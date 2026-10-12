import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { createDatabase } from "../../server/db.js";
import { hashToken } from "../../server/auth.js";
import { initializeAccess, mayReadConversation } from "../../server/access.js";
import { registerCalendar } from "../../server/calendar.js";

const ORIGIN = "http://localhost:5174";
const GOOGLE = "https://oauth2.googleapis.com/token";
const MS = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const googleEvent = (extra = {}) => ({
  id: "event-one",
  summary: "Interview",
  status: "confirmed",
  start: { dateTime: "2030-01-02T18:00:00+08:00" },
  end: { dateTime: "2030-01-02T11:00:00Z" },
  hangoutLink: "https://meet.google.com/example",
  ...extra,
});
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function fixture(overrides: NodeJS.ProcessEnv = {}) {
  const directory = mkdtempSync(join(tmpdir(), "arkoffer-calendar-")),
    store = createDatabase(directory);
  initializeAccess(store);
  const env: NodeJS.ProcessEnv = {
    APP_ORIGIN: ORIGIN,
    CALENDAR_TOKEN_ENCRYPTION_KEY: "a".repeat(64),
    GOOGLE_CALENDAR_CLIENT_ID: "google-test-client",
    GOOGLE_CALENDAR_CLIENT_SECRET: "google-test-secret",
    MICROSOFT_CALENDAR_CLIENT_ID: "ms-test-client",
    MICROSOFT_CALENDAR_CLIENT_SECRET: "ms-test-secret",
    ...overrides,
  };
  let time = Date.parse("2030-01-01T00:00:00Z");
  const calls: { url: string; init: RequestInit }[] = [];
  let handle: (
    url: string,
    init: RequestInit,
  ) => Promise<Response> | Response = (url) => {
    throw new Error(`Unexpected provider request ${url}`);
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
  registerCalendar(app, store, {
    env,
    now: () => time,
    fetch: (async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return handle(String(url), init);
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
  function user(workspaceId = randomUUID()) {
    const id = randomUUID(),
      token = randomBytes(32).toString("hex"),
      date = new Date().toISOString();
    store.db
      .prepare(
        "INSERT OR IGNORE INTO workspaces(id,name,created_at) VALUES(?,?,?)",
      )
      .run(workspaceId, "Calendar team", date);
    store.db
      .prepare(
        "INSERT INTO users(id,workspace_id,name,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        id,
        workspaceId,
        "Example",
        `${id}@example.com`,
        "unused",
        "member",
        date,
      );
    store.db
      .prepare(
        "INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)",
      )
      .run(hashToken(token), id, Date.now() + 3600000, date);
    return {
      id,
      workspaceId,
      cookie: `arkoffer_session=${token}`,
      name: "Example",
      email: `${id}@example.com`,
      workspaceName: "Calendar team",
      role: "member",
    };
  }
  const owner = user(),
    other = user(),
    teammate = user(owner.workspaceId);
  async function request(path: string, method = "GET", cookie = owner.cookie) {
    return fetch(base + path, {
      method,
      headers: { Cookie: cookie, Origin: ORIGIN },
      redirect: "manual",
    });
  }
  async function start(provider = "google", cookie = owner.cookie) {
    const response = await request(
      `/api/calendar/${provider}/connect`,
      "POST",
      cookie,
    );
    assert.equal(
      response.status,
      200,
      JSON.stringify(await response.clone().json()),
    );
    return new URL((await response.json()).url);
  }
  async function connect(provider = "google") {
    const auth = await start(provider);
    handle = (url, init) => {
      if ([GOOGLE, MS].includes(url)) {
        assert.equal(init.method, "POST");
        assert.equal(init.redirect, "error");
        assert.ok(init.signal);
        const body = init.body as URLSearchParams;
        assert.equal(body.get("grant_type"), "authorization_code");
        const challenge = createHash("sha256")
          .update(body.get("code_verifier")!)
          .digest("base64url");
        assert.equal(challenge, auth.searchParams.get("code_challenge"));
        assert.equal(
          body.get("redirect_uri"),
          `${ORIGIN}/api/calendar/${provider}/callback`,
        );
        return json({
          access_token: "private-access-token",
          refresh_token: "private-refresh-token",
          expires_in: 3600,
        });
      }
      if (url === "https://www.googleapis.com/calendar/v3/calendars/primary")
        return json({ id: "calendar@example.com", summary: "Work calendar" });
      if (
        url ===
        "https://graph.microsoft.com/v1.0/me/calendar?$select=id,name,owner"
      )
        return json({
          id: "primary",
          name: "Work",
          owner: { address: "example@example.com" },
        });
      throw new Error(`Unexpected ${url}`);
    };
    const response = await request(
      `/api/calendar/${provider}/callback?state=${auth.searchParams.get("state")}&code=temporary-code`,
    );
    assert.equal(
      response.status,
      302,
      JSON.stringify(await response.clone().text()),
    );
    assert.equal(
      response.headers.get("location"),
      `${ORIGIN}/app/settings?tab=integrations&calendar=connected`,
    );
    return auth;
  }
  return {
    store,
    env,
    owner,
    other,
    teammate,
    calls,
    request,
    start,
    connect,
    setHandler(fn: typeof handle) {
      handle = fn;
    },
    advance(ms: number) {
      time += ms;
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("calendar setup is explicit, exact-origin-only and never exposes credentials", async () => {
  const f = await fixture({
    CALENDAR_TOKEN_ENCRYPTION_KEY: "bad",
    CALENDAR_APP_ORIGIN: "https://evil.example",
  });
  try {
    const response = await f.request("/api/calendar"),
      body = await response.json();
    assert.equal(body.items[0].configured, false);
    assert.equal(body.items[0].connected, false);
    assert.match(
      body.items[0].missing.join(" "),
      /CALENDAR_TOKEN_ENCRYPTION_KEY.*CALENDAR_APP_ORIGIN/,
    );
    assert.equal(body.items[0].redirectUri, null);
    assert.doesNotMatch(
      JSON.stringify(body),
      /google-test-secret|ms-test-secret/,
    );
    assert.equal(
      (await f.request("/api/calendar/google/connect", "POST")).status,
      503,
    );
    assert.equal(
      (await f.request("/api/calendar/google/sync", "POST")).status,
      503,
    );
    assert.equal((await f.request("/api/calendar", "GET", "")).status, 401);
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});

test("OAuth state is single-use, session-bound, expiring and PKCE-bound", async () => {
  const f = await fixture();
  try {
    const auth = await f.start();
    const state = auth.searchParams.get("state")!;
    assert.equal(auth.origin, "https://accounts.google.com");
    assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
    assert.equal(
      auth.searchParams.get("scope"),
      "https://www.googleapis.com/auth/calendar.readonly",
    );
    const row = f.store.db
      .prepare("SELECT * FROM calendar_oauth_states")
      .get()!;
    assert.notEqual(row.state_hash, state);
    assert.doesNotMatch(String(row.verifier), /^[A-Za-z0-9_-]{64}$/);
    const path = `/api/calendar/google/callback?state=${state}&code=unused`;
    assert.equal((await f.request(path, "GET", f.other.cookie)).status, 400);
    assert.equal((await f.request(path, "GET", f.teammate.cookie)).status, 400);
    const session = randomBytes(32).toString("hex");
    f.store.db
      .prepare(
        "INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)",
      )
      .run(
        hashToken(session),
        f.owner.id,
        Date.now() + 3600000,
        new Date().toISOString(),
      );
    assert.equal(
      (await f.request(path, "GET", `arkoffer_session=${session}`)).status,
      400,
    );
    f.advance(600001);
    assert.equal((await f.request(path)).status, 400);
    assert.equal(f.calls.length, 0);
    const connected = await f.connect();
    assert.equal(
      (
        await f.request(
          `/api/calendar/google/callback?state=${connected.searchParams.get("state")}&code=replay`,
        )
      ).status,
      400,
    );
    const saved = f.store.db
      .prepare("SELECT tokens FROM calendar_connections")
      .get()!;
    assert.doesNotMatch(
      String(saved.tokens),
      /private-access-token|private-refresh-token/,
    );
  } finally {
    await f.close();
  }
});

test("Google calendar sync is idempotent, scoped, updates scheduling, preserves human work and handles cancellation", async () => {
  const f = await fixture();
  try {
    await f.connect();
    let event = googleEvent();
    f.setHandler((url) => {
      const parsed = new URL(url);
      assert.equal(parsed.origin, "https://www.googleapis.com");
      assert.equal(parsed.searchParams.get("showDeleted"), "true");
      assert.equal(parsed.searchParams.get("singleEvents"), "true");
      return json({ items: [event] });
    });
    const first = await f.request("/api/calendar/google/sync", "POST");
    assert.equal(first.status, 200);
    assert.equal((await first.json()).created, 1);
    let notes = f.store.list(f.owner.workspaceId, "conversations");
    assert.equal(notes.length, 1);
    const id = notes[0].id;
    assert.equal(mayReadConversation(f.store, f.teammate, id), false);
    assert.equal(
      (await f.request("/api/calendar/google/sync", "POST", f.teammate.cookie))
        .status,
      409,
    );
    assert.equal(
      (await f.request("/api/calendar", "GET", f.other.cookie)).status,
      200,
    );
    assert.equal(
      (
        await (
          await f.request("/api/calendar", "GET", f.teammate.cookie)
        ).json()
      ).items[0].connected,
      false,
    );
    f.store.update(f.owner.workspaceId, "conversations", {
      ...notes[0],
      title: "My edited title",
      transcript: "Human transcript",
      sections: [{ id: "section", title: "Summary", content: "Human notes" }],
      updatedAt: new Date().toISOString(),
    });
    event = googleEvent({
      summary: "Provider rename",
      start: { dateTime: "2030-01-03T10:00:00Z" },
    });
    const next = await f.request("/api/calendar/google/sync", "POST");
    assert.equal((await next.json()).created, 0);
    notes = f.store.list(f.owner.workspaceId, "conversations");
    assert.equal(notes.length, 1);
    assert.equal(notes[0].id, id);
    assert.equal(notes[0].title, "My edited title");
    assert.equal(notes[0].transcript, "Human transcript");
    assert.equal(notes[0].date, "2030-01-03T10:00:00.000Z");
    assert.deepEqual(notes[0].sections, [
      { id: "section", title: "Summary", content: "Human notes" },
    ]);
    event = googleEvent({
      status: "cancelled",
      start: undefined,
      end: undefined,
    });
    const cancelled = await f.request("/api/calendar/google/sync", "POST");
    assert.equal((await cancelled.json()).cancelled, 1);
    assert.equal(
      f.store.get(f.owner.workspaceId, "conversations", id)?.archived,
      true,
    );
    assert.equal(
      f.store.get(f.owner.workspaceId, "conversations", id)?.transcript,
      "Human transcript",
    );
    assert.equal(
      (await f.request("/api/calendar/google", "DELETE", f.other.cookie))
        .status,
      200,
    );
    assert.equal(
      (await (await f.request("/api/calendar")).json()).items[0].connected,
      true,
    );
    assert.equal(
      (await f.request("/api/calendar/google", "DELETE")).status,
      200,
    );
    assert.equal(
      (await (await f.request("/api/calendar")).json()).items[0].connected,
      false,
    );
    assert.equal(f.store.list(f.owner.workspaceId, "conversations").length, 1);
  } finally {
    await f.close();
  }
});

test("deleted imported conversations are not recreated and refresh-token rotation stays encrypted", async () => {
  const f = await fixture();
  try {
    await f.connect();
    f.setHandler(() => json({ items: [googleEvent()] }));
    await f.request("/api/calendar/google/sync", "POST");
    const note = f.store.list(f.owner.workspaceId, "conversations")[0];
    f.store.db.prepare("DELETE FROM resources WHERE id=?").run(note.id);
    f.advance(3600000);
    let refreshed = false;
    f.setHandler((url, init) => {
      if (url === GOOGLE) {
        refreshed = true;
        const body = init.body as URLSearchParams;
        assert.equal(body.get("grant_type"), "refresh_token");
        assert.equal(body.get("refresh_token"), "private-refresh-token");
        return json({
          access_token: "new-access",
          refresh_token: "rotated-refresh",
          expires_in: 3600,
        });
      }
      assert.equal(
        (init.headers as Record<string, string>).Authorization,
        "Bearer new-access",
      );
      return json({ items: [googleEvent()] });
    });
    assert.equal(
      (await f.request("/api/calendar/google/sync", "POST")).status,
      200,
    );
    assert.equal(refreshed, true);
    assert.equal(f.store.list(f.owner.workspaceId, "conversations").length, 0);
    const tokens = f.store.db
      .prepare("SELECT tokens FROM calendar_connections")
      .get()!.tokens;
    assert.doesNotMatch(String(tokens), /new-access|rotated-refresh/);
  } finally {
    await f.close();
  }
});

test("Microsoft calendar pagination stays on Graph and cancellation updates existing records", async () => {
  const f = await fixture();
  try {
    await f.connect("microsoft");
    let page = 0;
    f.setHandler((url, init) => {
      assert.equal(new URL(url).origin, "https://graph.microsoft.com");
      assert.match(
        (init.headers as Record<string, string>).Prefer,
        /ImmutableId/,
      );
      page++;
      return json(
        page === 1
          ? {
              value: [
                {
                  id: "ms-1",
                  subject: "Engineering interview",
                  start: {
                    dateTime: "2030-01-04T10:00:00.0000000",
                    timeZone: "UTC",
                  },
                  end: { dateTime: "2030-01-04T11:00:00.0000000" },
                  onlineMeeting: {
                    joinUrl: "https://teams.microsoft.com/meeting",
                  },
                },
              ],
              "@odata.nextLink":
                "https://graph.microsoft.com/v1.0/me/calendarView?$skiptoken=next",
            }
          : { value: [] },
      );
    });
    const synced = await f.request("/api/calendar/microsoft/sync", "POST");
    assert.equal(synced.status, 200);
    assert.equal(page, 2);
    const note = f.store.list(f.owner.workspaceId, "conversations")[0];
    assert.equal(note.date, "2030-01-04T10:00:00.000Z");
    f.setHandler(() => json({ value: [{ id: "ms-1", isCancelled: true }] }));
    const cancelled = await f.request("/api/calendar/microsoft/sync", "POST");
    assert.equal((await cancelled.json()).cancelled, 1);
    assert.equal(
      f.store.get(f.owner.workspaceId, "conversations", note.id)?.archived,
      true,
    );
  } finally {
    await f.close();
  }
});

test("provider failures and hostile pagination never cause partial imports or leak provider secrets", async () => {
  const f = await fixture();
  try {
    await f.connect("microsoft");
    const before = f.calls.length;
    f.setHandler(() =>
      json({
        value: [],
        "@odata.nextLink": "https://attacker.example/collect",
      }),
    );
    const unsafe = await f.request("/api/calendar/microsoft/sync", "POST");
    assert.equal(unsafe.status, 502);
    assert.equal(f.calls.length, before + 1);
    assert.equal(f.store.list(f.owner.workspaceId, "conversations").length, 0);
    f.setHandler(() =>
      json({ error: "secret-token provider stacktrace" }, 401),
    );
    const failed = await f.request("/api/calendar/microsoft/sync", "POST");
    assert.equal(failed.status, 502);
    assert.doesNotMatch(await failed.text(), /secret-token/);
    const status = await (await f.request("/api/calendar")).json();
    assert.match(status.items[1].lastError, /Reconnect/);
  } finally {
    await f.close();
  }
});

test("disconnect during a sync prevents the in-flight response from importing data", async () => {
  const f = await fixture();
  try {
    await f.connect();
    let release!: () => void, started!: () => void;
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.setHandler(async () => {
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return json({ items: [googleEvent()] });
    });
    const pending = f.request("/api/calendar/google/sync", "POST");
    await waiting;
    assert.equal(
      (await f.request("/api/calendar/google", "DELETE")).status,
      200,
    );
    release();
    assert.equal((await pending).status, 409);
    assert.equal(f.store.list(f.owner.workspaceId, "conversations").length, 0);
  } finally {
    await f.close();
  }
});

test("one person can connect and import the same calendar independently in two workspaces", async () => {
  const f = await fixture();
  try {
    await f.connect();
    f.setHandler(() => json({ items: [googleEvent()] }));
    assert.equal(
      (await f.request("/api/calendar/google/sync", "POST")).status,
      200,
    );
    const date = new Date().toISOString();
    f.store.db
      .prepare(
        "INSERT INTO memberships(workspace_id,user_id,role,created_at,updated_at) VALUES(?,?,'member',?,?)",
      )
      .run(f.other.workspaceId, f.owner.id, date, date);
    f.store.db
      .prepare("UPDATE sessions SET workspace_id=? WHERE user_id=?")
      .run(f.other.workspaceId, f.owner.id);
    assert.equal(
      (await (await f.request("/api/calendar")).json()).items[0].connected,
      false,
    );
    await f.connect();
    f.setHandler(() => json({ items: [googleEvent()] }));
    assert.equal(
      (await f.request("/api/calendar/google/sync", "POST")).status,
      200,
    );
    assert.equal(f.store.list(f.owner.workspaceId, "conversations").length, 1);
    assert.equal(f.store.list(f.other.workspaceId, "conversations").length, 1);
    assert.equal(
      f.store.db
        .prepare(
          "SELECT COUNT(*) AS n FROM calendar_connections WHERE user_id=?",
        )
        .get(f.owner.id)!.n,
      2,
    );
    assert.equal(
      (await f.request("/api/calendar/google", "DELETE")).status,
      200,
    );
    f.store.db
      .prepare("UPDATE sessions SET workspace_id=? WHERE user_id=?")
      .run(f.owner.workspaceId, f.owner.id);
    assert.equal(
      (await (await f.request("/api/calendar")).json()).items[0].connected,
      true,
    );
  } finally {
    await f.close();
  }
});

test("calendar schema upgrade preserves existing encrypted connections and imports", async () => {
  const f = await fixture();
  try {
    await f.connect();
    f.setHandler(() => json({ items: [googleEvent()] }));
    await f.request("/api/calendar/google/sync", "POST");
    const before = f.store.db
      .prepare("SELECT * FROM calendar_connections")
      .get();
    for (const table of ["calendar_connections", "calendar_imports"]) {
      const sql = String(
        f.store.db
          .prepare("SELECT sql FROM sqlite_master WHERE name=?")
          .get(table)!.sql,
      )
        .replace(
          "UNIQUE(user_id, workspace_id, provider)",
          "UNIQUE(user_id, provider)",
        )
        .replace(
          "PRIMARY KEY(user_id, workspace_id, provider, account_key, event_id)",
          "PRIMARY KEY(user_id, provider, account_key, event_id)",
        );
      f.store.transaction(() => {
        f.store.db.exec(`ALTER TABLE ${table} RENAME TO ${table}_test_old`);
        f.store.db.exec(sql);
        f.store.db.exec(
          `INSERT INTO ${table} SELECT * FROM ${table}_test_old; DROP TABLE ${table}_test_old`,
        );
      });
    }
    registerCalendar(express(), f.store, { env: f.env });
    assert.deepEqual(
      f.store.db.prepare("SELECT * FROM calendar_connections").get(),
      before,
    );
    const sql = String(
      f.store.db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE name='calendar_connections'",
        )
        .get()!.sql,
    );
    assert.match(sql, /UNIQUE\(user_id, workspace_id, provider\)/);
    assert.equal(
      f.store.db.prepare("SELECT COUNT(*) AS n FROM calendar_imports").get()!.n,
      1,
    );
  } finally {
    await f.close();
  }
});
