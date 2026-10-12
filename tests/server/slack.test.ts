import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { createDatabase, type Store } from "../../server/db.js";
import { hashToken, type User } from "../../server/auth.js";
import {
  initializeAccess,
  registerConversationOwner,
} from "../../server/access.js";
import { registerSlack, type SlackOptions } from "../../server/slack.js";
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
    .run(id, workspaceId, "Taylor", `${id}@example.com`, "unused", role, date);
  store.db
    .prepare(
      "INSERT INTO sessions(token_hash,user_id,workspace_id,expires_at,created_at) VALUES(?,?,?,?,?)",
    )
    .run(hashToken(token), id, workspaceId, Date.now() + 7 * 86_400_000, date);
  return { id, workspaceId, token, cookie: `arkoffer_session=${token}` };
}
async function fixture(options: Partial<SlackOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "arkoffer-slack-")),
    store = createDatabase(dir);
  const owner = addUser(store),
    member = addUser(store, owner.workspaceId, "member"),
    other = addUser(store);
  initializeAccess(store);
  let time = Date.now(),
    provider: (method: string, body: any) => Promise<Response> = async (
      method,
    ) => {
      if (method === "oauth.v2.access")
        return Response.json({
          ok: true,
          access_token: "xoxb-test-bot-secret",
          app_id: "ATEST",
          team: { id: "TTEST", name: "Acme Slack" },
          bot_user_id: "UBOT",
          scope: "commands,chat:write,im:write",
        });
      if (method === "conversations.open")
        return Response.json({ ok: true, channel: { id: "DPRIVATE" } });
      if (method === "chat.postMessage")
        return Response.json({ ok: true, ts: "123.456" });
      if (method === "auth.revoke") return Response.json({ ok: true });
      throw new Error("Unexpected method");
    };
  const calls: { method: string; body: any; url: string }[] = [];
  const env: NodeJS.ProcessEnv = {
    SLACK_CLIENT_ID: "test-client",
    SLACK_CLIENT_SECRET: "test-secret",
    SLACK_SIGNING_SECRET: "signing-secret",
    SLACK_APP_ID: "ATEST",
    SLACK_ENCRYPTION_KEY: "ab".repeat(32),
    SLACK_APP_ORIGIN: ORIGIN,
    SLACK_WORKSPACE_IDS: owner.workspaceId,
    SLACK_TEAM_IDS: "TTEST",
  };
  const app = express();
  const worker = registerSlack(app, store, {
    appOrigin: ORIGIN,
    env,
    now: () => time,
    fetch: (async (input, init) => {
      const url = String(input);
      assert.ok(url.startsWith("https://slack.com/api/"));
      assert.equal(init?.redirect, "error");
      const method = url.split("/").at(-1)!;
      const body =
        method === "oauth.v2.access"
          ? Object.fromEntries(new URLSearchParams(String(init?.body)))
          : JSON.parse(String(init?.body));
      calls.push({ method, body, url });
      return provider(method, body);
    }) as typeof fetch,
    answer: async () => ({
      text: "Interview answer",
      conversationIds: [],
      proof: { valid: true },
    }),
    validateAnswer: (_user, answer) => (answer.proof as any)?.valid === true,
    ...options,
  });
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
  worker.registerRoutes();
  app.use((_req, res) => res.status(404).json({ error: "Not found" }));
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
      redirect: "manual",
      headers: {
        Origin: ORIGIN,
        Cookie: cookie,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const signed = (
    path: string,
    body: string,
    json = false,
    timestamp = Math.floor(time / 1000),
  ) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": json
          ? "application/json"
          : "application/x-www-form-urlencoded",
        "X-Slack-Request-Timestamp": String(timestamp),
        "X-Slack-Signature": `v0=${createHmac("sha256", env.SLACK_SIGNING_SECRET!).update(`v0:${timestamp}:${body}`).digest("hex")}`,
      },
      body,
    });
  const commandBody = (text: string, fields: Record<string, string> = {}) =>
    new URLSearchParams({
      api_app_id: "ATEST",
      team_id: "TTEST",
      user_id: "USENDER",
      command: "/arkoffer",
      text,
      trigger_id: randomUUID(),
      channel_id: "CPUBLIC",
      response_url: "https://attacker.example/leak",
      ...fields,
    }).toString();
  const command = (text: string, fields: Record<string, string> = {}) =>
    signed("/api/slack/commands", commandBody(text, fields));
  const event = (type: string, extra = {}, eventId = randomUUID()) =>
    signed(
      "/api/slack/events",
      JSON.stringify({
        api_app_id: "ATEST",
        team_id: "TTEST",
        event_id: eventId,
        event_time: Math.floor(time / 1000),
        type: "event_callback",
        event: { type, ...extra },
      }),
      true,
    );
  const connect = async () => {
    const result = await request("/api/slack/connect", "POST", {});
    assert.equal(result.status, 200, await result.clone().text());
    const state = new URL((await result.json()).url).searchParams.get("state")!;
    const response = await request(
      `/api/slack/callback?state=${state}&code=test-code`,
    );
    assert.equal(response.status, 302, await response.clone().text());
    return state;
  };
  const link = async (cookie = owner.cookie, slackUserId = "USENDER") => {
    const response = await request("/api/slack/link", "POST", {}, cookie);
    assert.equal(response.status, 200);
    const body = await response.json(),
      commandText = String(body.command).replace("/arkoffer ", "");
    const result = await command(commandText, { user_id: slackUserId });
    assert.equal(result.status, 200);
    return { result: await result.json(), commandText };
  };
  const conversation = (user = owner, title = "Private interview") => {
    const item = {
      id: randomUUID(),
      title,
      date: new Date(time + 3600000).toISOString(),
      transcript: "Evidence",
      createdAt: new Date(time).toISOString(),
      updatedAt: new Date(time).toISOString(),
    };
    store.insert(user.workspaceId, "conversations", item);
    registerConversationOwner(store, user.workspaceId, item.id, user.id);
    return item;
  };
  return {
    store,
    owner,
    member,
    other,
    env,
    calls,
    worker,
    request,
    signed,
    command,
    commandBody,
    event,
    connect,
    link,
    conversation,
    setProvider: (fn: typeof provider) => {
      provider = fn;
    },
    time: () => time,
    advance: (ms: number) => {
      time += ms;
    },
    close: async () => {
      await worker.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("Slack configuration, admin-only install, hashed session-bound single-use OAuth and encrypted tokens", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await f.request("/api/slack", "GET", undefined, "")).status,
      401,
    );
    assert.equal(
      (await f.request("/api/slack/connect", "POST", {}, f.member.cookie))
        .status,
      403,
    );
    assert.equal(
      (await f.request("/api/slack/connect", "POST", {}, f.other.cookie))
        .status,
      503,
    );
    const connect = await (
        await f.request("/api/slack/connect", "POST", {})
      ).json(),
      state = new URL(connect.url).searchParams.get("state")!;
    assert.equal(new URL(connect.url).origin, "https://slack.com");
    assert.equal(
      f.store.db.prepare("SELECT state_hash FROM slack_oauth_states").get()!
        .state_hash,
      hashToken(state),
    );
    assert.equal(
      (
        await f.request(
          `/api/slack/callback?state=${state}&code=test`,
          "GET",
          undefined,
          f.member.cookie,
        )
      ).status,
      403,
    );
    assert.equal(
      (await f.request(`/api/slack/callback?state=${state}&code=test`)).status,
      302,
    );
    assert.equal(
      (await f.request(`/api/slack/callback?state=${state}&code=test`)).status,
      400,
    );
    const stored = String(
      f.store.db.prepare("SELECT token FROM slack_installs").get()!.token,
    );
    assert.ok(!stored.includes("xoxb"));
    assert.equal(stored.split(".").length, 3);
    const publicStatus = await (await f.request("/api/slack")).text();
    assert.ok(!publicStatus.includes(stored));
    assert.ok(!publicStatus.includes("test-secret"));
  } finally {
    await f.close();
  }
});

