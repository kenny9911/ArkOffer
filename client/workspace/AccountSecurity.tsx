import { useEffect, useState } from "react";
import { Check, Monitor, ShieldCheck } from "lucide-react";
import {
  api,
  json,
  Button,
  ErrorBanner,
  Field,
  Loading,
  useAuth,
  useToast,
} from "../ui";
import "./team.css";

type Security = {
  email: string;
  emailVerifiedAt: string | null;
  mailAvailable: boolean;
  sessions: {
    id: string;
    userAgent: string;
    createdAt: string;
    lastSeenAt: number;
    expiresAt: number;
    current: boolean;
    workspaceName: string;
  }[];
};
export default function AccountSecurity() {
  const { reload } = useAuth(),
    toast = useToast();
  const [data, setData] = useState<Security | null>(null),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const refresh = async () => setData(await api("account/security"));
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
  }, []);
  async function action(run: () => Promise<void>) {
    setError("");
    setMessage("");
    setBusy(true);
    try {
      await run();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!data)
    return (
      <>
        <ErrorBanner error={error} />
        {!error && <Loading />}
      </>
    );
  return (
    <>
      <div className="team-heading">
        <div>
          <h1>Account security</h1>
          <p className="muted">
            Manage your password, email verification, and signed-in sessions.
          </p>
        </div>
        <ShieldCheck size={28} />
      </div>
      <ErrorBanner error={error} />
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
      <section className="settings-section">
        <h2>Email verification</h2>
        <p>{data.email}</p>
        {data.emailVerifiedAt ? (
          <p className="integration-status">
            <Check size={16} /> Verified on{" "}
            {new Date(data.emailVerifiedAt).toLocaleDateString()}
          </p>
        ) : (
          <>
            <p className="muted">
              This address has not yet been verified. Verification confirms that
              you can receive email at this address.
            </p>
            <Button
              disabled={!data.mailAvailable}
              busy={busy}
              onClick={() =>
                void action(async () => {
                  const result = await api(
                    "account/verification",
                    json("POST", {}),
                  );
                  setMessage(result.message);
                })
              }
            >
              Send verification email
            </Button>
            {!data.mailAvailable && (
              <p className="muted">
                Verification email requires a configured mail provider and an
                allowed workspace. Contact your server administrator.
              </p>
            )}
          </>
        )}
      </section>
      <section className="settings-section">
        <h2>Change password</h2>
        <p className="muted">
          Changing your password signs out other sessions. This session stays
          signed in with a new cookie.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const element = e.currentTarget,
              form = new FormData(element);
            if (form.get("password") !== form.get("confirm")) {
              setError("The new passwords do not match.");
              return;
            }
            void action(async () => {
              await api(
                "account/password",
                json("POST", {
                  currentPassword: form.get("currentPassword"),
                  password: form.get("password"),
                }),
              );
              element.reset();
              await reload();
              toast("Password updated. Other sessions have been signed out.");
            });
          }}
        >
          <Field label="Current password">
            <input
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              required
              maxLength={128}
            />
          </Field>
          <Field label="New password" hint="Use at least 8 characters.">
            <input
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              maxLength={128}
            />
          </Field>
          <Field label="Confirm new password">
            <input
              name="confirm"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              maxLength={128}
            />
          </Field>
          <Button type="submit" variant="primary" busy={busy}>
            Update password
          </Button>
        </form>
      </section>
      <section className="settings-section">
        <div className="team-heading">
          <h2>Signed-in sessions</h2>
          <Button
            disabled={data.sessions.filter((s) => !s.current).length === 0}
            busy={busy}
            onClick={() =>
              void action(async () => {
                await api("account/sessions/others", { method: "DELETE" });
                toast("Other sessions signed out");
              })
            }
          >
            Sign out other sessions
          </Button>
        </div>
        <p className="muted">
          Sessions expire after seven days. Browser details describe the device
          that signed in; they are not a verified device identity.
        </p>
        {data.sessions.map((session) => (
          <article className="team-member" key={session.id}>
            <Monitor size={20} />
            <div className="team-person">
              <strong>
                {session.current ? "Current session" : "Other session"}
              </strong>
              <span>{session.userAgent || "Browser details unavailable"}</span>
              <small>
                {session.workspaceName} · Signed in{" "}
                {new Date(session.createdAt).toLocaleString()}
              </small>
              <small>
                Last active{" "}
                {session.lastSeenAt
                  ? new Date(session.lastSeenAt).toLocaleString()
                  : "Unknown"}
              </small>
            </div>
            <Button
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  await api(`account/sessions/${session.id}`, {
                    method: "DELETE",
                  });
                  if (session.current) window.location.assign("/login");
                  else toast("Session signed out");
                })
              }
            >
              Sign out{session.current ? " here" : ""}
            </Button>
          </article>
        ))}
      </section>
    </>
  );
}
