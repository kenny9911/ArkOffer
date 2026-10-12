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
