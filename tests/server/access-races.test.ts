import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../server/app.js";
import { createDatabase } from "../../server/db.js";
import { hashToken } from "../../server/auth.js";

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "arkoffer-acl-races-")),
    store = createDatabase(directory),
    origin = "http://localhost:5174",
    nativeFetch = globalThis.fetch;
  const app = createApp({
    store,
    appOrigin: origin,
    openAiApiKey: "fake-test-key",
  });
  const workspaceId = randomUUID(),
    date = new Date().toISOString();
  store.db
    .prepare("INSERT INTO workspaces(id,name,created_at) VALUES(?,?,?)")
    .run(workspaceId, "Access tests", date);
  function identity(role: string) {
    const id = randomUUID(),
      token = randomBytes(32).toString("hex");
    store.db
      .prepare(
        "INSERT INTO users(id,workspace_id,name,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        id,
        workspaceId,
        "Synthetic",
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
    return { id, token, cookie: `arkoffer_session=${token}` };
  }
  const owner = identity("owner"),
    member = identity("member"),
    server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const call = (
    who: typeof owner,
    path: string,
    method = "GET",
    body?: unknown,
  ) =>
    nativeFetch(base + "/api/" + path, {
      method,
      headers: {
        Cookie: who.cookie,
        Origin: origin,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  async function note() {
    const r = await call(owner, "conversations", "POST", {
      title: "Private interview",
      transcript: "Candidate: I delivered a product.",
      tldr: "Original notes",
      sections: [],
    });
    assert.equal(r.status, 201);
    const item = (await r.json()).item;
    assert.equal(
      (
        await call(
          owner,
          `conversations/${item.id}/access/${member.id}`,
          "PUT",
          { permission: "editor" },
        )
      ).status,
      200,
    );
    return item;
  }
  function holdProvider() {
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>((r) => {
      entered = r;
    });
    globalThis.fetch = (async (input: any, init: any) => {
      if (String(input).startsWith("https://api.openai.com/")) {
        entered();
        await new Promise<void>((r) => {
          release = r;
        });
        const transcription = String(input).includes("/audio/transcriptions");
        return new Response(
          JSON.stringify(
            transcription
              ? { text: "Provider transcript" }
              : {
                  choices: [
                    {
                      message: {
                        content: JSON.stringify({
                          tldr: "Provider result",
                          sections: [{ title: "Summary", content: "Evidence" }],
                        }),
                      },
                    },
                  ],
                },
          ),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      return nativeFetch(input, init);
    }) as typeof fetch;
    return {
      waiting,
      release() {
        release();
      },
    };
  }
  return {
    store,
    workspaceId,
    owner,
    member,
    call,
    async uploadAudio() {
      const form = new FormData();
      form.append("title", "Synthetic audio");
      form.append(
        "file",
        new Blob(["synthetic audio fixture"], { type: "audio/mpeg" }),
        "test.mp3",
      );
      return nativeFetch(base + "/api/conversations/upload", {
        method: "POST",
        headers: { Cookie: owner.cookie, Origin: origin },
        body: form,
      });
    },
    note,
    holdProvider,
    async close() {
      globalThis.fetch = nativeFetch;
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("case-insensitive and trailing-slash routes cannot bypass owner-only shares or version restore", async () => {
  const f = await fixture();
  try {
    const item = await f.note();
    const saved = await (
      await f.call(f.owner, `conversations/${item.id}/versions`, "POST", {
        label: "Original",
      })
    ).json();
    for (const suffix of [
      "shares",
      "SHARES",
      "ShArEs/",
      `versions/${saved.item.id}/restore`,
      `VERSIONS/${saved.item.id}/RESTORE/`,
    ])
      assert.equal(
        (
          await f.call(
            f.member,
            `conversations/${item.id}/${suffix}`,
            "POST",
            {},
          )
        ).status,
        403,
        suffix,
      );
    assert.equal(
      f.store.db.prepare("SELECT COUNT(*) AS n FROM shares").get()!.n,
      0,
    );
    assert.equal(
      (await f.call(f.member, `conversations/${item.id}/`, "DELETE")).status,
      403,
    );
  } finally {
    await f.close();
  }
});

test("view-only collections reject new attachments and restoration cannot restore revoked collection write access", async () => {
  const f = await fixture();
  try {
    const folder = (
      await (
        await f.call(f.owner, "collections", "POST", {
          name: "Read-only collection",
        })
      ).json()
    ).item;
    await f.call(
      f.owner,
      `collections/${folder.id}/access/${f.member.id}`,
      "PUT",
      { permission: "viewer" },
    );
    assert.equal(
      (
        await f.call(f.member, "conversations", "POST", {
          title: "Injected",
          collectionIds: [folder.id],
        })
      ).status,
      400,
    );
    const own = (
      await (
        await f.call(f.member, "conversations", "POST", {
          title: "Member-owned note",
        })
      ).json()
    ).item;
    assert.equal(
      (
        await f.call(f.member, `conversations/${own.id}`, "PATCH", {
          collectionIds: [folder.id],
        })
      ).status,
      400,
    );
    await f.call(
      f.owner,
      `collections/${folder.id}/access/${f.member.id}`,
      "PUT",
      { permission: "editor" },
    );
    assert.equal(
      (
        await f.call(f.member, `conversations/${own.id}`, "PATCH", {
          collectionIds: [folder.id],
        })
      ).status,
      200,
    );
    const saved = (
      await (
        await f.call(f.member, `conversations/${own.id}/versions`, "POST", {
          label: "Shared folder",
        })
      ).json()
    ).item;
    await f.call(
      f.owner,
      `collections/${folder.id}/access/${f.member.id}`,
      "PUT",
      { permission: "viewer" },
    );
    assert.equal(
      (
        await f.call(f.member, `conversations/${own.id}`, "PATCH", {
          title: "Unrelated edit",
          collectionIds: [folder.id],
        })
      ).status,
      200,
    );
    await f.call(f.member, `conversations/${own.id}`, "PATCH", {
      collectionIds: [],
    });
    const restored = await f.call(
      f.member,
      `conversations/${own.id}/versions/${saved.id}/restore`,
      "POST",
      {},
    );
    assert.equal(restored.status, 200);
    assert.deepEqual((await restored.json()).item.collectionIds, []);
  } finally {
    await f.close();
  }
});

for (const operation of ["generate", "assistant"]) {
  test(`revoking a conversation grant during ${operation} prevents the provider response from leaking or changing notes`, async () => {
    const f = await fixture();
    try {
      const item = await f.note(),
        held = f.holdProvider();
      const pending = f.call(
        f.member,
        `conversations/${item.id}/${operation}`,
        "POST",
        operation === "assistant" ? { question: "What was delivered?" } : {},
      );
      await held.waiting;
      await f.call(
        f.owner,
        `conversations/${item.id}/access/${f.member.id}`,
        "DELETE",
      );
      held.release();
      const result = await pending;
      assert.equal(result.status, 404);
      assert.doesNotMatch(await result.text(), /Provider result/);
      assert.equal(
        f.store.get(f.workspaceId, "conversations", item.id)?.tldr,
        "Original notes",
      );
    } finally {
      await f.close();
    }
  });
}

for (const change of ["session", "workspace"]) {
  test(`changing the active ${change} while generation runs rejects the stale response`, async () => {
    const f = await fixture();
    try {
      const item = await f.note(),
        held = f.holdProvider(),
        pending = f.call(
          f.member,
          `conversations/${item.id}/generate`,
          "POST",
          {},
        );
      await held.waiting;
      if (change === "session")
        f.store.db
          .prepare("DELETE FROM sessions WHERE user_id=?")
          .run(f.member.id);
      else {
        const second = randomUUID(),
          date = new Date().toISOString();
        f.store.db
          .prepare("INSERT INTO workspaces(id,name,created_at) VALUES(?,?,?)")
          .run(second, "Second workspace", date);
        f.store.db
          .prepare(
            "INSERT INTO memberships(workspace_id,user_id,role,created_at,updated_at) VALUES(?,?,'member',?,?)",
          )
          .run(second, f.member.id, date, date);
        f.store.db
          .prepare("UPDATE sessions SET workspace_id=? WHERE user_id=?")
          .run(second, f.member.id);
      }
      held.release();
      const result = await pending;
      assert.equal(result.status, 409);
      assert.doesNotMatch(await result.text(), /Provider result/);
      assert.equal(
        f.store.get(f.workspaceId, "conversations", item.id)?.tldr,
        "Original notes",
      );
    } finally {
      await f.close();
    }
  });
}

test("revoking edit access during audio transcription preserves the existing note", async () => {
  const f = await fixture();
  try {
    const uploaded = await f.uploadAudio();
    assert.equal(uploaded.status, 201);
    const item = (await uploaded.json()).item;
    assert.equal(
      (
        await f.call(
          f.owner,
          `conversations/${item.id}/access/${f.member.id}`,
          "PUT",
          { permission: "editor" },
        )
      ).status,
      200,
    );
    const held = f.holdProvider(),
      pending = f.call(
        f.member,
        `conversations/${item.id}/transcribe`,
        "POST",
        {},
      );
    await held.waiting;
    await f.call(
      f.owner,
      `conversations/${item.id}/access/${f.member.id}`,
      "DELETE",
    );
    held.release();
    const result = await pending;
    assert.equal(result.status, 404);
    assert.doesNotMatch(await result.text(), /Provider transcript/);
    assert.equal(
      f.store.get(f.workspaceId, "conversations", item.id)?.transcript,
      "",
    );
  } finally {
    await f.close();
  }
});
