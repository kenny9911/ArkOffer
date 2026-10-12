import { useEffect, useState } from "react";
import { Mail, RefreshCw, Send, X } from "lucide-react";
import { api, json, Button, ErrorBanner, Field, Modal } from "../ui";
import "./screening-outreach.css";

type Recipient = {
  name: string;
  email: string;
  candidateId?: string | null;
  subject: string;
  body: string;
};
type Preview = {
  id: string;
  expiresAt: number;
  mode: string;
  from: string;
  deadlineDays: number;
  reminderDays: number[];
  recipients: Recipient[];
};
type Invitation = {
  id: string;
  name: string;
  email: string;
  status: string;
  createdAt: number;
  openedAt: number | null;
  expiresAt: number;
  submittedAt: string | null;
  messages: {
    id: string;
    kind: string;
    daysBefore: number;
    dueAt: number;
    status: string;
    providerEvent: string | null;
    error: string | null;
  }[];
};
type Delivery = {
  mode: string;
  from: string;
  ready: boolean;
  canManage: boolean;
  reason: string | null;
};
type Candidate = { id: string; name: string; email?: string };
type Props = {
  screeningId: string;
  revision: string;
  title: string;
  deadlineDays?: number;
  disabled?: boolean;
  onDirty?: (dirty: boolean) => void;
};
const date = (value: string | number) => new Date(value).toLocaleString();
const defaultSubject = "Invitation: {{screening_title}} at {{company_name}}";
const defaultBody =
  "Hi {{candidate_first_name}},\n\nWe’d like to invite you to complete {{screening_title}}. Please share your professional experience by {{deadline}}.\n\n{{interview_link}}\n\nThank you,\n{{company_name}}";
