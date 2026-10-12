import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { createDatabase, type Resource } from "../../server/db.js";
import { hashToken } from "../../server/auth.js";
import {
  registerEnrichment,
  mapProfessionalEnrichment,
} from "../../server/enrichment.js";

const NOW = Date.now();
const payload = () => ({
  status: 200,
  likelihood: 8,
  matched: ["profile"],
  data: {
    id: "synthetic-pdl-id",
    full_name: "Jamie Example",
    job_title: "Staff Engineer",
    job_company_name: "Example Labs",
    linkedin_url: "linkedin.com/in/jamie-example",
    work_email: "jamie@synthetic.example",
    skills: ["TypeScript", "React"],
    experience: [
      {
        company: {
          name: "Example Labs",
          location: { street_address: "private" },
        },
        title: { name: "Staff Engineer" },
        start_date: "2024-01",
        end_date: null,
      },
    ],
    birth_date: "1980-01-01",
    sex: "private",
    mobile_phone: "+15555550100",
    street_address: "private-home",
    personal_emails: ["private@example.com"],
    profiles: [{ network: "private", url: "https://private.example" }],
  },
});
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "arkoffer-enrichment-")),
    store = createDatabase(directory);
  let time = NOW;
  function identity(workspaceId = randomUUID(), role = "owner") {
    const id = randomUUID(),
      token = randomBytes(32).toString("hex"),
      date = new Date(NOW).toISOString();
    store.db
      .prepare(
        "INSERT OR IGNORE INTO workspaces(id,name,created_at) VALUES(?,?,?)",
      )
      .run(workspaceId, "Enrichment tests", date);
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
        role,
        date,
      );
    store.db
      .prepare(
        "INSERT INTO sessions(token_hash,user_id,workspace_id,expires_at,created_at) VALUES(?,?,?,?,?)",
      )
      .run(hashToken(token), id, workspaceId, NOW + 3600000, date);
    return { id, workspaceId, cookie: `arkoffer_session=${token}`, token };
  }
  const owner = identity(),
    other = identity(),
    member = identity(owner.workspaceId, "member");
  const candidate = store.insert(owner.workspaceId, "candidates", {
    id: randomUUID(),
    name: "Jamie Example",
    profile: "https://www.linkedin.com/in/jamie-example",
    company: "Example Labs",
    role: "Engineer",
    email: "jamie@synthetic.example",
    notes: "Keep my notes",
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
  });
  const env: NodeJS.ProcessEnv = {
    PDL_API_KEY: "test-secret",
    ENRICHMENT_WORKSPACE_IDS: owner.workspaceId,
  };
  const calls: { url: string; init: RequestInit }[] = [];
  let handler: (
    url: string,
    init: RequestInit,
  ) => Promise<Response> | Response = () => response(payload());
  const app = express();
  app.use(express.json());
  registerEnrichment(app, store, {
    env,
    now: () => time,
    fetch: (async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return handler(String(url), init);
    }) as typeof fetch,
  });
  app.use(
    (
      error: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => res.status(500).json({ error: error.message }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const path = `/api/candidates/${candidate.id}/enrichment`;
  const request = (
    route = path,
    method = "GET",
    body?: unknown,
    cookie = owner.cookie,
  ) =>
    fetch(`http://127.0.0.1:${address.port}${route}`, {
      method,
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const input = () => ({
    requestKey: randomUUID(),
    candidateVersion: store.get(owner.workspaceId, "candidates", candidate.id)!
      .updatedAt,
    consent: true,
    identifier: "profile",
  });
  const lookup = async (body = input()) => {
    const result = await request(path, "POST", body);
    assert.equal(result.status, 201, await result.clone().text());
    return (await result.json()).item;
  };
  return {
    store,
    owner,
    other,
    member,
    candidate,
    env,
    calls,
    path,
    request,
    input,
    lookup,
    handler: (value: typeof handler) => {
      handler = value;
    },
    time: (value: number) => {
      time = value;
    },
    edit: (patch: Record<string, unknown>) =>
      store.update(owner.workspaceId, "candidates", {
        ...store.get(owner.workspaceId, "candidates", candidate.id)!,
        ...patch,
        updatedAt: new Date(time).toISOString(),
      } as Resource),
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("enrichment maps a bounded professional allowlist and discards private fields", () => {
  const input = payload();
  input.data.skills = Array.from(
    { length: 1000 },
    (_, index) => `Skill ${index}`,
  );
  const result = mapProfessionalEnrichment(input);
  assert.equal(String(result.proposal.skills).split(", ").length, 50);
  assert.deepEqual(result.proposal.workHistory, [
    {
      company: "Example Labs",
      role: "Staff Engineer",
      startDate: "2024-01",
      endDate: null,
    },
  ]);
  assert.equal(result.provenance.likelihood, 8);
  assert.equal(result.provenance.independentlyVerified, false);
  assert.doesNotMatch(
    JSON.stringify(result),
    /private|birth_date|mobile_phone|street_address|personal_emails|sex/,
  );
  assert.throws(
    () => mapProfessionalEnrichment({ ...input, likelihood: 5 }),
    /confidence/,
  );
  assert.throws(
    () => mapProfessionalEnrichment({ ...input, matched: [] }),
    /matched inputs/,
  );
  input.data.linkedin_url = "https://evil.example/in/jamie";
  input.data.work_email = "private@gmail.com";
  assert.equal(mapProfessionalEnrichment(input).proposal.profile, undefined);
  assert.equal(mapProfessionalEnrichment(input).proposal.workEmail, undefined);
});

test("lookups are setup-gated, tenant-scoped, admin-only and require explicit consent", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await f.request(f.path, "POST", f.input(), f.member.cookie)).status,
      403,
    );
    assert.equal(
      (await f.request(f.path, "POST", f.input(), f.other.cookie)).status,
      404,
    );
    assert.equal((await f.request(f.path, "GET", undefined, "")).status, 401);
    assert.equal(
      (await f.request(f.path, "POST", { ...f.input(), consent: false }))
        .status,
      400,
    );
    delete f.env.PDL_API_KEY;
    assert.equal((await f.request(f.path, "POST", f.input())).status, 503);
    const status = await (await f.request()).json();
    assert.equal(status.setup.configured, false);
    assert.deepEqual(status.setup.missing, ["PDL_API_KEY"]);
    f.env.PDL_API_KEY = "test-secret";
    f.env.ENRICHMENT_WORKSPACE_IDS = "";
    assert.equal((await f.request(f.path, "POST", f.input())).status, 403);
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});

test("lookup uses fixed provider endpoint and minimal inputs, persists sanitized proposal and applies only selected fields", async () => {
  const f = await fixture();
  try {
    const run = await f.lookup(),
      call = f.calls[0],
      url = new URL(call.url);
    assert.equal(
      url.origin + url.pathname,
      "https://api.peopledatalabs.com/v5/person/enrich",
    );
    assert.equal(url.searchParams.get("min_likelihood"), "6");
    assert.equal(url.searchParams.get("include_if_matched"), "true");
    assert.equal(url.searchParams.has("email"), false);
    assert.equal(url.searchParams.has("api_key"), false);
    assert.doesNotMatch(
      url.searchParams.get("data_include")!,
      /phone|location|sex|birth|emails/,
    );
    assert.equal(call.init.redirect, "error");
    assert.ok(call.init.signal);
    assert.equal(
      new Headers(call.init.headers).get("X-Api-Key"),
      "test-secret",
    );
    assert.equal(run.status, "proposed");
    assert.equal(
      f.store.get(f.owner.workspaceId, "candidates", f.candidate.id)!.role,
      "Engineer",
    );
    const stored = f.store.db
      .prepare(
        "SELECT proposal,provenance,snapshot FROM candidate_enrichment_runs",
      )
      .get();
    assert.doesNotMatch(
      JSON.stringify(stored),
      /private-home|private@example|test-secret|birth_date/,
    );
    const apply = await f.request(`${f.path}/${run.id}/apply`, "POST", {
      candidateVersion: run.candidateVersion,
      fields: ["role", "workHistory"],
      confirm: true,
    });
    assert.equal(apply.status, 200, await apply.clone().text());
    const item = (await apply.json()).item;
    assert.equal(item.role, "Staff Engineer");
    assert.equal(item.notes, "Keep my notes");
    assert.equal(item.workEmail, undefined);
    assert.equal(item.enrichmentProvenance.role.provider, "pdl");
    assert.equal(
      (
        await f.request(`${f.path}/${run.id}/apply`, "POST", {
          candidateVersion: item.updatedAt,
          fields: ["skills"],
          confirm: true,
        })
      ).status,
      409,
    );
  } finally {
    await f.close();
  }
});

test("same-key and same-identity requests reuse durable result; retries require a reviewed paid-attempt acknowledgment", async () => {
  const f = await fixture();
  try {
    const input = f.input(),
      run = await f.lookup(input);
    const repeated = await f.request(f.path, "POST", input);
    assert.equal(repeated.status, 200);
    assert.equal((await repeated.json()).item.id, run.id);
    const duplicate = await f.request(f.path, "POST", f.input());
    assert.equal((await duplicate.json()).reused, true);
    assert.equal(f.calls.length, 1);
    assert.equal(
      (await f.request(f.path, "POST", { ...f.input(), retryOf: run.id }))
        .status,
      409,
    );
    const retried = await f.request(f.path, "POST", {
      ...f.input(),
      retryOf: run.id,
      retryConfirmed: true,
    });
    assert.equal(retried.status, 201);
    assert.equal(f.calls.length, 2);
    assert.equal(
      (await f.request(f.path, "POST", { ...input, identifier: "nameCompany" }))
        .status,
      409,
    );
  } finally {
    await f.close();
  }
});

test("no-match, provider errors, oversized or malformed output and network uncertainty are durable and never auto-retried", async () => {
  for (const [handler, expected] of [
    [() => response({ status: 404 }, 404), "no_match"],
    [() => response({ error: "private provider details" }, 429), "failed"],
    [() => response({ error: "private provider details" }, 401), "failed"],
    [() => response({ error: "private provider details" }, 500), "uncertain"],
    [() => new Response("not json"), "uncertain"],
    [() => new Response("x".repeat(256_001)), "uncertain"],
    [
      () => {
        throw new Error("secret credentials");
      },
      "uncertain",
    ],
    [() => response({ ...payload(), matched: ["email"] }), "uncertain"],
  ] as const) {
    const f = await fixture();
    try {
      f.handler(handler);
      const run = await f.lookup();
      assert.equal(run.status, expected);
      assert.deepEqual(run.diff, []);
      assert.doesNotMatch(
        JSON.stringify(run),
        /private provider|secret credentials/,
      );
      const repeated = await f.request(f.path, "POST", f.input());
      assert.equal((await repeated.json()).item.status, expected);
      assert.equal(f.calls.length, 1);
      assert.equal(
        f.store.get(f.owner.workspaceId, "candidates", f.candidate.id)!.role,
        "Engineer",
      );
    } finally {
      await f.close();
    }
  }
});

test("local edits and version changes are preserved while unaffected fields remain reviewable", async () => {
  const f = await fixture();
  try {
    const run = await f.lookup();
    f.edit({ role: "Manually reviewed role", notes: "Latest notes" });
    assert.equal(
      (
        await f.request(`${f.path}/${run.id}/apply`, "POST", {
          candidateVersion: run.candidateVersion,
          fields: ["skills"],
          confirm: true,
        })
      ).status,
      409,
    );
    const latest = (await (await f.request()).json()).items[0];
    assert.equal(
      latest.diff.find((diff: any) => diff.field === "role").conflict,
      true,
    );
    assert.equal(
      (
        await f.request(`${f.path}/${run.id}/apply`, "POST", {
          candidateVersion: latest.candidateVersion,
          fields: ["role"],
          confirm: true,
        })
      ).status,
      409,
    );
    const applied = await f.request(`${f.path}/${run.id}/apply`, "POST", {
      candidateVersion: latest.candidateVersion,
      fields: ["skills"],
      confirm: true,
    });
    assert.equal(applied.status, 200);
    const c = (await applied.json()).item;
    assert.equal(c.role, "Manually reviewed role");
    assert.equal(c.notes, "Latest notes");
    assert.equal(c.skills, "TypeScript, React");
  } finally {
    await f.close();
  }
});

test("candidate identity changes invalidate the old proposal", async () => {
  const f = await fixture();
  try {
    const run = await f.lookup();
    const c = f.edit({ profile: "https://www.linkedin.com/in/someone-else" });
    const state = await (await f.request()).json();
    assert.equal(state.items[0].identityChanged, true);
    assert.equal(
      (
        await f.request(`${f.path}/${run.id}/apply`, "POST", {
          candidateVersion: c.updatedAt,
          fields: ["skills"],
          confirm: true,
        })
      ).status,
      409,
    );
    assert.equal(f.calls.length, 1);
  } finally {
    await f.close();
  }
});

test("concurrent requests deduplicate and candidate changes during lookup discard the proposal", async () => {
  const f = await fixture();
  try {
    let release!: () => void, started!: () => void;
    const pending = new Promise<void>((resolve) => {
        release = resolve;
      }),
      start = new Promise<void>((resolve) => {
        started = resolve;
      });
    f.handler(async () => {
      started();
      await pending;
      return response(payload());
    });
    const initial = f.request(f.path, "POST", f.input());
    await start;
    const duplicate = await f.request(f.path, "POST", f.input());
    assert.equal((await duplicate.json()).item.status, "running");
    assert.equal(f.calls.length, 1);
    f.edit({ notes: "Changed while provider was working" });
    release();
    const complete = await initial;
    assert.equal(complete.status, 201);
    const run = (await complete.json()).item;
    assert.equal(run.status, "stale");
    assert.deepEqual(run.diff, []);
  } finally {
    await f.close();
  }
});

test("session revocation, workspace switching and admin demotion during a provider wait prevent profile storage", async () => {
  for (const mutation of ["revoke", "switch", "demote"] as const) {
    const f = await fixture();
    try {
      let release!: () => void, started!: () => void;
      const pending = new Promise<void>((resolve) => {
          release = resolve;
        }),
        start = new Promise<void>((resolve) => {
          started = resolve;
        });
      f.handler(async () => {
        started();
        await pending;
        return response(payload());
      });
      const initial = f.request(f.path, "POST", f.input());
      await start;
      if (mutation === "revoke")
        f.store.db
          .prepare("DELETE FROM sessions WHERE user_id=?")
          .run(f.owner.id);
      if (mutation === "demote")
        f.store.db
          .prepare("UPDATE memberships SET role='member' WHERE user_id=?")
          .run(f.owner.id);
      if (mutation === "switch") {
        f.store.db
          .prepare(
            "INSERT INTO memberships(workspace_id,user_id,role,status,created_at,updated_at) VALUES(?,?,'owner','active',?,?)",
          )
          .run(
            f.other.workspaceId,
            f.owner.id,
            new Date(NOW).toISOString(),
            new Date(NOW).toISOString(),
          );
        f.store.db
          .prepare("UPDATE sessions SET workspace_id=? WHERE user_id=?")
          .run(f.other.workspaceId, f.owner.id);
      }
      release();
      const complete = await initial;
      assert.equal(
        complete.status,
        mutation === "revoke" ? 401 : mutation === "switch" ? 409 : 403,
      );
      const row = f.store.db
        .prepare("SELECT status,proposal FROM candidate_enrichment_runs")
        .get();
      assert.equal(row!.status, "abandoned");
      assert.equal(row!.proposal, "{}");
    } finally {
      await f.close();
    }
  }
});

test("interrupted durable runs become uncertain without sending another request", async () => {
  const f = await fixture();
  try {
    await f.lookup();
    f.store.db
      .prepare(
        "UPDATE candidate_enrichment_runs SET status='running',proposal='{}',provenance='{}'",
      )
      .run();
    f.time(NOW + 61_000);
    const state = await (await f.request()).json();
    assert.equal(state.items[0].status, "uncertain");
    const repeated = await f.request(f.path, "POST", f.input());
    assert.equal((await repeated.json()).item.status, "uncertain");
    assert.equal(f.calls.length, 1);
  } finally {
    await f.close();
  }
});

test("unsafe profile identifiers and personal email inputs do not reach the provider", async () => {
  const f = await fixture();
  try {
    for (const profile of [
      "http://127.0.0.1/in/test",
      "https://www.linkedin.com@evil.example/in/test",
      "https://www.linkedin.com/in/test?private=true",
      "https://www.linkedin.com/in/test#fragment",
    ]) {
      f.edit({ profile });
      assert.equal((await f.request(f.path, "POST", f.input())).status, 400);
    }
    f.edit({ email: "private@gmail.com" });
    assert.equal(
      (
        await f.request(f.path, "POST", {
          ...f.input(),
          identifier: "workEmail",
        })
      ).status,
      400,
    );
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});
