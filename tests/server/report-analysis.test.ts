import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { createDatabase } from "../../server/db.js";
import { hashToken } from "../../server/auth.js";
import {
  initializeAccess,
  registerResourceOwner,
} from "../../server/access.js";
import { createAi } from "../../server/ai.js";
import { registerReportViews } from "../../server/report-views.js";
import { registerPublicReportReads } from "../../server/report-public-sharing.js";
import {
  analysisSchema,
  analysisIssue,
  analyzeRun,
  normalizeAnalysisDate,
  snapshotAnalysisMetadata,
} from "../../server/report-analysis.js";
import {
  defaultAnalysis,
  type AnalysisChart,
  type AnalysisCondition,
  type AnalysisMetadata,
  type ReportAnalysis,
} from "../../shared/report-analysis.js";

const columns = [
  { id: "team", name: "Team", instruction: "Documented team", type: "text" },
  {
    id: "score",
    name: "Score",
    instruction: "Documented score",
    type: "number",
  },
  { id: "remote", name: "Remote", instruction: "Remote work", type: "boolean" },
  { id: "budget", name: "Budget", instruction: "Budget", type: "currency" },
];
const metadata = (patch: Partial<AnalysisMetadata> = {}): AnalysisMetadata => ({
  version: 1,
  createdAt: "2026-10-13T00:00:00.000Z",
  conversationDate: "2026-10-13T00:00:00.000Z",
  candidate: "Alex",
  interviewer: "Interviewer One",
  status: "ready",
  duration: 30,
  ...patch,
});
const cell = (columnId: string, value: unknown, status = "complete") => ({
  columnId,
  status,
  value,
});
const row = (
  id: string,
  cells: ReturnType<typeof cell>[],
  meta: AnalysisMetadata | null = metadata(),
) => ({ id, cells, metadata: meta });
const filtered = (
  condition: Partial<AnalysisCondition> = {},
  extra: Partial<ReportAnalysis> = {},
): ReportAnalysis => ({
  filters: {
    logic: "all",
    conditions: [
      {
        id: "condition",
        field: "score",
        operator: "gte",
        value: 3,
        ...condition,
      },
    ],
  },
  charts: [],
  ...extra,
});
const chart = (patch: Partial<AnalysisChart> = {}): AnalysisChart => ({
  id: "chart",
  name: "Results",
  mode: "bar",
  groupBy: "team",
  bucket: "day",
  splitBy: null,
  operation: "count",
  metric: null,
  ...patch,
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "arkoffer-report-analysis-"));
  const store = createDatabase(directory);
  const identity = (workspaceId = randomUUID(), role = "member") => {
    const id = randomUUID(),
      token = randomBytes(32).toString("hex"),
      date = new Date().toISOString();
    store.db
      .prepare(
        "INSERT OR IGNORE INTO workspaces(id,name,created_at) VALUES(?,?,?)",
      )
      .run(workspaceId, "Synthetic analysis", date);
    store.db
      .prepare(
        "INSERT INTO users(id,workspace_id,name,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        id,
        workspaceId,
        "Synthetic reviewer",
        `${id}@example.com`,
        "unused",
        role,
        date,
      );
    store.db
      .prepare(
        "INSERT INTO sessions(token_hash,user_id,workspace_id,expires_at,created_at) VALUES(?,?,?,?,?)",
      )
      .run(hashToken(token), id, workspaceId, Date.now() + 3600000, date);
    return { id, workspaceId, cookie: `arkoffer_session=${token}` };
  };
  const owner = identity(),
    member = identity(owner.workspaceId),
    other = identity();
  initializeAccess(store);
  const quote =
    "Candidate: I work with Engineering and scored 4. The budget is USD 100.";
  function note(title: string, patch: Record<string, unknown> = {}) {
    const item = store.insert(owner.workspaceId, "conversations", {
      id: randomUUID(),
      title,
      transcript: quote,
      candidate: "Alex",
      interviewer: "Interviewer One",
      status: "ready",
      duration: 30,
      date: "2026-10-11T23:30:00-02:00",
      archived: false,
      createdAt: "2026-10-10T00:00:00.000Z",
      updatedAt: new Date().toISOString(),
      ...patch,
    });
    registerResourceOwner(store, owner.workspaceId, item.id, owner.id);
    return item;
  }
  const first = note('=HYPERLINK("https://example.com")'),
    second = note("Second interview", { candidate: "Blair", duration: 60 });
  let calls = 0;
  const ai = createAi({
    apiKey: "synthetic-key",
    model: "synthetic-model",
    fetch: (async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body)),
        input = JSON.parse(body.messages[1].content);
      const output = JSON.stringify({
        cells: input.columns.map((column: any) => ({
          columnId: column.id,
          value:
            column.type === "number"
              ? 4
              : column.type === "boolean"
                ? true
                : column.type === "currency"
                  ? { amount: 100, currency: "USD" }
                  : "Engineering",
          evidence: [{ quote }],
        })),
      });
      return new Response(
        body.stream
          ? `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: output }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`
          : JSON.stringify({ choices: [{ message: { content: output } }] }),
        {
          headers: {
            "Content-Type": body.stream
              ? "text/event-stream"
              : "application/json",
          },
        },
      );
    }) as typeof fetch,
  });
  const app = express();
  app.use(express.json());
  registerPublicReportReads(app, store);
  let worker = registerReportViews(app, store, { ai });
  app.use((error: any, _req: any, res: any, _next: any) =>
    res
      .status(error.status || (error.name === "ZodError" ? 400 : 500))
      .json({ error: error.message }),
  );
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const request = (
    path = "",
    method = "GET",
    body?: unknown,
    cookie = owner.cookie,
  ) =>
    fetch(`${base}/api/report-views${path}`, {
      method,
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const definition = (patch: Record<string, unknown> = {}) => ({
    name: "Analysis report",
    question: "What is documented?",
    sourceIds: [first.id, second.id],
    columns,
    filters: { title: "", from: "", to: "" },
    ...patch,
  });
  async function create() {
    const res = await request("", "POST", definition());
    assert.equal(res.status, 201, await res.clone().text());
    return (await res.json()).item;
  }
  async function run(view: any) {
    const res = await request(`/${view.id}/runs`, "POST", {
      consent: true,
      revision: view.revision,
      requestKey: randomUUID(),
    });
    assert.equal(res.status, 202, await res.clone().text());
    const item = (await res.json()).item;
    await worker.tick();
    return item;
  }
  const detail = async (view: any, cookie = owner.cookie) =>
    (await request(`/${view.id}`, "GET", undefined, cookie)).json();
  const grant = (
    view: any,
    permission: "viewer" | "editor",
    sources = true,
  ) => {
    store.db
      .prepare(
        "INSERT OR REPLACE INTO ai_report_grants(view_id,user_id,permission,created_at) VALUES(?,?,?,?)",
      )
      .run(view.id, member.id, permission, new Date().toISOString());
    if (sources)
      for (const source of [first, second])
        store.db
          .prepare(
            "INSERT OR REPLACE INTO resource_grants(resource_id,user_id,permission,created_at) VALUES(?,?,?,?)",
          )
          .run(source.id, member.id, "viewer", new Date().toISOString());
  };
  return {
    store,
    owner,
    member,
    other,
    first,
    second,
    request,
    definition,
    create,
    run,
    detail,
    grant,
    calls: () => calls,
    base,
    async restart() {
      await worker.stop();
      worker = registerReportViews(express(), store, { ai });
    },
    async close() {
      await worker.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("analysis validates bounded, unique filters and charts and respects actual field types", () => {
  assert.equal(analysisSchema.safeParse(defaultAnalysis).success, true);
  assert.equal(
    analysisSchema.safeParse(
      filtered(
        {},
        {
          filters: {
            logic: "all",
            conditions: Array.from({ length: 13 }, (_, i) => ({
              id: `f${i}`,
              field: "score",
              operator: "gte",
              value: 3,
            })),
          },
        },
      ),
    ).success,
    false,
  );
  assert.equal(
    analysisSchema.safeParse({
      ...defaultAnalysis,
      charts: Array.from({ length: 7 }, (_, i) => chart({ id: `c${i}` })),
    }).success,
    false,
  );
  assert.equal(
    analysisSchema.safeParse({ ...defaultAnalysis, charts: [chart(), chart()] })
      .success,
    false,
  );
  for (const condition of [
    { field: "score", operator: "contains", value: "4" },
    { field: "remote", operator: "equals", value: "true" },
    { field: "missing", operator: "equals", value: "x" },
    { field: "budget", operator: "gte", value: 100 },
    { field: "$createdAt", operator: "gte", value: "2026-02-30" },
  ] as Partial<AnalysisCondition>[])
    assert.ok(
      analysisIssue(filtered(condition), columns),
      JSON.stringify(condition),
    );
  assert.equal(
    analysisIssue(
      filtered({
        field: "budget",
        operator: "gte",
        value: 100,
        currency: "USD",
      }),
      columns,
    ),
    null,
  );
  assert.ok(
    analysisIssue(
      {
        ...defaultAnalysis,
        charts: [chart({ operation: "sum", metric: "team" })],
      },
      columns,
    ),
  );
});

test("negative and missing filters do not turn queued, failed, unavailable or legacy metadata into matches", () => {
  const rows = [
    row("complete", [cell("score", 4)]),
    row("different", [cell("score", 2)]),
    row("missing", [cell("score", null, "not_documented")]),
    row("pending", [cell("score", null, "queued")]),
    row("failed", [cell("score", null, "failed")]),
    { ...row("unavailable", [cell("score", 4)]), unavailable: true },
  ];
  assert.deepEqual(
    analyzeRun(
      { columns, rows },
      filtered({ operator: "not_equals", value: 4 }),
    ).matchingRowIds,
    ["different"],
  );
  assert.deepEqual(
    analyzeRun(
      { columns, rows },
      filtered({ operator: "is_missing", value: undefined }),
    ).matchingRowIds,
    ["missing"],
  );
  const result = analyzeRun(
    {
      columns,
      rows: [
        row("legacy", [], null),
        row("missing", [], metadata({ candidate: null })),
        row("current", [], metadata()),
      ],
    },
    filtered({ field: "$candidate", operator: "is_missing", value: undefined }),
  );
  assert.deepEqual(result.matchingRowIds, ["missing"]);
  assert.equal(result.counts.unknown, 1);
  assert.equal(rows[0].cells[0].value, 4);
});

test("ALL and ANY compose typed predicates, with currencies compared only in their explicit unit", () => {
  const rows = [
    row("usd", [
      cell("team", "Engineering"),
      cell("score", 4),
      cell("remote", true),
      cell("budget", { amount: 100, currency: "USD" }),
    ]),
    row("eur", [
      cell("team", "Design"),
      cell("score", 2),
      cell("remote", false),
      cell("budget", { amount: 200, currency: "EUR" }),
    ]),
  ];
  const conditions: AnalysisCondition[] = [
    { id: "team", field: "team", operator: "contains", value: "engineer" },
    { id: "remote", field: "remote", operator: "equals", value: true },
  ];
  assert.deepEqual(
    analyzeRun(
      { columns, rows },
      { filters: { logic: "all", conditions }, charts: [] },
    ).matchingRowIds,
    ["usd"],
  );
  assert.deepEqual(
    analyzeRun(
      { columns, rows },
      {
        filters: {
          logic: "any",
          conditions: [
            ...conditions,
            { id: "score", field: "score", operator: "lt", value: 3 },
          ],
        },
        charts: [],
      },
    ).matchingRowIds,
    ["usd", "eur"],
  );
  assert.deepEqual(
    analyzeRun(
      { columns, rows },
      filtered({
        field: "budget",
        operator: "gte",
        value: 50,
        currency: "USD",
      }),
    ).matchingRowIds,
    ["usd"],
  );
});

test("chart sums and averages preserve currency units and ignore uncomputed metrics", () => {
  const rows = [
    row("a", [
      cell("team", "Engineering"),
      cell("budget", { amount: 100, currency: "USD" }),
    ]),
    row("b", [
      cell("team", "Engineering"),
      cell("budget", { amount: 200, currency: "USD" }),
    ]),
    row("c", [
      cell("team", "Engineering"),
      cell("budget", { amount: 400, currency: "EUR" }),
    ]),
    row("d", [cell("team", "Engineering"), cell("budget", null, "queued")]),
    row("e", [cell("team", "Engineering"), cell("budget", null, "failed")]),
    row("f", [
      cell("team", "Engineering"),
      cell("budget", null, "not_documented"),
    ]),
  ];
  const result = analyzeRun(
    { columns, rows },
    {
      ...defaultAnalysis,
      charts: [
        chart({ id: "sum", operation: "sum", metric: "budget" }),
        chart({ id: "average", operation: "average", metric: "budget" }),
      ],
    },
  );
  assert.equal(
    result.charts[0].groups.find((g) => g.unit === "USD")?.value,
    300,
  );
  assert.equal(
    result.charts[0].groups.find((g) => g.unit === "EUR")?.value,
    400,
  );
  assert.equal(
    result.charts[1].groups.find((g) => g.unit === "USD")?.value,
    150,
  );
  assert.equal(result.charts[0].pending, 1);
  assert.equal(result.charts[0].failed, 1);
  assert.equal(result.charts[0].missing, 1);
});

test("date charts bucket UTC days, Monday weeks and months chronologically with stacked series", () => {
  const rows = [
    row(
      "late",
      [cell("team", "Design")],
      metadata({ conversationDate: "2026-10-11T23:30:00-02:00" }),
    ),
    row(
      "early",
      [cell("team", "Engineering")],
      metadata({ conversationDate: "2026-10-11T23:00:00Z" }),
    ),
    row(
      "next",
      [cell("team", "Engineering")],
      metadata({ conversationDate: "2026-11-01T12:00:00Z" }),
    ),
  ];
  for (const [bucket, expected] of [
    ["day", ["2026-10-11", "2026-10-12", "2026-11-01"]],
    ["week", ["2026-10-05", "2026-10-12", "2026-10-26"]],
    ["month", ["2026-10-01", "2026-11-01"]],
  ] as const) {
    const result = analyzeRun(
      { columns, rows },
      {
        ...defaultAnalysis,
        charts: [chart({ groupBy: "$conversationDate", mode: "line", bucket })],
      },
    );
    assert.deepEqual(
      result.charts[0].groups.map((g) => g.label),
      expected,
    );
  }
  const stacked = analyzeRun(
    { columns, rows },
    {
      ...defaultAnalysis,
      charts: [
        chart({
          groupBy: "$conversationDate",
          mode: "stacked",
          bucket: "month",
          splitBy: "team",
        }),
      ],
    },
  );
  assert.deepEqual(
    new Set(stacked.charts[0].groups.map((g) => g.series)),
    new Set(["Design", "Engineering"]),
  );
});

test("snapshot metadata normalizes actual dates and finite duration without guessing missing values", () => {
  assert.equal(normalizeAnalysisDate("2026-02-30"), null);
  assert.equal(normalizeAnalysisDate("10/12/2026"), null);
  assert.equal(
    normalizeAnalysisDate("2026-10-12T23:30:00-02:00"),
    "2026-10-13T01:30:00.000Z",
  );
  const result = snapshotAnalysisMetadata({
    id: "source",
    title: "Interview",
    createdAt: "2026-10-10T00:00:00Z",
    date: "not a date",
    duration: Infinity,
    candidate: "Alex",
    interviewer: "Casey",
    status: "ready",
  });
  assert.equal(result.candidate, "Alex");
  assert.equal(result.conversationDate, null);
  assert.equal(result.duration, null);
  assert.equal(
    snapshotAnalysisMetadata({ id: "source", title: "Interview" }).createdAt,
    null,
  );
});

test("analysis revisions persist independently without changing extraction, legacy aggregation or public snapshots", async () => {
  const f = await fixture();
  try {
    const view = await f.create(),
      run = await f.run(view);
    const before = await f.detail(view);
    assert.equal(before.runs[0].status, "complete");
    const previewResponse = await f.request(
      `/${view.id}/public-links/preview`,
      "POST",
      {
        runId: run.id,
        title: "Reviewed summary",
        summary: "Synthetic results",
        sourceIds: [f.first.id],
        columnIds: ["score"],
        includeSourceTitles: false,
        allowCsv: false,
        expiresInDays: 7,
      },
    );
    assert.equal(
      previewResponse.status,
      200,
      await previewResponse.clone().text(),
    );
    const preview = await previewResponse.json();
    const publishedResponse = await f.request(
      `/${view.id}/public-links`,
      "POST",
      { previewId: preview.previewId, confirmed: true },
    );
    assert.equal(
      publishedResponse.status,
      201,
      await publishedResponse.clone().text(),
    );
    const published = (await publishedResponse.json()).item,
      token = published.path.split("/").pop();
    const publicBefore = await (
      await fetch(`${f.base}/api/public-reports/${token}`)
    ).json();
    const config = filtered(
      { field: "$candidate", operator: "equals", value: "Alex" },
      { charts: [chart({ operation: "sum", metric: "score" })] },
    );
    const response = await f.request(`/${view.id}/analysis`, "PATCH", {
      revision: before.item.analysisRevision,
      runId: run.id,
      analysis: config,
    });
    assert.equal(response.status, 200, await response.clone().text());
    const after = await response.json();
    assert.equal(after.item.analysisRevision, before.item.analysisRevision + 1);
    assert.equal(after.item.revision, before.item.revision);
    assert.deepEqual(after.item.columns, before.item.columns);
    assert.deepEqual(after.runs[0].rows, before.runs[0].rows);
    assert.deepEqual(after.runs[0].aggregation, before.runs[0].aggregation);
    assert.equal(after.runs[0].analysis.counts.matched, 1);
    assert.equal(after.runs[0].analysis.charts[0].groups[0].value, 4);
    assert.equal(f.calls(), 2);
    assert.equal(
      f.store.db.prepare("SELECT COUNT(*) AS count FROM ai_report_runs").get()
        ?.count,
      1,
    );
    assert.equal(
      (
        await f.request(`/${view.id}/analysis`, "PATCH", {
          revision: before.item.analysisRevision,
          analysis: config,
        })
      ).status,
      409,
    );
    await f.restart();
    assert.deepEqual((await f.detail(view)).item.analysis, config);
    const publicAfterResponse = await fetch(
      `${f.base}/api/public-reports/${token}`,
    );
    assert.equal(publicAfterResponse.status, 200);
    assert.deepEqual(await publicAfterResponse.json(), publicBefore);
    assert.equal(f.calls(), 2);
  } finally {
    await f.close();
  }
});

test("analysis snapshots remain immutable and old rows never borrow current conversation metadata", async () => {
  const f = await fixture();
  try {
    const view = await f.create(),
      run = await f.run(view);
    const initial = (await f.detail(view)).runs[0],
      captured = initial.rows.find((r: any) => r.sourceId === f.first.id);
    assert.equal(captured.metadata.candidate, "Alex");
    assert.equal(
      captured.metadata.conversationDate,
      "2026-10-12T01:30:00.000Z",
    );
    f.store.update(f.owner.workspaceId, "conversations", {
      ...f.store.get(f.owner.workspaceId, "conversations", f.first.id)!,
      candidate: "Renamed candidate",
      duration: 99,
      date: "2026-11-10T12:00:00Z",
    });
    assert.deepEqual(
      (await f.detail(view)).runs[0].rows.find((r: any) => r.id === captured.id)
        .metadata,
      captured.metadata,
    );
    f.store.db
      .prepare("UPDATE ai_report_sources SET metadata_json=NULL WHERE id=?")
      .run(captured.id);
    await f.restart();
    const legacy = (await f.detail(view)).runs[0].rows.find(
      (r: any) => r.id === captured.id,
    );
    assert.equal(legacy.metadata, null);
    assert.equal(
      f.store.db
        .prepare("SELECT metadata_json FROM ai_report_sources WHERE id=?")
        .get(captured.id)?.metadata_json,
      null,
    );
    const response = await f.request(`/${view.id}/analysis`, "PATCH", {
      revision: view.analysisRevision,
      runId: run.id,
      analysis: filtered({
        field: "$candidate",
        operator: "not_equals",
        value: "Nobody",
      }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    const result = (await response.json()).runs[0].analysis;
    assert.equal(result.counts.unknown, 1);
    assert.equal(result.counts.matched, 1);
    assert.equal(result.matchingRowIds.includes(captured.id), false);
  } finally {
    await f.close();
  }
});

test("analysis saves and exports honor report roles, workspace boundaries and fresh source revocation", async () => {
  const f = await fixture();
  try {
    const view = await f.create(),
      run = await f.run(view);
    const path = `/${view.id}/analysis`,
      body = {
        revision: view.analysisRevision,
        runId: run.id,
        analysis: { ...defaultAnalysis, charts: [chart()] },
      };
    assert.equal((await f.request(path, "PATCH", body, "")).status, 401);
    assert.equal(
      (await f.request(path, "PATCH", body, f.other.cookie)).status,
      404,
    );
    assert.equal(
      (await f.request(path, "PATCH", body, f.member.cookie)).status,
      404,
    );
    f.grant(view, "viewer");
    assert.equal(
      (await f.request(path, "PATCH", body, f.member.cookie)).status,
      403,
    );
    f.grant(view, "editor");
    assert.equal(
      (await f.request(path, "PATCH", body, f.member.cookie)).status,
      200,
    );
    const chartPath = `/${view.id}/runs/${run.id}/charts/chart.csv`,
      filteredPath = `/${view.id}/runs/${run.id}/analysis.csv`;
    assert.equal(
      (await f.request(filteredPath, "GET", undefined, f.other.cookie)).status,
      404,
    );
    assert.equal(
      (await f.request(chartPath, "GET", undefined, f.other.cookie)).status,
      404,
    );
    const before = await f.detail(view, f.member.cookie);
    assert.equal(before.runs[0].analysis.counts.matched, 2);
    f.store.db
      .prepare("DELETE FROM resource_grants WHERE resource_id=? AND user_id=?")
      .run(f.first.id, f.member.id);
    const after = await f.detail(view, f.member.cookie);
    assert.equal(after.runs[0].analysis.counts.matched, 1);
    assert.equal(after.runs[0].analysis.counts.unavailable, 1);
    const denied = after.runs[0].rows.find((r: any) => r.unavailable);
    assert.equal(denied.metadata, undefined);
    assert.equal(denied.title, undefined);
    assert.deepEqual(denied.cells, []);
    const exported = await f.request(
      filteredPath,
      "GET",
      undefined,
      f.member.cookie,
    );
    assert.equal(exported.status, 200);
    assert.doesNotMatch(await exported.text(), /HYPERLINK|Alex/);
    const charted = await f.request(
      chartPath,
      "GET",
      undefined,
      f.member.cookie,
    );
    assert.equal(charted.status, 200);
    assert.match(await charted.text(), /Engineering/);
    f.store.db
      .prepare("DELETE FROM ai_report_grants WHERE view_id=? AND user_id=?")
      .run(view.id, f.member.id);
    assert.equal(
      (await f.request(filteredPath, "GET", undefined, f.member.cookie)).status,
      404,
    );
    assert.equal(
      (await f.request(chartPath, "GET", undefined, f.member.cookie)).status,
      404,
    );
  } finally {
    await f.close();
  }
});

test("filtered and chart CSV reflect saved analysis and neutralize formula-bearing labels", async () => {
  const f = await fixture();
  try {
    const view = await f.create(),
      run = await f.run(view);
    f.store.db
      .prepare(
        "UPDATE ai_report_cells SET value_json=? WHERE run_id=? AND column_id='team'",
      )
      .run(JSON.stringify('=HYPERLINK("https://example.com")'), run.id);
    f.store.db
      .prepare(
        "UPDATE ai_report_cells SET value_json=? WHERE run_id=? AND column_id='score'",
      )
      .run(JSON.stringify(-5), run.id);
    const config = filtered(
      { field: "$candidate", operator: "equals", value: "Alex" },
      { charts: [chart({ operation: "sum", metric: "score" })] },
    );
    const response = await f.request(`/${view.id}/analysis`, "PATCH", {
      revision: view.analysisRevision,
      analysis: config,
    });
    assert.equal(response.status, 200, await response.clone().text());
    const csvResponse = await f.request(
      `/${view.id}/runs/${run.id}/analysis.csv`,
    );
    assert.equal(csvResponse.status, 200);
    const csv = await csvResponse.text();
    assert.match(csv, /'=HYPERLINK/);
    assert.match(csv, /,"-5",/);
    assert.doesNotMatch(csv, /"'-5"/);
    assert.doesNotMatch(csv, /Second interview/);
    const chartCsv = await f.request(
      `/${view.id}/runs/${run.id}/charts/chart.csv`,
    );
    assert.equal(chartCsv.status, 200);
    const chartText = await chartCsv.text();
    assert.match(chartText, /'=HYPERLINK/);
    assert.match(chartText, /,"sum","-5","1","1"/);
    assert.doesNotMatch(chartText, /"'-5"/);
    assert.equal(
      (await f.request(`/${view.id}/runs/${run.id}/charts/missing.csv`)).status,
      404,
    );
    assert.equal(f.calls(), 2);
  } finally {
    await f.close();
  }
});

test("historical runs reject incompatible analysis instead of interpreting a replacement column type", async () => {
  const f = await fixture();
  try {
    const view = await f.create(),
      oldRun = await f.run(view);
    const replacement = f.definition({
      columns: columns.map((column) =>
        column.id === "score" ? { ...column, type: "text" } : column,
      ),
    });
    const edit = await f.request(`/${view.id}`, "PATCH", {
      revision: view.revision,
      definition: replacement,
    });
    assert.equal(edit.status, 200, await edit.clone().text());
    const current = (await f.detail(view)).item;
    const analysis = filtered({
      field: "score",
      operator: "contains",
      value: "Engineering",
    });
    const wrongRun = await f.request(`/${view.id}/analysis`, "PATCH", {
      revision: current.analysisRevision,
      runId: oldRun.id,
      analysis,
    });
    assert.equal(wrongRun.status, 400, await wrongRun.clone().text());
    const saved = await f.request(`/${view.id}/analysis`, "PATCH", {
      revision: current.analysisRevision,
      analysis,
    });
    assert.equal(saved.status, 200, await saved.clone().text());
    const oldResult = (await saved.json()).runs.find(
      (r: any) => r.id === oldRun.id,
    );
    assert.equal(oldResult.analysis.compatible, false);
    assert.deepEqual(oldResult.analysis.matchingRowIds, []);
    assert.equal(
      (await f.request(`/${view.id}/runs/${oldRun.id}/analysis.csv`)).status,
      409,
    );
    assert.equal(f.calls(), 2);
  } finally {
    await f.close();
  }
});

test("unknown filter values preserve three-valued ALL/ANY truth instead of silently becoming false", () => {
  const rows = [
    row("true-unknown", [cell("remote", true)], null),
    row("false-unknown", [cell("remote", false)], null),
  ];
  const conditions: AnalysisCondition[] = [
    { id: "known", field: "remote", operator: "equals", value: true },
    { id: "unknown", field: "$candidate", operator: "contains", value: "Alex" },
  ];
  const all = analyzeRun(
    { columns, rows },
    { filters: { logic: "all", conditions }, charts: [] },
  );
  assert.deepEqual(all.matchingRowIds, []);
  assert.equal(all.counts.excluded, 1);
  assert.equal(all.counts.unknown, 1);
  const any = analyzeRun(
    { columns, rows },
    { filters: { logic: "any", conditions }, charts: [] },
  );
  assert.deepEqual(any.matchingRowIds, ["true-unknown"]);
  assert.equal(any.counts.excluded, 0);
  assert.equal(any.counts.unknown, 1);
});

test("date filters use UTC calendar days and numeric groups sort numerically", () => {
  const rows = [
    row(
      "utc-thirteen",
      [cell("score", 10)],
      metadata({ conversationDate: "2026-10-12T23:30:00-02:00" }),
    ),
    row(
      "utc-twelve",
      [cell("score", 2)],
      metadata({ conversationDate: "2026-10-13T01:30:00+08:00" }),
    ),
  ];
  const result = analyzeRun(
    { columns, rows },
    filtered({
      field: "$conversationDate",
      operator: "equals",
      value: "2026-10-13",
    }),
  );
  assert.deepEqual(result.matchingRowIds, ["utc-thirteen"]);
  const numeric = analyzeRun(
    { columns, rows },
    { ...defaultAnalysis, charts: [chart({ groupBy: "score" })] },
  );
  assert.deepEqual(
    numeric.charts[0].groups.map((group) => group.label),
    ["2", "10"],
  );
  assert.ok(
    analysisIssue(
      { ...defaultAnalysis, charts: [chart({ mode: "stacked" })] },
      columns,
    ),
  );
  assert.ok(
    analysisIssue(
      {
        ...defaultAnalysis,
        charts: [
          chart({
            mode: "stacked",
            splitBy: "remote",
            operation: "average",
            metric: "score",
          }),
        ],
      },
      columns,
    ),
  );
  assert.ok(
    analysisIssue(
      {
        ...defaultAnalysis,
        charts: [chart({ mode: "stacked", splitBy: "score" })],
      },
      columns,
    ),
  );
});
