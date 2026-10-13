import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import express from "express";
import { createDatabase } from "../../server/db.js";
import { hashToken } from "../../server/auth.js";
import { registerScreening } from "../../server/screening.js";
import { registerLiveInterviews } from "../../server/live-interviews.js";
import {
  registerScreeningRecordings,
  type RecordingAdapter,
  type RecordingJob,
} from "../../server/screening-recordings.js";

const originalBytes = Buffer.from("synthetic-original-video-bytes");
const segment = { startSeconds: 2, endSeconds: 5, muted: false };
type Segment = typeof segment;

async function fixture(t: TestContext, attached = true) {
  const dir = mkdtempSync(join(tmpdir(), "arkoffer-media-studio-"));
  const store = createDatabase(dir);
  let time = Date.now();
  function user(workspaceId = randomUUID(), role = "owner") {
    const id = randomUUID(),
      token = randomBytes(32).toString("hex"),
      date = new Date(time).toISOString();
    store.db
      .prepare(
        "INSERT OR IGNORE INTO workspaces(id,name,created_at) VALUES(?,?,?)",
      )
      .run(workspaceId, "Synthetic media team", date);
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
      .run(hashToken(token), id, workspaceId, time + 3_600_000, date);
    return { id, workspaceId, cookie: `arkoffer_session=${token}` };
  }
  const owner = user(),
    member = user(owner.workspaceId, "member"),
    admin = user(owner.workspaceId, "admin"),
    outsider = user();
  const env: NodeJS.ProcessEnv = {
    LIVEKIT_URL: "wss://test.livekit.cloud",
    LIVEKIT_API_KEY: "synthetic-key",
    LIVEKIT_API_SECRET: "synthetic-secret",
    LIVEKIT_WORKSPACE_IDS: owner.workspaceId,
    S3_BUCKET: "private-screenings",
    S3_REGION: "us-east-1",
    S3_ENDPOINT: "https://storage.example",
    S3_ACCESS_KEY_ID: "synthetic-access",
    S3_SECRET_ACCESS_KEY: "synthetic-storage-secret",
  };
  let providerJob: RecordingJob;
  const adapter: RecordingAdapter = {
    async start(room, destination) {
      providerJob = {
        id: randomUUID(),
        room,
        status: 1,
        key: destination.key,
        size: 0,
        duration: 0,
        startedAtMs: time,
      };
      return { ...providerJob };
    },
    async list() {
      return [{ ...providerJob }];
    },
    async stop() {
      Object.assign(providerJob, {
        status: 3,
        size: originalBytes.length,
        duration: 20,
      });
      return { ...providerJob };
    },
    async remove() {},
    async read() {
      return {
        body: Readable.from(originalBytes),
        length: originalBytes.length,
      };
    },
  };
  const calls = { exports: [] as Segment[][], aligns: 0 };
  let clipAvailable = true,
    alignmentAvailable = true;
  let pause: ((signal: AbortSignal) => Promise<void>) | undefined;
  let pauseStatus: (() => Promise<void>) | undefined;
  let releaseStatus: (() => void) | undefined;
  const mediaProcessor = {
    async status() {
      if (pauseStatus) await pauseStatus();
      return {
        clipping: {
          available: clipAvailable,
          missing: clipAvailable ? [] : ["FFmpeg"],
        },
        alignment: {
          available: alignmentAvailable,
          missing: alignmentAvailable ? [] : ["Transcription provider"],
          model: "synthetic-word-model",
        },
      };
    },
    async export(input: {
      inputPath: string;
      outputPath: string;
      segments: Segment[];
      signal?: AbortSignal;
    }) {
      calls.exports.push(structuredClone(input.segments));
      assert.deepEqual(
        readFileSync(input.inputPath),
        originalBytes,
        "processor receives only the authorized original recording",
      );
      if (pause) await pause(input.signal ?? new AbortController().signal);
      if (input.signal?.aborted) throw new Error("Synthetic processor aborted");
      writeFileSync(
        input.outputPath,
        `export:${JSON.stringify(input.segments)}`,
      );
    },
    async align(input: { inputPath: string; signal?: AbortSignal }) {
      calls.aligns += 1;
      assert.deepEqual(readFileSync(input.inputPath), originalBytes);
      if (pause) await pause(input.signal ?? new AbortController().signal);
      if (input.signal?.aborted) throw new Error("Synthetic processor aborted");
      return {
        model: "synthetic-word-model",
        words: [
          { word: "Original", start: 2, end: 2.5 },
          { word: "spoken", start: 2.6, end: 3 },
          { word: "answer", start: 3.2, end: 4 },
        ],
      };
    },
  };
  function application() {
    const app = express();
    app.use(express.json());
    registerScreening(app, store);
    registerLiveInterviews(app, store, { env });
    const service = registerScreeningRecordings(app, store, {
      env,
      adapter,
      mediaProcessor,
      now: () => time,
    });
    return { app, service };
  }
  const initial = application();
  let service = initial.service;
  const server = initial.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => {
    releaseStatus?.();
    await service.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const screeningId = randomUUID(),
    publicationId = randomUUID(),
    sessionId = randomUUID(),
    responseId = randomUUID(),
    questionId = randomUUID(),
    date = new Date(time).toISOString();
  store.insert(owner.workspaceId, "screenings", {
    id: screeningId,
    title: "Synthetic interview",
    name: "Synthetic interview",
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
      screeningId,
      owner.workspaceId,
      hashToken(randomUUID()),
      JSON.stringify({
        title: "Synthetic interview",
        setup: {
          interviewMode: "live",
          recordingEnabled: true,
          recordingRetentionDays: 30,
        },
        questions: [{ id: questionId, question: "Describe your work." }],
      }),
      time + 3_600_000,
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
      `screening-${sessionId}`,
      randomUUID(),
      time + 1_800_000,
      date,
      date,
    );
  const recording = await service.startSession(sessionId, true);
  await service.stopSession(sessionId);
  const eventId = randomUUID();
  store.db
    .prepare(
      "INSERT INTO screening_live_events(id,session_id,event_hash,sequence,kind,question_id,text,created_at,speech_start_ms,speech_end_ms,timing_source) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      eventId,
      sessionId,
      randomUUID(),
      1,
      "answer",
      questionId,
      "Original spoken answer",
      date,
      time + 2000,
      time + 5000,
      "livekit-vad",
    );
  store.db
    .prepare(
      "INSERT INTO screening_responses(id,publication_id,screening_id,workspace_id,candidate_name,email,answers,submitted_at,consent_at,submission_hash,live_session_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      responseId,
      publicationId,
      screeningId,
      owner.workspaceId,
      "Synthetic candidate",
      "candidate@example.com",
      JSON.stringify([{ questionId, value: "Candidate corrected answer" }]),
      date,
      date,
      randomUUID(),
      attached ? sessionId : null,
    );
  const recordingPath = `/api/screenings/${screeningId}/responses/${responseId}/recordings/${recording!.id}`;
  async function request(
    path = "",
    method = "GET",
    body?: unknown,
    cookie = owner.cookie,
    headers: Record<string, string> = {},
  ) {
    return fetch(`${origin}${recordingPath}/studio${path}`, {
      method,
      headers: {
        Cookie: cookie,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async function edit(segments = [segment]) {
    const response = await request("/edits", "POST", {
      title: "Selected evidence",
      segments,
    });
    assert.equal(response.status, 201, await response.clone().text());
    return (await response.json()).edit;
  }
  async function queue(
    editId: string,
    revision: number,
    requestKey = randomUUID(),
  ) {
    const response = await request(`/edits/${editId}/export`, "POST", {
      revision,
      requestKey,
    });
    assert.equal(response.status, 202, await response.clone().text());
    return (await response.json()).job;
  }
  function files(path = join(dir, "screening-media")): string[] {
    return existsSync(path)
      ? readdirSync(path, { withFileTypes: true }).flatMap((item) =>
          item.isDirectory()
            ? files(join(path, item.name))
            : [join(path, item.name)],
        )
      : [];
  }
  return {
    store,
    owner,
    member,
    admin,
    outsider,
    dir,
    screeningId,
    publicationId,
    sessionId,
    recordingId: recording!.id,
    responseId,
    eventId,
    request,
    edit,
    queue,
    calls,
    files,
    get service() {
      return service;
    },
    async restart() {
      await service.stop();
      service = application().service;
    },
    capability(kind: "clipping" | "alignment", available: boolean) {
      if (kind === "clipping") clipAvailable = available;
      else alignmentAvailable = available;
    },
    holdStatus(expected = 1) {
      let entered = 0,
        ready!: () => void,
        finish!: () => void;
      const started = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Capability checks were not reached.")),
          10_000,
        );
        timeout.unref();
        ready = () => {
          clearTimeout(timeout);
          resolve();
        };
      });
      const gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      releaseStatus = () => {
        pauseStatus = undefined;
        finish();
      };
      pauseStatus = async () => {
        if (++entered === expected) ready();
        await gate;
      };
      return {
        started,
        release() {
          releaseStatus?.();
        },
      };
    },
    async recording(path: string) {
      return fetch(`${origin}${recordingPath}${path}`, {
        headers: { Cookie: owner.cookie },
      });
    },
    pause() {
      let ready!: () => void, release!: () => void;
      const started = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Processor was not reached.")),
          10_000,
        );
        timeout.unref();
        ready = () => {
          clearTimeout(timeout);
          resolve();
        };
      });
      pause = async (signal) => {
        ready();
        await new Promise<void>((resolve) => {
          release = () => {
            signal.removeEventListener("abort", release);
            resolve();
          };
          signal.addEventListener("abort", release, { once: true });
          if (signal.aborted) release();
        });
      };
      return {
        started,
        release: () => {
          pause = undefined;
          release();
        },
      };
    },
    expire() {
      store.db
        .prepare("UPDATE screening_recordings SET expires_at=? WHERE id=?")
        .run(time - 1, recording!.id);
    },
  };
}

