import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type Resource = Record<string, unknown> & {
  id: string;
  createdAt: string;
  updatedAt: string;
};

export class Store {
  readonly db: DatabaseSync;
  readonly dataDir: string;

  constructor(
    dataDir = process.env.DATA_DIR || resolve("data"),
    filename?: string,
  ) {
    this.dataDir = resolve(dataDir);
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    mkdirSync(resolve(this.dataDir, "uploads"), {
      recursive: true,
      mode: 0o700,
    });
    const path = filename || resolve(this.dataDir, "arkoffer.sqlite");
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, settings TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'owner', created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
      CREATE TABLE IF NOT EXISTS resources (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), kind TEXT NOT NULL,
        data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS resources_workspace_kind ON resources(workspace_id, kind, updated_at);
      CREATE TABLE IF NOT EXISTS deleted_collections (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), deleted_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS versions (
        id TEXT PRIMARY KEY, resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id), data TEXT NOT NULL, label TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS versions_resource ON versions(resource_id, created_at);
      CREATE TABLE IF NOT EXISTS shares (
        id TEXT PRIMARY KEY, resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id), token_hash TEXT NOT NULL UNIQUE,
        expires_at INTEGER NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS shares_workspace_expiry ON shares(workspace_id, expires_at);
      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY, resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id), stored_name TEXT NOT NULL,
        original_name TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS submissions (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL
      );
    `);
    // Backfill legacy single-workspace accounts exactly once. Reopening the
    // database must not restore memberships an administrator has removed.
    this.transaction(() => {
      const hasMemberships = this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memberships'",
        )
        .get();
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS memberships (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('owner', 'admin', 'member')),
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'suspended')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS memberships_user ON memberships(user_id, status);
    `);
      if (!hasMemberships)
        this.db
          .exec(`INSERT INTO memberships (workspace_id, user_id, role, created_at, updated_at)
        SELECT workspace_id, id, CASE WHEN role IN ('owner', 'admin', 'member') THEN role ELSE 'member' END,
        created_at, created_at FROM users;`);
      const sessionColumns = this.db
        .prepare("PRAGMA table_info(sessions)")
        .all();
      if (!sessionColumns.some((column) => column.name === "workspace_id"))
        this.db
          .exec(`ALTER TABLE sessions ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
        UPDATE sessions SET workspace_id = (SELECT workspace_id FROM users WHERE id = sessions.user_id);`);
      if (!sessionColumns.some((column) => column.name === "public_id"))
        this.db.exec(`ALTER TABLE sessions ADD COLUMN public_id TEXT;
          UPDATE sessions SET public_id = lower(hex(randomblob(16)));`);
      if (!sessionColumns.some((column) => column.name === "user_agent"))
        this.db.exec(
          "ALTER TABLE sessions ADD COLUMN user_agent TEXT NOT NULL DEFAULT '';",
        );
      if (!sessionColumns.some((column) => column.name === "last_seen_at"))
        this.db.exec("ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER;");
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS sessions_public_id ON sessions(public_id);",
      );
      const userColumns = this.db.prepare("PRAGMA table_info(users)").all();
      if (!userColumns.some((column) => column.name === "email_verified_at"))
        this.db.exec("ALTER TABLE users ADD COLUMN email_verified_at TEXT;");
      this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS users_initial_membership AFTER INSERT ON users BEGIN
        INSERT INTO memberships (workspace_id, user_id, role, created_at, updated_at)
        VALUES (NEW.workspace_id, NEW.id,
          CASE WHEN NEW.role IN ('owner', 'admin', 'member') THEN NEW.role ELSE 'member' END,
          NEW.created_at, NEW.created_at);
      END;
    `);
    });
  }

  close() {
    this.db.close();
  }

  transaction<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  list(workspaceId: string, kind: string): Resource[] {
    return this.db
      .prepare(
        "SELECT data FROM resources WHERE workspace_id = ? AND kind = ? ORDER BY updated_at DESC",
      )
      .all(workspaceId, kind)
      .map((row) => JSON.parse(row.data as string) as Resource);
  }

  get(workspaceId: string, kind: string, id: string): Resource | undefined {
    const row = this.db
      .prepare(
        "SELECT data FROM resources WHERE workspace_id = ? AND kind = ? AND id = ?",
      )
      .get(workspaceId, kind, id);
    return row ? (JSON.parse(row.data as string) as Resource) : undefined;
  }

  insert(workspaceId: string, kind: string, data: Resource) {
    this.db
      .prepare(
        "INSERT INTO resources (id, workspace_id, kind, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        data.id,
        workspaceId,
        kind,
        JSON.stringify(data),
        data.createdAt,
        data.updatedAt,
      );
    return data;
  }

  update(workspaceId: string, kind: string, data: Resource) {
    const previous = this.db
      .prepare(
        "SELECT updated_at FROM resources WHERE workspace_id = ? AND kind = ? AND id = ?",
      )
      .get(workspaceId, kind, data.id);
    const previousTime = previous
      ? Date.parse(previous.updated_at as string)
      : 0;
    // Provider concurrency checks must also detect two edits inside one millisecond.
    if (Date.parse(data.updatedAt) <= previousTime)
      data.updatedAt = new Date(previousTime + 1).toISOString();
    this.db
      .prepare(
        "UPDATE resources SET data = ?, updated_at = ? WHERE workspace_id = ? AND kind = ? AND id = ?",
      )
      .run(JSON.stringify(data), data.updatedAt, workspaceId, kind, data.id);
    return data;
  }
}

export const createDatabase = (dataDir?: string, filename?: string) =>
  new Store(dataDir, filename);
