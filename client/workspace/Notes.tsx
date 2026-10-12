import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Check,
  CheckCheck,
  ChevronDown,
  Copy,
  Download,
  FileText,
  Folder,
  FolderPlus,
  History,
  Layers,
  Link2,
  MessageSquare,
  Mic,
  MoreHorizontal,
  PanelRightClose,
  Plus,
  Search,
  Send,
  Share2,
  Sparkles,
  Trash2,
  Upload,
  UserRound,
  Video,
  X,
} from "lucide-react";
import {
  api,
  json,
  useItems,
  Button,
  Field,
  Modal,
  Empty,
  Loading,
  ErrorBanner,
  SearchBox,
  Avatar,
  useToast,
  niceDate,
  downloadText,
  type Item,
} from "../ui";
type Section = { id: string; title: string; content: string };
export default function Notes() {
  const location = useLocation(),
    navigate = useNavigate();
  const { items, loading, error, refresh } = useItems("conversations"),
    collections = useItems("collections");
  const [search, setSearch] = useState(""),
    [archived, setArchived] = useState(false),
    [upload, setUpload] = useState(false),
    [newCollection, setNewCollection] = useState(false),
    [setup, setSetup] = useState(true),
    [selection, setSelection] = useState<string[]>([]);
  const toast = useToast();
  const parts = location.pathname.split("/").filter(Boolean),
    id =
      parts[1] && !["upcoming", "shared", "collection"].includes(parts[1])
        ? parts[1]
        : null,
    filter = parts[1] || "mine",
    collectionId = parts[2];
  const visible = items.filter(
    (n) =>
      (filter === "upcoming"
        ? n.status === "upcoming"
        : filter === "shared"
          ? n.shared
          : filter === "collection"
            ? (n.collectionIds || []).includes(collectionId)
            : n.status !== "upcoming") &&
      Boolean(n.archived) === archived &&
      `${n.title} ${n.candidate || ""} ${n.interviewer || ""}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  async function bulk(mode: string) {
    try {
      await Promise.all(
        selection.map((id) =>
          api(
            `conversations/${id}`,
            json("PATCH", { archived: mode === "archive" }),
          ),
        ),
      );
      setSelection([]);
      await refresh();
      toast(
        mode === "archive"
          ? "Conversations archived"
          : "Conversations restored",
      );
    } catch (e) {
      toast((e as Error).message);
    }
  }
  return (
    <>
      <div className="notes-actions">
        <Button onClick={() => setUpload(true)}>
          <Upload size={17} />
          Upload conversation
        </Button>
      </div>
      {id ? (
        <Conversation
          key={id}
          id={id}
          collections={collections.items}
          onChanged={refresh}
        />
      ) : (
        <div className={`notes-layout ${setup ? "with-setup" : ""}`}>
          <aside className="notes-folders">
            <p className="eyebrow">CONVERSATIONS</p>
            <Link className={filter === "mine" ? "selected" : ""} to="/notes">
              <UserRound size={18} />
              My conversations
            </Link>
            <Link
              className={filter === "upcoming" ? "selected" : ""}
              to="/notes/upcoming"
            >
              <CalendarDays size={18} />
              Upcoming
            </Link>
            <Link
              className={filter === "shared" ? "selected" : ""}
              to="/notes/shared"
            >
              <Share2 size={18} />
              Shared conversations
            </Link>
            <div className="collection-heading">
              <p className="eyebrow">COLLECTIONS</p>
              <button
                className="text-btn"
                onClick={() => setNewCollection(true)}
              >
                <Plus size={16} />
                New collection
              </button>
            </div>
            {collections.items.length ? (
              collections.items.map((c) => (
                <div className="collection-row" key={c.id}>
                  <Link
                    className={collectionId === c.id ? "selected" : ""}
                    to={`/notes/collection/${c.id}`}
                  >
                    <Folder size={17} />
                    {c.name || c.title}
                  </Link>
                  <button
                    className="icon-btn"
                    aria-label={`Delete collection ${c.name}`}
                    onClick={async () => {
                      if (
                        !confirm(
                          "Delete this collection? Conversations will be kept.",
                        )
                      )
                        return;
                      try {
                        await api(`collections/${c.id}`, { method: "DELETE" });
                        await collections.refresh();
                        navigate("/notes");
                      } catch (e) {
                        toast((e as Error).message);
                      }
                    }}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))
            ) : (
              <div className="empty-collections">
                <Layers size={26} />
                <span>No collections yet</span>
              </div>
            )}
          </aside>
          <main className="conversation-list">
            <div className="list-toolbar">
              <div className="bulk-actions">
                <select
                  aria-label="Conversation actions"
                  disabled={!selection.length}
                  value=""
                  onChange={(e) => void bulk(e.target.value)}
                >
                  <option value="">
                    Actions{selection.length ? ` (${selection.length})` : ""}
                  </option>
                  <option value={archived ? "restore" : "archive"}>
                    {archived ? "Restore" : "Archive"}
                  </option>
                </select>
              </div>
              <label className="switch-label">
                <input
                  type="checkbox"
                  role="switch"
                  checked={archived}
                  onChange={(e) => setArchived(e.target.checked)}
                />
                <span>Show archive</span>
              </label>
              <SearchBox value={search} onChange={setSearch} />
              {!setup && (
                <button
                  className="icon-btn"
                  aria-label="Show conversation setup"
                  onClick={() => setSetup(true)}
                >
                  <PanelRightClose size={18} />
                </button>
              )}
            </div>
            <ErrorBanner error={error} />
            {loading ? (
              <Loading />
            ) : visible.length ? (
              <div className="conversation-rows">
                {visible.map((n) => (
                  <div className="conversation-row" key={n.id}>
                    <input
                      type="checkbox"
                      aria-label={`Select ${n.title}`}
                      checked={selection.includes(n.id)}
                      onChange={(e) =>
                        setSelection(
                          e.target.checked
                            ? [...selection, n.id]
                            : selection.filter((i) => i !== n.id),
                        )
                      }
                    />
                    <Link className="conversation-open" to={`/notes/${n.id}`}>
                      <div className="conversation-thumbnail">
                        <Avatar name={n.candidate || n.title} />
                        <Video size={13} />
                      </div>
                      <span className="conversation-name">
                        <strong>{n.title}</strong>
                        <span>
                          {n.candidate || "Conversation"}
                          {n.interviewer ? ` with ${n.interviewer}` : ""}
                        </span>
                      </span>
                      <time>{niceDate(n.date || n.createdAt || "")}</time>
                      {n.status === "processing" && (
                        <span className="badge amber">Needs transcript</span>
                      )}
                    </Link>
                    <button
                      className="icon-btn"
                      aria-label={`${n.archived ? "Restore" : "Archive"} ${n.title}`}
                      onClick={async () => {
                        try {
                          await api(
                            `conversations/${n.id}`,
                            json("PATCH", { archived: !n.archived }),
                          );
                          await refresh();
                          toast(
                            n.archived
                              ? "Conversation restored"
                              : "Conversation archived",
                          );
                        } catch (e) {
                          toast((e as Error).message);
                        }
                      }}
                    >
                      <Archive size={16} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <Empty
                title={
                  search
                    ? "No conversations found"
                    : filter === "upcoming"
                      ? "Your next conversation starts here"
                      : filter === "shared"
                        ? "Shared conversations appear here"
                        : "A little more presence. A lot less note-taking."
                }
                action={
                  <Button onClick={() => setUpload(true)}>
                    <Upload size={16} />
                    Add a conversation
                  </Button>
                }
              >
                {search
                  ? "Try a different name or title."
                  : filter === "upcoming"
                    ? "Add a scheduled conversation to keep track of upcoming interviews."
                    : "Upload a recording or paste a transcript to make your first set of notes."}
              </Empty>
            )}
            <div className="list-footer">
              <span>
                {visible.length} conversation{visible.length === 1 ? "" : "s"}
              </span>
              <button className="text-btn" onClick={() => setUpload(true)}>
                <Plus size={14} />
                New conversation
              </button>
            </div>
          </main>
          {setup && (
            <Setup
              onClose={() => setSetup(false)}
              onUpload={() => setUpload(true)}
            />
          )}
        </div>
      )}
      {upload && (
        <UploadModal
          onClose={() => setUpload(false)}
          onDone={async (id) => {
            setUpload(false);
            await refresh();
            navigate(`/notes/${id}`);
          }}
        />
      )}
      {newCollection && (
        <Modal title="New collection" onClose={() => setNewCollection(false)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              try {
                const r = await api(
                  "collections",
                  json("POST", { name: f.get("name") }),
                );
                await collections.refresh();
                setNewCollection(false);
                navigate(`/notes/collection/${r.item.id}`);
              } catch (e) {
                toast((e as Error).message);
              }
            }}
          >
            <Field label="Collection name">
              <input
                name="name"
                placeholder="e.g. Engineering interviews"
                required
                autoFocus
                maxLength={120}
              />
            </Field>
            <div className="form-actions">
              <Button variant="primary" type="submit">
                Create collection
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
function Setup({
  onClose,
  onUpload,
}: {
  onClose: () => void;
  onUpload: () => void;
}) {
  return (
    <aside className="setup-panel">
      <button
        className="icon-btn setup-close"
        aria-label="Hide conversation setup"
        onClick={onClose}
      >
        <PanelRightClose size={18} />
      </button>
      <div className="setup-card">
        <h3>
          <UserRound size={19} />
          Set up your workspace
        </h3>
        <div className="setup-step">
          <h4>
            <Upload size={19} />
            Add your first conversation
          </h4>
          <p>
            Bring in a recording or transcript. Keep the context, questions, and
            next steps together.
          </p>
          <Button onClick={onUpload}>
            Upload conversation
            <ArrowRight size={16} />
          </Button>
        </div>
        <div className="setup-step">
          <h4>
            <CalendarDays size={19} />
            Connect your calendar
          </h4>
          <p>
            See the available calendar providers and what is needed to connect
            your account.
          </p>
          <Link className="btn" to="/app/settings?tab=integrations">
            Calendar settings
            <ArrowRight size={16} />
          </Link>
        </div>
        <div className="setup-step">
          <h4>
            <Link2 size={19} />
            Connect your ATS
          </h4>
          <p>
            Bring your recruiting workflow together with an applicant tracking
            system.
          </p>
          <Link className="btn" to="/app/settings?tab=integrations">
            Explore integrations
            <ArrowRight size={16} />
          </Link>
        </div>
        <div className="setup-step">
          <h4>
            <Mic size={19} />
            Record a conversation
          </h4>
          <p>
            Record using your browser microphone, then save it with your
            interview notes.
          </p>
          <Button onClick={onUpload}>
            Start a recording
            <ArrowRight size={16} />
          </Button>
        </div>
      </div>
    </aside>
  );
}
function UploadModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (id: string) => void;
}) {
  const [tab, setTab] = useState("transcript"),
    [file, setFile] = useState<File | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [microphonePending, setMicrophonePending] = useState(false),
    [recording, setRecording] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null),
    stream = useRef<MediaStream | null>(null),
    recordingSession = useRef(0);
  const toast = useToast();
  useEffect(() => {
    setRecording(false);
    setMicrophonePending(false);
    return () => {
      recordingSession.current += 1;
      if (recorder.current?.state === "recording") recorder.current.stop();
      stream.current?.getTracks().forEach((t) => t.stop());
    };
  }, [tab]);
  async function record() {
    const session = recordingSession.current;
    setMicrophonePending(true);
    setError("");
    try {
      const acquiredStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      if (session !== recordingSession.current) {
        acquiredStream.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.current = acquiredStream;
      const r = new MediaRecorder(acquiredStream);
      recorder.current = r;
      const chunks: BlobPart[] = [];
      r.ondataavailable = (e) => chunks.push(e.data);
      r.onstop = () => {
        acquiredStream.getTracks().forEach((t) => t.stop());
        if (session !== recordingSession.current) return;
        setFile(
          new File(chunks, `conversation-${Date.now()}.webm`, {
            type: r.mimeType || "audio/webm",
          }),
        );
        setRecording(false);
      };
      r.start();
      setRecording(true);
    } catch (e) {
      stream.current?.getTracks().forEach((t) => t.stop());
      if (session === recordingSession.current) setError((e as Error).message);
    } finally {
      if (session === recordingSession.current) setMicrophonePending(false);
    }
  }
  return (
    <Modal title="Add a conversation" onClose={onClose} wide>
      <div className="tabs" role="tablist">
        {[
          ["transcript", "Paste transcript"],
          ["upload", "Upload file"],
          ["record", "Record"],
          ["schedule", "Schedule"],
        ].map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? "active" : ""}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          setBusy(true);
          const f = new FormData(e.currentTarget);
          try {
            let r;
            if (file && tab !== "transcript" && tab !== "schedule") {
              const data = new FormData();
              data.set("title", String(f.get("title")));
              data.set("candidate", String(f.get("candidate") || ""));
              data.set("file", file);
              r = await api("conversations/upload", {
                method: "POST",
                body: data,
              });
            } else {
              const transcript = String(f.get("transcript") || "");
              r = await api(
                "conversations",
                json("POST", {
                  title: f.get("title"),
                  candidate: f.get("candidate"),
                  interviewer: f.get("interviewer") || "",
                  date: f.get("date") || new Date().toISOString(),
                  transcript,
                  status: tab === "schedule" ? "upcoming" : "ready",
                  sections: [],
                  tldr: "",
                  archived: false,
                  collectionIds: [],
                }),
              );
              if (transcript.trim()) {
                try {
                  await api(
                    `conversations/${r.item.id}/generate`,
                    json("POST", {}),
                  );
                } catch (error) {
                  toast(`Conversation saved. ${(error as Error).message}`);
                }
              }
            }
            onDone(r.item.id);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="form-grid">
          <Field label="Conversation title">
            <input
              name="title"
              placeholder="e.g. Product designer · First interview"
              required
              maxLength={200}
            />
          </Field>
          <Field label="Candidate">
            <input
              name="candidate"
              placeholder="Candidate name"
              maxLength={150}
            />
          </Field>
        </div>
        {tab === "transcript" && (
          <Field
            label="Transcript"
            hint="Paste the conversation, including speaker names if available."
          >
            <textarea
              name="transcript"
              placeholder="Interviewer: Tell me about your recent work.\nCandidate: …"
              rows={10}
              required
            />
          </Field>
        )}
        {tab === "upload" && (
          <label className="upload-zone">
            <Upload size={32} />
            <strong>
              {file ? file.name : "Choose a recording or document"}
            </strong>
            <span>Audio, video, TXT or VTT · 50 MB · PDF or DOCX · 10 MB</span>
            <input
              type="file"
              accept="audio/*,video/*,.txt,.vtt,.pdf,.docx"
              required
              onChange={(e) => setFile(e.target.files?.[0] || null)}
            />
          </label>
        )}
        {tab === "record" && (
          <div className="record-zone">
            <Mic size={34} />
            <h3>
              {recording
                ? "Recording in progress"
                : file
                  ? "Recording ready to save"
                  : "Capture a live conversation"}
            </h3>
            <p>Let everyone know you are recording before you start.</p>
            <Button
              type="button"
              busy={microphonePending}
              onClick={() =>
                recording ? recorder.current?.stop() : void record()
              }
            >
              {recording ? (
                <>
                  <span className="record-dot" />
                  Stop recording
                </>
              ) : (
                <>
                  <Mic size={17} />
                  {file ? "Record again" : "Start recording"}
                </>
              )}
            </Button>
            {file && <span>{file.name}</span>}
          </div>
        )}
        {tab === "schedule" && (
          <>
            <Field label="Date and time">
              <input type="datetime-local" name="date" required />
            </Field>
            <Field label="Interviewer">
              <input name="interviewer" />
            </Field>
            <p className="muted">
              This creates an upcoming entry. Calendar invitations and meeting
              bots require a connected provider.
            </p>
          </>
        )}
        {(tab === "upload" || tab === "record") && (
          <p className="muted">
            Audio and video transcription requires the workspace's transcription
            provider. You can also paste a transcript.
          </p>
        )}
        <ErrorBanner error={error} />
        <div className="form-actions">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            busy={busy}
            disabled={
              recording || ((tab === "upload" || tab === "record") && !file)
            }
          >
            {tab === "schedule" ? "Schedule conversation" : "Save conversation"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
function Conversation({
  id,
  collections,
  onChanged,
}: {
  id: string;
  collections: Item[];
  onChanged: () => Promise<void>;
}) {
  const [note, setNote] = useState<Item | null>(null),
    [error, setError] = useState(""),
    [tab, setTab] = useState("Summary"),
    [right, setRight] = useState("sources"),
    [modal, setModal] = useState(""),
    [versions, setVersions] = useState<Item[]>([]),
    [shares, setShares] = useState<Item[]>([]),
    [newShare, setNewShare] = useState(""),
    [question, setQuestion] = useState(""),
    [messages, setMessages] = useState<
      { role: string; text: string; citations?: any[]; mode?: string }[]
    >([]),
    [busy, setBusy] = useState(false),
    [saveState, setSaveState] = useState("Saved"),
    [format, setFormat] = useState("bullets"),
    [length, setLength] = useState("standard"),
    [language, setLanguage] = useState(""),
    [transcriptSearch, setTranscriptSearch] = useState("");
  const [templates, setTemplates] = useState<Item[]>([]);
  const toast = useToast();
  const navigate = useNavigate();
  const queue = useRef(Promise.resolve()),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    Promise.all([api(`conversations/${id}`), api("settings")])
      .then(([r, preferences]) => {
        if (cancelled) return;
        setNote(r.item);
        setFormat(
          r.item.summaryPreferences?.format ||
            (preferences.settings?.noteFormat === "Paragraphs"
              ? "paragraphs"
              : "bullets"),
        );
        setLength(
          r.item.summaryPreferences?.length ||
            preferences.settings?.noteLength ||
            "standard",
        );
        setLanguage("");
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
      alive.current = false;
    };
  }, [id]);
  async function save(patch: Record<string, any>) {
    let saved = false;
    setNote((n) => (n ? { ...n, ...patch } : n));
    setSaveState("Saving…");
    setError("");
    queue.current = queue.current.then(async () => {
      try {
        await api(`conversations/${id}`, json("PATCH", patch));
        saved = true;
        if (alive.current) setSaveState("Saved");
      } catch (e) {
        if (alive.current) {
          setSaveState("Save failed");
          setError((e as Error).message);
        }
      }
    });
    await queue.current;
    await onChanged();
    return saved;
  }
  async function generate(opts: Record<string, any> = {}) {
    setBusy(true);
    setError("");
    try {
      await queue.current;
      const r = await api(
        `conversations/${id}/generate`,
        json("POST", {
          format,
          length,
          ...(language ? { language } : {}),
          ...opts,
        }),
      );
      setNote(r.item);
      toast(
        r.mode === "extractive"
          ? "Notes extracted from your transcript"
          : "Notes generated",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(
        (note?.sections || [])
          .map((s: Section) => `${s.title}\n${s.content}`)
          .join("\n\n"),
      );
      toast("Notes copied");
    } catch {
      toast("Clipboard unavailable. Use Download text instead.");
    }
  }
  async function showHistory() {
    try {
      const r = await api(`conversations/${id}/versions`);
      setVersions(r.items);
      setModal("versions");
    } catch (e) {
      toast((e as Error).message);
    }
  }
  async function showShares() {
    try {
      const r = await api(`conversations/${id}/shares`);
      setShares(r.items);
      setModal("share");
    } catch (e) {
      toast((e as Error).message);
    }
  }
  if (error && !note) return <ErrorBanner error={error} />;
  if (!note) return <Loading />;
  const sections: Section[] = note.sections || [];
  const updateSection = (i: number, patch: Partial<Section>) => {
    const next = sections.map((s, j) => (j === i ? { ...s, ...patch } : s));
    return save({ sections: next });
  };
  const transcriptLines = String(note.transcript || "")
    .split("\n")
    .filter((s: string) => s.trim());
  return (
    <fieldset
      className="detail"
      disabled={busy}
      aria-busy={busy}
      aria-label="Conversation"
    >
      <main className="note-main">
        <div className="note-title">
          <Link
            to="/notes"
            className="icon-btn"
            aria-label="Back to conversations"
          >
            <ArrowLeft size={18} />
          </Link>
          <input
            aria-label="Conversation title"
            value={note.title}
            onChange={(e) => setNote({ ...note, title: e.target.value })}
            onBlur={(e) => void save({ title: e.target.value })}
          />
          <button
            className="icon-btn"
            aria-label="Version history"
            onClick={() => void showHistory()}
          >
            <History size={18} />
          </button>
        </div>
        <div className="note-tabs tabs" role="tablist">
          {["Summary", "TLDR", "Snippets"].map((t) => (
            <button
              role="tab"
              aria-selected={tab === t}
              className={tab === t ? "active" : ""}
              key={t}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </div>
        <div className="note-toolbar">
          <button
            onClick={async () => {
              try {
                const r = await api("templates");
                setTemplates(r.items);
                setModal("template");
              } catch (e) {
                toast((e as Error).message);
              }
            }}
          >
            <Layers size={15} />
            Use template
          </button>
          <select
            aria-label="Note format"
            value={format}
            onChange={(e) => setFormat(e.target.value)}
          >
            <option value="bullets">Bullets</option>
            <option value="paragraphs">Paragraphs</option>
          </select>
          <select
            aria-label="Note length"
            value={length}
            onChange={(e) => setLength(e.target.value)}
          >
            <option value="concise">Concise</option>
            <option value="standard">Standard length</option>
            <option value="detailed">Detailed</option>
          </select>
          <select
            aria-label="Translate notes"
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
          >
            <option value="">Workspace language</option>
            <option value="original">Original language</option>
            {[
              "English",
              "Chinese",
              "French",
              "German",
              "Spanish",
              "Japanese",
              "Portuguese",
              "Italian",
              "Korean",
              "Arabic",
              "Hindi",
              "Dutch",
              "Swedish",
              "Danish",
              "Norwegian",
              "Finnish",
              "Polish",
              "Turkish",
              "Indonesian",
              "Vietnamese",
              "Thai",
            ].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
          <Button busy={busy} onClick={() => void generate()}>
            <Sparkles size={14} />
            Regenerate
          </Button>
          <button onClick={() => void copy()}>
            <Copy size={15} />
            Copy
          </button>
        </div>
        <ErrorBanner error={error} />
        <div className="note-content">
          {tab === "Summary" ? (
            <>
              {sections.length ? (
                sections.map((s, i) => (
                  <section className="note-section" key={s.id || i}>
                    <div className="section-meta">
                      <button
                        onClick={() => {
                          setRight("transcript");
                          setTranscriptSearch("");
                        }}
                      >
                        <Link2 size={12} />
                        Transcript source
                      </button>
                      <div>
                        <button
                          aria-label={`Move ${s.title} up`}
                          disabled={i === 0}
                          onClick={() => {
                            const arr = [...sections];
                            [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]];
                            void save({ sections: arr });
                          }}
                        >
                          ↑
                        </button>
                        <button
                          aria-label={`Delete ${s.title}`}
                          onClick={() =>
                            void save({
                              sections: sections.filter((_, j) => j !== i),
                            })
                          }
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>
                    <input
                      className="section-title"
                      aria-label={`Section ${i + 1} title`}
                      value={s.title}
                      onChange={(e) =>
                        setNote({
                          ...note,
                          sections: sections.map((v, j) =>
                            j === i ? { ...v, title: e.target.value } : v,
                          ),
                        })
                      }
                      onBlur={(e) =>
                        void updateSection(i, { title: e.target.value })
                      }
                    />
                    <textarea
                      aria-label={`${s.title} notes`}
                      className={format}
                      style={{
                        height: `${Math.max(95, s.content.split("\n").length * 27 + Math.ceil(s.content.length / 95) * 17)}px`,
                      }}
                      value={s.content}
                      onChange={(e) =>
                        setNote({
                          ...note,
                          sections: sections.map((v, j) =>
                            j === i ? { ...v, content: e.target.value } : v,
                          ),
                        })
                      }
                      onBlur={(e) =>
                        void updateSection(i, { content: e.target.value })
                      }
                    />
                  </section>
                ))
              ) : (
                <Empty
                  title="Ready for your notes"
                  action={
                    <Button onClick={() => void generate()} busy={busy}>
                      <Sparkles size={16} />
                      Generate notes
                    </Button>
                  }
                >
                  {note.transcript
                    ? "Create a summary from this transcript or add your own sections."
                    : "Add a transcript to create notes from this conversation."}
                </Empty>
              )}
              <button
                className="add-section"
                onClick={() =>
                  void save({
                    sections: [
                      ...sections,
                      {
                        id: crypto.randomUUID(),
                        title: "New section",
                        content: "",
                      },
                    ],
                  })
                }
              >
                <Plus size={16} />
                Add section
              </button>
            </>
          ) : tab === "TLDR" ? (
            <section className="note-section">
              <h2>The short version</h2>
              <textarea
                aria-label="TLDR notes"
                rows={12}
                value={note.tldr || ""}
                onChange={(e) => setNote({ ...note, tldr: e.target.value })}
                onBlur={(e) => void save({ tldr: e.target.value })}
                placeholder="Write a brief overview of this conversation."
              />
            </section>
          ) : (
            <>
              <div className="section-heading">
                <h2>Conversation snippets</h2>
                <Button onClick={() => setModal("snippet")}>
                  <Plus size={15} />
                  New snippet
                </Button>
              </div>
              {(note.snippets || []).length ? (
                (note.snippets || []).map((s: any, i: number) => (
                  <article className="snippet" key={s.id}>
                    <div>
                      <strong>{s.title}</strong>
                      <button
                        className="icon-btn"
                        aria-label={`Delete snippet ${s.title}`}
                        onClick={() =>
                          void save({
                            snippets: note.snippets.filter(
                              (_: any, j: number) => i !== j,
                            ),
                          })
                        }
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                    <blockquote>{s.text}</blockquote>
                    <p>{s.note}</p>
                  </article>
                ))
              ) : (
                <Empty title="Keep the moments that matter">
                  Save a transcript excerpt with a title and your own context.
                </Empty>
              )}
            </>
          )}
        </div>
        <div className="note-status">
          <span>
            <CheckCheck size={14} />
            {saveState}
          </span>
          <button onClick={() => void showHistory()}>
            <History size={13} />
            Version history
          </button>
          <Button
            variant="primary"
            onClick={() =>
              setRight(right === "assistant" ? "sources" : "assistant")
            }
          >
            <Sparkles size={15} />
            Ask AI
          </Button>
        </div>
      </main>
      <aside className="note-side">
        <div className="side-tabs">
          <button
            className={right === "sources" ? "active" : ""}
            onClick={() => setRight("sources")}
          >
            Sources
          </button>
          <button
            className={right === "transcript" ? "active" : ""}
            onClick={() => setRight("transcript")}
          >
            Transcript
          </button>
          <button
            className={right === "assistant" ? "active" : ""}
            onClick={() => setRight("assistant")}
          >
            Ask AI
          </button>
        </div>
        {right === "sources" ? (
          <div className="sources-panel">
            <p className="eyebrow">SOURCES</p>
            <button
              className="source-card"
              onClick={() => setRight("transcript")}
            >
              <span className="source-icon">
                <FileText size={24} />
              </span>
              <small>{niceDate(note.date || note.createdAt || "")}</small>
              <strong>{note.title}</strong>
              <span>
                {note.candidate}
                {note.interviewer ? ` · ${note.interviewer}` : ""}
              </span>
              <small>
                Transcript{note.duration ? ` · ${note.duration}` : ""}
              </small>
            </button>
            <Button onClick={() => setModal("transcript")}>
              <Plus size={15} />
              {note.transcript ? "Edit transcript" : "Add transcript"}
            </Button>
            {note.file?.name ? (
              <a className="text-btn" href={`/api/conversations/${id}/file`}>
                <Download size={15} />
                Download source file
              </a>
            ) : null}
            <p className="eyebrow actions-label">ACTIONS</p>
            {note.file && /^(audio|video)\//.test(note.file.mimeType) && (
              <Button
                busy={busy}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    await queue.current;
                    const r = await api(
                      `conversations/${id}/transcribe`,
                      json("POST", {}),
                    );
                    setNote(r.item);
                    toast("Recording transcribed");
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Transcribe recording
              </Button>
            )}
            <button className="side-action" onClick={() => void copy()}>
              <Copy size={17} />
              Copy notes
            </button>
            <button className="side-action" onClick={() => void showShares()}>
              <Share2 size={17} />
              Share & export
            </button>
            <button
              className="side-action"
              onClick={() => setModal("collection")}
            >
              <FolderPlus size={17} />
              Add to collection
            </button>
            <button
              className="side-action"
              onClick={() => {
                downloadText(
                  `${note.title}.txt`,
                  sections.map((s) => `${s.title}\n${s.content}`).join("\n\n"),
                );
              }}
            >
              <Download size={17} />
              Download text
            </button>
            <button className="side-action" onClick={() => window.print()}>
              <FileText size={17} />
              Print / save PDF
            </button>
            <button
              className="side-action"
              onClick={() => void save({ archived: !note.archived })}
            >
              <Archive size={17} />
              {note.archived ? "Restore conversation" : "Archive conversation"}
            </button>
            <button
              className="side-action danger"
              onClick={async () => {
                if (
                  !confirm(
                    "Permanently delete this conversation, its source file and shared links?",
                  )
                )
                  return;
                setBusy(true);
                try {
                  await queue.current;
                  await api(`conversations/${id}`, { method: "DELETE" });
                  await onChanged();
                  navigate("/notes");
                  toast("Conversation deleted");
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Trash2 size={17} />
              Delete conversation
            </button>
            {note.summarySource?.truncated && (
              <p className="muted">
                The summary covers the first{" "}
                {note.summarySource.characters.toLocaleString()} of{" "}
                {note.summarySource.totalCharacters.toLocaleString()} transcript
                characters.
              </p>
            )}
            {note.transcriptionMessage && (
              <p className="muted">{note.transcriptionMessage}</p>
            )}
            <div className="note-info">
              <p>
                {note.summaryMode === "extractive"
                  ? "These notes use transcript extraction. Connect an AI provider for model-generated summaries."
                  : "Notes are saved in your workspace."}
              </p>
              <Link to="/app/settings?tab=integrations">
                Manage integrations
                <ArrowRight size={13} />
              </Link>
            </div>
          </div>
        ) : right === "transcript" ? (
          <div className="transcript-panel">
            <SearchBox
              value={transcriptSearch}
              onChange={setTranscriptSearch}
              placeholder="Search transcript"
            />
            {note.file?.name &&
              /\.(mp4|webm|mov|mp3|wav|m4a|ogg)$/i.test(note.file.name) && (
                <video
                  controls
                  src={`/api/conversations/${id}/media`}
                  preload="metadata"
                />
              )}
            <div className="transcript-actions">
              <button
                className="text-btn"
                onClick={() => setModal("transcript")}
              >
                Edit transcript
              </button>
              <button
                className="icon-btn"
                aria-label="Download transcript"
                onClick={() =>
                  downloadText(
                    `${note.title}-transcript.txt`,
                    note.transcript || "",
                  )
                }
              >
                <Download size={16} />
              </button>
            </div>
            {transcriptLines.length ? (
              transcriptLines
                .filter((line: string) =>
                  line.toLowerCase().includes(transcriptSearch.toLowerCase()),
                )
                .map((line: string, i: number) => (
                  <p className="transcript-line" key={i}>
                    <span>{String(i + 1).padStart(2, "0")}</span>
                    {line}
                  </p>
                ))
            ) : (
              <Empty
                title="No transcript yet"
                action={
                  <Button onClick={() => setModal("transcript")}>
                    Add transcript
                  </Button>
                }
              >
                Paste a transcript to start working with this conversation.
              </Empty>
            )}
          </div>
        ) : (
          <div className="assistant-panel">
            <div className="assistant-intro">
              <Sparkles size={24} />
              <h3>Ask about this conversation</h3>
              <p>
                Find details in the transcript, with source excerpts you can
                verify.
              </p>
            </div>
            <div className="chat-messages">
              {messages.map((m, i) => (
                <div key={i} className={`chat-message ${m.role}`}>
                  <strong>{m.role === "user" ? "You" : "ArkOffer"}</strong>
                  <p>{m.text}</p>
                  {m.mode === "extractive" && (
                    <small>
                      Transcript search · AI provider not configured
                    </small>
                  )}
                  {m.citations?.map((c, j) => (
                    <button
                      className="citation"
                      key={j}
                      onClick={() => {
                        setRight("transcript");
                        setTranscriptSearch(c.text?.slice(0, 40) || "");
                      }}
                    >
                      <Link2 size={12} />
                      {c.text}
                    </button>
                  ))}
                </div>
              ))}
            </div>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (!question.trim()) return;
                const q = question;
                setMessages((m) => [...m, { role: "user", text: q }]);
                setQuestion("");
                setBusy(true);
                try {
                  const r = await api(
                    `conversations/${id}/assistant`,
                    json("POST", { question: q }),
                  );
                  setMessages((m) => [
                    ...m,
                    {
                      role: "assistant",
                      text: r.answer,
                      citations: r.citations,
                      mode: r.mode,
                    },
                  ]);
                } catch (e) {
                  setMessages((m) => [
                    ...m,
                    { role: "assistant", text: (e as Error).message },
                  ]);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <textarea
                aria-label="Ask about this conversation"
                placeholder="What did the candidate say about…"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                required
                rows={3}
              />
              <Button
                variant="primary"
                type="submit"
                busy={busy}
                aria-label="Send question"
              >
                <Send size={17} />
              </Button>
            </form>
          </div>
        )}
      </aside>
      {modal === "transcript" && (
        <Modal title="Edit transcript" wide onClose={() => setModal("")}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const text = String(
                new FormData(e.currentTarget).get("transcript"),
              );
              if (!(await save({ transcript: text }))) return;
              setModal("");
              toast("Transcript saved");
            }}
          >
            <ErrorBanner error={error} />
            <Field label="Transcript">
              <textarea
                name="transcript"
                rows={17}
                defaultValue={note.transcript || ""}
                required
              />
            </Field>
            <div className="form-actions">
              <Button type="submit" variant="primary">
                Save transcript
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {modal === "collection" && (
        <Modal title="Add to collection" onClose={() => setModal("")}>
          {collections.length ? (
            collections.map((c) => (
              <label className="collection-choice" key={c.id}>
                <Folder size={18} />
                {c.name || c.title}
                <input
                  type="checkbox"
                  checked={(note.collectionIds || []).includes(c.id)}
                  onChange={(e) =>
                    void save({
                      collectionIds: e.target.checked
                        ? [...(note.collectionIds || []), c.id]
                        : (note.collectionIds || []).filter(
                            (v: string) => v !== c.id,
                          ),
                    })
                  }
                />
              </label>
            ))
          ) : (
            <Empty title="Create a collection first">
              Return to Conversations and select New collection.
            </Empty>
          )}
          <div className="form-actions">
            <Button onClick={() => setModal("")}>Done</Button>
          </div>
        </Modal>
      )}
      {modal === "template" && (
        <Modal title="Choose a template" onClose={() => setModal("")}>
          {templates.map((t) => (
            <button
              className="template-choice"
              key={t.id}
              onClick={() => {
                setModal("");
                void generate({ templateId: t.id });
              }}
            >
              <Layers size={20} />
              <span>
                <strong>{t.name || t.title}</strong>
                <small>{t.description}</small>
              </span>
              <ArrowRight size={16} />
            </button>
          ))}
        </Modal>
      )}
      {modal === "versions" && (
        <Modal title="Version history" onClose={() => setModal("")}>
          <p className="muted">
            Saved versions preserve earlier notes. Restoring creates a new
            version.
          </p>
          {versions.length ? (
            versions.map((v, i) => (
              <div className="version-row" key={v.id}>
                <History size={18} />
                <span>
                  <strong>Version {versions.length - i}</strong>
                  <small>{new Date(v.createdAt || "").toLocaleString()}</small>
                </span>
                <Button
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await queue.current;
                      const r = await api(
                        `conversations/${id}/versions/${v.id}/restore`,
                        json("POST", {}),
                      );
                      setNote(r.item);
                      setModal("");
                      toast("Version restored");
                    } catch (e) {
                      toast((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Restore
                </Button>
              </div>
            ))
          ) : (
            <Empty title="No earlier versions">
              A version will be saved when you change your notes.
            </Empty>
          )}
        </Modal>
      )}
      {modal === "share" && (
        <Modal title="Share & export" onClose={() => setModal("")}>
          <p>
            Create a read-only link to these notes and the full transcript,
            including participant names. Anyone with the link can read the
            conversation until it expires or is revoked. Source files remain
            private.
          </p>
          <Button
            variant="primary"
            onClick={async () => {
              try {
                const r = await api(
                  `conversations/${id}/shares`,
                  json("POST", { expiresInHours: 168 }),
                );
                const result = await api(`conversations/${id}/shares`);
                setShares(result.items);
                if (r.item?.token) {
                  const url = `${location.origin}/shared/${r.item.token}`;
                  setNewShare(url);
                  await navigator.clipboard
                    .writeText(url)
                    .then(() => toast("7-day share link copied"))
                    .catch(() => toast("Share link created. Copy it below."));
                }
              } catch (e) {
                toast((e as Error).message);
              }
            }}
          >
            <Link2 size={16} />
            Create 7-day share link
          </Button>
          {newShare && (
            <Field label="Your share link (copy before closing)">
              <input
                value={newShare}
                readOnly
                onFocus={(e) => e.target.select()}
              />
            </Field>
          )}
          {shares.map((s) => (
            <div className="share-row" key={s.id}>
              <span>
                <strong>{s.revokedAt ? "Revoked" : "Shared link"}</strong>
                <small>
                  {s.expiresAt
                    ? `Expires ${niceDate(s.expiresAt)}`
                    : "No expiration"}
                </small>
              </span>
              {s.token && (
                <Button
                  onClick={() => {
                    void navigator.clipboard.writeText(
                      `${location.origin}/shared/${s.token}`,
                    );
                    toast("Link copied");
                  }}
                >
                  <Copy size={14} />
                </Button>
              )}
              <Button
                onClick={async () => {
                  await api(`conversations/${id}/shares/${s.id}`, {
                    method: "DELETE",
                  });
                  setShares(shares.filter((v) => v.id !== s.id));
                }}
              >
                Revoke
              </Button>
            </div>
          ))}
          <div className="form-actions">
            <Button
              onClick={() =>
                downloadText(
                  `${note.title}.txt`,
                  sections.map((s) => `${s.title}\n${s.content}`).join("\n\n"),
                )
              }
            >
              <Download size={16} />
              Download notes
            </Button>
          </div>
        </Modal>
      )}
      {modal === "snippet" && (
        <Modal title="New transcript snippet" onClose={() => setModal("")}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              const saved = await save({
                snippets: [
                  ...(note.snippets || []),
                  {
                    id: crypto.randomUUID(),
                    title: f.get("title"),
                    text: f.get("text"),
                    note: f.get("note"),
                  },
                ],
              });
              if (saved) setModal("");
            }}
          >
            <ErrorBanner error={error} />
            <Field label="Title">
              <input name="title" required />
            </Field>
            <Field label="Transcript excerpt">
              <textarea name="text" rows={5} required />
            </Field>
            <Field label="Your note">
              <textarea name="note" rows={3} />
            </Field>
            <div className="form-actions">
              <Button variant="primary" type="submit">
                Save snippet
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </fieldset>
  );
}
