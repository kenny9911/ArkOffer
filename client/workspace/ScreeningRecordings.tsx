import { useEffect, useState } from "react";
import "./screening-recordings.css";

type Recording = {
  id: string;
  state: string;
  consentAt: string;
  expiresAt: string;
  durationSeconds: number;
  bytes: number;
  playable: boolean;
};
export default function ScreeningRecordings({ path }: { path: string }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Recording[] | null>(null);
  const [canDelete, setCanDelete] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [confirm, setConfirm] = useState("");
  const [playing, setPlaying] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setError("");
    fetch(`/api/${path}`, { credentials: "include", signal: controller.signal })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok)
          throw new Error(data.error || "Could not load recordings.");
        if (!controller.signal.aborted) {
          setItems(data.items);
          setCanDelete(data.canDelete);
          setPlaying((id) =>
            data.items.some(
              (item: Recording) => item.id === id && item.playable,
            )
              ? id
              : "",
          );
        }
      })
      .catch((cause: Error) => {
        if (!controller.signal.aborted) setError(cause.message);
      });
    return () => controller.abort();
  }, [open, path, revision]);
  useEffect(() => {
    if (
      !open ||
      !items?.some((item) =>
        ["starting", "unknown", "recording", "processing", "deleting"].includes(
          item.state,
        ),
      )
    )
      return;
    const timer = setTimeout(() => setRevision((value) => value + 1), 15_000);
    return () => clearTimeout(timer);
  }, [open, items]);
  async function remove(id: string) {
    setBusy(id);
    setError("");
    try {
      const response = await fetch(`/api/${path}/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Could not delete recording.");
      setPlaying("");
      setConfirm("");
      setItems(
        (current) =>
          current?.map((item) =>
            item.id === id
              ? { ...item, state: data.state, playable: false }
              : item,
          ) || null,
      );
      setRevision((value) => value + 1);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy("");
    }
  }
  return (
    <section className="screening-recordings" aria-label="Interview recordings">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          setPlaying("");
        }}
      >
        {open ? "Hide" : "View"} interview recordings
      </button>
      {open && (
        <div>
          <p className="screening-candidate-muted">
            Recordings include the candidate’s published camera and interview
            audio, when recording was enabled and consented to. Access is
            restricted to this hiring workspace.
          </p>
          <button
            type="button"
            onClick={() => setRevision((value) => value + 1)}
          >
            Refresh recordings
          </button>
          {error && <p role="alert">{error}</p>}
          {items === null ? (
            <p role="status">Loading recordings…</p>
          ) : items.length === 0 ? (
            <p>No recording was attached to this response.</p>
          ) : (
            items.map((item, index) => (
              <article key={item.id}>
                <header>
                  <strong>Interview recording {index + 1}</strong>
                  <span>{item.state}</span>
                </header>
                <p className="screening-candidate-muted">
                  Recording consent: {new Date(item.consentAt).toLocaleString()}{" "}
                  · Available until {new Date(item.expiresAt).toLocaleString()}
                </p>
                {item.durationSeconds > 0 && (
                  <p>
                    {Math.ceil(item.durationSeconds / 60)} minutes ·{" "}
                    {(item.bytes / 1024 / 1024).toFixed(1)} MB
                  </p>
                )}
                {item.playable && (
                  <div className="screening-recording-actions">
                    <button
                      type="button"
                      onClick={() =>
                        setPlaying(playing === item.id ? "" : item.id)
                      }
                    >
                      {playing === item.id ? "Close player" : "Play recording"}
                    </button>
                    <a
                      href={`/api/${path}/${item.id}/media?download=1`}
                      download="screening-interview.mp4"
                    >
                      Download MP4
                    </a>
                  </div>
                )}
                {playing === item.id && item.playable && (
                  <video
                    controls
                    playsInline
                    preload="metadata"
                    src={`/api/${path}/${item.id}/media`}
                    aria-label={`Interview recording ${index + 1}`}
                    onError={() =>
                      setError(
                        "This recording could not be loaded. Refresh to check its availability.",
                      )
                    }
                  />
                )}
                {["starting", "unknown", "recording", "processing"].includes(
                  item.state,
                ) && (
                  <p role="status">
                    The recording is being processed. This view refreshes
                    automatically.
                  </p>
                )}
                {item.state === "failed" && (
                  <p>
                    The provider could not produce a playable recording. The
                    submitted transcript remains available.
                  </p>
                )}
                {item.state === "expired" && (
                  <p>
                    This recording has reached its retention limit and cannot be
                    played.
                  </p>
                )}
                {item.state === "deleting" && (
                  <p role="status">
                    Access has been removed. Storage deletion is queued and
                    retried until confirmed.
                  </p>
                )}
                {item.state === "deleted" && (
                  <p>The stored recording has been deleted.</p>
                )}
                {canDelete &&
                  !["deleted", "deleting"].includes(item.state) &&
                  (confirm === item.id ? (
                    <div
                      className="screening-recording-confirm"
                      role="group"
                      aria-label="Confirm recording deletion"
                    >
                      <p>
                        Delete this recording permanently? The transcript and
                        submitted answers will remain.
                      </p>
                      <button
                        type="button"
                        disabled={!!busy}
                        onClick={() => void remove(item.id)}
                      >
                        {busy === item.id ? "Deleting…" : "Delete permanently"}
                      </button>
                      <button
                        type="button"
                        disabled={!!busy}
                        onClick={() => setConfirm("")}
                      >
                        Keep recording
                      </button>
                    </div>
                  ) : (
                    <button type="button" onClick={() => setConfirm(item.id)}>
                      Delete recording
                    </button>
                  ))}
              </article>
            ))
          )}
        </div>
      )}
    </section>
  );
}
