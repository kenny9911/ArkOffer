import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../server/app.js";
import { createDatabase } from "../../server/db.js";
async function setup(t: any, key: string | null = "") {
  const dir = mkdtempSync(join(tmpdir(), "arkoffer-knowledge-")),
    store = createDatabase(dir),
    origin = "http://localhost:5174",
    app = createApp({
      store,
      appOrigin: origin,
      openAiApiKey: key === null ? undefined : key,
    });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/api/`;
  const nativeFetch = fetch;
  const call = (cookie: string, path: string, method = "GET", body?: unknown) =>
    nativeFetch(url + path, {
      method,
      headers: {
        Origin: origin,
        Cookie: cookie,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  const signup = async (name: string) => {
    const r = await call("", "auth/signup", "POST", {
      name,
      email: name + "@example.com",
      password: "knowledge-test-pass-291",
    });
    assert.equal(r.status, 201);
    return {
      cookie: r.headers.get("set-cookie")!.split(";")[0],
      user: (await r.json()).user,
    };
  };
  const owner = await signup("knowledge-owner"),
    member = await signup("knowledge-member"),
    other = await signup("knowledge-other");
  const invitation = await (
    await call(owner.cookie, "team/invitations", "POST", {
      email: member.user.email,
      role: "member",
    })
  ).json();
  assert.equal(
    (
      await call(
        member.cookie,
        "invitations/" + invitation.item.url.split("/").pop() + "/accept",
        "POST",
        {},
      )
    ).status,
    200,
  );
  const note = async (title: string, transcript: string) =>
    (
      await (
        await call(owner.cookie, "conversations", "POST", { title, transcript })
      ).json()
    ).item;
  return { call, owner, member, other, note, store };
}
test("workspace assistant persists evidence across accessible notes, isolates history, and hides changed/revoked sources", async (t) => {
  const { call, owner, member, other, note } = await setup(t);
  const first = await note(
      "Platform interview",
      "Candidate: I built TypeScript services for a large team.",
    ),
    second = await note(
      "Frontend interview",
      "Candidate: TypeScript helped us improve accessibility.",
    ),
    secret = await note(
      "Confidential interview",
      "Secret: TypeScript secret-compensation-code.",
    );
  await note("Upcoming calendar interview", "");
  for (const n of [first, second])
    assert.equal(
      (
        await call(
          owner.cookie,
          `conversations/${n.id}/access/${member.user.id}`,
          "PUT",
          { permission: "viewer" },
        )
      ).status,
      200,
    );
  const answer = await call(member.cookie, "assistant/ask", "POST", {
    question: "TypeScript",
  });
  assert.equal(answer.status, 200);
  const data = await answer.json();
  assert.equal(data.message.mode, "extractive");
  assert.equal(data.message.citations.length, 2);
  assert.ok(data.message.answer.includes("Platform interview"));
  assert.ok(!JSON.stringify(data).includes("secret-compensation-code"));
  for (const c of data.message.citations) {
    const text =
      c.conversationId === first.id ? first.transcript : second.transcript;
    assert.equal(text.slice(c.start, c.end), c.text);
  }
  const history = await (
    await call(member.cookie, `assistant/threads/${data.threadId}`)
  ).json();
  assert.equal(history.messages.length, 1);
  assert.equal(history.messages[0].answer, data.message.answer);
  for (const person of [owner, other])
    assert.equal(
      (await call(person.cookie, `assistant/threads/${data.threadId}`)).status,
      404,
    );
  assert.equal(
    (
      await call(member.cookie, "assistant/ask", "POST", {
        question: "TypeScript",
        conversationIds: [secret.id],
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await call(
        owner.cookie,
        `conversations/${first.id}/access/${member.user.id}`,
        "DELETE",
      )
    ).status,
    200,
  );
  const revoked = await (
    await call(member.cookie, `assistant/threads/${data.threadId}`)
  ).json();
  assert.equal(revoked.messages[0].mode, "unavailable");
  assert.deepEqual(revoked.messages[0].citations, []);
  assert.ok(!JSON.stringify(revoked).includes("large team"));
  const next = await (
    await call(member.cookie, "assistant/ask", "POST", {
      question: "accessibility",
      threadId: data.threadId,
    })
  ).json();
  assert.equal(next.message.citations.length, 1);
  assert.equal(
    (
      await call(owner.cookie, `conversations/${second.id}`, "PATCH", {
        transcript: "Updated evidence without previous wording.",
      })
    ).status,
    200,
  );
  const edited = await (
    await call(member.cookie, `assistant/threads/${data.threadId}`)
  ).json();
  assert.equal(edited.messages[1].mode, "unavailable");
  const missing = await (
    await call(member.cookie, "assistant/ask", "POST", {
      question: "unmatched-zebra-unique",
    })
  ).json();
  assert.deepEqual(missing.message.citations, []);
  assert.ok(missing.message.answer.startsWith("No matching"));
  assert.equal(
    (await call(member.cookie, `assistant/threads/${data.threadId}`, "DELETE"))
      .status,
    200,
  );
  assert.equal(
    (await call(member.cookie, `assistant/threads/${data.threadId}`)).status,
    404,
  );
});
test("provider answers are discarded if source permissions change before completion", async (t) => {
  const { call, owner, member, note } = await setup(t, "test-key");
  const source = await note(
    "Revocation race",
    "Candidate: I built TypeScript systems.",
  );
  await call(
    owner.cookie,
    `conversations/${source.id}/access/${member.user.id}`,
    "PUT",
    { permission: "viewer" },
  );
  let release!: () => void, entered!: () => void;
  const hold = new Promise<void>((r) => (release = r)),
    started = new Promise<void>((r) => (entered = r));
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, options: any) => {
    assert.equal(String(input), "https://api.openai.com/v1/chat/completions");
    const body = JSON.parse(options.body);
    assert.ok(body.messages[1].content.includes("TypeScript"));
    entered();
    await hold;
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "TypeScript evidence [1]." } }],
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
    release();
  });
  const pending = call(member.cookie, "assistant/ask", "POST", {
    question: "TypeScript",
  });
  await started;
  assert.equal(
    (
      await call(
        owner.cookie,
        `conversations/${source.id}/access/${member.user.id}`,
        "DELETE",
      )
    ).status,
    200,
  );
  release();
  assert.equal((await pending).status, 409);
  assert.deepEqual(
    (await (await call(member.cookie, "assistant/threads")).json()).items,
    [],
  );
});

test("new workspaces cannot spend an operator AI key without explicit workspace enablement", async (t) => {
  const previousKey = process.env.OPENAI_API_KEY,
    previousIds = process.env.OPENAI_WORKSPACE_IDS;
  process.env.OPENAI_API_KEY = "synthetic-operator-key";
  process.env.OPENAI_WORKSPACE_IDS = "";
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousIds === undefined) delete process.env.OPENAI_WORKSPACE_IDS;
    else process.env.OPENAI_WORKSPACE_IDS = previousIds;
  });
  const { call, owner, note } = await setup(t, null);
  const source = await note(
    "Workspace authorization",
    "Candidate: TypeScript systems were my focus.",
  );
  const original = globalThis.fetch;
  let remoteCalls = 0;
  globalThis.fetch = (async () => {
    remoteCalls++;
    throw new Error("Live provider must not be used");
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const answer = await (
    await call(owner.cookie, "assistant/ask", "POST", {
      question: "TypeScript",
    })
  ).json();
  assert.equal(answer.message.mode, "extractive");
  const generation = await (
    await call(owner.cookie, `conversations/${source.id}/generate`, "POST", {})
  ).json();
  assert.equal(generation.mode, "extractive");
  const single = await (
    await call(owner.cookie, `conversations/${source.id}/assistant`, "POST", {
      question: "TypeScript",
    })
  ).json();
  assert.equal(single.mode, "extractive");
  assert.equal(
    (
      await call(
        owner.cookie,
        `conversations/${source.id}/transcribe`,
        "POST",
        {},
      )
    ).status,
    503,
  );
  const integrations = await (await call(owner.cookie, "integrations")).json();
  assert.equal(
    integrations.items.find((i: any) => i.id === "openai").configured,
    false,
  );
  assert.equal(remoteCalls, 0);
});
test("oversized provider answers are rejected without persisting an assistant thread", async (t) => {
  const { call, owner, note } = await setup(t, "test-key");
  await note("Bounded evidence", "Candidate: TypeScript software.");
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: "x".repeat(20_001) } }],
      }),
      { headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  assert.equal(
    (
      await call(owner.cookie, "assistant/ask", "POST", {
        question: "TypeScript",
      })
    ).status,
    502,
  );
  assert.deepEqual(
    (await (await call(owner.cookie, "assistant/threads")).json()).items,
    [],
  );
});
