import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { ArrowRight, Check, FileText, Layers, LockKeyhole } from "lucide-react";
import "./business.css";
import VoiceScreening from "./VoiceScreening";

type Question = {
  id: string;
  prompt: string;
  type: "text" | "yes-no" | "multiple-choice";
  options: string[];
  required: boolean;
};
type Interview = {
  title: string;
  description: string;
  workspaceName: string;
  expiresAt: string;
  questions: Question[];
};

export default function ScreeningInterview() {
  const { token } = useParams<{ token: string }>();
  const [interview, setInterview] = useState<Interview | null>(null);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false),
    [justSubmitted, setJustSubmitted] = useState(false),
    [busy, setBusy] = useState(false);
  const [voiceActive, setVoiceActive] = useState(false),
    [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceEvidence, setVoiceEvidence] = useState<Record<string, string>>(
    {},
  );
  const [answers, setAnswers] = useState<Record<string, string>>({});
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setInterview(null);
    setSubmitted(false);
    setJustSubmitted(false);
    setAnswers({});
    setVoiceEvidence({});
    setVoiceActive(false);
    setVoiceBusy(false);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) {
      setError("This screening link is unavailable or has expired.");
      setLoading(false);
      return;
    }
    fetch(`/api/interviews/${encodeURIComponent(token)}`, {
      credentials: "omit",
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok)
          throw new Error(data.error || "Unable to load this questionnaire.");
        return data;
      })
      .then((data) => {
        if (!controller.signal.aborted) {
          setInterview(data.item);
          setSubmitted(data.submitted);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error
              ? cause.message
              : "Unable to load this questionnaire.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [token]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!interview || busy || voiceBusy) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        `/api/interviews/${encodeURIComponent(token!)}/responses`,
        {
          method: "POST",
          credentials: "omit",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            candidateName: form.get("candidateName"),
            email: form.get("email"),
            consent: form.get("consent") === "on",
            voiceEvidence: Object.entries(voiceEvidence).map(
              ([questionId, turnId]) => ({ questionId, turnId }),
            ),
            answers: interview.questions.map((question) => ({
              questionId: question.id,
              value: answers[question.id] || "",
            })),
          }),
        },
      );
      const data = await response.json();
      if (!response.ok)
        throw new Error(
          data.error || "We could not save your responses. Please try again.",
        );
      setSubmitted(true);
      setJustSubmitted(true);
      setAnswers({});
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to submit. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  const requiredCount =
    interview?.questions.filter((question) => question.required).length || 0;
  const completedCount =
    interview?.questions.filter(
      (question) => question.required && answers[question.id]?.trim(),
    ).length || 0;
  return (
    <main className="screening-interview">
      <header className="screening-interview-header">
        <span>
          <Layers size={24} />
          ArkOffer
        </span>
        <span>
          <LockKeyhole size={13} />
          Candidate questionnaire
        </span>
      </header>
      <div className="screening-interview-content">
        {loading ? (
          <div className="screening-interview-state" role="status">
            Loading your questionnaire…
          </div>
        ) : !interview ? (
          <div className="screening-interview-state">
            <FileText size={32} />
            <h1>This link is unavailable</h1>
            <p>
              {error || "This screening link is unavailable or has expired."}
            </p>
            <p>Contact the hiring team to request a new link.</p>
          </div>
        ) : submitted ? (
          <div className="screening-interview-state">
            <span className="screening-interview-success">
              <Check size={30} />
            </span>
            <h1>
              {justSubmitted
                ? "Thank you for sharing your experience."
                : "This questionnaire is complete."}
            </h1>
            <p>
              {justSubmitted
                ? `Your responses have been submitted to ${interview.workspaceName}.`
                : "This link has already received a response."}
            </p>
            <p>
              For updates or corrections, contact the hiring team. You can close
              this page.
            </p>
          </div>
        ) : (
          <>
            <div className="screening-interview-intro">
              <span className="business-eyebrow">
                {interview.workspaceName}
              </span>
              <h1>{interview.title}</h1>
              {interview.description && <p>{interview.description}</p>}
              <div>
                <span>{interview.questions.length} questions</span>
                <span>
                  Available until{" "}
                  {new Date(interview.expiresAt).toLocaleDateString(undefined, {
                    month: "long",
                    day: "numeric",
                    year: "numeric",
                  })}
                </span>
              </div>
            </div>
            <form onSubmit={(event) => void submit(event)}>
              <fieldset disabled={busy}>
                <section className="screening-interview-section">
                  <h2>A little about you</h2>
                  <div className="screening-interview-identity">
                    <label htmlFor="screening-name">
                      Full name
                      <input
                        id="screening-name"
                        name="candidateName"
                        required
                        maxLength={120}
                        autoComplete="name"
                      />
                    </label>
                    <label htmlFor="screening-email">
                      Email address
                      <input
                        id="screening-email"
                        name="email"
                        type="email"
                        required
                        maxLength={254}
                        autoComplete="email"
                      />
                    </label>
                  </div>
                </section>
                <VoiceScreening
                  key={token}
                  token={token!}
                  questions={interview.questions}
                  answers={answers}
                  onAnswer={(id, value) =>
                    setAnswers((current) => ({ ...current, [id]: value }))
                  }
                  onEvidence={(id, turnId) =>
                    setVoiceEvidence((current) => {
                      const next = { ...current };
                      if (turnId) next[id] = turnId;
                      else delete next[id];
                      return next;
                    })
                  }
                  onActive={setVoiceActive}
                  onBusy={setVoiceBusy}
                />
                <section
                  className="screening-interview-section"
                  hidden={voiceActive}
                >
                  <div className="screening-interview-questions-heading">
                    <h2>Your experience</h2>
                    <span>
                      {completedCount} of {requiredCount} required answers
                    </span>
                  </div>
                  {interview.questions.map((question, index) => (
                    <div
                      className="screening-interview-question"
                      key={question.id}
                    >
                      <label htmlFor={`answer-${question.id}`}>
                        <span>{String(index + 1).padStart(2, "0")}</span>
                        {question.prompt}
                        {question.required ? (
                          <small>Required</small>
                        ) : (
                          <small>Optional</small>
                        )}
                      </label>
                      {question.type === "text" ? (
                        <textarea
                          id={`answer-${question.id}`}
                          rows={5}
                          maxLength={10_000}
                          required={question.required && !voiceActive}
                          value={answers[question.id] || ""}
                          onChange={(event) =>
                            setAnswers((current) => ({
                              ...current,
                              [question.id]: event.target.value,
                            }))
                          }
                          placeholder="Share your response…"
                        />
                      ) : (
                        <select
                          id={`answer-${question.id}`}
                          required={question.required && !voiceActive}
                          value={answers[question.id] || ""}
                          onChange={(event) =>
                            setAnswers((current) => ({
                              ...current,
                              [question.id]: event.target.value,
                            }))
                          }
                        >
                          <option value="">Select an answer</option>
                          {(question.type === "yes-no"
                            ? ["Yes", "No"]
                            : question.options
                          ).map((option) => (
                            <option key={option} value={option}>
                              {option}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  ))}
                </section>
                <section className="screening-interview-consent">
                  <label>
                    <input name="consent" type="checkbox" required />
                    <span>
                      I agree to share my name, email address and responses with{" "}
                      {interview.workspaceName} for their recruitment process.
                    </span>
                  </label>
                  <p>
                    One response is accepted per link. Contact the hiring team
                    if you need to make changes after submitting.
                  </p>
                  {error && (
                    <div className="business-alert" role="alert">
                      {error}
                    </div>
                  )}
                  <button
                    className="business-button"
                    type="submit"
                    disabled={
                      busy || voiceBusy || completedCount < requiredCount
                    }
                  >
                    {busy ? "Submitting…" : "Submit responses"}
                    <ArrowRight size={16} />
                  </button>
                </section>
              </fieldset>
            </form>
          </>
        )}
      </div>
      <footer className="screening-interview-footer">
        Your responses are shared with the hiring team. Hiring decisions are
        made by people.
      </footer>
    </main>
  );
}