test("studio is private, submitted-response scoped and members cannot mutate evidence", async (t) => {
  const f = await fixture(t);
  for (const [cookie, status] of [
    ["", 401],
    [f.outsider.cookie, 404],
  ] as const) {
    const denied = await f.request("", "GET", undefined, cookie);
    assert.equal(denied.status, status);
    assert.match(denied.headers.get("content-type")!, /application\/json/);
    const body = await denied.json();
    assert.equal(typeof body.error, "string");
    assert.ok(!JSON.stringify(body).includes("/server/"));
  }
  const owner = await (await f.request()).json();
  assert.equal(owner.canEdit, true);
  assert.equal(owner.capabilities.clipping.available, true);
  assert.ok(!JSON.stringify(owner).includes("private-screenings"));
  const member = await (
    await f.request("", "GET", undefined, f.member.cookie)
  ).json();
  assert.equal(member.canEdit, false);
  assert.equal(
    (
      await f.request(
        "/edits",
        "POST",
        { title: "Denied", segments: [segment] },
        f.member.cookie,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request(
        "/alignment",
        "POST",
        { requestKey: randomUUID(), consent: true },
        f.member.cookie,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request(
        "/edits",
        "POST",
        { title: "Admin edit", segments: [segment] },
        f.admin.cookie,
      )
    ).status,
    201,
  );
  const abandoned = await fixture(t, false);
  assert.equal((await abandoned.request()).status, 404);
  assert.equal(
    (
      await abandoned.request("/edits", "POST", {
        title: "Denied",
        segments: [segment],
      })
    ).status,
    404,
  );
});

test("edits validate finite in-range segments and preserve optimistic revisions", async (t) => {
  const f = await fixture(t);
  for (const segments of [
    [],
    [{ ...segment, startSeconds: -1 }],
    [{ ...segment, endSeconds: 21 }],
    [{ ...segment, endSeconds: 2 }],
    [{ ...segment, startSeconds: "2" }],
  ]) {
    assert.equal(
      (await f.request("/edits", "POST", { title: "Invalid", segments }))
        .status,
      400,
    );
  }
  const edit = await f.edit();
  assert.equal(edit.revision, 1);
  const updated = await f.request(`/edits/${edit.id}`, "PUT", {
    revision: 1,
    title: "Trimmed and muted",
    segments: [{ startSeconds: 7, endSeconds: 11, muted: true }],
  });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).edit.revision, 2);
  assert.equal(
    (
      await f.request(`/edits/${edit.id}`, "PUT", {
        revision: 1,
        title: "Stale edit",
        segments: [segment],
      })
    ).status,
    409,
  );
  assert.equal(
    (await f.request(`/edits/${edit.id}`, "DELETE", { revision: 1 })).status,
    409,
  );
  assert.equal(
    (
      await f.request(`/edits/${edit.id}/export`, "POST", {
        revision: 1,
        requestKey: randomUUID(),
      })
    ).status,
    409,
  );
});

