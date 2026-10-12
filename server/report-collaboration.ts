import { createHash, randomBytes, randomUUID } from "node:crypto";
import { urlencoded, type Express } from "express";
import { z } from "zod";
import { AccessError } from "./access.js";
import { hashToken, sessionUser, userById, type User } from "./auth.js";
import type { Store } from "./db.js";
import { createMailTransport, MailError } from "./mail.js";

type Row = Record<string, string | number | null>;
export type ReportPermission = "owner" | "editor" | "viewer";
const fail = (status: number, message: string): never => {
  throw new AccessError(status, message);
};
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export function initializeReportCollaboration(store: Store) {
  const db = store.db;
  if (
    !db
      .prepare("PRAGMA table_info(ai_report_views)")
      .all()
      .some((c) => c.name === "sharing_revision")
  )
    db.exec(
      "ALTER TABLE ai_report_views ADD COLUMN sharing_revision INTEGER NOT NULL DEFAULT 1",
    );
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_report_grants (view_id TEXT NOT NULL REFERENCES ai_report_views(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, permission TEXT NOT NULL CHECK(permission IN ('viewer','editor')), created_at TEXT NOT NULL, PRIMARY KEY(view_id,user_id));
    CREATE TABLE IF NOT EXISTS ai_report_preferences (view_id TEXT NOT NULL REFERENCES ai_report_views(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, favorite INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(view_id,user_id));
    INSERT OR IGNORE INTO ai_report_preferences SELECT id,author_id,favorite FROM ai_report_views;
    CREATE TABLE IF NOT EXISTS ai_report_subscriptions (id TEXT PRIMARY KEY, view_id TEXT NOT NULL REFERENCES ai_report_views(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, workspace_id TEXT NOT NULL REFERENCES workspaces(id), revision INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL, frequency TEXT NOT NULL CHECK(frequency IN ('immediate','weekly','monthly')), email TEXT NOT NULL, enabled_at INTEGER NOT NULL, next_at INTEGER NOT NULL, unsubscribe_hash TEXT NOT NULL UNIQUE, unsubscribe_token TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(view_id,user_id));
    CREATE TABLE IF NOT EXISTS ai_report_deliveries (id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL REFERENCES ai_report_subscriptions(id) ON DELETE CASCADE, revision INTEGER NOT NULL, run_ids TEXT NOT NULL, email TEXT NOT NULL, mode TEXT NOT NULL, transport_hash TEXT NOT NULL, status TEXT NOT NULL, provider_id TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS ai_report_deliveries_queue ON ai_report_deliveries(status,created_at);
    CREATE TABLE IF NOT EXISTS ai_report_subscription_events (subscription_id TEXT NOT NULL REFERENCES ai_report_subscriptions(id) ON DELETE CASCADE, revision INTEGER NOT NULL, run_id TEXT NOT NULL REFERENCES ai_report_runs(id) ON DELETE CASCADE, PRIMARY KEY(subscription_id,revision,run_id));
  `);
  for (const [name, definition] of Object.entries({
    notify_results: "INTEGER NOT NULL DEFAULT 1",
    notify_upcoming: "INTEGER NOT NULL DEFAULT 0",
    utc_hour: "INTEGER NOT NULL DEFAULT 9",
    weekday: "INTEGER NOT NULL DEFAULT 1",
    month_day: "INTEGER NOT NULL DEFAULT 1",
    mode: "TEXT NOT NULL DEFAULT 'outbox'",
    transport_hash: "TEXT NOT NULL DEFAULT ''",
  })) {
    if (
      !db
        .prepare("PRAGMA table_info(ai_report_subscriptions)")
        .all()
        .some((c) => c.name === name)
    )
      db.exec(
        `ALTER TABLE ai_report_subscriptions ADD COLUMN ${name} ${definition}`,
      );
  }
  if (
    !db
      .prepare("PRAGMA table_info(ai_report_deliveries)")
      .all()
      .some((c) => c.name === "upcoming_json")
  )
    db.exec(
      "ALTER TABLE ai_report_deliveries ADD COLUMN upcoming_json TEXT NOT NULL DEFAULT '[]'",
    );
  db.exec(
    "CREATE TABLE IF NOT EXISTS ai_report_upcoming_events (subscription_id TEXT NOT NULL REFERENCES ai_report_subscriptions(id) ON DELETE CASCADE, revision INTEGER NOT NULL, source_id TEXT NOT NULL, event_at TEXT NOT NULL, PRIMARY KEY(subscription_id,revision,source_id,event_at))",
  );
  db.prepare(
    "UPDATE ai_report_deliveries SET status='unknown',error='Processing stopped while delivery was in progress. Verify in the provider dashboard; this message is not retried automatically.' WHERE status='sending'",
  ).run();
}
export function reportPermission(
  store: Store,
  user: User,
  row: Row,
): ReportPermission | null {
  if (
    row.workspace_id !== user.workspaceId ||
    !userById(store, String(row.author_id), user.workspaceId)
  )
    return null;
  if (row.author_id === user.id) return "owner";
  const grant = store.db
    .prepare(
      "SELECT permission FROM ai_report_grants WHERE view_id=? AND user_id=?",
    )
    .get(String(row.id), user.id);
  return grant?.permission === "viewer" || grant?.permission === "editor"
    ? grant.permission
    : null;
}
export function requireReport(
  store: Store,
  user: User,
  id: string,
  action: "read" | "edit" | "manage" = "read",
): Row {
  const row = store.db
    .prepare("SELECT * FROM ai_report_views WHERE id=? AND workspace_id=?")
    .get(id, user.workspaceId) as Row | undefined;
  const permission = row && reportPermission(store, user, row);
  if (!row || !permission) return fail(404, "Report view not found.");
  if (action === "manage" && permission !== "owner")
    fail(
      403,
      "Only the report owner can manage sharing or delete this report.",
    );
  if (action === "edit" && permission === "viewer")
    fail(403, "This report is shared with you as read-only.");
  return row;
}
const halt = (store: Store, subscriptionId: string, reason: string) =>
  store.db
    .prepare(
      "UPDATE ai_report_deliveries SET status='cancelled',error=?,updated_at=? WHERE subscription_id=? AND status IN ('queued','outbox')",
    )
    .run(reason, Date.now(), subscriptionId);
function disable(store: Store, id: string, now: number, reason: string) {
  store.db
    .prepare(
      "UPDATE ai_report_subscriptions SET enabled=0,revision=revision+1,updated_at=? WHERE id=? AND enabled=1",
    )
    .run(now, id);
  halt(store, id, reason);
}
/** Public confirmation is intentionally separate so it can precede the API sign-in middleware. */
export function registerReportSubscriptionUnsubscribe(
  app: Express,
  store: Store,
) {
  const subscription = (token: string) =>
    /^[a-f0-9]{64}$/.test(token)
      ? store.db
          .prepare(
            "SELECT id FROM ai_report_subscriptions WHERE unsubscribe_hash=?",
          )
          .get(hashToken(token))
      : undefined;
  const page = (body: string) =>
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="referrer" content="no-referrer"><title>ArkOffer report emails</title><body style="font:16px system-ui;max-width:520px;margin:80px auto;padding:24px"><h1>Report emails</h1>${body}</body></html>`;
  app.get("/api/report-subscriptions/unsubscribe/:token", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res
      .type("html")
      .send(
        page(
          subscription(String(req.params.token))
            ? `<p>Stop email updates for this report. Opening this page does not change your settings.</p><form method="post" action="${escape(req.path)}"><button type="submit">Unsubscribe</button></form>`
            : "<p>This subscription link is unavailable.</p>",
        ),
      );
  });
  app.post(
    "/api/report-subscriptions/unsubscribe/:token",
    urlencoded({ extended: false, limit: "1kb" }),
    (req, res) => {
      const row = subscription(String(req.params.token));
      if (row)
        store.transaction(() =>
          disable(
            store,
            String(row.id),
            Date.now(),
            "Unsubscribed from this report.",
          ),
        );
      res.setHeader("Cache-Control", "no-store");
      res
        .type("html")
        .send(
          page(
            "<p>Report email updates have been stopped, or this subscription is no longer available.</p>",
          ),
        );
    },
  );
}
export function nextReportDigest(
  now: number,
  frequency: string,
  schedule: { utcHour?: number; weekday?: number; monthDay?: number } = {},
) {
  if (frequency === "immediate") return now;
  const date = new Date(now),
    hour = schedule.utcHour ?? 9;
  date.setUTCHours(hour, 0, 0, 0);
  if (frequency === "weekly") {
    date.setUTCDate(
      date.getUTCDate() +
        (((schedule.weekday ?? 1) - date.getUTCDay() + 7) % 7),
    );
    if (date.getTime() <= now) date.setUTCDate(date.getUTCDate() + 7);
  } else {
    const day = schedule.monthDay ?? 1;
    const applyDay = () => {
      date.setUTCDate(1);
      const last = new Date(
        Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
      ).getUTCDate();
      date.setUTCDate(Math.min(day, last));
    };
    applyDay();
    if (date.getTime() <= now) {
      date.setUTCDate(1);
      date.setUTCMonth(date.getUTCMonth() + 1);
      applyDay();
    }
  }
  return date.getTime();
}
type Upcoming = { id: string; date: string; title: string };
export function registerReportCollaboration(
  app: Express,
  store: Store,
  options: {
    mail: ReturnType<typeof createMailTransport>;
    clock?: () => number;
    upcoming: (user: User, view: Row) => Upcoming[];
    matchingSourceIds: (user: User, view: Row) => string[];
    publicRun: (
      user: User,
      row: Row,
    ) => { rows: { unavailable?: boolean; sourceId?: unknown }[] };
  },
) {
  const db = store.db,
    clock = options.clock || Date.now,
    mail = options.mail;
  const fresh = (req: Parameters<typeof sessionUser>[1]) =>
    sessionUser(store, req) || fail(401, "Please sign in to manage reports.");
  const transportHash = () =>
    createHash("sha256")
      .update(
        JSON.stringify([
          mail.config.mode,
          mail.config.from,
          mail.config.replyTo,
          mail.publicUrl,
        ]),
      )
      .digest("hex");
  const verified = (user: User) =>
    !!db.prepare("SELECT email_verified_at FROM users WHERE id=?").get(user.id)
      ?.email_verified_at;
  const subscriptionRow = (user: User, id: string) =>
    db
      .prepare(
        "SELECT * FROM ai_report_subscriptions WHERE view_id=? AND user_id=?",
      )
      .get(id, user.id) as Row | undefined;
  const publicSubscription = (row?: Row) =>
    row
      ? {
          id: row.id,
          revision: row.revision,
          enabled: !!row.enabled,
          frequency: row.frequency,
          notifyResults: Boolean(row.notify_results),
          notifyUpcoming: Boolean(row.notify_upcoming),
          utcHour: row.utc_hour,
          weekday: row.weekday,
          monthDay: row.month_day,
          email: row.email,
          nextAt: new Date(Number(row.next_at)).toISOString(),
          updatedAt: new Date(Number(row.updated_at)).toISOString(),
        }
      : null;
  const publicDelivery = (row: Row) => ({
    id: row.id,
    status: row.status,
    mode: row.mode,
    createdAt: new Date(Number(row.created_at)).toISOString(),
    error: row.error,
  });
  function settings(user: User, id: string) {
    requireReport(store, user, id);
    const row = subscriptionRow(user, id);
    return {
      subscription: publicSubscription(row),
      email: user.email,
      verified: verified(user),
      setup: {
        mode: mail.config.mode,
        configured: mail.allowed(user.workspaceId),
      },
      deliveries: row
        ? (
            db
              .prepare(
                "SELECT * FROM ai_report_deliveries WHERE subscription_id=? ORDER BY created_at DESC,id DESC LIMIT 25",
              )
              .all(String(row.id)) as Row[]
          ).map(publicDelivery)
        : [],
    };
  }
  app.get("/api/report-views/:id/sharing", (req, res) => {
    const user = fresh(req),
      row = requireReport(store, user, String(req.params.id));
    const permission = reportPermission(store, user, row)!;
    res.json({
      revision: row.sharing_revision,
      permission,
      owner: {
        id: row.author_id,
        name:
          userById(store, String(row.author_id), user.workspaceId)?.name ||
          "Report owner",
      },
      grants:
        permission === "owner"
          ? db
              .prepare(
                "SELECT g.user_id AS userId,g.permission,u.name,u.email,m.status FROM ai_report_grants g JOIN users u ON u.id=g.user_id JOIN memberships m ON m.user_id=u.id AND m.workspace_id=? WHERE g.view_id=? ORDER BY u.name",
              )
              .all(user.workspaceId, String(row.id))
          : [],
      members:
        permission === "owner"
          ? db
              .prepare(
                "SELECT u.id,u.name,u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND m.status='active' AND u.id!=? ORDER BY u.name LIMIT 500",
              )
              .all(user.workspaceId, user.id)
          : [],
    });
  });
  app.put("/api/report-views/:id/sharing", (req, res) => {
    const user = fresh(req),
      id = String(req.params.id),
      row = requireReport(store, user, id, "manage");
    const input = z
      .object({
        revision: z.number().int().positive(),
        grants: z
          .array(
            z
              .object({
                userId: z.uuid(),
                permission: z.enum(["viewer", "editor"]),
              })
              .strict(),
          )
          .max(100),
      })
      .strict()
      .parse(req.body);
    if (input.revision !== row.sharing_revision)
      fail(409, "Sharing changed. Reload permissions before saving.");
    if (new Set(input.grants.map((g) => g.userId)).size !== input.grants.length)
      fail(400, "Choose each person once.");
    for (const grant of input.grants)
      if (
        grant.userId === user.id ||
        !userById(store, grant.userId, user.workspaceId)
      )
        fail(400, "Choose active members of this workspace.");
    store.transaction(() => {
      db.prepare("DELETE FROM ai_report_grants WHERE view_id=?").run(id);
      for (const grant of input.grants)
        db.prepare(
          "INSERT INTO ai_report_grants(view_id,user_id,permission,created_at) VALUES(?,?,?,?)",
        ).run(
          id,
          grant.userId,
          grant.permission,
          new Date(clock()).toISOString(),
        );
      db.prepare(
        "UPDATE ai_report_views SET sharing_revision=sharing_revision+1 WHERE id=?",
      ).run(id);
      for (const sub of db
        .prepare(
          "SELECT * FROM ai_report_subscriptions WHERE view_id=? AND user_id!=?",
        )
        .all(id, user.id) as Row[])
        if (!input.grants.some((g) => g.userId === sub.user_id))
          disable(store, String(sub.id), clock(), "Report access was revoked.");
    });
    res.json({ ok: true, revision: Number(row.sharing_revision) + 1 });
  });
  app.get("/api/report-views/:id/subscription", (req, res) =>
    res.json(settings(fresh(req), String(req.params.id))),
  );
  app.put("/api/report-views/:id/subscription", (req, res) => {
    const user = fresh(req),
      id = String(req.params.id);
    requireReport(store, user, id);
    const input = z
      .object({
        revision: z.number().int().nonnegative(),
        enabled: z.boolean(),
        frequency: z.enum(["immediate", "weekly", "monthly"]),
        notifyResults: z.boolean().default(true),
        notifyUpcoming: z.boolean().default(false),
        utcHour: z.number().int().min(0).max(23).default(9),
        weekday: z.number().int().min(0).max(6).default(1),
        monthDay: z.number().int().min(1).max(31).default(1),
      })
      .strict()
      .parse(req.body);
    if (input.enabled && !input.notifyResults && !input.notifyUpcoming)
      fail(400, "Choose at least one type of email update.");
    const old = subscriptionRow(user, id);
    if (input.revision !== Number(old?.revision || 0))
      fail(409, "Subscription changed. Reload before saving.");
    if (
      input.enabled &&
      (!mail.allowed(user.workspaceId) ||
        (mail.config.mode !== "outbox" && !verified(user)))
    )
      fail(
        409,
        "Live report emails require a verified account email and configured workspace mail delivery. Outbox mode can be tested without sending.",
      );
    if (
      !old &&
      Number(
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM ai_report_subscriptions WHERE user_id=?",
          )
          .get(user.id)?.n,
      ) >= 50
    )
      fail(409, "You have reached the limit of 50 report subscriptions.");
    const now = clock(),
      token = old
        ? String(old.unsubscribe_token)
        : randomBytes(32).toString("hex");
    store.transaction(() => {
      if (old) {
        halt(store, String(old.id), "Subscription settings changed.");
        db.prepare(
          "UPDATE ai_report_subscriptions SET revision=revision+1,enabled=?,frequency=?,email=?,enabled_at=?,next_at=?,updated_at=? WHERE id=?",
        ).run(
          Number(input.enabled),
          input.frequency,
          user.email,
          now,
          nextReportDigest(now, input.frequency, input),
          now,
          String(old.id),
        );
      } else
        db.prepare(
          "INSERT INTO ai_report_subscriptions(id,view_id,user_id,workspace_id,enabled,frequency,email,enabled_at,next_at,unsubscribe_hash,unsubscribe_token,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ).run(
          randomUUID(),
          id,
          user.id,
          user.workspaceId,
          Number(input.enabled),
          input.frequency,
          user.email,
          now,
          nextReportDigest(now, input.frequency, input),
          hashToken(token),
          token,
          now,
          now,
        );
      db.prepare(
        "UPDATE ai_report_subscriptions SET notify_results=?,notify_upcoming=?,utc_hour=?,weekday=?,month_day=?,mode=?,transport_hash=? WHERE view_id=? AND user_id=?",
      ).run(
        Number(input.notifyResults),
        Number(input.notifyUpcoming),
        input.utcHour,
        input.weekday,
        input.monthDay,
        mail.config.mode,
        transportHash(),
        id,
        user.id,
      );
    });
    res.json(settings(user, id));
  });
  function eligible(sub: Row) {
    const user = userById(store, String(sub.user_id), String(sub.workspace_id));
    if (
      !sub.enabled ||
      sub.mode !== mail.config.mode ||
      sub.transport_hash !== transportHash() ||
      !user ||
      user.email !== sub.email ||
      !mail.allowed(String(sub.workspace_id)) ||
      (mail.config.mode !== "outbox" && !verified(user))
    )
      return undefined;
    try {
      const view = requireReport(store, user, String(sub.view_id));
      return { user, view };
    } catch {
      return undefined;
    }
  }
  function contents(sub: Row, runIds: string[], upcoming: Upcoming[] = []) {
    const access = eligible(sub);
    if (!access) return undefined;
    let runs = 0,
      rows = 0;
    const matching = new Set(
      options.matchingSourceIds(access.user, access.view),
    );
    for (const id of runIds) {
      const run = db
        .prepare(
          "SELECT * FROM ai_report_runs WHERE id=? AND view_id=? AND workspace_id=? AND status IN ('complete','completed_with_issues')",
        )
        .get(id, String(sub.view_id), String(sub.workspace_id)) as
        Row | undefined;
      if (!run || run.revision !== access.view.revision) continue;
      const count = options
        .publicRun(access.user, run)
        .rows.filter(
          (r) => !r.unavailable && matching.has(String(r.sourceId)),
        ).length;
      if (count) {
        runs++;
        rows += count;
      }
    }
    const currentUpcoming = sub.notify_upcoming
      ? options
          .upcoming(access.user, access.view)
          .filter(
            (item) =>
              upcoming.some(
                (selected) =>
                  selected.id === item.id && selected.date === item.date,
              ) &&
              Date.parse(item.date) > clock() &&
              Date.parse(item.date) <= clock() + 30 * 60000,
          )
      : [];
    if (!runs && !currentUpcoming.length) return undefined;
    const definition = JSON.parse(String(access.view.definition)),
      name = String(definition.name).replace(/[\r\n]/g, " ");
    const url = `${mail.publicUrl}/app/reports/${sub.view_id}`,
      unsubscribeUrl = `${mail.publicUrl}/api/report-subscriptions/unsubscribe/${sub.unsubscribe_token}`;
    return {
      subject: `ArkOffer report update: ${name}`,
      text: `${name}\n\n${currentUpcoming.length ? "Upcoming selected conversations:\n" + currentUpcoming.map((item) => `${item.title.replace(/[\r\n]/g, " ")} — ${item.date}`).join("\n") + "\n\n" : ""}${runs} newly completed report ${runs === 1 ? "run" : "runs"} with ${rows} currently accessible result ${rows === 1 ? "row" : "rows"}.\n\nOpen the report to review its answers and source evidence: ${url}\n\nChanged or inaccessible source results are excluded. These updates notify you of completed runs and selected upcoming conversations; they do not start AI extraction.\n\nUnsubscribe: ${unsubscribeUrl}`,
      unsubscribeUrl,
      runs,
      rows,
    };
  }
  app.get(
    "/api/report-views/:id/subscription/deliveries/:deliveryId",
    (req, res) => {
      const user = fresh(req),
        id = String(req.params.id);
      requireReport(store, user, id);
      const sub = subscriptionRow(user, id),
        row =
          sub &&
          (db
            .prepare(
              "SELECT * FROM ai_report_deliveries WHERE id=? AND subscription_id=?",
            )
            .get(String(req.params.deliveryId), String(sub.id)) as
            Row | undefined);
      if (!sub || !row) return fail(404, "Report email not found.");
      const preview =
        Number(row.revision) === Number(sub.revision) &&
        !["cancelled", "unknown"].includes(String(row.status))
          ? contents(
              sub,
              JSON.parse(String(row.run_ids)),
              JSON.parse(String(row.upcoming_json || "[]")),
            )
          : undefined;
      res.json({
        item: publicDelivery(row),
        preview: preview
          ? { to: user.email, subject: preview.subject, text: preview.text }
          : null,
        unavailable: !preview,
      });
    },
  );
  let stopped = false,
    active: Promise<void> | undefined;
  async function process() {
    const now = clock();
    for (const sub of db
      .prepare(
        "SELECT * FROM ai_report_subscriptions WHERE enabled=1 AND (next_at<=? OR notify_upcoming=1) ORDER BY next_at,id LIMIT 1000",
      )
      .all(now) as Row[]) {
      const access = eligible(sub);
      if (!access) {
        disable(
          store,
          String(sub.id),
          now,
          "Account, report access, email or delivery configuration changed.",
        );
        continue;
      }
      const due = Number(sub.next_at) <= now;
      const runs =
        due && sub.notify_results
          ? db
              .prepare(
                "SELECT r.id FROM ai_report_runs r WHERE r.view_id=? AND r.workspace_id=? AND r.status IN ('complete','completed_with_issues') AND r.completed_at>=? AND NOT EXISTS(SELECT 1 FROM ai_report_subscription_events e WHERE e.subscription_id=? AND e.revision=? AND e.run_id=r.id) ORDER BY r.completed_at,r.id LIMIT 100",
              )
              .all(
                String(sub.view_id),
                String(sub.workspace_id),
                new Date(Number(sub.enabled_at)).toISOString(),
                String(sub.id),
                Number(sub.revision),
              )
          : [];
      const runIds = runs.map((r) => String(r.id));
      const upcoming = sub.notify_upcoming
        ? options
            .upcoming(access.user, access.view)
            .filter(
              (item) =>
                Date.parse(item.date) > now &&
                Date.parse(item.date) <= now + 30 * 60000 &&
                !db
                  .prepare(
                    "SELECT 1 FROM ai_report_upcoming_events WHERE subscription_id=? AND source_id=? AND event_at=?",
                  )
                  .get(String(sub.id), item.id, item.date),
            )
        : [];
      store.transaction(() => {
        const current = db
          .prepare(
            "SELECT * FROM ai_report_subscriptions WHERE id=? AND revision=? AND enabled=1",
          )
          .get(String(sub.id), Number(sub.revision)) as Row | undefined;
        if (!current || !eligible(current)) return;
        // Claims and the message insert share a write transaction. Another worker
        // may have discovered the same events before this transaction acquired its lock.
        const claimedRuns = runIds.filter(
          (id) =>
            db
              .prepare(
                "INSERT OR IGNORE INTO ai_report_subscription_events(subscription_id,revision,run_id) VALUES(?,?,?)",
              )
              .run(String(sub.id), Number(sub.revision), id).changes,
        );
        const claimedUpcoming = upcoming.filter(
          (item) =>
            !db
              .prepare(
                "SELECT 1 FROM ai_report_upcoming_events WHERE subscription_id=? AND source_id=? AND event_at=?",
              )
              .get(String(sub.id), item.id, item.date) &&
            db
              .prepare(
                "INSERT OR IGNORE INTO ai_report_upcoming_events(subscription_id,revision,source_id,event_at) VALUES(?,?,?,?)",
              )
              .run(String(sub.id), Number(sub.revision), item.id, item.date)
              .changes,
        );
        const content = contents(current, claimedRuns, claimedUpcoming);
        if (content)
          db.prepare(
            "INSERT INTO ai_report_deliveries(id,subscription_id,revision,run_ids,upcoming_json,email,mode,transport_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'queued',?,?)",
          ).run(
            randomUUID(),
            String(sub.id),
            Number(sub.revision),
            JSON.stringify(claimedRuns),
            JSON.stringify(claimedUpcoming),
            String(sub.email),
            mail.config.mode,
            transportHash(),
            now,
            now,
          );
        if (due)
          db.prepare(
            "UPDATE ai_report_subscriptions SET next_at=? WHERE id=?",
          ).run(
            nextReportDigest(now, String(sub.frequency), {
              utcHour: Number(sub.utc_hour),
              weekday: Number(sub.weekday),
              monthDay: Number(sub.month_day),
            }),
            String(sub.id),
          );
      });
    }
    for (const row of db
      .prepare(
        "SELECT * FROM ai_report_deliveries WHERE status='queued' ORDER BY created_at,id LIMIT 25",
      )
      .all() as Row[]) {
      if (stopped) return;
      const sub = db
        .prepare("SELECT * FROM ai_report_subscriptions WHERE id=?")
        .get(String(row.subscription_id)) as Row | undefined;
      const content =
        sub &&
        sub.revision === row.revision &&
        row.email === sub.email &&
        row.transport_hash === transportHash()
          ? contents(
              sub,
              JSON.parse(String(row.run_ids)),
              JSON.parse(String(row.upcoming_json || "[]")),
            )
          : undefined;
      if (!sub || !content) {
        db.prepare(
          "UPDATE ai_report_deliveries SET status='cancelled',error='Current report access, source evidence, subscription or mail configuration is no longer valid.',updated_at=? WHERE id=? AND status='queued'",
        ).run(now, String(row.id));
        continue;
      }
      if (
        !db
          .prepare(
            "UPDATE ai_report_deliveries SET status='sending',updated_at=? WHERE id=? AND status='queued'",
          )
          .run(now, String(row.id)).changes
      )
        continue;
      try {
        const result = await mail.send({
          to: String(row.email),
          subject: content.subject,
          text: content.text,
          idempotencyKey: `report-${row.id}`,
          unsubscribeUrl: content.unsubscribeUrl,
        });
        db.prepare(
          "UPDATE ai_report_deliveries SET status=?,provider_id=?,updated_at=? WHERE id=? AND status='sending'",
        ).run(
          result.state === "outbox" ? "outbox" : "accepted",
          result.id,
          clock(),
          String(row.id),
        );
      } catch (error) {
        const unknown =
          !(error instanceof MailError) || error.kind === "unknown";
        db.prepare(
          "UPDATE ai_report_deliveries SET status=?,error=?,updated_at=? WHERE id=? AND status='sending'",
        ).run(
          unknown ? "unknown" : "failed",
          unknown
            ? "The provider outcome is unknown. Verify delivery before taking any further action; automatic retries are disabled."
            : "The provider rejected this email. Check mail configuration. No automatic retry will occur.",
          clock(),
          String(row.id),
        );
      }
    }
  }
  return {
    tick() {
      if (stopped) return Promise.resolve();
      if (active) return active;
      active = process().finally(() => {
        active = undefined;
      });
      return active;
    },
    start() {
      stopped = false;
    },
    async stop() {
      stopped = true;
      await active;
    },
  };
}
