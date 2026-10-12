import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { createDatabase } from "../../server/db.js";
import { createAi } from "../../server/ai.js";
import { sessionUser, hashToken, type AuthRequest } from "../../server/auth.js";
import {
  initializeAccess,
  registerResourceOwner,
} from "../../server/access.js";
import { registerNoteEditing } from "../../server/note-editing.js";

async function fixture(
  options: {
    configured?: boolean;
    complete?: ReturnType<typeof createAi>["complete"];
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "arkoffer-note-edits-")),
    store = createDatabase(directory),
    workspaceId = randomUUID(),
    createdAt = new Date().toISOString();
  store.db
    .prepare("INSERT INTO workspaces(id,name,created_at) VALUES(?,?,?)")
    .run(workspaceId, "Note edits", createdAt);
  function identity(role = "member", workspace = workspaceId) {
    const id = randomUUID(),
      token = randomBytes(32).toString("hex");
    store.db
      .prepare(
        "INSERT INTO users(id,workspace_id,name,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        id,
        workspace,
        "Synthetic",
        `${id}@example.com`,
        "unused",
        role,
        createdAt,
      );
    store.db
      .prepare(
        "INSERT INTO sessions(token_hash,user_id,workspace_id,expires_at,created_at) VALUES(?,?,?,?,?)",
      )
      .run(hashToken(token), id, workspace, Date.now() + 3600000, createdAt);
    return { id, token, cookie: `arkoffer_session=${token}` };
  }
  const owner = identity("owner"),
    editor = identity(),
    viewer = identity();
  initializeAccess(store);
  const item = store.insert(workspaceId, "conversations", {
    id: randomUUID(),
    createdAt,
    updatedAt: createdAt,
    title: "Alex interview",
    candidate: "Alex",
    transcript: "Alex: I shipped v1. Alex led the team.",
    tldr: "Alex shipped v1.",
    sections: [
      {
        id: "experience",
        title: "Experience",
        content: "Alex shipped v1. Alex led the team.",
      },
      { id: "skills", title: "Skills", content: "Alex uses C++ and $&." },
    ],
  });
  registerResourceOwner(store, workspaceId, item.id, owner.id);
  for (const [user, permission] of [
    [editor, "editor"],
    [viewer, "viewer"],
  ] as const)
    store.db
      .prepare(
        "INSERT INTO resource_grants(resource_id,user_id,permission,created_at) VALUES(?,?,?,?)",
      )
      .run(item.id, user.id, permission, createdAt);
  const ai = createAi({
    env: {},
    apiKey: options.configured === false ? "" : "fake-test-key",
  });
  let calls = 0;
  ai.complete = async (...args) => {
    calls++;
    if (options.complete) return options.complete(...args);
    return JSON.stringify({
      content: "Alex shipped v1.",
      evidence: [{ source: "notes", quote: "Alex shipped v1." }],
    });
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as AuthRequest).user = sessionUser(store, req);
    next();
  });
  registerNoteEditing(app, store, { ai });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/api/conversations/${item.id}/note-edits`;
  const call = (who = owner, suffix = "", method = "GET", body?: unknown) =>
    fetch(url + suffix, {
      method,
      headers: { Cookie: who.cookie, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  async function input(who = owner, extra: Record<string, unknown> = {}) {
    const source = await (await call(who)).json();
    return {
      requestId: randomUUID(),
      sourceFingerprint: source.sourceFingerprint,
      target: { kind: "section", sectionId: "experience" },
      operation: "shorten",
      ...extra,
    };
  }
  async function draft(who = owner, extra: Record<string, unknown> = {}) {
    const response = await call(who, "", "POST", await input(who, extra));
    assert.equal(response.status, 201, await response.clone().text());
    return (await response.json()).item;
  }
  function update(patch: Record<string, unknown>) {
    return store.update(workspaceId, "conversations", {
      ...store.get(workspaceId, "conversations", item.id)!,
      ...patch,
      updatedAt: new Date().toISOString(),
    });
  }
  return {
    store,
    workspaceId,
    item,
    owner,
    editor,
    viewer,
    call,
    input,
    draft,
    update,
    identity,
    calls: () => calls,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("AI drafts persist private previews and apply atomically only to the selected section; repeated apply preserves later edits", async () => {
  const f = await fixture();
  try {
    const input = await f.input(),
      response = await f.call(f.owner, "", "POST", input),
      draft = (await response.json()).item;
    assert.equal(response.status, 201);
    assert.equal(draft.status, "ready");
    assert.equal(
      (
        f.store.get(f.workspaceId, "conversations", f.item.id)!
          .sections as any[]
      )[0].content,
      "Alex shipped v1. Alex led the team.",
    );
    assert.equal((await (await f.call()).json()).items[0].id, draft.id);
    assert.equal((await f.call(f.owner, "", "POST", input)).status, 200);
    assert.equal(f.calls(), 1);
    assert.equal(
      (await f.call(f.owner, "", "POST", { ...input, operation: "expand" }))
        .status,
      409,
    );
    assert.equal(
      (
        await f.call(f.owner, `/${draft.id}/apply`, "POST", {
          proposed: "untrusted",
        })
      ).status,
      400,
    );
    const applied = await (
      await f.call(f.owner, `/${draft.id}/apply`, "POST", {})
    ).json();
    assert.equal(applied.draft.status, "applied");
    assert.equal(applied.item.sections[0].content, "Alex shipped v1.");
    assert.equal(applied.item.sections[1].content, "Alex uses C++ and $&.");
    assert.equal(applied.item.transcript, f.item.transcript);
    const version = f.store.db
      .prepare("SELECT * FROM versions WHERE resource_id=?")
      .get(f.item.id)!;
    assert.equal(
      JSON.parse(String(version.data)).sections[0].content,
      "Alex shipped v1. Alex led the team.",
    );
    f.update({ tldr: "Later independent edit" });
    const repeated = await (
      await f.call(f.owner, `/${draft.id}/apply`, "POST", {})
    ).json();
    assert.equal(repeated.alreadyApplied, true);
    assert.equal(repeated.item.tldr, "Later independent edit");
    assert.equal(
      f.store.db
        .prepare("SELECT COUNT(*) AS n FROM versions WHERE resource_id=?")
        .get(f.item.id)!.n,
      1,
    );
  } finally {
    await f.close();
  }
});

test("literal replacement uses no provider, treats regex and replacement tokens literally, and offers explicit whole-note scope", async () => {
  const f = await fixture({ configured: false });
  try {
    assert.equal(
      (await f.call(f.owner, "", "POST", await f.input())).status,
      503,
    );
    const exact = await f.draft(f.owner, {
      operation: "replace",
      target: { kind: "section", sectionId: "skills" },
      find: "C++",
      replacement: "$&",
    });
    assert.equal(exact.proposed, "Alex uses $& and $&.");
    await f.call(f.owner, `/${exact.id}/apply`, "POST", {});
    const draft = await f.draft(f.owner, {
      operation: "replace",
      target: { kind: "summary-and-transcript" },
      find: "Alex",
      replacement: "[redacted]",
    });
    assert.equal(draft.changes.length, 4);
    const applied = await (
      await f.call(f.owner, `/${draft.id}/apply`, "POST", {})
    ).json();
    assert.ok(
      applied.item.sections.every(
        (section: any) => !section.content.includes("Alex"),
      ),
    );
    assert.ok(!applied.item.transcript.includes("Alex"));
    assert.ok(!applied.item.tldr.includes("Alex"));
    assert.equal(applied.item.title, "Alex interview");
    assert.equal(applied.item.candidate, "Alex");
    assert.ok(
      String(
        f.store.db
          .prepare("SELECT data FROM versions ORDER BY rowid DESC LIMIT 1")
          .get()!.data,
      ).includes("Alex"),
    );
    assert.equal(f.calls(), 0);
    const notFound = await f.call(
      f.owner,
      "",
      "POST",
      await f.input(f.owner, {
        operation: "replace",
        find: "alex",
        replacement: "",
      }),
    );
    assert.equal(notFound.status, 400);
  } finally {
    await f.close();
  }
});

test("every draft route enforces active session, access and author isolation", async () => {
  const f = await fixture();
  try {
    const draft = await f.draft();
    assert.equal((await (await f.call(f.editor)).json()).items.length, 0);
    assert.equal(
      (await f.call(f.editor, `/${draft.id}/apply`, "POST", {})).status,
      404,
    );
    assert.equal(
      (await f.call(f.editor, `/${draft.id}/discard`, "POST", {})).status,
      404,
    );
    assert.equal(
      (await f.call(f.viewer, "", "POST", await f.input(f.viewer))).status,
      403,
    );
    assert.equal((await f.call({ ...f.owner, cookie: "" })).status, 401);
    const editorDraft = await f.draft(f.editor);
    f.store.db
      .prepare("DELETE FROM resource_grants WHERE user_id=?")
      .run(f.editor.id);
    assert.equal((await f.call(f.editor)).status, 404);
    assert.equal(
      (await f.call(f.editor, `/${editorDraft.id}/apply`, "POST", {})).status,
      404,
    );
    assert.equal(
      (await f.call(f.editor, `/${editorDraft.id}/discard`, "POST", {})).status,
      404,
    );
  } finally {
    await f.close();
  }
});

test("in-flight provider completion rechecks ACL and session before returning or retaining a proposal", async () => {
  for (const revoke of ["grant", "session", "membership"] as const) {
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const f = await fixture({
      complete: async () => {
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return JSON.stringify({
          content: "Alex shipped v1.",
          evidence: [{ source: "notes", quote: "Alex shipped v1." }],
        });
      },
    });
    try {
      const pending = f.call(f.editor, "", "POST", await f.input(f.editor));
      await waiting;
      if (revoke === "grant")
        f.store.db
          .prepare("DELETE FROM resource_grants WHERE user_id=?")
          .run(f.editor.id);
      else if (revoke === "session")
        f.store.db
          .prepare("DELETE FROM sessions WHERE user_id=?")
          .run(f.editor.id);
      else
        f.store.db
          .prepare("UPDATE memberships SET status='suspended' WHERE user_id=?")
          .run(f.editor.id);
      release();
      assert.equal((await pending).status, revoke === "grant" ? 404 : 401);
      const row = f.store.db
        .prepare("SELECT state,proposed_text FROM note_edit_drafts")
        .get()!;
      assert.equal(row.state, "failed");
      assert.equal(row.proposed_text, null);
    } finally {
      await f.close();
    }
  }
});

test("full source and version fingerprints reject stale creation and preserve concurrent changes before or after a provider request", async () => {
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const f = await fixture({
    complete: async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return JSON.stringify({
        content: "Alex shipped v1.",
        evidence: [{ source: "notes", quote: "Alex shipped v1." }],
      });
    },
  });
  try {
    const stale = await f.input();
    f.update({ tldr: "Changed" });
    assert.equal((await f.call(f.owner, "", "POST", stale)).status, 409);
    assert.equal(f.calls(), 0);
    const pending = f.call(f.owner, "", "POST", await f.input());
    await waiting;
    f.update({ transcript: "Changed transcript" });
    release();
    assert.equal((await pending).status, 409);
    const draft = await f.draft(f.owner, {
      operation: "replace",
      find: "Alex",
      replacement: "Person",
    });
    f.store.db
      .prepare(
        "INSERT INTO versions(id,resource_id,workspace_id,data,label,created_at) VALUES(?,?,?,?,?,?)",
      )
      .run(
        randomUUID(),
        f.item.id,
        f.workspaceId,
        JSON.stringify(f.item),
        "Concurrent version",
        new Date().toISOString(),
      );
    assert.equal(
      (await f.call(f.owner, `/${draft.id}/apply`, "POST", {})).status,
      409,
    );
    assert.equal(
      f.store.get(f.workspaceId, "conversations", f.item.id)!.transcript,
      "Changed transcript",
    );
    assert.equal(
      (await (await f.call()).json()).items.find(
        (row: any) => row.id === draft.id,
      ).status,
      "ready",
    );
  } finally {
    await f.close();
  }
});

test("provider failures and fabricated evidence produce failed persisted attempts without success or retry", async () => {
  for (const complete of [
    async () => {
      throw new Error("synthetic provider failure");
    },
    async () =>
      JSON.stringify({
        content: "Invented",
        evidence: [{ source: "transcript", quote: "Fabricated quotation" }],
      }),
  ]) {
    const f = await fixture({ complete });
    try {
      const input = await f.input(),
        response = await f.call(f.owner, "", "POST", input);
      assert.equal(response.status, 502);
      const retry = await (await f.call(f.owner, "", "POST", input)).json();
      assert.equal(retry.item.status, "failed");
      assert.equal(f.calls(), 1);
      assert.equal(
        (await f.call(f.owner, `/${retry.item.id}/apply`, "POST", {})).status,
        409,
      );
      assert.equal(
        f.store.db.prepare("SELECT COUNT(*) AS n FROM versions").get()!.n,
        0,
      );
    } finally {
      await f.close();
    }
  }
});

test("apply bounds conversation size and version retention, discarding prevents application", async () => {
  const f = await fixture({ configured: false });
  try {
    const discarded = await f.draft(f.owner, {
      operation: "replace",
      find: "Alex",
      replacement: "Someone",
    });
    assert.equal(
      (await f.call(f.owner, `/${discarded.id}/discard`, "POST", {})).status,
      200,
    );
    assert.equal(
      (await f.call(f.owner, `/${discarded.id}/apply`, "POST", {})).status,
      409,
    );
    const empty = f.update({ padding: "", tldr: "Alex" });
    f.update({
      padding: "x".repeat(999_800 - Buffer.byteLength(JSON.stringify(empty))),
    });
    const large = await f.draft(f.owner, {
      target: { kind: "tldr" },
      operation: "replace",
      find: "A",
      replacement: "z".repeat(500),
    });
    const applied = await f.call(f.owner, `/${large.id}/apply`, "POST", {});
    assert.equal(applied.status, 413);
    assert.equal(
      f.store.get(f.workspaceId, "conversations", f.item.id)!.tldr,
      "Alex",
    );
    assert.equal(
      f.store.db.prepare("SELECT COUNT(*) AS n FROM versions").get()!.n,
      0,
    );
    f.update({ padding: "", tldr: "Alex" });
    for (let i = 0; i < 105; i++)
      f.store.db
        .prepare(
          "INSERT INTO versions(id,resource_id,workspace_id,data,label,created_at) VALUES(?,?,?,?,?,?)",
        )
        .run(
          randomUUID(),
          f.item.id,
          f.workspaceId,
          JSON.stringify(f.item),
          "Before",
          new Date().toISOString(),
        );
    const bounded = await f.draft(f.owner, {
      target: { kind: "tldr" },
      operation: "replace",
      find: "Alex",
      replacement: "Person",
    });
    assert.equal(
      (await f.call(f.owner, `/${bounded.id}/apply`, "POST", {})).status,
      200,
    );
    assert.equal(
      f.store.db
        .prepare("SELECT COUNT(*) AS n FROM versions WHERE resource_id=?")
        .get(f.item.id)!.n,
      100,
    );
  } finally {
    await f.close();
  }
});

test("draft limits are per user and durable; names and pronouns are only explicit instructions", async () => {
  let prompt = "";
  const f = await fixture({
    complete: async (messages) => {
      prompt = JSON.stringify(messages);
      return JSON.stringify({
        content: "Alex shipped v1.",
        evidence: [{ source: "notes", quote: "Alex shipped v1." }],
      });
    },
  });
  try {
    await f.draft(f.owner, { pronounInstructions: "Use they/them for Alex" });
    assert.ok(prompt.includes("Never invent or infer names, gender, pronouns"));
    assert.ok(prompt.includes("Use they/them for Alex"));
    f.store.db
      .prepare("UPDATE note_edit_usage SET count=20 WHERE author_id=?")
      .run(f.owner.id);
    assert.equal(
      (await f.call(f.owner, "", "POST", await f.input())).status,
      429,
    );
    assert.equal(
      (await f.call(f.editor, "", "POST", await f.input(f.editor))).status,
      201,
    );
  } finally {
    await f.close();
  }
});

test("expired draft IDs cannot resubmit a provider request and exact source hashing detects unchanged timestamps", async () => {
  const f = await fixture();
  try {
    const input = await f.input();
    const created = await (await f.call(f.owner, "", "POST", input)).json();
    f.store.db
      .prepare("DELETE FROM note_edit_drafts WHERE id=?")
      .run(created.item.id);
    assert.equal((await f.call(f.owner, "", "POST", input)).status, 410);
    assert.equal(f.calls(), 1);
    const draft = await f.draft(f.owner, {
      operation: "replace",
      find: "Alex",
      replacement: "Person",
    });
    const current = f.store.get(f.workspaceId, "conversations", f.item.id)!;
    f.store.db.prepare("UPDATE resources SET data=? WHERE id=?").run(
      JSON.stringify({
        ...current,
        transcript: "A changed source with the same timestamp.",
      }),
      f.item.id,
    );
    assert.equal(
      (await f.call(f.owner, `/${draft.id}/apply`, "POST", {})).status,
      409,
    );
    assert.equal(
      f.store.db.prepare("SELECT COUNT(*) AS n FROM versions").get()!.n,
      0,
    );
  } finally {
    await f.close();
  }
});
