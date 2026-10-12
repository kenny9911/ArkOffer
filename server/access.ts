import { randomUUID } from "node:crypto";
import type { Express, Request } from "express";
import { z } from "zod";
import { isWorkspaceAdmin, type AuthRequest, type User } from "./auth.js";
import type { Store } from "./db.js";

type Kind = "conversations" | "collections";
type Permission = "viewer" | "editor" | "owner" | null;
export class AccessError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export function initializeAccess(store: Store) {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS resource_access (
      resource_id TEXT PRIMARY KEY REFERENCES resources(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      owner_id TEXT NOT NULL REFERENCES users(id),
      visibility TEXT NOT NULL DEFAULT 'private' CHECK(visibility IN ('private','workspace'))
    );
    CREATE TABLE IF NOT EXISTS resource_grants (
      resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id),
      permission TEXT NOT NULL CHECK(permission IN ('viewer','editor')),
      created_at TEXT NOT NULL,
      PRIMARY KEY(resource_id,user_id)
    );
    CREATE TABLE IF NOT EXISTS conversation_comments (
      id TEXT PRIMARY KEY,
      resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS conversation_comments_resource ON conversation_comments(resource_id,created_at);
  `);
  // Existing installations had exactly one original user per workspace. Migration
  // preserves ownership without making historical conversations visible to invitees.
  store.db
    .exec(`INSERT OR IGNORE INTO resource_access(resource_id,workspace_id,owner_id)
    SELECT r.id,r.workspace_id,(SELECT u.id FROM users u WHERE u.workspace_id=r.workspace_id ORDER BY u.created_at,u.id LIMIT 1)
    FROM resources r WHERE r.kind IN ('conversations','collections')
    AND EXISTS(SELECT 1 FROM users u WHERE u.workspace_id=r.workspace_id)`);
}
export function registerResourceOwner(
  store: Store,
  workspaceId: string,
  id: string,
  userId: string,
) {
  store.db
    .prepare(
      "INSERT OR IGNORE INTO resource_access(resource_id,workspace_id,owner_id) VALUES (?,?,?)",
    )
    .run(id, workspaceId, userId);
}
export const registerConversationOwner = registerResourceOwner;
function accessRow(store: Store, user: User, id: string) {
  let row = store.db
    .prepare(
      "SELECT * FROM resource_access WHERE resource_id=? AND workspace_id=?",
    )
    .get(id, user.workspaceId);
  if (!row) {
    // Covers synthetic seed records created after startup; ordinary creates register explicitly.
    const original = store.db
      .prepare(
        "SELECT id FROM users WHERE workspace_id=? ORDER BY created_at,id LIMIT 1",
      )
      .get(user.workspaceId);
    if (original)
      registerResourceOwner(store, user.workspaceId, id, String(original.id));
    row = store.db
      .prepare(
        "SELECT * FROM resource_access WHERE resource_id=? AND workspace_id=?",
      )
      .get(id, user.workspaceId);
  }
  return row;
}
export function resourcePermission(
  store: Store,
  user: User,
  kind: Kind,
  id: string,
): Permission {
  const item = store.get(user.workspaceId, kind, id);
  if (!item) return null;
  const row = accessRow(store, user, id);
  if (isWorkspaceAdmin(user) || row?.owner_id === user.id) return "owner";
  const grant = store.db
    .prepare(
      "SELECT permission FROM resource_grants WHERE resource_id=? AND user_id=?",
    )
    .get(id, user.id);
  if (grant?.permission === "editor") return "editor";
  if (kind === "conversations" && Array.isArray(item.collectionIds)) {
    const permissions = item.collectionIds.map((value) =>
      resourcePermission(store, user, "collections", String(value)),
    );
    if (permissions.some((value) => value === "owner" || value === "editor"))
      return "editor";
    if (permissions.some(Boolean)) return "viewer";
  }
  return grant?.permission === "viewer" || row?.visibility === "workspace"
    ? "viewer"
    : null;
}
export const mayReadConversation = (store: Store, user: User, id: string) =>
  Boolean(resourcePermission(store, user, "conversations", id));
export const mayEditConversation = (store: Store, user: User, id: string) =>
  ["owner", "editor"].includes(
    resourcePermission(store, user, "conversations", id) || "",
  );
export function accessInfo(store: Store, user: User, kind: Kind, id: string) {
  const row = accessRow(store, user, id),
    permission = resourcePermission(store, user, kind, id);
  return {
    ownerId: row?.owner_id,
    visibility: row?.visibility || "private",
    permission,
    canEdit: permission === "owner" || permission === "editor",
    canManage: permission === "owner",
  };
}
export function requireAccess(
  store: Store,
  user: User,
  kind: Kind,
  id: string,
  action: "read" | "edit" | "manage" = "read",
) {
  const permission = resourcePermission(store, user, kind, id);
  if (!permission) throw new AccessError(404, "Record not found.");
  if (
    (action === "edit" && permission === "viewer") ||
    (action === "manage" && permission !== "owner")
  )
    throw new AccessError(
      403,
      action === "manage"
        ? "Only the owner or a workspace admin can manage access."
        : "This conversation is shared with you as read-only.",
    );
}
export function registerAccess(app: Express, store: Store) {
  initializeAccess(store);
  const user = (req: Request) => (req as AuthRequest).user!;
  const id = (req: Request) => String(req.params.id);
  for (const kind of ["conversations", "collections"] as const) {
    app.get(`/api/${kind}/:id/access`, (req, res) => {
      requireAccess(store, user(req), kind, id(req));
      const info = accessInfo(store, user(req), kind, id(req));
      const grants = info.canManage
        ? store.db
            .prepare(
              "SELECT g.user_id AS userId,g.permission,u.name,u.email FROM resource_grants g JOIN users u ON u.id=g.user_id WHERE g.resource_id=?",
            )
            .all(id(req))
        : [];
      res.json({ ...info, grants });
    });
    app.patch(`/api/${kind}/:id/access`, (req, res) => {
      requireAccess(store, user(req), kind, id(req), "manage");
      const input = z
        .object({ visibility: z.enum(["private", "workspace"]) })
        .strict()
        .parse(req.body);
      store.db
        .prepare(
          "UPDATE resource_access SET visibility=? WHERE resource_id=? AND workspace_id=?",
        )
        .run(input.visibility, id(req), user(req).workspaceId);
      res.json({ ok: true });
    });
    app.put(`/api/${kind}/:id/access/:userId`, (req, res) => {
      requireAccess(store, user(req), kind, id(req), "manage");
      const target = String(req.params.userId);
      const member = store.db
        .prepare(
          "SELECT user_id FROM memberships WHERE workspace_id=? AND user_id=? AND status='active'",
        )
        .get(user(req).workspaceId, target);
      if (!member)
        throw new AccessError(
          400,
          "Choose an active member of this workspace.",
        );
      const input = z
        .object({ permission: z.enum(["viewer", "editor"]) })
        .strict()
        .parse(req.body);
      store.db
        .prepare(
          "INSERT INTO resource_grants(resource_id,user_id,permission,created_at) VALUES(?,?,?,?) ON CONFLICT(resource_id,user_id) DO UPDATE SET permission=excluded.permission",
        )
        .run(id(req), target, input.permission, new Date().toISOString());
      res.json({ ok: true });
    });
    app.delete(`/api/${kind}/:id/access/:userId`, (req, res) => {
      requireAccess(store, user(req), kind, id(req), "manage");
      store.db
        .prepare(
          "DELETE FROM resource_grants WHERE resource_id=? AND user_id=?",
        )
        .run(id(req), String(req.params.userId));
      res.json({ ok: true });
    });
  }
  app.get("/api/conversations/:id/comments", (req, res) => {
    requireAccess(store, user(req), "conversations", id(req));
    const items = store.db
      .prepare(
        "SELECT c.id,c.user_id AS userId,c.body,c.created_at AS createdAt,c.updated_at AS updatedAt,u.name FROM conversation_comments c JOIN users u ON u.id=c.user_id WHERE c.resource_id=? AND c.workspace_id=? ORDER BY c.created_at,c.id LIMIT 500",
      )
      .all(id(req), user(req).workspaceId);
    res.json({ items });
  });
  app.post("/api/conversations/:id/comments", (req, res) => {
    requireAccess(store, user(req), "conversations", id(req));
    const { body } = z
      .object({ body: z.string().trim().min(1).max(10000) })
      .strict()
      .parse(req.body);
    const count = store.db
      .prepare(
        "SELECT COUNT(*) AS n FROM conversation_comments WHERE resource_id=?",
      )
      .get(id(req));
    if (Number(count?.n) >= 500)
      throw new AccessError(
        400,
        "This conversation has reached its 500-comment limit.",
      );
    const item = {
      id: randomUUID(),
      userId: user(req).id,
      body,
      createdAt: new Date().toISOString(),
      name: user(req).name,
    };
    store.db
      .prepare(
        "INSERT INTO conversation_comments(id,resource_id,workspace_id,user_id,body,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        item.id,
        id(req),
        user(req).workspaceId,
        item.userId,
        body,
        item.createdAt,
        item.createdAt,
      );
    res.status(201).json({ item });
  });
  app.delete("/api/conversations/:id/comments/:commentId", (req, res) => {
    requireAccess(store, user(req), "conversations", id(req));
    const comment = store.db
      .prepare(
        "SELECT user_id FROM conversation_comments WHERE id=? AND resource_id=? AND workspace_id=?",
      )
      .get(String(req.params.commentId), id(req), user(req).workspaceId);
    if (!comment) throw new AccessError(404, "Comment not found.");
    if (comment.user_id !== user(req).id && !isWorkspaceAdmin(user(req)))
      throw new AccessError(403, "You may remove only your own comments.");
    store.db
      .prepare("DELETE FROM conversation_comments WHERE id=?")
      .run(String(req.params.commentId));
    res.json({ ok: true });
  });
}