test("Slack blocks untrusted redirect origins, disallowed teams, and rotating token installs", async () => {
  const f = await fixture();
  try {
    f.env.SLACK_APP_ORIGIN = "https://foreign.example";
    assert.equal(
      (await f.request("/api/slack/connect", "POST", {})).status,
      503,
    );
    f.env.SLACK_APP_ORIGIN = ORIGIN;
    f.setProvider(async () =>
      Response.json({
        ok: true,
        access_token: "xoxb-test",
        app_id: "ATEST",
        team: { id: "TFOREIGN" },
        bot_user_id: "UBOT",
        scope: "commands,chat:write,im:write",
      }),
    );
    let state = new URL(
      (await (await f.request("/api/slack/connect", "POST", {})).json()).url,
    ).searchParams.get("state");
    assert.equal(
      (await f.request(`/api/slack/callback?state=${state}&code=test`)).status,
      403,
    );
    f.setProvider(async () =>
      Response.json({
        ok: true,
        access_token: "xoxb-test",
        refresh_token: "refresh",
        app_id: "ATEST",
        team: { id: "TTEST" },
        bot_user_id: "UBOT",
        scope: "commands,chat:write,im:write",
      }),
    );
    state = new URL(
      (await (await f.request("/api/slack/connect", "POST", {})).json()).url,
    ).searchParams.get("state");
    assert.equal(
      (await f.request(`/api/slack/callback?state=${state}&code=test`)).status,
      400,
    );
    assert.equal(
      f.store.db.prepare("SELECT COUNT(*) AS n FROM slack_installs").get()!.n,
      0,
    );
  } finally {
    await f.close();
  }
});

