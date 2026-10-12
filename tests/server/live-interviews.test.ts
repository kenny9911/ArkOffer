import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import express from "express";
import { createDatabase, type Store } from "../../server/db.js";
import { hashToken } from "../../server/auth.js";
import { registerScreening } from "../../server/screening.js";
import {
  registerLiveInterviewCallbacks,
  registerLiveInterviews,
  liveInterviewStatus,
  type LiveInterviewAdapter,
} from "../../server/live-interviews.js";
import { newScreeningConfig } from "../../shared/screening.js";
let store: Store,
  server: Server,
  directory: string,
  base: string,
  service: ReturnType<typeof registerLiveInterviews>;
let owner: { cookie: string; workspaceId: string },
  other: { cookie: string; workspaceId: string };
const secret = "synthetic-callback-secret-for-tests-only";
const env: NodeJS.ProcessEnv = {
  LIVEKIT_URL: "wss://test.livekit.cloud",
  LIVEKIT_API_KEY: "test-key",
  LIVEKIT_API_SECRET: "test-secret",
  LIVEKIT_AGENT_CALLBACK_SECRET: secret,
  INTERVIEW_ENGINE_AGENT_NAME: "test-agent",
  APP_ORIGIN: "https://arkoffer.example",
  LLM_PROVIDER: "openrouter",
  OPENROUTER_API_KEY: "synthetic-key",
  LLM_MODEL: "configured-model",
};
const calls: {
  kind: string;
  room: string;
  metadata?: string;
  camera?: boolean;
}[] = [];
let createFailure = false,
  deleteFailure = false;
