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
import {
  createMailTransport,
  MailError,
  type OutboundMail,
} from "../../server/mail.js";
import {
  registerReportSubscriptionUnsubscribe,
  nextReportDigest,
} from "../../server/report-collaboration.js";

const quote = "Candidate: I led a team of four engineers.";
async function fixture(mode: "outbox" | "resend" = "outbox") {
  const configured = true;
  let now = Date.now();
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
  const sent: OutboundMail[] = [];
  const transport = createMailTransport({
    mode,
    apiKey: "synthetic",
    from: "reports@example.com",
    replyTo: "",
    publicUrl: "https://arkoffer.example",
    workspaceIds: [owner.workspaceId],
  });
  let sendHandler = async (
    message: OutboundMail,
  ): Promise<{ id: string; state: "outbox" | "accepted" }> => ({
    id: "synthetic",
    state: mode === "outbox" ? "outbox" : "accepted",
  });
  transport.send = async (message) => {
    sent.push(message);
    return sendHandler(message);
  };
  registerReportSubscriptionUnsubscribe(app, store);
  let worker = registerReportViews(app, store, {
    ai,
    mail: transport,
    clock: () => now,
  });
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
    sent,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    setSendHandler: (fn: typeof sendHandler) => {
      sendHandler = fn;
    },
    verify: (id = owner.id) =>
      store.db
        .prepare("UPDATE users SET email_verified_at=? WHERE id=?")
        .run(new Date().toISOString(), id),
    publicRequest: (path: string, method = "GET") =>
      fetch(`http://127.0.0.1:${address.port}${path}`, { method }),
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
    start: () => worker.start(),
    restart() {
      worker = registerReportViews(express(), store, {
        ai,
        mail: transport,
        clock: () => now,
      });
    },
    async close() {
      await worker.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      closeStore();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
const share = async (
  f: Awaited<ReturnType<typeof fixture>>,
  view: any,
  permission: "viewer" | "editor" | null,
  revision = 1,
) => {
  const response = await f.request(`/${view.id}/sharing`, "PUT", {
    revision,
    grants: permission ? [{ userId: f.member.id, permission }] : [],
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
};
const sourceGrant = (f: Awaited<ReturnType<typeof fixture>>) =>
  f.store.db
    .prepare(
      "INSERT INTO resource_grants(resource_id,user_id,permission,created_at) VALUES(?,?,?,?)",
    )
    .run(f.first.id, f.member.id, "viewer", new Date().toISOString());
const subscribe = async (
  f: Awaited<ReturnType<typeof fixture>>,
  view: any,
  extra = {},
  cookie = f.owner.cookie,
) => {
  const response = await f.request(
    `/${view.id}/subscription`,
    "PUT",
    { revision: 0, enabled: true, frequency: "immediate", ...extra },
    cookie,
  );
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
};
const deliveries = async (
  f: Awaited<ReturnType<typeof fixture>>,
  view: any,
  cookie = f.owner.cookie,
) =>
  (
    await (
      await f.request(`/${view.id}/subscription`, "GET", undefined, cookie)
    ).json()
  ).deliveries;

test("shared viewer reads report metadata but cannot see private evidence, change sources or manage access", async () => {
  const f = await fixture();
  try {
    const view = await f.create(),
      run = await f.run(view);
    await f.tick();
    assert.equal(
      (await f.request(`/${view.id}`, "GET", undefined, f.member.cookie))
        .status,
      404,
    );
    await share(f, view, "viewer");
    let result = await f.detail(view, f.member.cookie);
    assert.equal(result.item.permission, "viewer");
    assert.equal(result.item.canEdit, false);
    assert.equal(result.item.canManage, false);
    assert.equal(result.item.unavailableSourceCount, 1);
    assert.deepEqual(result.item.sourceIds, []);
    assert.equal(result.runs[0].rows[0].unavailable, true);
    assert.equal(result.runs[0].aggregation.counts.available, 0);
    assert.equal(JSON.stringify(result).includes(quote), false);
    assert.equal(
      (
        await f.request(
          `/${view.id}`,
          "PATCH",
          { revision: 1, definition: f.definition() },
          f.member.cookie,
        )
      ).status,
      403,
    );
    assert.equal(
      (await f.request(`/${view.id}`, "DELETE", undefined, f.member.cookie))
        .status,
      403,
    );
    assert.equal(
      (
        await f.request(
          `/${view.id}/sharing`,
          "PUT",
          { revision: 2, grants: [] },
          f.member.cookie,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await f.request(
          `/${view.id}/runs`,
          "POST",
          { consent: true, requestKey: randomUUID(), revision: 1 },
          f.member.cookie,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await f.request(
          `/${view.id}/runs/${run.id}/export.csv`,
          "GET",
          undefined,
          f.member.cookie,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await (
          await f.request(
            `/${view.id}/runs/${run.id}/export.csv`,
            "GET",
            undefined,
            f.member.cookie,
          )
        ).text()
      ).includes(quote),
      false,
    );
    sourceGrant(f);
    result = await f.detail(view, f.member.cookie);
    assert.equal(result.runs[0].rows[0].cells[0].value, "Led four engineers");
    const cellId = result.runs[0].rows[0].cells[0].id;
    assert.equal(
      (
        await f.request(
          `/${view.id}/runs/${run.id}/cells/${cellId}`,
          "PATCH",
          { annotation: "forged" },
          f.member.cookie,
        )
      ).status,
      403,
    );
    await f.request(
      `/${view.id}/preferences`,
      "PATCH",
      { favorite: true },
      f.member.cookie,
    );
    assert.equal((await f.detail(view)).item.favorite, false);
    assert.equal((await f.detail(view, f.member.cookie)).item.favorite, true);
    await share(f, view, null, 2);
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
    assert.equal(
      (await (await f.request("", "GET", undefined, f.member.cookie)).json())
        .items.length,
      0,
    );
    assert.equal(
      (await f.request(`/${view.id}`, "GET", undefined, f.other.cookie)).status,
      404,
    );
  } finally {
    await f.close();
  }
});

test("editor grants preserve revision conflicts and require access to every source before replacing definitions", async () => {
  const f = await fixture();
  try {
    const view = await f.create();
    await share(f, view, "editor");
    assert.equal(
      (
        await f.request(
          `/${view.id}`,
          "PATCH",
          { revision: 1, definition: f.definition() },
          f.member.cookie,
        )
      ).status,
      409,
    );
    sourceGrant(f);
    assert.equal(
      (
        await f.request(
          `/${view.id}`,
          "PATCH",
          {
            revision: 1,
            definition: f.definition({ name: "Edited by member" }),
          },
          f.member.cookie,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await f.request(`/${view.id}`, "PATCH", {
          revision: 1,
          definition: f.definition(),
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await f.request(`/${view.id}/sharing`, "PUT", {
          revision: 1,
          grants: [],
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await f.request(`/${view.id}/sharing`, "PUT", {
          revision: 2,
          grants: [{ userId: f.other.id, permission: "viewer" }],
        })
      ).status,
      400,
    );
    const changed = (await f.detail(view)).item;
    await f.run(changed, randomUUID(), f.member.cookie);
    await f.tick();
    assert.equal((await f.detail(view)).runs[0].status, "complete");
    await f.request(`/${view.id}/sharing`, "PUT", { revision: 2, grants: [] });
    assert.equal(
      (await f.request(`/${view.id}`, "GET", undefined, f.member.cookie))
        .status,
      404,
    );
  } finally {
    await f.close();
  }
});

test("immediate report subscriptions notify completed authorized runs once and unsubscribe suppresses previews", async () => {
  const f = await fixture();
  try {
    const view = await f.create();
    await subscribe(f, view);
    await f.run(view);
    await f.tick();
    await f.tick();
    assert.equal(f.sent.length, 1);
    assert.equal(f.calls.length, 1);
    assert.match(
      f.sent[0].text,
      /1 newly completed report run with 1 currently accessible result row/,
    );
    assert.equal(f.sent[0].text.includes(quote), false);
    const rows = await deliveries(f, view);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "outbox");
    const preview = await (
      await f.request(`/${view.id}/subscription/deliveries/${rows[0].id}`)
    ).json();
    assert.equal(preview.preview.to.endsWith("@example.com"), true);
    const unsubscribe = new URL(f.sent[0].unsubscribeUrl!).pathname;
    assert.equal((await f.publicRequest(unsubscribe)).status, 200);
    assert.equal(
      (await (await f.request(`/${view.id}/subscription`)).json()).subscription
        .enabled,
      true,
    );
    await f.publicRequest(unsubscribe, "POST");
    await f.publicRequest(unsubscribe, "POST");
    assert.equal(
      (await (await f.request(`/${view.id}/subscription`)).json()).subscription
        .enabled,
      false,
    );
    assert.equal(
      (
        await (
          await f.request(`/${view.id}/subscription/deliveries/${rows[0].id}`)
        ).json()
      ).preview,
      null,
    );
    await f.run(view);
    await f.tick();
    assert.equal(f.sent.length, 1);
  } finally {
    await f.close();
  }
});

test("report subscriptions enforce verified self-addresses and fail closed on unknown delivery outcomes", async () => {
  const f = await fixture("resend");
  try {
    const view = await f.create();
    assert.equal(
      (
        await f.request(`/${view.id}/subscription`, "PUT", {
          revision: 0,
          enabled: true,
          frequency: "immediate",
        })
      ).status,
      409,
    );
    f.verify();
    await subscribe(f, view);
    assert.equal(
      (
        await f.request(`/${view.id}/subscription`, "PUT", {
          revision: 1,
          enabled: true,
          frequency: "immediate",
          email: "other@example.com",
        })
      ).status,
      400,
    );
    f.setSendHandler(async () => {
      throw new MailError("unknown", "Unknown");
    });
    await f.run(view);
    await f.tick();
    await f.tick();
    assert.equal(f.sent.length, 1);
    assert.equal((await deliveries(f, view))[0].status, "unknown");
    f.restart();
    await f.tick();
    assert.equal(f.sent.length, 1);
  } finally {
    await f.close();
  }
});

test("weekly digests aggregate existing runs and suppress revoked or stale-source notifications", async () => {
  const f = await fixture();
  try {
    const view = await f.create();
    await share(f, view, "viewer");
    sourceGrant(f);
    const sub = await subscribe(
      f,
      view,
      { frequency: "weekly", weekday: 4, utcHour: 14 },
      f.member.cookie,
    );
    await f.run(view);
    await f.tick();
    assert.equal(f.sent.length, 0);
    const due = Date.parse(sub.subscription.nextAt);
    f.advance(due - f.now());
    await f.tick();
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].to, `${f.member.id}@example.com`);
    const delivery = (await deliveries(f, view, f.member.cookie))[0];
    f.change(f.first, { transcript: "Changed private source" });
    assert.equal(
      (
        await (
          await f.request(
            `/${view.id}/subscription/deliveries/${delivery.id}`,
            "GET",
            undefined,
            f.member.cookie,
          )
        ).json()
      ).preview,
      null,
    );
    await share(f, view, null, 2);
    assert.equal(
      (
        await f.request(
          `/${view.id}/subscription`,
          "GET",
          undefined,
          f.member.cookie,
        )
      ).status,
      404,
    );
    assert.equal(
      f.store.db
        .prepare("SELECT enabled FROM ai_report_subscriptions WHERE user_id=?")
        .get(f.member.id)?.enabled,
      0,
    );
    assert.equal(
      f.store.db
        .prepare("SELECT status FROM ai_report_deliveries WHERE id=?")
        .get(delivery.id)?.status,
      "cancelled",
    );
  } finally {
    await f.close();
  }
});

test("upcoming reminders require selected matching precise times and recheck changed metadata", async () => {
  const f = await fixture();
  try {
    const time = new Date(f.now() + 25 * 60000).toISOString();
    f.change(f.first, { status: "upcoming", date: time });
    const view = await f.create();
    await subscribe(f, view, {
      notifyResults: false,
      notifyUpcoming: true,
      frequency: "monthly",
      monthDay: 15,
    });
    await f.tick();
    await f.tick();
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0].text, /Upcoming selected conversations/);
    assert.equal(f.calls.length, 0);
    const delivery = (await deliveries(f, view))[0];
    f.change(f.first, { date: new Date(f.now() + 90 * 60000).toISOString() });
    assert.equal(
      (
        await (
          await f.request(`/${view.id}/subscription/deliveries/${delivery.id}`)
        ).json()
      ).preview,
      null,
    );
    await f.tick();
    assert.equal(f.sent.length, 1);
    f.change(f.first, { date: "2026-10-14" });
    await f.tick();
    assert.equal(f.sent.length, 1);
    f.change(f.first, { date: time, status: "ready" });
    await f.tick();
    assert.equal(f.sent.length, 1);
    f.change(f.first, { date: time, status: "upcoming" });
    await f.tick();
    assert.equal(f.sent.length, 1);
  } finally {
    await f.close();
  }
});

test("subscription changes reject stale revisions and monthly schedules honor UTC boundaries", () => {
  assert.equal(
    new Date(
      nextReportDigest(Date.parse("2026-10-13T08:59:59Z"), "weekly", {
        weekday: 2,
        utcHour: 9,
      }),
    ).toISOString(),
    "2026-10-13T09:00:00.000Z",
  );
  assert.equal(
    new Date(
      nextReportDigest(Date.parse("2026-10-13T09:00:00Z"), "weekly", {
        weekday: 2,
        utcHour: 9,
      }),
    ).toISOString(),
    "2026-10-20T09:00:00.000Z",
  );
  assert.equal(
    new Date(
      nextReportDigest(Date.parse("2026-12-31T23:30:00Z"), "monthly", {
        monthDay: 1,
        utcHour: 0,
      }),
    ).toISOString(),
    "2027-01-01T00:00:00.000Z",
  );
  assert.equal(
    new Date(
      nextReportDigest(Date.parse("2028-02-28T09:00:00Z"), "monthly", {
        monthDay: 28,
        utcHour: 9,
      }),
    ).toISOString(),
    "2028-03-28T09:00:00.000Z",
  );
});

test("paused memberships, changed email and interrupted sends cannot deliver queued report data", async () => {
  const f = await fixture("resend");
  try {
    const view = await f.create();
    f.verify();
    await subscribe(f, view);
    f.store.db
      .prepare("UPDATE users SET email=? WHERE id=?")
      .run("changed@example.com", f.owner.id);
    await f.run(view);
    await f.tick();
    assert.equal(f.sent.length, 0);
    const state = await (await f.request(`/${view.id}/subscription`)).json();
    assert.equal(state.subscription.enabled, false);
    assert.equal(
      (
        await f.request(`/${view.id}/subscription`, "PUT", {
          revision: 1,
          enabled: true,
          frequency: "immediate",
        })
      ).status,
      409,
    );
    await subscribe(f, view, { revision: state.subscription.revision });
    await f.run(view);
    await f.tick();
    assert.equal(f.sent.length, 1);
    f.store.db
      .prepare("UPDATE ai_report_deliveries SET status='sending'")
      .run();
    f.restart();
    await f.tick();
    assert.equal(f.sent.length, 1);
    assert.equal((await deliveries(f, view))[0].status, "unknown");
  } finally {
    await f.close();
  }
});

test("monthly digest days clamp without skipping short months or changing the UTC hour", () => {
  assert.equal(
    new Date(
      nextReportDigest(Date.parse("2028-01-31T09:00:00Z"), "monthly", {
        monthDay: 31,
        utcHour: 9,
      }),
    ).toISOString(),
    "2028-02-29T09:00:00.000Z",
  );
  assert.equal(
    new Date(
      nextReportDigest(Date.parse("2027-02-01T00:00:00Z"), "monthly", {
        monthDay: 31,
        utcHour: 23,
      }),
    ).toISOString(),
    "2027-02-28T23:00:00.000Z",
  );
  assert.equal(
    new Date(
      nextReportDigest(Date.parse("2026-12-31T23:00:00Z"), "monthly", {
        monthDay: 31,
        utcHour: 23,
      }),
    ).toISOString(),
    "2027-01-31T23:00:00.000Z",
  );
});

test("digest notices exclude historical definitions and sources no longer matching report filters", async () => {
  const f = await fixture();
  try {
    f.change(f.first, { status: "ready" });
    const input = f.definition({
        filters: { title: "", from: "", to: "", status: "ready" },
      }),
      view = await f.create(input);
    const saved = await subscribe(f, view, { frequency: "weekly" });
    await f.run(view);
    await f.tick();
    f.change(f.first, { status: "upcoming" });
    f.advance(Date.parse(saved.subscription.nextAt) - f.now());
    await f.tick();
    assert.equal(f.sent.length, 0);
    f.change(f.first, { status: "ready" });
    const changed = await f.request(`/${view.id}`, "PATCH", {
      revision: 1,
      definition: { ...input, question: "A changed report question" },
    });
    assert.equal(changed.status, 200);
    const renewed = await subscribe(f, view, {
      revision: 1,
      frequency: "immediate",
    });
    assert.equal(renewed.subscription.revision, 2);
    // A retained old-revision run cannot generate an update for the changed report.
    f.store.db
      .prepare("UPDATE ai_report_runs SET completed_at=? WHERE view_id=?")
      .run(new Date(f.now() + 1).toISOString(), view.id);
    await f.tick();
    assert.equal(f.sent.length, 0);
  } finally {
    await f.close();
  }
});

test("revoking an editor during extraction discards the in-flight answer and cancels subscriptions", async () => {
  const f = await fixture();
  try {
    const view = await f.create();
    await share(f, view, "editor");
    sourceGrant(f);
    await subscribe(f, view, {}, f.member.cookie);
    let release!: (value: unknown) => void, started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.setHandler(() => {
      started();
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    await f.run(view, randomUUID(), f.member.cookie);
    const tick = f.tick();
    await entered;
    await share(f, view, null, 2);
    release({
      cells: [
        {
          columnId: "leadership",
          value: "Led four engineers",
          evidence: [{ quote }],
        },
      ],
    });
    await tick;
    const detail = await f.detail(view);
    assert.equal(detail.runs[0].status, "cancelled");
    assert.equal(detail.runs[0].rows[0].cells[0].value, null);
    assert.equal(f.sent.length, 0);
  } finally {
    await f.close();
  }
});

test("mail mode and sender changes require fresh subscription consent", async () => {
  const f = await fixture();
  try {
    const view = await f.create();
    await subscribe(f, view);
    // Simulates a new operator transport configuration, without touching process.env.
    f.store.db
      .prepare("UPDATE ai_report_subscriptions SET mode='resend'")
      .run();
    await f.run(view);
    await f.tick();
    assert.equal(f.sent.length, 0);
    assert.equal(
      (await (await f.request(`/${view.id}/subscription`)).json()).subscription
        .enabled,
      false,
    );
  } finally {
    await f.close();
  }
});

test("events claimed by another worker after discovery do not queue duplicate emails", async () => {
  const f = await fixture();
  try {
    const view = await f.create(),
      run = await f.run(view);
    await f.tick();
    await subscribe(f, view);
    f.store.db
      .prepare("UPDATE ai_report_runs SET completed_at=? WHERE id=?")
      .run(new Date(f.now() + 1).toISOString(), run.id);
    const subscription = f.store.db
      .prepare(
        "SELECT id,revision FROM ai_report_subscriptions WHERE view_id=?",
      )
      .get(view.id)!;
    const transaction = f.store.transaction.bind(f.store);
    let intercepted = false;
    f.store.transaction = (action) => {
      if (!intercepted) {
        intercepted = true;
        transaction(() =>
          f.store.db
            .prepare(
              "INSERT INTO ai_report_subscription_events(subscription_id,revision,run_id) VALUES(?,?,?)",
            )
            .run(
              String(subscription.id),
              Number(subscription.revision),
              run.id,
            ),
        );
      }
      return transaction(action);
    };
    await f.tick();
    assert.equal(intercepted, true);
    assert.equal(f.sent.length, 0);
    assert.equal((await deliveries(f, view)).length, 0);
  } finally {
    await f.close();
  }
});

test("upcoming mail scheduling continues while AI extraction is waiting on its provider", async () => {
  const f = await fixture();
  let release!: (value: unknown) => void;
  try {
    f.change(f.first, {
      status: "upcoming",
      date: new Date(f.now() + 20 * 60000).toISOString(),
    });
    const view = await f.create();
    await subscribe(f, view, { notifyResults: false, notifyUpcoming: true });
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.setHandler(() => {
      started();
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    await f.run(view);
    f.start();
    await entered;
    await new Promise<void>((resolve, reject) => {
      const until = Date.now() + 5000;
      const timer = setInterval(() => {
        if (f.sent.length || Date.now() > until) {
          clearInterval(timer);
          f.sent.length
            ? resolve()
            : reject(new Error("Mail did not run independently"));
        }
      }, 25);
    });
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0].text, /Upcoming selected conversations/);
    release({
      cells: [
        {
          columnId: "leadership",
          value: "Led four engineers",
          evidence: [{ quote }],
        },
      ],
    });
    await f.tick();
  } finally {
    if (release) release({ cells: [] });
    await f.close();
  }
});
