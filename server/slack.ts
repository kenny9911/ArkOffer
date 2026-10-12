import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { z } from "zod";
import {
  getSessionToken,
  hashToken,
  isWorkspaceAdmin,
  sessionUser,
  userById,
  type User,
} from "./auth.js";
import { mayReadConversation } from "./access.js";
import type { Store } from "./db.js";

export type SlackAnswer = {
  text: string;
  conversationIds: string[];
  proof?: unknown;
};
export type SlackOptions = {
  appOrigin?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => number;
  /** Include ALL conversations given to the model, not just its cited sources. */
  answer?: (user: User, question: string) => Promise<SlackAnswer>;
  validateAnswer?: (user: User, answer: SlackAnswer) => boolean;
};
type Row = Record<string, any>;
const DAY = 86_400_000;
const SCOPES = ["commands", "chat:write", "im:write"];
const ACTIVE = "'queued','processing','sending','draft'";
class SlackError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryMs = 0,
    readonly ambiguous = false,
  ) {
    super(message);
  }
}
const fail = (status: number, message: string): never => {
  throw new SlackError(status, message);
};
const route =
  (fn: (req: Request, res: Response) => unknown) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve()
      .then(() => fn(req, res))
      .catch((error) => {
        if (error instanceof SlackError)
          res.status(error.status).json({ error: error.message });
        else if (error instanceof z.ZodError)
          res.status(400).json({
            error: error.issues[0]?.message || "Invalid Slack request.",
          });
        else next(error);
      });
  };
const list = (value = "") =>
  value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
const slackId = (value: unknown, prefix: string) =>
  typeof value === "string" &&
  new RegExp(`^[${prefix}][A-Z0-9]{2,40}$`).test(value);
