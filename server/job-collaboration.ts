import { randomUUID } from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";
import { z } from "zod";
import { hashToken, sessionUser, type User } from "./auth.js";
import type { Resource, Store } from "./db.js";

class CollaborationError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const fail = (status: number, message: string): never => {
  throw new CollaborationError(status, message);
};
const route =
  (handler: (req: Request, res: Response) => unknown) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve()
      .then(() => handler(req, res))
      .catch((error: unknown) => {
        if (error instanceof CollaborationError)
          res.status(error.status).json({ error: error.message });
        else if (error instanceof z.ZodError)
          res
            .status(400)
            .json({ error: error.issues[0]?.message || "Invalid job review." });
        else next(error);
      });
  };
const textSchema = z.string().trim().min(1).max(4000);
const revisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
type Row = Record<string, any>;
function snapshot(job: Resource) {
  return Object.fromEntries(
    [
      "id",
      "title",
      "description",
      "department",
      "location",
      "employmentType",
      "salary",
      "status",
      "updatedAt",
    ].map((key) => [key, typeof job[key] === "string" ? job[key] : ""]),
  );
}

/** Workspace comments and human review checks are separate from the job text. */
export function registerJobCollaboration(app: Express, store: Store) {
  const db = store.db;
  db.exec(`CREATE TABLE IF NOT EXISTS job_comments (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    job_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    body TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS job_comments_job ON job_comments(workspace_id,job_id,created_at);
    CREATE TABLE IF NOT EXISTS job_review_checks (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    job_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    fingerprint TEXT NOT NULL, reviewed INTEGER NOT NULL, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY(workspace_id,job_id,user_id));
    CREATE TABLE IF NOT EXISTS job_review_history (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    job_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    fingerprint TEXT NOT NULL, reviewed INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS job_review_history_job ON job_review_history(workspace_id,job_id,created_at);
    CREATE TABLE IF NOT EXISTS job_collaboration_attempts (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS job_collaboration_budget ON job_collaboration_attempts(workspace_id,user_id,created_at);`);
  const auth = (req: Request) =>
    sessionUser(store, req) || fail(401, "Please sign in to continue.");
  const job = (user: User, id: unknown) =>
    store.get(user.workspaceId, "jobs", z.uuid().parse(id)) ||
    fail(404, "Job post not found.");
  const fingerprint = (item: Resource) =>
    hashToken(JSON.stringify(snapshot(item)));
  const budget = (user: User, kind: "comment" | "review") => {
    db.prepare(
      "DELETE FROM job_collaboration_attempts WHERE created_at < ?",
    ).run(Date.now() - 86400000);
    const count = db
      .prepare(
        "SELECT COUNT(*) AS count FROM job_collaboration_attempts WHERE workspace_id=? AND user_id=? AND kind=? AND created_at > ?",
      )
      .get(user.workspaceId, user.id, kind, Date.now() - 3600000)!;
    if (Number(count.count) >= (kind === "comment" ? 30 : 60))
      fail(
        429,
        "The hourly job review limit has been reached. Please try again later.",
      );
    db.prepare("INSERT INTO job_collaboration_attempts VALUES(?,?,?,?,?)").run(
      randomUUID(),
      user.workspaceId,
      user.id,
      kind,
      Date.now(),
    );
  };
  const author = (row: Row) => ({
    id: row.user_id,
    name: row.author_name || "Former member",
  });
  const comments = (user: User, id: string) =>
    db
      .prepare(
        `SELECT c.*, u.name AS author_name FROM job_comments c
    LEFT JOIN users u ON u.id=c.user_id WHERE c.workspace_id=? AND c.job_id=? ORDER BY c.created_at,c.rowid`,
      )
      .all(user.workspaceId, id)
      .map((row) => ({
        id: row.id,
        body: row.body,
        revision: row.revision,
        author: author(row),
        mine: row.user_id === user.id,
        createdAt: new Date(Number(row.created_at)).toISOString(),
        updatedAt: new Date(Number(row.updated_at)).toISOString(),
      }));
  const checks = (user: User, id: string, current: string) =>
    db
      .prepare(
        `SELECT c.*, u.name AS author_name, m.status AS member_status
    FROM job_review_checks c LEFT JOIN users u ON u.id=c.user_id
    LEFT JOIN memberships m ON m.user_id=c.user_id AND m.workspace_id=c.workspace_id
    WHERE c.workspace_id=? AND c.job_id=? ORDER BY c.updated_at DESC,c.user_id`,
      )
      .all(user.workspaceId, id)
      .map((row) => ({
        author: author(row),
        mine: row.user_id === user.id,
        revision: row.revision,
        reviewed: Boolean(row.reviewed),
        current:
          Boolean(row.reviewed) &&
          row.fingerprint === current &&
          row.member_status === "active",
        memberActive: row.member_status === "active",
        updatedAt: new Date(Number(row.updated_at)).toISOString(),
      }));
  const summary = (user: User, item: Resource) => ({
    id: item.id,
    commentCount: Number(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM job_comments WHERE workspace_id=? AND job_id=?",
        )
        .get(user.workspaceId, item.id)!.count,
    ),
    reviewedCount: checks(user, item.id, fingerprint(item)).filter(
      (check) => check.current,
    ).length,
  });
  app.post(
    "/api/job-collaboration/summary",
    route((req, res) => {
      const user = auth(req),
        input = z
          .object({ ids: z.array(z.uuid()).max(200) })
          .strict()
          .parse(req.body);
      res.json({
        items: [...new Set(input.ids)].flatMap((id) => {
          const item = store.get(user.workspaceId, "jobs", id);
          return item ? [summary(user, item)] : [];
        }),
      });
    }),
  );
  app.get(
    "/api/jobs/:jobId/collaboration",
    route((req, res) => {
      const user = auth(req),
        item = job(user, req.params.jobId),
        current = fingerprint(item);
      const history = db
        .prepare(
          `SELECT h.*,u.name AS author_name FROM job_review_history h
      LEFT JOIN users u ON u.id=h.user_id WHERE h.workspace_id=? AND h.job_id=? ORDER BY h.created_at DESC,h.rowid DESC LIMIT 200`,
        )
        .all(user.workspaceId, item.id)
        .map((row) => ({
          id: row.id,
          author: author(row),
          reviewed: Boolean(row.reviewed),
          currentVersion: row.fingerprint === current,
          createdAt: new Date(Number(row.created_at)).toISOString(),
        }));
      res.json({
        fingerprint: current,
        snapshot: snapshot(item),
        comments: comments(user, item.id),
        checks: checks(user, item.id, current),
        history,
        limits: { comments: 200, commentCharacters: 4000, history: 200 },
        ...summary(user, item),
      });
    }),
  );
  app.post(
    "/api/jobs/:jobId/comments",
    route((req, res) => {
      const user = auth(req),
        item = job(user, req.params.jobId),
        input = z.object({ body: textSchema }).strict().parse(req.body);
      const now = Date.now(),
        id = randomUUID();
      store.transaction(() => {
        const count = db
          .prepare(
            "SELECT COUNT(*) AS count FROM job_comments WHERE workspace_id=? AND job_id=?",
          )
          .get(user.workspaceId, item.id)!;
        const workspace = db
          .prepare(
            "SELECT COUNT(*) AS count FROM job_comments WHERE workspace_id=?",
          )
          .get(user.workspaceId)!;
        if (Number(count.count) >= 200 || Number(workspace.count) >= 20000)
          fail(
            409,
            "Comment storage is full. Remove an old comment before adding another.",
          );
        budget(user, "comment");
        db.prepare(
          "INSERT INTO job_comments(id,workspace_id,job_id,user_id,body,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
        ).run(id, user.workspaceId, item.id, user.id, input.body, now, now);
      });
      res.status(201).json({ id });
    }),
  );
  const ownComment = (user: User, jobId: string, id: unknown) => {
    const row = db
      .prepare(
        "SELECT * FROM job_comments WHERE id=? AND workspace_id=? AND job_id=?",
      )
      .get(z.uuid().parse(id), user.workspaceId, jobId);
    if (!row || row.user_id !== user.id)
      fail(404, "Your comment was not found.");
    return row!;
  };
  app.patch(
    "/api/jobs/:jobId/comments/:id",
    route((req, res) => {
      const user = auth(req),
        item = job(user, req.params.jobId),
        input = z
          .object({ body: textSchema, revision: revisionSchema })
          .strict()
          .parse(req.body);
      const comment = ownComment(user, item.id, req.params.id);
      const result = db
        .prepare(
          "UPDATE job_comments SET body=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?",
        )
        .run(input.body, Date.now(), String(comment.id), input.revision);
      if (!result.changes)
        fail(
          409,
          "This comment changed. Refresh the discussion before editing it.",
        );
      res.json({ ok: true });
    }),
  );
  app.delete(
    "/api/jobs/:jobId/comments/:id",
    route((req, res) => {
      const user = auth(req),
        item = job(user, req.params.jobId),
        input = z.object({ revision: revisionSchema }).strict().parse(req.body);
      const comment = ownComment(user, item.id, req.params.id);
      const result = db
        .prepare("DELETE FROM job_comments WHERE id=? AND revision=?")
        .run(String(comment.id), input.revision);
      if (!result.changes)
        fail(
          409,
          "This comment changed. Refresh the discussion before deleting it.",
        );
      res.json({ ok: true });
    }),
  );
  app.post(
    "/api/jobs/:jobId/review",
    route((req, res) => {
      const user = auth(req),
        item = job(user, req.params.jobId),
        input = z
          .object({
            fingerprint: fingerprintSchema,
            revision: revisionSchema,
            reviewed: z.boolean(),
          })
          .strict()
          .parse(req.body);
      const current = fingerprint(item);
      if (input.fingerprint !== current)
        fail(
          409,
          "This job changed. Reopen its latest preview before marking it reviewed.",
        );
      store.transaction(() => {
        const previous = db
          .prepare(
            "SELECT * FROM job_review_checks WHERE workspace_id=? AND job_id=? AND user_id=?",
          )
          .get(user.workspaceId, item.id, user.id);
        if (Number(previous?.revision || 0) !== input.revision)
          fail(
            409,
            "Your review check changed. Refresh the discussion before updating it.",
          );
        budget(user, "review");
        const now = Date.now();
        db.prepare(
          `INSERT INTO job_review_checks(workspace_id,job_id,user_id,fingerprint,reviewed,revision,updated_at) VALUES(?,?,?,?,?,1,?)
        ON CONFLICT(workspace_id,job_id,user_id) DO UPDATE SET fingerprint=excluded.fingerprint,reviewed=excluded.reviewed,revision=job_review_checks.revision+1,updated_at=excluded.updated_at`,
        ).run(
          user.workspaceId,
          item.id,
          user.id,
          current,
          Number(input.reviewed),
          now,
        );
        db.prepare("INSERT INTO job_review_history VALUES(?,?,?,?,?,?,?)").run(
          randomUUID(),
          user.workspaceId,
          item.id,
          user.id,
          current,
          Number(input.reviewed),
          now,
        );
        db.prepare(
          `DELETE FROM job_review_history WHERE workspace_id=? AND job_id=? AND id NOT IN
        (SELECT id FROM job_review_history WHERE workspace_id=? AND job_id=? ORDER BY created_at DESC,rowid DESC LIMIT 200)`,
        ).run(user.workspaceId, item.id, user.workspaceId, item.id);
      });
      res.json({ ok: true });
    }),
  );
}
