import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import express from "express";
import { createDatabase } from "../../server/db.js";
import { hashToken } from "../../server/auth.js";
import { initializeAccess } from "../../server/access.js";
import { registerApplicationDocuments } from "../../server/application-documents.js";
import { registerApplicationReview } from "../../server/application-review.js";
import type { createAi } from "../../server/ai.js";
import { pdfFixture, docxFixture } from "./document-fixtures.js";

const docxMime =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "arkoffer-cv-")),
    store = createDatabase(directory);
  initializeAccess(store);
  function identity(workspaceId = randomUUID()) {
    const id = randomUUID(),
      token = randomBytes(32).toString("hex"),
      now = new Date().toISOString();
    store.db
      .prepare(
        "INSERT OR IGNORE INTO workspaces(id,name,created_at) VALUES(?,?,?)",
      )
      .run(workspaceId, "CV tests", now);
    store.db
      .prepare(
        "INSERT INTO users(id,workspace_id,name,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        id,
        workspaceId,
        "Reviewer",
        `${id}@example.test`,
        "unused",
        "member",
        now,
      );
    store.db
      .prepare(
        "INSERT INTO sessions(token_hash,user_id,workspace_id,expires_at,created_at) VALUES(?,?,?,?,?)",
      )
      .run(hashToken(token), id, workspaceId, Date.now() + 3600000, now);
    return { id, workspaceId, cookie: `arkoffer_session=${token}` };
  }
  const owner = identity(),
    teammate = identity(owner.workspaceId),
    other = identity();
  const insert = (kind: string, data: Record<string, unknown> = {}) => {
    const now = new Date().toISOString(),
      item = { id: randomUUID(), createdAt: now, updatedAt: now, ...data };
    store.insert(owner.workspaceId, kind, item);
    return item;
  };
  const job = insert("jobs", {
      title: "Engineer",
      description: "TypeScript experience",
    }),
    application = insert("applications", {
      name: "Synthetic Applicant",
      jobId: job.id,
      status: "in_review",
    }),
    second = insert("applications", { jobId: job.id });
  const criterion = {
    id: randomUUID(),
    text: "TypeScript experience",
    importance: "required",
  };
  const prompts: any[] = [];
  let complete = async (messages: any[]) => {
    const data = JSON.parse(messages[1].content);
    return JSON.stringify({
      criteria: [
        {
          criterionId: criterion.id,
          evidence: [
            { sourceId: data.sources[0].id, quote: "Built TypeScript APIs" },
          ],
          missingInformation: "Scale is not established.",
          followUp: "What was the project scope?",
        },
      ],
    });
  };
  const ai = {
    provider: "test",
    model: "fixture",
    configured: true,
    allowed: () => true,
    complete: async (messages: any[]) => {
      prompts.push(messages);
      return complete(messages);
    },
  } as ReturnType<typeof createAi>;
  const app = express();
  app.use(express.json());
  registerApplicationDocuments(app, store);
  registerApplicationReview(app, store, { ai });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const call = (path: string, method = "GET", body?: unknown, who = owner) =>
    fetch(`${base}/api/${path}`, {
      method,
      headers: {
        Cookie: who.cookie,
        ...(body instanceof FormData
          ? {}
          : { "Content-Type": "application/json" }),
      },
      body:
        body === undefined
          ? undefined
          : body instanceof FormData
            ? body
            : JSON.stringify(body),
    });
  const path = (id = application.id) => `applications/${id}/documents`;
  const upload = (
    bytes = pdfFixture(["Built TypeScript APIs"]),
    mime = "application/pdf",
    name = "Alex CV.pdf",
    who = owner,
    appId = application.id,
  ) => {
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(bytes)], { type: mime }),
      name,
    );
    return call(path(appId), "POST", form, who);
  };
  const reference = (source: any) => ({
    id: source.id,
    fingerprint: source.fingerprint,
  });
  const reviewPath = `applications/${application.id}/review-assistance`;
  const analyze = (
    source: any,
    extra: Record<string, unknown> = {},
    who = owner,
  ) =>
    call(
      reviewPath,
      "POST",
      {
        requestId: randomUUID(),
        criteriaRevision: 1,
        conversationIds: [],
        documents: [reference(source)],
        consent: true,
        ...extra,
      },
      who,
    );
  assert.equal(
    (
      await call(`jobs/${job.id}/review-criteria`, "PUT", {
        revision: 0,
        criteria: [criterion],
        approved: true,
      })
    ).status,
    200,
  );
  return {
    directory,
    store,
    base,
    owner,
    teammate,
    other,
    insert,
    application,
    second,
    job,
    criterion,
    prompts,
    call,
    path,
    upload,
    reference,
    reviewPath,
    analyze,
    setComplete: (value: typeof complete) => {
      complete = value;
    },
  };
}

