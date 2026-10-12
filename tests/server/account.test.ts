import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { createApp } from "../../server/app.js";
import { createDatabase, type Store } from "../../server/db.js";
import { hashPassword, hashToken, verifyPassword } from "../../server/auth.js";
import type { MailConfig } from "../../server/mail.js";

const ORIGIN = "http://localhost:5174",
  PASSWORD = "Original account password";
type Message = { to: string[]; subject: string; text: string };
class Client {
  cookie = "";
  constructor(readonly base: string) {}
  request(path: string, method = "GET", body?: unknown) {
    return fetch(`${this.base}/api/${path}`, {
      method,
      headers: {
        Origin: ORIGIN,
        Cookie: this.cookie,
        "Content-Type": "application/json",
        "User-Agent": "Account test browser",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async login(email = "alice@example.com", password = PASSWORD) {
    const response = await this.request("auth/login", "POST", {
      email,
      password,
    });
    assert.equal(response.status, 200);
    this.cookie = response.headers.get("set-cookie")!.split(";")[0];
  }
}
async function fixture(
  run: (fixture: {
    store: Store;
    alice: Client;
    bob: Client;
    base: string;
    sent: Message[];
    failMail: () => void;
  }) => Promise<void>,
  mode: "resend" | "outbox" = "resend",
) {
  const directory = mkdtempSync(join(tmpdir(), "arkoffer-account-")),
    store = createDatabase(directory),
    hash = await hashPassword(PASSWORD);
  for (const name of ["alice", "bob"]) {
    store.db
      .prepare("INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)")
      .run(`${name}-workspace`, `${name}'s team`, new Date().toISOString());
    store.db
      .prepare(
        "INSERT INTO users (id, workspace_id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        name,
        `${name}-workspace`,
        name,
        `${name}@example.com`,
        hash,
        new Date().toISOString(),
      );
  }
  const mail: MailConfig = {
    mode,
    apiKey: "synthetic-test-key",
    from: "ArkOffer <no-reply@example.com>",
    replyTo: "",
    publicUrl: "https://arkoffer.example.com",
    workspaceIds: ["alice-workspace"],
  };
  const sent: Message[] = [];
  let failing = false;
  const fetcher = (async (_url: unknown, options: RequestInit) => {
    sent.push(JSON.parse(String(options.body)));
    return new Response(
      JSON.stringify(
        failing
          ? { message: "Provider unavailable" }
          : { id: "test-message-id" },
      ),
      {
        status: failing ? 500 : 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }) as typeof fetch;
  const app = createApp({
    store,
    appOrigin: ORIGIN,
    openAiApiKey: "",
    accountOptions: { mail, fetcher },
  });
  let server: Server;
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, "127.0.0.1", (e) => (e ? reject(e) : resolve()));
  });
  const address = server!.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`,
    alice = new Client(base),
    bob = new Client(base);
  try {
    await alice.login();
    await bob.login("bob@example.com");
    await run({
      store,
      alice,
      bob,
      base,
      sent,
      failMail: () => {
        failing = true;
      },
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server!.close((e) => (e ? reject(e) : resolve())),
    );
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
function messageToken(message: Message) {
  const token = message.text.match(/token=([a-f0-9]{64})/)?.[1];
  assert.ok(token);
  return token;
}

test("password changes verify the current password, rotate the session, preserve workspace selection and revoke other sessions", async () =>
  fixture(async ({ store, alice, base }) => {
    const second = new Client(base);
    await second.login();
    assert.equal(
      (
        await alice.request("account/password", "POST", {
          currentPassword: "wrong",
          password: "Changed account password",
        })
      ).status,
      400,
    );
    store.db
      .prepare(
        "INSERT INTO memberships (workspace_id,user_id,role,created_at,updated_at) VALUES ('bob-workspace','alice','member',?,?)",
      )
      .run(new Date().toISOString(), new Date().toISOString());
    assert.equal(
      (await alice.request("workspaces/bob-workspace/switch", "POST", {}))
        .status,
      200,
    );
    const previousCookie = alice.cookie;
    const result = await alice.request("account/password", "POST", {
      currentPassword: PASSWORD,
      password: "Changed account password",
    });
    assert.equal(result.status, 200);
    assert.equal((await result.json()).user.workspaceId, "bob-workspace");
    alice.cookie = result.headers.get("set-cookie")!.split(";")[0];
    assert.notEqual(alice.cookie, previousCookie);
    assert.equal(
      (await (await alice.request("auth/me")).json()).user.workspaceId,
      "bob-workspace",
    );
    assert.equal((await second.request("account/security")).status, 401);
    const old = new Client(base);
    old.cookie = previousCookie;
    assert.equal((await old.request("account/security")).status, 401);
    const stored = store.db
      .prepare("SELECT password_hash FROM users WHERE id = 'alice'")
      .get()!;
    assert.equal(
      await verifyPassword(
        "Changed account password",
        String(stored.password_hash),
      ),
      true,
    );
    assert.equal(
      await verifyPassword(PASSWORD, String(stored.password_hash)),
      false,
    );
  }));

test("session management exposes opaque device IDs and cannot inspect or revoke another user's sessions", async () =>
  fixture(async ({ alice, bob, base }) => {
    const second = new Client(base);
    await second.login();
    const security = await (await alice.request("account/security")).json();
    assert.equal(security.sessions.length, 2);
    assert.equal(
      security.sessions.filter((s: { current: boolean }) => s.current).length,
      1,
    );
    assert.ok(
      security.sessions.every(
        (s: { id: string; token_hash?: string }) =>
          s.id && s.token_hash === undefined,
      ),
    );
    const other = security.sessions.find(
      (s: { current: boolean }) => !s.current,
    );
    assert.equal(
      (await bob.request(`account/sessions/${other.id}`, "DELETE")).status,
      404,
    );
    assert.equal(
      (await alice.request(`account/sessions/${other.id}`, "DELETE")).status,
      200,
    );
    assert.equal((await second.request("account/security")).status, 401);
    await second.login();
    assert.equal(
      (await alice.request("account/sessions/others", "DELETE")).status,
      200,
    );
    assert.equal((await second.request("account/security")).status, 401);
    assert.equal((await alice.request("account/security")).status, 200);
  }));

test("password recovery stays generic, never returns token material, consumes tokens once and signs out every session", async () =>
  fixture(async ({ store, alice, bob, base, sent }) => {
    const anonymous = new Client(base);
    const known = await anonymous.request("auth/forgot-password", "POST", {
      email: "alice@example.com",
    });
    const unknown = await anonymous.request("auth/forgot-password", "POST", {
      email: "unknown@example.com",
    });
    const notAllowed = await anonymous.request("auth/forgot-password", "POST", {
      email: "bob@example.com",
    });
    assert.equal(known.status, 202);
    assert.equal(unknown.status, 202);
    assert.equal(notAllowed.status, 202);
    assert.deepEqual(await known.json(), await unknown.json());
    assert.equal(sent.length, 1);
    const token = messageToken(sent[0]),
      stored = store.db
        .prepare("SELECT * FROM account_tokens WHERE user_id = 'alice'")
        .get()!;
    assert.equal(stored.token_hash, hashToken(token));
    assert.ok(!JSON.stringify(stored).includes(token));
    const reset = await anonymous.request("auth/reset-password", "POST", {
      token,
      password: "Recovered account password",
    });
    assert.equal(reset.status, 200);
    assert.equal((await alice.request("account/security")).status, 401);
    assert.equal((await bob.request("account/security")).status, 200);
    assert.equal(
      (
        await anonymous.request("auth/reset-password", "POST", {
          token,
          password: "Overwrite password",
        })
      ).status,
      400,
    );
    await alice.login("alice@example.com", "Recovered account password");
  }));

test("verification requires the matching signed-in identity and is never available from an outbox", async () =>
  fixture(async ({ store, alice, bob, base, sent }) => {
    assert.equal(
      (await bob.request("account/verification", "POST", {})).status,
      503,
    );
    const requested = await alice.request("account/verification", "POST", {});
    assert.equal(requested.status, 202);
    assert.equal(sent.length, 1);
    const token = messageToken(sent[0]);
    assert.equal(
      (
        await new Client(base).request("account/verify-email", "POST", {
          token,
        })
      ).status,
      401,
    );
    assert.equal(
      (await bob.request("account/verify-email", "POST", { token })).status,
      403,
    );
    assert.equal(
      (await alice.request("account/verify-email", "POST", { token })).status,
      200,
    );
    assert.ok(
      (await (await alice.request("account/security")).json()).emailVerifiedAt,
    );
    assert.ok(
      store.db
        .prepare("SELECT email_verified_at FROM users WHERE id = 'alice'")
        .get()!.email_verified_at,
    );
    assert.equal(
      (await alice.request("account/verify-email", "POST", { token })).status,
      400,
    );
    assert.equal(
      (await alice.request("account/verification", "POST", {})).status,
      200,
    );
    assert.equal(sent.length, 1);
  }));

test("outbox mode does not produce reset or verification tokens and reports the missing live mail configuration", async () =>
  fixture(async ({ store, alice, base, sent }) => {
    const anonymous = new Client(base);
    const known = await anonymous.request("auth/forgot-password", "POST", {
        email: "alice@example.com",
      }),
      unknown = await anonymous.request("auth/forgot-password", "POST", {
        email: "unknown@example.com",
      });
    assert.equal(known.status, 503);
    assert.equal(unknown.status, 503);
    assert.deepEqual(await known.json(), await unknown.json());
    assert.equal(
      (await alice.request("account/verification", "POST", {})).status,
      503,
    );
    assert.equal(
      Number(
        store.db.prepare("SELECT COUNT(*) AS count FROM account_tokens").get()!
          .count,
      ),
      0,
    );
    assert.equal(sent.length, 0);
  }, "outbox"));

test("replaced, expired and failed-provider recovery tokens are unusable and repeated requests are bounded", async () =>
  fixture(async ({ store, alice, base, sent, failMail }) => {
    const anonymous = new Client(base);
    await anonymous.request("auth/forgot-password", "POST", {
      email: "alice@example.com",
    });
    const replaced = messageToken(sent[0]);
    await anonymous.request("auth/forgot-password", "POST", {
      email: "alice@example.com",
    });
    const expired = messageToken(sent[1]);
    assert.equal(
      (
        await anonymous.request("auth/reset-password", "POST", {
          token: replaced,
          password: "Should not work",
        })
      ).status,
      400,
    );
    store.db
      .prepare("UPDATE account_tokens SET expires_at = ? WHERE token_hash = ?")
      .run(Date.now() - 1, hashToken(expired));
    assert.equal(
      (
        await anonymous.request("auth/reset-password", "POST", {
          token: expired,
          password: "Should not work",
        })
      ).status,
      400,
    );
    failMail();
    assert.equal(
      (
        await anonymous.request("auth/forgot-password", "POST", {
          email: "alice@example.com",
        })
      ).status,
      202,
    );
    const failed = messageToken(sent[2]);
    assert.equal(
      (
        await anonymous.request("auth/reset-password", "POST", {
          token: failed,
          password: "Should not work",
        })
      ).status,
      400,
    );
    assert.equal(
      (await alice.request("account/verification", "POST", {})).status,
      502,
    );
    await anonymous.request("auth/forgot-password", "POST", {
      email: "alice@example.com",
    });
    assert.equal(
      (
        await anonymous.request("auth/forgot-password", "POST", {
          email: "alice@example.com",
        })
      ).status,
      429,
    );
  }));
