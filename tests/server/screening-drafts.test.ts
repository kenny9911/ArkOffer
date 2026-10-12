import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { createDatabase } from "../../server/db.js";
import { hashToken } from "../../server/auth.js";
import { registerScreeningDrafts } from "../../server/screening-drafts.js";
import type { createAi } from "../../server/ai.js";
import { registerScreening } from "../../server/screening.js";

const validResult = () => ({
  title: "Backend engineering screen",
  description: "Tell us about your professional experience building services.",
  questions: [
    {
      prompt: "Tell us about a service you built.",
      type: "text",
      options: [],
      required: true,
      rubric:
        "Look for the project context, personal contribution and observed outcome.",
    },
    {
      prompt: "Have you used TypeScript professionally?",
      type: "yes-no",
      options: [],
      required: true,
      rubric:
        "Record the candidate's response and follow up on their experience; do not decide automatically.",
    },
    {
      prompt: "Which area would you like to discuss?",
      type: "multiple-choice",
      options: ["Reliability", "API design"],
      required: false,
      rubric: "Use their selection to guide the next conversation.",
    },
  ],
  notes: ["Confirm the expected screening length."],
});
const proposal = () => JSON.stringify(validResult());
async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "arkoffer-screening-drafts-")),
    store = createDatabase(directory);
  function identity(workspaceId = randomUUID()) {
    const id = randomUUID(),
      token = randomBytes(32).toString("hex"),
      date = new Date().toISOString();
    store.db
      .prepare(
        "INSERT OR IGNORE INTO workspaces(id,name,created_at) VALUES(?,?,?)",
      )
      .run(workspaceId, "Synthetic draft tests", date);
    store.db
      .prepare(
        "INSERT INTO users(id,workspace_id,name,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        id,
        workspaceId,
        "Draft tester",
        `${id}@example.com`,
        "unused",
        "owner",
        date,
      );
    store.db
      .prepare(
        "INSERT INTO sessions(token_hash,user_id,workspace_id,expires_at,created_at) VALUES(?,?,?,?,?)",
      )
      .run(hashToken(token), id, workspaceId, Date.now() + 3600000, date);
    return { id, workspaceId, cookie: `arkoffer_session=${token}`, token };
  }
  const owner = identity(),
    teammate = identity(owner.workspaceId),
    other = identity();
  let allowed = true,
    calls = 0,
    complete: () => Promise<string> = async () => proposal();
  const ai = {
    provider: "synthetic",
    model: "synthetic-model",
    configured: true,
    allowed: () => allowed,
    complete: async () => {
      calls++;
      return complete();
    },
  } as ReturnType<typeof createAi>;
  const app = express();
  app.use(express.json());
  registerScreening(app, store);
  registerScreeningDrafts(app, store, { ai });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const call = (cookie: string, path: string, method = "GET", body?: unknown) =>
    fetch(`http://127.0.0.1:${address.port}/api/${path}`, {
      method,
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const input = () => ({
    requestId: randomUUID(),
    brief:
      "Draft questions for a backend engineer building TypeScript services.",
    questionCount: 3,
    consent: true,
  });
  const job = () => {
    const now = new Date().toISOString();
    return store.insert(owner.workspaceId, "jobs", {
      id: randomUUID(),
      title: "Backend Engineer",
      description: "Existing description",
      status: "open",
      salary: "Keep this pay",
      ats: { id: "source-job" },
      createdAt: now,
      updatedAt: now,
    });
  };
  return {
    store,
    owner,
    other,
    teammate,
    call,
    input,
    job,
    setAllowed: (value: boolean) => {
      allowed = value;
    },
    setComplete: (value: () => Promise<string>) => {
      complete = value;
    },
    calls: () => calls,
  };
}

test("screening proposals stay private until reviewed; apply only opens a compatible manual draft", async (t) => {
  const f = await fixture(t),
    input = f.input();
  assert.equal(
    (await f.call("", "screening-drafts", "POST", input)).status,
    401,
  );
  assert.equal(
    (
      await f.call(f.owner.cookie, "screening-drafts", "POST", {
        ...input,
        consent: false,
      })
    ).status,
    400,
  );
  const response = await f.call(
    f.owner.cookie,
    "screening-drafts",
    "POST",
    input,
  );
  assert.equal(response.status, 201);
  const draft = (await response.json()).item;
  assert.equal(f.calls(), 1);
  assert.equal(f.store.list(f.owner.workspaceId, "screenings").length, 0);
  for (const other of [f.teammate, f.other]) {
    assert.equal(
      (await (await f.call(other.cookie, "screening-drafts")).json()).items
        .length,
      0,
    );
    assert.equal(
      (
        await f.call(
          other.cookie,
          `screening-drafts/${draft.id}/apply`,
          "POST",
          { confirm: true },
        )
      ).status,
      404,
    );
    assert.equal(
      (await f.call(other.cookie, `screening-drafts/${draft.id}`, "DELETE"))
        .status,
      404,
    );
  }
  assert.equal(
    (
      await f.call(
        f.owner.cookie,
        `screening-drafts/${draft.id}/apply`,
        "POST",
        {},
      )
    ).status,
    400,
  );
  const applied = await f.call(
    f.owner.cookie,
    `screening-drafts/${draft.id}/apply`,
    "POST",
    { confirm: true },
  );
  const item = (await applied.json()).item;
  assert.equal(applied.status, 200);
  assert.equal(item.id, undefined);
  assert.equal(item.status, "draft");
  assert.equal(item.questions.length, 3);
  assert.ok(item.questions[0].rubric);
  assert.equal(f.store.list(f.owner.workspaceId, "screenings").length, 0);
  const repeat = await (
    await f.call(f.owner.cookie, `screening-drafts/${draft.id}/apply`, "POST", {
      confirm: true,
    })
  ).json();
  assert.deepEqual(repeat.item, item);
  assert.equal(repeat.alreadyApplied, true);
  const now = new Date().toISOString();
  const saved = f.store.insert(f.owner.workspaceId, "screenings", {
    ...item,
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
  });
  const publication = await f.call(
    f.owner.cookie,
    `screenings/${saved.id}/publish`,
    "POST",
    {},
  );
  assert.equal(publication.status, 201);
  const token = (await publication.json()).item.token;
  const candidate = await (await f.call("", `interviews/${token}`)).json();
  assert.equal(candidate.item.questions.length, 3);
  assert.equal(
    candidate.item.questions[0].rubric,
    undefined,
    "private reviewer guidance is excluded from the candidate publication",
  );
});

test("paid screening requests are idempotent and deleting drafts does not reset usage or request IDs", async (t) => {
  const f = await fixture(t),
    input = f.input();
  const first = await (
    await f.call(f.owner.cookie, "screening-drafts", "POST", input)
  ).json();
  const repeat = await (
    await f.call(f.owner.cookie, "screening-drafts", "POST", input)
  ).json();
  assert.equal(repeat.item.id, first.item.id);
  assert.equal(f.calls(), 1);
  assert.equal(
    (
      await f.call(f.owner.cookie, "screening-drafts", "POST", {
        ...input,
        brief: input.brief + " changed",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.call(
        f.owner.cookie,
        `screening-drafts/${first.item.id}`,
        "DELETE",
      )
    ).status,
    200,
  );
  assert.equal(
    (await f.call(f.owner.cookie, "screening-drafts", "POST", input)).status,
    410,
  );
  for (let i = 0; i < 14; i++)
    f.store.db
      .prepare("INSERT INTO screening_ai_attempts VALUES(?,?,?,?)")
      .run(randomUUID(), f.owner.workspaceId, f.owner.id, Date.now());
  assert.equal(
    (await f.call(f.owner.cookie, "screening-drafts", "POST", f.input()))
      .status,
    429,
  );
  assert.equal(f.calls(), 1);
});

test("provider gating and input bounds run before any paid screening request", async (t) => {
  const f = await fixture(t);
  f.setAllowed(false);
  assert.equal(
    (await (await f.call(f.owner.cookie, "screening-drafts")).json()).available,
    false,
  );
  assert.equal(
    (await f.call(f.owner.cookie, "screening-drafts", "POST", f.input()))
      .status,
    503,
  );
  f.setAllowed(true);
  for (const change of [
    { questionCount: 11 },
    { brief: "short" },
    { context: "x".repeat(12001) },
    { candidateEmail: "private@example.com" },
  ])
    assert.equal(
      (
        await f.call(f.owner.cookie, "screening-drafts", "POST", {
          ...f.input(),
          ...change,
        })
      ).status,
      400,
    );
  assert.equal(
    (
      await f.call(f.other.cookie, "screening-drafts", "POST", {
        ...f.input(),
        jobId: f.job().id,
      })
    ).status,
    404,
  );
  assert.equal(f.calls(), 0);
});

test("malformed screening proposals fail closed and failed-request replay never calls the provider again", async (t) => {
  const f = await fixture(t);
  const bad = validResult();
  bad.questions[2].options = ["Same", "Same"];
  f.setComplete(async () => JSON.stringify(bad));
  const input = f.input();
  const failed = await f.call(
    f.owner.cookie,
    "screening-drafts",
    "POST",
    input,
  );
  assert.equal(failed.status, 502);
  const history = (
    await (await f.call(f.owner.cookie, "screening-drafts")).json()
  ).items;
  assert.equal(history[0].status, "failed");
  assert.equal(history[0].result, null);
  assert.equal(
    (
      await f.call(
        f.owner.cookie,
        `screening-drafts/${history[0].id}/apply`,
        "POST",
        { confirm: true },
      )
    ).status,
    409,
  );
  const repeat = await (
    await f.call(f.owner.cookie, "screening-drafts", "POST", input)
  ).json();
  assert.equal(repeat.item.status, "failed");
  assert.equal(f.calls(), 1);
  f.setComplete(async () => {
    throw new Error("private-upstream-token-must-not-appear");
  });
  const error = await f.call(
    f.owner.cookie,
    "screening-drafts",
    "POST",
    f.input(),
  );
  assert.equal(error.status, 502);
  assert.doesNotMatch(await error.text(), /private-upstream-token/);
  assert.equal(f.store.list(f.owner.workspaceId, "screenings").length, 0);
});

test("job changes invalidate private screening proposals without overwriting the role", async (t) => {
  const f = await fixture(t),
    job = f.job();
  const draft = (
    await (
      await f.call(f.owner.cookie, "screening-drafts", "POST", {
        ...f.input(),
        jobId: job.id,
      })
    ).json()
  ).item;
  f.store.update(f.owner.workspaceId, "jobs", {
    ...job,
    title: "Human revised role",
  });
  const history = (
    await (await f.call(f.owner.cookie, "screening-drafts")).json()
  ).items;
  assert.equal(history[0].sourceCurrent, false);
  assert.equal(history[0].result, null);
  assert.equal(
    (
      await f.call(
        f.owner.cookie,
        `screening-drafts/${draft.id}/apply`,
        "POST",
        { confirm: true },
      )
    ).status,
    409,
  );
  assert.equal(
    f.store.get(f.owner.workspaceId, "jobs", job.id)?.title,
    "Human revised role",
  );
});

test("pending screening drafts recheck source, session and provider access after generation", async (t) => {
  for (const mode of ["job", "session", "allowlist", "discard"]) {
    const f = await fixture(t),
      job = f.job();
    let release!: () => void;
    f.setComplete(
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve(proposal());
        }),
    );
    const response = f.call(f.owner.cookie, "screening-drafts", "POST", {
      ...f.input(),
      jobId: job.id,
    });
    for (let i = 0; i < 100 && !release; i++)
      await new Promise((resolve) => setTimeout(resolve, 2));
    assert.ok(release, "provider request started");
    if (mode === "job")
      f.store.update(f.owner.workspaceId, "jobs", {
        ...job,
        description: "Changed role requirements",
      });
    if (mode === "session")
      f.store.db
        .prepare("DELETE FROM sessions WHERE user_id=?")
        .run(f.owner.id);
    if (mode === "allowlist") f.setAllowed(false);
    if (mode === "discard") {
      const row = f.store.db
        .prepare("SELECT id FROM screening_ai_drafts WHERE user_id=?")
        .get(f.owner.id)!;
      assert.equal(
        (await f.call(f.owner.cookie, `screening-drafts/${row.id}`, "DELETE"))
          .status,
        200,
      );
    }
    release();
    const done = await response;
    assert.equal(
      done.status,
      mode === "session" ? 401 : mode === "allowlist" ? 403 : 409,
    );
    assert.equal(
      f.store.db
        .prepare(
          "SELECT count(*) AS n FROM screening_ai_drafts WHERE result IS NOT NULL",
        )
        .get()!.n,
      0,
    );
    assert.equal(f.store.list(f.owner.workspaceId, "screenings").length, 0);
  }
});
