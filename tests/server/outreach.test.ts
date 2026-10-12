import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { createDatabase, type Store } from "../../server/db.js";
import { hashToken } from "../../server/auth.js";
import { registerOutreach } from "../../server/outreach.js";
import {
  createMailTransport,
  MailError,
  type MailConfig,
} from "../../server/mail.js";

const ORIGIN = "http://localhost:5174";
function addUser(store: Store, workspaceId = randomUUID(), role = "owner") {
  const id = randomUUID(),
    token = randomBytes(32).toString("hex"),
    date = new Date().toISOString();
  store.db
    .prepare(
      "INSERT OR IGNORE INTO workspaces(id,name,created_at) VALUES(?,?,?)",
    )
    .run(workspaceId, "Acme Hiring", date);
  store.db
    .prepare(
      "INSERT INTO users(id,workspace_id,name,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?,?)",
    )
    .run(
      id,
      workspaceId,
      "Taylor Recruiter",
      `${id}@example.com`,
      "unused",
      role,
      date,
    );
  store.db
    .prepare(
      "INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)",
    )
    .run(hashToken(token), id, Date.now() + 3600000, date);
  return { workspaceId, cookie: `arkoffer_session=${token}` };
}
async function fixture(
  live = false,
  fetcher: typeof fetch = async () => {
    throw new Error("Unexpected real provider request");
  },
) {
  const dir = mkdtempSync(join(tmpdir(), "arkoffer-outreach-")),
    store = createDatabase(dir);
  const owner = addUser(store),
    other = addUser(store),
    member = addUser(store, owner.workspaceId, "member");
  let time = Date.now();
  const config: MailConfig = {
    mode: live ? "resend" : "outbox",
    apiKey: live ? "test-provider-key" : "",
    from: live ? "Acme <hiring@example.com>" : "",
    replyTo: "reply@example.com",
    publicUrl: live ? "https://arkoffer.example.com" : ORIGIN,
    workspaceIds: [owner.workspaceId],
  };
  const app = express();
  app.use(express.json());
  app.use("/api", (req, res, next) => {
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.get("origin") !== ORIGIN
    ) {
      res.status(403).json({ error: "Origin rejected" });
      return;
    }
    next();
  });
  const worker = registerOutreach(app, store, {
    clock: () => time,
    fetch: fetcher,
    mail: config,
  });
  const server = await new Promise<Server>((resolve) => {
    const running = app.listen(0, "127.0.0.1", () => resolve(running));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    cookie = owner.cookie,
  ) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        Origin: ORIGIN,
        Cookie: cookie,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const resource = (
    kind: string,
    data: Record<string, unknown>,
    workspace = owner.workspaceId,
  ) => {
    const item = {
      ...data,
      id: randomUUID(),
      createdAt: new Date(time).toISOString(),
      updatedAt: new Date(time).toISOString(),
    };
    store.insert(workspace, kind, item);
    return item;
  };
  const draft = (extra: Record<string, unknown> = {}) => {
    const candidate = resource("candidates", {
      name: "Alex Example",
      email: `alex-${randomUUID()}@example.com`,
      company: "Example Co",
      title: "Engineer",
    });
    const sequence = resource("sequences", {
      name: "Engineering outreach",
      enrolledCandidateIds: [candidate.id],
      steps: [
        {
          subject: "Hello {{firstName}}",
          body: "Hi {{name}}, {{senderName}} at {{workspaceName}}. Your {{role}} experience at {{company}} looks relevant.",
          delayDays: 0,
        },
        {
          subject: "Following up",
          body: "Would you like to talk?",
          delayDays: 2,
        },
      ],
      ...extra,
    });
    return { candidate, sequence };
  };
  const preview = async (id: string) =>
    await (await request(`/api/sequences/${id}/delivery/preview`)).json();
  const launch = async (id: string) => {
    const plan = await preview(id);
    const response = await request(
      `/api/sequences/${id}/delivery/launch`,
      "POST",
      { revision: plan.revision, acknowledged: true, mode: plan.config.mode },
    );
    assert.equal(
      response.status,
      201,
      JSON.stringify(await response.clone().json()),
    );
    return (await response.json()).enrollmentIds as string[];
  };
  const state = async (id: string) =>
    await (await request(`/api/sequences/${id}/delivery`)).json();
  const control = (id: string, action: string, enrollmentId?: string) =>
    request(`/api/sequences/${id}/delivery/control`, "POST", {
      action,
      ...(enrollmentId ? { enrollmentId } : {}),
    });
  return {
    store,
    owner,
    other,
    member,
    config,
    worker,
    resource,
    draft,
    preview,
    launch,
    state,
    control,
    request,
    advance: (ms: number) => {
      time += ms;
    },
    clock: () => time,
    async close() {
      await worker.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("outreach launches immutable personalized snapshots, schedules delays, pauses and resumes without sending email in outbox mode", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const { sequence, candidate } = f.draft();
  const preview = await f.preview(sequence.id);
  assert.equal(preview.recipients[0].messages[0].subject, "Hello Alex");
  assert.match(
    preview.recipients[0].messages[0].text,
    /Taylor Recruiter at Acme Hiring/,
  );
  assert.equal(preview.config.mode, "outbox");
  const [id] = await f.launch(sequence.id);
  f.store.update(f.owner.workspaceId, "candidates", {
    ...candidate,
    name: "Changed",
    email: "changed@example.com",
    updatedAt: new Date().toISOString(),
  });
  f.store.update(f.owner.workspaceId, "sequences", {
    ...sequence,
    steps: [],
    updatedAt: new Date().toISOString(),
  });
  await f.worker.tick();
  let state = await f.state(sequence.id);
  assert.equal(state.messages[0].status, "outbox");
  assert.equal(state.messages[1].status, "pending");
  const message = await (
    await f.request(
      `/api/sequences/${sequence.id}/delivery/messages/${state.messages[0].id}`,
    )
  ).json();
  assert.equal(message.item.subject, "Hello Alex");
  assert.match(message.item.text, /Alex Example/);
  assert.notEqual(message.item.email, "changed@example.com");
  await f.control(sequence.id, "pause", id);
  f.advance(3 * 86400000);
  await f.worker.tick();
  assert.equal((await f.state(sequence.id)).messages[1].status, "pending");
  await f.control(sequence.id, "resume", id);
  await f.worker.tick();
  assert.equal((await f.state(sequence.id)).messages[1].status, "pending");
  f.advance(2 * 86400000);
  await f.worker.tick();
  state = await f.state(sequence.id);
  assert.equal(state.messages[1].status, "outbox");
  assert.equal(state.enrollments[0].status, "completed");
  assert.ok(
    state.events.some((event: { type: string }) => event.type === "paused"),
  );
});

test("preview and management are workspace-scoped; owner approval, current revision, and explicit acknowledgment are mandatory", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const { sequence } = f.draft(),
    path = `/api/sequences/${sequence.id}/delivery`;
  assert.equal((await f.request(path, "GET", undefined, "")).status, 401);
  assert.equal(
    (await f.request(path, "GET", undefined, f.other.cookie)).status,
    404,
  );
  const plan = await f.preview(sequence.id);
  const body = { revision: plan.revision, acknowledged: true, mode: "outbox" };
  assert.equal(
    (await f.request(`${path}/launch`, "POST", body, f.member.cookie)).status,
    403,
  );
  assert.equal(
    (
      await f.request(`${path}/launch`, "POST", {
        ...body,
        acknowledged: false,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request(`${path}/launch`, "POST", {
        ...body,
        revision: "a".repeat(64),
      })
    ).status,
    409,
  );
  f.store.update(f.owner.workspaceId, "sequences", {
    ...sequence,
    name: "Changed after preview",
    updatedAt: new Date().toISOString(),
  });
  assert.equal((await f.request(`${path}/launch`, "POST", body)).status, 409);
  await f.launch(sequence.id);
  assert.equal(
    (
      await f.request(
        `${path}/control`,
        "POST",
        { action: "stop" },
        f.member.cookie,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request(`${path}/control`, "POST", {
        action: "stop",
        enrollmentId: randomUUID(),
      })
    ).status,
    404,
  );
});

test("live transport is opt-in and allowlisted; signup owners cannot use the operator's sender", async (t) => {
  const f = await fixture(true);
  t.after(() => f.close());
  f.config.workspaceIds = [];
  const { sequence } = f.draft();
  const plan = await f.preview(sequence.id);
  assert.equal(plan.config.allowed, false);
  assert.equal(
    (
      await f.request(`/api/sequences/${sequence.id}/delivery/launch`, "POST", {
        revision: plan.revision,
        acknowledged: true,
        mode: "resend",
      })
    ).status,
    409,
  );
  const transport = createMailTransport({
    ...f.config,
    publicUrl: "http://insecure.example.com",
  });
  assert.equal(transport.configured, false);
  assert.equal(
    createMailTransport({
      ...f.config,
      from: "Injected\r\nBcc: victim@example.com",
    }).configured,
    false,
  );
});

test("Resend requests use plain text, stable idempotency, bounded retries, reply-to and real status reconciliation", async (t) => {
  const sent: { url: string; init: RequestInit | undefined }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    sent.push({ url: String(input), init });
    if (init?.method === "GET")
      return Response.json({ last_event: "delivered" });
    if (sent.filter((x) => x.init?.method === "POST").length === 1)
      return Response.json(
        { name: "rate_limit_exceeded" },
        { status: 429, headers: { "Retry-After": "120" } },
      );
    return Response.json({ id: "11111111-2222-3333-4444-555555555555" });
  };
  const f = await fixture(true, fetcher);
  t.after(() => f.close());
  const { sequence } = f.draft();
  await f.launch(sequence.id);
  await f.worker.tick();
  let state = await f.state(sequence.id);
  assert.equal(state.messages[0].status, "retry");
  assert.equal(sent.length, 1);
  f.advance(119000);
  await f.worker.tick();
  assert.equal(sent.length, 1);
  f.advance(1000);
  await Promise.all([f.worker.tick(), f.worker.tick()]);
  assert.equal(sent.length, 2);
  const first = sent[0].init!,
    second = sent[1].init!;
  assert.equal(
    new Headers(first.headers).get("Idempotency-Key"),
    new Headers(second.headers).get("Idempotency-Key"),
  );
  assert.equal(
    new Headers(first.headers).get("Authorization"),
    "Bearer test-provider-key",
  );
  const body = JSON.parse(String(first.body));
  assert.equal(body.reply_to, "reply@example.com");
  assert.equal(body.to.length, 1);
  assert.ok(body.text.includes("Unsubscribe"));
  assert.equal(body.html, undefined);
  assert.ok(
    body.headers["List-Unsubscribe"].startsWith(
      "<https://arkoffer.example.com/",
    ),
  );
  state = await f.state(sequence.id);
  assert.equal(state.messages[0].status, "accepted");
  assert.ok(!JSON.stringify(state).includes("test-provider-key"));
  await f.worker.reconcile();
  state = await f.state(sequence.id);
  assert.equal(state.messages[0].status, "delivered");
  assert.equal(state.messages[0].providerEvent, "delivered");
});

test("ambiguous network errors never retry and block follow-ups", async (t) => {
  let calls = 0;
  const f = await fixture(true, async () => {
    calls++;
    throw new TypeError("fetch failed");
  });
  t.after(() => f.close());
  const { sequence } = f.draft();
  await f.launch(sequence.id);
  await f.worker.tick();
  f.advance(10 * 86400000);
  await f.worker.tick();
  const state = await f.state(sequence.id);
  assert.equal(calls, 1);
  assert.equal(state.messages[0].status, "unknown");
  assert.equal(state.messages[1].status, "cancelled");
  assert.equal(state.enrollments[0].status, "attention");
  await f.control(sequence.id, "resume");
  await f.worker.tick();
  assert.equal(calls, 1);
});

test("enrollment launch deduplicates emails and repeated launch requests; worker claims once", async (t) => {
  let calls = 0;
  const f = await fixture(true, async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 30));
    return Response.json({ id: randomUUID() });
  });
  t.after(() => f.close());
  const { sequence, candidate } = f.draft();
  const duplicate = f.resource("candidates", {
    name: "Duplicate",
    email: (
      f.store.get(f.owner.workspaceId, "candidates", candidate.id)!
        .email as string
    ).toUpperCase(),
  });
  f.store.update(f.owner.workspaceId, "sequences", {
    ...sequence,
    enrolledCandidateIds: [candidate.id, duplicate.id],
    updatedAt: new Date().toISOString(),
  });
  const plan = await f.preview(sequence.id);
  assert.equal(
    plan.recipients.filter((r: { eligible: boolean }) => r.eligible).length,
    1,
  );
  const body = { revision: plan.revision, acknowledged: true, mode: "resend" };
  const responses = await Promise.all([
    f.request(`/api/sequences/${sequence.id}/delivery/launch`, "POST", body),
    f.request(`/api/sequences/${sequence.id}/delivery/launch`, "POST", body),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
  await Promise.all([f.worker.tick(), f.worker.tick(), f.worker.tick()]);
  assert.equal(calls, 1);
});

test("unsubscribe GET is read-only; explicit POST suppresses every sequence for the workspace and blocks future enrollment", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const { sequence, candidate } = f.draft();
  await f.launch(sequence.id);
  await f.worker.tick();
  const second = f.resource("sequences", {
    name: "Other outreach",
    enrolledCandidateIds: [candidate.id],
    steps: [{ subject: "Other", body: "More", delayDays: 0 }],
  });
  await f.launch(second.id);
  const link = String(
    f.store.db
      .prepare("SELECT unsubscribe_url FROM outreach_messages LIMIT 1")
      .get()!.unsubscribe_url,
  );
  const path = new URL(link).pathname;
  assert.equal((await f.request(path, "GET", undefined, "")).status, 200);
  assert.equal((await f.state(second.id)).enrollments[0].status, "active");
  assert.equal((await f.request(path, "POST", undefined, "")).status, 200);
  await f.worker.tick();
  assert.equal((await f.state(second.id)).messages[0].status, "cancelled");
  assert.equal(
    (await f.state(sequence.id)).enrollments[0].status,
    "unsubscribed",
  );
  const third = f.resource("sequences", {
    name: "Third",
    enrolledCandidateIds: [candidate.id],
    steps: [{ subject: "Third", body: "More", delayDays: 0 }],
  });
  assert.equal(
    (await f.preview(third.id)).recipients[0].reason,
    "Unsubscribed or suppressed.",
  );
  assert.equal(
    (
      await f.request(
        "/api/outreach/unsubscribe/invalid",
        "POST",
        undefined,
        "",
      )
    ).status,
    404,
  );
});

test("manually recorded replies and stops cancel future steps; deleted candidates remove pending messages", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const first = f.draft(),
    second = f.draft(),
    third = f.draft();
  await f.launch(first.sequence.id);
  await f.launch(second.sequence.id);
  await f.launch(third.sequence.id);
  await f.control(first.sequence.id, "replied");
  await f.control(second.sequence.id, "stop");
  f.store.db
    .prepare("DELETE FROM resources WHERE id=?")
    .run(third.candidate.id);
  await f.worker.tick();
  assert.equal(
    (await f.state(first.sequence.id)).enrollments[0].status,
    "replied",
  );
  assert.equal(
    (await f.state(first.sequence.id)).messages[0].status,
    "cancelled",
  );
  assert.equal(
    (await f.state(second.sequence.id)).enrollments[0].status,
    "stopped",
  );
  assert.equal((await f.state(third.sequence.id)).messages.length, 0);
});

