import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { createDatabase } from "../../server/db.js";
import { hashToken } from "../../server/auth.js";
import { registerScreeningWorkspaces } from "../../server/screening-workspaces.js";
import { registerScreening } from "../../server/screening.js";
import { newScreeningConfig } from "../../shared/screening.js";

async function fixture(t: TestContext) {
  const directory = mkdtempSync(
      join(tmpdir(), "arkoffer-screening-workspace-"),
    ),
    store = createDatabase(directory);
  function identity() {
    const id = randomUUID(),
      workspaceId = randomUUID(),
      token = randomBytes(32).toString("hex"),
      now = new Date().toISOString();
    store.db
      .prepare("INSERT INTO workspaces(id,name,created_at) VALUES(?,?,?)")
      .run(workspaceId, "Synthetic hiring team", now);
    store.db
      .prepare(
        "INSERT INTO users(id,workspace_id,name,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        id,
        workspaceId,
        "Screen tester",
        `${id}@example.test`,
        "unused",
        "owner",
        now,
      );
    store.db
      .prepare(
        "INSERT INTO sessions(token_hash,user_id,workspace_id,expires_at,created_at) VALUES(?,?,?,?,?)",
      )
      .run(hashToken(token), id, workspaceId, Date.now() + 3600000, now);
    return { workspaceId, cookie: `arkoffer_session=${token}` };
  }
  const owner = identity(),
    other = identity();
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  registerScreeningWorkspaces(app, store);
  registerScreening(app, store);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const call = (
    path: string,
    method = "GET",
    body?: unknown,
    cookie = owner.cookie,
  ) =>
    fetch(`http://127.0.0.1:${address.port}/api/${path}`, {
      method,
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  function payload() {
    const config = newScreeningConfig();
    config.sections[0].questions = [
      {
        id: randomUUID(),
        prompt: "Describe a reliable API you built.",
        type: "text",
        options: [],
        required: true,
        rubric: "Private rubric sentinel",
        followUp: false,
      },
    ];
    config.context.role = "Private role context sentinel";
    config.sections[0].goal = "Private section goal sentinel";
    return {
      title: "API engineer",
      description: "Share your experience.",
      jobId: "",
      screeningConfig: config,
    };
  }
  return { store, owner, other, call, payload };
}

test("screening workspace saves sections and rejects stale edits or foreign records without losing the latest draft", async (t) => {
  const f = await fixture(t),
    body = f.payload();
  assert.equal(
    (await f.call("screening-workspaces", "GET", undefined, "")).status,
    401,
  );
  const create = await f.call("screening-workspaces", "POST", body);
  assert.equal(create.status, 201);
  const item = (await create.json()).item;
  assert.equal(item.questions[0].sectionTitle, "Experience and motivation");
  assert.equal(item.questions[0].rubric, "Private rubric sentinel");
  assert.equal(
    (
      await f.call(
        `screening-workspaces/${item.id}`,
        "GET",
        undefined,
        f.other.cookie,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await f.call(
        `screening-workspaces/${item.id}`,
        "PATCH",
        { ...body, revision: item.updatedAt },
        f.other.cookie,
      )
    ).status,
    404,
  );
  const result = await Promise.all(
    ["First concurrent edit", "Second concurrent edit"].map((title) =>
      f.call(`screening-workspaces/${item.id}`, "PATCH", {
        ...body,
        title,
        revision: item.updatedAt,
      }),
    ),
  );
  assert.deepEqual(
    result.map((response) => response.status).sort(),
    [200, 409],
  );
  const saved = (await (await f.call(`screening-workspaces/${item.id}`)).json())
    .item;
  assert.notEqual(saved.updatedAt, item.updatedAt);
  assert.equal(
    (await f.call(`screening-workspaces/${item.id}`, "PATCH", { ...body }))
      .status,
    409,
  );
  assert.equal(
    (
      await (
        await f.call("screening-workspaces", "GET", undefined, f.other.cookie)
      ).json()
    ).items.length,
    0,
  );
});

test("screening publication consumes configurable expiry, welcome, voice, sections and follow-up setting while excluding private context and rubric", async (t) => {
  const f = await fixture(t),
    body = f.payload();
  body.screeningConfig.outreach.deadlineDays = 3;
  body.screeningConfig.setup.language = "fr-FR";
  body.screeningConfig.setup.voice = "Local French voice";
  const item = (
    await (await f.call("screening-workspaces", "POST", body)).json()
  ).item;
  const before = Date.now();
  const publication = await f.call(`screenings/${item.id}/publish`, "POST", {});
  assert.equal(publication.status, 201);
  const published = (await publication.json()).item;
  assert.ok(
    Math.abs(Date.parse(published.expiresAt) - (before + 3 * 86400000)) < 3000,
  );
  const publicItem = (
    await (
      await f.call(`interviews/${published.token}`, "GET", undefined, "")
    ).json()
  ).item;
  assert.equal(publicItem.setup.language, "fr-FR");
  assert.equal(publicItem.setup.voice, "Local French voice");
  assert.match(
    publicItem.setup.welcomeMessage,
    /API engineer with Synthetic hiring team/,
  );
  assert.equal(publicItem.questions[0].followUp, false);
  assert.equal(
    publicItem.questions[0].sectionTitle,
    "Experience and motivation",
  );
  assert.doesNotMatch(
    JSON.stringify(publicItem),
    /Private|rubric|goal|context/,
  );
  await f.call(`screening-workspaces/${item.id}`, "PATCH", {
    ...body,
    revision: item.updatedAt,
    screeningConfig: {
      ...body.screeningConfig,
      setup: { ...body.screeningConfig.setup, welcomeMessage: "New welcome" },
      outreach: { deadlineDays: 30 },
    },
  });
  const frozen = (
    await (
      await f.call(`interviews/${published.token}`, "GET", undefined, "")
    ).json()
  ).item;
  assert.deepEqual(frozen, publicItem);
});

test("screening configuration rejects unsupported operational settings, duplicate identities, excessive limits and inaccessible role references", async (t) => {
  const f = await fixture(t),
    body = f.payload();
  for (const days of [0, 31, 2.5])
    assert.equal(
      (
        await f.call("screening-workspaces", "POST", {
          ...body,
          screeningConfig: {
            ...body.screeningConfig,
            outreach: { deadlineDays: days },
          },
        })
      ).status,
      400,
    );
  assert.equal(
    (
      await f.call("screening-workspaces", "POST", {
        ...body,
        screeningConfig: {
          ...body.screeningConfig,
          setup: { ...body.screeningConfig.setup, camera: "on" },
        },
      })
    ).status,
    400,
  );
  const section = body.screeningConfig.sections[0];
  assert.equal(
    (
      await f.call("screening-workspaces", "POST", {
        ...body,
        screeningConfig: {
          ...body.screeningConfig,
          sections: [section, { ...section, title: "Duplicate" }],
        },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.call("screening-workspaces", "POST", {
        ...body,
        jobId: randomUUID(),
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await f.call("screening-workspaces", "POST", {
        ...body,
        screeningConfig: {
          ...body.screeningConfig,
          context: { role: "x".repeat(12001), company: "" },
        },
      })
    ).status,
    400,
  );
  assert.equal(f.store.list(f.owner.workspaceId, "screenings").length, 0);
});

test("legacy screening editing preserves questions and private rubric until an explicit versioned save", async (t) => {
  const f = await fixture(t),
    id = randomUUID(),
    now = new Date().toISOString();
  f.store.insert(f.owner.workspaceId, "screenings", {
    id,
    name: "Legacy questionnaire",
    createdAt: now,
    updatedAt: now,
    questions: [
      {
        prompt: "Legacy prompt",
        type: "yes-no",
        required: false,
        options: [],
        rubric: "Legacy private rubric",
      },
    ],
  });
  const result = (await (await f.call(`screening-workspaces/${id}`)).json())
    .item;
  assert.equal(
    result.screeningConfig.sections[0].questions[0].prompt,
    "Legacy prompt",
  );
  assert.equal(
    result.screeningConfig.sections[0].questions[0].rubric,
    "Legacy private rubric",
  );
  assert.equal(
    f.store.get(f.owner.workspaceId, "screenings", id)?.screeningConfig,
    undefined,
  );
  const save = await f.call(`screening-workspaces/${id}`, "PATCH", {
    title: result.title,
    description: result.description,
    jobId: result.jobId,
    screeningConfig: result.screeningConfig,
    revision: result.updatedAt,
  });
  assert.equal(save.status, 200);
  assert.equal(
    f.store.get(f.owner.workspaceId, "screenings", id)?.screeningConfig !==
      undefined,
    true,
  );
});

test("screening workspace create budget applies while existing drafts remain editable", async (t) => {
  const f = await fixture(t),
    now = new Date().toISOString();
  let firstId = "";
  f.store.transaction(() => {
    for (let i = 0; i < 1000; i++) {
      const id = randomUUID();
      if (i === 0) firstId = id;
      f.store.insert(f.owner.workspaceId, "screenings", {
        id,
        name: `Draft ${i}`,
        createdAt: now,
        updatedAt: now,
      });
    }
  });
  assert.equal(
    (await f.call("screening-workspaces", "POST", f.payload())).status,
    409,
  );
  assert.equal(
    (
      await f.call(`screening-workspaces/${firstId}`, "PATCH", {
        ...f.payload(),
        revision: now,
      })
    ).status,
    200,
  );
});
