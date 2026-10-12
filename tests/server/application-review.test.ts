import { test, type TestContext } from "node:test";
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
import { registerApplicationReview } from "../../server/application-review.js";
import { AiError, type createAi } from "../../server/ai.js";

async function setup(t: TestContext, enabled = true) {
  const dir = mkdtempSync(join(tmpdir(), "arkoffer-review-")),
    store = createDatabase(dir),
    app = express();
  initializeAccess(store);
  const prompts: Array<{ role: string; content: string }>[] = [];
  let complete = async (messages: Array<{ role: string; content: string }>) => {
    const input = JSON.parse(messages[1].content);
    if (input.description)
      return JSON.stringify({
        criteria: [
          { text: "Experience with TypeScript", importance: "required" },
        ],
      });
    return JSON.stringify({
      criteria: input.criteria.map((c: { id: string }) => ({
        criterionId: c.id,
        evidence: [{ sourceId: input.sources[0].id, quote: "TypeScript" }],
        missingInformation: "Scope of recent work is not established.",
        followUp: "Can you describe a recent TypeScript project?",
      })),
    });
  };
  const ai: ReturnType<typeof createAi> = {
    provider: "test",
    model: "fixture",
    configured: enabled,
    allowed: () => enabled,
    complete: async (messages) => {
      prompts.push(messages);
      return complete(messages);
    },
  };
  app.use(express.json());
  registerApplicationReview(app, store, { ai });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  function user(workspaceId = randomUUID(), role = "owner") {
    const id = randomUUID(),
      token = randomBytes(32).toString("hex"),
      created = new Date().toISOString();
    store.db
      .prepare(
        "INSERT OR IGNORE INTO workspaces(id,name,created_at) VALUES(?,?,?)",
      )
      .run(workspaceId, "Hiring", created);
    store.db
      .prepare(
        "INSERT INTO users(id,workspace_id,name,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        id,
        workspaceId,
        "Reviewer",
        `${id}@example.test`,
        "unused",
        role,
        created,
      );
    store.db
      .prepare(
        "INSERT INTO sessions(token_hash,user_id,workspace_id,expires_at,created_at) VALUES(?,?,?,?,?)",
      )
      .run(hashToken(token), id, workspaceId, Date.now() + 60_000, created);
    return { id, workspaceId, cookie: `arkoffer_session=${token}` };
  }
  const owner = user(),
    member = user(owner.workspaceId, "member"),
    other = user();
  function insert(kind: string, data: Record<string, unknown>, who = owner) {
    const item = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...data,
    };
    store.insert(who.workspaceId, kind, item);
    if (kind === "conversations")
      registerResourceOwner(store, who.workspaceId, item.id, who.id);
    return item;
  }
  const job = insert("jobs", {
    title: "Engineer",
    description: "Build TypeScript software.",
  });
  const candidate = insert("candidates", {
    name: "Alex",
    role: "TypeScript engineer",
    company: "Professional Co",
    skills: "TypeScript",
    status: "rejected",
    notes: "PRIVATE MANUAL ASSESSMENT",
  });
  const application = insert("applications", {
    jobId: job.id,
    candidateId: candidate.id,
    name: "Alex",
    status: "in_review",
    notes: "PREVIOUS DECISION",
  });
  const note = insert("conversations", {
    title: "Explicit transcript",
    transcript: "Candidate: I built TypeScript software.",
    candidate: "Someone Else",
  });
  const criteria = [
    { id: randomUUID(), text: "TypeScript experience", importance: "required" },
  ];
  const path = `/api/applications/${application.id}/review-assistance`;
  const call = (path: string, method = "GET", body?: unknown, who = owner) =>
    fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      headers: { Cookie: who.cookie, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const save = (revision = 0) =>
    call(`/api/jobs/${job.id}/review-criteria`, "PUT", {
      revision,
      criteria,
      approved: true,
    });
  const analyze = (extra: Record<string, unknown> = {}, who = owner) =>
    call(
      path,
      "POST",
      {
        requestId: randomUUID(),
        criteriaRevision: 1,
        conversationIds: [],
        consent: true,
        ...extra,
      },
      who,
    );
  return {
    store,
    owner,
    member,
    other,
    user,
    insert,
    job,
    candidate,
    application,
    note,
    criteria,
    path,
    call,
    save,
    analyze,
    prompts,
    restart: () => registerApplicationReview(express(), store, { ai }),
    setComplete: (next: typeof complete) => {
      complete = next;
    },
  };
}

