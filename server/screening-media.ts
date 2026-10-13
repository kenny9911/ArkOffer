import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Express, NextFunction, Request, Response } from "express";
import { z } from "zod";
import {
  getSessionToken,
  hashToken,
  isWorkspaceAdmin,
  userById,
  type User,
} from "./auth.js";
import type { Store } from "./db.js";
import type { Recording } from "./screening-recordings.js";
import {
  alignTranscriptWords,
  createScreeningMediaProcessor,
} from "./screening-media-processor.js";

export type ScreeningMediaProcessor = ReturnType<
  typeof createScreeningMediaProcessor
>;
type Turn = {
  id: string;
  text: string;
  startSeconds: number | null;
  endSeconds: number | null;
};
type Segment = { startSeconds: number; endSeconds: number; muted: boolean };
type Edit = {
  id: string;
  recording_id: string;
  title: string;
  revision: number;
  segments: string;
  created_at: number;
  updated_at: number;
};
type Job = {
  id: string;
  recording_id: string;
  workspace_id: string;
  author_id: string;
  session_hash: string;
  screening_id: string;
  response_id: string;
  kind: "alignment" | "export";
  edit_id: string | null;
  edit_revision: number | null;
  edit_title: string | null;
  payload: string;
  fingerprint: string;
  request_key: string;
  request_hash: string;
  state: string;
  error: string | null;
  result: string | null;
  created_at: number;
  updated_at: number;
};
type Dependencies = {
  env: NodeJS.ProcessEnv;
  now: () => number;
  processor?: ScreeningMediaProcessor;
  authorize(req: Request): { user: User; rows: Recording[] };
  rowsFor(user: User, screeningId: string, responseId: string): Recording[];
  transcript(row: Recording): Turn[];
  read(
    row: Recording,
    signal: AbortSignal,
  ): Promise<{ body: Readable; length?: number }>;
};
const MAX_BYTES = 250 * 1024 * 1024;
const uuid = z.uuid();
const editSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    segments: z
      .array(
        z
          .object({
            startSeconds: z.number().finite().min(0),
            endSeconds: z.number().finite().positive(),
            muted: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(12),
  })
  .strict();
class MediaError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
function fail(status: number, message: string): never {
  throw new MediaError(status, message);
}
const route =
  (handler: (req: Request, res: Response) => unknown) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve()
      .then(() => handler(req, res))
      .catch((error) => {
        if (res.headersSent) return res.destroy();
        if (error instanceof MediaError)
          res.status(error.status).json({ error: error.message });
        else if (error instanceof z.ZodError)
          res
            .status(400)
            .json({ error: "Check the media edit fields and try again." });
        else next(error);
      });
  };
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const publicEdit = (row: Edit) => ({
  id: row.id,
  title: row.title,
  revision: row.revision,
  segments: JSON.parse(row.segments) as Segment[],
  createdAt: new Date(row.created_at).toISOString(),
  updatedAt: new Date(row.updated_at).toISOString(),
});
const publicJob = (row: Job) => ({
  id: row.id,
  kind: row.kind,
  editId: row.edit_id,
  editTitle: row.edit_title,
  editRevision: row.edit_revision,
  state: row.state,
  error: row.error,
  createdAt: new Date(row.created_at).toISOString(),
});

