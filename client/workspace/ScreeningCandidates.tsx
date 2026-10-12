import { useEffect, useState } from "react";
import { Download, RefreshCw, Search, X } from "lucide-react";
import "./screening-candidates.css";

type Status = "unreviewed" | "reviewed" | "progressed" | "rejected";
type Review = {
  responseId: string;
  status: Status;
  notes: string;
  revision: number;
  updatedAt: string;
  reviewer: { name: string };
};
type Answer = {
  questionId: string;
  prompt: string;
  value: string;
  voiceEvidence?: {
    durationMs: number;
    originalTranscript: string;
    candidateEdited: boolean;
  };
};
type Candidate = {
  id: string;
  candidateName: string;
  email: string;
  submittedAt: string;
  consentAt: string;
  answers: Answer[];
};
type Publication = {
  id: string;
  createdAt: string;
  expiresAt: string;
  status: string;
};
const labels: Record<Status, string> = {
  unreviewed: "Unreviewed",
  reviewed: "Reviewed",
  progressed: "Progressed",
  rejected: "Rejected",
};
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    credentials: "include",
    ...init,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      typeof data.error === "string"
        ? data.error
        : "The request could not be completed.",
    );
  return data;
}
const csvCell = (value: string) =>
  `"${(/^[=+@\-\t\r]/.test(value) ? "'" : "") + value.replaceAll('"', '""')}"`;