test("provider bounce suppresses later steps and a worker crash is never automatically retried", async (t) => {
  let calls = 0;
  const f = await fixture(true, async (_input, init) => {
    if (init?.method === "GET") return Response.json({ last_event: "bounced" });
    calls++;
    return Response.json({ id: randomUUID() });
  });
  t.after(() => f.close());
  const first = f.draft();
  await f.launch(first.sequence.id);
  await f.worker.tick();
  await f.worker.reconcile();
  assert.equal(
    (await f.state(first.sequence.id)).enrollments[0].status,
    "unsubscribed",
  );
  assert.equal(
    (await f.state(first.sequence.id)).messages[1].status,
    "cancelled",
  );
  const second = f.draft();
  await f.launch(second.sequence.id);
  const pending = (await f.state(second.sequence.id)).messages[0];
  f.store.db
    .prepare(
      "UPDATE outreach_messages SET status='sending',claimed_at=? WHERE id=?",
    )
    .run(f.clock() - 61000, pending.id);
  await f.worker.tick();
  assert.equal(
    (await f.state(second.sequence.id)).messages[0].status,
    "unknown",
  );
  assert.equal(calls, 1);
});

test("retries stop after four explicit provider errors and never cross the provider idempotency window", async (t) => {
  let calls = 0;
  const f = await fixture(true, async () => {
    calls++;
    return Response.json({ error: "unavailable" }, { status: 503 });
  });
  t.after(() => f.close());
  const { sequence } = f.draft();
  await f.launch(sequence.id);
  for (let i = 0; i < 5; i++) {
    await f.worker.tick();
    f.advance(3600000);
  }
  const state = await f.state(sequence.id);
  assert.equal(calls, 4);
  assert.equal(state.messages[0].status, "failed");
  assert.equal(state.messages[1].status, "cancelled");
  const second = f.draft();
  await f.launch(second.sequence.id);
  await f.worker.tick();
  f.advance(24 * 3600000);
  await f.worker.tick();
  assert.equal(calls, 5);
  assert.match(
    (await f.state(second.sequence.id)).messages[0].error,
    /idempotency window/,
  );
});