/** Derived media stays private and inherits its original recording's authority and lifetime. */
export function registerScreeningMedia(
  app: Express,
  store: Store,
  deps: Dependencies,
) {
  const { now } = deps;
  const processor = deps.processor || createScreeningMediaProcessor(deps.env);
  const root = join(store.dataDir, "screening-media");
  const directory = (id: string) => join(root, uuid.parse(id));
  store.db.exec(`CREATE TABLE IF NOT EXISTS screening_media_edits (
    id TEXT PRIMARY KEY, recording_id TEXT NOT NULL REFERENCES screening_recordings(id) ON DELETE CASCADE,
    title TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, segments TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS screening_media_jobs (
    id TEXT PRIMARY KEY, recording_id TEXT NOT NULL REFERENCES screening_recordings(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL, author_id TEXT NOT NULL, session_hash TEXT NOT NULL,
    screening_id TEXT NOT NULL, response_id TEXT NOT NULL, kind TEXT NOT NULL, edit_id TEXT,
    edit_revision INTEGER, edit_title TEXT, payload TEXT NOT NULL, fingerprint TEXT NOT NULL,
    request_key TEXT NOT NULL, request_hash TEXT NOT NULL, state TEXT NOT NULL,
    error TEXT, result TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE(recording_id,request_key)
  );
  CREATE INDEX IF NOT EXISTS screening_media_pending ON screening_media_jobs(state,created_at);
  CREATE TABLE IF NOT EXISTS screening_media_cleanup (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
  CREATE TRIGGER IF NOT EXISTS screening_media_job_deleted BEFORE DELETE ON screening_media_jobs BEGIN
    INSERT OR IGNORE INTO screening_media_cleanup(id,created_at) VALUES(OLD.id,unixepoch()*1000);
  END;
  CREATE TRIGGER IF NOT EXISTS screening_media_source_deleted AFTER UPDATE OF state ON screening_recordings
    WHEN NEW.state IN ('deleting','deleted') BEGIN
      DELETE FROM screening_media_edits WHERE recording_id=NEW.id;
      DELETE FROM screening_media_jobs WHERE recording_id=NEW.id;
  END;`);
  // A prior provider call may have succeeded: never automatically repeat uncertain paid work.
  store.transaction(() => {
    store.db.exec(`INSERT OR IGNORE INTO screening_media_cleanup(id,created_at)
      SELECT id,updated_at FROM screening_media_jobs WHERE state='processing';
      UPDATE screening_media_jobs SET state='failed',error='Processing was interrupted. Review the result and retry explicitly.' WHERE state='processing';`);
  });
  const getJob = (id: string) =>
    store.db
      .prepare("SELECT * FROM screening_media_jobs WHERE id=?")
      .get(id) as Job | undefined;
  const getEdit = (id: string) =>
    store.db
      .prepare("SELECT * FROM screening_media_edits WHERE id=?")
      .get(id) as Edit | undefined;
  const fingerprint = (row: Recording) =>
    digest({
      id: row.id,
      key: row.object_key,
      size: row.size,
      duration: row.duration,
      origin: row.media_started_at,
      turns: deps.transcript(row),
    });
  const playable = (row: Recording | undefined): row is Recording =>
    !!row && row.state === "ready" && row.expires_at > now();
  function access(req: Request, write = false) {
    let authorization: ReturnType<Dependencies["authorize"]>;
    try {
      authorization = deps.authorize(req);
    } catch (error) {
      const known = error as { status?: number; message?: string };
      if (known.status && [401, 403, 404].includes(known.status))
        return fail(
          known.status,
          known.message || "Recording access is unavailable.",
        );
      throw error;
    }
    const { user, rows } = authorization;
    const row = rows.find((item) => item.id === req.params.recordingId);
    if (!playable(row))
      return fail(404, "The original recording is unavailable or has expired.");
    if (write && !isWorkspaceAdmin(user))
      return fail(
        403,
        "Only workspace owners and admins can edit recordings or generate word timing.",
      );
    return { user, row };
  }
  function validSegments(segments: Segment[], row: Recording) {
    if (
      !Number.isFinite(row.duration) ||
      row.duration <= 0 ||
      row.duration > 1800 ||
      segments.some(
        (s) =>
          s.endSeconds > row.duration ||
          s.endSeconds - s.startSeconds < 0.1 - 1e-9,
      ) ||
      segments.reduce((sum, s) => sum + s.endSeconds - s.startSeconds, 0) >
        Math.min(1800, row.duration) + 1e-9
    )
      return fail(
        400,
        "Use clips of at least 0.1 seconds within the recording. Total edited duration cannot exceed the original or 30 minutes.",
      );
  }
  function freshJob(job: Job) {
    const stored = getJob(job.id);
    if (!stored || !["queued", "processing"].includes(stored.state))
      return undefined;
    const session = store.db
      .prepare(
        "SELECT user_id FROM sessions WHERE token_hash=? AND workspace_id=? AND expires_at>?",
      )
      .get(job.session_hash, job.workspace_id, Date.now());
    const user =
      session?.user_id === job.author_id
        ? userById(store, job.author_id, job.workspace_id)
        : undefined;
    if (!user || !isWorkspaceAdmin(user)) return undefined;
    try {
      const row = deps
        .rowsFor(user, job.screening_id, job.response_id)
        .find((item) => item.id === job.recording_id);
      return playable(row) && fingerprint(row) === job.fingerprint
        ? row
        : undefined;
    } catch {
      return undefined;
    }
  }
  function alignment(row: Recording) {
    const job = store.db
      .prepare(
        "SELECT * FROM screening_media_jobs WHERE recording_id=? AND kind='alignment' AND state='ready' AND fingerprint=? ORDER BY created_at DESC,id DESC LIMIT 1",
      )
      .get(row.id, fingerprint(row)) as Job | undefined;
    if (!job?.result) return null;
    return {
      jobId: job.id,
      ...(JSON.parse(job.result) as {
        model: string;
        matched: number;
        total: number;
        turns: ReturnType<typeof alignTranscriptWords>;
      }),
    };
  }
  const active = new Map<string, AbortController>();
  let running: Promise<void> | undefined,
    timer: ReturnType<typeof setInterval> | undefined,
    stopped = false;
  async function processJob(job: Job) {
    const source = freshJob(job);
    if (!source) {
      store.db
        .prepare(
          "UPDATE screening_media_jobs SET state='cancelled',error='Source access or processing authority changed.',updated_at=? WHERE id=? AND state='queued'",
        )
        .run(now(), job.id);
      return;
    }
    if (
      source.size <= 0 ||
      source.size > MAX_BYTES ||
      source.duration <= 0 ||
      source.duration > 1800
    ) {
      store.db
        .prepare(
          "UPDATE screening_media_jobs SET state='failed',error='Media processing supports recordings up to 250 MB and 30 minutes.',updated_at=? WHERE id=?",
        )
        .run(now(), job.id);
      return;
    }
    if (
      store.db
        .prepare(
          "UPDATE screening_media_jobs SET state='processing',updated_at=? WHERE id=? AND state='queued'",
        )
        .run(now(), job.id).changes !== 1
    )
      return;
    const controller = new AbortController();
    active.set(job.id, controller);
    const deadline = setTimeout(() => controller.abort(), 10 * 60_000);
    const monitor = setInterval(() => {
      if (!freshJob(job)) controller.abort();
    }, 250);
    deadline.unref();
    monitor.unref();
    const dir = directory(job.id),
      inputPath = join(dir, "source.mp4"),
      outputPath = join(dir, "clip.mp4");
    let keep = false;
    let body: Readable | undefined;
    try {
      const status = await processor.status(job.workspace_id);
      if (
        !(job.kind === "alignment"
          ? status.alignment.available
          : status.clipping.available)
      )
        throw new Error("capability");
      controller.signal.throwIfAborted();
      if (!freshJob(job)) throw new Error("authority");
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const media = await deps.read(source, controller.signal);
      body = media.body;
      if (
        media.length !== undefined &&
        (media.length <= 0 || media.length > MAX_BYTES)
      )
        throw new Error("size");
      let bytes = 0;
      const limit = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          callback(bytes > MAX_BYTES ? new Error("size") : null, chunk);
        },
      });
      await pipeline(
        media.body,
        limit,
        createWriteStream(inputPath, { flags: "wx", mode: 0o600 }),
        { signal: controller.signal },
      );
      if (!bytes || !freshJob(job)) throw new Error("authority");
      let result: unknown = null;
      if (job.kind === "alignment") {
        const output = await processor.align({
          inputPath,
          signal: controller.signal,
        });
        const turns = alignTranscriptWords(
          deps.transcript(source),
          output.words,
        );
        const tokens = turns.flatMap((turn) => turn.tokens);
        const matched = tokens.filter(
          (token) => token.startSeconds !== null,
        ).length;
        if (!matched) throw new Error("no-matches");
        result = {
          model: output.model,
          matched,
          total: tokens.filter((token) => /[\p{L}\p{N}]/u.test(token.text))
            .length,
          turns,
        };
      } else {
        const segments = JSON.parse(job.payload) as Segment[];
        validSegments(segments, source);
        await processor.export({
          inputPath,
          outputPath,
          segments,
          signal: controller.signal,
        });
        const file = await lstat(outputPath);
        if (
          !file.isFile() ||
          file.isSymbolicLink() ||
          file.size <= 0 ||
          file.size > MAX_BYTES
        )
          throw new Error("output-size");
        await chmod(outputPath, 0o600);
      }
      controller.signal.throwIfAborted();
      if (!freshJob(job)) throw new Error("authority");
      const saved = store.db
        .prepare(
          "UPDATE screening_media_jobs SET state='ready',result=?,error=NULL,updated_at=? WHERE id=? AND state='processing'",
        )
        .run(result ? JSON.stringify(result) : null, now(), job.id);
      keep = job.kind === "export" && saved.changes === 1;
    } catch (error) {
      const lost = !freshJob(job);
      store.db
        .prepare(
          "UPDATE screening_media_jobs SET state=?,error=?,updated_at=? WHERE id=? AND state='processing'",
        )
        .run(
          lost ? "cancelled" : "failed",
          lost
            ? "Source access or processing authority changed."
            : controller.signal.aborted
              ? "Processing timed out or was cancelled. Retry explicitly."
              : (error as Error).message === "no-matches"
                ? "No reliable word matches were found. The original transcript is unchanged."
                : "Media processing failed. Check media format, processing setup and provider access, then retry explicitly.",
          now(),
          job.id,
        );
    } finally {
      controller.abort();
      body?.destroy();
      clearTimeout(deadline);
      clearInterval(monitor);
      active.delete(job.id);
      // Retain a durable cleanup record until local removal succeeds.
      if (!keep)
        store.db
          .prepare(
            "INSERT OR IGNORE INTO screening_media_cleanup(id,created_at) VALUES(?,?)",
          )
          .run(job.id, now());
      if (keep) {
        try {
          await rm(inputPath, { force: true });
        } catch {
          store.db
            .prepare(
              "UPDATE screening_media_jobs SET state='failed',error='Private media cleanup is pending.',updated_at=? WHERE id=?",
            )
            .run(now(), job.id);
          store.db
            .prepare(
              "INSERT OR IGNORE INTO screening_media_cleanup(id,created_at) VALUES(?,?)",
            )
            .run(job.id, now());
        }
      }
    }
  }
  async function cleanup() {
    store.db
      .prepare(
        "DELETE FROM screening_media_edits WHERE recording_id IN (SELECT id FROM screening_recordings WHERE state IN ('deleting','deleted') OR expires_at<=?)",
      )
      .run(now());
    store.db
      .prepare(
        "DELETE FROM screening_media_jobs WHERE recording_id IN (SELECT id FROM screening_recordings WHERE state IN ('deleting','deleted') OR expires_at<=?)",
      )
      .run(now());
    const rows = store.db
      .prepare(
        "SELECT id FROM screening_media_cleanup ORDER BY created_at LIMIT 50",
      )
      .all();
    await Promise.allSettled(
      rows.map(async ({ id }) => {
        if (active.has(String(id))) return;
        await rm(directory(String(id)), { recursive: true, force: true });
        store.db
          .prepare("DELETE FROM screening_media_cleanup WHERE id=?")
          .run(id);
      }),
    );
  }
  function tick() {
    if (!running)
      running = (async () => {
        await cleanup();
        const job = !stopped
          ? (store.db
              .prepare(
                "SELECT * FROM screening_media_jobs WHERE state='queued' ORDER BY created_at,id LIMIT 1",
              )
              .get() as Job | undefined)
          : undefined;
        if (job) await processJob(job);
        await cleanup();
      })().finally(() => {
        running = undefined;
      });
    return running;
  }
  function jobFor(req: Request, row: Recording) {
    const job = getJob(String(req.params.jobId));
    if (!job || job.recording_id !== row.id)
      return fail(404, "Media job not found.");
    return job;
  }
  function editFor(req: Request, row: Recording) {
    const edit = getEdit(String(req.params.editId));
    if (!edit || edit.recording_id !== row.id)
      return fail(404, "Media edit not found.");
    return edit;
  }
  async function enqueue(
    req: Request,
    kind: Job["kind"],
    requestKey: string,
    edit?: Edit,
  ) {
    const { user, row } = access(req, true);
    const requestHash = digest({
      kind,
      editId: edit?.id,
      revision: edit?.revision,
    });
    const old = store.db
      .prepare(
        "SELECT * FROM screening_media_jobs WHERE recording_id=? AND request_key=?",
      )
      .get(row.id, requestKey) as Job | undefined;
    if (old) {
      if (old.request_hash !== requestHash)
        return fail(
          409,
          "This request key was already used for another media operation.",
        );
      return old;
    }
    const status = await processor.status(user.workspaceId);
    access(req, true);
    // Concurrent retries can pass the first lookup while capability detection awaits.
    const raced = store.db
      .prepare(
        "SELECT * FROM screening_media_jobs WHERE recording_id=? AND request_key=?",
      )
      .get(row.id, requestKey) as Job | undefined;
    if (raced) {
      if (raced.request_hash !== requestHash)
        return fail(
          409,
          "This request key was already used for another media operation.",
        );
      return raced;
    }
    if (edit && getEdit(edit.id)?.revision !== edit.revision)
      return fail(409, "This edit changed elsewhere. Reload before exporting.");
    const capability =
      kind === "alignment" ? status.alignment : status.clipping;
    if (!capability.available)
      return fail(
        503,
        "This media capability is not configured. Check its setup requirements.",
      );
    if (!row.duration || row.duration > 1800 || row.size > MAX_BYTES)
      return fail(
        413,
        "Media processing supports recordings up to 250 MB and 30 minutes.",
      );
    if (
      kind === "alignment" &&
      !deps.transcript(row).some((t) => t.startSeconds !== null)
    )
      return fail(
        409,
        "Word matching requires original utterance timing. This recording remains available with its untimed transcript.",
      );
    const pending = Number(
      store.db
        .prepare(
          "SELECT count(*) AS n FROM screening_media_jobs WHERE workspace_id=? AND state IN ('queued','processing')",
        )
        .get(user.workspaceId)?.n || 0,
    );
    const count = Number(
      store.db
        .prepare(
          "SELECT count(*) AS n FROM screening_media_jobs WHERE recording_id=?",
        )
        .get(row.id)?.n || 0,
    );
    if (pending >= 2 || count >= 30)
      return fail(
        429,
        "Finish or remove existing media jobs before starting another.",
      );
    const id = randomUUID();
    store.db
      .prepare(
        `INSERT INTO screening_media_jobs(id,recording_id,workspace_id,author_id,session_hash,screening_id,response_id,kind,edit_id,edit_revision,edit_title,payload,fingerprint,request_key,request_hash,state,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'queued',?,?)`,
      )
      .run(
        id,
        row.id,
        user.workspaceId,
        user.id,
        hashToken(getSessionToken(req)!),
        String(req.params.id),
        String(req.params.responseId),
        kind,
        edit?.id || null,
        edit?.revision || null,
        edit?.title || null,
        edit?.segments || "{}",
        fingerprint(row),
        requestKey,
        requestHash,
        now(),
        now(),
      );
    return getJob(id)!;
  }
  const base =
    "/api/screenings/:id/responses/:responseId/recordings/:recordingId/studio";
  app.get(
    base,
    route(async (req, res) => {
      const { user } = access(req);
      const capabilities = await processor.status(user.workspaceId);
      const { row, user: freshUser } = access(req);
      const currentAlignment = alignment(row);
      res.set("Cache-Control", "private, no-store").json({
        canEdit: isWorkspaceAdmin(freshUser),
        capabilities,
        edits: (
          store.db
            .prepare(
              "SELECT * FROM screening_media_edits WHERE recording_id=? ORDER BY created_at,id",
            )
            .all(row.id) as Edit[]
        ).map(publicEdit),
        jobs: (
          store.db
            .prepare(
              "SELECT * FROM screening_media_jobs WHERE recording_id=? ORDER BY created_at DESC,id DESC",
            )
            .all(row.id) as Job[]
        ).map(publicJob),
        alignment: currentAlignment
          ? {
              jobId: currentAlignment.jobId,
              model: currentAlignment.model,
              matched: currentAlignment.matched,
              total: currentAlignment.total,
            }
          : null,
      });
    }),
  );
  app.post(
    `${base}/edits`,
    route((req, res) => {
      const { row } = access(req, true),
        input = editSchema.parse(req.body);
      validSegments(input.segments, row);
      if (
        Number(
          store.db
            .prepare(
              "SELECT count(*) AS n FROM screening_media_edits WHERE recording_id=?",
            )
            .get(row.id)?.n || 0,
        ) >= 20
      )
        return fail(429, "A recording can have up to 20 saved edits.");
      const id = randomUUID();
      store.db
        .prepare(
          "INSERT INTO screening_media_edits(id,recording_id,title,segments,created_at,updated_at) VALUES(?,?,?,?,?,?)",
        )
        .run(
          id,
          row.id,
          input.title,
          JSON.stringify(input.segments),
          now(),
          now(),
        );
      res.status(201).json({ edit: publicEdit(getEdit(id)!) });
    }),
  );
  app.put(
    `${base}/edits/:editId`,
    route((req, res) => {
      const { row } = access(req, true),
        edit = editFor(req, row),
        input = editSchema
          .extend({ revision: z.number().int().positive() })
          .parse(req.body);
      validSegments(input.segments, row);
      const saved = store.db
        .prepare(
          "UPDATE screening_media_edits SET title=?,segments=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?",
        )
        .run(
          input.title,
          JSON.stringify(input.segments),
          now(),
          edit.id,
          input.revision,
        );
      if (saved.changes !== 1)
        return fail(
          409,
          "This edit changed elsewhere. Your draft has been preserved; reload the latest saved edit before retrying.",
        );
      res.json({ edit: publicEdit(getEdit(edit.id)!) });
    }),
  );
  app.delete(
    `${base}/edits/:editId`,
    route((req, res) => {
      const { row } = access(req, true),
        edit = editFor(req, row),
        input = z
          .object({ revision: z.number().int().positive() })
          .strict()
          .parse(req.body);
      if (
        store.db
          .prepare(
            "DELETE FROM screening_media_edits WHERE id=? AND revision=?",
          )
          .run(edit.id, input.revision).changes !== 1
      )
        return fail(
          409,
          "This edit changed elsewhere. Reload before deleting.",
        );
      res.json({ ok: true });
    }),
  );
  app.post(
    `${base}/alignment`,
    route(async (req, res) => {
      access(req, true);
      const input = z
        .object({ requestKey: uuid, consent: z.literal(true) })
        .strict()
        .parse(req.body);
      res.status(202).json({
        job: publicJob(await enqueue(req, "alignment", input.requestKey)),
      });
    }),
  );
  app.post(
    `${base}/edits/:editId/export`,
    route(async (req, res) => {
      const { row } = access(req, true),
        edit = editFor(req, row),
        input = z
          .object({ revision: z.number().int().positive(), requestKey: uuid })
          .strict()
          .parse(req.body);
      if (input.revision !== edit.revision)
        return fail(
          409,
          "This edit changed elsewhere. Reload before exporting.",
        );
      res.status(202).json({
        job: publicJob(await enqueue(req, "export", input.requestKey, edit)),
      });
    }),
  );
  app.delete(
    `${base}/jobs/:jobId`,
    route((req, res) => {
      const { row } = access(req, true),
        job = jobFor(req, row);
      active.get(job.id)?.abort();
      if (["queued", "processing"].includes(job.state)) {
        store.db
          .prepare(
            "UPDATE screening_media_jobs SET state='cancelled',error='Cancelled by a workspace administrator.',result=NULL,updated_at=? WHERE id=?",
          )
          .run(now(), job.id);
        store.db
          .prepare(
            "INSERT OR IGNORE INTO screening_media_cleanup(id,created_at) VALUES(?,?)",
          )
          .run(job.id, now());
      } else
        store.db
          .prepare("DELETE FROM screening_media_jobs WHERE id=?")
          .run(job.id);
      res.json({ ok: true });
    }),
  );
  app.get(
    `${base}/jobs/:jobId/media`,
    route(async (req, res) => {
      const { row } = access(req),
        job = jobFor(req, row);
      if (job.kind !== "export" || job.state !== "ready")
        return fail(404, "This exported clip is not available.");
      const path = join(directory(job.id), "clip.mp4");
      let file;
      try {
        file = await lstat(path);
      } catch {
        return fail(404, "This exported clip is not available.");
      }
      const fresh = access(req).row;
      if (
        jobFor(req, fresh).state !== "ready" ||
        !file.isFile() ||
        file.isSymbolicLink()
      )
        return fail(404, "This exported clip is not available.");
      let start = 0,
        end = file.size - 1;
      const range = req.get("Range");
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match || (!match[1] && !match[2]))
          return fail(416, "Only a single byte range is supported.");
        if (!match[1]) start = Math.max(0, file.size - Number(match[2]));
        else {
          start = Number(match[1]);
          if (match[2]) end = Math.min(end, Number(match[2]));
        }
        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start > end ||
          start >= file.size
        )
          return fail(416, "The requested byte range is unavailable.");
      }
      res.status(range ? 206 : 200).set({
        "Cache-Control": "private, no-store",
        "Content-Type": "video/mp4",
        "Accept-Ranges": "bytes",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": `${req.query.download === "1" ? "attachment" : "inline"}; filename="screening-clip.mp4"`,
        "Content-Length": String(end - start + 1),
      });
      if (range) res.set("Content-Range", `bytes ${start}-${end}/${file.size}`);
      const controller = new AbortController(),
        abort = () => controller.abort();
      const timeout = setTimeout(abort, 5 * 60_000);
      timeout.unref();
      res.once("close", abort);
      try {
        await pipeline(createReadStream(path, { start, end }), res, {
          signal: controller.signal,
        });
      } finally {
        controller.abort();
        clearTimeout(timeout);
        res.removeListener("close", abort);
      }
    }),
  );
  return {
    tick,
    alignment,
    start() {
      if (timer) return;
      stopped = false;
      void tick();
      timer = setInterval(() => {
        void tick();
      }, 2000);
      timer.unref();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      for (const controller of active.values()) controller.abort();
      await running;
      await cleanup();
    },
  };
}
