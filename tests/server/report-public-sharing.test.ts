import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
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

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "arkoffer-public-report-")),
    store = createDatabase(directory);
  let now = Date.now();
  const identity = (workspaceId = randomUUID(), role = "member") => {
    const id = randomUUID(),
      token = randomBytes(32).toString("hex"),
      date = new Date(now).toISOString();
    store.db
      .prepare(
        "INSERT OR IGNORE INTO workspaces(id,name,created_at) VALUES(?,?,?)",
      )
      .run(workspaceId, "Synthetic reports", date);
    store.db
      .prepare(
        "INSERT INTO users(id,workspace_id,name,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        id,
        workspaceId,
        "Synthetic member",
        `${id}@example.com`,
        "unused",
        role,
        date,
      );
    store.db
      .prepare(
        "INSERT INTO sessions(token_hash,user_id,workspace_id,expires_at,created_at) VALUES(?,?,?,?,?)",
      )
      .run(hashToken(token), id, workspaceId, now + 3600000, date);
    return { id, workspaceId, cookie: `arkoffer_session=${token}` };
  };
  const owner = identity(),
    member = identity(owner.workspaceId),
    other = identity();
  initializeAccess(store);
  const source = store.insert(owner.workspaceId, "conversations", {
    id: randomUUID(),
    title: "Private source title",
    transcript: "A private transcript quotation.",
    candidate: "Private candidate metadata",
    interviewer: "Private interviewer",
    archived: false,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  });
  const hidden = store.insert(owner.workspaceId, "conversations", {
    ...source,
    id: randomUUID(),
    title: "Unselected source secret",
  });
  for (const item of [source, hidden])
    registerResourceOwner(store, owner.workspaceId, item.id, owner.id);
  const app = express();
  app.use(express.json());
  registerPublicReportReads(app, store, { clock: () => now });
  const worker = registerReportViews(app, store, {
    ai: createAi({ apiKey: "" }),
    clock: () => now,
  });
  app.use((error: any, _req: any, res: any, _next: any) =>
    res
      .status(error.status || (error.name === "ZodError" ? 400 : 500))
      .json({ error: error.message }),
  );
  const viewId = randomUUID(),
    runId = randomUUID(),
    date = new Date(now).toISOString();
  const definition = {
    name: "Private report name",
    question: "Private extraction prompt",
    sourceIds: [source.id, hidden.id],
    columns: [
      {
        id: "selected",
        name: "Selected result",
        instruction: "Private instruction",
        type: "text",
      },
      {
        id: "hidden",
        name: "Hidden column",
        instruction: "Another private instruction",
        type: "text",
      },
    ],
    filters: { title: "", from: "", to: "" },
  };
  store.db
    .prepare(
      "INSERT INTO ai_report_views(id,workspace_id,author_id,definition,created_at,updated_at) VALUES(?,?,?,?,?,?)",
    )
    .run(
      viewId,
      owner.workspaceId,
      owner.id,
      JSON.stringify(definition),
      date,
      date,
    );
  store.db
    .prepare(
      "INSERT INTO ai_report_runs(id,view_id,workspace_id,author_id,session_hash,request_key,revision,definition,status,cell_count,model,created_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      runId,
      viewId,
      owner.workspaceId,
      owner.id,
      "unused",
      randomUUID(),
      1,
      JSON.stringify(definition),
      "complete",
      4,
      "private-model",
      date,
      date,
    );
  for (const item of [source, hidden]) {
    const snapshotId = randomUUID(),
      context = {
        title: String(item.title),
        transcript: String(item.transcript),
      };
    store.db
      .prepare(
        "INSERT INTO ai_report_sources(id,run_id,source_id,source_hash,context_hash,context_json,truncated,total_characters,status) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        snapshotId,
        runId,
        item.id,
        digest(context),
        digest(context),
        JSON.stringify(context),
        0,
        String(item.transcript).length,
        "complete",
      );
    for (const column of definition.columns)
      store.db
        .prepare(
          "INSERT INTO ai_report_cells(id,run_id,source_snapshot_id,column_id,status,value_json,evidence_json,annotation) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          randomUUID(),
          runId,
          snapshotId,
          column.id,
          "complete",
          JSON.stringify(
            item.id === source.id && column.id === "selected"
              ? "Reviewed public answer"
              : "Unselected secret answer",
          ),
          JSON.stringify([
            {
              quote: item.transcript,
              start: 0,
              end: String(item.transcript).length,
            },
          ]),
          "Private annotation",
        );
  }
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No server address");
  const base = `http://127.0.0.1:${address.port}`;
  const request = (
    path = "",
    method = "GET",
    body?: unknown,
    cookie = owner.cookie,
  ) =>
    fetch(`${base}/api/report-views/${viewId}/public-links${path}`, {
      method,
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const input = {
    runId,
    title: "Reviewed public title",
    summary: "Reviewed public description",
    sourceIds: [source.id],
    columnIds: ["selected"],
    includeSourceTitles: false,
    allowCsv: false,
    expiresInDays: 7,
  };
  const preview = async (extra = {}) => {
    const response = await request("/preview", "POST", { ...input, ...extra });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const publish = async (extra = {}) => {
    const reviewed = await preview(extra),
      response = await request("", "POST", {
        previewId: reviewed.previewId,
        confirmed: true,
      });
    assert.equal(response.status, 201, await response.clone().text());
    const { item } = await response.json();
    return { ...item, token: item.path.split("/").pop(), preview: reviewed };
  };
  const read = (token: string, suffix = "") =>
    fetch(`${base}/api/public-reports/${token}${suffix}`);
  return {
    store,
    owner,
    member,
    other,
    source,
    hidden,
    viewId,
    runId,
    input,
    base,
    request,
    preview,
    publish,
    read,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    async close() {
      await worker.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("confirmed public snapshot exposes only selected reviewed values, hash-only tokens and no private report API", async () => {
  const f = await fixture();
  try {
    const preview = await f.preview();
    assert.equal(
      (
        await f.request("", "POST", {
          previewId: preview.previewId,
          confirmed: false,
        })
      ).status,
      400,
    );
    assert.equal((await f.read("0".repeat(64))).status, 404);
    const response = await f.request("", "POST", {
      previewId: preview.previewId,
      confirmed: true,
    });
    assert.equal(response.status, 201);
    const { item } = await response.json(),
      token = item.path.split("/").pop();
    assert.equal(
      (
        await f.request("", "POST", {
          previewId: preview.previewId,
          confirmed: true,
        })
      ).status,
      409,
    );
    const result = await f.read(token),
      body = await result.json();
    assert.equal(result.status, 200);
    assert.deepEqual(body.report, preview.report);
    assert.equal(body.report.rows[0].label, "Conversation 1");
    for (const secret of [
      f.source.id,
      f.hidden.id,
      f.viewId,
      f.runId,
      "private-model",
      "Private source title",
      "Private candidate metadata",
      "Private interviewer",
      "Private extraction prompt",
      "Private instruction",
      "Private annotation",
      "Unselected secret answer",
      "A private transcript quotation.",
    ])
      assert.equal(JSON.stringify(body).includes(secret), false, secret);
    assert.match(result.headers.get("cache-control")!, /no-store/);
    assert.equal(result.headers.get("referrer-policy"), "no-referrer");
    assert.match(result.headers.get("x-robots-tag")!, /noindex/);
    assert.equal((await f.read(token, "/export.csv")).status, 403);
    const raw = f.store.db
      .prepare("SELECT * FROM ai_report_public_links")
      .get()!;
    assert.equal(raw.token_hash, hashToken(token));
    assert.equal(JSON.stringify(raw).includes(token), false);
    const listed = await (await f.request()).json();
    assert.equal(listed.items[0].status, "active");
    assert.equal(JSON.stringify(listed).includes(token), false);
    assert.equal(
      (await fetch(`${f.base}/api/report-views/${f.viewId}`)).status,
      401,
    );
    assert.equal((await f.read(token.slice(1))).status, 404);
  } finally {
    await f.close();
  }
});

test("CSV requires explicit permission, uses the same selected projection and neutralizes formulas", async () => {
  const f = await fixture();
  try {
    f.store.db
      .prepare(
        "UPDATE ai_report_cells SET value_json=? WHERE column_id='selected'",
      )
      .run(JSON.stringify('=HYPERLINK("https://example.com")'));
    const link = await f.publish({ allowCsv: true, includeSourceTitles: true }),
      response = await f.read(link.token, "/export.csv"),
      text = await response.text();
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("content-disposition"),
      'attachment; filename="shared-report.csv"',
    );
    assert.match(text, /'=HYPERLINK/);
    assert.match(text, /Private source title/);
    assert.equal(text.includes("Private annotation"), false);
    assert.equal(text.includes("Hidden column"), false);
    assert.equal(text.split("\r\n").length, 2);
    await f.request(`/${link.id}`, "DELETE");
    assert.equal((await f.read(link.token, "/export.csv")).status, 404);
  } finally {
    await f.close();
  }
});

test("only report authors with source sharing authority can publish, including through shared report grants", async () => {
  const f = await fixture();
  try {
    f.store.db
      .prepare(
        "INSERT INTO ai_report_grants(view_id,user_id,permission,created_at) VALUES(?,?,?,?)",
      )
      .run(f.viewId, f.member.id, "editor", new Date(f.now()).toISOString());
    assert.equal(
      (await f.request("/preview", "POST", f.input, f.member.cookie)).status,
      403,
    );
    assert.equal(
      (await f.request("", "GET", undefined, f.other.cookie)).status,
      404,
    );
    f.store.db
      .prepare("UPDATE resource_access SET owner_id=? WHERE resource_id=?")
      .run(f.member.id, f.source.id);
    f.store.db
      .prepare(
        "INSERT INTO resource_grants(resource_id,user_id,permission,created_at) VALUES(?,?,?,?)",
      )
      .run(f.source.id, f.owner.id, "editor", new Date(f.now()).toISOString());
    assert.equal((await f.request("/preview", "POST", f.input)).status, 409);
    // Administrators have the same manage authority as the existing conversation-sharing API.
    f.store.db
      .prepare(
        "UPDATE memberships SET role='admin' WHERE user_id=? AND workspace_id=?",
      )
      .run(f.owner.id, f.owner.workspaceId);
    const link = await f.publish();
    assert.equal((await f.read(link.token)).status, 200);
    f.store.db
      .prepare(
        "UPDATE memberships SET role='member' WHERE user_id=? AND workspace_id=?",
      )
      .run(f.owner.id, f.owner.workspaceId);
    assert.equal((await f.read(link.token)).status, 404);
  } finally {
    await f.close();
  }
});

test("preview binds the current complete run and rejects changed data, stale previews and duplicate publication", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (
        await f.request("/preview", "POST", {
          ...f.input,
          columnIds: ["missing"],
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await f.request("/preview", "POST", {
          ...f.input,
          sourceIds: [f.source.id, f.source.id],
        })
      ).status,
      400,
    );
    assert.equal(
      (await f.request("/preview", "POST", { ...f.input, expiresInDays: 31 }))
        .status,
      400,
    );
    f.store.db
      .prepare("UPDATE ai_report_runs SET status='processing' WHERE id=?")
      .run(f.runId);
    assert.equal((await f.request("/preview", "POST", f.input)).status, 409);
    f.store.db
      .prepare("UPDATE ai_report_runs SET status='complete' WHERE id=?")
      .run(f.runId);
    const reviewed = await f.preview();
    f.store.db
      .prepare(
        "UPDATE ai_report_cells SET value_json=? WHERE column_id='selected'",
      )
      .run(JSON.stringify("Changed result"));
    assert.equal(
      (
        await f.request("", "POST", {
          previewId: reviewed.previewId,
          confirmed: true,
        })
      ).status,
      409,
    );
    const next = await f.preview();
    f.advance(600001);
    assert.equal(
      (
        await f.request("", "POST", {
          previewId: next.previewId,
          confirmed: true,
        })
      ).status,
      409,
    );
    const current = await f.preview();
    const responses = await Promise.all([
      f.request("", "POST", { previewId: current.previewId, confirmed: true }),
      f.request("", "POST", { previewId: current.previewId, confirmed: true }),
    ]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
  } finally {
    await f.close();
  }
});

test("source content and authority changes invalidate both reads and export permanently", async () => {
  const f = await fixture();
  try {
    const link = await f.publish({ allowCsv: true });
    f.store.update(f.owner.workspaceId, "conversations", {
      ...f.source,
      candidate: "Changed candidate metadata",
    });
    assert.equal((await f.read(link.token)).status, 404);
    f.store.update(f.owner.workspaceId, "conversations", f.source);
    assert.equal((await f.read(link.token, "/export.csv")).status, 404);
    assert.equal(
      (await (await f.request()).json()).items[0].status,
      "invalidated",
    );
    const second = await f.publish();
    f.store.db
      .prepare("UPDATE resource_access SET owner_id=? WHERE resource_id=?")
      .run(f.member.id, f.source.id);
    assert.equal((await f.read(second.token)).status, 404);
    f.store.db
      .prepare("UPDATE resource_access SET owner_id=? WHERE resource_id=?")
      .run(f.owner.id, f.source.id);
    assert.equal((await f.read(second.token)).status, 404);
    const third = await f.publish();
    f.store.update(f.owner.workspaceId, "conversations", {
      ...f.source,
      transcript: "Changed content",
    });
    assert.equal((await f.read(third.token)).status, 404);
    assert.equal((await f.request("/preview", "POST", f.input)).status, 409);
  } finally {
    await f.close();
  }
});

test("author removal, report revision changes and selected result changes close public access", async () => {
  const f = await fixture();
  try {
    const memberLink = await f.publish();
    f.store.db
      .prepare(
        "UPDATE memberships SET status='suspended' WHERE user_id=? AND workspace_id=?",
      )
      .run(f.owner.id, f.owner.workspaceId);
    assert.equal((await f.read(memberLink.token)).status, 404);
    f.store.db
      .prepare(
        "UPDATE memberships SET status='active' WHERE user_id=? AND workspace_id=?",
      )
      .run(f.owner.id, f.owner.workspaceId);
    assert.equal((await f.read(memberLink.token)).status, 404);
    const revisionLink = await f.publish();
    f.store.db
      .prepare("UPDATE ai_report_views SET revision=revision+1 WHERE id=?")
      .run(f.viewId);
    assert.equal((await f.read(revisionLink.token)).status, 404);
    f.store.db
      .prepare("UPDATE ai_report_views SET revision=1 WHERE id=?")
      .run(f.viewId);
    const resultLink = await f.publish();
    f.store.db
      .prepare(
        "UPDATE ai_report_cells SET value_json=? WHERE column_id='selected'",
      )
      .run(JSON.stringify("Changed selected answer"));
    assert.equal((await f.read(resultLink.token)).status, 404);
  } finally {
    await f.close();
  }
});

test("expired and revoked tokens stay unavailable and cleanup deletes their stored snapshots", async () => {
  const f = await fixture();
  try {
    const link = await f.publish({ expiresInDays: 1 });
    assert.equal(
      (await f.request(`/${link.id}`, "DELETE", undefined, f.member.cookie))
        .status,
      404,
    );
    assert.equal((await f.request(`/${link.id}`, "DELETE")).status, 200);
    assert.equal((await f.request(`/${link.id}`, "DELETE")).status, 200);
    assert.equal((await f.read(link.token)).status, 404);
    const expiry = await f.publish({ expiresInDays: 1 });
    f.advance(86400000);
    assert.equal((await f.read(expiry.token)).status, 404);
    f.store.db.prepare("DELETE FROM ai_report_views WHERE id=?").run(f.viewId);
    assert.equal(
      Number(
        f.store.db
          .prepare("SELECT COUNT(*) AS n FROM ai_report_public_links")
          .get()?.n,
      ),
      0,
    );
    assert.equal((await f.read(expiry.token)).status, 404);
  } finally {
    await f.close();
  }
});
