import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { createDatabase, type Resource } from "../../server/db.js";
import { hashToken } from "../../server/auth.js";
import {
  initializeAccess,
  registerResourceOwner,
} from "../../server/access.js";
import { createAi } from "../../server/ai.js";
import { registerReportViews } from "../../server/report-views.js";

const quote = "Candidate: I led a team of four engineers.";
async function fixture(configured = true) {
  const directory = mkdtempSync(join(tmpdir(), "arkoffer-report-views-")),
    store = createDatabase(directory);
  function identity(workspaceId = randomUUID(), role = "owner") {
    const id = randomUUID(),
      token = randomBytes(32).toString("hex"),
      date = new Date().toISOString();
    store.db
      .prepare(
        "INSERT OR IGNORE INTO workspaces(id,name,created_at) VALUES(?,?,?)",
      )
      .run(workspaceId, "Reports", date);
    store.db
      .prepare(
        "INSERT INTO users(id,workspace_id,name,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        id,
        workspaceId,
        "Tester",
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
    return { id, workspaceId, token, cookie: `arkoffer_session=${token}` };
  }
  const owner = identity(),
    member = identity(owner.workspaceId, "member"),
    other = identity();
  initializeAccess(store);
  function note(
    title = "Interview",
    transcript = `Interviewer: Tell me about leadership.\n${quote}`,
  ) {
    const date = new Date().toISOString(),
      item = store.insert(owner.workspaceId, "conversations", {
        id: randomUUID(),
        title,
        transcript,
        archived: false,
        createdAt: date,
        updatedAt: date,
      });
    registerResourceOwner(store, owner.workspaceId, item.id, owner.id);
    return item;
  }
  const first = note(),
    calls: unknown[] = [];
  let handler: (
    body: any,
    signal?: AbortSignal | null,
  ) => Promise<unknown> | unknown = (body) => {
    const input = JSON.parse(body.messages[1].content);
    return {
      cells: input.columns.map((column: any) => ({
        columnId: column.id,
        value:
          column.type === "number"
            ? 4
            : column.type === "boolean"
              ? true
              : column.type === "currency"
                ? { amount: 100, currency: "USD" }
                : "Led four engineers",
        evidence: [{ quote }],
      })),
    };
  };
  const ai = createAi({
    apiKey: configured ? "synthetic-test-key" : "",
    model: "synthetic-model",
    fetch: (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      calls.push(body);
      const answer = await handler(body, init?.signal);
      if (body.stream)
        return new Response(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: typeof answer === "string" ? answer : JSON.stringify(answer) }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
          { headers: { "Content-Type": "text/event-stream" } },
        );
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  typeof answer === "string" ? answer : JSON.stringify(answer),
              },
            },
          ],
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch,
  });
  const app = express();
  app.use(express.json());
  let worker = registerReportViews(app, store, { ai });
  app.use(
    (
      error: any,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) =>
      res
        .status(error.status || (error.name === "ZodError" ? 400 : 500))
        .json({ error: error.message }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const request = (
    path = "",
    method = "GET",
    body?: unknown,
    cookie = owner.cookie,
  ) =>
    fetch(`http://127.0.0.1:${address.port}/api/report-views${path}`, {
      method,
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const definition = (extra: Record<string, unknown> = {}) => ({
    name: "Leadership",
    question: "What leadership experience is documented?",
    sourceIds: [first.id],
    columns: [
      {
        id: "leadership",
        name: "Leadership",
        instruction: "Describe documented leadership experience",
        type: "text",
      },
    ],
    filters: { title: "", from: "", to: "" },
    ...extra,
  });
  const create = async (input = definition(), cookie = owner.cookie) => {
    const response = await request("", "POST", input, cookie);
    assert.equal(response.status, 201, await response.clone().text());
    return (await response.json()).item;
  };
  const run = async (
    view: any,
    requestKey = randomUUID(),
    cookie = owner.cookie,
  ) => {
    const response = await request(
      `/${view.id}/runs`,
      "POST",
      { consent: true, revision: view.revision, requestKey },
      cookie,
    );
    assert.equal(response.status, 202, await response.clone().text());
    return (await response.json()).item;
  };
  const detail = async (view: any, cookie = owner.cookie) =>
    (await request(`/${view.id}`, "GET", undefined, cookie)).json();
  const change = (item: Resource, patch: Record<string, unknown>) =>
    store.update(owner.workspaceId, "conversations", {
      ...store.get(owner.workspaceId, "conversations", item.id)!,
      ...patch,
      updatedAt: new Date().toISOString(),
    });
  let storeClosed = false;
  function closeStore() {
    if (!storeClosed) {
      store.close();
      storeClosed = true;
    }
  }
  return {
    store,
    closeStore,
    stop: () => worker.stop(),
    owner,
    member,
    other,
    first,
    note,
    request,
    definition,
    create,
    run,
    detail,
    change,
    calls,
    ai,
    setHandler(fn: typeof handler) {
      handler = fn;
    },
    tick: () => worker.tick(),
    restart() {
      worker = registerReportViews(express(), store, { ai });
    },
    async close() {
      await worker.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      closeStore();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("private report views persist typed cells, exact evidence, human annotations and safe CSV", async () => {
  const f = await fixture();
  try {
    const columns = ["text", "number", "boolean", "currency"].map((type) => ({
      id: type,
      name: `${type} result`,
      instruction: "Extract documented evidence",
      type,
    }));
    f.change(f.first, {
      transcript: `${quote}\nCandidate: My budget was USD 100.`,
    });
    const view = await f.create(f.definition({ columns }));
    const run = await f.run(view);
    assert.equal(run.status, "queued");
    await f.tick();
    let result = await f.detail(view);
    assert.equal(result.runs[0].status, "complete");
    const cells = result.runs[0].rows[0].cells;
    assert.deepEqual(
      cells.map((cell: any) => cell.value),
      ["Led four engineers", 4, true, { amount: 100, currency: "USD" }],
    );
    assert.deepEqual(cells[0].evidence, [
      { quote, start: 0, end: quote.length },
    ]);
    assert.equal(
      (
        await f.request(
          `/${view.id}/runs/${run.id}/cells/${cells[0].id}`,
          "PATCH",
          { annotation: '=HYPERLINK("https://example.com")' },
        )
      ).status,
      200,
    );
    result = await f.detail(view);
    assert.match(result.runs[0].rows[0].cells[0].annotation, /HYPERLINK/);
    const exported = await f.request(`/${view.id}/runs/${run.id}/export.csv`);
    assert.equal(exported.status, 200);
    assert.match(await exported.text(), /'=HYPERLINK/);
    assert.equal(f.store.list(f.owner.workspaceId, "reports").length, 0);
    assert.equal(f.store.list(f.owner.workspaceId, "candidates").length, 0);
    const list = await (
      await f.request("", "GET", undefined, f.member.cookie)
    ).json();
    assert.deepEqual(list.items, []);
    assert.deepEqual(list.sources, []);
    assert.equal(
      (await f.request(`/${view.id}`, "GET", undefined, f.member.cookie))
        .status,
      404,
    );
    assert.equal(
      (
        await f.request(
          `/${view.id}/runs/${run.id}/export.csv`,
          "GET",
          undefined,
          f.other.cookie,
        )
      ).status,
      404,
    );
    f.restart();
    assert.equal(
      (await f.detail(view)).runs[0].rows[0].cells[0].annotation,
      '=HYPERLINK("https://example.com")',
    );
  } finally {
    await f.close();
  }
});

test("null is not documented, semantic instructions reach the provider, and truncation is disclosed", async () => {
  const f = await fixture();
  try {
    f.change(f.first, { transcript: quote + "x".repeat(70_000) });
    f.setHandler(() => ({
      cells: [{ columnId: "leadership", value: null, evidence: [] }],
    }));
    const view = await f.create(),
      run = await f.run(view);
    await f.tick();
    const result = (await f.detail(view)).runs[0];
    assert.equal(result.id, run.id);
    assert.equal(result.rows[0].truncated, true);
    assert.equal(result.rows[0].includedCharacters, 60_000);
    assert.equal(result.rows[0].cells[0].status, "not_documented");
    assert.equal(result.rows[0].cells[0].value, null);
    const body = f.calls[0] as any,
      input = JSON.parse(body.messages[1].content);
    assert.equal(input.question, view.question);
    assert.equal(input.columns[0].instruction, view.columns[0].instruction);
    assert.equal(input.transcript.length, 60_000);
    assert.match(body.messages[0].content, /semantic understanding/);
  } finally {
    await f.close();
  }
});

for (const mutation of ["transcript", "title", "archive", "delete"] as const)
  test(`a ${mutation} change hides the entire saved cell, including title and annotation`, async () => {
    const f = await fixture();
    try {
      const view = await f.create(),
        run = await f.run(view);
      await f.tick();
      let result = await f.detail(view);
      const cell = result.runs[0].rows[0].cells[0];
      await f.request(`/${view.id}/runs/${run.id}/cells/${cell.id}`, "PATCH", {
        annotation: "Secret reviewer assessment",
      });
      if (mutation === "delete")
        f.store.db.prepare("DELETE FROM resources WHERE id=?").run(f.first.id);
      else
        f.change(
          f.first,
          mutation === "transcript"
            ? { transcript: `${quote}\nChanged surrounding context` }
            : mutation === "title"
              ? { title: "Changed title" }
              : { archived: true },
        );
      result = await f.detail(view);
      assert.equal(result.runs[0].rows[0].unavailable, true);
      assert.equal(result.runs[0].rows[0].title, undefined);
      assert.deepEqual(result.runs[0].rows[0].cells, []);
      const text = await (
        await f.request(`/${view.id}/runs/${run.id}/export.csv`)
      ).text();
      assert.doesNotMatch(text, /Secret reviewer|Led four|Interview/);
      assert.equal(
        (
          await f.request(
            `/${view.id}/runs/${run.id}/cells/${cell.id}`,
            "PATCH",
            { annotation: "overwrite" },
          )
        ).status,
        404,
      );
    } finally {
      await f.close();
    }
  });

for (const mutation of [
  "source",
  "cancel",
  "revision",
  "session",
  "membership",
  "grant",
] as const)
  test(`in-flight ${mutation} changes discard model output without an automatic retry`, async () => {
    const f = await fixture();
    try {
      let cookie = f.owner.cookie;
      if (mutation === "grant") {
        f.store.db
          .prepare(
            "INSERT INTO resource_grants(resource_id,user_id,permission,created_at) VALUES(?,?,?,?)",
          )
          .run(f.first.id, f.member.id, "viewer", new Date().toISOString());
        cookie = f.member.cookie;
      }
      const view = await f.create(f.definition(), cookie),
        run = await f.run(view, randomUUID(), cookie);
      let started!: () => void, finish!: (data: unknown) => void;
      const start = new Promise<void>((resolve) => (started = resolve));
      f.setHandler(() => {
        started();
        return new Promise((resolve) => (finish = resolve));
      });
      const work = f.tick();
      await start;
      if (mutation === "source")
        f.change(f.first, {
          transcript: `${quote}\nNew context after provider dispatch`,
        });
      if (mutation === "cancel")
        assert.equal(
          (await f.request(`/${view.id}/runs/${run.id}/cancel`, "POST", {}))
            .status,
          200,
        );
      if (mutation === "revision")
        assert.equal(
          (
            await f.request(`/${view.id}`, "PATCH", {
              revision: view.revision,
              definition: f.definition({ name: "Revised" }),
            })
          ).status,
          200,
        );
      if (mutation === "session")
        f.store.db
          .prepare("DELETE FROM sessions WHERE token_hash=?")
          .run(hashToken(f.owner.token));
      if (mutation === "membership")
        f.store.db
          .prepare("DELETE FROM memberships WHERE workspace_id=? AND user_id=?")
          .run(f.owner.workspaceId, f.owner.id);
      if (mutation === "grant")
        f.store.db
          .prepare(
            "DELETE FROM resource_grants WHERE resource_id=? AND user_id=?",
          )
          .run(f.first.id, f.member.id);
      finish({
        cells: [
          {
            columnId: "leadership",
            value: "Should never persist",
            evidence: [{ quote }],
          },
        ],
      });
      await work;
      await f.tick();
      assert.equal(f.calls.length, 1);
      assert.equal(
        f.store.db
          .prepare("SELECT value_json FROM ai_report_cells WHERE run_id=?")
          .get(run.id)?.value_json,
        null,
      );
      if (mutation === "session" || mutation === "membership")
        assert.equal((await f.request(`/${view.id}`)).status, 401);
      else {
        const result = await f.detail(view, cookie);
        assert.doesNotMatch(JSON.stringify(result), /Should never persist/);
      }
    } finally {
      await f.close();
    }
  });

test("requests are revision-bound and idempotent; explicit reruns create fresh results", async () => {
  const f = await fixture();
  try {
    const view = await f.create(),
      key = randomUUID(),
      run = await f.run(view, key);
    const again = await f.request(`/${view.id}/runs`, "POST", {
      consent: true,
      revision: 1,
      requestKey: key,
    });
    assert.equal(again.status, 200);
    assert.equal((await again.json()).item.id, run.id);
    await f.tick();
    assert.equal(f.calls.length, 1);
    assert.equal(
      (
        await f.request(`/${view.id}/runs`, "POST", {
          consent: false,
          revision: 1,
          requestKey: randomUUID(),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await f.request(`/${view.id}/runs`, "POST", {
          consent: true,
          revision: 2,
          requestKey: randomUUID(),
        })
      ).status,
      409,
    );
    const next = await f.run(view);
    assert.notEqual(next.id, run.id);
    await f.tick();
    assert.equal(f.calls.length, 2);
  } finally {
    await f.close();
  }
});

test("queued work resumes after restart but a dispatched run is interrupted without paid retry", async () => {
  const f = await fixture();
  try {
    const view = await f.create(),
      run = await f.run(view);
    f.restart();
    await f.tick();
    assert.equal(f.calls.length, 1);
    assert.equal((await f.detail(view)).runs[0].status, "complete");
    const next = await f.run(view);
    f.store.db
      .prepare("UPDATE ai_report_runs SET status='processing' WHERE id=?")
      .run(next.id);
    f.store.db
      .prepare("UPDATE ai_report_cells SET status='processing' WHERE run_id=?")
      .run(next.id);
    f.restart();
    await f.tick();
    const runs = (await f.detail(view)).runs;
    assert.equal(
      runs.find((item: any) => item.id === next.id).status,
      "interrupted",
    );
    assert.equal(f.calls.length, 1);
    assert.equal(
      runs.find((item: any) => item.id === run.id).status,
      "complete",
    );
  } finally {
    await f.close();
  }
});

for (const invalid of ["quote", "type", "unsupported"])
  test(`invalid ${invalid} output fails closed`, async () => {
    const f = await fixture();
    try {
      f.setHandler(() => ({
        cells: [
          {
            columnId: "leadership",
            value: invalid === "type" ? 42 : "Claim",
            evidence:
              invalid === "unsupported"
                ? []
                : [
                    {
                      quote: invalid === "quote" ? "Invented evidence" : quote,
                    },
                  ],
          },
        ],
      }));
      const view = await f.create();
      await f.run(view);
      await f.tick();
      const result = (await f.detail(view)).runs[0];
      assert.equal(result.status, "completed_with_issues");
      assert.equal(result.rows[0].cells[0].value, null);
      assert.equal(result.rows[0].cells[0].status, "failed");
    } finally {
      await f.close();
    }
  });

test("configuration gates extraction while private editing still works", async () => {
  const f = await fixture(false);
  try {
    const view = await f.create();
    assert.equal((await (await f.request()).json()).setup.configured, false);
    assert.equal(
      (
        await f.request(`/${view.id}/runs`, "POST", {
          consent: true,
          revision: 1,
          requestKey: randomUUID(),
        })
      ).status,
      503,
    );
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});

test("bounded source selection, filters and durable daily budgets prevent unbounded extraction", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (
        await f.request(
          "",
          "POST",
          f.definition({
            sourceIds: Array.from({ length: 21 }, () => randomUUID()),
          }),
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await f.request(
          "",
          "POST",
          f.definition({
            columns: Array.from({ length: 6 }, (_, i) => ({
              id: String(i),
              name: "Column",
              instruction: "Extract",
              type: "text",
            })),
          }),
        )
      ).status,
      400,
    );
    const filtered = await f.create(
      f.definition({ filters: { title: "does not match", from: "", to: "" } }),
    );
    assert.equal(
      (
        await f.request(`/${filtered.id}/runs`, "POST", {
          consent: true,
          revision: 1,
          requestKey: randomUUID(),
        })
      ).status,
      400,
    );
    const view = await f.create(),
      run = await f.run(view);
    await f.request(`/${view.id}/runs/${run.id}/cancel`, "POST", {});
    await f.request(`/${view.id}`, "DELETE");
    assert.equal(
      f.store.db
        .prepare("SELECT cell_count FROM ai_report_budget WHERE run_id=?")
        .get(run.id)?.cell_count,
      1,
    );
    f.store.db
      .prepare("UPDATE ai_report_budget SET cell_count=500 WHERE run_id=?")
      .run(run.id);
    const next = await f.create();
    assert.equal(
      (
        await f.request(`/${next.id}/runs`, "POST", {
          consent: true,
          revision: 1,
          requestKey: randomUUID(),
        })
      ).status,
      429,
    );
  } finally {
    await f.close();
  }
});

test("queued provider changes require fresh confirmation before any paid request", async () => {
  const f = await fixture();
  try {
    const view = await f.create();
    await f.run(view);
    f.ai.model = "a-different-model";
    f.restart();
    await f.tick();
    const run = (await f.detail(view)).runs[0];
    assert.equal(run.status, "cancelled");
    assert.match(run.error, /provider or model changed/);
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});

test("changes outside a truncated excerpt invalidate all saved values and evidence", async () => {
  const f = await fixture();
  try {
    f.change(f.first, { transcript: quote + "x".repeat(70_000) });
    const view = await f.create();
    await f.run(view);
    await f.tick();
    assert.equal(
      (await f.detail(view)).runs[0].rows[0].cells[0].value,
      "Led four engineers",
    );
    f.change(f.first, {
      transcript: quote + "x".repeat(70_000) + "Changed tail",
    });
    const row = (await f.detail(view)).runs[0].rows[0];
    assert.equal(row.unavailable, true);
    assert.deepEqual(row.cells, []);
  } finally {
    await f.close();
  }
});

test("shutdown drains an aborted extraction before storage closes and never resumes it", async () => {
  const f = await fixture();
  let release!: (data: unknown) => void;
  try {
    const view = await f.create();
    const run = await f.run(view);
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    let aborted = false;
    f.setHandler((_body, signal) => {
      signal?.addEventListener(
        "abort",
        () => {
          aborted = true;
        },
        { once: true },
      );
      began();
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    let tickFinished = false;
    const processing = f.tick().then(() => {
      tickFinished = true;
    });
    await started;
    let stopped = false;
    const stopping = f.stop().then(() => {
      stopped = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(aborted, true);
    assert.equal(
      stopped,
      false,
      "stop must wait for provider cleanup before returning",
    );
    assert.equal(
      f.store.db
        .prepare("SELECT status FROM ai_report_runs WHERE id=?")
        .get(run.id)?.status,
      "interrupted",
    );
    release({
      cells: [
        { columnId: "leadership", value: "Late result", evidence: [{ quote }] },
      ],
    });
    await stopping;
    assert.equal(tickFinished, true);
    assert.equal(
      f.store.db
        .prepare("SELECT value_json FROM ai_report_cells WHERE run_id=?")
        .get(run.id)?.value_json,
      null,
    );
    f.closeStore();
    await processing;
    await f.tick();
    await f.stop();
    assert.equal(f.calls.length, 1);
  } finally {
    release?.({ cells: [] });
    await f.close();
  }
});

test("presentation revisions do not cancel extraction, and grouped CSV filters changed sources", async () => {
  const f = await fixture();
  try {
    const second = f.note("Private hidden source");
    const columns = [
      {
        id: "group",
        name: "Department",
        instruction: "Documented department",
        type: "text",
      },
      {
        id: "amount",
        name: "Amount",
        instruction: "Documented amount and currency",
        type: "currency",
      },
    ];
    const view = await f.create(
      f.definition({ sourceIds: [f.first.id, second.id], columns }),
    );
    const run = await f.run(view);
    const presentation = {
      mode: "bar",
      groupBy: "group",
      operation: "sum",
      metric: "amount",
    };
    let response = await f.request(`/${view.id}/presentation`, "PATCH", {
      revision: 1,
      presentation,
    });
    assert.equal(response.status, 200, await response.clone().text());
    const saved = await response.json();
    assert.equal(saved.item.revision, 1);
    assert.equal(saved.item.presentationRevision, 2);
    assert.equal(saved.runs[0].status, "queued");
    assert.equal(f.calls.length, 0);
    assert.equal(
      (
        await f.request(`/${view.id}/presentation`, "PATCH", {
          revision: 1,
          presentation,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await f.request(
          `/${view.id}/presentation`,
          "PATCH",
          { revision: 2, presentation },
          f.member.cookie,
        )
      ).status,
      404,
    );
    f.setHandler((body) => ({
      cells: JSON.parse(body.messages[1].content).columns.map(
        (column: any) => ({
          columnId: column.id,
          value:
            column.id === "group"
              ? "=Engineering"
              : { amount: 100, currency: "USD" },
          evidence: [{ quote }],
        }),
      ),
    }));
    await f.tick();
    let result = (await f.detail(view)).runs[0];
    assert.equal(result.aggregation.groups[0].value, 200);
    assert.equal(result.aggregation.groups[0].unit, "USD");
    f.change(second, { archived: true });
    result = (await f.detail(view)).runs[0];
    assert.equal(result.aggregation.groups[0].value, 100);
    assert.equal(result.aggregation.counts.unavailable, 1);
    response = await f.request(`/${view.id}/runs/${run.id}/grouped.csv`);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /"'=Engineering"/);
    assert.doesNotMatch(text, /Private hidden source|200/);
    assert.equal(
      (
        await f.request(
          `/${view.id}/runs/${run.id}/grouped.csv`,
          "GET",
          undefined,
          f.member.cookie,
        )
      ).status,
      404,
    );
    await f.request(`/${view.id}`, "PATCH", {
      revision: 1,
      definition: f.definition({
        columns: [
          {
            id: "new",
            name: "New",
            instruction: "New instruction",
            type: "number",
          },
        ],
      }),
    });
    result = (await f.detail(view)).runs[0];
    assert.equal(
      result.aggregation.compatible,
      true,
      "historical grouping uses the original run's column snapshot",
    );
    await f.request(`/${view.id}/presentation`, "PATCH", {
      revision: 2,
      presentation: {
        mode: "bar",
        groupBy: null,
        operation: "sum",
        metric: "new",
      },
    });
    result = (await f.detail(view)).runs[0];
    assert.equal(
      result.aggregation.compatible,
      false,
      "new-only columns cannot be applied to old results",
    );
    assert.equal(
      (await f.request(`/${view.id}/runs/${run.id}/grouped.csv`)).status,
      409,
    );
    assert.equal(
      (
        await f.request(`/${view.id}/presentation`, "PATCH", {
          revision: 3,
          runId: randomUUID(),
          presentation,
        })
      ).status,
      404,
    );
    const restored = await f.request(`/${view.id}/presentation`, "PATCH", {
      revision: 3,
      runId: run.id,
      presentation,
    });
    assert.equal(restored.status, 200, await restored.clone().text());
    assert.equal(
      (await restored.json()).runs[0].aggregation.groups[0].value,
      100,
    );
    assert.equal(
      (await f.request(`/${view.id}/runs/${run.id}/grouped.csv`)).status,
      200,
    );
    assert.equal(
      f.calls.length,
      2,
      "Restoring a historical chart does not buy extraction",
    );
  } finally {
    await f.close();
  }
});

test("report proposals are prompt-only private drafts with explicit apply, stale checks and durable replay identity", async () => {
  const f = await fixture();
  try {
    const view = await f.create();
    const proposal = {
      name: "Team report",
      question: "What team size was documented?",
      columns: [
        {
          name: "Team size",
          instruction: "Return documented team size, else null.",
          type: "number",
        },
      ],
      filters: { title: "", from: "", to: "" },
      notes: ["Review source selection."],
    };
    f.setHandler(() => proposal);
    const input = {
      requestId: randomUUID(),
      brief: "Report on documented engineering team sizes.",
      consent: true,
      viewId: view.id,
      revision: 1,
    };
    assert.equal(
      (await f.request("/drafts", "POST", { ...input, consent: false })).status,
      400,
    );
    const response = await f.request("/drafts", "POST", input);
    assert.equal(response.status, 201, await response.clone().text());
    const draft = (await response.json()).item;
    assert.deepEqual(JSON.parse((f.calls[0] as any).messages[1].content), {
      brief: input.brief,
    });
    assert.equal(
      f.store.db.prepare("SELECT COUNT(*) AS n FROM ai_report_views").get()?.n,
      1,
    );
    assert.equal(
      (await f.request("/drafts", "GET", undefined, f.member.cookie)).status,
      200,
    );
    assert.deepEqual(
      (
        await (
          await f.request("/drafts", "GET", undefined, f.member.cookie)
        ).json()
      ).items,
      [],
    );
    assert.equal(
      (
        await f.request(
          `/drafts/${draft.id}/apply`,
          "POST",
          { confirm: true },
          f.member.cookie,
        )
      ).status,
      404,
    );
    assert.equal(
      (await f.request(`/drafts/${draft.id}/apply`, "POST", { confirm: false }))
        .status,
      400,
    );
    const applied = await f.request(`/drafts/${draft.id}/apply`, "POST", {
      confirm: true,
    });
    assert.equal(applied.status, 200);
    assert.deepEqual((await applied.json()).definition.sourceIds, []);
    assert.equal(
      f.store.db.prepare("SELECT COUNT(*) AS n FROM ai_report_runs").get()?.n,
      0,
    );
    assert.equal((await f.request("/drafts", "POST", input)).status, 200);
    assert.equal(f.calls.length, 1);
    assert.equal(
      (
        await f.request("/drafts", "POST", {
          ...input,
          brief: "A different valid report brief.",
        })
      ).status,
      409,
    );
    await f.request(`/${view.id}`, "PATCH", {
      revision: 1,
      definition: f.definition({ name: "Changed report" }),
    });
    assert.equal(
      (await f.request(`/drafts/${draft.id}/apply`, "POST", { confirm: true }))
        .status,
      409,
    );
    const listed = (await (await f.request("/drafts")).json()).items[0];
    assert.equal(listed.sourceCurrent, false);
    assert.equal(listed.result, null);
    await f.request(`/drafts/${draft.id}`, "DELETE");
    assert.equal((await f.request("/drafts", "POST", input)).status, 410);
    assert.equal(f.calls.length, 1);
  } finally {
    await f.close();
  }
});

test("report draft budget survives deletion and rejects source IDs or fabricated output", async () => {
  const f = await fixture();
  try {
    const input = {
      requestId: randomUUID(),
      brief: "Report on documented engineering team sizes.",
      consent: true,
    };
    assert.equal(
      (
        await f.request("/drafts", "POST", {
          ...input,
          sourceIds: [f.first.id],
        })
      ).status,
      400,
    );
    f.setHandler(() => ({ name: "Invalid", sourceIds: [f.first.id] }));
    assert.equal((await f.request("/drafts", "POST", input)).status, 502);
    const draft = (await (await f.request("/drafts")).json()).items[0];
    assert.equal(draft.status, "failed");
    await f.request(`/drafts/${draft.id}`, "DELETE");
    for (let i = 0; i < 14; i++)
      f.store.db
        .prepare("INSERT INTO report_ai_attempts VALUES(?,?,?,?)")
        .run(randomUUID(), f.owner.workspaceId, f.owner.id, Date.now());
    assert.equal(
      (
        await f.request("/drafts", "POST", {
          ...input,
          requestId: randomUUID(),
        })
      ).status,
      429,
    );
    assert.equal(f.calls.length, 1);
  } finally {
    await f.close();
  }
});

test("report draft in-flight replays do not buy another request and stale generation is discarded", async () => {
  const f = await fixture();
  let release!: (value: unknown) => void;
  try {
    const view = await f.create();
    let begin!: () => void;
    const started = new Promise<void>((resolve) => {
      begin = resolve;
    });
    f.setHandler(() => {
      begin();
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const input = {
      requestId: randomUUID(),
      brief: "Report on documented engineering team sizes.",
      consent: true,
      viewId: view.id,
      revision: 1,
    };
    const pending = f.request("/drafts", "POST", input);
    await started;
    const replay = await f.request("/drafts", "POST", input);
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).item.status, "running");
    assert.equal(f.calls.length, 1);
    await f.request(`/${view.id}`, "PATCH", {
      revision: 1,
      definition: f.definition({ name: "Edited during generation" }),
    });
    release({
      name: "Team report",
      question: "What team size?",
      columns: [
        { name: "Team size", instruction: "Return team size", type: "number" },
      ],
      filters: { title: "", from: "", to: "" },
      notes: [],
    });
    assert.equal((await pending).status, 409);
    assert.equal(
      (await (await f.request("/drafts")).json()).items[0].result,
      null,
    );
  } finally {
    release?.({});
    await f.close();
  }
});
