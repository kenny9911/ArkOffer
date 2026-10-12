import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { createDatabase } from "../../server/db.js";
import { hashToken } from "../../server/auth.js";
import { registerConversationOwner } from "../../server/access.js";
import { registerJobDrafts } from "../../server/job-drafts.js";
import { registerJobSources } from "../../server/job-sources.js";
import type { createAi } from "../../server/ai.js";
import { pdfFixture, docxFixture } from "./document-fixtures.js";

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "arkoffer-job-sources-")),
    store = createDatabase(directory);
  function identity(workspaceId = randomUUID()) {
    const id = randomUUID(),
      token = randomBytes(32).toString("hex"),
      now = new Date().toISOString();
    store.db
      .prepare(
        "INSERT OR IGNORE INTO workspaces(id,name,created_at) VALUES(?,?,?)",
      )
      .run(workspaceId, "Synthetic jobs", now);
    store.db
      .prepare(
        "INSERT INTO users(id,workspace_id,name,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        id,
        workspaceId,
        "Job tester",
        `${id}@example.test`,
        "unused",
        "member",
        now,
      );
    store.db
      .prepare(
        "INSERT INTO sessions(token_hash,user_id,workspace_id,expires_at,created_at) VALUES(?,?,?,?,?)",
      )
      .run(hashToken(token), id, workspaceId, Date.now() + 3600000, now);
    return { id, workspaceId, cookie: `arkoffer_session=${token}` };
  }
  const owner = identity(),
    teammate = identity(owner.workspaceId),
    other = identity();
  let enabled = true,
    calls = 0,
    captured: unknown,
    complete = async () =>
      JSON.stringify({
        description: "Reviewed role facts",
        suggestions: [],
        missingDetails: [],
      });
  const ai = {
    model: "synthetic",
    allowed: () => enabled,
    complete: async (messages: unknown) => {
      calls++;
      captured = messages;
      return complete();
    },
  } as unknown as ReturnType<typeof createAi>;
  const app = express();
  app.use(express.json());
  registerJobSources(app, store);
  registerJobDrafts(app, store, { ai });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const call = (cookie: string, path: string, method = "GET", body?: unknown) =>
    fetch(`http://127.0.0.1:${address.port}/api/${path}`, {
      method,
      headers: {
        Cookie: cookie,
        ...(body instanceof FormData
          ? {}
          : { "Content-Type": "application/json" }),
      },
      body:
        body === undefined
          ? undefined
          : body instanceof FormData
            ? body
            : JSON.stringify(body),
    });
  const upload = (
    cookie: string,
    bytes: Buffer,
    mime = "application/pdf",
    name = "Role.pdf",
  ) => {
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(bytes)], { type: mime }),
      name,
    );
    return call(cookie, "job-sources/documents", "POST", form);
  };
  const reference = (source: any) => ({
    kind: source.kind,
    id: source.id,
    fingerprint: source.fingerprint,
  });
  const input = (source: any, mode = "ai") => ({
    requestId: randomUUID(),
    source: reference(source),
    details: { title: "Platform Engineer" },
    brief: "Use confirmed role facts.",
    mode,
  });
  const conversation = (
    text = "Hiring manager: We need a TypeScript engineer.",
  ) => {
    const now = new Date().toISOString(),
      item = {
        id: randomUUID(),
        title: "Private role intake",
        transcript: text,
        date: now,
        createdAt: now,
        updatedAt: now,
      };
    store.insert(owner.workspaceId, "conversations", item);
    registerConversationOwner(store, owner.workspaceId, item.id, owner.id);
    return item;
  };
  return {
    directory,
    store,
    owner,
    teammate,
    other,
    call,
    upload,
    reference,
    input,
    conversation,
    calls: () => calls,
    captured: () => captured,
    setEnabled: (value: boolean) => {
      enabled = value;
    },
    setComplete: (value: () => Promise<string>) => {
      complete = value;
    },
  };
}

