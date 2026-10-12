import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import express from "express";
import { createDatabase, type Store } from "../../server/db.js";
import { hashToken } from "../../server/auth.js";
import { registerScreening } from "../../server/screening.js";
import {
  registerVoiceScreening,
  voiceWavDuration,
} from "../../server/voice-screening.js";

let store: Store, server: Server, base: string, directory: string;
let owner: { cookie: string; workspaceId: string },
  other: { cookie: string; workspaceId: string };
let provider: typeof fetch,
  calls = 0;
let clarify: (input: {
  workspaceId: string;
  question: string;
  answer: string;
  signal: AbortSignal;
}) => Promise<string | null> = async () => null;
const allowed: string[] = [];
const ORIGIN = "http://localhost:5174";
const text =
  "I led research interviews and designed a product onboarding flow.";
function user() {
  const workspaceId = randomUUID(),
    id = randomUUID(),
    token = randomBytes(32).toString("hex"),
    date = new Date().toISOString();
  store.db
    .prepare("INSERT INTO workspaces(id,name,created_at) VALUES(?,?,?)")
    .run(workspaceId, "Hiring Team", date);
  store.db
    .prepare(
      "INSERT INTO users(id,workspace_id,name,email,password_hash,role,created_at) VALUES(?,?,?,?,?,'owner',?)",
    )
    .run(
      id,
      workspaceId,
      "Test User",
      `${id}@example.com`,
      "unused-test-hash",
      date,
    );
  store.db
    .prepare(
      "INSERT INTO sessions(token_hash,user_id,workspace_id,expires_at,created_at) VALUES(?,?,?,?,?)",
    )
    .run(hashToken(token), id, workspaceId, Date.now() + 3600000, date);
  return { workspaceId, cookie: `arkoffer_session=${token}` };
}
function wav(seconds = 1) {
  const result = Buffer.alloc(44 + 32000 * seconds);
  result.write("RIFF", 0);
  result.writeUInt32LE(result.length - 8, 4);
  result.write("WAVEfmt ", 8);
  result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20);
  result.writeUInt16LE(1, 22);
  result.writeUInt32LE(16000, 24);
  result.writeUInt32LE(32000, 28);
  result.writeUInt16LE(2, 32);
  result.writeUInt16LE(16, 34);
  result.write("data", 36);
  result.writeUInt32LE(result.length - 44, 40);
  return result;
}
function request(path: string, method = "GET", data?: unknown, cookie = "") {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      Origin: ORIGIN,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(data ? { "Content-Type": "application/json" } : {}),
    },
    body: data ? JSON.stringify(data) : undefined,
  });
}
async function setup(followUp?: boolean) {
  clarify = async () => null;
  provider = async (url, init) => {
    calls++;
    assert.equal(url, "https://api.openai.com/v1/audio/transcriptions");
    assert.equal(
      (init?.headers as Record<string, string>).Authorization,
      "Bearer test-not-a-real-key",
    );
    const body = init?.body as FormData;
    assert.equal(body.get("model"), "gpt-4o-mini-transcribe");
    assert.equal(body.get("response_format"), "json");
    assert.equal(body.get("prompt"), null);
    return new Response(JSON.stringify({ text }), { status: 200 });
  };
  const id = randomUUID(),
    date = new Date().toISOString();
  store.insert(owner.workspaceId, "screenings", {
    id,
    name: "Voice interview",
    title: "Voice interview",
    createdAt: date,
    updatedAt: date,
    questions: [
      {
        prompt: "Describe relevant experience.",
        type: "text",
        required: true,
        ...(followUp === undefined ? {} : { followUp }),
      },
      { prompt: "Can you use Figma?", type: "yes-no", required: false },
    ],
  });
  const pub = await (
    await request(`/api/screenings/${id}/publish`, "POST", {}, owner.cookie)
  ).json();
  const interview = await (
    await request(`/api/interviews/${pub.item.token}`)
  ).json();
  return {
    id,
    publicationId: pub.item.id as string,
    token: pub.item.token as string,
    questionId: interview.item.questions[0].id as string,
    choiceId: interview.item.questions[1].id as string,
  };
}
function transcribe(
  item: { token: string; questionId: string },
  options: {
    requestId?: string;
    consent?: string;
    buffer?: Buffer;
    mime?: string;
    extra?: boolean;
    parentTurnId?: string;
    signal?: AbortSignal;
  } = {},
) {
  const data = new FormData();
  data.set("questionId", item.questionId);
  data.set("requestId", options.requestId || randomUUID());
  data.set("consent", options.consent ?? "true");
  if (options.parentTurnId) data.set("parentTurnId", options.parentTurnId);
  data.set(
    "audio",
    new Blob([new Uint8Array(options.buffer || wav())], {
      type: options.mime || "audio/wav",
    }),
    "answer.wav",
  );
  if (options.extra) data.set("model", "arbitrary-model");
  return fetch(`${base}/api/interviews/${item.token}/voice/transcriptions`, {
    method: "POST",
    headers: { Origin: ORIGIN },
    body: data,
    signal: options.signal,
  });
}
function answer(
  questionId: string,
  voiceEvidence?: { questionId: string; turnId: string }[],
) {
  return {
    candidateName: "Candidate Example",
    email: "candidate@example.com",
    consent: true,
    answers: [{ questionId, value: "My corrected answer." }],
    ...(voiceEvidence ? { voiceEvidence } : {}),
  };
}
before(async () => {
  directory = mkdtempSync(join(tmpdir(), "arkoffer-voice-test-"));
  store = createDatabase(directory);
  const app = express();
  app.use(express.json());
  app.use("/api", (req, res, next) => {
    if (req.method !== "GET" && req.get("origin") !== ORIGIN) {
      res.status(403).json({ error: "Origin denied" });
      return;
    }
    next();
  });
  registerScreening(app, store);
  registerVoiceScreening(app, store, {
    apiKey: "test-not-a-real-key",
    allowedWorkspaceIds: allowed,
    fetchImpl: (url, init) => provider(url, init),
    generateClarification: (input) => clarify(input),
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}`;
  owner = user();
  other = user();
  allowed.push(owner.workspaceId);
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

test("duration verification rejects forged, unsupported, short and over-limit recordings", () => {
  assert.equal(voiceWavDuration(wav(120)), 120000);
  for (const audio of [wav(0), wav(121), Buffer.from("not WAV")])
    assert.throws(() => voiceWavDuration(audio));
  const forged = wav();
  forged.writeUInt32LE(48000, 24);
  assert.throws(() => voiceWavDuration(forged));
  const trailer = Buffer.concat([wav(), Buffer.from("trailing input")]);
  assert.throws(() => voiceWavDuration(trailer));
});
test("voice is optional and requires an operator workspace allowlist even with a configured API key", async () => {
  const item = await setup();
  assert.equal(
    (await (await request(`/api/interviews/${item.token}/voice`)).json())
      .available,
    true,
  );
  allowed.length = 0;
  const before = calls;
  assert.equal(
    (await (await request(`/api/interviews/${item.token}/voice`)).json())
      .available,
    false,
  );
  assert.equal((await transcribe(item)).status, 503);
  assert.equal(calls, before);
  allowed.push(owner.workspaceId);
});
test("transcribes once, idempotently returns evidence, and publishes original plus corrected transcript only to its workspace", async () => {
  const item = await setup(),
    requestId = randomUUID(),
    before = calls;
  const response = await transcribe(item, { requestId });
  assert.equal(response.status, 201);
  const data = await response.json();
  assert.equal(data.text, text);
  assert.equal(data.durationMs, 1000);
  const repeated = await transcribe(item, { requestId });
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).turnId, data.turnId);
  assert.equal(calls, before + 1);
  const early = await request(
    `/api/screenings/${item.id}/responses`,
    "GET",
    undefined,
    owner.cookie,
  );
  assert.deepEqual((await early.json()).items, []);
  const final = await request(
    `/api/interviews/${item.token}/responses`,
    "POST",
    answer(item.questionId, [
      { questionId: item.questionId, turnId: data.turnId },
    ]),
  );
  assert.equal(final.status, 201);
  const review = await (
    await request(
      `/api/screenings/${item.id}/responses`,
      "GET",
      undefined,
      owner.cookie,
    )
  ).json();
  const evidence = review.items[0].answers[0].voiceEvidence;
  assert.equal(evidence.originalTranscript, text);
  assert.equal(evidence.candidateEdited, true);
  assert.equal(evidence.durationMs, 1000);
  assert.ok(evidence.consentAt);
  assert.equal(
    (await request(`/api/screenings/${item.id}/responses`)).status,
    401,
  );
  assert.equal(
    (
      await request(
        `/api/screenings/${item.id}/responses`,
        "GET",
        undefined,
        other.cookie,
      )
    ).status,
    404,
  );
  const publicData = await (
    await request(`/api/interviews/${item.token}`)
  ).json();
  assert.equal(JSON.stringify(publicData).includes(text), false);
  assert.equal((await transcribe(item)).status, 409);
  const row = store.db
    .prepare("SELECT * FROM screening_voice_turns WHERE id = ?")
    .get(data.turnId)!;
  assert.equal(
    Object.keys(row).some(
      (key) => key.includes("audio") || key.includes("key"),
    ),
    false,
  );
});
test("consent, published text question identity, audio format and strict multipart bounds precede paid calls", async () => {
  const item = await setup(),
    before = calls;
  assert.equal((await transcribe(item, { consent: "false" })).status, 400);
  assert.equal(
    (await transcribe({ ...item, questionId: item.choiceId })).status,
    400,
  );
  assert.equal(
    (await transcribe({ ...item, questionId: randomUUID() })).status,
    400,
  );
  assert.equal((await transcribe(item, { mime: "audio/webm" })).status, 400);
  assert.equal((await transcribe(item, { buffer: wav(121) })).status, 400);
  assert.equal((await transcribe(item, { extra: true })).status, 400);
  assert.equal(calls, before);
});
test("three attempts per question include upstream failures and cannot be bypassed by new request IDs", async () => {
  const item = await setup();
  const before = calls;
  provider = async () => {
    calls++;
    return new Response("private upstream key", { status: 503 });
  };
  for (let i = 0; i < 3; i++) {
    const response = await transcribe(item);
    assert.equal(response.status, 502);
    assert.equal((await response.text()).includes("private upstream"), false);
  }
  assert.equal((await transcribe(item)).status, 429);
  assert.equal(calls, before + 3);
  assert.equal(
    (
      await request(
        `/api/interviews/${item.token}/responses`,
        "POST",
        answer(item.questionId),
      )
    ).status,
    201,
  );
});
test("revoked or expired tokens never call the provider", async () => {
  for (const mode of ["revoke", "expire"]) {
    const item = await setup(),
      before = calls;
    if (mode === "revoke")
      await request(
        `/api/screenings/${item.id}/publications/${item.publicationId}`,
        "DELETE",
        {},
        owner.cookie,
      );
    else
      store.db
        .prepare(
          "UPDATE screening_publications SET expires_at = ? WHERE id = ?",
        )
        .run(Date.now() - 1, item.publicationId);
    assert.equal((await transcribe(item)).status, 404);
    assert.equal(calls, before);
  }
});
test("revocation, completion, deletion and allowlist removal during transcription discard late results", async () => {
  for (const action of ["revoke", "complete", "delete", "allowlist"]) {
    const item = await setup();
    let complete!: (response: Response) => void, entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    provider = async () => {
      entered();
      return new Promise<Response>((resolve) => {
        complete = resolve;
      });
    };
    const pending = transcribe(item);
    await started;
    if (action === "revoke")
      await request(
        `/api/screenings/${item.id}/publications/${item.publicationId}`,
        "DELETE",
        {},
        owner.cookie,
      );
    if (action === "complete")
      await request(
        `/api/interviews/${item.token}/responses`,
        "POST",
        answer(item.questionId),
      );
    if (action === "delete")
      store.db.prepare("DELETE FROM resources WHERE id = ?").run(item.id);
    if (action === "allowlist") allowed.length = 0;
    complete(new Response(JSON.stringify({ text })));
    assert.ok([404, 409].includes((await pending).status));
    assert.equal(
      store.db
        .prepare(
          "SELECT id FROM screening_voice_turns WHERE publication_id = ? AND transcript IS NOT NULL",
        )
        .get(item.publicationId),
      undefined,
    );
    if (action === "allowlist") allowed.push(owner.workspaceId);
  }
});
test("only one transcription can be in flight for a publication, with no duplicate provider spend", async () => {
  const item = await setup();
  let complete!: (response: Response) => void, entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let count = 0;
  provider = async () => {
    count++;
    entered();
    return new Promise<Response>((resolve) => {
      complete = resolve;
    });
  };
  const pending = transcribe(item);
  await started;
  assert.equal((await transcribe(item)).status, 409);
  assert.equal(count, 1);
  complete(new Response(JSON.stringify({ text })));
  assert.equal((await pending).status, 201);
});
test("workspace hourly budget applies across public interview links", async () => {
  const item = await setup();
  const before = calls;
  const statement = store.db.prepare(
    "INSERT INTO screening_voice_turns(id,publication_id,workspace_id,question_id,request_id,state,duration_ms,created_at,consent_at) VALUES(?,?,?,?,?,'failed',1000,?,?)",
  );
  const ids: string[] = [];
  for (let i = 0; i < 120; i++) {
    const id = randomUUID();
    ids.push(id);
    statement.run(
      id,
      item.publicationId,
      owner.workspaceId,
      randomUUID(),
      randomUUID(),
      Date.now(),
      new Date().toISOString(),
    );
  }
  const otherLink = await setup();
  assert.equal((await transcribe(otherLink)).status, 429);
  assert.equal(calls, before);
  for (const id of ids)
    store.db.prepare("DELETE FROM screening_voice_turns WHERE id = ?").run(id);
});
test("voice evidence cannot be forged or borrowed from another candidate link", async () => {
  const first = await setup(),
    second = await setup();
  const data = await (await transcribe(first)).json();
  assert.equal(
    (
      await request(
        `/api/interviews/${second.token}/responses`,
        "POST",
        answer(second.questionId, [
          { questionId: second.questionId, turnId: data.turnId },
        ]),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await request(
        `/api/interviews/${second.token}/responses`,
        "POST",
        answer(second.questionId, [
          { questionId: second.questionId, turnId: randomUUID() },
        ]),
      )
    ).status,
    400,
  );
});
test("empty, invalid and oversized provider output fail without persisting fabricated evidence", async () => {
  for (const result of [
    JSON.stringify({ text: "" }),
    "not JSON",
    JSON.stringify({ text: "a".repeat(10001) }),
    "x".repeat(70000),
  ]) {
    const item = await setup();
    provider = async () => new Response(result);
    assert.equal((await transcribe(item)).status, 502);
    assert.equal(
      store.db
        .prepare(
          "SELECT id FROM screening_voice_turns WHERE publication_id = ? AND transcript IS NOT NULL",
        )
        .get(item.publicationId),
      undefined,
    );
  }
});

test("one bounded optional clarification links its spoken answer and cannot become an unbounded dialogue", async () => {
  const item = await setup();
  let generated = 0;
  clarify = async (input) => {
    generated++;
    assert.equal(input.workspaceId, owner.workspaceId);
    assert.equal(input.question, "Describe relevant experience.");
    assert.equal(input.answer, text);
    return "What did you learn from those research interviews?";
  };
  const first = await (await transcribe(item)).json();
  assert.equal(
    first.followup,
    "What did you learn from those research interviews?",
  );
  const next = await transcribe(item, { parentTurnId: first.turnId });
  assert.equal(next.status, 201);
  const second = await next.json();
  assert.equal(second.followup, null);
  assert.equal(second.followupAnswered, first.followup);
  assert.ok(second.text.includes(`Follow-up: ${first.followup}`));
  assert.equal(second.durationMs, 2000);
  assert.equal(generated, 1);
  assert.equal(
    (await transcribe(item, { parentTurnId: first.turnId })).status,
    409,
  );
  assert.equal(
    (await transcribe(item, { parentTurnId: second.turnId })).status,
    400,
  );
  const final = await request(
    `/api/interviews/${item.token}/responses`,
    "POST",
    answer(item.questionId, [
      { questionId: item.questionId, turnId: second.turnId },
    ]),
  );
  assert.equal(final.status, 201);
  const review = await (
    await request(
      `/api/screenings/${item.id}/responses`,
      "GET",
      undefined,
      owner.cookie,
    )
  ).json();
  assert.equal(
    review.items[0].answers[0].voiceEvidence.originalTranscript,
    second.text,
  );
});
test("clarification failures and oversized output preserve useful transcription without invented follow-ups", async () => {
  for (const mode of ["error", "oversized"]) {
    const item = await setup();
    clarify = async () => {
      if (mode === "error") throw new Error("private provider detail");
      return "x".repeat(2001);
    };
    const response = await transcribe(item);
    assert.equal(response.status, 201);
    const data = await response.json();
    assert.equal(data.text, text);
    assert.equal(data.followup, null);
  }
});
test("revoking the link while clarification is in flight prevents late evidence persistence", async () => {
  const item = await setup();
  let complete!: (value: string) => void, entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  clarify = async () => {
    entered();
    return new Promise((resolve) => {
      complete = resolve;
    });
  };
  const pending = transcribe(item);
  await started;
  await request(
    `/api/screenings/${item.id}/publications/${item.publicationId}`,
    "DELETE",
    {},
    owner.cookie,
  );
  complete("Could you give an example?");
  assert.equal((await pending).status, 404);
  assert.equal(
    store.db
      .prepare(
        "SELECT id FROM screening_voice_turns WHERE publication_id = ? AND transcript IS NOT NULL",
      )
      .get(item.publicationId),
    undefined,
  );
});

test("disconnecting a recording aborts provider work and releases its pending reservation", async () => {
  const item = await setup();
  let entered!: () => void, aborted!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const stopped = new Promise<void>((resolve) => {
    aborted = resolve;
  });
  provider = async (_url, init) => {
    entered();
    return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener(
        "abort",
        () => {
          aborted();
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });
  };
  const controller = new AbortController();
  const pending = transcribe(item, { signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(pending);
  await stopped;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    store.db
      .prepare(
        "SELECT id FROM screening_voice_turns WHERE publication_id = ? AND (state = 'pending' OR transcript IS NOT NULL)",
      )
      .get(item.publicationId),
    undefined,
  );
});

test("published follow-up opt-out transcribes evidence without calling the clarification model", async () => {
  const item = await setup(false);
  let generated = 0;
  clarify = async () => {
    generated++;
    return "Should not be generated";
  };
  const response = await transcribe(item);
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.followup, null);
  assert.equal(body.text, text);
  assert.equal(generated, 0);
});