export default function ScreeningCandidates({
  item,
  onPublish,
  onDirty,
}: {
  item: { id: string };
  onPublish?: () => void;
  onDirty?: (dirty: boolean) => void;
}) {
  const [candidates, setCandidates] = useState<Candidate[]>([]),
    [reviews, setReviews] = useState<Review[]>([]),
    [links, setLinks] = useState<Publication[]>([]);
  const [tab, setTab] = useState<Status | "all" | "links">("unreviewed"),
    [search, setSearch] = useState(""),
    [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [refresh, setRefresh] = useState(0),
    [dirty, setDirty] = useState(false),
    [revoking, setRevoking] = useState("");
  const [linkBusy, setLinkBusy] = useState(false);
  const path = `screenings/${encodeURIComponent(item.id)}`;
  useEffect(() => {
    onDirty?.(dirty);
  }, [dirty, onDirty]);
  useEffect(() => () => onDirty?.(false), [onDirty]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    Promise.all([
      request<{ items: Candidate[]; publications: Publication[] }>(
        `${path}/responses`,
        { signal: controller.signal },
      ),
      request<{ items: Review[] }>(`${path}/reviews`, {
        signal: controller.signal,
      }),
    ])
      .then(([responses, review]) => {
        if (controller.signal.aborted) return;
        setCandidates(responses.items);
        setLinks(responses.publications);
        setReviews(review.items);
        setError("");
      })
      .catch((cause: Error) => {
        if (!controller.signal.aborted) setError(cause.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [path, refresh]);
  const status = (id: string) =>
    reviews.find((review) => review.responseId === id)?.status || "unreviewed";
  const visible = candidates.filter(
    (candidate) =>
      (tab === "all" || tab === status(candidate.id)) &&
      `${candidate.candidateName} ${candidate.email}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const candidate = candidates.find((record) => record.id === selected);
  function download() {
    const lines = [
      ["Applicant", "Email", "Submitted", "Review status"],
      ...visible.map((row) => [
        row.candidateName,
        row.email,
        row.submittedAt,
        labels[status(row.id)],
      ]),
    ];
    const url = URL.createObjectURL(
      new Blob(
        [lines.map((line) => line.map(csvCell).join(",")).join("\r\n")],
        { type: "text/csv;charset=utf-8" },
      ),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "arkoffer-screening-candidates.csv";
    link.click();
    URL.revokeObjectURL(url);
  }
  return (
    <section className="screening-candidates" aria-label="Screening candidates">
      <div className="screening-candidate-toolbar">
        <div role="tablist" aria-label="Candidate stages">
          {(
            [
              "all",
              "unreviewed",
              "reviewed",
              "progressed",
              "rejected",
              "links",
            ] as const
          ).map((value) => (
            <button
              key={value}
              role="tab"
              aria-selected={tab === value}
              disabled={dirty && value === "links"}
              onClick={() => setTab(value)}
            >
              {value === "all"
                ? "All candidates"
                : value === "links"
                  ? "Candidate links"
                  : labels[value]}{" "}
              <span>
                {value === "all"
                  ? candidates.length
                  : value === "links"
                    ? links.length
                    : candidates.filter((record) => status(record.id) === value)
                        .length}
              </span>
            </button>
          ))}
        </div>
        <div className="screening-candidate-actions">
          <label className="screening-candidate-search">
            <Search size={15} />
            <input
              aria-label="Search screening candidates"
              placeholder="Search candidates"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <button
            type="button"
            disabled={loading || dirty}
            onClick={() => setRefresh((value) => value + 1)}
            aria-label="Refresh candidates"
          >
            <RefreshCw size={16} />
          </button>
          {tab !== "links" && (
            <button
              type="button"
              onClick={download}
              disabled={!visible.length}
              aria-label="Download candidate table"
            >
              <Download size={16} />
            </button>
          )}
        </div>
      </div>
      {error && (
        <p role="alert" className="screening-candidate-error">
          {error}
        </p>
      )}
      {loading ? (
        <p role="status">Loading candidates…</p>
      ) : tab === "links" ? (
        <>
          <div className="screening-candidate-explainer">
            <p>
              Each link accepts one response. Candidate identities appear after
              submission.
            </p>
            {onPublish && (
              <button onClick={onPublish}>Create candidate link</button>
            )}
          </div>
          <div className="screening-candidate-table">
            <table>
              <thead>
                <tr>
                  <th>Candidate link</th>
                  <th>Created</th>
                  <th>Deadline</th>
                  <th>Status</th>
                  <th>Access</th>
                </tr>
              </thead>
              <tbody>
                {links.map((link, index) => (
                  <tr key={link.id}>
                    <td>Link {links.length - index}</td>
                    <td>{new Date(link.createdAt).toLocaleString()}</td>
                    <td>{new Date(link.expiresAt).toLocaleString()}</td>
                    <td>{link.status}</td>
                    <td>
                      {["active", "completed"].includes(link.status) && (
                        <button onClick={() => setRevoking(link.id)}>
                          Revoke link
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!links.length && (
            <div className="screening-candidate-empty">
              <h3>No candidate links yet</h3>
              <p>Preview your screening, then create a link for a candidate.</p>
            </div>
          )}
          {revoking && (
            <div className="screening-candidate-confirm" role="alert">
              <p>
                Revoke this link? It will stop opening. Submitted responses
                remain available to your team.
              </p>
              <button disabled={linkBusy} onClick={() => setRevoking("")}>
                Cancel
              </button>
              <button
                disabled={linkBusy}
                onClick={async () => {
                  setLinkBusy(true);
                  setError("");
                  try {
                    await request(
                      `${path}/publications/${encodeURIComponent(revoking)}`,
                      { method: "DELETE" },
                    );
                    setLinks((previous) =>
                      previous.map((link) =>
                        link.id === revoking
                          ? { ...link, status: "revoked" }
                          : link,
                      ),
                    );
                    setRevoking("");
                  } catch (cause) {
                    setError((cause as Error).message);
                  } finally {
                    setLinkBusy(false);
                  }
                }}
              >
                Confirm revoke
              </button>
            </div>
          )}
        </>
      ) : (
        <div
          className={`screening-candidate-content ${candidate ? "with-review" : ""}`}
        >
          <div>
            <div className="screening-candidate-table">
              <table>
                <thead>
                  <tr>
                    <th>Applicant</th>
                    <th>Email</th>
                    <th>Submitted</th>
                    <th>Review status</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((record) => (
                    <tr
                      key={record.id}
                      className={selected === record.id ? "selected" : ""}
                    >
                      <td>
                        <button
                          disabled={dirty && selected !== record.id}
                          onClick={() => setSelected(record.id)}
                        >
                          {record.candidateName}
                        </button>
                      </td>
                      <td>{record.email}</td>
                      <td>{new Date(record.submittedAt).toLocaleString()}</td>
                      <td>
                        <span
                          className={`candidate-stage ${status(record.id)}`}
                        >
                          {labels[status(record.id)]}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!visible.length && (
              <div className="screening-candidate-empty">
                <h3>
                  {search
                    ? "No matching candidates"
                    : "No candidates in this view"}
                </h3>
                <p>Completed responses appear here for your team to review.</p>
                {onPublish && !candidates.length && (
                  <button onClick={onPublish}>Create candidate link</button>
                )}
              </div>
            )}
          </div>
          {candidate && (
            <ReviewPanel
              key={`${candidate.id}:${reviews.find((review) => review.responseId === candidate.id)?.revision || 0}`}
              candidate={candidate}
              review={reviews.find(
                (review) => review.responseId === candidate.id,
              )}
              path={path}
              onDirty={setDirty}
              onClose={() => {
                setSelected("");
                setDirty(false);
              }}
              onSave={(review) => {
                setReviews((previous) => [
                  ...previous.filter(
                    (entry) => entry.responseId !== review.responseId,
                  ),
                  review,
                ]);
                setDirty(false);
              }}
            />
          )}
        </div>
      )}
    </section>
  );
}

function ReviewPanel({
  candidate,
  review,
  path,
  onSave,
  onDirty,
  onClose,
}: {
  candidate: Candidate;
  review?: Review;
  path: string;
  onSave: (review: Review) => void;
  onDirty: (dirty: boolean) => void;
  onClose: () => void;
}) {
  const [notes, setNotes] = useState(review?.notes || ""),
    [status, setStatus] = useState<Status>(review?.status || "unreviewed"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const dirty =
    notes !== (review?.notes || "") ||
    status !== (review?.status || "unreviewed");
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  return (
    <aside
      className="screening-response-review"
      aria-label={`Review ${candidate.candidateName}`}
    >
      <header>
        <div>
          <h3>{candidate.candidateName}</h3>
          <small>{candidate.email}</small>
        </div>
        <button
          disabled={dirty || busy}
          aria-label="Close candidate review"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      <p className="screening-candidate-muted">
        Shared responses and reviewer notes are visible to your hiring team.
      </p>
      {candidate.answers.map((answer, index) => (
        <article key={answer.questionId}>
          <h4>
            {index + 1}. {answer.prompt}
          </h4>
          <p>{answer.value || "No answer provided (optional)."}</p>
          {answer.voiceEvidence && (
            <details>
              <summary>
                Voice transcript ·{" "}
                {Math.round(answer.voiceEvidence.durationMs / 1000)} seconds
                {answer.voiceEvidence.candidateEdited
                  ? " · candidate corrected"
                  : ""}
              </summary>
              <p>{answer.voiceEvidence.originalTranscript}</p>
            </details>
          )}
        </article>
      ))}
      <p className="screening-candidate-muted">
        Candidate consented on {new Date(candidate.consentAt).toLocaleString()}.
      </p>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          try {
            const result = await request<{ item: Review }>(
              `${path}/responses/${encodeURIComponent(candidate.id)}/review`,
              {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  status,
                  notes,
                  revision: review?.revision || 0,
                }),
              },
            );
            onSave(result.item);
          } catch (cause) {
            setError((cause as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <fieldset disabled={busy}>
          <legend>Your review</legend>
          <label>
            Review status
            <select
              aria-label="Review status"
              value={status}
              onChange={(event) => setStatus(event.target.value as Status)}
            >
              {Object.entries(labels).map(([value, label]) => (
                <option value={value} key={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Reviewer notes
            <textarea
              aria-label="Reviewer notes"
              maxLength={10_000}
              rows={5}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </label>
          <p className="screening-candidate-muted">
            Choose the outcome yourself. Saving does not send a message or
            update an ATS.
          </p>
          {error && (
            <p role="alert" className="screening-candidate-error">
              {error}
            </p>
          )}
          <div className="screening-candidate-actions">
            <button type="submit" disabled={!dirty}>
              Save review
            </button>
            {dirty && (
              <button
                type="button"
                onClick={() => {
                  setNotes(review?.notes || "");
                  setStatus(review?.status || "unreviewed");
                }}
              >
                Discard edits
              </button>
            )}
          </div>
        </fieldset>
      </form>
      {review && (
        <p role="status" className="screening-candidate-muted">
          Saved by {review.reviewer.name} ·{" "}
          {new Date(review.updatedAt).toLocaleString()}
        </p>
      )}
    </aside>
  );
}
