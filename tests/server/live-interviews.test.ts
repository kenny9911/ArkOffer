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
  deleteFailure = false,
  recordingAvailable = true,
  recordingStopFailure = false,
  recordingStartFailure = false;
const recordingCalls: Array<{
  kind: string;
  sessionId: string;
  consent?: boolean;
}> = [];
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
async function setup(
  policy: "required" | "optional" | "off" = "optional",
  options: {
    followUp?: boolean;
    secondQuestion?: boolean;
    recording?: boolean;
  } = {},
) {
  const id = randomUUID(),
    date = new Date().toISOString(),
    config = newScreeningConfig();
  config.setup.interviewMode = "live";
  config.setup.cameraPolicy = policy;
  config.setup.recordingEnabled = options.recording === true;
  config.context.role = "Private role context";
  config.sections[0].goal = "Private evaluation goal";
  const question = {
    id: randomUUID(),
    prompt: "Describe your experience.",
    type: "text" as const,
    options: [],
    required: true,
    rubric: "Private rubric",
    followUp: options.followUp ?? true,
  };
  config.sections[0].questions.push(question);
  if (options.secondQuestion)
    config.sections[0].questions.push({
      ...question,
      id: randomUUID(),
      prompt: "Describe a second project.",
    });
  store.insert(owner.workspaceId, "screenings", {
    id,
    name: "Interview",
    title: "Interview",
    description: "",
    status: "draft",
    createdAt: date,
    updatedAt: date,
    screeningConfig: config,
    questions: config.sections[0].questions,
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
    questionIds: candidate.item.questions.map(
      (item: { id: string }) => item.id,
    ) as string[],
  };
}
async function start(
  item: { token: string },
  cameraEnabled = true,
  recordingConsent?: true,
) {
  const response = await request(
    `/api/interviews/${item.token}/live/sessions`,
    "POST",
    {
      requestId: randomUUID(),
      consent: true,
      cameraEnabled,
      ...(recordingConsent ? { recordingConsent } : {}),
    },
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
  service = registerLiveInterviews(app, store, {
    env,
    adapter,
    recording: {
      status: () => ({ available: recordingAvailable }),
      async startSession(sessionId, consent) {
        recordingCalls.push({ kind: "start", sessionId, consent });
        calls.push({ kind: "recording-start", room: `screening-${sessionId}` });
        if (recordingStartFailure)
          throw new Error("Synthetic recording failure");
      },
      async stopSession(sessionId) {
        recordingCalls.push({ kind: "stop", sessionId });
        if (recordingStopFailure)
          throw new Error("Synthetic recording stop unavailable");
      },
    },
  });
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

test("adaptive callbacks enforce per-question order and preserve distinct submitted follow-up evidence", async () => {
  const item = await setup("optional", { secondQuestion: true }),
    session = await start(item);
  const dispatch = JSON.parse(
    calls.filter((call) => call.kind === "dispatch").at(-1)!.metadata!,
  );
  assert.equal(dispatch.questions[0].followUp, true);
  assert.equal(dispatch.questions[1].followUp, true);
  let sequence = 0;
  async function emit(
    kind: string,
    text: string,
    expected = 200,
    questionId = item.questionId,
  ) {
    const result = await callback({
      eventId: randomUUID(),
      sessionId: session.id,
      sequence: sequence + 1,
      kind,
      questionId,
      text,
    });
    assert.equal(result.status, expected, await result.text());
    if (expected === 200) sequence++;
  }
  await emit("followup-question", "What did you personally do?", 409);
  await emit("answer", "I built a search service.");
  await emit("answer", "An unexpected second original answer", 409);
  await emit("skip", "skip", 409);
  await emit("followup-question", "x".repeat(601), 409);
  await emit("followup-question", "What did you personally do?");
  // Repeat speaks the same clarification as an ordinary agent event; it cannot
  // create another clarification or move its identity to a different question.
  await emit("agent", "What did you personally do?");
  await emit(
    "followup-answer",
    "Wrong question identity",
    409,
    item.questionIds[1],
  );
  await emit("followup-answer", "I implemented the index.");
  await emit("followup-skip", "skip", 409);
  await emit("followup-question", "An unwanted second follow-up?", 409);
  await emit("answer", "I migrated a database.", 200, item.questionIds[1]);
  await emit(
    "followup-question",
    "What was the outcome?",
    200,
    item.questionIds[1],
  );
  await emit("followup-skip", "skip this question", 200, item.questionIds[1]);
  assert.equal(
    (
      await callback({
        eventId: randomUUID(),
        sessionId: session.id,
        sequence: ++sequence,
        kind: "ended",
      })
    ).status,
    200,
  );
  const submission = {
    candidateName: "Synthetic Candidate",
    email: "candidate@example.com",
    consent: true,
    liveSessionId: session.id,
    answers: [
      {
        questionId: item.questionId,
        value: "I built a search service.\nI implemented the index.",
      },
      { questionId: item.questionIds[1], value: "I migrated a database." },
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
    201,
  );
  const retry = await request(
    `/api/interviews/${item.token}/responses`,
    "POST",
    submission,
  );
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).alreadySubmitted, true);
  const responses = await (
    await request(
      `/api/screenings/${item.id}/responses`,
      "GET",
      undefined,
      owner.cookie,
    )
  ).json();
  const [first, second] = responses.items[0].answers;
  assert.equal(
    first.liveEvidence.originalTranscript,
    submission.answers[0].value,
  );
  assert.equal(first.liveEvidence.candidateEdited, false);
  assert.equal(first.liveEvidence.followUps.length, 1);
  assert.equal(first.liveEvidence.followUps[0].questionId, item.questionId);
  assert.equal(
    first.liveEvidence.followUps[0].question,
    "What did you personally do?",
  );
  assert.equal(
    first.liveEvidence.followUps[0].answer,
    "I implemented the index.",
  );
  assert.equal(first.liveEvidence.followUps[0].skipped, false);
  assert.match(first.liveEvidence.followUps[0].askedAt, /^\d{4}-/);
  assert.match(first.liveEvidence.followUps[0].answeredAt, /^\d{4}-/);
  assert.equal(
    second.liveEvidence.originalTranscript,
    "I migrated a database.",
  );
  assert.equal(second.liveEvidence.followUps.length, 1);
  assert.equal(
    second.liveEvidence.followUps[0].questionId,
    item.questionIds[1],
  );
  assert.equal(second.liveEvidence.followUps[0].answer, null);
  assert.equal(second.liveEvidence.followUps[0].skipped, true);
  // A late event cannot mutate evidence used in a submitted response.
  assert.equal(
    (
      await callback({
        eventId: randomUUID(),
        sessionId: session.id,
        sequence: sequence + 1,
        kind: "followup-answer",
        questionId: item.questionIds[1],
        text: "Late answer",
      })
    ).status,
    409,
  );
  await service.expireSessions();
});

test("published disabled follow-ups stay disabled and do not change legacy answer evidence shape", async () => {
  const item = await setup("optional", { followUp: false }),
    session = await start(item);
  const dispatch = JSON.parse(
    calls.filter((call) => call.kind === "dispatch").at(-1)!.metadata!,
  );
  assert.equal(dispatch.questions[0].followUp, false);
  assert.equal(
    (
      await callback({
        eventId: randomUUID(),
        sessionId: session.id,
        sequence: 1,
        kind: "answer",
        questionId: item.questionId,
        text: "My original answer",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await callback({
        eventId: randomUUID(),
        sessionId: session.id,
        sequence: 2,
        kind: "followup-question",
        questionId: item.questionId,
        text: "A forbidden follow-up?",
      })
    ).status,
    400,
  );
  await request(
    `/api/interviews/${item.token}/live/sessions/${session.id}/end`,
    "POST",
    {},
  );
  const submission = {
    candidateName: "Test",
    email: "candidate@example.com",
    consent: true,
    liveSessionId: session.id,
    answers: [{ questionId: item.questionId, value: "My original answer" }],
  };
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
  const row = store.db
    .prepare("SELECT answers FROM screening_responses WHERE publication_id=?")
    .get(item.publicationId)!;
  assert.equal(
    Object.hasOwn(JSON.parse(String(row.answers))[0].liveEvidence, "followUps"),
    false,
  );
  // A pre-migration response had no live_session_id column value. Its existing
  // answer evidence still identifies the same session during an exact retry.
  store.db
    .prepare(
      "UPDATE screening_responses SET live_session_id=NULL WHERE publication_id=?",
    )
    .run(item.publicationId);
  assert.equal(
    (
      await request(
        `/api/interviews/${item.token}/responses`,
        "POST",
        submission,
      )
    ).status,
    200,
  );
});

test("skipped required questions remain unanswered until manual review and keep their session evidence", async () => {
  const item = await setup(),
    session = await start(item);
  const event = {
    eventId: randomUUID(),
    sessionId: session.id,
    sequence: 1,
    kind: "skip",
    questionId: item.questionId,
    text: "skip this question",
  };
  assert.equal((await callback(event)).status, 200);
  assert.equal((await (await callback(event)).json()).duplicate, true);
  for (const kind of ["skip", "answer", "followup-question"])
    assert.equal(
      (await callback({ ...event, eventId: randomUUID(), sequence: 2, kind }))
        .status,
      409,
    );
  await request(
    `/api/interviews/${item.token}/live/sessions/${session.id}/end`,
    "POST",
    {},
  );
  const submission = {
    candidateName: "Test",
    email: "candidate@example.com",
    consent: true,
    liveSessionId: session.id,
    answers: [{ questionId: item.questionId, value: "" }],
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
  submission.answers[0].value = "My typed response after review";
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
  const response = store.db
    .prepare(
      "SELECT id,answers FROM screening_responses WHERE publication_id=?",
    )
    .get(item.publicationId)!;
  assert.equal(
    Object.hasOwn(JSON.parse(String(response.answers))[0], "liveEvidence"),
    false,
  );
  const review = await (
    await request(
      `/api/screenings/${item.id}/responses/${response.id}/live`,
      "GET",
      undefined,
      owner.cookie,
    )
  ).json();
  assert.equal(review.items.length, 1);
  assert.equal(review.items[0].id, session.id);
  assert.equal(review.items[0].events[0].kind, "skip");
  assert.equal(review.items[0].events[0].text, "skip this question");
});

test("typed-only submitted interviews bind one reviewed session and reject replay with a different or absent recording link", async () => {
  const item = await setup(),
    first = await start(item);
  await request(
    `/api/interviews/${item.token}/live/sessions/${first.id}/end`,
    "POST",
    {},
  );
  const second = await start(item);
  await request(
    `/api/interviews/${item.token}/live/sessions/${second.id}/end`,
    "POST",
    {},
  );
  const submission = {
    candidateName: "Test",
    email: "candidate@example.com",
    consent: true,
    liveSessionId: first.id,
    answers: [{ questionId: item.questionId, value: "Typed answer" }],
  };
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
  const response = store.db
    .prepare(
      "SELECT id,live_session_id FROM screening_responses WHERE publication_id=?",
    )
    .get(item.publicationId)!;
  assert.equal(response.live_session_id, first.id);
  const privatePath = `/api/screenings/${item.id}/responses/${response.id}/live`;
  const review = await (
    await request(privatePath, "GET", undefined, owner.cookie)
  ).json();
  assert.deepEqual(
    review.items.map((item: { id: string }) => item.id),
    [first.id],
  );
  assert.equal(
    (await request(privatePath, "GET", undefined, other.cookie)).status,
    404,
  );
  assert.equal(
    (
      await request(
        `/api/interviews/${item.token}/responses`,
        "POST",
        submission,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await request(`/api/interviews/${item.token}/responses`, "POST", {
        ...submission,
        liveSessionId: second.id,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(`/api/interviews/${item.token}/responses`, "POST", {
        ...submission,
        liveSessionId: undefined,
      })
    ).status,
    409,
  );
});

test("recording requires separate consent and readiness before allocation and starts before agent dispatch", async () => {
  const item = await setup("optional", { recording: true });
  const beforeCreates = calls.filter((call) => call.kind === "create").length;
  const beforeRecordings = recordingCalls.filter(
    (call) => call.kind === "start",
  ).length;
  const body = { requestId: randomUUID(), consent: true, cameraEnabled: true };
  assert.equal(
    (await request(`/api/interviews/${item.token}/live/sessions`, "POST", body))
      .status,
    400,
  );
  assert.equal(
    calls.filter((call) => call.kind === "create").length,
    beforeCreates,
  );
  assert.equal(
    recordingCalls.filter((call) => call.kind === "start").length,
    beforeRecordings,
  );
  recordingAvailable = false;
  try {
    const status = await (
      await request(`/api/interviews/${item.token}/live/status`)
    ).json();
    assert.equal(status.available, false);
    assert.equal(status.recording, true);
    assert.equal(
      (
        await request(`/api/interviews/${item.token}/live/sessions`, "POST", {
          ...body,
          recordingConsent: true,
        })
      ).status,
      503,
    );
    assert.equal(
      calls.filter((call) => call.kind === "create").length,
      beforeCreates,
    );
  } finally {
    recordingAvailable = true;
  }
  const session = await start(item, true, true);
  assert.equal(
    recordingCalls.find(
      (call) => call.kind === "start" && call.sessionId === session.id,
    )?.consent,
    true,
  );
  assert.ok(
    calls.some(
      (call) =>
        call.kind === "dispatch" && call.room === `screening-${session.id}`,
    ),
  );
  assert.ok(
    calls.findIndex(
      (call) =>
        call.kind === "recording-start" &&
        call.room === `screening-${session.id}`,
    ) <
      calls.findIndex(
        (call) =>
          call.kind === "dispatch" && call.room === `screening-${session.id}`,
      ),
  );
  // Stopping capture must not prevent disconnection when its provider fails.
  recordingStopFailure = true;
  try {
    assert.equal(
      (
        await request(
          `/api/interviews/${item.token}/live/sessions/${session.id}/end`,
          "POST",
          {},
        )
      ).status,
      200,
    );
    assert.ok(
      calls.some(
        (call) =>
          call.kind === "delete" && call.room === `screening-${session.id}`,
      ),
    );
    assert.equal(
      store.db
        .prepare("SELECT room_closed FROM screening_live_sessions WHERE id=?")
        .get(session.id)!.room_closed,
      1,
    );
  } finally {
    recordingStopFailure = false;
  }
});

test("recording start failure closes the allocated room and never dispatches the interviewer", async () => {
  const item = await setup("optional", { recording: true });
  recordingStartFailure = true;
  try {
    const result = await request(
      `/api/interviews/${item.token}/live/sessions`,
      "POST",
      {
        requestId: randomUUID(),
        consent: true,
        cameraEnabled: true,
        recordingConsent: true,
      },
    );
    assert.equal(result.status, 502);
    assert.ok(!(await result.text()).includes("Synthetic"));
  } finally {
    recordingStartFailure = false;
  }
  const row = store.db
    .prepare(
      "SELECT id,room_name,state,room_closed FROM screening_live_sessions WHERE publication_id=?",
    )
    .get(item.publicationId)!;
  assert.equal(row.state, "failed");
  assert.ok(
    calls.some((call) => call.kind === "delete" && call.room === row.room_name),
  );
  assert.ok(
    !calls.some(
      (call) => call.kind === "dispatch" && call.room === row.room_name,
    ),
  );
  assert.ok(
    recordingCalls.some(
      (call) => call.kind === "stop" && call.sessionId === row.id,
    ),
  );
  await service.expireSessions();
  assert.equal(
    store.db
      .prepare("SELECT room_closed FROM screening_live_sessions WHERE id=?")
      .get(row.id)!.room_closed,
    1,
  );
});

test("signed speech timing is bounded, speaker-specific, replay-safe and optional for legacy agents", async () => {
  const item = await setup(),
    session = await start(item),
    now = Date.now();
  const event = {
    eventId: randomUUID(),
    sessionId: session.id,
    sequence: 1,
    kind: "answer",
    questionId: item.questionId,
    text: "Actual spoken answer",
    timing: {
      source: "livekit-vad",
      startedAtMs: now - 1000,
      endedAtMs: now - 100,
    },
  };
  for (const timing of [
    { ...event.timing, source: "livekit-playout" },
    { ...event.timing, endedAtMs: now - 2000 },
    { ...event.timing, startedAtMs: now - 100_000 },
    { ...event.timing, endedAtMs: now + 60_000 },
  ])
    assert.equal((await callback({ ...event, timing })).status, 400);
  assert.equal(
    (
      await callback({
        ...event,
        kind: "ready",
        text: undefined,
        questionId: undefined,
      })
    ).status,
    400,
  );
  assert.equal((await callback(event)).status, 200);
  assert.equal((await (await callback(event)).json()).duplicate, true);
  assert.equal(
    (await callback({ ...event, timing: { ...event.timing, endedAtMs: now } }))
      .status,
    409,
  );
  const legacy = {
    eventId: randomUUID(),
    sessionId: session.id,
    sequence: 2,
    kind: "agent",
    questionId: item.questionId,
    text: "A legacy prompt",
  };
  assert.equal((await callback(legacy)).status, 200);
  const data = await (
    await request(`/api/interviews/${item.token}/live/sessions/${session.id}`)
  ).json();
  assert.deepEqual(data.item.events[0].timing, event.timing);
  assert.equal(data.item.events[1].timing, null);
  assert.notEqual(
    data.item.events[0].timing.startedAtMs,
    Date.parse(data.item.events[0].createdAt),
  );
});
