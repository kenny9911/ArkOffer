import { useEffect, useRef, useState } from "react";
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
                  <SynchronizedRecording
                    key={`${path}/${item.id}`}
                    path={`${path}/${item.id}`}
                    label={`Interview recording ${index + 1}`}
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

type TranscriptTurn = {
  id: string;
  kind: string;
  text: string;
  startSeconds: number | null;
  endSeconds: number | null;
};
const elapsed = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
const speaker = (kind: string) =>
  ["answer", "followup-answer", "skip", "followup-skip"].includes(kind)
    ? "Candidate"
    : "Interviewer";

function SynchronizedRecording({
  path,
  label,
  onError,
}: {
  path: string;
  label: string;
  onError: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const activeRow = useRef<HTMLLIElement>(null);
  const pendingSeek = useRef<number | null>(null);
  const [turns, setTurns] = useState<TranscriptTurn[] | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [query, setQuery] = useState("");
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [follow, setFollow] = useState(true);
  const [rate, setRate] = useState(1);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    fetch(`/api/${path}/transcript`, {
      credentials: "include",
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok)
          throw new Error(
            data.error || "Could not load the recording transcript.",
          );
        if (!controller.signal.aborted)
          setTurns(Array.isArray(data.items) ? data.items : []);
      })
      .catch((cause: Error) => {
        if (!controller.signal.aborted) setError(cause.message);
      });
    return () => controller.abort();
  }, [path, retry]);
  const visible = (turns || []).filter((turn) =>
    turn.text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const active = (turns || []).find(
    (turn) =>
      turn.startSeconds !== null &&
      turn.endSeconds !== null &&
      time >= turn.startSeconds &&
      time < turn.endSeconds,
  )?.id;
  const timed = visible.filter((turn) => turn.startSeconds !== null);
  useEffect(() => {
    if (!follow || !activeRow.current || !list.current) return;
    const row = activeRow.current,
      container = list.current;
    const top = row.offsetTop - container.offsetTop;
    if (
      top < container.scrollTop ||
      top + row.offsetHeight > container.scrollTop + container.clientHeight
    )
      container.scrollTop = Math.max(0, top - 16);
  }, [active, follow, query]);
  function seek(value: number) {
    const element = video.current;
    if (!element) return;
    const next = Math.max(
      0,
      Number.isFinite(element.duration)
        ? Math.min(value, element.duration)
        : value,
    );
    if (!element.readyState) pendingSeek.current = next;
    else element.currentTime = next;
    setTime(next);
  }
  function toggle() {
    const element = video.current;
    if (!element) return;
    if (element.paused) void element.play().catch(onError);
    else element.pause();
  }
  return (
    <div className="screening-synchronized-player">
      <video
        ref={video}
        controls
        playsInline
        preload="metadata"
        src={`/api/${path}/media`}
        aria-label={label}
        onError={onError}
        onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onLoadedMetadata={() => {
          if (pendingSeek.current !== null) {
            seek(pendingSeek.current);
            pendingSeek.current = null;
          }
        }}
      />
      <div
        className="screening-player-controls"
        role="group"
        aria-label="Video playback controls"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if ([" ", "k", "ArrowLeft", "ArrowRight"].includes(event.key)) {
            event.preventDefault();
            if (event.key === " " || event.key === "k") toggle();
            else seek(time + (event.key === "ArrowLeft" ? -10 : 10));
          }
        }}
      >
        <button
          type="button"
          onClick={() => seek(time - 10)}
          aria-label="Back 10 seconds"
        >
          −10s
        </button>
        <button type="button" onClick={toggle}>
          {playing ? "Pause video" : "Play video"}
        </button>
        <button
          type="button"
          onClick={() => seek(time + 10)}
          aria-label="Forward 10 seconds"
        >
          +10s
        </button>
        <span>{elapsed(time)}</span>
        <label>
          Playback speed{" "}
          <select
            value={rate}
            onChange={(event) => {
              const value = Number(event.target.value);
              setRate(value);
              if (video.current) video.current.playbackRate = value;
            }}
          >
            {[0.5, 0.75, 1, 1.25, 1.5, 2].map((value) => (
              <option key={value} value={value}>
                {value}×
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="screening-candidate-muted">
        Original speech transcript. Submitted answers may include candidate
        corrections. Timestamps approximate each spoken turn using speech
        detection and audio playout; they are not word-level alignment.
      </p>
      <p className="screening-candidate-muted">
        Focus playback controls: Space or K to play/pause; ←/→ to seek 10
        seconds. Transcript timestamp buttons work with Enter or Space.
      </p>
      <label className="screening-transcript-search">
        Search recording transcript
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <label className="screening-follow-playback">
        <input
          type="checkbox"
          checked={follow}
          onChange={(event) => setFollow(event.target.checked)}
        />{" "}
        Follow playback
      </label>
      {error ? (
        <p role="alert">
          {error}{" "}
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            Retry recording transcript
          </button>
        </p>
      ) : turns === null ? (
        <p role="status">Loading recording transcript…</p>
      ) : (
        <>
          <p role="status">
            {visible.length} transcript{" "}
            {visible.length === 1 ? "turn" : "turns"}
            {query ? " match your search" : ""}.
          </p>
          {turns.length > 0 && timed.length === 0 && !query && (
            <p>
              Timing is unavailable for this recording. You can read the
              original transcript and use the video controls.
            </p>
          )}
          <ol
            ref={list}
            className="screening-recording-transcript"
            aria-label="Synchronized interview transcript"
          >
            {visible.map((turn) => (
              <li
                key={turn.id}
                ref={active === turn.id ? activeRow : null}
                aria-current={active === turn.id ? "true" : undefined}
              >
                <div>
                  <strong>
                    {speaker(turn.kind)}
                    {turn.kind.startsWith("followup-") ? " · Follow-up" : ""}
                  </strong>
                  {turn.startSeconds !== null ? (
                    <button
                      type="button"
                      aria-label={`Seek to ${elapsed(turn.startSeconds)} ${speaker(turn.kind)}: ${turn.text}`}
                      onClick={() => seek(turn.startSeconds!)}
                    >
                      {elapsed(turn.startSeconds)}
                    </button>
                  ) : (
                    <span className="screening-candidate-muted">
                      Timing unavailable
                    </span>
                  )}
                </div>
                <p>{turn.text}</p>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}
