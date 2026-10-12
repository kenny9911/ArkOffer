import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  ArrowLeft,
  ArrowUp,
  BookOpen,
  Check,
  ChevronDown,
  Download,
  ExternalLink,
  Globe2,
  FolderX,
  History,
  Layers,
  Library,
  Map,
  MapPin,
  Paperclip,
  Plus,
  ScanSearch,
  Search,
  Sparkles,
  Trash2,
  UsersRound,
  X,
} from "lucide-react";
import { api, json, Button, Field, ErrorBanner, Loading, Modal } from "../ui";
import "./SourcingWorkspace.css";

type Mode = "sourcing" | "lookalikes" | "market" | "talent";
type Source = "workspace" | "pdl";
type Exclusions = { pastSearches: boolean; sequenced: boolean };
const noExclusions = (): Exclusions => ({
  pastSearches: false,
  sequenced: false,
});
type Criteria = {
  titles: string[];
  locations: string[];
  skills: string[];
  companies: string[];
  keywords: string[];
  excludeCompanies: string[];
};
type Person = {
  key: string;
  candidateId?: string;
  name: string;
  role: string;
  company: string;
  location: string;
  skills: string;
  profile: string;
  review: { status: string; notes: string };
};
type Pack = {
  id: string;
  source: Source;
  criteria: Criteria;
  exclusions: Exclusions;
  filteredCount: number;
  status: string;
  results: Person[];
  total: number;
  hasMore: boolean;
  unavailable: number;
  error?: string;
  createdAt: string;
};
type Session = {
  id: string;
  title: string;
  mode: Mode;
  source: Source;
  prompt: string;
  context: string;
  referenceId?: string;
  referenceIds?: string[];
  criteria: Criteria;
  exclusions: Exclusions;
  events: { role: string; text: string; unresolved?: string[] }[];
  status: string;
  revision: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
  runs?: Pack[];
};
type Setup = {
  aiAvailable: boolean;
  discoveryAvailable: boolean;
  discoveryProvider: string;
  sessions: Session[];
  references: {
    id: string;
    name: string;
    role: string;
    company: string;
    profile?: string;
  }[];
};
const modes = [
  {
    id: "sourcing",
    label: "Sourcing",
    icon: UsersRound,
    prompt: "Find software engineers in Singapore with TypeScript experience",
  },
  {
    id: "lookalikes",
    label: "Look-alikes",
    icon: ScanSearch,
    prompt:
      "Find people with similar professional experience to my reference candidate",
  },
  {
    id: "market",
    label: "Market mapping",
    icon: Map,
    prompt: "Map companies employing solutions architects in London",
  },
  {
    id: "talent",
    label: "Talent mapping",
    icon: MapPin,
    prompt: "Map where platform engineers with Kubernetes experience are based",
  },
] as const;
const criteriaLabels: Record<keyof Criteria, string> = {
  titles: "Job titles",
  locations: "Locations",
  skills: "Skills",
  companies: "Companies",
  keywords: "Other work keywords",
  excludeCompanies: "Exclude companies",
};
const guidedLabels = {
  role: "Role",
  location: "Location",
  years: "Years of experience",
  industry: "Industry",
  skills: "Skills",
  additional: "Additional requirements (optional)",
};
type GuidedFields = Record<string, string>;
const initialGuided: GuidedFields = {
  role: "",
  location: "",
  years: "",
  industry: "",
  skills: "",
  additional: "",
  company: "",
  functions: "",
  jobDescription: "",
  additionalContext: "",
  similarity: "",
};
const guideTitles: Record<Mode, string> = {
  sourcing: "Sourcing Prompt",
  lookalikes: "Look-alikes Prompt",
  market: "Market Mapping Prompt",
  talent: "Talent Mapping Prompt",
};
const modeFields: Record<Mode, Record<string, string>> = {
  sourcing: guidedLabels,
  lookalikes: {
    similarity: "What do you like about these profiles? (optional)",
  },
  market: {
    jobDescription: "Job Description or Link",
    additionalContext: "Additional Context",
  },
  talent: {
    company: "Company",
    functions: "Functions",
    additionalContext: "Additional Context",
  },
};
const guidedText = (
  mode: Mode,
  fields: GuidedFields,
  profiles: string[] = [],
) => {
  if (mode === "lookalikes")
    return `Find professionals with work experience similar to these reference profiles: ${profiles.filter(Boolean).join(", ") || "[Reference profiles]"}.${fields.similarity ? " Focus on: " + fields.similarity : " Use their roles and professional skills as a starting point."} Use only verified profile facts and explain what still needs review.`;
  if (mode === "market")
    return `Explore the talent market for this job description or reference link: ${fields.jobDescription || "[Job description or link]"}. ${fields.additionalContext || ""} Build search criteria, then summarize the companies and roles represented in the available result pack. Distinguish observed data from unanswered questions; do not invent market totals, tenure or compensation. A link alone is not the contents of a job description.`;
  if (mode === "talent")
    return `Map people working at ${fields.company || "[Company]"}${fields.functions ? " in these functions: " + fields.functions : ""}. ${fields.additionalContext || ""} Group the available profiles by job title and location, and prepare a candidate CSV. Treat this as a sample of the chosen data source, not a complete employee directory.`;
  return `Find ${fields.role || "[Role]"} in ${fields.location || "[Location]"} with ${fields.years || "[Years of experience]"} years of experience, a background in ${fields.industry || "[Industry]"}, and skills in ${fields.skills || "[Skills]"}.${fields.additional ? " Additional requirements: " + fields.additional : ""}`;
};
const emptyCriteria = (): Criteria => ({
  titles: [],
  locations: [],
  skills: [],
  companies: [],
  keywords: [],
  excludeCompanies: [],
});
export default function SourcingWorkspace({
  candidateLibrary,
}: {
  candidateLibrary?: ReactNode;
}) {
  const [setup, setSetup] = useState<Setup | null>(null),
    [active, setActive] = useState<Session | null>(null),
    [tab, setTab] = useState("search"),
    [history, setHistory] = useState(false),
    [sources, setSources] = useState(false),
    [exclusionMenu, setExclusionMenu] = useState(false),
    [exclusions, setExclusions] = useState<Exclusions>(noExclusions),
    [contextOpen, setContextOpen] = useState(false),
    [slack, setSlack] = useState(true),
    [guide, setGuide] = useState<Mode | null>(null),
    [profileInputs, setProfileInputs] = useState<string[]>([""]),
    [guideFields, setGuideFields] = useState<GuidedFields>(initialGuided),
    [guidePrompt, setGuidePrompt] = useState(
      guidedText("sourcing", initialGuided),
    );
  const [prompt, setPrompt] = useState(""),
    [context, setContext] = useState(""),
    [mode, setMode] = useState<Mode>("sourcing"),
    [source, setSource] = useState<Source>("workspace"),
    [reference, setReference] = useState("");
  const [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [criteria, setCriteria] = useState<Criteria>(emptyCriteria),
    [criteriaText, setCriteriaText] = useState<Record<string, string>>({}),
    [title, setTitle] = useState(""),
    [selectedPack, setSelectedPack] = useState(""),
    [selected, setSelected] = useState<string[]>([]),
    [review, setReview] = useState<Person | null>(null),
    [filter, setFilter] = useState("all"),
    [deletePending, setDeletePending] = useState(false);
  const attachment = useRef<HTMLInputElement>(null),
    request = useRef<{
      key: string;
      id: string;
      pending?: { sessionId: string; runId?: string };
    } | null>(null),
    alive = useRef(true);
  const requestId = (key: string) => {
    if (request.current?.key !== key)
      request.current = { key, id: crypto.randomUUID() };
    return request.current.id;
  };
  const refresh = async () => {
    const data = await api<Setup>("sourcing");
    if (alive.current) setSetup(data);
  };
  useEffect(() => {
    alive.current = true;
    void refresh().catch((e) => setError(e.message));
    return () => {
      alive.current = false;
    };
  }, []);
  const load = async (id: string) => {
    const data = await api<{ item: Session }>(`sourcing/sessions/${id}`);
    if (!alive.current) return;
    const pending = request.current?.pending;
    if (pending?.sessionId === id) {
      const finished = pending.runId
        ? data.item.runs?.some(
            (run) => run.id === pending.runId && run.status !== "running",
          )
        : data.item.status !== "planning";
      if (finished) request.current = null;
    }
    setActive(data.item);
    setCriteria(data.item.criteria);
    setExclusions(data.item.exclusions || noExclusions());
    setCriteriaText(
      Object.fromEntries(
        Object.entries(data.item.criteria).map(([key, values]) => [
          key,
          values.join(", "),
        ]),
      ),
    );
    setTitle(data.item.title);
    setSource(data.item.source);
    setMode(data.item.mode);
    setSelectedPack(data.item.runs?.[0]?.id || "");
    setSelected([]);
    setReview(null);
    setHistory(false);
    setDeletePending(false);
  };
  useEffect(() => {
    if (
      !active ||
      (active.status !== "planning" &&
        !active.runs?.some((r) => r.status === "running"))
    )
      return;
    const timer = setInterval(
      () => void load(active.id).catch((e) => setError(e.message)),
      2000,
    );
    return () => clearInterval(timer);
  }, [active?.id, active?.status, active?.runs]);
  const act = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setBusy("");
    }
  };
  const start = (manual = false, promptOverride?: string) =>
    void act("plan", async () => {
      const input = {
        prompt: (promptOverride ?? prompt).trim() || "New sourcing search",
        context,
        mode,
        source,
        exclusions,
        ...(mode === "lookalikes" && reference
          ? { referenceId: reference }
          : {}),
        ...(mode === "lookalikes"
          ? {
              referenceProfiles: profileInputs
                .filter((p) => p.trim())
                .map((p) => p.trim()),
            }
          : {}),
        manual,
      };
      const response = await api<{ item: Session }>(
        "sourcing/sessions",
        json("POST", { ...input, requestId: requestId(JSON.stringify(input)) }),
      );
      if (response.item.status === "planning" && request.current)
        request.current.pending = { sessionId: response.item.id };
      else request.current = null;
      await load(response.item.id);
      await refresh();
    });
  const reset = () => {
    setActive(null);
    setPrompt("");
    setContext("");
    setContextOpen(false);
    setReference("");
    setProfileInputs([""]);
    setGuide(null);
    setExclusions(noExclusions());
    setExclusionMenu(false);
    setReview(null);
    setSelected([]);
    setError("");
    setNotice("");
    setTab("search");
    setHistory(false);
    setDeletePending(false);
    request.current = null;
  };
  const save = async () => {
    if (!active) return;
    const data = await api<{ item: Session }>(
      `sourcing/sessions/${active.id}`,
      json("PATCH", {
        revision: active.revision,
        title,
        criteria,
        source,
        mode,
        exclusions,
      }),
    );
    setActive(data.item);
    await refresh();
    return data.item;
  };
  const dirty =
    !!active &&
    (JSON.stringify(criteria) !== JSON.stringify(active.criteria) ||
      title !== active.title ||
      source !== active.source ||
      mode !== active.mode ||
      JSON.stringify(exclusions) !==
        JSON.stringify(active.exclusions || noExclusions()));
  const pack =
    active?.runs?.find((r) => r.id === selectedPack) || active?.runs?.[0];
  const runPending = !!active?.runs?.some((r) => r.status === "running");
  const run = (afterRunId?: string) =>
    void act("run", async () => {
      if (!active || runPending) return;
      const current = dirty ? await save() : active;
      if (!current) return;
      const input = {
        revision: current.revision,
        consent: true,
        size: 20,
        ...(afterRunId ? { afterRunId } : {}),
      };
      const data = await api<{ item: Pack }>(
        `sourcing/sessions/${current.id}/runs`,
        json("POST", {
          ...input,
          requestId: requestId(
            JSON.stringify({ sessionId: current.id, ...input }),
          ),
        }),
      );
      if (data.item.status === "running" && request.current)
        request.current.pending = {
          sessionId: current.id,
          runId: data.item.id,
        };
      else request.current = null;
      await load(current.id);
      setSelectedPack(data.item.id);
      await refresh();
    });
  const results = (pack?.results || []).filter(
    (p) => filter === "all" || p.review.status === filter,
  );
  const grouped = Object.entries(
    (pack?.results || []).reduce<Record<string, number>>((all, p) => {
      const key =
        mode === "market"
          ? p.company || "Company not provided"
          : `${p.role || "Role not provided"} · ${p.location || "Location not provided"}`;
      all[key] = (all[key] || 0) + 1;
      return all;
    }, {}),
  ).sort((a, b) => b[1] - a[1]);
  const chooseMode = (value: Mode) => {
    setMode(value);
    setGuide(value);
    setGuidePrompt(guidedText(value, guideFields, profileInputs));
  };
  const exclusionControls = (
    <div className="sourcing-exclusions">
      <label>
        <input
          type="checkbox"
          checked={exclusions.pastSearches}
          disabled={!!busy}
          onChange={(e) =>
            setExclusions({ ...exclusions, pastSearches: e.target.checked })
          }
        />
        <span>
          Exclude past search results
          <small>
            Results from your own saved searches in this workspace. Other
            people's private results are not used.
          </small>
        </span>
      </label>
      <label>
        <input
          type="checkbox"
          checked={exclusions.sequenced}
          disabled={!!busy}
          onChange={(e) =>
            setExclusions({ ...exclusions, sequenced: e.target.checked })
          }
        />
        <span>
          Exclude sequenced candidates
          <small>
            People enrolled in a saved workspace sequence or delivery schedule.
          </small>
        </span>
      </label>
      <label className="unavailable">
        <input type="checkbox" disabled />
        <span>
          Exclude recent job changers
          <small>
            Unavailable until verified job start dates are available.
          </small>
        </span>
      </label>
    </div>
  );
  const composer = (
    <>
      <div className="sourcing-composer">
        <textarea
          aria-label="Describe who you want to hire"
          placeholder="Solutions Architect, London, enterprise software, AWS and Terraform"
          maxLength={5000}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              if (!busy && prompt.trim() && setup?.aiAvailable) start();
            }
          }}
        />
        <div className="sourcing-composer-controls">
          <span>
            {context && `${context.length.toLocaleString()} context characters`}
          </span>
          <button
            aria-label="Search exclusions"
            title="Search exclusions"
            aria-expanded={exclusionMenu}
            onClick={() => setExclusionMenu(!exclusionMenu)}
          >
            <FolderX size={17} />
            <span>
              {Number(exclusions.pastSearches) + Number(exclusions.sequenced)}
            </span>
          </button>
          <button
            aria-label="Professional discovery source"
            title="Professional discovery"
            onClick={() => setSources(!sources)}
          >
            <Globe2 size={17} />
            <span>{source === "pdl" ? 1 : 0}</span>
          </button>
          <button
            aria-label="Add search context"
            title="Add search context"
            onClick={() => setContextOpen(!contextOpen)}
          >
            <BookOpen size={17} />
          </button>
          <i />
          <button
            aria-label="Attach text brief"
            title="Attach a text or Markdown brief"
            onClick={() => attachment.current?.click()}
          >
            <Paperclip size={17} />
          </button>
          <button
            className="sourcing-submit"
            aria-label="Build search plan"
            disabled={
              !!busy ||
              !prompt.trim() ||
              !setup?.aiAvailable ||
              (mode === "lookalikes" &&
                !reference &&
                !profileInputs.some((p) => p.trim()))
            }
            onClick={() => start()}
          >
            <ArrowUp size={19} />
          </button>
        </div>
        <input
          ref={attachment}
          hidden
          type="file"
          accept=".txt,.md,text/plain,text/markdown"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            void act("file", async () => {
              if (file.size > 20_000)
                throw new Error("Choose a text brief smaller than 20 KB.");
              if (!/\.(txt|md)$/i.test(file.name))
                throw new Error("Attach a plain text or Markdown brief.");
              const value = await file.text();
              if (value.includes("\u0000"))
                throw new Error("This file is not plain text.");
              setContext(value);
              setContextOpen(true);
            });
          }}
        />
      </div>
      <div
        className="sourcing-prompts"
        role="group"
        aria-label="Agentic prompts"
      >
        <strong>Agentic prompts</strong>
        <p>
          Describe who you are looking for. Review a search plan, then explore
          the results.
        </p>
        <div>
          {modes.map((m) => (
            <button
              key={m.id}
              className={mode === m.id ? "selected" : ""}
              onClick={() => chooseMode(m.id)}
            >
              <m.icon size={17} />
              {m.label}
            </button>
          ))}
        </div>
      </div>
      {exclusionMenu && (
        <div className="sourcing-options">
          <h3>Exclusions</h3>
          {exclusionControls}
        </div>
      )}
      {sources && (
        <div className="sourcing-options">
          <h3>Candidate sources</h3>
          <label>
            <input
              type="radio"
              name="sourcing-source"
              checked={source === "workspace"}
              onChange={() => setSource("workspace")}
            />
            <span>
              <strong>Candidate library</strong>
              <small>
                People your workspace has already saved or imported.
              </small>
            </span>
          </label>
          <label>
            <input
              type="radio"
              name="sourcing-source"
              checked={source === "pdl"}
              onChange={() => setSource("pdl")}
            />
            <span>
              <strong>Professional discovery</strong>
              <small>
                {setup?.discoveryAvailable
                  ? "Search People Data Labs professional profiles. Provider credits apply after you review the criteria."
                  : "Connect People Data Labs to discover new profiles. Ask your administrator to configure professional sourcing."}
              </small>
            </span>
          </label>
          <p>
            <Link to="/app/settings?tab=integrations">ATS connections</Link> ·
            Search synced ATS profiles from your candidate library.
          </p>
        </div>
      )}
      {mode === "lookalikes" && (
        <div className="sourcing-options">
          <Field label="Reference candidate">
            <select
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            >
              <option value="">Choose from your candidate library</option>
              {setup?.references.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} · {c.role || c.company}
                </option>
              ))}
            </select>
          </Field>
          <p>
            Uses professional role and skills as a starting point. Review the
            criteria before searching.
          </p>
        </div>
      )}
      {contextOpen && (
        <div className="sourcing-options">
          <Field label="Search context">
            <textarea
              rows={5}
              maxLength={20_000}
              placeholder="Add a role brief, company context or the professional experience you need."
              value={context}
              onChange={(e) => setContext(e.target.value)}
            />
          </Field>
          <p>
            Your brief and context are sent to your configured text AI when you
            build a search plan.
          </p>
        </div>
      )}
    </>
  );
  return (
    <section className={`sourcing-workspace ${active ? "has-search" : ""}`}>
      <div className="sourcing-topline">
        <div>
          <button
            className={tab === "search" ? "active" : ""}
            onClick={() => setTab("search")}
          >
            <Search size={15} />
            Sourcing
          </button>
          <button
            className={tab === "library" ? "active" : ""}
            onClick={() => setTab("library")}
          >
            <UsersRound size={15} />
            Candidate library
          </button>
        </div>
        <div>
          <button onClick={() => setHistory(!history)} aria-expanded={history}>
            <History size={16} />
            History
          </button>
          {active && (
            <button disabled={!!busy} onClick={reset}>
              <Plus size={16} />
              New search
            </button>
          )}
        </div>
      </div>
      {history && (
        <aside className="sourcing-history">
          <div>
            <h2>Your searches</h2>
            <button
              aria-label="Close search history"
              onClick={() => setHistory(false)}
            >
              <X size={17} />
            </button>
          </div>
          {setup?.sessions.length ? (
            setup.sessions.map((s) => (
              <button
                key={s.id}
                onClick={() =>
                  void act("load", async () => {
                    await load(s.id);
                    setTab("search");
                  })
                }
              >
                <Search size={16} />
                <span>
                  <strong>{s.title}</strong>
                  <small>
                    {new Date(s.updatedAt).toLocaleDateString()} ·{" "}
                    {s.source === "pdl"
                      ? "Professional discovery"
                      : "Candidate library"}
                  </small>
                </span>
                <ChevronDown size={14} />
              </button>
            ))
          ) : (
            <p>Your saved searches will appear here.</p>
          )}
        </aside>
      )}
      {tab === "library" ? (
        candidateLibrary || (
          <p>Open the candidate library to manage profiles.</p>
        )
      ) : !setup ? (
        <Loading />
      ) : !active ? (
        <div className="sourcing-home">
          <div className="sourcing-brand">
            <Layers size={31} strokeWidth={2.3} />
            <span>ArkOffer</span>
          </div>
          <div className="sourcing-home-content">
            <h1>How can we help you hire today?</h1>
            <ErrorBanner error={error} />
            <div className="sourcing-prompt-shell">{composer}</div>
            <div className="sourcing-home-meta">
              <button
                onClick={() => start(true)}
                disabled={
                  !!busy ||
                  (mode === "lookalikes" &&
                    !reference &&
                    !profileInputs.some((p) => p.trim()))
                }
              >
                {busy === "plan"
                  ? "Building your search plan…"
                  : "Create a manual search"}
              </button>
              {!setup.aiAvailable && (
                <span>AI planning is not enabled for this workspace.</span>
              )}
            </div>
            {slack && (
              <div className="sourcing-slack">
                <span className="sourcing-slack-symbol" aria-hidden="true">
                  ✣
                </span>
                <div>
                  <strong>Bring Sourcing into Slack</strong>
                  <p>
                    Connect your workspace to ask questions and receive
                    recruiting updates.
                  </p>
                </div>
                <Link to="/app/settings?tab=integrations">Connect Slack</Link>
                <button
                  aria-label="Dismiss Slack connection"
                  onClick={() => setSlack(false)}
                >
                  <X size={16} />
                </button>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="sourcing-investigation">
          <header>
            <div>
              <button
                className="sourcing-back"
                disabled={!!busy}
                onClick={reset}
              >
                <ArrowLeft size={16} />
                Sourcing
              </button>
              <h1>{active.title}</h1>
              <p>
                {active.source === "pdl"
                  ? "Professional discovery · People Data Labs"
                  : "Your workspace candidate library"}{" "}
                · Private search
              </p>
            </div>
            <div>
              <button
                disabled={!!busy}
                onClick={() => setDeletePending(!deletePending)}
                aria-label="Delete search"
              >
                <Trash2 size={17} />
              </button>
            </div>
          </header>
          <ErrorBanner error={error || active.error || pack?.error || ""} />
          {notice && (
            <p className="sourcing-notice" role="status">
              {notice}
            </p>
          )}
          {deletePending && (
            <div className="sourcing-delete">
              <p>
                Delete this private search, result packs and review notes? Saved
                library candidates will stay.
              </p>
              <Button
                disabled={!!busy}
                onClick={() =>
                  void act("delete", async () => {
                    await api(
                      `sourcing/sessions/${active.id}`,
                      json("DELETE", {}),
                    );
                    reset();
                    await refresh();
                  })
                }
              >
                Delete search
              </Button>
              <Button
                variant="secondary"
                onClick={() => setDeletePending(false)}
              >
                Keep search
              </Button>
            </div>
          )}
          <div className="sourcing-search-grid">
            <aside className="sourcing-plan">
              <div className="sourcing-plan-heading">
                <Sparkles size={18} />
                <h2>Search plan</h2>
              </div>
              <div className="sourcing-conversation">
                {active.events.map((event, i) => (
                  <div key={i} className={event.role}>
                    <strong>
                      {event.role === "user" ? "You" : "ArkOffer"}
                    </strong>
                    <p>{event.text}</p>
                    {!!event.unresolved?.length && (
                      <div className="sourcing-unresolved">
                        <strong>Needs your review</strong>
                        <ul>
                          {event.unresolved.map((item, j) => (
                            <li key={j}>{item}</li>
                          ))}
                        </ul>
                        <small>
                          These requirements are not searchable filters. Review
                          them separately in candidate profiles.
                        </small>
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <Field label="Search name">
                <input
                  maxLength={100}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  disabled={!!busy}
                />
              </Field>
              <Field label="Search mode">
                <select
                  value={mode}
                  onChange={(e) => setMode(e.target.value as Mode)}
                  disabled={!!busy}
                >
                  {modes.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Search source">
                <select
                  value={source}
                  onChange={(e) => setSource(e.target.value as Source)}
                  disabled={!!busy}
                >
                  <option value="workspace">Candidate library</option>
                  <option value="pdl">
                    Professional discovery · People Data Labs
                  </option>
                </select>
              </Field>
              <details className="sourcing-plan-exclusions">
                <summary>
                  <FolderX size={14} />
                  Exclusions{" "}
                  <span>
                    {Number(exclusions.pastSearches) +
                      Number(exclusions.sequenced)}
                  </span>
                </summary>
                {exclusionControls}
              </details>
              {Object.entries(criteriaLabels).map(([key, label]) => (
                <Field key={key} label={label}>
                  <input
                    value={
                      criteriaText[key] ??
                      criteria[key as keyof Criteria].join(", ")
                    }
                    placeholder="Separate alternatives with commas"
                    onChange={(e) => {
                      setCriteriaText({
                        ...criteriaText,
                        [key]: e.target.value,
                      });
                      setCriteria({
                        ...criteria,
                        [key]: e.target.value
                          .split(",")
                          .map((v) => v.trim())
                          .filter(Boolean),
                      });
                    }}
                    disabled={!!busy}
                  />
                </Field>
              ))}
              <p className="sourcing-criteria-help">
                A profile must match each filled group. Terms inside a group are
                alternatives. Workspace results match the saved text; discovery
                uses provider search matching.
              </p>
              <Button
                variant="secondary"
                disabled={!dirty || !!busy || !title.trim()}
                onClick={() =>
                  void act("save", async () => {
                    await save();
                    setNotice("Search criteria saved.");
                  })
                }
              >
                Save criteria
              </Button>
              <Button
                disabled={
                  !!busy ||
                  !title.trim() ||
                  active.status === "planning" ||
                  runPending ||
                  (source === "pdl" && !setup.discoveryAvailable)
                }
                busy={busy === "run"}
                onClick={() => run()}
              >
                <Search size={15} />
                {source === "pdl"
                  ? "Discover up to 20 profiles"
                  : "Search candidate library"}
              </Button>
              {source === "pdl" && (
                <p className="sourcing-criteria-help">
                  {setup.discoveryAvailable
                    ? "Searching sends these criteria to People Data Labs and may use up to 20 provider credits. Exclusions are applied after retrieval, so packs may contain fewer profiles. Candidate contact details are not requested or stored."
                    : "Professional discovery is not connected. Ask your administrator to set PDL_API_KEY and allow this workspace in SOURCING_WORKSPACE_IDS."}
                </p>
              )}
              <button
                className="sourcing-refine"
                disabled={!!busy}
                onClick={() => {
                  setPrompt(active.prompt);
                  setContext(
                    (
                      active.context.slice(0, 15000) +
                      "\n\nPrevious search criteria:\n" +
                      JSON.stringify(criteria)
                    ).slice(0, 20000),
                  );
                  setReference(active.referenceId || "");
                  setProfileInputs(
                    setup.references
                      .filter((r) => active.referenceIds?.includes(r.id))
                      .map((r) => r.profile || "")
                      .filter(Boolean),
                  );
                  setActive(null);
                  setContextOpen(false);
                  request.current = null;
                }}
              >
                <Plus size={14} />
                Refine as a new search
              </button>
            </aside>
            <main className="sourcing-results">
              <div className="sourcing-results-heading">
                <h2>
                  Results{" "}
                  {pack?.status === "ready" && (
                    <span>{pack.results.length}</span>
                  )}
                </h2>
                {active.runs?.length ? (
                  <select
                    aria-label="Result pack"
                    value={selectedPack || pack?.id}
                    onChange={(e) => {
                      setSelectedPack(e.target.value);
                      setSelected([]);
                      setFilter("all");
                    }}
                  >
                    {active.runs.map((p, i) => (
                      <option key={p.id} value={p.id}>
                        Pack {active.runs!.length - i} ·{" "}
                        {new Date(p.createdAt).toLocaleString()} · {p.status}
                      </option>
                    ))}
                  </select>
                ) : null}
              </div>
              {!pack ? (
                <div className="sourcing-empty">
                  <ScanSearch size={38} />
                  <h3>Let's find your next great hire.</h3>
                  <p>
                    Review the search plan and choose a candidate source to
                    begin.
                  </p>
                </div>
              ) : pack.status === "running" ? (
                <Loading />
              ) : pack.status !== "ready" ? (
                <div className="sourcing-empty">
                  <h3>This search needs attention</h3>
                  <p>
                    {pack.error || "Edit your criteria and try another run."}
                  </p>
                </div>
              ) : (
                <>
                  <p className="sourcing-result-context">
                    {pack.results.length} profiles in this pack ·{" "}
                    {pack.total.toLocaleString()} matches reported by{" "}
                    {pack.source === "pdl"
                      ? "People Data Labs"
                      : "your candidate library"}
                    .{" "}
                    {pack.unavailable > 0 &&
                      `${pack.unavailable} changed or deleted profiles are hidden.`}
                  </p>
                  {(pack.exclusions?.pastSearches ||
                    pack.exclusions?.sequenced ||
                    pack.filteredCount > 0) && (
                    <p className="sourcing-result-context">
                      Exclusions in this pack:{" "}
                      {[
                        pack.exclusions?.pastSearches
                          ? "your past results"
                          : "",
                        pack.exclusions?.sequenced
                          ? "sequenced candidates"
                          : "",
                      ]
                        .filter(Boolean)
                        .join(", ") || "reference profiles and duplicates"}
                      . {pack.filteredCount || 0} profiles excluded{" "}
                      {pack.source === "pdl"
                        ? "after provider retrieval. Provider totals are before exclusions; excluded profiles can still consume provider credits."
                        : "before pagination."}
                    </p>
                  )}
                  {(mode === "market" || mode === "talent") && (
                    <div className="sourcing-map">
                      <h3>
                        {mode === "market"
                          ? "Companies in this result pack"
                          : "Roles and locations at requested companies"}
                      </h3>
                      <p>Counts describe this pack only.</p>
                      {grouped.map(([name, count]) => (
                        <div key={name}>
                          <span>{name}</span>
                          <i
                            style={{
                              width: `${Math.max(5, (count / Math.max(1, pack.results.length)) * 100)}%`,
                            }}
                          />
                          <strong>{count}</strong>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="sourcing-result-toolbar">
                    <select
                      aria-label="Filter sourcing reviews"
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                    >
                      <option value="all">All candidates</option>
                      <option value="unreviewed">Unreviewed</option>
                      <option value="yes">Yes</option>
                      <option value="maybe">Maybe</option>
                      <option value="no">No</option>
                    </select>
                    <a
                      className="sourcing-export"
                      href={`/api/sourcing/sessions/${active.id}/runs/${pack.id}/export.csv`}
                    >
                      <Download size={15} />
                      Export CSV
                    </a>
                  </div>
                  {!results.length ? (
                    <div className="sourcing-empty">
                      <h3>No candidates match</h3>
                      <p>
                        Try broader criteria or another review filter. No
                        candidate profiles are generated by AI.
                      </p>
                    </div>
                  ) : (
                    <div className="sourcing-people">
                      {results.map((person) => (
                        <article key={person.key}>
                          <label className="sourcing-select">
                            <input
                              type="checkbox"
                              aria-label={`Select ${person.name}`}
                              checked={selected.includes(person.key)}
                              onChange={(e) =>
                                setSelected(
                                  e.target.checked
                                    ? [...selected, person.key]
                                    : selected.filter((k) => k !== person.key),
                                )
                              }
                            />
                          </label>
                          <span className="sourcing-person-avatar">
                            {person.name.slice(0, 1).toUpperCase()}
                          </span>
                          <div>
                            <button
                              className="sourcing-person-name"
                              onClick={() =>
                                setReview({
                                  ...person,
                                  review: { ...person.review },
                                })
                              }
                            >
                              {person.name}
                            </button>
                            <strong>
                              {person.role || "Role not provided"}
                              {person.company && ` at ${person.company}`}
                            </strong>
                            <p>
                              <MapPin size={12} />
                              {person.location || "Location not provided"}
                            </p>
                            {person.skills && <small>{person.skills}</small>}
                            <div className="sourcing-person-meta">
                              <span>
                                {pack.source === "pdl"
                                  ? "People Data Labs"
                                  : "Candidate library"}
                              </span>
                              {person.profile && (
                                <a
                                  href={person.profile}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  Profile
                                  <ExternalLink size={12} />
                                </a>
                              )}
                            </div>
                          </div>
                          <button
                            className={`sourcing-review-chip ${person.review.status}`}
                            onClick={() =>
                              setReview({
                                ...person,
                                review: { ...person.review },
                              })
                            }
                          >
                            {person.review.status === "unreviewed"
                              ? "Review"
                              : person.review.status}
                          </button>
                        </article>
                      ))}
                    </div>
                  )}
                  {selected.length > 0 && (
                    <div className="sourcing-selection">
                      <span>{selected.length} selected</span>
                      <Button
                        disabled={!!busy}
                        onClick={() =>
                          void act("import", async () => {
                            const data = await api<{ candidateIds: string[] }>(
                              `sourcing/sessions/${active.id}/import`,
                              json("POST", {
                                runId: pack.id,
                                keys: selected,
                                confirm: true,
                              }),
                            );
                            setSelected([]);
                            setNotice(
                              `${data.candidateIds.length} candidates available in your shared candidate library. Open Sequences to enroll them.`,
                            );
                            await refresh();
                          })
                        }
                      >
                        <Plus size={14} />
                        Save to candidate library
                      </Button>
                    </div>
                  )}
                  {pack.hasMore && (
                    <Button
                      variant="secondary"
                      disabled={!!busy || dirty || runPending}
                      onClick={() => run(pack.id)}
                    >
                      Find next 20 profiles
                    </Button>
                  )}
                </>
              )}
            </main>
          </div>
        </div>
      )}
      {guide && (
        <Modal title={guideTitles[guide]} wide onClose={() => setGuide(null)}>
          <p className="sourcing-guide-subtitle">
            Fill in the placeholders, or edit the actual prompt.
          </p>
          <ErrorBanner error={error} />
          <div className="sourcing-guide-grid">
            <div>
              {guide === "lookalikes" && (
                <>
                  {profileInputs.map((url, i) => (
                    <Field key={i} label={`LinkedIn profile ${i + 1}`}>
                      <input
                        type="url"
                        maxLength={1000}
                        placeholder="https://www.linkedin.com/in/..."
                        value={url}
                        onChange={(e) => {
                          const values = profileInputs.map((v, j) =>
                            j === i ? e.target.value : v,
                          );
                          setProfileInputs(values);
                          setGuidePrompt(
                            guidedText(guide, guideFields, values),
                          );
                        }}
                      />
                    </Field>
                  ))}
                  <Button
                    variant="secondary"
                    disabled={profileInputs.length >= 5}
                    onClick={() => setProfileInputs([...profileInputs, ""])}
                  >
                    <Plus size={14} />
                    Add another profile
                  </Button>
                  <Field label="Or choose a saved reference candidate">
                    <select
                      value={reference}
                      onChange={(e) => setReference(e.target.value)}
                    >
                      <option value="">Select a candidate</option>
                      {setup?.references.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} · {c.role || c.company}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <p className="sourcing-criteria-help">
                    LinkedIn links must match profiles already saved in your
                    candidate library. Import or enrich professional details
                    first; the text AI does not open external profile URLs.
                  </p>
                </>
              )}
              {Object.entries(modeFields[guide]).map(([key, label]) => (
                <Field key={key} label={label}>
                  {[
                    "jobDescription",
                    "additionalContext",
                    "similarity",
                  ].includes(key) ? (
                    <textarea
                      rows={key === "jobDescription" ? 7 : 3}
                      value={guideFields[key]}
                      maxLength={3000}
                      placeholder={label}
                      onChange={(e) => {
                        const fields = {
                          ...guideFields,
                          [key]: e.target.value,
                        };
                        setGuideFields(fields);
                        setGuidePrompt(
                          guidedText(guide, fields, profileInputs),
                        );
                      }}
                    />
                  ) : (
                    <input
                      value={guideFields[key]}
                      maxLength={key === "additional" ? 1000 : 300}
                      placeholder={label}
                      onChange={(e) => {
                        const fields = {
                          ...guideFields,
                          [key]: e.target.value,
                        };
                        setGuideFields(fields);
                        setGuidePrompt(
                          guidedText(guide, fields, profileInputs),
                        );
                      }}
                    />
                  )}
                </Field>
              ))}
              <div className="sourcing-guide-attachment">
                <strong>Attachments</strong>
                <button onClick={() => attachment.current?.click()}>
                  <Paperclip size={15} />
                  Upload
                </button>
                <small>
                  {context
                    ? `${context.length.toLocaleString()} characters attached`
                    : "Text and Markdown briefs up to 20 KB"}
                </small>
              </div>
            </div>
            <div>
              <Field label="Actual prompt">
                <textarea
                  rows={17}
                  maxLength={5000}
                  value={guidePrompt}
                  onChange={(e) => setGuidePrompt(e.target.value)}
                />
              </Field>
              <p className="sourcing-criteria-help">
                You can edit this prompt directly. Changing a field rebuilds it.
                The next screen lets you review the search criteria before
                finding profiles.
              </p>
            </div>
          </div>
          <div className="sourcing-guide-footer">
            <Button variant="secondary" onClick={() => setGuide(null)}>
              Go back
            </Button>
            <Button
              disabled={
                !!busy ||
                !guidePrompt.trim() ||
                (guide === "lookalikes" &&
                  !reference &&
                  !profileInputs.some((p) => p.trim()))
              }
              onClick={() => {
                setPrompt(guidePrompt);
                setGuide(null);
                if (setup?.aiAvailable) start(false, guidePrompt);
              }}
            >
              {setup?.aiAvailable ? "Run" : "Use prompt"}
              <ArrowUp size={15} />
            </Button>
          </div>
        </Modal>
      )}
      {review && active && pack && (
        <Modal title={`Review ${review.name}`} onClose={() => setReview(null)}>
          <div className="sourcing-review-content">
            <p>
              {review.role} {review.company && `at ${review.company}`}
            </p>
            <p>{review.location}</p>
            <p>{review.skills}</p>
            <Field label="Your review">
              <select
                value={review.review.status}
                onChange={(e) =>
                  setReview({
                    ...review,
                    review: { ...review.review, status: e.target.value },
                  })
                }
              >
                <option value="unreviewed">Unreviewed</option>
                <option value="yes">Yes</option>
                <option value="maybe">Maybe</option>
                <option value="no">No</option>
              </select>
            </Field>
            <Field label="Private review notes">
              <textarea
                rows={5}
                maxLength={10_000}
                value={review.review.notes}
                onChange={(e) =>
                  setReview({
                    ...review,
                    review: { ...review.review, notes: e.target.value },
                  })
                }
              />
            </Field>
            <p className="sourcing-criteria-help">
              Your assessment stays in this private search. It does not change
              an application or contact this person.
            </p>
            <Button
              disabled={!!busy}
              onClick={() =>
                void act("review", async () => {
                  await api(
                    `sourcing/sessions/${active.id}/reviews`,
                    json("PATCH", {
                      runId: pack.id,
                      key: review.key,
                      ...review.review,
                    }),
                  );
                  const current = pack.id;
                  await load(active.id);
                  setSelectedPack(current);
                  setReview(null);
                  setNotice("Private review saved.");
                })
              }
            >
              <Check size={15} />
              Save review
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );
}
