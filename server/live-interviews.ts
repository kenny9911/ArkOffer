import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import {
  AccessToken,
  AgentDispatchClient,
  RoomServiceClient,
  TrackSource,
} from "livekit-server-sdk";
import { z } from "zod";
import { hashToken, sessionUser } from "./auth.js";
import type { Store } from "./db.js";

const DURATION = 30 * 60_000;
const ACTIVE = "('starting','active')";
type Publication = {
  id: string;
  workspace_id: string;
  snapshot: string;
  expires_at: number;
};
type Session = {
  id: string;
  publication_id: string;
  workspace_id: string;
  room_name: string;
  state: string;
  request_id: string;
  expires_at: number;
  created_at: string;
  consent_at: string;
  ended_at: string | null;
  end_reason: string | null;
};
type Question = {
  id: string;
  prompt: string;
  type: string;
  options: string[];
  required: boolean;
  followUp?: boolean;
};
type Snapshot = {
  title: string;
  questions: Question[];
  setup?: {
    language?: string;
    interviewMode?: string;
    cameraPolicy?: string;
    recordingEnabled?: boolean;
    recordingRetentionDays?: number;
    welcomeMessage?: string;
    completionMessage?: string;
  };
};
export type LiveInterviewAdapter = {
  createRoom(room: string): Promise<void>;
  dispatch(room: string, agent: string, metadata: string): Promise<void>;
  deleteRoom(room: string): Promise<void>;
  token(room: string, identity: string, camera: boolean): Promise<string>;
};
export type LiveInterviewOptions = {
  env?: NodeJS.ProcessEnv;
  adapter?: LiveInterviewAdapter;
  now?: () => number;
  recording?: {
    status: (workspaceId: string) => { available: boolean };
    startSession: (sessionId: string, consent: boolean) => Promise<unknown>;
    stopSession: (sessionId: string) => Promise<unknown>;
  };
};
class LiveError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const fail = (status: number, message: string): never => {
  throw new LiveError(status, message);
};
const route =
  (handler: (req: Request, res: Response) => unknown) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve()
      .then(() => handler(req, res))
      .catch((error) => {
        if (error instanceof LiveError)
          res.status(error.status).json({ error: error.message });
        else if (error instanceof z.ZodError)
          res.status(400).json({
            error:
              error.issues[0]?.message || "Invalid live interview request.",
          });
        else next(error);
      });
  };
