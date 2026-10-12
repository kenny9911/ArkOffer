import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { createDatabase } from "../../server/db.js";
import { hashToken } from "../../server/auth.js";
import { registerSourcing, sourcingQuery } from "../../server/sourcing.js";
import type { createAi } from "../../server/ai.js";
const criteria = (overrides: Record<string, string[]> = {}) => ({
  titles: [],
  locations: [],
  skills: [],
  companies: [],
  keywords: [],
  excludeCompanies: [],
  ...overrides,
});
const plan = () =>
  JSON.stringify({
    criteria: criteria({ titles: ["engineer"], skills: ["TypeScript"] }),
    summary: "Search engineering roles with TypeScript.",
    unresolved: ["Review years of experience separately."],
  });
async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "arkoffer-sourcing-")),
    store = createDatabase(dir);
  function identity(workspaceId = randomUUID()) {
    const id = randomUUID(),
      token = randomBytes(32).toString("hex"),
      date = new Date().toISOString();
    store.db
      .prepare(
        "INSERT OR IGNORE INTO workspaces(id,name,created_at) VALUES(?,?,?)",
      )
      .run(workspaceId, "Synthetic sourcing", date);
    store.db
      .prepare(
        "INSERT INTO users(id,workspace_id,name,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        id,
        workspaceId,
        "Tester",
        `${id}@example.com`,
        "unused",
        "owner",
        date,
      );
    store.db
      .prepare(
        "INSERT INTO sessions(token_hash,user_id,workspace_id,expires_at,created_at) VALUES(?,?,?,?,?)",
      )
      .run(hashToken(token), id, workspaceId, Date.now() + 3600_000, date);
    return { id, workspaceId, token, cookie: `arkoffer_session=${token}` };
  }
  const owner = identity(),
    teammate = identity(owner.workspaceId),
    other = identity();
  let aiAllowed = true,
    calls = 0,
    providerCalls = 0,
    complete: () => Promise<string> = async () => plan(),
    messages: any;
  const env: NodeJS.ProcessEnv = {
    PDL_API_KEY: "synthetic-key",
    SOURCING_WORKSPACE_IDS: owner.workspaceId,
  };
  let fetcher: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        status: 200,
        total: 1,
        data: [
          {
            id: "synthetic-provider-id",
            full_name: "Synthetic Person",
            job_title: "Engineer",
            job_company_name: "Example Studio",
            location_name: "Singapore",
            skills: ["typescript"],
            linkedin_url: "https://www.linkedin.com/in/synthetic-person",
            personal_emails: ["private@example.test"],
            mobile_phone: "private-number",
            birth_year: 1990,
            gender: "private",
          },
        ],
      }),
      { status: 200 },
    );
  let providerInput: { url: string; init?: RequestInit } | undefined;
  const ai = {
    provider: "synthetic",
    model: "synthetic",
    configured: true,
    allowed: () => aiAllowed,
    complete: async (input: any) => {
      calls++;
      messages = input;
      return complete();
    },
  } as ReturnType<typeof createAi>;
  const app = express();
  app.use(express.json());
  registerSourcing(app, store, {
    ai,
    env,
    fetch: async (input, init) => {
      providerCalls++;
      providerInput = { url: String(input), init };
      return fetcher(input, init);
    },
  });
  app.use((e: any, _req: any, res: any, _next: any) =>
    res.status(500).json({ error: e.message }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const call = (cookie: string, path: string, method = "GET", body?: unknown) =>
    fetch(`http://127.0.0.1:${address.port}/api/${path}`, {
      method,
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const candidate = (
    details: Record<string, unknown> = {},
    workspaceId = owner.workspaceId,
  ) => {
    const now = new Date().toISOString();
    return store.insert(workspaceId, "candidates", {
      id: randomUUID(),
      name: "Synthetic Engineer",
      role: "Platform Engineer",
      company: "Example Studio",
      location: "Singapore",
      skills: "TypeScript, Kubernetes",
      email: "not-for-ai@example.test",
      notes: "Private recruiting notes",
      createdAt: now,
      updatedAt: now,
      ...details,
    });
  };
  const create = async (overrides: Record<string, unknown> = {}) => {
    const input = {
      requestId: randomUUID(),
      prompt: "Find engineers",
      manual: true,
      ...overrides,
    };
    const r = await call(owner.cookie, "sourcing/sessions", "POST", input);
    assert.equal(r.status, 201, await r.clone().text());
    return { item: (await r.json()).item, input };
  };
  const save = async (item: any, changes: Record<string, unknown> = {}) => {
    const r = await call(
      owner.cookie,
      `sourcing/sessions/${item.id}`,
      "PATCH",
      {
        revision: item.revision,
        title: item.title,
        criteria: criteria({ titles: ["engineer"] }),
        source: item.source,
        mode: item.mode,
        ...changes,
      },
    );
    assert.equal(r.status, 200, await r.clone().text());
    return (await r.json()).item;
  };
  const run = async (item: any, changes: Record<string, unknown> = {}) => {
    const input = {
      requestId: randomUUID(),
      revision: item.revision,
      consent: true,
      ...changes,
    };
    const r = await call(
      owner.cookie,
      `sourcing/sessions/${item.id}/runs`,
      "POST",
      input,
    );
    return { response: r, input };
  };
  return {
    store,
    owner,
    teammate,
    other,
    call,
    candidate,
    create,
    save,
    run,
    env,
    calls: () => calls,
    providerCalls: () => providerCalls,
    providerInput: () => providerInput,
    messages: () => messages,
    setComplete: (fn: () => Promise<string>) => {
      complete = fn;
    },
    setAllowed: (value: boolean) => {
      aiAllowed = value;
    },
    setFetch: (fn: typeof fetch) => {
      fetcher = fn;
    },
  };
}
test("sourcing private plans, criteria matches and review evidence survive reload without changing shared candidate state", async (t) => {
  const f = await fixture(t),
    person = f.candidate();
  f.candidate({ name: "Different location", location: "London" });
  f.candidate({ name: "Excluded company", company: "Avoid Ltd" });
  f.candidate({ name: "Other workspace" }, f.other.workspaceId);
  let { item } = await f.create();
  item = await f.save(item, {
    criteria: criteria({
      titles: ["engineer"],
      locations: ["Singapore"],
      skills: ["TypeScript"],
      excludeCompanies: ["Avoid"],
    }),
  });
  const { response } = await f.run(item);
  assert.equal(response.status, 201);
  const pack = (await response.json()).item;
  assert.equal(pack.results.length, 1);
  assert.equal(pack.results[0].name, person.name);
  assert.equal(JSON.stringify(pack).includes("not-for-ai"), false);
  assert.equal(
    JSON.stringify(pack).includes("Private recruiting notes"),
    false,
  );
  const review = await f.call(
    f.owner.cookie,
    `sourcing/sessions/${item.id}/reviews`,
    "PATCH",
    {
      runId: pack.id,
      key: pack.results[0].key,
      status: "yes",
      notes: "Discuss TypeScript experience.",
    },
  );
  assert.equal(review.status, 200);
  assert.equal(
    f.store.get(f.owner.workspaceId, "candidates", person.id)?.status,
    undefined,
  );
  const loaded = await (
    await f.call(f.owner.cookie, `sourcing/sessions/${item.id}`)
  ).json();
  assert.equal(loaded.item.runs[0].results[0].review.status, "yes");
  assert.equal(
    (await (await f.call(f.teammate.cookie, "sourcing")).json()).sessions
      .length,
    0,
  );
  assert.equal(
    (await f.call(f.teammate.cookie, `sourcing/sessions/${item.id}`)).status,
    404,
  );
  assert.equal(
    (await f.call(f.other.cookie, `sourcing/sessions/${item.id}`)).status,
    404,
  );
  const csv = await (
    await f.call(
      f.owner.cookie,
      `sourcing/sessions/${item.id}/runs/${pack.id}/export.csv`,
    )
  ).text();
  assert.match(csv, /Discuss TypeScript/);
  assert.doesNotMatch(csv, /Private recruiting/);
  f.store.update(f.owner.workspaceId, "candidates", {
    ...person,
    role: "Changed role",
  });
  const hidden = await (
    await f.call(f.owner.cookie, `sourcing/sessions/${item.id}`)
  ).json();
  assert.equal(hidden.item.runs[0].results.length, 0);
  assert.equal(hidden.item.runs[0].unavailable, 1);
  assert.equal(
    (
      await f.call(
        f.owner.cookie,
        `sourcing/sessions/${item.id}/import`,
        "POST",
        { runId: pack.id, keys: [pack.results[0].key], confirm: true },
      )
    ).status,
    409,
  );
});
test("sourcing AI plans use only professional reference fields and retain idempotency after deletion", async (t) => {
  const f = await fixture(t),
    reference = f.candidate();
  const { item, input } = await f.create({
    manual: false,
    mode: "lookalikes",
    referenceId: reference.id,
  });
  assert.equal(item.status, "draft");
  assert.equal(item.criteria.titles[0], "engineer");
  assert.match(item.events[1].unresolved[0], /years/);
  assert.doesNotMatch(
    JSON.stringify(f.messages()),
    /not-for-ai|Private recruiting notes/,
  );
  assert.equal(f.calls(), 1);
  assert.equal(
    (await f.call(f.owner.cookie, "sourcing/sessions", "POST", input)).status,
    200,
  );
  assert.equal(f.calls(), 1);
  assert.equal(
    (
      await f.call(f.owner.cookie, "sourcing/sessions", "POST", {
        ...input,
        prompt: "Different brief",
      })
    ).status,
    409,
  );
  await f.call(f.owner.cookie, `sourcing/sessions/${item.id}`, "DELETE", {});
  assert.equal(
    (await f.call(f.owner.cookie, "sourcing/sessions", "POST", input)).status,
    410,
  );
  assert.equal(f.calls(), 1);
});
test("invalid AI output becomes a recoverable manual draft without invented results", async (t) => {
  const f = await fixture(t);
  f.setComplete(async () =>
    JSON.stringify({
      criteria: criteria(),
      summary: "Bad shape",
      unresolved: [],
      candidates: [{ name: "Invented" }],
    }),
  );
  const { item } = await f.create({ manual: false });
  assert.equal(item.status, "failed");
  assert.equal(item.runs.length, 0);
  assert.equal(f.store.list(f.owner.workspaceId, "candidates").length, 0);
  assert.equal((await f.save(item)).status, "draft");
  f.setAllowed(false);
  assert.equal(
    (
      await f.call(f.owner.cookie, "sourcing/sessions", "POST", {
        requestId: randomUUID(),
        prompt: "Find engineers",
      })
    ).status,
    503,
  );
  assert.equal((await f.create()).item.status, "draft");
});
test("session revocation and changed reference block delayed AI plans", async (t) => {
  const f = await fixture(t),
    ref = f.candidate();
  let resolve!: () => void;
  const wait = new Promise<void>((r) => (resolve = r));
  f.setComplete(async () => {
    await wait;
    return plan();
  });
  const request = f.call(f.owner.cookie, "sourcing/sessions", "POST", {
    requestId: randomUUID(),
    prompt: "Find peers",
    mode: "lookalikes",
    referenceId: ref.id,
  });
  while (f.calls() === 0) await new Promise((r) => setTimeout(r, 2));
  f.store.db
    .prepare("DELETE FROM sessions WHERE token_hash=?")
    .run(hashToken(f.owner.token));
  resolve();
  assert.equal((await request).status, 401);
  const row = f.store.db
    .prepare("SELECT status,criteria FROM sourcing_sessions WHERE user_id=?")
    .get(f.owner.id)!;
  assert.equal(row.status, "failed");
  assert.doesNotMatch(String(row.criteria), /engineer/);
});
test("PDL discovery is explicit, paid-call bounded, professional-only and import is deduplicated", async (t) => {
  const f = await fixture(t);
  let { item } = await f.create({ source: "pdl" });
  item = await f.save(item);
  const { response, input } = await f.run(item);
  assert.equal(response.status, 201, await response.clone().text());
  const pack = (await response.json()).item;
  assert.equal(pack.results[0].name, "Synthetic Person");
  assert.doesNotMatch(
    JSON.stringify(pack),
    /private-number|private@example|birth_year|gender/,
  );
  assert.equal(f.store.list(f.owner.workspaceId, "candidates").length, 0);
  assert.equal(f.providerCalls(), 1);
  const req = f.providerInput()!;
  assert.equal(new URL(req.url).origin, "https://api.peopledatalabs.com");
  assert.equal(new URL(req.url).searchParams.get("size"), "20");
  assert.equal(req.init?.redirect, "error");
  assert.equal(new URL(req.url).searchParams.get("dataset"), "resume");
  assert.doesNotMatch(
    new URL(req.url).searchParams.get("data_include")!,
    /email|phone|gender|birth/,
  );
  assert.equal(
    (
      await f.call(
        f.owner.cookie,
        `sourcing/sessions/${item.id}/runs`,
        "POST",
        input,
      )
    ).status,
    200,
  );
  assert.equal(f.providerCalls(), 1);
  const importBody = {
    runId: pack.id,
    keys: [pack.results[0].key],
    confirm: true,
  };
  assert.equal(
    (
      await f.call(
        f.owner.cookie,
        `sourcing/sessions/${item.id}/import`,
        "POST",
        importBody,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await f.call(
        f.owner.cookie,
        `sourcing/sessions/${item.id}/import`,
        "POST",
        importBody,
      )
    ).status,
    200,
  );
  assert.equal(f.store.list(f.owner.workspaceId, "candidates").length, 1);
  assert.doesNotMatch(
    JSON.stringify(f.store.list(f.owner.workspaceId, "candidates")),
    /private-number|private@example/,
  );
  f.env.SOURCING_WORKSPACE_IDS = "";
  assert.equal((await f.run(item)).response.status, 503);
  assert.equal(f.providerCalls(), 1);
});
test("provider failures, malformed profiles and access changes never leave successful result packs", async (t) => {
  const f = await fixture(t);
  let { item } = await f.create({ source: "pdl" });
  item = await f.save(item);
  f.setFetch(
    async () =>
      new Response(
        JSON.stringify({
          status: 200,
          total: 1,
          data: [{ id: "bad-no-name" }],
        }),
      ),
  );
  assert.equal((await f.run(item)).response.status, 502);
  let loaded = await (
    await f.call(f.owner.cookie, `sourcing/sessions/${item.id}`)
  ).json();
  assert.equal(loaded.item.runs[0].status, "failed");
  assert.equal(loaded.item.runs[0].results.length, 0);
  f.setFetch(async () => {
    f.env.SOURCING_WORKSPACE_IDS = "";
    return new Response(
      JSON.stringify({
        status: 200,
        total: 1,
        data: [{ id: "one", full_name: "Do not persist" }],
      }),
    );
  });
  assert.equal((await f.run(item)).response.status, 409);
  loaded = await (
    await f.call(f.owner.cookie, `sourcing/sessions/${item.id}`)
  ).json();
  assert.equal(loaded.item.runs[0].results.length, 0);
});
test("local packs paginate and reject stale criteria while provider query excludes raw user DSL", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 5; i++) f.candidate({ name: `Person ${i}` });
  let { item } = await f.create();
  item = await f.save(item);
  const first = await f.run(item, { size: 2 });
  const pack = (await first.response.json()).item;
  assert.equal(pack.results.length, 2);
  assert.equal(pack.hasMore, true);
  const second = await f.run(item, { size: 2, afterRunId: pack.id });
  const next = (await second.response.json()).item;
  assert.equal(next.results.length, 2);
  assert.equal(
    next.results.some((p: any) =>
      pack.results.some((q: any) => p.key === q.key),
    ),
    false,
  );
  item = await f.save(item, { criteria: criteria({ titles: ["designer"] }) });
  assert.equal(
    (await f.run(item, { afterRunId: pack.id })).response.status,
    409,
  );
  assert.equal((await f.run(item, { revision: 1 })).response.status, 409);
  const query = sourcingQuery(
    criteria({ titles: ['" OR 1=1'], excludeCompanies: ["Avoid"] }),
  );
  assert.equal(
    (query.bool.must[0] as any).bool.should[0].match_phrase.job_title,
    '" or 1=1',
  );
  assert.equal(
    (query.bool.must_not[0] as any).match_phrase.job_company_name,
    "avoid",
  );
});
test("paid-attempt budget and replay ledger survive deleting entire sourcing searches", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 15; i++) {
    const { item } = await f.create({ manual: false });
    await f.call(f.owner.cookie, `sourcing/sessions/${item.id}`, "DELETE", {});
  }
  assert.equal(f.calls(), 15);
  const denied = await f.call(f.owner.cookie, "sourcing/sessions", "POST", {
    requestId: randomUUID(),
    prompt: "Another paid plan",
  });
  assert.equal(denied.status, 429);
  assert.equal(f.calls(), 15);
  assert.equal((await f.create()).item.status, "draft");
});
test("sourcing requires session, enforces nonempty criteria, and escapes spreadsheet formulas", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call("", "sourcing")).status, 401);
  assert.equal((await f.call("", "sourcing/sessions", "POST", {})).status, 401);
  const { item: blank } = await f.create();
  assert.equal((await f.run(blank)).response.status, 400);
  f.candidate({ name: "=SYNTHETIC()" });
  const item = await f.save(blank);
  const pack = (await (await f.run(item)).response.json()).item;
  const csv = await (
    await f.call(
      f.owner.cookie,
      `sourcing/sessions/${item.id}/runs/${pack.id}/export.csv`,
    )
  ).text();
  assert.match(csv, /'=SYNTHETIC/);
  assert.equal(
    (
      await f.call(
        f.teammate.cookie,
        `sourcing/sessions/${item.id}/runs/${pack.id}/export.csv`,
      )
    ).status,
    404,
  );
});

