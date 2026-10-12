import { useEffect, useState } from "react";
import { Copy, Plus, UserPlus, UsersRound } from "lucide-react";
import {
  api,
  json,
  Button,
  ErrorBanner,
  Field,
  Loading,
  Modal,
  useAuth,
  useToast,
} from "../ui";
import "./team.css";

type Member = {
  id: string;
  name: string;
  email: string;
  role: string;
  status: string;
};
type Invitation = {
  id: string;
  email: string;
  name: string;
  role: string;
  expiresAt: number;
  url?: string;
};
type Workspace = { id: string; name: string; role: string };

export default function TeamSettings() {
  const { user, reload } = useAuth(),
    toast = useToast();
  const [members, setMembers] = useState<Member[]>([]),
    [invitations, setInvitations] = useState<Invitation[]>([]),
    [workspaces, setWorkspaces] = useState<Workspace[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [modal, setModal] = useState<"invite" | "workspace" | null>(null),
    [newInvite, setNewInvite] = useState<Invitation | null>(null),
    [confirmation, setConfirmation] = useState<{
      title: string;
      message: string;
      action: () => Promise<void>;
    } | null>(null);
  const admin = user?.role === "owner" || user?.role === "admin";
  async function refresh() {
    const [m, w] = await Promise.all([api("team/members"), api("workspaces")]);
    const i = m.canManage ? await api("team/invitations") : { items: [] };
    setMembers(m.items);
    setWorkspaces(w.items);
    setInvitations(i.items);
  }
  useEffect(() => {
    let live = true;
    refresh()
      .catch((e) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [user?.workspaceId, user?.role]);
  async function action(run: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await run();
      await reload();
      await refresh();
      setConfirmation(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(
        new URL(url, window.location.origin).href,
      );
      toast("Invitation link copied");
    } catch {
      toast("Copy the invitation link from the field below.");
    }
  }
  if (loading) return <Loading />;
  return (
    <>
      <div className="team-heading">
        <div>
          <h1>Team & workspaces</h1>
          <p className="muted">Manage who can access {user?.workspaceName}.</p>
        </div>
        <UsersRound size={27} />
      </div>
      <ErrorBanner error={error} />
      <section className="settings-section">
        <h2>Your workspaces</h2>
        <div className="team-switcher">
          <Field label="Active workspace">
            <select
              value={user?.workspaceId || ""}
              disabled={busy}
              onChange={(e) => {
                const id = e.target.value;
                void action(async () => {
                  await api(`workspaces/${id}/switch`, json("POST", {}));
                  window.location.assign("/notes");
                });
              }}
            >
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name} · {w.role}
                </option>
              ))}
            </select>
          </Field>
          <Button
            onClick={() => {
              setError("");
              setModal("workspace");
            }}
          >
            <Plus size={15} /> New workspace
          </Button>
        </div>
        <p className="muted">
          Switching changes the workspace for this browser session. Other
          signed-in browsers keep their selection.
        </p>
      </section>
      <section className="settings-section">
        <div className="team-heading">
          <h2>Members ({members.length})</h2>
          {admin && (
            <Button
              variant="primary"
              onClick={() => {
                setError("");
                setNewInvite(null);
                setModal("invite");
              }}
            >
              <UserPlus size={16} /> Invite member
            </Button>
          )}
        </div>
        <p className="muted">
          Owners manage all roles. Administrators manage members and workspace
          settings. Members work with conversations they own or that are shared
          with them.
        </p>
        <div className="team-members">
          {members.map((member) => {
            const editable =
              user?.role === "owner" ||
              (user?.role === "admin" && member.role === "member");
            return (
              <article className="team-member" key={member.id}>
                <div className="team-person">
                  <strong>
                    {member.name}
                    {member.id === user?.id ? " (you)" : ""}
                  </strong>
                  <span>{member.email}</span>
                  {member.status === "suspended" && (
                    <span className="badge">Suspended</span>
                  )}
                </div>
                {editable ? (
                  <select
                    aria-label={`Role for ${member.email}`}
                    value={member.role}
                    disabled={busy}
                    onChange={(e) => {
                      const role = e.target.value;
                      setConfirmation({
                        title: "Change member role",
                        message: `Change ${member.name}'s role to ${role}? This changes their workspace permissions immediately.`,
                        action: async () => {
                          await api(
                            `team/members/${member.id}`,
                            json("PATCH", { role }),
                          );
                          toast("Member role updated");
                        },
                      });
                    }}
                  >
                    {(user?.role === "owner"
                      ? ["member", "admin", "owner"]
                      : ["member"]
                    ).map((role) => (
                      <option key={role}>{role}</option>
                    ))}
                  </select>
                ) : (
                  <span className="badge">{member.role}</span>
                )}
                {editable && (
                  <div className="team-actions">
                    <Button
                      disabled={busy}
                      onClick={() =>
                        setConfirmation({
                          title:
                            member.status === "active"
                              ? "Suspend member"
                              : "Restore member",
                          message:
                            member.status === "active"
                              ? `Suspend ${member.name}'s access? Their sessions in this workspace will be signed out. Their work remains available to the team.`
                              : `Restore ${member.name}'s access to this workspace?`,
                          action: async () => {
                            await api(
                              `team/members/${member.id}`,
                              json("PATCH", {
                                status:
                                  member.status === "active"
                                    ? "suspended"
                                    : "active",
                              }),
                            );
                            toast("Member access updated");
                          },
                        })
                      }
                    >
                      {member.status === "active" ? "Suspend" : "Restore"}
                    </Button>
                    <Button
                      disabled={busy}
                      onClick={() =>
                        setConfirmation({
                          title: "Remove member",
                          message: `Remove ${member.name} from this workspace? Their workspace sessions will be signed out. Their records remain in the workspace.`,
                          action: async () => {
                            await api(`team/members/${member.id}`, {
                              method: "DELETE",
                            });
                            toast("Member removed");
                          },
                        })
                      }
                    >
                      Remove
                    </Button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </section>
      {admin && (
        <section className="settings-section">
          <h2>Pending invitations</h2>
          <p className="muted">
            Links expire after seven days and can only be accepted by a
            signed-in account with the invited email. ArkOffer does not send
            invitation emails; copy the link and share it with the recipient.
          </p>
          {newInvite?.url && (
            <div className="team-invite-result" role="status">
              <strong>Invitation ready for {newInvite.email}</strong>
              <Field label="Invitation link">
                <input
                  readOnly
                  value={new URL(newInvite.url, window.location.origin).href}
                  onFocus={(e) => e.target.select()}
                />
              </Field>
              <Button onClick={() => void copy(newInvite.url!)}>
                <Copy size={15} /> Copy invitation link
              </Button>
              <small>
                Save this link now. Only its hash is stored, so the link cannot
                be retrieved later.
              </small>
            </div>
          )}
          {!invitations.length ? (
            <p className="muted">No pending invitations.</p>
          ) : (
            invitations.map((invite) => (
              <article className="team-member" key={invite.id}>
                <div className="team-person">
                  <strong>{invite.name || invite.email}</strong>
                  <span>
                    {invite.email} · {invite.role}
                  </span>
                  <small>
                    Expires {new Date(invite.expiresAt).toLocaleDateString()}
                  </small>
                </div>
                {(user?.role === "owner" || invite.role === "member") && (
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        await api(`team/invitations/${invite.id}`, {
                          method: "DELETE",
                        });
                        if (newInvite?.id === invite.id) setNewInvite(null);
                        toast("Invitation revoked");
                      })
                    }
                  >
                    Revoke
                  </Button>
                )}
              </article>
            ))
          )}
        </section>
      )}
      {modal && (
        <Modal
          title={
            modal === "invite" ? "Invite a teammate" : "Create a workspace"
          }
          onClose={() => !busy && setModal(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              void action(async () => {
                if (modal === "workspace") {
                  await api(
                    "workspaces",
                    json("POST", { name: form.get("name") }),
                  );
                  window.location.assign("/notes");
                } else {
                  const result = await api(
                    "team/invitations",
                    json("POST", {
                      name: form.get("name"),
                      email: form.get("email"),
                      role: form.get("role"),
                    }),
                  );
                  setNewInvite(result.item);
                  toast("Invitation created. Copy the link to share it.");
                  setModal(null);
                }
              });
            }}
          >
            <Field
              label={modal === "invite" ? "Name (optional)" : "Workspace name"}
            >
              <input
                name="name"
                required={modal === "workspace"}
                maxLength={120}
              />
            </Field>
            {modal === "invite" && (
              <>
                <Field label="Email address">
                  <input name="email" type="email" required maxLength={254} />
                </Field>
                <Field label="Workspace role">
                  <select name="role" defaultValue="member">
                    {(user?.role === "owner"
                      ? ["member", "admin", "owner"]
                      : ["member"]
                    ).map((role) => (
                      <option key={role}>{role}</option>
                    ))}
                  </select>
                </Field>
                <p className="muted">
                  The recipient must sign in with this email address to accept.
                  Creating another invitation for the same email revokes the
                  previous link.
                </p>
              </>
            )}
            <ErrorBanner error={error} />
            <Button type="submit" variant="primary" busy={busy}>
              {modal === "invite"
                ? "Create invitation link"
                : "Create workspace"}
            </Button>
          </form>
        </Modal>
      )}
      {confirmation && (
        <Modal
          title={confirmation.title}
          onClose={() => !busy && setConfirmation(null)}
        >
          <p>{confirmation.message}</p>
          <ErrorBanner error={error} />
          <div className="team-actions">
            <Button onClick={() => setConfirmation(null)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              busy={busy}
              onClick={() => void action(confirmation.action)}
            >
              Confirm
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
