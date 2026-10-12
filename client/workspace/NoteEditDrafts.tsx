import { useEffect, useRef, useState } from "react";
import {
  api,
  json,
  Button,
  Field,
  Modal,
  ErrorBanner,
  Loading,
  type Item,
} from "../ui";
import "./NoteEditDrafts.css";

type Target =
  | { kind: "section"; sectionId: string }
  | { kind: "tldr" | "summary" | "summary-and-transcript" };
type Draft = {
  id: string;
  target: Target;
  operation: string;
  status: string;
  error?: string;
  before: string;
  proposed: string;
  createdAt: string;
  sourceFingerprint: string;
  evidence: Array<{ source: string; quote: string }>;
  changes?: Array<{ title: string; before: string; content: string }>;
};
export function NoteEditDrafts({
  note,
  initialTarget,
  beforeAction,
  onApplied,
  onClose,
}: {
  note: Item;
  initialTarget: string;
  beforeAction: () => Promise<void>;
  onApplied: (item: Item) => Promise<void>;
  onClose: () => void;
}) {
  const [target, setTarget] = useState(initialTarget),
    [operation, setOperation] = useState("replace"),
    [instructions, setInstructions] = useState(""),
    [pronouns, setPronouns] = useState(""),
    [find, setFind] = useState(""),
    [replacement, setReplacement] = useState(""),
    [items, setItems] = useState<Draft[]>([]),
    [selected, setSelected] = useState<Draft | null>(null),
    [fingerprint, setFingerprint] = useState(""),
    [aiAvailable, setAiAvailable] = useState(false),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const mounted = useRef(true),
    retry = useRef<{ signature: string; body: Record<string, unknown> } | null>(
      null,
    );
  const base = `conversations/${note.id}/note-edits`,
    bulk = target === "summary" || target === "summary-and-transcript";
  async function refresh() {
    const result = await api(base);
    if (mounted.current) {
      setItems(result.items);
      setFingerprint(result.sourceFingerprint);
      setAiAvailable(result.aiAvailable);
    }
    return result;
  }
  useEffect(() => {
    mounted.current = true;
    void (async () => {
      try {
        await beforeAction();
        await refresh();
      } catch (e) {
        if (mounted.current) setError((e as Error).message);
      } finally {
        if (mounted.current) setLoading(false);
      }
    })();
    return () => {
      mounted.current = false;
    };
  }, [note.id]);
  async function create() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await beforeAction();
      const chosenTarget: Target = target.startsWith("section:")
        ? { kind: "section", sectionId: target.slice(8) }
        : { kind: target as "tldr" | "summary" | "summary-and-transcript" };
      const input = {
        sourceFingerprint: fingerprint,
        target: chosenTarget,
        operation,
        ...(operation === "replace"
          ? { find, replacement }
          : {
              instructions,
              ...(pronouns ? { pronounInstructions: pronouns } : {}),
            }),
      };
      const signature = JSON.stringify(input);
      if (!retry.current || retry.current.signature !== signature)
        retry.current = {
          signature,
          body: { ...input, requestId: crypto.randomUUID() },
        };
      const result = await api(base, json("POST", retry.current.body));
      setSelected(result.item);
      await refresh();
      if (result.item.status === "ready") {
        retry.current = null;
        setNotice("Preview saved. Your notes have not changed.");
      } else if (result.item.status === "failed") {
        retry.current = null;
        setError(result.item.error || "Draft generation failed.");
      } else if (result.item.status === "generating")
        setNotice(
          "This request is still being prepared. Reload drafts to check its status; it will not be sent again.",
        );
    } catch (e) {
      setError((e as Error).message);
      await refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  async function action(draft: Draft, action: "apply" | "discard") {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await beforeAction();
      const result = await api(
        `${base}/${draft.id}/${action}`,
        json("POST", {}),
      );
      if (action === "apply") {
        await onApplied(result.item);
        setSelected(result.draft);
        setNotice(
          result.alreadyApplied
            ? "This draft was already applied. Later edits were kept."
            : "Edit applied. The previous notes are in Version history.",
        );
      } else {
        setSelected(result.item);
        setNotice("Draft discarded. Your notes have not changed.");
      }
      await refresh();
    } catch (e) {
      setError((e as Error).message);
      await refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Edit notes"
      wide
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="note-edits">
        <p className="muted">
          Create a private draft, review the evidence and preview, then choose
          Apply. Draft history retains your latest 100 edits for this
          conversation.
        </p>
        {loading ? (
          <Loading />
        ) : (
          <>
            <fieldset disabled={busy} className="note-edit-form">
              <div className="form-grid">
                <Field label="Edit scope">
                  <select
                    value={target}
                    onChange={(e) => {
                      setTarget(e.target.value);
                      if (
                        ["summary", "summary-and-transcript"].includes(
                          e.target.value,
                        )
                      )
                        setOperation("replace");
                    }}
                  >
                    {(note.sections || []).map((section: any) => (
                      <option key={section.id} value={`section:${section.id}`}>
                        {section.title}
                      </option>
                    ))}
                    <option value="tldr">TLDR</option>
                    <option value="summary">
                      All current sections and TLDR
                    </option>
                    <option value="summary-and-transcript">
                      All current sections, TLDR and transcript
                    </option>
                  </select>
                </Field>
                <Field label="Edit action">
                  <select
                    value={operation}
                    onChange={(e) => setOperation(e.target.value)}
                  >
                    <option value="replace">Replace exact term / redact</option>
                    <option value="shorten" disabled={!aiAvailable || bulk}>
                      Make shorter
                    </option>
                    <option value="expand" disabled={!aiAvailable || bulk}>
                      Add evidence-based detail
                    </option>
                    <option value="bullets" disabled={!aiAvailable || bulk}>
                      Convert to bullets
                    </option>
                    <option value="paragraphs" disabled={!aiAvailable || bulk}>
                      Convert to paragraphs
                    </option>
                    <option value="custom" disabled={!aiAvailable || bulk}>
                      Custom AI instructions
                    </option>
                  </select>
                </Field>
              </div>
              {operation === "replace" ? (
                <>
                  <div className="form-grid">
                    <Field
                      label="Exact term"
                      hint="Case-sensitive literal text, including punctuation."
                    >
                      <input
                        value={find}
                        maxLength={500}
                        onChange={(e) => setFind(e.target.value)}
                      />
                    </Field>
                    <Field
                      label="Replace with"
                      hint="Leave blank to remove the term, or enter [redacted]."
                    >
                      <input
                        value={replacement}
                        maxLength={500}
                        onChange={(e) => setReplacement(e.target.value)}
                      />
                    </Field>
                  </div>
                  <p className="note-edit-scope">
                    Replaces every exact match in{" "}
                    {target === "summary-and-transcript"
                      ? "current section contents, TLDR and transcript"
                      : target === "summary"
                        ? "current section contents and TLDR"
                        : "the selected notes only"}
                    . No AI is used.{" "}
                    {target !== "summary-and-transcript"
                      ? "The transcript is unchanged. "
                      : ""}
                    Titles, names in metadata, snippets, saved versions, draft
                    history, exports and other records are unchanged. This is a
                    text edit, not complete data erasure.
                  </p>
                </>
              ) : (
                <>
                  <Field
                    label="Editing instructions"
                    hint="Change presentation while keeping the source meaning and uncertainty."
                  >
                    <textarea
                      value={instructions}
                      maxLength={2000}
                      rows={3}
                      onChange={(e) => setInstructions(e.target.value)}
                    />
                  </Field>
                  <Field
                    label="Explicit pronoun wording (optional)"
                    hint="Only enter wording the person has provided. No names, gender or pronouns will be inferred."
                  >
                    <input
                      value={pronouns}
                      maxLength={300}
                      onChange={(e) => setPronouns(e.target.value)}
                      placeholder="For example: use they/them for Alex"
                    />
                  </Field>
                </>
              )}
              {!aiAvailable && (
                <p className="muted">
                  AI edits are not enabled for this workspace. Exact-term
                  replacement is available.
                </p>
              )}
              <div className="form-actions">
                <Button
                  onClick={() => void create()}
                  variant="primary"
                  busy={busy}
                  disabled={
                    !fingerprint ||
                    (operation === "replace" && !find) ||
                    (operation === "custom" && !instructions.trim())
                  }
                >
                  Create preview
                </Button>
              </div>
            </fieldset>
            <ErrorBanner error={error} />
            {notice && (
              <p className="note-edit-notice" role="status">
                {notice}
              </p>
            )}
            {selected && (
              <section
                className="note-edit-preview"
                aria-label="Note edit preview"
              >
                <div className="section-heading">
                  <h3>Preview · {selected.status}</h3>
                  <span>{selected.operation}</span>
                </div>
                {selected.status === "failed" && (
                  <ErrorBanner
                    error={
                      selected.error || "The provider did not return a draft."
                    }
                  />
                )}
                {selected.proposed !== null &&
                  selected.proposed !== undefined && (
                    <>
                      {selected.changes && (
                        <p>
                          {selected.changes.length} field
                          {selected.changes.length === 1 ? "" : "s"} will change
                          in the chosen scope.
                        </p>
                      )}
                      {(
                        selected.changes || [
                          {
                            title: "Selected notes",
                            before: selected.before,
                            content: selected.proposed,
                          },
                        ]
                      ).map((change, i) => (
                        <div key={i}>
                          <h4>{change.title}</h4>
                          <div className="note-edit-comparison">
                            <div>
                              <strong>Before</strong>
                              <pre>{change.before}</pre>
                            </div>
                            <div>
                              <strong>Proposed</strong>
                              <pre>
                                {change.content || "(Empty after removal)"}
                              </pre>
                            </div>
                          </div>
                        </div>
                      ))}
                      <details className="note-edit-evidence">
                        <summary>
                          Source evidence ({selected.evidence.length})
                        </summary>
                        <p className="muted">
                          Quotations are checked against the source. Review the
                          proposed wording for accuracy.
                        </p>
                        {selected.evidence.map((entry, i) => (
                          <blockquote key={i}>
                            <small>
                              {entry.source === "notes"
                                ? "Original notes"
                                : "Transcript"}
                            </small>
                            <p>{entry.quote}</p>
                          </blockquote>
                        ))}
                      </details>
                    </>
                  )}
                {selected.status === "ready" && (
                  <>
                    {selected.sourceFingerprint !== fingerprint && (
                      <p className="note-edit-scope">
                        This preview is out of date. Create a new draft to keep
                        the latest conversation edits.
                      </p>
                    )}
                    <div className="form-actions">
                      <Button
                        disabled={busy}
                        onClick={() => void action(selected, "discard")}
                      >
                        Discard draft
                      </Button>
                      <Button
                        variant="primary"
                        busy={busy}
                        disabled={selected.sourceFingerprint !== fingerprint}
                        onClick={() => void action(selected, "apply")}
                      >
                        Apply this draft
                      </Button>
                    </div>
                  </>
                )}
              </section>
            )}
            <section
              className="note-edit-history"
              aria-label="Note edit history"
            >
              <div className="section-heading">
                <h3>Your draft history</h3>
                <Button
                  disabled={busy}
                  onClick={async () => {
                    try {
                      const result = await refresh();
                      if (selected)
                        setSelected(
                          result.items.find(
                            (draft: Draft) => draft.id === selected.id,
                          ) || null,
                        );
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                >
                  Reload drafts
                </Button>
              </div>
              {items.length ? (
                <ul>
                  {items.map((draft) => (
                    <li key={draft.id}>
                      <button
                        onClick={() => setSelected(draft)}
                        disabled={busy}
                      >
                        <strong>
                          {draft.operation} ·{" "}
                          {draft.target.kind === "section"
                            ? (note.sections || []).find(
                                (section: any) =>
                                  section.id ===
                                  (draft.target as { sectionId: string })
                                    .sectionId,
                              )?.title || "Section"
                            : draft.target.kind}
                        </strong>
                        <span>
                          {draft.status} ·{" "}
                          {new Date(draft.createdAt).toLocaleString()}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">No saved drafts yet.</p>
              )}
            </section>
          </>
        )}
        <div className="form-actions">
          <Button disabled={busy} onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Modal>
  );
}
