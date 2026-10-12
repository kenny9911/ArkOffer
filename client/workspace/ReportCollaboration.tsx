import { useEffect, useRef, useState } from "react";
import { Bell, Share2, Mail, X } from "lucide-react";
import "./report-collaboration.css";
type Sharing = {
  revision: number;
  permission: string;
  owner: { id: string; name: string };
  grants: {
    userId: string;
    permission: "viewer" | "editor";
    name: string;
    email: string;
    status: string;
  }[];
  members: { id: string; name: string; email: string }[];
};
type Subscription = {
  revision: number;
  enabled: boolean;
  frequency: "immediate" | "weekly" | "monthly";
  notifyResults: boolean;
  notifyUpcoming: boolean;
  utcHour: number;
  weekday: number;
  monthDay: number;
  email: string;
  nextAt: string;
};
type Delivery = {
  id: string;
  status: string;
  mode: string;
  createdAt: string;
  error: string | null;
};
type Settings = {
  subscription: Subscription | null;
  email: string;
  verified: boolean;
  setup: { mode: string; configured: boolean };
  deliveries: Delivery[];
};
async function request<T>(
  viewId: string,
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api/report-views/${viewId}/${path}`, {
    method,
    credentials: "same-origin",
    signal,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || "Unable to update report access.");
  if (
    path === "sharing" &&
    method === "GET" &&
    (!data.owner ||
      typeof data.owner.name !== "string" ||
      !Array.isArray(data.grants) ||
      !Array.isArray(data.members))
  )
    throw new Error(
      "Report sharing returned an incomplete response. Refresh to try again.",
    );
  if (
    path === "subscription" &&
    (!data.setup ||
      typeof data.setup.mode !== "string" ||
      !Array.isArray(data.deliveries))
  )
    throw new Error(
      "Report email settings returned an incomplete response. Refresh to try again.",
    );
  return data;
}
const initial: Omit<Subscription, "email" | "nextAt"> = {
  revision: 0,
  enabled: false,
  frequency: "immediate",
  notifyResults: true,
  notifyUpcoming: false,
  utcHour: 9,
  weekday: 1,
  monthDay: 1,
};
export default function ReportCollaboration({
  viewId,
  open,
  onChanged,
}: {
  viewId: string;
  open: number;
  onChanged: () => Promise<unknown>;
}) {
  const sharingPanel = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (open && sharingPanel.current) {
      sharingPanel.current.open = true;
      sharingPanel.current.scrollIntoView({ block: "nearest" });
    }
  }, [open]);
  const [sharing, setSharing] = useState<Sharing | null>(null),
    [settings, setSettings] = useState<Settings | null>(null),
    [draft, setDraft] = useState(initial),
    [grants, setGrants] = useState<Sharing["grants"]>([]),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [preview, setPreview] = useState<{
      to: string;
      subject: string;
      text: string;
    } | null>(null);
  const accept = (data: Settings) => {
    setSettings(data);
    setDraft(
      data.subscription
        ? {
            revision: data.subscription.revision,
            enabled: data.subscription.enabled,
            frequency: data.subscription.frequency,
            notifyResults: data.subscription.notifyResults,
            notifyUpcoming: data.subscription.notifyUpcoming,
            utcHour: data.subscription.utcHour,
            weekday: data.subscription.weekday,
            monthDay: data.subscription.monthDay,
          }
        : initial,
    );
  };
  useEffect(() => {
    const controller = new AbortController();
    setSharing(null);
    setSettings(null);
    setError("");
    setPreview(null);
    void Promise.all([
      request<Sharing>(viewId, "sharing", "GET", undefined, controller.signal),
      request<Settings>(
        viewId,
        "subscription",
        "GET",
        undefined,
        controller.signal,
      ),
    ])
      .then(([access, subscription]) => {
        if (!controller.signal.aborted) {
          setSharing(access);
          setGrants(access.grants);
          accept(subscription);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause.message);
      });
    return () => controller.abort();
  }, [viewId]);
  async function action(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="report-collaboration"
      aria-label="Sharing and subscriptions"
    >
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      <details ref={sharingPanel}>
        <summary>
          <Share2 size={15} /> Share report
        </summary>
        <p>
          Named workspace members can open this report. Conversation permissions
          stay separate: share each source conversation to make its answers and
          evidence visible.
        </p>
        {sharing?.permission === "owner" ? (
          <>
            <div className="report-grants">
              {sharing.members.map((member) => (
                <label key={member.id}>
                  <span>
                    {member.name}
                    <small>{member.email}</small>
                  </span>
                  <select
                    aria-label={`Report access for ${member.name}`}
                    value={
                      grants.find((grant) => grant.userId === member.id)
                        ?.permission || "none"
                    }
                    disabled={busy}
                    onChange={(event) =>
                      setGrants((current) => [
                        ...current.filter((g) => g.userId !== member.id),
                        ...(event.target.value === "none"
                          ? []
                          : [
                              {
                                userId: member.id,
                                name: member.name,
                                email: member.email,
                                status: "active",
                                permission: event.target.value as
                                  "viewer" | "editor",
                              },
                            ]),
                      ])
                    }
                  >
                    <option value="none">No access</option>
                    <option value="viewer">Can view</option>
                    <option value="editor">Can edit</option>
                  </select>
                </label>
              ))}
            </div>
            {!sharing.members.length && (
              <p>
                Invite members to your workspace in Settings before sharing a
                report.
              </p>
            )}
            {grants
              .filter((grant) => grant.status !== "active")
              .map((grant) => (
                <p key={grant.userId}>
                  {grant.name} — inactive member{" "}
                  <button
                    onClick={() =>
                      setGrants((current) =>
                        current.filter((g) => g.userId !== grant.userId),
                      )
                    }
                  >
                    Remove inactive grant
                  </button>
                </p>
              ))}
            <button
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  await request(viewId, "sharing", "PUT", {
                    revision: sharing.revision,
                    grants: grants.map(({ userId, permission }) => ({
                      userId,
                      permission,
                    })),
                  });
                  const next = await request<Sharing>(viewId, "sharing");
                  setSharing(next);
                  setGrants(next.grants);
                  await onChanged();
                  setMessage(
                    "Report sharing saved. Source conversation access has not changed.",
                  );
                })
              }
            >
              Save sharing
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  const next = await request<Sharing>(viewId, "sharing");
                  setSharing(next);
                  setGrants(next.grants);
                  setMessage("Current permissions loaded.");
                })
              }
            >
              Reload permissions
            </button>
          </>
        ) : sharing ? (
          <p>
            {sharing.owner.name} owns this report. You have{" "}
            {sharing.permission === "editor" ? "edit" : "view-only"} access.
            Only the owner can change sharing.
          </p>
        ) : (
          <p>Loading access…</p>
        )}
      </details>
      <details>
        <summary>
          <Bell size={15} /> Email updates
        </summary>
        <p>
          Subscribe your account email to updates from this report. No
          subscription starts AI extraction.
        </p>
        {settings ? (
          <>
            <p className="report-mail-mode">
              <Mail size={14} /> {settings.email}
              <br />
              {settings.setup.mode === "outbox"
                ? "Outbox mode: emails are saved for review and are not sent."
                : "Live email delivery uses the workspace mail provider."}
            </p>
            {!settings.setup.configured && (
              <p>Workspace mail delivery is not configured.</p>
            )}
            {settings.setup.mode !== "outbox" && !settings.verified && (
              <p>Verify your account email before enabling live delivery.</p>
            )}
            <label className="report-sub-check">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) =>
                  setDraft({ ...draft, enabled: e.target.checked })
                }
              />
              Email updates enabled
            </label>
            <label className="report-sub-check">
              <input
                type="checkbox"
                checked={draft.notifyResults}
                onChange={(e) =>
                  setDraft({ ...draft, notifyResults: e.target.checked })
                }
              />
              New completed report results
            </label>
            <label className="report-sub-check">
              <input
                type="checkbox"
                checked={draft.notifyUpcoming}
                onChange={(e) =>
                  setDraft({ ...draft, notifyUpcoming: e.target.checked })
                }
              />
              Upcoming conversations, about 30 minutes before
            </label>
            <p className="report-collaboration-muted">
              Upcoming reminders use selected conversations with a recorded
              start date and time. Missing start times are not guessed.
            </p>
            <label>
              Result email frequency
              <select
                value={draft.frequency}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    frequency: e.target.value as Subscription["frequency"],
                  })
                }
              >
                <option value="immediate">
                  Immediately when a run completes
                </option>
                <option value="weekly">Weekly digest</option>
                <option value="monthly">Monthly digest</option>
              </select>
            </label>
            {draft.frequency !== "immediate" && (
              <label>
                Digest hour (UTC)
                <select
                  value={draft.utcHour}
                  onChange={(e) =>
                    setDraft({ ...draft, utcHour: Number(e.target.value) })
                  }
                >
                  {Array.from({ length: 24 }, (_, hour) => (
                    <option key={hour} value={hour}>
                      {String(hour).padStart(2, "0")}:00 UTC
                    </option>
                  ))}
                </select>
              </label>
            )}
            {draft.frequency === "weekly" && (
              <label>
                Digest weekday (UTC)
                <select
                  value={draft.weekday}
                  onChange={(e) =>
                    setDraft({ ...draft, weekday: Number(e.target.value) })
                  }
                >
                  {[
                    "Sunday",
                    "Monday",
                    "Tuesday",
                    "Wednesday",
                    "Thursday",
                    "Friday",
                    "Saturday",
                  ].map((day, i) => (
                    <option key={day} value={i}>
                      {day}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {draft.frequency === "monthly" && (
              <label>
                Digest day of month (UTC)
                <select
                  value={draft.monthDay}
                  onChange={(e) =>
                    setDraft({ ...draft, monthDay: Number(e.target.value) })
                  }
                >
                  {Array.from({ length: 31 }, (_, day) => (
                    <option key={day} value={day + 1}>
                      {day + 1}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button
              disabled={
                busy ||
                (draft.enabled &&
                  ((!draft.notifyResults && !draft.notifyUpcoming) ||
                    !settings.setup.configured ||
                    (settings.setup.mode !== "outbox" && !settings.verified)))
              }
              onClick={() =>
                void action(async () => {
                  accept(
                    await request<Settings>(
                      viewId,
                      "subscription",
                      "PUT",
                      draft,
                    ),
                  );
                  setPreview(null);
                  setMessage(
                    draft.enabled
                      ? "Email update settings saved. Only future matching events will be included."
                      : "Unsubscribed. Pending emails have been cancelled.",
                  );
                })
              }
            >
              Save email updates
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  accept(await request<Settings>(viewId, "subscription"));
                  setPreview(null);
                })
              }
            >
              Refresh email status
            </button>
            {settings.subscription?.enabled &&
              settings.subscription.frequency !== "immediate" && (
                <p>
                  Next digest:{" "}
                  {new Date(settings.subscription.nextAt).toLocaleString()}{" "}
                  (your local time). Empty digests are skipped.
                </p>
              )}
            {draft.frequency === "monthly" && (
              <p className="report-collaboration-muted">
                Months with fewer days use their last day.
              </p>
            )}
            <h4>Recent emails</h4>
            {!settings.deliveries.length ? (
              <p>No emails queued yet.</p>
            ) : (
              <ul className="report-delivery-list">
                {settings.deliveries.map((delivery) => (
                  <li key={delivery.id}>
                    <span>
                      {new Date(delivery.createdAt).toLocaleString()} ·{" "}
                      <strong>
                        {delivery.status === "accepted"
                          ? "Accepted by provider"
                          : delivery.status}
                      </strong>
                    </span>
                    {delivery.error && <small>{delivery.error}</small>}
                    <button
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          const result = await request<{
                            preview: typeof preview;
                          }>(viewId, `subscription/deliveries/${delivery.id}`);
                          setPreview(result.preview);
                          if (!result.preview)
                            setMessage(
                              "Email content is no longer available under current access, source or subscription settings.",
                            );
                        })
                      }
                    >
                      Preview email
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {preview && (
              <section
                className="report-email-preview"
                aria-label="Report email preview"
              >
                <button
                  aria-label="Close email preview"
                  onClick={() => setPreview(null)}
                >
                  <X size={14} />
                </button>
                <p>To: {preview.to}</p>
                <h4>{preview.subject}</h4>
                <pre>{preview.text}</pre>
              </section>
            )}
          </>
        ) : (
          <p>Loading subscription…</p>
        )}
      </details>
    </section>
  );
}