test("Slack rejects forged/stale signatures and signed foreign apps; link codes bind live sessions and sender identities", async () => {
  const f = await fixture();
  try {
    await f.connect();
    assert.equal(
      (await f.request("/api/slack/commands", "POST", {})).status,
      401,
    );
    assert.equal(
      (
        await f.signed(
          "/api/slack/commands",
          f.commandBody("ask test"),
          false,
          Math.floor(f.time() / 1000) - 301,
        )
      ).status,
      401,
    );
    assert.equal(
      (await f.command("ask test", { api_app_id: "AOTHER" })).status,
      400,
    );
    assert.equal(
      (await f.command("ask test", { team_id: "TOTHER" })).status,
      403,
    );
    const linked = await f.link();
    assert.match(linked.result.text, /account is linked/);
    assert.match(
      (
        await (
          await f.command(linked.commandText, { user_id: "UOTHER" })
        ).json()
      ).text,
      /invalid or expired/,
    );
    const conflict = await f.link(f.member.cookie);
    assert.match(conflict.result.text, /already linked/);
    const response = await (
      await f.request("/api/slack/link", "POST", {}, f.member.cookie)
    ).json();
    f.store.db.prepare("DELETE FROM sessions WHERE user_id=?").run(f.member.id);
    assert.match(
      (
        await (
          await f.command(response.command.replace("/arkoffer ", ""), {
            user_id: "UMEMBER",
          })
        ).json()
      ).text,
      /invalid or expired/,
    );
    assert.equal(
      f.store.db.prepare("SELECT COUNT(*) AS n FROM slack_links").get()!.n,
      1,
    );
  } finally {
    await f.close();
  }
});

test("Slack acknowledges durable commands quickly, deduplicates retries and sends only to the linked private DM", async () => {
  const f = await fixture();
  try {
    await f.connect();
    await f.link();
    const body = f.commandBody("ask What happened?");
    assert.equal((await f.signed("/api/slack/commands", body)).status, 200);
    assert.equal((await f.signed("/api/slack/commands", body)).status, 200);
    assert.equal(
      f.store.db.prepare("SELECT COUNT(*) AS n FROM slack_jobs").get()!.n,
      1,
    );
    assert.equal(
      f.calls.filter((call) => call.method === "chat.postMessage").length,
      0,
    );
    await f.worker.tick();
    const sent = f.calls.filter((call) => call.method === "chat.postMessage");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].body.channel, "DPRIVATE");
    assert.equal(sent[0].body.mrkdwn, false);
    assert.equal(
      f.calls.find((call) => call.method === "conversations.open")!.body.users,
      "USENDER",
    );
    assert.ok(f.calls.every((call) => !call.url.includes("attacker")));
    await f.worker.tick();
    assert.equal(
      f.calls.filter((call) => call.method === "chat.postMessage").length,
      1,
    );
    assert.equal(
      f.store.db.prepare("SELECT status FROM slack_jobs").get()!.status,
      "sent",
    );
  } finally {
    await f.close();
  }
});

