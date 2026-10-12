import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Express, Response } from "express";
import { z } from "zod";
import { AccessError, resourcePermission } from "./access.js";
import { hashToken, sessionUser, userById, type User } from "./auth.js";
import type { Store } from "./db.js";
import { requireReport } from "./report-collaboration.js";
import type {
  PublicReportPayload,
  PublicReportValue,
} from "../shared/public-report.js";

type Row = Record<string, string | number | null>;
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (status: number, message: string): never => {
  throw new AccessError(status, message);
};
const unavailable = () =>
  fail(404, "This shared report is unavailable or has expired.");
const selectionSchema = z
  .object({
    runId: z.uuid(),
    title: z.string().trim().min(1).max(120),
    summary: z.string().trim().max(2000).default(""),
    columnIds: z.array(z.string().max(64)).min(1).max(5),
    sourceIds: z.array(z.string().max(100)).min(1).max(20),
    includeSourceTitles: z.boolean().default(false),
    allowCsv: z.boolean().default(false),
    expiresInDays: z.number().int().min(1).max(30),
  })
  .strict()
  .refine(
    (input) =>
      new Set(input.columnIds).size === input.columnIds.length &&
      new Set(input.sourceIds).size === input.sourceIds.length,
    "Columns and sources must be unique.",
  );
type Selection = z.infer<typeof selectionSchema>;
const valueSchema = z.union([
  z.string().max(10000),
  z.number().finite(),
  z.boolean(),
  z
    .object({ amount: z.number().finite(), currency: z.string().max(12) })
    .strict(),
  z.null(),
]);

