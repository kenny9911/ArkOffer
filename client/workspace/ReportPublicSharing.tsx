import { useEffect, useRef, useState } from "react";
import { Globe, Copy, ExternalLink, X } from "lucide-react";
import type { PublicReportPayload } from "../../shared/public-report";
import { PublicReportContents } from "./PublicReport";
import "./report-public-sharing.css";

const MAX_PUBLIC_COLUMNS = 5;
const MAX_PUBLIC_SOURCES = 20;

export type PublicShareRun = {
  id: string;
  revision: number;
  status: string;
  createdAt: string;
  columns: { id: string; name: string; type: string }[];
  rows: { sourceId?: string; title?: string; unavailable?: boolean }[];
};
type Link = {
  id: string;
  title: string;
  createdAt: string;
  expiresAt: string;
  allowCsv: boolean;
  status: string;
};
type Preview = {
  previewId: string;
  report: PublicReportPayload;
  previewExpiresAt: string;
};

async function request<T>(
  viewId: string,
  path = "",
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(
    `/api/report-views/${viewId}/public-links${path}`,
    {
      method,
      signal,
      credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    },
  );
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error || "Unable to update public report sharing.");
  return result;
}
export default function ReportPublicSharing({
  viewId,
  revision,
  name,
  runs,
}: {
  viewId: string;
  revision: number;
  name: string;
  runs: PublicShareRun[];
}) {
  const eligible = runs.filter(
    (run) => run.status === "complete" && run.revision === revision,
  );
  const [runId, setRunId] = useState(eligible[0]?.id || ""),
    [title, setTitle] = useState(name),
    [summary, setSummary] = useState(""),
    [sourceIds, setSourceIds] = useState<string[]>([]),
    [columnIds, setColumnIds] = useState<string[]>([]),
    [includeTitles, setIncludeTitles] = useState(false),
    [allowCsv, setAllowCsv] = useState(false),
    [days, setDays] = useState(7),
    [links, setLinks] = useState<Link[]>([]),
    [preview, setPreview] = useState<Preview | null>(null),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [issued, setIssued] = useState<{ id: string; url: string } | null>(null),
    [revokeId, setRevokeId] = useState<string | null>(null);
  const previewFocus = useRef<HTMLHeadingElement>(null);
  const run = eligible.find((item) => item.id === runId);
  const availableIds = eligible.map((item) => item.id).join(",");
  // Polling recreates objects; reset the selection only when its actual options change.
  const selectionOptions = JSON.stringify([
    runId,
    revision,
    run?.rows.map(({ sourceId, title, unavailable }) => ({
      sourceId,
      title,
      unavailable,
    })),
    run?.columns.map(({ id, name, type }) => ({ id, name, type })),
  ]);
  useEffect(() => {
    if (!eligible.some((item) => item.id === runId))
      setRunId(eligible[0]?.id || "");
  }, [availableIds, runId]);
  useEffect(() => {
    setSourceIds(
      run?.rows
        .filter((row) => !row.unavailable && row.sourceId)
        .map((row) => row.sourceId!)
        .slice(0, MAX_PUBLIC_SOURCES) || [],
    );
    setColumnIds(
      run?.columns.map((column) => column.id).slice(0, MAX_PUBLIC_COLUMNS) ||
        [],
    );
    setPreview(null);
    setConfirmed(false);
  }, [selectionOptions]);
  useEffect(() => {
    const controller = new AbortController();
    void request<{ items: Link[] }>(
      viewId,
      "",
      "GET",
      undefined,
      controller.signal,
    )
      .then((result) => {
        if (!controller.signal.aborted) setLinks(result.items);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause.message);
      });
    return () => controller.abort();
  }, [viewId, revision]);
  useEffect(() => {
    if (preview) previewFocus.current?.focus();
  }, [preview]);
  const changed = () => {
    setPreview(null);
    setConfirmed(false);
  };
  const refresh = async () =>
    setLinks((await request<{ items: Link[] }>(viewId)).items);
  const action = async (work: () => Promise<void>) => {
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
  };
  return (
    <details className="report-public-sharing">
      <summary>
        <Globe size={15} />
        Public link
      </summary>
      <p>
        Publish selected results as a read-only snapshot. Anyone with the link
        can see the exact content you review below, including names or other
        identifying information contained in selected answers. Links expire
        within 30 days and can be revoked here.
      </p>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      {eligible.length ? (
        <>
          <fieldset disabled={busy} className="report-public-fields">
            <label>
              Completed run
              <select
                aria-label="Public report completed run"
                value={runId}
                onChange={(event) => {
                  setRunId(event.target.value);
                  changed();
                }}
              >
                {eligible.map((item) => (
                  <option value={item.id} key={item.id}>
                    {new Date(item.createdAt).toLocaleString()} ·{" "}
                    {item.rows.length} conversations
                  </option>
                ))}
              </select>
            </label>
            <label>
              Public title
              <input
                maxLength={120}
                value={title}
                onChange={(event) => {
                  setTitle(event.target.value);
                  changed();
                }}
              />
            </label>
            <label>
              Public description
              <textarea
                maxLength={2000}
                rows={3}
                value={summary}
                onChange={(event) => {
                  setSummary(event.target.value);
                  changed();
                }}
                placeholder="Optional context for people opening the link"
              />
            </label>
            <fieldset>
              <legend>Columns to publish</legend>
              <p className="report-collaboration-muted">
                {columnIds.length} of up to {MAX_PUBLIC_COLUMNS} columns
                selected.
                {columnIds.length >= MAX_PUBLIC_COLUMNS &&
                  " Deselect a column to choose another."}
              </p>
              {run?.columns.map((column) => (
                <label className="report-sub-check" key={column.id}>
                  <input
                    type="checkbox"
                    checked={columnIds.includes(column.id)}
                    disabled={
                      !columnIds.includes(column.id) &&
                      columnIds.length >= MAX_PUBLIC_COLUMNS
                    }
                    onChange={(event) => {
                      setColumnIds((ids) =>
                        event.target.checked
                          ? ids.length >= MAX_PUBLIC_COLUMNS
                            ? ids
                            : [...ids, column.id]
                          : ids.filter((id) => id !== column.id),
                      );
                      changed();
                    }}
                  />
                  {column.name}
                </label>
              ))}
            </fieldset>
            <fieldset>
              <legend>Conversations to include</legend>
              <p className="report-collaboration-muted">
                {sourceIds.length} of up to {MAX_PUBLIC_SOURCES} conversations
                selected.
                {sourceIds.length >= MAX_PUBLIC_SOURCES &&
                  " Deselect a conversation to choose another."}
              </p>
              {run?.rows.map((row, index) => (
                <label className="report-sub-check" key={row.sourceId || index}>
                  <input
                    type="checkbox"
                    disabled={
                      row.unavailable ||
                      !row.sourceId ||
                      (!sourceIds.includes(row.sourceId) &&
                        sourceIds.length >= MAX_PUBLIC_SOURCES)
                    }
                    checked={Boolean(
                      row.sourceId && sourceIds.includes(row.sourceId),
                    )}
                    onChange={(event) => {
                      setSourceIds((ids) =>
                        event.target.checked
                          ? ids.length >= MAX_PUBLIC_SOURCES
                            ? ids
                            : [...ids, row.sourceId!]
                          : ids.filter((id) => id !== row.sourceId),
                      );
                      changed();
                    }}
                  />
                  {row.title || "Unavailable conversation"}
                </label>
              ))}
            </fieldset>
            <label className="report-sub-check">
              <input
                type="checkbox"
                checked={includeTitles}
                onChange={(event) => {
                  setIncludeTitles(event.target.checked);
                  changed();
                }}
              />
              Include conversation titles in the public report
            </label>
            <label className="report-sub-check">
              <input
                type="checkbox"
                checked={allowCsv}
                onChange={(event) => {
                  setAllowCsv(event.target.checked);
                  changed();
                }}
              />
              Allow CSV download of these selected results
            </label>
            <label>
              Link expires after
              <select
                aria-label="Public report expiration"
                value={days}
                onChange={(event) => {
                  setDays(Number(event.target.value));
                  changed();
                }}
              >
                {[1, 3, 7, 14, 30].map((day) => (
                  <option value={day} key={day}>
                    {day} day{day === 1 ? "" : "s"}
                  </option>
                ))}
              </select>
            </label>
            <p className="report-collaboration-muted">
              Only conversations you own or administer can be published. Source
              changes, lost access or changes to the saved report make existing
              links unavailable. Transcripts, evidence quotes and private
              annotations are excluded; selected AI answers are included exactly
              as previewed.
            </p>
            <button
              disabled={
                !runId ||
                !title.trim() ||
                !sourceIds.length ||
                !columnIds.length
              }
              onClick={() =>
                void action(async () => {
                  setPreview(
                    await request<Preview>(viewId, "/preview", "POST", {
                      runId,
                      title,
                      summary,
                      sourceIds,
                      columnIds,
                      includeSourceTitles: includeTitles,
                      allowCsv,
                      expiresInDays: days,
                    }),
                  );
                  setConfirmed(false);
                })
              }
            >
              Preview public report
            </button>
          </fieldset>
          {preview && (
            <section
              className="report-public-preview"
              aria-label="Public report preview"
            >
              <h3 ref={previewFocus} tabIndex={-1}>
                Review exactly what the link will reveal
              </h3>
              <PublicReportContents report={preview.report} />
              <p>
                {preview.report.allowCsv
                  ? "Visitors can also download these selected results as CSV."
                  : "CSV download is disabled for this link."}
              </p>
              <label className="report-sub-check">
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={busy}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                I have reviewed this content and want anyone with the link to be
                able to view it.
              </label>
              <button
                disabled={busy || !confirmed}
                onClick={() =>
                  void action(async () => {
                    const result = await request<{
                      item: { id: string; path: string };
                    }>(viewId, "", "POST", {
                      previewId: preview.previewId,
                      confirmed: true,
                    });
                    setIssued({
                      id: result.item.id,
                      url: new URL(result.item.path, window.location.origin)
                        .href,
                    });
                    setPreview(null);
                    setConfirmed(false);
                    await refresh();
                  })
                }
              >
                Create public link
              </button>
              <button disabled={busy} onClick={() => setPreview(null)}>
                Cancel preview
              </button>
            </section>
          )}
        </>
      ) : (
        <p>
          Complete a run of the current saved report before creating a public
          link.
        </p>
      )}
      {issued && (
        <section
          className="report-public-issued"
          aria-label="Created public report link"
        >
          <button
            aria-label="Dismiss public link"
            onClick={() => setIssued(null)}
          >
            <X size={14} />
          </button>
          <strong>Public link created</strong>
          <p>
            Copy this link now. Its secret is shown only here and cannot be
            recovered after leaving this panel.
          </p>
          <input
            aria-label="Created public report URL"
            value={issued.url}
            readOnly
            onFocus={(event) => event.target.select()}
          />
          <button
            onClick={() =>
              void action(async () => {
                await navigator.clipboard.writeText(issued.url);
                setMessage("Public report link copied.");
              })
            }
          >
            <Copy size={14} />
            Copy link
          </button>
          <a href={issued.url} target="_blank" rel="noopener noreferrer">
            <ExternalLink size={14} />
            Open public report
          </a>
        </section>
      )}
      <h4>Published links</h4>
      <button disabled={busy} onClick={() => void action(refresh)}>
        Refresh public links
      </button>
      {links.length ? (
        <ul className="report-public-links">
          {links.map((link) => (
            <li key={link.id}>
              <strong>{link.title}</strong>
              <span>
                {link.status} · expires{" "}
                {new Date(link.expiresAt).toLocaleString()}
              </span>
              <small>
                Created {new Date(link.createdAt).toLocaleString()} · CSV{" "}
                {link.allowCsv ? "enabled" : "disabled"}
              </small>
              {link.status === "active" &&
                (revokeId === link.id ? (
                  <div>
                    <p>
                      Anyone using this link will lose access. Copies already
                      downloaded cannot be recalled.
                    </p>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          await request(viewId, `/${link.id}`, "DELETE");
                          if (issued?.id === link.id) setIssued(null);
                          setRevokeId(null);
                          await refresh();
                          setMessage("Public report link revoked.");
                        })
                      }
                    >
                      Confirm revoke link
                    </button>
                    <button disabled={busy} onClick={() => setRevokeId(null)}>
                      Keep link
                    </button>
                  </div>
                ) : (
                  <button disabled={busy} onClick={() => setRevokeId(link.id)}>
                    Revoke link
                  </button>
                ))}
            </li>
          ))}
        </ul>
      ) : (
        <p>No public links have been created.</p>
      )}
    </details>
  );
}
