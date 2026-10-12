import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { Layers, LockKeyhole } from "lucide-react";
import { api, Loading, ErrorBanner, type Item, niceDate } from "../ui";
export default function Shared() {
  const { token } = useParams();
  const [item, setItem] = useState<Item | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    setItem(null);
    setError("");
    api(`shared/${token}`)
      .then((r) => {
        if (!cancelled) setItem(r.item);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);
  return (
    <div className="shared-page">
      <header>
        <Link className="wordmark" to="/">
          <Layers />
          ArkOffer
        </Link>
        <span>
          <LockKeyhole size={14} />
          Read-only conversation
        </span>
      </header>
      {error ? (
        <ErrorBanner error={error} />
      ) : !item ? (
        <Loading />
      ) : (
        <article>
          <p className="muted">{niceDate(item.date || item.createdAt || "")}</p>
          <h1>{item.title}</h1>
          {item.candidate && <p className="muted">{item.candidate}</p>}
          {item.tldr && (
            <section>
              <h2>TLDR</h2>
              <p>{item.tldr}</p>
            </section>
          )}
          {(item.sections || []).map((s: any, i: number) => (
            <section key={s.id || i}>
              <h2>{s.title}</h2>
              <p>{s.content}</p>
            </section>
          ))}
          {!item.sections?.length && (
            <p>No notes have been added to this conversation.</p>
          )}
          {item.transcript && (
            <details>
              <summary>Read transcript</summary>
              <p style={{ whiteSpace: "pre-wrap" }}>{item.transcript}</p>
            </details>
          )}
        </article>
      )}
    </div>
  );
}