test("review keeps evidence private, quotes exact sources, persists notes, and never changes decisions", async (t) => {
  const f = await setup(t);
  assert.equal((await f.save()).status, 200);
  const before = f.store.get(
    f.owner.workspaceId,
    "applications",
    f.application.id,
  );
  const response = await f.analyze({ conversationIds: [f.note.id] });
  assert.equal(response.status, 201);
  const run = (await response.json()).item;
  assert.equal(run.status, "complete");
  assert.equal(run.output.criteria[0].evidence[0].quote, "TypeScript");
  assert.equal(run.output.sources.length, 2);
  assert.ok(!JSON.stringify(f.prompts).includes("PRIVATE MANUAL ASSESSMENT"));
  assert.ok(!JSON.stringify(f.prompts).includes("PREVIOUS DECISION"));
  assert.ok(!JSON.stringify(f.prompts).includes("rejected"));
  assert.equal(
    (
      await f.call(`${f.path}/${run.id}`, "PATCH", {
        notes: "PRIVATE REVIEWER NOTE",
        reviewed: true,
      })
    ).status,
    200,
  );
  const history = await (await f.call(f.path)).json();
  assert.equal(history.items[0].notes, "PRIVATE REVIEWER NOTE");
  assert.ok(history.items[0].reviewedAt);
  assert.deepEqual(
    f.store.get(f.owner.workspaceId, "applications", f.application.id),
    before,
  );
  assert.ok(
    !JSON.stringify(f.store.list(f.owner.workspaceId, "applications")).includes(
      "PRIVATE REVIEWER NOTE",
    ),
  );
  assert.ok(
    !JSON.stringify(f.store.list(f.owner.workspaceId, "jobs")).includes(
      "Supporting",
    ),
  );
  assert.equal(
    (await (await f.call(f.path, "GET", undefined, f.member)).json()).items
      .length,
    0,
  );
  assert.equal(
    (
      await f.call(
        `${f.path}/${run.id}`,
        "PATCH",
        { notes: "stolen", reviewed: true },
        f.member,
      )
    ).status,
    404,
  );
  assert.equal((await f.call(f.path, "GET", undefined, f.other)).status, 404);
});