test("PDF and DOCX CVs remain private to author, workspace and application; originals are removed", async (t) => {
  const f = await fixture(t);
  for (const [bytes, mime, name] of [
    [pdfFixture(["Built TypeScript APIs"]), "application/pdf", "Alex CV.pdf"],
    [docxFixture(["Built TypeScript APIs"]), docxMime, "Alex CV.docx"],
  ] as const) {
    const response = await f.upload(bytes, mime, name);
    assert.equal(response.status, 201);
    const source = (await response.json()).item;
    assert.match(source.text, /Built TypeScript APIs/);
    assert.deepEqual(
      readdirSync(join(f.directory, "application-document-uploads")),
      [],
    );
    const list = (await (await f.call(f.path())).json()).items;
    assert.equal(
      list.find((item: any) => item.id === source.id).text,
      undefined,
    );
    assert.equal((await f.call(`${f.path()}/${source.id}`)).status, 200);
    for (const who of [f.teammate, f.other]) {
      assert.ok(
        [200, 404].includes(
          (await f.call(f.path(), "GET", undefined, who)).status,
        ),
      );
      assert.equal(
        (await f.call(`${f.path()}/${source.id}`, "GET", undefined, who))
          .status,
        404,
      );
      assert.equal(
        (await f.call(`${f.path()}/${source.id}`, "DELETE", undefined, who))
          .status,
        404,
      );
      assert.equal((await f.analyze(source, {}, who)).status, 404);
    }
    assert.equal(
      (await f.call(`${f.path(f.second.id)}/${source.id}`)).status,
      404,
    );
    assert.equal(
      (await f.call(`${f.path(f.second.id)}/${source.id}`, "DELETE")).status,
      404,
    );
    assert.equal(f.prompts.length, 0);
    assert.equal(f.store.list(f.owner.workspaceId, "conversations").length, 0);
    assert.ok(
      !JSON.stringify(
        f.store.get(f.owner.workspaceId, "applications", f.application.id),
      ).includes("Built TypeScript APIs"),
    );
    assert.equal(
      (await f.call(`${f.path()}/${source.id}`, "DELETE")).status,
      200,
    );
  }
});

test("invalid, oversized and overlong CVs fail with no originals or extracted text retained", async (t) => {
  const f = await fixture(t);
  for (const [bytes, mime, code] of [
    [Buffer.from("invalid"), "application/pdf", 422],
    [Buffer.from("text"), "text/plain", 415],
    [Buffer.alloc(10 * 1024 * 1024 + 1), "application/pdf", 413],
    [docxFixture(["x".repeat(60001)]), docxMime, 413],
  ] as const) {
    assert.equal((await f.upload(bytes, mime)).status, code);
    assert.deepEqual(
      readdirSync(join(f.directory, "application-document-uploads")),
      [],
    );
    assert.equal((await (await f.call(f.path())).json()).items.length, 0);
  }
  assert.equal((await f.call(f.path(), "POST", new FormData())).status, 400);
});

