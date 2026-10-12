import { useEffect, useRef, useState } from "react";
import { Camera, Mic, PhoneOff, Video } from "lucide-react";
import type { LocalTrack, Room } from "livekit-client";
import "./live-interview.css";

type LiveEvent = {
  id: string;
  kind: string;
  questionId: string | null;
  text: string | null;
};
type LiveSession = {
  id: string;
  state: string;
  expiresAt: string;
  events: LiveEvent[];
};
type Capability = {
  enabled: boolean;
  available: boolean;
  cameraPolicy: "required" | "optional" | "off";
  recording?: boolean;
  recordingRetentionDays?: number;
  reason: string;
  previousSession?: LiveSession | null;
};
type Question = { id: string; prompt: string; type: string; options: string[] };
export default function LiveInterview({
  token,
  questions,
  onBusy,
  onReview,
}: {
  token: string;
  questions: Question[];
  onBusy: (busy: boolean) => void;
  onReview: (sessionId: string, answers: Record<string, string>) => void;
}) {
  const [capability, setCapability] = useState<Capability | null>(null);
  const [phase, setPhase] = useState<
    | "recover"
    | "idle"
    | "previewing"
    | "ready"
    | "joining"
    | "active"
    | "ending"
    | "ended"
  >("idle");
  const [camera, setCamera] = useState(true),
    [consent, setConsent] = useState(false),
    [error, setError] = useState("");
  const [recordingConsent, setRecordingConsent] = useState(false);
  const [session, setSession] = useState<LiveSession | null>(null),
    [ready, setReady] = useState(false),
    [applied, setApplied] = useState(false);
  const [muted, setMuted] = useState(false),
    [audioBlocked, setAudioBlocked] = useState(false);
  const video = useRef<HTMLVideoElement>(null),
    audio = useRef<HTMLDivElement>(null),
    tracks = useRef<LocalTrack[]>([]),
    room = useRef<Room | null>(null);
  const generation = useRef(0),
    sessionId = useRef(""),
    closing = useRef(false),
    mounted = useRef(true);
  const base = `/api/interviews/${encodeURIComponent(token)}/live`;
  async function api(path: string, body?: unknown, signal?: AbortSignal) {
    const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      credentials: "omit",
      signal,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok)
      throw new Error(data.error || "The live interviewer is unavailable.");
    return data;
  }
  function stopDevices() {
    tracks.current.forEach((track) => {
      track.detach();
      track.stop();
    });
    tracks.current = [];
    if (video.current) video.current.srcObject = null;
    audio.current?.replaceChildren();
  }
  useEffect(() => {
    mounted.current = true;
    closing.current = false;
    const controller = new AbortController();
    void api("/status", undefined, controller.signal)
      .then((data: Capability) => {
        if (!controller.signal.aborted) {
          setCapability(data);
          setCamera(data.cameraPolicy !== "off");
          if (data.previousSession) {
            sessionId.current = data.previousSession.id;
            setSession(data.previousSession);
            setPhase(
              data.available &&
                ["starting", "active"].includes(data.previousSession.state)
                ? "recover"
                : "ended",
            );
          }
        }
      })
      .catch(() => {});
    return () => {
      mounted.current = false;
      controller.abort();
      generation.current++;
      closing.current = true;
      stopDevices();
      void room.current?.disconnect();
      room.current = null;
      if (sessionId.current)
        void fetch(`${base}/sessions/${sessionId.current}/end`, {
          method: "POST",
          credentials: "omit",
          keepalive: true,
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }).catch(() => {});
      onBusy(false);
    };
    // Each candidate link owns its devices and room; callbacks don't recreate it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  useEffect(() => {
    onBusy(["joining", "active", "ending", "recover"].includes(phase));
  }, [phase, onBusy]);
  useEffect(() => {
    if (phase !== "active" || !session) return;
    const controller = new AbortController();
    let pending = false;
    async function poll() {
      if (pending) return;
      pending = true;
      try {
        const data = await api(
          `/sessions/${session!.id}`,
          undefined,
          controller.signal,
        );
        if (!controller.signal.aborted) {
          setSession(data.item);
          setReady(
            data.item.events.some((event: LiveEvent) => event.kind === "ready"),
          );
          if (
            ["ended", "failed"].includes(data.item.state) ||
            new Date(data.item.expiresAt).getTime() <= Date.now()
          )
            void end();
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : "Connection lost.");
          void end();
        }
      } finally {
        pending = false;
      }
    }
    void poll();
    const timer = window.setInterval(() => void poll(), 2000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
    // Session id, not each transcript update, owns one bounded polling loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, session?.id]);
  async function preview() {
    const attempt = ++generation.current;
    closing.current = false;
    setError("");
    setPhase("previewing");
    try {
      const { createLocalTracks } = await import("livekit-client");
      if (!mounted.current || generation.current !== attempt) return;
      const created = await createLocalTracks({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: camera
          ? { resolution: { width: 640, height: 360, frameRate: 15 } }
          : false,
      });
      if (!mounted.current || generation.current !== attempt) {
        created.forEach((track) => track.stop());
        return;
      }
      tracks.current = created;
      const cameraTrack = created.find((track) => track.kind === "video");
      if (cameraTrack && video.current) cameraTrack.attach(video.current);
      setPhase("ready");
    } catch {
      if (mounted.current && generation.current === attempt) {
        stopDevices();
        setPhase("idle");
        setError(
          "Camera or microphone permission was not granted. Check your browser permissions, or use the questionnaire below.",
        );
      }
    }
  }
  function cancelPreview() {
    generation.current++;
    stopDevices();
    setPhase("idle");
  }
  async function join() {
    if (
      !consent ||
      (capability?.recording && !recordingConsent) ||
      phase !== "ready"
    )
      return;
    const attempt = ++generation.current;
    setError("");
    setPhase("joining");
    setApplied(false);
    setReady(false);
    closing.current = false;
    try {
      const data = await api("/sessions", {
        requestId: crypto.randomUUID(),
        consent: true,
        cameraEnabled: camera,
        ...(capability?.recording ? { recordingConsent: true } : {}),
      });
      sessionId.current = data.item.id;
      if (!mounted.current || generation.current !== attempt) {
        void api(`/sessions/${data.item.id}/end`, {}).catch(() => {});
        return;
      }
      setSession(data.item);
      const {
        Room: LiveKitRoom,
        RoomEvent,
        Track,
      } = await import("livekit-client");
      if (!mounted.current || generation.current !== attempt) return;
      const current = new LiveKitRoom({ adaptiveStream: true, dynacast: true });
      room.current = current;
      current.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === Track.Kind.Audio && audio.current) {
          const element = track.attach();
          element.setAttribute("aria-hidden", "true");
          audio.current.append(element);
          void (element as HTMLAudioElement)
            .play()
            .catch(() => setAudioBlocked(true));
        }
      });
      current.on(RoomEvent.TrackUnsubscribed, (track) =>
        track.detach().forEach((element) => element.remove()),
      );
      current.on(RoomEvent.Disconnected, () => {
        if (mounted.current && !closing.current) {
          setError(
            "The interview disconnected. Review any transcript received, or finish by typing.",
          );
          void end();
        }
      });
      await current.connect(data.url, data.token);
      if (!mounted.current || generation.current !== attempt) {
        await current.disconnect();
        return;
      }
      for (const track of tracks.current)
        await current.localParticipant.publishTrack(track);
      if (!mounted.current || generation.current !== attempt) {
        await current.disconnect();
        return;
      }
      setPhase("active");
    } catch (cause) {
      if (!mounted.current || generation.current !== attempt) return;
      setError(
        cause instanceof Error
          ? cause.message
          : "The interviewer could not connect.",
      );
      await end();
    }
  }
  async function end() {
    if (closing.current) return;
    closing.current = true;
    generation.current++;
    setPhase("ending");
    stopDevices();
    await room.current?.disconnect();
    room.current = null;
    try {
      if (sessionId.current) {
        const data = await api(`/sessions/${sessionId.current}/end`, {});
        if (mounted.current) setSession(data.item);
      }
      if (mounted.current) setPhase("ended");
    } catch (cause) {
      if (mounted.current) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Unable to end the interview. Please retry.",
        );
        setPhase("ending");
      }
    } finally {
      closing.current = false;
    }
  }
  function useTranscript() {
    if (!session || !["ended", "failed"].includes(session.state)) return;
    const answers: Record<string, string> = {};
    for (const question of questions) {
      const text = session.events
        .filter(
          (event) =>
            ["answer", "followup-answer"].includes(event.kind) &&
            event.questionId === question.id,
        )
        .map((event) => event.text || "")
        .join("\n");
      if (!text) continue;
      if (question.type === "text") answers[question.id] = text;
      else {
        const options =
          question.type === "yes-no" ? ["Yes", "No"] : question.options;
        const match = options.find(
          (option) =>
            option.toLowerCase() === text.toLowerCase().replace(/[.!?]$/, ""),
        );
        if (match) answers[question.id] = match;
      }
    }
    onReview(session.id, answers);
    setApplied(true);
  }
  if (!capability?.enabled) return null;
  return (
    <section className="live-interview" aria-label="Live video interview">
      <header>
        <Video size={22} />
        <div>
          <h2>Meet your AI interviewer</h2>
          <p>
            Speak through the questions, then review your responses before
            submitting.
          </p>
        </div>
      </header>
      {!capability.available ? (
        <p role="status">{capability.reason}</p>
      ) : (
        <>
          <div className="live-interview-stage">
            <video
              ref={video}
              autoPlay
              muted
              playsInline
              aria-label="Your camera preview"
              hidden={!camera || ["idle", "ended"].includes(phase)}
            />
            {(!camera || ["idle", "ended"].includes(phase)) && (
              <div className="live-interview-placeholder">
                <Camera size={32} />
                <span>{camera ? "Your camera preview" : "Camera is off"}</span>
              </div>
            )}
            <div className="live-interview-agent">
              <span aria-hidden="true">✦</span>
              <strong>ArkOffer interviewer</strong>
              <p role="status">
                {phase === "active"
                  ? ready
                    ? "Listening and responding"
                    : "Waiting for the interviewer…"
                  : phase === "joining"
                    ? "Connecting…"
                    : phase === "ended"
                      ? "Interview ended"
                      : "Ready when you are"}
              </p>
            </div>
          </div>
          <div ref={audio} />
          {phase === "idle" && (
            <>
              {capability.cameraPolicy === "optional" ? (
                <label className="live-interview-check">
                  <input
                    type="checkbox"
                    checked={camera}
                    onChange={(event) => setCamera(event.target.checked)}
                  />{" "}
                  Use my camera
                </label>
              ) : (
                <p>
                  {capability.cameraPolicy === "required"
                    ? "The hiring team requires your camera during the live interview."
                    : "This screening uses audio only."}
                </p>
              )}
              <button
                type="button"
                className="business-button secondary"
                onClick={() => void preview()}
              >
                Check camera and microphone
              </button>
            </>
          )}
          {phase === "recover" && (
            <>
              <p>
                An earlier interview attempt is still open. Close it to review
                the saved transcript and continue answering below.
              </p>
              <button
                type="button"
                className="business-button secondary"
                onClick={() => void end()}
              >
                Close previous interview
              </button>
            </>
          )}
          {phase === "previewing" && (
            <>
              <p role="status">Waiting for device permission…</p>
              <button
                type="button"
                className="business-button secondary"
                onClick={cancelPreview}
              >
                Cancel device check
              </button>
            </>
          )}
          {phase === "ready" && (
            <>
              <label className="live-interview-check">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(event) => setConsent(event.target.checked)}
                />{" "}
                I agree to share my microphone{camera ? " and camera" : ""} with
                the AI interviewer and have my spoken responses transcribed for
                the hiring team.
              </label>
              {capability.recording && (
                <label className="live-interview-check">
                  <input
                    type="checkbox"
                    checked={recordingConsent}
                    onChange={(event) =>
                      setRecordingConsent(event.target.checked)
                    }
                  />
                  I agree to recording of my interview audio
                  {camera ? " and camera video" : ""} for the hiring team,
                  retained for up to {capability.recordingRetentionDays || 30}{" "}
                  days.
                </label>
              )}
              <p className="live-interview-note">
                {capability.recording
                  ? "Recording starts when you join and ends when you leave. Your hiring team can privately review or download it before its retention deadline. "
                  : "Video and audio recordings are not stored. "}
                A transcript is retained. The interviewer does not assess your
                appearance or make hiring decisions. Maximum interview time: 30
                minutes.
              </p>
              <div className="live-interview-actions">
                <button
                  type="button"
                  className="business-button"
                  disabled={
                    !consent || (capability.recording && !recordingConsent)
                  }
                  onClick={() => void join()}
                >
                  Start live interview
                </button>
                <button
                  type="button"
                  className="business-button secondary"
                  onClick={cancelPreview}
                >
                  Cancel preview
                </button>
              </div>
            </>
          )}
          {["joining", "active"].includes(phase) && (
            <div className="live-interview-actions">
              {phase === "active" && (
                <button
                  type="button"
                  className="business-button secondary"
                  onClick={() => {
                    const next = !muted;
                    void room.current?.localParticipant
                      .setMicrophoneEnabled(!next)
                      .then(() => setMuted(next))
                      .catch(() =>
                        setError("Could not change the microphone."),
                      );
                  }}
                >
                  <Mic size={16} />
                  {muted ? "Unmute microphone" : "Mute microphone"}
                </button>
              )}
              <button
                type="button"
                className="business-button secondary"
                onClick={() => void end()}
              >
                <PhoneOff size={16} />
                End interview
              </button>
              {audioBlocked && (
                <button
                  type="button"
                  className="business-button secondary"
                  onClick={() =>
                    void room.current
                      ?.startAudio()
                      .then(() => setAudioBlocked(false))
                  }
                >
                  Enable interviewer audio
                </button>
              )}
            </div>
          )}
          {phase === "ending" && (
            <>
              <p role="status">Your devices are off. Closing the interview…</p>
              {!closing.current && (
                <button
                  type="button"
                  className="business-button secondary"
                  onClick={() => void end()}
                >
                  Retry closing interview
                </button>
              )}
            </>
          )}
          {session &&
            session.events.some((event) => event.kind === "answer") && (
              <details
                className="live-interview-transcript"
                open={phase === "ended"}
              >
                <summary>Interview transcript</summary>
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
                    <div key={event.id}>
                      <strong>
                        {[
                          "answer",
                          "followup-answer",
                          "skip",
                          "followup-skip",
                        ].includes(event.kind)
                          ? "You"
                          : "Interviewer"}
                        {event.kind.startsWith("followup-")
                          ? " · Follow-up"
                          : ""}
                      </strong>
                      <p>{event.text}</p>
                    </div>
                  ))}
              </details>
            )}
          {phase === "ended" && (
            <>
              <p>
                Review the transcript and fill any unanswered questions below.
                Nothing is submitted until you choose Submit responses.
              </p>
              <button
                type="button"
                className="business-button"
                disabled={applied || !session}
                onClick={useTranscript}
              >
                {applied
                  ? "Transcript added — review answers below"
                  : "Use transcript in my answers"}
              </button>
            </>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
