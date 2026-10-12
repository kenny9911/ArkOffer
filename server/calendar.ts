import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import type { Express, Request, Response, NextFunction } from "express";
import { getSessionToken, hashToken, sessionUser, type User } from "./auth.js";
import type { Store } from "./db.js";
import { registerConversationOwner } from "./access.js";

type Provider = "google" | "microsoft";
type Fetcher = typeof fetch;
type Options = {
  appOrigin?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: Fetcher;
  now?: () => number;
};
type Tokens = { accessToken: string; refreshToken: string; expiresAt: number };
type Connection = {
  id: string;
  user_id: string;
  workspace_id: string;
  provider: Provider;
  account_key: string;
  account_name: string;
  tokens: string;
  created_at: string;
  last_sync: string | null;
  last_error: string | null;
  event_count: number;
};
type CalendarEvent = {
  id: string;
  title: string;
  start: string;
  end: string;
  cancelled: boolean;
  meetingUrl: string;
};
const PROVIDERS: Provider[] = ["google", "microsoft"];
const DAY = 86400000;
const definitions = {
  google: {
    name: "Google Calendar",
    client: "GOOGLE_CALENDAR_CLIENT_ID",
    secret: "GOOGLE_CALENDAR_CLIENT_SECRET",
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    scope: "https://www.googleapis.com/auth/calendar.readonly",
  },
  microsoft: {
    name: "Microsoft Outlook",
    client: "MICROSOFT_CALENDAR_CLIENT_ID",
    secret: "MICROSOFT_CALENDAR_CLIENT_SECRET",
    authorize: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scope: "offline_access https://graph.microsoft.com/Calendars.Read",
  },
};
class CalendarError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const fail = (status: number, message: string): never => {
  throw new CalendarError(status, message);
};
const string = (value: unknown, max = 2000) =>
  typeof value === "string" ? value.slice(0, max) : "";
function safeMeetingUrl(value: unknown) {
  try {
    const url = new URL(string(value));
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href
      : "";
  } catch {
    return "";
  }
}
function date(value: unknown) {
  const input = string(value, 100);
  // Graph returns UTC dateTime values without a suffix when the Prefer UTC header is used.
  const normalized =
    /^\d{4}-\d\d-\d\dT/.test(input) && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(input)
      ? `${input}Z`
      : input;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
}
function encrypt(value: unknown, key: Buffer, aad: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value)),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), encrypted]
    .map((part) => part.toString("base64url"))
    .join(".");
}
function decrypt<T>(value: string, key: Buffer, aad: string): T {
  try {
    const [iv, tag, ciphertext] = value
      .split(".")
      .map((part) => Buffer.from(part, "base64url"));
    const cipher = createDecipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(aad));
    cipher.setAuthTag(tag);
    return JSON.parse(
      Buffer.concat([cipher.update(ciphertext), cipher.final()]).toString(),
    ) as T;
  } catch {
    return fail(
      503,
      "Calendar credentials cannot be decrypted. Restore the original encryption key or disconnect and reconnect this calendar.",
    );
  }
}

