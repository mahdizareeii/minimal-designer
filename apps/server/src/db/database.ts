import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import * as schema from "./schema.js";

const migrationSql = `
CREATE TABLE IF NOT EXISTS designs (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  name TEXT NOT NULL,
  current_version INTEGER NOT NULL,
  current_revision_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS designs_actor_updated ON designs(actor_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS revisions (
  id TEXT PRIMARY KEY,
  design_id TEXT NOT NULL REFERENCES designs(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL,
  parent_revision_id TEXT,
  actor_id TEXT NOT NULL,
  message TEXT,
  document_json TEXT NOT NULL,
  operations_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(design_id, version)
);
CREATE INDEX IF NOT EXISTS revisions_design_created ON revisions(design_id, version DESC);

CREATE TRIGGER IF NOT EXISTS revisions_immutable_update
BEFORE UPDATE ON revisions BEGIN SELECT RAISE(ABORT, 'revisions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS revisions_immutable_delete
BEFORE DELETE ON revisions BEGIN SELECT RAISE(ABORT, 'revisions are immutable'); END;

CREATE TABLE IF NOT EXISTS previews (
  id TEXT PRIMARY KEY,
  design_id TEXT NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL,
  root_base_version INTEGER NOT NULL,
  base_preview_id TEXT,
  operation_hash TEXT NOT NULL,
  operations_json TEXT NOT NULL,
  document_json TEXT NOT NULL,
  diagnostics_json TEXT NOT NULL,
  committable INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS previews_actor_expiry ON previews(actor_id, expires_at);

CREATE TABLE IF NOT EXISTS idempotency (
  actor_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY(actor_id, scope, key)
);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  design_id TEXT REFERENCES designs(id) ON DELETE SET NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  data BLOB NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS assets_actor_created ON assets(actor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS contexts (
  actor_id TEXT PRIMARY KEY,
  design_id TEXT,
  page_id TEXT,
  selection_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export class DesignerDatabase {
  readonly sqlite: Database.Database;
  readonly orm: ReturnType<typeof drizzle<typeof schema>>;

  constructor(filename: string) {
    if (filename !== ":memory:") fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.sqlite = new Database(filename);
    this.sqlite.pragma("foreign_keys = ON");
    this.sqlite.pragma("busy_timeout = 5000");
    if (filename !== ":memory:") this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("synchronous = NORMAL");
    this.sqlite.exec(migrationSql);
    this.orm = drizzle(this.sqlite, { schema });
  }

  close(): void {
    this.sqlite.close();
  }

  cleanup(now = new Date().toISOString()): void {
    this.cleanupPreviews(now);
    this.cleanupIdempotency(now);
  }

  cleanupPreviews(now = new Date().toISOString()): void {
    this.sqlite.prepare("DELETE FROM previews WHERE expires_at <= ?").run(now);
  }

  cleanupIdempotency(now = new Date().toISOString()): void {
    this.sqlite.prepare("DELETE FROM idempotency WHERE expires_at <= ?").run(now);
  }
}