test("AI criteria drafts require explicit revision-controlled approval", async (t) => {
  const f = await setup(t);
  assert.equal((await f.analyze()).status, 409);
  const draft = await f.call(
    `/api/jobs/${f.job.id}/review-criteria/draft`,
    "POST",
    { requestId: randomUUID(), revision: 0 },
  );
  assert.equal(draft.status, 201);
  const generated = (await draft.json()).item.output.criteria;
  const job = await (
    await f.call(`/api/jobs/${f.job.id}/review-criteria`)
  ).json();
  assert.equal(job.revision, 0);
  assert.equal(job.drafts.length, 1);
  assert.equal((await f.analyze()).status, 409);
  assert.equal(
    (
      await f.call(`/api/jobs/${f.job.id}/review-criteria`, "PUT", {
        revision: 0,
        criteria: generated,
        approved: true,
      })
    ).status,
    200,
  );
  assert.equal((await f.save()).status, 409);
  assert.equal(
    (
      await f.call(`/api/jobs/${f.job.id}/review-criteria`, "PUT", {
        revision: 1,
        criteria: generated,
        approved: false,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.call(`/api/jobs/${f.job.id}/review-criteria/draft`, "POST", {
        requestId: randomUUID(),
        revision: 0,
      })
    ).status,
    409,
  );
});

test("explicit transcript selection enforces workspace ACL and never links by name", async (t) => {
  const f = await setup(t);
  await f.save();
  const before = await (
    await f.call(f.path, "GET", undefined, f.member)
  ).json();
  assert.equal(before.sources.length, 0);
  assert.equal(
    (await f.analyze({ conversationIds: [f.note.id] }, f.member)).status,
    404,
  );
  const foreign = f.insert(
    "conversations",
    { transcript: "TypeScript", title: "Foreign" },
    f.other,
  );
  assert.equal(
    (await f.analyze({ conversationIds: [foreign.id] })).status,
    404,
  );
  assert.equal(f.prompts.length, 0);
  assert.equal((await f.analyze({}, f.member)).status, 201);
  const input = JSON.parse(f.prompts[0][1].content);
  assert.equal(input.sources.length, 1);
  assert.ok(input.sources[0].id.startsWith("candidate:"));
});

test("source content, application linkage, criteria and permissions invalidate persisted reviews", async (t) => {
  const f = await setup(t);
  await f.save();
  const r = await (await f.analyze({ conversationIds: [f.note.id] })).json();
  f.store.update(f.owner.workspaceId, "conversations", {
    ...f.note,
    transcript: "Candidate: I built TypeScript software. Added context.",
  });
  const stale = await (await f.call(f.path)).json();
  assert.equal(stale.items[0].status, "stale");
  assert.equal(stale.items[0].output, undefined);
  assert.equal(stale.items[0].notes, undefined);
  assert.equal(
    (
      await f.call(`${f.path}/${r.item.id}`, "PATCH", {
        notes: "Should fail",
        reviewed: true,
      })
    ).status,
    409,
  );
  const next = await (await f.analyze()).json();
  await f.save(1);
  assert.equal(
    (await (await f.call(f.path)).json()).items.find(
      (run: { id: string }) => run.id === next.item.id,
    ).status,
    "stale",
  );
  const linked = await (await f.analyze({ criteriaRevision: 2 })).json();
  f.store.update(f.owner.workspaceId, "applications", {
    ...f.application,
    candidateId: "deleted",
  });
  assert.equal(
    (await (await f.call(f.path)).json()).items.find(
      (run: { id: string }) => run.id === linked.item.id,
    ).output,
    undefined,
  );
});

test("permission revocation and membership changes while AI is pending cannot save evidence", async (t) => {
  const f = await setup(t);
  await f.save();
  f.store.db
    .prepare(
      "INSERT INTO resource_grants(resource_id,user_id,permission,created_at) VALUES(?,?,?,?)",
    )
    .run(f.note.id, f.member.id, "viewer", new Date().toISOString());
  let finish!: (value: string) => void, started!: () => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.setComplete(async () => {
    started();
    return new Promise<string>((resolve) => {
      finish = resolve;
    });
  });
  const pending = f.analyze({ conversationIds: [f.note.id] }, f.member);
  await began;
  f.store.db
    .prepare("DELETE FROM resource_grants WHERE resource_id=? AND user_id=?")
    .run(f.note.id, f.member.id);
  finish(JSON.stringify({ criteria: [] }));
  assert.equal((await pending).status, 409);
  const persisted = f.store.db
    .prepare("SELECT * FROM application_review_runs WHERE user_id=?")
    .get(f.member.id)!;
  assert.equal(persisted.output, null);
  assert.equal(persisted.status, "failed");
  assert.equal(
    (await (await f.call(f.path, "GET", undefined, f.member)).json()).items[0]
      .output,
    undefined,
  );
});

test("current workspace membership and role are checked again after provider completion", async (t) => {
  for (const change of ["role", "suspend", "session"] as const) {
    await t.test(change, async (inner) => {
      const f = await setup(inner);
      await f.save();
      let finish!: (value: string) => void, started!: () => void;
      const began = new Promise<void>((resolve) => {
        started = resolve;
      });
      f.setComplete(async () => {
        started();
        return new Promise<string>((resolve) => {
          finish = resolve;
        });
      });
      const pending = f.analyze();
      await began;
      if (change === "role")
        f.store.db
          .prepare("UPDATE memberships SET role='member' WHERE user_id=?")
          .run(f.owner.id);
      else if (change === "suspend")
        f.store.db
          .prepare("UPDATE memberships SET status='suspended' WHERE user_id=?")
          .run(f.owner.id);
      else
        f.store.db
          .prepare("DELETE FROM sessions WHERE user_id=?")
          .run(f.owner.id);
      finish("{}");
      assert.ok([401, 409].includes((await pending).status));
      assert.equal(
        f.store.db.prepare("SELECT output FROM application_review_runs").get()!
          .output,
        null,
      );
    });
  }
});

test("duplicate request IDs are idempotent, including concurrent requests", async (t) => {
  const f = await setup(t);
  await f.save();
  const requestId = randomUUID();
  const first = await f.analyze({ requestId });
  assert.equal(first.status, 201);
  const second = await f.analyze({ requestId });
  assert.equal(second.status, 200);
  assert.equal(f.prompts.length, 1);
  assert.equal(
    (await f.analyze({ requestId, conversationIds: [f.note.id] })).status,
    409,
  );
  assert.equal((await f.analyze({ requestId }, f.member)).status, 409);
  let finish!: (value: string) => void, started!: () => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.setComplete(async () => {
    started();
    return new Promise<string>((resolve) => {
      finish = resolve;
    });
  });
  const pendingId = randomUUID(),
    pending = f.analyze({ requestId: pendingId });
  await began;
  assert.equal((await f.analyze({ requestId: pendingId })).status, 202);
  assert.equal(f.prompts.length, 2);
  finish("invalid");
  assert.equal((await pending).status, 502);
  assert.equal((await f.analyze({ requestId: pendingId })).status, 200);
  assert.equal(f.prompts.length, 2);
});

test("invalid JSON, fabricated evidence, missing criteria, and excess provider output are rejected", async (t) => {
  const f = await setup(t);
  await f.save();
  const row = {
    criterionId: f.criteria[0].id,
    evidence: [
      { sourceId: `candidate:${f.candidate.id}`, quote: "fabricated" },
    ],
    missingInformation: "",
    followUp: "",
  };
  for (const output of [
    "not JSON",
    JSON.stringify({ criteria: [row] }),
    JSON.stringify({
      criteria: [
        { ...row, evidence: [{ sourceId: "made-up", quote: "TypeScript" }] },
      ],
    }),
    JSON.stringify({ criteria: [] }),
    "x".repeat(20_001),
  ]) {
    f.setComplete(async () => output);
    assert.equal((await f.analyze()).status, 502);
  }
  for (const row of f.store.db
    .prepare("SELECT output,status FROM application_review_runs")
    .all()) {
    assert.equal(row.output, null);
    assert.equal(row.status, "failed");
  }
});

test("disabled setup, consent, source size, and hourly budgets fail before paid requests", async (t) => {
  const disabled = await setup(t, false);
  await disabled.save();
  assert.equal((await disabled.analyze()).status, 503);
  assert.equal(disabled.prompts.length, 0);
  const f = await setup(t);
  await f.save();
  assert.equal((await f.analyze({ consent: false })).status, 400);
  f.store.update(f.owner.workspaceId, "conversations", {
    ...f.note,
    transcript: "a".repeat(60_001),
  });
  assert.equal((await f.analyze({ conversationIds: [f.note.id] })).status, 400);
  assert.equal(f.prompts.length, 0);
  for (let i = 0; i < 10; i++) assert.equal((await f.analyze()).status, 201);
  assert.equal((await f.analyze()).status, 429);
  assert.equal(f.prompts.length, 10);
});

test("edits outside quoted text during an AI response invalidate the full context", async (t) => {
  const f = await setup(t);
  await f.save();
  let finish!: (value: string) => void, started!: () => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.setComplete(async () => {
    started();
    return new Promise<string>((resolve) => {
      finish = resolve;
    });
  });
  const pending = f.analyze();
  await began;
  f.store.update(f.owner.workspaceId, "jobs", {
    ...f.job,
    title: "Different job context",
  });
  finish(
    JSON.stringify({
      criteria: [
        {
          criterionId: f.criteria[0].id,
          evidence: [
            { sourceId: `candidate:${f.candidate.id}`, quote: "TypeScript" },
          ],
          missingInformation: "",
          followUp: "",
        },
      ],
    }),
  );
  assert.equal((await pending).status, 409);
  assert.equal(
    f.store.db.prepare("SELECT output FROM application_review_runs").get()!
      .output,
    null,
  );
});

test("deleting applications cannot reset the durable generation budget", async (t) => {
  const f = await setup(t);
  await f.save();
  for (let i = 0; i < 10; i++) assert.equal((await f.analyze()).status, 201);
  f.store.db.prepare("DELETE FROM resources WHERE id=?").run(f.application.id);
  assert.equal(
    f.store.db
      .prepare("SELECT COUNT(*) AS n FROM application_review_runs")
      .get()!.n,
    0,
  );
  const application = f.insert("applications", {
    jobId: f.job.id,
    candidateId: f.candidate.id,
  });
  const next = await f.call(
    `/api/applications/${application.id}/review-assistance`,
    "POST",
    {
      requestId: randomUUID(),
      criteriaRevision: 1,
      conversationIds: [],
      consent: true,
    },
  );
  assert.equal(next.status, 429);
  assert.equal(f.prompts.length, 10);
});

test("restart marks uncertain generations failed without automatically repeating provider calls", async (t) => {
  const f = await setup(t);
  await f.save();
  const requestId = randomUUID();
  await f.analyze({ requestId });
  f.store.db
    .prepare(
      "UPDATE application_review_runs SET status='running',output=NULL WHERE id=?",
    )
    .run(requestId);
  f.restart();
  const response = await f.analyze({ requestId });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).item.status, "failed");
  assert.equal(f.prompts.length, 1);
});