test("exports use immutable edit snapshots, idempotency and private range downloads without altering originals", async (t) => {
  const f = await fixture(t),
    edit = await f.edit([
      segment,
      { startSeconds: 10, endSeconds: 13, muted: true },
    ]),
    key = randomUUID();
  const job = await f.queue(edit.id, edit.revision, key);
  const duplicate = await f.queue(edit.id, edit.revision, key);
  assert.equal(duplicate.id, job.id);
  assert.equal(
    f.calls.exports.length,
    0,
    "queueing must not run paid or heavy work inside the HTTP request",
  );
  assert.equal(
    (
      await f.request(`/edits/${edit.id}`, "PUT", {
        revision: 1,
        title: "Later edit",
        segments: [{ startSeconds: 15, endSeconds: 19, muted: false }],
      })
    ).status,
    200,
  );
  await f.service.media.tick();
  assert.deepEqual(f.calls.exports, [
    [segment, { startSeconds: 10, endSeconds: 13, muted: true }],
  ]);
  const bytes = `export:${JSON.stringify(f.calls.exports[0])}`;
  const full = await f.request(`/jobs/${job.id}/media?download=1`);
  assert.equal(full.status, 200);
  assert.match(full.headers.get("content-disposition")!, /^attachment/);
  assert.match(full.headers.get("cache-control")!, /no-store/);
  assert.equal(await full.text(), bytes);
  const range = await f.request(
    `/jobs/${job.id}/media`,
    "GET",
    undefined,
    f.member.cookie,
    { Range: "bytes=0-5" },
  );
  assert.equal(range.status, 206);
  assert.equal(
    range.headers.get("content-range"),
    `bytes 0-5/${Buffer.byteLength(bytes)}`,
  );
  assert.equal(await range.text(), "export");
  const suffix = await f.request(
    `/jobs/${job.id}/media`,
    "GET",
    undefined,
    f.owner.cookie,
    { Range: "bytes=-2" },
  );
  assert.equal(suffix.status, 206);
  assert.equal(await suffix.text(), bytes.slice(-2));
  for (const value of ["bytes=999999-", "bytes=0-1,3-4", "nonsense"])
    assert.equal(
      (
        await f.request(
          `/jobs/${job.id}/media`,
          "GET",
          undefined,
          f.owner.cookie,
          { Range: value },
        )
      ).status,
      416,
    );
  assert.equal(
    (
      await f.request(
        `/jobs/${job.id}/media`,
        "GET",
        undefined,
        f.outsider.cookie,
      )
    ).status,
    404,
  );
  assert.deepEqual(
    Buffer.from(await (await f.recording("/media")).arrayBuffer()),
    originalBytes,
  );
  assert.deepEqual(
    f.files().map((path) => basename(path)),
    ["clip.mp4"],
    "only the finished clip remains; downloaded source scratch files are removed",
  );
});

