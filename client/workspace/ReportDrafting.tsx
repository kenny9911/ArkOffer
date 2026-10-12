import { useEffect, useRef, useState } from "react";
export type ReportDefinition = {
  name: string;
  question: string;
  sourceIds: string[];
  columns: {
    id: string;
    name: string;
    instruction: string;
    type: "text" | "number" | "boolean" | "currency";
  }[];
  filters: { title: string; from: string; to: string };
};
type Draft = {
  id: string;
  viewId: string | null;
  revision: number | null;
  status: string;
  brief: string;
  sourceCurrent: boolean;
  error: string | null;
  result: (Omit<ReportDefinition, "sourceIds"> & { notes: string[] }) | null;
};
async function api<T>(path = "", method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`/api/report-views/drafts${path}`, {
    method,
    credentials: "same-origin",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || "Unable to draft this report.");
  return data;
}
export default function ReportDrafting({
  viewId,
  revision,
  editorIdentity,
  onUse,
  onClose,
}: {
  viewId?: string;
  revision?: number;
  editorIdentity: string;
  onUse: (definition: ReportDefinition) => void;
  onClose: () => void;
}) {
  const [brief, setBrief] = useState(""),
    [consent, setConsent] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [items, setItems] = useState<Draft[]>([]),
    [selected, setSelected] = useState<Draft | null>(null),
    [available, setAvailable] = useState(false);
  const request = useRef<{ key: string; body: string; editor: string } | null>(
      null,
    ),
    currentEditor = useRef(editorIdentity),
    selectedEditor = useRef(editorIdentity),
    mounted = useRef(true);
  currentEditor.current = editorIdentity;
  async function refresh() {
    const result = await api<{ available: boolean; items: Draft[] }>();
    if (mounted.current) {
      setAvailable(result.available);
      setItems(
        result.items.filter(
          (item) =>
            item.viewId === (viewId || null) &&
            item.revision === (revision || null),
        ),
      );
    }
  }
  useEffect(() => {
    mounted.current = true;
    void refresh().catch((e) => {
      if (mounted.current) setError(e.message);
    });
    return () => {
      mounted.current = false;
    };
  }, [viewId, revision]);
  async function checkStatus() {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      const { item } = await api<{ item: Draft }>(`/${selected.id}`);
      if (mounted.current) {
        setSelected(item);
        if (item.status !== "running") request.current = null;
        await refresh();
      }
    } catch (error) {
      if (mounted.current) setError((error as Error).message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function generate() {
    const body = JSON.stringify({
      brief,
      consent: true,
      ...(viewId ? { viewId, revision } : {}),
    });
    if (!request.current || request.current.body !== body)
      request.current = {
        key: crypto.randomUUID(),
        body,
        editor: currentEditor.current,
      };
    setBusy(true);
    setError("");
    try {
      const { item } = await api<{ item: Draft }>("", "POST", {
        ...JSON.parse(body),
        requestId: request.current.key,
      });
      if (!mounted.current) return;
      selectedEditor.current = request.current.editor;
      setSelected(item);
      // Keep the request identity after a lost response or running replay: retrying must never buy another draft.
      if (item.status !== "running") request.current = null;
      await refresh();
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <aside className="report-drafting" aria-label="Report drafting agent">
      <div className="ai-report-view-heading">
        <div>
          <h4>What do you want to report on?</h4>
          <p>
            The agent proposes columns and filters for you to review. Select
            conversations in the editor afterward.
          </p>
        </div>
        <button type="button" onClick={onClose} disabled={busy}>
          Close agent
        </button>
      </div>
      {error && (
        <p role="alert" className="ai-report-error">
          {error}
        </p>
      )}
      <div
        className="report-prompt-suggestions"
        aria-label="Report prompt suggestions"
      >
        {[
          "Summarize candidate feedback from my conversations.",
          "Compare documented team sizes and leadership examples.",
          "What questions were left unanswered in these interviews?",
        ].map((prompt) => (
          <button
            type="button"
            key={prompt}
            disabled={busy}
            onClick={() => {
              setBrief(prompt);
              setConsent(false);
            }}
          >
            {prompt}
          </button>
        ))}
      </div>
      <label>
        Report brief
        <textarea
          rows={3}
          minLength={20}
          maxLength={4000}
          value={brief}
          disabled={busy}
          onChange={(e) => {
            setBrief(e.target.value);
            setConsent(false);
          }}
          placeholder="Compare documented team sizes and leadership examples across engineering interviews."
        />
      </label>
      <label className="ai-report-check">
        <input
          type="checkbox"
          checked={consent}
          disabled={busy || !available}
          onChange={(e) => setConsent(e.target.checked)}
        />
        <span>
          I agree to send this brief to the configured AI provider. No source
          conversations are included. Provider usage may incur charges.
        </span>
      </label>
      <button
        type="button"
        onClick={() =>
          void (selected?.status === "running" ? checkStatus() : generate())
        }
        disabled={
          busy ||
          (selected?.status !== "running" &&
            (!available || !consent || brief.trim().length < 20))
        }
      >
        {busy
          ? "Drafting report…"
          : selected?.status === "running"
            ? "Check draft status"
            : "Generate report proposal"}
      </button>
      {!available && (
        <p>
          Report drafting needs text AI enabled for this workspace. The manual
          editor remains available.
        </p>
      )}
      {!!items.length && (
        <label className="report-draft-history">
          Private proposal history
          <select
            aria-label="Report proposal history"
            value={selected?.id || ""}
            onChange={(e) => {
              setSelected(
                items.find((item) => item.id === e.target.value) || null,
              );
              selectedEditor.current = currentEditor.current;
            }}
          >
            <option value="">Select a proposal</option>
            {items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.result?.name || item.brief.slice(0, 60)} · {item.status}
              </option>
            ))}
          </select>
        </label>
      )}
      {selected && (
        <div className="report-proposal">
          {!selected.sourceCurrent ? (
            <p role="alert">
              The saved report changed. This proposal can no longer be applied.
            </p>
          ) : selected.result ? (
            <>
              <h4>{selected.result.name}</h4>
              <p>{selected.result.question}</p>
              <ul>
                {selected.result.columns.map((column) => (
                  <li key={column.id}>
                    <strong>
                      {column.name} · {column.type}
                    </strong>
                    <p>{column.instruction}</p>
                  </li>
                ))}
              </ul>
              <p>
                Title filter: {selected.result.filters.title || "Any"} ·
                Created: {selected.result.filters.from || "Any start"} to{" "}
                {selected.result.filters.to || "Any end"}
              </p>
              {selected.result.notes.map((note, i) => (
                <p key={i}>{note}</p>
              ))}
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  if (selectedEditor.current !== currentEditor.current) {
                    setError(
                      "The editor changed after this proposal was selected. Reselect the proposal after reviewing your edits.",
                    );
                    return;
                  }
                  setBusy(true);
                  setError("");
                  try {
                    const result = await api<{ definition: ReportDefinition }>(
                      `/${selected.id}/apply`,
                      "POST",
                      { confirm: true },
                    );
                    if (selectedEditor.current !== currentEditor.current)
                      throw new Error(
                        "The editor changed during apply. Review and reselect the proposal.",
                      );
                    if (mounted.current) onUse(result.definition);
                  } catch (e) {
                    if (mounted.current) setError((e as Error).message);
                  } finally {
                    if (mounted.current) setBusy(false);
                  }
                }}
              >
                Use proposal in editor
              </button>
              <p>
                Review the definition and select sources before saving.
                Extraction requires its own confirmation.
              </p>
            </>
          ) : (
            <p role="status">
              {selected.error ||
                (selected.status === "running"
                  ? "This draft is still running. Check its status using the same brief."
                  : `Draft ${selected.status}.`)}
            </p>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api(`/${selected.id}`, "DELETE");
                setSelected(null);
                await refresh();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Discard proposal
          </button>
        </div>
      )}
    </aside>
  );
}
