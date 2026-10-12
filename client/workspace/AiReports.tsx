import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Columns3,
  FileSpreadsheet,
  Filter,
  Info,
  Layers,
  LockKeyhole,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Table2,
  X,
} from "lucide-react";
import "./ai-reports.css";
import ReportDrafting from "./ReportDrafting";
import ReportCollaboration from "./ReportCollaboration";
import ReportPresentation, {
  initialPresentation,
  type Aggregation,
} from "./ReportPresentation";

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
  filters: {
    title: string;
    from: string;
    to: string;
    candidate?: string;
    interviewer?: string;
    status?: string;
    dateField?: "created" | "conversation";
    durationMin?: number;
    durationMax?: number;
  };
};
type View = Definition & {
  id: string;
  revision: number;
  favorite?: boolean;
  ownerName?: string;
  createdAt?: string;
  updatedAt?: string;
  unavailableSourceCount?: number;
  presentation?: typeof initialPresentation;
  presentationRevision?: number;
  permission?: "owner" | "editor" | "viewer";
  canEdit?: boolean;
  canManage?: boolean;
  shared?: boolean;
};
type Source = {
  id: string;
  title: string;
  createdAt: string;
  characters: number;
  candidate?: string;
  interviewer?: string;
  date?: string;
  duration?: number | null;
  status?: string;
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
  aggregation?: Aggregation;
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
  canEdit,
}: {
  canEdit: boolean;
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
            disabled={!canEdit}
            maxLength={4000}
            rows={3}
            value={annotation}
            onChange={(event) => setAnnotation(event.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={!canEdit || saving || annotation === saved}
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

function matchesFilters(source: Source, filters: Definition["filters"]) {
  const date = (
    filters.dateField === "conversation" ? source.date || "" : source.createdAt
  ).slice(0, 10);
  return (
    (!filters.title ||
      source.title.toLowerCase().includes(filters.title.toLowerCase())) &&
    (!filters.candidate ||
      (source.candidate || "")
        .toLowerCase()
        .includes(filters.candidate.toLowerCase())) &&
    (!filters.interviewer ||
      (source.interviewer || "")
        .toLowerCase()
        .includes(filters.interviewer.toLowerCase())) &&
    (!filters.status || source.status === filters.status) &&
    (filters.durationMin === undefined ||
      (typeof source.duration === "number" &&
        source.duration >= filters.durationMin)) &&
    (filters.durationMax === undefined ||
      (typeof source.duration === "number" &&
        source.duration <= filters.durationMax)) &&
    (!filters.from || date >= filters.from) &&
    (!filters.to || (!!date && date <= filters.to))
  );
}
const formatDate = (value?: string) =>
  value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "—";

type Panel = "info" | "agent" | "charts";
type Tool = "filters" | "columns" | "sources" | null;
export default function AiReports() {
  const navigate = useNavigate(),
    location = useLocation();
  const routeId = location.pathname.split("/")[3] || "";
  const newReport = routeId === "new",
    selected = newReport ? "" : routeId,
    isList = !routeId;
  const [index, setIndex] = useState<Index | null>(null),
    [detail, setDetail] = useState<Detail | null>(null);
  const [draft, setDraft] = useState<Definition>(freshDefinition),
    [editing, setEditing] = useState(newReport);
  const [panel, setPanel] = useState<Panel>(newReport ? "agent" : "info"),
    [tool, setTool] = useState<Tool>(null);
  const [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const [consent, setConsent] = useState(false),
    [confirmDelete, setConfirmDelete] = useState(false),
    [selectedRun, setSelectedRun] = useState("");
  const [sharingOpen, setSharingOpen] = useState(0);
  const [listFilter, setListFilter] = useState("all");
  const [search, setSearch] = useState(""),
    [sort, setSort] = useState("updated"),
    [sourceSearch, setSourceSearch] = useState("");
  const requestKey = useRef(crypto.randomUUID()),
    selectedRef = useRef(selected),
    mounted = useRef(true),
    initialized = useRef(""),
    editorRevision = useRef<number | null>(null);
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
      if (initialized.current !== id) {
        initialized.current = id;
        editorRevision.current = result.item.revision;
        setDraft(definitionOf(result.item));
      }
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
    setEditing(newReport);
    initialized.current = "";
    editorRevision.current = null;
    requestKey.current = crypto.randomUUID();
    if (!selected) {
      if (newReport) setDraft(freshDefinition());
      return;
    }
    const controller = new AbortController();
    void loadDetail(selected, controller.signal).catch((cause) => {
      if (!controller.signal.aborted) setError(cause.message);
    });
    return () => controller.abort();
  }, [selected, newReport]);
  const running = detail?.runs.some(active),
    run = detail?.runs.find((item) => item.id === selectedRun);
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
  async function action(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  const canEdit = detail?.item.canEdit !== false,
    canManage = detail?.item.canManage !== false;
  const current = editing ? draft : detail ? definitionOf(detail.item) : draft;
  const matchedSources =
    index?.sources.filter(
      (source) =>
        current.sourceIds.includes(source.id) &&
        matchesFilters(source, current.filters),
    ) || [];
  const editable = (update: (value: Definition) => Definition) => {
    if (!canEdit) return;
    if (!editing) editorRevision.current = detail?.item.revision || null;
    setDraft(update(current));
    setEditing(true);
    setConsent(false);
  };
  const openTool = (value: Tool) => {
    setTool(tool === value ? null : value);
  };
  const filterCount = Object.entries(current.filters).filter(
    ([key, value]) =>
      key !== "dateField" && value !== "" && value !== undefined,
  ).length;
  const changed =
    editing &&
    (!detail ||
      JSON.stringify(draft) !== JSON.stringify(definitionOf(detail.item)));
  function discard() {
    editorRevision.current = detail?.item.revision || null;
    setDraft(detail ? definitionOf(detail.item) : freshDefinition());
    setEditing(false);
    setTool(null);
    setError("");
  }
  async function save() {
    if (
      !current.name.trim() ||
      !current.question.trim() ||
      !current.columns.every(
        (column) => column.name.trim() && column.instruction.trim(),
      )
    ) {
      setError(
        "Add a report name, question, and a name and instruction for each AI column.",
      );
      setPanel("info");
      return;
    }
    await action(async () => {
      const result = await request<Detail>(
        selected ? `/${selected}` : "",
        selected ? "PATCH" : "POST",
        selected
          ? { revision: editorRevision.current, definition: current }
          : current,
      );
      setDetail(result);
      editorRevision.current = result.item.revision;
      setDraft(definitionOf(result.item));
      setEditing(false);
      setTool(null);
      setMessage(
        "Private report view saved. Review the run scope before extracting.",
      );
      if (!selected) navigate(`/app/reports/${result.item.id}`);
      else await loadIndex();
    });
  }
  const resultsTable = run ? (
    <div className="ai-report-table-scroll report-evidence-table">
      <table aria-label="Report evidence">
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
                  Source unavailable or changed — its title, values, evidence,
                  and annotations are hidden. Start a new run after reviewing
                  sources.
                </td>
              </tr>
            ) : (
              <tr key={row.id}>
                <th scope="row">
                  <Link to={`/notes/${row.sourceId}`}>{row.title}</Link>
                  {row.truncated && (
                    <p className="ai-report-truncation">
                      Partial transcript:{" "}
                      {row.includedCharacters?.toLocaleString()} of{" "}
                      {row.totalCharacters?.toLocaleString()} characters
                      included. Answers cover only that excerpt.
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
                      canEdit={canEdit}
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
  ) : null;
  const visibleItems =
    index?.items
      .filter(
        (view) =>
          (listFilter !== "favorites" || view.favorite) &&
          (listFilter !== "mine" ||
            view.permission === undefined ||
            view.permission === "owner") &&
          (listFilter !== "shared" ||
            view.permission === "viewer" ||
            view.permission === "editor") &&
          (listFilter !== "recent" ||
            Date.parse(view.updatedAt || "") >= Date.now() - 30 * 86400000),
      )
      .filter((view) =>
        `${view.name} ${view.question}`
          .toLowerCase()
          .includes(search.toLowerCase()),
      )
      .sort((a, b) =>
        sort === "name"
          ? a.name.localeCompare(b.name)
          : (b.updatedAt || "").localeCompare(a.updatedAt || ""),
      ) || [];
  return (
    <section
      className={`ai-reports reports-workspace ${isList ? "reports-index" : "reports-builder"}`}
      aria-label="AI report views"
    >
      <header className="reports-topbar">
        <div className="reports-breadcrumb">
          <Link to="/app/reports">
            <Table2 size={18} /> Reports
          </Link>
          {!isList && (
            <>
              <ChevronRight size={15} />
              <h1>{detail?.item.name || "Untitled Report"}</h1>
              {changed && <span className="report-unsaved">Unsaved</span>}
            </>
          )}
        </div>
        {isList ? (
          <Link to="/app/reports/new" className="report-button primary">
            <Plus size={15} /> New report
          </Link>
        ) : (
          <div className="ai-report-actions">
            <span className="reports-private">
              <LockKeyhole size={13} />{" "}
              {detail?.item.shared ? "Shared" : "Private"}
            </span>
            {detail && (
              <button
                onClick={() => {
                  setPanel("info");
                  setSharingOpen((value) => value + 1);
                }}
              >
                Share
              </button>
            )}
            {changed && detail && (
              <button onClick={discard} disabled={busy}>
                Discard changes
              </button>
            )}
            <button
              className="primary"
              onClick={() => void save()}
              disabled={
                !canEdit ||
                busy ||
                (!changed && Boolean(detail)) ||
                !current.sourceIds.length
              }
            >
              {busy ? "Saving…" : "Save report"}
            </button>
          </div>
        )}
      </header>
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
        <p className="reports-loading">Loading reports…</p>
      ) : isList ? (
        <div className="reports-index-body">
          <div className="reports-index-tools">
            <label className="report-search">
              <Search size={16} />
              <input
                aria-label="Search reports"
                placeholder="Search reports"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <select
              aria-label="Report list filter"
              className="report-list-filter"
              value={listFilter}
              onChange={(e) => setListFilter(e.target.value)}
            >
              <option value="all">All reports</option>
              <option value="mine">Created by me</option>
              <option value="shared">Shared with me</option>
              <option value="recent">Updated in last 30 days</option>
              <option value="favorites">Favorites</option>
            </select>
            <span className="report-owner-filter">
              <LockKeyhole size={14} /> Your accessible reports
            </span>
            <label className="report-sort">
              Sort by
              <select
                aria-label="Sort reports"
                value={sort}
                onChange={(event) => setSort(event.target.value)}
              >
                <option value="updated">Last updated</option>
                <option value="name">Name</option>
              </select>
            </label>
            <Link to="/app/reports/analytics">Workspace analytics</Link>
          </div>
          <div className="reports-list-table">
            <table aria-label="Saved reports">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Owner</th>
                  <th>Conversations</th>
                  <th>Last updated</th>
                </tr>
              </thead>
              <tbody>
                {visibleItems.map((view) => (
                  <tr key={view.id}>
                    <td>
                      <Link to={`/app/reports/${view.id}`}>
                        <Table2 size={16} />
                        <span>
                          <strong>{view.name}</strong>
                          <small>{view.columns.length} AI columns</small>
                        </span>
                      </Link>
                    </td>
                    <td>
                      {view.ownerName || "You"} <LockKeyhole size={12} />
                    </td>
                    <td>{view.sourceIds.length}</td>
                    <td>{formatDate(view.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!visibleItems.length && (
              <div className="reports-list-empty">
                <div className="report-empty-icon">
                  <Table2 size={30} />
                </div>
                <h2>
                  {search
                    ? "No reports match your search"
                    : "Get more from your conversations"}
                </h2>
                <p>
                  {search
                    ? "Try a different name or question."
                    : "Build a report to find answers, spot patterns, and explore the conversations that matter."}
                </p>
                {!search && (
                  <Link className="report-button primary" to="/app/reports/new">
                    <Plus size={15} /> Create report
                  </Link>
                )}
              </div>
            )}
          </div>
          <p className="reports-access-note">
            <LockKeyhole size={13} /> Reports and extracted answers are visible
            only to their owner and named members. Source conversation
            permissions remain separate.
          </p>
        </div>
      ) : selected && !detail ? (
        <p className="reports-loading">Loading report view…</p>
      ) : (
        <div className="report-builder-layout">
          <main className="report-canvas">
            <div className="report-toolbar">
              <div>
                <button
                  className={tool === "filters" ? "selected" : ""}
                  onClick={() => openTool("filters")}
                  aria-expanded={tool === "filters"}
                >
                  <Filter size={15} /> Filter
                  {filterCount ? ` · ${filterCount}` : ""}
                </button>
                <button onClick={() => setPanel("charts")}>
                  <Layers size={15} /> Group
                </button>
                <button
                  className={tool === "columns" ? "selected" : ""}
                  onClick={() => openTool("columns")}
                  aria-expanded={tool === "columns"}
                >
                  <Columns3 size={15} /> Columns{" "}
                  <span>{current.columns.length}</span>
                </button>
              </div>
              <button
                className={tool === "sources" ? "selected" : ""}
                onClick={() => openTool("sources")}
                aria-expanded={tool === "sources"}
              >
                Conversations <span>{current.sourceIds.length}</span>
              </button>
            </div>
            {!canEdit && (
              <p className="report-readonly">
                You can view this report and export currently accessible
                results. Ask the owner for edit access to change it.
              </p>
            )}
            {!!detail?.item.unavailableSourceCount && (
              <p className="report-readonly">
                Some source conversations are unavailable. Ask their owner to
                share them separately; report sharing does not grant
                conversation access.
              </p>
            )}
            {tool && (
              <section
                className="report-tool-panel"
                aria-label={
                  tool === "filters"
                    ? "Report filters"
                    : tool === "columns"
                      ? "Report columns"
                      : "Source conversations"
                }
              >
                <div className="report-tool-heading">
                  <h2>
                    {tool === "filters"
                      ? "Filter conversations"
                      : tool === "columns"
                        ? "Customize columns"
                        : "Choose conversations"}
                  </h2>
                  <button
                    aria-label="Close report controls"
                    onClick={() => setTool(null)}
                  >
                    <X size={16} />
                  </button>
                </div>
                <fieldset className="report-tool-fieldset" disabled={!canEdit}>
                  {tool === "filters" && (
                    <>
                      <div className="ai-report-filters">
                        <label>
                          Title contains
                          <input
                            value={current.filters.title}
                            maxLength={200}
                            onChange={(e) =>
                              editable((d) => ({
                                ...d,
                                filters: {
                                  ...d.filters,
                                  title: e.target.value,
                                },
                              }))
                            }
                          />
                        </label>
                        <label>
                          Candidate contains
                          <input
                            value={current.filters.candidate || ""}
                            maxLength={200}
                            onChange={(e) =>
                              editable((d) => ({
                                ...d,
                                filters: {
                                  ...d.filters,
                                  candidate: e.target.value,
                                },
                              }))
                            }
                          />
                        </label>
                        <label>
                          Interviewer contains
                          <input
                            value={current.filters.interviewer || ""}
                            maxLength={200}
                            onChange={(e) =>
                              editable((d) => ({
                                ...d,
                                filters: {
                                  ...d.filters,
                                  interviewer: e.target.value,
                                },
                              }))
                            }
                          />
                        </label>
                        <label>
                          Date field
                          <select
                            value={current.filters.dateField || "created"}
                            onChange={(e) =>
                              editable((d) => ({
                                ...d,
                                filters: {
                                  ...d.filters,
                                  dateField: e.target.value as
                                    "created" | "conversation",
                                },
                              }))
                            }
                          >
                            <option value="created">Created date</option>
                            <option value="conversation">
                              Conversation date
                            </option>
                          </select>
                        </label>
                        <label>
                          On or after
                          <input
                            type="date"
                            value={current.filters.from}
                            onChange={(e) =>
                              editable((d) => ({
                                ...d,
                                filters: { ...d.filters, from: e.target.value },
                              }))
                            }
                          />
                        </label>
                        <label>
                          On or before
                          <input
                            type="date"
                            value={current.filters.to}
                            onChange={(e) =>
                              editable((d) => ({
                                ...d,
                                filters: { ...d.filters, to: e.target.value },
                              }))
                            }
                          />
                        </label>
                        <label>
                          Status
                          <select
                            value={current.filters.status || ""}
                            onChange={(e) =>
                              editable((d) => ({
                                ...d,
                                filters: {
                                  ...d.filters,
                                  status: e.target.value,
                                },
                              }))
                            }
                          >
                            <option value="">Any status</option>
                            <option value="ready">Ready</option>
                            <option value="processing">Processing</option>
                            <option value="upcoming">Upcoming</option>
                          </select>
                        </label>
                        <label>
                          Minimum duration (minutes)
                          <input
                            type="number"
                            min={0}
                            max={10080}
                            value={current.filters.durationMin ?? ""}
                            onChange={(e) =>
                              editable((d) => ({
                                ...d,
                                filters: {
                                  ...d.filters,
                                  durationMin:
                                    e.target.value === ""
                                      ? undefined
                                      : Number(e.target.value),
                                },
                              }))
                            }
                          />
                        </label>
                        <label>
                          Maximum duration (minutes)
                          <input
                            type="number"
                            min={0}
                            max={10080}
                            value={current.filters.durationMax ?? ""}
                            onChange={(e) =>
                              editable((d) => ({
                                ...d,
                                filters: {
                                  ...d.filters,
                                  durationMax:
                                    e.target.value === ""
                                      ? undefined
                                      : Number(e.target.value),
                                },
                              }))
                            }
                          />
                        </label>
                      </div>
                      <p className="ai-report-muted">
                        Filters apply to selected conversations. Duration uses
                        the saved minute value; imported calendar events may
                        contain planned duration. Missing values do not match
                        duration or conversation-date filters.
                      </p>
                      <button
                        onClick={() =>
                          editable((d) => ({
                            ...d,
                            filters: { title: "", from: "", to: "" },
                          }))
                        }
                      >
                        Clear filters
                      </button>
                    </>
                  )}
                  {tool === "columns" && (
                    <>
                      <p className="ai-report-muted">
                        Add up to five AI columns. Each answer includes the
                        transcript evidence that supports it.
                      </p>
                      {current.columns.map((column, i) => (
                        <div
                          className="ai-report-column-editor"
                          key={column.id}
                        >
                          <div className="ai-report-column-top">
                            <label>
                              Column {i + 1} name
                              <input
                                required
                                maxLength={80}
                                value={column.name}
                                onChange={(e) =>
                                  editable((d) => ({
                                    ...d,
                                    columns: d.columns.map((c) =>
                                      c.id === column.id
                                        ? { ...c, name: e.target.value }
                                        : c,
                                    ),
                                  }))
                                }
                              />
                            </label>
                            <label>
                              Column {i + 1} type
                              <select
                                value={column.type}
                                onChange={(e) =>
                                  editable((d) => ({
                                    ...d,
                                    columns: d.columns.map((c) =>
                                      c.id === column.id
                                        ? {
                                            ...c,
                                            type: e.target
                                              .value as Column["type"],
                                          }
                                        : c,
                                    ),
                                  }))
                                }
                              >
                                <option value="text">Text</option>
                                <option value="number">Number</option>
                                <option value="boolean">Yes / no</option>
                                <option value="currency">Currency</option>
                              </select>
                            </label>
                            <div className="report-column-actions">
                              <button
                                aria-label={`Move column ${i + 1} up`}
                                disabled={i === 0}
                                onClick={() =>
                                  editable((d) => {
                                    const columns = [...d.columns];
                                    [columns[i - 1], columns[i]] = [
                                      columns[i],
                                      columns[i - 1],
                                    ];
                                    return { ...d, columns };
                                  })
                                }
                              >
                                <ArrowUp size={14} />
                              </button>
                              <button
                                aria-label={`Move column ${i + 1} down`}
                                disabled={i === current.columns.length - 1}
                                onClick={() =>
                                  editable((d) => {
                                    const columns = [...d.columns];
                                    [columns[i + 1], columns[i]] = [
                                      columns[i],
                                      columns[i + 1],
                                    ];
                                    return { ...d, columns };
                                  })
                                }
                              >
                                <ArrowDown size={14} />
                              </button>
                              <button
                                aria-label={`Remove column ${i + 1}`}
                                disabled={current.columns.length === 1}
                                onClick={() =>
                                  editable((d) => ({
                                    ...d,
                                    columns: d.columns.filter(
                                      (c) => c.id !== column.id,
                                    ),
                                  }))
                                }
                              >
                                <X size={14} />
                              </button>
                            </div>
                          </div>
                          <label>
                            Column {i + 1} extraction instructions
                            <textarea
                              required
                              maxLength={2000}
                              rows={2}
                              value={column.instruction}
                              onChange={(e) =>
                                editable((d) => ({
                                  ...d,
                                  columns: d.columns.map((c) =>
                                    c.id === column.id
                                      ? { ...c, instruction: e.target.value }
                                      : c,
                                  ),
                                }))
                              }
                              placeholder="Describe the answer to extract. Return not documented when the transcript does not provide it."
                            />
                          </label>
                        </div>
                      ))}
                      <button
                        disabled={current.columns.length >= 5}
                        onClick={() =>
                          editable((d) => ({
                            ...d,
                            columns: [
                              ...d.columns,
                              {
                                id: crypto.randomUUID(),
                                name: "",
                                instruction: "",
                                type: "text",
                              },
                            ],
                          }))
                        }
                      >
                        <Plus size={14} /> Add AI column
                      </button>
                    </>
                  )}
                  {tool === "sources" && (
                    <>
                      <p className="ai-report-muted">
                        Choose up to {index.limits.notes} accessible
                        conversations. Selection does not send transcripts to
                        AI.
                      </p>
                      <input
                        aria-label="Search source conversations"
                        placeholder="Search conversations"
                        value={sourceSearch}
                        onChange={(e) => setSourceSearch(e.target.value)}
                      />
                      <div className="ai-report-sources">
                        {index.sources
                          .filter((source) =>
                            source.title
                              .toLowerCase()
                              .includes(sourceSearch.toLowerCase()),
                          )
                          .map((source) => (
                            <label className="ai-report-check" key={source.id}>
                              <input
                                type="checkbox"
                                checked={current.sourceIds.includes(source.id)}
                                disabled={
                                  !current.sourceIds.includes(source.id) &&
                                  current.sourceIds.length >= index.limits.notes
                                }
                                onChange={(e) =>
                                  editable((d) => ({
                                    ...d,
                                    sourceIds: e.target.checked
                                      ? [...d.sourceIds, source.id]
                                      : d.sourceIds.filter(
                                          (id) => id !== source.id,
                                        ),
                                  }))
                                }
                              />
                              <span>
                                {source.title}
                                <small>
                                  {source.characters.toLocaleString()}{" "}
                                  transcript characters ·{" "}
                                  {formatDate(source.createdAt)}
                                </small>
                              </span>
                            </label>
                          ))}
                        {!index.sources.length && (
                          <p>
                            Add an unarchived conversation with a transcript to
                            select sources.
                          </p>
                        )}
                      </div>
                      <button
                        disabled={!current.sourceIds.length}
                        onClick={() =>
                          editable((d) => ({ ...d, sourceIds: [] }))
                        }
                      >
                        Clear selection
                      </button>
                    </>
                  )}
                </fieldset>
              </section>
            )}
            <div className="report-table-summary">
              <span>
                {matchedSources.length} matching conversations ×{" "}
                {current.columns.length} columns ={" "}
                {matchedSources.length * current.columns.length} cells per run.
              </span>
              {detail && (
                <button
                  aria-label="Refresh report results"
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      await Promise.all([loadDetail(selected), loadIndex()]);
                    })
                  }
                >
                  <RefreshCw size={14} />
                </button>
              )}
            </div>
            {run && (
              <div className="report-run-toolbar">
                <div>
                  <h2>{statusLabel(run.status)}</h2>
                  <span role="status">
                    {run.finishedCells} of {run.totalCells} cells finished ·{" "}
                    {run.model}
                  </span>
                </div>
                <div className="ai-report-actions">
                  <select
                    aria-label="Report run history"
                    value={selectedRun}
                    onChange={(e) => setSelectedRun(e.target.value)}
                  >
                    {detail?.runs.map((item) => (
                      <option key={item.id} value={item.id}>
                        {new Date(item.createdAt).toLocaleString()} · revision{" "}
                        {item.revision} · {statusLabel(item.status)}
                      </option>
                    ))}
                  </select>
                  {canEdit && active(run) && (
                    <button
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
                    className="report-button"
                    href={`/api/report-views/${selected}/runs/${run.id}/export.csv`}
                  >
                    Export CSV
                  </a>
                </div>
              </div>
            )}
            {run?.error && <p className="ai-report-error">{run.error}</p>}
            {run && changed && (
              <p className="report-snapshot-note">
                Showing saved results. Save your changes and confirm a new run
                to update the table.
              </p>
            )}
            {resultsTable || (
              <div className="ai-report-table-scroll report-preview-table">
                <table aria-label="Conversation preview">
                  <thead>
                    <tr>
                      <th>Conversation</th>
                      <th>Candidate</th>
                      <th>Interviewer</th>
                      <th>Date</th>
                      {current.columns.map((column, i) => (
                        <th key={column.id}>
                          <Sparkles size={12} />{" "}
                          {column.name || `AI column ${i + 1}`}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {matchedSources.map((source) => (
                      <tr key={source.id}>
                        <th scope="row">
                          <Link to={`/notes/${source.id}`}>{source.title}</Link>
                        </th>
                        <td>{source.candidate || "—"}</td>
                        <td>{source.interviewer || "—"}</td>
                        <td>{formatDate(source.date || source.createdAt)}</td>
                        {current.columns.map((column) => (
                          <td key={column.id}>
                            <span className="report-unprocessed">
                              Not extracted
                            </span>
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!matchedSources.length && (
                  <div className="report-canvas-empty">
                    <Table2 size={32} />
                    <h2>
                      {current.sourceIds.length
                        ? "No conversations match these filters"
                        : "Start filtering"}
                    </h2>
                    <p>
                      {current.sourceIds.length
                        ? "Adjust the filters or choose more conversations."
                        : "Choose which conversations to include, then add filters and columns to find the answers you need."}
                    </p>
                    <button
                      onClick={() =>
                        setTool(
                          current.sourceIds.length ? "filters" : "sources",
                        )
                      }
                    >
                      {current.sourceIds.length
                        ? "Edit filters"
                        : "Choose conversations"}
                    </button>
                  </div>
                )}
              </div>
            )}
            {run && (
              <p className="report-snapshot-note">
                Answers reflect the selected run. Changed or inaccessible
                sources are hidden. Human annotations remain separate from AI
                answers.
              </p>
            )}
          </main>
          <aside
            className="report-inspector"
            aria-label="Report workspace panel"
          >
            <div role="tablist" aria-label="Report panels">
              {(["info", "agent", "charts"] as Panel[]).map((value) => (
                <button
                  key={value}
                  role="tab"
                  disabled={value === "agent" && !canEdit}
                  aria-selected={panel === value}
                  onClick={() => setPanel(value)}
                >
                  {value === "info" ? (
                    <Info size={15} />
                  ) : value === "agent" ? (
                    <Sparkles size={15} />
                  ) : (
                    <Layers size={15} />
                  )}{" "}
                  {value[0].toUpperCase() + value.slice(1)}
                </button>
              ))}
            </div>
            <div
              className="report-inspector-body"
              role="tabpanel"
              aria-label={`${panel[0].toUpperCase() + panel.slice(1)} panel`}
            >
              {panel === "info" && (
                <>
                  <h2>Properties</h2>
                  <label>
                    Title
                    <input
                      aria-label="Report name"
                      disabled={!canEdit}
                      required
                      maxLength={120}
                      placeholder="Untitled report"
                      value={current.name}
                      onChange={(e) =>
                        editable((d) => ({ ...d, name: e.target.value }))
                      }
                    />
                  </label>
                  <label>
                    Description
                    <textarea
                      aria-label="What do you want to learn?"
                      disabled={!canEdit}
                      required
                      maxLength={4000}
                      rows={4}
                      placeholder="What would you like to learn from your conversations?"
                      value={current.question}
                      onChange={(e) =>
                        editable((d) => ({ ...d, question: e.target.value }))
                      }
                    />
                  </label>
                  <div className="report-info-meta">
                    <span>
                      <LockKeyhole size={14} />{" "}
                      {detail?.item.shared
                        ? "Shared with named workspace members"
                        : "Private to the report owner"}
                    </span>
                    <span>
                      Created{" "}
                      {detail ? formatDate(detail.item.createdAt) : "Now"}
                    </span>
                    <span>Created by {detail?.item.ownerName || "you"}</span>
                    {detail && (
                      <span>Updated {formatDate(detail.item.updatedAt)}</span>
                    )}
                  </div>
                  <button
                    className="report-agent-shortcut"
                    disabled={!canEdit}
                    onClick={() => setPanel("agent")}
                  >
                    <Sparkles size={15} /> Draft report with AI
                  </button>
                  {!index.setup.configured && (
                    <div className="ai-report-setup">
                      <strong>Text AI is not enabled for this workspace</strong>
                      <p>
                        You can build and save reports. An administrator must
                        configure text AI before extraction.
                      </p>
                    </div>
                  )}
                  {detail && (
                    <>
                      <div className="ai-report-run-box">
                        <h3>Generate answers</h3>
                        <p>
                          Run scope: up to {detail.item.sourceIds.length}{" "}
                          conversations · {detail.item.columns.length} columns
                        </p>
                        {!!detail.item.unavailableSourceCount && (
                          <p>
                            {detail.item.unavailableSourceCount} saved sources
                            are unavailable. Edit the source selection before
                            running again.
                          </p>
                        )}
                        <p>
                          Each selected transcript sends at most{" "}
                          {index.limits.transcriptCharacters.toLocaleString()}{" "}
                          characters to{" "}
                          {index.setup.model || "your text AI provider"}.
                          Provider usage may incur charges.
                        </p>
                        <label className="ai-report-check">
                          <input
                            type="checkbox"
                            checked={consent}
                            onChange={(e) => setConsent(e.target.checked)}
                            disabled={
                              !canEdit ||
                              busy ||
                              Boolean(running) ||
                              changed ||
                              !index.setup.configured
                            }
                          />
                          <span>
                            I confirm this saved view and selected transcripts
                            may be sent to the configured text AI provider for
                            this run.
                          </span>
                        </label>
                        <button
                          className="primary"
                          disabled={
                            !canEdit ||
                            busy ||
                            !consent ||
                            Boolean(running) ||
                            changed ||
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
                        {changed && (
                          <p>
                            Save changes before starting extraction.
                            {running
                              ? " Saving will cancel the active run."
                              : ""}
                          </p>
                        )}
                      </div>
                      <h3 className="report-properties-heading">Actions</h3>
                      <div className="report-info-actions">
                        <button
                          disabled={busy}
                          onClick={() =>
                            void action(async () => {
                              const result = await request<Detail>(
                                `/${selected}/preferences`,
                                "PATCH",
                                { favorite: !detail.item.favorite },
                              );
                              setDetail(result);
                              setMessage(
                                result.item.favorite
                                  ? "Report added to favorites."
                                  : "Report removed from favorites.",
                              );
                            })
                          }
                        >
                          {detail.item.favorite
                            ? "Remove from favorites"
                            : "Add to favorites"}
                        </button>
                        <button
                          disabled={
                            busy ||
                            changed ||
                            Boolean(detail.item.unavailableSourceCount)
                          }
                          onClick={() =>
                            void action(async () => {
                              const copy = await request<Detail>("", "POST", {
                                ...definitionOf(detail.item),
                                name: `${detail.item.name.slice(0, 110)} (copy)`,
                              });
                              navigate(`/app/reports/${copy.item.id}`);
                            })
                          }
                        >
                          Duplicate report
                        </button>
                      </div>
                      <button
                        className="report-delete"
                        onClick={() => setConfirmDelete(!confirmDelete)}
                        disabled={busy || !canManage}
                      >
                        Delete view
                      </button>
                      {confirmDelete && (
                        <div className="ai-report-confirm">
                          <p>
                            Delete this private report, its results, and
                            annotations?
                          </p>
                          <button
                            onClick={() =>
                              void action(async () => {
                                await request(`/${selected}`, "DELETE");
                                navigate("/app/reports");
                              })
                            }
                            disabled={busy}
                          >
                            Confirm delete report view
                          </button>
                          <button onClick={() => setConfirmDelete(false)}>
                            Keep view
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </>
              )}
              {panel === "info" && detail && (
                <ReportCollaboration
                  key={detail.item.id}
                  viewId={detail.item.id}
                  revision={detail.item.revision}
                  name={detail.item.name}
                  runs={detail.runs}
                  open={sharingOpen}
                  onChanged={async () => {
                    await Promise.all([loadDetail(selected), loadIndex()]);
                  }}
                />
              )}
              {canEdit && (
                <div hidden={panel !== "agent"}>
                  <ReportDrafting
                    viewId={selected || undefined}
                    revision={
                      editing
                        ? editorRevision.current || undefined
                        : detail?.item.revision
                    }
                    editorIdentity={JSON.stringify(current)}
                    onClose={() => setPanel("info")}
                    onUse={(proposal) => {
                      editable((d) => ({
                        ...proposal,
                        sourceIds: d.sourceIds,
                      }));
                      setPanel("info");
                      setMessage(
                        "Proposal applied to the editor. Review columns, filters and selected sources before saving.",
                      );
                    }}
                  />
                </div>
              )}
              {panel === "charts" &&
                (detail ? (
                  <ReportPresentation
                    key={`${detail.item.id}:${run?.id || "definition"}:${detail.item.presentationRevision || 1}`}
                    viewId={detail.item.id}
                    readOnly={!canEdit}
                    revision={detail.item.presentationRevision || 1}
                    saved={detail.item.presentation || initialPresentation}
                    columns={run?.columns || detail.item.columns}
                    aggregation={run?.aggregation}
                    runId={run?.id}
                    onSaved={async () => {
                      await Promise.all([loadDetail(selected), loadIndex()]);
                      setMessage(
                        "Presentation saved. No extraction was started.",
                      );
                    }}
                    onError={setError}
                  />
                ) : (
                  <div className="report-charts-empty">
                    <Layers size={28} />
                    <h2>Turn your answers into a chart</h2>
                    <p>
                      Save a report to choose a grouping and calculation. Charts
                      use extracted answers from the run you select.
                    </p>
                    <button onClick={() => setPanel("info")}>
                      Complete report info
                    </button>
                  </div>
                ))}
            </div>
          </aside>
        </div>
      )}
    </section>
  );
}