test("job templates create private reviewed drafts without AI; applying is explicit and idempotent", async (t) => {
  const f = await fixture(t);
  f.setEnabled(false);
  const response = await f.call(f.owner.cookie, "job-sources/templates");
  assert.equal(response.status, 200);
  const template = (await response.json()).items[0],
    input = f.input(template, "manual");
  const created = await f.call(f.owner.cookie, "job-drafts", "POST", input);
  assert.equal(created.status, 201);
  const draft = (await created.json()).item;
  assert.equal(draft.model, "Source copy");
  assert.equal(draft.result.description, template.text);
  assert.equal(f.calls(), 0);
  assert.equal(f.store.list(f.owner.workspaceId, "jobs").length, 0);
  assert.equal(
    (await f.call(f.owner.cookie, "job-drafts", "POST", input)).status,
    200,
  );
  assert.equal(
    (await (await f.call(f.teammate.cookie, "job-drafts")).json()).items.length,
    0,
  );
  assert.equal(
    (
      await f.call(f.owner.cookie, `job-drafts/${draft.id}/apply`, "POST", {
        description: "A clear reviewed job description",
      })
    ).status,
    400,
  );
  const applied = await f.call(
    f.owner.cookie,
    `job-drafts/${draft.id}/apply`,
    "POST",
    { description: "A clear reviewed job description", confirm: true },
  );
  assert.equal(applied.status, 200);
  const job = (await applied.json()).item;
  assert.equal(job.status, "draft");
  assert.equal(job.title, "Platform Engineer");
  const repeat = await f.call(
    f.owner.cookie,
    `job-drafts/${draft.id}/apply`,
    "POST",
    { description: "Changed", confirm: true },
  );
  assert.equal((await repeat.json()).item.description, job.description);
  assert.equal(f.store.list(f.owner.workspaceId, "jobs").length, 1);
});

test("PDF and DOCX job sources stay private, remove originals, and invalidate drafts on source deletion", async (t) => {
  const f = await fixture(t);
  for (const [bytes, mime, name] of [
    [pdfFixture(["Build reliable APIs"]), "application/pdf", "Role.pdf"],
    [
      docxFixture(["Build reliable APIs"]),
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Role.docx",
    ],
  ] as const) {
    const result = await f.upload(f.owner.cookie, bytes, mime, name);
    assert.equal(result.status, 201);
    const source = (await result.json()).item;
    assert.match(source.text, /Build reliable APIs/);
    assert.deepEqual(readdirSync(join(f.directory, "job-source-uploads")), []);
    assert.equal(f.store.list(f.owner.workspaceId, "conversations").length, 0);
    assert.equal(
      (await (await f.call(f.teammate.cookie, "job-sources/documents")).json())
        .items.length,
      0,
    );
    assert.equal(
      (await f.call(f.teammate.cookie, "job-drafts", "POST", f.input(source)))
        .status,
      404,
    );
    assert.equal(f.calls(), 0);
    const draftResponse = await f.call(
      f.owner.cookie,
      "job-drafts",
      "POST",
      f.input(source, "manual"),
    );
    const draft = (await draftResponse.json()).item;
    assert.equal(
      (
        await f.call(
          f.other.cookie,
          `job-sources/documents/${source.id}`,
          "DELETE",
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await f.call(
          f.owner.cookie,
          `job-sources/documents/${source.id}`,
          "DELETE",
        )
      ).status,
      200,
    );
    const hidden = (
      await (await f.call(f.owner.cookie, "job-drafts")).json()
    ).items.find((item: any) => item.id === draft.id);
    assert.equal(hidden.result, null);
    assert.equal(hidden.title, "Source unavailable");
    assert.equal(hidden.status, "stale");
    assert.equal(
      (
        await f.call(f.owner.cookie, `job-drafts/${draft.id}/apply`, "POST", {
          description: "Leaked",
          confirm: true,
        })
      ).status,
      409,
    );
  }
});

test("invalid, oversized and overlong job uploads are rejected with no retained originals or text", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.upload(f.owner.cookie, Buffer.from("not a PDF"))).status,
    422,
  );
  assert.equal(
    (
      await f.upload(
        f.owner.cookie,
        Buffer.from("plain"),
        "text/plain",
        "notes.txt",
      )
    ).status,
    415,
  );
  assert.equal(
    (await f.upload(f.owner.cookie, Buffer.alloc(10 * 1024 * 1024 + 1))).status,
    413,
  );
  assert.equal(
    (
      await f.upload(
        f.owner.cookie,
        docxFixture(["x".repeat(60001)]),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "long.docx",
      )
    ).status,
    413,
  );
  assert.deepEqual(readdirSync(join(f.directory, "job-source-uploads")), []);
  assert.equal(
    (await (await f.call(f.owner.cookie, "job-sources/documents")).json()).items
      .length,
    0,
  );
});

