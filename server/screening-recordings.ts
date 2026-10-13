import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Express, NextFunction, Request, Response } from "express";
import {
  EgressClient,
  EncodedFileOutput,
  EncodedFileType,
  EncodingOptionsPreset,
  S3Upload,
  type EgressInfo,
} from "livekit-server-sdk";
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectVersionsCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { isWorkspaceAdmin, sessionUser } from "./auth.js";
import type { Store } from "./db.js";

const DAY = 86_400_000;
const TERMINAL = new Set([3, 4, 5, 6]);
type Destination = {
  bucket: string;
  endpoint: string;
  region: string;
  key: string;
};
export type RecordingJob = {
  id: string;
  room: string;
  status: number;
  key: string;
  size: number;
  duration: number;
  /** Actual Egress file start, Unix milliseconds; absent for legacy/unknown jobs. */
  startedAtMs?: number;
};
export type RecordingAdapter = {
  start(room: string, destination: Destination): Promise<RecordingJob>;
  list(room: string): Promise<RecordingJob[]>;
  stop(id: string): Promise<RecordingJob>;
  remove(destination: Destination): Promise<void>;
  read(
    destination: Destination,
    range: string | undefined,
    signal: AbortSignal,
  ): Promise<{
    body: Readable;
    length?: number;
    range?: string;
  }>;
};
type Options = {
  env?: NodeJS.ProcessEnv;
  adapter?: RecordingAdapter;
  now?: () => number;
};
type Recording = {
  id: string;
  session_id: string;
  workspace_id: string;
  room_name: string;
  object_key: string;
  bucket: string;
  endpoint: string;
  region: string;
  egress_id: string | null;
  state: string;
  created_at: number;
  consent_at: number;
  expires_at: number;
  size: number;
  duration: number;
  stop_requested: number;
  updated_at: number;
  media_started_at: number | null;
};
type Cleanup = Recording & { reconcile_until: number };
class RecordingError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
function fail(status: number, message: string): never {
  throw new RecordingError(status, message);
}
const route =
  (handler: (req: Request, res: Response) => unknown) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve()
      .then(() => handler(req, res))
      .catch((error) => {
        if (error instanceof RecordingError && !res.headersSent)
          res.status(error.status).json({ error: error.message });
        else if (!res.headersSent) next(error);
        else res.destroy();
      });
  };
