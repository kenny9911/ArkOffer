import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { FileSpreadsheet, Plus, RefreshCw } from "lucide-react";
import "./ai-reports.css";

type Column = {
  id: string;
  name: string;
  instruction: string;
  type: "text" | "number" | "boolean" | "currency";
};
type Definition = {
  name: string;
  question: string;
  sourceIds: string[];
  columns: Column[];
  filters: { title: string; from: string; to: string };
};
type View = Definition & {
  id: string;
  revision: number;
  unavailableSourceCount?: number;
};
type Source = {
  id: string;
  title: string;
  createdAt: string;
  characters: number;
};
type Cell = {
  id: string;
  columnId: string;
  value:
    string | number | boolean | { amount: number; currency: string } | null;
  status: string;
  evidence: { quote: string; start: number; end: number }[];
  annotation: string;
  error: string | null;
};
type Run = {
  id: string;
  revision: number;
  status: string;
  model: string;
  createdAt: string;
  error: string | null;
  totalCells: number;
  finishedCells: number;
  columns: Column[];
  rows: {
    id: string;
    sourceId?: string;
    title?: string;
    unavailable?: boolean;
    truncated?: boolean;
    includedCharacters?: number;
    totalCharacters?: number;
    cells: Cell[];
  }[];
};
type Index = {
  items: View[];
  sources: Source[];
  setup: { configured: boolean; model: string | null };
  limits: {
    notes: number;
    columns: number;
    cells: number;
    transcriptCharacters: number;
    userDailyCells: number;
    workspaceDailyCells: number;
  };
};
type Detail = { item: View; runs: Run[] };
const freshDefinition = (): Definition => ({
  name: "",
  question: "",
  sourceIds: [],
  columns: [
    { id: crypto.randomUUID(), name: "", instruction: "", type: "text" },
  ],
  filters: { title: "", from: "", to: "" },
});
const definitionOf = (view: View): Definition => ({
  name: view.name,
  question: view.question,
  sourceIds: view.sourceIds,
  columns: view.columns,
  filters: view.filters,
});
const active = (run?: Run) =>
  run && ["queued", "processing"].includes(run.status);
const statusLabel = (status: string) =>
  ({
    not_documented: "Not documented",
    completed_with_issues: "Completed with issues",
    interrupted: "Interrupted — confirm a new run to retry",
    unavailable: "Source unavailable",
    queued: "Queued",
    processing: "Extracting",
    complete: "Complete",
    cancelled: "Cancelled",
    failed: "Extraction failed",
  })[status] || status;
