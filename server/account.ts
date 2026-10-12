import { randomBytes, randomUUID } from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";
import { z } from "zod";
import {
  COOKIE,
  createSession,
  getSessionToken,
  hashPassword,
  hashToken,
  sessionUser,
  userById,
  verifyPassword,
} from "./auth.js";
import type { Store } from "./db.js";
import { createMailTransport, type MailConfig } from "./mail.js";

export type AccountOptions = { mail?: MailConfig; fetcher?: typeof fetch };
type TokenRow = {
  id: string;
  user_id: string;
  email: string;
  purpose: string;
  expires_at: number;
  used_at: string | null;
};
const password = z
  .string()
  .min(8, "Use at least 8 characters for your password.")
  .max(128);
const email = z
  .string()
  .trim()
  .email()
  .max(254)
  .transform((v) => v.toLowerCase());
const tokenSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "This account link is invalid or has expired.");
class AccountError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const fail = (status: number, message: string): never => {
  throw new AccountError(status, message);
};
const route =
  (handler: (req: Request, res: Response) => unknown | Promise<unknown>) =>
  async (req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      await handler(req, res);
    } catch (error) {
      if (res.headersSent) return;
      if (error instanceof AccountError)
        res.status(error.status).json({ error: error.message });
      else if (error instanceof z.ZodError)
        res.status(400).json({
          error: error.issues[0]?.message || "Invalid account information.",
        });
      else next(error);
    }
  };