/** Register after JSON and Origin middleware, before the application's session-only API middleware. */
export function registerCalendar(
  app: Express,
  store: Store,
  options: Options = {},
) {
  const env = options.env || process.env,
    fetcher = options.fetch || fetch,
    now = options.now || Date.now;
  const busy = new Set<string>();
  const callbacks = new Map<string, string>();
  store.transaction(() => {
    const schemas = store.db
      .prepare(
        "SELECT name,sql FROM sqlite_master WHERE type='table' AND name IN ('calendar_connections','calendar_imports')",
      )
      .all();
    const migrateConnections = schemas.some(
      (row) =>
        row.name === "calendar_connections" &&
        /UNIQUE\s*\(user_id,\s*provider\)/i.test(String(row.sql)),
    );
    const migrateImports = schemas.some(
      (row) =>
        row.name === "calendar_imports" &&
        /PRIMARY KEY\s*\(user_id,\s*provider,\s*account_key,\s*event_id\)/i.test(
          String(row.sql),
        ),
    );
    if (migrateConnections)
      store.db.exec(
        "ALTER TABLE calendar_connections RENAME TO calendar_connections_legacy",
      );
    if (migrateImports)
      store.db.exec(
        "ALTER TABLE calendar_imports RENAME TO calendar_imports_legacy",
      );
    store.db.exec(`
    CREATE TABLE IF NOT EXISTS calendar_connections (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, provider TEXT NOT NULL,
      account_key TEXT NOT NULL, account_name TEXT NOT NULL, tokens TEXT NOT NULL, created_at TEXT NOT NULL,
      last_sync TEXT, last_error TEXT, event_count INTEGER NOT NULL DEFAULT 0, UNIQUE(user_id, workspace_id, provider)
    );
    CREATE TABLE IF NOT EXISTS calendar_oauth_states (
      state_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, session_hash TEXT NOT NULL,
      provider TEXT NOT NULL, verifier TEXT NOT NULL, redirect_uri TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS calendar_imports (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      provider TEXT NOT NULL, account_key TEXT NOT NULL, event_id TEXT NOT NULL,
      conversation_id TEXT REFERENCES resources(id) ON DELETE SET NULL, source_start TEXT NOT NULL, source_end TEXT NOT NULL,
      PRIMARY KEY(user_id, workspace_id, provider, account_key, event_id)
    );
  `);
    if (migrateConnections)
      store.db.exec(
        "INSERT INTO calendar_connections SELECT * FROM calendar_connections_legacy; DROP TABLE calendar_connections_legacy",
      );
    if (migrateImports)
      store.db.exec(
        "INSERT INTO calendar_imports SELECT * FROM calendar_imports_legacy; DROP TABLE calendar_imports_legacy",
      );
  });
  function provider(req: Request): Provider {
    const value = String(req.params.provider || "");
    if (!PROVIDERS.includes(value as Provider))
      return fail(404, "Calendar provider not found.");
    return value as Provider;
  }
  function authorize(req: Request): User {
    return (
      sessionUser(store, req) || fail(401, "Sign in to manage your calendar.")
    );
  }
  function origin() {
    const raw =
      env.CALENDAR_APP_ORIGIN ||
      (options.appOrigin || env.APP_ORIGIN || "").split(",")[0]?.trim();
    try {
      const url = new URL(raw);
      if (
        url.origin !== raw ||
        url.username ||
        url.password ||
        (url.protocol !== "https:" &&
          !(
            url.protocol === "http:" &&
            ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
          ))
      )
        return "";
      const allowlist = (options.appOrigin || env.APP_ORIGIN || "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
      if (allowlist.length && !allowlist.includes(url.origin)) return "";
      return url.origin;
    } catch {
      return "";
    }
  }
  function configuration(p: Provider) {
    const d = definitions[p],
      missing: string[] = [];
    if (!env[d.client]) missing.push(d.client);
    if (!env[d.secret]) missing.push(d.secret);
    if (!/^[a-f0-9]{64}$/i.test(env.CALENDAR_TOKEN_ENCRYPTION_KEY || ""))
      missing.push("CALENDAR_TOKEN_ENCRYPTION_KEY (64 hexadecimal characters)");
    if (!origin())
      missing.push("CALENDAR_APP_ORIGIN (an exact origin in APP_ORIGIN)");
    return {
      configured: missing.length === 0,
      missing,
      redirectUri: origin() ? `${origin()}/api/calendar/${p}/callback` : null,
    };
  }
  function config(p: Provider) {
    const status = configuration(p);
    if (!status.configured)
      return fail(
        503,
        `Calendar setup required: ${status.missing.join(", ")}.`,
      );
    return {
      key: Buffer.from(env.CALENDAR_TOKEN_ENCRYPTION_KEY!, "hex"),
      redirectUri: status.redirectUri!,
      clientId: env[definitions[p].client]!,
      clientSecret: env[definitions[p].secret]!,
    };
  }
  const aad = (user: User, p: Provider) =>
    `${user.workspaceId}:${user.id}:${p}`;
  function connection(user: User, p: Provider) {
    return store.db
      .prepare(
        "SELECT * FROM calendar_connections WHERE user_id = ? AND workspace_id = ? AND provider = ?",
      )
      .get(user.id, user.workspaceId, p) as Connection | undefined;
  }
  function current(user: User, p: Provider, id: string) {
    if (connection(user, p)?.id !== id)
      fail(409, "This calendar connection changed. Connect or sync again.");
  }
  const route =
    (handler: (req: Request, res: Response) => unknown) =>
    (req: Request, res: Response, next: NextFunction) => {
      Promise.resolve()
        .then(() => handler(req, res))
        .catch((error) => {
          if (error instanceof CalendarError)
            res.status(error.status).json({ error: error.message });
          else next(error);
        });
    };
  async function request(
    url: string,
    init: RequestInit,
    context: "token" | "calendar",
  ) {
    let response: globalThis.Response;
    try {
      response = await fetcher(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      return fail(
        502,
        "The calendar provider did not respond. Try again later.",
      );
    }
    if (!response.ok) {
      if (
        [401, 403].includes(response.status) ||
        (context === "token" && response.status === 400)
      )
        return fail(
          502,
          "Calendar authorization has expired or was denied. Reconnect your calendar.",
        );
      if (response.status === 429)
        return fail(
          429,
          "The calendar provider is limiting requests. Try again later.",
        );
      return fail(
        502,
        "The calendar provider could not complete this request.",
      );
    }
    // Bound response size rather than trusting a provider's Content-Length header.
    const reader = response.body?.getReader();
    if (!reader)
      return fail(502, "The calendar provider returned an empty response.");
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 2_000_000) {
          await reader.cancel();
          return fail(502, "The calendar provider response was too large.");
        }
        chunks.push(part.value);
      }
      const parsed = JSON.parse(Buffer.concat(chunks).toString());
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return fail(502, "The calendar provider returned an invalid response.");
      return parsed;
    } catch (error) {
      if (error instanceof CalendarError) throw error;
      return fail(502, "The calendar provider returned an invalid response.");
    }
  }
  async function tokenRequest(
    p: Provider,
    fields: Record<string, string>,
    previous?: Tokens,
  ): Promise<Tokens> {
    const c = config(p);
    const body = new URLSearchParams({
      client_id: c.clientId,
      client_secret: c.clientSecret,
      ...fields,
    });
    const data = await request(
      definitions[p].token,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      },
      "token",
    );
    if (
      typeof data.access_token !== "string" ||
      data.access_token.length > 20000 ||
      !data.access_token ||
      !Number.isFinite(Number(data.expires_in)) ||
      Number(data.expires_in) <= 0
    )
      return fail(
        502,
        "The calendar provider did not return a usable access token.",
      );
    const refreshToken =
      string(data.refresh_token, 20000) || previous?.refreshToken || "";
    if (!refreshToken)
      return fail(
        502,
        "The calendar provider did not grant offline access. Reconnect and grant calendar consent.",
      );
    return {
      accessToken: data.access_token,
      refreshToken,
      expiresAt: now() + Math.min(Number(data.expires_in), 86400) * 1000,
    };
  }
  const headers = (tokens: Tokens) => ({
    Authorization: `Bearer ${tokens.accessToken}`,
    Prefer: 'outlook.timezone="UTC", IdType="ImmutableId"',
  });
  async function account(p: Provider, tokens: Tokens) {
    const data = await request(
      p === "google"
        ? "https://www.googleapis.com/calendar/v3/calendars/primary"
        : "https://graph.microsoft.com/v1.0/me/calendar?$select=id,name,owner",
      { headers: headers(tokens) },
      "calendar",
    );
    const identity =
      string(data.id) +
      (p === "microsoft" ? `:${string(data.owner?.address)}` : "");
    if (!string(data.id))
      return fail(
        502,
        "The calendar provider did not identify a primary calendar.",
      );
    return {
      key: hashToken(`${p}:${identity}`),
      name: string(
        p === "google"
          ? data.summary || data.id
          : data.owner?.address || data.name,
        200,
      ),
    };
  }
  async function events(
    p: Provider,
    tokens: Tokens,
    from: string,
    until: string,
  ) {
    const result: CalendarEvent[] = [],
      seen = new Set<string>();
    let next =
      p === "google"
        ? `https://www.googleapis.com/calendar/v3/calendars/primary/events?${new URLSearchParams({ timeMin: from, timeMax: until, singleEvents: "true", showDeleted: "true", maxResults: "250" })}`
        : `https://graph.microsoft.com/v1.0/me/calendarView?${new URLSearchParams({ startDateTime: from, endDateTime: until, $top: "250", $select: "id,subject,start,end,isCancelled,onlineMeeting,webLink" })}`;
    for (let page = 0; page < 4 && next; page++) {
      const target = new URL(next);
      // Never forward the bearer token to a provider-supplied foreign host or endpoint.
      if (
        p === "microsoft" &&
        (target.origin !== "https://graph.microsoft.com" ||
          target.pathname !== "/v1.0/me/calendarView" ||
          target.username ||
          target.password)
      )
        return fail(
          502,
          "The calendar provider returned an unsafe pagination link.",
        );
      if (seen.has(next))
        return fail(502, "The calendar provider repeated a pagination cursor.");
      seen.add(next);
      const data = await request(
        next,
        { headers: headers(tokens) },
        "calendar",
      );
      const items = p === "google" ? data.items : data.value;
      if (!Array.isArray(items) || items.length > 250)
        return fail(
          502,
          "The calendar provider returned an invalid events page.",
        );
      for (const event of items) {
        if (!event || typeof event !== "object")
          return fail(502, "The calendar provider returned an invalid event.");
        const id = string(event.id),
          cancelled =
            p === "google"
              ? event.status === "cancelled"
              : event.isCancelled === true;
        const start = date(
          p === "google"
            ? event.start?.dateTime || event.start?.date
            : event.start?.dateTime,
        );
        const end = date(
          p === "google"
            ? event.end?.dateTime || event.end?.date
            : event.end?.dateTime,
        );
        if (!id || (!cancelled && (!start || !end))) continue;
        const video =
          p === "google"
            ? event.hangoutLink ||
              event.conferenceData?.entryPoints?.find(
                (entry: { entryPointType?: string }) =>
                  entry.entryPointType === "video",
              )?.uri
            : event.onlineMeeting?.joinUrl;
        result.push({
          id,
          title:
            string(p === "google" ? event.summary : event.subject, 300) ||
            "Calendar conversation",
          start,
          end,
          cancelled,
          meetingUrl: safeMeetingUrl(video),
        });
      }
      const cursor = string(
        p === "google" ? data.nextPageToken : data["@odata.nextLink"],
        16000,
      );
      next = cursor
        ? p === "google"
          ? `https://www.googleapis.com/calendar/v3/calendars/primary/events?${new URLSearchParams({ timeMin: from, timeMax: until, singleEvents: "true", showDeleted: "true", maxResults: "250", pageToken: cursor })}`
          : cursor
        : "";
    }
    if (next)
      return fail(
        413,
        "This calendar has more than 1,000 events in the next 30 days. No events were imported. Use a less busy primary calendar.",
      );
    return result;
  }

  app.get(
    "/api/calendar",
    route((req, res) => {
      const user = authorize(req);
      res.json({
        items: PROVIDERS.map((p) => {
          const row = connection(user, p);
          return {
            id: p,
            name: definitions[p].name,
            ...configuration(p),
            connected: !!row,
            accountName: row?.account_name || null,
            lastSync: row?.last_sync || null,
            lastError: row?.last_error || null,
            eventCount: row?.event_count || 0,
          };
        }),
      });
    }),
  );
  app.post(
    "/api/calendar/:provider/connect",
    route((req, res) => {
      const user = authorize(req),
        p = provider(req),
        c = config(p),
        state = randomBytes(32).toString("hex"),
        verifier = randomBytes(48).toString("base64url");
      callbacks.delete(`${user.workspaceId}:${user.id}:${p}`);
      store.db
        .prepare(
          "DELETE FROM calendar_oauth_states WHERE expires_at <= ? OR (user_id = ? AND workspace_id = ? AND provider = ?)",
        )
        .run(now(), user.id, user.workspaceId, p);
      store.db
        .prepare(
          "INSERT INTO calendar_oauth_states(state_hash,user_id,workspace_id,session_hash,provider,verifier,redirect_uri,expires_at) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          hashToken(state),
          user.id,
          user.workspaceId,
          hashToken(getSessionToken(req)!),
          p,
          encrypt(verifier, c.key, aad(user, p)),
          c.redirectUri,
          now() + 600000,
        );
      const query = new URLSearchParams({
        client_id: c.clientId,
        redirect_uri: c.redirectUri,
        response_type: "code",
        scope: definitions[p].scope,
        state,
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
        code_challenge_method: "S256",
      });
      if (p === "google") {
        query.set("access_type", "offline");
        query.set("prompt", "consent");
      } else {
        query.set("response_mode", "query");
        query.set("prompt", "select_account");
      }
      res.setHeader("Cache-Control", "no-store");
      res.json({ url: `${definitions[p].authorize}?${query}` });
    }),
  );
  app.get(
    "/api/calendar/:provider/callback",
    route(async (req, res) => {
      const user = authorize(req),
        p = provider(req),
        c = config(p),
        state = string(req.query.state, 200);
      if (!/^[a-f0-9]{64}$/.test(state))
        return fail(
          400,
          "The calendar authorization state is missing or invalid. Start connecting again.",
        );
      const row = store.db
        .prepare(
          "SELECT * FROM calendar_oauth_states WHERE state_hash = ? AND user_id = ? AND workspace_id = ? AND session_hash = ? AND provider = ? AND expires_at > ?",
        )
        .get(
          hashToken(state),
          user.id,
          user.workspaceId,
          hashToken(getSessionToken(req)!),
          p,
          now(),
        );
      if (!row || row.redirect_uri !== c.redirectUri)
        return fail(
          400,
          "This calendar authorization request expired or belongs to another session. Start connecting again.",
        );
      store.db
        .prepare("DELETE FROM calendar_oauth_states WHERE state_hash = ?")
        .run(hashToken(state));
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Cache-Control", "no-store");
      if (req.query.error) {
        res.redirect(
          `${origin()}/app/settings?tab=integrations&calendar=denied`,
        );
        return;
      }
      const code = string(req.query.code, 20000);
      if (!code)
        return fail(
          400,
          "The calendar provider did not return an authorization code.",
        );
      // Capture the current connection to prevent an in-flight callback undoing a later disconnect.
      const callbackId = randomUUID();
      callbacks.set(`${user.workspaceId}:${user.id}:${p}`, callbackId);
      try {
        const tokens = await tokenRequest(p, {
          grant_type: "authorization_code",
          code,
          redirect_uri: c.redirectUri,
          code_verifier: decrypt<string>(
            String(row.verifier),
            c.key,
            aad(user, p),
          ),
        });
        const identity = await account(p, tokens);
        if (sessionUser(store, req)?.workspaceId !== user.workspaceId)
          return fail(401, "Your session ended. Sign in and connect again.");
        if (callbacks.get(`${user.workspaceId}:${user.id}:${p}`) !== callbackId)
          return fail(
            409,
            "This calendar connection was cancelled. Connect again.",
          );
        store.db
          .prepare(
            "INSERT INTO calendar_connections(id,user_id,workspace_id,provider,account_key,account_name,tokens,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(user_id,workspace_id,provider) DO UPDATE SET id=excluded.id,workspace_id=excluded.workspace_id,account_key=excluded.account_key,account_name=excluded.account_name,tokens=excluded.tokens,created_at=excluded.created_at,last_sync=NULL,last_error=NULL,event_count=0",
          )
          .run(
            callbackId,
            user.id,
            user.workspaceId,
            p,
            identity.key,
            identity.name,
            encrypt(tokens, c.key, aad(user, p)),
            new Date(now()).toISOString(),
          );
        res.redirect(
          `${origin()}/app/settings?tab=integrations&calendar=connected`,
        );
      } finally {
        if (callbacks.get(`${user.workspaceId}:${user.id}:${p}`) === callbackId)
          callbacks.delete(`${user.workspaceId}:${user.id}:${p}`);
      }
    }),
  );
  app.delete(
    "/api/calendar/:provider",
    route((req, res) => {
      const user = authorize(req),
        p = provider(req);
      callbacks.delete(`${user.workspaceId}:${user.id}:${p}`);
      store.db
        .prepare(
          "DELETE FROM calendar_connections WHERE user_id = ? AND workspace_id = ? AND provider = ?",
        )
        .run(user.id, user.workspaceId, p);
      store.db
        .prepare(
          "DELETE FROM calendar_oauth_states WHERE user_id = ? AND workspace_id = ? AND provider = ?",
        )
        .run(user.id, user.workspaceId, p);
      res.json({ ok: true });
    }),
  );
  app.post(
    "/api/calendar/:provider/sync",
    route(async (req, res) => {
      const user = authorize(req),
        p = provider(req),
        c = config(p),
        row = connection(user, p);
      if (!row) return fail(409, "Connect your calendar before syncing.");
      const busyKey = `${user.workspaceId}:${user.id}:${p}`;
      if (busy.has(busyKey))
        return fail(409, "A calendar sync is already running.");
      busy.add(busyKey);
      try {
        let tokens = decrypt<Tokens>(row.tokens, c.key, aad(user, p));
        if (tokens.expiresAt <= now() + 60000) {
          tokens = await tokenRequest(
            p,
            {
              grant_type: "refresh_token",
              refresh_token: tokens.refreshToken,
              ...(p === "microsoft" ? { scope: definitions[p].scope } : {}),
            },
            tokens,
          );
          current(user, p, row.id);
          store.db
            .prepare("UPDATE calendar_connections SET tokens = ? WHERE id = ?")
            .run(encrypt(tokens, c.key, aad(user, p)), row.id);
        }
        const from = new Date(now()).toISOString(),
          until = new Date(now() + 30 * DAY).toISOString();
        const imported = await events(p, tokens, from, until);
        current(user, p, row.id);
        if (sessionUser(store, req)?.workspaceId !== user.workspaceId)
          return fail(401, "Your session ended. Sign in and sync again.");
        const stamp = new Date(now()).toISOString();
        let created = 0,
          updated = 0,
          cancelled = 0;
        store.transaction(() => {
          for (const event of imported) {
            const mapping = store.db
              .prepare(
                "SELECT conversation_id FROM calendar_imports WHERE user_id = ? AND workspace_id = ? AND provider = ? AND account_key = ? AND event_id = ?",
              )
              .get(user.id, user.workspaceId, p, row.account_key, event.id);
            const previous = mapping?.conversation_id
              ? store.get(
                  user.workspaceId,
                  "conversations",
                  String(mapping.conversation_id),
                )
              : undefined;
            if (mapping && !previous) continue; // A locally deleted conversation stays deleted on later syncs.
            if (event.cancelled && !previous) continue;
            const metadata = {
              provider: p,
              eventId: event.id,
              title: event.title,
              start: event.start,
              end: event.end,
              status: event.cancelled ? "cancelled" : "scheduled",
              meetingUrl: event.meetingUrl,
              syncedAt: stamp,
            };
            if (previous) {
              // Only refresh untouched scheduling fields. Human titles, transcripts and note sections survive.
              const old = previous.calendar as
                Partial<typeof metadata> | undefined;
              const scheduling: Record<string, unknown> = {};
              if (previous.title === old?.title && !event.cancelled)
                scheduling.title = event.title;
              if (previous.date === old?.start && event.start)
                scheduling.date = event.start;
              if (event.cancelled) scheduling.archived = true;
              store.update(user.workspaceId, "conversations", {
                ...previous,
                ...scheduling,
                calendar: metadata,
                updatedAt: stamp,
              });
              updated++;
              if (event.cancelled) cancelled++;
            } else {
              const id = randomUUID();
              store.insert(user.workspaceId, "conversations", {
                id,
                createdAt: stamp,
                updatedAt: stamp,
                title: event.title,
                date: event.start,
                duration: Math.max(
                  0,
                  Math.round(
                    (Date.parse(event.end) - Date.parse(event.start)) / 60000,
                  ),
                ),
                interviewer: user.name,
                candidate: "",
                transcript: "",
                sections: [],
                tldr: "",
                status: "upcoming",
                archived: false,
                collectionIds: [],
                calendar: metadata,
              });
              registerConversationOwner(store, user.workspaceId, id, user.id);
              store.db
                .prepare(
                  "INSERT INTO calendar_imports(user_id,workspace_id,provider,account_key,event_id,conversation_id,source_start,source_end) VALUES(?,?,?,?,?,?,?,?)",
                )
                .run(
                  user.id,
                  user.workspaceId,
                  p,
                  row.account_key,
                  event.id,
                  id,
                  event.start,
                  event.end,
                );
              created++;
            }
            if (event.start && event.end)
              store.db
                .prepare(
                  "UPDATE calendar_imports SET source_start=?,source_end=? WHERE user_id=? AND workspace_id=? AND provider=? AND account_key=? AND event_id=?",
                )
                .run(
                  event.start,
                  event.end,
                  user.id,
                  user.workspaceId,
                  p,
                  row.account_key,
                  event.id,
                );
          }
          store.db
            .prepare(
              "UPDATE calendar_connections SET last_sync=?,last_error=NULL,event_count=? WHERE id=?",
            )
            .run(stamp, imported.filter((e) => !e.cancelled).length, row.id);
        });
        res.json({
          ok: true,
          created,
          updated,
          cancelled,
          eventCount: imported.filter((e) => !e.cancelled).length,
          lastSync: stamp,
        });
      } catch (error) {
        if (error instanceof CalendarError)
          store.db
            .prepare(
              "UPDATE calendar_connections SET last_error = ? WHERE id = ?",
            )
            .run(error.message, row.id);
        throw error;
      } finally {
        busy.delete(busyKey);
      }
    }),
  );
}
