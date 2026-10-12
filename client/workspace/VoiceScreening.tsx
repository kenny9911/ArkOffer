import { useEffect, useRef, useState } from "react";
import { Mic, Square, Volume2, ChevronLeft, ChevronRight } from "lucide-react";
import "./voice-screening.css";

export type VoiceQuestion = {
  id: string;
  prompt: string;
  type: "text" | "yes-no" | "multiple-choice";
  options: string[];
  required: boolean;
};
export type VoiceEvidence = { questionId: string; turnId: string };
type Props = {
  token: string;
  questions: VoiceQuestion[];
  language?: string;
  voiceName?: string;
  answers: Record<string, string>;
  onAnswer: (questionId: string, value: string) => void;
  onEvidence: (questionId: string, turnId: string | null) => void;
  onActive: (active: boolean) => void;
  onBusy: (busy: boolean) => void;
};
type Capture = {
  stream: MediaStream;
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  parentTurnId?: string;
  samples: Float32Array[];
  count: number;
  timer?: ReturnType<typeof setTimeout>;
  ticker?: ReturnType<typeof setInterval>;
};
function release(capture: Capture | null) {
  if (!capture) return;
  clearTimeout(capture.timer);
  clearInterval(capture.ticker);
  capture.processor.onaudioprocess = null;
  capture.processor.disconnect();
  capture.source.disconnect();
  capture.stream.getTracks().forEach((track) => track.stop());
  void capture.context.close().catch(() => undefined);
}
/** Encode a bounded canonical PCM WAV so the server can verify the true audio duration. */
export function encodeVoiceWav(
  chunks: Float32Array[],
  count: number,
  sampleRate: number,
) {
  const samples = new Float32Array(count);
  let offset = 0;
  for (const chunk of chunks) {
    samples.set(chunk, offset);
    offset += chunk.length;
  }
  const outputCount = Math.min(
    16_000 * 120,
    Math.floor((count * 16_000) / sampleRate),
  );
  const buffer = new ArrayBuffer(44 + outputCount * 2),
    view = new DataView(buffer);
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i++)
      view.setUint8(at + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, buffer.byteLength - 8, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, outputCount * 2, true);
  for (let i = 0; i < outputCount; i++) {
    const value = Math.max(
      -1,
      Math.min(1, samples[Math.floor((i * sampleRate) / 16000)] || 0),
    );
    view.setInt16(44 + i * 2, value < 0 ? value * 32768 : value * 32767, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

export default function VoiceScreening({
  token,
  questions,
  answers,
  onAnswer,
  onEvidence,
  onActive,
  onBusy,
  language,
  voiceName,
}: Props) {
  const [providerName, setProviderName] = useState("OpenAI"),
    [clarification, setClarification] = useState(false);
  const [followups, setFollowups] = useState<
    Record<string, { turnId: string; prompt: string }>
  >({});
  const [available, setAvailable] = useState(false),
    [active, setActive] = useState(false),
    [consent, setConsent] = useState(false);
  const [index, setIndex] = useState(0),
    [status, setStatus] = useState<
      "idle" | "permission" | "recording" | "uploading"
    >("idle");
  const [seconds, setSeconds] = useState(0),
    [error, setError] = useState("");
  const capture = useRef<Capture | null>(null),
    sequence = useRef(0),
    upload = useRef<AbortController | null>(null);
  const callbacks = useRef({ onBusy });
  callbacks.current = { onBusy };
  const question = questions[index];
  const busy = status !== "idle";
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/interviews/${encodeURIComponent(token)}/voice`, {
      credentials: "omit",
      signal: controller.signal,
    })
      .then(async (response) =>
        response.ok ? response.json() : { available: false },
      )
      .then((data) => {
        if (!controller.signal.aborted) {
          setAvailable(Boolean(data.available));
          setProviderName(
            data.provider || "the hiring team's transcription provider",
          );
          setClarification(Boolean(data.clarification));
        }
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
      sequence.current++;
      upload.current?.abort();
      release(capture.current);
      capture.current = null;
      window.speechSynthesis?.cancel();
      callbacks.current.onBusy(false);
    };
  }, [token]);
  function cancel() {
    sequence.current++;
    upload.current?.abort();
    upload.current = null;
    release(capture.current);
    capture.current = null;
    window.speechSynthesis?.cancel();
    setStatus("idle");
    onBusy(false);
    setSeconds(0);
  }
  function leave() {
    cancel();
    setActive(false);
    setConsent(false);
    onActive(false);
    setError("");
  }
  function speak(prompt = question.prompt) {
    if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) {
      setError(
        "Spoken prompts are unavailable in this browser. Read the question below.",
      );
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(prompt);
    // Prefer a local voice so reading a question does not require a speech service.
    const voices = window.speechSynthesis
      .getVoices()
      .filter((voice) => voice.localService);
    const matching = voices.filter(
      (voice) =>
        !language ||
        voice.lang
          .toLowerCase()
          .startsWith(language.split("-")[0].toLowerCase()),
    );
    const local =
      matching.find((voice) => voice.name === voiceName) || matching[0];
    if (!local) {
      setError(
        "A local spoken voice is not available. You can read the question below.",
      );
      return;
    }
    utterance.voice = local;
    utterance.lang = language || local.lang;
    window.speechSynthesis.speak(utterance);
  }
  async function finish(recordingSequence: number) {
    const recorded = capture.current;
    if (!recorded || sequence.current !== recordingSequence) return;
    capture.current = null;
    release(recorded);
    if (recorded.count / recorded.context.sampleRate < 0.5) {
      setStatus("idle");
      onBusy(false);
      setError("Record at least half a second before transcribing.");
      return;
    }
    setStatus("uploading");
    const controller = new AbortController();
    upload.current = controller;
    try {
      const body = new FormData();
      body.set(
        "audio",
        encodeVoiceWav(
          recorded.samples,
          recorded.count,
          recorded.context.sampleRate,
        ),
        "answer.wav",
      );
      body.set("questionId", question.id);
      body.set("requestId", crypto.randomUUID());
      body.set("consent", "true");
      if (recorded.parentTurnId)
        body.set("parentTurnId", recorded.parentTurnId);
      const response = await fetch(
        `/api/interviews/${encodeURIComponent(token)}/voice/transcriptions`,
        {
          method: "POST",
          credentials: "omit",
          body,
          signal: controller.signal,
        },
      );
      const data = await response.json();
      if (!response.ok)
        throw new Error(
          data.error || "Unable to transcribe. You can type your response.",
        );
      if (sequence.current !== recordingSequence) return;
      onAnswer(
        question.id,
        recorded.parentTurnId && data.answerText && data.followupAnswered
          ? `${answers[question.id] || ""}\n\nFollow-up: ${data.followupAnswered}\n${data.answerText}`
          : data.text,
      );
      setFollowups((current) => {
        const next = { ...current };
        if (data.followup)
          next[question.id] = { turnId: data.turnId, prompt: data.followup };
        else delete next[question.id];
        return next;
      });
      onEvidence(question.id, data.turnId);
    } catch (cause) {
      if (sequence.current === recordingSequence && !controller.signal.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : "Unable to transcribe. You can type your response.",
        );
    } finally {
      if (sequence.current === recordingSequence) {
        upload.current = null;
        setStatus("idle");
        onBusy(false);
      }
    }
  }
  async function record(parentTurnId?: string) {
    if (busy || !consent) return;
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext) {
      setError(
        "Voice recording is unavailable in this browser. You can type your answer.",
      );
      return;
    }
    const current = ++sequence.current;
    setStatus("permission");
    onBusy(true);
    setError("");
    setSeconds(0);
    window.speechSynthesis?.cancel();
    let stream: MediaStream | undefined;
    let context: AudioContext | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
        video: false,
      });
      if (sequence.current !== current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      context = new AudioContext({ sampleRate: 16000 });
      await context.resume();
      if (sequence.current !== current) {
        stream.getTracks().forEach((track) => track.stop());
        await context.close();
        return;
      }
      const source = context.createMediaStreamSource(stream),
        processor = context.createScriptProcessor(4096, 1, 1);
      const recording: Capture = {
        stream,
        context,
        source,
        processor,
        parentTurnId,
        samples: [],
        count: 0,
      };
      capture.current = recording;
      processor.onaudioprocess = (event) => {
        if (sequence.current !== current || capture.current !== recording)
          return;
        const input = event.inputBuffer.getChannelData(0);
        const remaining = Math.max(
          0,
          context!.sampleRate * 120 - recording.count,
        );
        const chunk = new Float32Array(input.subarray(0, remaining));
        recording.samples.push(chunk);
        recording.count += chunk.length;
        if (!remaining) void finish(current);
      };
      source.connect(processor);
      processor.connect(context.destination);
      recording.timer = setTimeout(() => void finish(current), 120_000);
      recording.ticker = setInterval(
        () => setSeconds((value) => Math.min(120, value + 1)),
        1000,
      );
      setStatus("recording");
    } catch {
      stream?.getTracks().forEach((track) => track.stop());
      if (context && context.state !== "closed")
        void context.close().catch(() => undefined);
      if (capture.current?.context === context) {
        release(capture.current);
        capture.current = null;
      }
      if (sequence.current === current) {
        setStatus("idle");
        onBusy(false);
        setError(
          "Microphone access was unavailable. Check your browser permissions or type your answer.",
        );
      }
    }
  }
  if (!available || !question) return null;
  return (
    <section className="voice-screening" aria-label="Guided voice interview">
      <div className="voice-screening-heading">
        <Mic size={20} />
        <h2>Guided voice interview</h2>
        <span>Optional</span>
      </div>
      {!active ? (
        <>
          <p>
            Hear each published question and record an answer, then review the
            transcript. This is a guided interview with AI transcription, not a
            live conversation. You can type instead at any time.
          </p>
          <label className="voice-screening-consent">
            <input
              type="checkbox"
              checked={consent}
              onChange={(event) => setConsent(event.target.checked)}
            />
            <span>
              I agree to send my voice answers to {providerName} for
              transcription. ArkOffer stores the transcript, not the audio. My
              original transcript and any corrections will be shared with the
              hiring team when I submit.{" "}
              {clarification &&
                "The hiring team's AI service may use the question and transcript to suggest one optional follow-up."}
            </span>
          </label>
          <button
            type="button"
            className="business-button"
            disabled={!consent}
            onClick={() => {
              setActive(true);
              onActive(true);
            }}
          >
            Start guided voice interview
          </button>
        </>
      ) : (
        <>
          <div className="voice-screening-progress">
            <span>
              Question {index + 1} of {questions.length}
            </span>
            <button
              type="button"
              className="business-button secondary"
              onClick={leave}
            >
              Use written questionnaire
            </button>
          </div>
          <h3 id="voice-current-question">{question.prompt}</h3>
          <p>
            {question.required ? "Required" : "Optional"} ·{" "}
            {question.type === "text"
              ? "Up to 2 minutes per recording · 3 transcription attempts per question"
              : "Select your answer below"}
          </p>
          <div className="voice-screening-actions">
            <button
              type="button"
              className="business-button secondary"
              onClick={() => speak()}
              disabled={busy}
            >
              <Volume2 size={16} />
              Read question aloud
            </button>
            {question.type === "text" && (
              <>
                {status === "recording" ? (
                  <button
                    type="button"
                    className="business-button"
                    onClick={() => void finish(sequence.current)}
                  >
                    <Square size={16} />
                    Stop and transcribe
                  </button>
                ) : (
                  <button
                    type="button"
                    className="business-button"
                    onClick={() => void record()}
                    disabled={busy}
                  >
                    <Mic size={16} />
                    {answers[question.id] ? "Record again" : "Record answer"}
                  </button>
                )}
                {busy && (
                  <button
                    type="button"
                    className="business-button secondary"
                    onClick={cancel}
                  >
                    Cancel recording
                  </button>
                )}
              </>
            )}
          </div>
          <p role="status" className="voice-screening-status">
            {status === "permission"
              ? "Waiting for microphone permission…"
              : status === "recording"
                ? `Recording · ${seconds}s / 120s`
                : status === "uploading"
                  ? "Transcribing your answer…"
                  : "Microphone off. Review and correct your answer before continuing."}
          </p>
          {error && (
            <p role="alert" className="business-alert">
              {error}
            </p>
          )}
          {question.type === "text" ? (
            <label className="voice-screening-answer">
              Review your answer
              <textarea
                aria-describedby="voice-current-question"
                rows={6}
                maxLength={10_000}
                value={answers[question.id] || ""}
                disabled={busy}
                onChange={(event) => {
                  onAnswer(question.id, event.target.value);
                  if (!event.target.value.trim()) onEvidence(question.id, null);
                }}
              />
            </label>
          ) : (
            <label className="voice-screening-answer">
              Your answer
              <select
                aria-label="Your answer"
                value={answers[question.id] || ""}
                onChange={(event) => onAnswer(question.id, event.target.value)}
              >
                <option value="">Select an answer</option>
                {(question.type === "yes-no"
                  ? ["Yes", "No"]
                  : question.options
                ).map((option) => (
                  <option key={option}>{option}</option>
                ))}
              </select>
            </label>
          )}
          {followups[question.id] && (
            <aside
              className="voice-screening-followup"
              aria-label="Optional AI follow-up"
            >
              <h3>Optional follow-up</h3>
              <p>{followups[question.id].prompt}</p>
              <p>
                An AI-generated clarification. Skip it or add a response; it
                does not assess your suitability.
              </p>
              <div className="voice-screening-actions">
                <button
                  type="button"
                  className="business-button secondary"
                  disabled={busy}
                  onClick={() => speak(followups[question.id].prompt)}
                >
                  Read follow-up aloud
                </button>
                <button
                  type="button"
                  className="business-button"
                  disabled={busy}
                  onClick={() => void record(followups[question.id].turnId)}
                >
                  Record follow-up answer
                </button>
                <button
                  type="button"
                  className="business-button secondary"
                  disabled={busy}
                  onClick={() =>
                    setFollowups((current) => {
                      const next = { ...current };
                      delete next[question.id];
                      return next;
                    })
                  }
                >
                  Skip follow-up
                </button>
              </div>
            </aside>
          )}
          <div className="voice-screening-progress">
            <button
              type="button"
              className="business-button secondary"
              disabled={busy || index === 0}
              onClick={() => {
                window.speechSynthesis?.cancel();
                setIndex(index - 1);
                setError("");
              }}
            >
              <ChevronLeft size={16} />
              Previous question
            </button>
            {index < questions.length - 1 ? (
              <button
                type="button"
                className="business-button"
                disabled={
                  busy || (question.required && !answers[question.id]?.trim())
                }
                onClick={() => {
                  window.speechSynthesis?.cancel();
                  setIndex(index + 1);
                  setError("");
                }}
              >
                Next question
                <ChevronRight size={16} />
              </button>
            ) : (
              <span>Review your details and submit below.</span>
            )}
          </div>
        </>
      )}
    </section>
  );
}