test("alignment needs explicit consent and capability, then augments rather than rewrites speech evidence", async (t) => {
  const f = await fixture(t),
    key = randomUUID();
  assert.equal(
    (await f.request("/alignment", "POST", { requestKey: key, consent: false }))
      .status,
    400,
  );
  assert.equal(f.calls.aligns, 0);
  f.capability("alignment", false);
  assert.equal(
    (await f.request("/alignment", "POST", { requestKey: key, consent: true }))
      .status,
    503,
  );
  f.capability("alignment", true);
  const response = await f.request("/alignment", "POST", {
    requestKey: key,
    consent: true,
  });
  assert.equal(response.status, 202);
  const duplicate = await f.request("/alignment", "POST", {
    requestKey: key,
    consent: true,
  });
  assert.equal(duplicate.status, 202);
  assert.equal((await response.json()).job.id, (await duplicate.json()).job.id);
  await f.service.media.tick();
  assert.equal(f.calls.aligns, 1);
  const transcript = await (await f.recording("/transcript")).json();
  assert.equal(transcript.items[0].text, "Original spoken answer");
  assert.equal(
    JSON.stringify(transcript).includes("Candidate corrected answer"),
    false,
  );
  assert.ok(JSON.stringify(transcript).includes("synthetic-word-model"));
  assert.ok(transcript.items[0].tokens.length >= 3);
  assert.ok(
    transcript.items[0].tokens.some(
      (token: { startSeconds: number | null }) => token.startSeconds === 2,
    ),
  );
});

