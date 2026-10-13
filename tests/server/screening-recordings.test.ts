import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { Server } from "node:http";
import express from "express";
import { EgressClient, EgressInfo } from "livekit-server-sdk";
import { S3Client } from "@aws-sdk/client-s3";
import { createDatabase, type Store } from "../../server/db.js";
import { hashToken } from "../../server/auth.js";
import { registerScreening } from "../../server/screening.js";
import { registerLiveInterviews } from "../../server/live-interviews.js";
import {
  createRecordingAdapter,
  registerScreeningRecordings,
  screeningRecordingStatus,
  type RecordingAdapter,
  type RecordingJob,
} from "../../server/screening-recordings.js";

let store: Store,
  server: Server,
  base: string,
  dir: string,
  service: ReturnType<typeof registerScreeningRecordings>;
let owner: ReturnType<typeof user>,
  outsider: ReturnType<typeof user>,
  member: ReturnType<typeof user>;
let time = Date.now(),
  failStart = false,
  failDelete = false,
  pauseStart: (() => Promise<void>) | undefined,
  pauseRead: (() => void) | undefined;
let lastBody: Readable | undefined;
const jobs = new Map<string, RecordingJob>();
const calls: { kind: string; room?: string; key?: string; range?: string }[] =
  [];
const env: NodeJS.ProcessEnv = {
  LIVEKIT_URL: "wss://test.livekit.cloud",
  LIVEKIT_API_KEY: "synthetic-key",
  LIVEKIT_API_SECRET: "synthetic-secret",
  S3_BUCKET: "private-screenings",
  S3_REGION: "us-east-1",
  S3_ENDPOINT: "https://storage.example",
  S3_ACCESS_KEY_ID: "synthetic-access",
  S3_SECRET_ACCESS_KEY: "synthetic-storage-secret",
};
const adapter: RecordingAdapter = {
  async start(room, target) {
    calls.push({ kind: "start", room, key: target.key });
    if (pauseStart) await pauseStart();
    if (failStart) throw new Error("Synthetic ambiguous timeout");
    const result = {
      id: randomUUID(),
      room,
      status: 1,
      key: target.key,
      size: 0,
      duration: 0,
    };
    jobs.set(room, result);
    return result;
  },
  async list(room) {
    calls.push({ kind: "list", room });
    return jobs.has(room) ? [{ ...jobs.get(room)! }] : [];
  },
  async stop(id) {
    const result = [...jobs.values()].find((item) => item.id === id)!;
    calls.push({ kind: "stop", room: result.room });
    result.status = 3;
    result.size = 10;
    result.duration = 12;
    return { ...result };
  },
  async remove(target) {
    calls.push({ kind: "delete", key: target.key });
    if (failDelete) throw new Error("Synthetic storage outage");
  },
  async read(target, range) {
    calls.push({ kind: "read", key: target.key, range });
    pauseRead?.();
    lastBody = Readable.from(range ? "0123" : "0123456789");
    return {
      body: lastBody,
      length: range ? 4 : 10,
      range: range ? "bytes 0-3/10" : undefined,
    };
  },
};
function user(workspaceId = randomUUID(), role = "owner") {
  const id = randomUUID(),
    token = randomBytes(32).toString("hex"),
    date = new Date().toISOString();
  store.db
    .prepare(
      "INSERT OR IGNORE INTO workspaces(id,name,created_at) VALUES(?,?,?)",
    )
    .run(workspaceId, "Synthetic team", date);
  store.db
    .prepare(
      "INSERT INTO users(id,workspace_id,name,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?,?)",
    )
    .run(
      id,
      workspaceId,
      "Synthetic reviewer",
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
  return { id, workspaceId, cookie: `arkoffer_session=${token}` };
}
function request(
  path: string,
  method = "GET",
  cookie = owner.cookie,
  headers: Record<string, string> = {},
) {
  return fetch(base + path, {
    method,
    headers: { Cookie: cookie, ...headers },
  });
}
function setup(recordingEnabled = true, retentionDays = 30) {
  const id = randomUUID(),
    publicationId = randomUUID(),
    sessionId = randomUUID(),
    date = new Date(time).toISOString(),
    room = `screening-${sessionId}`,
    token = randomBytes(32).toString("hex");
  store.insert(owner.workspaceId, "screenings", {
    id,
    name: "Synthetic screening",
    title: "Synthetic screening",
    status: "draft",
    createdAt: date,
    updatedAt: date,
  });
  store.db
    .prepare(
      "INSERT INTO screening_publications(id,screening_id,workspace_id,token_hash,snapshot,expires_at,created_at) VALUES(?,?,?,?,?,?,?)",
    )
    .run(
      publicationId,
      id,
      owner.workspaceId,
      hashToken(token),
      JSON.stringify({
        title: "Synthetic screening",
        setup: {
          interviewMode: "live",
          recordingEnabled,
          recordingRetentionDays: retentionDays,
        },
        questions: [],
      }),
      time + 3600000,
      date,
    );
  store.db
    .prepare(
      "INSERT INTO screening_live_sessions(id,publication_id,workspace_id,room_name,request_id,state,expires_at,created_at,consent_at) VALUES(?,?,?,?,?,'active',?,?,?)",
    )
    .run(
      sessionId,
      publicationId,
      owner.workspaceId,
      room,
      randomUUID(),
      time + 1800000,
      date,
      date,
    );
  return { id, publicationId, sessionId, room, token };
}
function submit(item: ReturnType<typeof setup>, attach = true) {
  const responseId = randomUUID(),
    date = new Date(time).toISOString();
  store.db
    .prepare(
      "INSERT INTO screening_responses(id,publication_id,screening_id,workspace_id,candidate_name,email,answers,submitted_at,consent_at,submission_hash) VALUES(?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      responseId,
      item.publicationId,
      item.id,
      owner.workspaceId,
      "Synthetic candidate",
      "candidate@example.com",
      JSON.stringify(
        attach
          ? [
              {
                questionId: randomUUID(),
                value: "An answer",
                liveEvidence: { sessionId: item.sessionId },
              },
            ]
          : [],
      ),
      date,
      date,
      "hash",
    );
  return `/api/screenings/${item.id}/responses/${responseId}/recordings`;
}
before(async () => {
  dir = mkdtempSync(join(tmpdir(), "arkoffer-recording-"));
  store = createDatabase(dir);
  owner = user();
  outsider = user();
  member = user(owner.workspaceId, "member");
  env.LIVEKIT_WORKSPACE_IDS = owner.workspaceId;
  const app = express();
  app.use(express.json());
  registerScreening(app, store);
  registerLiveInterviews(app, store, { env });
  service = registerScreeningRecordings(app, store, {
    env,
    adapter,
    now: () => time,
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => {
  await service.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("recording readiness uses existing keys, secure endpoints and workspace allowlist without returning secrets", async () => {
  assert.equal(
    screeningRecordingStatus(owner.workspaceId, env).available,
    true,
  );
  assert.equal(
    screeningRecordingStatus(outsider.workspaceId, env).available,
    false,
  );
  assert.equal(
    screeningRecordingStatus(owner.workspaceId, {
      ...env,
      S3_ENDPOINT: "http://storage.example",
    }).available,
    false,
  );
  assert.equal(
    screeningRecordingStatus(owner.workspaceId, {
      ...env,
      S3_SECRET_ACCESS_KEY: "",
    }).available,
    false,
  );
  assert.equal(
    (await request("/api/screening-recordings/status", "GET", "")).status,
    401,
  );
  const result = await (
    await request("/api/screening-recordings/status")
  ).text();
  assert.ok(!result.includes("synthetic"));
  assert.equal(JSON.parse(result).available, true);
});
test("recording is opt-in and requires separate explicit consent before any provider call", async () => {
  const disabled = setup(false),
    enabled = setup();
  assert.equal(await service.startSession(disabled.sessionId, false), null);
  const before = calls.filter((call) => call.kind === "start").length;
  await assert.rejects(
    service.startSession(enabled.sessionId, false),
    /explicit consent/,
  );
  assert.equal(calls.filter((call) => call.kind === "start").length, before);
  const result = await service.startSession(enabled.sessionId, true);
  assert.ok(result?.id);
  const same = await service.startSession(enabled.sessionId, true);
  assert.equal(same?.id, result.id);
  assert.equal(
    calls.filter((call) => call.kind === "start" && call.room === enabled.room)
      .length,
    1,
  );
});
test("a timed-out start remains unknown and never automatically starts a duplicate", async () => {
  const item = setup();
  failStart = true;
  try {
    await assert.rejects(
      service.startSession(item.sessionId, true),
      /not be retried/,
    );
  } finally {
    failStart = false;
  }
  await assert.rejects(
    service.startSession(item.sessionId, true),
    /second recording/,
  );
  await service.tick();
  assert.equal(
    calls.filter((call) => call.kind === "start" && call.room === item.room)
      .length,
    1,
  );
  const row = store.db
    .prepare("SELECT * FROM screening_recordings WHERE session_id=?")
    .get(item.sessionId)!;
  jobs.set(item.room, {
    id: randomUUID(),
    room: item.room,
    status: 1,
    key: String(row.object_key),
    size: 0,
    duration: 0,
  });
  await service.tick();
  assert.equal(
    store.db
      .prepare("SELECT state FROM screening_recordings WHERE id=?")
      .get(row.id)!.state,
    "ready",
  );
  assert.ok(
    calls.some((call) => call.kind === "stop" && call.room === item.room),
  );
});
test("provider completion is reconciled only for the expected private object", async () => {
  const item = setup();
  await service.startSession(item.sessionId, true);
  Object.assign(jobs.get(item.room)!, {
    status: 3,
    size: 10,
    key: "someone-elses-object.mp4",
  });
  await service.tick();
  assert.equal(
    store.db
      .prepare("SELECT state FROM screening_recordings WHERE session_id=?")
      .get(item.sessionId)!.state,
    "failed",
  );
});
test("private playback is response-bound, authenticated, range-capable and has no exposed storage URLs", async () => {
  const item = setup(),
    recording = await service.startSession(item.sessionId, true);
  await service.stopSession(item.sessionId);
  const path = submit(item);
  assert.equal((await request(path, "GET", "")).status, 401);
  assert.equal((await request(path, "GET", outsider.cookie)).status, 404);
  const list = await (await request(path)).json();
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].playable, true);
  assert.ok(!JSON.stringify(list).includes("private-screenings"));
  assert.ok(!JSON.stringify(list).includes("storage.example"));
  assert.ok(!JSON.stringify(list).includes("object_key"));
  const response = await request(
    `${path}/${recording!.id}/media`,
    "GET",
    owner.cookie,
    { Range: "bytes=0-3" },
  );
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 0-3/10");
  assert.match(response.headers.get("cache-control")!, /no-store/);
  assert.equal(await response.text(), "0123");
  const download = await request(`${path}/${recording!.id}/media?download=1`);
  assert.match(download.headers.get("content-disposition")!, /^attachment/);
  await download.arrayBuffer();
  assert.equal(
    (
      await request(`${path}/${recording!.id}/media`, "GET", owner.cookie, {
        Range: "bytes=0-3,5-7",
      })
    ).status,
    416,
  );
  assert.equal(
    (await request(`${path}/${recording!.id}/media`, "GET", outsider.cookie))
      .status,
    404,
  );
});
test("abandoned recording attempts are excluded from the submitted response", async () => {
  const item = setup(),
    recording = await service.startSession(item.sessionId, true);
  await service.stopSession(item.sessionId);
  const path = submit(item, false);
  assert.deepEqual((await (await request(path)).json()).items, []);
  assert.equal((await request(`${path}/${recording!.id}/media`)).status, 404);
});
test("an explicitly submitted live session remains reviewable when all final answers were typed", async () => {
  const item = setup();
  await service.startSession(item.sessionId, true);
  await service.stopSession(item.sessionId);
  const path = submit(item, false);
  store.db
    .prepare(
      "UPDATE screening_responses SET live_session_id=? WHERE publication_id=?",
    )
    .run(item.sessionId, item.publicationId);
  assert.equal((await (await request(path)).json()).items.length, 1);
});
test("membership loss during a storage read prevents bytes from being returned", async () => {
  const item = setup(),
    recording = await service.startSession(item.sessionId, true);
  await service.stopSession(item.sessionId);
  const path = submit(item);
  pauseRead = () =>
    store.db
      .prepare(
        "UPDATE memberships SET status='suspended' WHERE user_id=? AND workspace_id=?",
      )
      .run(member.id, owner.workspaceId);
  try {
    assert.equal(
      (await request(`${path}/${recording!.id}/media`, "GET", member.cookie))
        .status,
      401,
    );
    assert.equal(lastBody?.destroyed, true);
  } finally {
    pauseRead = undefined;
    store.db
      .prepare(
        "UPDATE memberships SET status='active' WHERE user_id=? AND workspace_id=?",
      )
      .run(member.id, owner.workspaceId);
  }
});
test("delete is administrator-only, immediately revokes playback and retries storage failures", async () => {
  const item = setup(),
    recording = await service.startSession(item.sessionId, true);
  await service.stopSession(item.sessionId);
  const path = submit(item);
  assert.equal(
    (await request(`${path}/${recording!.id}`, "DELETE", member.cookie)).status,
    403,
  );
  failDelete = true;
  try {
    assert.equal(
      (await request(`${path}/${recording!.id}`, "DELETE")).status,
      202,
    );
    await service.tick();
    assert.equal((await request(`${path}/${recording!.id}/media`)).status, 404);
    assert.ok(
      store.db
        .prepare("SELECT id FROM screening_recording_cleanup WHERE id=?")
        .get(recording!.id),
    );
  } finally {
    failDelete = false;
  }
  await service.tick();
  assert.equal(
    store.db
      .prepare("SELECT state FROM screening_recordings WHERE id=?")
      .get(recording!.id)!.state,
    "deleted",
  );
});
test("retention expiry removes access before scheduled cleanup runs", async () => {
  const item = setup(true, 1),
    recording = await service.startSession(item.sessionId, true);
  await service.stopSession(item.sessionId);
  const path = submit(item);
  store.db
    .prepare("UPDATE screening_recordings SET expires_at=? WHERE id=?")
    .run(time - 1, recording!.id);
  assert.equal((await request(`${path}/${recording!.id}/media`)).status, 404);
  assert.equal((await (await request(path)).json()).items[0].state, "expired");
  await service.tick();
  assert.equal(
    store.db
      .prepare("SELECT state FROM screening_recordings WHERE id=?")
      .get(recording!.id)!.state,
    "deleted",
  );
});
test("publication revocation stops recording without needing a candidate browser", async () => {
  const item = setup();
  await service.startSession(item.sessionId, true);
  store.db
    .prepare("UPDATE screening_publications SET revoked_at=? WHERE id=?")
    .run(new Date().toISOString(), item.publicationId);
  await service.tick();
  assert.ok(
    calls.some((call) => call.kind === "stop" && call.room === item.room),
  );
});
test("source cascade retains cleanup tasks until remote recording and object are deleted", async () => {
  const item = setup(),
    recording = await service.startSession(item.sessionId, true);
  store.db.prepare("DELETE FROM resources WHERE id=?").run(item.id);
  assert.equal(
    store.db
      .prepare("SELECT id FROM screening_recordings WHERE id=?")
      .get(recording!.id),
    undefined,
  );
  assert.ok(
    store.db
      .prepare("SELECT id FROM screening_recording_cleanup WHERE id=?")
      .get(recording!.id),
  );
  await service.tick();
  await service.tick();
  assert.ok(
    calls.some(
      (call) => call.kind === "delete" && call.key?.includes(recording!.id),
    ),
  );
  assert.equal(
    store.db
      .prepare("SELECT id FROM screening_recording_cleanup WHERE id=?")
      .get(recording!.id),
    undefined,
  );
});
test("deletion during provider start stops the late job and retains its cleanup tombstone", async () => {
  const item = setup();
  let finish!: () => void;
  pauseStart = () =>
    new Promise<void>((resolve) => {
      finish = resolve;
    });
  const pending = service.startSession(item.sessionId, true);
  await Promise.resolve();
  store.db.prepare("DELETE FROM resources WHERE id=?").run(item.id);
  finish();
  try {
    await assert.rejects(pending, /ended while recording/);
  } finally {
    pauseStart = undefined;
  }
  assert.ok(
    calls.some((call) => call.kind === "stop" && call.room === item.room),
  );
  await service.tick();
  assert.equal(
    store.db
      .prepare("SELECT id FROM screening_recording_cleanup WHERE room_name=?")
      .get(item.room),
    undefined,
  );
});
test("an unknown start cascade waits for late Egress reconciliation before deleting its object", async () => {
  const item = setup();
  failStart = true;
  try {
    await assert.rejects(service.startSession(item.sessionId, true));
  } finally {
    failStart = false;
  }
  store.db.prepare("DELETE FROM resources WHERE id=?").run(item.id);
  await service.tick();
  assert.ok(
    store.db
      .prepare("SELECT id FROM screening_recording_cleanup WHERE room_name=?")
      .get(item.room),
  );
  time += 7_200_001;
  await service.tick();
  assert.equal(
    store.db
      .prepare("SELECT id FROM screening_recording_cleanup WHERE room_name=?")
      .get(item.room),
    undefined,
  );
});
test("real Egress adapter requests bounded MP4 composite output with private destination and no manifest", async () => {
  const original = EgressClient.prototype.startRoomCompositeEgress;
  let received: unknown[] = [];
  EgressClient.prototype.startRoomCompositeEgress = async function (
    ...args: unknown[]
  ) {
    received = args;
    return new EgressInfo({
      egressId: "eg-test",
      roomName: "room-test",
      status: 1,
    });
  } as typeof original;
  try {
    const result = await createRecordingAdapter(env).start("room-test", {
      bucket: "private-bucket",
      key: "controlled/key.mp4",
      endpoint: "https://storage.example",
      region: "us-east-1",
    });
    assert.equal(result.id, "eg-test");
    const output = received[1] as {
      disableManifest: boolean;
      filepath: string;
      output: {
        case: string;
        value: { bucket: string; forcePathStyle: boolean };
      };
    };
    assert.equal(output.disableManifest, true);
    assert.equal(output.filepath, "controlled/key.mp4");
    assert.equal(output.output.case, "s3");
    assert.equal(output.output.value.bucket, "private-bucket");
    assert.equal(output.output.value.forcePathStyle, true);
  } finally {
    EgressClient.prototype.startRoomCompositeEgress = original;
  }
});
test("the Egress SDK cannot replay an ambiguous recording start through regional failover", async () => {
  const original = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    requests.push(String(input));
    return new Response(
      JSON.stringify({ code: "unavailable", msg: "Synthetic provider outage" }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  };
  try {
    await assert.rejects(
      createRecordingAdapter(env).start("synthetic-room", {
        bucket: "private-bucket",
        key: "controlled/file.mp4",
        endpoint: "https://storage.example",
        region: "us-east-1",
      }),
    );
    assert.equal(requests.length, 1);
    assert.match(requests[0], /StartRoomCompositeEgress$/);
  } finally {
    globalThis.fetch = original;
  }
});
test("storage deletion permanently removes only the recording key's versions and markers", async () => {
  const original = S3Client.prototype.send;
  const deleted: unknown[] = [];
  S3Client.prototype.send = async function (command: {
    constructor: { name: string };
    input: any;
  }) {
    if (command.constructor.name === "DeleteObjectCommand")
      return { DeleteMarker: true, VersionId: "new-marker" };
    if (command.constructor.name === "ListObjectVersionsCommand") {
      assert.equal(command.input.Prefix, "controlled/file.mp4");
      return {
        Versions: [
          { Key: "controlled/file.mp4", VersionId: "video-version" },
          { Key: "controlled/file.mp4-other", VersionId: "neighbor-version" },
        ],
        DeleteMarkers: [
          { Key: "controlled/file.mp4", VersionId: "new-marker" },
        ],
      };
    }
    if (command.constructor.name === "DeleteObjectsCommand") {
      deleted.push(command.input.Delete.Objects);
      return {};
    }
    throw new Error("Unexpected storage operation");
  } as typeof original;
  try {
    await createRecordingAdapter(env).remove({
      bucket: "private-bucket",
      key: "controlled/file.mp4",
      endpoint: "https://storage.example",
      region: "us-east-1",
    });
    assert.deepEqual(deleted, [
      [
        { Key: "controlled/file.mp4", VersionId: "video-version" },
        { Key: "controlled/file.mp4", VersionId: "new-marker" },
      ],
    ]);
  } finally {
    S3Client.prototype.send = original;
  }
});
test("partial version deletion never reports permanent success", async () => {
  const original = S3Client.prototype.send;
  S3Client.prototype.send = async function (command: {
    constructor: { name: string };
  }) {
    if (command.constructor.name === "DeleteObjectCommand")
      return { DeleteMarker: true, VersionId: "marker" };
    if (command.constructor.name === "ListObjectVersionsCommand")
      return {
        Versions: [{ Key: "controlled/file.mp4", VersionId: "locked-version" }],
      };
    return { Errors: [{ Code: "AccessDenied", Key: "controlled/file.mp4" }] };
  } as typeof original;
  try {
    await assert.rejects(
      createRecordingAdapter(env).remove({
        bucket: "private-bucket",
        key: "controlled/file.mp4",
        endpoint: "https://storage.example",
        region: "us-east-1",
      }),
      /versions could not be deleted/,
    );
  } finally {
    S3Client.prototype.send = original;
  }
});

test("recording transcript aligns SDK speech bounds to the actual file start and never callback arrival", async () => {
  const item = setup(),
    recording = await service.startSession(item.sessionId, true);
  jobs.get(item.room)!.startedAtMs = time + 1000;
  await service.stopSession(item.sessionId);
  const path = submit(item);
  const insert = store.db.prepare(
    "INSERT INTO screening_live_events(id,session_id,event_hash,sequence,kind,question_id,text,created_at,speech_start_ms,speech_end_ms,timing_source) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
  );
  const add = (
    sequence: number,
    start: number | null,
    end: number | null,
    source: string | null,
    text: string,
  ) =>
    insert.run(
      randomUUID(),
      item.sessionId,
      String(sequence),
      sequence,
      "answer",
      randomUUID(),
      text,
      new Date(time + 900_000).toISOString(),
      start,
      end,
      source,
    );
  add(1, time + 3000, time + 5000, "livekit-vad", "Original spoken answer");
  add(2, null, null, null, "Legacy untimed speech");
  add(3, time - 1000, time + 2000, "livekit-vad", "Partly before recording");
  add(4, time + 20_000, time + 22_000, "livekit-vad", "Outside recording");
  add(5, time + 11_000, time + 15_000, "livekit-vad", "Partly after recording");
  const response = await request(`${path}/${recording!.id}/transcript`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control")!, /no-store/);
  const data = await response.json();
  assert.equal(data.synchronization, "approximate-utterance");
  assert.deepEqual(
    data.items.map(
      (turn: { startSeconds: number | null; endSeconds: number | null }) => [
        turn.startSeconds,
        turn.endSeconds,
      ],
    ),
    [
      [2, 4],
      [null, null],
      [0, 1],
      [null, null],
      [10, 12],
    ],
  );
  assert.equal(data.items[0].text, "Original spoken answer");
  assert.equal(
    JSON.stringify(data).includes("An answer"),
    false,
    "candidate-corrected form text is not the speech transcript",
  );
  assert.equal(
    (await request(`${path}/${recording!.id}/transcript`, "GET", "")).status,
    401,
  );
  assert.equal(
    (
      await request(
        `${path}/${recording!.id}/transcript`,
        "GET",
        outsider.cookie,
      )
    ).status,
    404,
  );
  store.db
    .prepare("UPDATE screening_recordings SET media_started_at=NULL WHERE id=?")
    .run(recording!.id);
  const legacy = await (
    await request(`${path}/${recording!.id}/transcript`)
  ).json();
  assert.ok(
    legacy.items.every(
      (turn: { startSeconds: unknown }) => turn.startSeconds === null,
    ),
  );
  store.db
    .prepare("UPDATE screening_recordings SET expires_at=? WHERE id=?")
    .run(time - 1, recording!.id);
  assert.equal(
    (await request(`${path}/${recording!.id}/transcript`)).status,
    404,
  );
});

test("Egress adapter reads file nanosecond origin instead of job creation time", async () => {
  const original = EgressClient.prototype.startRoomCompositeEgress;
  EgressClient.prototype.startRoomCompositeEgress = async function () {
    return new EgressInfo({
      egressId: "timed-egress",
      roomName: "timed-room",
      status: 3,
      startedAt: 1_700_000_000_000_000_000n,
      fileResults: [
        {
          filename: "controlled/timed.mp4",
          startedAt: 1_700_000_005_123_456_789n,
          duration: 12_000_000_000n,
          size: 10n,
        },
      ],
    });
  } as typeof original;
  try {
    const result = await createRecordingAdapter(env).start("timed-room", {
      bucket: "private",
      key: "controlled/timed.mp4",
      endpoint: "https://storage.example",
      region: "us-east-1",
    });
    assert.equal(result.startedAtMs, 1_700_000_005_123);
    assert.equal(result.duration, 12);
  } finally {
    EgressClient.prototype.startRoomCompositeEgress = original;
  }
});
