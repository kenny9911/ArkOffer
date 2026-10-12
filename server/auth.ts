import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import type { Request, Response } from "express";
import type { Store } from "./db.js";
import { seedTemplates } from "./seed.js";

const scrypt = promisify(scryptCallback);
export const COOKIE = "arkoffer_session";
export const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
export const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export type User = {
  id: string;
  name: string;
  email: string;
  workspaceId: string;
  workspaceName: string;
  role: string;
};
export type AuthRequest = Request & { user?: User };

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `${salt}:${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string) {
  const [salt, key] = stored.split(":");
  if (!salt || !key) return false;
  const candidate = (await scrypt(password, salt, 64)) as Buffer;
  const expected = Buffer.from(key, "hex");
  return (
    candidate.length === expected.length && timingSafeEqual(candidate, expected)
  );
}

export function getSessionToken(req: Request) {
  const match = req.headers.cookie
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE}=`));
  return match?.slice(COOKIE.length + 1);
}

export const isWorkspaceAdmin = (user: Pick<User, "role">) =>
  user.role === "owner" || user.role === "admin";

export function userById(
  store: Store,
  id: string,
  workspaceId?: string,
): User | undefined {
  return store.db
    .prepare(
      `SELECT u.id, u.name, u.email, m.workspace_id AS workspaceId, w.name AS workspaceName, m.role
    FROM users u JOIN memberships m ON m.user_id = u.id AND m.status = 'active'
    JOIN workspaces w ON w.id = m.workspace_id
    WHERE u.id = ? AND (? IS NULL OR m.workspace_id = ?)
    ORDER BY CASE WHEN m.workspace_id = u.workspace_id THEN 0 ELSE 1 END, m.created_at, m.workspace_id LIMIT 1`,
    )
    .get(id, workspaceId ?? null, workspaceId ?? null) as User | undefined;
}

export function sessionUser(store: Store, req: Request): User | undefined {
  const token = getSessionToken(req);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return undefined;
  const row = store.db
    .prepare(
      "SELECT user_id, workspace_id, last_seen_at FROM sessions WHERE token_hash = ? AND expires_at > ?",
    )
    .get(hashToken(token), Date.now());
  if (row && Number(row.last_seen_at || 0) < Date.now() - 60_000)
    store.db
      .prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?")
      .run(Date.now(), hashToken(token));
  return row
    ? userById(store, row.user_id as string, row.workspace_id as string)
    : undefined;
}

export function createSession(
  store: Store,
  req: Request,
  res: Response,
  userId: string,
  selectedWorkspaceId?: string,
) {
  // A removed/suspended final membership must not lock someone out of their
  // account. A new personal workspace grants no access to the former team.
  let user =
    userById(store, userId, selectedWorkspaceId) || userById(store, userId);
  if (!user) {
    const account = store.db
      .prepare("SELECT name FROM users WHERE id = ?")
      .get(userId);
    if (!account) throw new Error("Account not found.");
    const workspaceId = randomUUID(),
      createdAt = new Date().toISOString();
    store.transaction(() => {
      store.db
        .prepare(
          "INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)",
        )
        .run(
          workspaceId,
          `${String(account.name).split(" ")[0]}'s workspace`,
          createdAt,
        );
      store.db
        .prepare(
          "INSERT INTO memberships (workspace_id, user_id, role, created_at, updated_at) VALUES (?, ?, 'owner', ?, ?)",
        )
        .run(workspaceId, userId, createdAt, createdAt);
      seedTemplates(store, workspaceId);
    });
    user = userById(store, userId)!;
  }
  const previous = getSessionToken(req);
  if (previous)
    store.db
      .prepare("DELETE FROM sessions WHERE token_hash = ?")
      .run(hashToken(previous));
  store.db
    .prepare("DELETE FROM sessions WHERE expires_at <= ?")
    .run(Date.now());
  const token = randomBytes(32).toString("hex");
  store.db
    .prepare(
      "INSERT INTO sessions (token_hash, user_id, expires_at, created_at, workspace_id, public_id, user_agent, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      hashToken(token),
      userId,
      Date.now() + SESSION_MS,
      new Date().toISOString(),
      user.workspaceId,
      randomUUID(),
      String(req.get("user-agent") || "").slice(0, 500),
      Date.now(),
    );
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: req.secure || process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MS,
  });
}
