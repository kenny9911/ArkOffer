import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { createDatabase } from "../../server/db.js";
import { hashToken } from "../../server/auth.js";
import { registerScreening } from "../../server/screening.js";
import { registerScreeningReviews } from "../../server/screening-reviews.js";

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "arkoffer-screening-review-"));
  const store = createDatabase(directory);
  function identity(workspaceId = randomUUID(), name = "Screening owner") {
    const id = randomUUID(),
      token = randomBytes(32).toString("hex"),
      now = new Date().toISOString();
    store.db
      .prepare(
        "INSERT OR IGNORE INTO workspaces(id,name,created_at) VALUES(?,?,?)",
      )
      .run(workspaceId, "Synthetic screening reviews", now);
    store.db
      .prepare(
        "INSERT INTO users(id,workspace_id,name,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(id, workspaceId, name, `${id}@example.test`, "unused", "owner", now);
    store.db
      .prepare(
        "INSERT INTO sessions(token_hash,user_id,workspace_id,expires_at,created_at) VALUES(?,?,?,?,?)",
      )
      .run(hashToken(token), id, workspaceId, Date.now() + 3600000, now);
    return { id, workspaceId, name, cookie: `arkoffer_session=${token}` };
  }
  const owner = identity(),
    teammate = identity(owner.workspaceId, "Screening reviewer"),
    other = identity();
  const createScreen = (workspaceId = owner.workspaceId) => {
    const now = new Date().toISOString();
    return store.insert(workspaceId, "screenings", {
      id: randomUUID(),
      name: "Platform engineer",
      title: "Platform engineer",
      description: "Describe relevant professional experience.",
      status: "draft",
      createdAt: now,
      updatedAt: now,
      questions: [
        {
          prompt: "Describe an API you built.",
          type: "text",
          options: [],
          required: true,
        },
      ],
    });
  };
  const screen = createScreen(),
    sibling = createScreen(),
    foreign = createScreen(other.workspaceId);
  const app = express();
  app.use(express.json());
  registerScreening(app, store);
  registerScreeningReviews(app, store);
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
  const call = (
    path: string,
    method = "GET",
    body?: unknown,
    cookie = owner.cookie,
  ) =>
    fetch(`http://127.0.0.1:${address.port}/api/${path}`, {
      method,
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const publicationResult = await call(
    `screenings/${screen.id}/publish`,
    "POST",
    {},
  );
  assert.equal(publicationResult.status, 201);
  const publication = (await publicationResult.json()).item;
  const form = await (
    await call(`interviews/${publication.token}`, "GET", undefined, "")
  ).json();
  const submission = {
    candidateName: "Alex Example",
    email: "alex@example.test",
    consent: true,
    answers: [
      {
        questionId: form.item.questions[0].id,
        value: "I built a TypeScript API for a scheduling application.",
      },
    ],
  };
  assert.equal(
    (
      await call(
        `interviews/${publication.token}/responses`,
        "POST",
        submission,
        "",
      )
    ).status,
    201,
  );
  const response = (
    await (await call(`screenings/${screen.id}/responses`)).json()
  ).items[0];
  const path = `screenings/${screen.id}`;
  const review = (
    input: Record<string, unknown> = {},
    cookie = owner.cookie,
    target = path,
    responseId = response.id,
  ) =>
    call(
      `${target}/responses/${responseId}/review`,
      "PATCH",
      {
        status: "reviewed",
        notes: "Concrete API example; follow up on operations.",
        revision: 0,
        ...input,
      },
      cookie,
    );
  const list = async (cookie = owner.cookie) =>
    await (await call(`${path}/reviews`, "GET", undefined, cookie)).json();
  return {
    store,
    owner,
    teammate,
    other,
    screen,
    sibling,
    foreign,
    publication,
    response,
    submission,
    call,
    path,
    review,
    list,
  };
}

test("screening human reviews persist for teammates and concurrent edits require the current revision", async (t) => {
  const f = await fixture(t);
  assert.deepEqual((await f.list()).items, []);
  const saved = await f.review({ notes: "  Concrete API example.  " });
  assert.equal(saved.status, 200);
  const item = (await saved.json()).item;
  assert.equal(item.responseId, f.response.id);
  assert.equal(item.notes, "Concrete API example.");
  assert.equal(item.status, "reviewed");
  assert.equal(item.revision, 1);
  assert.deepEqual(item.reviewer, { id: f.owner.id, name: f.owner.name });
  assert.ok(!JSON.stringify(item).includes("@example.test"));
  assert.deepEqual((await f.list(f.teammate.cookie)).items, [item]);
  const concurrent = await Promise.all([
    f.review(
      {
        revision: 1,
        status: "progressed",
        notes: "Discuss in the next interview.",
      },
      f.teammate.cookie,
    ),
    f.review({
      revision: 1,
      status: "rejected",
      notes: "Competing human decision.",
    }),
  ]);
  assert.deepEqual(
    concurrent.map((result) => result.status).sort(),
    [200, 409],
  );
  const winner = (
    await concurrent.find((result) => result.status === 200)!.json()
  ).item;
  assert.equal(winner.revision, 2);
  assert.deepEqual((await f.list()).items, [winner]);
  assert.equal(
    (await f.review({ revision: 1, notes: "Stale overwrite" })).status,
    409,
  );
  assert.deepEqual((await f.list()).items, [winner]);
  assert.equal(
    (await f.review({ revision: 2, status: "unreviewed", notes: "" })).status,
    200,
  );
  assert.equal((await f.list()).items[0].revision, 3);
});

test("screening reviews reject anonymous, foreign workspace, suspended and removed members", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.review()).status, 200);
  for (const [cookie, expected] of [
    ["", 401],
    [f.other.cookie, 404],
  ] as const) {
    assert.equal(
      (await f.call(`${f.path}/reviews`, "GET", undefined, cookie)).status,
      expected,
    );
    assert.equal((await f.review({ revision: 1 }, cookie)).status, expected);
  }
  for (const mutation of [
    "UPDATE memberships SET status='suspended' WHERE user_id=?",
    "DELETE FROM memberships WHERE user_id=?",
  ]) {
    f.store.db.prepare(mutation).run(f.teammate.id);
    assert.equal(
      (await f.call(`${f.path}/reviews`, "GET", undefined, f.teammate.cookie))
        .status,
      401,
    );
    assert.equal(
      (await f.review({ revision: 1 }, f.teammate.cookie)).status,
      401,
    );
  }
  assert.equal((await f.list()).items[0].revision, 1);
});

