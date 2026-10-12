import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Server } from "node:http";
import { createApp } from "../../server/app.js";
import { createDatabase, type Store } from "../../server/db.js";
import { hashToken, sessionUser, userById } from "../../server/auth.js";
import type { Request } from "express";

const ORIGIN = "http://localhost:5174";
class Client {
  cookie = "";
  user: Record<string, string> = {};
  constructor(readonly base: string) {}
  request(path: string, method = "GET", body?: unknown) {
    return fetch(`${this.base}/api/${path}`, {
      method,
      headers: {
        Origin: ORIGIN,
        Cookie: this.cookie,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async signup(name: string) {
    const response = await this.request("auth/signup", "POST", {
      name,
      email: `${name.toLowerCase()}@example.com`,
      password: "Team testing secure password",
      seedDemo: false,
    });
    assert.equal(response.status, 201);
    this.cookie = response.headers.get("set-cookie")!.split(";")[0];
    this.user = (await response.json()).user;
  }
  async login(email: string) {
    const response = await this.request("auth/login", "POST", {
      email,
      password: "Team testing secure password",
    });
    assert.equal(response.status, 200);
    this.cookie = response.headers.get("set-cookie")!.split(";")[0];
    this.user = (await response.json()).user;
  }
  async invite(email: string, role = "member") {
    const response = await this.request("team/invitations", "POST", {
      email,
      role,
      name: "Invited teammate",
    });
    assert.equal(response.status, 201);
    return (await response.json()).item;
  }
  async accept(url: string) {
    return this.request(`${url.slice(1)}/accept`, "POST", {});
  }
}
async function fixture(
  run: (
    store: Store,
    owner: Client,
    other: Client,
    base: string,
  ) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), "arkoffer-team-test-"));
  const store = createDatabase(directory),
    app = createApp({ store, appOrigin: ORIGIN, openAiApiKey: "" });
  let server: Server;
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, "127.0.0.1", (error) =>
      error ? reject(error) : resolve(),
    );
  });
  const address = server!.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`,
    owner = new Client(base),
    other = new Client(base);
  try {
    await owner.signup("Owner");
    await other.signup("Other");
    await run(store, owner, other, base);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server!.close((e) => (e ? reject(e) : resolve())),
    );
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("legacy single-workspace accounts and sessions migrate once without resurrecting removed memberships", () => {
  const directory = mkdtempSync(join(tmpdir(), "arkoffer-team-legacy-")),
    filename = join(directory, "legacy.sqlite");
  const token = "a".repeat(64),
    db = new DatabaseSync(filename);
  db.exec(`CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, settings TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
    CREATE TABLE users (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'owner', created_at TEXT NOT NULL);
    CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL, created_at TEXT NOT NULL);
    INSERT INTO workspaces VALUES ('legacy-w', 'Legacy workspace', '{}', '2026-01-01');
    INSERT INTO users VALUES ('legacy-u', 'legacy-w', 'Legacy', 'legacy@example.com', 'unused', 'owner', '2026-01-01');`);
  db.prepare(
    "INSERT INTO sessions VALUES (?, 'legacy-u', ?, '2026-01-01')",
  ).run(hashToken(token), Date.now() + 100_000);
  db.close();
  let store = createDatabase(directory, filename);
  try {
    assert.equal(userById(store, "legacy-u")?.role, "owner");
    assert.equal(
      sessionUser(store, {
        headers: { cookie: `arkoffer_session=${token}` },
      } as Request)?.workspaceId,
      "legacy-w",
    );
    store.db
      .prepare("DELETE FROM memberships WHERE user_id = ?")
      .run("legacy-u");
    store.close();
    store = createDatabase(directory, filename);
    assert.equal(userById(store, "legacy-u"), undefined);
    assert.equal(
      sessionUser(store, {
        headers: { cookie: `arkoffer_session=${token}` },
      } as Request),
      undefined,
    );
    store.db.exec(
      "INSERT INTO users (id, workspace_id, name, email, password_hash, role, created_at) VALUES ('new-u', 'legacy-w', 'New', 'new@example.com', 'unused', 'admin', '2026-01-01')",
    );
    assert.equal(userById(store, "new-u")?.role, "admin");
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("invitation acceptance is email-bound, hashed, single-use and switches only the accepting session", async () =>
  fixture(async (store, owner, other, base) => {
    const originalWorkspace = other.user.workspaceId,
      otherBrowser = new Client(base);
    await otherBrowser.login(other.user.email);
    const invite = await owner.invite(other.user.email);
    const token = invite.url.split("/").at(-1);
    const row = store.db
      .prepare("SELECT * FROM team_invitations WHERE id = ?")
      .get(invite.id)!;
    assert.equal(row.token_hash, hashToken(token));
    assert.ok(!JSON.stringify(row).includes(token));
    const publicResponse = await new Client(base).request(invite.url.slice(1));
    assert.equal(publicResponse.status, 200);
    const detail = (await publicResponse.json()).invitation;
    assert.equal(detail.workspaceName, owner.user.workspaceName);
    assert.equal(detail.emailHint, "o***@example.com");
    assert.equal(detail.email, undefined);
    assert.equal((await new Client(base).accept(invite.url)).status, 401);
    assert.equal((await owner.accept(invite.url)).status, 403);
    assert.equal((await other.accept(invite.url)).status, 200);
    const accepted = (await (await other.request("auth/me")).json()).user;
    assert.equal(accepted.workspaceId, owner.user.workspaceId);
    assert.equal(accepted.role, "member");
    assert.equal(
      (await (await otherBrowser.request("auth/me")).json()).user.workspaceId,
      originalWorkspace,
    );
    assert.equal((await other.accept(invite.url)).status, 404);
    assert.equal(
      (await new Client(base).request(invite.url.slice(1))).status,
      404,
    );
    const workspaces = (await (await other.request("workspaces")).json()).items;
    assert.equal(workspaces.length, 2);
    assert.equal(
      (
        await other.request(
          `workspaces/${originalWorkspace}/switch`,
          "POST",
          {},
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await other.request(
          `workspaces/${owner.user.workspaceId}/switch`,
          "POST",
          {},
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await owner.request(
          `workspaces/${originalWorkspace}/switch`,
          "POST",
          {},
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await other.request("team/invitations", "POST", {
          email: "third@example.com",
        })
      ).status,
      403,
    );
  }));

test("roles, last-owner protection and suspended membership revoke team access while preserving unrelated sessions", async () =>
  fixture(async (_store, owner, other, base) => {
    const invite = await owner.invite(other.user.email, "admin");
    assert.equal((await other.accept(invite.url)).status, 200);
    assert.equal(
      (
        await other.request("team/invitations", "POST", {
          email: "forbidden@example.com",
          role: "owner",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await other.request(`team/members/${owner.user.id}`, "PATCH", {
          role: "member",
        })
      ).status,
      403,
    );
    assert.equal(
      (await other.request(`team/members/${owner.user.id}`, "DELETE")).status,
      403,
    );
    for (const body of [{ role: "member" }, { status: "suspended" }])
      assert.equal(
        (await owner.request(`team/members/${owner.user.id}`, "PATCH", body))
          .status,
        409,
      );
    assert.equal(
      (await owner.request(`team/members/${owner.user.id}`, "DELETE")).status,
      409,
    );
    const member = new Client(base);
    await member.signup("Member");
    const secondSession = new Client(base);
    await secondSession.login(member.user.email);
    const memberInvite = await other.invite(member.user.email);
    assert.equal((await member.accept(memberInvite.url)).status, 200);
    assert.equal(
      (
        await member.request(`team/members/${other.user.id}`, "PATCH", {
          role: "owner",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await other.request(`team/members/${member.user.id}`, "PATCH", {
          status: "suspended",
        })
      ).status,
      200,
    );
    assert.equal((await member.request("conversations")).status, 401);
    assert.equal(
      (
        await secondSession.request(
          `workspaces/${owner.user.workspaceId}/switch`,
          "POST",
          {},
        )
      ).status,
      404,
    );
    assert.equal((await secondSession.request("conversations")).status, 200);
    assert.equal(
      (
        await owner.request(`team/members/${member.user.id}`, "PATCH", {
          status: "active",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await secondSession.request(
          `workspaces/${owner.user.workspaceId}/switch`,
          "POST",
          {},
        )
      ).status,
      200,
    );
    assert.equal(
      (await owner.request(`team/members/${member.user.id}`, "DELETE")).status,
      200,
    );
    assert.equal((await secondSession.request("team/members")).status, 401);
  }));

test("revoked, expired and replaced links cannot grant access; invitations do not cross workspace boundaries", async () =>
  fixture(async (store, owner, other, base) => {
    const first = await owner.invite(other.user.email),
      replacement = await owner.invite(other.user.email);
    assert.equal((await other.accept(first.url)).status, 404);
    assert.equal(
      (await other.request(`team/invitations/${replacement.id}`, "DELETE"))
        .status,
      404,
    );
    assert.equal(
      (await owner.request(`team/invitations/${replacement.id}`, "DELETE"))
        .status,
      200,
    );
    assert.equal((await other.accept(replacement.url)).status, 404);
    const expired = await owner.invite(other.user.email);
    store.db
      .prepare("UPDATE team_invitations SET expires_at = ? WHERE id = ?")
      .run(Date.now() - 1, expired.id);
    assert.equal((await other.accept(expired.url)).status, 404);
    assert.equal(
      (await (await owner.request("team/invitations")).json()).items.length,
      0,
    );
    assert.equal(
      (await new Client(base).request("invitations/not-a-token")).status,
      404,
    );
    const denied = await fetch(`${base}/api/team/invitations`, {
      method: "POST",
      headers: { Cookie: owner.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ email: "denied@example.com" }),
    });
    assert.equal(denied.status, 403);
  }));

test("new workspaces are isolated, have templates, and final-membership removal cannot strand account login", async () =>
  fixture(async (store, owner, other, base) => {
    const original = owner.user.workspaceId;
    const response = await owner.request("workspaces", "POST", {
      name: "Second hiring team",
    });
    assert.equal(response.status, 201);
    const workspace = (await response.json()).user.workspaceId;
    assert.notEqual(workspace, original);
    assert.equal(store.list(workspace, "templates").length, 12);
    assert.equal(
      (await (await owner.request("auth/me")).json()).user.workspaceId,
      workspace,
    );
    assert.equal(
      (await other.request(`workspaces/${workspace}/switch`, "POST", {}))
        .status,
      404,
    );
    assert.equal(
      (await (await other.request("team/members")).json()).items.length,
      1,
    );
    // Simulate an administrator removing the last membership after transfer of its ownership.
    store.db
      .prepare("DELETE FROM memberships WHERE user_id = ?")
      .run(other.user.id);
    const recovered = new Client(base);
    await recovered.login(other.user.email);
    assert.equal(recovered.user.role, "owner");
    assert.notEqual(recovered.user.workspaceId, other.user.workspaceId);
    assert.equal(
      (await recovered.request(`workspaces/${workspace}/switch`, "POST", {}))
        .status,
      404,
    );
  }));

test("demotion revokes outstanding delegated invites and administrators cannot replace owner invitations", async () =>
  fixture(async (_store, owner, other, base) => {
    const invite = await owner.invite(other.user.email, "owner");
    assert.equal((await other.accept(invite.url)).status, 200);
    const highPrivilege = await other.invite(
      "future-owner@example.com",
      "owner",
    );
    const memberInvitation = await other.invite(
      "future-member@example.com",
      "member",
    );
    assert.equal(
      (
        await owner.request(`team/members/${other.user.id}`, "PATCH", {
          role: "admin",
        })
      ).status,
      200,
    );
    assert.equal(
      (await new Client(base).request(highPrivilege.url.slice(1))).status,
      404,
    );
    assert.equal(
      (await new Client(base).request(memberInvitation.url.slice(1))).status,
      200,
    );
    const ownerInvitation = await owner.invite(
      "second-future-owner@example.com",
      "owner",
    );
    assert.equal(
      (
        await other.request("team/invitations", "POST", {
          email: ownerInvitation.email,
          role: "member",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await owner.request(`team/members/${other.user.id}`, "PATCH", {
          status: "suspended",
        })
      ).status,
      200,
    );
    assert.equal(
      (await new Client(base).request(memberInvitation.url.slice(1))).status,
      404,
    );
  }));
