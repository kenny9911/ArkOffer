import { useEffect, useState } from "react";

type Session = {
  id: string;
  state: string;
  consentAt: string;
  endedAt: string | null;
  endReason: string | null;
  recording: boolean;
  events: {
    id: string;
    sequence: number;
    kind:
      | "ready"
      | "answer"
      | "agent"
      | "ended"
      | "error"
      | "followup-question"
      | "followup-answer"
      | "skip"
      | "followup-skip";
    text: string;
    createdAt: string;
    timing?: {
      source: "livekit-vad" | "livekit-playout";
      startedAtMs: number;
      endedAtMs: number;
    } | null;
  }[];
};

export default function ScreeningLiveEvidence({ path }: { path: string }) {
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setSessions(null);
    setError("");
    fetch(`/api/${path}`, { credentials: "include", signal: controller.signal })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok)
          throw new Error(data.error || "Could not load interview transcript.");
        if (!controller.signal.aborted) setSessions(data.items);
      })
      .catch((cause: Error) => {
        if (!controller.signal.aborted) setError(cause.message);
      });
    return () => controller.abort();
  }, [open, path, retry]);

  return (
    <section
      className="screening-live-evidence"
      aria-label="Live interview evidence"
    >
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "Hide" : "View"} full interview transcript
      </button>
      {open && (
        <div>
          <p className="screening-candidate-muted">
            The transcript may contain transcription errors. Final answers above
            include the candidate’s corrections.{" "}
            {sessions && !sessions.some((session) => session.recording)
              ? "Audio and video were not recorded."
              : "Consented recordings, when available, appear below."}
          </p>
          {error ? (
            <p role="alert">
              {error}{" "}
              <button
                type="button"
                onClick={() => setRetry((value) => value + 1)}
              >
                Retry transcript
              </button>
            </p>
          ) : sessions === null ? (
            <p role="status">Loading transcript…</p>
          ) : sessions.length === 0 ? (
            <p>No live interview transcript is available.</p>
          ) : (
            sessions.map((session) => (
              <article key={session.id}>
                <p className="screening-candidate-muted">
                  {session.state} · Consented{" "}
                  {new Date(session.consentAt).toLocaleString()}
                  {session.endedAt
                    ? ` · Ended ${new Date(session.endedAt).toLocaleString()}`
                    : ""}
                </p>
                <ol className="screening-live-turns">
                  {session.events
                    .filter((event) =>
                      [
                        "answer",
                        "agent",
                        "followup-question",
                        "followup-answer",
                        "skip",
                        "followup-skip",
                      ].includes(event.kind),
                    )
                    .map((event) => (
                      <li key={event.id}>
                        <strong>
                          {[
                            "answer",
                            "followup-answer",
                            "skip",
                            "followup-skip",
                          ].includes(event.kind)
                            ? "Candidate"
                            : "Interviewer"}
                          {event.kind.startsWith("followup-")
                            ? " · Follow-up"
                            : ""}
                        </strong>
                        <time
                          dateTime={
                            event.timing
                              ? new Date(event.timing.startedAtMs).toISOString()
                              : event.createdAt
                          }
                        >
                          {event.timing ? "Spoken " : "Received "}
                          {new Date(
                            event.timing?.startedAtMs ?? event.createdAt,
                          ).toLocaleTimeString()}
                        </time>
                        <p>{event.text}</p>
                      </li>
                    ))}
                </ol>
              </article>
            ))
          )}
        </div>
      )}
    </section>
  );
}
