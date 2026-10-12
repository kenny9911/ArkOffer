import { randomBytes, randomUUID } from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";
import { z } from "zod";
import {
  getSessionToken,
  hashToken,
  isWorkspaceAdmin,
  sessionUser,
  userById,
  type User,
} from "./auth.js";
import type { Store } from "./db.js";
import { seedTemplates } from "./seed.js";

const WEEK = 7 * 24 * 60 * 60 * 1000;
const roleSchema = z.enum(["owner", "admin", "member"]);
const invitationSchema = z
  .object({
    email: z
      .string()
      .trim()
      .email()
      .max(254)
      .transform((value) => value.toLowerCase()),
    name: z.string().trim().max(120).optional(),
    role: roleSchema.default("member"),
  })
  .strict();
class TeamError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const fail = (status: number, message: string): never => {
  throw new TeamError(status, message);
};
const param = (req: Request, key: string) => String(req.params[key] || "");
const route =
  (handler: (req: Request, res: Response) => unknown) =>
  (req: Request, res: Response, next: NextFunction) => {
    try {
      handler(req, res);
    } catch (error) {
      if (error instanceof TeamError)
        res.status(error.status).json({ error: error.message });
      else if (error instanceof z.ZodError)
        res.status(400).json({
          error: error.issues[0]?.message || "Invalid team information.",
        });
      else next(error);
    }
  };
type Invitation = {
  id: string;
  workspace_id: string;
  email: string;
  name: string;
  role: "owner" | "admin" | "member";
  token_hash: string;
  created_at: string;
  expires_at: number;
  revoked_at: string | null;
  accepted_at: string | null;
  created_by: string;
};

