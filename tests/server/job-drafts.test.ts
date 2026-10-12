import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { createDatabase } from "../../server/db.js";
import { hashToken } from "../../server/auth.js";
import { registerJobDrafts } from "../../server/job-drafts.js";
import type { createAi } from "../../server/ai.js";

const proposal = () =>
  JSON.stringify({
    description: "Build reliable TypeScript services.",
    suggestions: ["Clarify the interview process."],
    missingDetails: ["Confirm working hours."],
  });
async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "arkoffer-job-drafts-")),
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
  registerJobDrafts(app, store, { ai });
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
    details: { title: "Backend Engineer", salary: "SGD 100,000 per year" },
    brief: "Build TypeScript services.",
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

test("job drafts remain private until explicit apply; creation and repeated apply preserve human job data", async (t) => {
  const f = await fixture(t),
    input = f.input();
  const response = await f.call(f.owner.cookie, "job-drafts", "POST", input);
  assert.equal(response.status, 201);
  const draft = (await response.json()).item;
  assert.equal(f.store.list(f.owner.workspaceId, "jobs").length, 0);
  assert.equal(
    (await (await f.call(f.teammate.cookie, "job-drafts")).json()).items.length,
    0,
  );
  assert.equal(
    (
      await f.call(f.teammate.cookie, `job-drafts/${draft.id}/apply`, "POST", {
        confirm: true,
        description: "Forbidden",
      })
    ).status,
    404,
  );
  const repeat = await f.call(f.owner.cookie, "job-drafts", "POST", input);
  assert.equal(repeat.status, 200);
  assert.equal(f.calls(), 1);
  assert.equal(
    (
      await f.call(f.owner.cookie, "job-drafts", "POST", {
        ...input,
        brief: "Different",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.call(f.owner.cookie, `job-drafts/${draft.id}/apply`, "POST", {
        description: "Reviewed",
      })
    ).status,
    400,
  );
  const apply = await f.call(
    f.owner.cookie,
    `job-drafts/${draft.id}/apply`,
    "POST",
    { confirm: true, description: "Reviewed description" },
  );
  assert.equal(apply.status, 200);
  const item = (await apply.json()).item;
  assert.equal(item.status, "draft");
  assert.equal(item.salary, input.details.salary);
  assert.equal(item.description, "Reviewed description");
  f.store.update(f.owner.workspaceId, "jobs", {
    ...item,
    description: "Later human edit",
    updatedAt: new Date().toISOString(),
  });
  const repeated = await (
    await f.call(f.owner.cookie, `job-drafts/${draft.id}/apply`, "POST", {
      confirm: true,
      description: "Old draft",
    })
  ).json();
  assert.equal(repeated.item.description, "Later human edit");
  assert.equal(f.store.list(f.owner.workspaceId, "jobs").length, 1);
});
test("job draft availability, tenant ownership and strict inputs are enforced before provider calls", async (t) => {
  const f = await fixture(t),
    job = f.job();
  assert.equal((await f.call("", "job-drafts")).status, 401);
  f.setAllowed(false);
  assert.equal(
    (await f.call(f.owner.cookie, "job-drafts", "POST", f.input())).status,
    503,
  );
  f.setAllowed(true);
  assert.equal(
    (
      await f.call(f.other.cookie, "job-drafts", "POST", {
        requestId: randomUUID(),
        jobId: job.id,
        sourceVersion: job.updatedAt,
        brief: "Improve",
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await f.call(f.owner.cookie, "job-drafts", "POST", {
        ...f.input(),
        unexpected: "x",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.call(f.owner.cookie, "job-drafts", "POST", {
        ...f.input(),
        brief: "x".repeat(10001),
      })
    ).status,
    400,
  );
  assert.equal(f.calls(), 0);
});
test("existing-job drafts only apply descriptions and reject changed source versions", async (t) => {
  const f = await fixture(t),
    job = f.job();
  const draft = (
    await (
      await f.call(f.owner.cookie, "job-drafts", "POST", {
        requestId: randomUUID(),
        jobId: job.id,
        sourceVersion: job.updatedAt,
        brief: "Improve clarity",
      })
    ).json()
  ).item;
  const apply = await f.call(
    f.owner.cookie,
    `job-drafts/${draft.id}/apply`,
    "POST",
    { confirm: true, description: "Approved description" },
  );
  assert.equal(apply.status, 200);
  const updated = (await apply.json()).item;
  assert.equal(updated.status, "open");
  assert.equal(updated.salary, "Keep this pay");
  assert.deepEqual(updated.ats, { id: "source-job" });
  const second = (
    await (
      await f.call(f.owner.cookie, "job-drafts", "POST", {
        requestId: randomUUID(),
        jobId: job.id,
        sourceVersion: updated.updatedAt,
        brief: "Shorten",
      })
    ).json()
  ).item;
  f.store.update(f.owner.workspaceId, "jobs", {
    ...updated,
    title: "Renamed role",
    updatedAt: new Date().toISOString(),
  });
  assert.equal(
    (
      await f.call(f.owner.cookie, `job-drafts/${second.id}/apply`, "POST", {
        confirm: true,
        description: "Stale",
      })
    ).status,
    409,
  );
  assert.equal(
    f.store.get(f.owner.workspaceId, "jobs", job.id)?.description,
    "Approved description",
  );
});
test("provider failures and invalid output persist an explicit failure without mutating jobs or retrying", async (t) => {
  const f = await fixture(t),
    job = f.job();
  for (const output of [
    "not-json",
    JSON.stringify({ description: "", suggestions: [], missingDetails: [] }),
    JSON.stringify({
      description: "x",
      suggestions: [],
      missingDetails: [],
      status: "hired",
    }),
  ]) {
    f.setComplete(async () => output);
    const input = {
      requestId: randomUUID(),
      jobId: job.id,
      sourceVersion: job.updatedAt,
      brief: "Improve",
    };
    assert.equal(
      (await f.call(f.owner.cookie, "job-drafts", "POST", input)).status,
      502,
    );
    const count = f.calls();
    assert.equal(
      (await f.call(f.owner.cookie, "job-drafts", "POST", input)).status,
      200,
    );
    assert.equal(f.calls(), count);
  }
  const list = (await (await f.call(f.owner.cookie, "job-drafts")).json())
    .items;
  assert.ok(list.every((d: any) => d.status === "failed" && d.result === null));
  assert.equal(
    f.store.get(f.owner.workspaceId, "jobs", job.id)?.description,
    "Existing description",
  );
});
test("changes to the job, session, workspace or allowlist during generation discard the late result", async (t) => {
  for (const change of ["job", "session", "workspace", "allowlist"]) {
    const f = await fixture(t),
      job = f.job();
    let resolve!: () => void, started!: () => void;
    const ready = new Promise<void>((r) => {
        started = r;
      }),
      pending = new Promise<void>((r) => {
        resolve = r;
      });
    f.setComplete(async () => {
      started();
      await pending;
      return proposal();
    });
    const request = f.call(f.owner.cookie, "job-drafts", "POST", {
      requestId: randomUUID(),
      jobId: job.id,
      sourceVersion: job.updatedAt,
      brief: "Improve",
    });
    await ready;
    if (change === "job")
      f.store.update(f.owner.workspaceId, "jobs", {
        ...job,
        description: "Concurrent human edit",
        updatedAt: new Date().toISOString(),
      });
    if (change === "session")
      f.store.db
        .prepare("DELETE FROM sessions WHERE user_id=?")
        .run(f.owner.id);
    if (change === "workspace")
      f.store.db
        .prepare("UPDATE sessions SET workspace_id=? WHERE user_id=?")
        .run(f.other.workspaceId, f.owner.id);
    if (change === "allowlist") f.setAllowed(false);
    resolve();
    assert.ok([401, 403, 409].includes((await request).status), change);
    assert.equal(
      f.store.db.prepare("SELECT result FROM job_ai_drafts").get()!.result,
      null,
    );
  }
});
test("deleting drafts cannot reset paid attempt budgets or resurrect an old request", async (t) => {
  const f = await fixture(t),
    first = f.input();
  let firstId = "";
  for (let i = 0; i < 30; i++) {
    const response = await f.call(
      f.owner.cookie,
      "job-drafts",
      "POST",
      i === 0 ? first : f.input(),
    );
    assert.equal(response.status, 201);
    const draft = (await response.json()).item;
    if (i === 0) firstId = draft.id;
    assert.equal(
      (await f.call(f.owner.cookie, `job-drafts/${draft.id}`, "DELETE")).status,
      200,
    );
  }
  assert.equal(
    (await f.call(f.owner.cookie, "job-drafts", "POST", first)).status,
    410,
  );
  assert.equal(
    (await f.call(f.owner.cookie, "job-drafts", "POST", f.input())).status,
    429,
  );
  assert.equal(f.calls(), 30);
  assert.equal(
    (
      await f.call(f.owner.cookie, `job-drafts/${firstId}/apply`, "POST", {
        confirm: true,
        description: "Old",
      })
    ).status,
    404,
  );
});
