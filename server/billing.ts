import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  Express,
  Request,
  RequestHandler,
  Response as ExpressResponse,
} from "express";
import { z } from "zod";
import { isWorkspaceAdmin, sessionUser, type User } from "./auth.js";
import type { Store } from "./db.js";

export type BillingConfig = {
  secretKey: string;
  webhookSecret: string;
  publicUrl: string;
  workspaceIds: string[];
  prices: Record<string, string>;
};
type Options = {
  config?: BillingConfig;
  fetch?: typeof fetch;
  clock?: () => number;
};
type Row = Record<string, string | number | null>;
type StripeObject = Record<string, any>;
class BillingError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const fail = (status: number, message: string): never => {
  throw new BillingError(status, message);
};
const stripeId = (value: unknown, prefix: string) =>
  typeof value === "string" &&
  new RegExp(`^${prefix}_[A-Za-z0-9_]{1,180}$`).test(value)
    ? value
    : fail(502, "Stripe returned an invalid resource identifier.");
const reference = (value: unknown) =>
  typeof value === "string"
    ? value
    : value && typeof value === "object"
      ? String((value as { id?: unknown }).id || "")
      : "";
export const billingConfig = (): BillingConfig => ({
  secretKey: process.env.STRIPE_SECRET_KEY || "",
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || "",
  publicUrl: process.env.PUBLIC_APP_URL || "",
  workspaceIds: (process.env.BILLING_WORKSPACE_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
  prices: Object.fromEntries(
    [
      ["team", process.env.STRIPE_PRICE_TEAM],
      ["business", process.env.STRIPE_PRICE_BUSINESS],
    ].filter((entry): entry is [string, string] => !!entry[1]),
  ),
});
/** Stripe snapshot webhooks must receive the untouched raw body before JSON or Origin middleware.
 * https://docs.stripe.com/webhooks#verify-manually
 */
export function validStripeSignature(
  body: Buffer,
  header: string,
  secret: string,
  now = Date.now(),
) {
  if (!secret || header.length > 2000) return false;
  const fields = header.split(",").map((value) => value.trim().split("="));
  const timestamps = fields.filter(([key]) => key === "t");
  if (timestamps.length !== 1 || !/^\d+$/.test(timestamps[0][1] || ""))
    return false;
  const timestamp = Number(timestamps[0][1]);
  if (
    !Number.isSafeInteger(timestamp) ||
    Math.abs(now / 1000 - timestamp) > 300
  )
    return false;
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.`)
    .update(body)
    .digest();
  return fields.some(
    ([key, value]) =>
      key === "v1" &&
      /^[a-f0-9]{64}$/i.test(value || "") &&
      timingSafeEqual(expected, Buffer.from(value, "hex")),
  );
}
export function createBilling(store: Store, options: Options = {}) {
  const config = options.config || billingConfig(),
    clock = options.clock || Date.now,
    fetcher = options.fetch || fetch,
    db = store.db;
  const publicUrl = (() => {
    try {
      const url = new URL(config.publicUrl);
      return url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname === "/"
        ? url.origin
        : "";
    } catch {
      return "";
    }
  })();
  const priceEntries = Object.entries(config.prices).filter(
    ([name, id]) =>
      /^[a-z][a-z0-9_-]{0,30}$/.test(name) && /^price_[A-Za-z0-9]+$/.test(id),
  );
  const configured =
    !!publicUrl &&
    /^(sk|rk)_(test|live)_/.test(config.secretKey) &&
    config.webhookSecret.startsWith("whsec_") &&
    priceEntries.length > 0;
  const allowed = (workspaceId: string) =>
    configured && config.workspaceIds.includes(workspaceId);
  const mode = config.secretKey.includes("_live_") ? "live" : "test";
  db.exec(`
    CREATE TABLE IF NOT EXISTS billing_accounts (
      workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
      customer_id TEXT UNIQUE, customer_payload TEXT NOT NULL, created_at INTEGER NOT NULL,
      subscription_id TEXT UNIQUE, plan TEXT, status TEXT NOT NULL DEFAULT 'free', seats INTEGER NOT NULL DEFAULT 0,
      period_end INTEGER, cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
      last_event_created INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS billing_checkouts (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      stripe_id TEXT UNIQUE, plan TEXT NOT NULL, seats INTEGER NOT NULL,
      payload TEXT NOT NULL, state TEXT NOT NULL, url TEXT, created_at INTEGER NOT NULL, expires_at INTEGER,
      replaces_subscription_id TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS billing_one_open_checkout ON billing_checkouts(workspace_id) WHERE state IN ('creating','open','unknown');
    CREATE TABLE IF NOT EXISTS billing_events (
      id TEXT PRIMARY KEY, workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
      type TEXT NOT NULL, event_created INTEGER NOT NULL, outcome TEXT NOT NULL, processed_at INTEGER NOT NULL
    );
  `);
  if (
    !db
      .prepare("PRAGMA table_info(billing_checkouts)")
      .all()
      .some((column) => column.name === "replaces_subscription_id")
  )
    db.exec(
      "ALTER TABLE billing_checkouts ADD COLUMN replaces_subscription_id TEXT",
    );
  const request = async (
    path: string,
    method = "GET",
    payload?: Record<string, string>,
    key?: string,
  ): Promise<StripeObject> => {
    let response: Response;
    try {
      response = await fetcher(`https://api.stripe.com/v1${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${config.secretKey}`,
          ...(payload
            ? { "Content-Type": "application/x-www-form-urlencoded" }
            : {}),
          ...(key ? { "Idempotency-Key": key } : {}),
        },
        body: payload ? new URLSearchParams(payload).toString() : undefined,
        signal: AbortSignal.timeout(10000),
        redirect: "error",
      });
    } catch {
      return fail(
        502,
        "Stripe did not confirm the request. Retry this same operation; its saved idempotency key prevents duplicate creation during the safe retry window.",
      );
    }
    if (!response.ok) {
      void response.body?.cancel();
      return fail(
        502,
        `Stripe returned HTTP ${response.status}. Check the Stripe configuration or try again later.`,
      );
    }
    try {
      return (await response.json()) as StripeObject;
    } catch {
      return fail(
        502,
        "Stripe returned an unreadable response. The operation has not been marked complete.",
      );
    }
  };
  const safeUrl = (value: unknown, hostname: string) => {
    try {
      const url = new URL(String(value));
      if (
        url.protocol === "https:" &&
        url.hostname === hostname &&
        !url.username &&
        !url.password &&
        !url.port
      )
        return url.toString();
    } catch {}
    return fail(
      502,
      "Stripe returned an unexpected redirect URL. No redirect was opened.",
    );
  };
  const actor = (req: Request, admin = false) => {
    const user = sessionUser(store, req);
    if (!user) return fail(401, "Please sign in to manage billing.");
    if (admin && !isWorkspaceAdmin(user))
      return fail(
        403,
        "Only workspace owners and administrators can manage billing.",
      );
    return user;
  };
  const revalidate = (req: Request, expected: User, admin = false) => {
    const current = actor(req, admin);
    if (
      current.id !== expected.id ||
      current.workspaceId !== expected.workspaceId
    )
      return fail(
        409,
        "The active account or workspace changed. Refresh billing before continuing.",
      );
    return current;
  };
  const enabled = (workspaceId: string) => {
    if (!allowed(workspaceId))
      fail(
        409,
        "Stripe billing is not configured and enabled for this workspace.",
      );
  };
  const account = (workspaceId: string) =>
    db
      .prepare("SELECT * FROM billing_accounts WHERE workspace_id=?")
      .get(workspaceId) as Row | undefined;
  const activeSeats = (workspaceId: string) =>
    Number(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM memberships WHERE workspace_id=? AND status='active'",
        )
        .get(workspaceId)!.count,
    );
  const writeEvent = (
    event: StripeObject,
    workspaceId: string | null,
    outcome: string,
  ) =>
    db
      .prepare(
        "INSERT OR IGNORE INTO billing_events(id,workspace_id,type,event_created,outcome,processed_at) VALUES(?,?,?,?,?,?)",
      )
      .run(event.id, workspaceId, event.type, event.created, outcome, clock());
  const route =
    (
      handler: (req: Request, res: ExpressResponse) => unknown,
    ): RequestHandler =>
    async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      try {
        await handler(req, res);
      } catch (error) {
        if (error instanceof BillingError)
          res.status(error.status).json({ error: error.message });
        else if (error instanceof z.ZodError)
          res.status(400).json({
            error: error.issues[0]?.message || "Invalid billing request.",
          });
        else
          res
            .status(500)
            .json({ error: "The billing operation could not be completed." });
      }
    };
  const priceCache = new Map<
    string,
    { expires: number; value: StripeObject }
  >();
  const price = async (alias: string) => {
    const id = priceEntries.find(([name]) => name === alias)?.[1];
    if (!id) return fail(400, "Choose a configured billing plan.");
    const cached = priceCache.get(id);
    if (cached && cached.expires > clock()) return cached.value;
    const item = await request(`/prices/${id}?expand%5B%5D=product`);
    if (
      item.id !== id ||
      !item.active ||
      item.type !== "recurring" ||
      !item.recurring ||
      item.recurring.usage_type !== "licensed" ||
      !Number.isSafeInteger(item.unit_amount) ||
      item.unit_amount < 0 ||
      !/^[a-z]{3}$/.test(item.currency) ||
      !["day", "week", "month", "year"].includes(item.recurring.interval) ||
      !Number.isInteger(item.recurring.interval_count)
    )
      return fail(
        409,
        "This plan must use an active, fixed-price, recurring licensed-seat Stripe price.",
      );
    const value = {
      id: alias,
      name: typeof item.product?.name === "string" ? item.product.name : alias,
      unitAmount: item.unit_amount,
      currency: item.currency,
      interval: item.recurring.interval,
      intervalCount: item.recurring.interval_count,
    };
    priceCache.set(id, { expires: clock() + 300000, value });
    return value;
  };
  const ensureCustomer = async (user: User) => {
    let saved = account(user.workspaceId);
    if (!saved) {
      const payload = {
        email: user.email,
        name: user.workspaceName,
        "metadata[arkoffer_workspace_id]": user.workspaceId,
      };
      db.prepare(
        "INSERT OR IGNORE INTO billing_accounts(workspace_id,customer_payload,created_at,updated_at) VALUES(?,?,?,?)",
      ).run(user.workspaceId, JSON.stringify(payload), clock(), clock());
      saved = account(user.workspaceId)!;
    }
    if (saved.customer_id) return String(saved.customer_id);
    if (clock() - Number(saved.created_at) > 23 * 3600000)
      return fail(
        409,
        "A previous customer creation was not confirmed within the safe retry window. Ask the operator to reconcile it in Stripe before trying again.",
      );
    const customer = await request(
      "/customers",
      "POST",
      JSON.parse(String(saved.customer_payload)),
      `arkoffer/customer/${user.workspaceId}`,
    );
    const id = stripeId(customer.id, "cus");
    db.prepare(
      "UPDATE billing_accounts SET customer_id=?,updated_at=? WHERE workspace_id=? AND customer_id IS NULL",
    ).run(id, clock(), user.workspaceId);
    return String(account(user.workspaceId)!.customer_id);
  };
  const applySubscriptionNow = async (
    workspaceId: string,
    subscriptionId: string,
    eventCreated?: number,
    checkoutId?: string,
  ) => {
    // A timestamp orders changes to one subscription, not the identity of the
    // workspace's subscription. Only a new, verified checkout may replace it.
    const mayReplace = (current: Row) => {
      if (
        !current.subscription_id ||
        current.subscription_id === subscriptionId
      )
        return true;
      if (
        !checkoutId ||
        !["canceled", "incomplete_expired"].includes(String(current.status))
      )
        return false;
      const checkout = db
        .prepare(
          "SELECT replaces_subscription_id FROM billing_checkouts WHERE id=? AND workspace_id=?",
        )
        .get(checkoutId, workspaceId) as Row | undefined;
      return checkout?.replaces_subscription_id === current.subscription_id;
    };
    const before = account(workspaceId);
    if (!before?.customer_id)
      return fail(409, "This workspace has no verified Stripe customer.");
    if (!mayReplace(before)) return false;
    if (
      eventCreated !== undefined &&
      eventCreated < Number(before.last_event_created)
    )
      return false;
    const started = clock();
    const item = await request(
      `/subscriptions/${stripeId(subscriptionId, "sub")}`,
    );
    if (
      item.id !== subscriptionId ||
      reference(item.customer) !== before.customer_id ||
      item.metadata?.arkoffer_workspace_id !== workspaceId
    )
      return fail(409, "Subscription ownership could not be verified.");
    const lines = item.items?.data;
    if (!Array.isArray(lines) || lines.length !== 1)
      return fail(
        409,
        "This subscription does not match the configured single-plan seat model.",
      );
    const line = lines[0],
      priceId = reference(line.price),
      plan = priceEntries.find(([, id]) => id === priceId)?.[0];
    if (
      !plan ||
      !Number.isInteger(line.quantity) ||
      line.quantity < 1 ||
      line.quantity > 1000
    )
      return fail(
        409,
        "Subscription price or seat quantity is outside this installation's configured plans.",
      );
    const statuses = [
      "incomplete",
      "incomplete_expired",
      "trialing",
      "active",
      "past_due",
      "canceled",
      "unpaid",
      "paused",
    ];
    if (!statuses.includes(item.status))
      return fail(502, "Stripe returned an unsupported subscription status.");
    const period = line.current_period_end ?? item.current_period_end;
    return store.transaction(() => {
      const current = account(workspaceId)!;
      if (!mayReplace(current)) return false;
      if (
        eventCreated !== undefined &&
        eventCreated < Number(current.last_event_created)
      )
        return false;
      if (eventCreated === undefined && Number(current.updated_at) > started)
        return false;
      db.prepare(
        "UPDATE billing_accounts SET subscription_id=?,plan=?,status=?,seats=?,period_end=?,cancel_at_period_end=?,last_event_created=?,updated_at=? WHERE workspace_id=?",
      ).run(
        subscriptionId,
        plan,
        item.status,
        line.quantity,
        Number.isFinite(period) ? Number(period) * 1000 : null,
        item.cancel_at_period_end ? 1 : 0,
        eventCreated ?? current.last_event_created,
        clock(),
        workspaceId,
      );
      return true;
    });
  };
  // Serialize canonical reads per workspace so equal-second webhook events and
  // manual refreshes cannot commit older network responses over newer ones.
  const syncs = new Map<string, Promise<boolean>>();
  const applySubscription = (
    workspaceId: string,
    subscriptionId: string,
    eventCreated?: number,
    checkoutId?: string,
  ) => {
    const prior = syncs.get(workspaceId) || Promise.resolve(false);
    const next = prior
      .catch(() => false)
      .then(() =>
        applySubscriptionNow(
          workspaceId,
          subscriptionId,
          eventCreated,
          checkoutId,
        ),
      );
    syncs.set(workspaceId, next);
    const release = () => {
      if (syncs.get(workspaceId) === next) syncs.delete(workspaceId);
    };
    void next.then(release, release);
    return next;
  };
  const readCheckout = async (row: Row) => {
    const item = await request(
      `/checkout/sessions/${stripeId(row.stripe_id, "cs")}`,
    );
    const saved = account(String(row.workspace_id));
    if (
      item.id !== row.stripe_id ||
      reference(item.customer) !== saved?.customer_id ||
      item.client_reference_id !== row.workspace_id ||
      item.metadata?.arkoffer_workspace_id !== row.workspace_id
    )
      return fail(409, "Checkout ownership could not be verified.");
    return item;
  };
  const checkoutFromProvider = async (row: Row) => {
    const item = await readCheckout(row);
    if (item.status === "complete" && reference(item.subscription)) {
      await applySubscription(
        String(row.workspace_id),
        reference(item.subscription),
        undefined,
        String(row.id),
      );
      db.prepare(
        "UPDATE billing_checkouts SET state='complete',url=NULL WHERE id=?",
      ).run(row.id);
    } else if (item.status === "expired")
      db.prepare(
        "UPDATE billing_checkouts SET state='expired',url=NULL WHERE id=?",
      ).run(row.id);
    return item;
  };
  const webhook: RequestHandler = route(async (req, res) => {
    if (!config.webhookSecret)
      return fail(503, "Webhook verification is not configured.");
    if (
      !Buffer.isBuffer(req.body) ||
      !validStripeSignature(
        req.body,
        req.get("stripe-signature") || "",
        config.webhookSecret,
        clock(),
      )
    )
      return fail(400, "Invalid Stripe webhook signature.");
    let event: StripeObject;
    try {
      event = JSON.parse(req.body.toString("utf8"));
    } catch {
      return fail(400, "Invalid event JSON.");
    }
    if (
      !/^evt_[A-Za-z0-9_]{1,180}$/.test(event.id || "") ||
      !Number.isSafeInteger(event.created) ||
      event.created > Math.floor(clock() / 1000) + 300 ||
      event.livemode !== (mode === "live") ||
      typeof event.type !== "string" ||
      !event.data?.object
    )
      return fail(400, "Invalid Stripe snapshot event.");
    if (db.prepare("SELECT id FROM billing_events WHERE id=?").get(event.id)) {
      res.json({ received: true, duplicate: true });
      return;
    }
    const object = event.data.object;
    if (
      ![
        "customer.subscription.created",
        "customer.subscription.updated",
        "customer.subscription.deleted",
        "checkout.session.completed",
        "checkout.session.async_payment_succeeded",
      ].includes(event.type)
    ) {
      writeEvent(event, null, "ignored");
      res.json({ received: true, ignored: true });
      return;
    }
    const customerId = reference(object.customer),
      saved = db
        .prepare("SELECT * FROM billing_accounts WHERE customer_id=?")
        .get(customerId) as Row | undefined;
    if (!saved) {
      writeEvent(event, null, "unknown_customer");
      res.json({ received: true, ignored: true });
      return;
    }
    const workspaceId = String(saved.workspace_id);
    if (event.created < Number(saved.last_event_created)) {
      writeEvent(event, workspaceId, "stale");
      res.json({ received: true, stale: true });
      return;
    }
    let subscriptionId = reference(object.id),
      checkoutId: string | undefined;
    if (event.type.startsWith("checkout.")) {
      const checkout = db
        .prepare(
          "SELECT * FROM billing_checkouts WHERE stripe_id=? AND workspace_id=?",
        )
        .get(reference(object.id), workspaceId) as Row | undefined;
      if (
        !checkout ||
        object.client_reference_id !== workspaceId ||
        object.metadata?.arkoffer_workspace_id !== workspaceId
      ) {
        writeEvent(event, workspaceId, "unrecognized_checkout");
        res.json({ received: true, ignored: true });
        return;
      }
      subscriptionId = reference(object.subscription);
      if (!subscriptionId)
        return fail(
          503,
          "Subscription is not available yet. Retry this event.",
        );
      const canonical = await readCheckout(checkout);
      if (canonical.status !== "complete" || !reference(canonical.subscription))
        return fail(
          503,
          "Checkout completion is not available yet. Retry this event.",
        );
      if (reference(canonical.subscription) !== subscriptionId)
        return fail(409, "Checkout subscription could not be verified.");
      checkoutId = String(checkout.id);
    }
    const updated = await applySubscription(
      workspaceId,
      subscriptionId,
      event.created,
      checkoutId,
    );
    store.transaction(() => {
      writeEvent(event, workspaceId, updated ? "applied" : "stale");
      if (event.type.startsWith("checkout."))
        db.prepare(
          "UPDATE billing_checkouts SET state='complete',url=NULL WHERE stripe_id=? AND workspace_id=?",
        ).run(reference(object.id), workspaceId);
    });
    res.json({ received: true });
  });
  return {
    webhook,
    register(app: Express) {
      app.get(
        "/api/billing",
        route(async (req, res) => {
          const user = actor(req);
          let plans: StripeObject[] = [],
            priceError = "";
          if (allowed(user.workspaceId)) {
            try {
              plans = await Promise.all(
                priceEntries.map(([alias]) => price(alias)),
              );
            } catch (error) {
              priceError =
                error instanceof Error
                  ? error.message
                  : "Prices are unavailable.";
            }
          }
          const current = revalidate(req, user),
            saved = account(user.workspaceId);
          const pending = db
            .prepare(
              "SELECT id,plan,seats,state,url,expires_at AS expiresAt FROM billing_checkouts WHERE workspace_id=? AND state IN ('creating','open','unknown') ORDER BY created_at DESC LIMIT 1",
            )
            .get(user.workspaceId);
          res.json({
            configured,
            enabled: allowed(user.workspaceId),
            mode,
            canManage: isWorkspaceAdmin(current),
            activeSeats: activeSeats(user.workspaceId),
            plans,
            priceError,
            pendingCheckout: pending
              ? {
                  ...pending,
                  url: isWorkspaceAdmin(current) ? pending.url : null,
                }
              : null,
            subscription: saved?.subscription_id
              ? {
                  plan: saved.plan,
                  status: saved.status,
                  seats: saved.seats,
                  periodEnd: saved.period_end,
                  cancelAtPeriodEnd: !!saved.cancel_at_period_end,
                  updatedAt: saved.updated_at,
                }
              : null,
            hasCustomer: !!saved?.customer_id,
          });
        }),
      );
      app.post(
        "/api/billing/checkout",
        route(async (req, res) => {
          const user = actor(req, true);
          enabled(user.workspaceId);
          const input = z
            .object({
              plan: z.string().min(1).max(31),
              seats: z.number().int().min(1).max(1000),
              acknowledged: z.literal(true),
            })
            .strict()
            .parse(req.body);
          if (input.seats < activeSeats(user.workspaceId))
            return fail(
              400,
              "Seat quantity must cover all active workspace members.",
            );
          await price(input.plan);
          revalidate(req, user, true);
          const pendingExisting = db
            .prepare(
              "SELECT * FROM billing_checkouts WHERE workspace_id=? AND state='open'",
            )
            .get(user.workspaceId) as Row | undefined;
          if (pendingExisting) await checkoutFromProvider(pendingExisting);
          revalidate(req, user, true);
          const saved = account(user.workspaceId);
          if (
            saved?.subscription_id &&
            !["canceled", "incomplete_expired"].includes(String(saved.status))
          )
            return fail(
              409,
              "This workspace already has a subscription. Use the billing portal to update or cancel it.",
            );
          const customer = await ensureCustomer(user);
          revalidate(req, user, true);
          let checkout = store.transaction(() => {
            const existing = db
              .prepare(
                "SELECT * FROM billing_checkouts WHERE workspace_id=? AND state IN ('creating','open','unknown')",
              )
              .get(user.workspaceId) as Row | undefined;
            if (existing) return existing;
            const id = randomUUID(),
              payload = {
                customer,
                mode: "subscription",
                "line_items[0][price]": config.prices[input.plan],
                "line_items[0][quantity]": String(input.seats),
                success_url: `${publicUrl}/app/settings?tab=billing&checkout=success`,
                cancel_url: `${publicUrl}/app/settings?tab=billing&checkout=cancelled`,
                client_reference_id: user.workspaceId,
                "metadata[arkoffer_workspace_id]": user.workspaceId,
                "subscription_data[metadata][arkoffer_workspace_id]":
                  user.workspaceId,
              };
            db.prepare(
              "INSERT INTO billing_checkouts(id,workspace_id,plan,seats,payload,state,created_at,replaces_subscription_id) VALUES(?,?,?,?,?,'creating',?,?)",
            ).run(
              id,
              user.workspaceId,
              input.plan,
              input.seats,
              JSON.stringify(payload),
              clock(),
              account(user.workspaceId)?.subscription_id ?? null,
            );
            return db
              .prepare("SELECT * FROM billing_checkouts WHERE id=?")
              .get(id) as Row;
          });
          if (checkout.plan !== input.plan || checkout.seats !== input.seats)
            return fail(
              409,
              "A checkout for different seats or a different plan is already open. Continue or cancel it before creating another.",
            );
          if (checkout.state === "open" && checkout.url) {
            res.json({ url: safeUrl(checkout.url, "checkout.stripe.com") });
            return;
          }
          if (clock() - Number(checkout.created_at) > 23 * 3600000)
            return fail(
              409,
              "Checkout creation was not confirmed inside the safe retry window. Ask the operator to reconcile it with Stripe before starting another.",
            );
          const created = await request(
            "/checkout/sessions",
            "POST",
            JSON.parse(String(checkout.payload)),
            `arkoffer/checkout/${checkout.id}`,
          );
          const id = stripeId(created.id, "cs"),
            url = safeUrl(created.url, "checkout.stripe.com");
          if (created.customer && reference(created.customer) !== customer)
            return fail(
              502,
              "Stripe returned a checkout for an unexpected customer.",
            );
          if (!Number.isFinite(created.expires_at))
            return fail(
              502,
              "Stripe did not return checkout expiry information.",
            );
          db.prepare(
            "UPDATE billing_checkouts SET stripe_id=?,state='open',url=?,expires_at=? WHERE id=? AND state='creating'",
          ).run(id, url, Number(created.expires_at) * 1000, checkout.id);
          revalidate(req, user, true);
          res.json({ url });
        }),
      );
      app.post(
        "/api/billing/checkout/cancel",
        route(async (req, res) => {
          const user = actor(req, true);
          enabled(user.workspaceId);
          const row = db
            .prepare(
              "SELECT * FROM billing_checkouts WHERE workspace_id=? AND state IN ('creating','open','unknown')",
            )
            .get(user.workspaceId) as Row | undefined;
          if (!row) {
            res.json({ ok: true });
            return;
          }
          if (!row.stripe_id)
            return fail(
              409,
              "The checkout has no confirmed provider ID. Retry its creation first or ask the operator to reconcile it.",
            );
          const current = await checkoutFromProvider(row);
          revalidate(req, user, true);
          if (current.status === "open") {
            const expired = await request(
              `/checkout/sessions/${stripeId(row.stripe_id, "cs")}/expire`,
              "POST",
              {},
              `arkoffer/expire/${row.id}`,
            );
            if (expired.status !== "expired")
              return fail(
                502,
                "Stripe has not confirmed checkout cancellation.",
              );
            db.prepare(
              "UPDATE billing_checkouts SET state='expired',url=NULL WHERE id=?",
            ).run(row.id);
          }
          revalidate(req, user, true);
          res.json({ ok: true });
        }),
      );
      app.post(
        "/api/billing/portal",
        route(async (req, res) => {
          const user = actor(req, true);
          enabled(user.workspaceId);
          const saved = account(user.workspaceId);
          if (!saved?.customer_id)
            return fail(
              409,
              "This workspace does not yet have a Stripe customer.",
            );
          const session = await request(
            "/billing_portal/sessions",
            "POST",
            {
              customer: String(saved.customer_id),
              return_url: `${publicUrl}/app/settings?tab=billing`,
            },
            `arkoffer/portal/${randomUUID()}`,
          );
          revalidate(req, user, true);
          res.json({ url: safeUrl(session.url, "billing.stripe.com") });
        }),
      );
      app.post(
        "/api/billing/refresh",
        route(async (req, res) => {
          const user = actor(req, true);
          enabled(user.workspaceId);
          const saved = account(user.workspaceId);
          if (saved?.subscription_id)
            await applySubscription(
              user.workspaceId,
              String(saved.subscription_id),
            );
          revalidate(req, user, true);
          const pending = db
            .prepare(
              "SELECT * FROM billing_checkouts WHERE workspace_id=? AND state='open'",
            )
            .get(user.workspaceId) as Row | undefined;
          if (pending) await checkoutFromProvider(pending);
          revalidate(req, user, true);
          res.json({ ok: true });
        }),
      );
    },
  };
}
