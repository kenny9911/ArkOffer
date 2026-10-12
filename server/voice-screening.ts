import { randomUUID } from "node:crypto";
import type { Express, Request, Response, NextFunction } from "express";
import multer from "multer";
import { z } from "zod";
import { hashToken } from "./auth.js";
import type { Store } from "./db.js";

export type VoiceScreeningOptions = {
  apiKey?: string;
  allowedWorkspaceIds?: string[];
  transcriptionModel?: string;
  transcriptionBaseUrl?: string;
  generateClarification?: (input: {
    workspaceId: string;
    question: string;
    answer: string;
    signal: AbortSignal;
  }) => Promise<string | null>;
  fetchImpl?: typeof fetch;
};
const MAX_SECONDS = 120;
const MAX_BYTES = 44 + 16_000 * 2 * MAX_SECONDS;
type Publication = { id: string; workspace_id: string; snapshot: string };
class VoiceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const fail = (status: number, message: string): never => {
  throw new VoiceError(status, message);
};
const route =
  (handler: (req: Request, res: Response) => Promise<unknown> | unknown) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve()
      .then(() => handler(req, res))
      .catch((error) => {
        if (error instanceof VoiceError)
          res.status(error.status).json({ error: error.message });
        else if (error instanceof z.ZodError)
          res.status(400).json({
            error: error.issues[0]?.message || "Invalid voice request.",
          });
        else next(error);
      });
  };

/** Only canonical mono 16kHz PCM WAV is accepted: duration is verified from bytes, never client metadata. */
export function voiceWavDuration(audio: Buffer) {
  if (
    audio.length < 44 ||
    audio.length > MAX_BYTES ||
    audio.toString("ascii", 0, 4) !== "RIFF" ||
    audio.readUInt32LE(4) !== audio.length - 8 ||
    audio.toString("ascii", 8, 12) !== "WAVE" ||
    audio.toString("ascii", 12, 16) !== "fmt " ||
    audio.readUInt32LE(16) !== 16 ||
    audio.readUInt16LE(20) !== 1 ||
    audio.readUInt16LE(22) !== 1 ||
    audio.readUInt32LE(24) !== 16000 ||
    audio.readUInt32LE(28) !== 32000 ||
    audio.readUInt16LE(32) !== 2 ||
    audio.readUInt16LE(34) !== 16 ||
    audio.toString("ascii", 36, 40) !== "data" ||
    audio.readUInt32LE(40) !== audio.length - 44 ||
    (audio.length - 44) % 2 !== 0
  )
    return fail(
      400,
      "Record a supported voice answer of no more than two minutes.",
    );
  const durationMs = (audio.length - 44) / 32;
  if (durationMs < 500)
    return fail(400, "Record at least half a second before transcribing.");
  return durationMs;
}

