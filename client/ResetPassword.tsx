import { useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { Layers, ShieldCheck } from "lucide-react";
import { api, json, Button, ErrorBanner, Field, useAuth } from "./ui";

export default function ResetPassword() {
  const [params] = useSearchParams(),
    location = useLocation(),
    { user, reload } = useAuth();
  const token = params.get("token") || "",
    verification = location.pathname === "/verify-email";
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [complete, setComplete] = useState(false);
  return (
    <main className="auth-page">
      <Link to="/" className="wordmark">
        <Layers /> ArkOffer
      </Link>
      <section className="auth-card">
        <ShieldCheck size={34} />
        <p className="eyebrow">ACCOUNT SECURITY</p>
        <h1>
          {verification
            ? "Verify your email"
            : token
              ? "Choose a new password"
              : "Reset your password"}
        </h1>
        {complete ? (
          <>
            <p role="status">{message}</p>
            <Link
              className="btn primary"
              to={verification ? "/app/settings?tab=security" : "/login"}
            >
              {verification ? "Return to account security" : "Sign in"}
            </Link>
          </>
        ) : verification ? (
          <>
            <p>
              Confirm that you can receive email at the address linked to your
              ArkOffer account.
            </p>
            {user ? (
              <>
                <p>
                  Signed in as <strong>{user.email}</strong>.
                </p>
                <Button
                  variant="primary"
                  busy={busy}
                  onClick={async () => {
                    setBusy(true);
                    setError("");
                    try {
                      const result = await api(
                        "account/verify-email",
                        json("POST", { token }),
                      );
                      setMessage(result.message);
                      setComplete(true);
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Verify email address
                </Button>
              </>
            ) : (
              <Link
                className="btn primary"
                to={`/login?returnTo=${encodeURIComponent(`/verify-email?token=${token}`)}`}
              >
                Sign in to verify
              </Link>
            )}
          </>
        ) : (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              setError("");
              setMessage("");
              if (token && form.get("password") !== form.get("confirm")) {
                setError("The new passwords do not match.");
                return;
              }
              setBusy(true);
              try {
                const result = await api(
                  `auth/${token ? "reset-password" : "forgot-password"}`,
                  json(
                    "POST",
                    token
                      ? { token, password: form.get("password") }
                      : { email: form.get("email") },
                  ),
                );
                setMessage(result.message);
                if (token) {
                  await reload();
                  setComplete(true);
                }
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {token ? (
              <>
                <p>Your new password signs out all existing sessions.</p>
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
              </>
            ) : (
              <>
                <p>
                  Enter your account email to request a password reset link.
                </p>
                <Field label="Account email">
                  <input
                    name="email"
                    type="email"
                    autoComplete="email"
                    required
                    maxLength={254}
                  />
                </Field>
              </>
            )}
            <Button variant="primary" type="submit" busy={busy}>
              {token ? "Reset password" : "Request reset link"}
            </Button>
            {message && <p role="status">{message}</p>}
          </form>
        )}
        <ErrorBanner error={error} />
        {!complete && (
          <p>
            <Link to={user ? "/app/settings?tab=security" : "/login"}>
              Back to {user ? "account security" : "sign in"}
            </Link>
          </p>
        )}
      </section>
    </main>
  );
}
