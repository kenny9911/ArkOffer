import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import type { Request, Response } from "express";
import type { Store } from "./db.js";

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

export function userById(store: Store, id: string): User | undefined {
  return store.db
    .prepare(
      `SELECT u.id, u.name, u.email, u.workspace_id AS workspaceId, w.name AS workspaceName, u.role
    FROM users u JOIN workspaces w ON w.id = u.workspace_id WHERE u.id = ?`,
    )
    .get(id) as User | undefined;
}

export function sessionUser(store: Store, req: Request): User | undefined {
  const token = getSessionToken(req);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return undefined;
  const row = store.db
    .prepare(
      "SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?",
    )
    .get(hashToken(token), Date.now());
  return row ? userById(store, row.user_id as string) : undefined;
}

export function createSession(
  store: Store,
  req: Request,
  res: Response,
  userId: string,
) {
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
      "INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(
      hashToken(token),
      userId,
      Date.now() + SESSION_MS,
      new Date().toISOString(),
    );
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: req.secure || process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MS,
  });
}
