import { useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { api, json, Modal, Field, Button, ErrorBanner } from "../ui";
import "./job-drafting.css";

type Job = { id: string; [key: string]: unknown };
export type JobSource = {
  kind: "template" | "conversation" | "document";
  id: string;
  fingerprint: string;
  title: string;
  text: string;
  characters: number;
};
type Draft = {
  id: string;
  jobId: string | null;
  title: string;
  status: string;
  sourceCurrent: boolean;
  error: string | null;
  model: string;
  createdAt: string;
  result: {
    description: string;
    suggestions: string[];
    missingDetails: string[];
  } | null;
};
const str = (value: unknown) => (typeof value === "string" ? value : "");
export default function JobDrafting({
  job,
  source,
  onClose,
  onApplied,
}: {
  job?: Job;
  source?: JobSource;
  onClose: () => void;
  onApplied: (job: Job) => void;
}) {
  const [items, setItems] = useState<Draft[]>([]),
    [available, setAvailable] = useState(false),
    [loading, setLoading] = useState(true);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [selected, setSelected] = useState("");
  const [description, setDescription] = useState(""),
    [confirmed, setConfirmed] = useState(false);
  const controller = useRef<AbortController | null>(null),
    mounted = useRef(true),
    request = useRef<{ key: string; hash: string }>({
      key: crypto.randomUUID(),
      hash: "",
    });
  const path = `job-drafts${job ? `?jobId=${encodeURIComponent(job.id)}` : ""}`;
  const draft = items.find((item) => item.id === selected);
  async function load(signal?: AbortSignal) {
    const data = await api(path, { signal });
    if (mounted.current) {
      setItems(data.items);
      const selectedItem = data.items.find(
        (item: Draft) => item.id === selected,
      );
      if (selectedItem && !selectedItem.sourceCurrent) {
        setDescription("");
        setConfirmed(false);
      }
      setAvailable(data.available);
      setLoading(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    const abort = new AbortController();
    void load(abort.signal).catch((e) => {
      if (!abort.signal.aborted) {
        setError(e.message);
        setLoading(false);
      }
    });
    return () => {
      mounted.current = false;
      abort.abort();
      controller.current?.abort();
    };
  }, [path]);
  const choose = (item: Draft) => {
    setSelected(item.id);
    setDescription(item.result?.description || "");
    setConfirmed(false);
    setError("");
  };
  async function generate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const submitter = (event.nativeEvent as SubmitEvent)
      .submitter as HTMLButtonElement | null;
    const mode = submitter?.value === "manual" ? "manual" : "ai";
    const body = {
      mode,
      ...(source
        ? {
            source: {
              kind: source.kind,
              id: source.id,
              fingerprint: source.fingerprint,
            },
          }
        : {}),
      brief: String(form.get("brief") || ""),
      companyContext: String(form.get("companyContext") || ""),
      tone: String(form.get("tone") || "clear"),
      ...(job
        ? { jobId: job.id, sourceVersion: job.updatedAt }
        : {
            details: {
              title: String(form.get("title") || ""),
              department: String(form.get("department") || ""),
              location: String(form.get("location") || ""),
              salary: String(form.get("salary") || ""),
              employmentType: String(form.get("employmentType") || ""),
            },
          }),
    };
    const hash = JSON.stringify(body);
    if (hash !== request.current.hash)
      request.current = { key: crypto.randomUUID(), hash };
    setBusy(true);
    setError("");
    const abort = new AbortController();
    controller.current = abort;
    try {
      const data = await api("job-drafts", {
        ...json("POST", { ...body, requestId: request.current.key }),
        signal: abort.signal,
      });
      if (!mounted.current) return;
      choose(data.item);
      if (data.item.status === "running")
        setError(
          "This draft is still running. Refresh its history or retry the same request; another generation will not be started.",
        );
      if (data.item.status !== "running")
        request.current = { key: crypto.randomUUID(), hash: "" };
      await load();
    } catch (e) {
      if (mounted.current) {
        setError(
          abort.signal.aborted
            ? "Generation stopped. Refresh history before making another paid request."
            : (e as Error).message,
        );
        await load().catch(() => {});
      }
    } finally {
      if (mounted.current) setBusy(false);
      if (controller.current === abort) controller.current = null;
    }
  }
  async function apply() {
    if (!draft || busy || !confirmed) return;
    setBusy(true);
    setError("");
    try {
      const data = await api(
        `job-drafts/${draft.id}/apply`,
        json("POST", { description, confirm: true }),
      );
      if (mounted.current) {
        onApplied(data.item);
        onClose();
      }
    } catch (e) {
      if (mounted.current) {
        setError((e as Error).message);
        await load().catch(() => {});
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function remove(item: Draft) {
    setBusy(true);
    setError("");
    try {
      await api(`job-drafts/${item.id}`, json("DELETE", {}));
      if (mounted.current) {
        if (item.id === selected) {
          setSelected("");
          setDescription("");
        }
        await load();
      }
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <Modal
      title={
        job
          ? `AI drafting · ${str(job.title)}`
          : source
            ? "Create job from source"
            : "AI job drafts"
      }
      onClose={onClose}
      wide
    >
      <div className="job-drafting">
        <p>
          Turn your role brief into an editable job description. Drafts stay
          private until you apply them to a workspace job post.
        </p>
        <ErrorBanner error={error} />
        {source && (
          <details className="job-draft-source">
            <summary>Selected source: {source.title}</summary>
            <p className="muted">
              Review this source before using AI. Only include information
              appropriate for this job post.
            </p>
            <pre>{source.text}</pre>
          </details>
        )}
        {loading ? (
          <p role="status">Loading drafts…</p>
        ) : !available ? (
          <p className="notice">
            Text AI is not enabled for this workspace. Ask your server
            administrator to configure the provider and workspace allowlist.
            Manual job writing remains available.
          </p>
        ) : null}
        <form onSubmit={generate}>
          <fieldset disabled={busy || (!available && !source) || loading}>
            {!job && (
              <div className="job-draft-fields">
                <Field label="Draft job title">
                  <input
                    name="title"
                    required
                    maxLength={300}
                    placeholder="Senior Backend Engineer"
                  />
                </Field>
                <Field label="Department">
                  <input name="department" maxLength={300} />
                </Field>
                <Field label="Location">
                  <input name="location" maxLength={300} />
                </Field>
                <Field label="Employment type">
                  <input name="employmentType" maxLength={100} />
                </Field>
                <Field label="Compensation">
                  <input
                    name="salary"
                    maxLength={300}
                    placeholder="Only include confirmed compensation"
                  />
                </Field>
              </div>
            )}
            <Field
              label="Role brief"
              hint="Describe responsibilities, requirements and outcomes. Only include facts you want in the job post."
            >
              <textarea
                name="brief"
                required={!source}
                maxLength={10000}
                rows={4}
              />
            </Field>
            <Field
              label="Company context and writing guidance"
              hint="Optional facts, approved company wording and tone guidance."
            >
              <textarea name="companyContext" maxLength={10000} rows={3} />
            </Field>
            <Field label="Writing tone">
              <select name="tone">
                <option value="clear">Clear and direct</option>
                <option value="warm">Warm</option>
                <option value="formal">Formal</option>
              </select>
            </Field>
            {source?.kind === "conversation" && (
              <p className="muted">
                Intake calls can include private discussion. Remove participant
                names, contact details and unrelated information from the
                description before sharing it with your workspace.
              </p>
            )}
            {source && (
              <Button type="submit" name="mode" value="manual" busy={busy}>
                {source.kind === "template"
                  ? "Use template without AI"
                  : "Copy source into editable draft"}
              </Button>
            )}
            <Button
              type="submit"
              name="mode"
              value="ai"
              variant="primary"
              busy={busy}
              disabled={!available}
            >
              <Sparkles size={16} />
              Generate private draft
            </Button>
          </fieldset>
        </form>
        {busy && controller.current && (
          <Button onClick={() => controller.current?.abort()}>
            Stop generation
          </Button>
        )}
        <section aria-label="Saved job drafts">
          <div className="job-draft-history-title">
            <h3>Your saved drafts</h3>
            <Button
              disabled={busy}
              onClick={() => {
                setError("");
                void load().catch((e) => setError(e.message));
              }}
            >
              Refresh drafts
            </Button>
          </div>
          {!items.length ? (
            <p className="muted">No drafts yet.</p>
          ) : (
            <ul className="job-draft-list">
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    className="link-button"
                    onClick={() => choose(item)}
                    disabled={busy}
                  >
                    {item.title} · {item.status}
                  </button>
                  <button
                    className="link-button"
                    onClick={() => void remove(item)}
                    disabled={busy}
                    aria-label={`Delete draft ${item.title}`}
                  >
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        {draft && (
          <section aria-label="Job draft preview" className="job-draft-preview">
            <h3>Review {draft.title}</h3>
            {draft.error && <p role="status">{draft.error}</p>}
            {draft.result && (
              <>
                <p className="muted">
                  {draft.model === "Source copy"
                    ? "Copied from your selected source."
                    : `Generated with ${draft.model}.`}{" "}
                  Check every statement and edit before applying. Suggestions do
                  not establish legal compliance.
                </p>
                <Field label="Proposed job description">
                  <textarea
                    value={description}
                    maxLength={60000}
                    rows={14}
                    onChange={(e) => {
                      setDescription(e.target.value);
                      setConfirmed(false);
                    }}
                    disabled={busy || draft.status !== "ready"}
                  />
                </Field>
                {!!draft.result.suggestions.length && (
                  <>
                    <h4>Editorial suggestions</h4>
                    <ul>
                      {draft.result.suggestions.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ul>
                  </>
                )}
                {!!draft.result.missingDetails.length && (
                  <>
                    <h4>Details to confirm</h4>
                    <ul>
                      {draft.result.missingDetails.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ul>
                  </>
                )}
                {!draft.sourceCurrent && (
                  <p role="alert">
                    The source changed or is no longer accessible. Select and
                    review it again before making a fresh draft.
                  </p>
                )}
                {draft.status === "ready" && (
                  <>
                    <label className="job-draft-confirm">
                      <input
                        type="checkbox"
                        checked={confirmed}
                        disabled={busy || !draft.sourceCurrent}
                        onChange={(e) => setConfirmed(e.target.checked)}
                      />
                      I reviewed this description and approve making it visible
                      to everyone in this workspace.
                    </label>
                    <Button
                      variant="primary"
                      disabled={
                        busy ||
                        !confirmed ||
                        !draft.sourceCurrent ||
                        !description.trim()
                      }
                      onClick={() => void apply()}
                    >
                      {draft.jobId
                        ? "Apply to workspace job"
                        : "Create workspace draft job"}
                    </Button>
                    <p className="muted">
                      Existing job status and metadata are preserved. New jobs
                      are saved as drafts. This does not publish to an external
                      job board.
                    </p>
                  </>
                )}
              </>
            )}
          </section>
        )}
      </div>
    </Modal>
  );
}
