import type { Express, Request, Response } from "express";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { sessionUser, hashToken, type User } from "./auth.js";
import type { Resource, Store } from "./db.js";
import { createMailTransport, MailError, type MailConfig } from "./mail.js";

type Options = {
  clock?: () => number;
  fetch?: typeof fetch;
  mail?: MailConfig;
};
type Row = Record<string, string | number | null>;
class OutreachError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const fail = (status: number, message: string): never => {
  throw new OutreachError(status, message);
};
const inputText = (value: unknown) => (typeof value === "string" ? value : "");
const emailSchema = z.string().trim().toLowerCase().email().max(254);
const stepSchema = z
  .array(
    z.object({
      subject: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .refine(
          (value) => !/[\r\n]/.test(value),
          "Subject cannot contain newlines.",
        ),
      body: z.string().trim().min(1).max(5000),
      delayDays: z.number().int().min(0).max(365),
    }),
  )
  .min(1)
  .max(10)
  .refine(
    (steps) => steps.every((step, index) => index === 0 || step.delayDays >= 1),
    "Follow-ups must wait at least one day after the previous step.",
  );
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const DAY = 86_400_000;
const MAX_RECIPIENTS = 100;
const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );

/** Register after the application's Origin checks, before its catch-all auth middleware.
 * start() is explicitly invoked by the server entry point; tests call tick() with an injected transport.
 */