test("CV selection supplies server-resolved exact quotes and never changes an application decision", async (t) => {
  const f = await fixture(t),
    source = (await (await f.upload()).json()).item;
  assert.equal(
    (
      await f.analyze(source, {
        documents: [{ ...f.reference(source), text: "injected" }],
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.analyze(source, {
        documents: [{ id: source.id, fingerprint: "0".repeat(64) }],
      })
    ).status,
    409,
  );
  assert.equal((await f.analyze(source, { consent: false })).status, 400);
  assert.equal(
    (
      await f.analyze(source, {
        documents: [f.reference(source), f.reference(source)],
      })
    ).status,
    400,
  );
  assert.equal(f.prompts.length, 0);
  const requestId = randomUUID(),
    response = await f.analyze(source, { requestId });
  assert.equal(response.status, 201);
  const review = (await response.json()).item;
  assert.equal(
    review.output.criteria[0].evidence[0].quote,
    "Built TypeScript APIs",
  );
  assert.deepEqual(JSON.parse(f.prompts[0][1].content).sources, [
    { id: `document:${source.id}`, title: source.title, text: source.text },
  ]);
  assert.equal((await f.analyze(source, { requestId })).status, 200);
  assert.equal(f.prompts.length, 1);
  assert.equal(
    f.store.get(f.owner.workspaceId, "applications", f.application.id)!.status,
    "in_review",
  );
  assert.equal(
    (await (await f.call(f.reviewPath, "GET", undefined, f.teammate)).json())
      .items.length,
    0,
  );
  f.setComplete(async () =>
    JSON.stringify({
      criteria: [
        {
          criterionId: f.criterion.id,
          evidence: [
            { sourceId: `document:${source.id}`, quote: "Invented experience" },
          ],
          missingInformation: "",
          followUp: "",
        },
      ],
    }),
  );
  assert.equal((await f.analyze(source)).status, 502);
});

test("deleted or changed CVs hide derived output and reviewer notes on history, replay and save", async (t) => {
  const f = await fixture(t);
  for (const change of ["delete", "edit"]) {
    const source = (await (await f.upload()).json()).item,
      requestId = randomUUID();
    const review = (await (await f.analyze(source, { requestId })).json()).item;
    assert.equal(
      (
        await f.call(`${f.reviewPath}/${review.id}`, "PATCH", {
          notes: "Private follow-up",
          reviewed: true,
        })
      ).status,
      200,
    );
    if (change === "delete") await f.call(`${f.path()}/${source.id}`, "DELETE");
    else
      f.store.db
        .prepare(
          "UPDATE application_documents SET text='Changed evidence' WHERE id=?",
        )
        .run(source.id);
    const stale = (await (await f.call(f.reviewPath)).json()).items.find(
      (item: any) => item.id === review.id,
    );
    assert.equal(stale.status, "stale");
    assert.equal(stale.output, undefined);
    assert.equal(stale.notes, undefined);
    assert.ok(
      [404, 409].includes((await f.analyze(source, { requestId })).status),
    );
    assert.equal(
      (
        await f.call(`${f.reviewPath}/${review.id}`, "PATCH", {
          notes: "Do not save",
          reviewed: true,
        })
      ).status,
      409,
    );
  }
  assert.equal(f.prompts.length, 2);
});

test("CV deletion while generation is pending discards output", async (t) => {
  const f = await fixture(t),
    source = (await (await f.upload()).json()).item;
  f.setComplete(async () => {
    f.store.db
      .prepare("DELETE FROM application_documents WHERE id=?")
      .run(source.id);
    return JSON.stringify({
      criteria: [
        {
          criterionId: f.criterion.id,
          evidence: [
            {
              sourceId: `document:${source.id}`,
              quote: "Built TypeScript APIs",
            },
          ],
          missingInformation: "",
          followUp: "",
        },
      ],
    });
  });
  assert.equal((await f.analyze(source)).status, 409);
  const row = f.store.db
    .prepare("SELECT status,output FROM application_review_runs")
    .get()!;
  assert.equal(row.status, "failed");
  assert.equal(row.output, null);
  assert.equal(
    (await (await f.call(f.reviewPath)).json()).items[0].output,
    undefined,
  );
});

test("CV retention and workspace upload budgets cannot be reset by deleting documents or applications", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 5; i++) {
    f.store.db
      .prepare("INSERT INTO application_documents VALUES(?,?,?,?,?,?,?,?,?)")
      .run(
        randomUUID(),
        f.owner.workspaceId,
        f.owner.id,
        f.application.id,
        "CV",
        "Evidence",
        "pdf",
        8,
        Date.now(),
      );
  }
  assert.equal((await f.upload()).status, 400);
  assert.equal(
    f.store.db
      .prepare("SELECT count(*) AS n FROM application_document_attempts")
      .get()!.n,
    0,
  );
  f.store.db.prepare("DELETE FROM resources WHERE id=?").run(f.application.id);
  assert.equal(
    f.store.db.prepare("SELECT count(*) AS n FROM application_documents").get()!
      .n,
    0,
  );
  for (let i = 0; i < 20; i++)
    f.store.db
      .prepare("INSERT INTO application_document_attempts VALUES(?,?,?)")
      .run(randomUUID(), f.owner.workspaceId, Date.now());
  assert.equal(
    (await f.upload(undefined, undefined, undefined, undefined, f.second.id))
      .status,
    429,
  );
  assert.deepEqual(
    readdirSync(join(f.directory, "application-document-uploads")),
    [],
  );
});

test("combined CV evidence limits are enforced before provider calls", async (t) => {
  const f = await fixture(t),
    source = (
      await (await f.upload(docxFixture(["x".repeat(31000)]), docxMime)).json()
    ).item;
  const second = (
    await (await f.upload(docxFixture(["y".repeat(31000)]), docxMime)).json()
  ).item;
  assert.equal(
    (
      await f.analyze(source, {
        documents: [f.reference(source), f.reference(second)],
      })
    ).status,
    400,
  );
  assert.equal(f.prompts.length, 0);
});

test("workspace access revoked during multipart upload cannot retain extracted CV text", async (t) => {
  const f = await fixture(t),
    boundary = `cv-${randomUUID()}`;
  const bytes = pdfFixture(["Built TypeScript APIs"]),
    middle = Math.floor(bytes.length / 2);
  let finish!: (status: number) => void, reject!: (error: Error) => void;
  const result = new Promise<number>((resolve, fail) => {
    finish = resolve;
    reject = fail;
  });
  const req = httpRequest(
    `${f.base}/api/${f.path()}`,
    {
      method: "POST",
      headers: {
        Cookie: f.owner.cookie,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
    },
    (response) => {
      response.resume();
      response.on("end", () => finish(response.statusCode!));
    },
  );
  req.on("error", reject);
  req.write(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="Resume.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
  );
  req.write(bytes.subarray(0, middle));
  const directory = join(f.directory, "application-document-uploads");
  for (let i = 0; i < 200 && !readdirSync(directory).length; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(readdirSync(directory).length, 1);
  f.store.db
    .prepare(
      "UPDATE memberships SET status='suspended' WHERE workspace_id=? AND user_id=?",
    )
    .run(f.owner.workspaceId, f.owner.id);
  req.write(bytes.subarray(middle));
  req.end(`\r\n--${boundary}--\r\n`);
  assert.equal(await result, 401);
  assert.deepEqual(readdirSync(directory), []);
  assert.equal(
    f.store.db.prepare("SELECT count(*) AS n FROM application_documents").get()!
      .n,
    0,
  );
});
