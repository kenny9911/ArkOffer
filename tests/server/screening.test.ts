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
import { createApp } from "../../server/app.js";

const ORIGIN = "http://localhost:5174";
let store: Store, server: Server, base: string, directory: string;
let owner: { cookie: string; workspaceId: string },
  other: { cookie: string; workspaceId: string },
  member: { cookie: string; workspaceId: string };
function user(workspaceId: string = randomUUID(), role = "owner") {
  const id = randomUUID(),
    token = randomBytes(32).toString("hex"),
    date = new Date().toISOString();
  store.db
    .prepare(
      "INSERT OR IGNORE INTO workspaces(id,name,created_at) VALUES(?,?,?)",
    )
    .run(workspaceId, "Hiring Team", date);
  store.db
    .prepare(
      "INSERT INTO users(id,workspace_id,name,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?,?)",
    )
    .run(
      id,
      workspaceId,
      "Test User",
      `${id}@example.com`,
      "unused-test-hash",
      role,
      date,
    );
  store.db
    .prepare(
      "INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)",
    )
    .run(hashToken(token), id, Date.now() + 3600000, date);
  return { workspaceId, cookie: `arkoffer_session=${token}` };
}
function screening(extra: Record<string, unknown> = {}) {
  const id = randomUUID(),
    date = new Date().toISOString();
  store.insert(owner.workspaceId, "screenings", {
    id,
    createdAt: date,
    updatedAt: date,
    name: "Product questionnaire",
    title: "Product questionnaire",
    description: "Share your role-related experience.",
    privateCandidateData: "must never become public",
    questions: [
      {
        prompt: "Describe relevant experience.",
        type: "text",
        options: [],
        required: true,
      },
      {
        prompt: "Preferred tool?",
        type: "multiple-choice",
        options: ["Figma", "Sketch"],
        required: true,
      },
      { prompt: "Anything else?", type: "text", options: [], required: false },
    ],
    ...extra,
  });
  return id;
}
async function request(
  path: string,
  method = "GET",
  body?: unknown,
  cookie = "",
  origin = ORIGIN,
) {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function publish(id: string) {
  const response = await request(
    `/api/screenings/${id}/publish`,
    "POST",
    {},
    owner.cookie,
  );
  assert.equal(response.status, 201);
  return (await response.json()).item as {
    id: string;
    token: string;
    url: string;
    expiresAt: string;
  };
}
async function publicForm(token: string) {
  const response = await request(`/api/interviews/${token}`);
  assert.equal(response.status, 200);
  return (await response.json()).item as {
    title: string;
    questions: { id: string; prompt: string }[];
  };
}
function answers(form: { questions: { id: string }[] }) {
  return {
    candidateName: "Alex Example",
    email: "ALEX@example.com",
    consent: true,
    answers: [
      {
        questionId: form.questions[0].id,
        value: "I designed a product onboarding flow.",
      },
      { questionId: form.questions[1].id, value: "Figma" },
    ],
  };
}
before(async () => {
  directory = mkdtempSync(join(tmpdir(), "arkoffer-screening-test-"));
  store = createDatabase(directory);
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use("/api", (req, res, next) => {
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.get("origin") !== ORIGIN
    ) {
      res.status(403).json({ error: "Request origin is not allowed." });
      return;
    }
    next();
  });
  registerScreening(app, store);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}`;
  owner = user();
  other = user();
  member = user(owner.workspaceId, "member");
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

test("publishing creates a seven-day hash-only bearer link and immutable public question snapshot", async () => {
  const id = screening();
  const publication = await publish(id);
  assert.match(publication.token, /^[a-f0-9]{64}$/);
  assert.equal(publication.url, `/interviews/${publication.token}`);
  assert.ok(Date.parse(publication.expiresAt) - Date.now() > 6.99 * 86400000);
  const row = store.db
    .prepare("SELECT * FROM screening_publications WHERE id = ?")
    .get(publication.id)!;
  assert.equal(row.token_hash, hashToken(publication.token));
  assert.ok(!JSON.stringify(row).includes(publication.token));
  const first = await request(`/api/interviews/${publication.token}`);
  assert.equal(first.headers.get("referrer-policy"), "no-referrer");
  const payload = await first.json();
  assert.equal(payload.submitted, false);
  assert.equal(payload.item.title, "Product questionnaire");
  assert.equal(payload.item.workspaceName, "Hiring Team");
  assert.equal(payload.item.questions.length, 3);
  assert.ok(!JSON.stringify(payload).includes("privateCandidateData"));
  assert.ok(!JSON.stringify(payload).includes("must never become public"));
  const prior = store.get(owner.workspaceId, "screenings", id)!;
  store.update(owner.workspaceId, "screenings", {
    ...prior,
    title: "Edited later",
    questions: [],
  });
  assert.equal(
    (await publicForm(publication.token)).title,
    "Product questionnaire",
  );
});

test("management requires a session and workspace ownership; only owners publish or revoke", async () => {
  const id = screening();
  assert.equal(
    (await request(`/api/screenings/${id}/publish`, "POST", {})).status,
    401,
  );
  assert.equal(
    (await request(`/api/screenings/${id}/publish`, "POST", {}, other.cookie))
      .status,
    404,
  );
  assert.equal(
    (await request(`/api/screenings/${id}/publish`, "POST", {}, member.cookie))
      .status,
    403,
  );
  assert.equal(
    (
      await request(
        `/api/screenings/${id}/publish`,
        "POST",
        {},
        owner.cookie,
        "https://foreign.example",
      )
    ).status,
    403,
  );
  const publication = await publish(id);
  assert.equal((await request(`/api/screenings/${id}/responses`)).status, 401);
  assert.equal(
    (
      await request(
        `/api/screenings/${id}/responses`,
        "GET",
        undefined,
        other.cookie,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await request(
        `/api/screenings/${id}/publications/${publication.id}`,
        "DELETE",
        undefined,
        other.cookie,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await request(
        `/api/screenings/${id}/publications/${publication.id}`,
        "DELETE",
        undefined,
        member.cookie,
      )
    ).status,
    403,
  );
  const foreign = store.insert(other.workspaceId, "screenings", {
    id: randomUUID(),
    name: "Foreign",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  assert.equal(
    (
      await request(
        `/api/screenings/${foreign.id}/publications/${publication.id}`,
        "DELETE",
        undefined,
        other.cookie,
      )
    ).status,
    404,
  );
});

test("responses require consent, required text, valid options and published question identities", async () => {
  const publication = await publish(screening());
  const form = await publicForm(publication.token);
  const input = answers(form);
  const endpoint = `/api/interviews/${publication.token}/responses`;
  assert.equal(
    (await request(endpoint, "POST", { ...input, consent: false })).status,
    400,
  );
  assert.equal(
    (await request(endpoint, "POST", { ...input, candidateName: " " })).status,
    400,
  );
  assert.equal(
    (await request(endpoint, "POST", { ...input, email: "invalid" })).status,
    400,
  );
  assert.equal(
    (await request(endpoint, "POST", { ...input, answers: [] })).status,
    400,
  );
  assert.equal(
    (
      await request(endpoint, "POST", {
        ...input,
        answers: [
          { questionId: form.questions[0].id, value: " " },
          input.answers[1],
        ],
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(endpoint, "POST", {
        ...input,
        answers: [
          input.answers[0],
          { questionId: form.questions[1].id, value: "Unpublished option" },
        ],
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(endpoint, "POST", {
        ...input,
        answers: [...input.answers, input.answers[0]],
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(endpoint, "POST", {
        ...input,
        answers: [
          ...input.answers,
          { questionId: "another-question", value: "No" },
        ],
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(endpoint, "POST", {
        ...input,
        answers: [
          { questionId: form.questions[0].id, value: "x".repeat(10001) },
          input.answers[1],
        ],
      })
    ).status,
    400,
  );
  assert.equal(
    (await request(endpoint, "POST", input, "", "https://foreign.example"))
      .status,
    403,
  );
});

test("a token accepts one response, identical retries are idempotent and answers stay private", async () => {
  const id = screening();
  const publication = await publish(id);
  const form = await publicForm(publication.token);
  const input = answers(form);
  const endpoint = `/api/interviews/${publication.token}/responses`;
  const responses = await Promise.all([
    request(endpoint, "POST", input),
    request(endpoint, "POST", input),
  ]);
  assert.deepEqual(
    responses.map((response) => response.status).sort(),
    [200, 201],
  );
  assert.equal(
    (
      await request(endpoint, "POST", {
        ...input,
        candidateName: "Another person",
      })
    ).status,
    409,
  );
  assert.equal(
    store.db
      .prepare(
        "SELECT COUNT(*) AS count FROM screening_responses WHERE publication_id = ?",
      )
      .get(publication.id)!.count,
    1,
  );
  const publicResponse = await (
    await request(`/api/interviews/${publication.token}`)
  ).json();
  assert.equal(publicResponse.submitted, true);
  assert.ok(!JSON.stringify(publicResponse).includes(input.candidateName));
  assert.ok(!JSON.stringify(publicResponse).includes("onboarding flow"));
  const managed = await (
    await request(
      `/api/screenings/${id}/responses`,
      "GET",
      undefined,
      owner.cookie,
    )
  ).json();
  assert.equal(managed.items.length, 1);
  assert.equal(managed.items[0].email, "alex@example.com");
  assert.equal(managed.items[0].answers[0].value, input.answers[0].value);
  assert.equal(managed.items[0].answers[2].value, "");
  assert.ok(managed.items[0].consentAt);
  assert.equal(managed.publications[0].status, "completed");
  assert.ok(!JSON.stringify(managed).includes(publication.token));
  assert.ok(!JSON.stringify(managed).includes(hashToken(publication.token)));
});

test("revocation and expiry prevent all public access while preserving owner response history", async () => {
  const id = screening();
  const publication = await publish(id);
  const form = await publicForm(publication.token);
  await request(
    `/api/interviews/${publication.token}/responses`,
    "POST",
    answers(form),
  );
  assert.equal(
    (
      await request(
        `/api/screenings/${id}/publications/${publication.id}`,
        "DELETE",
        undefined,
        owner.cookie,
      )
    ).status,
    200,
  );
  assert.equal(
    (await request(`/api/interviews/${publication.token}`)).status,
    404,
  );
  assert.equal(
    (
      await request(
        `/api/interviews/${publication.token}/responses`,
        "POST",
        answers(form),
      )
    ).status,
    404,
  );
  const managed = await (
    await request(
      `/api/screenings/${id}/responses`,
      "GET",
      undefined,
      owner.cookie,
    )
  ).json();
  assert.equal(managed.items.length, 1);
  assert.equal(managed.publications[0].status, "revoked");
  const expired = await publish(id);
  store.db
    .prepare("UPDATE screening_publications SET expires_at = ? WHERE id = ?")
    .run(Date.now() - 1, expired.id);
  assert.equal((await request(`/api/interviews/${expired.token}`)).status, 404);
  assert.equal((await request("/api/interviews/not-a-token")).status, 404);
});

test("screening deletion cascades publication tokens and personally identifiable responses", async () => {
  const id = screening();
  const publication = await publish(id);
  const form = await publicForm(publication.token);
  await request(
    `/api/interviews/${publication.token}/responses`,
    "POST",
    answers(form),
  );
  store.db
    .prepare("DELETE FROM resources WHERE id = ? AND workspace_id = ?")
    .run(id, owner.workspaceId);
  assert.equal(
    store.db
      .prepare("SELECT id FROM screening_publications WHERE id = ?")
      .get(publication.id),
    undefined,
  );
  assert.equal(
    store.db
      .prepare("SELECT id FROM screening_responses WHERE screening_id = ?")
      .get(id),
    undefined,
  );
  assert.equal(
    (await request(`/api/interviews/${publication.token}`)).status,
    404,
  );
});

test("publishing validates bounded question types and options", async () => {
  for (const questions of [
    [],
    [{ prompt: "Voice question", type: "voice", options: [], required: true }],
    [
      {
        prompt: "Pick",
        type: "multiple-choice",
        options: ["Same", "Same"],
        required: true,
      },
    ],
    Array.from({ length: 51 }, () => ({ prompt: "Question", type: "text" })),
  ]) {
    const id = screening({ questions });
    assert.equal(
      (await request(`/api/screenings/${id}/publish`, "POST", {}, owner.cookie))
        .status,
      400,
    );
  }
});

test("real application registration enforces Origin before public screening writes and preserves public reads", async () => {
  const integrated = createApp({ store, appOrigin: ORIGIN, openAiApiKey: "" });
  const integratedServer = await new Promise<Server>((resolve) => {
    const running = integrated.listen(0, "127.0.0.1", () => resolve(running));
  });
  try {
    const address = integratedServer.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const id = screening();
    const endpoint = `${origin}/api/screenings/${id}/publish`;
    assert.equal(
      (
        await fetch(endpoint, {
          method: "POST",
          headers: { Cookie: owner.cookie, "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(endpoint, {
          method: "POST",
          headers: {
            Cookie: owner.cookie,
            Origin: "https://foreign.example",
            "Content-Type": "application/json",
          },
          body: "{}",
        })
      ).status,
      403,
    );
    const published = await fetch(endpoint, {
      method: "POST",
      headers: {
        Cookie: owner.cookie,
        Origin: ORIGIN,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    assert.equal(published.status, 201);
    const { item } = await published.json();
    const publicRead = await fetch(`${origin}/api/interviews/${item.token}`);
    assert.equal(publicRead.status, 200);
    const form = (await publicRead.json()).item;
    assert.equal(
      (
        await fetch(`${origin}/api/interviews/${item.token}/responses`, {
          method: "POST",
          headers: {
            Origin: "https://foreign.example",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(answers(form)),
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(`${origin}/api/screenings/${id}/responses`)).status,
      401,
    );
    assert.equal(
      (
        await fetch(`${origin}/api/screenings/${id}/responses`, {
          headers: { Cookie: other.cookie },
        })
      ).status,
      404,
    );
  } finally {
    await new Promise<void>((resolve) =>
      integratedServer.close(() => resolve()),
    );
  }
});