function tables(store: Store) {
  // Called lazily because callback routes are registered before publication tables.
  store.db.exec(`CREATE TABLE IF NOT EXISTS screening_live_sessions (
    id TEXT PRIMARY KEY, publication_id TEXT NOT NULL REFERENCES screening_publications(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, room_name TEXT NOT NULL UNIQUE,
    request_id TEXT NOT NULL, state TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at TEXT NOT NULL,
    consent_at TEXT NOT NULL, ended_at TEXT, end_reason TEXT, room_closed INTEGER NOT NULL DEFAULT 0, UNIQUE(publication_id,request_id)
  ); CREATE UNIQUE INDEX IF NOT EXISTS screening_live_one_active ON screening_live_sessions(publication_id) WHERE state IN ${ACTIVE};
  CREATE TABLE IF NOT EXISTS screening_live_events (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES screening_live_sessions(id) ON DELETE CASCADE,
    event_hash TEXT NOT NULL, sequence INTEGER NOT NULL, kind TEXT NOT NULL, question_id TEXT, text TEXT,
    created_at TEXT NOT NULL, UNIQUE(session_id,sequence)
  );`);
  if (
    !store.db
      .prepare("PRAGMA table_info(screening_live_sessions)")
      .all()
      .some((column) => column.name === "room_closed")
  )
    store.db.exec(
      "ALTER TABLE screening_live_sessions ADD COLUMN room_closed INTEGER NOT NULL DEFAULT 0",
    );
  const eventColumns = store.db
    .prepare("PRAGMA table_info(screening_live_events)")
    .all();
  for (const [name, type] of [
    ["speech_start_ms", "INTEGER"],
    ["speech_end_ms", "INTEGER"],
    ["timing_source", "TEXT"],
  ]) {
    if (!eventColumns.some((column) => column.name === name))
      store.db.exec(
        `ALTER TABLE screening_live_events ADD COLUMN ${name} ${type}`,
      );
  }
  // Survives the session/publication/workspace cascade until the remote room is deleted.
  store.db
    .exec(`CREATE TABLE IF NOT EXISTS screening_live_room_cleanup (room_name TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
    CREATE TRIGGER IF NOT EXISTS screening_live_deleted_room BEFORE DELETE ON screening_live_sessions WHEN OLD.room_closed=0
    BEGIN INSERT OR IGNORE INTO screening_live_room_cleanup(room_name,created_at) VALUES(OLD.room_name,unixepoch()*1000); END;`);
}
function liveConfig(env: NodeJS.ProcessEnv) {
  const missing: string[] = [];
  const url = env.LIVEKIT_URL?.trim() || "";
  let validUrl = false,
    cloud = false;
  try {
    const parsed = new URL(url);
    validUrl =
      parsed.protocol === "wss:" &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash;
    cloud = parsed.hostname.endsWith(".livekit.cloud");
  } catch {
    /* capability is unavailable */
  }
  if (!validUrl) missing.push("LIVEKIT_URL (secure wss URL)");
  for (const name of [
    "LIVEKIT_API_KEY",
    "LIVEKIT_API_SECRET",
    "INTERVIEW_ENGINE_AGENT_NAME",
  ] as const)
    if (!env[name]?.trim()) missing.push(name);
  if ((env.LIVEKIT_AGENT_CALLBACK_SECRET || "").length < 24)
    missing.push("LIVEKIT_AGENT_CALLBACK_SECRET (at least 24 characters)");
  const callbackOrigin = env.PUBLIC_APP_URL || env.APP_URL || env.APP_ORIGIN;
  const callback =
    env.INTERVIEW_AGENT_CALLBACK_URL?.trim() ||
    `${callbackOrigin?.replace(/\/$/, "") || ""}/api/live-interviews/callback`;
  try {
    const parsed = new URL(callback);
    if (
      (parsed.protocol !== "https:" &&
        !(
          parsed.protocol === "http:" &&
          ["localhost", "127.0.0.1"].includes(parsed.hostname)
        )) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      throw new Error();
  } catch {
    missing.push(
      "PUBLIC_APP_URL or INTERVIEW_AGENT_CALLBACK_URL (agent-reachable URL)",
    );
  }
  const provider = env.LLM_PROVIDER?.trim().toLowerCase() || "openai";
  if (!["openai", "openrouter"].includes(provider))
    missing.push("LLM_PROVIDER (openai or openrouter)");
  if (
    !(
      provider === "openrouter" ? env.OPENROUTER_API_KEY : env.OPENAI_API_KEY
    )?.trim()
  )
    missing.push(
      provider === "openrouter" ? "OPENROUTER_API_KEY" : "OPENAI_API_KEY",
    );
  if (
    !(
      env.LLM_INTERVIEW_MODEL ||
      env.LLM_MODEL ||
      (provider === "openai" ? env.OPENAI_MODEL : "")
    )?.trim()
  )
    missing.push("LLM_MODEL");
  const llmBase =
    provider === "openrouter"
      ? env.OPENROUTER_API_BASE_URL ||
        env.OPENROUTER_BASE_URL ||
        "https://openrouter.ai/api/v1"
      : env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  try {
    const base = new URL(llmBase);
    if (
      base.protocol !== "https:" ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    )
      throw new Error();
  } catch {
    missing.push("Secure text provider API base URL");
  }
  const speech =
    env.INTERVIEW_VOICE_PROVIDER?.trim() || (cloud ? "livekit" : "openai");
  if (!["livekit", "openai"].includes(speech))
    missing.push("INTERVIEW_VOICE_PROVIDER (livekit or openai)");
  if (speech === "livekit" && !cloud)
    missing.push(
      "LiveKit Cloud for inference, or INTERVIEW_VOICE_PROVIDER=openai",
    );
  if (speech === "openai" && !env.OPENAI_API_KEY?.trim())
    missing.push("OPENAI_API_KEY for speech");
  return {
    missing: [...new Set(missing)],
    url,
    callback,
    speech,
    agent: env.INTERVIEW_ENGINE_AGENT_NAME || "",
  };
}
function allowed(env: NodeJS.ProcessEnv, workspaceId: string) {
  return (
    env.LIVEKIT_WORKSPACE_IDS ??
    env.LLM_WORKSPACE_IDS ??
    env.OPENAI_WORKSPACE_IDS ??
    ""
  )
    .split(",")
    .map((item) => item.trim())
    .includes(workspaceId);
}
export function liveInterviewStatus(
  workspaceId: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const config = liveConfig(env),
    missing = [...config.missing];
  if (!allowed(env, workspaceId))
    missing.push("LIVEKIT_WORKSPACE_IDS or LLM_WORKSPACE_IDS workspace access");
  return {
    available: missing.length === 0,
    missing,
    recording: false,
    maxMinutes: 30,
  };
}
function publication(
  store: Store,
  token: string,
  now: number,
  allowSubmitted = false,
): Publication {
  if (!/^[a-f0-9]{64}$/.test(token))
    return fail(404, "This screening link is unavailable or has expired.");
  const row = store.db
    .prepare(
      `SELECT p.id,p.workspace_id,p.snapshot,p.expires_at FROM screening_publications p JOIN resources r
    ON r.id=p.screening_id AND r.workspace_id=p.workspace_id AND r.kind='screenings'
    WHERE p.token_hash=? AND p.revoked_at IS NULL AND p.expires_at>?`,
    )
    .get(hashToken(token), now) as Publication | undefined;
  if (!row)
    return fail(404, "This screening link is unavailable or has expired.");
  if (
    !allowSubmitted &&
    store.db
      .prepare("SELECT id FROM screening_responses WHERE publication_id=?")
      .get(row.id)
  )
    return fail(409, "This questionnaire is complete.");
  return row;
}
function publicSession(store: Store, row: Session) {
  const events = store.db
    .prepare(
      "SELECT id,sequence,kind,question_id,text,created_at,speech_start_ms,speech_end_ms,timing_source FROM screening_live_events WHERE session_id=? ORDER BY sequence",
    )
    .all(row.id);
  return {
    id: row.id,
    state: row.state,
    expiresAt: new Date(row.expires_at).toISOString(),
    consentAt: row.consent_at,
    endedAt: row.ended_at,
    endReason: row.end_reason,
    recording:
      JSON.parse(
        String(
          store.db
            .prepare("SELECT snapshot FROM screening_publications WHERE id=?")
            .get(row.publication_id)?.snapshot ?? "{}",
        ),
      ).setup?.recordingEnabled === true,
    events: events.map((event) => ({
      id: event.id,
      sequence: event.sequence,
      kind: event.kind,
      questionId: event.question_id,
      text: event.text,
      createdAt: event.created_at,
      timing: event.timing_source
        ? {
            source: event.timing_source,
            startedAtMs: event.speech_start_ms,
            endedAtMs: event.speech_end_ms,
          }
        : null,
    })),
  };
}
function defaultAdapter(env: NodeJS.ProcessEnv): LiveInterviewAdapter {
  const url = env.LIVEKIT_URL!.replace(/^wss:/, "https:");
  const rooms = new RoomServiceClient(
    url,
    env.LIVEKIT_API_KEY,
    env.LIVEKIT_API_SECRET,
    { requestTimeout: 10, failover: false },
  );
  const dispatch = new AgentDispatchClient(
    url,
    env.LIVEKIT_API_KEY,
    env.LIVEKIT_API_SECRET,
    { requestTimeout: 10, failover: false },
  );
  return {
    async createRoom(name) {
      await rooms.createRoom({
        name,
        emptyTimeout: 60,
        departureTimeout: 20,
        maxParticipants: 2,
      });
    },
    async dispatch(room, agent, metadata) {
      await dispatch.createDispatch(room, agent, { metadata });
    },
    async deleteRoom(room) {
      try {
        await rooms.deleteRoom(room);
      } catch (error) {
        if (!(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "not_found"
        ))
          throw error;
      }
    },
    async token(room, identity, camera) {
      const token = new AccessToken(
        env.LIVEKIT_API_KEY,
        env.LIVEKIT_API_SECRET,
        { identity, ttl: 120, name: "Candidate" },
      );
      token.addGrant({
        roomJoin: true,
        room,
        canSubscribe: true,
        canPublish: true,
        canPublishData: false,
        canPublishSources: camera
          ? [TrackSource.MICROPHONE, TrackSource.CAMERA]
          : [TrackSource.MICROPHONE],
      });
      return token.toJwt();
    },
  };
}
/** Mount before express.json and Origin middleware. Raw bytes, not reserialized JSON, are authenticated. */
export function registerLiveInterviewCallbacks(
  app: Express,
  store: Store,
  options: LiveInterviewOptions = {},
) {
  const env = options.env || process.env,
    now = options.now || Date.now;
  app.post(
    "/api/live-interviews/callback",
    express.raw({ type: "application/json", limit: "32kb" }),
    route((req, res) => {
      const secret = env.LIVEKIT_AGENT_CALLBACK_SECRET || "",
        timestamp = req.get("X-ArkOffer-Timestamp") || "",
        signature = req.get("X-ArkOffer-Signature") || "";
      if (
        secret.length < 24 ||
        !Buffer.isBuffer(req.body) ||
        !/^\d{13}$/.test(timestamp) ||
        Math.abs(now() - Number(timestamp)) > 300_000 ||
        !/^[a-f0-9]{64}$/.test(signature)
      )
        return fail(401, "Invalid interview callback signature.");
      const expected = createHmac("sha256", secret)
        .update(`${timestamp}.`)
        .update(req.body)
        .digest();
      if (!timingSafeEqual(expected, Buffer.from(signature, "hex")))
        return fail(401, "Invalid interview callback signature.");
      let body: unknown;
      try {
        body = JSON.parse(req.body.toString("utf8"));
      } catch {
        return fail(400, "Invalid callback JSON.");
      }
      const input = z
        .object({
          eventId: z.uuid(),
          sessionId: z.uuid(),
          sequence: z.number().int().min(1).max(400),
          kind: z.enum([
            "ready",
            "answer",
            "agent",
            "ended",
            "error",
            "followup-question",
            "followup-answer",
            "skip",
            "followup-skip",
          ]),
          questionId: z.uuid().optional(),
          text: z.string().trim().min(1).max(10_000).optional(),
          timing: z
            .object({
              source: z.enum(["livekit-vad", "livekit-playout"]),
              startedAtMs: z.number().int().positive().safe(),
              endedAtMs: z.number().int().positive().safe(),
            })
            .strict()
            .optional(),
        })
        .strict()
        .parse(body);
      tables(store);
      const session = store.db
        .prepare(
          `SELECT s.* FROM screening_live_sessions s JOIN screening_publications p ON p.id=s.publication_id
      JOIN resources r ON r.id=p.screening_id AND r.workspace_id=p.workspace_id AND r.kind='screenings'
      WHERE s.id=? AND p.revoked_at IS NULL AND p.expires_at>?`,
        )
        .get(input.sessionId, now()) as Session | undefined;
      if (!session) return fail(404, "Live interview is unavailable.");
      const hash = hashToken(JSON.stringify(input));
      const duplicate = store.db
        .prepare(
          "SELECT event_hash FROM screening_live_events WHERE id=? AND session_id=?",
        )
        .get(input.eventId, session.id);
      if (duplicate) {
        if (duplicate.event_hash !== hash)
          return fail(
            409,
            "Callback identity conflicts with an earlier event.",
          );
        res.json({ ok: true, duplicate: true });
        return;
      }
      if (
        !["starting", "active"].includes(session.state) ||
        session.expires_at <= now() ||
        store.db
          .prepare("SELECT id FROM screening_responses WHERE publication_id=?")
          .get(session.publication_id)
      )
        return fail(409, "Live interview has ended.");
      const snapshot = JSON.parse(
        String(
          store.db
            .prepare("SELECT snapshot FROM screening_publications WHERE id=?")
            .get(session.publication_id)!.snapshot,
        ),
      ) as Snapshot;
      const transcriptKinds = [
        "answer",
        "agent",
        "followup-question",
        "followup-answer",
        "skip",
        "followup-skip",
      ];
      if (
        transcriptKinds.includes(input.kind) &&
        (!input.text ||
          !input.questionId ||
          !snapshot.questions.some(
            (question) => question.id === input.questionId,
          ))
      )
        return fail(400, "Transcript must reference a published question.");
      if (
        !transcriptKinds.includes(input.kind) &&
        (input.text || input.questionId || input.timing)
      )
        return fail(400, "State callbacks cannot contain transcript data.");
      if (input.timing) {
        const { startedAtMs, endedAtMs, source } = input.timing;
        const candidate = [
          "answer",
          "followup-answer",
          "skip",
          "followup-skip",
        ].includes(input.kind);
        if (
          source !== (candidate ? "livekit-vad" : "livekit-playout") ||
          endedAtMs <= startedAtMs ||
          endedAtMs - startedAtMs > 1_800_000 ||
          startedAtMs < Date.parse(session.created_at) - 30_000 ||
          endedAtMs > Math.min(now(), session.expires_at) + 30_000
        )
          return fail(
            400,
            "Speech timing must match this interview and speaker.",
          );
      }
      if (
        ["answer", "skip"].includes(input.kind) &&
        store.db
          .prepare(
            "SELECT id FROM screening_live_events WHERE session_id=? AND question_id=? AND kind IN ('answer','skip')",
          )
          .get(session.id, input.questionId!)
      ) {
        return fail(
          409,
          "A published question can be answered or skipped only once.",
        );
      }
      if (input.kind.startsWith("followup-")) {
        const question = snapshot.questions.find(
          (item) => item.id === input.questionId,
        )!;
        if (question.type !== "text" || question.followUp !== true)
          return fail(
            400,
            "This published question does not allow a follow-up.",
          );
        const turns = store.db
          .prepare(
            "SELECT kind FROM screening_live_events WHERE session_id=? AND question_id=? ORDER BY sequence",
          )
          .all(session.id, input.questionId!);
        const kinds = turns.map((turn) => turn.kind);
        if (input.kind === "followup-question") {
          if (
            !kinds.includes("answer") ||
            kinds.includes("followup-question") ||
            kinds.includes("skip") ||
            input.text!.length > 600
          )
            return fail(
              409,
              "Only one bounded follow-up may follow an answered question.",
            );
        } else if (
          !kinds.includes("followup-question") ||
          kinds.includes("followup-answer") ||
          kinds.includes("followup-skip")
        ) {
          return fail(
            409,
            "A follow-up can be answered or skipped only once, after it is asked.",
          );
        }
      }
      const usage = store.db
        .prepare(
          "SELECT COUNT(*) count,COALESCE(SUM(LENGTH(text)),0) bytes,COALESCE(MAX(sequence),0) sequence FROM screening_live_events WHERE session_id=?",
        )
        .get(session.id)!;
      if (
        Number(usage.count) >= 400 ||
        Number(usage.bytes) + (input.text?.length || 0) > 200_000
      )
        return fail(413, "Interview transcript limit reached.");
      if (input.sequence !== Number(usage.sequence) + 1)
        return fail(409, "Interview events must arrive in sequence.");
      store.db
        .prepare(
          "INSERT INTO screening_live_events(id,session_id,event_hash,sequence,kind,question_id,text,created_at,speech_start_ms,speech_end_ms,timing_source) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          input.eventId,
          session.id,
          hash,
          input.sequence,
          input.kind,
          input.questionId || null,
          input.text || null,
          new Date(now()).toISOString(),
          input.timing?.startedAtMs ?? null,
          input.timing?.endedAtMs ?? null,
          input.timing?.source ?? null,
        );
      if (["ended", "error"].includes(input.kind))
        store.db
          .prepare(
            "UPDATE screening_live_sessions SET state=?,ended_at=?,end_reason=? WHERE id=?",
          )
          .run(
            input.kind === "error" ? "failed" : "ended",
            new Date(now()).toISOString(),
            input.kind === "error" ? "provider-error" : "completed",
            session.id,
          );
      res.json({ ok: true });
    }),
  );
}
/** Mount after screening tables, before session-only middleware. */
export function registerLiveInterviews(
  app: Express,
  store: Store,
  options: LiveInterviewOptions = {},
) {
  tables(store);
  const env = options.env || process.env,
    now = options.now || Date.now;
  let adapter = options.adapter;
  const getAdapter = () => (adapter ||= defaultAdapter(env));
  const capability = (workspaceId: string) =>
    liveInterviewStatus(workspaceId, env);
  let timer: ReturnType<typeof setInterval> | undefined,
    running: Promise<void> | undefined;
  async function sweep() {
    const pending = store.db
      .prepare(
        "SELECT room_name FROM screening_live_room_cleanup ORDER BY created_at LIMIT 10",
      )
      .all();
    const expired = store.db
      .prepare(
        `SELECT s.* FROM screening_live_sessions s LEFT JOIN screening_publications p ON p.id=s.publication_id
      WHERE s.room_closed=0 AND ((s.state='starting' AND s.created_at<?) OR (s.state='active' AND s.created_at<? AND NOT EXISTS(SELECT 1 FROM screening_live_events e WHERE e.session_id=s.id AND e.kind='ready')) OR s.state IN ('ended','failed') OR s.expires_at<=? OR p.expires_at<=? OR p.revoked_at IS NOT NULL OR EXISTS(SELECT 1 FROM screening_responses r WHERE r.publication_id=s.publication_id)) ORDER BY s.created_at LIMIT 20`,
      )
      .all(
        new Date(now() - 60_000).toISOString(),
        new Date(now() - 60_000).toISOString(),
        now(),
        now(),
      ) as Session[];
    // Bound a sweep to one provider timeout; a provider outage must not multiply shutdown time per room.
    await Promise.allSettled([
      ...pending.map(async (row) => {
        await getAdapter().deleteRoom(String(row.room_name));
        store.db
          .prepare("DELETE FROM screening_live_room_cleanup WHERE room_name=?")
          .run(row.room_name);
      }),
      ...expired.map(async (row) => {
        if (["starting", "active"].includes(row.state))
          store.db
            .prepare(
              "UPDATE screening_live_sessions SET state='ended',ended_at=?,end_reason='expired-or-revoked' WHERE id=?",
            )
            .run(new Date(now()).toISOString(), row.id);
        await options.recording?.stopSession(row.id).catch(() => {});
        await getAdapter().deleteRoom(row.room_name);
        store.db
          .prepare(
            "UPDATE screening_live_sessions SET room_closed=1 WHERE id=?",
          )
          .run(row.id);
      }),
    ]);
  }
  function expireSessions() {
    if (!running)
      running = sweep().finally(() => {
        running = undefined;
      });
    return running;
  }
  app.get(
    "/api/live-interviews/status",
    route((req, res) => {
      const user = sessionUser(store, req);
      if (!user) return fail(401, "Sign in to view interview capabilities.");
      res.json(capability(user.workspaceId));
    }),
  );
  app.get(
    "/api/interviews/:token/live/status",
    route((req, res) => {
      const pub = publication(store, String(req.params.token), now()),
        snapshot = JSON.parse(pub.snapshot) as Snapshot;
      const configured = capability(pub.workspace_id);
      const recording = snapshot.setup?.recordingEnabled === true;
      const recordingReady =
        !recording ||
        options.recording?.status(pub.workspace_id).available === true;
      res.setHeader("Cache-Control", "no-store");
      res.json({
        available:
          configured.available &&
          recordingReady &&
          snapshot.setup?.interviewMode === "live",
        enabled: snapshot.setup?.interviewMode === "live",
        cameraPolicy: snapshot.setup?.cameraPolicy || "optional",
        recording,
        recordingRetentionDays: snapshot.setup?.recordingRetentionDays || 30,
        maxMinutes: 30,
        previousSession: (() => {
          const row = store.db
            .prepare(
              "SELECT * FROM screening_live_sessions WHERE publication_id=? AND workspace_id=? ORDER BY created_at DESC LIMIT 1",
            )
            .get(pub.id, pub.workspace_id) as Session | undefined;
          return row ? publicSession(store, row) : null;
        })(),
        reason: !recordingReady
          ? "Interview recording is not configured for this hiring team. You can complete the questionnaire below."
          : configured.available
            ? ""
            : "Live interviewing is not configured for this hiring team. You can complete the questionnaire below.",
      });
    }),
  );
  app.post(
    "/api/interviews/:token/live/sessions",
    route(async (req, res) => {
      const pub = publication(store, String(req.params.token), now()),
        snapshot = JSON.parse(pub.snapshot) as Snapshot;
      const input = z
        .object({
          requestId: z.uuid(),
          consent: z.literal(true),
          cameraEnabled: z.boolean(),
          recordingConsent: z.literal(true).optional(),
        })
        .strict()
        .parse(req.body);
      if (
        !capability(pub.workspace_id).available ||
        snapshot.setup?.interviewMode !== "live"
      )
        return fail(
          503,
          "Live interviewing is not enabled for this hiring team.",
        );
      if (snapshot.setup?.recordingEnabled) {
        if (!input.recordingConsent)
          return fail(400, "Consent to interview recording before joining.");
        if (!options.recording?.status(pub.workspace_id).available)
          return fail(
            503,
            "Interview recording is unavailable. Complete the questionnaire or contact the hiring team.",
          );
      }
      const policy = snapshot.setup?.cameraPolicy || "optional";
      if (
        (policy === "required" && !input.cameraEnabled) ||
        (policy === "off" && input.cameraEnabled)
      )
        return fail(400, "Use the camera setting required by this screening.");
      const existing = store.db
        .prepare(
          "SELECT * FROM screening_live_sessions WHERE publication_id=? AND request_id=?",
        )
        .get(pub.id, input.requestId) as Session | undefined;
      if (existing) {
        if (existing.state !== "active" || existing.expires_at <= now())
          return fail(
            409,
            "This interview attempt has ended or is still connecting.",
          );
        res.json({
          item: publicSession(store, existing),
          url: liveConfig(env).url,
          token: await getAdapter().token(
            existing.room_name,
            `candidate-${existing.id}`,
            input.cameraEnabled,
          ),
        });
        return;
      }
      const active = store.db
        .prepare(
          `SELECT id FROM screening_live_sessions WHERE publication_id=? AND state IN ${ACTIVE}`,
        )
        .get(pub.id);
      if (active)
        return fail(
          409,
          "A live interview is already active for this link. End it before starting another.",
        );
      const count = store.db
        .prepare(
          "SELECT COUNT(*) count FROM screening_live_sessions WHERE publication_id=?",
        )
        .get(pub.id)!;
      const daily = store.db
        .prepare(
          "SELECT COUNT(*) count FROM screening_live_sessions WHERE workspace_id=? AND created_at>=?",
        )
        .get(pub.workspace_id, new Date(now() - 86400000).toISOString())!;
      const concurrent = store.db
        .prepare(
          `SELECT COUNT(*) count FROM screening_live_sessions WHERE workspace_id=? AND state IN ${ACTIVE}`,
        )
        .get(pub.workspace_id)!;
      if (
        Number(count.count) >= 3 ||
        Number(daily.count) >= 100 ||
        Number(concurrent.count) >= 5
      )
        return fail(
          429,
          "Live interview limit reached. Complete the questionnaire or contact the hiring team.",
        );
      const id = randomUUID(),
        room = `screening-${id}`,
        date = new Date(now()).toISOString(),
        expires = Math.min(pub.expires_at, now() + DURATION);
      store.db
        .prepare(
          "INSERT INTO screening_live_sessions(id,publication_id,workspace_id,room_name,request_id,state,expires_at,created_at,consent_at) VALUES(?,?,?,?,?,'starting',?,?,?)",
        )
        .run(
          id,
          pub.id,
          pub.workspace_id,
          room,
          input.requestId,
          expires,
          date,
          date,
        );
      try {
        await getAdapter().createRoom(room);
        // Consent is validated before allocating a room or starting capture.
        if (snapshot.setup?.recordingEnabled)
          await options.recording!.startSession(
            id,
            input.recordingConsent === true,
          );
        publication(store, String(req.params.token), now());
        const config = liveConfig(env);
        // Never send private screening context, evaluation rubric, hiring decisions, or account secrets.
        await getAdapter().dispatch(
          room,
          config.agent,
          JSON.stringify({
            version: 1,
            sessionId: id,
            candidateIdentity: `candidate-${id}`,
            expiresAt: expires,
            callbackUrl: config.callback,
            title: snapshot.title,
            language: snapshot.setup?.language || "en-US",
            welcomeMessage: snapshot.setup?.welcomeMessage || "",
            completionMessage: snapshot.setup?.completionMessage || "",
            questions: snapshot.questions.map(
              ({ id, prompt, type, options, required, followUp }) => ({
                id,
                prompt,
                type,
                options,
                required,
                followUp: followUp === true,
              }),
            ),
          }),
        );
        publication(store, String(req.params.token), now());
        store.db
          .prepare(
            "UPDATE screening_live_sessions SET state='active' WHERE id=? AND state='starting'",
          )
          .run(id);
        const current = store.db
          .prepare("SELECT * FROM screening_live_sessions WHERE id=?")
          .get(id) as Session;
        if (current.state !== "active" || current.expires_at <= now())
          return fail(409, "The interview could not start. Try again.");
        res.status(201).json({
          item: publicSession(store, current),
          url: config.url,
          token: await getAdapter().token(
            room,
            `candidate-${id}`,
            input.cameraEnabled,
          ),
        });
      } catch {
        await options.recording?.stopSession(id).catch(() => {});
        try {
          await getAdapter().deleteRoom(room);
        } catch {
          /* expiry sweeper retries failed rooms */
        }
        store.db
          .prepare(
            "UPDATE screening_live_sessions SET state='failed',ended_at=?,end_reason='connection-failed' WHERE id=?",
          )
          .run(new Date(now()).toISOString(), id);
        return fail(
          502,
          "The live interviewer could not connect. Your typed answers are still available.",
        );
      }
    }),
  );
  app.get(
    "/api/interviews/:token/live/sessions/:sessionId",
    route((req, res) => {
      const pub = publication(store, String(req.params.token), now());
      const row = store.db
        .prepare(
          "SELECT * FROM screening_live_sessions WHERE id=? AND publication_id=? AND workspace_id=?",
        )
        .get(String(req.params.sessionId), pub.id, pub.workspace_id) as
        Session | undefined;
      if (!row) return fail(404, "Live interview not found.");
      res.setHeader("Cache-Control", "no-store");
      res.json({ item: publicSession(store, row) });
    }),
  );
  app.post(
    "/api/interviews/:token/live/sessions/:sessionId/end",
    route(async (req, res) => {
      const pub = publication(store, String(req.params.token), now());
      const row = store.db
        .prepare(
          "SELECT * FROM screening_live_sessions WHERE id=? AND publication_id=? AND workspace_id=?",
        )
        .get(String(req.params.sessionId), pub.id, pub.workspace_id) as
        Session | undefined;
      if (!row) return fail(404, "Live interview not found.");
      store.db
        .prepare(
          "UPDATE screening_live_sessions SET state='ended',ended_at=COALESCE(ended_at,?),end_reason=COALESCE(end_reason,'candidate-ended') WHERE id=?",
        )
        .run(new Date(now()).toISOString(), row.id);
      let cleanupPending = false;
      try {
        await options.recording?.stopSession(row.id).catch(() => {});
        await getAdapter().deleteRoom(row.room_name);
        store.db
          .prepare(
            "UPDATE screening_live_sessions SET room_closed=1 WHERE id=?",
          )
          .run(row.id);
      } catch {
        cleanupPending = true;
      }
      res.json({
        cleanupPending,
        item: publicSession(
          store,
          store.db
            .prepare("SELECT * FROM screening_live_sessions WHERE id=?")
            .get(row.id) as Session,
        ),
      });
    }),
  );
  app.get(
    "/api/screenings/:id/responses/:responseId/live",
    route((req, res) => {
      const user = sessionUser(store, req);
      if (!user) return fail(401, "Sign in to review interviews.");
      const response = store.db
        .prepare(
          "SELECT publication_id,answers,live_session_id FROM screening_responses WHERE id=? AND screening_id=? AND workspace_id=?",
        )
        .get(
          String(req.params.responseId),
          String(req.params.id),
          user.workspaceId,
        );
      if (!response) return fail(404, "Screening response not found.");
      const rows = store.db
        .prepare(
          "SELECT * FROM screening_live_sessions WHERE publication_id=? AND workspace_id=? ORDER BY created_at",
        )
        .all(response.publication_id, user.workspaceId) as Session[];
      const submittedSessions = new Set(
        (
          JSON.parse(String(response.answers)) as Array<{
            liveEvidence?: { sessionId?: string };
          }>
        ).flatMap((answer) =>
          answer.liveEvidence?.sessionId ? [answer.liveEvidence.sessionId] : [],
        ),
      );
      if (response.live_session_id)
        submittedSessions.add(String(response.live_session_id));
      res.setHeader("Cache-Control", "no-store");
      res.json({
        items: rows
          .filter((row) => submittedSessions.has(row.id))
          .map((row) => publicSession(store, row)),
      });
    }),
  );
  return {
    expireSessions,
    start() {
      if (timer) return;
      void expireSessions().catch(() => {});
      timer = setInterval(() => {
        void expireSessions().catch(() => {});
      }, 15_000);
      timer.unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await running;
      store.db
        .prepare(
          `UPDATE screening_live_sessions SET state='ended',ended_at=?,end_reason='server-stopped' WHERE state IN ${ACTIVE}`,
        )
        .run(new Date(now()).toISOString());
      await expireSessions();
    },
  };
}
/** Evidence remains attributable even when candidates correct the transcription before submitting. */
export function liveSubmissionEvidence(
  store: Store,
  publicationId: string,
  workspaceId: string,
  sessionId: string,
) {
  const exists = store.db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='screening_live_sessions'",
    )
    .get();
  if (!exists) throw new Error("Live interview evidence is unavailable.");
  const session = store.db
    .prepare(
      "SELECT * FROM screening_live_sessions WHERE id=? AND publication_id=? AND workspace_id=? AND state IN ('ended','failed')",
    )
    .get(sessionId, publicationId, workspaceId) as Session | undefined;
  if (!session)
    throw new Error("End the live interview before submitting your responses.");
  const answers = store.db
    .prepare(
      "SELECT question_id,text,created_at FROM screening_live_events WHERE session_id=? AND kind IN ('answer','followup-answer') ORDER BY sequence",
    )
    .all(session.id);
  const followUps = store.db
    .prepare(
      "SELECT question_id,text,created_at FROM screening_live_events WHERE session_id=? AND kind='followup-question' ORDER BY sequence",
    )
    .all(session.id)
    .map((question) => {
      const response = store.db
        .prepare(
          "SELECT kind,text,created_at FROM screening_live_events WHERE session_id=? AND question_id=? AND kind IN ('followup-answer','followup-skip') ORDER BY sequence LIMIT 1",
        )
        .get(session.id, question.question_id);
      return {
        questionId: String(question.question_id),
        question: String(question.text),
        answer:
          response?.kind === "followup-answer" ? String(response.text) : null,
        skipped: response?.kind === "followup-skip",
        askedAt: String(question.created_at),
        answeredAt: response ? String(response.created_at) : null,
      };
    });
  return {
    sessionId: session.id,
    consentAt: session.consent_at,
    endedAt: session.ended_at,
    followUps,
    answers: answers.map((answer) => ({
      questionId: String(answer.question_id),
      text: String(answer.text),
      transcribedAt: String(answer.created_at),
    })),
  };
}