function initialize(store: Store) {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS ai_report_public_previews (id TEXT PRIMARY KEY, view_id TEXT NOT NULL REFERENCES ai_report_views(id) ON DELETE CASCADE, author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, workspace_id TEXT NOT NULL, selection_json TEXT NOT NULL, payload_json TEXT NOT NULL, binding_hash TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER);
    CREATE TABLE IF NOT EXISTS ai_report_public_links (id TEXT PRIMARY KEY, view_id TEXT NOT NULL REFERENCES ai_report_views(id) ON DELETE CASCADE, run_id TEXT NOT NULL REFERENCES ai_report_runs(id) ON DELETE CASCADE, author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, workspace_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, selection_json TEXT NOT NULL, payload_json TEXT NOT NULL, binding_hash TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER, invalidated_at INTEGER);
    CREATE INDEX IF NOT EXISTS ai_report_public_links_view ON ai_report_public_links(view_id,created_at);
  `);
}

/** Rebuild the exact selected projection and its authority/content binding. */
function projection(
  store: Store,
  author: User,
  viewId: string,
  input: Selection,
  expiresAt: number,
) {
  const view = requireReport(store, author, viewId, "manage");
  const run = store.db
    .prepare(
      "SELECT * FROM ai_report_runs WHERE id=? AND view_id=? AND workspace_id=?",
    )
    .get(input.runId, viewId, author.workspaceId) as Row | undefined;
  if (
    !run ||
    run.status !== "complete" ||
    run.revision !== view.revision ||
    run.definition !== view.definition ||
    !run.completed_at
  )
    fail(
      409,
      "Choose a completed run of the current saved report. Refresh and preview it again.",
    );
  const definition = JSON.parse(String(run!.definition)) as {
    columns: { id: string; name: string; type: string }[];
  };
  const columns = input.columnIds.map(
    (id) =>
      definition.columns.find((c) => c.id === id) ||
      fail(400, "Choose columns included in the selected run."),
  );
  const bindings: unknown[] = [];
  const rows = input.sourceIds.map((id, index) => {
    const snapshot = store.db
      .prepare("SELECT * FROM ai_report_sources WHERE run_id=? AND source_id=?")
      .get(input.runId, id) as Row | undefined;
    const source = store.get(author.workspaceId, "conversations", id);
    // Only conversation owners and workspace administrators can intentionally publish its derived values.
    if (
      !snapshot ||
      snapshot.status !== "complete" ||
      !source ||
      source.archived ||
      resourcePermission(store, author, "conversations", id) !== "owner"
    )
      fail(
        409,
        "Every selected conversation must still be available and owned by you, or managed by you as a workspace administrator.",
      );
    const context = {
      title: String(source!.title || "Untitled conversation"),
      transcript: String(source!.transcript || ""),
    };
    if (
      digest(context) !== snapshot!.source_hash ||
      digest(JSON.parse(String(snapshot!.context_json))) !==
        snapshot!.context_hash
    )
      fail(
        409,
        "A selected conversation changed after extraction. Run the report again before publishing.",
      );
    const values = columns.map((column) => {
      const cell = store.db
        .prepare(
          "SELECT status,value_json FROM ai_report_cells WHERE run_id=? AND source_snapshot_id=? AND column_id=?",
        )
        .get(input.runId, String(snapshot!.id), column.id);
      if (
        !cell ||
        !["complete", "not_documented"].includes(String(cell.status))
      )
        fail(
          409,
          "A selected result is incomplete. Run the report again before publishing.",
        );
      const value = valueSchema.parse(
        cell!.value_json ? JSON.parse(String(cell!.value_json)) : null,
      );
      return value as PublicReportValue;
    });
    bindings.push({
      id,
      snapshotId: snapshot!.id,
      source: digest(source),
      contextHash: snapshot!.context_hash,
      values,
    });
    return {
      label: input.includeSourceTitles
        ? context.title
        : `Conversation ${index + 1}`,
      values,
    };
  });
  const payload: PublicReportPayload = {
    title: input.title,
    summary: input.summary,
    columns: columns.map(({ name, type }) => ({ name, type })),
    rows,
    completedAt: String(run!.completed_at),
    expiresAt: new Date(expiresAt).toISOString(),
    allowCsv: input.allowCsv,
  };
  if (Buffer.byteLength(JSON.stringify(payload)) > 300_000)
    fail(
      400,
      "Choose fewer or shorter results to keep this public report under 300 KB.",
    );
  return {
    payload,
    binding: digest({
      viewRevision: view.revision,
      definition: view.definition,
      authorId: author.id,
      role: author.role,
      runId: run!.id,
      runRevision: run!.revision,
      completedAt: run!.completed_at,
      bindings,
      payload,
    }),
  };
}

function activeProjection(
  store: Store,
  row: Row,
  now: number,
): PublicReportPayload | null {
  if (row.revoked_at || row.invalidated_at || Number(row.expires_at) <= now)
    return null;
  const author = userById(
    store,
    String(row.author_id),
    String(row.workspace_id),
  );
  try {
    if (!author) return null;
    const current = projection(
      store,
      author,
      String(row.view_id),
      selectionSchema.parse(JSON.parse(String(row.selection_json))),
      Number(row.expires_at),
    );
    return current.binding === row.binding_hash &&
      JSON.stringify(current.payload) === row.payload_json
      ? current.payload
      : null;
  } catch (error) {
    if (
      error instanceof AccessError ||
      error instanceof z.ZodError ||
      error instanceof SyntaxError
    )
      return null;
    throw error;
  }
}
function readLink(store: Store, row: Row, now: number) {
  const payload = activeProjection(store, row, now);
  if (
    !payload &&
    !row.revoked_at &&
    !row.invalidated_at &&
    Number(row.expires_at) > now
  )
    store.db
      .prepare(
        "UPDATE ai_report_public_links SET invalidated_at=? WHERE id=? AND invalidated_at IS NULL",
      )
      .run(now, String(row.id));
  return payload;
}
const publicHeaders = (res: Response) => {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  res.setHeader("X-Content-Type-Options", "nosniff");
};

/** Mount before catch-all API authentication. No private report serializer is reused. */
export function registerPublicReportReads(
  app: Express,
  store: Store,
  { clock = Date.now }: { clock?: () => number } = {},
) {
  const lookup = (token: string) => {
    if (!/^[a-f0-9]{64}$/.test(token)) return unavailable();
    const row = store.db
      .prepare("SELECT * FROM ai_report_public_links WHERE token_hash=?")
      .get(hashToken(token)) as Row | undefined;
    return (row && readLink(store, row, clock())) || unavailable();
  };
  app.get("/api/public-reports/:token", (req, res) => {
    publicHeaders(res);
    res.json({ report: lookup(String(req.params.token)) });
  });
  app.get("/api/public-reports/:token/export.csv", (req, res) => {
    publicHeaders(res);
    const report = lookup(String(req.params.token));
    if (!report.allowCsv)
      return fail(403, "CSV export was not enabled for this shared report.");
    const quote = (value: unknown) => {
      let text =
        value === null
          ? ""
          : typeof value === "object"
            ? JSON.stringify(value)
            : String(value);
      if (/^[\s]*[=+\-@\t\r\n]/.test(text)) text = `'${text}`;
      return `"${text.replaceAll('"', '""')}"`;
    };
    const lines = [
      ["Conversation", ...report.columns.map((c) => c.name)],
      ...report.rows.map((row) => [row.label, ...row.values]),
    ];
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="shared-report.csv"',
    );
    res
      .type("text/csv")
      .send(lines.map((line) => line.map(quote).join(",")).join("\r\n"));
  });
}

