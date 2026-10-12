import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { Express, Request, Response, NextFunction } from "express";
import multer from "multer";
import { z } from "zod";
import { hashToken, sessionUser, userById, type User } from "./auth.js";
import { initializeAccess, mayReadConversation } from "./access.js";
import type { Store } from "./db.js";
import {
  DOCUMENT_MIME_TYPES,
  DocumentExtractionError,
  extractDocument,
} from "./documents.js";

export class JobSourceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const fail = (status: number, message: string): never => {
  throw new JobSourceError(status, message);
};
export const jobSourceReference = z
  .object({
    kind: z.enum(["template", "conversation", "document"]),
    id: z.string().min(1).max(100),
    fingerprint: z.string().length(64),
  })
  .strict();
export type JobSourceReference = z.infer<typeof jobSourceReference>;
type Source = JobSourceReference & {
  title: string;
  text: string;
  characters: number;
};
const templates = [
  {
    id: "standard",
    title: "Standard job description",
    description: "A clear structure for any role.",
    text: "About the role\n[Describe the purpose of this role and the team.]\n\nWhat you will do\n[Add the responsibilities and outcomes.]\n\nWhat you will bring\n[Add the skills and experience necessary for this role.]\n\nWorking together\n[Confirm the location, working arrangement and employment type.]\n\nCompensation and benefits\n[Include only confirmed compensation and benefits.]\n\nHow to apply\n[Explain the application process and next steps.]",
  },
  {
    id: "engineering",
    title: "Engineering role",
    description: "Responsibilities, technical scope and collaboration.",
    text: "About the team\n[Describe the product and engineering team.]\n\nThe work\n[Explain the systems, technical challenges and expected outcomes.]\n\nResponsibilities\n[Describe ownership, delivery and collaboration.]\n\nSkills and experience\n[List the essential technical experience. Separate optional experience.]\n\nWorking arrangement\n[Confirm location, schedule and employment type.]\n\nCompensation and benefits\n[Add confirmed details.]\n\nInterview process\n[Describe the planned stages.]",
  },
  {
    id: "commercial",
    title: "Commercial role",
    description: "Customer focus, responsibilities and success measures.",
    text: "About the opportunity\n[Describe the team and its customers.]\n\nWhat success looks like\n[State the outcomes expected of this role.]\n\nResponsibilities\n[Add the day-to-day work and collaboration.]\n\nSkills and experience\n[Describe the relevant experience without unnecessary requirements.]\n\nWorking arrangement\n[Confirm location, travel and employment type.]\n\nCompensation and benefits\n[Include only confirmed base pay, variable pay and benefits.]\n\nHow to apply\n[Explain the process.]",
  },
];
const sourceView = (
  kind: Source["kind"],
  id: string,
  title: string,
  text: string,
  revision: unknown,
): Source => ({
  kind,
  id,
  title,
  text,
  characters: text.length,
  fingerprint: hashToken(JSON.stringify(revision)),
});
export function initializeJobSources(store: Store) {
  initializeAccess(store);
  store.db.exec(`CREATE TABLE IF NOT EXISTS job_source_documents (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL, text TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS job_source_documents_owner ON job_source_documents(workspace_id,user_id,created_at);
    CREATE TABLE IF NOT EXISTS job_source_attempts(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS job_source_attempts_budget ON job_source_attempts(workspace_id,created_at);`);
}
export function resolveJobSource(
  store: Store,
  original: User,
  reference: JobSourceReference,
): Source {
  const user =
    userById(store, original.id, original.workspaceId) ||
    fail(403, "Workspace access is no longer available.");
  if (user.role !== original.role)
    fail(409, "Workspace permissions changed. Reload before continuing.");
  let source: Source;
  if (reference.kind === "template") {
    const template =
      templates.find((t) => t.id === reference.id) ||
      fail(404, "Template not found.");
    source = sourceView(
      "template",
      template.id,
      template.title,
      template.text,
      template,
    );
  } else if (reference.kind === "conversation") {
    if (!mayReadConversation(store, user, reference.id))
      fail(404, "The intake conversation is no longer available.");
    const item = store.get(user.workspaceId, "conversations", reference.id)!;
    if (
      item.archived ||
      typeof item.transcript !== "string" ||
      !item.transcript.trim()
    )
      fail(404, "The intake conversation is no longer available.");
    source = sourceView(
      "conversation",
      item.id,
      String(item.title || "Intake conversation").slice(0, 200),
      item.transcript as string,
      item,
    );
  } else {
    const row = store.db
      .prepare(
        "SELECT * FROM job_source_documents WHERE id=? AND workspace_id=? AND user_id=?",
      )
      .get(reference.id, user.workspaceId, user.id);
    if (!row) fail(404, "The uploaded job document is no longer available.");
    source = sourceView(
      "document",
      String(row!.id),
      String(row!.title),
      String(row!.text),
      row!,
    );
  }
  if (source.text.length > 60_000)
    fail(
      413,
      "Job sources support up to 60,000 characters. Choose a shorter intake or document.",
    );
  if (source.fingerprint !== reference.fingerprint)
    fail(
      409,
      "This source changed. Select and review it again before drafting.",
    );
  return source;
}
const route =
  (handler: (req: Request, res: Response) => unknown) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve()
      .then(() => handler(req, res))
      .catch((error: unknown) => {
        if (
          error instanceof JobSourceError ||
          error instanceof DocumentExtractionError
        )
          res.status(error.status).json({ error: error.message });
        else if (error instanceof z.ZodError)
          res
            .status(400)
            .json({ error: error.issues[0]?.message || "Invalid source." });
        else next(error);
      });
  };