/** Install after Origin/JSON middleware; reset requests intentionally precede session-only middleware. */
export function registerAccount(
  app: Express,
  store: Store,
  options: AccountOptions = {},
) {
  const pendingRecovery = new Set<Promise<void>>();
  // The server drains these bounded provider calls before closing SQLite.
  app.locals.account = {
    stop: async () => {
      await Promise.allSettled([...pendingRecovery]);
    },
  };
  const mail = createMailTransport(options.mail, options.fetcher);
  const liveMail =
    mail.config.mode === "resend" &&
    mail.configured &&
    mail.config.workspaceIds.length > 0;
  store.db.exec(`CREATE TABLE IF NOT EXISTS account_tokens (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, email TEXT NOT NULL,
    purpose TEXT NOT NULL CHECK(purpose IN ('reset_password', 'verify_email')), token_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL, created_at TEXT NOT NULL, used_at TEXT
  ); CREATE INDEX IF NOT EXISTS account_tokens_user ON account_tokens(user_id, purpose, expires_at);`);
  const limits = new Map<string, { count: number; until: number }>();
  const rateLimit = (
    req: Request,
    action: string,
    max = 10,
    identity?: string,
  ) => {
    const time = Date.now(),
      key = `${action}:${identity || req.ip || req.socket.remoteAddress}`;
    if (limits.size > 10_000)
      for (const [k, v] of limits) if (v.until < time) limits.delete(k);
    const entry = limits.get(key);
    if (!entry || entry.until < time) {
      limits.set(key, { count: 1, until: time + 15 * 60_000 });
      return;
    }
    if (++entry.count > max)
      return fail(429, "Too many account requests. Please try again later.");
  };
  const authenticate = (req: Request) =>
    sessionUser(store, req) || fail(401, "Sign in to manage your account.");
  const createToken = (
    userId: string,
    address: string,
    purpose: "reset_password" | "verify_email",
  ) => {
    const id = randomUUID(),
      token = randomBytes(32).toString("hex"),
      time = Date.now();
    store.transaction(() => {
      store.db
        .prepare("DELETE FROM account_tokens WHERE expires_at <= ?")
        .run(time);
      store.db
        .prepare(
          "UPDATE account_tokens SET used_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL",
        )
        .run(new Date(time).toISOString(), userId, purpose);
      store.db
        .prepare(
          "INSERT INTO account_tokens (id, user_id, email, purpose, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          id,
          userId,
          address,
          purpose,
          hashToken(token),
          time +
            (purpose === "reset_password" ? 30 * 60_000 : 24 * 60 * 60_000),
          new Date(time).toISOString(),
        );
    });
    return { id, token };
  };
  const tokenRow = (token: string, purpose: string) => {
    const row = store.db
      .prepare(
        "SELECT id, user_id, email, purpose, expires_at, used_at FROM account_tokens WHERE token_hash = ? AND purpose = ? AND expires_at > ? AND used_at IS NULL",
      )
      .get(hashToken(token), purpose, Date.now()) as TokenRow | undefined;
    if (!row)
      return fail(
        400,
        "This account link is invalid or has expired. Request a new link.",
      );
    const account = store.db
      .prepare("SELECT email FROM users WHERE id = ?")
      .get(row.user_id);
    if (account?.email !== row.email)
      return fail(
        400,
        "This account link is invalid or has expired. Request a new link.",
      );
    return row;
  };
  const revokeToken = (id: string) =>
    store.db
      .prepare("UPDATE account_tokens SET used_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  const clearCookie = (req: Request, res: Response) =>
    res.clearCookie(COOKIE, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: req.secure || process.env.NODE_ENV === "production",
    });

  app.post(
    "/api/auth/forgot-password",
    route(async (req, res) => {
      rateLimit(req, "forgot-password");
      const input = z.object({ email }).strict().parse(req.body);
      rateLimit(req, "forgot-email", 4, hashToken(input.email));
      if (!liveMail)
        return res.status(503).json({
          error:
            "Account recovery email is not configured for this installation. Contact the server administrator. No recovery email was sent.",
        });
      // Acknowledge before provider I/O so delivery latency does not reveal
      // whether an address has an eligible account. This is not a delivery receipt.
      res.status(202).json({
        message:
          "If this address has an eligible ArkOffer account, a password reset link will be emailed. Check your inbox, or contact the administrator if it does not arrive.",
      });
      const account = store.db
        .prepare("SELECT id, email FROM users WHERE email = ?")
        .get(input.email);
      const allowed =
        account &&
        store.db
          .prepare(
            "SELECT workspace_id FROM memberships WHERE user_id = ? AND status = 'active'",
          )
          .all(account.id)
          .some((m) => mail.allowed(String(m.workspace_id)));
      if (account && allowed) {
        const token = createToken(
          String(account.id),
          input.email,
          "reset_password",
        );
        const task = (async () => {
          try {
            const result = await mail.send({
              to: input.email,
              subject: "Reset your ArkOffer password",
              idempotencyKey: `account-reset-${token.id}`,
              text: `A password reset was requested for your ArkOffer account. Open this link within 30 minutes to choose a new password:\n\n${mail.publicUrl}/reset-password?token=${token.token}\n\nIf you did not request this, ignore this email. Your password has not changed.`,
            });
            if (result.state !== "accepted") revokeToken(token.id);
          } catch {
            revokeToken(token.id);
          }
        })();
        pendingRecovery.add(task);
        try {
          await task;
        } finally {
          pendingRecovery.delete(task);
        }
      }
    }),
  );
  app.post(
    "/api/auth/reset-password",
    route(async (req, res) => {
      rateLimit(req, "reset-password", 20);
      const input = z
        .object({ token: tokenSchema, password })
        .strict()
        .parse(req.body);
      tokenRow(input.token, "reset_password");
      const passwordHash = await hashPassword(input.password);
      store.transaction(() => {
        const row = tokenRow(input.token, "reset_password");
        store.db
          .prepare("UPDATE users SET password_hash = ? WHERE id = ?")
          .run(passwordHash, row.user_id);
        store.db
          .prepare("DELETE FROM sessions WHERE user_id = ?")
          .run(row.user_id);
        store.db
          .prepare(
            "UPDATE account_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL",
          )
          .run(new Date().toISOString(), row.user_id);
      });
      clearCookie(req, res);
      res.json({
        ok: true,
        message: "Password updated. Sign in with your new password.",
      });
    }),
  );
  app.get(
    "/api/account/security",
    route((req, res) => {
      const user = authenticate(req),
        tokenHash = hashToken(getSessionToken(req)!);
      const account = store.db
        .prepare("SELECT email_verified_at FROM users WHERE id = ?")
        .get(user.id)!;
      const sessions = store.db
        .prepare(
          `SELECT s.public_id AS id, s.user_agent AS userAgent, s.created_at AS createdAt,
      s.last_seen_at AS lastSeenAt, s.expires_at AS expiresAt, s.token_hash = ? AS current, w.name AS workspaceName
      FROM sessions s LEFT JOIN workspaces w ON w.id = s.workspace_id WHERE s.user_id = ? AND s.expires_at > ? ORDER BY s.created_at DESC`,
        )
        .all(tokenHash, user.id, Date.now())
        .map((s) => ({ ...s, current: Boolean(s.current) }));
      res.json({
        email: user.email,
        emailVerifiedAt: account.email_verified_at,
        mailAvailable: liveMail && mail.allowed(user.workspaceId),
        sessions,
      });
    }),
  );
  app.post(
    "/api/account/password",
    route(async (req, res) => {
      const user = authenticate(req);
      rateLimit(req, "change-password", 10, user.id);
      const input = z
        .object({ currentPassword: z.string().min(1).max(128), password })
        .strict()
        .parse(req.body);
      const account = store.db
        .prepare("SELECT password_hash FROM users WHERE id = ?")
        .get(user.id)!;
      if (
        !(await verifyPassword(
          input.currentPassword,
          String(account.password_hash),
        ))
      )
        return fail(400, "The current password is incorrect.");
      const passwordHash = await hashPassword(input.password);
      store.transaction(() => {
        // Recheck after the async KDF so concurrent password changes cannot overwrite one another.
        if (sessionUser(store, req)?.id !== user.id)
          return fail(401, "This session has ended. Sign in again.");
        const current = store.db
          .prepare("SELECT password_hash FROM users WHERE id = ?")
          .get(user.id)!;
        if (current.password_hash !== account.password_hash)
          return fail(
            409,
            "Your password changed during this request. Sign in again.",
          );
        store.db
          .prepare("UPDATE users SET password_hash = ? WHERE id = ?")
          .run(passwordHash, user.id);
        store.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
        store.db
          .prepare(
            "UPDATE account_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL",
          )
          .run(new Date().toISOString(), user.id);
      });
      createSession(store, req, res, user.id, user.workspaceId);
      res.json({ ok: true, user: userById(store, user.id, user.workspaceId) });
    }),
  );
  app.delete(
    "/api/account/sessions/others",
    route((req, res) => {
      const user = authenticate(req);
      store.db
        .prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?")
        .run(user.id, hashToken(getSessionToken(req)!));
      res.json({ ok: true });
    }),
  );
  app.delete(
    "/api/account/sessions/:id",
    route((req, res) => {
      const user = authenticate(req);
      const row = store.db
        .prepare(
          "SELECT token_hash FROM sessions WHERE public_id = ? AND user_id = ?",
        )
        .get(String(req.params.id), user.id);
      if (!row) return fail(404, "Session not found.");
      store.db
        .prepare("DELETE FROM sessions WHERE public_id = ? AND user_id = ?")
        .run(String(req.params.id), user.id);
      if (row.token_hash === hashToken(getSessionToken(req)!))
        clearCookie(req, res);
      res.json({ ok: true });
    }),
  );
  app.post(
    "/api/account/verification",
    route(async (req, res) => {
      const user = authenticate(req);
      rateLimit(req, "verification", 4, user.id);
      if (!liveMail || !mail.allowed(user.workspaceId))
        return fail(
          503,
          "Verification email is not configured for this workspace. Contact the server administrator. No email was sent.",
        );
      const account = store.db
        .prepare("SELECT email_verified_at FROM users WHERE id = ?")
        .get(user.id)!;
      if (account.email_verified_at)
        return res.json({
          verified: true,
          message: "Your email address is already verified.",
        });
      const token = createToken(user.id, user.email, "verify_email");
      try {
        const result = await mail.send({
          to: user.email,
          subject: "Verify your ArkOffer email",
          idempotencyKey: `account-verify-${token.id}`,
          text: `Confirm this email address for your ArkOffer account. Sign in with this account and open the link within 24 hours:\n\n${mail.publicUrl}/verify-email?token=${token.token}\n\nIf you did not request this, ignore this email.`,
        });
        if (result.state !== "accepted") {
          revokeToken(token.id);
          return fail(
            503,
            "Verification email was not sent. Contact the server administrator.",
          );
        }
      } catch (error) {
        revokeToken(token.id);
        if (error instanceof AccountError) throw error;
        return fail(
          502,
          "The verification email could not be sent. Please try again later.",
        );
      }
      res.status(202).json({
        message:
          "The email provider accepted your verification request. Check your inbox.",
      });
    }),
  );
  app.post(
    "/api/account/verify-email",
    route((req, res) => {
      const user = authenticate(req);
      rateLimit(req, "verify-email", 20, user.id);
      const input = z.object({ token: tokenSchema }).strict().parse(req.body);
      store.transaction(() => {
        const token = tokenRow(input.token, "verify_email");
        if (token.user_id !== user.id || token.email !== user.email)
          return fail(
            403,
            "Sign in with the account this verification link belongs to.",
          );
        store.db
          .prepare("UPDATE users SET email_verified_at = ? WHERE id = ?")
          .run(new Date().toISOString(), user.id);
        revokeToken(token.id);
      });
      res.json({ ok: true, message: "Your email address is verified." });
    }),
  );
}
