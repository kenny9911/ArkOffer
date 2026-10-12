import { createHash, randomUUID } from "node:crypto";
import type { Express, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { isWorkspaceAdmin, sessionUser, type User } from "./auth.js";
import { registerConversationOwner } from "./access.js";
import type { Resource, Store } from "./db.js";

type Options = {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => number;
};
type Capture = {
  id: string;
  workspace_id: string;
  user_id: string;
  request_key: string;
  request_hash: string;
  title: string;
  meeting_url: string;
  join_at: string | null;
  consent_at: string;
  bot_id: string | null;
  status: string;
  recording_id: string | null;
  transcript_ready: number;
  conversation_id: string | null;
  imported_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};
class ProviderError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly providerStatus?: number,
  ) {
    super(message);
  }
}
const fail = (status: number, message: string): never => {
  throw new ProviderError(status, message);
};
const text = (value: unknown, max = 1000) =>
  typeof value === "string" ? value.slice(0, max) : "";
const externalId = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? String(value)
    : typeof value === "string" && /^[A-Za-z0-9_-]{1,150}$/.test(value)
      ? value
      : "";
const uuid = (value: unknown) =>
  z.string().uuid().safeParse(value).success ? String(value) : "";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const terminal = new Set(["done", "fatal", "cancelled", "failed"]);
const createSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    meetingUrl: z.string().max(3000),
    joinAt: z.string().datetime({ offset: true }).nullable().optional(),
    consent: z.literal(true),
    requestKey: z.string().uuid(),
  })
  .strict();
function meetingAddress(raw: string) {
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      url.port ||
      url.username ||
      url.password ||
      url.hash
    )
      return fail(
        400,
        "Use a valid HTTPS Google Meet, Zoom or Microsoft Teams meeting link.",
      );
    const host = url.hostname;
    const valid =
      (host === "meet.google.com" &&
        /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(url.pathname)) ||
      ((host === "zoom.us" || /^[a-z0-9-]+\.zoom\.us$/.test(host)) &&
        /^\/(?:j|wc\/join)\/\d{9,11}\/?$/.test(url.pathname)) ||
      (["teams.microsoft.com", "teams.live.com"].includes(host) &&
        /^\/(?:l\/meetup-join\/|meet\/)[^\s]+$/.test(url.pathname));
    if (!valid)
      return fail(
        400,
        "Use a valid HTTPS Google Meet, Zoom or Microsoft Teams meeting link.",
      );
    return url.href;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    return fail(400, "The meeting URL is invalid.");
  }
}

