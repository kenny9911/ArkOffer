import { useEffect, useState } from "react";
import { CreditCard, ExternalLink, RefreshCw, UsersRound } from "lucide-react";
import { api, json, Button, ErrorBanner, Field, Loading, useAuth } from "../ui";

type Plan = {
  id: string;
  name: string;
  unitAmount: number;
  currency: string;
  interval: string;
  intervalCount: number;
};
type Billing = {
  configured: boolean;
  enabled: boolean;
  mode: "test" | "live";
  canManage: boolean;
  activeSeats: number;
  plans: Plan[];
  priceError: string;
  hasCustomer: boolean;
  pendingCheckout: null | {
    id: string;
    plan: string;
    seats: number;
    state: string;
    url: string | null;
    expiresAt: number | null;
  };
  subscription: null | {
    plan: string;
    status: string;
    seats: number;
    periodEnd: number | null;
    cancelAtPeriodEnd: boolean;
    updatedAt: number;
  };
};
const zeroDecimal = new Set([
  "bif",
  "clp",
  "djf",
  "gnf",
  "jpy",
  "kmf",
  "krw",
  "mga",
  "pyg",
  "rwf",
  "vnd",
  "vuv",
  "xaf",
  "xof",
  "xpf",
]);
const money = (plan: Plan, seats = 1) =>
  new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: plan.currency.toUpperCase(),
  }).format(
    (plan.unitAmount * seats) / (zeroDecimal.has(plan.currency) ? 1 : 100),
  );
const interval = (plan: Plan) =>
  plan.intervalCount === 1
    ? plan.interval
    : `${plan.intervalCount} ${plan.interval}s`;
function redirect(value: string, host: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== host ||
    url.username ||
    url.password ||
    url.port
  )
    throw new Error("The billing destination is invalid.");
  window.location.assign(url.href);
}

