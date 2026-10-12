import { useEffect, useRef, useState } from "react";
import "./application-review.css";
import ApplicationDocuments, {
  type DocumentReference,
} from "./ApplicationDocuments";

type Item = { id: string; [key: string]: unknown };
type Criterion = {
  id: string;
  text: string;
  importance: "required" | "preferred";
};
type Run = {
  id: string;
  status: string;
  createdAt: string;
  notes?: string;
  reviewedAt?: string | null;
  error?: string;
  output?: {
    criteria: {
      criterionId: string;
      evidence: { sourceId: string; quote: string }[];
      missingInformation: string;
      followUp: string;
    }[];
    approvedCriteria: Criterion[];
    sources: { id: string; title: string; text: string }[];
    provider: string;
    model: string;
  } | null;
};
type State = {
  jobId: string | null;
  criteria: { revision: number; criteria: Criterion[] };
  candidateEvidence: string;
  sources: { id: string; title: string; characters: number }[];
  items: Run[];
  setup: { enabled: boolean };
};
type Draft = {
  id: string;
  status: string;
  output?: { criteria: Criterion[] };
  error?: string;
};
async function request<T>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    signal,
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok)
    throw Object.assign(
      new Error(value.error || "Unable to load application review."),
      { status: response.status },
    );
  return value;
}