/** Register after JSON/Origin middleware. No provider requests occur until an authorized explicit action. */
export function registerProviders(
  app: Express,
  store: Store,
  options: Options = {},
) {
  const env = options.env || process.env,
    fetcher = options.fetch || fetch,
    now = options.now || Date.now;
  const locks = new Set<string>();
  const stamp = () => new Date(now()).toISOString();
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS provider_syncs(workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, provider TEXT NOT NULL, last_sync TEXT, last_error TEXT, counts TEXT NOT NULL DEFAULT '{}', PRIMARY KEY(workspace_id,provider));
    CREATE TABLE IF NOT EXISTS provider_imports(workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, provider TEXT NOT NULL, kind TEXT NOT NULL, external_id TEXT NOT NULL, resource_id TEXT REFERENCES resources(id) ON DELETE SET NULL, source TEXT NOT NULL, synced_at TEXT NOT NULL, PRIMARY KEY(workspace_id,provider,kind,external_id));
    CREATE TABLE IF NOT EXISTS meeting_captures(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id),request_key TEXT NOT NULL,request_hash TEXT NOT NULL,title TEXT NOT NULL,meeting_url TEXT NOT NULL,join_at TEXT,consent_at TEXT NOT NULL,bot_id TEXT,status TEXT NOT NULL,recording_id TEXT,transcript_ready INTEGER NOT NULL DEFAULT 0,conversation_id TEXT REFERENCES resources(id) ON DELETE SET NULL,imported_at TEXT,last_error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(workspace_id,user_id,request_key));
    CREATE TABLE IF NOT EXISTS capture_events(id TEXT PRIMARY KEY,capture_id TEXT NOT NULL REFERENCES meeting_captures(id) ON DELETE CASCADE,operation TEXT NOT NULL,status TEXT NOT NULL,occurred_at TEXT NOT NULL);
  `);
  const route =
    (handler: (req: Request, res: Response) => unknown) =>
    (req: Request, res: Response, next: NextFunction) => {
      Promise.resolve()
        .then(() => handler(req, res))
        .catch((error) => {
          if (error instanceof ProviderError)
            res.status(error.status).json({ error: error.message });
          else if (error instanceof z.ZodError)
            res.status(400).json({
              error: error.issues[0]?.message || "Invalid provider request.",
            });
          else next(error);
        });
    };
  function user(req: Request, admin = false) {
    const value =
      sessionUser(store, req) || fail(401, "Sign in to manage providers.");
    if (admin && !isWorkspaceAdmin(value))
      return fail(
        403,
        "Only workspace owners and admins can use operator-funded providers.",
      );
    return value;
  }
  function current(req: Request, original: User) {
    const latest = user(req, true);
    if (
      latest.workspaceId !== original.workspaceId ||
      latest.id !== original.id
    )
      fail(
        409,
        "The active workspace changed. Try again in the original workspace.",
      );
  }
  function allowed(u: User) {
    return (env.PROVIDER_WORKSPACE_IDS || "")
      .split(",")
      .map((v) => v.trim())
      .includes(u.workspaceId);
  }
  function setup(provider: "greenhouse" | "recall", u: User) {
    const missing: string[] = [];
    if (!allowed(u))
      missing.push(
        "PROVIDER_WORKSPACE_IDS (this workspace must be explicitly allowed)",
      );
    if (provider === "greenhouse") {
      if (!env.GREENHOUSE_CLIENT_ID) missing.push("GREENHOUSE_CLIENT_ID");
      if (!env.GREENHOUSE_CLIENT_SECRET)
        missing.push("GREENHOUSE_CLIENT_SECRET");
      if (env.GREENHOUSE_USER_ID && !/^\d+$/.test(env.GREENHOUSE_USER_ID))
        missing.push("GREENHOUSE_USER_ID (numeric Greenhouse user ID)");
    } else {
      if (!env.RECALL_API_KEY) missing.push("RECALL_API_KEY");
      if (
        !["us-east-1", "us-west-2", "eu-central-1", "ap-northeast-1"].includes(
          env.RECALL_REGION || "us-east-1",
        )
      )
        missing.push("RECALL_REGION (supported Recall region)");
    }
    return {
      configured: missing.length === 0,
      allowed: allowed(u),
      canManage: isWorkspaceAdmin(u),
      missing,
    };
  }
  function requireSetup(p: "greenhouse" | "recall", u: User) {
    const s = setup(p, u);
    if (!s.allowed)
      fail(
        403,
        "This workspace is not enabled for operator-funded providers. Ask the server administrator to allow its workspace ID.",
      );
    if (!s.configured)
      fail(503, `Provider setup required: ${s.missing.join(", ")}.`);
  }
  const recallBase = () =>
    `https://${env.RECALL_REGION || "us-east-1"}.recall.ai/api/v1`;
  async function request(
    url: string,
    init: RequestInit = {},
    limit = 4_000_000,
    empty = false,
  ) {
    let response: globalThis.Response;
    try {
      response = await fetcher(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      return fail(
        502,
        "The provider did not respond. Check provider status before retrying.",
      );
    }
    if (!response.ok) {
      if (response.status === 429)
        throw new ProviderError(
          429,
          "The provider is limiting requests. Try again later.",
          response.status,
        );
      if ([401, 403].includes(response.status))
        throw new ProviderError(
          502,
          "The provider rejected the configured credentials or permissions.",
          response.status,
        );
      throw new ProviderError(
        502,
        `The provider could not complete the request (HTTP ${response.status}).`,
        response.status,
      );
    }
    if (empty || response.status === 204)
      return { data: null, headers: response.headers };
    const reader = response.body?.getReader();
    if (!reader) fail(502, "The provider returned an empty response.");
    let length = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const part = await reader!.read();
        if (part.done) break;
        length += part.value.byteLength;
        if (length > limit) {
          await reader!.cancel();
          fail(502, "The provider response exceeded the import size limit.");
        }
        chunks.push(part.value);
      }
      return {
        data: JSON.parse(Buffer.concat(chunks).toString()),
        headers: response.headers,
      };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      return fail(502, "The provider returned an invalid response.");
    }
  }
  async function recall(
    path: string,
    method = "GET",
    body?: unknown,
    empty = false,
  ) {
    return (
      await request(
        `${recallBase()}${path}`,
        {
          method,
          headers: {
            Authorization: env.RECALL_API_KEY!,
            "Content-Type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        4_000_000,
        empty,
      )
    ).data;
  }
  function event(id: string, operation: string, status: string) {
    store.db
      .prepare(
        "INSERT INTO capture_events(id,capture_id,operation,status,occurred_at) VALUES(?,?,?,?,?)",
      )
      .run(randomUUID(), id, operation, status, stamp());
  }
  function getCapture(u: User, id: string): Capture {
    const row = store.db
      .prepare("SELECT * FROM meeting_captures WHERE id=? AND workspace_id=?")
      .get(id, u.workspaceId) as Capture | undefined;
    if (!row || (!isWorkspaceAdmin(u) && row.user_id !== u.id))
      return fail(404, "Capture not found.");
    return row;
  }
  function safeCapture(row: Capture) {
    return {
      id: row.id,
      title: row.title,
      meetingUrl: row.meeting_url,
      joinAt: row.join_at,
      status: row.status,
      transcriptReady: !!row.transcript_ready,
      conversationId: row.conversation_id,
      importedAt: row.imported_at,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      canCancel:
        !!row.bot_id &&
        !!row.join_at &&
        Date.parse(row.join_at) > now() &&
        !terminal.has(row.status),
      canLeave: !!row.bot_id && !terminal.has(row.status),
      events: store.db
        .prepare(
          "SELECT operation,status,occurred_at AS occurredAt FROM capture_events WHERE capture_id=? ORDER BY occurred_at DESC LIMIT 30",
        )
        .all(row.id),
    };
  }
  function observation(bot: any, expectedId: string) {
    if (!bot || bot.id !== expectedId)
      fail(502, "The provider returned a different or invalid capture.");
    const changes = Array.isArray(bot.status_changes) ? bot.status_changes : [];
    const last = changes.at(-1);
    const status = text(last?.code, 80) || "created";
    const recordings = Array.isArray(bot.recordings) ? bot.recordings : [];
    const recording =
      recordings.findLast(
        (r: any) => r?.media_shortcuts?.transcript?.status?.code === "done",
      ) || recordings.at(-1);
    const transcript = recording?.media_shortcuts?.transcript;
    return {
      status,
      recordingId: uuid(recording?.id),
      transcriptReady:
        transcript?.status?.code === "done" &&
        !!text(transcript?.data?.download_url, 16000),
      downloadUrl: text(transcript?.data?.download_url, 16000),
    };
  }
  function applyObservation(
    row: Capture,
    observed: ReturnType<typeof observation>,
  ) {
    store.db
      .prepare(
        "UPDATE meeting_captures SET status=?,recording_id=?,transcript_ready=?,last_error=NULL,updated_at=? WHERE id=?",
      )
      .run(
        observed.status,
        observed.recordingId || null,
        Number(observed.transcriptReady),
        stamp(),
        row.id,
      );
    event(row.id, "status", observed.status);
  }
  async function locked<T>(key: string, action: () => Promise<T>) {
    if (locks.has(key))
      fail(409, "This provider operation is already running.");
    locks.add(key);
    try {
      return await action();
    } finally {
      locks.delete(key);
    }
  }
  async function captureAction(
    req: Request,
    id: string,
    action: (u: User, row: Capture) => Promise<unknown>,
  ) {
    const u = user(req, true);
    requireSetup("recall", u);
    const row = getCapture(u, id);
    return locked(`capture:${id}`, async () => {
      try {
        return await action(u, row);
      } catch (error) {
        if (error instanceof ProviderError) {
          store.db
            .prepare(
              "UPDATE meeting_captures SET last_error=?,updated_at=? WHERE id=?",
            )
            .run(error.message, stamp(), id);
          event(id, "error", String(error.status));
        }
        throw error;
      }
    });
  }

  app.get(
    "/api/providers",
    route((req, res) => {
      const u = user(req);
      res.json({
        workspaceId: u.workspaceId,
        items: ["greenhouse", "recall"].map((p) => ({
          id: p,
          name:
            p === "greenhouse" ? "Greenhouse ATS" : "Recall.ai meeting capture",
          ...setup(p as "greenhouse" | "recall", u),
          ...(p === "greenhouse"
            ? (() => {
                const row = store.db
                  .prepare(
                    "SELECT last_sync,last_error,counts FROM provider_syncs WHERE workspace_id=? AND provider='greenhouse'",
                  )
                  .get(u.workspaceId);
                return {
                  lastSync: row?.last_sync || null,
                  lastError: row?.last_error || null,
                  counts: JSON.parse(String(row?.counts || "{}")),
                };
              })()
            : {}),
        })),
      });
    }),
  );
  app.post(
    "/api/providers/greenhouse/sync",
    route(async (req, res) => {
      const u = user(req, true);
      requireSetup("greenhouse", u);
      await locked(`greenhouse:${u.workspaceId}`, async () => {
        try {
          const token = await request("https://auth.greenhouse.io/token", {
            method: "POST",
            headers: {
              Authorization: `Basic ${Buffer.from(`${env.GREENHOUSE_CLIENT_ID}:${env.GREENHOUSE_CLIENT_SECRET}`).toString("base64")}`,
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              grant_type: "client_credentials",
              ...(env.GREENHOUSE_USER_ID
                ? { sub: env.GREENHOUSE_USER_ID }
                : {}),
            }),
          });
          if (!text(token.data?.access_token, 20000))
            fail(502, "Greenhouse did not return an access token.");
          async function list(kind: string) {
            let next = `https://harvest.greenhouse.io/v3/${kind}?per_page=100${kind === "candidates" ? "&private=false" : kind === "jobs" ? "&confidential=false" : ""}`;
            const items: any[] = [];
            const seen = new Set<string>();
            for (let page = 0; page < 10 && next; page++) {
              const url = new URL(next);
              if (
                url.origin !== "https://harvest.greenhouse.io" ||
                url.pathname !== `/v3/${kind}` ||
                url.username ||
                url.password ||
                seen.has(next)
              )
                fail(502, "Greenhouse returned an unsafe pagination link.");
              seen.add(next);
              const result = await request(next, {
                headers: { Authorization: `Bearer ${token.data.access_token}` },
              });
              if (!Array.isArray(result.data) || result.data.length > 500)
                fail(502, "Greenhouse returned an invalid resource list.");
              items.push(...result.data);
              if (items.length > 1000)
                fail(
                  413,
                  "This import exceeds 1,000 records per resource. No data was imported.",
                );
              const link = result.headers.get("link") || "";
              next =
                link
                  .split(",")
                  .map((v) => v.match(/<([^>]+)>;\s*rel="next"/))
                  .find(Boolean)?.[1] || "";
            }
            if (next)
              fail(
                413,
                "This import exceeds the 10-page limit. No data was imported.",
              );
            return items;
          }
          const jobs = await list("jobs"),
            candidates = await list("candidates"),
            applications = await list("applications");
          current(req, u);
          const counts = {
            jobs: 0,
            candidates: 0,
            applications: 0,
            updated: 0,
            skipped: 0,
          };
          const synchronized = stamp();
          store.transaction(() => {
            function importItem(
              kind: "jobs" | "candidates" | "applications",
              external: unknown,
              source: Record<string, unknown>,
              initial: Record<string, unknown>,
            ) {
              const externalKey = externalId(external);
              if (!externalKey) {
                counts.skipped++;
                return null;
              }
              const mapped = store.db
                .prepare(
                  "SELECT resource_id FROM provider_imports WHERE workspace_id=? AND provider='greenhouse' AND kind=? AND external_id=?",
                )
                .get(u.workspaceId, kind, externalKey);
              const existing = mapped?.resource_id
                ? store.get(u.workspaceId, kind, String(mapped.resource_id))
                : undefined;
              if (mapped && !existing) {
                counts.skipped++;
                return null;
              }
              const sourceData = {
                provider: "greenhouse",
                externalId: externalKey,
                ...source,
                syncedAt: synchronized,
              };
              if (existing) {
                store.update(u.workspaceId, kind, {
                  ...existing,
                  ats: sourceData,
                  updatedAt: synchronized,
                });
                store.db
                  .prepare(
                    "UPDATE provider_imports SET source=?,synced_at=? WHERE workspace_id=? AND provider='greenhouse' AND kind=? AND external_id=?",
                  )
                  .run(
                    JSON.stringify(sourceData),
                    synchronized,
                    u.workspaceId,
                    kind,
                    externalKey,
                  );
                counts.updated++;
                return existing.id;
              }
              const id = randomUUID();
              store.insert(u.workspaceId, kind, {
                id,
                ...initial,
                ats: sourceData,
                createdAt: synchronized,
                updatedAt: synchronized,
              });
              store.db
                .prepare(
                  "INSERT INTO provider_imports(workspace_id,provider,kind,external_id,resource_id,source,synced_at) VALUES(?,'greenhouse',?,?,?,?,?)",
                )
                .run(
                  u.workspaceId,
                  kind,
                  externalKey,
                  id,
                  JSON.stringify(sourceData),
                  synchronized,
                );
              counts[kind]++;
              return id;
            }
            const jobMap = new Map<string, { id: string; title: string }>(),
              candidateMap = new Map<
                string,
                { id: string; name: string; email: string }
              >();
            for (const job of jobs) {
              if (!job || job.confidential === true) continue;
              const title = text(job.name, 300) || "Greenhouse role",
                source = {
                  title,
                  status: text(job.status),
                  requisitionId: text(job.requisition_id),
                };
              const id = importItem("jobs", job.id, source, {
                title,
                status: "draft",
                description: "",
                notes:
                  "Imported from Greenhouse. Provider status is stored separately.",
              });
              if (id) jobMap.set(externalId(job.id), { id, title });
            }
            for (const candidate of candidates) {
              if (!candidate || candidate.private === true) continue;
              const name =
                  [
                    text(candidate.first_name, 150),
                    text(candidate.last_name, 150),
                  ]
                    .filter(Boolean)
                    .join(" ") || "Greenhouse candidate",
                email = text(candidate.email_addresses?.[0]?.value, 254),
                source = {
                  name,
                  email,
                  company: text(candidate.company, 300),
                  role: text(candidate.title, 300),
                };
              const id = importItem("candidates", candidate.id, source, {
                ...source,
                status: "unreviewed",
                source: "Greenhouse",
                notes: "",
              });
              if (id)
                candidateMap.set(externalId(candidate.id), { id, name, email });
            }
            for (const application of applications) {
              if (!application) continue;
              const c = candidateMap.get(externalId(application.candidate_id)),
                j = jobMap.get(externalId(application.job_id));
              // An application can reveal the stage of a confidential job even
              // when its candidate is public. Import only relationships whose
              // candidate AND nonconfidential job were included in this sync.
              if (!c || !j) {
                counts.skipped++;
                continue;
              }
              const source = {
                status: text(application.status),
                stage: text(application.stage_name),
                candidateExternalId: externalId(application.candidate_id),
                jobExternalId: externalId(application.job_id),
              };
              importItem("applications", application.id, source, {
                name: c.name,
                email: c.email,
                candidateId: c.id,
                jobId: j.id,
                jobTitle: j.title,
                status: "applied",
                notes: "",
                source: "Greenhouse",
              });
            }
            store.db
              .prepare(
                "INSERT INTO provider_syncs(workspace_id,provider,last_sync,last_error,counts) VALUES(?,'greenhouse',?,NULL,?) ON CONFLICT(workspace_id,provider) DO UPDATE SET last_sync=excluded.last_sync,last_error=NULL,counts=excluded.counts",
              )
              .run(u.workspaceId, synchronized, JSON.stringify(counts));
          });
          res.json({ ok: true, counts, lastSync: synchronized });
        } catch (error) {
          if (error instanceof ProviderError)
            store.db
              .prepare(
                "INSERT INTO provider_syncs(workspace_id,provider,last_error) VALUES(?,'greenhouse',?) ON CONFLICT(workspace_id,provider) DO UPDATE SET last_error=excluded.last_error",
              )
              .run(u.workspaceId, error.message);
          throw error;
        }
      });
    }),
  );
  app.get(
    "/api/captures",
    route((req, res) => {
      const u = user(req);
      const rows = store.db
        .prepare(
          `SELECT * FROM meeting_captures WHERE workspace_id=? ${isWorkspaceAdmin(u) ? "" : "AND user_id=?"} ORDER BY created_at DESC LIMIT 100`,
        )
        .all(
          ...(isWorkspaceAdmin(u) ? [u.workspaceId] : [u.workspaceId, u.id]),
        ) as Capture[];
      res.json({ items: rows.map(safeCapture) });
    }),
  );
  app.post(
    "/api/captures",
    route(async (req, res) => {
      const u = user(req, true);
      requireSetup("recall", u);
      const input = createSchema.parse(req.body),
        meetingUrl = meetingAddress(input.meetingUrl),
        joinAt = input.joinAt || null;
      if (
        joinAt &&
        (Date.parse(joinAt) < now() + 600000 ||
          Date.parse(joinAt) > now() + 30 * 86400000)
      )
        fail(
          400,
          "Schedule a capture between 10 minutes and 30 days ahead, or leave the time empty to join now.",
        );
      const fingerprint = hash(
        JSON.stringify({ title: input.title, meetingUrl, joinAt }),
      );
      await locked(`create:${u.workspaceId}`, async () => {
        const previous = store.db
          .prepare(
            "SELECT * FROM meeting_captures WHERE workspace_id=? AND user_id=? AND request_key=?",
          )
          .get(u.workspaceId, u.id, input.requestKey) as Capture | undefined;
        if (previous) {
          if (previous.request_hash !== fingerprint)
            fail(
              409,
              "This request key was already used for a different capture.",
            );
          res.json({ item: safeCapture(previous) });
          return;
        }
        const duplicate = store.db
          .prepare(
            "SELECT id FROM meeting_captures WHERE workspace_id=? AND meeting_url=? AND COALESCE(join_at,'')=? AND status NOT IN ('done','fatal','cancelled','failed')",
          )
          .get(u.workspaceId, meetingUrl, joinAt || "");
        if (duplicate)
          fail(
            409,
            "An active or unresolved capture already exists for this meeting and time.",
          );
        const id = randomUUID(),
          created = stamp();
        store.db
          .prepare(
            "INSERT INTO meeting_captures(id,workspace_id,user_id,request_key,request_hash,title,meeting_url,join_at,consent_at,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'creating',?,?)",
          )
          .run(
            id,
            u.workspaceId,
            u.id,
            input.requestKey,
            fingerprint,
            input.title,
            meetingUrl,
            joinAt,
            created,
            created,
            created,
          );
        event(id, "consent", "recording_acknowledged");
        try {
          const data = await recall("/bot/", "POST", {
            meeting_url: meetingUrl,
            bot_name: "ArkOffer Notetaker",
            ...(joinAt ? { join_at: joinAt } : {}),
            recording_config: {
              transcript: {
                provider: {
                  recallai_streaming: {
                    mode: "prioritize_accuracy",
                    language_code: "auto",
                  },
                },
              },
            },
            chat: {
              on_bot_join: {
                send_to: "everyone",
                message:
                  "ArkOffer is recording and transcribing this meeting. Please tell the organizer if you do not consent.",
              },
            },
            metadata: { arkoffer_capture_id: id },
          });
          if (!uuid(data?.id))
            fail(
              502,
              "Recall did not return a valid bot ID. Check the Recall dashboard before creating another capture.",
            );
          const observed = observation(data, data.id);
          store.db
            .prepare(
              "UPDATE meeting_captures SET bot_id=?,status=?,updated_at=? WHERE id=?",
            )
            .run(data.id, observed.status, stamp(), id);
          event(id, "create", observed.status);
          res.status(201).json({ item: safeCapture(getCapture(u, id)) });
        } catch (error) {
          const rejected =
            error instanceof ProviderError &&
            [400, 401, 403, 404, 422, 429, 507].includes(
              error.providerStatus || 0,
            );
          const message = rejected
            ? error.message
            : "The capture creation outcome is unknown. Check the Recall dashboard before attempting another capture.";
          store.db
            .prepare(
              "UPDATE meeting_captures SET status=?,last_error=?,updated_at=? WHERE id=?",
            )
            .run(rejected ? "failed" : "unknown", message, stamp(), id);
          event(id, "create", rejected ? "failed" : "unknown");
          throw new ProviderError(502, message);
        }
      });
    }),
  );
  app.post(
    "/api/captures/:id/recover",
    route(async (req, res) => {
      await captureAction(req, String(req.params.id), async (u, row) => {
        if (row.bot_id || row.status !== "unknown")
          fail(409, "Only an unresolved creation can be recovered.");
        const input = z
          .object({ botId: z.string().uuid() })
          .strict()
          .parse(req.body);
        const bot = await recall(`/bot/${input.botId}/`);
        if (bot?.metadata?.arkoffer_capture_id !== row.id)
          fail(409, "This Recall bot does not belong to this capture request.");
        current(req, u);
        const observed = observation(bot, input.botId);
        store.db
          .prepare("UPDATE meeting_captures SET bot_id=? WHERE id=?")
          .run(input.botId, row.id);
        applyObservation(row, observed);
        event(row.id, "recover", observed.status);
        res.json({ item: safeCapture(getCapture(u, row.id)) });
      });
    }),
  );
  app.post(
    "/api/captures/:id/refresh",
    route(async (req, res) => {
      await captureAction(req, String(req.params.id), async (u, row) => {
        if (!row.bot_id)
          fail(
            409,
            "No provider bot ID is available. Check the Recall dashboard.",
          );
        const data = await recall(`/bot/${row.bot_id}/`);
        current(req, u);
        applyObservation(row, observation(data, row.bot_id!));
        res.json({ item: safeCapture(getCapture(u, row.id)) });
      });
    }),
  );
  app.post(
    "/api/captures/:id/leave",
    route(async (req, res) => {
      await captureAction(req, String(req.params.id), async (u, row) => {
        if (!row.bot_id || terminal.has(row.status))
          fail(409, "This capture has no active bot to remove.");
        await recall(`/bot/${row.bot_id}/leave_call/`, "POST", {}, true);
        store.db
          .prepare(
            "UPDATE meeting_captures SET status='leave_requested',updated_at=?,last_error=NULL WHERE id=?",
          )
          .run(stamp(), row.id);
        event(row.id, "leave", "requested");
        res.json({ item: safeCapture(getCapture(u, row.id)) });
      });
    }),
  );
  app.delete(
    "/api/captures/:id",
    route(async (req, res) => {
      await captureAction(req, String(req.params.id), async (u, row) => {
        if (
          !row.bot_id ||
          !row.join_at ||
          Date.parse(row.join_at) <= now() ||
          terminal.has(row.status)
        )
          fail(
            409,
            "Only a scheduled capture that has not joined can be cancelled. Use Leave call for an active bot.",
          );
        await recall(`/bot/${row.bot_id}/`, "DELETE", undefined, true);
        store.db
          .prepare(
            "UPDATE meeting_captures SET status='cancelled',updated_at=?,last_error=NULL WHERE id=?",
          )
          .run(stamp(), row.id);
        event(row.id, "cancel", "cancelled");
        res.json({ item: safeCapture(getCapture(u, row.id)) });
      });
    }),
  );
  app.post(
    "/api/captures/:id/import",
    route(async (req, res) => {
      await captureAction(req, String(req.params.id), async (u, row) => {
        if (row.imported_at) {
          if (!row.conversation_id)
            fail(
              409,
              "The imported conversation was deleted. It will not be recreated.",
            );
          res.json({
            item: store.get(
              u.workspaceId,
              "conversations",
              row.conversation_id!,
            ),
            alreadyImported: true,
          });
          return;
        }
        if (!row.bot_id) fail(409, "No provider bot ID is available.");
        const data = await recall(`/bot/${row.bot_id}/`),
          observed = observation(data, row.bot_id!);
        current(req, u);
        applyObservation(row, observed);
        if (!observed.transcriptReady)
          fail(
            409,
            "Recall has not finished the transcript. Refresh after the meeting and transcription complete.",
          );
        let url: URL;
        try {
          url = new URL(observed.downloadUrl);
        } catch {
          return fail(
            502,
            "Recall returned an invalid transcript download address.",
          );
        }
        const safeHost =
          /^[a-z0-9][a-z0-9.-]*\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.test(
            url.hostname,
          ) ||
          [
            "us-east-1.recall.ai",
            "us-west-2.recall.ai",
            "eu-central-1.recall.ai",
            "ap-northeast-1.recall.ai",
          ].includes(url.hostname);
        if (
          url.protocol !== "https:" ||
          url.port ||
          url.username ||
          url.password ||
          !safeHost
        )
          fail(
            502,
            "The transcript download host is not a supported Recall or Amazon S3 host. No download was attempted.",
          );
        const downloaded = await request(url.href, {}, 8_000_000);
        if (!Array.isArray(downloaded.data) || downloaded.data.length > 20000)
          fail(502, "Recall returned an invalid transcript.");
        const transcript = downloaded.data
          .map((turn: any) => {
            if (!turn || !Array.isArray(turn.words)) return "";
            const words = turn.words
              .map((word: any) => text(word?.text, 2000))
              .filter(Boolean)
              .join(" ");
            return words
              ? `${text(turn.participant?.name, 150) || "Speaker"}: ${words}`
              : "";
          })
          .filter(Boolean)
          .join("\n");
        if (!transcript.trim())
          fail(409, "The completed transcript contains no speech.");
        if (transcript.length > 500000)
          fail(
            413,
            "The transcript exceeds the 500,000-character import limit.",
          );
        current(req, u);
        const id = randomUUID(),
          created = stamp();
        let item: Resource;
        store.transaction(() => {
          item = store.insert(u.workspaceId, "conversations", {
            id,
            title: row.title,
            transcript,
            sections: [],
            tldr: "",
            candidate: "",
            interviewer: u.name,
            date: row.join_at || row.created_at,
            status: "ready",
            archived: false,
            collectionIds: [],
            capture: {
              provider: "recall",
              captureId: row.id,
              botId: row.bot_id,
              recordingId: observed.recordingId,
            },
            createdAt: created,
            updatedAt: created,
          });
          registerConversationOwner(store, u.workspaceId, id, row.user_id);
          store.db
            .prepare(
              "UPDATE meeting_captures SET conversation_id=?,imported_at=?,updated_at=?,last_error=NULL WHERE id=?",
            )
            .run(id, created, created, row.id);
          event(row.id, "import", "completed");
        });
        res.status(201).json({ item: item! });
      });
    }),
  );
}