export function registerReportPublicSharing(
  app: Express,
  store: Store,
  { clock = Date.now }: { clock?: () => number } = {},
) {
  initialize(store);
  const author = (req: Parameters<typeof sessionUser>[1]) =>
    sessionUser(store, req) ||
    fail(401, "Please sign in to manage report sharing.");
  const path = "/api/report-views/:id/public-links";
  app.get(path, (req, res) => {
    const user = author(req),
      id = String(req.params.id);
    requireReport(store, user, id, "manage");
    const now = clock();
    const items = (
      store.db
        .prepare(
          "SELECT * FROM ai_report_public_links WHERE view_id=? ORDER BY created_at DESC LIMIT 100",
        )
        .all(id) as Row[]
    ).map((row) => {
      const available = Boolean(readLink(store, row, now));
      return {
        id: row.id,
        title: JSON.parse(String(row.payload_json)).title,
        createdAt: new Date(Number(row.created_at)).toISOString(),
        expiresAt: new Date(Number(row.expires_at)).toISOString(),
        allowCsv: JSON.parse(String(row.payload_json)).allowCsv,
        status: row.revoked_at
          ? "revoked"
          : Number(row.expires_at) <= now
            ? "expired"
            : available
              ? "active"
              : "invalidated",
      };
    });
    res.setHeader("Cache-Control", "no-store");
    res.json({ items });
  });
  app.post(`${path}/preview`, (req, res) => {
    const user = author(req),
      id = String(req.params.id),
      input = selectionSchema.parse(req.body),
      now = clock();
    const expiresAt = now + input.expiresInDays * 86400000;
    const projected = projection(store, user, id, input, expiresAt),
      previewId = randomUUID();
    store.transaction(() => {
      store.db
        .prepare(
          "DELETE FROM ai_report_public_previews WHERE expires_at<=? OR consumed_at IS NOT NULL",
        )
        .run(now);
      const count = store.db
        .prepare(
          "SELECT COUNT(*) AS count FROM ai_report_public_previews WHERE author_id=?",
        )
        .get(user.id);
      if (Number(count?.count) >= 20)
        fail(
          429,
          "Too many open public previews. Wait ten minutes before trying again.",
        );
      store.db
        .prepare(
          "INSERT INTO ai_report_public_previews(id,view_id,author_id,workspace_id,selection_json,payload_json,binding_hash,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .run(
          previewId,
          id,
          user.id,
          user.workspaceId,
          JSON.stringify(input),
          JSON.stringify(projected.payload),
          projected.binding,
          now,
          now + 600000,
        );
    });
    res.setHeader("Cache-Control", "no-store");
    res.json({
      previewId,
      report: projected.payload,
      previewExpiresAt: new Date(now + 600000).toISOString(),
    });
  });
  app.post(path, (req, res) => {
    const user = author(req),
      id = String(req.params.id),
      now = clock();
    requireReport(store, user, id, "manage");
    const input = z
      .object({ previewId: z.uuid(), confirmed: z.literal(true) })
      .strict()
      .parse(req.body);
    const result = store.transaction(() => {
      const preview = store.db
        .prepare(
          "SELECT * FROM ai_report_public_previews WHERE id=? AND view_id=? AND author_id=? AND workspace_id=?",
        )
        .get(input.previewId, id, user.id, user.workspaceId) as Row | undefined;
      if (!preview || preview.consumed_at || Number(preview.expires_at) <= now)
        fail(
          409,
          "This preview expired or was already published. Review a fresh preview to create another link.",
        );
      const payload = JSON.parse(
        String(preview!.payload_json),
      ) as PublicReportPayload;
      const selected = selectionSchema.parse(
        JSON.parse(String(preview!.selection_json)),
      );
      const projected = projection(
        store,
        user,
        id,
        selected,
        Date.parse(payload.expiresAt),
      );
      if (projected.binding !== preview!.binding_hash)
        fail(
          409,
          "The report or its sources changed. Review a fresh preview before publishing.",
        );
      const count = store.db
        .prepare(
          "SELECT COUNT(*) AS count FROM ai_report_public_links WHERE view_id=? AND revoked_at IS NULL AND invalidated_at IS NULL AND expires_at>?",
        )
        .get(id, now);
      if (Number(count?.count) >= 20)
        fail(
          409,
          "This report already has 20 active links. Revoke an old link first.",
        );
      const linkId = randomUUID(),
        token = randomBytes(32).toString("hex");
      store.db
        .prepare(
          "INSERT INTO ai_report_public_links(id,view_id,run_id,author_id,workspace_id,token_hash,selection_json,payload_json,binding_hash,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          linkId,
          id,
          selected.runId,
          user.id,
          user.workspaceId,
          hashToken(token),
          JSON.stringify(selected),
          JSON.stringify(projected.payload),
          projected.binding,
          now,
          Date.parse(payload.expiresAt),
        );
      store.db
        .prepare(
          "UPDATE ai_report_public_previews SET consumed_at=? WHERE id=?",
        )
        .run(now, input.previewId);
      return {
        id: linkId,
        path: `/reports/shared/${token}`,
        expiresAt: payload.expiresAt,
      };
    });
    res.setHeader("Cache-Control", "no-store");
    res.status(201).json({ item: result });
  });
  app.delete(`${path}/:linkId`, (req, res) => {
    const user = author(req),
      id = String(req.params.id);
    requireReport(store, user, id, "manage");
    const row = store.db
      .prepare(
        "SELECT id FROM ai_report_public_links WHERE id=? AND view_id=? AND workspace_id=?",
      )
      .get(String(req.params.linkId), id, user.workspaceId);
    if (!row) fail(404, "Public report link not found.");
    store.db
      .prepare(
        "UPDATE ai_report_public_links SET revoked_at=COALESCE(revoked_at,?) WHERE id=?",
      )
      .run(clock(), String(row!.id));
    res.json({ ok: true });
  });
}