export function registerOutreach(
  app: Express,
  store: Store,
  options: Options = {},
) {
  const clock = options.clock || Date.now;
  const transport = createMailTransport(options.mail, options.fetch);
  const db = store.db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS outreach_enrollments (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      sequence_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
      candidate_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
      email TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL, mode TEXT NOT NULL,
      sender TEXT NOT NULL, reply_to TEXT NOT NULL, public_url TEXT NOT NULL,
      unsubscribe_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,
      paused_at INTEGER, updated_at INTEGER NOT NULL, UNIQUE(sequence_id,email)
    );
    CREATE INDEX IF NOT EXISTS outreach_workspace ON outreach_enrollments(workspace_id,sequence_id);
    CREATE TABLE IF NOT EXISTS outreach_messages (
      id TEXT PRIMARY KEY, enrollment_id TEXT NOT NULL REFERENCES outreach_enrollments(id) ON DELETE CASCADE,
      step_index INTEGER NOT NULL, delay_days INTEGER NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL,
      unsubscribe_url TEXT NOT NULL, status TEXT NOT NULL, due_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
      provider_id TEXT, provider_event TEXT, error TEXT, first_attempt_at INTEGER, claimed_at INTEGER,
      checked_at INTEGER, updated_at INTEGER NOT NULL, UNIQUE(enrollment_id,step_index)
    );
    CREATE INDEX IF NOT EXISTS outreach_due ON outreach_messages(status,due_at);
    CREATE TABLE IF NOT EXISTS outreach_events (
      id TEXT PRIMARY KEY, enrollment_id TEXT NOT NULL REFERENCES outreach_enrollments(id) ON DELETE CASCADE,
      message_id TEXT REFERENCES outreach_messages(id) ON DELETE CASCADE,
      type TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS outreach_event_enrollment ON outreach_events(enrollment_id,created_at);
    CREATE TABLE IF NOT EXISTS outreach_suppressions (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      email TEXT NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(workspace_id,email)
    );
  `);
  const route =
    (handler: (req: Request, res: Response) => unknown) =>
    async (req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store");
      try {
        await handler(req, res);
      } catch (error) {
        if (error instanceof z.ZodError) {
          res
            .status(400)
            .json({ error: error.issues[0]?.message || "Invalid request." });
          return;
        }
        if (error instanceof OutreachError) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        res
          .status(500)
          .json({ error: "The outreach operation could not be completed." });
      }
    };
  const actor = (req: Request, admin = false): User => {
    const user = sessionUser(store, req);
    if (!user) return fail(401, "Please sign in to continue.");
    if (admin && !["owner", "admin"].includes(user.role))
      return fail(403, "Only workspace owners and admins can manage delivery.");
    return user;
  };
  const sequence = (user: User, req: Request) =>
    store.get(user.workspaceId, "sequences", String(req.params.id)) ||
    fail(404, "Sequence not found.");
  const event = (
    enrollmentId: string,
    type: string,
    detail: string,
    messageId: string | null = null,
  ) => {
    db.prepare(
      "INSERT INTO outreach_events(id,enrollment_id,message_id,type,detail,created_at) VALUES(?,?,?,?,?,?)",
    ).run(
      randomUUID(),
      enrollmentId,
      messageId,
      type,
      detail.slice(0, 1000),
      clock(),
    );
  };
  const suppressed = (workspaceId: string, email: string) =>
    !!db
      .prepare(
        "SELECT email FROM outreach_suppressions WHERE workspace_id=? AND email=?",
      )
      .get(workspaceId, email);
  const halt = (enrollmentId: string, status: string, detail: string) => {
    db.prepare(
      "UPDATE outreach_enrollments SET status=?, updated_at=? WHERE id=?",
    ).run(status, clock(), enrollmentId);
    db.prepare(
      "UPDATE outreach_messages SET status='cancelled',error=?,updated_at=? WHERE enrollment_id=? AND status IN ('pending','waiting','retry')",
    ).run(detail, clock(), enrollmentId);
    event(enrollmentId, status, detail);
  };
  const suppress = (workspaceId: string, email: string, reason: string) =>
    store.transaction(() => {
      db.prepare(
        "INSERT INTO outreach_suppressions(workspace_id,email,reason,created_at) VALUES(?,?,?,?) ON CONFLICT(workspace_id,email) DO UPDATE SET reason=excluded.reason",
      ).run(workspaceId, email, reason, clock());
      const rows = db
        .prepare(
          "SELECT id FROM outreach_enrollments WHERE workspace_id=? AND email=? AND status IN ('active','paused','completed')",
        )
        .all(workspaceId, email) as Row[];
      for (const row of rows) halt(String(row.id), "unsubscribed", reason);
    });
  const personalize = (text: string, candidate: Resource, user: User) => {
    const name = inputText(candidate.name).trim();
    const values: Record<string, string> = {
      firstName: name.split(/\s+/)[0] || "there",
      name,
      company: inputText(candidate.company),
      role: inputText(candidate.role) || inputText(candidate.title),
      senderName: user.name,
      workspaceName: user.workspaceName,
    };
    return text.replace(/\{\{\s*([\w]+)\s*\}\}/g, (_match, key: string) => {
      if (!(key in values))
        return fail(
          400,
          `Unknown personalization field: ${key}. Use firstName, name, company, role, senderName, or workspaceName.`,
        );
      return values[key].replace(/[\r\n]/g, " ").slice(0, 300);
    });
  };
  const preview = (user: User, item: Resource) => {
    const steps = stepSchema.parse(item.steps);
    const ids = z
      .array(z.string().uuid())
      .min(1, "Enroll at least one candidate first.")
      .max(MAX_RECIPIENTS)
      .parse(item.enrolledCandidateIds);
    const seen = new Set<string>();
    const recipients = [...new Set(ids)].map((id) => {
      const candidate = store.get(user.workspaceId, "candidates", id);
      if (!candidate)
        return {
          candidateId: id,
          name: "Unavailable candidate",
          email: "",
          eligible: false,
          reason: "Candidate was removed from this workspace.",
          messages: [],
        };
      const parsed = emailSchema.safeParse(candidate.email);
      const email = parsed.success ? parsed.data : "";
      let reason = !email ? "Add a valid candidate email." : "";
      if (email && seen.has(email))
        reason = "Duplicate email in this enrollment.";
      if (email) seen.add(email);
      if (email && suppressed(user.workspaceId, email))
        reason = "Unsubscribed or suppressed.";
      if (
        email &&
        db
          .prepare(
            "SELECT id FROM outreach_enrollments WHERE sequence_id=? AND email=?",
          )
          .get(item.id, email)
      )
        reason =
          "Already launched for this email. Duplicate sends are blocked.";
      return {
        candidateId: id,
        name: inputText(candidate.name),
        email,
        eligible: !reason,
        reason,
        messages: steps.map((step, index) => ({
          step: index + 1,
          subject: personalize(step.subject, candidate, user),
          text: personalize(step.body, candidate, user),
          delayDays: step.delayDays,
        })),
      };
    });
    const config = {
      mode: transport.config.mode,
      configured: transport.configured,
      allowed: transport.allowed(user.workspaceId),
      from:
        transport.config.mode === "outbox"
          ? "Local outbox — no delivery"
          : transport.config.from,
      replyTo: transport.config.replyTo,
      publicUrl: transport.publicUrl,
    };
    const revision = digest({
      sequenceId: item.id,
      updatedAt: item.updatedAt,
      recipients,
      config,
    });
    return { revision, sequenceName: inputText(item.name), recipients, config };
  };
  app.get(
    "/api/sequences/:id/delivery/preview",
    route((req, res) => {
      const user = actor(req);
      res.json(preview(user, sequence(user, req)));
    }),
  );
  app.get(
    "/api/sequences/:id/delivery",
    route((req, res) => {
      const user = actor(req),
        item = sequence(user, req);
      const enrollments = db
        .prepare(
          "SELECT id,candidate_id AS candidateId,email,name,status,mode,created_at AS createdAt,updated_at AS updatedAt FROM outreach_enrollments WHERE workspace_id=? AND sequence_id=? ORDER BY created_at DESC LIMIT 1000",
        )
        .all(user.workspaceId, item.id);
      const messages = db
        .prepare(
          "SELECT m.id,m.enrollment_id AS enrollmentId,m.step_index AS stepIndex,m.subject,m.status,m.due_at AS dueAt,m.attempts,m.provider_event AS providerEvent,m.error,m.updated_at AS updatedAt FROM outreach_messages m JOIN outreach_enrollments e ON e.id=m.enrollment_id WHERE e.workspace_id=? AND e.sequence_id=? ORDER BY e.created_at DESC,m.step_index LIMIT 1000",
        )
        .all(user.workspaceId, item.id);
      const events = db
        .prepare(
          "SELECT v.id,v.enrollment_id AS enrollmentId,v.type,v.detail,v.created_at AS createdAt FROM outreach_events v JOIN outreach_enrollments e ON e.id=v.enrollment_id WHERE e.workspace_id=? AND e.sequence_id=? ORDER BY v.created_at DESC LIMIT 200",
        )
        .all(user.workspaceId, item.id);
      res.json({
        enrollments,
        messages,
        events,
        config: {
          mode: transport.config.mode,
          configured: transport.configured,
          allowed: transport.allowed(user.workspaceId),
          from: transport.config.from,
          replyTo: transport.config.replyTo,
        },
      });
    }),
  );
  app.get(
    "/api/sequences/:id/delivery/messages/:messageId",
    route((req, res) => {
      const user = actor(req),
        item = sequence(user, req);
      const message = db
        .prepare(
          "SELECT m.subject,m.body AS text,m.status,e.email,e.name,e.mode FROM outreach_messages m JOIN outreach_enrollments e ON e.id=m.enrollment_id WHERE m.id=? AND e.sequence_id=? AND e.workspace_id=?",
        )
        .get(String(req.params.messageId), item.id, user.workspaceId);
      if (!message) return fail(404, "Message not found.");
      res.json({ item: message });
    }),
  );
  app.post(
    "/api/sequences/:id/delivery/launch",
    route((req, res) => {
      const user = actor(req, true),
        item = sequence(user, req);
      const input = z
        .object({
          revision: z.string().regex(/^[a-f0-9]{64}$/),
          acknowledged: z.literal(true),
          mode: z.enum(["outbox", "resend"]),
        })
        .strict()
        .parse(req.body);
      if (!transport.allowed(user.workspaceId))
        return fail(
          409,
          "Live delivery requires a verified sender, HTTPS public URL, and this workspace in the server MAIL_WORKSPACE_IDS allowlist.",
        );
      const plan = preview(user, item);
      if (input.revision !== plan.revision || input.mode !== plan.config.mode)
        return fail(
          409,
          "The draft, recipients, or delivery configuration changed. Refresh the preview before launching.",
        );
      const recipients = plan.recipients.filter(
        (recipient) => recipient.eligible,
      );
      if (!recipients.length)
        return fail(
          409,
          "No new eligible recipients. Review the preview exclusions.",
        );
      const active = Number(
        db
          .prepare(
            "SELECT count(*) AS count FROM outreach_enrollments WHERE workspace_id=? AND status IN ('active','paused')",
          )
          .get(user.workspaceId)!.count,
      );
      if (active + recipients.length > 1000)
        return fail(
          409,
          "This workspace has reached the limit of 1,000 active or paused enrollments.",
        );
      const launched = store.transaction(() =>
        recipients.map((recipient) => {
          const id = randomUUID(),
            token = randomBytes(32).toString("hex"),
            created = clock();
          const unsubscribeUrl = `${transport.publicUrl || "http://localhost:5174"}/api/outreach/unsubscribe/${token}`;
          db.prepare(
            "INSERT INTO outreach_enrollments(id,workspace_id,sequence_id,candidate_id,email,name,status,mode,sender,reply_to,public_url,unsubscribe_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,'active',?,?,?,?,?,?,?)",
          ).run(
            id,
            user.workspaceId,
            item.id,
            recipient.candidateId,
            recipient.email,
            recipient.name,
            transport.config.mode,
            transport.config.from,
            transport.config.replyTo,
            transport.publicUrl,
            hashToken(token),
            created,
            created,
          );
          recipient.messages.forEach((message, index) => {
            db.prepare(
              "INSERT INTO outreach_messages(id,enrollment_id,step_index,delay_days,subject,body,unsubscribe_url,status,due_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
            ).run(
              randomUUID(),
              id,
              index,
              message.delayDays,
              message.subject,
              `${message.text}\n\nUnsubscribe from ${user.workspaceName} recruiting outreach: ${unsubscribeUrl}`,
              unsubscribeUrl,
              index === 0 ? "pending" : "waiting",
              index === 0 ? created + message.delayDays * DAY : null,
              created,
            );
          });
          event(
            id,
            "launched",
            `${recipient.messages.length} steps scheduled in ${transport.config.mode === "outbox" ? "local outbox mode (no email delivery)" : "live Resend mode"}.`,
          );
          return id;
        }),
      );
      res.status(201).json({
        ok: true,
        enrollmentIds: launched,
        mode: transport.config.mode,
      });
    }),
  );
  app.post(
    "/api/sequences/:id/delivery/control",
    route((req, res) => {
      const user = actor(req, true),
        item = sequence(user, req);
      const input = z
        .object({
          action: z.enum(["pause", "resume", "stop", "replied"]),
          enrollmentId: z.string().uuid().optional(),
        })
        .strict()
        .parse(req.body);
      const rows = db
        .prepare(
          "SELECT * FROM outreach_enrollments WHERE workspace_id=? AND sequence_id=? AND (? IS NULL OR id=?)",
        )
        .all(
          user.workspaceId,
          item.id,
          input.enrollmentId || null,
          input.enrollmentId || null,
        ) as Row[];
      if (input.enrollmentId && !rows.length)
        return fail(404, "Enrollment not found.");
      let changed = 0;
      store.transaction(() => {
        for (const row of rows) {
          const id = String(row.id);
          if (input.action === "pause" && row.status === "active") {
            db.prepare(
              "UPDATE outreach_enrollments SET status='paused',paused_at=?,updated_at=? WHERE id=?",
            ).run(clock(), clock(), id);
            event(
              id,
              "paused",
              "Pending messages paused. A provider request already in flight cannot be recalled.",
            );
            changed++;
          } else if (input.action === "resume" && row.status === "paused") {
            if (
              !transport.allowed(user.workspaceId) ||
              row.mode !== transport.config.mode ||
              row.sender !== transport.config.from ||
              row.reply_to !== transport.config.replyTo ||
              row.public_url !== transport.publicUrl
            )
              return fail(
                409,
                "Delivery configuration changed. These enrollments cannot be resumed under a different sender or mode.",
              );
            const delay = Math.max(
              0,
              clock() - Number(row.paused_at || clock()),
            );
            db.prepare(
              "UPDATE outreach_messages SET due_at=due_at+?,updated_at=? WHERE enrollment_id=? AND status IN ('pending','retry')",
            ).run(delay, clock(), id);
            db.prepare(
              "UPDATE outreach_enrollments SET status='active',paused_at=NULL,updated_at=? WHERE id=?",
            ).run(clock(), id);
            event(
              id,
              "resumed",
              "Pending schedule resumed with the paused time added to its due dates.",
            );
            changed++;
          } else if (
            ["stop", "replied"].includes(input.action) &&
            ["active", "paused", "completed"].includes(String(row.status))
          ) {
            halt(
              id,
              input.action === "replied" ? "replied" : "stopped",
              input.action === "replied"
                ? "Reply recorded manually by the team. Further steps cancelled."
                : "Stopped by the team. Further steps cancelled.",
            );
            changed++;
          }
        }
      });
      res.json({ ok: true, changed });
    }),
  );
  const publicEnrollment = (req: Request) => {
    const token = String(req.params.token);
    if (!/^[a-f0-9]{64}$/.test(token))
      return fail(404, "Unsubscribe link unavailable.");
    return (
      (db
        .prepare(
          "SELECT id,workspace_id,email FROM outreach_enrollments WHERE unsubscribe_hash=?",
        )
        .get(hashToken(token)) as Row | undefined) ||
      fail(404, "Unsubscribe link unavailable.")
    );
  };
  const unsubscribePage = (title: string, content: string) =>
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title} · ArkOffer</title><body style="font:16px system-ui;max-width:560px;margin:12vh auto;padding:24px;line-height:1.6"><h1>${title}</h1>${content}</body></html>`;
  app.get(
    "/api/outreach/unsubscribe/:token",
    route((req, res) => {
      publicEnrollment(req);
      res.setHeader("Referrer-Policy", "no-referrer");
      res
        .type("html")
        .send(
          unsubscribePage(
            "Unsubscribe from recruiting outreach",
            `<p>Confirm to stop this hiring workspace from sending you further sequence messages. Opening this page does not change your preferences.</p><form method="post" action="${escapeHtml(req.path)}"><button type="submit" style="padding:12px 20px">Unsubscribe</button></form>`,
          ),
        );
    }),
  );
  app.post(
    "/api/outreach/unsubscribe/:token",
    route((req, res) => {
      const row = publicEnrollment(req);
      suppress(
        String(row.workspace_id),
        String(row.email),
        "Recipient unsubscribed.",
      );
      res.setHeader("Referrer-Policy", "no-referrer");
      res
        .type("html")
        .send(
          unsubscribePage(
            "You’re unsubscribed",
            "<p>You will receive no further sequence messages from this workspace. A message already accepted by the email provider may still arrive.</p>",
          ),
        );
    }),
  );
  const reconcile = async (workspaceId?: string, sequenceId?: string) => {
    const messages = db
      .prepare(
        "SELECT m.id,m.provider_id,m.enrollment_id,e.workspace_id,e.email FROM outreach_messages m JOIN outreach_enrollments e ON e.id=m.enrollment_id WHERE e.mode='resend' AND m.provider_id IS NOT NULL AND m.status IN ('accepted','delivered') AND (m.checked_at IS NULL OR m.checked_at<?) AND (? IS NULL OR e.workspace_id=?) AND (? IS NULL OR e.sequence_id=?) ORDER BY COALESCE(m.checked_at,0) LIMIT 10",
      )
      .all(
        clock() - 60_000,
        workspaceId || null,
        workspaceId || null,
        sequenceId || null,
        sequenceId || null,
      ) as Row[];
    let updated = 0;
    for (const row of messages) {
      if (!transport.allowed(String(row.workspace_id))) continue;
      try {
        const result = await transport.retrieve(String(row.provider_id));
        const status = [
          "bounced",
          "complained",
          "failed",
          "suppressed",
        ].includes(result)
          ? "failed"
          : ["delivered", "opened", "clicked"].includes(result)
            ? "delivered"
            : "accepted";
        const previous = db
          .prepare("SELECT provider_event FROM outreach_messages WHERE id=?")
          .get(row.id);
        db.prepare(
          "UPDATE outreach_messages SET provider_event=?,status=?,checked_at=?,updated_at=? WHERE id=?",
        ).run(result, status, clock(), clock(), row.id);
        if (previous && previous.provider_event !== result)
          event(
            String(row.enrollment_id),
            "provider_status",
            `Resend reported ${result}.`,
            String(row.id),
          );
        if (["bounced", "complained", "suppressed"].includes(result))
          suppress(
            String(row.workspace_id),
            String(row.email),
            `Provider reported ${result}.`,
          );
        else if (result === "failed")
          halt(
            String(row.enrollment_id),
            "failed",
            "The provider reported a failed message. Further steps cancelled.",
          );
        updated++;
      } catch {
        db.prepare("UPDATE outreach_messages SET checked_at=? WHERE id=?").run(
          clock(),
          row.id,
        );
      }
    }
    return updated;
  };
  app.post(
    "/api/sequences/:id/delivery/reconcile",
    route(async (req, res) => {
      const user = actor(req, true),
        item = sequence(user, req);
      res.json({
        ok: true,
        updated: await reconcile(user.workspaceId, item.id),
      });
    }),
  );
  let ticking: Promise<void> | undefined;
  const tick = async (limit = 10) => {
    if (ticking) return ticking;
    ticking = (async () => {
      const stale = db
        .prepare(
          "SELECT id,enrollment_id FROM outreach_messages WHERE status='sending' AND claimed_at<?",
        )
        .all(clock() - 60_000) as Row[];
      for (const row of stale) {
        db.prepare(
          "UPDATE outreach_messages SET status='unknown',error=?,updated_at=? WHERE id=? AND status='sending'",
        ).run(
          "Worker stopped before confirmation. Verify delivery in the provider dashboard; automatic retries are disabled.",
          clock(),
          row.id,
        );
        halt(
          String(row.enrollment_id),
          "attention",
          "Delivery outcome is unknown. Further steps cancelled to prevent duplicate contact.",
        );
      }
      for (let index = 0; index < Math.min(Math.max(limit, 1), 20); index++) {
        const row: Row | undefined = store.transaction<Row | undefined>(() => {
          const candidate = db
            .prepare(
              "SELECT m.*,e.workspace_id,e.email,e.mode,e.sender,e.reply_to,e.public_url,e.status AS enrollment_status,e.candidate_id FROM outreach_messages m JOIN outreach_enrollments e ON e.id=m.enrollment_id WHERE m.status IN ('pending','retry') AND m.due_at<=? AND e.status='active' ORDER BY m.due_at,m.id LIMIT 1",
            )
            .get(clock()) as Row | undefined;
          if (!candidate) return;
          const claimed = db
            .prepare(
              "UPDATE outreach_messages SET status='sending',attempts=attempts+1,first_attempt_at=COALESCE(first_attempt_at,?),claimed_at=?,updated_at=? WHERE id=? AND status IN ('pending','retry')",
            )
            .run(clock(), clock(), clock(), candidate.id);
          return claimed.changes
            ? { ...candidate, attempts: Number(candidate.attempts) + 1 }
            : undefined;
        });
        if (!row) break;
        const id = String(row.id),
          enrollmentId = String(row.enrollment_id),
          workspaceId = String(row.workspace_id);
        if (suppressed(workspaceId, String(row.email))) {
          db.prepare(
            "UPDATE outreach_messages SET status='cancelled',updated_at=? WHERE id=?",
          ).run(clock(), id);
          halt(enrollmentId, "unsubscribed", "Recipient is suppressed.");
          continue;
        }
        if (!store.get(workspaceId, "candidates", String(row.candidate_id))) {
          db.prepare(
            "UPDATE outreach_messages SET status='cancelled',updated_at=? WHERE id=?",
          ).run(clock(), id);
          halt(enrollmentId, "stopped", "Candidate no longer exists.");
          continue;
        }
        try {
          if (
            !transport.allowed(workspaceId) ||
            row.mode !== transport.config.mode ||
            row.sender !== transport.config.from ||
            row.reply_to !== transport.config.replyTo ||
            row.public_url !== transport.publicUrl
          )
            throw new MailError(
              "permanent",
              "Server delivery configuration changed or this workspace is not approved for live email. No message was sent.",
            );
          if (
            row.first_attempt_at &&
            clock() - Number(row.first_attempt_at) > 23 * 3_600_000
          )
            throw new MailError(
              "permanent",
              "The safe provider idempotency window expired. No automatic retry was sent.",
            );
          const result = await transport.send({
            to: String(row.email),
            subject: String(row.subject),
            text: String(row.body),
            unsubscribeUrl: String(row.unsubscribe_url),
            idempotencyKey: `arkoffer/${id}`,
          });
          store.transaction(() => {
            const stillExists = db
              .prepare("SELECT id FROM outreach_messages WHERE id=?")
              .get(id);
            if (!stillExists) return;
            db.prepare(
              "UPDATE outreach_messages SET status=?,provider_id=?,provider_event=?,error=NULL,updated_at=? WHERE id=?",
            ).run(
              result.state,
              result.id,
              result.state === "outbox" ? "not_delivered" : "sent",
              clock(),
              id,
            );
            event(
              enrollmentId,
              result.state,
              result.state === "outbox"
                ? "Saved to local outbox. No email was delivered."
                : "Accepted by Resend. Delivery is not yet confirmed.",
              id,
            );
            const enrollment = db
              .prepare("SELECT status FROM outreach_enrollments WHERE id=?")
              .get(enrollmentId);
            if (
              !enrollment ||
              !["active", "paused"].includes(String(enrollment.status))
            )
              return;
            const next = db
              .prepare(
                "SELECT id,delay_days FROM outreach_messages WHERE enrollment_id=? AND step_index=? AND status='waiting'",
              )
              .get(enrollmentId, Number(row.step_index) + 1);
            if (next)
              db.prepare(
                "UPDATE outreach_messages SET status='pending',due_at=?,updated_at=? WHERE id=?",
              ).run(clock() + Number(next.delay_days) * DAY, clock(), next.id);
            else
              db.prepare(
                "UPDATE outreach_enrollments SET status='completed',updated_at=? WHERE id=?",
              ).run(clock(), enrollmentId);
          });
        } catch (error) {
          const problem =
            error instanceof MailError
              ? error
              : new MailError(
                  "unknown",
                  "Delivery outcome is unknown. Automatic retries are disabled.",
                );
          if (
            !db.prepare("SELECT id FROM outreach_messages WHERE id=?").get(id)
          )
            continue;
          const retry =
            problem.kind === "retryable" && Number(row.attempts) < 4;
          const status = retry
            ? "retry"
            : problem.kind === "unknown"
              ? "unknown"
              : "failed";
          const delay = Math.max(
            problem.retryAfterMs,
            Math.min(60_000 * 2 ** (Number(row.attempts) - 1), 3_600_000),
          );
          db.prepare(
            "UPDATE outreach_messages SET status=?,error=?,due_at=?,updated_at=? WHERE id=?",
          ).run(
            status,
            problem.message,
            retry ? clock() + delay : null,
            clock(),
            id,
          );
          event(enrollmentId, status, problem.message, id);
          if (!retry)
            halt(
              enrollmentId,
              status === "unknown" ? "attention" : "failed",
              status === "unknown"
                ? "Delivery unknown. Further steps cancelled; check the provider dashboard."
                : "Delivery failed. Further steps cancelled.",
            );
        }
      }
    })().finally(() => {
      ticking = undefined;
    });
    return ticking;
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  let maintenance: Promise<unknown> | undefined;
  return {
    tick,
    reconcile,
    start() {
      if (timer) return;
      const work = () => {
        if (maintenance) return;
        maintenance = (async () => {
          await reconcile();
          await tick(1);
        })()
          .catch(() => {
            /* Keep the worker alive; records retain their last confirmed state. */
          })
          .finally(() => {
            maintenance = undefined;
          });
      };
      timer = setInterval(work, 15_000);
      timer.unref();
      work();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await maintenance;
      await ticking;
    },
  };
}