function secureUrl(value: string, protocol: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === protocol &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}
export function screeningRecordingStatus(
  workspaceId: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const missing: string[] = [];
  if (!secureUrl(env.LIVEKIT_URL || "", "wss:"))
    missing.push("LIVEKIT_URL (secure wss URL)");
  for (const key of [
    "LIVEKIT_API_KEY",
    "LIVEKIT_API_SECRET",
    "S3_BUCKET",
    "S3_REGION",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
  ])
    if (!env[key]?.trim()) missing.push(key);
  if (env.S3_ENDPOINT?.trim() && !secureUrl(env.S3_ENDPOINT.trim(), "https:"))
    missing.push("S3_ENDPOINT (secure https URL)");
  const workspaces = (
    env.LIVEKIT_WORKSPACE_IDS ??
    env.LLM_WORKSPACE_IDS ??
    env.OPENAI_WORKSPACE_IDS ??
    ""
  )
    .split(",")
    .map((id) => id.trim());
  if (!workspaces.includes(workspaceId))
    missing.push("LIVEKIT_WORKSPACE_IDS or LLM_WORKSPACE_IDS workspace access");
  return {
    available: missing.length === 0,
    missing,
    defaultRetentionDays: 30,
    maxRetentionDays: 90,
  };
}
function destination(
  row: Pick<Recording, "bucket" | "endpoint" | "region" | "object_key">,
): Destination {
  return {
    bucket: row.bucket,
    endpoint: row.endpoint,
    region: row.region,
    key: row.object_key,
  };
}
function job(info: EgressInfo): RecordingJob {
  const file = info.fileResults[0];
  return {
    id: info.egressId,
    room: info.roomName,
    status: info.status,
    key: file?.filename || "",
    size: Number(file?.size || 0),
    duration: Number(file?.duration || 0) / 1e9,
    // Egress FileInfo uses Unix nanoseconds. EgressInfo.startedAt is job start,
    // not necessarily the first byte of this particular output file.
    startedAtMs:
      file?.startedAt && file.startedAt > 0n
        ? Number(file.startedAt / 1_000_000n)
        : undefined,
  };
}
/** Credentials stay in server memory. Playback always passes through current workspace authorization. */
export function createRecordingAdapter(
  env: NodeJS.ProcessEnv,
): RecordingAdapter {
  const client = new EgressClient(
    env.LIVEKIT_URL!.replace(/^wss:/, "https:"),
    env.LIVEKIT_API_KEY,
    env.LIVEKIT_API_SECRET,
    { requestTimeout: 10, failover: false },
  );
  const storage = (target: Destination) =>
    new S3Client({
      region: target.region,
      endpoint: target.endpoint || undefined,
      forcePathStyle: !!target.endpoint,
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID!,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
      },
      maxAttempts: 1,
      requestHandler: { connectionTimeout: 5_000, requestTimeout: 15_000 },
    });
  return {
    async start(room, target) {
      return job(
        await client.startRoomCompositeEgress(
          room,
          new EncodedFileOutput({
            fileType: EncodedFileType.MP4,
            filepath: target.key,
            disableManifest: true,
            output: {
              case: "s3",
              value: new S3Upload({
                accessKey: env.S3_ACCESS_KEY_ID!,
                secret: env.S3_SECRET_ACCESS_KEY!,
                bucket: target.bucket,
                region: target.region,
                endpoint: target.endpoint,
                forcePathStyle: !!target.endpoint,
                contentDisposition:
                  'attachment; filename="screening-interview.mp4"',
              }),
            },
          }),
          {
            layout: "speaker",
            encodingOptions: EncodingOptionsPreset.H264_720P_30,
          },
        ),
      );
    },
    async list(room) {
      return (await client.listEgress({ roomName: room })).map(job);
    },
    async stop(id) {
      return job(await client.stopEgress(id));
    },
    async remove(target) {
      const s3 = storage(target);
      try {
        const abortSignal = AbortSignal.timeout(15_000);
        const removed = await s3.send(
          new DeleteObjectCommand({ Bucket: target.bucket, Key: target.key }),
          { abortSignal },
        );
        // Versioned buckets otherwise retain the original video behind a delete marker.
        // Never declare deletion complete until every version of this exact generated key is gone.
        if (removed.DeleteMarker || removed.VersionId) {
          const versions = await s3.send(
            new ListObjectVersionsCommand({
              Bucket: target.bucket,
              Prefix: target.key,
              MaxKeys: 1000,
            }),
            { abortSignal },
          );
          const objects = [
            ...(versions.Versions || []),
            ...(versions.DeleteMarkers || []),
          ]
            .filter((item) => item.Key === target.key && item.VersionId)
            .map((item) => ({ Key: target.key, VersionId: item.VersionId! }));
          if (objects.length) {
            const deleted = await s3.send(
              new DeleteObjectsCommand({
                Bucket: target.bucket,
                Delete: { Objects: objects, Quiet: true },
              }),
              { abortSignal },
            );
            if (deleted.Errors?.length)
              throw new Error("Recording versions could not be deleted.");
          }
          // A subsequent cleanup attempt removes another bounded page; no broad prefix deletion.
          if (
            versions.IsTruncated &&
            (!versions.NextKeyMarker || versions.NextKeyMarker === target.key)
          )
            throw new Error("More recording versions remain for cleanup.");
        }
      } finally {
        s3.destroy();
      }
    },
    async read(target, range, signal) {
      const s3 = storage(target);
      try {
        const result = await s3.send(
          new GetObjectCommand({
            Bucket: target.bucket,
            Key: target.key,
            Range: range,
          }),
          { abortSignal: signal },
        );
        if (!(result.Body instanceof Readable)) {
          s3.destroy();
          throw new Error("Recording body unavailable.");
        }
        result.Body.once("close", () => s3.destroy());
        return {
          body: result.Body,
          length: result.ContentLength,
          range: result.ContentRange,
        };
      } catch (error) {
        s3.destroy();
        throw error;
      }
    },
  };
}
function tables(store: Store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS screening_recordings (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE REFERENCES screening_live_sessions(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, room_name TEXT NOT NULL,
    object_key TEXT NOT NULL UNIQUE, bucket TEXT NOT NULL, endpoint TEXT NOT NULL, region TEXT NOT NULL,
    egress_id TEXT, state TEXT NOT NULL, created_at INTEGER NOT NULL, consent_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, size INTEGER NOT NULL DEFAULT 0,
    duration REAL NOT NULL DEFAULT 0, stop_requested INTEGER NOT NULL DEFAULT 0
  ); CREATE INDEX IF NOT EXISTS screening_recordings_expiry ON screening_recordings(expires_at);
  CREATE TABLE IF NOT EXISTS screening_recording_cleanup (
    id TEXT PRIMARY KEY, room_name TEXT NOT NULL, object_key TEXT NOT NULL, bucket TEXT NOT NULL,
    endpoint TEXT NOT NULL, region TEXT NOT NULL, egress_id TEXT, reconcile_until INTEGER NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0
  ); CREATE TRIGGER IF NOT EXISTS screening_recordings_deleted BEFORE DELETE ON screening_recordings
    WHEN OLD.state <> 'deleted' BEGIN
      INSERT OR IGNORE INTO screening_recording_cleanup(id,room_name,object_key,bucket,endpoint,region,egress_id,reconcile_until,created_at)
      VALUES(OLD.id,OLD.room_name,OLD.object_key,OLD.bucket,OLD.endpoint,OLD.region,OLD.egress_id,OLD.created_at+7200000,unixepoch()*1000);
    END;`);
  if (
    !store.db
      .prepare("PRAGMA table_info(screening_recordings)")
      .all()
      .some((column) => column.name === "media_started_at")
  )
    store.db.exec(
      "ALTER TABLE screening_recordings ADD COLUMN media_started_at INTEGER",
    );
  if (
    !store.db
      .prepare("PRAGMA table_info(screening_recording_cleanup)")
      .all()
      .some((column) => column.name === "updated_at")
  ) {
    store.db.exec(
      "ALTER TABLE screening_recording_cleanup ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0",
    );
  }
}
/** Mount after live-interview tables, before the global authenticated API middleware. */
export function registerScreeningRecordings(
  app: Express,
  store: Store,
  options: Options = {},
) {
  tables(store);
  const env = options.env || process.env,
    now = options.now || Date.now;
  let adapter = options.adapter;
  const provider = () => (adapter ||= createRecordingAdapter(env));
  const get = (id: string) =>
    store.db
      .prepare("SELECT * FROM screening_recordings WHERE id=?")
      .get(id) as Recording | undefined;
  const bySession = (id: string) =>
    store.db
      .prepare("SELECT * FROM screening_recordings WHERE session_id=?")
      .get(id) as Recording | undefined;
  function saveJob(row: Recording, result: RecordingJob) {
    if (
      result.room !== row.room_name ||
      (row.egress_id && result.id !== row.egress_id)
    )
      return;
    // Do not trust provider locations or unexpected object names, and never retain its upload URL.
    const complete =
      result.status === 3 && result.key === row.object_key && result.size > 0;
    const state =
      row.stop_requested && !TERMINAL.has(result.status)
        ? "processing"
        : complete
          ? "ready"
          : TERMINAL.has(result.status)
            ? "failed"
            : result.status === 2
              ? "processing"
              : "recording";
    store.db
      .prepare(
        "UPDATE screening_recordings SET egress_id=?,state=?,size=?,duration=?,media_started_at=COALESCE(?,media_started_at),updated_at=? WHERE id=? AND state NOT IN ('deleting','deleted')",
      )
      .run(
        result.id,
        state,
        Math.max(0, result.size),
        Math.max(0, result.duration),
        Number.isSafeInteger(result.startedAtMs) &&
          result.startedAtMs! >= row.created_at - 30_000 &&
          result.startedAtMs! <= now() + 30_000
          ? result.startedAtMs!
          : null,
        now(),
        row.id,
      );
  }
  function markDelete(row: Recording) {
    store.transaction(() => {
      store.db
        .prepare(
          "INSERT OR IGNORE INTO screening_recording_cleanup(id,room_name,object_key,bucket,endpoint,region,egress_id,reconcile_until,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .run(
          row.id,
          row.room_name,
          row.object_key,
          row.bucket,
          row.endpoint,
          row.region,
          row.egress_id,
          row.created_at + 7_200_000,
          now(),
        );
      store.db
        .prepare(
          "UPDATE screening_recordings SET state='deleting',stop_requested=1,updated_at=? WHERE id=?",
        )
        .run(now(), row.id);
    });
  }
  async function startSession(sessionId: string, recordingConsent: boolean) {
    const session = store.db
      .prepare(
        `SELECT s.*,p.snapshot,p.revoked_at,p.expires_at AS publication_expiry FROM screening_live_sessions s
      JOIN screening_publications p ON p.id=s.publication_id WHERE s.id=?`,
      )
      .get(sessionId);
    if (!session) return fail(404, "Live interview unavailable.");
    const setup = (
      JSON.parse(String(session.snapshot)) as {
        setup?: { recordingEnabled?: boolean; recordingRetentionDays?: number };
      }
    ).setup;
    if (!setup?.recordingEnabled) return null;
    if (!recordingConsent)
      return fail(400, "Recording requires the candidate’s explicit consent.");
    if (!screeningRecordingStatus(String(session.workspace_id), env).available)
      return fail(
        503,
        "Interview recording is not configured for this hiring team.",
      );
    if (
      session.revoked_at ||
      Number(session.publication_expiry) <= now() ||
      Number(session.expires_at) <= now() ||
      !["starting", "active"].includes(String(session.state))
    )
      return fail(409, "This interview is no longer active.");
    const existing = bySession(sessionId);
    if (existing) {
      if (existing.state === "recording" && !existing.stop_requested)
        return { id: existing.id, state: existing.state };
      return fail(
        409,
        "Recording is still being reconciled or has ended. A second recording will not be started.",
      );
    }
    const id = randomUUID(),
      key = `arkoffer/screening/${session.workspace_id}/${sessionId}/${id}.mp4`;
    const retention = Math.min(
      90,
      Math.max(1, Number(setup.recordingRetentionDays) || 30),
    );
    store.db
      .prepare(
        "INSERT INTO screening_recordings(id,session_id,workspace_id,room_name,object_key,bucket,endpoint,region,state,created_at,consent_at,expires_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'starting',?,?,?,?)",
      )
      .run(
        id,
        sessionId,
        session.workspace_id,
        session.room_name,
        key,
        env.S3_BUCKET!.trim(),
        env.S3_ENDPOINT?.trim() || "",
        env.S3_REGION!.trim(),
        now(),
        now(),
        now() + retention * DAY,
        now(),
      );
    const row = get(id)!;
    try {
      const result = await provider().start(row.room_name, destination(row));
      if (
        result.room !== row.room_name ||
        !result.id ||
        TERMINAL.has(result.status)
      )
        throw new Error("Recording failed to start.");
      saveJob(row, result);
      // Session/resource revocation during the provider call cannot authorize recording afterwards.
      const current = get(id);
      const alive = store.db
        .prepare(
          `SELECT s.id FROM screening_live_sessions s JOIN screening_publications p ON p.id=s.publication_id
        WHERE s.id=? AND s.state IN ('starting','active') AND s.expires_at>? AND p.revoked_at IS NULL AND p.expires_at>?`,
        )
        .get(sessionId, now(), now());
      if (
        !current ||
        !alive ||
        current.state === "deleting" ||
        current.stop_requested
      ) {
        await provider()
          .stop(result.id)
          .catch(() => {});
        return fail(409, "This interview ended while recording was starting.");
      }
      return { id, state: current.state };
    } catch (error) {
      store.db
        .prepare(
          "UPDATE screening_recordings SET state='unknown',stop_requested=1,updated_at=? WHERE id=? AND state='starting'",
        )
        .run(now(), id);
      if (error instanceof RecordingError) throw error;
      return fail(
        502,
        "Recording could not start. This attempt is being reconciled; it will not be retried automatically.",
      );
    }
  }
  async function stopSession(sessionId: string) {
    const row = bySession(sessionId);
    if (!row || ["ready", "failed", "deleting", "deleted"].includes(row.state))
      return;
    store.db
      .prepare(
        "UPDATE screening_recordings SET stop_requested=1,state=CASE WHEN state='recording' THEN 'processing' ELSE state END,updated_at=? WHERE id=?",
      )
      .run(now(), row.id);
    if (row.egress_id) {
      const result = await provider().stop(row.egress_id);
      saveJob({ ...row, stop_requested: 1 }, result);
    }
  }
  async function reconcile(row: Recording) {
    if (row.expires_at <= now()) {
      markDelete(row);
      return;
    }
    if (["deleted", "deleting", "ready", "failed"].includes(row.state)) return;
    const source = store.db
      .prepare(
        `SELECT s.state,s.expires_at,p.revoked_at,p.expires_at AS publication_expiry FROM screening_live_sessions s
      JOIN screening_publications p ON p.id=s.publication_id WHERE s.id=?`,
      )
      .get(row.session_id);
    const shouldStop =
      !!row.stop_requested ||
      !source ||
      !["starting", "active"].includes(String(source.state)) ||
      Number(source.expires_at) <= now() ||
      !!source.revoked_at ||
      Number(source.publication_expiry) <= now();
    const jobs = (await provider().list(row.room_name)).filter(
      (item) =>
        item.room === row.room_name &&
        (row.egress_id
          ? item.id === row.egress_id
          : !item.key || item.key === row.object_key),
    );
    if (!jobs.length) {
      if (row.created_at + 7_200_000 <= now()) markDelete(row);
      return;
    }
    const result = jobs[0];
    if (shouldStop && !TERMINAL.has(result.status)) {
      store.db
        .prepare("UPDATE screening_recordings SET stop_requested=1 WHERE id=?")
        .run(row.id);
      saveJob({ ...row, stop_requested: 1 }, await provider().stop(result.id));
    } else saveJob(row, result);
  }
  async function cleanup(row: Cleanup) {
    const jobs = (await provider().list(row.room_name)).filter(
      (item) =>
        item.room === row.room_name &&
        (row.egress_id
          ? item.id === row.egress_id
          : !item.key || item.key === row.object_key),
    );
    let active = false;
    for (const item of jobs) {
      if (!TERMINAL.has(item.status)) {
        await provider().stop(item.id);
        active = true;
      }
    }
    if (active) return;
    // A timeout is an unknown start outcome. Keep a tombstone long enough to catch a late provider start.
    if (!jobs.length && !row.egress_id && row.reconcile_until > now()) return;
    await provider().remove(destination(row));
    store.transaction(() => {
      store.db
        .prepare(
          "UPDATE screening_recordings SET state='deleted',size=0,duration=0,updated_at=? WHERE id=?",
        )
        .run(now(), row.id);
      store.db
        .prepare("DELETE FROM screening_recording_cleanup WHERE id=?")
        .run(row.id);
    });
  }
  let timer: ReturnType<typeof setInterval> | undefined,
    running: Promise<void> | undefined;
  function tick() {
    if (!running)
      running = (async () => {
        const rows = store.db
          .prepare(
            "SELECT * FROM screening_recordings WHERE state NOT IN ('deleting','deleted') AND (state NOT IN ('ready','failed') OR expires_at<=?) ORDER BY updated_at LIMIT 20",
          )
          .all(now()) as Recording[];
        await Promise.allSettled(
          rows.map((row) => {
            store.db
              .prepare(
                "UPDATE screening_recordings SET updated_at=? WHERE id=?",
              )
              .run(now(), row.id);
            return reconcile(row);
          }),
        );
        const deleted = store.db
          .prepare(
            "SELECT * FROM screening_recording_cleanup ORDER BY updated_at,created_at LIMIT 20",
          )
          .all() as Cleanup[];
        await Promise.allSettled(
          deleted.map((row) => {
            store.db
              .prepare(
                "UPDATE screening_recording_cleanup SET updated_at=? WHERE id=?",
              )
              .run(now(), row.id);
            return cleanup(row);
          }),
        );
      })().finally(() => {
        running = undefined;
      });
    return running;
  }
  function authorize(req: Request) {
    const user = sessionUser(store, req);
    if (!user) return fail(401, "Sign in to review interview recordings.");
    const response = store.db
      .prepare(
        `SELECT a.publication_id,a.answers,a.live_session_id FROM screening_responses a JOIN resources r ON r.id=a.screening_id AND r.workspace_id=a.workspace_id
      WHERE a.id=? AND a.screening_id=? AND a.workspace_id=? AND r.kind='screenings'`,
      )
      .get(
        String(req.params.responseId),
        String(req.params.id),
        user.workspaceId,
      );
    if (!response) return fail(404, "Screening response not found.");
    const ids = new Set(
      (
        JSON.parse(String(response.answers)) as {
          liveEvidence?: { sessionId?: string };
        }[]
      ).flatMap((answer) =>
        answer.liveEvidence?.sessionId ? [answer.liveEvidence.sessionId] : [],
      ),
    );
    if (response.live_session_id) ids.add(String(response.live_session_id));
    const rows = (
      store.db
        .prepare(
          `SELECT r.* FROM screening_recordings r JOIN screening_live_sessions s ON s.id=r.session_id WHERE s.publication_id=? AND r.workspace_id=? ORDER BY r.created_at`,
        )
        .all(response.publication_id, user.workspaceId) as Recording[]
    ).filter((row) => ids.has(row.session_id));
    return { user, rows };
  }
  const base = "/api/screenings/:id/responses/:responseId/recordings";
  app.get(
    "/api/screening-recordings/status",
    route((req, res) => {
      const user = sessionUser(store, req);
      if (!user) return fail(401, "Sign in to view recording capabilities.");
      res.json(screeningRecordingStatus(user.workspaceId, env));
    }),
  );
  app.get(
    base,
    route((req, res) => {
      const { user, rows } = authorize(req);
      res.setHeader("Cache-Control", "private, no-store");
      res.json({
        canDelete: isWorkspaceAdmin(user),
        items: rows.map((row) => ({
          id: row.id,
          sessionId: row.session_id,
          state:
            row.expires_at <= now() && row.state !== "deleted"
              ? "expired"
              : row.state,
          consentAt: new Date(row.consent_at).toISOString(),
          expiresAt: new Date(row.expires_at).toISOString(),
          durationSeconds: row.duration,
          hasMediaTimeline: row.media_started_at !== null,
          bytes: row.size,
          playable: row.state === "ready" && row.expires_at > now(),
        })),
      });
    }),
  );
  app.get(
    `${base}/:recordingId/transcript`,
    route((req, res) => {
      const { rows } = authorize(req),
        row = rows.find((item) => item.id === req.params.recordingId);
      if (!row || row.state !== "ready" || row.expires_at <= now())
        return fail(404, "This recording is unavailable or has expired.");
      const events = store.db
        .prepare(
          "SELECT id,sequence,kind,question_id,text,speech_start_ms,speech_end_ms,timing_source FROM screening_live_events WHERE session_id=? AND text IS NOT NULL ORDER BY sequence",
        )
        .all(row.session_id);
      res.setHeader("Cache-Control", "private, no-store");
      res.json({
        synchronization: "approximate-utterance",
        items: events.map((event) => {
          const start =
            row.media_started_at !== null && event.speech_start_ms !== null
              ? (Number(event.speech_start_ms) - row.media_started_at) / 1000
              : null;
          const end =
            row.media_started_at !== null && event.speech_end_ms !== null
              ? (Number(event.speech_end_ms) - row.media_started_at) / 1000
              : null;
          const aligned =
            !!event.timing_source &&
            start !== null &&
            end !== null &&
            Number.isFinite(start) &&
            Number.isFinite(end) &&
            end > Math.max(0, start) &&
            start < row.duration &&
            row.duration > 0;
          return {
            id: event.id,
            sequence: event.sequence,
            kind: event.kind,
            questionId: event.question_id,
            text: event.text,
            startSeconds: aligned ? Math.max(0, start) : null,
            endSeconds: aligned ? Math.min(row.duration, end) : null,
            timingSource: aligned ? event.timing_source : null,
          };
        }),
      });
    }),
  );
  app.get(
    `${base}/:recordingId/media`,
    route(async (req, res) => {
      const { rows } = authorize(req),
        row = rows.find((item) => item.id === req.params.recordingId);
      if (!row || row.state !== "ready" || row.expires_at <= now())
        return fail(404, "This recording is unavailable or has expired.");
      const range = req.get("Range");
      if (range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range))
        return fail(416, "Only a single valid byte range is supported.");
      const controller = new AbortController();
      const abort = () => controller.abort();
      res.once("close", abort);
      const timeout = setTimeout(abort, 5 * 60_000);
      timeout.unref();
      let body: Readable | undefined;
      try {
        const result = await provider().read(
          destination(row),
          range,
          controller.signal,
        );
        body = result.body;
        // Slow storage reads must not bypass a concurrent deletion or membership revocation.
        const fresh = authorize(req).rows.find((item) => item.id === row.id);
        if (!fresh || fresh.state !== "ready" || fresh.expires_at <= now()) {
          result.body.destroy();
          return fail(404, "This recording is unavailable or has expired.");
        }
        res.status(result.range ? 206 : 200);
        res.set({
          "Cache-Control": "private, no-store",
          "Content-Type": "video/mp4",
          "Accept-Ranges": "bytes",
          "X-Content-Type-Options": "nosniff",
          "Content-Disposition": `${req.query.download === "1" ? "attachment" : "inline"}; filename="screening-interview.mp4"`,
        });
        if (result.length !== undefined)
          res.setHeader("Content-Length", result.length);
        if (result.range) res.setHeader("Content-Range", result.range);
        await pipeline(result.body, res, { signal: controller.signal });
      } catch (error) {
        if (error instanceof RecordingError) throw error;
        if (!res.headersSent && !res.destroyed) {
          if (controller.signal.aborted)
            return fail(
              504,
              "The recording download timed out. Please try again.",
            );
          if ((error as { name?: string }).name === "InvalidRange")
            return fail(416, "The requested byte range is unavailable.");
          return fail(502, "Recording storage is temporarily unavailable.");
        }
      } finally {
        controller.abort();
        body?.destroy();
        clearTimeout(timeout);
        res.removeListener("close", abort);
      }
    }),
  );
  app.delete(
    `${base}/:recordingId`,
    route(async (req, res) => {
      const { user, rows } = authorize(req);
      if (!isWorkspaceAdmin(user))
        return fail(
          403,
          "Only workspace owners and admins can delete recordings.",
        );
      const row = rows.find((item) => item.id === req.params.recordingId);
      if (!row) return fail(404, "Recording not found.");
      if (row.state !== "deleted") markDelete(row);
      res.status(202).json({
        ok: true,
        state: row.state === "deleted" ? "deleted" : "deleting",
      });
      void tick();
    }),
  );
  return {
    startSession,
    stopSession,
    tick,
    start() {
      if (timer) return;
      void tick();
      timer = setInterval(() => {
        void tick();
      }, 15_000);
      timer.unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await running;
    },
  };
}