export default function BillingSettings() {
  const { user } = useAuth();
  const [billing, setBilling] = useState<Billing | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [selected, setSelected] = useState(""),
    [seats, setSeats] = useState(1),
    [acknowledged, setAcknowledged] = useState(false),
    [notice, setNotice] = useState("");
  async function load() {
    const result = await api<Billing>("billing");
    setBilling(result);
    setSelected((current) =>
      result.plans.some((plan) => plan.id === current)
        ? current
        : result.plans[0]?.id || "",
    );
    setSeats((current) =>
      Math.max(current, result.activeSeats, result.subscription?.seats || 1),
    );
    return result;
  }
  useEffect(() => {
    let active = true;
    setBilling(null);
    setError("");
    setAcknowledged(false);
    api<Billing>("billing")
      .then((result) => {
        if (active) {
          setBilling(result);
          setSelected(result.plans[0]?.id || "");
          setSeats(
            Math.max(1, result.activeSeats, result.subscription?.seats || 1),
          );
        }
      })
      .catch((failure) => active && setError(failure.message));
    const status = new URLSearchParams(window.location.search).get("checkout");
    if (status === "success")
      setNotice(
        "Returned from Stripe. Use Refresh status to verify your subscription; returning here does not activate a plan.",
      );
    else if (status === "cancelled")
      setNotice(
        "Checkout was left before confirmation. Your subscription status has not changed here.",
      );
    return () => {
      active = false;
    };
  }, [user?.workspaceId]);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Billing could not be updated.",
      );
    } finally {
      setBusy(false);
    }
  }
  const selectedPlan = billing?.plans.find((plan) => plan.id === selected),
    subscription = billing?.subscription;
  const hasSubscription =
    subscription &&
    !["canceled", "incomplete_expired"].includes(subscription.status);
  return (
    <section aria-labelledby="billing-title">
      <div className="team-heading">
        <div>
          <h1 id="billing-title">Plans & billing</h1>
          <p className="muted">
            Manage the subscription for {user?.workspaceName}.
          </p>
        </div>
        <CreditCard size={27} />
      </div>
      <ErrorBanner error={error} />
      {notice && (
        <p className="info-note" role="status">
          {notice}
        </p>
      )}
      {!billing && !error && <Loading />}
      {billing && (
        <>
          <article
            className="settings-card"
            style={{
              padding: 20,
              border: "1px solid #e5e5ea",
              borderRadius: 12,
              marginBottom: 20,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                flexWrap: "wrap",
              }}
            >
              <h2 style={{ margin: 0 }}>
                {subscription
                  ? billing.plans.find((plan) => plan.id === subscription.plan)
                      ?.name || subscription.plan
                  : "No confirmed paid subscription"}
              </h2>
              <span className="badge">
                {subscription?.status.replaceAll("_", " ") || "Local workspace"}
              </span>
              {billing.enabled && (
                <span className="badge">Stripe {billing.mode} mode</span>
              )}
            </div>
            <p>
              <UsersRound size={16} /> {billing.activeSeats} active members
              {subscription
                ? ` · ${subscription.seats} subscription seats`
                : ""}
            </p>
            {subscription?.periodEnd && (
              <p className="muted">
                {subscription.cancelAtPeriodEnd
                  ? "Cancellation scheduled for"
                  : "Current billing period ends"}{" "}
                {new Date(subscription.periodEnd).toLocaleDateString()}.
              </p>
            )}
            {!!subscription && billing.activeSeats > subscription.seats && (
              <p className="error">
                Your workspace has more active members than subscription seats.
                Update the seat quantity in the billing portal.
              </p>
            )}
            {!billing.enabled && (
              <p className="muted">
                Stripe checkout is not enabled for this workspace. Local
                workspace features remain available. An operator must configure
                the Stripe account, prices, webhook, and workspace access before
                billing can start.
              </p>
            )}
            {billing.canManage && billing.enabled && (
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <Button
                  variant="secondary"
                  busy={busy}
                  onClick={() =>
                    void run(async () => {
                      await api("billing/refresh", json("POST", {}));
                      await load();
                      setNotice("Billing status refreshed from Stripe.");
                    })
                  }
                >
                  <RefreshCw size={15} />
                  Refresh status
                </Button>
                {billing.hasCustomer && (
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const result = await api<{ url: string }>(
                          "billing/portal",
                          json("POST", {}),
                        );
                        redirect(result.url, "billing.stripe.com");
                      })
                    }
                  >
                    <ExternalLink size={15} />
                    Open billing portal
                  </Button>
                )}
              </div>
            )}
            {!billing.canManage && (
              <p className="muted">
                Only workspace owners and administrators can change billing.
              </p>
            )}
          </article>
          <ErrorBanner error={billing.priceError} />
          {billing.pendingCheckout && billing.canManage && (
            <article
              style={{
                padding: 20,
                border: "1px solid #e5e5ea",
                borderRadius: 12,
                marginBottom: 20,
              }}
            >
              <h3>Checkout in progress</h3>
              <p>
                {billing.pendingCheckout.plan} · {billing.pendingCheckout.seats}{" "}
                seats · {billing.pendingCheckout.state}
              </p>
              <p className="muted">
                A saved checkout prevents duplicate subscriptions. Complete it
                or cancel it before choosing a different plan.
              </p>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                {billing.pendingCheckout.url && (
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        redirect(
                          billing.pendingCheckout!.url!,
                          "checkout.stripe.com",
                        );
                      })
                    }
                  >
                    Continue saved checkout <ExternalLink size={15} />
                  </Button>
                )}
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await api("billing/checkout/cancel", json("POST", {}));
                      await load();
                      setNotice("Checkout status verified with Stripe.");
                    })
                  }
                >
                  Cancel checkout
                </Button>
              </div>
            </article>
          )}
          {billing.enabled && billing.plans.length > 0 && (
            <>
              <div className="integration-grid">
                {billing.plans.map((plan) => (
                  <article className="integration-card" key={plan.id}>
                    <h3>{plan.name}</h3>
                    <strong style={{ fontSize: 24 }}>{money(plan)}</strong>
                    <p className="muted">per seat / {interval(plan)}</p>
                    {!hasSubscription && billing.canManage && (
                      <Button
                        variant={selected === plan.id ? "" : "secondary"}
                        disabled={busy}
                        onClick={() => {
                          setSelected(plan.id);
                          setAcknowledged(false);
                        }}
                      >
                        {selected === plan.id ? "Selected" : "Choose plan"}
                      </Button>
                    )}
                  </article>
                ))}
              </div>
              {hasSubscription && (
                <p className="muted">
                  Use the billing portal to change your plan or seats, update
                  payment details, view invoices, or cancel. Stripe shows the
                  final amount before you confirm changes.
                </p>
              )}
              {!hasSubscription && billing.canManage && selectedPlan && (
                <div style={{ marginTop: 24, maxWidth: 580 }}>
                  <Field
                    label="Subscription seats"
                    hint={`At least ${billing.activeSeats} seats are needed for the active members of this workspace.`}
                  >
                    <input
                      type="number"
                      min={Math.max(1, billing.activeSeats)}
                      max={1000}
                      value={seats}
                      onChange={(event) => {
                        setSeats(Number(event.target.value));
                        setAcknowledged(false);
                      }}
                    />
                  </Field>
                  <p>
                    <strong>
                      {Number.isInteger(seats) && seats > 0
                        ? money(selectedPlan, seats)
                        : "—"}{" "}
                      / {interval(selectedPlan)}
                    </strong>{" "}
                    before any applicable taxes or discounts. Stripe Checkout
                    shows the final total.
                  </p>
                  <label
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 10,
                      lineHeight: 1.5,
                      margin: "18px 0",
                    }}
                  >
                    <input
                      style={{ marginTop: 5 }}
                      type="checkbox"
                      checked={acknowledged}
                      onChange={(event) =>
                        setAcknowledged(event.target.checked)
                      }
                      disabled={busy}
                    />
                    <span>
                      I reviewed this plan and seat quantity and want to
                      continue to Stripe{" "}
                      {billing.mode === "test" ? "test " : ""}Checkout.
                    </span>
                  </label>
                  <Button
                    busy={busy}
                    disabled={
                      !acknowledged ||
                      !Number.isInteger(seats) ||
                      seats < Math.max(1, billing.activeSeats) ||
                      seats > 1000
                    }
                    onClick={() =>
                      void run(async () => {
                        const result = await api<{ url: string }>(
                          "billing/checkout",
                          json("POST", { plan: selected, seats, acknowledged }),
                        );
                        redirect(result.url, "checkout.stripe.com");
                      })
                    }
                  >
                    Continue to Stripe <ExternalLink size={15} />
                  </Button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
