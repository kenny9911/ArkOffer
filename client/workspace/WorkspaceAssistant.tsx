import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { MessageSquare, Plus, Send, Trash2, FileText } from "lucide-react";
import {
  api,
  json,
  Button,
  ErrorBanner,
  Field,
  Loading,
  type Item,
} from "../ui";
import "./assistant.css";
type Answer = {
  id: string;
  question: string;
  answer: string;
  mode: string;
  citations: Array<{ conversationId: string; title: string; text: string }>;
};
export default function WorkspaceAssistant() {
  const [threads, setThreads] = useState<Item[]>([]),
    [notes, setNotes] = useState<Item[]>([]),
    [selected, setSelected] = useState(""),
    [scope, setScope] = useState(""),
    [messages, setMessages] = useState<Answer[]>([]),
    [question, setQuestion] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const request = useRef(0),
    bottom = useRef<HTMLDivElement>(null);
  async function refresh() {
    const r = await api("assistant/threads");
    setThreads(r.items);
  }
  useEffect(() => {
    Promise.all([api("assistant/threads"), api("conversations")])
      .then(([r, n]) => {
        setThreads(r.items);
        setNotes(n.items.filter((note: Item) => !note.archived));
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest" });
  }, [messages]);
  async function open(id: string) {
    if (busy) return;
    const sequence = ++request.current;
    setError("");
    setSelected(id);
    setMessages([]);
    if (!id) return;
    setLoading(true);
    try {
      const r = await api(`assistant/threads/${id}`);
      if (sequence === request.current) setMessages(r.messages);
    } catch (e) {
      if (sequence === request.current) setError((e as Error).message);
    } finally {
      if (sequence === request.current) setLoading(false);
    }
  }
  async function ask(e: React.FormEvent) {
    e.preventDefault();
    if (busy || loading || !question.trim()) return;
    setBusy(true);
    setError("");
    try {
      const r = await api(
        "assistant/ask",
        json("POST", {
          question,
          ...(selected ? { threadId: selected } : {}),
          ...(scope ? { conversationIds: [scope] } : {}),
        }),
      );
      setSelected(r.threadId);
      setMessages((previous) => [...previous, r.message]);
      setQuestion("");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="assistant-workspace">
      <aside className="assistant-history">
        <div className="assistant-history-heading">
          <h2>Conversations</h2>
          <Button disabled={busy || loading} onClick={() => void open("")}>
            <Plus size={16} />
            New
          </Button>
        </div>
        {threads.length === 0 && (
          <p className="muted">
            Your questions and answers will be saved here.
          </p>
        )}
        {threads.map((t) => (
          <div
            className={`assistant-thread ${selected === t.id ? "selected" : ""}`}
            key={t.id}
          >
            <button disabled={busy} onClick={() => void open(t.id)}>
              <MessageSquare size={15} />
              <span>{t.title}</span>
            </button>
            <button
              className="icon-btn"
              disabled={busy}
              aria-label={`Delete ${t.title}`}
              onClick={async () => {
                if (!confirm("Delete this assistant conversation?")) return;
                setBusy(true);
                try {
                  await api(`assistant/threads/${t.id}`, json("DELETE", {}));
                  if (selected === t.id) {
                    setSelected("");
                    setMessages([]);
                  }
                  await refresh();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Trash2 size={15} />
            </button>
          </div>
        ))}
      </aside>
      <main className="assistant-main">
        <header>
          <p className="eyebrow">ARKOFFER ASSISTANT</p>
          <h1>Ask your conversations.</h1>
          <p className="muted">
            Find evidence across interviews you can access. Answers are saved
            with their sources.
          </p>
        </header>
        <ErrorBanner error={error} />
        {loading ? (
          <Loading />
        ) : (
          <div className="assistant-messages" aria-live="polite">
            {!messages.length && (
              <section className="assistant-welcome">
                <FileText size={28} />
                <h2>Start with a specific question</h2>
                <p>
                  Try “What experience did candidates describe with TypeScript?”
                  or search for a topic across your transcripts.
                </p>
                <p className="muted">
                  Local mode returns matching excerpts. AI synthesis requires a
                  configured provider. Each question searches the selected
                  sources independently.
                </p>
              </section>
            )}
            {messages.map((message) => (
              <article className="assistant-answer" key={message.id}>
                <h2>{message.question}</h2>
                <span className="badge">
                  {["openai", "openrouter"].includes(message.mode)
                    ? "AI answer"
                    : message.mode === "unavailable"
                      ? "Source unavailable"
                      : "Transcript excerpts"}
                </span>
                <p className="assistant-answer-text">{message.answer}</p>
                {!!message.citations.length && (
                  <details>
                    <summary>Sources · {message.citations.length}</summary>
                    {message.citations.map((source, i) => (
                      <blockquote key={`${source.conversationId}-${i}`}>
                        <Link to={`/notes/${source.conversationId}`}>
                          [{i + 1}] {source.title}
                        </Link>
                        <p>{source.text}</p>
                      </blockquote>
                    ))}
                  </details>
                )}
              </article>
            ))}
            <div ref={bottom} />
          </div>
        )}
        <form className="assistant-compose" onSubmit={ask}>
          <Field label="Source conversations">
            <select
              value={scope}
              disabled={busy}
              onChange={(e) => setScope(e.target.value)}
            >
              <option value="">All accessible conversations</option>
              {notes.map((note) => (
                <option value={note.id} key={note.id}>
                  {note.title}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Your question">
            <textarea
              placeholder="Ask about your interviews…"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              maxLength={2000}
              rows={3}
              disabled={busy}
              required
            />
          </Field>
          <div>
            <small className="muted">
              Check sources before using an answer. Access is checked when you
              reopen saved answers.
            </small>
            <Button
              variant="primary"
              type="submit"
              busy={busy}
              disabled={loading || !question.trim()}
            >
              <Send size={16} />
              Ask
            </Button>
          </div>
        </form>
      </main>
    </div>
  );
}
