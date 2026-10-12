import { randomBytes, randomUUID } from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";
import { z } from "zod";
import { hashToken, sessionUser } from "./auth.js";
import type { Store, Resource } from "./db.js";
import { liveSubmissionEvidence } from "./live-interviews.js";
import { screeningMessage } from "../shared/screening.js";
import { screeningConfigSchema } from "../shared/screening-schema.js";

const questionSchema = z
  .object({
    prompt: z.string().trim().min(1).max(2000),
    type: z.enum(["text", "yes-no", "multiple-choice"]),
    options: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
    required: z.boolean().default(true),
    followUp: z.boolean().optional(),
    sectionTitle: z.string().max(120).optional(),
  })
  .superRefine((question, context) => {
    if (
      question.type === "multiple-choice" &&
      (question.options.length < 2 ||
        new Set(question.options).size !== question.options.length)
    )
      context.addIssue({
        code: "custom",
        message: "Multiple-choice questions need 2–20 distinct answer options.",
      });
  });
const questionsSchema = z
  .array(questionSchema)
  .min(1, "Add at least one question before publishing.")
  .max(50);
const submissionSchema = z
  .object({
    candidateName: z.string().trim().min(1).max(120),
    email: z
      .string()
      .trim()
      .email()
      .max(254)
      .transform((value) => value.toLowerCase()),
    consent: z.literal(true, {
      error: "Acknowledge sharing your responses with the hiring team.",
    }),
    liveSessionId: z.uuid().optional(),
    voiceEvidence: z
      .array(
        z
          .object({
            questionId: z.string().uuid(),
            turnId: z.string().uuid(),
          })
          .strict(),
      )
      .max(50)
      .optional(),
    answers: z
      .array(
        z
          .object({
            questionId: z.string().max(100),
            value: z.string().max(10_000),
          })
          .strict(),
      )
      .max(50),
  })
  .strict();

type Question = z.infer<typeof questionSchema> & { id: string };
type Snapshot = {
  title: string;
  description: string;
  workspaceName: string;
  questions: Question[];
  setup?: {
    welcomeMessage: string;
    completionMessage: string;
    language: string;
    voice: string;
    interviewMode?: "questionnaire" | "live";
    cameraPolicy?: "required" | "optional" | "off";
  };
};
type Publication = {
  id: string;
  screening_id: string;
  workspace_id: string;
  snapshot: string;
  token_hash: string;
  expires_at: number;
  created_at: string;
  revoked_at: string | null;
};
export class ScreeningError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const fail = (status: number, message: string): never => {
  throw new ScreeningError(status, message);
};
const parameter = (req: Request, name: string) =>
  String(req.params[name] || "");
const route =
  (handler: (req: Request, res: Response) => unknown) =>
  (req: Request, res: Response, next: NextFunction) => {
    try {
      handler(req, res);
    } catch (error) {
      if (error instanceof ScreeningError)
        res.status(error.status).json({ error: error.message });
      else if (error instanceof z.ZodError)
        res.status(400).json({
          error: error.issues[0]?.message || "Invalid questionnaire data.",
        });
      else next(error);
    }
  };

export function buildScreeningSnapshot(
  screening: Resource,
  workspaceName: string,
) {
  const config =
    screening.screeningConfig === undefined
      ? undefined
      : screeningConfigSchema.parse(screening.screeningConfig);
  const questions = questionsSchema
    .parse(screening.questions)
    .map((question) => ({
      ...question,
      options: question.type === "multiple-choice" ? question.options : [],
      id: randomUUID(),
    }));
  const snapshot: Snapshot = {
    title: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .parse(screening.title || screening.name),
    description: z
      .string()
      .max(5000)
      .parse(screening.description || ""),
    workspaceName: workspaceName,
    questions,
    ...(config
      ? {
          setup: {
            ...config.setup,
            welcomeMessage: screeningMessage(
              config.setup.welcomeMessage,
              String(screening.title || screening.name),
              workspaceName,
            ),
            completionMessage: screeningMessage(
              config.setup.completionMessage,
              String(screening.title || screening.name),
              workspaceName,
            ),
          },
        }
      : {}),
  };
  if (Buffer.byteLength(JSON.stringify(snapshot)) > 150_000)
    return fail(413, "The questionnaire is too large to publish.");
  return { snapshot, deadlineDays: config?.outreach.deadlineDays ?? 7 };
}

