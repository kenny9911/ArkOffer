import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { createDatabase } from "../../server/db.js";
import { hashToken } from "../../server/auth.js";
import { registerSequenceDrafts } from "../../server/sequence-drafts.js";
import { AiError, type createAi } from "../../server/ai.js";

const proposal = () =>
  JSON.stringify({
    name: "Engineering outreach",
    description: "A relevant introduction",
    steps: [
      {
        kind: "linkedin_message",
        subject: "Introduce yourself",
        body: "Hello {{firstName}}",
        delayDays: 0,
      },
      {
        kind: "email",
        subject: "Follow up",
        body: "Would you like to learn more?",
        delayDays: 3,
      },
    ],
    notes: ["Confirm the role details before launch."],
  });
async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "arkoffer-job-drafts-")),
    store = createDatabase(directory);
  function identity(workspaceId = randomUUID()) {
    const id = randomUUID(),
      token = randomBytes(32).toString("hex"),
      date = new Date().toISOString();
    store.db
      .prepare(
        "INSERT OR IGNORE INTO workspaces(id,name,created_at) VALUES(?,?,?)",
      )
      .run(workspaceId, "Synthetic draft tests", date);
    store.db
      .prepare(
        "INSERT INTO users(id,workspace_id,name,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        id,
        workspaceId,
        "Draft tester",
        `${id}@example.com`,
        "unused",
        "owner",
        date,
      );
    store.db
      .prepare(
        "INSERT INTO sessions(token_hash,user_id,workspace_id,expires_at,created_at) VALUES(?,?,?,?,?)",
      )
      .run(hashToken(token), id, workspaceId, Date.now() + 3600000, date);
    return { id, workspaceId, cookie: `arkoffer_session=${token}`, token };
  }
  const owner = identity(),
    teammate = identity(owner.workspaceId),
    other = identity();
  let allowed = true,
    calls = 0,
    complete: () => Promise<string> = async () => proposal();
  let capturedMessages: unknown;
  let capturedSettings: Parameters<ReturnType<typeof createAi>["complete"]>[2];
  const ai = {
    provider: "synthetic",
    model: "synthetic-model",
    configured: true,
    allowed: () => allowed,
    complete: async (
      messages: unknown,
      _json: boolean,
      settings: Parameters<ReturnType<typeof createAi>["complete"]>[2],
    ) => {
      capturedMessages = messages;
      capturedSettings = settings;
      calls++;
      return complete();
    },
  } as ReturnType<typeof createAi>;
  const app = express();
  app.use(express.json());
  registerSequenceDrafts(app, store, { ai });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const call = (cookie: string, path: string, method = "GET", body?: unknown) =>
    fetch(`http://127.0.0.1:${address.port}/api/${path}`, {
      method,
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const input = () => ({
    requestId: randomUUID(),
    instruction: "Write a LinkedIn introduction, then email.",
    draft: {
      name: "New sequence",
      description: "",
      steps: [{ kind: "email", subject: "", body: "", delayDays: 0 }],
      enrolledCandidateIds: [],
    },
  });
  return {
    store,
    owner,
    other,
    teammate,
    call,
    input,
    setAllowed: (value: boolean) => {
      allowed = value;
    },
    setComplete: (value: () => Promise<string>) => {
      complete = value;
    },
    calls: () => calls,
    captured: () => JSON.stringify(capturedMessages),
    settings: () => capturedSettings,
  };
}

test("sequence editor saves incomplete drafts, uses revision protection, and rejects invalid settings or cross-workspace candidates", async (t) => {
  const f = await fixture(t);
  const input = f.input().draft;
  const create = await f.call(
    f.owner.cookie,
    "sequence-workspace",
    "POST",
    input,
  );
  assert.equal(create.status, 201);
  const original = await create.json();
  assert.equal(
    (await f.call(f.other.cookie, `sequence-workspace/${original.item.id}`))
      .status,
    404,
  );
  const update = await f.call(
    f.owner.cookie,
    `sequence-workspace/${original.item.id}`,
    "PUT",
    { revision: original.revision, draft: { ...input, name: "Updated" } },
  );
  assert.equal(update.status, 200);
  assert.equal(
    (
      await f.call(
        f.owner.cookie,
        `sequence-workspace/${original.item.id}`,
        "PUT",
        {
          revision: original.revision,
          draft: { ...input, name: "Stale overwrite" },
        },
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await f.call(f.owner.cookie, "sequence-workspace", "POST", {
        ...input,
        settings: {
          timezone: "Invalid/Zone",
          weekdays: [1],
          startHour: 9,
          endHour: 8,
        },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.call(f.owner.cookie, "sequence-workspace", "POST", {
        ...input,
        enrolledCandidateIds: [randomUUID()],
      })
    ).status,
    400,
  );
  assert.equal(
    (await f.call("", "sequence-workspace", "POST", input)).status,
    401,
  );
});

test("agent proposals stay private, are idempotent, and cannot save or launch a sequence", async (t) => {
  const f = await fixture(t),
    input = f.input();
  const result = await f.call(f.owner.cookie, "sequence-drafts", "POST", input);
  assert.equal(result.status, 201);
  const draft = (await result.json()).item;
  assert.equal(draft.status, "ready");
  assert.equal(draft.result.steps[0].kind, "linkedin_message");
  assert.equal(f.settings()?.timeoutMs, 120_000);
  assert.equal(f.settings()?.maxTokens, 4500);
  assert.ok(f.settings()?.signal instanceof AbortSignal);
  assert.equal(f.store.list(f.owner.workspaceId, "sequences").length, 0);
  assert.equal(
    (await (await f.call(f.teammate.cookie, "sequence-drafts")).json()).items
      .length,
    0,
  );
  const duplicate = await f.call(
    f.owner.cookie,
    "sequence-drafts",
    "POST",
    input,
  );
  assert.equal(duplicate.status, 200);
  assert.equal(f.calls(), 1);
  assert.equal(
    (
      await f.call(f.owner.cookie, "sequence-drafts", "POST", {
        ...input,
        instruction: "Different request",
      })
    ).status,
    409,
  );
  assert.equal(
    (await f.call(f.other.cookie, `sequence-drafts?sequenceId=${randomUUID()}`))
      .status,
    404,
  );
});

test("agent preserves safe provider errors and idempotent failures without exposing unexpected error details", async (t) => {
  const f = await fixture(t);
  const safeMessage =
    "The AI provider took too long to respond. Please try again.";
  f.setComplete(async () => {
    throw new AiError(safeMessage);
  });
  const input = f.input();
  const result = await f.call(f.owner.cookie, "sequence-drafts", "POST", input);
  assert.equal(result.status, 201);
  const failed = (await result.json()).item;
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, safeMessage);
  assert.equal(failed.result, null);
  const replay = await f.call(f.owner.cookie, "sequence-drafts", "POST", input);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).item.error, safeMessage);
  assert.equal(f.calls(), 1);
  f.setComplete(async () => {
    throw new Error("secret provider payload");
  });
  const unexpected = await f.call(
    f.owner.cookie,
    "sequence-drafts",
    "POST",
    f.input(),
  );
  const hidden = (await unexpected.json()).item;
  assert.equal(hidden.status, "failed");
  assert.equal(
    hidden.error,
    "The provider could not produce a valid draft. No sequence was changed.",
  );
  assert.equal(
    JSON.stringify(hidden).includes("secret provider payload"),
    false,
  );
  assert.equal(f.store.list(f.owner.workspaceId, "sequences").length, 0);
});

test("agent setup and output validation never turn failure into a usable draft", async (t) => {
  const f = await fixture(t);
  f.setAllowed(false);
  assert.equal(
    (await f.call(f.owner.cookie, "sequence-drafts", "POST", f.input())).status,
    503,
  );
  assert.equal(f.calls(), 0);
  f.setAllowed(true);
  f.setComplete(async () =>
    JSON.stringify({
      ...JSON.parse(proposal()),
      steps: [
        {
          kind: "email",
          subject: "Unsafe\nheader",
          body: "Hello",
          delayDays: 0,
        },
      ],
    }),
  );
  let response = await f.call(
    f.owner.cookie,
    "sequence-drafts",
    "POST",
    f.input(),
  );
  assert.equal((await response.json()).item.status, "failed");
  f.setComplete(async () =>
    JSON.stringify({
      ...JSON.parse(proposal()),
      steps: [
        {
          kind: "email",
          subject: "Hi",
          body: "Hello {{secret}}",
          delayDays: 0,
        },
      ],
    }),
  );
  response = await f.call(f.owner.cookie, "sequence-drafts", "POST", f.input());
  assert.equal((await response.json()).item.status, "failed");
  assert.equal(f.store.list(f.owner.workspaceId, "sequences").length, 0);
});

test("agent rechecks the full source and session after the provider finishes", async (t) => {
  const f = await fixture(t);
  const created = await (
    await f.call(f.owner.cookie, "sequence-workspace", "POST", f.input().draft)
  ).json();
  f.setComplete(async () => {
    f.store.update(f.owner.workspaceId, "sequences", {
      ...created.item,
      description: "Concurrent edit",
      updatedAt: new Date().toISOString(),
    });
    return proposal();
  });
  const response = await f.call(f.owner.cookie, "sequence-drafts", "POST", {
    ...f.input(),
    sequenceId: created.item.id,
    revision: created.revision,
  });
  const draft = (await response.json()).item;
  assert.equal(draft.status, "failed");
  assert.equal(draft.result, null);
  assert.equal(draft.sourceCurrent, false);
  f.setComplete(async () => {
    f.store.db
      .prepare("DELETE FROM sessions WHERE token_hash=?")
      .run(hashToken(f.owner.token));
    return proposal();
  });
  assert.equal(
    (await f.call(f.owner.cookie, "sequence-drafts", "POST", f.input())).status,
    401,
  );
});

test("paid request tombstones and the hourly budget survive source deletion", async (t) => {
  const f = await fixture(t);
  const created = await (
      await f.call(
        f.owner.cookie,
        "sequence-workspace",
        "POST",
        f.input().draft,
      )
    ).json(),
    input = {
      ...f.input(),
      sequenceId: created.item.id,
      revision: created.revision,
    };
  assert.equal(
    (await f.call(f.owner.cookie, "sequence-drafts", "POST", input)).status,
    201,
  );
  f.store.db.prepare("DELETE FROM resources WHERE id=?").run(created.item.id);
  assert.equal(
    (await f.call(f.owner.cookie, "sequence-drafts", "POST", input)).status,
    410,
  );
  assert.equal(f.calls(), 1);
  const insert = f.store.db.prepare(
    "INSERT INTO sequence_ai_requests VALUES(?,?,?,?,?)",
  );
  for (let i = 0; i < 29; i++)
    insert.run(
      f.owner.workspaceId,
      f.owner.id,
      randomUUID(),
      "synthetic",
      Date.now(),
    );
  assert.equal(
    (await f.call(f.owner.cookie, "sequence-drafts", "POST", f.input())).status,
    429,
  );
  assert.equal(f.calls(), 1);
});

test("source changes hide previously generated proposals and candidate IDs are excluded from provider context", async (t) => {
  const f = await fixture(t);
  const created = await (
    await f.call(f.owner.cookie, "sequence-workspace", "POST", f.input().draft)
  ).json();
  assert.equal(
    (
      await f.call(f.owner.cookie, "sequence-drafts", "POST", {
        ...f.input(),
        sequenceId: created.item.id,
        revision: created.revision,
      })
    ).status,
    201,
  );
  assert.equal(f.captured().includes("enrolledCandidateIds"), false);
  f.store.update(f.owner.workspaceId, "sequences", {
    ...created.item,
    name: "Edited title",
    updatedAt: new Date().toISOString(),
  });
  const history = await (
    await f.call(
      f.owner.cookie,
      `sequence-drafts?sequenceId=${created.item.id}`,
    )
  ).json();
  assert.equal(history.items[0].sourceCurrent, false);
  assert.equal(history.items[0].result, null);
});
