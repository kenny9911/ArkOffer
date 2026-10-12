import type { Express, Request, Response } from "express";
import { urlencoded } from "express";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { sessionUser, hashToken, type User } from "./auth.js";
import type { Resource, Store } from "./db.js";
import { renderEmailMarkup, escapeEmailHtml } from "../shared/email-markup.js";
import { createMailTransport, MailError, type MailConfig } from "./mail.js";
import {
  sequenceStepSchema,
  sequenceSettingsSchema,
} from "./sequence-drafts.js";

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
    sequenceStepSchema.refine(
      (step) => !!step.subject.trim() && !!step.body.trim(),
      "Complete each step's subject and body before launching.",
    ),
  )
  .min(1)
  .max(10)
  .refine(
    (steps) => steps.every((step, index) => index === 0 || step.delayDays >= 1),
    "Follow-ups must wait at least one day after the previous step.",
  );
/** Absent settings preserve the schedule of existing sequences. New drafts explicitly save a window. */
function scheduledTime(time: number, raw: string | null | undefined): number {
  if (!raw) return time;
  const settings = sequenceSettingsSchema.parse(JSON.parse(raw));
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: settings.timezone,
    weekday: "short",
    hour: "numeric",
    hourCycle: "h23",
  });
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  for (
    let candidate = time, i = 0;
    i < 8 * 24 * 60;
    i++, candidate = Math.ceil((candidate + 1) / 60000) * 60000
  ) {
    const parts = formatter.formatToParts(candidate),
      day = days.indexOf(parts.find((part) => part.type === "weekday")!.value),
      hour = Number(parts.find((part) => part.type === "hour")!.value);
    if (
      settings.weekdays.includes(day) &&
      hour >= settings.startHour &&
      hour < settings.endHour
    )
      return candidate;
  }
  throw new Error("No sending window is available.");
}
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
    CREATE TABLE IF NOT EXISTS outreach_recipients (message_id TEXT NOT NULL REFERENCES outreach_messages(id) ON DELETE CASCADE,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,email TEXT NOT NULL,kind TEXT NOT NULL,PRIMARY KEY(message_id,email));
    CREATE INDEX IF NOT EXISTS outreach_copy_suppression ON outreach_recipients(workspace_id,email);
    CREATE TABLE IF NOT EXISTS outreach_recipient_budget (message_id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,slots INTEGER NOT NULL,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS outreach_slot_budget ON outreach_recipient_budget(workspace_id,created_at);
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
  for (const [table, column, definition] of [
    ["outreach_messages", "kind", "TEXT NOT NULL DEFAULT 'email'"],
    ["outreach_enrollments", "schedule", "TEXT"],
    ["outreach_messages", "html", "TEXT"],
    ["outreach_messages", "cc", "TEXT NOT NULL DEFAULT '[]'"],
    ["outreach_messages", "bcc", "TEXT NOT NULL DEFAULT '[]'"],
  ]) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((row) => row.name === column))
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
  db.exec(`INSERT OR IGNORE INTO outreach_recipients(message_id,workspace_id,email,kind) SELECT m.id,e.workspace_id,e.email,'to' FROM outreach_messages m JOIN outreach_enrollments e ON e.id=m.enrollment_id WHERE m.kind='email';
    INSERT OR IGNORE INTO outreach_recipient_budget(message_id,workspace_id,slots,created_at) SELECT m.id,e.workspace_id,1,e.created_at FROM outreach_messages m JOIN outreach_enrollments e ON e.id=m.enrollment_id WHERE m.kind='email';`);
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
      "UPDATE outreach_messages SET status='cancelled',error=?,updated_at=? WHERE enrollment_id=? AND status IN ('pending','waiting','retry','task_due')",
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
          "SELECT e.id FROM outreach_enrollments e WHERE e.workspace_id=? AND (e.email=? OR e.id IN(SELECT m.enrollment_id FROM outreach_messages m JOIN outreach_recipients r ON r.message_id=m.id WHERE r.workspace_id=? AND r.email=?)) AND e.status IN ('active','paused','completed')",
        )
        .all(workspaceId, email, workspaceId, email) as Row[];
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
    const manualOnly = steps.every((step) => step.kind !== "email");
    const schedule = item.settings
      ? sequenceSettingsSchema.parse(item.settings)
      : null;
    const ids = z
      .array(z.string().uuid())
      .min(1, "Enroll at least one candidate first.")
      .max(MAX_RECIPIENTS)
      .parse(item.enrolledCandidateIds);
    const copyRecipients = [
      ...new Set(steps.flatMap((step) => [...step.cc, ...step.bcc])),
    ];
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
      let reason =
        !email && !manualOnly
          ? "Add a valid candidate email for automatic email steps."
          : "";
      // The non-email key preserves the existing enrollment uniqueness constraint without inventing a contact address.
      const contactKey = email || `manual:${id}`;
      if (manualOnly && suppressed(user.workspaceId, contactKey))
        reason = "Unsubscribed or suppressed.";
      if (email && seen.has(email))
        reason = "Duplicate email in this enrollment.";
      if (email) seen.add(email);
      if (email && suppressed(user.workspaceId, email))
        reason = "Unsubscribed or suppressed.";
      if (copyRecipients.includes(email))
        reason =
          "A candidate recipient is also listed in Cc/Bcc. Remove the duplicate before launch.";
      if (
        copyRecipients.some((address) => suppressed(user.workspaceId, address))
      )
        reason = "A Cc/Bcc recipient is suppressed. Remove them before launch.";
      if (
        db
          .prepare(
            "SELECT id FROM outreach_enrollments WHERE sequence_id=? AND (email=? OR candidate_id=?)",
          )
          .get(item.id, contactKey, id)
      )
        reason =
          "Already launched for this email. Duplicate sends are blocked.";
      return {
        candidateId: id,
        name: inputText(candidate.name),
        email,
        contactKey,
        eligible: !reason,
        reason,
        messages: steps.map((step, index) => {
          const body =
            step.format === "formatted"
              ? renderEmailMarkup(step.body, (value) =>
                  personalize(value, candidate, user),
                )
              : { text: personalize(step.body, candidate, user), html: null };
          return {
            step: index + 1,
            kind: step.kind,
            subject: personalize(step.subject, candidate, user),
            text: body.text,
            html: body.html,
            cc: step.cc,
            bcc: step.bcc,
            delayDays: step.delayDays,
          };
        }),
      };
    });
    const recipientSlots = recipients
      .filter((recipient) => recipient.eligible)
      .reduce(
        (count, recipient) =>
          count +
          recipient.messages.reduce(
            (sum, message) =>
              sum +
              (message.kind === "email"
                ? 1 + message.cc.length + message.bcc.length
                : 0),
            0,
          ),
        0,
      );
    const uniqueRecipients = new Set([
      ...recipients
        .filter((recipient) => recipient.eligible)
        .map((recipient) => recipient.email)
        .filter(Boolean),
      ...copyRecipients,
    ]).size;
    const config = {
      mode: manualOnly ? ("outbox" as const) : transport.config.mode,
      configured: manualOnly || transport.configured,
      allowed: manualOnly || transport.allowed(user.workspaceId),
      from:
        manualOnly || transport.config.mode === "outbox"
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
      schedule,
      recipientSlots,
      uniqueRecipients,
    });
    return {
      revision,
      sequenceName: inputText(item.name),
      recipients,
      config,
      schedule,
      recipientSlots,
      uniqueRecipients,
    };
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
      const parsedSteps = stepSchema.safeParse(item.steps);
      const manualOnly =
        parsedSteps.success &&
        parsedSteps.data.every((step) => step.kind !== "email");
      const enrollments = db
        .prepare(
          "SELECT id,candidate_id AS candidateId,CASE WHEN email LIKE 'manual:%' THEN '' ELSE email END AS email,name,status,mode,created_at AS createdAt,updated_at AS updatedAt FROM outreach_enrollments WHERE workspace_id=? AND sequence_id=? ORDER BY created_at DESC LIMIT 1000",
        )
        .all(user.workspaceId, item.id);
      const messages = db
        .prepare(
          "SELECT m.id,m.enrollment_id AS enrollmentId,m.step_index AS stepIndex,m.kind,m.subject,m.status,m.due_at AS dueAt,m.attempts,m.provider_event AS providerEvent,m.error,m.updated_at AS updatedAt FROM outreach_messages m JOIN outreach_enrollments e ON e.id=m.enrollment_id WHERE e.workspace_id=? AND e.sequence_id=? ORDER BY e.created_at DESC,m.step_index LIMIT 1000",
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
          mode: manualOnly ? "outbox" : transport.config.mode,
          configured: manualOnly || transport.configured,
          allowed: manualOnly || transport.allowed(user.workspaceId),
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
          "SELECT m.kind,m.subject,m.body AS text,m.html,m.cc,m.bcc,m.status,CASE WHEN e.email LIKE 'manual:%' THEN '' ELSE e.email END AS email,e.name,e.mode FROM outreach_messages m JOIN outreach_enrollments e ON e.id=m.enrollment_id WHERE m.id=? AND e.sequence_id=? AND e.workspace_id=?",
        )
        .get(String(req.params.messageId), item.id, user.workspaceId);
      if (!message) return fail(404, "Message not found.");
      const row = message as Row;
      res.json({
        item: {
          ...row,
          cc: JSON.parse(String(row.cc || "[]")),
          bcc: JSON.parse(String(row.bcc || "[]")),
        },
      });
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
      const plan = preview(user, item);
      if (!plan.config.allowed)
        return fail(
          409,
          "Live delivery requires a verified sender, HTTPS public URL, and this workspace in the server MAIL_WORKSPACE_IDS allowlist.",
        );
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
      if (plan.uniqueRecipients > 100)
        fail(
          409,
          "A launch may include at most 100 distinct recipients, including Cc/Bcc.",
        );
      const usedSlots = Number(
        db
          .prepare(
            "SELECT COALESCE(SUM(slots),0) AS n FROM outreach_recipient_budget WHERE workspace_id=? AND created_at>?",
          )
          .get(user.workspaceId, clock() - DAY)!.n,
      );
      if (usedSlots + plan.recipientSlots > 1000)
        fail(
          429,
          "This workspace has a daily budget of 1,000 scheduled recipient deliveries, including every Cc/Bcc copy and follow-up. Deleted schedules do not reset it.",
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
            recipient.contactKey!,
            recipient.name,
            plan.config.mode,
            transport.config.from,
            transport.config.replyTo,
            transport.publicUrl,
            hashToken(token),
            created,
            created,
          );
          const schedule = plan.schedule ? JSON.stringify(plan.schedule) : null;
          db.prepare(
            "UPDATE outreach_enrollments SET schedule=? WHERE id=?",
          ).run(schedule, id);
          recipient.messages.forEach((message, index) => {
            const messageId = randomUUID();
            db.prepare(
              "INSERT INTO outreach_messages(id,enrollment_id,step_index,delay_days,subject,body,unsubscribe_url,status,due_at,updated_at,kind) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            ).run(
              messageId,
              id,
              index,
              message.delayDays,
              message.subject,
              message.kind === "email"
                ? `${message.text}\n\nUnsubscribe from ${user.workspaceName} recruiting outreach: ${unsubscribeUrl}`
                : message.text,
              unsubscribeUrl,
              index === 0 ? "pending" : "waiting",
              index === 0
                ? scheduledTime(created + message.delayDays * DAY, schedule)
                : null,
              created,
              message.kind,
            );
            const html = message.html
              ? `${message.html}${message.kind === "email" ? `<p>Unsubscribe from ${escapeEmailHtml(user.workspaceName)} recruiting outreach: <a href="${escapeEmailHtml(unsubscribeUrl)}">unsubscribe</a></p>` : ""}`
              : null;
            db.prepare(
              "UPDATE outreach_messages SET html=?,cc=?,bcc=? WHERE id=?",
            ).run(
              html,
              JSON.stringify(message.cc),
              JSON.stringify(message.bcc),
              messageId,
            );
            if (message.kind === "email") {
              const add = db.prepare(
                "INSERT INTO outreach_recipients VALUES(?,?,?,?)",
              );
              add.run(messageId, user.workspaceId, recipient.email, "to");
              for (const address of message.cc)
                add.run(messageId, user.workspaceId, address, "cc");
              for (const address of message.bcc)
                add.run(messageId, user.workspaceId, address, "bcc");
              db.prepare(
                "INSERT INTO outreach_recipient_budget VALUES(?,?,?,?)",
              ).run(
                messageId,
                user.workspaceId,
                1 + message.cc.length + message.bcc.length,
                created,
              );
            }
          });
          event(
            id,
            "launched",
            `${recipient.messages.length} steps scheduled in ${plan.config.mode === "outbox" ? "local outbox/manual mode (no email delivery)" : "live Resend mode"}.`,
          );
          return id;
        }),
      );
      res.status(201).json({
        ok: true,
        enrollmentIds: launched,
        mode: plan.config.mode,
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
            const hasAutomaticEmail = !!db
              .prepare(
                "SELECT id FROM outreach_messages WHERE enrollment_id=? AND kind='email' LIMIT 1",
              )
              .get(id);
            if (
              hasAutomaticEmail &&
              (!transport.allowed(user.workspaceId) ||
                row.mode !== transport.config.mode ||
                row.sender !== transport.config.from ||
                row.reply_to !== transport.config.replyTo ||
                row.public_url !== transport.publicUrl)
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
              "SELECT id,due_at FROM outreach_messages WHERE enrollment_id=? AND status IN ('pending','retry')",
            )
              .all(id)
              .forEach((message) =>
                db
                  .prepare(
                    "UPDATE outreach_messages SET due_at=?,updated_at=? WHERE id=?",
                  )
                  .run(
                    scheduledTime(
                      Number(message.due_at) + delay,
                      row.schedule as string | null,
                    ),
                    clock(),
                    message.id,
                  ),
              );
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
  app.post(
    "/api/sequences/:id/delivery/messages/:messageId/complete",
    route((req, res) => {
      const user = actor(req, true),
        item = sequence(user, req);
      z.object({ confirmed: z.literal(true) })
        .strict()
        .parse(req.body);
      store.transaction(() => {
        const message = db
          .prepare(
            "SELECT m.*,e.status AS enrollment_status,e.schedule FROM outreach_messages m JOIN outreach_enrollments e ON e.id=m.enrollment_id WHERE m.id=? AND e.sequence_id=? AND e.workspace_id=?",
          )
          .get(String(req.params.messageId), item.id, user.workspaceId) as
          Row | undefined;
        if (!message) fail(404, "Task not found.");
        if (message!.kind === "email")
          fail(400, "Automatic email cannot be marked as a manual task.");
        if (message!.status === "task_completed") return;
        if (
          message!.status !== "task_due" ||
          message!.enrollment_status !== "active"
        )
          fail(
            409,
            "Only a due task in an active enrollment can be completed.",
          );
        db.prepare(
          "UPDATE outreach_messages SET status='task_completed',updated_at=? WHERE id=?",
        ).run(clock(), message!.id);
        event(
          String(message!.enrollment_id),
          "task_completed",
          "A team member confirmed completion outside ArkOffer. No message was sent by this action.",
          String(message!.id),
        );
        advance(message!);
      });
      res.json({ ok: true });
    }),
  );
  const advance = (message: Row) => {
    const enrollment = db
      .prepare("SELECT status,schedule FROM outreach_enrollments WHERE id=?")
      .get(message.enrollment_id);
    if (
      !enrollment ||
      !["active", "paused"].includes(String(enrollment.status))
    )
      return;
    const next = db
      .prepare(
        "SELECT id,delay_days FROM outreach_messages WHERE enrollment_id=? AND step_index=? AND status='waiting'",
      )
      .get(message.enrollment_id, Number(message.step_index) + 1);
    if (next)
      db.prepare(
        "UPDATE outreach_messages SET status='pending',due_at=?,updated_at=? WHERE id=?",
      ).run(
        scheduledTime(
          clock() + Number(next.delay_days) * DAY,
          enrollment.schedule as string | null,
        ),
        clock(),
        next.id,
      );
    else
      db.prepare(
        "UPDATE outreach_enrollments SET status='completed',updated_at=? WHERE id=?",
      ).run(clock(), message.enrollment_id);
  };
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
            `<p>Confirm to stop this hiring workspace from sending you further sequence messages. Opening this page does not change your preferences.</p><form method="post" action="${escapeHtml(req.path)}"><p>If you received a Cc or Bcc copy, enter your email to unsubscribe your address. Leave it blank to unsubscribe the primary recipient.</p><label>Your email (optional)<input type="email" name="email" maxlength="254"></label><button type="submit" style="padding:12px 20px">Unsubscribe</button></form>`,
          ),
        );
    }),
  );
  app.post(
    "/api/outreach/unsubscribe/:token",
    urlencoded({ extended: false, limit: "2kb", parameterLimit: 2 }),
    route((req, res) => {
      const row = publicEnrollment(req);
      const supplied =
        typeof req.body?.email === "string"
          ? req.body.email.trim().toLowerCase()
          : "";
      const parsed = supplied ? emailSchema.safeParse(supplied) : null;
      if (!supplied)
        suppress(
          String(row.workspace_id),
          String(row.email),
          "Recipient unsubscribed.",
        );
      else if (
        parsed?.success &&
        db
          .prepare(
            "SELECT r.email FROM outreach_recipients r JOIN outreach_messages m ON m.id=r.message_id WHERE m.enrollment_id=? AND r.email=? LIMIT 1",
          )
          .get(row.id, parsed.data)
      )
        suppress(
          String(row.workspace_id),
          parsed.data,
          "Recipient unsubscribed.",
        );
      // Identical responses for unknown addresses avoid exposing blind-copy membership.
      res.setHeader("Referrer-Policy", "no-referrer");
      res
        .type("html")
        .send(
          unsubscribePage(
            "You’re unsubscribed",
            "<p>Any matching recipient address has been unsubscribed from this workspace. A message already accepted by the email provider may still arrive.</p>",
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
        if (["bounced", "complained", "suppressed"].includes(result)) {
          const addresses = db
            .prepare("SELECT email FROM outreach_recipients WHERE message_id=?")
            .all(row.id);
          // Provider status is at message level. Without an individual-recipient event, stop the entire approved recipient group rather than retry a potentially suppressed copy.
          for (const address of addresses.length
            ? addresses
            : [{ email: row.email }])
            suppress(
              String(row.workspace_id),
              String(address.email),
              `Provider reported ${result} for a message including this recipient.`,
            );
        } else if (result === "failed")
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
              "SELECT m.*,e.workspace_id,e.email,e.mode,e.sender,e.reply_to,e.public_url,e.schedule,e.status AS enrollment_status,e.candidate_id FROM outreach_messages m JOIN outreach_enrollments e ON e.id=m.enrollment_id WHERE m.status IN ('pending','retry') AND m.due_at<=? AND e.status='active' ORDER BY m.due_at,m.id LIMIT 1",
            )
            .get(clock()) as Row | undefined;
          if (!candidate) return;
          const nextTime = scheduledTime(
            clock(),
            candidate.schedule as string | null,
          );
          if (nextTime > clock()) {
            db.prepare(
              "UPDATE outreach_messages SET due_at=?,updated_at=? WHERE id=?",
            ).run(nextTime, clock(), candidate.id);
            return { deferred: 1 } as Row;
          }
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
        if (row.deferred) continue;
        const id = String(row.id),
          enrollmentId = String(row.enrollment_id),
          workspaceId = String(row.workspace_id);
        const recipientsSuppressed = !!db
          .prepare(
            "SELECT r.email FROM outreach_recipients r JOIN outreach_suppressions s ON s.workspace_id=r.workspace_id AND s.email=r.email WHERE r.message_id=? LIMIT 1",
          )
          .get(id);
        if (
          suppressed(workspaceId, String(row.email)) ||
          recipientsSuppressed
        ) {
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
        if (row.kind !== "email") {
          db.prepare(
            "UPDATE outreach_messages SET status='task_due',attempts=0,first_attempt_at=NULL,claimed_at=NULL,updated_at=? WHERE id=?",
          ).run(clock(), id);
          event(
            enrollmentId,
            "task_due",
            "Manual task is ready. Complete it outside ArkOffer, then confirm completion to continue the schedule.",
            id,
          );
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
            ...(row.html ? { html: String(row.html) } : {}),
            cc: JSON.parse(String(row.cc || "[]")),
            bcc: JSON.parse(String(row.bcc || "[]")),
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
            advance(row);
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
            retry
              ? scheduledTime(clock() + delay, row.schedule as string | null)
              : null,
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
