import type { Express, NextFunction, Request, Response } from "express";
import { z } from "zod";
import { sessionUser } from "./auth.js";
import type { Store } from "./db.js";

const update = z
  .object({
    revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    status: z.enum(["unreviewed", "reviewed", "progressed", "rejected"]),
    notes: z.string().trim().max(10_000),
  })
  .strict();

/** Human review state is shared with the hiring team, never exposed on candidate links. */
export function registerScreeningReviews(app: Express, store: Store) {
  const db = store.db;
  db.exec(`CREATE TABLE IF NOT EXISTS screening_response_reviews (
    response_id TEXT PRIMARY KEY REFERENCES screening_responses(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    status TEXT NOT NULL, notes TEXT NOT NULL, revision INTEGER NOT NULL,
    reviewer_id TEXT REFERENCES users(id) ON DELETE SET NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS screening_review_workspace ON screening_response_reviews(workspace_id);`);
  const route =
    (handler: (req: Request, res: Response) => void) =>
    (req: Request, res: Response, next: NextFunction) => {
      try {
        handler(req, res);
      } catch (error) {
        if (error instanceof z.ZodError)
          res
            .status(400)
            .json({ error: error.issues[0]?.message || "Invalid review." });
        else next(error);
      }
    };
  const authorize = (req: Request, res: Response) => {
    const user = sessionUser(store, req);
    if (!user) {
      res.status(401).json({ error: "Sign in to review candidates." });
      return;
    }
    const screening = store.get(
      user.workspaceId,
      "screenings",
      String(req.params.id),
    );
    if (!screening) {
      res.status(404).json({ error: "Screening not found." });
      return;
    }
    return { user, screening };
  };
  const serialize = (row: Record<string, unknown>) => ({
    responseId: row.response_id,
    status: row.status,
    notes: row.notes,
    revision: row.revision,
    updatedAt: row.updated_at,
    reviewer: {
      id: row.reviewer_id,
      name: row.reviewer_name || "Former member",
    },
  });
  app.get(
    "/api/screenings/:id/reviews",
    route((req, res) => {
      const auth = authorize(req, res);
      if (!auth) return;
      const rows = db
        .prepare(
          `SELECT v.*, u.name AS reviewer_name
      FROM screening_response_reviews v JOIN screening_responses r ON r.id=v.response_id AND r.workspace_id=v.workspace_id
      LEFT JOIN users u ON u.id=v.reviewer_id WHERE r.screening_id=? AND v.workspace_id=?
      ORDER BY v.updated_at DESC`,
        )
        .all(auth.screening.id, auth.user.workspaceId);
      res.json({ items: rows.map(serialize) });
    }),
  );
  app.patch(
    "/api/screenings/:id/responses/:responseId/review",
    route((req, res) => {
      const auth = authorize(req, res);
      if (!auth) return;
      const input = update.parse(req.body);
      const responseId = z.uuid().parse(req.params.responseId);
      const response = db
        .prepare(
          "SELECT id FROM screening_responses WHERE id=? AND screening_id=? AND workspace_id=?",
        )
        .get(responseId, auth.screening.id, auth.user.workspaceId);
      if (!response) {
        res.status(404).json({ error: "Candidate response not found." });
        return;
      }
      const previous = db
        .prepare(
          "SELECT revision FROM screening_response_reviews WHERE response_id=? AND workspace_id=?",
        )
        .get(responseId, auth.user.workspaceId);
      if (Number(previous?.revision || 0) !== input.revision) {
        res.status(409).json({
          error:
            "Another teammate updated this review. Refresh to see their changes before saving again.",
        });
        return;
      }
      const updatedAt = new Date().toISOString();
      db.prepare(
        `INSERT INTO screening_response_reviews(response_id,workspace_id,status,notes,revision,reviewer_id,updated_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(response_id) DO UPDATE SET status=excluded.status,notes=excluded.notes,
      revision=excluded.revision,reviewer_id=excluded.reviewer_id,updated_at=excluded.updated_at`,
      ).run(
        responseId,
        auth.user.workspaceId,
        input.status,
        input.notes,
        input.revision + 1,
        auth.user.id,
        updatedAt,
      );
      res.json({
        item: {
          responseId,
          status: input.status,
          notes: input.notes,
          revision: input.revision + 1,
          updatedAt,
          reviewer: { id: auth.user.id, name: auth.user.name },
        },
      });
    }),
  );
}
