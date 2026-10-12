import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Bold,
  Italic,
  Strikethrough,
  Link as LinkIcon,
  List,
  ListOrdered,
  Check,
  Clock3,
  Eye,
  GripVertical,
  Mail,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Trash2,
  Users,
} from "lucide-react";
import {
  api,
  json,
  Button,
  ErrorBanner,
  Field,
  Loading,
  Modal,
  type Item,
  useAuth,
} from "../ui";
import SequenceDelivery from "./SequenceDelivery";
import "./SequenceWorkspace.css";
import { renderEmailMarkup, safeEmailLink } from "../../shared/email-markup";
import { sequenceRequiresSubject } from "../../shared/sequence-channels";

type Kind =
  | "email"
  | "manual_email"
  | "linkedin_message"
  | "linkedin_connection"
  | "linkedin_inmail"
  | "call"
  | "sms"
  | "task";
type Step = {
  kind: Kind;
  subject: string;
  body: string;
  delayDays: number;
  format?: "plain" | "formatted";
  cc?: string[];
  bcc?: string[];
};
type Settings = {
  timezone: string;
  weekdays: number[];
  startHour: number;
  endHour: number;
};
type Draft = {
  name: string;
  description: string;
  steps: Step[];
  settings?: Settings;
  enrolledCandidateIds: string[];
};
type Proposal = {
  id: string;
  status: string;
  result: null | {
    name: string;
    description: string;
    steps: Step[];
    notes: string[];
  };
  error: string | null;
  sourceCurrent: boolean;
  createdAt: number;
};
type Overview = {
  items: Item[];
  metrics: { sent: number; opened: number; bounced: number; replied: number };
  aiAvailable: boolean;
  sender: string;
};
const kinds: Record<Kind, string> = {
  email: "Automatic Email",
  manual_email: "Manual Email",
  linkedin_message: "LinkedIn Message",
  linkedin_connection: "LinkedIn Connection Request",
  linkedin_inmail: "LinkedIn InMail",
  call: "Phone",
  sms: "SMS",
  task: "Manual task",
};
const fields: Record<string, string> = {
  "Candidate first name": "firstName",
  "Candidate name": "name",
  "Current company": "company",
  "Job title": "role",
  "Sender name": "senderName",
  Workspace: "workspaceName",
};
const emptyStep = (first = false): Step => ({
  kind: "email",
  subject: "",
  body: "",
  delayDays: first ? 0 : 3,
});
const defaultSettings = (): Settings => ({
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  weekdays: [1, 2, 3, 4, 5],
  startHour: 9,
  endHour: 18,
});
const blank = (): Draft => ({
  name: "",
  description: "",
  steps: [emptyStep(true)],
  settings: defaultSettings(),
  enrolledCandidateIds: [],
});
const fromItem = (item: Item): Draft => ({
  name: String(item.name || ""),
  description: String(item.description || ""),
  steps:
    Array.isArray(item.steps) && item.steps.length
      ? item.steps.map((step: Step) => ({
          ...step,
          kind: step.kind || "email",
        }))
      : [emptyStep(true)],
  settings: item.settings,
  enrolledCandidateIds: Array.isArray(item.enrolledCandidateIds)
    ? item.enrolledCandidateIds
    : [],
});
const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "The operation could not be completed.";
export default function SequenceWorkspace() {
  const location = useLocation(),
    navigate = useNavigate(),
    { user } = useAuth();
  const id = location.pathname.match(/\/sequences\/([^/]+)\/?$/)?.[1];
  const [overview, setOverview] = useState<Overview | null>(null),
    [error, setError] = useState(""),
    [search, setSearch] = useState(""),
    [filter, setFilter] = useState("all");
  const [draft, setDraft] = useState<Draft>(blank),
    [revision, setRevision] = useState(""),
    [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const [tab, setTab] = useState("steps"),
    [previews, setPreviews] = useState<number[]>([]),
    [agentOpen, setAgentOpen] = useState(true),
    [enrolling, setEnrolling] = useState(false),
    [delivery, setDelivery] = useState(false),
    [deleteId, setDeleteId] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Item[]>([]),
    [candidateError, setCandidateError] = useState(""),
    [candidateLoading, setCandidateLoading] = useState(false),
    [previewCandidate, setPreviewCandidate] = useState("");
  const [instruction, setInstruction] = useState(""),
    [generating, setGenerating] = useState(false),
    [history, setHistory] = useState<Proposal[]>([]),
    [proposal, setProposal] = useState<Proposal | null>(null),
    [proposalSource, setProposalSource] = useState("");
  const [linkEditing, setLinkEditing] = useState<{
    index: number;
    start: number;
    end: number;
    label: string;
    url: string;
  } | null>(null);
  const inputs = useRef<Record<number, HTMLTextAreaElement | null>>({}),
    request = useRef<{ fingerprint: string; id: string } | null>(null),
    controller = useRef<AbortController | null>(null),
    generationEpoch = useRef(0),
    mounted = useRef(true),
    saved = useRef("");
  const pendingSelection = useRef<{
    index: number;
    body: string;
    start: number;
    end: number;
  } | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const dirty = JSON.stringify(draft) !== saved.current;
  useLayoutEffect(() => {
    const selection = pendingSelection.current;
    if (!selection) return;
    pendingSelection.current = null;
    const input = inputs.current[selection.index];
    if (input?.value !== selection.body) return;
    // Restore against the committed value before another keyboard/pointer action
    // can move the cursor; a later animation frame could overwrite that action.
    input.focus();
    input.setSelectionRange(selection.start, selection.end);
  }, [draft.steps]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => {
      if (JSON.stringify(draftRef.current) !== saved.current) {
        event.preventDefault();
      }
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, []);
  const reload = async () => {
    const data = await api<Overview>("sequence-workspace");
    setOverview(data);
  };
  useEffect(() => {
    let active = true;
    setError("");
    setNotice("");
    setTab("steps");
    setPreviews([]);
    setProposal(null);
    setHistory([]);
    setInstruction("");
    request.current = null;
    controller.current?.abort();
    generationEpoch.current++;
    setGenerating(false);
    setDelivery(false);
    setEnrolling(false);
    setRevision("");
    setLoading(!!id && id !== "new");
    void api<Overview>("sequence-workspace")
      .then((data) => {
        if (active) setOverview(data);
      })
      .catch((error) => {
        if (active) setError(errorText(error));
      });
    if (!id || id === "new") {
      const data = blank();
      setDraft(data);
      saved.current = JSON.stringify(data);
    } else
      void api<{ item: Item; revision: string }>(`sequence-workspace/${id}`)
        .then((data) => {
          if (active) {
            const value = fromItem(data.item);
            setDraft(value);
            saved.current = JSON.stringify(value);
            setRevision(data.revision);
          }
        })
        .catch((error) => {
          if (active) setError(errorText(error));
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    if (id)
      void api<{ items: Proposal[] }>(
        `sequence-drafts${id !== "new" ? `?sequenceId=${id}` : ""}`,
      )
        .then((data) => {
          if (active) setHistory(data.items);
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, [id]);
  useEffect(() => {
    if (!id) return;
    let active = true;
    setCandidateLoading(true);
    setCandidateError("");
    void api<{ items: Item[] }>("candidates")
      .then((data) => {
        if (active) setCandidates(data.items);
      })
      .catch((error) => {
        if (active) setCandidateError(errorText(error));
      })
      .finally(() => {
        if (active) setCandidateLoading(false);
      });
    return () => {
      active = false;
    };
  }, [id]);
  const update = (index: number, patch: Partial<Step>) =>
    setDraft((current) => ({
      ...current,
      steps: current.steps.map((step, i) =>
        i === index ? { ...step, ...patch } : step,
      ),
    }));
  const save = async () => {
    setBusy(true);
    setError("");
    setNotice("");
    const snapshot = draftRef.current;
    try {
      const result = await api<{ item: Item; revision: string }>(
        `sequence-workspace${id && id !== "new" ? `/${id}` : ""}`,
        json(
          id && id !== "new" ? "PUT" : "POST",
          id && id !== "new" ? { revision, draft: snapshot } : snapshot,
        ),
      );
      saved.current = JSON.stringify(snapshot);
      setRevision(result.revision);
      setNotice("Sequence saved. Nothing has been sent.");
      if (id === "new")
        navigate(`/app/sequences/${result.item.id}`, { replace: true });
      else await reload();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  const personalize = (text: string) => {
    const person = candidates.find((item) => item.id === previewCandidate);
    const values: Record<string, string> = {
      firstName: person?.name?.split(/\s+/)[0] || "[Candidate first name]",
      name: person?.name || "[Candidate name]",
      company: person?.company || "[Current company]",
      role: person?.role || person?.title || "[Job title]",
      senderName: user?.name || "[Sender name]",
      workspaceName: user?.workspaceName || "[Workspace]",
    };
    return text.replace(
      /\{\{\s*(\w+)\s*\}\}/g,
      (match, key: string) => values[key] ?? match,
    );
  };
  const generate = async () => {
    setGenerating(true);
    setError("");
    const epoch = ++generationEpoch.current;
    controller.current = new AbortController();
    const snapshot = JSON.stringify(draftRef.current),
      payload = {
        instruction,
        draft: {
          ...draftRef.current,
          name: draftRef.current.name || "New sequence",
        },
        ...(id !== "new" ? { sequenceId: id, revision } : {}),
      },
      fingerprint = JSON.stringify(payload);
    if (request.current?.fingerprint !== fingerprint)
      request.current = { fingerprint, id: crypto.randomUUID() };
    try {
      const data = await api<{ item: Proposal }>("sequence-drafts", {
        ...json("POST", { ...payload, requestId: request.current.id }),
        signal: controller.current.signal,
      });
      if (mounted.current && epoch === generationEpoch.current) {
        setProposal(data.item);
        setProposalSource(snapshot);
        setHistory((current) => [
          data.item,
          ...current.filter((item) => item.id !== data.item.id),
        ]);
        if (data.item.status !== "ready")
          setError(data.item.error || "This draft is not ready.");
        if (data.item.status !== "running") request.current = null;
      }
    } catch (error) {
      if (mounted.current && epoch === generationEpoch.current)
        setError(errorText(error));
    } finally {
      if (mounted.current && epoch === generationEpoch.current)
        setGenerating(false);
    }
  };
  const addToken = (index: number, token: string) => {
    const input = inputs.current[index],
      step = draft.steps[index],
      start = input?.selectionStart ?? step.body.length,
      end = input?.selectionEnd ?? start;
    const insertion = `{{${token}}}`;
    const body = step.body.slice(0, start) + insertion + step.body.slice(end);
    pendingSelection.current = {
      index,
      body,
      start: start + insertion.length,
      end: start + insertion.length,
    };
    update(index, { body });
  };
  const formatSelection = (index: number, marker: string) => {
    const input = inputs.current[index],
      step = draft.steps[index],
      start = input?.selectionStart ?? step.body.length,
      end = input?.selectionEnd ?? start,
      selected = step.body.slice(start, end) || "text";
    const content =
      marker === "list" || marker === "numbered"
        ? selected
            .split("\n")
            .map(
              (line, i) => `${marker === "list" ? "-" : `${i + 1}.`} ${line}`,
            )
            .join("\n")
        : `${marker}${selected}${marker}`;
    const body = step.body.slice(0, start) + content + step.body.slice(end);
    pendingSelection.current = {
      index,
      body,
      start,
      end: start + content.length,
    };
    update(index, { body, format: "formatted" });
  };
  const editLink = (index: number) => {
    const input = inputs.current[index],
      start = input?.selectionStart ?? draft.steps[index].body.length,
      end = input?.selectionEnd ?? start;
    setLinkEditing({
      index,
      start,
      end,
      label: draft.steps[index].body.slice(start, end) || "Learn more",
      url: "",
    });
  };
  if (!id)
    return (
      <div className="sequence-list">
        <div className="sequence-list-head">
          <div>
            <h1>Sequences</h1>
            <p>Personal outreach, thoughtfully timed.</p>
          </div>
          <Link className="btn" to="/app/sequences/new">
            <Plus size={16} />
            New sequence
          </Link>
        </div>
        <div className="sequence-metrics">
          {(
            [
              ["sent", "Sent"],
              ["opened", "Opened"],
              ["bounced", "Bounced"],
              ["replied", "Replied"],
            ] as const
          ).map(([key, label]) => (
            <section key={key}>
              <span>{label}</span>
              <strong>{overview?.metrics[key] ?? 0}</strong>
              <div className="sequence-metric-line" />
              <small>
                {key === "replied"
                  ? "Replies recorded by your team"
                  : key === "opened"
                    ? "Provider-confirmed opens or clicks"
                    : "Provider-confirmed activity"}
              </small>
            </section>
          ))}
        </div>
        <ErrorBanner error={error} />
        <div className="sequence-list-toolbar">
          <label>
            <Search size={17} />
            <input
              aria-label="Search sequences"
              placeholder="Search sequence name"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <select
            aria-label="Filter sequences"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          >
            <option value="all">All sequences</option>
            <option value="enrolled">With enrolled candidates</option>
            <option value="empty">Without candidates</option>
          </select>
        </div>
        {!overview && !error ? (
          <Loading />
        ) : (
          <div className="sequence-library">
            {overview?.items
              .filter(
                (item) =>
                  String(item.name)
                    .toLowerCase()
                    .includes(search.toLowerCase()) &&
                  (filter === "all" ||
                    (filter === "enrolled"
                      ? !!item.enrolledCandidateIds?.length
                      : !item.enrolledCandidateIds?.length)),
              )
              .map((item) => (
                <article key={item.id}>
                  <Link to={`/app/sequences/${item.id}`}>
                    <Mail size={20} />
                    <div>
                      <strong>{item.name}</strong>
                      <p>{item.description || "Outreach sequence"}</p>
                    </div>
                  </Link>
                  <span>{item.steps?.length || 0} steps</span>
                  <span>{item.enrolledCandidateIds?.length || 0} enrolled</span>
                  <button
                    aria-label={`Delete ${item.name}`}
                    onClick={() => setDeleteId(item.id)}
                  >
                    <Trash2 size={16} />
                  </button>
                </article>
              ))}
            {overview && !overview.items.length && (
              <div className="sequence-list-empty">
                <Mail size={30} />
                <h2>Create your first sequence</h2>
                <p>
                  Build email and manual outreach steps, or ask the agent to
                  draft them.
                </p>
                <Link className="btn" to="/app/sequences/new">
                  New sequence
                </Link>
              </div>
            )}
          </div>
        )}
        {deleteId && (
          <Modal title="Delete sequence?" onClose={() => setDeleteId(null)}>
            <p>
              This removes the sequence and cancels its remaining schedule.
              Candidate records remain.
            </p>
            <Button
              busy={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api(`sequences/${deleteId}`, { method: "DELETE" });
                  setDeleteId(null);
                  await reload();
                } catch (error) {
                  setError(errorText(error));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Delete sequence
            </Button>
          </Modal>
        )}
      </div>
    );
  if (loading) return <Loading />;
  if (id !== "new" && !revision)
    return (
      <div className="sequence-list">
        <ErrorBanner error={error} />
        <Link to="/app/sequences">Back to sequences</Link>
      </div>
    );
  return (
    <div className={`sequence-workspace ${agentOpen ? "" : "agent-collapsed"}`}>
      <header className="sequence-breadcrumb">
        <Link to="/app/sequences">
          <Mail size={17} />
          Sequences
        </Link>
        <span>/</span>
        <strong>{draft.name || "New Sequence"}</strong>
        <span className="sequence-save-state">
          {id === "new"
            ? "Unsaved draft"
            : dirty
              ? "Unsaved changes"
              : "Saved draft"}
        </span>
      </header>
      <div className="sequence-main">
        <div className="sequence-editor">
          <div className="sequence-editor-toolbar">
            <div role="tablist" aria-label="Sequence editor">
              <button
                role="tab"
                aria-selected={tab === "steps"}
                onClick={() => setTab("steps")}
              >
                <GripVertical size={16} />
                Steps
              </button>
              <button
                role="tab"
                aria-selected={tab === "settings"}
                onClick={() => setTab("settings")}
              >
                <Settings2 size={16} />
                Settings
              </button>
            </div>
            <Button
              disabled={!draft.name.trim()}
              busy={busy}
              onClick={() => void save()}
            >
              Save sequence
            </Button>
            {!agentOpen && (
              <button
                aria-label="Open agent"
                onClick={() => setAgentOpen(true)}
              >
                <PanelRightOpen size={18} />
              </button>
            )}
          </div>
          <fieldset disabled={busy} className="sequence-editor-content">
            <ErrorBanner error={error} />
            {notice && (
              <p className="sequence-notice" role="status">
                <Check size={15} />
                {notice}
              </p>
            )}
            {tab === "steps" ? (
              <>
                <section className="sequence-title-card">
                  <Field label="Sequence title">
                    <input
                      value={draft.name}
                      maxLength={200}
                      placeholder="Sequence name"
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          name: event.target.value,
                        }))
                      }
                    />
                  </Field>
                </section>
                {draft.steps.map((step, index) => (
                  <section className="sequence-step-card" key={index}>
                    <div className="sequence-step-header">
                      <GripVertical size={16} />
                      <Mail size={16} />
                      <span>Step {index + 1}</span>
                      <select
                        aria-label={`Step ${index + 1} type`}
                        value={step.kind}
                        onChange={(event) =>
                          update(index, {
                            kind: event.target.value as Kind,
                            ...(event.target.value !== "email"
                              ? { cc: [], bcc: [] }
                              : {}),
                          })
                        }
                      >
                        {Object.entries(kinds).map(([key, label]) => (
                          <option key={key} value={key}>
                            {label}
                          </option>
                        ))}
                        <option disabled>
                          Automatic WhatsApp · not connected
                        </option>
                      </select>
                      <label className="sequence-timing">
                        <Clock3 size={14} />
                        <span>Send</span>
                        <select
                          aria-label={`Step ${index + 1} delay`}
                          value={step.delayDays}
                          onChange={(event) =>
                            update(index, {
                              delayDays: Number(event.target.value),
                            })
                          }
                        >
                          {[
                            ...new Set([
                              ...(index === 0 ? [0] : []),
                              1,
                              2,
                              3,
                              5,
                              7,
                              14,
                              30,
                              step.delayDays,
                            ]),
                          ]
                            .sort((a, b) => a - b)
                            .map((day) => (
                              <option key={day} value={day}>
                                {day === 0
                                  ? "Immediately"
                                  : `After ${day} day${day === 1 ? "" : "s"}`}
                              </option>
                            ))}
                        </select>
                      </label>
                      <button
                        disabled={!index}
                        aria-label={`Move step ${index + 1} up`}
                        onClick={() =>
                          setDraft((current) => {
                            const steps = [...current.steps];
                            [steps[index - 1], steps[index]] = [
                              steps[index],
                              steps[index - 1],
                            ];
                            return {
                              ...current,
                              steps: steps.map((value, i) => ({
                                ...value,
                                delayDays:
                                  i === 0
                                    ? value.delayDays
                                    : Math.max(value.delayDays, 1),
                              })),
                            };
                          })
                        }
                      >
                        <ArrowUp size={14} />
                      </button>
                      <button
                        disabled={index === draft.steps.length - 1}
                        aria-label={`Move step ${index + 1} down`}
                        onClick={() =>
                          setDraft((current) => {
                            const steps = [...current.steps];
                            [steps[index + 1], steps[index]] = [
                              steps[index],
                              steps[index + 1],
                            ];
                            return {
                              ...current,
                              steps: steps.map((value, i) => ({
                                ...value,
                                delayDays:
                                  i === 0
                                    ? value.delayDays
                                    : Math.max(value.delayDays, 1),
                              })),
                            };
                          })
                        }
                      >
                        <ArrowDown size={14} />
                      </button>
                      <button
                        disabled={draft.steps.length === 1}
                        aria-label={`Remove step ${index + 1}`}
                        onClick={() =>
                          setDraft((current) => ({
                            ...current,
                            steps: current.steps.filter((_, i) => i !== index),
                          }))
                        }
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                    <div className="sequence-step-tabs">
                      <button
                        className={!previews.includes(index) ? "active" : ""}
                        onClick={() =>
                          setPreviews((current) =>
                            current.filter((i) => i !== index),
                          )
                        }
                      >
                        <Pencil size={14} />
                        Edit
                      </button>
                      <button
                        className={previews.includes(index) ? "active" : ""}
                        onClick={() =>
                          setPreviews((current) => [...current, index])
                        }
                      >
                        <Eye size={14} />
                        Preview
                      </button>
                    </div>
                    {previews.includes(index) ? (
                      <div className="sequence-step-preview">
                        <Field label="Preview as candidate">
                          <select
                            value={previewCandidate}
                            onChange={(event) =>
                              setPreviewCandidate(event.target.value)
                            }
                          >
                            <option value="">Example placeholders</option>
                            {candidates.map((person) => (
                              <option key={person.id} value={person.id}>
                                {person.name}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <strong>
                          {personalize(step.subject) ||
                            (sequenceRequiresSubject(step.kind)
                              ? "No subject yet"
                              : "Manual task")}
                        </strong>
                        {step.format === "formatted" ? (
                          <div
                            className="sequence-formatted-preview"
                            dangerouslySetInnerHTML={{
                              __html: renderEmailMarkup(step.body, personalize)
                                .html,
                            }}
                          />
                        ) : (
                          <p>
                            {personalize(step.body) ||
                              "Write a message to preview it here."}
                          </p>
                        )}
                        {!!step.cc?.length && (
                          <p>
                            <small>Cc: {step.cc.join(", ")}</small>
                          </p>
                        )}
                        {!!step.bcc?.length && (
                          <p>
                            <small>
                              Bcc: {step.bcc.join(", ")} (hidden from other
                              recipients)
                            </small>
                          </p>
                        )}
                        <small>
                          {step.kind === "email"
                            ? "Delivery preview will show the final recipient and unsubscribe link."
                            : "Manual task: complete outside ArkOffer, then confirm in Delivery to continue."}
                        </small>
                      </div>
                    ) : (
                      <div className="sequence-step-fields">
                        <div className="sequence-subject-row">
                          <Field
                            label={
                              sequenceRequiresSubject(step.kind)
                                ? "Subject"
                                : "Task title (optional)"
                            }
                          >
                            <input
                              aria-label={`Step ${index + 1} subject`}
                              maxLength={200}
                              value={step.subject}
                              placeholder={
                                sequenceRequiresSubject(step.kind)
                                  ? "Enter message subject here"
                                  : "Optional label for this task"
                              }
                              onChange={(event) =>
                                update(index, { subject: event.target.value })
                              }
                            />
                          </Field>
                          <Field label="Type">
                            <select
                              disabled
                              title="Reply-thread delivery is not available yet"
                            >
                              <option>New thread</option>
                            </select>
                          </Field>
                        </div>
                        {step.kind === "email" && (
                          <>
                            <Field label="From">
                              <select disabled>
                                <option>
                                  {overview?.sender ||
                                    "Local outbox — no delivery"}
                                </option>
                              </select>
                            </Field>
                            <div className="sequence-copy-row">
                              <Field label="Cc">
                                <input
                                  key={`cc-${index}-${(step.cc || []).join()}`}
                                  aria-label={`Step ${index + 1} Cc`}
                                  defaultValue={(step.cc || []).join(", ")}
                                  placeholder="Add email addresses"
                                  onBlur={(event) =>
                                    update(index, {
                                      cc: event.target.value
                                        .split(/[,;\n]/)
                                        .map((value) => value.trim())
                                        .filter(Boolean),
                                    })
                                  }
                                />
                              </Field>
                              <Field label="Bcc">
                                <input
                                  key={`bcc-${index}-${(step.bcc || []).join()}`}
                                  aria-label={`Step ${index + 1} Bcc`}
                                  defaultValue={(step.bcc || []).join(", ")}
                                  placeholder="Add email addresses"
                                  onBlur={(event) =>
                                    update(index, {
                                      bcc: event.target.value
                                        .split(/[,;\n]/)
                                        .map((value) => value.trim())
                                        .filter(Boolean),
                                    })
                                  }
                                />
                              </Field>
                            </div>
                          </>
                        )}
                        {step.kind !== "email" && (
                          <p className="sequence-manual-note">
                            This creates a manual task. ArkOffer waits for your
                            completion before continuing; it does not send{" "}
                            {step.kind.startsWith("linkedin")
                              ? "LinkedIn messages"
                              : step.kind === "sms"
                                ? "text messages"
                                : step.kind === "call"
                                  ? "calls"
                                  : "this message"}
                            .
                          </p>
                        )}
                        <Field
                          label={
                            step.kind === "email"
                              ? "Body"
                              : "Message or instructions"
                          }
                        >
                          <textarea
                            ref={(element) => {
                              inputs.current[index] = element;
                            }}
                            aria-label={`Step ${index + 1} body`}
                            value={step.body}
                            maxLength={5000}
                            rows={6}
                            placeholder="Start drafting your message here"
                            onChange={(event) =>
                              update(index, { body: event.target.value })
                            }
                          />
                        </Field>
                        <div className="sequence-prompt-chips">
                          <p>
                            <strong>Prompts</strong> · Add personalized content
                          </p>
                          <button onClick={() => addToken(index, "firstName")}>
                            Greeting
                          </button>
                          {Object.entries(fields).map(([label, key]) => (
                            <button
                              key={key}
                              onClick={() => addToken(index, key)}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                        <div
                          className="sequence-format-toolbar"
                          role="toolbar"
                          aria-label={`Step ${index + 1} formatting`}
                        >
                          <select
                            aria-label={`Step ${index + 1} message format`}
                            value={step.format || "plain"}
                            onChange={(event) =>
                              update(index, {
                                format: event.target.value as
                                  "plain" | "formatted",
                              })
                            }
                          >
                            <option value="plain">Plain text</option>
                            <option value="formatted">Formatted</option>
                          </select>
                          <button
                            aria-label={`Bold step ${index + 1} selection`}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => formatSelection(index, "**")}
                          >
                            <Bold size={16} />
                          </button>
                          <button
                            aria-label={`Italic step ${index + 1} selection`}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => formatSelection(index, "_")}
                          >
                            <Italic size={16} />
                          </button>
                          <button
                            aria-label={`Strikethrough step ${index + 1} selection`}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => formatSelection(index, "~~")}
                          >
                            <Strikethrough size={16} />
                          </button>
                          <button
                            aria-label={`Bullet list step ${index + 1}`}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => formatSelection(index, "list")}
                          >
                            <List size={16} />
                          </button>
                          <button
                            aria-label={`Numbered list step ${index + 1}`}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => formatSelection(index, "numbered")}
                          >
                            <ListOrdered size={16} />
                          </button>
                          <button
                            aria-label={`Add link to step ${index + 1}`}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => editLink(index)}
                          >
                            <LinkIcon size={16} />
                          </button>
                        </div>
                        <p className="sequence-format-note">
                          {step.format === "formatted"
                            ? "Formatting markers become styled text in Preview and delivery. A plain-text version is included."
                            : "Plain text · Use the toolbar to add formatting or a secure link."}
                          {step.kind === "email" &&
                            " Up to five Cc/Bcc addresses per step; all copies appear in delivery approval."}
                        </p>
                      </div>
                    )}
                  </section>
                ))}
                <div className="sequence-add-step">
                  <span />
                  <Button
                    variant="secondary"
                    disabled={draft.steps.length >= 10}
                    onClick={() =>
                      setDraft((current) => ({
                        ...current,
                        steps: [...current.steps, emptyStep()],
                      }))
                    }
                  >
                    <Plus size={16} />
                    New step
                  </Button>
                </div>
                <div className="sequence-bottom-actions">
                  <Button
                    variant="secondary"
                    onClick={() => setEnrolling(true)}
                  >
                    <Users size={16} />
                    Candidates ({draft.enrolledCandidateIds.length})
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={id === "new" || dirty}
                    onClick={() => setDelivery(true)}
                  >
                    <ArrowUpRight size={16} />
                    Review delivery
                  </Button>
                  <p>
                    Save your edits before reviewing recipients and launching a
                    schedule.
                  </p>
                </div>
              </>
            ) : (
              <section className="sequence-settings">
                <h2>Sequence settings</h2>
                <Field label="Description">
                  <textarea
                    rows={3}
                    maxLength={2000}
                    value={draft.description}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        description: event.target.value,
                      }))
                    }
                  />
                </Field>
                <h3>Contact details and enrollment</h3>
                <div className="sequence-source-settings">
                  <fieldset disabled>
                    <legend>Automatically find personal emails</legend>
                    <label>
                      <input
                        type="radio"
                        name="find-email"
                        checked={false}
                        readOnly
                      />
                      Enabled
                    </label>
                    <label>
                      <input type="radio" name="find-email" checked readOnly />
                      Disabled
                    </label>
                    <p>
                      A contact discovery provider and credits are required.
                      ArkOffer uses the email addresses already in your
                      candidate library.
                    </p>
                  </fieldset>
                  <fieldset disabled>
                    <legend>Automatically find phone numbers</legend>
                    <label>
                      <input
                        type="radio"
                        name="find-phone"
                        checked={false}
                        readOnly
                      />
                      Enabled
                    </label>
                    <label>
                      <input type="radio" name="find-phone" checked readOnly />
                      Disabled
                    </label>
                    <p>
                      Phone discovery is not configured. You can save phone
                      numbers on candidate profiles.
                    </p>
                  </fieldset>
                  <fieldset disabled>
                    <legend>
                      Automatically enroll candidates as they are added
                    </legend>
                    <label>
                      <input
                        type="radio"
                        name="auto-enroll"
                        checked={false}
                        readOnly
                      />
                      Enabled
                    </label>
                    <label>
                      <input type="radio" name="auto-enroll" checked readOnly />
                      Disabled
                    </label>
                    <p>
                      New candidates remain drafts until you review recipients
                      and explicitly launch from Delivery.
                    </p>
                  </fieldset>
                </div>
                <h3>Sending window</h3>
                {!draft.settings ? (
                  <>
                    <p>
                      This existing sequence uses its original schedule without
                      time-of-day restrictions.
                    </p>
                    <Button
                      variant="secondary"
                      onClick={() =>
                        setDraft((current) => ({
                          ...current,
                          settings: defaultSettings(),
                        }))
                      }
                    >
                      Set sending window
                    </Button>
                  </>
                ) : (
                  <>
                    <Field label="Time zone">
                      <input
                        value={draft.settings.timezone}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            settings: {
                              ...current.settings!,
                              timezone: event.target.value,
                            },
                          }))
                        }
                      />
                    </Field>
                    <div className="sequence-weekdays">
                      {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(
                        (day, i) => (
                          <label key={day}>
                            <input
                              type="checkbox"
                              checked={draft.settings!.weekdays.includes(i)}
                              onChange={(event) =>
                                setDraft((current) => ({
                                  ...current,
                                  settings: {
                                    ...current.settings!,
                                    weekdays: event.target.checked
                                      ? [...current.settings!.weekdays, i]
                                      : current.settings!.weekdays.filter(
                                          (value) => value !== i,
                                        ),
                                  },
                                }))
                              }
                            />
                            {day}
                          </label>
                        ),
                      )}
                    </div>
                    <div className="sequence-copy-row">
                      <Field label="Start hour">
                        <input
                          type="number"
                          min={0}
                          max={23}
                          value={draft.settings.startHour}
                          onChange={(event) =>
                            setDraft((current) => ({
                              ...current,
                              settings: {
                                ...current.settings!,
                                startHour: Number(event.target.value),
                              },
                            }))
                          }
                        />
                      </Field>
                      <Field label="End hour">
                        <input
                          type="number"
                          min={1}
                          max={24}
                          value={draft.settings.endHour}
                          onChange={(event) =>
                            setDraft((current) => ({
                              ...current,
                              settings: {
                                ...current.settings!,
                                endHour: Number(event.target.value),
                              },
                            }))
                          }
                        />
                      </Field>
                    </div>
                    <p>
                      Due steps wait for this window in the selected time zone,
                      including daylight saving changes. The schedule is locked
                      when you launch.
                    </p>
                  </>
                )}
                <h3>Replies and unsubscribes</h3>
                <p>
                  Mark a candidate as replied in Delivery to stop their
                  remaining steps. Unsubscribes and provider-reported bounces
                  automatically suppress further email. Inbox reply detection is
                  not connected.
                </p>
                <h3>Sending account</h3>
                <p>
                  {overview?.sender}. Sender connections, reply threading, file
                  attachments and advanced email layouts are not available in
                  this editor yet.
                </p>
              </section>
            )}
          </fieldset>
        </div>
        {agentOpen && (
          <aside className="sequence-agent">
            <header>
              <span className="sequence-agent-orb" />
              Agent
              <button
                aria-label="Close agent"
                onClick={() => setAgentOpen(false)}
              >
                <PanelRightClose size={18} />
              </button>
            </header>
            <div
              className={`sequence-agent-content ${proposal ? "has-proposal" : ""}`}
            >
              <div className="sequence-agent-intro">
                <h2>Ready to engage your candidates?</h2>
                <p>
                  Describe the outreach you have in mind. Review the agent’s
                  steps before adding them to your draft.
                </p>
              </div>
              {proposal?.result && (
                <section className="sequence-proposal">
                  <h3>{proposal.result.name}</h3>
                  {proposal.result.steps.map((step, index) => (
                    <article key={index}>
                      <small>
                        {index + 1} · {kinds[step.kind]} · {step.delayDays} days
                      </small>
                      <strong>{step.subject}</strong>
                      <p>{step.body}</p>
                    </article>
                  ))}
                  {!!proposal.result.notes.length && (
                    <ul>
                      {proposal.result.notes.map((note, index) => (
                        <li key={index}>{note}</li>
                      ))}
                    </ul>
                  )}
                  <Button
                    disabled={
                      !proposal.sourceCurrent ||
                      proposalSource !== JSON.stringify(draft)
                    }
                    onClick={() => {
                      setDraft((current) => ({
                        ...current,
                        name: proposal.result!.name,
                        description: proposal.result!.description,
                        steps: proposal.result!.steps,
                      }));
                      setProposal(null);
                      setNotice(
                        "Agent draft applied to the editor. Review it and save when ready.",
                      );
                    }}
                  >
                    Apply draft to editor
                  </Button>
                  {proposalSource !== JSON.stringify(draft) && (
                    <p>
                      Your editor changed. Generate a new draft to preserve
                      these edits.
                    </p>
                  )}
                </section>
              )}
              <form
                className="sequence-agent-composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  void generate();
                }}
              >
                <textarea
                  aria-label="Sequence agent instructions"
                  value={instruction}
                  maxLength={10000}
                  rows={3}
                  placeholder="Start with a LinkedIn message, then follow up by email…"
                  onChange={(event) => setInstruction(event.target.value)}
                />
                <footer>
                  <span>
                    <Sparkles size={16} />
                    Private draft
                  </span>
                  <button
                    aria-label="Generate sequence draft"
                    type="submit"
                    disabled={
                      !overview?.aiAvailable ||
                      !instruction.trim() ||
                      generating ||
                      busy
                    }
                  >
                    {generating ? <span>…</span> : <ArrowUp size={19} />}
                  </button>
                </footer>
              </form>
              {!overview?.aiAvailable && (
                <p className="sequence-agent-availability">
                  AI drafting needs a configured model and workspace access. You
                  can create and save steps manually.
                </p>
              )}
              {generating && (
                <Button
                  variant="secondary"
                  onClick={() => controller.current?.abort()}
                >
                  Stop generation
                </Button>
              )}
              {!!history.length && (
                <details className="sequence-agent-history">
                  <summary>Private draft history ({history.length})</summary>
                  {history.map((item) => (
                    <button
                      key={item.id}
                      disabled={
                        item.status !== "ready" ||
                        !item.result ||
                        !item.sourceCurrent
                      }
                      onClick={() => {
                        setProposal(item);
                        setProposalSource(JSON.stringify(draft));
                      }}
                    >
                      {item.result?.name || "Draft"} · {item.status}
                    </button>
                  ))}
                </details>
              )}
            </div>
          </aside>
        )}
      </div>
      {linkEditing && (
        <Modal title="Insert secure link" onClose={() => setLinkEditing(null)}>
          <Field label="Link text">
            <input
              value={linkEditing.label}
              maxLength={1000}
              onChange={(event) =>
                setLinkEditing((current) =>
                  current ? { ...current, label: event.target.value } : null,
                )
              }
            />
          </Field>
          <Field label="HTTPS address">
            <input
              type="url"
              value={linkEditing.url}
              placeholder="https://example.com/careers"
              onChange={(event) =>
                setLinkEditing((current) =>
                  current ? { ...current, url: event.target.value } : null,
                )
              }
            />
          </Field>
          <p>
            Only HTTPS links without embedded account credentials are supported.
          </p>
          <Button
            disabled={
              !safeEmailLink(linkEditing.url) ||
              !linkEditing.label.trim() ||
              /[\[\]\n]/.test(linkEditing.label)
            }
            onClick={() => {
              const { index, start, end, label, url } = linkEditing;
              update(index, {
                body:
                  draft.steps[index].body.slice(0, start) +
                  `[${label}](${safeEmailLink(url)})` +
                  draft.steps[index].body.slice(end),
                format: "formatted",
              });
              setLinkEditing(null);
            }}
          >
            Insert link
          </Button>
        </Modal>
      )}
      {enrolling && (
        <Modal title="Enroll candidates" onClose={() => setEnrolling(false)}>
          <p>
            Choose candidates for this draft. Enrollment is saved with the
            sequence; it never starts delivery.
          </p>
          <ErrorBanner error={candidateError} />
          {candidateLoading ? (
            <Loading />
          ) : (
            <div className="sequence-candidate-list">
              {candidates.map((person) => (
                <label key={person.id}>
                  <input
                    type="checkbox"
                    checked={draft.enrolledCandidateIds.includes(person.id)}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        enrolledCandidateIds: event.target.checked
                          ? [...current.enrolledCandidateIds, person.id]
                          : current.enrolledCandidateIds.filter(
                              (value) => value !== person.id,
                            ),
                      }))
                    }
                  />
                  <span>
                    <strong>{person.name}</strong>
                    <small>{person.email || "No email saved"}</small>
                  </span>
                </label>
              ))}
            </div>
          )}
          <Button onClick={() => setEnrolling(false)}>Done</Button>
        </Modal>
      )}
      {delivery && id !== "new" && (
        <SequenceDelivery sequenceId={id} onClose={() => setDelivery(false)} />
      )}
    </div>
  );
}