test("screening review identities cannot target another screening or a missing response", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.review({}, f.owner.cookie, f.path, randomUUID())).status,
    404,
  );
  assert.equal(
    (await f.review({}, f.owner.cookie, f.path, "invalid-response-id")).status,
    400,
  );
  assert.equal(
    (await f.review({}, f.owner.cookie, `screenings/${f.sibling.id}`)).status,
    404,
  );
  assert.equal(
    (await f.review({}, f.other.cookie, `screenings/${f.foreign.id}`)).status,
    404,
  );
  assert.equal(
    (await f.review({}, f.owner.cookie, `screenings/${randomUUID()}`)).status,
    404,
  );
  assert.deepEqual((await f.list()).items, []);
});

test("screening reviews validate bounded notes, statuses and revisions before changing stored state", async (t) => {
  const f = await fixture(t);
  for (const input of [
    { status: "hired" },
    { status: null },
    { notes: "a".repeat(10_001) },
    { notes: 123 },
    { revision: -1 },
    { revision: 0.5 },
    { revision: Number.MAX_SAFE_INTEGER + 1 },
    { reviewerId: f.teammate.id },
    { workspaceId: f.other.workspaceId },
  ])
    assert.equal(
      (await f.review(input)).status,
      400,
      JSON.stringify(input).slice(0, 100),
    );
  assert.deepEqual((await f.list()).items, []);
  assert.equal((await f.review({ notes: "a".repeat(10_000) })).status, 200);
  assert.equal((await f.list()).items[0].notes.length, 10_000);
});

test("candidate public links and submission replay never expose hiring-team review notes or outcomes", async (t) => {
  const f = await fixture(t);
  const privateNotes = "PRIVATE_TEAM_REVIEW_e79415c2";
  assert.equal(
    (await f.review({ status: "rejected", notes: privateNotes })).status,
    200,
  );
  for (const result of [
    await f.call(`interviews/${f.publication.token}`, "GET", undefined, ""),
    await f.call(
      `interviews/${f.publication.token}/responses`,
      "POST",
      f.submission,
      "",
    ),
  ]) {
    assert.equal(result.status, 200);
    const payload = JSON.stringify(await result.json());
    for (const privateValue of [
      privateNotes,
      '"rejected"',
      '"reviewer"',
      '"revision"',
      '"notes"',
    ])
      assert.ok(
        !payload.includes(privateValue),
        `Public payload leaked ${privateValue}`,
      );
  }
  assert.equal(
    (await f.call(`${f.path}/responses`, "GET", undefined, "")).status,
    401,
  );
  assert.equal(
    (await f.call(`${f.path}/reviews`, "GET", undefined, "")).status,
    401,
  );
  assert.equal((await f.list()).items[0].notes, privateNotes);
});

test("screening review records cascade away with responses, publications and screenings", async (t) => {
  for (const target of [
    "screening_responses",
    "screening_publications",
    "resources",
  ]) {
    await t.test(target, async (t) => {
      const f = await fixture(t);
      assert.equal((await f.review()).status, 200);
      const id =
        target === "resources"
          ? f.screen.id
          : target === "screening_publications"
            ? f.publication.id
            : f.response.id;
      f.store.db.prepare(`DELETE FROM ${target} WHERE id=?`).run(id);
      assert.equal(
        f.store.db
          .prepare("SELECT COUNT(*) AS count FROM screening_response_reviews")
          .get()!.count,
        0,
      );
      assert.equal((await f.review({ revision: 1 })).status, 404);
      if (target !== "resources") assert.deepEqual((await f.list()).items, []);
      else assert.equal((await f.call(`${f.path}/reviews`)).status, 404);
    });
  }
});