const safeText = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Register BEFORE JSON/Origin middleware. Call registerRoutes AFTER that middleware. */
export function registerSlack(
  app: Express,
  store: Store,
  options: SlackOptions = {},
) {
  const db = store.db,
    env = options.env || process.env,
    fetcher = options.fetch || fetch,
    now = options.now || Date.now;
  db.exec(`
    CREATE TABLE IF NOT EXISTS slack_installs (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
      team_id TEXT NOT NULL UNIQUE, team_name TEXT NOT NULL, bot_user_id TEXT NOT NULL, token TEXT NOT NULL,
      installed_by TEXT NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL, next_send_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS slack_oauth_states (
      state_hash TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, session_hash TEXT NOT NULL,
      redirect_uri TEXT NOT NULL, expires_at INTEGER NOT NULL, claimed INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS slack_link_codes (
      code_hash TEXT PRIMARY KEY, install_id TEXT NOT NULL REFERENCES slack_installs(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, session_hash TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS slack_links (
      install_id TEXT NOT NULL REFERENCES slack_installs(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      slack_user_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(install_id,user_id), UNIQUE(install_id,slack_user_id)
    );
    CREATE TABLE IF NOT EXISTS slack_receipts (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS slack_jobs (
      id TEXT PRIMARY KEY, install_id TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, slack_user_id TEXT NOT NULL, kind TEXT NOT NULL,
      question TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', conversation_ids TEXT NOT NULL DEFAULT '[]', proof TEXT NOT NULL DEFAULT 'null',
      status TEXT NOT NULL, approval INTEGER NOT NULL DEFAULT 0, revision TEXT NOT NULL DEFAULT '',
      due_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', slack_ts TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS slack_jobs_due ON slack_jobs(status,due_at);
    CREATE TABLE IF NOT EXISTS slack_schedules (
      install_id TEXT NOT NULL REFERENCES slack_installs(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, enabled INTEGER NOT NULL, hour_utc INTEGER NOT NULL, delivery TEXT NOT NULL,
      next_at INTEGER NOT NULL, PRIMARY KEY(install_id,user_id,kind)
    );
  `);
  if (
    !db
      .prepare("PRAGMA table_info(slack_jobs)")
      .all()
      .some((column) => column.name === "proof")
  )
    db.exec(
      "ALTER TABLE slack_jobs ADD COLUMN proof TEXT NOT NULL DEFAULT 'null'",
    );
  if (
    !db
      .prepare("PRAGMA table_info(slack_oauth_states)")
      .all()
      .some((column) => column.name === "claimed")
  )
    db.exec(
      "ALTER TABLE slack_oauth_states ADD COLUMN claimed INTEGER NOT NULL DEFAULT 0",
    );
  function origin() {
    const value =
      env.SLACK_APP_ORIGIN ||
      list(options.appOrigin || env.APP_ORIGIN)[0] ||
      "";
    try {
      const url = new URL(value),
        allowed = list(options.appOrigin || env.APP_ORIGIN);
      return url.origin === value &&
        !url.username &&
        !url.password &&
        (url.protocol === "https:" ||
          (url.protocol === "http:" &&
            ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) &&
        (!allowed.length || allowed.includes(value))
        ? value
        : "";
    } catch {
      return "";
    }
  }
  function config(workspaceId?: string) {
    const missing = [
      "SLACK_CLIENT_ID",
      "SLACK_CLIENT_SECRET",
      "SLACK_SIGNING_SECRET",
      "SLACK_APP_ID",
    ].filter((key) => !env[key]);
    if (!/^[a-f0-9]{64}$/i.test(env.SLACK_ENCRYPTION_KEY || ""))
      missing.push("SLACK_ENCRYPTION_KEY (64 hex characters)");
    if (!origin()) missing.push("SLACK_APP_ORIGIN (trusted exact origin)");
    if (!list(env.SLACK_TEAM_IDS).length) missing.push("SLACK_TEAM_IDS");
    if (!workspaceId || !list(env.SLACK_WORKSPACE_IDS).includes(workspaceId))
      missing.push("SLACK_WORKSPACE_IDS (workspace authorization)");
    return { configured: !missing.length, missing };
  }
  function crypt(value: string, install: Row, decrypt = false) {
    const key = Buffer.from(env.SLACK_ENCRYPTION_KEY || "", "hex");
    try {
      const aad = Buffer.from(
        `${install.workspace_id}:${install.team_id}:${install.id}`,
      );
      if (decrypt) {
        const [iv, tag, body] = value
          .split(".")
          .map((s) => Buffer.from(s, "base64url"));
        const cipher = createDecipheriv("aes-256-gcm", key, iv);
        cipher.setAAD(aad);
        cipher.setAuthTag(tag);
        return Buffer.concat([cipher.update(body), cipher.final()]).toString();
      }
      const iv = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(aad);
      const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
      return [iv, cipher.getAuthTag(), ciphertext]
        .map((part) => part.toString("base64url"))
        .join(".");
    } catch {
      return fail(
        503,
        "Slack credentials are unavailable. Restore the encryption key or reinstall the app.",
      );
    }
  }
  function auth(req: Request, admin = false) {
    const user =
      sessionUser(store, req) || fail(401, "Sign in to manage Slack.");
    if (admin && !isWorkspaceAdmin(user))
      fail(
        403,
        "Only workspace owners and administrators can install or disconnect Slack.",
      );
    return user;
  }
  const installFor = (workspaceId: string) =>
    db
      .prepare("SELECT * FROM slack_installs WHERE workspace_id=?")
      .get(workspaceId) as Row | undefined;
  const linkFor = (installId: string, userId: string) =>
    db
      .prepare("SELECT * FROM slack_links WHERE install_id=? AND user_id=?")
      .get(installId, userId) as Row | undefined;
  function revoke(install: Row, message: string) {
    store.transaction(() => {
      db.prepare(
        `UPDATE slack_jobs SET status='cancelled',body='',question='',error=?,updated_at=? WHERE install_id=? AND status IN (${ACTIVE})`,
      ).run(message, now(), install.id);
      db.prepare("DELETE FROM slack_oauth_states WHERE workspace_id=?").run(
        install.workspace_id,
      );
      db.prepare("DELETE FROM slack_installs WHERE id=?").run(install.id);
    });
  }
  function current(job: Row) {
    const install = installFor(job.workspace_id),
      user = userById(store, job.user_id, job.workspace_id);
    if (
      !install ||
      install.id !== job.install_id ||
      !user ||
      !config(user.workspaceId).configured ||
      !list(env.SLACK_TEAM_IDS).includes(install.team_id)
    )
      return null;
    const link = linkFor(install.id, user.id);
    if (!link || link.slack_user_id !== job.slack_user_id) return null;
    if (
      !(JSON.parse(job.conversation_ids || "[]") as string[]).every((id) =>
        mayReadConversation(store, user, id),
      )
    )
      return null;
    if (job.kind === "ask" && job.body) {
      if (!options.validateAnswer || !job.proof || job.proof === "null")
        return null;
      try {
        if (
          !options.validateAnswer(user, {
            text: job.body,
            conversationIds: JSON.parse(job.conversation_ids),
            proof: JSON.parse(job.proof),
          })
        )
          return null;
      } catch {
        return null;
      }
    }
    if (["digest", "reminder"].includes(job.kind) && job.body) {
      // An approved reminder must still describe current interviews when it is
      // delivered, including after a slow Slack request or worker restart.
      const latest = buildDigest(user, job.kind);
      if (
        latest.text !== job.body ||
        JSON.stringify(latest.conversationIds) !== job.conversation_ids
      )
        return null;
    }
    const fresh = db
      .prepare("SELECT status FROM slack_jobs WHERE id=?")
      .get(job.id);
    if (
      fresh &&
      !["draft", "queued", "processing", "sending"].includes(
        String(fresh.status),
      )
    )
      return null;
    return { install, user };
  }
  async function slack(
    method: string,
    fields: Record<string, unknown>,
    token = "",
    sending = false,
  ) {
    let response: globalThis.Response;
    try {
      response = await fetcher(`https://slack.com/api/${method}`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(12_000),
        headers: token
          ? {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            }
          : { "Content-Type": "application/x-www-form-urlencoded" },
        body: token
          ? JSON.stringify(fields)
          : new URLSearchParams(fields as Record<string, string>).toString(),
      });
    } catch {
      throw new SlackError(
        502,
        sending
          ? "Delivery could not be confirmed. Check Slack; automatic retries are disabled."
          : "Slack could not be reached.",
        sending ? 0 : 30_000,
        sending,
      );
    }
    if (response.status === 429) {
      await response.body?.cancel();
      const seconds = Number(response.headers.get("retry-after") || "30");
      if (!Number.isFinite(seconds) || seconds > 3600)
        throw new SlackError(
          429,
          "Slack rate limit requires a later manual attempt.",
        );
      throw new SlackError(
        429,
        "Slack rate limited this request.",
        Math.max(1000, seconds * 1000),
      );
    }
    let data: Row;
    try {
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Empty Slack response");
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 128_000) {
          await reader.cancel();
          throw new Error("Oversized Slack response");
        }
        chunks.push(part.value);
      }
      data = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Row;
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new Error("Invalid Slack response");
    } catch {
      throw new SlackError(
        502,
        "Slack returned an unreadable response. Check delivery before trying again.",
        0,
        sending,
      );
    }
    if (!response.ok || !data.ok) {
      const code = String(data.error || "unavailable");
      if (
        [
          "token_revoked",
          "invalid_auth",
          "account_inactive",
          "token_expired",
        ].includes(code)
      )
        throw new SlackError(
          401,
          "Slack authorization was revoked or expired. Reinstall the app.",
        );
      if (
        response.status >= 500 ||
        ["internal_error", "fatal_error"].includes(code)
      )
        throw new SlackError(
          502,
          "Slack could not confirm this request. Check delivery before trying again.",
          sending ? 0 : 30_000,
          sending,
        );
      throw new SlackError(
        502,
        "Slack rejected the request. Check app scopes and the linked account.",
      );
    }
    return data;
  }
  function verified(req: Request) {
    const timestamp = req.get("x-slack-request-timestamp") || "",
      signature = req.get("x-slack-signature") || "";
    if (
      !env.SLACK_SIGNING_SECRET ||
      !Buffer.isBuffer(req.body) ||
      !/^\d{10}$/.test(timestamp) ||
      Math.abs(now() / 1000 - Number(timestamp)) > 300 ||
      !/^v0=[a-f0-9]{64}$/.test(signature)
    )
      fail(401, "Invalid Slack signature.");
    const expected = `v0=${createHmac("sha256", env.SLACK_SIGNING_SECRET!)
      .update(`v0:${timestamp}:`)
      .update(req.body as Buffer)
      .digest("hex")}`;
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected)))
      fail(401, "Invalid Slack signature.");
    return signature;
  }
  function receipt(id: string) {
    return Boolean(
      db
        .prepare(
          "INSERT OR IGNORE INTO slack_receipts(id,created_at) VALUES(?,?)",
        )
        .run(hashToken(id), now()).changes,
    );
  }
  function queue(
    install: Row,
    userId: string,
    slackUserId: string,
    kind: string,
    question = "",
    approval = false,
  ) {
    const id = randomUUID();
    db.prepare(
      "INSERT INTO slack_jobs(id,install_id,workspace_id,user_id,slack_user_id,kind,question,status,approval,due_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'queued',?,?,?,?)",
    ).run(
      id,
      install.id,
      install.workspace_id,
      userId,
      slackUserId,
      kind,
      question,
      Number(approval),
      now(),
      now(),
      now(),
    );
    return id;
  }
  app.post(
    "/api/slack/commands",
    express.raw({ type: "application/x-www-form-urlencoded", limit: "16kb" }),
    route((req, res) => {
      const signature = verified(req),
        body = new URLSearchParams(req.body.toString()),
        teamId = body.get("team_id"),
        slackUserId = body.get("user_id"),
        text = body.get("text")?.trim() || "";
      if (
        body.get("api_app_id") !== env.SLACK_APP_ID ||
        body.get("command") !== "/arkoffer" ||
        !slackId(teamId, "T") ||
        !slackId(slackUserId, "UW")
      )
        fail(400, "Invalid Slack command.");
      const install = db
        .prepare("SELECT * FROM slack_installs WHERE team_id=?")
        .get(teamId!) as Row | undefined;
      if (
        !install ||
        !config(install.workspace_id).configured ||
        !list(env.SLACK_TEAM_IDS).includes(teamId!)
      )
        return fail(403, "This Slack workspace is not connected.");
      let message =
        "Use /arkoffer ask QUESTION. Link your account in ArkOffer Settings → Integrations first.";
      store.transaction(() => {
        if (
          !receipt(`command:${teamId}:${body.get("trigger_id") || signature}`)
        ) {
          message = "This command was already received.";
          return;
        }
        if (text.startsWith("link ")) {
          const code = text.slice(5).trim();
          if (!/^[a-f0-9]{32}$/.test(code)) {
            message =
              "The link code is invalid or expired. Generate a new code in ArkOffer.";
            return;
          }
          const record = db
            .prepare(
              "DELETE FROM slack_link_codes WHERE code_hash=? AND install_id=? AND expires_at>? RETURNING *",
            )
            .get(hashToken(code), install.id, now()) as Row | undefined;
          const session =
            record &&
            db
              .prepare(
                "SELECT user_id FROM sessions WHERE token_hash=? AND user_id=? AND workspace_id=? AND expires_at>?",
              )
              .get(
                record.session_hash,
                record.user_id,
                install.workspace_id,
                now(),
              );
          if (
            !record ||
            !session ||
            !userById(store, record.user_id, install.workspace_id)
          ) {
            message =
              "The link code is invalid or expired. Generate a new code in ArkOffer.";
            return;
          }
          const conflict = db
            .prepare(
              "SELECT user_id FROM slack_links WHERE install_id=? AND slack_user_id=?",
            )
            .get(install.id, slackUserId!);
          if (conflict && conflict.user_id !== record.user_id) {
            message =
              "This Slack account is already linked. Unlink it in ArkOffer first.";
            return;
          }
          const existing = linkFor(install.id, record.user_id);
          if (existing && existing.slack_user_id !== slackUserId) {
            message = "Unlink your existing Slack account in ArkOffer first.";
            return;
          }
          db.prepare(
            "INSERT OR IGNORE INTO slack_links(install_id,user_id,slack_user_id,created_at) VALUES(?,?,?,?)",
          ).run(install.id, record.user_id, slackUserId!, now());
          message =
            "Your account is linked. Questions and approved updates are sent only to your private DM with ArkOffer.";
        } else if (text.startsWith("ask ")) {
          const question = text.slice(4).trim();
          if (!question || question.length > 2000) {
            message = "Ask a question between 1 and 2,000 characters.";
            return;
          }
          const link = db
            .prepare(
              "SELECT * FROM slack_links WHERE install_id=? AND slack_user_id=?",
            )
            .get(install.id, slackUserId!) as Row | undefined;
          if (!link || !userById(store, link.user_id, install.workspace_id)) {
            message =
              "Link an active ArkOffer account in Settings → Integrations before asking a question.";
            return;
          }
          const recent = db
            .prepare(
              "SELECT COUNT(*) AS count FROM slack_jobs WHERE install_id=? AND user_id=? AND created_at>?",
            )
            .get(install.id, link.user_id, now() - 60_000)!;
          const pending = db
            .prepare(
              `SELECT COUNT(*) AS count FROM slack_jobs WHERE install_id=? AND status IN (${ACTIVE})`,
            )
            .get(install.id)!;
          if (Number(recent.count) >= 5 || Number(pending.count) >= 100) {
            message =
              "Your Slack queue is full. Wait for existing requests to finish.";
            return;
          }
          queue(install, link.user_id, slackUserId!, "ask", question);
          message =
            "Question queued. ArkOffer will send the answer to your private DM. You can inspect its status in Settings → Integrations.";
        }
      });
      // Never use the supplied response_url or channel_id, including for follow-ups.
      res.json({ response_type: "ephemeral", text: message });
    }),
  );
  app.post(
    "/api/slack/events",
    express.raw({ type: "application/json", limit: "32kb" }),
    route((req, res) => {
      verified(req);
      let body: Row;
      try {
        body = JSON.parse(req.body.toString());
      } catch {
        return fail(400, "Invalid Slack event.");
      }
      if (
        body.type === "url_verification" &&
        typeof body.challenge === "string" &&
        body.challenge.length < 500
      ) {
        res.json({ challenge: body.challenge });
        return;
      }
      if (
        body.api_app_id !== env.SLACK_APP_ID ||
        !slackId(body.team_id, "T") ||
        typeof body.event_id !== "string" ||
        body.event_id.length > 200 ||
        !Number.isSafeInteger(body.event_time)
      )
        return fail(400, "Invalid Slack event.");
      const install = db
        .prepare("SELECT * FROM slack_installs WHERE team_id=?")
        .get(body.team_id) as Row | undefined;
      if (
        install &&
        Number(body.event_time) >=
          Math.floor(Number(install.created_at) / 1000) &&
        !db
          .prepare("SELECT id FROM slack_receipts WHERE id=?")
          .get(hashToken(`event:${body.event_id}`)) &&
        (body.event?.type === "app_uninstalled" ||
          (body.event?.type === "tokens_revoked" &&
            Array.isArray(body.event.tokens?.bot) &&
            body.event.tokens.bot.includes(install.bot_user_id)))
      )
        revoke(install, "Slack app access was revoked.");
      // Revocation is idempotent; record the receipt after cancellation so a
      // crash cannot mark an unprocessed revocation as completed.
      receipt(`event:${body.event_id}`);
      res.status(200).json({ ok: true });
    }),
  );
  function nextAt(hour: number) {
    const date = new Date(now());
    date.setUTCHours(hour, 0, 0, 0);
    return date.getTime() <= now() ? date.getTime() + DAY : date.getTime();
  }
  function cancelUser(installId: string, userId: string) {
    db.prepare(
      `UPDATE slack_jobs SET status='cancelled',body='',question='',updated_at=? WHERE install_id=? AND user_id=? AND status IN (${ACTIVE})`,
    ).run(now(), installId, userId);
    db.prepare(
      "DELETE FROM slack_schedules WHERE install_id=? AND user_id=?",
    ).run(installId, userId);
    db.prepare("DELETE FROM slack_links WHERE install_id=? AND user_id=?").run(
      installId,
      userId,
    );
    db.prepare(
      "DELETE FROM slack_link_codes WHERE install_id=? AND user_id=?",
    ).run(installId, userId);
  }
  let routesRegistered = false;
  function registerRoutes() {
    if (routesRegistered) return;
    routesRegistered = true;
    app.get(
      "/api/slack",
      route((req, res) => {
        const user = auth(req),
          install = installFor(user.workspaceId),
          link = install && linkFor(install.id, user.id);
        const jobs = db
          .prepare(
            "SELECT * FROM slack_jobs WHERE workspace_id=? AND user_id=? ORDER BY created_at DESC,id DESC LIMIT 30",
          )
          .all(user.workspaceId, user.id) as Row[];
        res.json({
          ...config(user.workspaceId),
          canManage: isWorkspaceAdmin(user),
          connected: Boolean(install),
          teamName: install?.team_name || null,
          linked: Boolean(link),
          slackUserId: link?.slack_user_id || null,
          redirectUri: origin() ? `${origin()}/api/slack/callback` : null,
          commandUrl: origin() ? `${origin()}/api/slack/commands` : null,
          eventsUrl: origin() ? `${origin()}/api/slack/events` : null,
          scopes: SCOPES,
          schedules: install
            ? db
                .prepare(
                  "SELECT kind,enabled,hour_utc AS hourUtc,delivery,next_at AS nextAt FROM slack_schedules WHERE install_id=? AND user_id=?",
                )
                .all(install.id, user.id)
            : [],
          jobs: jobs.map((j) => {
            const permitted = Boolean(current(j));
            return {
              id: j.id,
              kind: j.kind,
              status:
                !permitted &&
                ["draft", "queued", "processing"].includes(j.status)
                  ? "cancelled"
                  : j.status,
              createdAt: j.created_at,
              error: j.error,
              body: permitted && j.status === "draft" ? j.body : "",
              revision: permitted && j.status === "draft" ? j.revision : "",
            };
          }),
        });
      }),
    );
    app.post(
      "/api/slack/connect",
      route((req, res) => {
        const user = auth(req, true);
        if (!config(user.workspaceId).configured)
          fail(
            503,
            "The Slack app needs server configuration and workspace authorization.",
          );
        if (installFor(user.workspaceId))
          fail(
            409,
            "Disconnect the existing Slack workspace before installing again.",
          );
        const state = randomBytes(32).toString("hex"),
          redirect = `${origin()}/api/slack/callback`;
        db.prepare(
          "DELETE FROM slack_oauth_states WHERE expires_at<=? OR (user_id=? AND workspace_id=?)",
        ).run(now(), user.id, user.workspaceId);
        db.prepare(
          "INSERT INTO slack_oauth_states(state_hash,workspace_id,user_id,session_hash,redirect_uri,expires_at) VALUES(?,?,?,?,?,?)",
        ).run(
          hashToken(state),
          user.workspaceId,
          user.id,
          hashToken(getSessionToken(req)!),
          redirect,
          now() + 600_000,
        );
        const url = new URL("https://slack.com/oauth/v2/authorize");
        url.search = new URLSearchParams({
          client_id: env.SLACK_CLIENT_ID!,
          scope: SCOPES.join(","),
          redirect_uri: redirect,
          state,
        }).toString();
        res.json({ url: url.href });
      }),
    );
    app.get(
      "/api/slack/callback",
      route(async (req, res) => {
        const user = auth(req, true),
          state = String(req.query.state || "");
        if (!/^[a-f0-9]{64}$/.test(state))
          fail(400, "Slack authorization state is invalid or expired.");
        const pending = db
          .prepare(
            "UPDATE slack_oauth_states SET claimed=1 WHERE state_hash=? AND user_id=? AND workspace_id=? AND session_hash=? AND expires_at>? AND claimed=0 RETURNING *",
          )
          .get(
            hashToken(state),
            user.id,
            user.workspaceId,
            hashToken(getSessionToken(req)!),
            now(),
          ) as Row | undefined;
        if (
          !pending ||
          !config(user.workspaceId).configured ||
          pending.redirect_uri !== `${origin()}/api/slack/callback`
        )
          fail(400, "Slack authorization state is invalid or expired.");
        if (req.query.error) {
          db.prepare("DELETE FROM slack_oauth_states WHERE state_hash=?").run(
            hashToken(state),
          );
          res.redirect(
            `${origin()}/app/settings?tab=integrations&slack=denied`,
          );
          return;
        }
        const code = z.string().min(1).max(2000).parse(req.query.code);
        const result = await slack("oauth.v2.access", {
          code,
          client_id: env.SLACK_CLIENT_ID!,
          client_secret: env.SLACK_CLIENT_SECRET!,
          redirect_uri: pending!.redirect_uri,
        });
        if (
          sessionUser(store, req)?.workspaceId !== user.workspaceId ||
          !db
            .prepare(
              "SELECT state_hash FROM slack_oauth_states WHERE state_hash=? AND expires_at>?",
            )
            .get(hashToken(state), now()) ||
          !isWorkspaceAdmin(
            userById(store, user.id, user.workspaceId) || { role: "" },
          ) ||
          !config(user.workspaceId).configured
        )
          fail(
            403,
            "Workspace authorization changed during Slack installation.",
          );
        if (
          result.app_id !== env.SLACK_APP_ID ||
          !slackId(result.team?.id, "T") ||
          !list(env.SLACK_TEAM_IDS).includes(result.team.id) ||
          result.is_enterprise_install ||
          !slackId(result.bot_user_id, "UW") ||
          typeof result.access_token !== "string" ||
          !result.access_token.startsWith("xoxb-") ||
          !SCOPES.every((scope) => list(result.scope).includes(scope))
        )
          fail(
            403,
            "Slack returned an unauthorized workspace, app, or incomplete bot scopes.",
          );
        if (result.refresh_token || result.expires_in)
          fail(
            400,
            "This connector requires a Slack app with token rotation disabled. Rotating tokens are not supported yet.",
          );
        const install = {
          id: randomUUID(),
          workspace_id: user.workspaceId,
          team_id: result.team.id,
        };
        store.transaction(() => {
          if (
            installFor(user.workspaceId) ||
            db
              .prepare("SELECT id FROM slack_installs WHERE team_id=?")
              .get(result.team.id)
          )
            fail(
              409,
              "This ArkOffer or Slack workspace already has an installation.",
            );
          db.prepare(
            "INSERT INTO slack_installs(id,workspace_id,team_id,team_name,bot_user_id,token,installed_by,created_at) VALUES(?,?,?,?,?,?,?,?)",
          ).run(
            install.id,
            user.workspaceId,
            install.team_id,
            String(result.team.name || install.team_id).slice(0, 200),
            result.bot_user_id,
            crypt(result.access_token, install),
            user.id,
            now(),
          );
        });
        db.prepare("DELETE FROM slack_oauth_states WHERE state_hash=?").run(
          hashToken(state),
        );
        res.redirect(
          `${origin()}/app/settings?tab=integrations&slack=connected`,
        );
      }),
    );
    app.delete(
      "/api/slack",
      route(async (req, res) => {
        const user = auth(req, true),
          install = installFor(user.workspaceId);
        db.prepare("DELETE FROM slack_oauth_states WHERE workspace_id=?").run(
          user.workspaceId,
        );
        let providerRevoked = false;
        if (install) {
          let token = "";
          try {
            token = crypt(install.token, install, true);
          } catch {
            /* Local cancellation must still work after key loss. */
          }
          revoke(install, "Slack was disconnected.");
          if (token)
            try {
              await slack("auth.revoke", {}, token);
              providerRevoked = true;
            } catch {
              /* Credentials are already removed locally. */
            }
        }
        res.json({
          ok: true,
          providerRevoked,
          message: providerRevoked
            ? "Slack disconnected and bot token revoked."
            : "Slack disconnected locally. Remove the app in Slack settings to ensure provider access is revoked.",
        });
      }),
    );
    app.post(
      "/api/slack/link",
      route((req, res) => {
        const user = auth(req),
          install = installFor(user.workspaceId);
        if (!install || !config(user.workspaceId).configured)
          fail(409, "Connect an authorized Slack workspace first.");
        const code = randomBytes(16).toString("hex");
        db.prepare(
          "DELETE FROM slack_link_codes WHERE expires_at<=? OR (install_id=? AND user_id=?)",
        ).run(now(), install!.id, user.id);
        db.prepare("INSERT INTO slack_link_codes VALUES(?,?,?,?,?)").run(
          hashToken(code),
          install!.id,
          user.id,
          hashToken(getSessionToken(req)!),
          now() + 300_000,
        );
        res.json({
          command: `/arkoffer link ${code}`,
          expiresAt: now() + 300_000,
        });
      }),
    );
    app.delete(
      "/api/slack/link",
      route((req, res) => {
        const user = auth(req),
          install = installFor(user.workspaceId);
        if (install) store.transaction(() => cancelUser(install.id, user.id));
        res.json({ ok: true });
      }),
    );
    const kind = z.enum(["digest", "reminder"]);
    app.put(
      "/api/slack/schedule",
      route((req, res) => {
        const user = auth(req),
          install = installFor(user.workspaceId),
          link = install && linkFor(install.id, user.id);
        if (!install || !link || !config(user.workspaceId).configured)
          fail(409, "Link your Slack account first.");
        const input = z
          .object({
            kind,
            enabled: z.boolean(),
            hourUtc: z.number().int().min(0).max(23),
            delivery: z.enum(["draft", "automatic"]),
          })
          .strict()
          .parse(req.body);
        store.transaction(() => {
          db.prepare(
            "INSERT INTO slack_schedules VALUES(?,?,?,?,?,?,?) ON CONFLICT(install_id,user_id,kind) DO UPDATE SET enabled=excluded.enabled,hour_utc=excluded.hour_utc,delivery=excluded.delivery,next_at=excluded.next_at",
          ).run(
            install!.id,
            user.id,
            input.kind,
            Number(input.enabled),
            input.hourUtc,
            input.delivery,
            nextAt(input.hourUtc),
          );
          db.prepare(
            `UPDATE slack_jobs SET status='cancelled',body='',updated_at=? WHERE install_id=? AND user_id=? AND kind=? AND status IN (${ACTIVE})`,
          ).run(now(), install!.id, user.id, input.kind);
        });
        res.json({ ok: true });
      }),
    );
    app.post(
      "/api/slack/drafts",
      route((req, res) => {
        const user = auth(req),
          install = installFor(user.workspaceId),
          link = install && linkFor(install.id, user.id);
        if (!install || !link || !config(user.workspaceId).configured)
          fail(409, "Link your Slack account first.");
        const input = z.object({ kind }).strict().parse(req.body);
        const pending = db
          .prepare(
            `SELECT COUNT(*) AS count FROM slack_jobs WHERE install_id=? AND user_id=? AND status IN (${ACTIVE})`,
          )
          .get(install!.id, user.id)!;
        if (Number(pending.count) >= 10)
          fail(
            429,
            "Review or cancel existing drafts before creating another.",
          );
        res.status(201).json({
          id: queue(
            install!,
            user.id,
            link!.slack_user_id,
            input.kind,
            "",
            true,
          ),
        });
      }),
    );
    app.post(
      "/api/slack/jobs/:id/approve",
      route((req, res) => {
        const user = auth(req),
          input = z
            .object({ revision: z.string().min(1).max(100) })
            .strict()
            .parse(req.body);
        const job = db
          .prepare(
            "SELECT * FROM slack_jobs WHERE id=? AND workspace_id=? AND user_id=? AND status='draft'",
          )
          .get(String(req.params.id), user.workspaceId, user.id) as
          Row | undefined;
        if (!job) fail(404, "Slack draft not found.");
        if (!current(job!))
          fail(409, "Slack draft access changed. Create a new draft.");
        if (
          job!.revision !== input.revision ||
          Number(job!.updated_at) < now() - DAY
        )
          fail(409, "This draft changed or expired. Create a new draft.");
        db.prepare(
          "UPDATE slack_jobs SET status='queued',approval=0,due_at=?,updated_at=? WHERE id=? AND status='draft'",
        ).run(now(), now(), job!.id);
        res.json({ ok: true });
      }),
    );
    app.delete(
      "/api/slack/jobs/:id",
      route((req, res) => {
        const user = auth(req);
        const result = db
          .prepare(
            `UPDATE slack_jobs SET status='cancelled',body='',question='',updated_at=? WHERE id=? AND workspace_id=? AND user_id=? AND status IN (${ACTIVE})`,
          )
          .run(now(), String(req.params.id), user.workspaceId, user.id);
        if (!result.changes) fail(404, "Active Slack job not found.");
        res.json({ ok: true });
      }),
    );
  }
  function buildDigest(user: User, kind: string): SlackAnswer {
    const items = store
      .list(user.workspaceId, "conversations")
      .filter(
        (item) => !item.archived && mayReadConversation(store, user, item.id),
      );
    const selected = items
      .filter((item) => {
        if (kind === "reminder") {
          if (item.status === "cancelled") return false;
          const date = Date.parse(String(item.date || ""));
          return date >= now() && date <= now() + DAY;
        }
        return Date.parse(item.updatedAt) >= now() - DAY;
      })
      .slice(0, 15);
    const heading =
      kind === "reminder"
        ? "Your interviews in the next 24 hours"
        : "Your interview activity in the past 24 hours";
    return {
      text: `${heading}\n${selected.length ? selected.map((item) => `• ${String(item.title || item.name || "Interview").slice(0, 160)}`).join("\n") : "No matching interviews you can access."}\nOpen ArkOffer for the full details.`,
      conversationIds: selected.map((item) => item.id),
    };
  }
  function schedule() {
    store.transaction(() => {
      const due = db
        .prepare(
          "SELECT * FROM slack_schedules WHERE enabled=1 AND next_at<=? LIMIT 50",
        )
        .all(now()) as Row[];
      for (const item of due) {
        const install = db
          .prepare("SELECT * FROM slack_installs WHERE id=?")
          .get(item.install_id) as Row | undefined;
        const link = linkFor(item.install_id, item.user_id);
        const user =
          install && userById(store, item.user_id, install.workspace_id);
        if (
          !install ||
          !link ||
          !user ||
          !config(install.workspace_id).configured
        ) {
          db.prepare(
            "UPDATE slack_schedules SET enabled=0 WHERE install_id=? AND user_id=? AND kind=?",
          ).run(item.install_id, item.user_id, item.kind);
          continue;
        }
        const pending = db
          .prepare(
            `SELECT id FROM slack_jobs WHERE install_id=? AND user_id=? AND kind=? AND status IN (${ACTIVE})`,
          )
          .get(install.id, item.user_id, item.kind);
        if (!pending)
          queue(
            install,
            item.user_id,
            link.slack_user_id,
            item.kind,
            "",
            item.delivery === "draft",
          );
        // Coalesce missed runs after a restart; never send a backlog of daily digests.
        db.prepare(
          "UPDATE slack_schedules SET next_at=? WHERE install_id=? AND user_id=? AND kind=?",
        ).run(
          nextAt(Number(item.hour_utc)),
          install.id,
          item.user_id,
          item.kind,
        );
      }
    });
  }
  let ticking: Promise<void> | undefined,
    timer: ReturnType<typeof setInterval> | undefined;
  const tick = () => {
    if (ticking) return ticking;
    ticking = (async () => {
      db.prepare("DELETE FROM slack_receipts WHERE created_at<?").run(
        now() - 7 * DAY,
      );
      db.prepare("DELETE FROM slack_oauth_states WHERE expires_at<=?").run(
        now(),
      );
      db.prepare("DELETE FROM slack_link_codes WHERE expires_at<=?").run(now());
      db.prepare(
        "UPDATE slack_jobs SET status='unknown',error='Worker stopped before delivery confirmation. Check Slack; automatic retries are disabled.',updated_at=? WHERE status='sending' AND updated_at<?",
      ).run(now(), now() - 120_000);
      db.prepare(
        "UPDATE slack_jobs SET status='queued',updated_at=? WHERE status='processing' AND updated_at<?",
      ).run(now(), now() - 120_000);
      db.prepare(
        "UPDATE slack_jobs SET status='cancelled',body='',question='',error='Slack request expired.',updated_at=? WHERE status IN ('queued','draft') AND created_at<?",
      ).run(now(), now() - DAY);
      schedule();
      for (let i = 0; i < 10; i++) {
        const job = store.transaction(() => {
          const row = db
            .prepare(
              "SELECT * FROM slack_jobs WHERE status='queued' AND due_at<=? ORDER BY due_at,id LIMIT 1",
            )
            .get(now()) as Row | undefined;
          if (!row) return;
          db.prepare(
            "UPDATE slack_jobs SET status='processing',updated_at=? WHERE id=? AND status='queued'",
          ).run(now(), row.id);
          return row;
        });
        if (!job) break;
        let sending = false;
        try {
          let access = current(job);
          if (!access) {
            db.prepare(
              "UPDATE slack_jobs SET status='cancelled',body='',question='',error='Account or interview access changed.',updated_at=? WHERE id=?",
            ).run(now(), job.id);
            continue;
          }
          if (!job.body) {
            const answer =
              job.kind === "ask"
                ? await (options.answer
                    ? options.answer(access.user, job.question)
                    : Promise.reject(
                        new SlackError(
                          503,
                          "The knowledge answer service is unavailable.",
                        ),
                      ))
                : buildDigest(access.user, job.kind);
            if (
              !answer ||
              typeof answer.text !== "string" ||
              !Array.isArray(answer.conversationIds) ||
              answer.conversationIds.some((id) => typeof id !== "string")
            )
              throw new SlackError(
                503,
                "The answer could not be safely verified.",
              );
            job.body = answer.text.slice(0, 3500);
            job.conversation_ids = JSON.stringify([
              ...new Set(answer.conversationIds),
            ]);
            job.proof = JSON.stringify(answer.proof ?? null);
            job.revision = hashToken(
              `${job.id}:${job.body}:${job.conversation_ids}`,
            );
            if (!current(job))
              throw new SlackError(
                403,
                "Account or interview access changed while preparing this message.",
              );
            db.prepare(
              "UPDATE slack_jobs SET body=?,conversation_ids=?,proof=?,revision=?,updated_at=? WHERE id=? AND status='processing'",
            ).run(
              job.body,
              job.conversation_ids,
              job.proof,
              job.revision,
              now(),
              job.id,
            );
          }
          if (job.approval) {
            db.prepare(
              "UPDATE slack_jobs SET status='draft',updated_at=? WHERE id=? AND status='processing'",
            ).run(now(), job.id);
            continue;
          }
          access = current(job);
          if (!access)
            throw new SlackError(403, "Account or interview access changed.");
          if (Number(access.install.next_send_at) > now()) {
            db.prepare(
              "UPDATE slack_jobs SET status='queued',due_at=?,updated_at=? WHERE id=? AND status='processing'",
            ).run(access.install.next_send_at, now(), job.id);
            continue;
          }
          const token = crypt(access.install.token, access.install, true);
          const opened = await slack(
            "conversations.open",
            { users: job.slack_user_id, return_im: true },
            token,
          );
          if (!slackId(opened.channel?.id, "D"))
            throw new SlackError(
              502,
              "Slack did not return a private direct message.",
            );
          // No sensitive content crosses the network until ALL authorization is rechecked after async work.
          access = current(job);
          if (!access)
            throw new SlackError(
              403,
              "Account or interview access changed before delivery.",
            );
          const claimed = store.transaction(() => {
            const install = db
              .prepare("SELECT next_send_at FROM slack_installs WHERE id=?")
              .get(access!.install.id);
            if (!install) return false;
            if (Number(install.next_send_at) > now()) {
              db.prepare(
                "UPDATE slack_jobs SET status='queued',due_at=?,updated_at=? WHERE id=? AND status='processing'",
              ).run(install.next_send_at, now(), job.id);
              return false;
            }
            const changed = db
              .prepare(
                "UPDATE slack_jobs SET status='sending',attempts=attempts+1,updated_at=? WHERE id=? AND status='processing'",
              )
              .run(now(), job.id);
            if (!changed.changes) return false;
            db.prepare(
              "UPDATE slack_installs SET next_send_at=? WHERE id=?",
            ).run(now() + 1100, access!.install.id);
            return true;
          });
          if (!claimed) continue;
          sending = true;
          const result = await slack(
            "chat.postMessage",
            {
              channel: opened.channel.id,
              text: safeText(job.body),
              mrkdwn: false,
              parse: "none",
              unfurl_links: false,
              unfurl_media: false,
              client_msg_id: job.id,
            },
            token,
            true,
          );
          if (typeof result.ts !== "string")
            throw new SlackError(
              502,
              "Slack did not confirm delivery. Check Slack; automatic retries are disabled.",
              0,
              true,
            );
          db.prepare(
            "UPDATE slack_jobs SET status='sent',slack_ts=?,body='',question='',updated_at=?,error='' WHERE id=? AND status='sending'",
          ).run(result.ts, now(), job.id);
        } catch (error) {
          const problem =
            error instanceof SlackError
              ? error
              : new SlackError(
                  502,
                  "The Slack request could not be completed.",
                  0,
                  sending,
                );
          if (problem.status === 401) {
            const install = installFor(job.workspace_id);
            if (install && install.id === job.install_id)
              revoke(install, problem.message);
          }
          const fresh = db
            .prepare("SELECT attempts,status FROM slack_jobs WHERE id=?")
            .get(job.id);
          if (
            fresh &&
            !["processing", "sending"].includes(String(fresh.status))
          )
            continue;
          const retry = problem.retryMs > 0 && Number(fresh?.attempts || 0) < 3;
          const status = problem.ambiguous
            ? "unknown"
            : retry
              ? "queued"
              : problem.status === 403
                ? "cancelled"
                : "failed";
          db.prepare(
            "UPDATE slack_jobs SET status=?,due_at=?,attempts=attempts+?,error=?,updated_at=?,body=CASE WHEN ? THEN '' ELSE body END,question=CASE WHEN ? THEN '' ELSE question END WHERE id=? AND status IN ('processing','sending')",
          ).run(
            status,
            now() + problem.retryMs,
            Number(!sending),
            problem.message,
            now(),
            Number(!retry),
            Number(!retry),
            job.id,
          );
          if (retry)
            db.prepare(
              "UPDATE slack_installs SET next_send_at=MAX(next_send_at,?) WHERE id=?",
            ).run(now() + problem.retryMs, job.install_id);
        }
      }
    })().finally(() => {
      ticking = undefined;
    });
    return ticking;
  };
  return {
    registerRoutes,
    tick,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void tick().catch(() => {
          /* Durable jobs retain their last confirmed state. */
        });
      }, 2000);
      timer.unref();
      void tick().catch(() => {});
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await ticking;
    },
  };
}