const labels: Record<string, string> = {
  outbox: "Saved to local outbox",
  accepted: "Accepted by email provider",
  delivered: "Delivered",
  pending: "Scheduled",
  unknown: "Delivery unknown",
  attention: "Needs attention",
  active: "Invited",
  author_unavailable: "Sender access removed",
  candidate_removed: "Candidate removed",
  unsubscribed: "Opted out",
};
export default function ScreeningOutreach({
  screeningId,
  revision,
  title,
  deadlineDays = 7,
  disabled = false,
  onDirty,
}: Props) {
  const [items, setItems] = useState<Invitation[]>([]),
    [delivery, setDelivery] = useState<Delivery | null>(null),
    [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState<string[]>([]),
    [manual, setManual] = useState(""),
    [subject, setSubject] = useState(
      "Invitation: {{screening_title}} at {{company_name}}",
    ),
    [body, setBody] = useState(
      "Hi {{candidate_first_name}},\n\nWe’d like to invite you to complete {{screening_title}}. Please share your professional experience by {{deadline}}.\n\n{{interview_link}}\n\nThank you,\n{{company_name}}",
    ),
    [reminders, setReminders] = useState<number[]>(
      [3, 1].filter((day) => day < deadlineDays),
    );
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [preview, setPreview] = useState<Preview | null>(null),
    [requestId, setRequestId] = useState(""),
    [reviewIndex, setReviewIndex] = useState(0),
    [approved, setApproved] = useState(false),
    [sent, setSent] = useState("");
  const [view, setView] = useState<{
      to: string;
      subject: string;
      text: string;
      mode: string;
    } | null>(null),
    [cancel, setCancel] = useState<Invitation | null>(null),
    [query, setQuery] = useState("");
  const prefix = `screenings/${encodeURIComponent(screeningId)}/outreach`;
  const load = async () => {
    const result = await api<{ items: Invitation[]; delivery: Delivery }>(
      prefix,
    );
    setItems(result.items);
    setDelivery(result.delivery);
  };
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    Promise.all([
      api<{ items: Invitation[]; delivery: Delivery }>(prefix, {
        signal: abort.signal,
      }),
      api<{ items: Candidate[] }>("candidates", { signal: abort.signal }),
    ])
      .then(([result, people]) => {
        setItems(result.items);
        setDelivery(result.delivery);
        setCandidates(people.items);
      })
      .catch((error) => {
        if (!abort.signal.aborted) setError(error.message);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [prefix]);
  useEffect(() => {
    setPreview(null);
    setApproved(false);
  }, [revision]);
  const [baseline, setBaseline] = useState({
    subject: defaultSubject,
    body: defaultBody,
    reminders: [3, 1].filter((day) => day < deadlineDays).join(","),
  });
  const dirty =
    !!manual.trim() ||
    selected.length > 0 ||
    subject !== baseline.subject ||
    body !== baseline.body ||
    [...reminders].sort().join(",") !==
      baseline.reminders.split(",").sort().join(",");
  useEffect(() => {
    onDirty?.(dirty);
    return () => onDirty?.(false);
  }, [dirty, onDirty]);
  const change = () => {
    setPreview(null);
    setApproved(false);
    setSent("");
  };
  const work = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const prepare = () =>
    work(async () => {
      const recipients = manual
        .split(/\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const match = line.match(/^(.+?)\s*<([^<>]+)>$/);
          if (!match)
            throw new Error(
              "Use one recipient per line: Full Name <email@example.com>.",
            );
          return { name: match[1].trim(), email: match[2].trim() };
        });
      const result = await api<{ item: Preview }>(
        `${prefix}/preview`,
        json("POST", {
          revision,
          candidateIds: selected,
          recipients,
          subject,
          body,
          reminderDays: reminders.filter((day) => day < deadlineDays),
        }),
      );
      setPreview(result.item);
      setRequestId(crypto.randomUUID());
      setReviewIndex(0);
      setApproved(false);
    });
  const queue = () =>
    work(async () => {
      if (!preview) return;
      const result = await api<{ items: Invitation[] }>(
        `${prefix}/queue`,
        json("POST", { previewId: preview.id, requestId, confirmed: true }),
      );
      setItems(result.items);
      setBaseline({
        subject,
        body,
        reminders: [...reminders].sort().join(","),
      });
      setSent(
        `${preview.recipients.length} invitation${preview.recipients.length === 1 ? "" : "s"} queued${preview.mode === "outbox" ? " for the local outbox. No email will be delivered." : " for email delivery."}`,
      );
      setPreview(null);
      setSelected([]);
      setManual("");
      setApproved(false);
    });
  const canManage = delivery?.canManage && !disabled && !busy;
  return (
    <section
      className="screening-outreach"
      aria-label="Screening invitations and reminders"
    >
      <header>
        <div>
          <h2>
            <Mail size={19} /> Invitations & reminders
          </h2>
          <p>
            Send each candidate a private link to the saved version of {title}.
            Links expire {deadlineDays} days after queuing.
          </p>
        </div>
      </header>
      <ErrorBanner error={error} />
      {sent && (
        <p className="screening-outreach-success" role="status">
          {sent}
        </p>
      )}
      {loading ? (
        <p role="status">Loading invitations…</p>
      ) : (
        <>
          <div className="screening-outreach-mode">
            <strong>
              {delivery?.mode === "outbox"
                ? "Local outbox — no email is delivered"
                : "Email delivery"}
            </strong>
            <span>From: {delivery?.from}</span>
            {delivery?.reason && <p>{delivery.reason}</p>}
          </div>
          {disabled && (
            <p role="status">
              Save your screening changes before preparing invitations.
            </p>
          )}
          {!delivery?.canManage && (
            <p>
              Only workspace owners can queue or cancel candidate invitations.
            </p>
          )}
          <fieldset
            disabled={!canManage}
            className="screening-outreach-compose"
          >
            <legend>Recipients & message</legend>
            <Field label="Find workspace candidates">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search candidate name or email"
              />
            </Field>
            <div className="screening-outreach-people">
              {candidates
                .filter((candidate) =>
                  `${candidate.name} ${candidate.email || ""}`
                    .toLowerCase()
                    .includes(query.toLowerCase()),
                )
                .slice(0, 100)
                .map((candidate) => (
                  <label key={candidate.id}>
                    <input
                      type="checkbox"
                      disabled={!candidate.email}
                      checked={selected.includes(candidate.id)}
                      onChange={(e) => {
                        change();
                        setSelected((current) =>
                          e.target.checked
                            ? [...current, candidate.id]
                            : current.filter((id) => id !== candidate.id),
                        );
                      }}
                    />
                    <span>
                      {candidate.name}
                      <small>{candidate.email || "No email address"}</small>
                    </span>
                  </label>
                ))}
              {!candidates.length && (
                <p>No workspace candidates yet. Add named recipients below.</p>
              )}
            </div>
            <Field
              label="Additional recipients"
              hint="One Full Name <email> per line. Up to 50 recipients per reviewed batch."
            >
              <textarea
                rows={3}
                value={manual}
                onChange={(e) => {
                  change();
                  setManual(e.target.value);
                }}
                placeholder="Alex Example <alex@example.com>"
              />
            </Field>
            <Field label="Invitation subject">
              <input
                maxLength={200}
                value={subject}
                onChange={(e) => {
                  change();
                  setSubject(e.target.value);
                }}
              />
            </Field>
            <Field label="Invitation message">
              <textarea
                rows={9}
                maxLength={10000}
                value={body}
                onChange={(e) => {
                  change();
                  setBody(e.target.value);
                }}
              />
            </Field>
            <p className="screening-outreach-variables">
              Variables:{" "}
              {
                "{{candidate_first_name}}, {{candidate_name}}, {{screening_title}}, {{company_name}}, {{deadline}}, {{interview_link}}"
              }
            </p>
            <div className="screening-outreach-reminders">
              <strong>Reminders before the deadline</strong>
              {[3, 1].map((day) => (
                <label key={day}>
                  <input
                    type="checkbox"
                    disabled={day >= deadlineDays}
                    checked={reminders.includes(day) && day < deadlineDays}
                    onChange={(e) => {
                      change();
                      setReminders((current) =>
                        e.target.checked
                          ? [...current, day]
                          : current.filter((value) => value !== day),
                      );
                    }}
                  />
                  {day} day{day === 1 ? "" : "s"} before
                  {day >= deadlineDays ? " (deadline too short)" : ""}
                </label>
              ))}
            </div>
            <p>
              Reminders stop after submission, cancellation, link revocation,
              expiration or opt-out. Every message includes an opt-out link.
            </p>
            <Button
              onClick={prepare}
              disabled={
                !delivery?.ready || (!selected.length && !manual.trim()) || busy
              }
            >
              <Send size={16} />
              Review invitations
            </Button>
            {dirty && (
              <Button
                variant="ghost"
                onClick={() => {
                  setManual("");
                  setSelected([]);
                  setSubject(baseline.subject);
                  setBody(baseline.body);
                  setReminders(
                    baseline.reminders.split(",").filter(Boolean).map(Number),
                  );
                  change();
                }}
              >
                Discard invitation edits
              </Button>
            )}
          </fieldset>
          <div className="screening-outreach-history">
            <header>
              <h3>Invitation history</h3>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => work(load)}
              >
                <RefreshCw size={15} />
                Refresh delivery
              </Button>
            </header>
            {!items.length ? (
              <p>No invitations queued yet.</p>
            ) : (
              <div className="screening-outreach-table">
                <table>
                  <thead>
                    <tr>
                      <th>Candidate</th>
                      <th>Status</th>
                      <th>Deadline</th>
                      <th>Delivery & reminders</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={item.id}>
                        <td>
                          <strong>{item.name}</strong>
                          <small>{item.email}</small>
                        </td>
                        <td>
                          {labels[item.status] || item.status}
                          {item.openedAt && (
                            <small>Link opened {date(item.openedAt)}</small>
                          )}
                          {item.submittedAt && (
                            <small>Submitted {date(item.submittedAt)}</small>
                          )}
                        </td>
                        <td>{date(item.expiresAt)}</td>
                        <td>
                          {item.messages.map((message) => (
                            <div
                              className="screening-outreach-message"
                              key={message.id}
                            >
                              <strong>
                                {message.kind === "invitation"
                                  ? "Invitation"
                                  : `${message.daysBefore}-day reminder`}
                                : {labels[message.status] || message.status}
                              </strong>
                              <small>{date(message.dueAt)}</small>
                              {message.error && (
                                <small className="screening-outreach-problem">
                                  {message.error}
                                </small>
                              )}
                            </div>
                          ))}
                        </td>
                        <td>
                          {delivery?.canManage && (
                            <Button
                              variant="ghost"
                              disabled={busy}
                              onClick={() =>
                                work(async () => {
                                  const result = await api<{
                                    item: {
                                      to: string;
                                      subject: string;
                                      text: string;
                                      mode: string;
                                    };
                                  }>(
                                    `${prefix}/invitations/${item.id}/preview`,
                                  );
                                  setView(result.item);
                                })
                              }
                            >
                              View message
                            </Button>
                          )}
                          {delivery?.canManage &&
                            ["active", "attention"].includes(item.status) && (
                              <Button
                                variant="ghost"
                                disabled={busy}
                                onClick={() => setCancel(item)}
                              >
                                <X size={14} />
                                Cancel invitation
                              </Button>
                            )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
      {preview && (
        <Modal
          title="Review screening invitations"
          wide
          onClose={() => {
            if (!busy) setPreview(null);
          }}
        >
          <div className="screening-outreach-review">
            <p>
              <strong>
                {preview.recipients.length} recipient
                {preview.recipients.length === 1 ? "" : "s"}
              </strong>{" "}
              ·{" "}
              {preview.mode === "outbox"
                ? "Local outbox; no email will be delivered"
                : "Live email delivery"}
            </p>
            <p>
              From: {preview.from}. Deadline: {preview.deadlineDays} days from
              queuing. Reminders:{" "}
              {preview.reminderDays.length
                ? `${preview.reminderDays.join(" and ")} days before the deadline`
                : "none"}
              .
            </p>
            <Field label="Review recipient">
              <select
                value={reviewIndex}
                onChange={(e) => setReviewIndex(Number(e.target.value))}
              >
                {preview.recipients.map((recipient, index) => (
                  <option key={recipient.email} value={index}>
                    {recipient.name} &lt;{recipient.email}&gt;
                  </option>
                ))}
              </select>
            </Field>
            <h3>{preview.recipients[reviewIndex].subject}</h3>
            <pre>{preview.recipients[reviewIndex].body}</pre>
            <p>
              Preview expires {date(preview.expiresAt)}. A unique candidate link
              is generated only when you queue this batch.
            </p>
            <label className="screening-outreach-approval">
              <input
                type="checkbox"
                checked={approved}
                disabled={busy}
                onChange={(e) => setApproved(e.target.checked)}
              />
              I reviewed the complete recipient list and message, and approve
              this batch and its reminders.
            </label>
            <ErrorBanner error={error} />
            <Button disabled={!approved || busy} onClick={queue}>
              {busy
                ? "Queuing…"
                : preview.mode === "outbox"
                  ? "Queue in local outbox"
                  : "Queue and send invitations"}
            </Button>
          </div>
        </Modal>
      )}
      {view && (
        <Modal title="Invitation message" wide onClose={() => setView(null)}>
          <div className="screening-outreach-review">
            <p>To: {view.to}</p>
            <p>
              {view.mode === "outbox"
                ? "Local outbox preview — no email delivered."
                : "Approved invitation content. Delivery state appears in history."}
            </p>
            <h3>{view.subject}</h3>
            <pre>{view.text}</pre>
          </div>
        </Modal>
      )}
      {cancel && (
        <Modal
          title="Cancel this invitation?"
          onClose={() => {
            if (!busy) setCancel(null);
          }}
        >
          <p>
            Cancel pending reminders for {cancel.name} and revoke their
            candidate link. A message already accepted by the email provider may
            still arrive.
          </p>
          <Button
            disabled={busy}
            onClick={() =>
              work(async () => {
                await api(
                  `${prefix}/invitations/${cancel.id}/cancel`,
                  json("POST", { confirmed: true }),
                );
                setCancel(null);
                await load();
              })
            }
          >
            Confirm cancellation
          </Button>
        </Modal>
      )}
    </section>
  );
}
