import { useEffect, useRef, useState } from "react";

export type DocumentReference = { id: string; fingerprint: string };
type Document = DocumentReference & {
  title: string;
  characters: number;
  type: string;
  text?: string;
};
export default function ApplicationDocuments({
  applicationId,
  selected,
  disabled,
  onChange,
  onDeleted,
  onBusy,
}: {
  applicationId: string;
  selected: DocumentReference[];
  disabled: boolean;
  onChange: (documents: DocumentReference[]) => void;
  onDeleted: () => Promise<void>;
  onBusy: (busy: boolean) => void;
}) {
  const path = `/api/applications/${encodeURIComponent(applicationId)}/documents`;
  const [documents, setDocuments] = useState<Document[]>([]),
    [preview, setPreview] = useState<Document | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [loaded, setLoaded] = useState(false),
    [removeId, setRemoveId] = useState("");
  const lifetime = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  async function request<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, {
      credentials: "same-origin",
      ...init,
      signal: lifetime.current?.signal,
    });
    const data = await response.json();
    if (!response.ok)
      throw new Error(data.error || "Unable to load private CVs.");
    return data;
  }
  async function load() {
    const response = await request<{ items: Document[] }>(path);
    setDocuments(response.items);
    setLoaded(true);
  }
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    void load().catch((cause) => {
      if (!controller.signal.aborted) setError(cause.message);
    });
    return () => controller.abort();
  }, [applicationId]);
  async function action(work: () => Promise<void>) {
    setBusy(true);
    onBusy(true);
    setError("");
    try {
      await work();
    } catch (cause) {
      if (!lifetime.current?.signal.aborted)
        setError(cause instanceof Error ? cause.message : "CV request failed.");
    } finally {
      if (!lifetime.current?.signal.aborted) {
        setBusy(false);
        onBusy(false);
      }
    }
  }
  return (
    <section className="application-documents" aria-label="Private CV evidence">
      <h4>CVs and resumes</h4>
      <p>
        Upload a PDF or DOCX for this application, inspect its extracted text,
        then select it as evidence. Your uploads and reviews are private to you.
        Original files are removed after extraction.
      </p>
      <p className="application-review-muted">
        10 MB per file · 60,000 characters · 5 CVs per application · select up
        to 3. Scanned images need a text-based document.
      </p>
      {error && (
        <p role="alert" className="application-review-error">
          {error}
        </p>
      )}
      <label className="application-review-field">
        Upload a CV
        <input
          ref={fileInput}
          type="file"
          accept="application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.pdf,.docx"
          disabled={disabled || busy || documents.length >= 5}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            void action(async () => {
              if (file.size > 10 * 1024 * 1024)
                throw new Error("CVs must be 10 MB or smaller.");
              const form = new FormData();
              form.append("file", file);
              const response = await request<{ item: Document }>(path, {
                method: "POST",
                body: form,
              });
              setPreview(response.item);
              await load();
            }).finally(() => {
              if (fileInput.current) fileInput.current.value = "";
            });
          }}
        />
      </label>
      {busy && <p role="status">Working with your private CV…</p>}
      {!documents.length && (
        <p className="application-review-muted">
          {loaded
            ? "No private CVs uploaded for this application."
            : "Loading private CVs…"}
        </p>
      )}
      <div className="application-documents-list">
        {documents.map((document) => {
          const checked = selected.some((item) => item.id === document.id);
          return (
            <article key={document.id}>
              <label className="application-review-check">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={
                    disabled || busy || (!checked && selected.length >= 3)
                  }
                  onChange={(event) =>
                    onChange(
                      event.target.checked
                        ? [
                            ...selected,
                            {
                              id: document.id,
                              fingerprint: document.fingerprint,
                            },
                          ]
                        : selected.filter((item) => item.id !== document.id),
                    )
                  }
                />
                <span>
                  {document.title}
                  <small>
                    {document.type.toUpperCase()} ·{" "}
                    {document.characters.toLocaleString()} characters
                  </small>
                </span>
              </label>
              <div className="application-review-actions">
                <button
                  type="button"
                  className="business-button secondary"
                  disabled={disabled || busy}
                  aria-label={`Preview ${document.title}`}
                  onClick={() =>
                    void action(async () => {
                      const response = await request<{ item: Document }>(
                        `${path}/${document.id}`,
                      );
                      setPreview(response.item);
                    })
                  }
                >
                  Preview text
                </button>
                <button
                  type="button"
                  className="business-button secondary"
                  disabled={disabled || busy}
                  aria-label={`Delete ${document.title}`}
                  onClick={() => setRemoveId(document.id)}
                >
                  Delete
                </button>
              </div>
              {removeId === document.id && (
                <div className="application-document-confirm">
                  <p>
                    Delete this private CV? Reviews using it will become
                    unavailable.
                  </p>
                  <button
                    type="button"
                    className="business-button"
                    disabled={disabled || busy}
                    onClick={() =>
                      void action(async () => {
                        await request(`${path}/${document.id}`, {
                          method: "DELETE",
                        });
                        onChange(
                          selected.filter((item) => item.id !== document.id),
                        );
                        setPreview((current) =>
                          current?.id === document.id ? null : current,
                        );
                        setRemoveId("");
                        setDocuments((current) =>
                          current.filter((item) => item.id !== document.id),
                        );
                        await onDeleted();
                      })
                    }
                  >
                    Delete CV
                  </button>{" "}
                  <button
                    type="button"
                    className="business-button secondary"
                    disabled={disabled || busy}
                    onClick={() => setRemoveId("")}
                  >
                    Keep CV
                  </button>
                </div>
              )}
            </article>
          );
        })}
      </div>
      {preview && (
        <div className="application-document-preview">
          <div className="application-review-actions">
            <h4>Extracted text: {preview.title}</h4>
            <button
              type="button"
              className="business-button secondary"
              onClick={() => setPreview(null)}
            >
              Close preview
            </button>
          </div>
          <p className="application-review-muted">
            Check for extraction errors and verify this CV belongs to the
            applicant before sending it to AI.
          </p>
          <pre>{preview.text}</pre>
        </div>
      )}
    </section>
  );
}