const adapter: LiveInterviewAdapter = {
  async createRoom(room) {
    calls.push({ kind: "create", room });
    if (createFailure) throw new Error("Synthetic unavailable");
  },
  async dispatch(room, agent, metadata) {
    assert.equal(agent, "test-agent");
    calls.push({ kind: "dispatch", room, metadata });
  },
  async deleteRoom(room) {
    calls.push({ kind: "delete", room });
    if (deleteFailure) throw new Error("Synthetic temporary delete failure");
  },
  async token(room, identity, camera) {
    assert.match(identity, /^candidate-/);
    calls.push({ kind: "token", room, camera });
    return "synthetic-token";
  },
};
function user() {
  const workspaceId = randomUUID(),
    id = randomUUID(),
    token = randomBytes(32).toString("hex"),
    date = new Date().toISOString();
  store.db
    .prepare("INSERT INTO workspaces(id,name,created_at) VALUES(?,?,?)")
    .run(workspaceId, "Test Team", date);
  store.db
    .prepare(
      "INSERT INTO users(id,workspace_id,name,email,password_hash,role,created_at) VALUES(?,?,?,?,?,'owner',?)",
    )
    .run(id, workspaceId, "Test User", `${id}@example.com`, "unused", date);
  store.db
    .prepare(
      "INSERT INTO sessions(token_hash,user_id,workspace_id,expires_at,created_at) VALUES(?,?,?,?,?)",
    )
    .run(hashToken(token), id, workspaceId, Date.now() + 3600000, date);
  return { workspaceId, cookie: `arkoffer_session=${token}` };
}
function request(path: string, method = "GET", data?: unknown, cookie = "") {
  return fetch(base + path, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(data === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
}
async function setup(policy: "required" | "optional" | "off" = "optional") {
  const id = randomUUID(),
    date = new Date().toISOString(),
    config = newScreeningConfig();
  config.setup.interviewMode = "live";
  config.setup.cameraPolicy = policy;
  config.context.role = "Private role context";
  config.sections[0].goal = "Private evaluation goal";
  const question = {
    id: randomUUID(),
    prompt: "Describe your experience.",
    type: "text" as const,
    options: [],
    required: true,
    rubric: "Private rubric",
    followUp: true,
  };
  config.sections[0].questions.push(question);
  store.insert(owner.workspaceId, "screenings", {
    id,
    name: "Interview",
    title: "Interview",
    description: "",
    status: "draft",
    createdAt: date,
    updatedAt: date,
    screeningConfig: config,
    questions: [question],
  });
  const published = await (
    await request(`/api/screenings/${id}/publish`, "POST", {}, owner.cookie)
  ).json();
  assert.ok(published.item?.token, JSON.stringify(published));
  const candidate = await (
    await request(`/api/interviews/${published.item.token}`)
  ).json();
  return {
    id,
    token: published.item.token as string,
    publicationId: published.item.id as string,
    questionId: candidate.item.questions[0].id as string,
  };
}
async function start(item: { token: string }, cameraEnabled = true) {
  const response = await request(
    `/api/interviews/${item.token}/live/sessions`,
    "POST",
    { requestId: randomUUID(), consent: true, cameraEnabled },
  );
  const data = await response.json();
  assert.equal(response.status, 201, JSON.stringify(data));
  return data.item as { id: string; events: unknown[]; state: string };
}
async function callback(
  input: Record<string, unknown>,
  timestamp = String(Date.now()),
  key = secret,
) {
  const body = JSON.stringify(input),
    signature = createHmac("sha256", key)
      .update(`${timestamp}.${body}`)
      .digest("hex");
  return fetch(base + "/api/live-interviews/callback", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-ArkOffer-Timestamp": timestamp,
      "X-ArkOffer-Signature": signature,
    },
    body,
  });
}
before(async () => {
  directory = mkdtempSync(join(tmpdir(), "arkoffer-live-"));
  store = createDatabase(directory);
  owner = user();
  other = user();
  env.LLM_WORKSPACE_IDS = owner.workspaceId;
  const app = express();
  registerLiveInterviewCallbacks(app, store, { env });
  app.use(express.json());
  registerScreening(app, store);
  service = registerLiveInterviews(app, store, { env, adapter });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => {
  await service.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.db.close();
  rmSync(directory, { recursive: true, force: true });
});
test("capabilities are honest, workspace-scoped, and expose no secrets", async () => {
  assert.equal(liveInterviewStatus(owner.workspaceId, env).available, true);
  assert.equal(liveInterviewStatus(other.workspaceId, env).available, false);
  assert.equal(
    liveInterviewStatus(owner.workspaceId, { ...env, LIVEKIT_API_KEY: "" })
      .available,
    false,
  );
  const response = await request(
    "/api/live-interviews/status",
    "GET",
    undefined,
    owner.cookie,
  );
  const data = await response.json();
  assert.equal(data.recording, false);
  assert.equal(data.available, true);
  assert.ok(!JSON.stringify(data).includes("synthetic-key"));
  assert.equal((await request("/api/live-interviews/status")).status, 401);
});
test("join consent, camera policy, publication and single active session enforced", async () => {
  const item = await setup("required");
  assert.equal(
    (
      await request(`/api/interviews/${item.token}/live/sessions`, "POST", {
        requestId: randomUUID(),
        consent: false,
        cameraEnabled: true,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(`/api/interviews/${item.token}/live/sessions`, "POST", {
        requestId: randomUUID(),
        consent: true,
        cameraEnabled: false,
      })
    ).status,
    400,
  );
  const session = await start(item);
  assert.equal(
    (
      await request(`/api/interviews/${item.token}/live/sessions`, "POST", {
        requestId: randomUUID(),
        consent: true,
        cameraEnabled: true,
      })
    ).status,
    409,
  );
  const dispatch = calls.filter((call) => call.kind === "dispatch").at(-1)!;
  assert.ok(!dispatch.metadata?.includes("Private"));
  assert.ok(!dispatch.metadata?.includes("rubric"));
  assert.ok(dispatch.metadata?.includes(item.questionId));
  await request(
    `/api/interviews/${item.token}/live/sessions/${session.id}/end`,
    "POST",
    {},
  );
});
test("callback authentication, event replay, order, and question identities are enforced", async () => {
  const item = await setup(),
    session = await start(item);
  const event = {
    eventId: randomUUID(),
    sessionId: session.id,
    sequence: 1,
    kind: "ready",
  };
  assert.equal(
    (await callback(event, String(Date.now() - 360000))).status,
    401,
  );
  assert.equal(
    (await callback(event, String(Date.now()), "invalid-secret")).status,
    401,
  );
  assert.equal((await callback(event)).status, 200);
  assert.equal((await (await callback(event)).json()).duplicate, true);
  assert.equal((await callback({ ...event, kind: "ended" })).status, 409);
  assert.equal(
    (
      await callback({
        eventId: randomUUID(),
        sessionId: session.id,
        sequence: 3,
        kind: "answer",
        questionId: item.questionId,
        text: "Test",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await callback({
        eventId: randomUUID(),
        sessionId: session.id,
        sequence: 2,
        kind: "answer",
        questionId: randomUUID(),
        text: "Test",
      })
    ).status,
    400,
  );
  await request(
    `/api/interviews/${item.token}/live/sessions/${session.id}/end`,
    "POST",
    {},
  );
});
test("only signed original transcripts become evidence, candidate manually corrects and submits", async () => {
  const item = await setup(),
    session = await start(item);
  assert.equal(
    (
      await callback({
        eventId: randomUUID(),
        sessionId: session.id,
        sequence: 1,
        kind: "answer",
        questionId: item.questionId,
        text: "I led a team of fore people.",
      })
    ).status,
    200,
  );
  const submission = {
    candidateName: "Test Candidate",
    email: "candidate@example.com",
    consent: true,
    liveSessionId: session.id,
    answers: [
      { questionId: item.questionId, value: "I led a team of four people." },
    ],
  };
  assert.equal(
    (
      await request(
        `/api/interviews/${item.token}/responses`,
        "POST",
        submission,
      )
    ).status,
    400,
  );
  await request(
    `/api/interviews/${item.token}/live/sessions/${session.id}/end`,
    "POST",
    {},
  );
  assert.equal(
    (
      await request(
        `/api/interviews/${item.token}/responses`,
        "POST",
        submission,
      )
    ).status,
    201,
  );
  const responses = await (
    await request(
      `/api/screenings/${item.id}/responses`,
      "GET",
      undefined,
      owner.cookie,
    )
  ).json();
  const answer = responses.items[0].answers[0];
  assert.equal(answer.value, submission.answers[0].value);
  assert.equal(
    answer.liveEvidence.originalTranscript,
    "I led a team of fore people.",
  );
  assert.equal(answer.liveEvidence.candidateEdited, true);
  const privatePath = `/api/screenings/${item.id}/responses/${responses.items[0].id}/live`;
  assert.equal((await request(privatePath)).status, 401);
  assert.equal(
    (await request(privatePath, "GET", undefined, other.cookie)).status,
    404,
  );
  assert.equal(
    (await request(privatePath, "GET", undefined, owner.cookie)).status,
    200,
  );
});
test("foreign sessions cannot be read, ended or attached to another publication", async () => {
  const first = await setup(),
    second = await setup(),
    session = await start(first);
  assert.equal(
    (
      await request(
        `/api/interviews/${second.token}/live/sessions/${session.id}`,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await request(
        `/api/interviews/${second.token}/live/sessions/${session.id}/end`,
        "POST",
        {},
      )
    ).status,
    404,
  );
  await request(
    `/api/interviews/${first.token}/live/sessions/${session.id}/end`,
    "POST",
    {},
  );
  assert.equal(
    (
      await request(`/api/interviews/${second.token}/responses`, "POST", {
        candidateName: "Test",
        email: "test@example.com",
        consent: true,
        liveSessionId: session.id,
        answers: [{ questionId: second.questionId, value: "Test" }],
      })
    ).status,
    400,
  );
});
test("revocation closes active room and rejects callbacks and new tokens", async () => {
  const item = await setup(),
    session = await start(item);
  await request(
    `/api/screenings/${item.id}/publications/${item.publicationId}`,
    "DELETE",
    undefined,
    owner.cookie,
  );
  assert.equal(
    (
      await callback({
        eventId: randomUUID(),
        sessionId: session.id,
        sequence: 1,
        kind: "ready",
      })
    ).status,
    404,
  );
  await service.expireSessions();
  assert.equal(
    store.db
      .prepare("SELECT state FROM screening_live_sessions WHERE id=?")
      .get(session.id)!.state,
    "ended",
  );
  assert.equal(
    (await request(`/api/interviews/${item.token}/live/status`)).status,
    404,
  );
});
test("provider failures close rooms without exposing provider errors", async () => {
  const item = await setup();
  createFailure = true;
  try {
    const response = await request(
      `/api/interviews/${item.token}/live/sessions`,
      "POST",
      { requestId: randomUUID(), consent: true, cameraEnabled: true },
    );
    assert.equal(response.status, 502);
    assert.ok(!(await response.text()).includes("Synthetic"));
  } finally {
    createFailure = false;
  }
  const row = store.db
    .prepare("SELECT state FROM screening_live_sessions WHERE publication_id=?")
    .get(item.publicationId)!;
  assert.equal(row.state, "failed");
});
test("camera-off token grants audio only and retries keep one room", async () => {
  const item = await setup("off"),
    requestId = randomUUID(),
    body = { requestId, consent: true, cameraEnabled: false };
  const first = await (
    await request(`/api/interviews/${item.token}/live/sessions`, "POST", body)
  ).json();
  const retry = await (
    await request(`/api/interviews/${item.token}/live/sessions`, "POST", body)
  ).json();
  assert.equal(first.item.id, retry.item.id);
  assert.equal(
    calls.filter((call) => call.kind === "token").at(-1)?.camera,
    false,
  );
  await request(
    `/api/interviews/${item.token}/live/sessions/${first.item.id}/end`,
    "POST",
    {},
  );
});

test("resource cascade retains a durable remote-room cleanup record", async () => {
  const item = await setup(),
    session = await start(item);
  const room = String(
    store.db
      .prepare("SELECT room_name FROM screening_live_sessions WHERE id=?")
      .get(session.id)!.room_name,
  );
  store.db.prepare("DELETE FROM resources WHERE id=?").run(item.id);
  assert.equal(
    store.db
      .prepare("SELECT id FROM screening_live_sessions WHERE id=?")
      .get(session.id),
    undefined,
  );
  assert.ok(
    store.db
      .prepare(
        "SELECT room_name FROM screening_live_room_cleanup WHERE room_name=?",
      )
      .get(room),
  );
  deleteFailure = true;
  try {
    await service.expireSessions();
    assert.ok(
      store.db
        .prepare(
          "SELECT room_name FROM screening_live_room_cleanup WHERE room_name=?",
        )
        .get(room),
    );
  } finally {
    deleteFailure = false;
  }
  await service.expireSessions();
  assert.equal(
    store.db
      .prepare(
        "SELECT room_name FROM screening_live_room_cleanup WHERE room_name=?",
      )
      .get(room),
    undefined,
  );
  assert.ok(calls.some((call) => call.kind === "delete" && call.room === room));
});
test("failed remote deletion remains pending after ended callbacks and retries", async () => {
  const item = await setup(),
    session = await start(item);
  assert.equal(
    (
      await callback({
        eventId: randomUUID(),
        sessionId: session.id,
        sequence: 1,
        kind: "ended",
      })
    ).status,
    200,
  );
  deleteFailure = true;
  try {
    const response = await request(
      `/api/interviews/${item.token}/live/sessions/${session.id}/end`,
      "POST",
      {},
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).cleanupPending, true);
    assert.equal(
      store.db
        .prepare("SELECT room_closed FROM screening_live_sessions WHERE id=?")
        .get(session.id)!.room_closed,
      0,
    );
  } finally {
    deleteFailure = false;
  }
  await service.expireSessions();
  assert.equal(
    store.db
      .prepare("SELECT room_closed FROM screening_live_sessions WHERE id=?")
      .get(session.id)!.room_closed,
    1,
  );
});
test("agent readiness timeout stops an unattended room and preserves recovery metadata", async () => {
  const item = await setup(),
    session = await start(item);
  store.db
    .prepare("UPDATE screening_live_sessions SET created_at=? WHERE id=?")
    .run(new Date(Date.now() - 61_000).toISOString(), session.id);
  await service.expireSessions();
  assert.equal(
    store.db
      .prepare("SELECT state FROM screening_live_sessions WHERE id=?")
      .get(session.id)!.state,
    "ended",
  );
  const status = await (
    await request(`/api/interviews/${item.token}/live/status`)
  ).json();
  assert.equal(status.previousSession.id, session.id);
  assert.equal(status.previousSession.state, "ended");
});
