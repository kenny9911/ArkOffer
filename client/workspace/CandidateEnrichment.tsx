import { useEffect, useRef, useState } from "react";
import { RefreshCw, SearchCheck } from "lucide-react";
import "./enrichment.css";

type Candidate = { id: string; [key: string]: unknown };
type Identifier = "profile" | "workEmail" | "nameCompany";
type Diff = {
  field: string;
  before: unknown;
  proposed: unknown;
  conflict: boolean;
};
type Run = {
  id: string;
  status: string;
  identifier: Identifier;
  createdAt: string;
  completedAt: string | null;
  appliedAt: string | null;
  appliedFields: string[];
  error: string | null;
  candidateVersion: string;
  identityChanged: boolean;
  diff: Diff[];
  provenance: {
    providerName?: string;
    likelihood?: number;
    matched?: string[];
    identity?: {
      name?: string;
      company?: string;
      role?: string;
      profile?: string;
    };
  };
};
type State = {
  setup: {
    configured: boolean;
    canManage: boolean;
    missing: string[];
    workspaceId: string;
  };
  candidateVersion: string;
  identifiers: {
    id: Identifier;
    available: boolean;
    inputs: Record<string, string>;
  }[];
  items: Run[];
};
const names: Record<string, string> = {
  name: "Name",
  role: "Current role",
  company: "Company",
  skills: "Skills",
  profile: "Professional profile",
  workEmail: "Work email",
  workHistory: "Work history",
  nameCompany: "Full name and company",
};
const statuses: Record<string, string> = {
  running: "Lookup in progress",
  proposed: "Ready for review",
  applied: "Selected fields applied",
  no_match: "No matching profile",
  failed: "Provider declined lookup",
  uncertain: "Outcome uncertain",
  stale: "Candidate changed during lookup",
  abandoned: "Lookup abandoned",
};
function format(value: unknown): string {
  if (value == null || value === "") return "Not set";
  if (Array.isArray(value))
    return value
      .map((item) =>
        typeof item === "object" && item
          ? `${item.role || ""} · ${item.company || ""} (${item.startDate || "unknown"}–${item.endDate || "present / unknown"})`
          : String(item),
      )
      .join("\n");
  return typeof value === "string" ? value : JSON.stringify(value);
}
async function request<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    signal,
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || "Unable to complete enrichment.");
  return data;
}

