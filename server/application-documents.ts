import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { Express, Request, Response, NextFunction } from "express";
import multer from "multer";
import { z } from "zod";
import { hashToken, sessionUser, userById, type User } from "./auth.js";
import type { Store } from "./db.js";
import {
  DOCUMENT_MIME_TYPES,
  DocumentExtractionError,
  extractDocument,
} from "./documents.js";

export class ApplicationDocumentError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const fail = (status: number, message: string): never => {
  throw new ApplicationDocumentError(status, message);
};
export const applicationDocumentReference = z
  .object({ id: z.uuid(), fingerprint: z.string().length(64) })
  .strict();
export type ApplicationDocumentReference = z.infer<
  typeof applicationDocumentReference
>;
type DocumentRow = {
  id: string;
  workspace_id: string;
  user_id: string;
  application_id: string;
  title: string;
  text: string;
  type: string;
  size: number;
  created_at: number;
};
const present = (row: DocumentRow) => ({
  id: row.id,
  title: row.title,
  text: row.text,
  type: row.type,
  size: row.size,
  characters: row.text.length,
  createdAt: new Date(row.created_at).toISOString(),
  fingerprint: hashToken(JSON.stringify(row)),
});

export function initializeApplicationDocuments(store: Store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS application_documents (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    application_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
    title TEXT NOT NULL, text TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS application_documents_owner ON application_documents(workspace_id,user_id,application_id,created_at);
    CREATE TABLE IF NOT EXISTS application_document_attempts(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS application_document_attempts_budget ON application_document_attempts(workspace_id,created_at);`);
}
function application(store: Store, user: User, id: string) {
  if (!["owner", "admin", "member"].includes(user.role))
    fail(403, "Workspace membership is required.");
  return (
    store.get(user.workspaceId, "applications", id) ||
    fail(404, "Application not found.")
  );
}
export function resolveApplicationDocument(
  store: Store,
  original: User,
  applicationId: string,
  reference: ApplicationDocumentReference,
) {
  const user =
    userById(store, original.id, original.workspaceId) ||
    fail(403, "Workspace access is no longer available.");
  if (user.role !== original.role)
    fail(409, "Workspace permissions changed. Reload before continuing.");
  application(store, user, applicationId);
  const row = store.db
    .prepare(
      "SELECT * FROM application_documents WHERE id=? AND workspace_id=? AND user_id=? AND application_id=?",
    )
    .get(reference.id, user.workspaceId, user.id, applicationId) as
    DocumentRow | undefined;
  if (!row) return fail(404, "A selected CV is no longer available.");
  const source = present(row);
  if (source.fingerprint !== reference.fingerprint)
    fail(409, "A selected CV changed. Review and select it again.");
  return source;
}
const route =
  (handler: (req: Request, res: Response) => unknown) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve()
      .then(() => handler(req, res))
      .catch((error: unknown) => {
        if (
          error instanceof ApplicationDocumentError ||
          error instanceof DocumentExtractionError
        )
          res.status(error.status).json({ error: error.message });
        else if (error instanceof z.ZodError)
          res
            .status(400)
            .json({ error: error.issues[0]?.message || "Invalid CV request." });
        else next(error);
      });
  };

export function registerApplicationDocuments(app: Express, store: Store) {
  initializeApplicationDocuments(store);
  const auth = (req: Request) => {
    const user =
      sessionUser(store, req) || fail(401, "Please sign in to continue.");
    application(store, user, String(req.params.id));
    return user;
  };
  const directory = resolve(store.dataDir, "application-document-uploads");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const upload = multer({
    storage: multer.diskStorage({
      destination: directory,
      filename: (_req, _file, callback) => callback(null, randomUUID()),
    }),
    limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 0, parts: 1 },
    fileFilter: (_req, file, callback) => {
      if (DOCUMENT_MIME_TYPES.includes(file.mimetype)) callback(null, true);
      else
        callback(new ApplicationDocumentError(415, "Upload a PDF or DOCX CV."));
    },
  }).single("file");
  function retention(user: User, applicationId: string) {
    const counts = store.db
      .prepare(
        "SELECT count(*) AS total,SUM(CASE WHEN application_id=? THEN 1 ELSE 0 END) AS per_application FROM application_documents WHERE workspace_id=? AND user_id=?",
      )
      .get(applicationId, user.workspaceId, user.id)!;
    if (Number(counts.total) >= 50 || Number(counts.per_application) >= 5)
      fail(
        400,
        "Delete a private CV before adding another. Keep up to 5 per application and 50 across your workspace.",
      );
  }
  const path = "/api/applications/:id/documents";
  app.get(
    path,
    route((req, res) => {
      const user = auth(req);
      const rows = store.db
        .prepare(
          "SELECT * FROM application_documents WHERE workspace_id=? AND user_id=? AND application_id=? ORDER BY created_at DESC",
        )
        .all(user.workspaceId, user.id, String(req.params.id)) as DocumentRow[];
      res.json({
        items: rows.map((row) => {
          const { text: _text, ...metadata } = present(row);
          return metadata;
        }),
      });
    }),
  );
  app.get(
    `${path}/:documentId`,
    route((req, res) => {
      const user = auth(req),
        id = z.uuid().parse(req.params.documentId);
      const row = store.db
        .prepare(
          "SELECT * FROM application_documents WHERE id=? AND workspace_id=? AND user_id=? AND application_id=?",
        )
        .get(id, user.workspaceId, user.id, String(req.params.id)) as
        DocumentRow | undefined;
      if (!row) return fail(404, "CV not found.");
      res.json({ item: present(row) });
    }),
  );
  app.post(path, (req, res, next) => {
    let original: User;
    try {
      original = auth(req);
      retention(original, String(req.params.id));
      const now = Date.now();
      const attempts = Number(
        store.db
          .prepare(
            "SELECT count(*) AS n FROM application_document_attempts WHERE workspace_id=? AND created_at>?",
          )
          .get(original.workspaceId, now - 3600000)!.n,
      );
      if (attempts >= 20)
        fail(429, "This workspace reached its hourly CV upload limit.");
      store.db
        .prepare("INSERT INTO application_document_attempts VALUES(?,?,?)")
        .run(randomUUID(), original.workspaceId, now);
      store.db
        .prepare("DELETE FROM application_document_attempts WHERE created_at<?")
        .run(now - 86400000);
    } catch (error) {
      if (error instanceof ApplicationDocumentError)
        res.status(error.status).json({ error: error.message });
      else next(error);
      return;
    }
    upload(req, res, (error) => {
      if (error) {
        if (req.file) rmSync(req.file.path, { force: true });
        if (error instanceof multer.MulterError)
          res.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
            error:
              error.code === "LIMIT_FILE_SIZE"
                ? "CVs must be 10 MB or smaller."
                : "Upload one PDF or DOCX CV.",
          });
        else if (error instanceof ApplicationDocumentError)
          res.status(error.status).json({ error: error.message });
        else next(error);
        return;
      }
      void route(async (req, res) => {
        const file = req.file || fail(400, "Choose a PDF or DOCX CV.");
        try {
          chmodSync(file.path, 0o600);
          const extraction = await extractDocument(file.path, file.mimetype);
          const current = auth(req);
          if (
            current.id !== original.id ||
            current.workspaceId !== original.workspaceId ||
            current.role !== original.role
          )
            fail(409, "Your workspace or permissions changed during upload.");
          if (req.aborted || res.destroyed) fail(409, "Upload was cancelled.");
          if (extraction.text.length > 60000)
            fail(
              413,
              "CV evidence supports up to 60,000 characters. Upload a shorter document.",
            );
          retention(current, String(req.params.id));
          const id = randomUUID();
          store.db
            .prepare(
              "INSERT INTO application_documents VALUES(?,?,?,?,?,?,?,?,?)",
            )
            .run(
              id,
              current.workspaceId,
              current.id,
              String(req.params.id),
              basename(file.originalname.replaceAll("\\", "/")).slice(0, 200),
              extraction.text,
              extraction.type,
              file.size,
              Date.now(),
            );
          const row = store.db
            .prepare("SELECT * FROM application_documents WHERE id=?")
            .get(id) as DocumentRow;
          res.status(201).json({ item: present(row) });
        } finally {
          rmSync(file.path, { force: true });
        }
      })(req, res, next);
    });
  });
  app.delete(
    `${path}/:documentId`,
    route((req, res) => {
      const user = auth(req),
        id = z.uuid().parse(req.params.documentId);
      const result = store.db
        .prepare(
          "DELETE FROM application_documents WHERE id=? AND workspace_id=? AND user_id=? AND application_id=?",
        )
        .run(id, user.workspaceId, user.id, String(req.params.id));
      if (!result.changes) fail(404, "CV not found.");
      res.json({ ok: true });
    }),
  );
}
