import { randomUUID } from "node:crypto";
import type { Express, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { sessionUser, userById, type AuthRequest, type User } from "./auth.js";
import type { Store } from "./db.js";
import { mayReadConversation } from "./access.js";

export type Citation = {
  conversationId: string;
  title: string;
  text: string;
  start: number;
  end: number;
};
export type KnowledgeOptions = {
  mode?: string;
  complete?: (
    user: User,
    evidence: Citation[],
    question: string,
  ) => Promise<string | null>;
};
class KnowledgeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const fail = (status: number, message: string): never => {
  throw new KnowledgeError(status, message);
};

export type KnowledgeAnswer = {
  answer: string;
  citations: Citation[];
  mode: string;
};
const noMatch =
  "No matching excerpts were found in the conversations you can access. Try a specific phrase from a transcript.";
const limitNotice =
  "\n\nSearch reached its workspace limit. Select a specific source conversation to search older material.";
const proofSchema = z
  .object({
    answer: z.string().min(1).max(21_000),
    mode: z.string().min(1).max(50),
    citations: z
      .array(
        z
          .object({
            conversationId: z.uuid(),
            title: z.string().max(10_000),
            text: z.string().min(1).max(900),
            start: z.number().int().min(0).max(800_000),
            end: z.number().int().min(1).max(800_000),
          })
          .strict(),
      )
      .max(12),
  })
  .strict();

/** Shared retrieval and source proof validation for web and explicitly authorized delivery adapters. */
export function createKnowledgeEngine(
  store: Store,
  options: KnowledgeOptions = {},
) {
  function validateAnswer(user: User, result: unknown): boolean {
    const active = userById(store, user.id, user.workspaceId);
    if (!active) return false;
    const parsed = proofSchema.safeParse(result);
    if (!parsed.success) return false;
    const proof = parsed.data;
    if (!proof.citations.length)
      return (
        proof.mode === "extractive" &&
        [noMatch, noMatch + limitNotice].includes(proof.answer)
      );
    const seen = new Set<string>();
    return proof.citations.every((citation) => {
      const key = `${citation.conversationId}:${citation.start}:${citation.end}`;
      if (
        seen.has(key) ||
        citation.end <= citation.start ||
        citation.end - citation.start !== citation.text.length
      )
        return false;
      seen.add(key);
      if (!mayReadConversation(store, active, citation.conversationId))
        return false;
      const item = store.get(
        active.workspaceId,
        "conversations",
        citation.conversationId,
      );
      return (
        !!item &&
        !item.archived &&
        String(item.title || "Conversation") === citation.title &&
        String(item.transcript || "").slice(citation.start, citation.end) ===
          citation.text
      );
    });
  }
  async function answer(
    user: User,
    rawQuestion: string,
    rawConversationIds?: string[],
  ): Promise<KnowledgeAnswer> {
    const question = z.string().trim().min(1).max(2000).parse(rawQuestion);
    const conversationIds = z
      .array(z.uuid())
      .max(50)
      .optional()
      .parse(rawConversationIds);
    const current =
      userById(store, user.id, user.workspaceId) ||
      fail(403, "Workspace access is unavailable.");
    const selectedIds = conversationIds?.length
      ? [...new Set(conversationIds)]
      : [];
    for (const id of selectedIds) {
      if (
        !mayReadConversation(store, current, id) ||
        store.get(current.workspaceId, "conversations", id)?.archived
      )
        fail(404, "A selected source is unavailable.");
    }
    // Stream IDs and sizes before parsing records; never load the entire transcript library.
    const records = store.db
      .prepare(
        `SELECT id,length(CAST(data AS BLOB)) AS bytes FROM resources
        WHERE workspace_id=? AND kind='conversations'
        ${selectedIds.length ? `AND id IN (${selectedIds.map(() => "?").join(",")})` : ""}
        ORDER BY updated_at DESC, rowid DESC`,
      )
      .iterate(current.workspaceId, ...selectedIds);
    const words = [
      ...new Set(question.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []),
    ]
      .filter(
        (word) =>
          ![
            "the",
            "and",
            "what",
            "which",
            "with",
            "from",
            "that",
            "this",
            "does",
            "have",
            "about",
            "how",
            "are",
            "was",
            "for",
            "tell",
            "across",
          ].includes(word),
      )
      .slice(0, 20);
    const ranked: Array<Citation & { score: number }> = [];
    // Bound total parsed source data, including rows that fail authorization.
    let remaining = 50_000_000,
      scanned = 0,
      limited = false;
    for (const row of records) {
      if (++scanned > 2000 || Number(row.bytes) > remaining) {
        limited = true;
        break;
      }
      remaining -= Number(row.bytes);
      const id = String(row.id);
      if (!mayReadConversation(store, current, id)) continue;
      const item = store.get(current.workspaceId, "conversations", id);
      if (!item || item.archived) continue;
      const transcript = String(item.transcript || "").slice(0, 800_000);
      if (!transcript.length) continue;
      const noteEvidence: Array<Citation & { score: number }> = [];
      for (const match of transcript.matchAll(/[^\n.!?]+[.!?]?/g)) {
        const raw = match[0],
          text = raw.trim();
        if (!text) continue;
        const start = (match.index || 0) + raw.indexOf(text);
        const clipped = text.slice(0, 900);
        const searchable = clipped.toLowerCase();
        const score = words.reduce(
          (sum, word) => sum + (searchable.includes(word) ? 1 : 0),
          0,
        );
        if (score) {
          noteEvidence.push({
            conversationId: item.id,
            title: String(item.title || "Conversation"),
            text: clipped,
            start,
            end: start + clipped.length,
            score,
          });
          noteEvidence.sort((a, b) => b.score - a.score);
          if (noteEvidence.length > 3) noteEvidence.pop();
        }
      }
      ranked.push(...noteEvidence);
      ranked.sort((a, b) => b.score - a.score);
      ranked.splice(12);
    }
    const citations = ranked.map(({ score, ...citation }) => citation);

    let mode = "extractive",
      answer = citations.length
        ? `Relevant conversation excerpts:\n\n${citations.map((c, i) => `[${i + 1}] ${c.title}: ${c.text}`).join("\n\n")}`
        : "No matching excerpts were found in the conversations you can access. Try a specific phrase from a transcript.";
    if (citations.length && options.complete) {
      const generated = await options.complete(current, citations, question);
      if (generated) {
        if (generated.length > 20_000)
          fail(
            502,
            "The provider answer exceeded the supported length. Please ask a narrower question.",
          );
        answer = generated;
        mode = options.mode || "openai";
      }
    }
    if (limited)
      answer +=
        "\n\nSearch reached its workspace limit. Select a specific source conversation to search older material.";

    const result = { answer, citations, mode };
    if (!validateAnswer(current, result))
      fail(409, "Source access changed while answering. Please try again.");
    return result;
  }
  return { answer, validateAnswer };
}

/** Answers belong to one user in one workspace. Source permissions are checked on every read. */
export function registerKnowledge(
  app: Express,
  store: Store,
  options: KnowledgeOptions = {},
  engine = createKnowledgeEngine(store, options),
) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS assistant_threads (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), user_id TEXT NOT NULL REFERENCES users(id),
    title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS assistant_threads_owner ON assistant_threads(workspace_id,user_id,updated_at);
    CREATE TABLE IF NOT EXISTS assistant_messages (
    id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES assistant_threads(id) ON DELETE CASCADE,
    question TEXT NOT NULL, answer TEXT NOT NULL, citations TEXT NOT NULL, mode TEXT NOT NULL, created_at TEXT NOT NULL);`);
  const thread = (user: User, id: string) =>
    store.db
      .prepare(
        "SELECT * FROM assistant_threads WHERE id=? AND workspace_id=? AND user_id=?",
      )
      .get(id, user.workspaceId, user.id) ||
    fail(404, "Conversation not found.");
  const view = (user: User, row: Record<string, unknown>) => {
    const citations = JSON.parse(String(row.citations)) as Citation[];
    if (
      !engine.validateAnswer(user, {
        answer: row.answer,
        citations,
        mode: row.mode,
      })
    )
      return {
        id: row.id,
        question: row.question,
        answer:
          "This answer is unavailable because a source changed or you no longer have access.",
        citations: [],
        mode: "unavailable",
        createdAt: row.created_at,
      };
    return {
      id: row.id,
      question: row.question,
      answer: row.answer,
      citations,
      mode: row.mode,
      createdAt: row.created_at,
    };
  };
  const route =
    (handler: (req: Request, res: Response) => unknown | Promise<unknown>) =>
    (req: Request, res: Response, next: NextFunction) =>
      Promise.resolve()
        .then(() => handler(req, res))
        .catch((e: unknown) => {
          if (e instanceof KnowledgeError)
            res.status(e.status).json({ error: e.message });
          else if (e instanceof z.ZodError)
            res
              .status(400)
              .json({ error: e.issues[0]?.message || "Invalid question." });
          else next(e);
        });
  const user = (req: AuthRequest) => req.user!;
  app.get(
    "/api/assistant/threads",
    route((req: AuthRequest, res: Response) =>
      res.json({
        items: store.db
          .prepare(
            "SELECT id,title,created_at AS createdAt,updated_at AS updatedAt FROM assistant_threads WHERE workspace_id=? AND user_id=? ORDER BY updated_at DESC LIMIT 100",
          )
          .all(user(req).workspaceId, user(req).id),
      }),
    ),
  );
  app.get(
    "/api/assistant/threads/:id",
    route((req: AuthRequest, res: Response) => {
      const item = thread(user(req), String(req.params.id));
      const messages = store.db
        .prepare(
          "SELECT * FROM assistant_messages WHERE thread_id=? ORDER BY created_at,rowid",
        )
        .all(item.id);
      res.json({
        item: { id: item.id, title: item.title },
        messages: messages.map((row) => view(user(req), row)),
      });
    }),
  );
  app.delete(
    "/api/assistant/threads/:id",
    route((req: AuthRequest, res: Response) => {
      const item = thread(user(req), String(req.params.id));
      store.db.prepare("DELETE FROM assistant_threads WHERE id=?").run(item.id);
      res.json({ ok: true });
    }),
  );
  const inFlight = new Set<string>();
  app.post(
    "/api/assistant/ask",
    route(async (req: AuthRequest, res: Response) => {
      const input = z
        .object({
          question: z.string().trim().min(1).max(2000),
          threadId: z.string().uuid().optional(),
          conversationIds: z.array(z.string().uuid()).max(50).optional(),
        })
        .strict()
        .parse(req.body);
      const current = user(req),
        key = `${current.workspaceId}:${current.id}`;
      if (inFlight.has(key))
        fail(409, "Wait for your current answer to finish.");
      const existing = input.threadId ? thread(current, input.threadId) : null;
      if (existing) {
        const count = store.db
          .prepare(
            "SELECT COUNT(*) AS n FROM assistant_messages WHERE thread_id=?",
          )
          .get(existing.id)!;
        if (Number(count.n) >= 100)
          fail(400, "Start a new conversation after 100 questions.");
      } else if (
        Number(
          store.db
            .prepare(
              "SELECT COUNT(*) AS n FROM assistant_threads WHERE workspace_id=? AND user_id=?",
            )
            .get(current.workspaceId, current.id)!.n,
        ) >= 100
      )
        fail(400, "Delete an old conversation before starting another.");
      inFlight.add(key);
      try {
        const result = await engine.answer(
          current,
          input.question,
          input.conversationIds,
        );
        const { answer, citations, mode } = result;
        // A provider call can outlive membership, note, or permission changes.
        const active = sessionUser(store, req);
        if (
          !active ||
          active.id !== current.id ||
          active.workspaceId !== current.workspaceId
        )
          fail(409, "Your session or workspace changed. Please try again.");
        if (!engine.validateAnswer(active!, result))
          fail(409, "Source access changed while answering. Please try again.");
        const id = existing ? String(existing.id) : randomUUID(),
          createdAt = new Date().toISOString(),
          message = {
            id: randomUUID(),
            question: input.question,
            answer,
            citations,
            mode,
            createdAt,
          };
        store.transaction(() => {
          if (existing) thread(current, id);
          else
            store.db
              .prepare(
                "INSERT INTO assistant_threads(id,workspace_id,user_id,title,created_at,updated_at) VALUES(?,?,?,?,?,?)",
              )
              .run(
                id,
                current.workspaceId,
                current.id,
                input.question.slice(0, 100),
                createdAt,
                createdAt,
              );
          store.db
            .prepare(
              "INSERT INTO assistant_messages(id,thread_id,question,answer,citations,mode,created_at) VALUES(?,?,?,?,?,?,?)",
            )
            .run(
              message.id,
              id,
              input.question,
              answer,
              JSON.stringify(citations),
              mode,
              createdAt,
            );
          store.db
            .prepare("UPDATE assistant_threads SET updated_at=? WHERE id=?")
            .run(createdAt, id);
        });
        res.json({ threadId: id, message });
      } finally {
        inFlight.delete(key);
      }
    }),
  );
}