test("intake previews obey grants and source revisions; AI receives only server-resolved evidence", async (t) => {
  const f = await fixture(t),
    note = f.conversation();
  assert.equal(
    (
      await (
        await f.call(f.teammate.cookie, "job-sources/conversations")
      ).json()
    ).items.length,
    0,
  );
  assert.equal(
    (await f.call(f.teammate.cookie, `job-sources/conversations/${note.id}`))
      .status,
    404,
  );
  const source = (
    await (
      await f.call(f.owner.cookie, `job-sources/conversations/${note.id}`)
    ).json()
  ).item;
  assert.equal(
    (
      await f.call(f.owner.cookie, "job-drafts", "POST", {
        ...f.input(source),
        source: { ...f.reference(source), text: "Client-supplied replacement" },
      })
    ).status,
    400,
  );
  const created = await f.call(
    f.owner.cookie,
    "job-drafts",
    "POST",
    f.input(source),
  );
  assert.equal(created.status, 201);
  const messages = f.captured() as any[];
  assert.equal(JSON.parse(messages[1].content).source.text, note.transcript);
  f.store.update(f.owner.workspaceId, "conversations", {
    ...note,
    transcript: "Changed role facts",
    updatedAt: "changed",
  });
  const list = (await (await f.call(f.owner.cookie, "job-drafts")).json())
    .items;
  assert.equal(list[0].result, null);
  assert.equal(list[0].sourceCurrent, false);
  assert.equal(
    (await f.call(f.owner.cookie, "job-drafts", "POST", f.input(source)))
      .status,
    409,
  );
  assert.equal(f.calls(), 1);
});

test("revoked intake access during generation hides the result and blocks apply and request replay", async (t) => {
  const f = await fixture(t),
    note = f.conversation();
  f.store.db
    .prepare("INSERT INTO resource_grants VALUES(?,?,?,?)")
    .run(note.id, f.teammate.id, "viewer", new Date().toISOString());
  const source = (
      await (
        await f.call(f.teammate.cookie, `job-sources/conversations/${note.id}`)
      ).json()
    ).item,
    input = f.input(source);
  f.setComplete(async () => {
    f.store.db
      .prepare("DELETE FROM resource_grants WHERE resource_id=? AND user_id=?")
      .run(note.id, f.teammate.id);
    return JSON.stringify({
      description: "Private intake facts",
      suggestions: [],
      missingDetails: [],
    });
  });
  assert.equal(
    (await f.call(f.teammate.cookie, "job-drafts", "POST", input)).status,
    409,
  );
  const draft = (await (await f.call(f.teammate.cookie, "job-drafts")).json())
    .items[0];
  assert.equal(draft.result, null);
  assert.equal(draft.title, "Source unavailable");
  const replay = (
    await (await f.call(f.teammate.cookie, "job-drafts", "POST", input)).json()
  ).item;
  assert.equal(replay.result, null);
  assert.equal(f.calls(), 1);
  assert.equal(
    (
      await f.call(f.teammate.cookie, `job-drafts/${draft.id}/apply`, "POST", {
        description: "Private intake facts",
        confirm: true,
      })
    ).status,
    409,
  );
});

test("membership removal during drafting cannot return or apply source-derived output", async (t) => {
  const f = await fixture(t),
    template = (
      await (await f.call(f.owner.cookie, "job-sources/templates")).json()
    ).items[0];
  f.setComplete(async () => {
    f.store.db
      .prepare(
        "UPDATE memberships SET status='suspended' WHERE workspace_id=? AND user_id=?",
      )
      .run(f.owner.workspaceId, f.owner.id);
    return JSON.stringify({
      description: "No access",
      suggestions: [],
      missingDetails: [],
    });
  });
  const response = await f.call(
    f.owner.cookie,
    "job-drafts",
    "POST",
    f.input(template),
  );
  assert.equal(response.status, 401);
  assert.equal((await f.call(f.owner.cookie, "job-drafts")).status, 401);
  assert.equal(f.store.list(f.owner.workspaceId, "jobs").length, 0);
});

test("long imported descriptions can be improved after a reviewed workspace apply", async (t) => {
  const f = await fixture(t),
    uploaded = await f.upload(
      f.owner.cookie,
      docxFixture(["x".repeat(50001)]),
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Long role.docx",
    );
  assert.equal(uploaded.status, 201);
  const source = (await uploaded.json()).item;
  const draft = (
    await (
      await f.call(
        f.owner.cookie,
        "job-drafts",
        "POST",
        f.input(source, "manual"),
      )
    ).json()
  ).item;
  const applied = await f.call(
    f.owner.cookie,
    `job-drafts/${draft.id}/apply`,
    "POST",
    { description: source.text, confirm: true },
  );
  assert.equal(applied.status, 200);
  const job = (await applied.json()).item;
  const response = await f.call(f.owner.cookie, "job-drafts", "POST", {
    requestId: randomUUID(),
    jobId: job.id,
    sourceVersion: job.updatedAt,
    brief: "Improve this imported description.",
  });
  assert.equal(response.status, 201);
  assert.equal(f.calls(), 1);
});
