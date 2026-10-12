import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { createDatabase } from "../../server/db.js";
import { hashToken } from "../../server/auth.js";
import { initializeAccess, mayReadConversation } from "../../server/access.js";
import { registerProviders } from "../../server/providers.js";

const ORIGIN = "http://localhost:5174",
  BOT = "6b4b8b2c-e3c7-4d8f-b8a2-5094d39eeeb3",
  RECORDING = "4e1bb3c2-4dc5-4201-9a3e-338bff732916",
  NOW = Date.parse("2030-01-01T00:00:00Z");
const response = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "arkoffer-providers-")),
    store = createDatabase(directory);
  initializeAccess(store);
  function identity(workspaceId = randomUUID(), role = "owner") {
    const id = randomUUID(),
      token = randomBytes(32).toString("hex"),
      date = new Date().toISOString();
    store.db
      .prepare(
        "INSERT OR IGNORE INTO workspaces(id,name,created_at) VALUES(?,?,?)",
      )
      .run(workspaceId, "Provider workspace", date);
    store.db
      .prepare(
        "INSERT INTO users(id,workspace_id,name,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        id,
        workspaceId,
        "Test user",
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
    return {
      id,
      workspaceId,
      name: "Test user",
      email: `${id}@example.com`,
      workspaceName: "Provider workspace",
      role,
      cookie: `arkoffer_session=${token}`,
    };
  }
  const owner = identity(),
    other = identity(),
    member = identity(owner.workspaceId, "member");
  const env: NodeJS.ProcessEnv = {
    PROVIDER_WORKSPACE_IDS: owner.workspaceId,
    GREENHOUSE_CLIENT_ID: "test-client",
    GREENHOUSE_CLIENT_SECRET: "private-secret",
    RECALL_API_KEY: "private-recall-key",
    RECALL_REGION: "us-east-1",
  };
  const calls: { url: string; init: RequestInit }[] = [];
  let handler: (
    url: string,
    init: RequestInit,
  ) => Promise<Response> | Response = () => {
    throw new Error("Unexpected provider request");
  };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (!["GET", "HEAD"].includes(req.method) && req.get("origin") !== ORIGIN) {
      res.status(403).json({ error: "Origin denied" });
      return;
    }
    next();
  });
  registerProviders(app, store, {
    env,
    now: () => NOW,
    fetch: (async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return handler(String(url), init);
    }) as typeof fetch,
  });
  app.use(
    (
      error: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => res.status(500).json({ error: error.message }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  async function request(
    path: string,
    method = "GET",
    body?: unknown,
    cookie = owner.cookie,
  ) {
    return fetch(base + path, {
      method,
      headers: {
        Cookie: cookie,
        Origin: ORIGIN,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  const creation = () => ({
    title: "Interview recording",
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    consent: true,
    requestKey: randomUUID(),
  });
  async function create(
    input: ReturnType<typeof creation> & { joinAt?: string } = creation(),
  ) {
    handler = (_url, init) => {
      assert.equal(init.method, "POST");
      const sent = JSON.parse(String(init.body));
      assert.equal(
        sent.recording_config.transcript.provider.recallai_streaming.mode,
        "prioritize_accuracy",
      );
      assert.match(sent.chat.on_bot_join.message, /recording/);
      assert.equal(sent.bot_name, "ArkOffer Notetaker");
      return response(
        { id: BOT, status_changes: [{ code: "ready" }], recordings: [] },
        201,
      );
    };
    const result = await request("/api/captures", "POST", input);
    assert.equal(result.status, 201, await result.clone().text());
    return (await result.json()).item;
  }
  return {
    store,
    env,
    owner,
    other,
    member,
    calls,
    request,
    creation,
    create,
    setHandler(fn: typeof handler) {
      handler = fn;
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
function bot(
  downloadUrl = "https://recall-test-bucket.s3.us-east-1.amazonaws.com/transcript.json?signature=fake",
) {
  return {
    id: BOT,
    status_changes: [{ code: "done" }],
    recordings: [
      {
        id: RECORDING,
        media_shortcuts: {
          transcript: {
            status: { code: "done" },
            data: { download_url: downloadUrl },
          },
        },
      },
    ],
  };
}

test("operator provider credentials are never exposed and live calls require workspace allowlist plus admin role", async () => {
  const f = await fixture();
  try {
    const status = await (await f.request("/api/providers")).json();
    assert.equal(status.items[0].configured, true);
    assert.doesNotMatch(
      JSON.stringify(status),
      /private-secret|private-recall-key/,
    );
    assert.equal(
      (
        await f.request(
          "/api/providers/greenhouse/sync",
          "POST",
          {},
          f.member.cookie,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await f.request(
          "/api/providers/greenhouse/sync",
          "POST",
          {},
          f.other.cookie,
        )
      ).status,
      403,
    );
    assert.equal(
      (await f.request("/api/captures", "POST", f.creation(), f.other.cookie))
        .status,
      403,
    );
    assert.equal(
      (await f.request("/api/captures", "POST", f.creation(), f.member.cookie))
        .status,
      403,
    );
    assert.equal(f.calls.length, 0);
    f.env.RECALL_REGION = "127.0.0.1";
    assert.equal(
      (await f.request("/api/captures", "POST", f.creation())).status,
      503,
    );
  } finally {
    await f.close();
  }
});

test("Greenhouse v3 imports read-only source snapshots, preserves manual decisions and deduplicates repeated sync", async () => {
  const f = await fixture();
  try {
    let candidateName = "Ada";
    f.setHandler((url, init) => {
      if (url === "https://auth.greenhouse.io/token") {
        assert.equal(init.method, "POST");
        assert.equal(String(init.body), "grant_type=client_credentials");
        return response({ access_token: "ephemeral-token" });
      }
      assert.equal(init.method, undefined);
      assert.equal(
        (init.headers as Record<string, string>).Authorization,
        "Bearer ephemeral-token",
      );
      const path = new URL(url).pathname;
      if (path.endsWith("/jobs"))
        return response([
          { id: 10, name: "Engineer", status: "open", confidential: false },
          {
            id: 11,
            name: "Confidential executive role",
            status: "open",
            confidential: true,
          },
        ]);
      if (path.endsWith("/candidates"))
        return response([
          {
            id: 20,
            first_name: candidateName,
            last_name: "Example",
            email_addresses: [{ value: "ada@example.com" }],
            title: "Developer",
            private: false,
          },
          { id: 21, first_name: "Hidden", private: true },
        ]);
      if (path.endsWith("/applications"))
        return response([
          {
            id: 30,
            candidate_id: 20,
            job_id: 10,
            status: "active",
            stage_name: "Interview",
          },
          { id: 31, candidate_id: 21, job_id: 10 },
          {
            id: 32,
            candidate_id: 20,
            job_id: 11,
            stage_name: "Confidential executive final",
          },
          {
            id: 33,
            candidate_id: 20,
            job_id: 999,
            stage_name: "Missing role final",
          },
          { id: 34, candidate_id: 20, job_id: null, prospect: true },
        ]);
      throw new Error("Unexpected endpoint");
    });
    const first = await f.request("/api/providers/greenhouse/sync", "POST", {});
    assert.equal(first.status, 200);
    assert.equal((await first.json()).counts.candidates, 1);
    let candidate = f.store.list(f.owner.workspaceId, "candidates")[0];
    const application = f.store.list(f.owner.workspaceId, "applications")[0];
    assert.equal(application.status, "applied");
    assert.equal((application.ats as any).stage, "Interview");
    assert.equal((application.ats as any).externalId, "30");
    assert.equal(f.store.list(f.owner.workspaceId, "applications").length, 1);
    assert.equal(f.store.list(f.owner.workspaceId, "jobs").length, 1);
    assert.ok(
      !JSON.stringify(
        f.store.list(f.owner.workspaceId, "applications"),
      ).includes("Confidential executive"),
    );
    f.store.update(f.owner.workspaceId, "candidates", {
      ...candidate,
      name: "Manual name",
      status: "yes",
      updatedAt: new Date().toISOString(),
    });
    candidateName = "Provider rename";
    assert.equal(
      (await f.request("/api/providers/greenhouse/sync", "POST", {})).status,
      200,
    );
    candidate = f.store.list(f.owner.workspaceId, "candidates")[0];
    assert.equal(candidate.name, "Manual name");
    assert.equal(candidate.status, "yes");
    assert.equal((candidate.ats as any).name, "Provider rename Example");
    assert.equal(f.store.list(f.owner.workspaceId, "applications").length, 1);
    assert.equal(f.store.list(f.other.workspaceId, "candidates").length, 0);
    f.store.db.prepare("DELETE FROM resources WHERE id=?").run(candidate.id);
    assert.equal(
      (await f.request("/api/providers/greenhouse/sync", "POST", {})).status,
      200,
    );
    assert.equal(f.store.list(f.owner.workspaceId, "candidates").length, 0);
  } finally {
    await f.close();
  }
});

test("Greenhouse pagination rejects foreign endpoints before sending tokens and does not import partial data", async () => {
  const f = await fixture();
  try {
    f.setHandler((url) =>
      url === "https://auth.greenhouse.io/token"
        ? response({ access_token: "secret-token" })
        : response([{ id: 1, name: "Partial" }], 200, {
            Link: '<https://attacker.example/collect>; rel="next"',
          }),
    );
    const result = await f.request(
      "/api/providers/greenhouse/sync",
      "POST",
      {},
    );
    assert.equal(result.status, 502);
    assert.equal(f.calls.length, 2);
    assert.equal(f.store.list(f.owner.workspaceId, "jobs").length, 0);
    assert.doesNotMatch(await result.text(), /secret-token/);
  } finally {
    await f.close();
  }
});

test("meeting capture validates consent, meeting platform, schedule and strict input before any provider request", async () => {
  const f = await fixture();
  try {
    for (const input of [
      { ...f.creation(), consent: false },
      { ...f.creation(), meetingUrl: "https://127.0.0.1/private" },
      {
        ...f.creation(),
        meetingUrl: "https://meet.google.com.attacker.example/abc-defg-hij",
      },
      {
        ...f.creation(),
        meetingUrl: "https://user@meet.google.com/abc-defg-hij",
      },
      { ...f.creation(), joinAt: "2030-01-01T00:05:00Z" },
      { ...f.creation(), apiKey: "attacker" },
    ]) {
      assert.equal(
        (await f.request("/api/captures", "POST", input)).status,
        400,
      );
    }
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});

test("capture creation has durable idempotency and cross-workspace isolation", async () => {
  const f = await fixture();
  try {
    const input = f.creation(),
      created = await f.create(input);
    const before = f.calls.length;
    const same = await f.request("/api/captures", "POST", input);
    assert.equal(same.status, 200);
    assert.equal((await same.json()).item.id, created.id);
    assert.equal(f.calls.length, before);
    assert.equal(
      (
        await f.request("/api/captures", "POST", {
          ...input,
          title: "Tampered",
        })
      ).status,
      409,
    );
    assert.equal(
      (await f.request("/api/captures", "POST", f.creation())).status,
      409,
    );
    f.env.PROVIDER_WORKSPACE_IDS += `,${f.other.workspaceId}`;
    assert.equal(
      (
        await f.request(
          `/api/captures/${created.id}/refresh`,
          "POST",
          {},
          f.other.cookie,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await (
          await f.request("/api/captures", "GET", undefined, f.other.cookie)
        ).json()
      ).items.length,
      0,
    );
    assert.equal(f.calls.length, before);
  } finally {
    await f.close();
  }
});

test("confirmed transcript import creates a private conversation once, retains manual edits and honors deletion", async () => {
  const f = await fixture();
  try {
    const created = await f.create();
    f.setHandler((url, init) => {
      if (url.endsWith(`/bot/${BOT}/`)) return response(bot());
      assert.match(url, /\.s3\.us-east-1\.amazonaws\.com/);
      assert.equal(init.headers, undefined);
      assert.equal(init.redirect, "error");
      return response([
        {
          participant: { name: "Candidate" },
          words: [{ text: "I built a product." }],
        },
      ]);
    });
    const refreshed = await f.request(
      `/api/captures/${created.id}/refresh`,
      "POST",
      {},
    );
    assert.equal((await refreshed.json()).item.transcriptReady, true);
    const imported = await f.request(
      `/api/captures/${created.id}/import`,
      "POST",
      {},
    );
    assert.equal(imported.status, 201);
    const item = (await imported.json()).item;
    assert.equal(item.transcript, "Candidate: I built a product.");
    assert.equal(mayReadConversation(f.store, f.member, item.id), false);
    f.store.update(f.owner.workspaceId, "conversations", {
      ...item,
      transcript: "Human edited transcript",
      updatedAt: new Date().toISOString(),
    });
    const before = f.calls.length;
    const again = await f.request(
      `/api/captures/${created.id}/import`,
      "POST",
      {},
    );
    assert.equal(
      (await again.json()).item.transcript,
      "Human edited transcript",
    );
    assert.equal(f.calls.length, before);
    f.store.db.prepare("DELETE FROM resources WHERE id=?").run(item.id);
    assert.equal(
      (await f.request(`/api/captures/${created.id}/import`, "POST", {}))
        .status,
      409,
    );
    assert.equal(f.store.list(f.owner.workspaceId, "conversations").length, 0);
  } finally {
    await f.close();
  }
});

test("transcript download rejects private hosts and never labels unfinished transcripts as ready", async () => {
  const f = await fixture();
  try {
    const created = await f.create();
    f.setHandler(() =>
      response({
        id: BOT,
        status_changes: [{ code: "in_call_recording" }],
        recordings: [],
      }),
    );
    assert.equal(
      (await f.request(`/api/captures/${created.id}/import`, "POST", {}))
        .status,
      409,
    );
    assert.equal(
      (await (await f.request("/api/captures")).json()).items[0]
        .transcriptReady,
      false,
    );
    f.setHandler(() =>
      response(bot("https://169.254.169.254/latest/meta-data/")),
    );
    const before = f.calls.length;
    assert.equal(
      (await f.request(`/api/captures/${created.id}/import`, "POST", {}))
        .status,
      502,
    );
    assert.equal(f.calls.length, before + 1);
    assert.equal(f.store.list(f.owner.workspaceId, "conversations").length, 0);
  } finally {
    await f.close();
  }
});

test("ambiguous create failures are durable and retries do not create duplicate paid bots", async () => {
  const f = await fixture();
  try {
    const input = f.creation();
    f.setHandler(() => {
      throw new Error("network timeout with private-recall-key");
    });
    const first = await f.request("/api/captures", "POST", input);
    assert.equal(first.status, 502);
    assert.doesNotMatch(await first.text(), /private-recall-key/);
    const retry = await f.request("/api/captures", "POST", input);
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).item.status, "unknown");
    assert.equal(f.calls.length, 1);
  } finally {
    await f.close();
  }
});

test("scheduled cancellation and explicit leave requests call only the matching bot endpoints", async () => {
  const f = await fixture();
  try {
    const scheduled = await f.create({
      ...f.creation(),
      joinAt: "2030-01-01T01:00:00Z",
    });
    f.setHandler((url, init) => {
      assert.equal(url, `https://us-east-1.recall.ai/api/v1/bot/${BOT}/`);
      assert.equal(init.method, "DELETE");
      return response(null, 204);
    });
    const cancelled = await f.request(
      `/api/captures/${scheduled.id}`,
      "DELETE",
    );
    assert.equal((await cancelled.json()).item.status, "cancelled");
    const live = await f.create();
    f.setHandler((url, init) => {
      assert.equal(
        url,
        `https://us-east-1.recall.ai/api/v1/bot/${BOT}/leave_call/`,
      );
      assert.equal(init.method, "POST");
      return response({});
    });
    const leaving = await f.request(
      `/api/captures/${live.id}/leave`,
      "POST",
      {},
    );
    assert.equal((await leaving.json()).item.status, "leave_requested");
  } finally {
    await f.close();
  }
});

test("an uncertain capture can only recover the provider bot carrying its exact request metadata", async () => {
  const f = await fixture();
  try {
    const input = f.creation();
    f.setHandler(() => {
      throw new Error("Timeout");
    });
    await f.request("/api/captures", "POST", input);
    const item = (await (await f.request("/api/captures")).json()).items[0];
    f.setHandler(() =>
      response({
        ...bot(),
        metadata: { arkoffer_capture_id: "other-capture" },
      }),
    );
    assert.equal(
      (
        await f.request(`/api/captures/${item.id}/recover`, "POST", {
          botId: BOT,
        })
      ).status,
      409,
    );
    f.setHandler(() =>
      response({ ...bot(), metadata: { arkoffer_capture_id: item.id } }),
    );
    const recovered = await f.request(
      `/api/captures/${item.id}/recover`,
      "POST",
      { botId: BOT },
    );
    assert.equal(recovered.status, 200);
    assert.equal((await recovered.json()).item.status, "done");
  } finally {
    await f.close();
  }
});

test("a definitive provider rejection is marked failed rather than joined or an unknown success", async () => {
  const f = await fixture();
  try {
    f.setHandler(() => response({ error: "private provider payload" }, 400));
    const result = await f.request("/api/captures", "POST", f.creation());
    assert.equal(result.status, 502);
    assert.doesNotMatch(await result.text(), /private provider payload/);
    assert.equal(
      (await (await f.request("/api/captures")).json()).items[0].status,
      "failed",
    );
  } finally {
    await f.close();
  }
});
