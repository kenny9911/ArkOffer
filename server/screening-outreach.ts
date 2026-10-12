import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  urlencoded,
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { z } from "zod";
import { sessionUser, hashToken, userById } from "./auth.js";
import type { Store } from "./db.js";
import { buildScreeningSnapshot, ScreeningError } from "./screening.js";
import { createMailTransport, MailError, type MailConfig } from "./mail.js";
import { escapeEmailHtml } from "../shared/email-markup.js";

type Options = {
  clock?: () => number;
  fetch?: typeof fetch;
  mail?: MailConfig;
  tokenSecret?: string;
  validateSnapshot?: (snapshot: unknown, workspaceId: string) => void;
};
type Row = Record<string, string | number | null>;
const DAY = 86_400_000;
const email = z.string().trim().toLowerCase().email().max(254);
const draftSchema = z
  .object({
    revision: z.string().min(1),
    candidateIds: z.array(z.uuid()).max(50).default([]),
    recipients: z
      .array(
        z.object({ name: z.string().trim().min(1).max(120), email }).strict(),
      )
      .max(50)
      .default([]),
    subject: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine((v) => !/[\r\n]/.test(v), "Use one line for the subject."),
    body: z.string().trim().min(1).max(10000),
    reminderDays: z
      .array(z.number().int().min(1).max(29))
      .max(5)
      .default([3, 1]),
  })
  .strict();
const fail = (status: number, message: string): never => {
  throw new ScreeningError(status, message);
};
const route =
  (handler: (req: Request, res: Response) => unknown) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (error instanceof ScreeningError)
        res.status(error.status).json({ error: error.message });
      else if (error instanceof z.ZodError)
        res
          .status(400)
          .json({ error: error.issues[0]?.message || "Invalid invitation." });
      else next(error);
    }
  };
const personalize = (text: string, values: Record<string, string>) =>
  text.replace(
    /\{\{([a-z_]+)\}\}/g,
    (match, key: string) => values[key] ?? match,
  );