export default function ApplicationReview({
  applications,
}: {
  applications: Item[];
}) {
  const [selected, setSelected] = useState("");
  const id = applications.some((app) => app.id === selected)
    ? selected
    : applications[0]?.id || "";
  return (
    <section
      className="application-review business-panel"
      aria-labelledby="application-review-heading"
    >
      <div className="application-review-heading">
        <h3 id="application-review-heading">Application evidence review</h3>
        <p>
          Compare selected evidence with approved job criteria. Every result
          needs your review before a hiring decision.
        </p>
      </div>
      {!applications.length ? (
        <p>Add an application to start an evidence review.</p>
      ) : (
        <>
          <label className="application-review-field">
            Application to analyze
            <select value={id} onChange={(e) => setSelected(e.target.value)}>
              {applications.map((app) => (
                <option key={app.id} value={app.id}>
                  {String(app.name || app.title || "Unnamed applicant")} ·{" "}
                  {String(app.jobTitle || "Application")}
                </option>
              ))}
            </select>
          </label>
          <ReviewEditor key={id} id={id} />
        </>
      )}
    </section>
  );
}
function ReviewEditor({ id }: { id: string }) {
  const path = `/api/applications/${encodeURIComponent(id)}/review-assistance`;
  const [state, setState] = useState<State | null>(null),
    [criteria, setCriteria] = useState<Criterion[]>([]),
    [dirty, setDirty] = useState(false);
  const [sources, setSources] = useState<string[]>([]),
    [documents, setDocuments] = useState<DocumentReference[]>([]),
    [documentBusy, setDocumentBusy] = useState(false),
    [consent, setConsent] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const [selectedRun, setSelectedRun] = useState(""),
    [drafts, setDrafts] = useState<Draft[]>([]);
  const requestKeys = useRef(new Map<string, string>());
  async function generate<T>(url: string, body: Record<string, unknown>) {
    const scope = JSON.stringify({ url, body });
    const key = requestKeys.current.get(scope) || crypto.randomUUID();
    requestKeys.current.set(scope, key);
    try {
      const response = await request<{ item: T & { status: string } }>(
        url,
        "POST",
        { ...body, requestId: key },
      );
      if (response.item.status !== "running") requestKeys.current.delete(scope);
      return response;
    } catch (cause) {
      // A network failure may hide a successful paid request: reuse its key.
      if (cause instanceof Error && "status" in cause)
        requestKeys.current.delete(scope);
      throw cause;
    }
  }
  async function load(signal?: AbortSignal) {
    const next = await request<State>(path, "GET", undefined, signal);
    if (signal?.aborted) return;
    setState(next);
    setCriteria(next.criteria.criteria);
    setDirty(false);
    setSelectedRun((current) =>
      next.items.some((run) => run.id === current)
        ? current
        : next.items[0]?.id || "",
    );
    if (next.jobId) {
      const job = await request<{ drafts: Draft[] }>(
        `/api/jobs/${next.jobId}/review-criteria`,
        "GET",
        undefined,
        signal,
      );
      if (!signal?.aborted)
        setDrafts(job.drafts.filter((draft) => draft.status === "complete"));
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).catch((cause) => {
      if (!controller.signal.aborted) setError(cause.message);
    });
    return () => controller.abort();
  }, [id]);
  async function action(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Review request failed.",
      );
    } finally {
      setBusy(false);
    }
  }
  const run = state?.items.find((item) => item.id === selectedRun);
  return (
    <>
      {error && (
        <p role="alert" className="application-review-error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {!state ? (
        <p>Loading evidence review…</p>
      ) : (
        <>
          {!state.setup.enabled && (
            <p className="application-review-notice">
              AI application review is unavailable. A workspace administrator
              needs to configure text AI and enable this workspace. You can
              still approve job criteria and inspect saved reviews.
            </p>
          )}
          {!state.jobId ? (
            <p>
              Assign this application to a job before setting review criteria.
            </p>
          ) : (
            <>
              <fieldset disabled={busy} className="application-review-criteria">
                <legend>1. Approve job criteria</legend>
                <p>
                  These criteria are shared with your workspace for this job.
                  Use only relevant professional requirements. Keep private
                  feedback in your review notes below.
                </p>
                {criteria.map((criterion, index) => (
                  <div
                    className="application-review-criterion"
                    key={criterion.id}
                  >
                    <label className="application-review-field">
                      Criterion {index + 1}
                      <textarea
                        value={criterion.text}
                        rows={2}
                        maxLength={600}
                        onChange={(e) => {
                          setCriteria((current) =>
                            current.map((c) =>
                              c.id === criterion.id
                                ? { ...c, text: e.target.value }
                                : c,
                            ),
                          );
                          setDirty(true);
                        }}
                      />
                    </label>
                    <label className="application-review-field">
                      Importance
                      <select
                        value={criterion.importance}
                        onChange={(e) => {
                          setCriteria((current) =>
                            current.map((c) =>
                              c.id === criterion.id
                                ? {
                                    ...c,
                                    importance: e.target
                                      .value as Criterion["importance"],
                                  }
                                : c,
                            ),
                          );
                          setDirty(true);
                        }}
                      >
                        <option value="required">Required</option>
                        <option value="preferred">Preferred</option>
                      </select>
                    </label>
                    <button
                      type="button"
                      className="business-button secondary"
                      aria-label={`Remove criterion ${index + 1}`}
                      onClick={() => {
                        setCriteria((current) =>
                          current.filter((c) => c.id !== criterion.id),
                        );
                        setDirty(true);
                      }}
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <div className="application-review-actions">
                  <button
                    type="button"
                    className="business-button secondary"
                    disabled={criteria.length >= 10}
                    onClick={() => {
                      setCriteria((current) => [
                        ...current,
                        {
                          id: crypto.randomUUID(),
                          text: "",
                          importance: "required",
                        },
                      ]);
                      setDirty(true);
                    }}
                  >
                    Add criterion
                  </button>
                  <button
                    type="button"
                    className="business-button secondary"
                    disabled={!state.setup.enabled}
                    onClick={() =>
                      void action(async () => {
                        const response = await generate<Draft>(
                          `/api/jobs/${state.jobId}/review-criteria/draft`,
                          { revision: state.criteria.revision },
                        );
                        if (
                          response.item.status !== "complete" ||
                          !response.item.output
                        )
                          throw new Error(
                            response.item.error ||
                              "Criteria draft is still processing. Reload to check it.",
                          );
                        setCriteria(response.item.output.criteria);
                        setDirty(true);
                        setMessage(
                          "AI criteria draft loaded. Review and edit every criterion, then approve it before analysis.",
                        );
                      })
                    }
                  >
                    Draft criteria with AI
                  </button>
                  <button
                    type="button"
                    className="business-button"
                    disabled={
                      !criteria.length ||
                      criteria.some((c) => !c.text.trim()) ||
                      (!dirty && state.criteria.revision > 0)
                    }
                    onClick={() =>
                      void action(async () => {
                        await request(
                          `/api/jobs/${state.jobId}/review-criteria`,
                          "PUT",
                          {
                            revision: state.criteria.revision,
                            criteria,
                            approved: true,
                          },
                        );
                        await load();
                        setMessage(
                          "Criteria approved for this job. Previous reviews become stale when criteria change.",
                        );
                      })
                    }
                  >
                    Approve criteria for this job
                  </button>
                </div>
                {!!drafts.length && (
                  <label className="application-review-field">
                    Recover a saved AI draft
                    <select
                      defaultValue=""
                      onChange={(e) => {
                        const draft = drafts.find(
                          (d) => d.id === e.target.value,
                        );
                        if (draft?.output) {
                          setCriteria(draft.output.criteria);
                          setDirty(true);
                        }
                      }}
                    >
                      <option value="">Choose a draft to review</option>
                      {drafts.map((draft, index) => (
                        <option value={draft.id} key={draft.id}>
                          Draft {index + 1}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <p className="application-review-muted">
                  {dirty
                    ? "Unsaved draft — approve these criteria before analyzing."
                    : state.criteria.revision
                      ? `Approved criteria · revision ${state.criteria.revision}`
                      : "No criteria approved yet."}
                </p>
              </fieldset>
              <fieldset disabled={busy} className="application-review-sources">
                <legend>2. Choose evidence</legend>
                {state.candidateEvidence ? (
                  <details>
                    <summary>
                      Linked candidate professional fields included
                    </summary>
                    <pre>{state.candidateEvidence}</pre>
                  </details>
                ) : (
                  <p>
                    No linked candidate professional fields are available.
                    Select a CV or transcript containing the candidate’s
                    relevant evidence.
                  </p>
                )}
                <ApplicationDocuments
                  applicationId={id}
                  selected={documents}
                  disabled={busy}
                  onBusy={setDocumentBusy}
                  onChange={(next) => {
                    setDocuments(next);
                    setConsent(false);
                  }}
                  onDeleted={async () => {
                    // Hide cached output immediately; the server recomputes source access.
                    setState((current) =>
                      current ? { ...current, items: [] } : current,
                    );
                    const next = await request<State>(path);
                    setState(next);
                  }}
                />
                <p>
                  Select up to 5 transcripts you have verified belong to this
                  application. Nothing is matched by name. Combined evidence is
                  limited to 60,000 characters.
                </p>
                {!state.sources.length ? (
                  <p>No accessible transcripts are available.</p>
                ) : (
                  <div className="application-review-picker">
                    {state.sources.map((source) => (
                      <label key={source.id}>
                        <input
                          type="checkbox"
                          checked={sources.includes(source.id)}
                          disabled={
                            !sources.includes(source.id) && sources.length >= 5
                          }
                          onChange={(e) => {
                            setSources((current) =>
                              e.target.checked
                                ? [...current, source.id]
                                : current.filter(
                                    (value) => value !== source.id,
                                  ),
                            );
                            setConsent(false);
                          }}
                        />
                        <span>
                          {source.title}
                          <small>
                            {source.characters.toLocaleString()} characters
                          </small>
                        </span>
                      </label>
                    ))}
                  </div>
                )}
                <label className="application-review-check">
                  <input
                    type="checkbox"
                    checked={consent}
                    disabled={documentBusy}
                    onChange={(e) => setConsent(e.target.checked)}
                  />
                  I verified these sources belong to this application and agree
                  to send the selected evidence to the configured AI provider.
                </label>
                <button
                  type="button"
                  className="business-button"
                  disabled={
                    !state.setup.enabled ||
                    documentBusy ||
                    !consent ||
                    dirty ||
                    !state.criteria.revision ||
                    (!sources.length &&
                      !documents.length &&
                      !state.candidateEvidence)
                  }
                  onClick={() =>
                    void action(async () => {
                      const response = await generate<Run>(path, {
                        criteriaRevision: state.criteria.revision,
                        conversationIds: sources,
                        ...(documents.length ? { documents } : {}),
                        consent: true,
                      });
                      await load();
                      setSelectedRun(response.item.id);
                      if (response.item.status !== "complete")
                        throw new Error(
                          response.item.error ||
                            "Review is still processing. Reload to check its status.",
                        );
                      setMessage(
                        "Review generated. Inspect every criterion and source before making your own decision.",
                      );
                    })
                  }
                >
                  {busy ? "Working…" : "Analyze selected evidence"}
                </button>
              </fieldset>
            </>
          )}
          <div className="application-review-history">
            <h4>3. Inspect your private reviews</h4>
            <p>
              AI output and these notes are private to you. Missing evidence is
              a follow-up prompt, not a negative decision.
            </p>
            <button
              type="button"
              className="business-button secondary"
              disabled={busy}
              onClick={() => void action(() => load())}
            >
              Reload reviews and criteria
            </button>
            {!!state.items.length && (
              <label className="application-review-field">
                Saved evidence review
                <select
                  value={selectedRun}
                  onChange={(e) => setSelectedRun(e.target.value)}
                >
                  {state.items.map((item) => (
                    <option value={item.id} key={item.id}>
                      {new Date(item.createdAt).toLocaleString()} ·{" "}
                      {item.status}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {run && (
              <SavedReview
                key={`${run.id}:${run.status}`}
                run={run}
                busy={busy}
                save={(notes, reviewed) =>
                  action(async () => {
                    await request(`${path}/${run.id}`, "PATCH", {
                      notes,
                      reviewed,
                    });
                    await load();
                    setMessage(
                      "Your private review notes were saved. Application status is unchanged.",
                    );
                  })
                }
              />
            )}
            {!state.items.length && <p>No evidence reviews yet.</p>}
          </div>
        </>
      )}
    </>
  );
}
function SavedReview({
  run,
  busy,
  save,
}: {
  run: Run;
  busy: boolean;
  save: (notes: string, reviewed: boolean) => Promise<void>;
}) {
  const [notes, setNotes] = useState(run.notes || ""),
    [reviewed, setReviewed] = useState(Boolean(run.reviewedAt));
  if (run.status !== "complete" || !run.output)
    return (
      <p>{run.error || `Review ${run.status}. Reload to check its status.`}</p>
    );
  const output = run.output;
  return (
    <div className="application-review-result">
      <p className="application-review-muted">
        Generated with {output.provider} / {output.model}. Verify all statements
        against their sources.
      </p>
      {output.approvedCriteria.map((criterion) => {
        const result = output.criteria.find(
          (c) => c.criterionId === criterion.id,
        );
        if (!result) return null;
        return (
          <article key={criterion.id}>
            <h4>
              {criterion.text} <span>{criterion.importance}</span>
            </h4>
            <p>
              {result.evidence.length
                ? "Supporting source excerpts"
                : "No supporting evidence found in these sources"}
            </p>
            {result.evidence.map((evidence, index) => {
              const source = output.sources.find(
                (s) => s.id === evidence.sourceId,
              );
              return (
                <div key={index}>
                  <blockquote>{evidence.quote}</blockquote>
                  <details>
                    <summary>
                      Inspect source: {source?.title || "Source"}
                    </summary>
                    <pre>{source?.text}</pre>
                  </details>
                </div>
              );
            })}
            {result.missingInformation && (
              <p>
                <strong>Information to clarify: </strong>
                {result.missingInformation}
              </p>
            )}
            {result.followUp && (
              <p>
                <strong>Suggested follow-up: </strong>
                {result.followUp}
              </p>
            )}
          </article>
        );
      })}
      <label className="application-review-field">
        Your private reviewer notes
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={4}
          maxLength={10000}
        />
      </label>
      <label className="application-review-check">
        <input
          type="checkbox"
          checked={reviewed}
          onChange={(e) => setReviewed(e.target.checked)}
        />
        I inspected every criterion and the source evidence. Hiring decisions
        remain mine.
      </label>
      <button
        type="button"
        className="business-button"
        disabled={busy}
        onClick={() => void save(notes, reviewed)}
      >
        Save private review notes
      </button>
      {run.reviewedAt && (
        <p className="application-review-muted">
          Review acknowledged {new Date(run.reviewedAt).toLocaleString()}.
        </p>
      )}
    </div>
  );
}
