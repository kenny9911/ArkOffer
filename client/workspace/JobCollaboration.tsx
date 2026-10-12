import { useEffect, useRef, useState } from "react";
import { CheckCircle2, MessageSquare, RefreshCw } from "lucide-react";
import { api, json, Button, ErrorBanner, type Item } from "../ui";
import "./job-collaboration.css";

type Author = { id: string | null; name: string };
type Comment = {
  id: string;
  body: string;
  revision: number;
  author: Author;
  mine: boolean;
  createdAt: string;
  updatedAt: string;
};
type Review = {
  author: Author;
  mine: boolean;
  revision: number;
  reviewed: boolean;
  current: boolean;
  memberActive: boolean;
  updatedAt: string;
};
type Collaboration = {
  fingerprint: string;
  snapshot: Record<string, string>;
  comments: Comment[];
  checks: Review[];
  history: {
    id: string;
    author: Author;
    reviewed: boolean;
    currentVersion: boolean;
    createdAt: string;
  }[];
  commentCount: number;
  reviewedCount: number;
  limits: { comments: number; commentCharacters: number; history: number };
};
type Summary = { id: string; commentCount: number; reviewedCount: number };
const changeEvent = "arkoffer:job-collaboration";
const date = (value: string) => new Date(value).toLocaleString();

