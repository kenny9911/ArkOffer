import { useCallback, useEffect, useState } from "react";
import {
  Clock3,
  Mail,
  Pause,
  Play,
  RefreshCw,
  Square,
  CheckCircle2,
} from "lucide-react";
import { api, json, Modal, Button, ErrorBanner, Loading, useAuth } from "../ui";

type Mode = "outbox" | "resend";
type DeliveryConfig = {
  mode: Mode;
  configured: boolean;
  allowed: boolean;
  from: string;
  replyTo: string;
};
type Recipient = {
  candidateId: string;
  name: string;
  email: string;
  eligible: boolean;
  reason: string;
  messages: {
    step: number;
    subject: string;
    text: string;
    delayDays: number;
  }[];
};
type Preview = {
  revision: string;
  sequenceName: string;
  config: DeliveryConfig;
  recipients: Recipient[];
};
type Enrollment = {
  id: string;
  name: string;
  email: string;
  status: string;
  mode: Mode;
  createdAt: number;
};
type Message = {
  id: string;
  enrollmentId: string;
  stepIndex: number;
  subject: string;
  status: string;
  dueAt: number | null;
  attempts: number;
  error: string | null;
  providerEvent: string | null;
};
type Activity = {
  enrollments: Enrollment[];
  messages: Message[];
  events: {
    id: string;
    enrollmentId: string;
    type: string;
    detail: string;
    createdAt: number;
  }[];
  config: DeliveryConfig;
};
const when = (value: number | null) =>
  value ? new Date(value).toLocaleString() : "After previous step";
const statusLabel = (status: string) =>
  ({
    outbox: "Local outbox · not delivered",
    accepted: "Provider accepted · awaiting delivery",
    unknown: "Delivery unknown · no retry",
    attention: "Needs review",
    retry: "Waiting to retry",
    pending: "Scheduled",
    waiting: "Waiting for previous step",
    replied: "Reply recorded",
    sending: "Sending",
    delivered: "Delivered",
    failed: "Failed",
    cancelled: "Cancelled",
    active: "Active",
    paused: "Paused",
    stopped: "Stopped",
    unsubscribed: "Suppressed",
    completed: "All steps processed",
  })[status] || status;
const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "The operation could not be completed.";

