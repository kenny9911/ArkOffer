import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import express from "express";
import { createDatabase, type Store } from "../../server/db.js";
import { hashToken } from "../../server/auth.js";
import {
  createBilling,
  validStripeSignature,
  type BillingConfig,
} from "../../server/billing.js";
const ORIGIN = "http://localhost:5174";
function user(store: Store, workspaceId = randomUUID(), role = "owner") {
  const id = randomUUID(),
    token = randomBytes(32).toString("hex"),
    date = new Date().toISOString();
  store.db
    .prepare(
      "INSERT OR IGNORE INTO workspaces(id,name,created_at) VALUES(?,?,?)",
    )
    .run(workspaceId, "Billing Team", date);
  store.db
    .prepare(
      "INSERT INTO users(id,workspace_id,name,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?,?)",
    )
    .run(
      id,
      workspaceId,
      "Billing Owner",
      `${id}@example.com`,
      "unused",
      role,
      date,
    );
  store.db
    .prepare(
      "INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)",
    )
    .run(hashToken(token), id, Date.now() + 3600000, date);
  return { id, workspaceId, cookie: `arkoffer_session=${token}` };
}
async function fixture(configured = true) {
  const dir = mkdtempSync(join(tmpdir(), "arkoffer-billing-")),
    store = createDatabase(dir),
    owner = user(store),
    member = user(store, owner.workspaceId, "member"),
    other = user(store);
  let time = Date.now();
  let blocked:
    | {
        path: string;
        method: string;
        entered: () => void;
        wait: Promise<void>;
      }
    | undefined;
  const config: BillingConfig = {
    secretKey: configured ? "sk_test_mock" : "",
    webhookSecret: "whsec_mock",
    publicUrl: "https://arkoffer.example.com",
    workspaceIds: [owner.workspaceId],
    prices: { team: "price_team", business: "price_business" },
  };
  const mock: {
    customer: any;
    checkout: any;
    subscription: any;
    calls: {
      path: string;
      method: string;
      body: Record<string, string>;
      key: string | null;
    }[];
    portalUrl: string;
    failPath: string;
    priceOverride: Record<string, unknown>;
    cache: Map<string, unknown>;
  } = {
    customer: null,
    checkout: null,
    subscription: null,
    calls: [],
    portalUrl: "https://billing.stripe.com/p/session/test",
    failPath: "",
    priceOverride: {},
    cache: new Map(),
  };
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)),
      method = init?.method || "GET",
      body = Object.fromEntries(new URLSearchParams(String(init?.body || ""))),
      key = new Headers(init?.headers).get("Idempotency-Key");
    assert.equal(url.origin, "https://api.stripe.com");
    assert.equal(
      new Headers(init?.headers).get("Authorization"),
      "Bearer sk_test_mock",
    );
    mock.calls.push({ path: url.pathname, method, body, key });
    if (blocked?.path === url.pathname && blocked.method === method) {
      const pending = blocked;
      blocked = undefined;
      pending.entered();
      await pending.wait;
    }
    if (mock.failPath === url.pathname) {
      mock.failPath = "";
      throw new TypeError("network timeout after dispatch");
    }
    if (method === "POST" && key && mock.cache.has(key))
      return Response.json(mock.cache.get(key));
    let result: unknown;
    if (url.pathname.startsWith("/v1/prices/"))
      result = {
        id: url.pathname.split("/").at(-1),
        active: true,
        type: "recurring",
        unit_amount: 3500,
        currency: "usd",
        recurring: {
          usage_type: "licensed",
          interval: "month",
          interval_count: 1,
        },
        product: {
          name: url.pathname.endsWith("business") ? "Business" : "Team",
        },
        ...mock.priceOverride,
      };
    else if (url.pathname === "/v1/customers" && method === "POST") {
      mock.customer = {
        id: `cus_${randomUUID().replaceAll("-", "")}`,
        metadata: {
          arkoffer_workspace_id: body["metadata[arkoffer_workspace_id]"],
        },
      };
      result = mock.customer;
    } else if (url.pathname === "/v1/checkout/sessions" && method === "POST") {
      mock.checkout = {
        id: `cs_test_${randomUUID().replaceAll("-", "")}`,
        customer: body.customer,
        client_reference_id: body.client_reference_id,
        metadata: {
          arkoffer_workspace_id: body["metadata[arkoffer_workspace_id]"],
        },
        url: "https://checkout.stripe.com/c/pay/test",
        expires_at: Math.floor(time / 1000) + 86400,
        status: "open",
        subscription: null,
      };
      result = mock.checkout;
    } else if (
      url.pathname.startsWith("/v1/checkout/sessions/") &&
      url.pathname.endsWith("/expire")
    ) {
      mock.checkout.status = "expired";
      result = mock.checkout;
    } else if (url.pathname.startsWith("/v1/checkout/sessions/"))
      result = mock.checkout;
    else if (url.pathname.startsWith("/v1/subscriptions/"))
      result = mock.subscription;
    else if (url.pathname === "/v1/billing_portal/sessions")
      result = { id: "bps_test", url: mock.portalUrl };
    else throw new Error(`Unexpected Stripe path ${url.pathname}`);
    if (method === "POST" && key) mock.cache.set(key, result);
    return Response.json(result);
  };
  const billing = createBilling(store, {
      config,
      clock: () => time,
      fetch: fetcher,
    }),
    app = express();
  app.post(
    "/api/billing/webhook",
    express.raw({ type: "application/json", limit: "1mb" }),
    billing.webhook,
  );
  app.use(express.json());
  app.use("/api", (req, res, next) => {
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.get("origin") !== ORIGIN
    ) {
      res.status(403).json({ error: "Origin rejected" });
      return;
    }
    next();
  });
  billing.register(app);
  const server = await new Promise<Server>((resolve) => {
    const running = app.listen(0, "127.0.0.1", () => resolve(running));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    cookie = owner.cookie,
  ) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        Origin: ORIGIN,
        Cookie: cookie,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const status = async (cookie = owner.cookie) =>
    await (await request("/api/billing", "GET", undefined, cookie)).json();
  const checkout = (
    extra: Record<string, unknown> = {},
    cookie = owner.cookie,
  ) =>
    request(
      "/api/billing/checkout",
      "POST",
      { plan: "team", seats: 2, acknowledged: true, ...extra },
      cookie,
    );
  const activate = (extra: Record<string, unknown> = {}) => {
    mock.subscription = {
      id: "sub_test123",
      customer: mock.customer.id,
      metadata: { arkoffer_workspace_id: owner.workspaceId },
      status: "active",
      cancel_at_period_end: false,
      items: {
        data: [
          {
            price: { id: "price_team" },
            quantity: 2,
            current_period_end: Math.floor(time / 1000) + 86400 * 30,
          },
        ],
      },
      ...extra,
    };
    mock.checkout.subscription = mock.subscription.id;
    mock.checkout.status = "complete";
    return mock.subscription;
  };
  const event = (
    type = "customer.subscription.updated",
    extra: Record<string, unknown> = {},
  ) => ({
    id: `evt_${randomUUID().replaceAll("-", "")}`,
    type,
    livemode: false,
    created: Math.floor(time / 1000),
    data: {
      object: type.startsWith("checkout.") ? mock.checkout : mock.subscription,
    },
    ...extra,
  });
  const deliver = async (value: unknown, header?: string, body?: string) => {
    const raw = body || JSON.stringify(value),
      timestamp = Math.floor(time / 1000),
      signature = createHmac("sha256", config.webhookSecret)
        .update(`${timestamp}.${raw}`)
        .digest("hex");
    return fetch(`${base}/api/billing/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Stripe-Signature": header || `t=${timestamp},v1=${signature}`,
      },
      body: raw,
    });
  };
  return {
    store,
    owner,
    member,
    other,
    config,
    mock,
    request,
    status,
    checkout,
    activate,
    event,
    deliver,
    hold(path: string, method = "GET") {
      assert.equal(blocked, undefined);
      let entered!: () => void, release!: () => void;
      const arrival = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      blocked = { path, method, entered, wait };
      return { entered: arrival, release };
    },
    clock: () => time,
    advance: (ms: number) => {
      time += ms;
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function changeActor(
  f: Awaited<ReturnType<typeof fixture>>,
  kind: "role" | "session" | "workspace",
) {
  if (kind === "role") {
    f.store.db
      .prepare(
        "UPDATE memberships SET role='member' WHERE user_id=? AND workspace_id=?",
      )
      .run(f.owner.id, f.owner.workspaceId);
    return 403;
  }
  if (kind === "session") {
    f.store.db.prepare("DELETE FROM sessions WHERE user_id=?").run(f.owner.id);
    return 401;
  }
  const now = new Date().toISOString();
  f.store.db
    .prepare(
      "INSERT INTO memberships(workspace_id,user_id,role,created_at,updated_at) VALUES(?,?,'owner',?,?)",
    )
    .run(f.other.workspaceId, f.owner.id, now, now);
  f.store.db
    .prepare("UPDATE sessions SET workspace_id=? WHERE user_id=?")
    .run(f.other.workspaceId, f.owner.id);
  return 409;
}

test("unconfigured Stripe stays free and cannot create financial objects; status requires a session", async (t) => {
  const f = await fixture(false);
  t.after(() => f.close());
  const state = await f.status();
  assert.equal(state.enabled, false);
  assert.equal(state.subscription, null);
  assert.equal(state.activeSeats, 2);
  assert.deepEqual(state.plans, []);
  assert.equal(f.mock.calls.length, 0);
  assert.equal((await f.checkout()).status, 409);
  assert.equal(
    (await f.request("/api/billing", "GET", undefined, "")).status,
    401,
  );
  assert.equal(f.mock.calls.length, 0);
});

test("checkout uses server price IDs, member counts, exact return URLs and durable idempotency without activating a plan", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const state = await f.status();
  assert.equal(state.plans[0].unitAmount, 3500);
  assert.equal(state.plans[0].name, "Team");
  assert.equal(state.mode, "test");
  assert.equal((await f.checkout({ seats: 1 })).status, 400);
  assert.equal((await f.checkout({ priceId: "price_evil" })).status, 400);
  assert.equal((await f.checkout({ acknowledged: false })).status, 400);
  const response = await f.checkout();
  assert.equal(
    response.status,
    200,
    JSON.stringify(await response.clone().json()),
  );
  assert.equal(
    (await response.json()).url,
    "https://checkout.stripe.com/c/pay/test",
  );
  const posted = f.mock.calls.find(
    (call) => call.path === "/v1/checkout/sessions" && call.method === "POST",
  )!;
  assert.equal(posted.body["line_items[0][price]"], "price_team");
  assert.equal(posted.body["line_items[0][quantity]"], "2");
  assert.equal(posted.body.mode, "subscription");
  assert.equal(
    posted.body["subscription_data[metadata][arkoffer_workspace_id]"],
    f.owner.workspaceId,
  );
  assert.equal(
    posted.body.success_url,
    "https://arkoffer.example.com/app/settings?tab=billing&checkout=success",
  );
  assert.match(posted.key!, /^arkoffer\/checkout\//);
  assert.equal((await f.status()).subscription, null);
  assert.equal((await f.checkout()).status, 200);
  assert.equal(
    f.mock.calls.filter(
      (call) => call.path === "/v1/checkout/sessions" && call.method === "POST",
    ).length,
    1,
  );
  assert.equal((await f.checkout({ seats: 3 })).status, 409);
});

test("role and workspace allowlists protect billing actions and member responses omit checkout URLs", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  assert.equal((await f.checkout({}, f.member.cookie)).status, 403);
  assert.equal((await f.checkout({}, f.other.cookie)).status, 409);
  await f.checkout();
  const member = await f.status(f.member.cookie);
  assert.equal(member.canManage, false);
  assert.equal(member.pendingCheckout.url, null);
  assert.equal(
    (await f.request("/api/billing/portal", "POST", {}, f.member.cookie))
      .status,
    403,
  );
  assert.equal(
    (await f.request("/api/billing/refresh", "POST", {}, f.member.cookie))
      .status,
    403,
  );
  assert.equal((await f.status(f.other.cookie)).subscription, null);
  assert.ok(!JSON.stringify(await f.status()).includes("sk_test_mock"));
});

test("webhooks require raw-body cryptographic signatures, fresh timestamps, and matching Stripe mode", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await f.checkout();
  f.activate();
  const event = f.event(),
    raw = Buffer.from(JSON.stringify(event)),
    timestamp = Math.floor(f.clock() / 1000);
  const signature = createHmac("sha256", f.config.webhookSecret)
    .update(`${timestamp}.`)
    .update(raw)
    .digest("hex");
  assert.equal(
    validStripeSignature(
      raw,
      `t=${timestamp},v1=${signature}`,
      f.config.webhookSecret,
      f.clock(),
    ),
    true,
  );
  assert.equal(
    validStripeSignature(
      Buffer.from("different"),
      `t=${timestamp},v1=${signature}`,
      f.config.webhookSecret,
      f.clock(),
    ),
    false,
  );
  assert.equal(
    validStripeSignature(
      raw,
      `t=${timestamp},v1=${signature}`,
      f.config.webhookSecret,
      f.clock() + 301000,
    ),
    false,
  );
  assert.equal(
    (await f.deliver(event, `t=${timestamp},v1=${"0".repeat(64)}`)).status,
    400,
  );
  assert.equal((await f.deliver({ ...event, livemode: true })).status, 400);
  assert.equal(
    (await f.deliver({ ...event, created: timestamp + 400 })).status,
    400,
  );
  assert.equal((await f.status()).subscription, null);
});

test("signed events retrieve canonical subscriptions, activate verified seats, and deduplicate retries", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await f.checkout();
  f.activate({ status: "trialing" });
  const event = f.event("checkout.session.completed");
  const result = await f.deliver(event);
  assert.equal(result.status, 200, JSON.stringify(await result.clone().json()));
  const state = await f.status();
  assert.equal(state.subscription.status, "trialing");
  assert.equal(state.subscription.seats, 2);
  assert.equal(state.subscription.plan, "team");
  assert.equal(state.pendingCheckout, null);
  const calls = f.mock.calls.length;
  const duplicate = await (await f.deliver(event)).json();
  assert.equal(duplicate.duplicate, true);
  assert.equal(f.mock.calls.length, calls);
  assert.equal((await f.checkout()).status, 409);
});

test("out-of-order webhooks cannot restore a canceled subscription and unknown customers do not access another workspace", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await f.checkout();
  f.activate();
  const original = f.event();
  assert.equal((await f.deliver(original)).status, 200);
  f.advance(10000);
  f.mock.subscription.status = "canceled";
  const cancelled = f.event("customer.subscription.deleted");
  assert.equal((await f.deliver(cancelled)).status, 200);
  f.mock.subscription.status = "active";
  const stale = f.event("customer.subscription.updated", {
    created: original.created,
  });
  const staleResult = await (await f.deliver(stale)).json();
  assert.equal(staleResult.stale, true);
  assert.equal((await f.status()).subscription.status, "canceled");
  const foreign = f.event("customer.subscription.updated", {
    data: { object: { id: "sub_foreign", customer: "cus_unknown" } },
  });
  assert.equal((await (await f.deliver(foreign)).json()).ignored, true);
  assert.equal((await f.status(f.other.cookie)).subscription, null);
});

test("canonical customer metadata, plan and subscription IDs must match before entitlement updates", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await f.checkout();
  f.activate();
  f.mock.subscription.metadata.arkoffer_workspace_id = f.other.workspaceId;
  assert.equal((await f.deliver(f.event())).status, 409);
  assert.equal((await f.status()).subscription, null);
  f.mock.subscription.metadata.arkoffer_workspace_id = f.owner.workspaceId;
  f.mock.subscription.items.data[0].price.id = "price_unapproved";
  assert.equal((await f.deliver(f.event())).status, 409);
  assert.equal((await f.status()).subscription, null);
  f.mock.subscription.items.data[0].price.id = "price_team";
  assert.equal((await f.deliver(f.event())).status, 200);
});

test("missing checkout webhooks are reconciled before another subscription is created", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await f.checkout();
  f.activate();
  f.advance(25 * 3600000);
  assert.equal((await f.checkout({ seats: 3 })).status, 409);
  assert.equal((await f.status()).subscription.status, "active");
  assert.equal(
    f.mock.calls.filter(
      (call) => call.path === "/v1/checkout/sessions" && call.method === "POST",
    ).length,
    1,
  );
});

test("the billing portal and checkout only redirect to verified Stripe hosts; cancellation expires an open checkout", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await f.checkout();
  let portal = await f.request("/api/billing/portal", "POST", {});
  assert.equal(portal.status, 200);
  assert.equal(
    (await portal.json()).url,
    "https://billing.stripe.com/p/session/test",
  );
  f.mock.portalUrl = "https://billing.stripe.com.evil.example/";
  portal = await f.request("/api/billing/portal", "POST", {});
  assert.equal(portal.status, 502);
  assert.equal(
    (await f.request("/api/billing/checkout/cancel", "POST", {})).status,
    200,
  );
  assert.equal(f.mock.checkout.status, "expired");
  assert.equal((await f.status()).pendingCheckout, null);
  assert.equal((await f.checkout({ plan: "business" })).status, 200);
  assert.equal(
    f.mock.calls.filter(
      (call) => call.path === "/v1/checkout/sessions" && call.method === "POST",
    ).length,
    2,
  );
});

test("unknown creation responses retry the same saved payload/key and cannot create again after the safe window", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  f.mock.failPath = "/v1/checkout/sessions";
  assert.equal((await f.checkout()).status, 502);
  assert.equal((await f.status()).subscription, null);
  assert.equal((await f.checkout()).status, 200);
  const posts = f.mock.calls.filter(
    (call) => call.path === "/v1/checkout/sessions" && call.method === "POST",
  );
  assert.equal(posts.length, 2);
  assert.equal(posts[0].key, posts[1].key);
  assert.deepEqual(posts[0].body, posts[1].body);
  await f.request("/api/billing/checkout/cancel", "POST", {});
  f.mock.failPath = "/v1/checkout/sessions";
  assert.equal((await f.checkout()).status, 502);
  f.advance(24 * 3600000);
  const count = f.mock.calls.length;
  assert.equal((await f.checkout()).status, 409);
  assert.equal(
    f.mock.calls.filter(
      (call) => call.path === "/v1/checkout/sessions" && call.method === "POST",
    ).length,
    3,
  );
  assert.ok(f.mock.calls.length >= count);
});

test("unsupported metered prices fail visibly instead of inventing a price or creating a checkout", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  f.mock.priceOverride = { unit_amount: null };
  const state = await f.status();
  assert.match(state.priceError, /fixed-price/);
  assert.deepEqual(state.plans, []);
  assert.equal((await f.checkout()).status, 409);
  assert.equal(f.mock.customer, null);
});

test(
  "billing capability URLs are withheld when the actor changes during Stripe creation",
  { timeout: 15000 },
  async (t) => {
    for (const target of ["portal", "checkout"] as const) {
      for (const kind of ["role", "session", "workspace"] as const) {
        await t.test(`${target}: ${kind}`, async (t) => {
          const f = await fixture();
          t.after(() => f.close());
          if (target === "portal") await f.checkout();
          const held = f.hold(
            target === "portal"
              ? "/v1/billing_portal/sessions"
              : "/v1/checkout/sessions",
            "POST",
          );
          const pending =
            target === "portal"
              ? f.request("/api/billing/portal", "POST", {})
              : f.checkout();
          await held.entered;
          const expected = changeActor(f, kind);
          held.release();
          const response = await pending;
          assert.equal(response.status, expected);
          assert.equal((await response.json()).url, undefined);
          if (target === "checkout") {
            // Retain the provider result so another authorized admin can recover
            // it without creating a second checkout after this actor loses access.
            const saved = f.store.db
              .prepare(
                "SELECT stripe_id,state FROM billing_checkouts WHERE workspace_id=?",
              )
              .get(f.owner.workspaceId)!;
            assert.equal(saved.stripe_id, f.mock.checkout.id);
            assert.equal(saved.state, "open");
          }
        });
      }
    }
  },
);

test(
  "billing status checks the live actor after price reads before disclosing an existing checkout",
  { timeout: 10000 },
  async (t) => {
    for (const kind of ["role", "session", "workspace"] as const) {
      await t.test(kind, async (t) => {
        const f = await fixture();
        t.after(() => f.close());
        await f.checkout();
        f.advance(300001);
        const held = f.hold("/v1/prices/price_team");
        const pending = f.request("/api/billing");
        await held.entered;
        const expected = changeActor(f, kind);
        held.release();
        const response = await pending;
        assert.equal(response.status, kind === "role" ? 200 : expected);
        const body = await response.json();
        if (kind === "role") {
          assert.equal(body.canManage, false);
          assert.equal(body.pendingCheckout.url, null);
        } else assert.equal(body.pendingCheckout, undefined);
      });
    }
  },
);

test(
  "checkout creation and cancellation revalidate access before subsequent Stripe mutations",
  { timeout: 15000 },
  async (t) => {
    for (const kind of ["role", "session", "workspace"] as const) {
      for (const operation of ["create", "cancel"] as const) {
        await t.test(`${operation}: ${kind}`, async (t) => {
          const f = await fixture();
          t.after(() => f.close());
          if (operation === "cancel") await f.checkout();
          const held = f.hold(
            operation === "cancel"
              ? `/v1/checkout/sessions/${f.mock.checkout.id}`
              : "/v1/prices/price_team",
          );
          const pending =
            operation === "cancel"
              ? f.request("/api/billing/checkout/cancel", "POST", {})
              : f.checkout();
          await held.entered;
          const before = f.mock.calls.length;
          const expected = changeActor(f, kind);
          held.release();
          assert.equal((await pending).status, expected);
          assert.equal(
            f.mock.calls.slice(before).some((call) => call.method === "POST"),
            false,
          );
          if (operation === "cancel")
            assert.equal(f.mock.checkout.status, "open");
        });
      }
    }
  },
);

test("a late event for an old subscription cannot replace a newer active subscription", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await f.checkout();
  f.activate({ id: "sub_current" });
  assert.equal(
    (await f.deliver(f.event("checkout.session.completed"))).status,
    200,
  );
  f.advance(10000);
  f.mock.subscription = {
    ...f.mock.subscription,
    id: "sub_old",
    status: "canceled",
  };
  const oldEvent = f.event();
  assert.equal((await f.deliver(oldEvent)).status, 200);
  const saved = f.store.db
    .prepare("SELECT * FROM billing_accounts WHERE workspace_id=?")
    .get(f.owner.workspaceId)!;
  assert.equal(saved.subscription_id, "sub_current");
  assert.equal(saved.status, "active");
  assert.ok(Number(saved.last_event_created) < oldEvent.created);
  assert.equal((await f.checkout()).status, 409);
  assert.equal(
    f.mock.calls.filter(
      (call) => call.path === "/v1/checkout/sessions" && call.method === "POST",
    ).length,
    1,
  );
});

test("replacement subscriptions require a completed recognized checkout bound to the previous subscription", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await f.checkout();
  f.activate({ id: "sub_first" });
  assert.equal(
    (await f.deliver(f.event("checkout.session.completed"))).status,
    200,
  );
  const firstCheckout = { ...f.mock.checkout };
  f.advance(10000);
  f.mock.subscription.status = "canceled";
  assert.equal(
    (await f.deliver(f.event("customer.subscription.deleted"))).status,
    200,
  );
  f.advance(10000);
  f.mock.subscription = {
    ...f.mock.subscription,
    id: "sub_unrecognized",
    status: "active",
  };
  assert.equal((await f.deliver(f.event())).status, 200);
  assert.equal((await f.status()).subscription.status, "canceled");
  assert.equal((await f.checkout()).status, 200);
  const replacement = f.store.db
    .prepare(
      "SELECT replaces_subscription_id FROM billing_checkouts WHERE stripe_id=?",
    )
    .get(f.mock.checkout.id)!;
  assert.equal(replacement.replaces_subscription_id, "sub_first");
  f.activate({ id: "sub_second" });
  const nextCheckout = { ...f.mock.checkout };
  const event = f.event("checkout.session.completed");
  assert.equal((await f.deliver(event)).status, 200);
  assert.equal((await f.status()).subscription.status, "active");
  assert.equal(
    f.store.db
      .prepare(
        "SELECT subscription_id FROM billing_accounts WHERE workspace_id=?",
      )
      .get(f.owner.workspaceId)!.subscription_id,
    "sub_second",
  );
  f.advance(10000);
  f.mock.subscription.status = "canceled";
  assert.equal(
    (await f.deliver(f.event("customer.subscription.deleted"))).status,
    200,
  );
  // Even after cancellation, a different event ID for a historical checkout
  // cannot promote its old subscription back into the workspace.
  f.advance(10000);
  f.mock.checkout = firstCheckout;
  f.mock.subscription = {
    ...f.mock.subscription,
    id: "sub_first",
    status: "active",
  };
  assert.equal(
    (await f.deliver(f.event("checkout.session.completed"))).status,
    200,
  );
  assert.equal(
    f.store.db
      .prepare(
        "SELECT subscription_id FROM billing_accounts WHERE workspace_id=?",
      )
      .get(f.owner.workspaceId)!.subscription_id,
    "sub_second",
  );
  assert.equal((await f.status()).subscription.status, "canceled");
  // A forged completed snapshot must also agree with the canonical checkout.
  f.mock.checkout = { ...nextCheckout, subscription: "sub_mismatch" };
  const mismatch = {
    ...event,
    id: `evt_${randomUUID().replaceAll("-", "")}`,
    created: Math.floor(f.clock() / 1000),
  };
  assert.equal((await f.deliver(mismatch)).status, 409);
});

test("the real application preserves raw webhook bytes and exempts only the signed webhook from browser Origin requirements", async (t) => {
  const { createApp } = await import("../../server/app.js");
  const f = await fixture();
  const originalSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const originalKey = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_integration";
  process.env.STRIPE_SECRET_KEY = "";
  let integrated: ReturnType<typeof createApp>;
  try {
    integrated = createApp({
      store: f.store,
      appOrigin: ORIGIN,
      openAiApiKey: "",
    });
  } finally {
    if (originalSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = originalSecret;
    if (originalKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = originalKey;
  }
  const running = await new Promise<Server>((resolve) => {
    const value = integrated.listen(0, "127.0.0.1", () => resolve(value));
  });
  t.after(async () => {
    await new Promise<void>((resolve) => running.close(() => resolve()));
    await f.close();
  });
  const address = running.address();
  assert.ok(address && typeof address !== "string");
  const timestamp = Math.floor(Date.now() / 1000);
  const raw = JSON.stringify({
    id: "evt_integration",
    type: "payment_intent.succeeded",
    livemode: false,
    created: timestamp,
    data: { object: { id: "pi_ignored" } },
  });
  const signature = createHmac("sha256", "whsec_integration")
    .update(`${timestamp}.${raw}`)
    .digest("hex");
  const response = await fetch(
    `http://127.0.0.1:${address.port}/api/billing/webhook`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Stripe-Signature": `t=${timestamp},v1=${signature}`,
      },
      body: raw,
    },
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ignored, true);
  const protectedPost = await fetch(
    `http://127.0.0.1:${address.port}/api/billing/portal`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: f.owner.cookie },
      body: "{}",
    },
  );
  assert.equal(protectedPost.status, 403);
});