/** Register after the application's JSON/Origin middleware, before its session-only API middleware. */
export function registerScreening(
  app: Express,
  store: Store,
  options: {
    validateSnapshot?: (snapshot: Snapshot, workspaceId: string) => void;
  } = {},
) {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS screening_publications (
      id TEXT PRIMARY KEY,
      screening_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      snapshot TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS screening_publications_workspace ON screening_publications(workspace_id, screening_id);
    CREATE TABLE IF NOT EXISTS screening_responses (
      id TEXT PRIMARY KEY,
      publication_id TEXT NOT NULL UNIQUE REFERENCES screening_publications(id) ON DELETE CASCADE,
      screening_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      candidate_name TEXT NOT NULL,
      email TEXT NOT NULL,
      answers TEXT NOT NULL,
      submitted_at TEXT NOT NULL,
      consent_at TEXT NOT NULL,
      submission_hash TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS screening_responses_workspace ON screening_responses(workspace_id, screening_id);
  `);

  function authorize(req: Request, ownerOnly = false) {
    const user = sessionUser(store, req);
    if (!user) return fail(401, "Sign in to manage screenings.");
    if (ownerOnly && user.role !== "owner")
      return fail(
        403,
        "Only a workspace owner can publish or revoke candidate links.",
      );
    const screening = store.get(
      user.workspaceId,
      "screenings",
      parameter(req, "id"),
    );
    if (!screening) return fail(404, "Screening not found.");
    return { user, screening };
  }
  function publication(req: Request): Publication {
    const token = parameter(req, "token");
    if (!/^[a-f0-9]{64}$/.test(token))
      return fail(404, "This screening link is unavailable or has expired.");
    // Join the resource identity as a second workspace/type boundary, including after deletion.
    const row = store.db
      .prepare(
        `SELECT p.* FROM screening_publications p JOIN resources r
      ON r.id = p.screening_id AND r.workspace_id = p.workspace_id AND r.kind = 'screenings'
      WHERE p.token_hash = ? AND p.expires_at > ? AND p.revoked_at IS NULL`,
      )
      .get(hashToken(token), Date.now()) as Publication | undefined;
    if (!row)
      return fail(404, "This screening link is unavailable or has expired.");
    return row;
  }

  app.post(
    "/api/screenings/:id/publish",
    route((req, res) => {
      const { user, screening } = authorize(req, true);
      const { snapshot, deadlineDays } = buildScreeningSnapshot(
        screening,
        user.workspaceName,
      );
      options.validateSnapshot?.(snapshot, user.workspaceId);
      const active = store.db
        .prepare(
          "SELECT COUNT(*) AS count FROM screening_publications WHERE screening_id = ? AND workspace_id = ? AND expires_at > ? AND revoked_at IS NULL",
        )
        .get(screening.id, user.workspaceId, Date.now())!;
      if (Number(active.count) >= 100)
        return fail(
          409,
          "This screening already has 100 active links. Revoke unused links before creating more.",
        );
      const token = randomBytes(32).toString("hex");
      const id = randomUUID(),
        createdAt = new Date().toISOString(),
        expiresAt = Date.now() + deadlineDays * 86400000;
      store.db
        .prepare(
          "INSERT INTO screening_publications (id, screening_id, workspace_id, token_hash, snapshot, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          id,
          screening.id,
          user.workspaceId,
          hashToken(token),
          JSON.stringify(snapshot),
          expiresAt,
          createdAt,
        );
      res.status(201).json({
        item: {
          id,
          token,
          url: `/interviews/${token}`,
          createdAt,
          expiresAt: new Date(expiresAt).toISOString(),
        },
      });
    }),
  );

  app.get(
    "/api/interviews/:token",
    route((req, res) => {
      const row = publication(req);
      if (
        store.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='screening_invitations'",
          )
          .get()
      )
        store.db
          .prepare(
            "UPDATE screening_invitations SET opened_at=COALESCE(opened_at,?) WHERE publication_id=?",
          )
          .run(Date.now(), row.id);
      const submitted = !!store.db
        .prepare("SELECT id FROM screening_responses WHERE publication_id = ?")
        .get(row.id);
      res.setHeader("Referrer-Policy", "no-referrer");
      res.json({
        item: {
          ...(JSON.parse(row.snapshot) as Snapshot),
          expiresAt: new Date(row.expires_at).toISOString(),
        },
        submitted,
      });
    }),
  );

  app.post(
    "/api/interviews/:token/responses",
    route((req, res) => {
      const row = publication(req);
      if (Buffer.byteLength(JSON.stringify(req.body ?? {})) > 150_000)
        return fail(413, "Your answers are too long.");
      const input = submissionSchema.parse(req.body);
      const snapshot = JSON.parse(row.snapshot) as Snapshot;
      const byId = new Map(
        input.answers.map((answer) => [answer.questionId, answer.value.trim()]),
      );
      if (
        byId.size !== input.answers.length ||
        input.answers.some(
          (answer) =>
            !snapshot.questions.some(
              (question) => question.id === answer.questionId,
            ),
        )
      )
        return fail(
          400,
          "Answers must reference each published question at most once.",
        );
      const voiceEvidence = new Map(
        (input.voiceEvidence || []).map((item) => [
          item.questionId,
          item.turnId,
        ]),
      );
      if (
        voiceEvidence.size !== (input.voiceEvidence || []).length ||
        [...voiceEvidence.keys()].some(
          (id) =>
            !snapshot.questions.some(
              (question) => question.id === id && question.type === "text",
            ),
        )
      )
        return fail(
          400,
          "Voice evidence must reference each published text question at most once.",
        );
      if (
        voiceEvidence.size &&
        !store.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'screening_voice_turns'",
          )
          .get()
      )
        return fail(400, "Voice evidence is unavailable.");
      let live: ReturnType<typeof liveSubmissionEvidence> | undefined;
      if (input.liveSessionId) {
        try {
          live = liveSubmissionEvidence(
            store,
            row.id,
            row.workspace_id,
            input.liveSessionId,
          );
        } catch (error) {
          return fail(
            400,
            error instanceof Error
              ? error.message
              : "Invalid live interview evidence.",
          );
        }
      }
      const answers = snapshot.questions.map((question) => {
        const value = byId.get(question.id) || "";
        if (question.required && !value)
          return fail(400, `Answer the required question: ${question.prompt}`);
        if (
          value &&
          question.type !== "text" &&
          !(
            question.type === "yes-no" ? ["Yes", "No"] : question.options
          ).includes(value)
        )
          return fail(400, "Select one of the published answer options.");
        const turnId = voiceEvidence.get(question.id);
        const turn = turnId
          ? store.db
              .prepare(
                `SELECT transcript, duration_ms, consent_at, transcribed_at
          FROM screening_voice_turns WHERE id = ? AND publication_id = ? AND workspace_id = ? AND question_id = ? AND state = 'complete'`,
              )
              .get(turnId, row.id, row.workspace_id, question.id)
          : undefined;
        if (turnId && (!turn || !turn.transcript || !value))
          return fail(
            400,
            "Voice evidence is unavailable for this answer. Record again or submit a typed answer.",
          );
        return {
          questionId: question.id,
          prompt: question.prompt,
          type: question.type,
          value,
          ...(live &&
          live.answers.some((answer) => answer.questionId === question.id)
            ? {
                liveEvidence: {
                  sessionId: live.sessionId,
                  consentAt: live.consentAt,
                  endedAt: live.endedAt,
                  originalTranscript: live.answers
                    .filter((answer) => answer.questionId === question.id)
                    .map((answer) => answer.text)
                    .join("\n"),
                  candidateEdited:
                    value !==
                    live.answers
                      .filter((answer) => answer.questionId === question.id)
                      .map((answer) => answer.text)
                      .join("\n")
                      .trim(),
                  source: "live-interview-transcription",
                },
              }
            : {}),
          ...(turn
            ? {
                voiceEvidence: {
                  originalTranscript: turn.transcript,
                  durationMs: turn.duration_ms,
                  consentAt: turn.consent_at,
                  transcribedAt: turn.transcribed_at,
                  candidateEdited: value !== String(turn.transcript).trim(),
                  source: "voice-transcription",
                },
              }
            : {}),
        };
      });
      const submittedAt = new Date().toISOString();
      const submissionHash = hashToken(
        JSON.stringify({
          candidateName: input.candidateName,
          email: input.email,
          answers,
        }),
      );
      const existing = store.db
        .prepare(
          "SELECT submission_hash FROM screening_responses WHERE publication_id = ?",
        )
        .get(row.id);
      if (existing) {
        if (existing.submission_hash !== submissionHash)
          return fail(
            409,
            "This link has already received a response. Ask the hiring team for a new link to submit again.",
          );
        res.json({ ok: true, alreadySubmitted: true });
        return;
      }
      store.db
        .prepare(
          `INSERT INTO screening_responses (id, publication_id, screening_id, workspace_id, candidate_name, email, answers, submitted_at, consent_at, submission_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          row.id,
          row.screening_id,
          row.workspace_id,
          input.candidateName,
          input.email,
          JSON.stringify(answers),
          submittedAt,
          submittedAt,
          submissionHash,
        );
      res.status(201).json({ ok: true, alreadySubmitted: false });
    }),
  );

  app.get(
    "/api/screenings/:id/responses",
    route((req, res) => {
      const { user, screening } = authorize(req);
      const responses = store.db
        .prepare(
          `SELECT id, publication_id, candidate_name, email, answers, submitted_at, consent_at
      FROM screening_responses WHERE screening_id = ? AND workspace_id = ? ORDER BY submitted_at DESC`,
        )
        .all(screening.id, user.workspaceId);
      const links = store.db
        .prepare(
          `SELECT p.id, p.created_at, p.expires_at, p.revoked_at, r.submitted_at FROM screening_publications p
      LEFT JOIN screening_responses r ON r.publication_id = p.id WHERE p.screening_id = ? AND p.workspace_id = ? ORDER BY p.created_at DESC`,
        )
        .all(screening.id, user.workspaceId);
      res.json({
        items: responses.map((row) => ({
          id: row.id,
          publicationId: row.publication_id,
          candidateName: row.candidate_name,
          email: row.email,
          answers: JSON.parse(row.answers as string),
          submittedAt: row.submitted_at,
          consentAt: row.consent_at,
        })),
        publications: links.map((row) => ({
          id: row.id,
          createdAt: row.created_at,
          expiresAt: new Date(row.expires_at as number).toISOString(),
          revokedAt: row.revoked_at,
          submittedAt: row.submitted_at || null,
          status: row.revoked_at
            ? "revoked"
            : Number(row.expires_at) <= Date.now()
              ? "expired"
              : row.submitted_at
                ? "completed"
                : "active",
        })),
      });
    }),
  );

  app.delete(
    "/api/screenings/:id/publications/:publicationId",
    route((req, res) => {
      const { user, screening } = authorize(req, true);
      const row = store.db
        .prepare(
          "SELECT id FROM screening_publications WHERE id = ? AND screening_id = ? AND workspace_id = ?",
        )
        .get(parameter(req, "publicationId"), screening.id, user.workspaceId);
      if (!row) return fail(404, "Candidate link not found.");
      store.db
        .prepare(
          "UPDATE screening_publications SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?",
        )
        .run(new Date().toISOString(), row.id);
      res.json({ ok: true });
    }),
  );
}
