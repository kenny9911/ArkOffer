import { randomUUID } from "node:crypto";
import type { Express, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { sessionUser } from "./auth.js";
import type { Store, Resource } from "./db.js";
import { newScreeningConfig } from "../shared/screening.js";
import { screeningConfigSchema } from "../shared/screening-schema.js";

const inputSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    description: z.string().max(5000),
    jobId: z.union([z.uuid(), z.literal("")]).default(""),
    screeningConfig: screeningConfigSchema,
    revision: z.string().optional(),
  })
  .strict();
class WorkspaceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
function fail(status: number, message: string): never {
  throw new WorkspaceError(status, message);
}
const route =
  (handler: (req: Request, res: Response) => unknown) =>
  (req: Request, res: Response, next: NextFunction) => {
    try {
      handler(req, res);
    } catch (error) {
      if (error instanceof WorkspaceError)
        res.status(error.status).json({ error: error.message });
      else if (error instanceof z.ZodError)
        res.status(400).json({
          error: error.issues[0]?.message || "Invalid screening configuration.",
        });
      else next(error);
    }
  };

/** A legacy questionnaire remains editable without rewriting its published snapshots. */
export function screeningWorkspaceView(item: Resource) {
  const parsed = screeningConfigSchema.safeParse(item.screeningConfig);
  const config = parsed.success ? parsed.data : newScreeningConfig();
  if (!parsed.success) {
    config.sections[0].questions = (
      Array.isArray(item.questions) ? item.questions : []
    )
      .slice(0, 50)
      .map((question: Record<string, unknown>) => ({
        id:
          typeof question.id === "string" &&
          z.uuid().safeParse(question.id).success
            ? question.id
            : randomUUID(),
        prompt:
          typeof question.prompt === "string"
            ? question.prompt.slice(0, 2000)
            : "",
        type:
          question.type === "yes-no" || question.type === "multiple-choice"
            ? question.type
            : "text",
        options: Array.isArray(question.options)
          ? question.options
              .filter((value): value is string => typeof value === "string")
              .slice(0, 20)
          : [],
        required: question.required !== false,
        rubric:
          typeof question.rubric === "string"
            ? question.rubric.slice(0, 2000)
            : "",
        followUp: question.followUp !== false,
      }));
  }
  return {
    ...item,
    title: item.title || item.name,
    description: item.description || "",
    jobId: item.jobId || "",
    screeningConfig: config,
  };
}

export function registerScreeningWorkspaces(app: Express, store: Store) {
  const auth = (req: Request) =>
    sessionUser(store, req) || fail(401, "Sign in to manage screenings.");
  app.get(
    "/api/screening-workspaces",
    route((req, res) => {
      const user = auth(req);
      res.json({
        items: store
          .list(user.workspaceId, "screenings")
          .map(screeningWorkspaceView),
      });
    }),
  );
  app.get(
    "/api/screening-workspaces/:id",
    route((req, res) => {
      const user = auth(req);
      const item =
        store.get(user.workspaceId, "screenings", String(req.params.id)) ||
        fail(404, "Screening not found.");
      res.json({ item: screeningWorkspaceView(item) });
    }),
  );
  const save = (req: Request, res: Response) => {
    const user = auth(req),
      input = inputSchema.parse(req.body);
    if (input.jobId && !store.get(user.workspaceId, "jobs", input.jobId))
      fail(404, "The selected job is unavailable in this workspace.");
    const item = store.transaction(() => {
      const prior = req.params.id
        ? store.get(user.workspaceId, "screenings", String(req.params.id))
        : undefined;
      if (req.params.id && !prior) fail(404, "Screening not found.");
      if (
        !prior &&
        Number(
          store.db
            .prepare(
              "SELECT COUNT(*) AS total FROM resources WHERE workspace_id=? AND kind='screenings'",
            )
            .get(user.workspaceId)?.total,
        ) >= 1000
      )
        fail(
          409,
          "This workspace has reached its 1,000 screening limit. Delete unused drafts before creating another.",
        );
      if (prior && input.revision !== prior.updatedAt)
        fail(
          409,
          "This screening changed in another window. Reload the saved draft before editing again.",
        );
      const now = new Date().toISOString();
      const record = {
        ...prior,
        name: input.title,
        title: input.title,
        description: input.description,
        jobId: input.jobId,
        screeningConfig: input.screeningConfig,
        questions: input.screeningConfig.sections.flatMap((section) =>
          section.questions.map((question) => ({
            ...question,
            sectionTitle: section.title,
          })),
        ),
        status: "draft",
        id: prior?.id || randomUUID(),
        createdAt: prior?.createdAt || now,
        updatedAt: now,
      };
      if (Buffer.byteLength(JSON.stringify(record)) > 150_000)
        fail(
          413,
          "The screening draft is too large. Shorten its context or questions.",
        );
      return prior
        ? store.update(user.workspaceId, "screenings", record)
        : store.insert(user.workspaceId, "screenings", record);
    });
    res
      .status(req.params.id ? 200 : 201)
      .json({ item: screeningWorkspaceView(item) });
  };
  app.post("/api/screening-workspaces", route(save));
  app.patch("/api/screening-workspaces/:id", route(save));
}