test("missing clipping capability prevents export while saving a reversible edit stays available", async (t) => {
  const f = await fixture(t),
    edit = await f.edit();
  f.capability("clipping", false);
  assert.equal(
    (
      await f.request(`/edits/${edit.id}/export`, "POST", {
        revision: edit.revision,
        requestKey: randomUUID(),
      })
    ).status,
    503,
  );
  assert.equal(f.calls.exports.length, 0);
});

test("cancelled queued and running jobs cannot publish derived bytes", async (t) => {
  const f = await fixture(t),
    edit = await f.edit(),
    queued = await f.queue(edit.id, edit.revision);
  assert.equal(
    (
      await f.request(
        `/jobs/${queued.id}`,
        "DELETE",
        undefined,
        f.member.cookie,
      )
    ).status,
    403,
  );
  assert.ok((await f.request(`/jobs/${queued.id}`, "DELETE")).ok);
  await f.service.media.tick();
  assert.equal(f.calls.exports.length, 0);
  const running = await f.queue(edit.id, edit.revision),
    pause = f.pause(),
    pending = f.service.media.tick();
  await pause.started;
  assert.ok((await f.request(`/jobs/${running.id}`, "DELETE")).ok);
  pause.release();
  await pending;
  assert.equal((await f.request(`/jobs/${running.id}/media`)).status, 404);
  assert.deepEqual(f.files(), []);
});

test("creator authority is rechecked after processing and removed membership never publishes output", async (t) => {
  const f = await fixture(t),
    edit = await f.edit(),
    job = await f.queue(edit.id, edit.revision),
    pause = f.pause(),
    pending = f.service.media.tick();
  await pause.started;
  f.store.db
    .prepare(
      "UPDATE memberships SET status='suspended' WHERE user_id=? AND workspace_id=?",
    )
    .run(f.owner.id, f.owner.workspaceId);
  pause.release();
  await pending;
  assert.equal(
    (await f.request(`/jobs/${job.id}/media`, "GET", undefined, f.admin.cookie))
      .status,
    404,
  );
  assert.deepEqual(f.files(), []);
});

test("source deletion during processing revokes jobs and cleans late files", async (t) => {
  const f = await fixture(t),
    edit = await f.edit(),
    job = await f.queue(edit.id, edit.revision),
    pause = f.pause(),
    pending = f.service.media.tick();
  await pause.started;
  f.store.db.prepare("DELETE FROM resources WHERE id=?").run(f.screeningId);
  pause.release();
  await pending;
  await f.service.media.tick();
  assert.equal((await f.request(`/jobs/${job.id}/media`)).status, 404);
  assert.deepEqual(f.files(), []);
});

test("retention expiry immediately revokes derived media then removes it on cleanup", async (t) => {
  const f = await fixture(t),
    edit = await f.edit(),
    job = await f.queue(edit.id, edit.revision);
  await f.service.media.tick();
  assert.ok(f.files().length > 0);
  f.expire();
  assert.equal((await f.request(`/jobs/${job.id}/media`)).status, 404);
  assert.equal(
    (
      await f.request("/alignment", "POST", {
        requestKey: randomUUID(),
        consent: true,
      })
    ).status,
    404,
  );
  await f.service.media.tick();
  assert.deepEqual(f.files(), []);
});

test("restart marks interrupted processing failed without replaying work or retaining partial media", async (t) => {
  const f = await fixture(t),
    edit = await f.edit(),
    job = await f.queue(edit.id, edit.revision);
  f.store.db
    .prepare("UPDATE screening_media_jobs SET state='processing' WHERE id=?")
    .run(job.id);
  mkdirSync(join(f.dir, "screening-media", job.id), { recursive: true });
  writeFileSync(
    join(f.dir, "screening-media", job.id, "clip.mp4"),
    "partial output",
  );
  await f.restart();
  await f.service.media.tick();
  const data = await (await f.request()).json();
  assert.equal(
    data.jobs.find((item: { id: string }) => item.id === job.id).state,
    "failed",
  );
  assert.equal(
    f.calls.exports.length,
    0,
    "ambiguous interrupted jobs require an explicit new export",
  );
  assert.deepEqual(f.files(), []);
});