test("look-alikes resolve multiple saved profile URLs without fetching unknown profiles; talent maps require a company", async (t) => {
  const f = await fixture(t);
  const one = f.candidate({
      profile: "https://www.linkedin.com/in/synthetic-one",
    }),
    two = f.candidate({
      name: "Second Reference",
      profile: "https://www.linkedin.com/in/synthetic-two",
      role: "Software Engineer",
    });
  f.candidate({ name: "Potential colleague" });
  let { item } = await f.create({
    mode: "lookalikes",
    referenceProfiles: [one.profile, two.profile],
  });
  assert.equal(item.referenceIds.length, 2);
  const run = await f.run(item);
  assert.equal(run.response.status, 201);
  const pack = (await run.response.json()).item;
  assert.deepEqual(
    pack.results.map((p: any) => p.name),
    ["Potential colleague"],
  );
  const unknown = await f.call(f.owner.cookie, "sourcing/sessions", "POST", {
    requestId: randomUUID(),
    manual: true,
    mode: "lookalikes",
    prompt: "Find peers",
    referenceProfiles: ["https://www.linkedin.com/in/unknown-person"],
  });
  assert.equal(unknown.status, 400);
  assert.equal(f.providerCalls(), 0);
  item = await f.save(item, { mode: "talent" });
  assert.equal((await f.run(item)).response.status, 400);
  item = await f.save(item, {
    mode: "talent",
    criteria: criteria({ companies: ["Example Studio"] }),
  });
  assert.equal((await f.run(item)).response.status, 201);
});