test("queued outbox jobs cannot become live email after a configuration switch", async (t) => {
  let calls = 0;
  const f = await fixture();
  t.after(() => f.close());
  const { sequence } = f.draft();
  await f.launch(sequence.id);
  const alternate = registerOutreach(express(), f.store, {
    clock: f.clock,
    fetch: async () => {
      calls++;
      return Response.json({ id: randomUUID() });
    },
    mail: {
      ...f.config,
      mode: "resend",
      apiKey: "test",
      from: "hiring@example.com",
      publicUrl: "https://arkoffer.example.com",
    },
  });
  await alternate.tick();
  await alternate.stop();
  assert.equal(calls, 0);
  assert.equal((await f.state(sequence.id)).messages[0].status, "failed");
});

test("preview rejects unsafe and unbounded drafts; transport treats malformed success as unknown", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  for (const steps of [
    [],
    [
      {
        subject: "Bad\r\nBcc: victim@example.com",
        body: "hello",
        delayDays: 0,
      },
    ],
    [{ subject: "Hi", body: "{{password}}", delayDays: 0 }],
    [
      { subject: "Hi", body: "Hello", delayDays: 0 },
      { subject: "Fast", body: "Hello", delayDays: 0 },
    ],
  ]) {
    const { sequence } = f.draft({ steps });
    assert.equal(
      (await f.request(`/api/sequences/${sequence.id}/delivery/preview`))
        .status,
      400,
    );
  }
  const mail = createMailTransport(
    {
      ...f.config,
      mode: "resend",
      apiKey: "test",
      from: "hiring@example.com",
      publicUrl: "https://arkoffer.example.com",
    },
    async () => Response.json({}),
  );
  await assert.rejects(
    mail.send({
      to: "alex@example.com",
      subject: "Hi",
      text: "hello",
      idempotencyKey: "test",
    }),
    (error: unknown) => error instanceof MailError && error.kind === "unknown",
  );
});