test("an idempotency key cannot silently refer to a different edit snapshot or job kind", async (t) => {
  const f = await fixture(t),
    edit = await f.edit(),
    key = randomUUID();
  await f.queue(edit.id, edit.revision, key);
  assert.equal(
    (
      await f.request(`/edits/${edit.id}`, "PUT", {
        revision: 1,
        title: "New snapshot",
        segments: [{ startSeconds: 12, endSeconds: 15, muted: true }],
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.request(`/edits/${edit.id}/export`, "POST", {
        revision: 2,
        requestKey: key,
      })
    ).status,
    409,
  );
  assert.equal(
    (await f.request("/alignment", "POST", { consent: true, requestKey: key }))
      .status,
    409,
  );
  await f.service.media.tick();
  assert.deepEqual(f.calls.exports, [[segment]]);
  assert.equal(f.calls.aligns, 0);
});

test("deleting a completed source cascades derived exports and cleanup survives missing source rows", async (t) => {
  const f = await fixture(t),
    edit = await f.edit(),
    job = await f.queue(edit.id, edit.revision);
  await f.service.media.tick();
  assert.ok(f.files().length > 0);
  f.store.db.prepare("DELETE FROM resources WHERE id=?").run(f.screeningId);
  assert.equal((await f.request(`/jobs/${job.id}/media`)).status, 404);
  await f.service.media.tick();
  assert.deepEqual(f.files(), []);
});

test("alignment from an older transcript snapshot cannot attach word offsets to changed evidence", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await f.request("/alignment", "POST", {
        requestKey: randomUUID(),
        consent: true,
      })
    ).status,
    202,
  );
  await f.service.media.tick();
  const aligned = await (await f.recording("/transcript")).json();
  assert.ok(
    aligned.items[0].tokens.some(
      (token: { startSeconds: number | null }) => token.startSeconds !== null,
    ),
  );
  f.store.db
    .prepare("UPDATE screening_live_events SET text=? WHERE id=?")
    .run("Different evidence now", f.eventId);
  const changed = await (await f.recording("/transcript")).json();
  assert.equal(changed.items[0].text, "Different evidence now");
  assert.ok(
    !changed.items[0].tokens ||
      changed.items[0].tokens.every(
        (token: { startSeconds: number | null }) => token.startSeconds === null,
      ),
  );
});

test("overlapping requests with the same key enqueue exactly one job after asynchronous capability checks", async (t) => {
  const f = await fixture(t),
    edit = await f.edit(),
    key = randomUUID(),
    hold = f.holdStatus(2);
  const input = { revision: edit.revision, requestKey: key };
  const first = f.request(`/edits/${edit.id}/export`, "POST", input);
  const second = f.request(`/edits/${edit.id}/export`, "POST", input);
  await hold.started;
  hold.release();
  const responses = await Promise.all([first, second]);
  assert.deepEqual(
    responses.map((response) => response.status),
    [202, 202],
  );
  const jobs = await Promise.all(
    responses.map(async (response) => (await response.json()).job),
  );
  assert.equal(jobs[0].id, jobs[1].id);
  await f.service.media.tick();
  assert.equal(f.calls.exports.length, 1);
  const data = await (await f.request()).json();
  assert.equal(data.jobs.length, 1);
});

test("a concurrent edit during capability checks cannot export an outdated revision", async (t) => {
  const f = await fixture(t),
    edit = await f.edit(),
    hold = f.holdStatus();
  const pending = f.request(`/edits/${edit.id}/export`, "POST", {
    revision: edit.revision,
    requestKey: randomUUID(),
  });
  await hold.started;
  try {
    assert.equal(
      (
        await f.request(`/edits/${edit.id}`, "PUT", {
          revision: edit.revision,
          title: "Concurrent change",
          segments: [{ startSeconds: 10, endSeconds: 12, muted: true }],
        })
      ).status,
      200,
    );
  } finally {
    hold.release();
  }
  assert.equal((await pending).status, 409);
  await f.service.media.tick();
  assert.equal(f.calls.exports.length, 0);
  assert.deepEqual((await (await f.request()).json()).jobs, []);
});