export default function CandidateEnrichment({
  candidate,
  onApplied,
}: {
  candidate: Candidate;
  onApplied: (item: Candidate) => void;
}) {
  const [state, setState] = useState<State | null>(null),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false),
    [identifier, setIdentifier] = useState<Identifier>("profile"),
    [consent, setConsent] = useState(false),
    [retry, setRetry] = useState(false),
    [confirmed, setConfirmed] = useState(false);
  const [selectedRun, setSelectedRun] = useState(""),
    [selectedFields, setSelectedFields] = useState<string[]>([]);
  const requestKey = useRef(crypto.randomUUID()),
    mounted = useRef(false);
  const activeCandidate = useRef(candidate.id);
  activeCandidate.current = candidate.id;
  const active = () =>
    mounted.current && activeCandidate.current === candidate.id;
  const path = `/api/candidates/${encodeURIComponent(candidate.id)}/enrichment`;
  async function load(signal?: AbortSignal) {
    const result = await request<State>(path, undefined, signal);
    if (active()) {
      setState(result);
      setSelectedRun((current) =>
        result.items.some((item) => item.id === current)
          ? current
          : result.items[0]?.id || "",
      );
    }
    return result;
  }
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    setState(null);
    setBusy(false);
    setError("");
    setMessage("");
    setConsent(false);
    setRetry(false);
    setConfirmed(false);
    setSelectedFields([]);
    setSelectedRun("");
    requestKey.current = crypto.randomUUID();
    void load(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted)
          setIdentifier(
            result.identifiers.find((item) => item.available)?.id || "profile",
          );
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause.message);
      });
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [candidate.id]);
  const run = state?.items.find((item) => item.id === selectedRun),
    input = state?.identifiers.find((item) => item.id === identifier);
  const previous = state?.items.find((item) => item.identifier === identifier);
  async function lookup() {
    if (!state || busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await request<{ item: Run; reused: boolean }>(path, {
        requestKey: requestKey.current,
        candidateVersion: state.candidateVersion,
        identifier,
        consent: true,
        ...(retry && previous
          ? { retryOf: previous.id, retryConfirmed: true }
          : {}),
      });
      if (!active()) return;
      requestKey.current = crypto.randomUUID();
      setSelectedRun(result.item.id);
      setSelectedFields([]);
      setConfirmed(false);
      setConsent(false);
      setRetry(false);
      setMessage(
        result.reused
          ? "Showing the existing lookup. No new provider request was made."
          : "Lookup recorded. Review the result before applying any fields.",
      );
      await load();
    } catch (cause) {
      if (active()) {
        setError((cause as Error).message);
        await load().catch(() => {});
      }
    } finally {
      if (active()) setBusy(false);
    }
  }
  async function apply() {
    if (!run || busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await request<{ item: Candidate }>(
        `${path}/${encodeURIComponent(run.id)}/apply`,
        {
          candidateVersion: run.candidateVersion,
          fields: selectedFields,
          confirm: true,
        },
      );
      if (!active()) return;
      onApplied(result.item);
      setMessage(
        `Applied ${selectedFields.length} selected professional fields.`,
      );
      setSelectedFields([]);
      setConfirmed(false);
      await load();
    } catch (cause) {
      if (active()) {
        setError((cause as Error).message);
        setSelectedFields([]);
        setConfirmed(false);
        await load().catch(() => {});
      }
    } finally {
      if (active()) setBusy(false);
    }
  }
  return (
    <section className="candidate-enrichment" aria-label="Candidate enrichment">
      <div className="enrichment-heading">
        <h3>
          <SearchCheck size={18} /> Professional enrichment
        </h3>
        <button
          type="button"
          className="business-button secondary"
          disabled={busy}
          aria-label="Refresh enrichment history"
          onClick={() => {
            setError("");
            setSelectedFields([]);
            setConfirmed(false);
            void load().catch((cause) => setError(cause.message));
          }}
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </div>
      <p>
        Look up this candidate through People Data Labs, then review each
        proposed change. Provider matches can be inaccurate or outdated; they
        are not independently verified.
      </p>
      {error && (
        <div className="business-alert" role="alert">
          {error}
        </div>
      )}
      {message && (
        <div className="enrichment-message" role="status">
          {message}
        </div>
      )}
      {!state ? (
        !error && <p role="status">Loading enrichment…</p>
      ) : (
        <>
          {!state.setup.configured && (
            <div className="enrichment-setup">
              <strong>Provider setup required</strong>
              <p>
                Ask the server administrator to configure{" "}
                {state.setup.missing.join(" and ")}. No lookup is available yet.
              </p>
              <small>Workspace ID: {state.setup.workspaceId}</small>
            </div>
          )}
          {!state.setup.canManage && (
            <p>
              Only workspace owners and admins can run lookups or apply changes.
              You can review this candidate’s history.
            </p>
          )}
          {state.setup.canManage && (
            <fieldset className="enrichment-lookup" disabled={busy}>
              <label htmlFor={`enrichment-identifier-${candidate.id}`}>
                Use candidate-provided information
              </label>
              <select
                id={`enrichment-identifier-${candidate.id}`}
                value={identifier}
                onChange={(event) => {
                  setIdentifier(event.target.value as Identifier);
                  setConsent(false);
                  setRetry(false);
                  requestKey.current = crypto.randomUUID();
                }}
              >
                {state.identifiers.map((item) => (
                  <option
                    key={item.id}
                    value={item.id}
                    disabled={!item.available}
                  >
                    {names[item.id]}
                    {item.available ? "" : " — add to candidate first"}
                  </option>
                ))}
              </select>
              {input?.available ? (
                <dl className="enrichment-inputs">
                  {Object.entries(input.inputs).map(([key, value]) => (
                    <div key={key}>
                      <dt>
                        {names[key] || (key === "email" ? "Work email" : key)}
                      </dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p>
                  Add a public LinkedIn profile, work email, or full name and
                  company to the candidate first.
                </p>
              )}
              <label className="enrichment-check">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(event) => setConsent(event.target.checked)}
                />
                <span>
                  I confirm this candidate supplied these professional
                  identifiers and authorize sending them to People Data Labs for
                  this lookup. A provider credit may be consumed.
                </span>
              </label>
              {previous && (
                <label className="enrichment-check">
                  <input
                    type="checkbox"
                    checked={retry}
                    onChange={(event) => {
                      setRetry(event.target.checked);
                      requestKey.current = crypto.randomUUID();
                    }}
                    disabled={previous.status === "running"}
                  />
                  <span>
                    Run another paid attempt. I reviewed the previous outcome
                    and provider usage; another credit may be consumed even if
                    the earlier outcome was uncertain.
                  </span>
                </label>
              )}
              <button
                type="button"
                className="business-button"
                disabled={
                  busy ||
                  !state.setup.configured ||
                  !input?.available ||
                  !consent
                }
                onClick={() => void lookup()}
              >
                {busy
                  ? "Working…"
                  : retry
                    ? "Run another paid lookup"
                    : previous
                      ? "Review existing lookup"
                      : "Look up professional profile"}
              </button>
            </fieldset>
          )}
          {state.items.length > 0 && (
            <div className="enrichment-history">
              <label htmlFor={`enrichment-history-${candidate.id}`}>
                Lookup history
              </label>
              <select
                id={`enrichment-history-${candidate.id}`}
                value={selectedRun}
                onChange={(event) => {
                  setSelectedRun(event.target.value);
                  setSelectedFields([]);
                  setConfirmed(false);
                }}
              >
                {state.items.map((item) => (
                  <option key={item.id} value={item.id}>
                    {new Date(item.createdAt).toLocaleString()} —{" "}
                    {statuses[item.status] || item.status}
                  </option>
                ))}
              </select>
            </div>
          )}
          {run && (
            <div className="enrichment-review">
              <h4>{statuses[run.status] || run.status}</h4>
              {run.error && (
                <p role={run.status === "uncertain" ? "alert" : undefined}>
                  {run.error}
                </p>
              )}
              {run.provenance.identity && (
                <div className="enrichment-match">
                  <strong>{run.provenance.identity.name}</strong>
                  <span>
                    {[
                      run.provenance.identity.role,
                      run.provenance.identity.company,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  <span>
                    Source: {run.provenance.providerName} · Match confidence:{" "}
                    {run.provenance.likelihood}/10
                  </span>
                  <span>
                    Matched input fields:{" "}
                    {run.provenance.matched?.join(", ") || "Not provided"}. This
                    score is not a verified identity or a percentage.
                  </span>
                  {run.provenance.identity.profile && (
                    <a
                      href={run.provenance.identity.profile}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Inspect matched professional profile
                    </a>
                  )}
                </div>
              )}
              {run.identityChanged && run.status === "proposed" && (
                <p role="alert">
                  The candidate’s lookup identity has changed. This proposal
                  cannot be applied.
                </p>
              )}
              {run.status === "proposed" && (
                <>
                  <p>
                    Select only fields you have reviewed. Fields edited since
                    the lookup are protected.
                  </p>
                  {run.diff.length === 0 ? (
                    <p>
                      The returned professional fields already match this
                      candidate.
                    </p>
                  ) : (
                    <div className="enrichment-diff">
                      {run.diff.map((diff) => (
                        <label
                          className={`enrichment-diff-row ${diff.conflict ? "conflict" : ""}`}
                          key={diff.field}
                        >
                          <input
                            type="checkbox"
                            aria-label={`Apply ${names[diff.field] || diff.field}`}
                            checked={selectedFields.includes(diff.field)}
                            disabled={
                              !state.setup.canManage ||
                              busy ||
                              diff.conflict ||
                              run.identityChanged
                            }
                            onChange={(event) => {
                              setConfirmed(false);
                              setSelectedFields((current) =>
                                event.target.checked
                                  ? [...current, diff.field]
                                  : current.filter(
                                      (field) => field !== diff.field,
                                    ),
                              );
                            }}
                          />
                          <div>
                            <strong>{names[diff.field] || diff.field}</strong>
                            {diff.conflict && (
                              <small>
                                Local edit preserved — unavailable for this
                                proposal
                              </small>
                            )}
                            <div className="enrichment-values">
                              <div>
                                <span>Current</span>
                                <p>{format(diff.before)}</p>
                              </div>
                              <div>
                                <span>Proposed</span>
                                <p>{format(diff.proposed)}</p>
                              </div>
                            </div>
                          </div>
                        </label>
                      ))}
                    </div>
                  )}
                  {state.setup.canManage && run.diff.length > 0 && (
                    <>
                      <label className="enrichment-check">
                        <input
                          type="checkbox"
                          checked={confirmed}
                          onChange={(event) =>
                            setConfirmed(event.target.checked)
                          }
                          disabled={
                            busy ||
                            selectedFields.length === 0 ||
                            run.identityChanged
                          }
                        />
                        <span>
                          I reviewed the matched identity and selected field
                          changes.
                        </span>
                      </label>
                      <button
                        type="button"
                        className="business-button"
                        disabled={
                          busy ||
                          !confirmed ||
                          !selectedFields.length ||
                          run.identityChanged
                        }
                        onClick={() => void apply()}
                      >
                        Apply {selectedFields.length || "selected"} fields
                      </button>
                    </>
                  )}
                </>
              )}
              {run.appliedAt && (
                <p>
                  Applied{" "}
                  {run.appliedFields
                    .map((field) => names[field] || field)
                    .join(", ")}{" "}
                  on {new Date(run.appliedAt).toLocaleString()}.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