export default function SequenceDelivery({
  sequenceId,
  onClose,
}: {
  sequenceId: string;
  onClose: () => void;
}) {
  const { user } = useAuth();
  const admin = ["owner", "admin"].includes(user?.role || "");
  const path = `sequences/${sequenceId}/delivery`;
  const [preview, setPreview] = useState<Preview | null>(null);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"preview" | "activity">("preview");
  const [busy, setBusy] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [message, setMessage] = useState<{
    id: string;
    subject: string;
    text: string;
    email: string;
    status: string;
  } | null>(null);
  const [notice, setNotice] = useState("");
  const reload = useCallback(async () => {
    const results = await Promise.allSettled([
      api<Preview>(`${path}/preview`),
      api<Activity>(path),
    ]);
    if (results[0].status === "fulfilled") {
      setPreview(results[0].value);
      setPreviewError("");
    } else {
      setPreview(null);
      setPreviewError(errorText(results[0].reason));
    }
    if (results[1].status === "fulfilled") setActivity(results[1].value);
    else setError(errorText(results[1].reason));
    setAcknowledged(false);
  }, [path]);
  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    let active = true;
    const timer = setInterval(() => {
      void api<Activity>(path)
        .then((data) => {
          if (active) setActivity(data);
        })
        .catch(() => {
          /* Manual refresh reports persistent errors. */
        });
    }, 15_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [path]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };
  const control = (action: string, enrollmentId?: string) =>
    run(async () => {
      await api(
        `${path}/control`,
        json("POST", { action, ...(enrollmentId ? { enrollmentId } : {}) }),
      );
      setConfirmStop(false);
      await reload();
    });
  const config = preview?.config || activity?.config;
  const eligible =
    preview?.recipients.filter((recipient) => recipient.eligible) || [];
  const active =
    activity?.enrollments.filter((item) => item.status === "active").length ||
    0;
  const paused =
    activity?.enrollments.filter((item) => item.status === "paused").length ||
    0;
  return (
    <Modal
      wide
      title={
        preview ? `Delivery · ${preview.sequenceName}` : "Sequence delivery"
      }
      onClose={onClose}
    >
      {config && (
        <div className="business-provider-note" style={{ marginBottom: 18 }}>
          <Mail size={20} style={{ flexShrink: 0 }} />
          <div>
            <strong>
              {config.mode === "outbox" ? "Local outbox" : "Resend delivery"}
            </strong>
            <p style={{ margin: "4px 0 0" }}>
              {config.mode === "outbox"
                ? "Launch runs the sequence schedule and saves messages locally. No email is sent to candidates."
                : `Messages will be sent from ${config.from || "an unconfigured sender"}. ${config.replyTo ? `Replies go to ${config.replyTo}.` : ""}`}
            </p>
            {!config.allowed && (
              <p style={{ margin: "6px 0 0" }}>
                Live delivery is not enabled for this workspace. An operator
                must configure and approve the sender before launch.
              </p>
            )}
          </div>
        </div>
      )}
      <div className="tabs" style={{ marginBottom: 18 }}>
        <button
          className={tab === "preview" ? "active" : ""}
          onClick={() => setTab("preview")}
        >
          Recipients & preview
        </button>
        <button
          className={tab === "activity" ? "active" : ""}
          onClick={() => setTab("activity")}
        >
          Activity{" "}
          {activity?.enrollments.length
            ? `(${activity.enrollments.length})`
            : ""}
        </button>
        <button
          aria-label="Refresh delivery"
          disabled={busy}
          onClick={() => void run(reload)}
        >
          <RefreshCw size={15} />
        </button>
      </div>
      <ErrorBanner error={error} />
      {notice && (
        <p role="status" className="business-provider-note">
          {notice}
        </p>
      )}
      {!activity && !error && <Loading />}
      {tab === "preview" && (
        <>
          <ErrorBanner error={previewError} />
          {preview && (
            <>
              <p style={{ color: "var(--muted)", lineHeight: 1.55 }}>
                Review each recipient and personalized message before launch.
                Launched messages keep this snapshot even if you later edit the
                draft. Follow-up delays start after the previous step is
                processed.
              </p>
              <p>
                <strong>{eligible.length} eligible recipients</strong> ·{" "}
                {preview.recipients.length - eligible.length} excluded
              </p>
              <div style={{ display: "grid", gap: 10, marginBottom: 18 }}>
                {preview.recipients.map((recipient) => (
                  <details
                    key={recipient.candidateId}
                    style={{
                      border: "1px solid #e5e5ea",
                      borderRadius: 10,
                      padding: 12,
                    }}
                  >
                    <summary
                      style={{ cursor: "pointer", overflowWrap: "anywhere" }}
                    >
                      <strong>{recipient.name || "Candidate"}</strong> ·{" "}
                      {recipient.email || "Missing email"}{" "}
                      <span className="business-badge">
                        {recipient.eligible ? "Ready" : "Excluded"}
                      </span>
                    </summary>
                    {recipient.reason && (
                      <p className="business-alert">{recipient.reason}</p>
                    )}
                    {recipient.messages.map((step) => (
                      <div
                        key={step.step}
                        style={{
                          marginTop: 16,
                          borderTop: "1px solid #eeeeef",
                          paddingTop: 12,
                        }}
                      >
                        <p style={{ margin: "0 0 8px", color: "var(--muted)" }}>
                          <Clock3 size={13} /> Step {step.step} ·{" "}
                          {step.step === 1
                            ? `${step.delayDays} days after launch`
                            : `${step.delayDays} days after previous step`}
                        </p>
                        <strong>{step.subject}</strong>
                        <p
                          style={{
                            whiteSpace: "pre-wrap",
                            overflowWrap: "anywhere",
                          }}
                        >
                          {step.text}
                        </p>
                      </div>
                    ))}
                    <small className="business-muted">
                      Each message includes a working unsubscribe link.
                    </small>
                  </details>
                ))}
              </div>
              {admin ? (
                <>
                  <label
                    style={{
                      display: "flex",
                      gap: 10,
                      alignItems: "flex-start",
                      lineHeight: 1.5,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={acknowledged}
                      disabled={busy || !eligible.length || !config?.allowed}
                      onChange={(event) =>
                        setAcknowledged(event.target.checked)
                      }
                      style={{ marginTop: 5 }}
                    />
                    <span>
                      {config?.mode === "resend"
                        ? `I reviewed the ${eligible.length} recipients and messages and authorize sending this sequence on its schedule.`
                        : `I reviewed the ${eligible.length} recipients and authorize running this schedule in the local outbox. No emails will be delivered.`}
                    </span>
                  </label>
                  <div className="business-dialog-actions">
                    <Button
                      busy={busy}
                      disabled={
                        !acknowledged || !eligible.length || !config?.allowed
                      }
                      onClick={() =>
                        void run(async () => {
                          await api(
                            `${path}/launch`,
                            json("POST", {
                              revision: preview.revision,
                              mode: preview.config.mode,
                              acknowledged,
                            }),
                          );
                          setNotice(
                            preview.config.mode === "outbox"
                              ? "Sequence queued in the local outbox. The scheduler processes due steps while the server is running."
                              : "Sequence launched. Due steps will be sent while the server is running.",
                          );
                          await reload();
                          setTab("activity");
                        })
                      }
                    >
                      <Play size={15} />
                      {config?.mode === "outbox"
                        ? "Queue in local outbox"
                        : "Launch email sequence"}
                    </Button>
                  </div>
                </>
              ) : (
                <p className="business-help">
                  An owner or admin can launch and manage delivery.
                </p>
              )}
            </>
          )}
        </>
      )}
      {tab === "activity" && activity && (
        <>
          <p className="business-help">
            Replies are recorded manually here; ArkOffer is not monitoring an
            inbox. Mark a reply to cancel remaining follow-ups. Pausing or
            stopping cannot recall a request already sent to the provider.
          </p>
          {admin && (
            <div
              style={{
                display: "flex",
                gap: 8,
                flexWrap: "wrap",
                marginBottom: 18,
              }}
            >
              <Button
                variant="secondary"
                disabled={busy || !active}
                onClick={() => void control("pause")}
              >
                <Pause size={14} />
                Pause all
              </Button>
              <Button
                variant="secondary"
                disabled={busy || !paused}
                onClick={() => void control("resume")}
              >
                <Play size={14} />
                Resume all
              </Button>
              <Button
                variant="secondary"
                disabled={busy || !(active + paused)}
                onClick={() => setConfirmStop(true)}
              >
                <Square size={14} />
                Stop all
              </Button>
              {config?.mode === "resend" && (
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const result = await api<{ updated: number }>(
                        `${path}/reconcile`,
                        json("POST", {}),
                      );
                      await reload();
                      setNotice(
                        result.updated
                          ? `Refreshed ${result.updated} provider statuses.`
                          : "No provider statuses were eligible for refresh. Recently checked messages are refreshed after one minute.",
                      );
                    })
                  }
                >
                  Check provider status
                </Button>
              )}
            </div>
          )}
          {confirmStop && (
            <div className="business-alert">
              <p>
                Stop all pending follow-ups? Stopped enrollments cannot be
                restarted, which prevents duplicate outreach.
              </p>
              <Button disabled={busy} onClick={() => void control("stop")}>
                Confirm stop
              </Button>{" "}
              <Button variant="secondary" onClick={() => setConfirmStop(false)}>
                Keep running
              </Button>
            </div>
          )}
          {!activity.enrollments.length && (
            <p className="business-help">
              Nothing has launched yet. Review the recipients and messages in
              the preview.
            </p>
          )}
          <div style={{ display: "grid", gap: 12 }}>
            {activity.enrollments.map((enrollment) => (
              <section
                key={enrollment.id}
                style={{
                  border: "1px solid #e5e5ea",
                  borderRadius: 10,
                  padding: 14,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 12,
                    flexWrap: "wrap",
                  }}
                >
                  <div style={{ overflowWrap: "anywhere" }}>
                    <strong>{enrollment.name}</strong>
                    <p style={{ margin: "4px 0" }}>{enrollment.email}</p>
                    <span className="business-badge">
                      {statusLabel(enrollment.status)}
                    </span>{" "}
                    <small>
                      {enrollment.mode === "outbox"
                        ? "Local simulation"
                        : "Live email"}
                    </small>
                  </div>
                  {admin &&
                    ["active", "paused", "completed"].includes(
                      enrollment.status,
                    ) && (
                      <Button
                        variant="secondary"
                        disabled={busy}
                        onClick={() => void control("replied", enrollment.id)}
                      >
                        <CheckCircle2 size={14} />
                        Mark replied
                      </Button>
                    )}
                </div>
                {activity.messages
                  .filter((item) => item.enrollmentId === enrollment.id)
                  .map((item) => (
                    <div
                      key={item.id}
                      style={{
                        borderTop: "1px solid #eeeeef",
                        paddingTop: 12,
                        marginTop: 12,
                      }}
                    >
                      <button
                        className="business-link"
                        onClick={() =>
                          void run(async () => {
                            const result = await api<{
                              item: Omit<NonNullable<typeof message>, "id">;
                            }>(`${path}/messages/${item.id}`);
                            setMessage({ id: item.id, ...result.item });
                          })
                        }
                      >
                        Step {item.stepIndex + 1}: {item.subject}
                      </button>
                      <p style={{ margin: "5px 0", fontSize: 13 }}>
                        {statusLabel(item.status)}
                        {["pending", "retry", "waiting"].includes(item.status)
                          ? ` · ${when(item.dueAt)}`
                          : ""}
                        {item.attempts > 1
                          ? ` · ${item.attempts} attempts`
                          : ""}
                      </p>
                      {item.error && (
                        <p role="status" className="business-alert">
                          {item.error}
                        </p>
                      )}
                      {message?.id === item.id && (
                        <div
                          style={{
                            padding: 12,
                            background: "#f6f6f8",
                            borderRadius: 8,
                          }}
                        >
                          <p
                            style={{
                              whiteSpace: "pre-wrap",
                              overflowWrap: "anywhere",
                              margin: "0 0 12px",
                            }}
                          >
                            {message.text}
                          </p>
                          <button
                            className="business-link"
                            onClick={() => setMessage(null)}
                          >
                            Close message
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
              </section>
            ))}
          </div>
          {!!activity.events.length && (
            <details style={{ marginTop: 24 }}>
              <summary style={{ cursor: "pointer" }}>Recent history</summary>
              <ol style={{ paddingLeft: 20 }}>
                {activity.events.map((event) => (
                  <li
                    key={event.id}
                    style={{ margin: "12px 0", lineHeight: 1.5 }}
                  >
                    <small className="business-muted">
                      {when(event.createdAt)}
                    </small>
                    <br />
                    {event.detail}
                  </li>
                ))}
              </ol>
            </details>
          )}
        </>
      )}
    </Modal>
  );
}