export function useJobCollaborationSummaries(jobs: Item[]) {
  const key = JSON.stringify(jobs.map((job) => [job.id, job.updatedAt]));
  const [summaries, setSummaries] = useState<Record<string, Summary>>({});
  const [error, setError] = useState("");
  useEffect(() => {
    let controller: AbortController;
    const ids = (JSON.parse(key) as [string, string][]).map(([id]) => id);
    async function load() {
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      try {
        const pages = await Promise.all(
          Array.from({ length: Math.ceil(ids.length / 200) }, (_, page) =>
            api<{ items: Summary[] }>("job-collaboration/summary", {
              ...json("POST", { ids: ids.slice(page * 200, (page + 1) * 200) }),
              signal,
            }),
          ),
        );
        if (!signal.aborted) {
          setSummaries(
            Object.fromEntries(
              pages
                .flatMap((page) => page.items)
                .map((item) => [item.id, item]),
            ),
          );
          setError("");
        }
      } catch (e) {
        if (!signal.aborted) {
          setSummaries({});
          setError((e as Error).message);
        }
      }
    }
    void load();
    const refresh = () => void load();
    window.addEventListener(changeEvent, refresh);
    return () => {
      controller?.abort();
      window.removeEventListener(changeEvent, refresh);
    };
  }, [key]);
  return { summaries, error };
}
export function JobCollaborationSummary({ summary }: { summary?: Summary }) {
  return (
    <span
      className="job-review-summary"
      aria-label="Job discussion and review status"
    >
      {summary ? (
        <>
          <span>
            <MessageSquare size={14} aria-hidden="true" />
            {summary.commentCount}{" "}
            {summary.commentCount === 1 ? "comment" : "comments"}
          </span>
          <span>
            <CheckCircle2 size={14} aria-hidden="true" />
            {summary.reviewedCount} reviewed
          </span>
        </>
      ) : (
        <span>Review status unavailable</span>
      )}
    </span>
  );
}
export default function JobCollaboration({ job }: { job: Item }) {
  return <JobDiscussion key={JSON.stringify(job)} job={job} />;
}
function JobDiscussion({ job }: { job: Item }) {
  const [data, setData] = useState<Collaboration | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const [editing, setEditing] = useState<Comment | null>(null);
  const [editedText, setEditedText] = useState("");
  const [deleting, setDeleting] = useState("");
  const mounted = useRef(true),
    controller = useRef<AbortController | null>(null);
  const path = `jobs/${encodeURIComponent(job.id)}`;
  async function load(signal?: AbortSignal) {
    const response = await api<Collaboration>(`${path}/collaboration`, {
      signal,
    });
    if (mounted.current && !signal?.aborted) setData(response);
  }
  useEffect(() => {
    mounted.current = true;
    const abort = new AbortController();
    void load(abort.signal).catch((e) => {
      if (!abort.signal.aborted) setError(e.message);
    });
    return () => {
      mounted.current = false;
      abort.abort();
      controller.current?.abort();
    };
  }, [path]);
  const own = data?.checks.find((check) => check.mine);
  const stale =
    !!data &&
    Object.entries(data.snapshot).some(
      ([key, value]) =>
        value !== (typeof job[key] === "string" ? job[key] : ""),
    );
  async function mutate(
    endpoint: string,
    method: string,
    input: unknown,
    success?: () => void,
  ) {
    if (busy) return;
    setBusy(true);
    setError("");
    const abort = new AbortController();
    controller.current = abort;
    let saved = false;
    try {
      await api(`${path}/${endpoint}`, {
        ...json(method, input),
        signal: abort.signal,
      });
      saved = true;
      window.dispatchEvent(new Event(changeEvent));
      if (mounted.current && !abort.signal.aborted) success?.();
      await load(abort.signal);
    } catch (e) {
      if (mounted.current && !abort.signal.aborted)
        setError(
          saved
            ? "Your change was saved, but the discussion could not be refreshed. Refresh the discussion to see the latest version."
            : (e as Error).message,
        );
    } finally {
      if (mounted.current && !abort.signal.aborted) setBusy(false);
    }
  }
  async function refresh() {
    if (busy) return;
    setBusy(true);
    setError("");
    const abort = new AbortController();
    controller.current = abort;
    try {
      await load(abort.signal);
    } catch (e) {
      if (mounted.current && !abort.signal.aborted)
        setError((e as Error).message);
    } finally {
      if (mounted.current && !abort.signal.aborted) setBusy(false);
    }
  }
  return (
    <section className="job-collaboration" aria-label="Job collaboration">
      <div className="job-review-heading">
        <div>
          <h3>Team review</h3>
          <p>Discuss this job and record your review of its current version.</p>
        </div>
        <Button
          variant="secondary"
          onClick={() => void refresh()}
          disabled={busy}
          aria-label="Refresh job discussion"
        >
          <RefreshCw size={15} />
        </Button>
      </div>
      {error && <ErrorBanner error={error} />}
      {!data ? (
        <p role="status">
          {error ? "Discussion could not be loaded." : "Loading discussion…"}
        </p>
      ) : (
        <>
          <div className="job-review-check">
            <div>
              <strong>
                {data.reviewedCount}{" "}
                {data.reviewedCount === 1 ? "person has" : "people have"}{" "}
                reviewed this version
              </strong>
              <p>
                Changing the job invalidates previous checks. This records a
                human review, not a publishing approval.
              </p>
            </div>
            <Button
              variant={own?.current ? "secondary" : ""}
              disabled={busy || stale}
              onClick={() =>
                void mutate("review", "POST", {
                  fingerprint: data.fingerprint,
                  revision: own?.revision || 0,
                  reviewed: !own?.current,
                })
              }
            >
              <CheckCircle2 size={16} />
              {own?.current ? "Withdraw my review" : "Mark as reviewed"}
            </Button>
          </div>
          {stale && (
            <p className="job-review-stale" role="status">
              This job changed since you opened the preview. Close it and
              refresh the jobs list before reviewing.
            </p>
          )}
          {!!data.checks.length && (
            <ul className="job-review-people" aria-label="Reviewer status">
              {data.checks.map((check) => (
                <li key={check.author.id}>
                  <strong>
                    {check.author.name}
                    {check.mine ? " (you)" : ""}
                  </strong>
                  <span>
                    {!check.memberActive
                      ? "No longer an active member"
                      : check.current
                        ? "Reviewed current version"
                        : check.reviewed
                          ? "Needs review after changes"
                          : "Review withdrawn"}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <details className="job-review-history">
            <summary>Review history ({data.history.length})</summary>
            <p>The latest {data.limits.history} review events are retained.</p>
            {!data.history.length ? (
              <p>No reviews yet.</p>
            ) : (
              <ol>
                {data.history.map((event) => (
                  <li key={event.id}>
                    <strong>{event.author.name}</strong>{" "}
                    {event.reviewed
                      ? "marked the job reviewed"
                      : "withdrew their review"}
                    {event.currentVersion ? "" : " · earlier version"}
                    <time dateTime={event.createdAt}>
                      {date(event.createdAt)}
                    </time>
                  </li>
                ))}
              </ol>
            )}
          </details>
          <div className="job-comments-heading">
            <h3>Comments</h3>
            <span>
              {data.commentCount} / {data.limits.comments}
            </span>
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void mutate("comments", "POST", { body: text }, () =>
                setText(""),
              );
            }}
          >
            <label htmlFor={`job-comment-${job.id}`}>Add a comment</label>
            <textarea
              id={`job-comment-${job.id}`}
              value={text}
              onChange={(event) => setText(event.target.value)}
              maxLength={data.limits.commentCharacters}
              rows={3}
              placeholder="Share feedback with your workspace…"
              required
              disabled={busy}
            />
            <div className="job-comment-compose">
              <small>
                Visible to workspace members. {text.length} /{" "}
                {data.limits.commentCharacters}
              </small>
              <Button
                type="submit"
                disabled={
                  busy ||
                  !text.trim() ||
                  data.commentCount >= data.limits.comments
                }
              >
                Post comment
              </Button>
            </div>
          </form>
          {!data.comments.length ? (
            <p className="job-comments-empty">
              No comments yet. Start the discussion.
            </p>
          ) : (
            <ol className="job-comments" aria-label="Job comments">
              {data.comments.map((comment) => (
                <li key={comment.id}>
                  <div className="job-comment-meta">
                    <strong>
                      {comment.author.name}
                      {comment.mine ? " (you)" : ""}
                    </strong>
                    <time dateTime={comment.createdAt}>
                      {date(comment.createdAt)}
                      {comment.revision > 1 ? " · edited" : ""}
                    </time>
                  </div>
                  {editing?.id === comment.id ? (
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        void mutate(
                          `comments/${comment.id}`,
                          "PATCH",
                          { body: editedText, revision: editing.revision },
                          () => setEditing(null),
                        );
                      }}
                    >
                      <label htmlFor={`edit-comment-${comment.id}`}>
                        Edit comment
                      </label>
                      <textarea
                        id={`edit-comment-${comment.id}`}
                        value={editedText}
                        onChange={(event) => setEditedText(event.target.value)}
                        rows={3}
                        maxLength={4000}
                        disabled={busy}
                        required
                      />
                      <div className="job-comment-actions">
                        <Button
                          type="submit"
                          disabled={busy || !editedText.trim()}
                        >
                          Save comment
                        </Button>
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={busy}
                          onClick={() => setEditing(null)}
                        >
                          Cancel edit
                        </Button>
                      </div>
                    </form>
                  ) : (
                    <p className="job-comment-body">{comment.body}</p>
                  )}
                  {comment.mine && editing?.id !== comment.id && (
                    <div className="job-comment-actions">
                      {deleting === comment.id ? (
                        <>
                          <span>Delete this comment?</span>
                          <Button
                            variant="danger"
                            disabled={busy}
                            onClick={() =>
                              void mutate(
                                `comments/${comment.id}`,
                                "DELETE",
                                { revision: comment.revision },
                                () => setDeleting(""),
                              )
                            }
                          >
                            Confirm delete
                          </Button>
                          <Button
                            variant="secondary"
                            disabled={busy}
                            onClick={() => setDeleting("")}
                          >
                            Keep comment
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button
                            variant="secondary"
                            disabled={busy}
                            onClick={() => {
                              setEditing(comment);
                              setEditedText(comment.body);
                              setDeleting("");
                            }}
                          >
                            Edit comment
                          </Button>
                          <Button
                            variant="secondary"
                            disabled={busy}
                            onClick={() => setDeleting(comment.id)}
                          >
                            Delete comment
                          </Button>
                        </>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </section>
  );
}