/** Mail bodies/capabilities are derived at send time, never persisted in plaintext. */
export function registerScreeningOutreach(
  app: Express,
  store: Store,
  options: Options = {},
) {
  const db = store.db,
    clock = options.clock || Date.now,
    transport = createMailTransport(options.mail, options.fetch);
  let secret =
    options.tokenSecret ?? process.env.SCREENING_OUTREACH_SECRET ?? "";
  if (!secret && transport.config.mode === "outbox") {
    const path = join(store.dataDir, "screening-outreach.key");
    try {
      secret = readFileSync(path, "utf8").trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const generated = randomBytes(32).toString("hex");
      try {
        writeFileSync(path, generated, { mode: 0o600, flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      secret = readFileSync(path, "utf8").trim();
    }
  }
  const secretReady = secret.length >= 32,
    keyId = secretReady ? hashToken(secret) : "";
  const capability = (
    workspace: string,
    id: string,
    kind: "interview" | "unsubscribe",
  ) =>
    createHmac("sha256", secret)
      .update(`arkoffer/screening/${kind}/${workspace}/${id}`)
      .digest("hex");
  db.exec(`
    CREATE TABLE IF NOT EXISTS screening_invitation_previews (
      id TEXT PRIMARY KEY,screening_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      revision TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,
      request_id TEXT,queued_at INTEGER,UNIQUE(workspace_id,request_id)
    );
    CREATE TABLE IF NOT EXISTS screening_invitations (
      id TEXT PRIMARY KEY,preview_id TEXT NOT NULL REFERENCES screening_invitation_previews(id) ON DELETE CASCADE,
      screening_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      publication_id TEXT NOT NULL UNIQUE REFERENCES screening_publications(id) ON DELETE CASCADE,actor_id TEXT NOT NULL REFERENCES users(id),
      candidate_id TEXT,name TEXT NOT NULL,email TEXT NOT NULL,subject TEXT NOT NULL,body TEXT NOT NULL,
      unsubscribe_hash TEXT NOT NULL UNIQUE,key_id TEXT NOT NULL,delivery_config TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',created_at INTEGER NOT NULL,opened_at INTEGER,cancelled_at INTEGER,opted_out_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS screening_invitations_scope ON screening_invitations(workspace_id,screening_id,created_at);
    CREATE TABLE IF NOT EXISTS screening_invitation_messages (
      id TEXT PRIMARY KEY,invitation_id TEXT NOT NULL REFERENCES screening_invitations(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,days_before INTEGER NOT NULL DEFAULT 0,due_at INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending',
      claimed_at INTEGER,provider_id TEXT,provider_event TEXT,error TEXT,checked_at INTEGER,updated_at INTEGER NOT NULL,
      UNIQUE(invitation_id,kind,days_before)
    );
    CREATE INDEX IF NOT EXISTS screening_invitation_due ON screening_invitation_messages(status,due_at);
    CREATE TABLE IF NOT EXISTS screening_invitation_suppressions (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,email TEXT NOT NULL,created_at INTEGER NOT NULL,
      PRIMARY KEY(workspace_id,email)
    );
  `);
  const deliveryConfig = () =>
    JSON.stringify({
      mode: transport.config.mode,
      from: transport.config.from,
      replyTo: transport.config.replyTo,
      publicUrl: transport.publicUrl,
    });
  const actor = (req: Request, write = false) => {
    const user =
      sessionUser(store, req) ||
      fail(401, "Sign in to manage screening invitations.");
    if (write && user.role !== "owner")
      fail(
        403,
        "Only a workspace owner can queue or cancel screening invitations.",
      );
    const screening =
      store.get(user.workspaceId, "screenings", String(req.params.id)) ||
      fail(404, "Screening not found.");
    return { user, screening };
  };
  const ready = (workspaceId: string) =>
    secretReady && !!transport.publicUrl && transport.allowed(workspaceId);
  const suppression = (workspaceId: string, address: string) =>
    !!db
      .prepare(
        "SELECT email FROM screening_invitation_suppressions WHERE workspace_id=? AND email=?",
      )
      .get(workspaceId, address);
  const stop = (id: string, status: string) => {
    db.prepare(
      "UPDATE screening_invitations SET status=? WHERE id=? AND status='active'",
    ).run(status, id);
    db.prepare(
      "UPDATE screening_invitation_messages SET status='cancelled',updated_at=? WHERE invitation_id=? AND status='pending'",
    ).run(clock(), id);
  };
  const sync = () => {
    const rows = db
      .prepare(
        `SELECT i.id,i.workspace_id,i.email,i.candidate_id,i.actor_id,p.revoked_at,p.expires_at,r.submitted_at
      FROM screening_invitations i JOIN screening_publications p ON p.id=i.publication_id
      LEFT JOIN screening_responses r ON r.publication_id=p.id WHERE i.status='active'`,
      )
      .all() as Row[];
    for (const row of rows) {
      const author = userById(
        store,
        String(row.actor_id),
        String(row.workspace_id),
      );
      const status = row.submitted_at
        ? "completed"
        : row.revoked_at
          ? "revoked"
          : Number(row.expires_at) <= clock()
            ? "expired"
            : suppression(String(row.workspace_id), String(row.email))
              ? "unsubscribed"
              : !author || author.role !== "owner"
                ? "author_unavailable"
                : row.candidate_id &&
                    !store.get(
                      String(row.workspace_id),
                      "candidates",
                      String(row.candidate_id),
                    )
                  ? "candidate_removed"
                  : null;
      if (status) stop(String(row.id), status);
    }
  };
  const inviteRows = (workspaceId: string, screeningId: string) => {
    sync();
    return db
      .prepare(
        `SELECT i.id,i.name,i.email,i.status,i.created_at,i.opened_at,i.cancelled_at,i.opted_out_at,i.publication_id,p.expires_at,r.submitted_at
      FROM screening_invitations i JOIN screening_publications p ON p.id=i.publication_id
      LEFT JOIN screening_responses r ON r.publication_id=p.id WHERE i.workspace_id=? AND i.screening_id=? ORDER BY i.created_at DESC LIMIT 500`,
      )
      .all(workspaceId, screeningId)
      .map((row) => ({
        id: row.id,
        name: row.name,
        email: row.email,
        status: row.status,
        createdAt: row.created_at,
        openedAt: row.opened_at,
        expiresAt: row.expires_at,
        submittedAt: row.submitted_at,
        messages: db
          .prepare(
            "SELECT id,kind,days_before AS daysBefore,due_at AS dueAt,status,provider_event AS providerEvent,error FROM screening_invitation_messages WHERE invitation_id=? ORDER BY due_at",
          )
          .all(row.id),
      }));
  };
  const values = (
    name: string,
    title: string,
    workspaceName: string,
    url: string,
    deadline: number,
  ) => ({
    candidate_name: name,
    candidate_first_name: name.split(/\s/)[0],
    screening_title: title,
    company_name: workspaceName,
    interview_link: url,
    deadline: new Date(deadline)
      .toISOString()
      .replace("T", " ")
      .replace(":00.000Z", " UTC"),
  });
  const compose = (row: Row, reminder = false) => {
    const publication = db
      .prepare(
        "SELECT snapshot,expires_at FROM screening_publications WHERE id=?",
      )
      .get(row.publication_id)!;
    const snapshot = JSON.parse(String(publication.snapshot)) as {
      title: string;
      workspaceName: string;
    };
    const token = capability(
        String(row.workspace_id),
        String(row.id),
        "interview",
      ),
      url = `${transport.publicUrl}/interviews/${token}`;
    const unsubscribeUrl = `${transport.publicUrl}/api/screening-outreach/unsubscribe/${capability(String(row.workspace_id), String(row.id), "unsubscribe")}`;
    const substitutions = values(
      String(row.name),
      snapshot.title,
      snapshot.workspaceName,
      url,
      Number(publication.expires_at),
    );
    let text = personalize(String(row.body), substitutions);
    if (!String(row.body).includes("{{interview_link}}"))
      text += `\n\nStart screening: ${url}`;
    if (reminder)
      text = `Reminder: your screening is due ${substitutions.deadline}.\n\n${text}`;
    text += `\n\nStop screening invitations from ${snapshot.workspaceName}: ${unsubscribeUrl}`;
    return {
      subject: `${reminder ? "Reminder: " : ""}${personalize(String(row.subject), substitutions)}`,
      text,
      unsubscribeUrl,
      url,
    };
  };
  app.get(
    "/api/screenings/:id/outreach",
    route((req, res) => {
      const { user, screening } = actor(req);
      res.json({
        items: inviteRows(user.workspaceId, screening.id),
        delivery: {
          mode: transport.config.mode,
          from: transport.config.from || "Local outbox",
          ready: ready(user.workspaceId),
          canManage: user.role === "owner",
          reason: !secretReady
            ? "Set SCREENING_OUTREACH_SECRET to at least 32 characters before sending."
            : !ready(user.workspaceId)
              ? "Configure the verified sender, public URL, and approved workspace before sending."
              : null,
        },
      });
    }),
  );
  app.post(
    "/api/screenings/:id/outreach/preview",
    route((req, res) => {
      const { user, screening } = actor(req, true),
        input = draftSchema.parse(req.body);
      if (input.revision !== screening.updatedAt)
        fail(
          409,
          "The screening changed. Save and reload it before preparing invitations.",
        );
      if (!ready(user.workspaceId))
        fail(
          409,
          "Screening email delivery is not configured for this workspace.",
        );
      const { snapshot, deadlineDays } = buildScreeningSnapshot(
        screening,
        user.workspaceName,
      );
      options.validateSnapshot?.(snapshot, user.workspaceId);
      const recipients = input.recipients.map((r) => ({
        ...r,
        candidateId: null as string | null,
      }));
      for (const candidateId of new Set(input.candidateIds)) {
        const candidate =
          store.get(user.workspaceId, "candidates", candidateId) ||
          fail(404, "A selected candidate is unavailable.");
        recipients.push({
          name: z.string().trim().min(1).max(120).parse(candidate.name),
          email: email.parse(candidate.email),
          candidateId,
        });
      }
      if (!recipients.length || recipients.length > 50)
        fail(400, "Choose between 1 and 50 recipients.");
      if (new Set(recipients.map((r) => r.email)).size !== recipients.length)
        fail(400, "Each recipient email must be unique.");
      const reminderDays = [...new Set(input.reminderDays)].sort(
        (a, b) => b - a,
      );
      if (reminderDays.some((day) => day >= deadlineDays))
        fail(
          400,
          "Reminders must be fewer days before the deadline than the screening duration.",
        );
      for (const recipient of recipients)
        if (suppression(user.workspaceId, recipient.email))
          fail(
            409,
            `${recipient.email} has opted out of screening invitations.`,
          );
      const unknown = [
        ...`${input.subject}\n${input.body}`.matchAll(/\{\{([^}]+)\}\}/g),
      ].find(
        (match) =>
          ![
            "candidate_name",
            "candidate_first_name",
            "screening_title",
            "company_name",
            "interview_link",
            "deadline",
          ].includes(match[1]),
      );
      if (unknown) fail(400, `Unsupported variable: ${unknown[0]}`);
      const id = randomUUID(),
        createdAt = clock(),
        expiresAt = createdAt + 15 * 60000;
      const payload = {
        snapshot,
        deadlineDays,
        recipients,
        subject: input.subject,
        body: input.body,
        reminderDays,
        deliveryConfig: deliveryConfig(),
        keyId,
      };
      // Bounded preview retention; queued previews are immutable delivery records.
      db.prepare(
        "DELETE FROM screening_invitation_previews WHERE queued_at IS NULL AND expires_at<?",
      ).run(clock());
      if (
        Number(
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM screening_invitation_previews WHERE workspace_id=? AND queued_at IS NULL",
            )
            .get(user.workspaceId)?.n,
        ) >= 100
      )
        fail(
          429,
          "Too many pending invitation previews. Wait for older previews to expire.",
        );
      db.prepare(
        "INSERT INTO screening_invitation_previews(id,screening_id,workspace_id,actor_id,revision,payload,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)",
      ).run(
        id,
        screening.id,
        user.workspaceId,
        user.id,
        screening.updatedAt,
        JSON.stringify(payload),
        createdAt,
        expiresAt,
      );
      res.status(201).json({
        item: {
          id,
          expiresAt,
          mode: transport.config.mode,
          from: transport.config.from || "Local outbox",
          deadlineDays,
          reminderDays,
          recipients: recipients.map((recipient) => {
            const substitutions = values(
              recipient.name,
              snapshot.title,
              user.workspaceName,
              "[unique candidate link]",
              createdAt + deadlineDays * DAY,
            );
            return {
              ...recipient,
              subject: personalize(input.subject, substitutions),
              body:
                personalize(input.body, substitutions) +
                (!input.body.includes("{{interview_link}}")
                  ? "\n\nStart screening: [unique candidate link]"
                  : "") +
                "\n\nAn opt-out link is included in every message.",
            };
          }),
        },
      });
    }),
  );
  app.post(
    "/api/screenings/:id/outreach/queue",
    route((req, res) => {
      const { user, screening } = actor(req, true),
        input = z
          .object({
            previewId: z.uuid(),
            requestId: z.uuid(),
            confirmed: z.literal(true),
          })
          .strict()
          .parse(req.body);
      const result = store.transaction(() => {
        const replay = db
          .prepare(
            "SELECT id,screening_id FROM screening_invitation_previews WHERE workspace_id=? AND request_id=? AND queued_at IS NOT NULL",
          )
          .get(user.workspaceId, input.requestId);
        if (replay) {
          if (
            replay.id !== input.previewId ||
            replay.screening_id !== screening.id
          )
            fail(
              409,
              "This request identity belongs to a different invitation batch.",
            );
          return { replayed: true };
        }
        const preview = db
          .prepare(
            "SELECT * FROM screening_invitation_previews WHERE id=? AND workspace_id=? AND screening_id=? AND actor_id=?",
          )
          .get(input.previewId, user.workspaceId, screening.id, user.id) as
          Row | undefined;
        if (!preview) fail(404, "Invitation preview not found.");
        if (preview!.queued_at)
          fail(
            409,
            "This preview was already queued. Refresh delivery history.",
          );
        if (Number(preview!.expires_at) <= clock())
          fail(
            409,
            "This invitation preview expired. Review a fresh preview before queuing.",
          );
        if (preview!.revision !== screening.updatedAt)
          fail(
            409,
            "The screening changed after the preview. Review a fresh preview before queuing.",
          );
        const payload = JSON.parse(String(preview!.payload)) as {
          snapshot: unknown;
          deadlineDays: number;
          recipients: {
            name: string;
            email: string;
            candidateId: string | null;
          }[];
          subject: string;
          body: string;
          reminderDays: number[];
          deliveryConfig: string;
          keyId: string;
        };
        if (
          !ready(user.workspaceId) ||
          payload.deliveryConfig !== deliveryConfig() ||
          payload.keyId !== keyId
        )
          fail(409, "Delivery settings changed. Review a fresh preview.");
        options.validateSnapshot?.(payload.snapshot, user.workspaceId);
        const now = clock(),
          expiresAt = now + payload.deadlineDays * DAY;
        const active = Number(
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM screening_publications WHERE workspace_id=? AND screening_id=? AND revoked_at IS NULL AND expires_at>?",
            )
            .get(user.workspaceId, screening.id, now)?.n,
        );
        if (active + payload.recipients.length > 100)
          fail(
            409,
            "This screening supports 100 active candidate links. Revoke unused links before inviting more candidates.",
          );
        const total = Number(
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM screening_invitations WHERE workspace_id=?",
            )
            .get(user.workspaceId)?.n,
        );
        if (total + payload.recipients.length > 10000)
          fail(
            409,
            "This workspace has reached its 10,000 screening invitation limit.",
          );
        for (const recipient of payload.recipients) {
          if (suppression(user.workspaceId, recipient.email))
            fail(409, "A reviewed recipient has since opted out.");
          if (recipient.candidateId) {
            const candidate = store.get(
              user.workspaceId,
              "candidates",
              recipient.candidateId,
            );
            if (
              !candidate ||
              String(candidate.email).toLowerCase().trim() !==
                recipient.email ||
              candidate.name !== recipient.name
            )
              fail(
                409,
                "A selected candidate changed. Review a fresh preview.",
              );
          }
          if (
            db
              .prepare(
                "SELECT i.id FROM screening_invitations i JOIN screening_publications p ON p.id=i.publication_id WHERE i.workspace_id=? AND i.screening_id=? AND i.email=? AND p.expires_at>? AND p.revoked_at IS NULL AND i.status IN ('active','attention','completed')",
              )
              .get(user.workspaceId, screening.id, recipient.email, now)
          )
            fail(
              409,
              `${recipient.email} already has an active invitation for this screening.`,
            );
          const id = randomUUID(),
            publicationId = randomUUID(),
            token = capability(user.workspaceId, id, "interview"),
            unsubscribe = capability(user.workspaceId, id, "unsubscribe");
          db.prepare(
            "INSERT INTO screening_publications(id,screening_id,workspace_id,token_hash,snapshot,expires_at,created_at) VALUES(?,?,?,?,?,?,?)",
          ).run(
            publicationId,
            screening.id,
            user.workspaceId,
            hashToken(token),
            JSON.stringify(payload.snapshot),
            expiresAt,
            new Date(now).toISOString(),
          );
          db.prepare(
            "INSERT INTO screening_invitations(id,preview_id,screening_id,workspace_id,publication_id,actor_id,candidate_id,name,email,subject,body,unsubscribe_hash,key_id,delivery_config,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          ).run(
            id,
            input.previewId,
            screening.id,
            user.workspaceId,
            publicationId,
            user.id,
            recipient.candidateId,
            recipient.name,
            recipient.email,
            payload.subject,
            payload.body,
            hashToken(unsubscribe),
            keyId,
            deliveryConfig(),
            now,
          );
          const insert = db.prepare(
            "INSERT INTO screening_invitation_messages(id,invitation_id,kind,days_before,due_at,updated_at) VALUES(?,?,?,?,?,?)",
          );
          insert.run(randomUUID(), id, "invitation", 0, now, now);
          for (const day of payload.reminderDays)
            insert.run(
              randomUUID(),
              id,
              "reminder",
              day,
              expiresAt - day * DAY,
              now,
            );
        }
        db.prepare(
          "UPDATE screening_invitation_previews SET request_id=?,queued_at=? WHERE id=?",
        ).run(input.requestId, now, input.previewId);
        return { replayed: false };
      });
      res
        .status(result.replayed ? 200 : 201)
        .json({ ...result, items: inviteRows(user.workspaceId, screening.id) });
    }),
  );
  app.post(
    "/api/screenings/:id/outreach/invitations/:invitationId/cancel",
    route((req, res) => {
      const { user, screening } = actor(req, true);
      z.object({ confirmed: z.literal(true) })
        .strict()
        .parse(req.body);
      const row =
        db
          .prepare(
            "SELECT id,publication_id FROM screening_invitations WHERE id=? AND workspace_id=? AND screening_id=?",
          )
          .get(
            String(req.params.invitationId),
            user.workspaceId,
            screening.id,
          ) || fail(404, "Invitation not found.");
      store.transaction(() => {
        stop(String(row.id), "cancelled");
        db.prepare(
          "UPDATE screening_invitations SET status='cancelled' WHERE id=? AND status!='completed'",
        ).run(row.id);
        db.prepare(
          "UPDATE screening_invitations SET cancelled_at=COALESCE(cancelled_at,?) WHERE id=?",
        ).run(clock(), row.id);
        db.prepare(
          "UPDATE screening_publications SET revoked_at=COALESCE(revoked_at,?) WHERE id=?",
        ).run(new Date(clock()).toISOString(), row.publication_id);
      });
      res.json({ ok: true });
    }),
  );
  app.get(
    "/api/screenings/:id/outreach/invitations/:invitationId/preview",
    route((req, res) => {
      const { user, screening } = actor(req, true);
      const row = db
        .prepare(
          "SELECT * FROM screening_invitations WHERE id=? AND workspace_id=? AND screening_id=?",
        )
        .get(
          String(req.params.invitationId),
          user.workspaceId,
          screening.id,
        ) as Row | undefined;
      if (!row) fail(404, "Invitation not found.");
      if (
        !secretReady ||
        row!.key_id !== keyId ||
        row!.delivery_config !== deliveryConfig()
      )
        fail(
          409,
          "The invitation was created with different delivery settings. Its original capability cannot be displayed here.",
        );
      res.setHeader("Cache-Control", "no-store");
      res.json({
        item: {
          ...compose(row!),
          to: row!.email,
          name: row!.name,
          mode: JSON.parse(String(row!.delivery_config)).mode,
        },
      });
    }),
  );
  const publicInvitation = (req: Request) => {
    const token = String(req.params.token);
    if (!/^[a-f0-9]{64}$/.test(token))
      fail(404, "Unsubscribe link unavailable.");
    return (
      db
        .prepare(
          "SELECT id,workspace_id,email FROM screening_invitations WHERE unsubscribe_hash=?",
        )
        .get(hashToken(token)) || fail(404, "Unsubscribe link unavailable.")
    );
  };
  const page = (title: string, body: string) =>
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title} · ArkOffer</title><body style="font:16px system-ui;max-width:560px;margin:12vh auto;padding:24px;line-height:1.6"><h1>${title}</h1>${body}</body></html>`;
  app.get(
    "/api/screening-outreach/unsubscribe/:token",
    route((req, res) => {
      publicInvitation(req);
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Cache-Control", "no-store");
      res
        .type("html")
        .send(
          page(
            "Stop screening invitations",
            `<p>Confirm to stop further screening invitations and reminders from this hiring workspace. Opening this page does not change your preferences.</p><form method="post" action="${escapeEmailHtml(req.path)}"><button type="submit">Unsubscribe</button></form>`,
          ),
        );
    }),
  );
  app.post(
    "/api/screening-outreach/unsubscribe/:token",
    urlencoded({ extended: false, limit: "1kb", parameterLimit: 1 }),
    route((req, res) => {
      const row = publicInvitation(req);
      store.transaction(() => {
        db.prepare(
          "INSERT OR IGNORE INTO screening_invitation_suppressions(workspace_id,email,created_at) VALUES(?,?,?)",
        ).run(row.workspace_id, row.email, clock());
        const invitations = db
          .prepare(
            "SELECT id FROM screening_invitations WHERE workspace_id=? AND email=?",
          )
          .all(row.workspace_id, row.email);
        for (const invitation of invitations) {
          stop(String(invitation.id), "unsubscribed");
          db.prepare(
            "UPDATE screening_invitations SET opted_out_at=COALESCE(opted_out_at,?) WHERE id=?",
          ).run(clock(), invitation.id);
        }
      });
      res.setHeader("Referrer-Policy", "no-referrer");
      res
        .type("html")
        .send(
          page(
            "You’re unsubscribed",
            "<p>This workspace will not send you further screening invitations or reminders. A message already accepted by the email provider may still arrive. Your screening link remains available until its deadline.</p>",
          ),
        );
    }),
  );
  let ticking: Promise<void> | undefined;
  const tick = async (limit = 10) => {
    if (ticking) return ticking;
    ticking = (async () => {
      sync();
      for (const stale of db
        .prepare(
          "SELECT id,invitation_id FROM screening_invitation_messages WHERE status='sending' AND claimed_at<?",
        )
        .all(clock() - 60000)) {
        db.prepare(
          "UPDATE screening_invitation_messages SET status='unknown',error=?,updated_at=? WHERE id=? AND status='sending'",
        ).run(
          "Delivery was interrupted before confirmation. Check the provider; automatic retry is disabled.",
          clock(),
          stale.id,
        );
        stop(String(stale.invitation_id), "attention");
      }
      for (let index = 0; index < Math.min(Math.max(limit, 1), 20); index++) {
        sync();
        const row = store.transaction(() => {
          const row = db
            .prepare(
              `SELECT m.id AS message_id,m.kind,m.due_at,i.* FROM screening_invitation_messages m JOIN screening_invitations i ON i.id=m.invitation_id
            WHERE m.status='pending' AND m.due_at<=? AND i.status='active'
            AND (m.kind='invitation' OR EXISTS(SELECT 1 FROM screening_invitation_messages first WHERE first.invitation_id=i.id AND first.kind='invitation' AND first.status IN ('accepted','delivered','outbox')))
            ORDER BY m.due_at,m.id LIMIT 1`,
            )
            .get(clock()) as Row | undefined;
          if (!row) return;
          if (row.kind === "reminder") {
            const recent = db
              .prepare(
                "SELECT id FROM screening_invitation_messages WHERE invitation_id=? AND status IN ('accepted','delivered','outbox') AND claimed_at>? LIMIT 1",
              )
              .get(row.id, clock() - DAY);
            // Do not turn downtime into several reminders arriving together.
            if (clock() - Number(row.due_at) > 6 * 3600000 || recent) {
              db.prepare(
                "UPDATE screening_invitation_messages SET status='skipped',error=?,updated_at=? WHERE id=?",
              ).run(
                "Missed reminder window or another invitation was sent within the last day.",
                clock(),
                row.message_id,
              );
              return { ...row, skipped: 1 };
            }
          }
          const result = db
            .prepare(
              "UPDATE screening_invitation_messages SET status='sending',claimed_at=?,updated_at=? WHERE id=? AND status='pending'",
            )
            .run(clock(), clock(), row.message_id);
          return result.changes ? row : undefined;
        });
        if (!row) break;
        if (row.skipped) continue;
        try {
          if (
            !ready(String(row.workspace_id)) ||
            row.delivery_config !== deliveryConfig() ||
            row.key_id !== keyId
          )
            throw new MailError(
              "permanent",
              "Delivery settings or the token secret changed. No email was sent.",
            );
          const published = db
            .prepare("SELECT snapshot FROM screening_publications WHERE id=?")
            .get(row.publication_id);
          options.validateSnapshot?.(
            JSON.parse(String(published?.snapshot)),
            String(row.workspace_id),
          );
          const mail = compose(row, row.kind === "reminder"),
            result = await transport.send({
              to: String(row.email),
              subject: mail.subject,
              text: mail.text,
              unsubscribeUrl: mail.unsubscribeUrl,
              idempotencyKey: `arkoffer/screening/${row.message_id}`,
            });
          db.prepare(
            "UPDATE screening_invitation_messages SET status=?,provider_id=?,provider_event=?,updated_at=? WHERE id=? AND status='sending'",
          ).run(
            result.state,
            result.id,
            result.state === "outbox" ? "not_delivered" : "sent",
            clock(),
            row.message_id,
          );
        } catch (error) {
          const known =
              (error instanceof MailError && error.kind === "permanent") ||
              error instanceof ScreeningError,
            status = known ? "failed" : "unknown";
          db.prepare(
            "UPDATE screening_invitation_messages SET status=?,error=?,updated_at=? WHERE id=? AND status='sending'",
          ).run(
            status,
            known
              ? (error as Error).message
              : "Delivery could not be confirmed. Check the provider dashboard before contacting this candidate again; no automatic retry is scheduled.",
            clock(),
            row.message_id,
          );
          stop(String(row.id), "attention");
        }
      }
    })().finally(() => {
      ticking = undefined;
    });
    return ticking;
  };
  let reconciling: Promise<number> | undefined;
  const reconcile = async () => {
    if (reconciling) return reconciling;
    reconciling = (async () => {
      sync();
      let count = 0;
      for (const row of db
        .prepare(
          `SELECT m.id,m.provider_id,i.id AS invitation_id,i.workspace_id,i.email,i.delivery_config FROM screening_invitation_messages m JOIN screening_invitations i ON i.id=m.invitation_id WHERE m.status IN ('accepted','delivered') AND m.provider_id IS NOT NULL AND (m.checked_at IS NULL OR m.checked_at<?) ORDER BY COALESCE(m.checked_at,0) LIMIT 10`,
        )
        .all(clock() - 60000) as Row[]) {
        if (
          !ready(String(row.workspace_id)) ||
          row.delivery_config !== deliveryConfig()
        )
          continue;
        try {
          const event = await transport.retrieve(String(row.provider_id)),
            bad = ["bounced", "complained", "failed", "suppressed"].includes(
              event,
            );
          db.prepare(
            "UPDATE screening_invitation_messages SET status=?,provider_event=?,checked_at=?,updated_at=? WHERE id=?",
          ).run(
            bad
              ? "failed"
              : ["delivered", "opened", "clicked"].includes(event)
                ? "delivered"
                : "accepted",
            event,
            clock(),
            clock(),
            row.id,
          );
          if (bad) {
            db.prepare(
              "INSERT OR IGNORE INTO screening_invitation_suppressions(workspace_id,email,created_at) VALUES(?,?,?)",
            ).run(row.workspace_id, row.email, clock());
            stop(String(row.invitation_id), "attention");
          }
          count++;
        } catch {
          db.prepare(
            "UPDATE screening_invitation_messages SET checked_at=? WHERE id=?",
          ).run(clock(), row.id);
        }
      }
      return count;
    })().finally(() => {
      reconciling = undefined;
    });
    return reconciling;
  };
  let timer: ReturnType<typeof setInterval> | undefined,
    maintenance: Promise<unknown> | undefined;
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
          .catch(() => {})
          .finally(() => {
            maintenance = undefined;
          });
      };
      timer = setInterval(work, 15000);
      timer.unref();
      work();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await maintenance;
      await ticking;
      await reconciling;
    },
  };
}
