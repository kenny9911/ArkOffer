import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { ArrowUp, Check, FileText, Sparkles, Trash2 } from "lucide-react";
import { api, json, Modal, Field, Button, ErrorBanner } from "../ui";
import "./screening-drafting.css";

export type ScreeningProposal = {
  title: string;
  name: string;
  description: string;
  jobId: string;
  questions: Array<{
    prompt: string;
    type: "text" | "yes-no" | "multiple-choice";
    options: string[];
    required: boolean;
    rubric: string;
  }>;
  status: "draft";
};
type Draft = {
  id: string;
  title: string;
  status: string;
  model: string;
  sourceCurrent: boolean;
  error: string | null;
  createdAt: string;
  result:
    | (Pick<ScreeningProposal, "title" | "description" | "questions"> & {
        notes: string[];
      })
    | null;
};
export default function ScreeningDrafting({
  jobs = [],
  onClose,
  onUseDraft,
  inline = false,
  initialContext = "",
}: {
  jobs?: Array<{ id: string; title?: string; name?: string }>;
  onClose: () => void;
  onUseDraft: (proposal: ScreeningProposal) => void;
  inline?: boolean;
  initialContext?: string;
}) {
  const [items, setItems] = useState<Draft[]>([]),
    [available, setAvailable] = useState(false),
    [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [consent, setConsent] = useState(false),
    [reviewed, setReviewed] = useState(false);
  const request = useRef({ id: crypto.randomUUID(), hash: "" }),
    controller = useRef<AbortController | null>(null),
    mounted = useRef(true);
  const draft = items.find((item) => item.id === selected);
  async function load(signal?: AbortSignal) {
    const data = await api<{ available: boolean; items: Draft[] }>(
      "screening-drafts",
      { signal },
    );
    if (mounted.current) {
      setAvailable(data.available);
      setItems(data.items);
      setLoading(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    const abort = new AbortController();
    void load(abort.signal).catch((error) => {
      if (!abort.signal.aborted) {
        setError(error.message);
        setLoading(false);
      }
    });
    return () => {
      mounted.current = false;
      abort.abort();
      controller.current?.abort();
    };
  }, []);
  const choose = (item: Draft) => {
    setSelected(item.id);
    setReviewed(false);
    setError("");
  };
  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !consent) return;
    const form = new FormData(event.currentTarget),
      jobId = String(form.get("jobId") || "");
    const input = {
      brief: String(form.get("brief") || ""),
      context: String(form.get("context") || ""),
      questionCount: Number(form.get("questionCount") || 5),
      consent: true,
      ...(jobId ? { jobId } : {}),
    };
    const hash = JSON.stringify(input);
    if (request.current.hash !== hash)
      request.current = { id: crypto.randomUUID(), hash };
    setBusy(true);
    setError("");
    const abort = new AbortController();
    controller.current = abort;
    try {
      const data = await api<{ item: Draft }>("screening-drafts", {
        ...json("POST", { ...input, requestId: request.current.id }),
        signal: abort.signal,
      });
      if (!mounted.current) return;
      setItems((old) => [
        data.item,
        ...old.filter((item) => item.id !== data.item.id),
      ]);
      choose(data.item);
      // Replaying a request may return its unfinished draft before the original
      // provider call settles. Keep its identity so another retry cannot charge
      // for a second generation of the same brief.
      if (
        ["ready", "applied", "failed", "discarded"].includes(data.item.status)
      )
        request.current = { id: crypto.randomUUID(), hash: "" };
      await load();
    } catch (error) {
      if (mounted.current) {
        setError(
          abort.signal.aborted
            ? "Drafting stopped. Refresh your history before making another paid request."
            : (error as Error).message,
        );
        await load().catch(() => {});
      }
    } finally {
      if (mounted.current) setBusy(false);
      if (controller.current === abort) controller.current = null;
    }
  }
  async function useDraft() {
    if (!draft || busy || !reviewed) return;
    setBusy(true);
    setError("");
    try {
      const data = await api<{ item: ScreeningProposal }>(
        `screening-drafts/${draft.id}/apply`,
        json("POST", { confirm: true }),
      );
      if (mounted.current) {
        onUseDraft(data.item);
        if (!inline) onClose();
      }
    } catch (error) {
      if (mounted.current) setError((error as Error).message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function discard(item: Draft) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api(`screening-drafts/${item.id}`, json("DELETE", {}));
      if (mounted.current) {
        if (selected === item.id) setSelected("");
        await load();
      }
    } catch (error) {
      if (mounted.current) setError((error as Error).message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  const content = (
    <div
      className={`screening-drafting ${inline ? "screening-drafting-inline" : ""}`}
    >
      <div className="screening-drafting-intro">
        <span>
          <Sparkles size={24} />
        </span>
        <h2>
          {inline
            ? "Screen every candidate, without picking up the phone"
            : "What role are you hiring for?"}
        </h2>
        <p>
          Describe the role. Draft questions and guidance for your team, then
          review them in the screening editor.
        </p>
      </div>
      <ErrorBanner error={error} />
      {loading ? (
        <p role="status">Loading private screening drafts…</p>
      ) : (
        <>
          {!available && (
            <p className="screening-drafting-unavailable">
              Text AI is not enabled for this workspace. You can still create a
              screening manually.
            </p>
          )}
          <form onSubmit={generate}>
            <Field
              label="Describe the role"
              hint="Include responsibilities, essential skills and what you want to learn. Do not include a candidate's personal information."
            >
              <textarea
                name="brief"
                required
                minLength={20}
                maxLength={12000}
                rows={4}
                disabled={busy}
                placeholder="We’re hiring a solutions architect who works with enterprise customers. Explore cloud architecture experience, technical communication and how they approach an unfamiliar problem."
              />
            </Field>
            <details
              className="screening-drafting-advanced"
              open={!inline || undefined}
            >
              <summary>Role context and options</summary>
              <div className="screening-drafting-options">
                <Field label="Role context from a job">
                  <select name="jobId" disabled={busy}>
                    <option value="">Use the brief only</option>
                    {jobs.map((job) => (
                      <option key={job.id} value={job.id}>
                        {job.title || job.name || "Untitled job"}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Number of questions">
                  <select name="questionCount" defaultValue="5" disabled={busy}>
                    {[3, 4, 5, 6, 7, 8, 9, 10].map((count) => (
                      <option key={count} value={count}>
                        {count} questions
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <Field
                label="Additional role context"
                hint="Paste relevant job-description text or interviewing guidance."
              >
                <textarea
                  name="context"
                  maxLength={12000}
                  rows={2}
                  defaultValue={initialContext}
                  disabled={busy}
                />
              </Field>
            </details>
            <label className="screening-drafting-check">
              <input
                type="checkbox"
                checked={consent}
                disabled={busy}
                onChange={(event) => setConsent(event.target.checked)}
              />
              Send this role brief, additional context and selected job details
              to the configured AI provider to draft questions.
            </label>
            <div className="screening-drafting-actions">
              <Button
                type="submit"
                disabled={!available || !consent}
                busy={busy}
              >
                <ArrowUp size={17} />
                {busy ? "Drafting screening…" : "Draft screening"}
              </Button>
              {busy && controller.current && (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => controller.current?.abort()}
                >
                  Stop drafting
                </Button>
              )}
            </div>
          </form>
          <div className="screening-drafting-steps">
            {[
              [
                "Build it",
                "Describe the role. Review your questions and rubrics.",
              ],
              [
                "Send it",
                "Preview the experience, then share a candidate link.",
              ],
              ["Review it", "Read candidate responses with your hiring team."],
            ].map(([title, body], index) => (
              <div key={title}>
                {inline && (
                  <small className="screening-step-number">
                    {index === 0 ? (
                      <FileText size={15} />
                    ) : index === 1 ? (
                      <ArrowUp size={15} />
                    ) : (
                      <Check size={15} />
                    )}
                    STEP {index + 1}
                  </small>
                )}
                <strong>{title}</strong>
                <p>{body}</p>
              </div>
            ))}
          </div>
          {draft && (
            <section
              className="screening-drafting-preview"
              aria-label="Screening draft preview"
            >
              <div className="screening-drafting-preview-title">
                <FileText size={20} />
                <h3>{draft.result?.title || draft.title}</h3>
                <span>{draft.status}</span>
              </div>
              {["running", "queued"].includes(draft.status) && (
                <p role="status">
                  This request is still generating. Refresh your private drafts
                  to check its progress before requesting another draft.
                </p>
              )}
              {!draft.sourceCurrent && (
                <p className="screening-drafting-unavailable">
                  The linked role changed. Generate a fresh draft before using
                  these questions.
                </p>
              )}
              {draft.error && <p role="status">{draft.error}</p>}
              {draft.result && (
                <>
                  <p>{draft.result.description}</p>
                  <ol>
                    {draft.result.questions.map((question, index) => (
                      <li key={index}>
                        <h4>{question.prompt}</h4>
                        <small>
                          {question.type === "text"
                            ? "Written answer"
                            : question.type === "yes-no"
                              ? "Yes / No"
                              : "Multiple choice"}{" "}
                          · {question.required ? "Required" : "Optional"}
                        </small>
                        {question.options.length > 0 && (
                          <ul>
                            {question.options.map((option) => (
                              <li key={option}>{option}</li>
                            ))}
                          </ul>
                        )}
                        <div className="screening-drafting-rubric">
                          <strong>Human review guidance</strong>
                          <p>{question.rubric}</p>
                        </div>
                      </li>
                    ))}
                  </ol>
                  {draft.result.notes.length > 0 && (
                    <div className="screening-drafting-notes">
                      <h4>Details to review</h4>
                      <ul>
                        {draft.result.notes.map((note, index) => (
                          <li key={index}>{note}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {["ready", "applied"].includes(draft.status) &&
                    draft.sourceCurrent && (
                      <>
                        <label className="screening-drafting-check">
                          <input
                            type="checkbox"
                            checked={reviewed}
                            onChange={(event) =>
                              setReviewed(event.target.checked)
                            }
                            disabled={busy}
                          />
                          I reviewed the questions and guidance. Continue to the
                          editor so I can edit and save a draft.
                        </label>
                        <Button
                          disabled={!reviewed || busy}
                          onClick={() => void useDraft()}
                        >
                          <Check size={16} />
                          Use in screening editor
                        </Button>
                        <p className="screening-drafting-small">
                          This does not create a candidate link or contact
                          anyone. A person reviews candidate responses and makes
                          hiring decisions.
                        </p>
                      </>
                    )}
                </>
              )}
            </section>
          )}
          <details
            className="screening-drafting-history"
            open={!inline || undefined}
          >
            <summary>Private draft history</summary>
            <div>
              <h3>Private draft history</h3>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  setError("");
                  void load().catch((error) => setError(error.message));
                }}
              >
                Refresh history
              </Button>
            </div>
            {!items.length ? (
              <p>No drafts yet. Start with the role above.</p>
            ) : (
              items.map((item) => (
                <div className="screening-drafting-history-row" key={item.id}>
                  <button disabled={busy} onClick={() => choose(item)}>
                    <span>{item.title}</span>
                    <small>
                      {item.status} ·{" "}
                      {new Date(item.createdAt).toLocaleString()}
                    </small>
                  </button>
                  <Button
                    variant="secondary"
                    disabled={busy}
                    aria-label={`Discard ${item.title}`}
                    onClick={() => void discard(item)}
                  >
                    <Trash2 size={15} />
                  </Button>
                </div>
              ))
            )}
          </details>
        </>
      )}
    </div>
  );
  return inline ? (
    content
  ) : (
    <DraftModal onClose={onClose}>{content}</DraftModal>
  );
}

function DraftModal({
  children,
  onClose,
}: {
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <Modal title="Build a screening" onClose={onClose} wide>
      {children}
    </Modal>
  );
}
