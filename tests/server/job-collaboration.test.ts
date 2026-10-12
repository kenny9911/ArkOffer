import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { createDatabase } from "../../server/db.js";
import { hashToken } from "../../server/auth.js";
import { registerJobCollaboration } from "../../server/job-collaboration.js";

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "arkoffer-job-review-")),
    store = createDatabase(directory);
  function identity(workspaceId = randomUUID(), name = "Review tester") {
    const id = randomUUID(),
      token = randomBytes(32).toString("hex"),
      now = new Date().toISOString();
    store.db
      .prepare(
        "INSERT OR IGNORE INTO workspaces(id,name,created_at) VALUES(?,?,?)",
      )
      .run(workspaceId, "Synthetic job review", now);
    store.db
      .prepare(
        "INSERT INTO users(id,workspace_id,name,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        id,
        workspaceId,
        name,
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
  const owner = identity(undefined, "Role owner"),
    teammate = identity(owner.workspaceId, "Role reviewer"),
    other = identity();
  const now = new Date().toISOString(),
    item = {
      id: randomUUID(),
      title: "Platform engineer",
      description: "Build reliable APIs",
      salary: "Confirmed range",
      status: "draft",
      createdAt: now,
      updatedAt: now,
    };
  store.insert(owner.workspaceId, "jobs", item);
  const app = express();
  app.use(express.json());
  registerJobCollaboration(app, store);
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
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const endpoint = `jobs/${item.id}`;
  const view = async (cookie = owner.cookie) =>
    await (await call(cookie, `${endpoint}/collaboration`)).json();
  const comment = async (
    body = "Please confirm on-call expectations.",
    cookie = owner.cookie,
  ) => call(cookie, `${endpoint}/comments`, "POST", { body });
  const review = async (
    cookie = owner.cookie,
    reviewed = true,
    override: Record<string, unknown> = {},
  ) => {
    const data = await view(cookie),
      own = data.checks.find((check: any) => check.mine);
    return call(cookie, `${endpoint}/review`, "POST", {
      fingerprint: data.fingerprint,
      revision: own?.revision || 0,
      reviewed,
      ...override,
    });
  };
  return {
    store,
    owner,
    teammate,
    other,
    item,
    call,
    endpoint,
    view,
    comment,
    review,
  };
}

test("job comments expose workspace identities and enforce author-only optimistic edits and deletion", async (t) => {
  const f = await fixture(t);
  const added = await f.comment();
  assert.equal(added.status, 201);
  const id = (await added.json()).id,
    original = (await f.view()).comments[0];
  assert.equal(original.author.name, "Role owner");
  assert.equal(original.mine, true);
  assert.equal(original.revision, 1);
  assert.equal((await f.view(f.teammate.cookie)).comments[0].mine, false);
  const path = `${f.endpoint}/comments/${id}`;
  assert.equal(
    (
      await f.call(f.teammate.cookie, path, "PATCH", {
        body: "Cannot impersonate",
        revision: 1,
      })
    ).status,
    404,
  );
  assert.equal(
    (await f.call(f.teammate.cookie, path, "DELETE", { revision: 1 })).status,
    404,
  );
  const edits = await Promise.all(
    ["Confirmed on-call schedule", "Stale competing edit"].map((body) =>
      f.call(f.owner.cookie, path, "PATCH", { body, revision: 1 }),
    ),
  );
  assert.deepEqual(edits.map((response) => response.status).sort(), [200, 409]);
  assert.equal(
    (await f.call(f.owner.cookie, path, "DELETE", { revision: 1 })).status,
    409,
  );
  assert.equal((await f.view()).comments[0].revision, 2);
  assert.equal(
    (await f.call(f.owner.cookie, path, "DELETE", { revision: 2 })).status,
    200,
  );
  assert.equal((await f.view()).commentCount, 0);
});

test("job discussion rejects cross-workspace, revoked membership, malformed and deleted targets", async (t) => {
  const f = await fixture(t);
  await f.comment();
  await f.review();
  assert.equal((await f.call("", `${f.endpoint}/collaboration`)).status, 401);
  assert.equal(
    (await f.call(f.other.cookie, `${f.endpoint}/collaboration`)).status,
    404,
  );
  assert.equal((await f.comment("Foreign", f.other.cookie)).status, 404);
  const original = await f.view();
  assert.equal(
    (
      await f.call(f.other.cookie, `${f.endpoint}/review`, "POST", {
        fingerprint: original.fingerprint,
        reviewed: true,
        revision: 0,
      })
    ).status,
    404,
  );
  assert.equal(
    (await f.call(f.owner.cookie, "jobs/invalid/collaboration")).status,
    400,
  );
  f.store.db
    .prepare("UPDATE memberships SET status='suspended' WHERE user_id=?")
    .run(f.teammate.id);
  assert.equal(
    (await f.call(f.teammate.cookie, `${f.endpoint}/collaboration`)).status,
    401,
  );
  f.store.db.prepare("DELETE FROM resources WHERE id=?").run(f.item.id);
  assert.equal(
    (await f.call(f.owner.cookie, `${f.endpoint}/collaboration`)).status,
    404,
  );
  assert.equal((await f.comment()).status, 404);
  for (const table of [
    "job_comments",
    "job_review_checks",
    "job_review_history",
  ])
    assert.equal(
      f.store.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count,
      0,
    );
});

test("human review checks bind to the job version and cannot overwrite another tab's check", async (t) => {
  const f = await fixture(t),
    initial = await f.view();
  assert.equal((await f.review()).status, 200);
  assert.equal((await f.review(f.teammate.cookie)).status, 200);
  assert.equal((await f.view()).reviewedCount, 2);
  assert.equal(
    (await f.review(f.owner.cookie, false, { revision: 0 })).status,
    409,
  );
  const changed = {
    ...f.item,
    salary: "Updated confirmed range",
    updatedAt: new Date(Date.now() + 1000).toISOString(),
  };
  f.store.update(f.owner.workspaceId, "jobs", changed);
  const stale = await f.view();
  assert.notEqual(stale.fingerprint, initial.fingerprint);
  assert.equal(stale.reviewedCount, 0);
  assert.ok(
    stale.checks.every((check: any) => check.reviewed && !check.current),
  );
  assert.ok(stale.history.every((event: any) => !event.currentVersion));
  assert.equal(
    (await f.review(f.owner.cookie, true, { fingerprint: initial.fingerprint }))
      .status,
    409,
  );
  assert.equal((await f.review()).status, 200);
  assert.equal((await f.view()).reviewedCount, 1);
  assert.equal((await f.review(f.owner.cookie, false)).status, 200);
  const final = await f.view();
  assert.equal(final.reviewedCount, 0);
  assert.equal(final.history[0].reviewed, false);
  assert.equal(final.checks.find((check: any) => check.mine).revision, 3);
});

test("suspended or removed reviewers no longer count, while review history remains readable", async (t) => {
  const f = await fixture(t);
  await f.review();
  await f.review(f.teammate.cookie);
  f.store.db
    .prepare("UPDATE memberships SET status='suspended' WHERE user_id=?")
    .run(f.teammate.id);
  let data = await f.view();
  assert.equal(data.reviewedCount, 1);
  assert.equal(data.history.length, 2);
  assert.equal(
    data.checks.find((check: any) => !check.mine).memberActive,
    false,
  );
  f.store.db
    .prepare("DELETE FROM memberships WHERE user_id=?")
    .run(f.teammate.id);
  data = await f.view();
  assert.equal(data.reviewedCount, 1);
  const summary = await f.call(
    f.owner.cookie,
    "job-collaboration/summary",
    "POST",
    { ids: [f.item.id, randomUUID(), f.item.id] },
  );
  assert.deepEqual((await summary.json()).items, [
    { id: f.item.id, commentCount: 0, reviewedCount: 1 },
  ]);
  const foreign = await f.call(
    f.other.cookie,
    "job-collaboration/summary",
    "POST",
    { ids: [f.item.id] },
  );
  assert.deepEqual((await foreign.json()).items, []);
});

test("job comments enforce bounded input and durable creation limits even after deletion", async (t) => {
  const f = await fixture(t);
  for (const body of [" ", "a".repeat(4001)])
    assert.equal((await f.comment(body)).status, 400);
  assert.equal(
    (
      await f.call(f.owner.cookie, `${f.endpoint}/comments`, "POST", {
        body: "Spoofed author",
        userId: f.teammate.id,
      })
    ).status,
    400,
  );
  for (let index = 0; index < 30; index++)
    assert.equal((await f.comment(`Feedback ${index}`)).status, 201);
  assert.equal((await f.comment()).status, 429);
  const first = (await f.view()).comments[0];
  assert.equal(
    (
      await f.call(
        f.owner.cookie,
        `${f.endpoint}/comments/${first.id}`,
        "DELETE",
        { revision: first.revision },
      )
    ).status,
    200,
  );
  assert.equal((await f.comment()).status, 429);
  assert.equal(
    (await f.comment("Teammate can still comment", f.teammate.cookie)).status,
    201,
  );
  assert.equal(
    (
      await f.call(f.owner.cookie, "job-collaboration/summary", "POST", {
        ids: Array.from({ length: 201 }, () => randomUUID()),
      })
    ).status,
    400,
  );
});

test("review history retention keeps current review state and comments cannot exceed job capacity", async (t) => {
  const f = await fixture(t),
    fingerprint = (await f.view()).fingerprint;
  for (let index = 0; index < 205; index++) {
    f.store.db
      .prepare("INSERT INTO job_review_history VALUES(?,?,?,?,?,?,?)")
      .run(
        randomUUID(),
        f.owner.workspaceId,
        f.item.id,
        f.teammate.id,
        fingerprint,
        1,
        Date.now() - 10000 + index,
      );
    if (index < 200)
      f.store.db
        .prepare(
          "INSERT INTO job_comments(id,workspace_id,job_id,user_id,body,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          randomUUID(),
          f.owner.workspaceId,
          f.item.id,
          f.teammate.id,
          "Existing feedback",
          Date.now(),
          Date.now(),
        );
  }
  assert.equal((await f.review()).status, 200);
  const data = await f.view();
  assert.equal(data.history.length, 200);
  assert.equal(data.history[0].author.id, f.owner.id);
  assert.equal(data.reviewedCount, 1);
  assert.equal((await f.comment()).status, 409);
  assert.equal(
    f.store.db
      .prepare("SELECT COUNT(*) AS count FROM job_review_history")
      .get()!.count,
    200,
  );
});