/** Register after screening tables and origin middleware, before session-only middleware. */
export function registerVoiceScreening(
  app: Express,
  store: Store,
  options: VoiceScreeningOptions = {},
) {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  const providerFetch = options.fetchImpl || fetch;
  const baseUrl = new URL(
    options.transcriptionBaseUrl ||
      process.env.OPENAI_TRANSCRIPTION_BASE_URL ||
      "https://api.openai.com/v1",
  );
  if (
    baseUrl.protocol !== "https:" ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash
  )
    throw new Error(
      "Voice transcription requires an HTTPS API base URL without credentials, query or fragment.",
    );
  const transcriptionUrl = `${baseUrl.toString().replace(/\/$/, "")}/audio/transcriptions`;
  const allowed = (workspaceId: string) =>
    Boolean(apiKey) &&
    (
      options.allowedWorkspaceIds ??
      (process.env.OPENAI_WORKSPACE_IDS || "").split(",").map((id) => id.trim())
    ).includes(workspaceId);
  store.db.exec(`CREATE TABLE IF NOT EXISTS screening_voice_turns (
    id TEXT PRIMARY KEY, publication_id TEXT NOT NULL REFERENCES screening_publications(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, question_id TEXT NOT NULL,
    request_id TEXT NOT NULL, state TEXT NOT NULL, transcript TEXT, duration_ms INTEGER NOT NULL,
    created_at INTEGER NOT NULL, consent_at TEXT NOT NULL, transcribed_at TEXT,
    parent_turn_id TEXT, followup_prompt TEXT, clarification_attempted INTEGER NOT NULL DEFAULT 0,
    UNIQUE(publication_id, request_id)
  ); CREATE INDEX IF NOT EXISTS screening_voice_usage ON screening_voice_turns(workspace_id, created_at);
  CREATE INDEX IF NOT EXISTS screening_voice_publication ON screening_voice_turns(publication_id, question_id);`);
  const columns = store.db
    .prepare("PRAGMA table_info(screening_voice_turns)")
    .all();
  for (const [name, type] of [
    ["parent_turn_id", "TEXT"],
    ["followup_prompt", "TEXT"],
    ["clarification_attempted", "INTEGER NOT NULL DEFAULT 0"],
  ])
    if (!columns.some((column) => column.name === name))
      store.db.exec(
        `ALTER TABLE screening_voice_turns ADD COLUMN ${name} ${type}`,
      );
  const publication = (req: Request): Publication => {
    const token = String(req.params.token || "");
    if (!/^[a-f0-9]{64}$/.test(token))
      return fail(404, "This screening link is unavailable or has expired.");
    const row = store.db
      .prepare(
        `SELECT p.id, p.workspace_id, p.snapshot FROM screening_publications p
      JOIN resources r ON r.id = p.screening_id AND r.workspace_id = p.workspace_id AND r.kind = 'screenings'
      WHERE p.token_hash = ? AND p.expires_at > ? AND p.revoked_at IS NULL`,
      )
      .get(hashToken(token), Date.now()) as Publication | undefined;
    if (!row)
      return fail(404, "This screening link is unavailable or has expired.");
    if (
      store.db
        .prepare("SELECT id FROM screening_responses WHERE publication_id = ?")
        .get(row.id)
    )
      return fail(
        409,
        "This questionnaire is complete. Ask the hiring team for a new link.",
      );
    return row;
  };
  app.get(
    "/api/interviews/:token/voice",
    route((req, res) => {
      const row = publication(req);
      res.json({
        available: allowed(row.workspace_id),
        maxSeconds: MAX_SECONDS,
        maxAttemptsPerQuestion: 3,
        mode: "guided",
        provider:
          baseUrl.hostname === "api.openai.com"
            ? "OpenAI"
            : "the hiring team's transcription provider",
        clarification: Boolean(options.generateClarification),
        audioRetention: "not-stored",
      });
    }),
  );
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: MAX_BYTES,
      files: 1,
      fields: 4,
      fieldSize: 200,
      parts: 5,
    },
  }).single("audio");
  // Keep authorization before upload parsing so invalid public links cannot allocate audio buffers.
  app.post(
    "/api/interviews/:token/voice/transcriptions",
    (req, res, next) => {
      try {
        const row = publication(req);
        if (!allowed(row.workspace_id))
          return fail(
            503,
            "Voice transcription is not enabled for this hiring team. You can type your answers.",
          );
        next();
      } catch (error) {
        if (error instanceof VoiceError)
          res.status(error.status).json({ error: error.message });
        else next(error);
      }
    },
    (req, res, next) =>
      upload(req, res, (error) => {
        if (error)
          res.status(400).json({
            error: "Use one voice recording of no more than two minutes.",
          });
        else next();
      }),
    route(async (req, res) => {
      const row = publication(req);
      if (!allowed(row.workspace_id))
        return fail(
          503,
          "Voice transcription is not enabled for this hiring team. You can type your answers.",
        );
      const input = z
        .object({
          questionId: z.string().uuid(),
          requestId: z.string().uuid(),
          consent: z.literal("true"),
          parentTurnId: z.string().uuid().optional(),
        })
        .strict()
        .parse(req.body);
      const questions = JSON.parse(row.snapshot).questions as {
        id: string;
        type: string;
        prompt: string;
      }[];
      if (
        !questions.some((q) => q.id === input.questionId && q.type === "text")
      )
        return fail(
          400,
          "Voice answers must belong to a published text question.",
        );
      if (!req.file || req.file.mimetype !== "audio/wav")
        return fail(400, "A WAV voice recording is required.");
      const parent = input.parentTurnId
        ? store.db
            .prepare(
              `SELECT * FROM screening_voice_turns
        WHERE id = ? AND publication_id = ? AND workspace_id = ? AND question_id = ?
        AND state = 'complete' AND parent_turn_id IS NULL AND followup_prompt IS NOT NULL`,
            )
            .get(input.parentTurnId, row.id, row.workspace_id, input.questionId)
        : undefined;
      if (input.parentTurnId && (!parent || !parent.transcript))
        return fail(
          400,
          "This follow-up is unavailable. Record a new answer or type your response.",
        );
      const durationMs = voiceWavDuration(req.file.buffer);
      const turnId = randomUUID(),
        timestamp = Date.now();
      // Reservations are durable and include failed attempts: public tokens cannot create an unbounded paid proxy.
      const existing = store.transaction(() => {
        store.db
          .prepare(
            "UPDATE screening_voice_turns SET state = 'failed', transcript = NULL WHERE state = 'pending' AND created_at < ?",
          )
          .run(timestamp - 120_000);
        store.db
          .prepare(
            `UPDATE screening_voice_turns SET transcript = NULL, followup_prompt = NULL
        WHERE transcript IS NOT NULL AND publication_id IN (
          SELECT id FROM screening_publications WHERE expires_at <= ? OR revoked_at IS NOT NULL)
        AND publication_id NOT IN (SELECT publication_id FROM screening_responses)`,
          )
          .run(timestamp);
        const previous = store.db
          .prepare(
            "SELECT * FROM screening_voice_turns WHERE publication_id = ? AND request_id = ?",
          )
          .get(row.id, input.requestId);
        if (previous) {
          if (
            previous.question_id !== input.questionId ||
            (previous.parent_turn_id || null) !== (input.parentTurnId || null)
          )
            return fail(
              409,
              "This voice request was already used for another question.",
            );
          if (previous.state === "complete" && previous.transcript)
            return previous;
          return fail(
            409,
            "This recording is already processing or was used. Record a new answer to retry.",
          );
        }
        if (
          store.db
            .prepare(
              "SELECT id FROM screening_voice_turns WHERE publication_id = ? AND state = 'pending'",
            )
            .get(row.id)
        )
          return fail(
            409,
            "Wait for the current recording to finish transcribing.",
          );
        const count = (sql: string, ...args: (string | number)[]) =>
          Number(store.db.prepare(sql).get(...args)!.count);
        if (
          count(
            "SELECT COUNT(*) AS count FROM screening_voice_turns WHERE publication_id = ? AND question_id = ?",
            row.id,
            input.questionId,
          ) >= 3 ||
          count(
            "SELECT COUNT(*) AS count FROM screening_voice_turns WHERE publication_id = ?",
            row.id,
          ) >= 60
        )
          return fail(
            429,
            "The voice recording limit for this link has been reached. You can still type your answer.",
          );
        if (
          count(
            "SELECT COUNT(*) AS count FROM screening_voice_turns WHERE workspace_id = ? AND created_at > ?",
            row.workspace_id,
            timestamp - 3_600_000,
          ) >= 120
        )
          return fail(
            429,
            "Voice transcription is busy for this team. Please type your answer or try later.",
          );
        if (
          parent &&
          store.db
            .prepare(
              "SELECT id FROM screening_voice_turns WHERE parent_turn_id = ?",
            )
            .get(parent.id)
        )
          return fail(
            409,
            "This follow-up has already been recorded. You can edit your answer below.",
          );
        store.db
          .prepare(
            `INSERT INTO screening_voice_turns(id, publication_id, workspace_id, question_id, request_id, state, duration_ms, created_at, consent_at, parent_turn_id)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
          )
          .run(
            turnId,
            row.id,
            row.workspace_id,
            input.questionId,
            input.requestId,
            durationMs,
            timestamp,
            new Date(timestamp).toISOString(),
            input.parentTurnId || null,
          );
        return undefined;
      });
      if (existing)
        return res.json({
          turnId: existing.id,
          text: existing.transcript,
          durationMs: existing.duration_ms,
          followup: existing.followup_prompt || null,
        });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 45_000);
      const abort = () => {
        if (!res.writableEnded) controller.abort();
      };
      res.on("close", abort);
      try {
        const body = new FormData();
        body.append(
          "file",
          new Blob([new Uint8Array(req.file.buffer)], { type: "audio/wav" }),
          "answer.wav",
        );
        body.append(
          "model",
          options.transcriptionModel ||
            process.env.OPENAI_TRANSCRIPTION_MODEL ||
            "gpt-4o-mini-transcribe",
        );
        body.append("response_format", "json");
        const response = await providerFetch(transcriptionUrl, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}` },
          body,
          signal: controller.signal,
        });
        if (!response.ok) {
          void response.body?.cancel();
          return fail(
            502,
            "The transcription service could not process your answer. Try again or type your response.",
          );
        }
        const reader = response.body?.getReader();
        if (!reader)
          return fail(502, "The transcription service returned no transcript.");
        let size = 0;
        const chunks: Uint8Array[] = [];
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 65_536) {
            await reader.cancel();
            return fail(
              502,
              "The transcript was too large. Please type your response.",
            );
          }
          chunks.push(chunk.value);
        }
        let payload: unknown;
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          return fail(
            502,
            "The transcription service returned an invalid transcript.",
          );
        }
        const parsed = z
          .object({ text: z.string().trim().min(1).max(10_000) })
          .safeParse(payload);
        if (!parsed.success)
          return fail(
            502,
            "No usable transcript was returned. Please try again or type your response.",
          );
        // Revalidate expiry/revocation/deletion/completion and operator access after external work.
        publication(req);
        if (!allowed(row.workspace_id) || controller.signal.aborted)
          return fail(
            409,
            "Voice transcription was interrupted. You can type your response.",
          );
        let followup: string | null = null;
        if (
          !parent &&
          options.generateClarification &&
          !store.db
            .prepare(
              "SELECT id FROM screening_voice_turns WHERE publication_id = ? AND question_id = ? AND clarification_attempted = 1",
            )
            .get(row.id, input.questionId)
        ) {
          store.db
            .prepare(
              "UPDATE screening_voice_turns SET clarification_attempted = 1 WHERE id = ?",
            )
            .run(turnId);
          try {
            const generated = await options.generateClarification({
              workspaceId: row.workspace_id,
              question: questions.find(
                (question) => question.id === input.questionId,
              )!.prompt,
              answer: parsed.data.text,
              signal: controller.signal,
            });
            if (
              typeof generated === "string" &&
              generated.trim() &&
              generated.trim().length <= 2000
            )
              followup = generated.trim();
          } catch {
            /* Transcription remains useful when optional clarification is unavailable. */
          }
          publication(req);
          if (!allowed(row.workspace_id) || controller.signal.aborted)
            return fail(
              409,
              "Voice transcription was interrupted. You can type your response.",
            );
        }
        const transcript = parent
          ? `${parent.transcript}\n\nFollow-up: ${parent.followup_prompt}\n${parsed.data.text}`
          : parsed.data.text;
        if (transcript.length > 10_000)
          return fail(
            502,
            "The combined transcript is too long. Please type your response.",
          );
        const evidenceDuration =
          durationMs + (parent ? Number(parent.duration_ms) : 0);
        const result = store.db
          .prepare(
            "UPDATE screening_voice_turns SET state = 'complete', transcript = ?, transcribed_at = ?, followup_prompt = ?, duration_ms = ? WHERE id = ? AND state = 'pending'",
          )
          .run(
            transcript,
            new Date().toISOString(),
            followup,
            evidenceDuration,
            turnId,
          );
        if (result.changes !== 1)
          return fail(
            409,
            "This recording was cancelled. You can record a new answer.",
          );
        res.status(201).json({
          turnId,
          text: transcript,
          durationMs: evidenceDuration,
          followup,
          ...(parent
            ? {
                answerText: parsed.data.text,
                followupAnswered: parent.followup_prompt,
              }
            : {}),
        });
      } catch (error) {
        store.db
          .prepare(
            "UPDATE screening_voice_turns SET state = 'failed', transcript = NULL WHERE id = ? AND state = 'pending'",
          )
          .run(turnId);
        if (error instanceof VoiceError) throw error;
        return fail(
          502,
          "Voice transcription was interrupted. Please try again or type your response.",
        );
      } finally {
        clearTimeout(timeout);
        res.off("close", abort);
      }
    }),
  );
}
