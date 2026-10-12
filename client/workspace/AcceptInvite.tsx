import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Layers, UsersRound } from "lucide-react";
import { api, json, Button, ErrorBanner, Loading, useAuth } from "../ui";

export default function AcceptInvite() {
  const { token } = useParams(),
    { user, reload } = useAuth(),
    navigate = useNavigate();
  const [invitation, setInvitation] = useState<{
      workspaceName: string;
      role: string;
      emailHint: string;
      expiresAt: number;
    } | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    api(`invitations/${token}`)
      .then((r) => live && setInvitation(r.invitation))
      .catch((e) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [token]);
  const returnTo = encodeURIComponent(`/invitations/${token}`);
  return (
    <main className="auth-page">
      <Link to="/" className="wordmark">
        <Layers /> ArkOffer
      </Link>
      <section className="auth-card">
        <UsersRound size={34} />
        {loading ? (
          <Loading />
        ) : invitation ? (
          <>
            <p className="eyebrow">YOU'RE INVITED</p>
            <h1>Join {invitation.workspaceName}</h1>
            <p>
              You've been invited as a workspace{" "}
              <strong>{invitation.role}</strong>. Sign in with the email address
              matching <strong>{invitation.emailHint}</strong>.
            </p>
            <p className="muted">
              This invitation expires{" "}
              {new Date(invitation.expiresAt).toLocaleString()}.
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
                      await api(
                        `invitations/${token}/accept`,
                        json("POST", {}),
                      );
                      await reload();
                      navigate("/notes", { replace: true });
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Accept invitation
                </Button>
                <p>
                  <Link to={`/login?returnTo=${returnTo}`}>
                    Sign in with another account
                  </Link>
                </p>
              </>
            ) : (
              <>
                <Link
                  className="btn primary"
                  to={`/login?returnTo=${returnTo}`}
                >
                  Sign in to accept
                </Link>
                <p>
                  New to ArkOffer?{" "}
                  <Link to={`/signup?returnTo=${returnTo}`}>
                    Create an account
                  </Link>
                </p>
              </>
            )}
          </>
        ) : (
          <h1>Invitation unavailable</h1>
        )}
        <ErrorBanner error={error} />
        <p>
          <Link to={user ? "/notes" : "/"}>Back to ArkOffer</Link>
        </p>
      </section>
    </main>
  );
}
