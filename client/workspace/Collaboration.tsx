import { useEffect, useState } from "react";
import {
  api,
  json,
  Button,
  Field,
  ErrorBanner,
  Loading,
  useAuth,
  type Item,
} from "../ui";
import "./collaboration.css";

export function AccessPanel({
  kind,
  id,
  onChanged,
}: {
  kind: "conversations" | "collections";
  id: string;
  onChanged?: () => void;
}) {
  const [access, setAccess] = useState<any>(null),
    [members, setMembers] = useState<Item[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const path = `${kind}/${id}/access`;
  const load = async () => {
    const [a, m] = await Promise.all([api(path), api("team/members")]);
    setAccess(a);
    setMembers(m.items || m.members || []);
  };
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [path]);
  async function change(path: string, method: string, data?: unknown) {
    setBusy(true);
    setError("");
    try {
      await api(path, data === undefined ? { method } : json(method, data));
      await load();
      onChanged?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!access) return error ? <ErrorBanner error={error} /> : <Loading />;
  return (
    <section className="collaboration-panel">
      <h2>Team access</h2>
      <ErrorBanner error={error} />
      <p className="muted">
        Owners and workspace admins can manage access. Named teammates must be
        active members. Sharing a collection also shares the conversations
        inside it.
      </p>
      {!access.canManage ? (
        <p>
          Your access: {access.permission}. Ask the owner or a workspace admin
          to change sharing.
        </p>
      ) : (
        <fieldset disabled={busy}>
          <Field label="General access">
            <select
              value={access.visibility}
              onChange={(e) =>
                void change(path, "PATCH", { visibility: e.target.value })
              }
            >
              <option value="private">Owner, admins and named teammates</option>
              <option value="workspace">
                Everyone in this workspace can view
              </option>
            </select>
          </Field>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              void change(`${path}/${data.get("member")}`, "PUT", {
                permission: data.get("permission"),
              });
            }}
          >
            <Field label="Teammate">
              <select name="member" required defaultValue="">
                <option value="" disabled>
                  Select a teammate
                </option>
                {members
                  .filter(
                    (m) =>
                      (m.userId || m.id) !== access.ownerId &&
                      m.status !== "suspended",
                  )
                  .map((m) => (
                    <option key={m.userId || m.id} value={m.userId || m.id}>
                      {m.name} · {m.email}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Permission">
              <select name="permission">
                <option value="viewer">Can view</option>
                <option value="editor">Can edit</option>
              </select>
            </Field>
            <Button type="submit">Share with teammate</Button>
          </form>
          <div className="collaboration-list">
            {access.grants.map((grant: any) => (
              <div key={grant.userId}>
                <span>
                  <strong>{grant.name}</strong>
                  <small>
                    {grant.email} · {grant.permission}
                  </small>
                </span>
                <Button
                  onClick={() =>
                    void change(`${path}/${grant.userId}`, "DELETE")
                  }
                >
                  Remove access
                </Button>
              </div>
            ))}
          </div>
        </fieldset>
      )}
    </section>
  );
}
export function ConversationComments({ id }: { id: string }) {
  const { user } = useAuth();
  const [items, setItems] = useState<Item[]>([]),
    [body, setBody] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const load = async () =>
    setItems((await api(`conversations/${id}/comments`)).items);
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [id]);
  return (
    <section className="collaboration-panel">
      <h2>Discussion</h2>
      <p className="muted">
        Comments are visible to people who can access this conversation.
      </p>
      <ErrorBanner error={error} />
      <div className="comment-list">
        {items.length ? (
          items.map((item) => (
            <article key={item.id}>
              <header>
                <strong>{item.name}</strong>
                <time>{new Date(item.createdAt || "").toLocaleString()}</time>
              </header>
              <p>{item.body}</p>
              {(item.userId === user?.id ||
                ["owner", "admin"].includes(user?.role || "")) && (
                <button
                  className="text-btn"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await api(`conversations/${id}/comments/${item.id}`, {
                        method: "DELETE",
                      });
                      await load();
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Delete comment
                </button>
              )}
            </article>
          ))
        ) : (
          <p>No comments yet. Start the conversation.</p>
        )}
      </div>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await api(`conversations/${id}/comments`, json("POST", { body }));
            setBody("");
            await load();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Your comment">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            required
            maxLength={10000}
            rows={4}
          />
        </Field>
        <Button type="submit" variant="primary" busy={busy}>
          Post comment
        </Button>
      </form>
    </section>
  );
}