test("at most two generations can be in flight per workspace", async (t) => {
  const f = await setup(t);
  await f.save();
  const finish: Array<(value: string) => void> = [];
  let first!: () => void, second!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
      first = resolve;
    }),
    secondStarted = new Promise<void>((resolve) => {
      second = resolve;
    });
  f.setComplete(
    async () =>
      new Promise<string>((resolve) => {
        finish.push(resolve);
        if (finish.length === 1) first();
        else second();
      }),
  );
  const one = f.analyze();
  await firstStarted;
  const two = f.analyze({}, f.member);
  await secondStarted;
  assert.equal((await f.analyze()).status, 429);
  assert.equal(f.prompts.length, 2);
  finish.forEach((resolve) => resolve("{}"));
  assert.equal((await one).status, 502);
  assert.equal((await two).status, 502);
});

test("safe AI failure causes survive responses and reloads without repeating paid requests", async (t) => {
  const f = await setup(t);
  await f.save();
  const messages = [
    "The AI provider could not complete the request. Check its configuration and quota.",
    "The AI provider returned an empty response.",
    "The AI answer reached its output limit. Please ask a narrower question.",
    "The AI provider could not be reached. Please try again.",
  ];
  for (const message of messages) {
    const requestId = randomUUID();
    f.setComplete(async () => {
      throw new AiError(message);
    });
    const response = await f.analyze({ requestId });
    assert.equal(response.status, 502);
    const error = (await response.json()).error;
    assert.ok(error.startsWith(message.replace(/ Please try again\.$/, "")));
    assert.match(error, /will not retry automatically/);
    assert.match(error, /usage may have been charged/);
    assert.ok(!error.includes("Please try again."));
    assert.ok(!error.includes("Start a new request."));
    const previousCalls = f.prompts.length;
    const replay = await f.analyze({ requestId });
    assert.equal(replay.status, 200);
    const persisted = (await replay.json()).item;
    assert.equal(persisted.status, "failed");
    assert.equal(persisted.error, error);
    assert.equal(persisted.output, null);
    assert.equal(f.prompts.length, previousCalls);
  }
});

test("unexpected provider exceptions do not expose transport or private data", async (t) => {
  const f = await setup(t);
  await f.save();
  f.setComplete(async () => {
    throw new Error(
      "PRIVATE PROVIDER BODY token=secret-value candidate=private-name",
    );
  });
  const response = await f.analyze();
  assert.equal(response.status, 502);
  const error = (await response.json()).error;
  assert.match(error, /^AI could not complete this review\./);
  assert.match(
    error,
    /check provider usage before deciding whether to run again/,
  );
  const history = await (await f.call(f.path)).json();
  assert.equal(history.items[0].error, error);
  assert.ok(!JSON.stringify(history).includes("PRIVATE PROVIDER BODY"));
  assert.ok(!JSON.stringify(history).includes("secret-value"));
});
