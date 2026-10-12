import { useEffect, useRef, useState } from "react";
import {
  FilePlus2,
  FileText,
  LayoutTemplate,
  MessagesSquare,
  Trash2,
  Upload,
} from "lucide-react";
import { api, json, Modal, Button, Field, ErrorBanner } from "../ui";
import JobDrafting, { type JobSource } from "./JobDrafting";
import "./job-creation.css";

type Intake = {
  id: string;
  title: string;
  date: string;
  characters: number;
  eligible: boolean;
};
type Template = JobSource & { description: string };
export default function JobCreation({
  onClose,
  onBlank,
  onApplied,
}: {
  onClose: () => void;
  onBlank: () => void;
  onApplied: (job: { id: string; [key: string]: unknown }) => void;
}) {
  const [mode, setMode] = useState<
    "choices" | "template" | "conversation" | "document"
  >("choices");
  const [templates, setTemplates] = useState<Template[]>([]),
    [intakes, setIntakes] = useState<Intake[]>([]),
    [documents, setDocuments] = useState<JobSource[]>([]);
  const [source, setSource] = useState<JobSource | null>(null),
    [selected, setSelected] = useState<JobSource | null>(null);
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [query, setQuery] = useState("");
  const controller = useRef<AbortController | null>(null),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (mode === "choices") return;
    const abort = new AbortController();
    controller.current = abort;
    setLoading(true);
    setError("");
    setQuery("");
    setSelected(null);
    const path =
      mode === "template"
        ? "templates"
        : mode === "conversation"
          ? "conversations"
          : "documents";
    void api(`job-sources/${path}`, { signal: abort.signal })
      .then((data) => {
        if (abort.signal.aborted) return;
        if (mode === "template") setTemplates(data.items);
        else if (mode === "conversation") setIntakes(data.items);
        else setDocuments(data.items);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [mode]);
  async function selectIntake(id: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    const abort = new AbortController();
    controller.current = abort;
    try {
      const data = await api(`job-sources/conversations/${id}`, {
        signal: abort.signal,
      });
      if (mounted.current) setSelected(data.item);
    } catch (e) {
      if (mounted.current && !abort.signal.aborted)
        setError((e as Error).message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function upload(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget),
      file = form.get("file");
    if (!(file instanceof File) || !file.size) {
      setError("Choose a PDF or DOCX job document.");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError("Job documents must be 10 MB or smaller.");
      return;
    }
    setBusy(true);
    setError("");
    const abort = new AbortController();
    controller.current = abort;
    try {
      const data = await api("job-sources/documents", {
        method: "POST",
        body: form,
        signal: abort.signal,
      });
      if (mounted.current) {
        setDocuments((items) => [data.item, ...items]);
        setSelected(data.item);
      }
    } catch (e) {
      if (mounted.current && !abort.signal.aborted)
        setError((e as Error).message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function remove(id: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api(`job-sources/documents/${id}`, json("DELETE", {}));
      if (mounted.current) {
        setDocuments((items) => items.filter((item) => item.id !== id));
        if (selected?.id === id) setSelected(null);
      }
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  if (source)
    return (
      <JobDrafting source={source} onClose={onClose} onApplied={onApplied} />
    );
  const matching = (title: string) =>
    title.toLowerCase().includes(query.toLowerCase());
  return (
    <Modal title="Create job post" onClose={onClose} wide>
      <div className="job-creation">
        <ErrorBanner error={error} />
        {mode === "choices" ? (
          <>
            <p>Choose a starting point for your next role.</p>
            <div className="job-creation-choices">
              <button onClick={onBlank}>
                <FilePlus2 size={22} />
                <span>
                  <strong>Start from scratch</strong>
                  <small>Write a blank job post.</small>
                </span>
              </button>
              <button onClick={() => setMode("conversation")}>
                <MessagesSquare size={22} />
                <span>
                  <strong>From an intake call</strong>
                  <small>Use a conversation you can access.</small>
                </span>
              </button>
              <button onClick={() => setMode("template")}>
                <LayoutTemplate size={22} />
                <span>
                  <strong>Use a template</strong>
                  <small>Start with a structured job description.</small>
                </span>
              </button>
              <button onClick={() => setMode("document")}>
                <Upload size={22} />
                <span>
                  <strong>Upload a job description</strong>
                  <small>Import text from a PDF or DOCX.</small>
                </span>
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="job-creation-heading">
              <Button disabled={busy} onClick={() => setMode("choices")}>
                Back
              </Button>
              <h3>
                {mode === "template"
                  ? "Job description templates"
                  : mode === "conversation"
                    ? "Choose an intake conversation"
                    : "Your private job documents"}
              </h3>
            </div>
            {mode === "document" ? (
              <form onSubmit={upload} className="job-source-upload">
                <Field
                  label="Job description document"
                  hint="PDF or DOCX, up to 10 MB and 60,000 characters. Text-based documents only; scanned PDFs need OCR before upload."
                >
                  <input
                    name="file"
                    type="file"
                    required
                    disabled={busy}
                    accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  />
                </Field>
                <Button type="submit" busy={busy}>
                  <Upload size={15} />
                  Extract document text
                </Button>
                <p className="muted">
                  Extracted text stays in your private source library. The
                  original file is removed after extraction. Delete the source
                  when you no longer need it.
                </p>
              </form>
            ) : (
              <Field
                label={
                  mode === "template"
                    ? "Search templates"
                    : "Search conversations"
                }
              >
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={
                    mode === "template"
                      ? "Find a template"
                      : "Find a conversation"
                  }
                />
              </Field>
            )}
            {mode === "conversation" && (
              <p className="muted">
                Showing accessible transcripts among the workspace’s 500 most
                recent conversations. Archived conversations are excluded.
              </p>
            )}
            {loading ? (
              <p role="status">Loading sources…</p>
            ) : (
              <div className="job-source-list">
                {mode === "template" &&
                  templates
                    .filter((item) => matching(item.title))
                    .map((item) => (
                      <button
                        key={item.id}
                        className={selected?.id === item.id ? "selected" : ""}
                        onClick={() => setSelected(item)}
                      >
                        <LayoutTemplate size={18} />
                        <span>
                          <strong>{item.title}</strong>
                          <small>{item.description}</small>
                        </span>
                      </button>
                    ))}
                {mode === "conversation" &&
                  intakes
                    .filter((item) => matching(item.title))
                    .map((item) => (
                      <button
                        key={item.id}
                        disabled={busy || !item.eligible}
                        className={selected?.id === item.id ? "selected" : ""}
                        onClick={() => void selectIntake(item.id)}
                      >
                        <MessagesSquare size={18} />
                        <span>
                          <strong>{item.title}</strong>
                          <small>
                            {new Date(item.date).toLocaleDateString()} ·{" "}
                            {item.characters.toLocaleString()} characters
                            {!item.eligible ? " · exceeds source limit" : ""}
                          </small>
                        </span>
                      </button>
                    ))}
                {mode === "conversation" &&
                  !intakes.filter((item) => matching(item.title)).length && (
                    <p className="muted">
                      No matching conversations with transcripts. Record or
                      upload an intake call in Notes first.
                    </p>
                  )}
                {mode === "document" &&
                  documents.map((item) => (
                    <div className="job-document-row" key={item.id}>
                      <button
                        className={selected?.id === item.id ? "selected" : ""}
                        onClick={() => setSelected(item)}
                      >
                        <FileText size={18} />
                        <span>
                          <strong>{item.title}</strong>
                          <small>
                            {item.characters.toLocaleString()} characters
                          </small>
                        </span>
                      </button>
                      <Button
                        disabled={busy}
                        aria-label={`Delete source ${item.title}`}
                        onClick={() => void remove(item.id)}
                      >
                        <Trash2 size={16} />
                      </Button>
                    </div>
                  ))}
                {mode === "document" && !documents.length && (
                  <p className="muted">
                    Upload a job description to review its extracted text here.
                  </p>
                )}
              </div>
            )}
            {selected && (
              <section
                aria-label="Job source preview"
                className="job-source-preview"
              >
                <h4>{selected.title}</h4>
                <pre>{selected.text}</pre>
                <p className="muted">
                  Review this source before continuing. You will review and edit
                  the job description again before creating a workspace job.
                </p>
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() => setSource(selected)}
                >
                  Use selected source
                </Button>
              </section>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
