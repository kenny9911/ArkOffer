import { useEffect, useState, type ReactNode, type KeyboardEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  Copy,
  FileText,
  Layers,
  Mail,
  Play,
  Plus,
  ScanFace,
  Settings,
  Sparkles,
  Trash2,
  Users,
} from "lucide-react";
import { api, json, Button, ErrorBanner, Field, Modal } from "../ui";
import ScreeningDrafting, { type ScreeningProposal } from "./ScreeningDrafting";
import ScreeningOutreach from "./ScreeningOutreach";
import {
  newScreeningConfig,
  screeningMessage,
  type ScreeningConfig,
  type ScreeningItem,
  type ScreeningQuestion,
} from "../../shared/screening";
import "./screening-workspace.css";

type Props = {
  renderPublication?: (item: ScreeningItem, onClose: () => void) => ReactNode;
  renderResponses?: (item: ScreeningItem, onClose: () => void) => ReactNode;
  renderCandidates?: (
    item: ScreeningItem,
    onPublish: () => void,
    onDirty: (dirty: boolean) => void,
  ) => ReactNode;
};
type Editor = {
  title: string;
  description: string;
  jobId: string;
  screeningConfig: ScreeningConfig;
};
const blank = (): Editor => ({
  title: "New screening",
  description: "",
  jobId: "",
  screeningConfig: newScreeningConfig(),
});
const question = (): ScreeningQuestion => ({
  id: crypto.randomUUID(),
  prompt: "",
  type: "text",
  options: [],
  required: true,
  rubric: "",
  followUp: true,
});
const languages = [
  ["en-US", "English (United States)"],
  ["en-GB", "English (United Kingdom)"],
  ["es-ES", "Spanish"],
  ["fr-FR", "French"],
  ["de-DE", "German"],
  ["pt-BR", "Portuguese (Brazil)"],
  ["zh-CN", "Chinese (Mandarin)"],
  ["ja-JP", "Japanese"],
];
function moved<T>(items: T[], index: number, direction: number) {
  const result = [...items],
    target = index + direction;
  if (target >= 0 && target < result.length)
    [result[index], result[target]] = [result[target], result[index]];
  return result;
}
function tabKeys(event: KeyboardEvent<HTMLElement>) {
  if (
    ![
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "Home",
      "End",
    ].includes(event.key)
  )
    return;
  const tabs = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>(
      '[role="tab"]:not(:disabled)',
    ),
  );
  const index = tabs.indexOf(document.activeElement as HTMLButtonElement);
  if (index < 0 || !tabs.length) return;
  event.preventDefault();
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (index +
            (["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1) +
            tabs.length) %
          tabs.length;
  tabs[next].focus();
  tabs[next].click();
}

export default function ScreeningWorkspace({
  renderPublication,
  renderResponses,
  renderCandidates,
}: Props) {
  const location = useLocation(),
    navigate = useNavigate();
  const routeId = location.pathname.split("/")[3];
  const [items, setItems] = useState<ScreeningItem[]>([]),
    [jobs, setJobs] = useState<Array<{ id: string; title: string }>>([]);
  const [item, setItem] = useState<ScreeningItem | null>(null),
    [editor, setEditor] = useState<Editor>(blank);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [manual, setManual] = useState(false),
    [dirty, setDirty] = useState(false),
    [candidateDirty, setCandidateDirty] = useState(false),
    [outreachDirty, setOutreachDirty] = useState(false),
    [query, setQuery] = useState("");
  const [panel, setPanel] = useState<
    "setup" | "interview" | "context" | "outreach"
  >("interview");
  const [side, setSide] = useState<"preview" | "agent">("preview");
  const [preview, setPreview] = useState(false),
    [publishing, setPublishing] = useState(false),
    [responses, setResponses] = useState(false);
  const [voices, setVoices] = useState<Array<{ name: string; lang: string }>>(
    [],
  );
  const [liveStatus, setLiveStatus] = useState<{
    available: boolean;
    missing: string[];
    recording: boolean;
  } | null>(null);
  const [liveError, setLiveError] = useState("");
  const [recordingStatus, setRecordingStatus] = useState<{
    available: boolean;
    missing: string[];
  } | null>(null);
  const [recordingError, setRecordingError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    api<{ available: boolean; missing: string[]; recording: boolean }>(
      "live-interviews/status",
      { signal: abort.signal },
    )
      .then((status) => {
        if (!abort.signal.aborted) setLiveStatus(status);
      })
      .catch((cause) => {
        if (!abort.signal.aborted) setLiveError(cause.message);
      });
    api<{ available: boolean; missing: string[] }>(
      "screening-recordings/status",
      { signal: abort.signal },
    )
      .then((status) => {
        if (!abort.signal.aborted) setRecordingStatus(status);
      })
      .catch((cause) => {
        if (!abort.signal.aborted) setRecordingError(cause.message);
      });
    return () => abort.abort();
  }, []);
  const candidates =
    new URLSearchParams(location.search).get("tab") === "candidates";
  const isNew = routeId === "new",
    isEditor = !!routeId && (!isNew || manual);
  useEffect(() => {
    const abort = new AbortController();
    Promise.all([
      api<{ items: ScreeningItem[] }>("screening-workspaces", {
        signal: abort.signal,
      }),
      api<{ items: Array<{ id: string; title: string }> }>("jobs", {
        signal: abort.signal,
      }),
      routeId && routeId !== "new"
        ? api<{ item: ScreeningItem }>(
            `screening-workspaces/${encodeURIComponent(routeId)}`,
            { signal: abort.signal },
          )
        : Promise.resolve(null),
    ])
      .then(([list, roles, detail]) => {
        if (abort.signal.aborted) return;
        setItems(list.items);
        setJobs(roles.items);
        if (detail) {
          setItem(detail.item);
          setEditor(detail.item);
        }
        setLoading(false);
      })
      .catch((cause) => {
        if (!abort.signal.aborted) {
          setError(cause.message);
          setLoading(false);
        }
      });
    return () => abort.abort();
  }, [routeId]);
  useEffect(() => {
    if (!dirty && !outreachDirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, outreachDirty]);
  useEffect(() => {
    const speech = window.speechSynthesis;
    const refresh = () =>
      setVoices(
        speech
          ?.getVoices()
          .filter((voice) => voice.localService)
          .map(({ name, lang }) => ({ name, lang })) || [],
      );
    refresh();
    speech?.addEventListener("voiceschanged", refresh);
    return () => speech?.removeEventListener("voiceschanged", refresh);
  }, []);
  function change(update: Partial<Editor>) {
    setEditor((current) => ({ ...current, ...update }));
    setDirty(true);
  }
  function config(update: Partial<ScreeningConfig>) {
    setEditor((current) => ({
      ...current,
      screeningConfig: { ...current.screeningConfig, ...update },
    }));
    setDirty(true);
  }
  function sections(update: ScreeningConfig["sections"]) {
    config({ sections: update });
  }
  function updateSection(
    index: number,
    update: Partial<ScreeningConfig["sections"][number]>,
  ) {
    sections(
      editor.screeningConfig.sections.map((section, i) =>
        i === index ? { ...section, ...update } : section,
      ),
    );
  }
  function updateQuestion(
    sectionIndex: number,
    questionIndex: number,
    update: Partial<ScreeningQuestion>,
  ) {
    updateSection(sectionIndex, {
      questions: editor.screeningConfig.sections[sectionIndex].questions.map(
        (q, i) => (i === questionIndex ? { ...q, ...update } : q),
      ),
    });
  }
  async function save() {
    if (busy) return null;
    setBusy(true);
    setError("");
    try {
      const body = {
        title: editor.title,
        description: editor.description,
        jobId: editor.jobId,
        screeningConfig: editor.screeningConfig,
        ...(item ? { revision: item.updatedAt } : {}),
      };
      const result = await api<{ item: ScreeningItem }>(
        `screening-workspaces${item ? `/${item.id}` : ""}`,
        json(item ? "PATCH" : "POST", body),
      );
      setItem(result.item);
      setEditor(result.item);
      setDirty(false);
      if (!item)
        navigate(`/app/screening/${result.item.id}?tab=builder`, {
          replace: true,
        });
      return result.item;
    } catch (cause) {
      setError((cause as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }
  function useProposal(proposal: ScreeningProposal) {
    const next = newScreeningConfig();
    next.sections[0].questions = proposal.questions.map((q) => ({
      ...q,
      id: crypto.randomUUID(),
      followUp: true,
    }));
    setEditor((current) => ({
      ...current,
      title: proposal.title,
      description: proposal.description,
      jobId: proposal.jobId || "",
      screeningConfig: { ...current.screeningConfig, sections: next.sections },
    }));
    setManual(true);
    setDirty(true);
    setPanel("interview");
    setSide("preview");
  }
  const questions = editor.screeningConfig.sections.flatMap(
    (section) => section.questions,
  );
  const previewContent = <ScreeningPreview editor={editor} />;
  if (loading)
    return (
      <div className="screen-workspace screen-loading" role="status">
        Loading screenings…
      </div>
    );
  if (routeId && !isNew && !item)
    return (
      <div className="screen-workspace">
        <ErrorBanner error={error || "Screening not found."} />
        <Link to="/app/screening">Back to screenings</Link>
      </div>
    );
  if (!routeId)
    return (
      <div className="screen-workspace screen-list">
        <div className="screen-list-heading">
          <div>
            <h1>Screening</h1>
            <p>Build an interview. Hear every candidate’s story.</p>
          </div>
          <Link className="btn" to="/app/screening/new">
            <Plus size={16} /> New screening
          </Link>
        </div>
        <ErrorBanner error={error} />
        <div className="screen-list-tools">
          <input
            aria-label="Search screenings"
            placeholder="Search screenings"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <span>{items.length} screenings</span>
        </div>
        {items.length ? (
          <div className="screen-table">
            <div className="screen-table-head">
              <span>Screening</span>
              <span>Questions</span>
              <span>Last updated</span>
              <span />
            </div>
            {items
              .filter((row) =>
                String(row.title).toLowerCase().includes(query.toLowerCase()),
              )
              .map((row) => (
                <div className="screen-table-row" key={row.id}>
                  <Link to={`/app/screening/${row.id}?tab=builder`}>
                    <ScanFace size={18} />
                    <strong>{row.title}</strong>
                    <small>Draft</small>
                  </Link>
                  <span>
                    {Array.isArray(row.questions) ? row.questions.length : 0}
                  </span>
                  <span>{new Date(row.updatedAt).toLocaleDateString()}</span>
                  <button
                    aria-label={`Delete ${row.title}`}
                    onClick={async () => {
                      if (
                        !window.confirm(
                          `Delete ${row.title}, its links and responses?`,
                        )
                      )
                        return;
                      try {
                        await api(`screenings/${row.id}`, { method: "DELETE" });
                        setItems((current) =>
                          current.filter((entry) => entry.id !== row.id),
                        );
                      } catch (cause) {
                        setError((cause as Error).message);
                      }
                    }}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
          </div>
        ) : (
          <div className="screen-empty">
            <ScanFace size={36} />
            <h2>A great hire starts with a great conversation.</h2>
            <p>Create your first screening for the role you’re hiring.</p>
            <Link className="btn" to="/app/screening/new">
              Create screening
            </Link>
          </div>
        )}
      </div>
    );
  return (
    <div
      className={`screen-workspace ${isEditor ? "screen-editor" : "screen-new"}`}
    >
      <header className="screen-header">
        <Link
          to="/app/screening"
          onClick={(event) => {
            if (
              (dirty || candidateDirty || outreachDirty) &&
              !window.confirm(
                "Leave this screening without saving your changes?",
              )
            )
              event.preventDefault();
          }}
        >
          <ScanFace size={17} />
          Screening
        </Link>
        <ChevronRight size={15} />
        <span>{isEditor ? editor.title : "New screening"}</span>
        <div className="screen-header-actions">
          {isEditor ? (
            <>
              <span className="screen-save-state" role="status">
                {dirty ? "Unsaved changes" : "Draft saved"}
              </span>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => void save()}
              >
                Save draft
              </Button>
              {item && renderPublication && (
                <Button
                  disabled={
                    dirty ||
                    busy ||
                    questions.length === 0 ||
                    (editor.screeningConfig.setup.interviewMode === "live" &&
                      !liveStatus?.available) ||
                    (editor.screeningConfig.setup.recordingEnabled &&
                      !recordingStatus?.available)
                  }
                  onClick={() => setPublishing(true)}
                >
                  Publish
                </Button>
              )}
            </>
          ) : (
            <Button
              variant="secondary"
              onClick={() => {
                setManual(true);
                setDirty(true);
              }}
            >
              Start from scratch
            </Button>
          )}
        </div>
      </header>
      <ErrorBanner error={error} />
      {!isEditor ? (
        <div className="screen-new-body">
          <ScreeningDrafting
            inline
            jobs={jobs}
            onClose={() => navigate("/app/screening")}
            onUseDraft={useProposal}
          />
          <p className="screen-new-manual">
            Already know what to ask?{" "}
            <button
              onClick={() => {
                setManual(true);
                setDirty(true);
              }}
            >
              Create screening manually
            </button>
          </p>
        </div>
      ) : (
        <>
          <div className="screen-onboarding">
            {[
              ["1", "Draft your screening"],
              ["2", "Preview the experience"],
              ["3", "Share a candidate link"],
              ["4", "Review responses"],
            ].map(([number, title]) => (
              <div key={number}>
                <span>{number}</span>
                {title}
              </div>
            ))}
          </div>
          <nav
            className="screen-tabs"
            aria-label="Screening workspace"
            role="tablist"
            onKeyDown={tabKeys}
          >
            <button
              role="tab"
              aria-selected={!candidates}
              tabIndex={!candidates ? 0 : -1}
              className={!candidates ? "active" : ""}
              disabled={candidateDirty}
              onClick={() =>
                navigate(`${location.pathname}?tab=builder`, { replace: true })
              }
            >
              Builder
            </button>
            <button
              role="tab"
              aria-selected={candidates}
              tabIndex={candidates ? 0 : -1}
              className={candidates ? "active" : ""}
              disabled={!item || outreachDirty}
              onClick={() =>
                navigate(`${location.pathname}?tab=candidates`, {
                  replace: true,
                })
              }
            >
              <Users size={15} />
              Candidates
            </button>
          </nav>
          {candidates && item ? (
            <div className="screen-candidates">
              {renderCandidates ? (
                renderCandidates(
                  item,
                  () => setPublishing(true),
                  setCandidateDirty,
                )
              ) : (
                <>
                  <h2>Candidate responses</h2>
                  <p>View submissions and manage active candidate links.</p>
                  <Button onClick={() => setResponses(true)}>
                    Review responses
                  </Button>
                </>
              )}
            </div>
          ) : (
            <div className="screen-builder" inert={busy} aria-busy={busy}>
              <aside
                className="screen-builder-nav"
                role="tablist"
                aria-label="Builder settings"
                aria-orientation="vertical"
                onKeyDown={tabKeys}
              >
                {(
                  [
                    ["setup", "Setup", Settings],
                    ["interview", "Interview", Layers],
                    ["context", "Context", FileText],
                    ["outreach", "Outreach", Mail],
                  ] as const
                ).map(([key, label, Icon]) => (
                  <button
                    role="tab"
                    aria-selected={panel === key}
                    tabIndex={panel === key ? 0 : -1}
                    key={key}
                    className={panel === key ? "active" : ""}
                    onClick={() => setPanel(key)}
                  >
                    <Icon size={17} />
                    {label}
                  </button>
                ))}
              </aside>
              <main className="screen-builder-content">
                {panel === "setup" && (
                  <>
                    <div className="screen-section-title">
                      <h2>Setup</h2>
                      <p>
                        Make candidates feel welcome before the first question.
                      </p>
                    </div>
                    <div className="screen-card">
                      <Field label="Screening title">
                        <input
                          value={editor.title}
                          maxLength={300}
                          onChange={(event) =>
                            change({ title: event.target.value })
                          }
                        />
                      </Field>
                      <Field label="Job">
                        <select
                          value={editor.jobId}
                          onChange={(event) =>
                            change({ jobId: event.target.value })
                          }
                        >
                          <option value="">Any role</option>
                          {jobs.map((job) => (
                            <option key={job.id} value={job.id}>
                              {job.title}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label="Introduction for candidates">
                        <textarea
                          rows={3}
                          value={editor.description}
                          maxLength={5000}
                          onChange={(event) =>
                            change({ description: event.target.value })
                          }
                        />
                      </Field>
                    </div>
                    <div className="screen-card">
                      <h3>Interview experience</h3>
                      <Field label="Interview mode">
                        <select
                          value={editor.screeningConfig.setup.interviewMode}
                          onChange={(event) =>
                            config({
                              setup: {
                                ...editor.screeningConfig.setup,
                                interviewMode: event.target
                                  .value as ScreeningConfig["setup"]["interviewMode"],
                                recordingEnabled:
                                  event.target.value === "live" &&
                                  editor.screeningConfig.setup.recordingEnabled,
                              },
                            })
                          }
                        >
                          <option value="questionnaire">
                            Questionnaire with optional recorded answers
                          </option>
                          <option value="live">Live video interview</option>
                        </select>
                      </Field>
                      {editor.screeningConfig.setup.interviewMode ===
                        "live" && (
                        <>
                          <Field
                            label="Candidate camera"
                            hint="Microphone access is required for a live interview. Camera access follows this setting."
                          >
                            <select
                              value={editor.screeningConfig.setup.cameraPolicy}
                              onChange={(event) =>
                                config({
                                  setup: {
                                    ...editor.screeningConfig.setup,
                                    cameraPolicy: event.target
                                      .value as ScreeningConfig["setup"]["cameraPolicy"],
                                  },
                                })
                              }
                            >
                              <option value="optional">Optional</option>
                              <option value="required">Required</option>
                              <option value="off">Off</option>
                            </select>
                          </Field>
                          <p className="screen-hint" role="status">
                            {liveStatus?.available
                              ? "Candidates join a private live room, speak with the interviewer, and review their transcript before submitting. Eligible questions can include one adaptive follow-up."
                              : liveError
                                ? `Live interview setup could not be checked: ${liveError}`
                                : liveStatus
                                  ? `Live interviewing needs server setup: ${liveStatus.missing.join(", ")}. You can save this draft; publishing is available after setup.`
                                  : "Checking live interview setup…"}
                          </p>
                          <label className="check-row">
                            <input
                              type="checkbox"
                              checked={
                                editor.screeningConfig.setup.recordingEnabled
                              }
                              onChange={(event) =>
                                config({
                                  setup: {
                                    ...editor.screeningConfig.setup,
                                    recordingEnabled: event.target.checked,
                                  },
                                })
                              }
                            />
                            Record interview video and audio
                          </label>
                          <p className="screen-hint">
                            Candidates must consent before recording starts.
                            Recordings are private to your hiring workspace;
                            camera-off interviews capture audio only.
                          </p>
                          {editor.screeningConfig.setup.recordingEnabled && (
                            <>
                              <Field
                                label="Recording retention (days)"
                                hint="Recordings expire after 1–90 days and are then deleted from storage."
                              >
                                <input
                                  type="number"
                                  min={1}
                                  max={90}
                                  value={
                                    editor.screeningConfig.setup
                                      .recordingRetentionDays
                                  }
                                  onChange={(event) =>
                                    config({
                                      setup: {
                                        ...editor.screeningConfig.setup,
                                        recordingRetentionDays: Number(
                                          event.target.value,
                                        ),
                                      },
                                    })
                                  }
                                />
                              </Field>
                              <p className="screen-hint" role="status">
                                {recordingStatus?.available
                                  ? "Private recording storage is configured."
                                  : recordingError
                                    ? `Recording setup could not be checked: ${recordingError}`
                                    : recordingStatus
                                      ? `Recording needs server setup: ${recordingStatus.missing.join(", ")}. You can save this draft before setup is complete.`
                                      : "Checking recording setup…"}
                              </p>
                            </>
                          )}
                        </>
                      )}
                    </div>
                    <div className="screen-card">
                      <h3>Language and voice</h3>
                      <Field label="Spoken prompt language">
                        <select
                          value={editor.screeningConfig.setup.language}
                          onChange={(event) =>
                            config({
                              setup: {
                                ...editor.screeningConfig.setup,
                                language: event.target
                                  .value as ScreeningConfig["setup"]["language"],
                              },
                            })
                          }
                        >
                          {languages.map(([code, name]) => (
                            <option value={code} key={code}>
                              {name}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field
                        label="Local browser voice"
                        hint="Candidates use an available local voice in this language. Their device may have different voices."
                      >
                        <select
                          value={editor.screeningConfig.setup.voice}
                          onChange={(event) =>
                            config({
                              setup: {
                                ...editor.screeningConfig.setup,
                                voice: event.target.value,
                              },
                            })
                          }
                        >
                          <option value="">Automatic local voice</option>
                          {voices
                            .filter((voice) =>
                              voice.lang
                                .toLowerCase()
                                .startsWith(
                                  editor.screeningConfig.setup.language.split(
                                    "-",
                                  )[0],
                                ),
                            )
                            .map((voice) => (
                              <option key={voice.name}>{voice.name}</option>
                            ))}
                          {editor.screeningConfig.setup.voice &&
                            !voices.some(
                              (voice) =>
                                voice.name ===
                                editor.screeningConfig.setup.voice,
                            ) && (
                              <option>
                                {editor.screeningConfig.setup.voice}
                              </option>
                            )}
                        </select>
                      </Field>
                      <p className="screen-hint">
                        Questions keep the language you write. Questionnaire
                        narration uses a local browser voice; live interviews
                        use the team’s configured speech provider.
                      </p>
                    </div>
                    <div className="screen-card">
                      <h3>Welcome message</h3>
                      <Field label="Welcome message">
                        <textarea
                          rows={4}
                          maxLength={5000}
                          value={editor.screeningConfig.setup.welcomeMessage}
                          onChange={(event) =>
                            config({
                              setup: {
                                ...editor.screeningConfig.setup,
                                welcomeMessage: event.target.value,
                              },
                            })
                          }
                        />
                      </Field>
                      <VariableButtons
                        onInsert={(value) =>
                          config({
                            setup: {
                              ...editor.screeningConfig.setup,
                              welcomeMessage:
                                editor.screeningConfig.setup.welcomeMessage +
                                value,
                            },
                          })
                        }
                      />
                      <h3>Completion message</h3>
                      <Field label="Completion message">
                        <textarea
                          rows={3}
                          maxLength={5000}
                          value={editor.screeningConfig.setup.completionMessage}
                          onChange={(event) =>
                            config({
                              setup: {
                                ...editor.screeningConfig.setup,
                                completionMessage: event.target.value,
                              },
                            })
                          }
                        />
                      </Field>
                      <p className="screen-hint">
                        Welcome and completion messages are shown to candidates
                        and are not scored.
                      </p>
                    </div>
                  </>
                )}
                {panel === "interview" && (
                  <>
                    <div className="screen-section-title">
                      <h2>Interview</h2>
                      <p>Give each part of the conversation a clear purpose.</p>
                    </div>
                    <Field label="Screening title">
                      <input
                        value={editor.title}
                        maxLength={300}
                        onChange={(event) =>
                          change({ title: event.target.value })
                        }
                      />
                    </Field>
                    <div className="screen-message-block">
                      <span>Welcome</span>
                      <p>
                        {screeningMessage(
                          editor.screeningConfig.setup.welcomeMessage,
                          editor.title,
                          "your hiring team",
                        )}
                      </p>
                      <button onClick={() => setPanel("setup")}>
                        Edit welcome
                      </button>
                    </div>
                    {editor.screeningConfig.sections.map(
                      (section, sectionIndex) => (
                        <details
                          className="screen-card screen-interview-section"
                          key={section.id}
                          open
                        >
                          <summary>
                            <Layers size={17} />
                            <strong>{section.title}</strong>
                            <span>{section.questions.length} questions</span>
                          </summary>
                          <div className="screen-section-tools">
                            <button
                              aria-label={`Move section ${sectionIndex + 1} up`}
                              disabled={sectionIndex === 0}
                              onClick={() =>
                                sections(
                                  moved(
                                    editor.screeningConfig.sections,
                                    sectionIndex,
                                    -1,
                                  ),
                                )
                              }
                            >
                              <ArrowUp size={15} />
                            </button>
                            <button
                              aria-label={`Move section ${sectionIndex + 1} down`}
                              disabled={
                                sectionIndex ===
                                editor.screeningConfig.sections.length - 1
                              }
                              onClick={() =>
                                sections(
                                  moved(
                                    editor.screeningConfig.sections,
                                    sectionIndex,
                                    1,
                                  ),
                                )
                              }
                            >
                              <ArrowDown size={15} />
                            </button>
                            <button
                              aria-label={`Duplicate section ${sectionIndex + 1}`}
                              disabled={
                                editor.screeningConfig.sections.length >= 20 ||
                                questions.length + section.questions.length > 50
                              }
                              onClick={() =>
                                sections([
                                  ...editor.screeningConfig.sections.slice(
                                    0,
                                    sectionIndex + 1,
                                  ),
                                  {
                                    ...section,
                                    id: crypto.randomUUID(),
                                    title: `${section.title.slice(0, 110)} copy`,
                                    questions: section.questions.map((q) => ({
                                      ...q,
                                      id: crypto.randomUUID(),
                                    })),
                                  },
                                  ...editor.screeningConfig.sections.slice(
                                    sectionIndex + 1,
                                  ),
                                ])
                              }
                            >
                              <Copy size={15} />
                            </button>
                            <button
                              aria-label={`Remove section ${sectionIndex + 1}`}
                              disabled={
                                editor.screeningConfig.sections.length === 1
                              }
                              onClick={() =>
                                sections(
                                  editor.screeningConfig.sections.filter(
                                    (_, index) => index !== sectionIndex,
                                  ),
                                )
                              }
                            >
                              <Trash2 size={15} />
                            </button>
                          </div>
                          <Field label="Section title">
                            <input
                              value={section.title}
                              maxLength={120}
                              onChange={(event) =>
                                updateSection(sectionIndex, {
                                  title: event.target.value,
                                })
                              }
                            />
                          </Field>
                          <Field
                            label="Section goal"
                            hint="Private guidance for your team."
                          >
                            <textarea
                              rows={2}
                              value={section.goal}
                              maxLength={2000}
                              onChange={(event) =>
                                updateSection(sectionIndex, {
                                  goal: event.target.value,
                                })
                              }
                            />
                          </Field>
                          {section.questions.map((q, questionIndex) => (
                            <details
                              className="screen-question"
                              key={q.id}
                              open
                            >
                              <summary>
                                <span>{questionIndex + 1}</span>
                                <strong>{q.prompt || "New question"}</strong>
                                <small>
                                  {q.type === "text"
                                    ? "Written / voice"
                                    : q.type === "yes-no"
                                      ? "Yes / No"
                                      : "Multiple choice"}
                                </small>
                              </summary>
                              <div className="screen-section-tools">
                                <button
                                  aria-label={`Move question ${sectionIndex + 1}.${questionIndex + 1} up`}
                                  disabled={questionIndex === 0}
                                  onClick={() =>
                                    updateSection(sectionIndex, {
                                      questions: moved(
                                        section.questions,
                                        questionIndex,
                                        -1,
                                      ),
                                    })
                                  }
                                >
                                  <ArrowUp size={14} />
                                </button>
                                <button
                                  aria-label={`Move question ${sectionIndex + 1}.${questionIndex + 1} down`}
                                  disabled={
                                    questionIndex ===
                                    section.questions.length - 1
                                  }
                                  onClick={() =>
                                    updateSection(sectionIndex, {
                                      questions: moved(
                                        section.questions,
                                        questionIndex,
                                        1,
                                      ),
                                    })
                                  }
                                >
                                  <ArrowDown size={14} />
                                </button>
                                <button
                                  aria-label={`Duplicate question ${sectionIndex + 1}.${questionIndex + 1}`}
                                  disabled={questions.length >= 50}
                                  onClick={() =>
                                    updateSection(sectionIndex, {
                                      questions: [
                                        ...section.questions.slice(
                                          0,
                                          questionIndex + 1,
                                        ),
                                        { ...q, id: crypto.randomUUID() },
                                        ...section.questions.slice(
                                          questionIndex + 1,
                                        ),
                                      ],
                                    })
                                  }
                                >
                                  <Copy size={14} />
                                </button>
                                <button
                                  aria-label={`Remove question ${sectionIndex + 1}.${questionIndex + 1}`}
                                  onClick={() =>
                                    updateSection(sectionIndex, {
                                      questions: section.questions.filter(
                                        (_, index) => index !== questionIndex,
                                      ),
                                    })
                                  }
                                >
                                  <Trash2 size={14} />
                                </button>
                              </div>
                              <Field label="Question text">
                                <textarea
                                  rows={3}
                                  maxLength={2000}
                                  value={q.prompt}
                                  onChange={(event) =>
                                    updateQuestion(
                                      sectionIndex,
                                      questionIndex,
                                      { prompt: event.target.value },
                                    )
                                  }
                                />
                              </Field>
                              <Field label="Answer type">
                                <select
                                  value={q.type}
                                  onChange={(event) =>
                                    updateQuestion(
                                      sectionIndex,
                                      questionIndex,
                                      {
                                        type: event.target
                                          .value as ScreeningQuestion["type"],
                                        options: [],
                                      },
                                    )
                                  }
                                >
                                  <option value="text">
                                    Written answer or optional voice
                                  </option>
                                  <option value="yes-no">Yes / No</option>
                                  <option value="multiple-choice">
                                    Multiple choice
                                  </option>
                                </select>
                              </Field>
                              {q.type === "multiple-choice" && (
                                <Field
                                  label="Answer options"
                                  hint="One option per line; at least two distinct options before publishing."
                                >
                                  <textarea
                                    value={q.options.join("\n")}
                                    onChange={(event) =>
                                      updateQuestion(
                                        sectionIndex,
                                        questionIndex,
                                        {
                                          options:
                                            event.target.value.split("\n"),
                                        },
                                      )
                                    }
                                  />
                                </Field>
                              )}
                              <label className="screen-check">
                                <input
                                  type="checkbox"
                                  checked={q.required}
                                  onChange={(event) =>
                                    updateQuestion(
                                      sectionIndex,
                                      questionIndex,
                                      { required: event.target.checked },
                                    )
                                  }
                                />
                                Required question
                              </label>
                              {q.type === "text" && (
                                <label className="screen-check">
                                  <input
                                    type="checkbox"
                                    checked={q.followUp}
                                    onChange={(event) =>
                                      updateQuestion(
                                        sectionIndex,
                                        questionIndex,
                                        { followUp: event.target.checked },
                                      )
                                    }
                                  />
                                  Allow one AI clarification after a voice
                                  answer when the provider is enabled
                                </label>
                              )}
                              <Field
                                label="Review rubric"
                                hint="Private guidance. Never included in the candidate link."
                              >
                                <textarea
                                  rows={2}
                                  maxLength={2000}
                                  value={q.rubric}
                                  onChange={(event) =>
                                    updateQuestion(
                                      sectionIndex,
                                      questionIndex,
                                      { rubric: event.target.value },
                                    )
                                  }
                                />
                              </Field>
                            </details>
                          ))}
                          <Button
                            variant="secondary"
                            disabled={questions.length >= 50}
                            onClick={() =>
                              updateSection(sectionIndex, {
                                questions: [...section.questions, question()],
                              })
                            }
                          >
                            <Plus size={15} />
                            Add question
                          </Button>
                        </details>
                      ),
                    )}
                    <Button
                      variant="secondary"
                      disabled={editor.screeningConfig.sections.length >= 20}
                      onClick={() =>
                        sections([
                          ...editor.screeningConfig.sections,
                          {
                            id: crypto.randomUUID(),
                            title: "New section",
                            goal: "",
                            questions: [],
                          },
                        ])
                      }
                    >
                      <Plus size={16} />
                      Add section
                    </Button>
                    <div className="screen-message-block">
                      <span>Wrap-up</span>
                      <p>{editor.screeningConfig.setup.completionMessage}</p>
                      <button onClick={() => setPanel("setup")}>
                        Edit completion message
                      </button>
                    </div>
                  </>
                )}
                {panel === "context" && (
                  <>
                    <div className="screen-section-title">
                      <h2>Context</h2>
                      <p>
                        Keep role and company information close to the questions
                        you’re writing.
                      </p>
                    </div>
                    <div className="screen-card">
                      <Field label="Role context">
                        <textarea
                          rows={8}
                          maxLength={12000}
                          value={editor.screeningConfig.context.role}
                          onChange={(event) =>
                            config({
                              context: {
                                ...editor.screeningConfig.context,
                                role: event.target.value,
                              },
                            })
                          }
                        />
                      </Field>
                      <Field label="Company context">
                        <textarea
                          rows={8}
                          maxLength={12000}
                          value={editor.screeningConfig.context.company}
                          onChange={(event) =>
                            config({
                              context: {
                                ...editor.screeningConfig.context,
                                company: event.target.value,
                              },
                            })
                          }
                        />
                      </Field>
                      <label className="screen-file">
                        Import text context
                        <input
                          type="file"
                          accept=".txt,.md,text/plain,text/markdown"
                          onChange={async (event) => {
                            const file = event.target.files?.[0];
                            if (!file) return;
                            if (file.size > 24000) {
                              setError(
                                "Choose a text file no larger than 24 KB.",
                              );
                              return;
                            }
                            const text = await file.text();
                            if (text.length > 12000) {
                              setError(
                                "Context must be at most 12,000 characters.",
                              );
                              return;
                            }
                            config({
                              context: {
                                ...editor.screeningConfig.context,
                                role: text,
                              },
                            });
                            event.target.value = "";
                          }}
                        />
                      </label>
                      <p className="screen-hint">
                        Context and section goals stay private. Open Agent to
                        explicitly share selected context when drafting
                        questions.
                      </p>
                      <Button
                        variant="secondary"
                        onClick={() => setSide("agent")}
                      >
                        <Sparkles size={15} />
                        Draft with this context
                      </Button>
                    </div>
                  </>
                )}
                <div hidden={panel !== "outreach"}>
                  <div className="screen-section-title">
                    <h2>Outreach</h2>
                    <p>
                      Set the response window before sharing a candidate link.
                    </p>
                  </div>
                  <div className="screen-card">
                    <Field
                      label="Candidate response deadline"
                      hint="Applied when a new link is published. Existing links retain their original deadline."
                    >
                      <select
                        value={editor.screeningConfig.outreach.deadlineDays}
                        onChange={(event) =>
                          config({
                            outreach: {
                              deadlineDays: Number(event.target.value),
                            },
                          })
                        }
                      >
                        {Array.from(
                          { length: 30 },
                          (_, index) => index + 1,
                        ).map((day) => (
                          <option value={day} key={day}>
                            {day} {day === 1 ? "day" : "days"}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <p>
                      Each link accepts one candidate response. You can revoke
                      it from Candidates.
                    </p>
                    {item && renderPublication && (
                      <Button
                        disabled={dirty}
                        onClick={() => setPublishing(true)}
                      >
                        Create candidate link
                      </Button>
                    )}
                  </div>
                  {item ? (
                    <ScreeningOutreach
                      screeningId={item.id}
                      revision={item.updatedAt}
                      title={item.title}
                      deadlineDays={
                        editor.screeningConfig.outreach.deadlineDays
                      }
                      disabled={dirty || busy}
                      onDirty={setOutreachDirty}
                    />
                  ) : (
                    <p className="screen-hint">
                      Save this screening before preparing invitations and
                      reminders.
                    </p>
                  )}
                </div>
              </main>
              <aside className="screen-assistant">
                <nav
                  role="tablist"
                  aria-label="Screening assistant"
                  onKeyDown={tabKeys}
                >
                  <button
                    role="tab"
                    aria-selected={side === "preview"}
                    tabIndex={side === "preview" ? 0 : -1}
                    className={side === "preview" ? "active" : ""}
                    onClick={() => setSide("preview")}
                  >
                    <Play size={14} />
                    Preview
                  </button>
                  <button
                    role="tab"
                    aria-selected={side === "agent"}
                    tabIndex={side === "agent" ? 0 : -1}
                    className={side === "agent" ? "active" : ""}
                    onClick={() => setSide("agent")}
                  >
                    <Sparkles size={14} />
                    Agent
                  </button>
                </nav>
                {side === "preview" ? (
                  <>
                    <div className="screen-preview-device">
                      {previewContent}
                    </div>
                    <Button
                      variant="secondary"
                      onClick={() => setPreview(true)}
                    >
                      <Play size={14} />
                      Try candidate preview
                    </Button>
                    <p className="screen-hint">
                      Preview only. Answers are not collected.
                    </p>
                  </>
                ) : (
                  <ScreeningDrafting
                    key={
                      editor.screeningConfig.context.role +
                      editor.screeningConfig.context.company
                    }
                    inline
                    jobs={jobs}
                    initialContext={[
                      editor.screeningConfig.context.role,
                      editor.screeningConfig.context.company,
                    ]
                      .filter(Boolean)
                      .join("\n\n")
                      .slice(0, 12000)}
                    onClose={() => setSide("preview")}
                    onUseDraft={useProposal}
                  />
                )}
              </aside>
            </div>
          )}
        </>
      )}
      {preview && (
        <Modal title="Candidate preview" onClose={() => setPreview(false)} wide>
          {previewContent}
        </Modal>
      )}
      {publishing &&
        item &&
        renderPublication?.(item, () => setPublishing(false))}
      {responses && item && renderResponses?.(item, () => setResponses(false))}
    </div>
  );
}

function VariableButtons({ onInsert }: { onInsert: (value: string) => void }) {
  return (
    <div className="screen-variables">
      {[
        ["Screening title", "{{screening_title}}"],
        ["Company name", "{{company_name}}"],
      ].map(([label, value]) => (
        <button type="button" key={value} onClick={() => onInsert(value)}>
          {label}
        </button>
      ))}
    </div>
  );
}
function ScreeningPreview({ editor }: { editor: Editor }) {
  const [complete, setComplete] = useState(false);
  return (
    <div className="screen-candidate-preview">
      <div className="screen-preview-logo">
        <Layers size={24} />
        ArkOffer
      </div>
      {complete ? (
        <>
          <Check size={28} />
          <h2>Preview complete</h2>
          <p>
            {screeningMessage(
              editor.screeningConfig.setup.completionMessage,
              editor.title,
              "your hiring team",
            )}
          </p>
          <p>These responses have not been collected or saved.</p>
          <Button variant="secondary" onClick={() => setComplete(false)}>
            Try again
          </Button>
        </>
      ) : (
        <>
          <span className="screen-preview-eyebrow">YOUR SCREENING</span>
          <h2>{editor.title}</h2>
          <p>{editor.description}</p>
          <p>
            {screeningMessage(
              editor.screeningConfig.setup.welcomeMessage,
              editor.title,
              "your hiring team",
            )}
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setComplete(true);
            }}
          >
            {editor.screeningConfig.sections.map((section) => (
              <section key={section.id}>
                <h3>{section.title}</h3>
                {section.questions.map((q, index) => (
                  <Field
                    label={`${index + 1}. ${q.prompt || "Your question"}`}
                    key={q.id}
                  >
                    {q.type === "text" ? (
                      <textarea rows={3} required={q.required} />
                    ) : (
                      <select required={q.required} defaultValue="">
                        <option value="">Select an answer</option>
                        {(q.type === "yes-no" ? ["Yes", "No"] : q.options).map(
                          (value, i) => (
                            <option key={`${value}-${i}`}>{value}</option>
                          ),
                        )}
                      </select>
                    )}
                  </Field>
                ))}
              </section>
            ))}
            <Button type="submit">Finish preview</Button>
          </form>
        </>
      )}
    </div>
  );
}
