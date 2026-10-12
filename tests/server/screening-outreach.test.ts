import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../../server/db.js";
import { hashToken } from "../../server/auth.js";
import { registerScreening, ScreeningError } from "../../server/screening.js";
import { registerScreeningOutreach } from "../../server/screening-outreach.js";
import { newScreeningConfig } from "../../shared/screening.js";
import type { MailConfig } from "../../server/mail.js";
const DAY = 86400000;
async function fixture(
  options: {
    fetch?: typeof fetch;
    live?: boolean;
    validateSnapshot?: (snapshot: unknown, workspace: string) => void;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "ark-screen-outreach-")),
    store = createDatabase(directory);
  let now = Date.now();
  const clock = () => now;
  function user(workspaceId = randomUUID(), role = "owner") {
    const id = randomUUID(),
      token = randomBytes(32).toString("hex"),
      date = new Date().toISOString();
    store.db
      .prepare(
        "INSERT OR IGNORE INTO workspaces(id,name,created_at) VALUES(?,?,?)",
      )
      .run(workspaceId, "Example Company", date);
    store.db
      .prepare(
        "INSERT INTO users(id,workspace_id,name,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        id,
        workspaceId,
        "Owner",
        `${id}@example.test`,
        "unused",
        role,
        date,
      );
    store.db
      .prepare(
        "INSERT INTO sessions(token_hash,user_id,workspace_id,expires_at,created_at) VALUES(?,?,?,?,?)",
      )
      .run(hashToken(token), id, workspaceId, Date.now() + DAY, date);
    return { id, workspaceId, cookie: `arkoffer_session=${token}` };
  }
  const owner = user(),
    other = user(),
    member = user(owner.workspaceId, "member");
  const config = newScreeningConfig();
  config.sections[0].questions = [
    {
      id: randomUUID(),
      prompt: "Describe your professional experience.",
      type: "text",
      options: [],
      required: true,
      rubric: "Private review-only rubric",
      followUp: false,
    },
  ];
  config.context.company = "Private company context";
  const screening = {
    id: randomUUID(),
    name: "Engineer screening",
    title: "Engineer screening",
    description: "Professional experience",
    questions: config.sections[0].questions,
    screeningConfig: config,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };
  store.insert(owner.workspaceId, "screenings", screening);
  const mail: MailConfig = {
    mode: options.live ? "resend" : "outbox",
    apiKey: options.live ? "test-provider-key" : "",
    from: "Hiring <hiring@example.test>",
    replyTo: "",
    publicUrl: "https://hiring.example.test",
    workspaceIds: [owner.workspaceId],
  };
  const app = express();
  app.use(express.json());
  registerScreening(app, store);
  let worker = registerScreeningOutreach(app, store, {
    clock,
    mail,
    fetch: options.fetch,
    validateSnapshot: options.validateSnapshot,
    ...(options.live
      ? { tokenSecret: "synthetic-durable-capability-secret-32" }
      : {}),
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`,
    prefix = `/api/screenings/${screening.id}/outreach`;
  const request = (
    path: string,
    method = "GET",
    data?: unknown,
    cookie = owner.cookie,
  ) =>
    fetch(base + path, {
      method,
      headers: {
        Cookie: cookie,
        ...(data === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
  const draft = {
    revision: screening.updatedAt,
    recipients: [{ name: "Alex Candidate", email: "alex@example.test" }],
    candidateIds: [],
    subject: "{{screening_title}} for {{candidate_name}}",
    body: "Hello {{candidate_first_name}} from {{company_name}}. Complete by {{deadline}}: {{interview_link}}",
    reminderDays: [3, 1],
  };
  async function preview(data: unknown = draft) {
    const response = await request(prefix + "/preview", "POST", data);
    assert.equal(response.status, 201, await response.clone().text());
    return (await response.json()).item;
  }
  async function queue(previewId: string, requestId = randomUUID()) {
    return request(prefix + "/queue", "POST", {
      previewId,
      requestId,
      confirmed: true,
    });
  }
  async function enqueue(data: unknown = draft) {
    const p = await preview(data);
    const response = await queue(p.id);
    assert.equal(response.status, 201, await response.clone().text());
    return (await response.json()).items as any[];
  }
  async function detail(id: string) {
    const response = await request(`${prefix}/invitations/${id}/preview`);
    assert.equal(response.status, 200);
    return (await response.json()).item;
  }
  return {
    directory,
    store,
    owner,
    member,
    other,
    screening,
    draft,
    mail,
    app,
    prefix,
    request,
    preview,
    queue,
    enqueue,
    detail,
    worker,
    user,
    clock,
    advance: (ms: number) => {
      now += ms;
    },
    replaceWorker: () => {
      worker = registerScreeningOutreach(express(), store, {
        clock,
        mail,
        fetch: options.fetch,
      });
      return worker;
    },
    close: async () => {
      await worker.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("reviewed invitations persist immutable per-recipient capabilities without plaintext tokens and replay once", async () => {
  const f = await fixture();
  try {
    const p = await f.preview({
      ...f.draft,
      recipients: [
        ...f.draft.recipients,
        { name: "Taylor Example", email: "taylor@example.test" },
      ],
    });
    assert.equal(p.recipients.length, 2);
    assert.match(p.recipients[0].body, /unique candidate link/);
    const requestId = randomUUID(),
      response = await f.queue(p.id, requestId);
    assert.equal(response.status, 201);
    const items = (await response.json()).items;
    assert.equal(items.length, 2);
    const retry = await f.queue(p.id, requestId);
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).replayed, true);
    assert.equal((await f.queue(p.id)).status, 409);
    const messages = await Promise.all(
      items.map((item: any) => f.detail(item.id)),
    );
    assert.notEqual(messages[0].url, messages[1].url);
    const token = new URL(messages[0].url).pathname.split("/").pop()!;
    for (const table of [
      "screening_invitations",
      "screening_invitation_previews",
      "screening_invitation_messages",
      "screening_publications",
    ]) {
      assert.ok(
        !JSON.stringify(
          f.store.db.prepare(`SELECT * FROM ${table}`).all(),
        ).includes(token),
      );
    }
    assert.equal(
      statSync(join(f.directory, "screening-outreach.key")).mode & 0o777,
      0o600,
    );
    assert.equal(
      readFileSync(join(f.directory, "screening-outreach.key"), "utf8").length,
      64,
    );
    f.store.update(f.owner.workspaceId, "screenings", {
      ...f.screening,
      title: "Changed after invitation",
    });
    const published = await f.request(`/api/interviews/${token}`);
    assert.equal(published.status, 200);
    const value = await published.json();
    assert.equal(value.item.title, "Engineer screening");
    assert.ok(!JSON.stringify(value).includes("Private"));
    await f.worker.tick();
    await f.worker.tick();
    const states = f.store.db
      .prepare(
        "SELECT status FROM screening_invitation_messages WHERE kind='invitation'",
      )
      .all();
    assert.deepEqual(
      states.map((row) => row.status),
      ["outbox", "outbox"],
    );
    const history = await (await f.request(f.prefix)).json();
    assert.ok(
      history.items.find((item: any) => item.id === items[0].id).openedAt,
    );
  } finally {
    await f.close();
  }
});

test("reminders survive restart and completion stops the remaining schedule", async () => {
  const f = await fixture();
  try {
    const [item] = await f.enqueue();
    await f.worker.tick();
    const original = await f.detail(item.id);
    const replacement = f.replaceWorker();
    assert.equal((await f.detail(item.id)).url, original.url);
    f.advance(4 * DAY);
    await replacement.tick();
    assert.equal(
      f.store.db
        .prepare(
          "SELECT status FROM screening_invitation_messages WHERE kind='reminder' AND days_before=3",
        )
        .get()?.status,
      "outbox",
    );
    const token = new URL(original.url).pathname.split("/").pop()!,
      form = (await (await f.request(`/api/interviews/${token}`)).json()).item;
    const submitted = await f.request(
      `/api/interviews/${token}/responses`,
      "POST",
      {
        candidateName: "Alex Candidate",
        email: "alex@example.test",
        consent: true,
        answers: [
          { questionId: form.questions[0].id, value: "Built services." },
        ],
      },
      "",
    );
    assert.equal(submitted.status, 201);
    f.advance(2 * DAY);
    await replacement.tick();
    assert.equal(
      f.store.db
        .prepare(
          "SELECT status FROM screening_invitation_messages WHERE kind='reminder' AND days_before=1",
        )
        .get()?.status,
      "cancelled",
    );
    assert.equal(
      (await (await f.request(f.prefix)).json()).items[0].status,
      "completed",
    );
  } finally {
    await f.close();
  }
});

test("cancellation revokes capability and prevents dispatch, including pending reminders", async () => {
  const f = await fixture();
  try {
    const [item] = await f.enqueue(),
      message = await f.detail(item.id);
    const cancel = await f.request(
      `${f.prefix}/invitations/${item.id}/cancel`,
      "POST",
      { confirmed: true },
    );
    assert.equal(cancel.status, 200);
    await f.worker.tick();
    assert.ok(
      f.store.db
        .prepare("SELECT status FROM screening_invitation_messages")
        .all()
        .every((row) => row.status === "cancelled"),
    );
    assert.equal(
      (
        await f.request(
          new URL(message.url).pathname.replace(
            "/interviews/",
            "/api/interviews/",
          ),
        )
      ).status,
      404,
    );
  } finally {
    await f.close();
  }
});

test("GET opt-out is inert; POST suppresses future batches and all pending messages for that workspace recipient", async () => {
  const f = await fixture();
  try {
    const [item] = await f.enqueue(),
      message = await f.detail(item.id),
      path = new URL(message.unsubscribeUrl).pathname;
    assert.equal((await f.request(path)).status, 200);
    assert.equal(
      f.store.db
        .prepare("SELECT COUNT(*) AS n FROM screening_invitation_suppressions")
        .get()?.n,
      0,
    );
    assert.equal((await f.request(path, "POST", {})).status, 200);
    await f.worker.tick();
    assert.ok(
      f.store.db
        .prepare("SELECT status FROM screening_invitation_messages")
        .all()
        .every((row) => row.status === "cancelled"),
    );
    assert.equal(
      (await f.request(f.prefix + "/preview", "POST", f.draft)).status,
      409,
    );
    assert.equal(
      (
        await f.request(
          new URL(message.url).pathname.replace(
            "/interviews/",
            "/api/interviews/",
          ),
        )
      ).status,
      200,
    );
  } finally {
    await f.close();
  }
});

test("unknown provider outcome and stale sending claims never resend after restart", async () => {
  let calls = 0;
  const f = await fixture({
    live: true,
    fetch: (async () => {
      calls++;
      throw new Error("connection interrupted");
    }) as typeof fetch,
  });
  try {
    const [item] = await f.enqueue();
    await f.worker.tick();
    assert.equal(calls, 1);
    await f.worker.tick();
    f.advance(8 * DAY);
    await f.worker.tick();
    assert.equal(calls, 1);
    assert.equal(
      f.store.db
        .prepare(
          "SELECT status FROM screening_invitation_messages WHERE kind='invitation'",
        )
        .get()?.status,
      "unknown",
    );
    assert.equal(
      (await (await f.request(f.prefix)).json()).items[0].status,
      "attention",
    );
    // A second fixture isolates restart recovery from prior provider attempts.
    assert.ok(item.id);
  } finally {
    await f.close();
  }
  const second = await fixture();
  try {
    await second.enqueue();
    second.store.db
      .prepare(
        "UPDATE screening_invitation_messages SET status='sending',claimed_at=? WHERE kind='invitation'",
      )
      .run(second.clock() - 61000);
    await second.worker.tick();
    assert.equal(
      second.store.db
        .prepare(
          "SELECT status FROM screening_invitation_messages WHERE kind='invitation'",
        )
        .get()?.status,
      "unknown",
    );
    assert.ok(
      second.store.db
        .prepare(
          "SELECT status FROM screening_invitation_messages WHERE kind='reminder'",
        )
        .all()
        .every((row) => row.status === "cancelled"),
    );
  } finally {
    await second.close();
  }
});

test("provider events update delivery and bounce suppression prevents reminders", async () => {
  let requests = 0;
  const f = await fixture({
    live: true,
    fetch: (async (_url, init) => {
      requests++;
      return Response.json(
        init?.method === "POST"
          ? { id: "mail-123" }
          : { last_event: "bounced" },
      );
    }) as typeof fetch,
  });
  try {
    await f.enqueue();
    await f.worker.tick();
    assert.equal(
      f.store.db
        .prepare(
          "SELECT status FROM screening_invitation_messages WHERE kind='invitation'",
        )
        .get()?.status,
      "accepted",
    );
    await f.worker.reconcile();
    assert.equal(requests, 2);
    assert.equal(
      f.store.db
        .prepare(
          "SELECT status FROM screening_invitation_messages WHERE kind='invitation'",
        )
        .get()?.status,
      "failed",
    );
    f.advance(4 * DAY);
    await f.worker.tick();
    assert.equal(requests, 2);
    assert.equal(
      (await f.request(f.prefix + "/preview", "POST", f.draft)).status,
      409,
    );
  } finally {
    await f.close();
  }
});

test("workspace and active owner boundaries hold for preview, history, detail, queue and worker", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request(f.prefix, "GET", undefined, "")).status, 401);
    assert.equal(
      (await f.request(f.prefix, "GET", undefined, f.other.cookie)).status,
      404,
    );
    assert.equal(
      (await f.request(f.prefix + "/preview", "POST", f.draft, f.member.cookie))
        .status,
      403,
    );
    const p = await f.preview();
    assert.equal(
      (
        await f.request(
          f.prefix + "/queue",
          "POST",
          { previewId: p.id, requestId: randomUUID(), confirmed: true },
          f.other.cookie,
        )
      ).status,
      404,
    );
    const response = await f.queue(p.id),
      item = (await response.json()).items[0];
    assert.equal(
      (
        await f.request(
          `${f.prefix}/invitations/${item.id}/preview`,
          "GET",
          undefined,
          f.member.cookie,
        )
      ).status,
      403,
    );
    f.store.db
      .prepare("UPDATE memberships SET status='suspended' WHERE user_id=?")
      .run(f.owner.id);
    assert.equal((await f.request(f.prefix)).status, 401);
    await f.worker.tick();
    assert.equal(
      f.store.db.prepare("SELECT status FROM screening_invitations").get()
        ?.status,
      "author_unavailable",
    );
    assert.ok(
      f.store.db
        .prepare("SELECT status FROM screening_invitation_messages")
        .all()
        .every((row) => row.status === "cancelled"),
    );
  } finally {
    await f.close();
  }
});

test("stale, expired and changed previews fail atomically; selected candidate identity is revalidated", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (
        await f.request(f.prefix + "/preview", "POST", {
          ...f.draft,
          revision: "stale",
        })
      ).status,
      409,
    );
    const p = await f.preview();
    f.advance(16 * 60000);
    assert.equal((await f.queue(p.id)).status, 409);
    assert.equal(
      f.store.db
        .prepare("SELECT COUNT(*) AS n FROM screening_invitations")
        .get()?.n,
      0,
    );
    const candidate = {
      id: randomUUID(),
      name: "Workspace Person",
      email: "person@example.test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    f.store.insert(f.owner.workspaceId, "candidates", candidate);
    const selected = await f.preview({
      ...f.draft,
      candidateIds: [candidate.id],
      recipients: [],
    });
    f.store.update(f.owner.workspaceId, "candidates", {
      ...candidate,
      email: "changed@example.test",
    });
    assert.equal((await f.queue(selected.id)).status, 409);
    assert.equal(
      f.store.db
        .prepare("SELECT COUNT(*) AS n FROM screening_publications")
        .get()?.n,
      0,
    );
    const changed = await f.preview();
    f.store.update(f.owner.workspaceId, "screenings", {
      ...f.screening,
      title: "Revised",
    });
    assert.equal((await f.queue(changed.id)).status, 409);
  } finally {
    await f.close();
  }
});

test("validation prevents duplicate recipients, invalid reminder windows and accidental duplicate invitations", async () => {
  const f = await fixture();
  try {
    for (const draft of [
      {
        ...f.draft,
        recipients: [...f.draft.recipients, ...f.draft.recipients],
      },
      { ...f.draft, reminderDays: [7] },
      { ...f.draft, subject: "bad\nheader" },
      { ...f.draft, body: "{{unknown_variable}}" },
    ])
      assert.equal(
        (await f.request(f.prefix + "/preview", "POST", draft)).status,
        400,
      );
    await f.enqueue();
    const duplicate = await f.preview();
    assert.equal((await f.queue(duplicate.id)).status, 409);
    assert.equal(
      f.store.db
        .prepare("SELECT COUNT(*) AS n FROM screening_invitations")
        .get()?.n,
      1,
    );
  } finally {
    await f.close();
  }
});

test("revoked, expired and deleted-candidate invitations suppress dispatch", async () => {
  for (const scenario of ["revoked", "expired", "candidate_removed"]) {
    const f = await fixture();
    try {
      let draft: any = f.draft;
      if (scenario === "candidate_removed") {
        const candidate = {
          id: randomUUID(),
          name: "Local Candidate",
          email: "local@example.test",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        f.store.insert(f.owner.workspaceId, "candidates", candidate);
        draft = { ...f.draft, recipients: [], candidateIds: [candidate.id] };
      }
      await f.enqueue(draft);
      if (scenario === "revoked")
        f.store.db
          .prepare("UPDATE screening_publications SET revoked_at=?")
          .run(new Date().toISOString());
      if (scenario === "expired") f.advance(8 * DAY);
      if (scenario === "candidate_removed")
        f.store.db
          .prepare("DELETE FROM resources WHERE kind='candidates'")
          .run();
      await f.worker.tick();
      assert.equal(
        f.store.db.prepare("SELECT status FROM screening_invitations").get()
          ?.status,
        scenario,
      );
      assert.ok(
        f.store.db
          .prepare("SELECT status FROM screening_invitation_messages")
          .all()
          .every((row) => row.status === "cancelled"),
      );
    } finally {
      await f.close();
    }
  }
});

test("live availability is revalidated at preview, queue and dispatch", async () => {
  let available = false,
    checks = 0;
  const f = await fixture({
    validateSnapshot: () => {
      checks++;
      if (!available)
        throw new ScreeningError(409, "Live provider unavailable.");
    },
  });
  try {
    assert.equal(
      (await f.request(f.prefix + "/preview", "POST", f.draft)).status,
      409,
    );
    available = true;
    const p = await f.preview();
    available = false;
    assert.equal((await f.queue(p.id)).status, 409);
    available = true;
    assert.equal((await f.queue(p.id)).status, 201);
    available = false;
    await f.worker.tick();
    assert.equal(
      f.store.db
        .prepare(
          "SELECT status FROM screening_invitation_messages WHERE kind='invitation'",
        )
        .get()?.status,
      "failed",
    );
    assert.equal(checks, 5);
  } finally {
    await f.close();
  }
});

test("worker downtime never sends multiple catch-up reminders alongside a late invitation", async () => {
  const f = await fixture();
  try {
    await f.enqueue();
    f.advance(6 * DAY);
    await f.worker.tick();
    assert.equal(
      f.store.db
        .prepare(
          "SELECT status FROM screening_invitation_messages WHERE kind='invitation'",
        )
        .get()?.status,
      "outbox",
    );
    assert.ok(
      f.store.db
        .prepare(
          "SELECT status FROM screening_invitation_messages WHERE kind='reminder'",
        )
        .all()
        .every((row) => row.status === "skipped"),
    );
  } finally {
    await f.close();
  }
});