export function registerJobSources(app: Express, store: Store) {
  initializeJobSources(store);
  const auth = (req: Request) =>
    sessionUser(store, req) || fail(401, "Please sign in to continue.");
  const directory = resolve(store.dataDir, "job-source-uploads");
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
        callback(new JobSourceError(415, "Upload a PDF or DOCX job document."));
    },
  }).single("file");
  app.get(
    "/api/job-sources/templates",
    route((_req, res) => {
      auth(_req);
      res.json({
        items: templates.map((template) => ({
          ...sourceView(
            "template",
            template.id,
            template.title,
            template.text,
            template,
          ),
          description: template.description,
        })),
      });
    }),
  );
  app.get(
    "/api/job-sources/conversations",
    route((req, res) => {
      const user = auth(req);
      const items = store.db
        .prepare(
          "SELECT id FROM resources WHERE workspace_id=? AND kind='conversations' ORDER BY updated_at DESC LIMIT 500",
        )
        .all(user.workspaceId)
        .flatMap((row) => {
          const id = String(row.id);
          if (!mayReadConversation(store, user, id)) return [];
          const item = store.get(user.workspaceId, "conversations", id)!;
          if (
            item.archived ||
            typeof item.transcript !== "string" ||
            !item.transcript.trim()
          )
            return [];
          return [
            {
              id,
              title: String(item.title || "Intake conversation").slice(0, 200),
              date: item.date || item.createdAt,
              characters: item.transcript.length,
              eligible: item.transcript.length <= 60000,
            },
          ];
        });
      res.json({ items });
    }),
  );
  app.get(
    "/api/job-sources/conversations/:id",
    route((req, res) => {
      const user = auth(req),
        id = z.uuid().parse(req.params.id);
      if (!mayReadConversation(store, user, id))
        fail(404, "Intake conversation not found.");
      const item = store.get(user.workspaceId, "conversations", id)!;
      if (
        item.archived ||
        typeof item.transcript !== "string" ||
        !item.transcript.trim()
      )
        fail(404, "Intake conversation not found.");
      const source = sourceView(
        "conversation",
        id,
        String(item.title || "Intake conversation").slice(0, 200),
        String(item.transcript),
        item,
      );
      res.json({ item: resolveJobSource(store, user, source) });
    }),
  );
  app.get(
    "/api/job-sources/documents",
    route((req, res) => {
      const user = auth(req);
      res.json({
        items: store.db
          .prepare(
            "SELECT * FROM job_source_documents WHERE workspace_id=? AND user_id=? ORDER BY created_at DESC LIMIT 30",
          )
          .all(user.workspaceId, user.id)
          .map((row) => ({
            ...sourceView(
              "document",
              String(row.id),
              String(row.title),
              String(row.text),
              row,
            ),
            createdAt: new Date(Number(row.created_at)).toISOString(),
          })),
      });
    }),
  );
  app.post("/api/job-sources/documents", (req, res, next) => {
    let original: User;
    try {
      original = auth(req);
      const count = Number(
        store.db
          .prepare(
            "SELECT count(*) AS n FROM job_source_documents WHERE workspace_id=? AND user_id=?",
          )
          .get(original.workspaceId, original.id)!.n,
      );
      if (count >= 30)
        fail(
          400,
          "Delete an uploaded job document before adding another. The private library supports 30 documents.",
        );
      const now = Date.now();
      const attempts = Number(
        store.db
          .prepare(
            "SELECT count(*) AS n FROM job_source_attempts WHERE workspace_id=? AND created_at>?",
          )
          .get(original.workspaceId, now - 3600000)!.n,
      );
      if (attempts >= 20)
        fail(429, "This workspace reached its hourly document upload limit.");
      store.db
        .prepare("INSERT INTO job_source_attempts VALUES(?,?,?)")
        .run(randomUUID(), original.workspaceId, now);
      store.db
        .prepare("DELETE FROM job_source_attempts WHERE created_at<?")
        .run(now - 86400000);
    } catch (error) {
      if (error instanceof JobSourceError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      next(error);
      return;
    }
    upload(req, res, (error) => {
      if (error) {
        if (req.file) rmSync(req.file.path, { force: true });
        if (error instanceof multer.MulterError)
          res.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
            error:
              error.code === "LIMIT_FILE_SIZE"
                ? "Job documents must be 10 MB or smaller."
                : "Upload one PDF or DOCX file.",
          });
        else if (error instanceof JobSourceError)
          res.status(error.status).json({ error: error.message });
        else next(error);
        return;
      }
      void route(async (req, res) => {
        const file =
          req.file || fail(400, "Choose a PDF or DOCX job document.");
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
              "Job sources support up to 60,000 characters. Split the document into shorter sources.",
            );
          // Recheck retention after asynchronous extraction, before storing any source text.
          const retained = Number(
            store.db
              .prepare(
                "SELECT count(*) AS n FROM job_source_documents WHERE workspace_id=? AND user_id=?",
              )
              .get(current.workspaceId, current.id)!.n,
          );
          if (retained >= 30)
            fail(400, "Delete an uploaded job document before adding another.");
          const id = randomUUID();
          store.db
            .prepare("INSERT INTO job_source_documents VALUES(?,?,?,?,?,?,?,?)")
            .run(
              id,
              current.workspaceId,
              current.id,
              basename(file.originalname).slice(0, 200),
              extraction.text,
              extraction.type,
              file.size,
              Date.now(),
            );
          const row = store.db
            .prepare("SELECT * FROM job_source_documents WHERE id=?")
            .get(id)!;
          res.status(201).json({
            item: sourceView(
              "document",
              id,
              String(row.title),
              String(row.text),
              row,
            ),
          });
        } finally {
          rmSync(file.path, { force: true });
        }
      })(req, res, next);
    });
  });
  app.delete(
    "/api/job-sources/documents/:id",
    route((req, res) => {
      const user = auth(req),
        id = z.uuid().parse(req.params.id);
      const result = store.db
        .prepare(
          "DELETE FROM job_source_documents WHERE id=? AND workspace_id=? AND user_id=?",
        )
        .run(id, user.workspaceId, user.id);
      if (!result.changes) fail(404, "Uploaded job document not found.");
      res.json({ ok: true });
    }),
  );
}