test("past-result exclusions are private to the author, persist per pack, and keep pagination stable", async (t) => {
  const f = await fixture(t),
    past = f.candidate({ name: "Owner past result", role: "Designer" }),
    peer = f.candidate({ name: "Teammate past result", role: "Engineer" }),
    fresh = f.candidate({ name: "Fresh result", role: "Architect" });
  let old = (await f.create()).item;
  old = await f.save(old, { criteria: criteria({ titles: ["Designer"] }) });
  assert.equal((await f.run(old)).response.status, 201);
  const made = await f.call(f.teammate.cookie, "sourcing/sessions", "POST", {
    requestId: randomUUID(),
    prompt: "Teammate private search",
    manual: true,
  });
  const theirs = (await made.json()).item;
  const patched = await f.call(
    f.teammate.cookie,
    `sourcing/sessions/${theirs.id}`,
    "PATCH",
    {
      revision: theirs.revision,
      title: theirs.title,
      criteria: criteria({ titles: ["Engineer"] }),
      source: "workspace",
      mode: "sourcing",
    },
  );
  const teammateSearch = (await patched.json()).item;
  assert.equal(
    (
      await f.call(
        f.teammate.cookie,
        `sourcing/sessions/${theirs.id}/runs`,
        "POST",
        {
          requestId: randomUUID(),
          revision: teammateSearch.revision,
          consent: true,
        },
      )
    ).status,
    201,
  );
  let search = (
    await f.create({ exclusions: { pastSearches: true, sequenced: false } })
  ).item;
  search = await f.save(search, {
    criteria: criteria({ companies: ["Example Studio"] }),
  });
  assert.equal(search.exclusions.pastSearches, true);
  const first = (await (await f.run(search, { size: 1 })).response.json()).item;
  assert.equal(first.total, 2);
  assert.equal(first.filteredCount, 1);
  assert.notEqual(first.results[0].candidateId, past.id);
  const next = (
    await (
      await f.run(search, { size: 1, afterRunId: first.id })
    ).response.json()
  ).item;
  assert.equal(next.status, "ready");
  assert.equal(next.total, 2);
  assert.deepEqual(
    new Set([first.results[0].candidateId, next.results[0].candidateId]),
    new Set([peer.id, fresh.id]),
  );
  const again = (await (await f.run(search)).response.json()).item;
  assert.equal(again.results.length, 0);
  assert.equal(again.filteredCount, 3);
  search = await f.save(search, {
    criteria: criteria({ companies: ["Example Studio"] }),
    exclusions: { pastSearches: false, sequenced: false },
  });
  const unfiltered = (await (await f.run(search)).response.json()).item;
  assert.equal(unfiltered.results.length, 3);
  const loaded = await (
    await f.call(f.owner.cookie, `sourcing/sessions/${search.id}`)
  ).json();
  assert.equal(
    loaded.item.runs.find((r: any) => r.id === first.id).exclusions
      .pastSearches,
    true,
  );
});
test("sequenced exclusions cover workspace sequence and delivery enrollments and disclose PDL post-filtering", async (t) => {
  const f = await fixture(t),
    saved = f.candidate({
      name: "Sequenced profile",
      profile: "https://www.linkedin.com/in/sequence-fixture",
    }),
    delivered = f.candidate({ name: "Delivered profile" });
  f.candidate({ name: "Available profile" });
  const now = new Date().toISOString();
  f.store.insert(f.owner.workspaceId, "sequences", {
    id: randomUUID(),
    name: "Saved sequence",
    enrolledCandidateIds: [saved.id],
    createdAt: now,
    updatedAt: now,
  });
  f.store.db.exec(
    "CREATE TABLE outreach_enrollments(workspace_id TEXT,candidate_id TEXT)",
  );
  f.store.db
    .prepare("INSERT INTO outreach_enrollments VALUES(?,?)")
    .run(f.owner.workspaceId, delivered.id);
  let search = (
    await f.create({ exclusions: { pastSearches: false, sequenced: true } })
  ).item;
  search = await f.save(search);
  const pack = (await (await f.run(search)).response.json()).item;
  assert.deepEqual(
    pack.results.map((p: any) => p.name),
    ["Available profile"],
  );
  assert.equal(pack.filteredCount, 2);
  f.setFetch(
    async () =>
      new Response(
        JSON.stringify({
          status: 200,
          total: 500,
          scroll_token: "next-private-cursor",
          data: [
            {
              id: "sequenced",
              full_name: "Sequenced profile",
              linkedin_url: saved.profile,
            },
            {
              id: "fresh-pdl",
              full_name: "Fresh provider profile",
              linkedin_url: "https://www.linkedin.com/in/fresh-fixture",
            },
          ],
        }),
      ),
  );
  let web = (
    await f.create({
      source: "pdl",
      exclusions: { pastSearches: true, sequenced: true },
    })
  ).item;
  web = await f.save(web);
  const first = (await (await f.run(web)).response.json()).item;
  assert.deepEqual(
    first.results.map((p: any) => p.name),
    ["Fresh provider profile"],
  );
  assert.equal(first.total, 500);
  assert.equal(first.filteredCount, 1);
  assert.equal(first.hasMore, true);
  assert.equal(first.exclusions.sequenced, true);
  assert.equal(JSON.stringify(first).includes("next-private-cursor"), false);
  const repeated = (await (await f.run(web)).response.json()).item;
  assert.equal(repeated.results.length, 0);
  assert.equal(repeated.filteredCount, 2);
  assert.equal(repeated.hasMore, true);
  assert.equal(f.providerCalls(), 2);
});