async function request<T>(
  path = "",
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api/report-views${path}`, {
    method,
    credentials: "same-origin",
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || "Unable to update your report view.");
  return data;
}
function valueText(value: Cell["value"]) {
  return value === null
    ? "Not documented"
    : typeof value === "object"
      ? `${value.currency} ${value.amount.toLocaleString()}`
      : typeof value === "boolean"
        ? value
          ? "Yes"
          : "No"
        : String(value);
}
function ReportCell({
  cell,
  column,
  path,
  onError,
}: {
  cell: Cell;
  column: Column;
  path: string;
  onError: (message: string) => void;
}) {
  const [annotation, setAnnotation] = useState(cell.annotation),
    [saved, setSaved] = useState(cell.annotation),
    [saving, setSaving] = useState(false);
  return (
    <td>
      <strong
        className={`ai-report-value ${cell.status === "not_documented" ? "muted" : ""}`}
      >
        {["complete", "not_documented"].includes(cell.status)
          ? valueText(cell.value)
          : statusLabel(cell.status)}
      </strong>
      {cell.error && <p className="ai-report-error">{cell.error}</p>}
      {!!cell.evidence.length && (
        <details className="ai-report-evidence">
          <summary>
            Review{" "}
            {cell.evidence.length === 1
              ? "source quote"
              : `${cell.evidence.length} source quotes`}
          </summary>
          {cell.evidence.map((e, index) => (
            <blockquote key={index}>
              <p>{e.quote}</p>
              <small>
                Transcript characters {e.start}–{e.end} (UTF-16, zero-based)
              </small>
            </blockquote>
          ))}
        </details>
      )}
      <details className="ai-report-annotation">
        <summary>
          {saved ? "Human annotation saved" : "Add human annotation"}
        </summary>
        <label>
          Human annotation for {column.name}
          <textarea
            maxLength={4000}
            rows={3}
            value={annotation}
            onChange={(event) => setAnnotation(event.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={saving || annotation === saved}
          onClick={async () => {
            setSaving(true);
            try {
              await request(`${path}/cells/${cell.id}`, "PATCH", {
                annotation,
              });
              setSaved(annotation);
            } catch (error) {
              onError((error as Error).message);
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? "Saving…" : "Save annotation"}
        </button>
      </details>
    </td>
  );
}

export default function AiReports() {
  const [index, setIndex] = useState<Index | null>(null),
    [detail, setDetail] = useState<Detail | null>(null),
    [selected, setSelected] = useState("");
  const [editing, setEditing] = useState(false),
    [draft, setDraft] = useState<Definition>(freshDefinition),
    [revision, setRevision] = useState<number | null>(null);
  const [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [consent, setConsent] = useState(false),
    [confirmDelete, setConfirmDelete] = useState(false),
    [selectedRun, setSelectedRun] = useState("");
  const requestKey = useRef(crypto.randomUUID()),
    selectedRef = useRef(selected),
    mounted = useRef(true);
  selectedRef.current = selected;
  async function loadIndex(signal?: AbortSignal) {
    const result = await request<Index>("", "GET", undefined, signal);
    if (mounted.current && !signal?.aborted) setIndex(result);
    return result;
  }
  async function loadDetail(id: string, signal?: AbortSignal) {
    const result = await request<Detail>(`/${id}`, "GET", undefined, signal);
    if (mounted.current && selectedRef.current === id && !signal?.aborted) {
      setDetail(result);
      setSelectedRun((current) =>
        result.runs.some((run) => run.id === current)
          ? current
          : result.runs[0]?.id || "",
      );
    }
    return result;
  }
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void loadIndex(controller.signal).catch((cause) => {
      if (!controller.signal.aborted) setError(cause.message);
    });
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, []);
  useEffect(() => {
    setDetail(null);
    setConsent(false);
    setSelectedRun("");
    setConfirmDelete(false);
    requestKey.current = crypto.randomUUID();
    if (!selected) return;
    const controller = new AbortController();
    void loadDetail(selected, controller.signal).catch((cause) => {
      if (!controller.signal.aborted) setError(cause.message);
    });
    return () => controller.abort();
  }, [selected]);
  const running = detail?.runs.some(active);
  useEffect(() => {
    if (!selected || !running) return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      void loadDetail(selected, controller.signal).catch((cause) => {
        if (!controller.signal.aborted) setError(cause.message);
      });
    }, 2000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [selected, running]);
  const run = detail?.runs.find((item) => item.id === selectedRun);
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
  const matchedSources =
    index?.sources.filter(
      (source) =>
        draft.sourceIds.includes(source.id) &&
        (!draft.filters.title ||
          source.title
            .toLowerCase()
            .includes(draft.filters.title.toLowerCase())) &&
        (!draft.filters.from ||
          source.createdAt.slice(0, 10) >= draft.filters.from) &&
        (!draft.filters.to ||
          source.createdAt.slice(0, 10) <= draft.filters.to),
    ) || [];
  function edit(view?: View) {
    setDraft(view ? definitionOf(view) : freshDefinition());
    setRevision(view?.revision || null);
    if (!view) {
      setSelected("");
      setDetail(null);
    }
    setEditing(true);
    setError("");
    setMessage("");
    setConsent(false);
  }
  return (
    <section className="ai-reports" aria-labelledby="ai-reports-heading">
      <div className="ai-reports-heading">
        <div>
          <span className="ai-reports-eyebrow">PRIVATE WORKSPACE</span>
          <h2 id="ai-reports-heading">
            <FileSpreadsheet size={21} /> AI report views
          </h2>
          <p>
            Ask a question across your conversations. Review typed answers
            alongside the exact words that support them.
          </p>
        </div>
        <button
          type="button"
          className="business-button primary"
          onClick={() => edit()}
          disabled={busy}
        >
          <Plus size={15} /> New AI report
        </button>
      </div>
      {error && (
        <div role="alert" className="ai-report-error-box">
          {error}
        </div>
      )}
      {message && (
        <p role="status" className="ai-report-message">
          {message}
        </p>
      )}
      {!index ? (
        <p>Loading private report views…</p>
      ) : (
        <>
          {!index.setup.configured && (
            <div className="ai-report-setup">
              <strong>Text AI is not enabled for this workspace</strong>
              <p>
                You can save and edit private report views. Extraction requires
                the shared text AI provider and workspace access to be
                configured by an administrator.
              </p>
            </div>
          )}
          <div className="ai-reports-layout">
            <nav
              className="ai-report-list"
              aria-label="Private AI report views"
            >
              {index.items.length ? (
                index.items.map((view) => (
                  <button
                    type="button"
                    key={view.id}
                    className={selected === view.id ? "selected" : ""}
                    onClick={() => {
                      setSelected(view.id);
                      setEditing(false);
                      setError("");
                    }}
                    disabled={busy}
                  >
                    <strong>{view.name}</strong>
                    <span>
                      {view.columns.length} columns · {view.sourceIds.length}{" "}
                      available conversations
                    </span>
                  </button>
                ))
              ) : (
                <p>
                  No saved AI reports yet. Choose conversations and define what
                  you want to learn.
                </p>
              )}
            </nav>
            <div className="ai-report-main">
              {editing ? (
                <form
                  className="ai-report-editor"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void action(async () => {
                      const result = await request<Detail>(
                        revision ? `/${selected}` : "",
                        revision ? "PATCH" : "POST",
                        revision ? { revision, definition: draft } : draft,
                      );
                      await loadIndex();
                      selectedRef.current = result.item.id;
                      setSelected(result.item.id);
                      setDetail(result);
                      setEditing(false);
                      setMessage(
                        "Private report view saved. Review the run scope before extracting.",
                      );
                    });
                  }}
                >
                  <h3>
                    {revision ? "Edit report view" : "Build a report view"}
                  </h3>
                  <p className="ai-report-muted">
                    Only you can see this view, its answers, and your
                    annotations. Every run checks your current source access.
                  </p>
                  <label>
                    Report name
                    <input
                      required
                      maxLength={120}
                      value={draft.name}
                      onChange={(event) =>
                        setDraft({ ...draft, name: event.target.value })
                      }
                      placeholder="Engineering leadership review"
                    />
                  </label>
                  <label>
                    What do you want to learn?
                    <textarea
                      required
                      maxLength={4000}
                      rows={3}
                      value={draft.question}
                      onChange={(event) =>
                        setDraft({ ...draft, question: event.target.value })
                      }
                      placeholder="What do these candidates say about leading teams, and which examples support their experience?"
                    />
                  </label>
                  <fieldset>
                    <legend>AI columns</legend>
                    <p className="ai-report-muted">
                      Define up to 5 answers. Ask for documented facts and
                      specify units or currency where relevant.
                    </p>
                    {draft.columns.map((column, i) => (
                      <div className="ai-report-column-editor" key={column.id}>
                        <div className="ai-report-column-top">
                          <label>
                            Column {i + 1} name
                            <input
                              required
                              maxLength={80}
                              value={column.name}
                              onChange={(event) =>
                                setDraft({
                                  ...draft,
                                  columns: draft.columns.map((c) =>
                                    c.id === column.id
                                      ? { ...c, name: event.target.value }
                                      : c,
                                  ),
                                })
                              }
                            />
                          </label>
                          <label>
                            Column {i + 1} type
                            <select
                              value={column.type}
                              onChange={(event) =>
                                setDraft({
                                  ...draft,
                                  columns: draft.columns.map((c) =>
                                    c.id === column.id
                                      ? {
                                          ...c,
                                          type: event.target
                                            .value as Column["type"],
                                        }
                                      : c,
                                  ),
                                })
                              }
                            >
                              <option value="text">Text</option>
                              <option value="number">Number</option>
                              <option value="boolean">Yes / no</option>
                              <option value="currency">Currency</option>
                            </select>
                          </label>
                          <button
                            type="button"
                            aria-label={`Remove column ${i + 1}`}
                            disabled={draft.columns.length === 1}
                            onClick={() =>
                              setDraft({
                                ...draft,
                                columns: draft.columns.filter(
                                  (c) => c.id !== column.id,
                                ),
                              })
                            }
                          >
                            Remove
                          </button>
                        </div>
                        <label>
                          Column {i + 1} extraction instructions
                          <textarea
                            required
                            maxLength={2000}
                            rows={2}
                            value={column.instruction}
                            onChange={(event) =>
                              setDraft({
                                ...draft,
                                columns: draft.columns.map((c) =>
                                  c.id === column.id
                                    ? { ...c, instruction: event.target.value }
                                    : c,
                                ),
                              })
                            }
                            placeholder="Summarize an example of leading a team. Return not documented if none is stated."
                          />
                        </label>
                      </div>
                    ))}
                    <button
                      type="button"
                      disabled={draft.columns.length >= 5}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          columns: [
                            ...draft.columns,
                            {
                              id: crypto.randomUUID(),
                              name: "",
                              type: "text",
                              instruction: "",
                            },
                          ],
                        })
                      }
                    >
                      Add AI column
                    </button>
                  </fieldset>
                  <fieldset>
                    <legend>Source conversations</legend>
                    <p className="ai-report-muted">
                      Select up to 20 unarchived conversations you can access.
                      Empty transcripts return “Not documented”.
                    </p>
                    {!index.sources.length ? (
                      <p>
                        Add an unarchived conversation with a transcript to
                        select sources.
                      </p>
                    ) : (
                      <div className="ai-report-sources">
                        {index.sources.map((source) => (
                          <label className="ai-report-check" key={source.id}>
                            <input
                              type="checkbox"
                              checked={draft.sourceIds.includes(source.id)}
                              disabled={
                                !draft.sourceIds.includes(source.id) &&
                                draft.sourceIds.length >= 20
                              }
                              onChange={(event) =>
                                setDraft({
                                  ...draft,
                                  sourceIds: event.target.checked
                                    ? [...draft.sourceIds, source.id]
                                    : draft.sourceIds.filter(
                                        (id) => id !== source.id,
                                      ),
                                })
                              }
                            />
                            <span>
                              {source.title}
                              <small>
                                {source.characters.toLocaleString()} transcript
                                characters · {source.createdAt.slice(0, 10)}
                              </small>
                            </span>
                          </label>
                        ))}
                      </div>
                    )}
                    <div className="ai-report-filters">
                      <label>
                        Title contains
                        <input
                          value={draft.filters.title}
                          maxLength={200}
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              filters: {
                                ...draft.filters,
                                title: event.target.value,
                              },
                            })
                          }
                        />
                      </label>
                      <label>
                        Created on or after
                        <input
                          type="date"
                          value={draft.filters.from}
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              filters: {
                                ...draft.filters,
                                from: event.target.value,
                              },
                            })
                          }
                        />
                      </label>
                      <label>
                        Created on or before
                        <input
                          type="date"
                          value={draft.filters.to}
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              filters: {
                                ...draft.filters,
                                to: event.target.value,
                              },
                            })
                          }
                        />
                      </label>
                    </div>
                    <p>
                      {matchedSources.length} matching conversations ×{" "}
                      {draft.columns.length} columns ={" "}
                      {matchedSources.length * draft.columns.length} cells per
                      run.
                    </p>
                  </fieldset>
                  {revision && running && (
                    <p>
                      Saving changes cancels the active run. Completed
                      historical runs remain available.
                    </p>
                  )}
                  <div className="ai-report-actions">
                    <button
                      className="business-button primary"
                      disabled={busy || !draft.sourceIds.length}
                      type="submit"
                    >
                      {busy ? "Saving…" : "Save report view"}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setEditing(false)}
                    >
                      Cancel editing
                    </button>
                  </div>
                </form>
              ) : detail ? (
                <>
                  <div className="ai-report-view-heading">
                    <div>
                      <h3>{detail.item.name}</h3>
                      <p>{detail.item.question}</p>
                    </div>
                    <div className="ai-report-actions">
                      <button
                        type="button"
                        onClick={() => edit(detail.item)}
                        disabled={busy}
                      >
                        Edit view
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDelete(!confirmDelete)}
                        disabled={busy}
                      >
                        Delete view
                      </button>
                    </div>
                  </div>
                  {confirmDelete && (
                    <div className="ai-report-confirm">
                      <p>
                        Delete this private view, all extracted results, and
                        your annotations?
                      </p>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void action(async () => {
                            await request(`/${selected}`, "DELETE");
                            setSelected("");
                            setDetail(null);
                            setConfirmDelete(false);
                            await loadIndex();
                            setMessage("Report view deleted.");
                          })
                        }
                      >
                        Confirm delete report view
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDelete(false)}
                      >
                        Keep view
                      </button>
                    </div>
                  )}
                  <div className="ai-report-column-summary">
                    {detail.item.columns.map((column) => (
                      <div key={column.id}>
                        <strong>{column.name}</strong>
                        <span>{column.type}</span>
                        <p>{column.instruction}</p>
                      </div>
                    ))}
                  </div>
                  <div className="ai-report-run-box">
                    <strong>
                      Run scope: up to {detail.item.sourceIds.length}{" "}
                      conversations · {detail.item.columns.length} columns
                    </strong>
                    <p>
                      Title filter: {detail.item.filters.title || "Any"} ·
                      Created: {detail.item.filters.from || "Any start"} to{" "}
                      {detail.item.filters.to || "Any end"}.
                    </p>
                    {!!detail.item.unavailableSourceCount && (
                      <p>
                        {detail.item.unavailableSourceCount} saved sources are
                        unavailable. Edit the source selection before running
                        again.
                      </p>
                    )}
                    <p>
                      Each selected transcript sends at most{" "}
                      {index.limits.transcriptCharacters.toLocaleString()}{" "}
                      characters to{" "}
                      {index.setup.model || "your text AI provider"}. The report
                      is limited to {index.limits.cells} cells per run and{" "}
                      {index.limits.userDailyCells} cells per user /{" "}
                      {index.limits.workspaceDailyCells.toLocaleString()} per
                      workspace over 24 hours. Provider usage may incur charges.
                      Review every answer before using it.
                    </p>
                    <label className="ai-report-check">
                      <input
                        type="checkbox"
                        checked={consent}
                        onChange={(event) => setConsent(event.target.checked)}
                        disabled={
                          busy || Boolean(running) || !index.setup.configured
                        }
                      />
                      <span>
                        I confirm this saved view and selected transcripts may
                        be sent to the configured text AI provider for this run.
                      </span>
                    </label>
                    <button
                      type="button"
                      className="business-button primary"
                      disabled={
                        busy ||
                        !consent ||
                        Boolean(running) ||
                        !index.setup.configured ||
                        Boolean(detail.item.unavailableSourceCount)
                      }
                      onClick={() =>
                        void action(async () => {
                          const result = await request<{ item: Run }>(
                            `/${selected}/runs`,
                            "POST",
                            {
                              consent: true,
                              revision: detail.item.revision,
                              requestKey: requestKey.current,
                            },
                          );
                          requestKey.current = crypto.randomUUID();
                          setConsent(false);
                          await loadDetail(selected);
                          setSelectedRun(result.item.id);
                          setMessage(
                            "Extraction queued. You can leave this page and return to review progress.",
                          );
                        })
                      }
                    >
                      <RefreshCw size={14} />
                      {detail.runs.length
                        ? "Run extraction again"
                        : "Run extraction"}
                    </button>
                  </div>
                  {!!detail.runs.length && (
                    <label className="ai-report-history">
                      Run history
                      <select
                        aria-label="Report run history"
                        value={selectedRun}
                        onChange={(event) => setSelectedRun(event.target.value)}
                      >
                        {detail.runs.map((item) => (
                          <option key={item.id} value={item.id}>
                            {new Date(item.createdAt).toLocaleString()} ·
                            revision {item.revision} ·{" "}
                            {statusLabel(item.status)}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {run && (
                    <div className="ai-report-results">
                      <div className="ai-report-results-heading">
                        <div>
                          <h4>{statusLabel(run.status)}</h4>
                          <p role="status">
                            {run.finishedCells} of {run.totalCells} cells
                            finished · {run.model}
                          </p>
                        </div>
                        <div className="ai-report-actions">
                          {active(run) && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                void action(async () => {
                                  await request(
                                    `/${selected}/runs/${run.id}/cancel`,
                                    "POST",
                                    {},
                                  );
                                  await loadDetail(selected);
                                  setMessage(
                                    "Run cancelled. Any in-flight response will be discarded.",
                                  );
                                })
                              }
                            >
                              Cancel extraction
                            </button>
                          )}
                          <a
                            className="business-button"
                            href={`/api/report-views/${selected}/runs/${run.id}/export.csv`}
                          >
                            Export CSV
                          </a>
                          <button
                            type="button"
                            aria-label="Refresh report results"
                            disabled={busy}
                            onClick={() =>
                              void action(async () => {
                                await loadDetail(selected);
                                await loadIndex();
                              })
                            }
                          >
                            <RefreshCw size={14} />
                          </button>
                        </div>
                      </div>
                      {run.error && (
                        <p className="ai-report-error">{run.error}</p>
                      )}
                      <p className="ai-report-muted">
                        Answers reflect the saved run revision. Changed,
                        archived, deleted, or inaccessible sources are hidden.
                        Human annotations are separate from AI answers.
                      </p>
                      <div className="ai-report-table-scroll">
                        <table>
                          <thead>
                            <tr>
                              <th>Conversation</th>
                              {run.columns.map((column) => (
                                <th key={column.id}>
                                  {column.name}
                                  <small>{column.type}</small>
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {run.rows.map((row) =>
                              row.unavailable ? (
                                <tr key={row.id}>
                                  <td colSpan={run.columns.length + 1}>
                                    Source unavailable or changed — its title,
                                    values, evidence, and annotations are
                                    hidden. Start a new run after reviewing
                                    sources.
                                  </td>
                                </tr>
                              ) : (
                                <tr key={row.id}>
                                  <th scope="row">
                                    <Link to={`/notes/${row.sourceId}`}>
                                      {row.title}
                                    </Link>
                                    {row.truncated && (
                                      <p className="ai-report-truncation">
                                        Partial transcript:{" "}
                                        {row.includedCharacters?.toLocaleString()}{" "}
                                        of{" "}
                                        {row.totalCharacters?.toLocaleString()}{" "}
                                        characters included. Answers cover only
                                        that excerpt.
                                      </p>
                                    )}
                                  </th>
                                  {run.columns.map((column) => {
                                    const cell = row.cells.find(
                                      (item) => item.columnId === column.id,
                                    );
                                    return cell ? (
                                      <ReportCell
                                        key={cell.id}
                                        cell={cell}
                                        column={column}
                                        path={`/${selected}/runs/${run.id}`}
                                        onError={setError}
                                      />
                                    ) : (
                                      <td key={column.id}>Not available</td>
                                    );
                                  })}
                                </tr>
                              ),
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </>
              ) : selected ? (
                <p>Loading report view…</p>
              ) : (
                <div className="ai-report-empty">
                  <FileSpreadsheet size={30} />
                  <h3>Turn conversations into a reviewable report</h3>
                  <p>
                    Create a private view with your question, selected
                    conversations, and custom columns. Extraction starts only
                    after your confirmation.
                  </p>
                  <button
                    type="button"
                    className="business-button"
                    onClick={() => edit()}
                  >
                    Create your first AI report
                  </button>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