/** Install after Origin/JSON middleware, before the session-only API fallback. */
export function registerTeam(app: Express, store: Store) {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS team_invitations (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      email TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', role TEXT NOT NULL CHECK(role IN ('owner', 'admin', 'member')),
      token_hash TEXT NOT NULL UNIQUE, created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
      expires_at INTEGER NOT NULL, revoked_at TEXT, accepted_at TEXT, accepted_by TEXT REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS team_invitations_workspace ON team_invitations(workspace_id, email, expires_at);
    CREATE TABLE IF NOT EXISTS team_audit (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), actor_id TEXT NOT NULL REFERENCES users(id),
      action TEXT NOT NULL, subject_id TEXT NOT NULL, details TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
    );
  `);
  const authenticate = (req: Request, admin = false) => {
    const user = sessionUser(store, req);
    if (!user) return fail(401, "Sign in to manage your workspace.");
    if (admin && !isWorkspaceAdmin(user))
      return fail(403, "Only owners and administrators can manage the team.");
    return user;
  };
  const audit = (
    user: User,
    action: string,
    subject: string,
    details: unknown = {},
  ) => {
    store.db
      .prepare(
        "INSERT INTO team_audit (id, workspace_id, actor_id, action, subject_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        randomUUID(),
        user.workspaceId,
        user.id,
        action,
        subject,
        JSON.stringify(details),
        new Date().toISOString(),
      );
  };
  const selectWorkspace = (req: Request, workspaceId: string) => {
    store.db
      .prepare("UPDATE sessions SET workspace_id = ? WHERE token_hash = ?")
      .run(workspaceId, hashToken(getSessionToken(req)!));
  };
  const invitation = (token: string) => {
    if (!/^[a-f0-9]{64}$/.test(token))
      return fail(404, "This invitation is unavailable or has expired.");
    const item = store.db
      .prepare(
        "SELECT * FROM team_invitations WHERE token_hash = ? AND expires_at > ? AND revoked_at IS NULL AND accepted_at IS NULL",
      )
      .get(hashToken(token), Date.now()) as Invitation | undefined;
    if (!item)
      return fail(404, "This invitation is unavailable or has expired.");
    return item;
  };
  const mayAssign = (user: User, role: string) => {
    if (role !== "member" && user.role !== "owner")
      return fail(403, "Only owners can assign administrator or owner access.");
  };

  app.get(
    "/api/workspaces",
    route((req, res) => {
      const user = authenticate(req);
      const items = store.db
        .prepare(
          `SELECT w.id, w.name, m.role, m.created_at AS joinedAt FROM memberships m
      JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ? AND m.status = 'active' ORDER BY w.name, w.id`,
        )
        .all(user.id);
      res.json({ items, activeWorkspaceId: user.workspaceId });
    }),
  );
  app.post(
    "/api/workspaces",
    route((req, res) => {
      const user = authenticate(req);
      const input = z
        .object({ name: z.string().trim().min(1).max(120) })
        .strict()
        .parse(req.body);
      const count = store.db
        .prepare("SELECT COUNT(*) AS count FROM memberships WHERE user_id = ?")
        .get(user.id)!;
      if (Number(count.count) >= 30)
        return fail(409, "You can belong to at most 30 workspaces.");
      const id = randomUUID(),
        date = new Date().toISOString();
      store.transaction(() => {
        store.db
          .prepare(
            "INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)",
          )
          .run(id, input.name, date);
        store.db
          .prepare(
            "INSERT INTO memberships (workspace_id, user_id, role, created_at, updated_at) VALUES (?, ?, 'owner', ?, ?)",
          )
          .run(id, user.id, date, date);
        seedTemplates(store, id);
        selectWorkspace(req, id);
      });
      res.status(201).json({ user: userById(store, user.id, id) });
    }),
  );
  app.post(
    "/api/workspaces/:id/switch",
    route((req, res) => {
      const user = authenticate(req),
        id = param(req, "id");
      const selected = userById(store, user.id, id);
      if (!selected) return fail(404, "Workspace not found.");
      selectWorkspace(req, id);
      res.json({ user: selected });
    }),
  );
  app.get(
    "/api/team/members",
    route((req, res) => {
      const user = authenticate(req);
      const items = store.db
        .prepare(
          `SELECT u.id, u.name, u.email, m.role, m.status, m.created_at AS joinedAt
      FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ?
      ${isWorkspaceAdmin(user) ? "" : "AND m.status = 'active'"} ORDER BY u.name, u.id`,
        )
        .all(user.workspaceId);
      res.json({ items, canManage: isWorkspaceAdmin(user) });
    }),
  );
  app.patch(
    "/api/team/members/:id",
    route((req, res) => {
      const user = authenticate(req, true),
        targetId = param(req, "id");
      const input = z
        .object({
          role: roleSchema.optional(),
          status: z.enum(["active", "suspended"]).optional(),
        })
        .strict()
        .parse(req.body);
      if (!input.role && !input.status)
        return fail(400, "Provide a role or membership status.");
      store.transaction(() => {
        const target = store.db
          .prepare(
            "SELECT role, status FROM memberships WHERE workspace_id = ? AND user_id = ?",
          )
          .get(user.workspaceId, targetId);
        if (!target) return fail(404, "Member not found.");
        if (user.role !== "owner" && target.role !== "member")
          return fail(403, "Only owners can change administrators or owners.");
        const role = input.role || String(target.role),
          status = input.status || String(target.status);
        mayAssign(user, role);
        if (
          target.role === "owner" &&
          target.status === "active" &&
          (role !== "owner" || status !== "active")
        ) {
          const owners = store.db
            .prepare(
              "SELECT COUNT(*) AS count FROM memberships WHERE workspace_id = ? AND role = 'owner' AND status = 'active'",
            )
            .get(user.workspaceId)!;
          if (Number(owners.count) <= 1)
            return fail(
              409,
              "A workspace must retain at least one active owner.",
            );
        }
        store.db
          .prepare(
            "UPDATE memberships SET role = ?, status = ?, updated_at = ? WHERE workspace_id = ? AND user_id = ?",
          )
          .run(
            role,
            status,
            new Date().toISOString(),
            user.workspaceId,
            targetId,
          );
        if (status === "suspended")
          store.db
            .prepare(
              "DELETE FROM sessions WHERE user_id = ? AND workspace_id = ?",
            )
            .run(targetId, user.workspaceId);
        if (status === "suspended" || role === "member")
          store.db
            .prepare(
              "UPDATE team_invitations SET revoked_at = ? WHERE workspace_id = ? AND created_by = ? AND accepted_at IS NULL AND revoked_at IS NULL",
            )
            .run(new Date().toISOString(), user.workspaceId, targetId);
        else if (role === "admin")
          store.db
            .prepare(
              "UPDATE team_invitations SET revoked_at = ? WHERE workspace_id = ? AND created_by = ? AND role <> 'member' AND accepted_at IS NULL AND revoked_at IS NULL",
            )
            .run(new Date().toISOString(), user.workspaceId, targetId);
        audit(user, "member.updated", targetId, { role, status });
      });
      res.json({ ok: true });
    }),
  );
  app.delete(
    "/api/team/members/:id",
    route((req, res) => {
      const user = authenticate(req, true),
        targetId = param(req, "id");
      store.transaction(() => {
        const target = store.db
          .prepare(
            "SELECT role, status FROM memberships WHERE workspace_id = ? AND user_id = ?",
          )
          .get(user.workspaceId, targetId);
        if (!target) return fail(404, "Member not found.");
        if (user.role !== "owner" && target.role !== "member")
          return fail(403, "Only owners can remove administrators or owners.");
        if (target.role === "owner" && target.status === "active") {
          const owners = store.db
            .prepare(
              "SELECT COUNT(*) AS count FROM memberships WHERE workspace_id = ? AND role = 'owner' AND status = 'active'",
            )
            .get(user.workspaceId)!;
          if (Number(owners.count) <= 1)
            return fail(
              409,
              "A workspace must retain at least one active owner.",
            );
        }
        store.db
          .prepare(
            "DELETE FROM memberships WHERE workspace_id = ? AND user_id = ?",
          )
          .run(user.workspaceId, targetId);
        store.db
          .prepare(
            "DELETE FROM sessions WHERE user_id = ? AND workspace_id = ?",
          )
          .run(targetId, user.workspaceId);
        // Old pending invitations must not silently restore access after removal.
        store.db
          .prepare(
            "UPDATE team_invitations SET revoked_at = ? WHERE workspace_id = ? AND (email = (SELECT email FROM users WHERE id = ?) OR created_by = ?) AND accepted_at IS NULL",
          )
          .run(new Date().toISOString(), user.workspaceId, targetId, targetId);
        audit(user, "member.removed", targetId);
      });
      res.json({ ok: true });
    }),
  );
  app.get(
    "/api/team/invitations",
    route((req, res) => {
      const user = authenticate(req, true);
      const items = store.db
        .prepare(
          `SELECT id, email, name, role, created_at AS createdAt, expires_at AS expiresAt
      FROM team_invitations WHERE workspace_id = ? AND revoked_at IS NULL AND accepted_at IS NULL AND expires_at > ? ORDER BY created_at DESC`,
        )
        .all(user.workspaceId, Date.now());
      res.json({ items });
    }),
  );
  app.post(
    "/api/team/invitations",
    route((req, res) => {
      const user = authenticate(req, true),
        input = invitationSchema.parse(req.body);
      mayAssign(user, input.role);
      const existing = store.db
        .prepare(
          `SELECT m.status FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = ? AND u.email = ?`,
        )
        .get(user.workspaceId, input.email);
      if (existing)
        return fail(
          409,
          "This person is already a member. Manage their role or restore their access in the member list.",
        );
      const pending = store.db
        .prepare(
          "SELECT role FROM team_invitations WHERE workspace_id = ? AND email = ? AND revoked_at IS NULL AND accepted_at IS NULL AND expires_at > ?",
        )
        .get(user.workspaceId, input.email, Date.now());
      if (pending) mayAssign(user, String(pending.role));
      const id = randomUUID(),
        token = randomBytes(32).toString("hex"),
        date = new Date().toISOString(),
        expiresAt = Date.now() + WEEK;
      store.transaction(() => {
        store.db
          .prepare(
            "UPDATE team_invitations SET revoked_at = ? WHERE workspace_id = ? AND email = ? AND accepted_at IS NULL",
          )
          .run(date, user.workspaceId, input.email);
        const count = store.db
          .prepare(
            "SELECT COUNT(*) AS count FROM team_invitations WHERE workspace_id = ? AND revoked_at IS NULL AND accepted_at IS NULL AND expires_at > ?",
          )
          .get(user.workspaceId, Date.now())!;
        if (Number(count.count) >= 100)
          return fail(
            409,
            "This workspace already has 100 pending invitations.",
          );
        store.db
          .prepare(
            "INSERT INTO team_invitations (id, workspace_id, email, name, role, token_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            id,
            user.workspaceId,
            input.email,
            input.name || "",
            input.role,
            hashToken(token),
            user.id,
            date,
            expiresAt,
          );
        audit(user, "invitation.created", id, { role: input.role });
      });
      res.status(201).json({
        item: {
          id,
          email: input.email,
          name: input.name || "",
          role: input.role,
          createdAt: date,
          expiresAt,
          url: `/invitations/${token}`,
        },
      });
    }),
  );
  app.delete(
    "/api/team/invitations/:id",
    route((req, res) => {
      const user = authenticate(req, true),
        id = param(req, "id");
      const existing = store.db
        .prepare(
          "SELECT role FROM team_invitations WHERE id = ? AND workspace_id = ? AND revoked_at IS NULL AND accepted_at IS NULL",
        )
        .get(id, user.workspaceId);
      if (!existing) return fail(404, "Invitation not found.");
      mayAssign(user, String(existing.role));
      store.transaction(() => {
        store.db
          .prepare("UPDATE team_invitations SET revoked_at = ? WHERE id = ?")
          .run(new Date().toISOString(), id);
        audit(user, "invitation.revoked", id);
      });
      res.json({ ok: true });
    }),
  );
  app.get(
    "/api/invitations/:token",
    route((req, res) => {
      const item = invitation(param(req, "token"));
      const workspace = store.db
        .prepare("SELECT name FROM workspaces WHERE id = ?")
        .get(item.workspace_id)!;
      const [local, domain] = item.email.split("@");
      res.json({
        invitation: {
          workspaceName: workspace.name,
          role: item.role,
          expiresAt: item.expires_at,
          emailHint: `${local[0]}***@${domain}`,
        },
      });
    }),
  );
  app.post(
    "/api/invitations/:token/accept",
    route((req, res) => {
      const user = authenticate(req);
      let selected: User | undefined;
      store.transaction(() => {
        const item = invitation(param(req, "token"));
        if (user.email.toLowerCase() !== item.email)
          return fail(
            403,
            "Sign in with the email address this invitation was sent to.",
          );
        const existing = store.db
          .prepare(
            "SELECT role, status FROM memberships WHERE workspace_id = ? AND user_id = ?",
          )
          .get(item.workspace_id, user.id);
        if (existing?.status === "suspended")
          return fail(
            403,
            "Your membership is suspended. Ask a workspace owner to restore access.",
          );
        if (!existing) {
          const count = store.db
            .prepare(
              "SELECT COUNT(*) AS count FROM memberships WHERE user_id = ?",
            )
            .get(user.id)!;
          if (Number(count.count) >= 30)
            return fail(409, "You can belong to at most 30 workspaces.");
          const date = new Date().toISOString();
          store.db
            .prepare(
              "INSERT INTO memberships (workspace_id, user_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            )
            .run(item.workspace_id, user.id, item.role, date, date);
        }
        store.db
          .prepare(
            "UPDATE team_invitations SET accepted_at = ?, accepted_by = ? WHERE id = ?",
          )
          .run(new Date().toISOString(), user.id, item.id);
        selectWorkspace(req, item.workspace_id);
        selected = userById(store, user.id, item.workspace_id)!;
        audit(selected, "invitation.accepted", item.id);
      });
      res.json({ user: selected });
    }),
  );
}