test("Slack rechecks interview permission and membership after asynchronous answering and opening a DM", async () => {
  let act: (() => void) | undefined;
  const f = await fixture({
    answer: async () => {
      act?.();
      return {
        text: "Sensitive answer",
        conversationIds: [conversationId],
        proof: { valid: true },
      };
    },
  });
  let conversationId = "";
  try {
    await f.connect();
    await f.link(f.member.cookie);
    const conversation = f.conversation();
    conversationId = conversation.id;
    f.store.db
      .prepare("INSERT INTO resource_grants VALUES(?,?,?,?)")
      .run(conversation.id, f.member.id, "viewer", new Date().toISOString());
    act = () => {
      f.store.db
        .prepare("DELETE FROM resource_grants WHERE resource_id=?")
        .run(conversation.id);
    };
    await f.command("ask secret");
    await f.worker.tick();
    assert.equal(
      f.calls.filter((call) => call.method === "chat.postMessage").length,
      0,
    );
    assert.equal(
      f.store.db.prepare("SELECT status FROM slack_jobs").get()!.status,
      "cancelled",
    );
    act = undefined;
    f.store.db
      .prepare("INSERT INTO resource_grants VALUES(?,?,?,?)")
      .run(conversation.id, f.member.id, "viewer", new Date().toISOString());
    f.setProvider(async (method) => {
      if (method === "conversations.open") {
        f.store.db
          .prepare("UPDATE memberships SET status='suspended' WHERE user_id=?")
          .run(f.member.id);
        return Response.json({ ok: true, channel: { id: "DPRIVATE" } });
      }
      throw new Error("Must never post");
    });
    await f.command("ask secret again");
    await f.worker.tick();
    assert.equal(
      f.calls.filter((call) => call.method === "chat.postMessage").length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("Slack validates durable answer proof after DM open and rejects non-private channels", async () => {
  let valid = true;
  const f = await fixture({ validateAnswer: () => valid });
  try {
    await f.connect();
    await f.link();
    f.setProvider(async () => {
      valid = false;
      return Response.json({ ok: true, channel: { id: "DPRIVATE" } });
    });
    await f.command("ask evidence");
    await f.worker.tick();
    assert.equal(
      f.calls.filter((call) => call.method === "chat.postMessage").length,
      0,
    );
    valid = true;
    f.setProvider(async () =>
      Response.json({ ok: true, channel: { id: "CPUBLIC" } }),
    );
    await f.command("ask channel");
    await f.worker.tick();
    assert.equal(
      f.calls.filter((call) => call.method === "chat.postMessage").length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("Slack schedules are opt-in, persist drafts for exact approval, and scope queue controls to the requesting member", async () => {
  const f = await fixture();
  try {
    await f.connect();
    await f.link(f.member.cookie);
    f.conversation(f.member, "Member interview");
    f.conversation(f.owner, "Owner private interview");
    const status = await (
      await f.request("/api/slack", "GET", undefined, f.member.cookie)
    ).json();
    assert.equal(status.schedules.length, 0);
    assert.equal(
      (
        await f.request(
          "/api/slack/schedule",
          "PUT",
          { kind: "digest", enabled: true, hourUtc: 9, delivery: "draft" },
          f.member.cookie,
        )
      ).status,
      200,
    );
    const nextAt = Number(
      f.store.db.prepare("SELECT next_at FROM slack_schedules").get()!.next_at,
    );
    f.advance(nextAt - f.time());
    await f.worker.tick();
    assert.equal(
      f.calls.filter((call) => call.method === "chat.postMessage").length,
      0,
    );
    let jobs = (
      await (
        await f.request("/api/slack", "GET", undefined, f.member.cookie)
      ).json()
    ).jobs;
    assert.equal(jobs[0].status, "draft");
    assert.ok(!jobs[0].body.includes("Owner private interview"));
    assert.equal(
      (
        await f.request(`/api/slack/jobs/${jobs[0].id}/approve`, "POST", {
          revision: jobs[0].revision,
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await f.request(
          `/api/slack/jobs/${jobs[0].id}/approve`,
          "POST",
          { revision: "wrong" },
          f.member.cookie,
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await f.request(
          `/api/slack/jobs/${jobs[0].id}/approve`,
          "POST",
          { revision: jobs[0].revision },
          f.member.cookie,
        )
      ).status,
      200,
    );
    await f.worker.tick();
    assert.equal(
      f.calls.filter((call) => call.method === "chat.postMessage").length,
      1,
    );
    await f.request(
      "/api/slack/drafts",
      "POST",
      { kind: "reminder" },
      f.member.cookie,
    );
    await f.worker.tick();
    jobs = (
      await (
        await f.request("/api/slack", "GET", undefined, f.member.cookie)
      ).json()
    ).jobs;
    assert.equal(
      jobs.find((job: any) => job.kind === "reminder").status,
      "draft",
    );
    await f.request("/api/slack/link", "DELETE", undefined, f.member.cookie);
    assert.equal(
      f.store.db.prepare("SELECT COUNT(*) AS n FROM slack_schedules").get()!.n,
      0,
    );
    assert.equal(
      f.store.db
        .prepare("SELECT status FROM slack_jobs WHERE kind='reminder'")
        .get()!.status,
      "cancelled",
    );
  } finally {
    await f.close();
  }
});

test("Slack honors bounded Retry-After and does not repeat ambiguous sends, even after a restart recovery", async () => {
  const f = await fixture();
  try {
    await f.connect();
    await f.link();
    let posts = 0;
    f.setProvider(async (method) => {
      if (method === "conversations.open")
        return Response.json({ ok: true, channel: { id: "DPRIVATE" } });
      posts++;
      if (posts === 1)
        return new Response("rate limited", {
          status: 429,
          headers: { "Retry-After": "30" },
        });
      throw new Error("Connection lost after send");
    });
    await f.command("ask retry");
    await f.worker.tick();
    assert.equal(posts, 1);
    f.advance(29_000);
    await f.worker.tick();
    assert.equal(posts, 1);
    f.advance(1000);
    await f.worker.tick();
    assert.equal(posts, 2);
    assert.equal(
      f.store.db.prepare("SELECT status FROM slack_jobs").get()!.status,
      "unknown",
    );
    f.advance(300_000);
    await f.worker.tick();
    assert.equal(posts, 2);
    f.store.db
      .prepare("UPDATE slack_jobs SET status='sending',updated_at=?")
      .run(f.time() - 130_000);
    await f.worker.tick();
    assert.equal(
      f.store.db.prepare("SELECT status FROM slack_jobs").get()!.status,
      "unknown",
    );
    assert.equal(posts, 2);
  } finally {
    await f.close();
  }
});

test("Slack signed revocation cancels jobs and schedules, removes tokens and is idempotent", async () => {
  const f = await fixture();
  try {
    await f.connect();
    await f.link();
    await f.command("ask pending");
    await f.request("/api/slack/schedule", "PUT", {
      kind: "digest",
      enabled: true,
      hourUtc: 9,
      delivery: "automatic",
    });
    await f.event("tokens_revoked", { tokens: { bot: ["UOTHER"] } });
    assert.equal(
      f.store.db.prepare("SELECT COUNT(*) AS n FROM slack_installs").get()!.n,
      1,
    );
    const id = randomUUID();
    await f.event("tokens_revoked", { tokens: { bot: ["UBOT"] } }, id);
    await f.event("tokens_revoked", { tokens: { bot: ["UBOT"] } }, id);
    assert.equal(
      f.store.db.prepare("SELECT COUNT(*) AS n FROM slack_installs").get()!.n,
      0,
    );
    assert.equal(
      f.store.db.prepare("SELECT COUNT(*) AS n FROM slack_schedules").get()!.n,
      0,
    );
    assert.equal(
      f.store.db.prepare("SELECT status FROM slack_jobs").get()!.status,
      "cancelled",
    );
    await f.worker.tick();
    assert.equal(
      f.calls.filter((call) => call.method === "chat.postMessage").length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("Slack limits queued questions and disconnect prevents an in-flight OAuth callback from installing", async () => {
  const f = await fixture();
  try {
    await f.connect();
    await f.link();
    for (let i = 0; i < 6; i++) await f.command(`ask question ${i}`);
    assert.equal(
      f.store.db.prepare("SELECT COUNT(*) AS n FROM slack_jobs").get()!.n,
      5,
    );
    assert.equal(
      (await f.request("/api/slack", "DELETE", undefined, f.member.cookie))
        .status,
      403,
    );
    assert.equal((await f.request("/api/slack", "DELETE")).status, 200);
    let release: (() => void) | undefined, started: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.setProvider(async () => {
      started?.();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return Response.json({
        ok: true,
        access_token: "xoxb-test",
        app_id: "ATEST",
        team: { id: "TTEST" },
        bot_user_id: "UBOT",
        scope: "commands,chat:write,im:write",
      });
    });
    const state = new URL(
      (await (await f.request("/api/slack/connect", "POST", {})).json()).url,
    ).searchParams.get("state");
    const callback = f.request(`/api/slack/callback?state=${state}&code=test`);
    await entered;
    await f.request("/api/slack", "DELETE");
    release?.();
    assert.equal((await callback).status, 403);
    assert.equal(
      f.store.db.prepare("SELECT COUNT(*) AS n FROM slack_installs").get()!.n,
      0,
    );
  } finally {
    await f.close();
  }
});

test("Slack signed uninstall replay cannot remove a later installation; stale events are ignored", async () => {
  const f = await fixture();
  try {
    await f.connect();
    const body = JSON.stringify({
      api_app_id: "ATEST",
      team_id: "TTEST",
      event_id: "old-uninstall",
      event_time: Math.floor(f.time() / 1000),
      event: { type: "app_uninstalled" },
      type: "event_callback",
    });
    assert.equal((await f.signed("/api/slack/events", body, true)).status, 200);
    await f.connect();
    await f.signed("/api/slack/events", body, true);
    assert.equal(
      f.store.db.prepare("SELECT COUNT(*) AS n FROM slack_installs").get()!.n,
      1,
    );
    await f.signed(
      "/api/slack/events",
      JSON.stringify({
        ...JSON.parse(body),
        event_id: "delayed-old-event",
        event_time: Math.floor(f.time() / 1000) - 10,
      }),
      true,
    );
    assert.equal(
      f.store.db.prepare("SELECT COUNT(*) AS n FROM slack_installs").get()!.n,
      1,
    );
  } finally {
    await f.close();
  }
});

test("Slack draft permission loss hides content and prevents approval; automatic schedules deliver only after opt-in", async () => {
  const f = await fixture();
  try {
    await f.connect();
    await f.link(f.member.cookie);
    const item = f.conversation();
    f.store.db
      .prepare("INSERT INTO resource_grants VALUES(?,?,?,?)")
      .run(item.id, f.member.id, "viewer", new Date().toISOString());
    await f.request(
      "/api/slack/drafts",
      "POST",
      { kind: "digest" },
      f.member.cookie,
    );
    await f.worker.tick();
    const draft = (
      await (
        await f.request("/api/slack", "GET", undefined, f.member.cookie)
      ).json()
    ).jobs[0];
    assert.match(draft.body, /Private interview/);
    f.store.db
      .prepare("DELETE FROM resource_grants WHERE resource_id=?")
      .run(item.id);
    const hidden = (
      await (
        await f.request("/api/slack", "GET", undefined, f.member.cookie)
      ).json()
    ).jobs[0];
    assert.equal(hidden.body, "");
    assert.equal(hidden.status, "cancelled");
    assert.equal(
      (
        await f.request(
          `/api/slack/jobs/${draft.id}/approve`,
          "POST",
          { revision: draft.revision },
          f.member.cookie,
        )
      ).status,
      409,
    );
    await f.request(
      "/api/slack/schedule",
      "PUT",
      { kind: "digest", enabled: true, hourUtc: 9, delivery: "automatic" },
      f.member.cookie,
    );
    const nextAt = Number(
      f.store.db.prepare("SELECT next_at FROM slack_schedules").get()!.next_at,
    );
    f.advance(nextAt - f.time());
    await f.worker.tick();
    const sent = f.calls.filter((call) => call.method === "chat.postMessage");
    assert.equal(sent.length, 1);
    assert.ok(!sent[0].body.text.includes("Private interview"));
    // Missed days coalesce into one run, never a backlog of messages.
    f.advance(4 * 86_400_000);
    await f.worker.tick();
    assert.equal(
      f.calls.filter((call) => call.method === "chat.postMessage").length,
      2,
    );
  } finally {
    await f.close();
  }
});

test("Slack retries rate limits at most three sends and expires link codes", async () => {
  const f = await fixture();
  try {
    await f.connect();
    const result = await (
      await f.request("/api/slack/link", "POST", {})
    ).json();
    f.advance(301_000);
    assert.match(
      (await (await f.command(result.command.replace("/arkoffer ", ""))).json())
        .text,
      /invalid or expired/,
    );
    await f.link();
    f.setProvider(async (method) =>
      method === "conversations.open"
        ? Response.json({ ok: true, channel: { id: "DPRIVATE" } })
        : new Response("limited", {
            status: 429,
            headers: { "Retry-After": "2" },
          }),
    );
    await f.command("ask limited");
    for (let i = 0; i < 5; i++) {
      await f.worker.tick();
      f.advance(2100);
    }
    assert.equal(
      f.calls.filter((call) => call.method === "chat.postMessage").length,
      3,
    );
    assert.equal(
      f.store.db.prepare("SELECT status FROM slack_jobs").get()!.status,
      "failed",
    );
  } finally {
    await f.close();
  }
});

test("Slack revalidates local reminders after DM opening and excludes archived or cancelled interviews", async () => {
  for (const change of ["archive", "reschedule", "rename"] as const) {
    const f = await fixture();
    try {
      await f.connect();
      await f.link();
      const interview = f.conversation();
      const archived = f.conversation(f.owner, "Archived title");
      const cancelled = f.conversation(f.owner, "Cancelled title");
      f.store.update(f.owner.workspaceId, "conversations", {
        ...archived,
        archived: true,
      });
      f.store.update(f.owner.workspaceId, "conversations", {
        ...cancelled,
        status: "cancelled",
      });
      await f.request("/api/slack/drafts", "POST", { kind: "reminder" });
      await f.worker.tick();
      const draft = (await (await f.request("/api/slack")).json()).jobs[0];
      assert.match(draft.body, /Private interview/);
      assert.ok(!draft.body.includes("Archived title"));
      assert.ok(!draft.body.includes("Cancelled title"));
      await f.request(`/api/slack/jobs/${draft.id}/approve`, "POST", {
        revision: draft.revision,
      });
      f.setProvider(async (method) => {
        assert.equal(method, "conversations.open");
        f.store.update(f.owner.workspaceId, "conversations", {
          ...interview,
          ...(change === "archive"
            ? { archived: true }
            : change === "rename"
              ? { title: "Changed interview title" }
              : { date: new Date(f.time() + 3 * 86400000).toISOString() }),
        });
        return Response.json({ ok: true, channel: { id: "DPRIVATE" } });
      });
      await f.worker.tick();
      assert.equal(
        f.calls.filter((call) => call.method === "chat.postMessage").length,
        0,
      );
      assert.equal(
        f.store.db.prepare("SELECT status FROM slack_jobs").get()!.status,
        "cancelled",
      );
    } finally {
      await f.close();
    }
  }
});
