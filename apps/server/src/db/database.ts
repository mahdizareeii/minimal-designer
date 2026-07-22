import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { DesignDocumentSchema, DesignOperationListSchema } from "@designer/core";

import {
  DEFAULT_RUNTIME_VERSIONS,
  changedNodeIds,
  operationHash,
  readSnapshotJson,
  revisionHash,
  storeSnapshot,
} from "../persistence.js";
import { cleanupRetainedRenderJobs } from "../render-job-store.js";
import * as schema from "./schema.js";

export interface DatabaseMigrationLedgerEntry {
  readonly version: number;
  readonly name: string;
}

interface Migration extends DatabaseMigrationLedgerEntry {
  up: (sqlite: Database.Database) => void;
}

// Migration 2 is immutable historical DDL. Runtime version bumps must update
// current metadata and newly written rows without rewriting the SQL bytes of
// every historical schema prefix.
const MIGRATION_2_RUNTIME_DEFAULTS = Object.freeze({
  commandEngine: "1",
  renderer: "2",
  fontBundle: "1",
});

const baselineSql = `
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

function columnNames(sqlite: Database.Database, table: string): Set<string> {
  const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function addColumn(sqlite: Database.Database, table: string, definition: string): void {
  const name = definition.trim().split(/\s+/, 1)[0];
  if (name && !columnNames(sqlite, table).has(name)) sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

function parseStoredJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`Cannot migrate invalid ${label} JSON.`, { cause: error });
  }
}

function parseStoredDocument(value: string, label: string) {
  const parsed = DesignDocumentSchema.safeParse(parseStoredJson(value, label));
  if (!parsed.success) throw new Error(`Cannot migrate schema-invalid ${label}.`, { cause: parsed.error });
  return parsed.data;
}

function parseStoredOperations(value: string, label: string) {
  const parsed = DesignOperationListSchema.safeParse(parseStoredJson(value, label));
  if (!parsed.success) throw new Error(`Cannot migrate schema-invalid ${label}.`, { cause: parsed.error });
  return parsed.data;
}

function addPersistenceIntegrity(sqlite: Database.Database): void {
  sqlite.exec(`
    DROP TRIGGER IF EXISTS revisions_immutable_update;
    DROP TRIGGER IF EXISTS revisions_immutable_delete;

    CREATE TABLE IF NOT EXISTS system_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      snapshot_hash TEXT PRIMARY KEY,
      encoding TEXT NOT NULL CHECK(encoding = 'br'),
      document_brotli BLOB NOT NULL,
      uncompressed_bytes INTEGER NOT NULL CHECK(uncompressed_bytes >= 0),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS event_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      workspace INTEGER NOT NULL CHECK(workspace IN (0, 1)),
      created_at TEXT NOT NULL,
      published_at TEXT
    );
    CREATE INDEX IF NOT EXISTS event_outbox_unpublished ON event_outbox(published_at, id);
  `);

  addColumn(sqlite, "revisions", "snapshot_hash TEXT REFERENCES snapshots(snapshot_hash)");
  addColumn(sqlite, "revisions", "operation_hash TEXT");
  addColumn(sqlite, "revisions", "parent_revision_hash TEXT");
  addColumn(sqlite, "revisions", "revision_hash TEXT");

  addColumn(sqlite, "previews", "base_revision_id TEXT");
  addColumn(sqlite, "previews", "base_snapshot_hash TEXT REFERENCES snapshots(snapshot_hash)");
  addColumn(sqlite, "previews", "result_snapshot_hash TEXT REFERENCES snapshots(snapshot_hash)");
  addColumn(sqlite, "previews", "temporary_id_map_json TEXT NOT NULL DEFAULT '{}'");
  addColumn(sqlite, "previews", "created_ids_json TEXT NOT NULL DEFAULT '{}'");
  addColumn(sqlite, "previews", "changed_node_ids_json TEXT NOT NULL DEFAULT '[]'");
  addColumn(sqlite, "previews", `command_engine_version TEXT NOT NULL DEFAULT '${MIGRATION_2_RUNTIME_DEFAULTS.commandEngine}'`);
  addColumn(sqlite, "previews", `renderer_version TEXT NOT NULL DEFAULT '${MIGRATION_2_RUNTIME_DEFAULTS.renderer}'`);
  addColumn(sqlite, "previews", `font_bundle_version TEXT NOT NULL DEFAULT '${MIGRATION_2_RUNTIME_DEFAULTS.fontBundle}'`);
  addColumn(sqlite, "previews", "status TEXT NOT NULL DEFAULT 'ready'");
  addColumn(sqlite, "previews", "kind TEXT NOT NULL DEFAULT 'ordinary'");
  addColumn(sqlite, "previews", "committed_revision_id TEXT");
  addColumn(sqlite, "previews", "committed_at TEXT");

  const revisionRows = sqlite.prepare(
    `SELECT id, design_id, version, parent_revision_id, actor_id, message,
            document_json, operations_json, created_at
     FROM revisions ORDER BY design_id, version`,
  ).all() as Array<{
    id: string;
    design_id: string;
    version: number;
    parent_revision_id: string | null;
    actor_id: string;
    message: string | null;
    document_json: string;
    operations_json: string;
    created_at: string;
  }>;
  const priorRevisions = new Map<string, { id: string; version: number; hash: string }>();
  for (const row of revisionRows) {
    const document = parseStoredDocument(row.document_json, `revision ${row.id} document`);
    const snapshot = storeSnapshot(sqlite, document, row.created_at);
    const operations = parseStoredOperations(row.operations_json, `revision ${row.id} operations`);
    const operationsHash = operationHash(operations);
    const prior = priorRevisions.get(row.design_id);
    if (row.version === 1) {
      if (prior || row.parent_revision_id !== null) {
        throw new Error(`Revision ${row.id} has an invalid initial parent chain.`);
      }
    } else if (!prior || prior.version !== row.version - 1 || prior.id !== row.parent_revision_id) {
      throw new Error(`Revision ${row.id} has a broken parent chain.`);
    }
    const parentHash = prior?.hash ?? null;
    const integrityHash = revisionHash({
      parentRevisionHash: parentHash,
      snapshotHash: snapshot.hash,
      operationHash: operationsHash,
      metadata: {
        id: row.id,
        designId: row.design_id,
        version: row.version,
        parentRevisionId: row.parent_revision_id,
        actorId: row.actor_id,
        message: row.message,
        createdAt: row.created_at,
      },
    });
    sqlite.prepare(
      `UPDATE revisions SET snapshot_hash = ?, operation_hash = ?, parent_revision_hash = ?, revision_hash = ?
       WHERE id = ?`,
    ).run(snapshot.hash, operationsHash, parentHash, integrityHash, row.id);
    priorRevisions.set(row.design_id, { id: row.id, version: row.version, hash: integrityHash });
  }

  const designHeads = sqlite.prepare(
    "SELECT id, current_version, current_revision_id FROM designs",
  ).all() as Array<{ id: string; current_version: number; current_revision_id: string }>;
  for (const design of designHeads) {
    const last = priorRevisions.get(design.id);
    if (!last || last.version !== design.current_version || last.id !== design.current_revision_id) {
      throw new Error(`Design ${design.id} has an invalid revision head.`);
    }
  }

  const now = new Date().toISOString();
  const previewRows = sqlite.prepare(
    `SELECT id, design_id, root_base_version, operations_json, document_json,
            committable, created_at, expires_at FROM previews`,
  ).all() as Array<{
    id: string;
    design_id: string;
    root_base_version: number;
    operations_json: string;
    document_json: string;
    committable: number;
    created_at: string;
    expires_at: string;
  }>;
  const revisionLookup = sqlite.prepare(
    "SELECT id, snapshot_hash FROM revisions WHERE design_id = ? AND version = ?",
  );
  for (const row of previewRows) {
    const base = revisionLookup.get(row.design_id, row.root_base_version) as {
      id: string;
      snapshot_hash: string;
    } | undefined;
    if (!base) throw new Error(`Preview ${row.id} references a missing base revision.`);
    const resultDocument = parseStoredDocument(row.document_json, `preview ${row.id} document`);
    if (resultDocument.revision !== row.root_base_version + 1) {
      throw new Error(`Preview ${row.id} has an invalid result revision.`);
    }
    const resultSnapshot = storeSnapshot(sqlite, resultDocument, row.created_at);
    const operations = parseStoredOperations(row.operations_json, `preview ${row.id} operations`);
    const previewOperationHash = operationHash(operations);
    const baseDocument = parseStoredDocument(
      readSnapshotJson(sqlite, base.snapshot_hash),
      `preview ${row.id} base snapshot`,
    );
    const kind = Array.isArray(operations)
      && operations.some((value) => {
        if (typeof value !== "object" || value === null) return false;
        const type = (value as { type?: unknown }).type;
        return type === "archive_nodes" || type === "archive_page";
      })
      ? "archive"
      : "ordinary";
    const status = row.expires_at <= now ? "expired" : row.committable === 1 ? "ready" : "blocked";
    sqlite.prepare(
      `UPDATE previews SET base_revision_id = ?, base_snapshot_hash = ?, result_snapshot_hash = ?,
       operation_hash = ?, changed_node_ids_json = ?, status = ?, kind = ? WHERE id = ?`,
    ).run(
      base.id,
      base.snapshot_hash,
      resultSnapshot.hash,
      previewOperationHash,
      JSON.stringify(changedNodeIds(baseDocument, resultDocument)),
      status,
      kind,
      row.id,
    );
  }

  sqlite.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS revisions_revision_hash ON revisions(revision_hash);
    CREATE INDEX IF NOT EXISTS previews_status_expiry ON previews(status, expires_at);

    CREATE TRIGGER revisions_require_integrity
    BEFORE INSERT ON revisions
    WHEN NEW.snapshot_hash IS NULL OR NEW.operation_hash IS NULL OR NEW.revision_hash IS NULL
      OR (NEW.version = 1 AND (NEW.parent_revision_id IS NOT NULL OR NEW.parent_revision_hash IS NOT NULL))
      OR (NEW.version > 1 AND (NEW.parent_revision_id IS NULL OR NEW.parent_revision_hash IS NULL))
      OR (NEW.version > 1 AND NOT EXISTS (
        SELECT 1 FROM revisions
        WHERE id = NEW.parent_revision_id AND design_id = NEW.design_id
          AND version = NEW.version - 1 AND revision_hash = NEW.parent_revision_hash
      ))
    BEGIN SELECT RAISE(ABORT, 'revision integrity metadata is required'); END;

    CREATE TRIGGER revisions_immutable_update
    BEFORE UPDATE ON revisions BEGIN SELECT RAISE(ABORT, 'revisions are immutable'); END;
    CREATE TRIGGER revisions_immutable_delete
    BEFORE DELETE ON revisions BEGIN SELECT RAISE(ABORT, 'revisions are immutable'); END;

    CREATE TRIGGER previews_require_integrity_insert
    BEFORE INSERT ON previews
    WHEN NEW.base_revision_id IS NULL OR NEW.base_snapshot_hash IS NULL OR NEW.result_snapshot_hash IS NULL
      OR NEW.temporary_id_map_json IS NULL OR NEW.created_ids_json IS NULL OR NEW.changed_node_ids_json IS NULL
      OR NEW.command_engine_version IS NULL OR NEW.renderer_version IS NULL OR NEW.font_bundle_version IS NULL
      OR NEW.status NOT IN ('ready', 'blocked', 'expired', 'committed')
      OR NEW.kind NOT IN ('ordinary', 'archive')
      OR NOT EXISTS (
        SELECT 1 FROM revisions
        WHERE id = NEW.base_revision_id AND design_id = NEW.design_id
          AND version = NEW.root_base_version AND snapshot_hash = NEW.base_snapshot_hash
      )
      OR (NEW.status = 'committed' AND (NEW.committed_revision_id IS NULL OR NEW.committed_at IS NULL))
      OR (NEW.status <> 'committed' AND (NEW.committed_revision_id IS NOT NULL OR NEW.committed_at IS NOT NULL))
      OR (NEW.status = 'committed' AND NOT EXISTS (
        SELECT 1 FROM revisions
        WHERE id = NEW.committed_revision_id AND design_id = NEW.design_id
          AND version = NEW.root_base_version + 1 AND snapshot_hash = NEW.result_snapshot_hash
      ))
    BEGIN SELECT RAISE(ABORT, 'preview integrity metadata is required'); END;

    CREATE TRIGGER previews_require_integrity_update
    BEFORE UPDATE ON previews
    WHEN NEW.base_revision_id IS NULL OR NEW.base_snapshot_hash IS NULL OR NEW.result_snapshot_hash IS NULL
      OR NEW.temporary_id_map_json IS NULL OR NEW.created_ids_json IS NULL OR NEW.changed_node_ids_json IS NULL
      OR NEW.command_engine_version IS NULL OR NEW.renderer_version IS NULL OR NEW.font_bundle_version IS NULL
      OR NEW.status NOT IN ('ready', 'blocked', 'expired', 'committed')
      OR NEW.kind NOT IN ('ordinary', 'archive')
      OR NOT EXISTS (
        SELECT 1 FROM revisions
        WHERE id = NEW.base_revision_id AND design_id = NEW.design_id
          AND version = NEW.root_base_version AND snapshot_hash = NEW.base_snapshot_hash
      )
      OR (NEW.status = 'committed' AND (NEW.committed_revision_id IS NULL OR NEW.committed_at IS NULL))
      OR (NEW.status <> 'committed' AND (NEW.committed_revision_id IS NOT NULL OR NEW.committed_at IS NOT NULL))
      OR (NEW.status = 'committed' AND NOT EXISTS (
        SELECT 1 FROM revisions
        WHERE id = NEW.committed_revision_id AND design_id = NEW.design_id
          AND version = NEW.root_base_version + 1 AND snapshot_hash = NEW.result_snapshot_hash
      ))
    BEGIN SELECT RAISE(ABORT, 'preview integrity metadata is required'); END;

    CREATE TRIGGER snapshots_immutable_update
    BEFORE UPDATE ON snapshots BEGIN SELECT RAISE(ABORT, 'snapshots are immutable'); END;
    CREATE TRIGGER snapshots_immutable_delete
    BEFORE DELETE ON snapshots BEGIN SELECT RAISE(ABORT, 'snapshots are immutable'); END;

    CREATE TRIGGER schema_migrations_immutable_update
    BEFORE UPDATE ON schema_migrations BEGIN SELECT RAISE(ABORT, 'schema migrations are immutable'); END;
    CREATE TRIGGER schema_migrations_immutable_delete
    BEFORE DELETE ON schema_migrations BEGIN SELECT RAISE(ABORT, 'schema migrations are immutable'); END;
  `);
}

function addEnterpriseWorkflowFoundation(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      config_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS principals (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      kind TEXT NOT NULL CHECK(kind IN ('local', 'human', 'agent')),
      display_name TEXT NOT NULL,
      external_id TEXT,
      created_at TEXT NOT NULL,
      disabled_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS principals_org_external
      ON principals(organization_id, external_id) WHERE external_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS memberships (
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
      role TEXT NOT NULL CHECK(role IN ('organization_admin', 'product_manager', 'design_editor', 'engineer', 'viewer', 'agent')),
      created_at TEXT NOT NULL,
      PRIMARY KEY(organization_id, principal_id)
    );

    CREATE TABLE IF NOT EXISTS agent_grants (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
      token_hash TEXT NOT NULL UNIQUE,
      scopes_json TEXT NOT NULL,
      project_ids_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      last_used_at TEXT
    );

    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT,
      details_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS audit_events_org_created ON audit_events(organization_id, created_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS agent_tasks (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      design_id TEXT NOT NULL REFERENCES designs(id) ON DELETE RESTRICT,
      actor_id TEXT NOT NULL,
      brief TEXT NOT NULL,
      selection_json TEXT NOT NULL,
      base_version INTEGER NOT NULL,
      expected_output TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agent_tasks_design_created ON agent_tasks(design_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS agent_task_transitions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE RESTRICT,
      from_status TEXT,
      to_status TEXT NOT NULL CHECK(to_status IN ('queued', 'claimed', 'in_progress', 'awaiting_approval', 'completed', 'failed', 'cancelled', 'expired')),
      actor_id TEXT NOT NULL,
      message TEXT,
      data_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agent_task_transitions_task_created ON agent_task_transitions(task_id, created_at, id);

    CREATE TABLE IF NOT EXISTS planning_sessions (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      design_id TEXT NOT NULL REFERENCES designs(id) ON DELETE RESTRICT,
      version INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('draft', 'in_progress', 'ready_for_review', 'completed', 'cancelled')),
      current_section TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS planning_answers (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES planning_sessions(id) ON DELETE RESTRICT,
      section TEXT NOT NULL,
      version INTEGER NOT NULL,
      answer TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(session_id, section, version)
    );

    CREATE TABLE IF NOT EXISTS product_specifications (
      design_id TEXT NOT NULL REFERENCES designs(id) ON DELETE RESTRICT,
      version INTEGER NOT NULL,
      specification_json TEXT NOT NULL,
      revision_id TEXT REFERENCES revisions(id) ON DELETE RESTRICT,
      actor_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(design_id, version)
    );

    CREATE TABLE IF NOT EXISTS product_spec_previews (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      design_id TEXT NOT NULL REFERENCES designs(id) ON DELETE RESTRICT,
      actor_id TEXT NOT NULL,
      base_version INTEGER NOT NULL,
      specification_json TEXT NOT NULL,
      specification_hash TEXT NOT NULL,
      diagnostics_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('ready', 'blocked', 'expired', 'committed')),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      committed_version INTEGER
    );
    CREATE INDEX IF NOT EXISTS product_spec_previews_design_expiry ON product_spec_previews(design_id, expires_at);

    CREATE TABLE IF NOT EXISTS agent_connections (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      principal_id TEXT REFERENCES principals(id) ON DELETE RESTRICT,
      adapter TEXT NOT NULL,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'active', 'expired', 'revoked', 'error')),
      scopes_json TEXT NOT NULL,
      project_ids_json TEXT NOT NULL DEFAULT '[]',
      expires_at TEXT,
      last_used_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pairing_nonces (
      nonce_hash TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL REFERENCES agent_connections(id) ON DELETE CASCADE,
      created_by TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS backup_records (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      filename TEXT NOT NULL,
      bundle_sha256 TEXT,
      status TEXT NOT NULL CHECK(status IN ('creating', 'valid', 'invalid', 'restored')),
      manifest_json TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      verified_at TEXT
    );

    CREATE TABLE IF NOT EXISTS backup_schedules (
      organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE RESTRICT,
      enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
      cron_expression TEXT NOT NULL DEFAULT '0 2 * * *',
      daily_retention INTEGER NOT NULL DEFAULT 7,
      weekly_retention INTEGER NOT NULL DEFAULT 4,
      monthly_retention INTEGER NOT NULL DEFAULT 12,
      updated_at TEXT NOT NULL
    );
  `);

  addColumn(sqlite, "designs", "organization_id TEXT REFERENCES organizations(id)");
  addColumn(sqlite, "assets", "organization_id TEXT REFERENCES organizations(id)");
  addColumn(sqlite, "previews", "organization_id TEXT REFERENCES organizations(id)");
  addColumn(sqlite, "contexts", "organization_id TEXT REFERENCES organizations(id)");

  const now = new Date().toISOString();
  sqlite.prepare(
    `INSERT OR IGNORE INTO organizations (id, name, config_json, created_at, updated_at)
     VALUES ('organization_legacy', 'FormaSpec workspace', '{}', ?, ?)`,
  ).run(now, now);
  sqlite.prepare(
    `INSERT OR IGNORE INTO principals (id, organization_id, kind, display_name, external_id, created_at)
     VALUES ('principal_local', 'organization_legacy', 'local', 'Local administrator', 'local', ?)`,
  ).run(now);
  sqlite.prepare(
    `INSERT OR IGNORE INTO memberships (organization_id, principal_id, role, created_at)
     VALUES ('organization_legacy', 'principal_local', 'organization_admin', ?)`,
  ).run(now);
  sqlite.prepare("UPDATE designs SET organization_id = 'organization_legacy' WHERE organization_id IS NULL").run();
  sqlite.prepare("UPDATE assets SET organization_id = 'organization_legacy' WHERE organization_id IS NULL").run();
  sqlite.prepare("UPDATE previews SET organization_id = 'organization_legacy' WHERE organization_id IS NULL").run();
  sqlite.prepare("UPDATE contexts SET organization_id = 'organization_legacy' WHERE organization_id IS NULL").run();

  sqlite.exec(`
    CREATE TRIGGER IF NOT EXISTS audit_events_immutable_update
    BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit events are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS audit_events_immutable_delete
    BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit events are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS agent_tasks_immutable_update
    BEFORE UPDATE ON agent_tasks BEGIN SELECT RAISE(ABORT, 'agent tasks are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS agent_tasks_immutable_delete
    BEFORE DELETE ON agent_tasks BEGIN SELECT RAISE(ABORT, 'agent tasks are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS agent_task_transitions_immutable_update
    BEFORE UPDATE ON agent_task_transitions BEGIN SELECT RAISE(ABORT, 'agent task transitions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS agent_task_transitions_immutable_delete
    BEFORE DELETE ON agent_task_transitions BEGIN SELECT RAISE(ABORT, 'agent task transitions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS planning_answers_immutable_update
    BEFORE UPDATE ON planning_answers BEGIN SELECT RAISE(ABORT, 'planning answers are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS planning_answers_immutable_delete
    BEFORE DELETE ON planning_answers BEGIN SELECT RAISE(ABORT, 'planning answers are immutable'); END;
  `);
}

function addPreviewRetention(sqlite: Database.Database): void {
  sqlite.exec(`
    DROP TRIGGER IF EXISTS snapshots_immutable_delete;
    CREATE INDEX IF NOT EXISTS revisions_snapshot_lookup ON revisions(snapshot_hash);
    CREATE INDEX IF NOT EXISTS previews_base_snapshot_lookup ON previews(base_snapshot_hash);
    CREATE INDEX IF NOT EXISTS previews_result_snapshot_lookup ON previews(result_snapshot_hash);
    CREATE TRIGGER snapshots_referenced_delete
    BEFORE DELETE ON snapshots
    WHEN EXISTS (SELECT 1 FROM revisions WHERE snapshot_hash = OLD.snapshot_hash)
      OR EXISTS (SELECT 1 FROM previews WHERE base_snapshot_hash = OLD.snapshot_hash OR result_snapshot_hash = OLD.snapshot_hash)
    BEGIN SELECT RAISE(ABORT, 'referenced snapshots cannot be deleted'); END;
  `);
}

function addOrganizationScopedOutbox(sqlite: Database.Database): void {
  addColumn(sqlite, "event_outbox", "organization_id TEXT REFERENCES organizations(id)");
  sqlite.prepare(
    "UPDATE event_outbox SET organization_id = 'organization_legacy' WHERE organization_id IS NULL",
  ).run();
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS event_outbox_org_id ON event_outbox(organization_id, id);
    CREATE TRIGGER event_outbox_require_organization_insert
    BEFORE INSERT ON event_outbox
    WHEN NEW.organization_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM organizations WHERE id = NEW.organization_id
    )
    BEGIN SELECT RAISE(ABORT, 'event outbox organization is required'); END;
    CREATE TRIGGER event_outbox_require_organization_update
    BEFORE UPDATE ON event_outbox
    WHEN NEW.organization_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM organizations WHERE id = NEW.organization_id
    )
      OR NEW.organization_id <> OLD.organization_id
      OR NEW.actor_id <> OLD.actor_id
      OR NEW.event_type <> OLD.event_type
      OR NEW.payload_json <> OLD.payload_json
      OR NEW.workspace <> OLD.workspace
      OR NEW.created_at <> OLD.created_at
      OR (OLD.published_at IS NOT NULL AND NEW.published_at IS NOT OLD.published_at)
    BEGIN SELECT RAISE(ABORT, 'event outbox organization is required'); END;
  `);
}

function addEnterpriseWorkflowIntegrity(sqlite: Database.Database): void {
  // product_spec_previews was added to the v3 function after some databases had
  // already recorded v3. Keep this catch-up migration permanently idempotent.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS product_spec_previews (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      design_id TEXT NOT NULL REFERENCES designs(id) ON DELETE RESTRICT,
      actor_id TEXT NOT NULL,
      base_version INTEGER NOT NULL CHECK(base_version >= 0),
      specification_json TEXT NOT NULL,
      specification_hash TEXT NOT NULL,
      diagnostics_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('ready', 'blocked', 'expired', 'committed')),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      committed_version INTEGER,
      committed_at TEXT,
      commit_actor_id TEXT
    );
    CREATE INDEX IF NOT EXISTS product_spec_previews_design_expiry
      ON product_spec_previews(design_id, expires_at);

    CREATE TABLE IF NOT EXISTS planning_session_versions (
      session_id TEXT NOT NULL REFERENCES planning_sessions(id) ON DELETE RESTRICT,
      version INTEGER NOT NULL CHECK(version > 0),
      status TEXT NOT NULL CHECK(status IN ('draft', 'in_progress', 'ready_for_review', 'completed', 'cancelled')),
      current_section TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(session_id, version)
    );
  `);

  addColumn(sqlite, "product_specifications", "organization_id TEXT REFERENCES organizations(id)");
  addColumn(sqlite, "product_specifications", "specification_hash TEXT");
  addColumn(sqlite, "product_specifications", "message TEXT");
  addColumn(sqlite, "product_spec_previews", "committed_at TEXT");
  addColumn(sqlite, "product_spec_previews", "commit_actor_id TEXT");
  addColumn(sqlite, "pairing_nonces", "created_at TEXT");
  addColumn(sqlite, "pairing_nonces", "revoked_at TEXT");

  sqlite.prepare(
    `UPDATE product_specifications
     SET organization_id = (SELECT organization_id FROM designs WHERE designs.id = product_specifications.design_id)
     WHERE organization_id IS NULL`,
  ).run();
  const specificationRows = sqlite.prepare(
    "SELECT design_id, version, specification_json FROM product_specifications WHERE specification_hash IS NULL",
  ).all() as Array<{ design_id: string; version: number; specification_json: string }>;
  const updateSpecificationHash = sqlite.prepare(
    "UPDATE product_specifications SET specification_hash = ? WHERE design_id = ? AND version = ?",
  );
  for (const row of specificationRows) {
    const hash = createHash("sha256").update(row.specification_json, "utf8").digest("hex");
    updateSpecificationHash.run(hash, row.design_id, row.version);
  }
  sqlite.prepare(
    `UPDATE pairing_nonces
     SET created_at = COALESCE(
       (SELECT created_at FROM agent_connections WHERE agent_connections.id = pairing_nonces.connection_id),
       expires_at
     )
     WHERE created_at IS NULL`,
  ).run();
  sqlite.prepare(
    `INSERT OR IGNORE INTO planning_session_versions
       (session_id, version, status, current_section, actor_id, created_at)
     SELECT id, version, status, current_section, 'principal_local', updated_at
     FROM planning_sessions`,
  ).run();

  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS product_specifications_org_design_version
      ON product_specifications(organization_id, design_id, version DESC);
    CREATE INDEX IF NOT EXISTS product_spec_previews_org_design_status
      ON product_spec_previews(organization_id, design_id, status, expires_at);
    CREATE INDEX IF NOT EXISTS planning_sessions_org_design_updated
      ON planning_sessions(organization_id, design_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS agent_tasks_org_design_created
      ON agent_tasks(organization_id, design_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS agent_connections_org_updated
      ON agent_connections(organization_id, updated_at DESC);

    CREATE TRIGGER IF NOT EXISTS product_specifications_require_integrity
    BEFORE INSERT ON product_specifications
    WHEN NEW.organization_id IS NULL
      OR NEW.specification_hash IS NULL
      OR length(NEW.specification_hash) <> 64
      OR json_valid(NEW.specification_json) = 0
      OR CAST(json_extract(NEW.specification_json, '$.version') AS INTEGER) <> NEW.version
      OR NOT EXISTS (
        SELECT 1 FROM designs
        WHERE id = NEW.design_id AND organization_id = NEW.organization_id
      )
    BEGIN SELECT RAISE(ABORT, 'product specification integrity metadata is required'); END;

    CREATE TRIGGER IF NOT EXISTS product_specifications_immutable_update
    BEFORE UPDATE ON product_specifications
    BEGIN SELECT RAISE(ABORT, 'product specifications are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS product_specifications_immutable_delete
    BEFORE DELETE ON product_specifications
    BEGIN SELECT RAISE(ABORT, 'product specifications are immutable'); END;

    CREATE TRIGGER IF NOT EXISTS product_spec_previews_require_integrity_insert
    BEFORE INSERT ON product_spec_previews
    WHEN NEW.base_version < 0
      OR length(NEW.specification_hash) <> 64
      OR json_valid(NEW.specification_json) = 0
      OR CAST(json_extract(NEW.specification_json, '$.version') AS INTEGER) <> NEW.base_version + 1
      OR NOT EXISTS (
        SELECT 1 FROM designs
        WHERE id = NEW.design_id AND organization_id = NEW.organization_id
      )
      OR (NEW.status = 'committed' AND (
        NEW.committed_version IS NULL OR NEW.committed_at IS NULL OR NEW.commit_actor_id IS NULL
        OR NEW.committed_version <> NEW.base_version + 1
        OR NOT EXISTS (
          SELECT 1 FROM product_specifications
          WHERE design_id = NEW.design_id AND version = NEW.committed_version
            AND specification_hash = NEW.specification_hash
        )
      ))
      OR (NEW.status <> 'committed' AND (
        NEW.committed_version IS NOT NULL OR NEW.committed_at IS NOT NULL OR NEW.commit_actor_id IS NOT NULL
      ))
    BEGIN SELECT RAISE(ABORT, 'product specification preview integrity metadata is required'); END;

    CREATE TRIGGER IF NOT EXISTS product_spec_previews_require_integrity_update
    BEFORE UPDATE ON product_spec_previews
    WHEN NEW.organization_id IS NOT OLD.organization_id
      OR NEW.design_id IS NOT OLD.design_id
      OR NEW.actor_id IS NOT OLD.actor_id
      OR NEW.base_version IS NOT OLD.base_version
      OR NEW.specification_json IS NOT OLD.specification_json
      OR NEW.specification_hash IS NOT OLD.specification_hash
      OR NEW.diagnostics_json IS NOT OLD.diagnostics_json
      OR NEW.created_at IS NOT OLD.created_at
      OR NEW.expires_at IS NOT OLD.expires_at
      OR NOT (
        NEW.status = OLD.status
        OR (OLD.status IN ('ready', 'blocked') AND NEW.status = 'expired')
        OR (OLD.status = 'ready' AND NEW.status = 'committed')
      )
      OR (OLD.status = 'committed' AND (
        NEW.committed_version IS NOT OLD.committed_version
        OR NEW.committed_at IS NOT OLD.committed_at
        OR NEW.commit_actor_id IS NOT OLD.commit_actor_id
      ))
      OR (NEW.status = 'committed' AND (
        NEW.committed_version IS NULL OR NEW.committed_at IS NULL OR NEW.commit_actor_id IS NULL
        OR NEW.committed_version <> NEW.base_version + 1
        OR NOT EXISTS (
          SELECT 1 FROM product_specifications
          WHERE design_id = NEW.design_id AND version = NEW.committed_version
            AND specification_hash = NEW.specification_hash
        )
      ))
      OR (NEW.status <> 'committed' AND (
        NEW.committed_version IS NOT NULL OR NEW.committed_at IS NOT NULL OR NEW.commit_actor_id IS NOT NULL
      ))
    BEGIN SELECT RAISE(ABORT, 'invalid product specification preview transition'); END;

    CREATE TRIGGER IF NOT EXISTS planning_session_versions_immutable_update
    BEFORE UPDATE ON planning_session_versions
    BEGIN SELECT RAISE(ABORT, 'planning session versions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS planning_session_versions_immutable_delete
    BEFORE DELETE ON planning_session_versions
    BEGIN SELECT RAISE(ABORT, 'planning session versions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS planning_sessions_versioned_update
    BEFORE UPDATE ON planning_sessions
    WHEN NEW.id IS NOT OLD.id
      OR NEW.organization_id IS NOT OLD.organization_id
      OR NEW.design_id IS NOT OLD.design_id
      OR NEW.created_at IS NOT OLD.created_at
      OR NEW.version <> OLD.version + 1
      OR NOT EXISTS (
        SELECT 1 FROM planning_session_versions
        WHERE session_id = OLD.id AND version = NEW.version
          AND status = NEW.status AND current_section = NEW.current_section
      )
    BEGIN SELECT RAISE(ABORT, 'planning session updates require an immutable version'); END;
    CREATE TRIGGER IF NOT EXISTS planning_sessions_immutable_delete
    BEFORE DELETE ON planning_sessions
    BEGIN SELECT RAISE(ABORT, 'planning sessions cannot be deleted'); END;

    CREATE TRIGGER IF NOT EXISTS agent_task_transition_chain
    BEFORE INSERT ON agent_task_transitions
    WHEN (
      NEW.to_status = 'queued' AND (
        NEW.from_status IS NOT NULL
        OR EXISTS (SELECT 1 FROM agent_task_transitions WHERE task_id = NEW.task_id)
      )
    ) OR (
      NEW.to_status <> 'queued' AND (
        NEW.from_status IS NULL
        OR NEW.from_status IS NOT (
          SELECT to_status FROM agent_task_transitions
          WHERE task_id = NEW.task_id ORDER BY rowid DESC LIMIT 1
        )
        OR NEW.from_status IN ('completed', 'failed', 'cancelled', 'expired')
      )
    )
    BEGIN SELECT RAISE(ABORT, 'agent task transitions must form an append-only chain'); END;

    CREATE TRIGGER IF NOT EXISTS agent_task_transition_lifecycle
    BEFORE INSERT ON agent_task_transitions
    WHEN (NEW.from_status = 'queued' AND NEW.to_status NOT IN ('claimed', 'cancelled', 'expired'))
      OR (NEW.from_status = 'claimed' AND NEW.to_status NOT IN ('in_progress', 'failed', 'cancelled', 'expired'))
      OR (NEW.from_status = 'in_progress' AND NEW.to_status NOT IN ('awaiting_approval', 'completed', 'failed', 'cancelled', 'expired'))
      OR (NEW.from_status = 'awaiting_approval' AND NEW.to_status NOT IN ('in_progress', 'completed', 'failed', 'cancelled', 'expired'))
      OR NEW.from_status IN ('completed', 'failed', 'cancelled', 'expired')
    BEGIN SELECT RAISE(ABORT, 'invalid agent task lifecycle transition'); END;
  `);
}

function addEnterpriseDeliveryOperations(sqlite: Database.Database): void {
  addColumn(sqlite, "backup_records", "size_bytes INTEGER CHECK(size_bytes IS NULL OR size_bytes >= 0)");
  addColumn(sqlite, "backup_records", "verification_json TEXT");
  addColumn(sqlite, "backup_records", "retention_class TEXT NOT NULL DEFAULT 'manual' CHECK(retention_class IN ('manual', 'daily', 'weekly', 'monthly'))");
  addColumn(sqlite, "backup_records", "completed_at TEXT");

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS portable_exports (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      design_id TEXT NOT NULL REFERENCES designs(id) ON DELETE RESTRICT,
      revision_id TEXT NOT NULL REFERENCES revisions(id) ON DELETE RESTRICT,
      filename TEXT NOT NULL,
      bundle_sha256 TEXT NOT NULL,
      size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
      manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json) = 1),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS portable_exports_org_design_created
      ON portable_exports(organization_id, design_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS operational_locks (
      name TEXT NOT NULL,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      holder_id TEXT NOT NULL,
      purpose TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json) = 1),
      acquired_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY(organization_id, name)
    );
    CREATE INDEX IF NOT EXISTS operational_locks_expiry
      ON operational_locks(expires_at);
  `);
}

function addEnterpriseDomainModels(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS design_systems (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK(status IN ('active', 'archived')),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS design_systems_org_updated
      ON design_systems(organization_id, updated_at DESC, id);

    CREATE TABLE IF NOT EXISTS design_system_tokens (
      design_system_id TEXT NOT NULL REFERENCES design_systems(id) ON DELETE RESTRICT,
      token_id TEXT NOT NULL,
      version INTEGER NOT NULL CHECK(version > 0),
      status TEXT NOT NULL CHECK(status IN ('draft', 'published', 'deprecated')),
      token_json TEXT NOT NULL CHECK(json_valid(token_json) = 1),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(design_system_id, token_id, version)
    );
    CREATE INDEX IF NOT EXISTS design_system_tokens_system_status
      ON design_system_tokens(design_system_id, status, token_id, version DESC);

    CREATE TABLE IF NOT EXISTS component_definitions (
      design_system_id TEXT NOT NULL REFERENCES design_systems(id) ON DELETE RESTRICT,
      component_id TEXT NOT NULL,
      version INTEGER NOT NULL CHECK(version > 0),
      status TEXT NOT NULL CHECK(status IN ('draft', 'published', 'deprecated')),
      definition_json TEXT NOT NULL CHECK(json_valid(definition_json) = 1),
      replacement_component_id TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(design_system_id, component_id, version)
    );
    CREATE INDEX IF NOT EXISTS component_definitions_system_status
      ON component_definitions(design_system_id, status, component_id, version DESC);

    CREATE TABLE IF NOT EXISTS design_system_releases (
      id TEXT PRIMARY KEY,
      design_system_id TEXT NOT NULL REFERENCES design_systems(id) ON DELETE RESTRICT,
      version INTEGER NOT NULL CHECK(version > 0),
      name TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('draft', 'published', 'deprecated')),
      release_json TEXT NOT NULL CHECK(json_valid(release_json) = 1),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      published_at TEXT,
      UNIQUE(design_system_id, version)
    );
    CREATE INDEX IF NOT EXISTS design_system_releases_system_status
      ON design_system_releases(design_system_id, status, version DESC);

    CREATE TABLE IF NOT EXISTS project_design_system_pins (
      design_id TEXT PRIMARY KEY REFERENCES designs(id) ON DELETE RESTRICT,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      design_system_id TEXT NOT NULL REFERENCES design_systems(id) ON DELETE RESTRICT,
      release_id TEXT NOT NULL REFERENCES design_system_releases(id) ON DELETE RESTRICT,
      release_version INTEGER NOT NULL CHECK(release_version > 0),
      pinned_by TEXT NOT NULL,
      pinned_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS project_design_system_pins_org_system
      ON project_design_system_pins(organization_id, design_system_id, release_version);

    CREATE TABLE IF NOT EXISTS design_system_upgrade_previews (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      design_id TEXT NOT NULL REFERENCES designs(id) ON DELETE RESTRICT,
      current_release_id TEXT REFERENCES design_system_releases(id) ON DELETE RESTRICT,
      target_release_id TEXT NOT NULL REFERENCES design_system_releases(id) ON DELETE RESTRICT,
      diagnostics_json TEXT NOT NULL CHECK(json_valid(diagnostics_json) = 1),
      preview_hash TEXT NOT NULL CHECK(length(preview_hash) = 64),
      status TEXT NOT NULL CHECK(status IN ('ready', 'blocked', 'committed', 'expired')),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      committed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS design_system_upgrade_previews_design_expiry
      ON design_system_upgrade_previews(design_id, status, expires_at);

    CREATE TABLE IF NOT EXISTS repository_inventories (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      repository_fingerprint TEXT NOT NULL CHECK(length(repository_fingerprint) = 64),
      inventory_hash TEXT NOT NULL CHECK(length(inventory_hash) = 64),
      inventory_json TEXT NOT NULL CHECK(json_valid(inventory_json) = 1),
      status TEXT NOT NULL CHECK(status IN ('active', 'superseded', 'revoked')),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT,
      UNIQUE(organization_id, repository_fingerprint, inventory_hash)
    );
    CREATE INDEX IF NOT EXISTS repository_inventories_org_created
      ON repository_inventories(organization_id, created_at DESC, id);

    CREATE TABLE IF NOT EXISTS implementation_mappings (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      design_id TEXT NOT NULL REFERENCES designs(id) ON DELETE RESTRICT,
      revision_id TEXT NOT NULL REFERENCES revisions(id) ON DELETE RESTRICT,
      inventory_id TEXT REFERENCES repository_inventories(id) ON DELETE RESTRICT,
      entity_kind TEXT NOT NULL CHECK(entity_kind IN ('component', 'token', 'screen', 'route', 'asset', 'flow', 'business_rule')),
      entity_id TEXT NOT NULL,
      platform TEXT NOT NULL CHECK(platform IN ('web', 'android', 'ios', 'flutter', 'react_native', 'other')),
      symbol TEXT NOT NULL,
      mapping_json TEXT NOT NULL CHECK(json_valid(mapping_json) = 1),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS implementation_mappings_design_revision
      ON implementation_mappings(design_id, revision_id, entity_kind, entity_id);

    CREATE TABLE IF NOT EXISTS handoffs (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      design_id TEXT NOT NULL REFERENCES designs(id) ON DELETE RESTRICT,
      revision_id TEXT NOT NULL REFERENCES revisions(id) ON DELETE RESTRICT,
      inventory_id TEXT REFERENCES repository_inventories(id) ON DELETE RESTRICT,
      status TEXT NOT NULL CHECK(status IN ('draft', 'in_review', 'approved', 'implementing', 'completed', 'cancelled')),
      current_version INTEGER NOT NULL CHECK(current_version > 0),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS handoffs_org_design_updated
      ON handoffs(organization_id, design_id, updated_at DESC, id);

    CREATE TABLE IF NOT EXISTS handoff_versions (
      handoff_id TEXT NOT NULL REFERENCES handoffs(id) ON DELETE RESTRICT,
      version INTEGER NOT NULL CHECK(version > 0),
      specification_json TEXT NOT NULL CHECK(json_valid(specification_json) = 1),
      actor_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(handoff_id, version)
    );

    CREATE TABLE IF NOT EXISTS handoff_transitions (
      id TEXT PRIMARY KEY,
      handoff_id TEXT NOT NULL REFERENCES handoffs(id) ON DELETE RESTRICT,
      from_status TEXT,
      to_status TEXT NOT NULL CHECK(to_status IN ('draft', 'in_review', 'approved', 'implementing', 'completed', 'cancelled')),
      actor_id TEXT NOT NULL,
      details_json TEXT NOT NULL CHECK(json_valid(details_json) = 1),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS handoff_transitions_handoff_created
      ON handoff_transitions(handoff_id, created_at, id);

    CREATE TABLE IF NOT EXISTS redesign_assessments (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      design_id TEXT REFERENCES designs(id) ON DELETE RESTRICT,
      inventory_id TEXT REFERENCES repository_inventories(id) ON DELETE RESTRICT,
      status TEXT NOT NULL CHECK(status IN ('active', 'completed', 'cancelled')),
      current_stage TEXT NOT NULL CHECK(current_stage IN ('connect_inspect', 'document_current_state', 'pm_interview', 'future_state_proposal', 'design', 'handoff', 'approved_implementation')),
      current_version INTEGER NOT NULL CHECK(current_version > 0),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS redesign_assessments_org_updated
      ON redesign_assessments(organization_id, updated_at DESC, id);

    CREATE TABLE IF NOT EXISTS redesign_assessment_versions (
      assessment_id TEXT NOT NULL REFERENCES redesign_assessments(id) ON DELETE RESTRICT,
      version INTEGER NOT NULL CHECK(version > 0),
      stage TEXT NOT NULL CHECK(stage IN ('connect_inspect', 'document_current_state', 'pm_interview', 'future_state_proposal', 'design', 'handoff', 'approved_implementation')),
      content_json TEXT NOT NULL CHECK(json_valid(content_json) = 1),
      actor_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(assessment_id, version)
    );

    CREATE TABLE IF NOT EXISTS redesign_transitions (
      id TEXT PRIMARY KEY,
      assessment_id TEXT NOT NULL REFERENCES redesign_assessments(id) ON DELETE RESTRICT,
      from_stage TEXT,
      to_stage TEXT NOT NULL CHECK(to_stage IN ('connect_inspect', 'document_current_state', 'pm_interview', 'future_state_proposal', 'design', 'handoff', 'approved_implementation')),
      decision TEXT NOT NULL CHECK(decision IN ('created', 'advanced', 'returned', 'approved', 'cancelled', 'completed')),
      actor_id TEXT NOT NULL,
      details_json TEXT NOT NULL CHECK(json_valid(details_json) = 1),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS redesign_transitions_assessment_created
      ON redesign_transitions(assessment_id, created_at, id);

    CREATE TRIGGER IF NOT EXISTS design_system_tokens_immutable_update
    BEFORE UPDATE ON design_system_tokens BEGIN SELECT RAISE(ABORT, 'design system tokens are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS design_system_tokens_immutable_delete
    BEFORE DELETE ON design_system_tokens BEGIN SELECT RAISE(ABORT, 'design system tokens are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS component_definitions_immutable_update
    BEFORE UPDATE ON component_definitions BEGIN SELECT RAISE(ABORT, 'component definitions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS component_definitions_immutable_delete
    BEFORE DELETE ON component_definitions BEGIN SELECT RAISE(ABORT, 'component definitions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS design_system_releases_immutable_update
    BEFORE UPDATE ON design_system_releases BEGIN SELECT RAISE(ABORT, 'design system releases are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS design_system_releases_immutable_delete
    BEFORE DELETE ON design_system_releases BEGIN SELECT RAISE(ABORT, 'design system releases are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS repository_inventories_immutable_delete
    BEFORE DELETE ON repository_inventories BEGIN SELECT RAISE(ABORT, 'repository inventories cannot be deleted'); END;
    CREATE TRIGGER IF NOT EXISTS implementation_mappings_immutable_update
    BEFORE UPDATE ON implementation_mappings BEGIN SELECT RAISE(ABORT, 'implementation mappings are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS implementation_mappings_immutable_delete
    BEFORE DELETE ON implementation_mappings BEGIN SELECT RAISE(ABORT, 'implementation mappings are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS handoff_versions_immutable_update
    BEFORE UPDATE ON handoff_versions BEGIN SELECT RAISE(ABORT, 'handoff versions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS handoff_versions_immutable_delete
    BEFORE DELETE ON handoff_versions BEGIN SELECT RAISE(ABORT, 'handoff versions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS handoff_transitions_immutable_update
    BEFORE UPDATE ON handoff_transitions BEGIN SELECT RAISE(ABORT, 'handoff transitions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS handoff_transitions_immutable_delete
    BEFORE DELETE ON handoff_transitions BEGIN SELECT RAISE(ABORT, 'handoff transitions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS redesign_assessment_versions_immutable_update
    BEFORE UPDATE ON redesign_assessment_versions BEGIN SELECT RAISE(ABORT, 'redesign assessment versions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS redesign_assessment_versions_immutable_delete
    BEFORE DELETE ON redesign_assessment_versions BEGIN SELECT RAISE(ABORT, 'redesign assessment versions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS redesign_transitions_immutable_update
    BEFORE UPDATE ON redesign_transitions BEGIN SELECT RAISE(ABORT, 'redesign transitions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS redesign_transitions_immutable_delete
    BEFORE DELETE ON redesign_transitions BEGIN SELECT RAISE(ABORT, 'redesign transitions are immutable'); END;
  `);
}

function addAuditRetentionExecution(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS audit_retention_previews (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      actor_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
      configuration_hash TEXT NOT NULL CHECK(length(configuration_hash) = 64),
      policy_hash TEXT NOT NULL CHECK(length(policy_hash) = 64),
      retention_days INTEGER NOT NULL CHECK(retention_days BETWEEN 30 AND 3650),
      cutoff_at TEXT NOT NULL,
      audit_event_ids_json TEXT NOT NULL CHECK(json_valid(audit_event_ids_json) = 1),
      audit_event_count INTEGER NOT NULL CHECK(audit_event_count >= 0),
      audit_event_bytes INTEGER NOT NULL CHECK(audit_event_bytes >= 0),
      audit_first_id INTEGER,
      audit_last_id INTEGER,
      audit_events_hash TEXT NOT NULL CHECK(length(audit_events_hash) = 64),
      audit_has_more INTEGER NOT NULL CHECK(audit_has_more IN (0, 1)),
      outbox_event_ids_json TEXT NOT NULL CHECK(json_valid(outbox_event_ids_json) = 1),
      outbox_event_count INTEGER NOT NULL CHECK(outbox_event_count >= 0),
      outbox_event_bytes INTEGER NOT NULL CHECK(outbox_event_bytes >= 0),
      outbox_first_id INTEGER,
      outbox_last_id INTEGER,
      outbox_events_hash TEXT NOT NULL CHECK(length(outbox_events_hash) = 64),
      outbox_has_more INTEGER NOT NULL CHECK(outbox_has_more IN (0, 1)),
      plan_hash TEXT NOT NULL CHECK(length(plan_hash) = 64),
      status TEXT NOT NULL CHECK(status IN ('ready', 'expired', 'committed')),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      committed_run_id TEXT,
      committed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS audit_retention_previews_org_status_expiry
      ON audit_retention_previews(organization_id, status, expires_at);

    CREATE TABLE IF NOT EXISTS audit_retention_runs (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      preview_id TEXT NOT NULL UNIQUE REFERENCES audit_retention_previews(id) ON DELETE RESTRICT,
      actor_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL CHECK(length(request_hash) = 64),
      configuration_hash TEXT NOT NULL CHECK(length(configuration_hash) = 64),
      policy_hash TEXT NOT NULL CHECK(length(policy_hash) = 64),
      retention_days INTEGER NOT NULL CHECK(retention_days BETWEEN 30 AND 3650),
      cutoff_at TEXT NOT NULL,
      audit_event_ids_json TEXT NOT NULL CHECK(json_valid(audit_event_ids_json) = 1),
      audit_event_count INTEGER NOT NULL CHECK(audit_event_count >= 0),
      audit_event_bytes INTEGER NOT NULL CHECK(audit_event_bytes >= 0),
      audit_first_id INTEGER,
      audit_last_id INTEGER,
      audit_events_hash TEXT NOT NULL CHECK(length(audit_events_hash) = 64),
      audit_has_more INTEGER NOT NULL CHECK(audit_has_more IN (0, 1)),
      outbox_event_ids_json TEXT NOT NULL CHECK(json_valid(outbox_event_ids_json) = 1),
      outbox_event_count INTEGER NOT NULL CHECK(outbox_event_count >= 0),
      outbox_event_bytes INTEGER NOT NULL CHECK(outbox_event_bytes >= 0),
      outbox_first_id INTEGER,
      outbox_last_id INTEGER,
      outbox_events_hash TEXT NOT NULL CHECK(length(outbox_events_hash) = 64),
      outbox_has_more INTEGER NOT NULL CHECK(outbox_has_more IN (0, 1)),
      plan_hash TEXT NOT NULL CHECK(length(plan_hash) = 64),
      previous_run_hash TEXT,
      run_hash TEXT NOT NULL UNIQUE CHECK(length(run_hash) = 64),
      commit_audit_event_id INTEGER NOT NULL REFERENCES audit_events(id) ON DELETE RESTRICT,
      commit_outbox_event_id INTEGER NOT NULL REFERENCES event_outbox(id) ON DELETE RESTRICT,
      completed_at TEXT NOT NULL,
      UNIQUE(organization_id, actor_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS audit_retention_runs_org_completed
      ON audit_retention_runs(organization_id, completed_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS audit_retention_runs_org_sequence
      ON audit_retention_runs(organization_id, commit_audit_event_id DESC);

    CREATE TABLE IF NOT EXISTS audit_retention_delete_permits (
      run_id TEXT NOT NULL REFERENCES audit_retention_runs(id) ON DELETE RESTRICT,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      event_kind TEXT NOT NULL CHECK(event_kind IN ('audit', 'outbox')),
      event_id INTEGER NOT NULL CHECK(event_id > 0),
      PRIMARY KEY(run_id, event_kind, event_id),
      UNIQUE(organization_id, event_kind, event_id)
    );
    CREATE INDEX IF NOT EXISTS audit_retention_delete_permits_lookup
      ON audit_retention_delete_permits(organization_id, event_kind, event_id);

    DROP TRIGGER IF EXISTS audit_events_immutable_delete;
    DROP TRIGGER IF EXISTS audit_events_retention_delete;
    CREATE TRIGGER audit_events_retention_delete
    BEFORE DELETE ON audit_events
    WHEN OLD.action LIKE 'audit_retention.%'
      OR OLD.action = 'organization_policy.update'
      OR OLD.action IN ('backup.pre_restore_create', 'backup.restore_commit', 'backup.restore_rolled_back')
      OR NOT EXISTS (
        SELECT 1
        FROM audit_retention_delete_permits p
        JOIN audit_retention_runs r ON r.id = p.run_id AND r.organization_id = p.organization_id
        WHERE p.organization_id = OLD.organization_id
          AND p.event_kind = 'audit'
          AND p.event_id = OLD.id
          AND OLD.created_at < r.cutoff_at
      )
    BEGIN SELECT RAISE(ABORT, 'audit events are immutable outside exact retention execution'); END;

    CREATE TRIGGER IF NOT EXISTS event_outbox_retention_delete
    BEFORE DELETE ON event_outbox
    WHEN OLD.event_type = 'audit.retention'
      OR OLD.published_at IS NULL
      OR (
        json_valid(OLD.payload_json) = 1
        AND (
          (OLD.event_type = 'organization_policy.changed'
            AND json_extract(OLD.payload_json, '$.action') = 'organization_policy.update')
          OR (OLD.event_type = 'backup.operation'
            AND json_extract(OLD.payload_json, '$.action') IN (
              'backup.pre_restore_create', 'backup.restore_commit', 'backup.restore_rolled_back'
            ))
        )
      )
      OR NOT EXISTS (
        SELECT 1
        FROM audit_retention_delete_permits p
        JOIN audit_retention_runs r ON r.id = p.run_id AND r.organization_id = p.organization_id
        WHERE p.organization_id = OLD.organization_id
          AND p.event_kind = 'outbox'
          AND p.event_id = OLD.id
          AND OLD.created_at < r.cutoff_at
      )
    BEGIN SELECT RAISE(ABORT, 'event outbox rows require exact published-event retention execution'); END;

    CREATE TRIGGER IF NOT EXISTS audit_retention_runs_immutable_update
    BEFORE UPDATE ON audit_retention_runs
    BEGIN SELECT RAISE(ABORT, 'audit retention runs are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS audit_retention_runs_immutable_delete
    BEFORE DELETE ON audit_retention_runs
    BEGIN SELECT RAISE(ABORT, 'audit retention runs are immutable'); END;
  `);
}

function addPortableImportProvenance(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS portable_imports (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      mode TEXT NOT NULL CHECK(mode IN ('conflict_fail', 'clone')),
      bundle_sha256 TEXT NOT NULL CHECK(length(bundle_sha256) = 64),
      source_document_id TEXT NOT NULL,
      source_document_revision INTEGER NOT NULL CHECK(source_document_revision >= 0),
      source_revision_id TEXT NOT NULL,
      source_revision_hash_claim TEXT NOT NULL CHECK(length(source_revision_hash_claim) = 64),
      target_design_id TEXT NOT NULL UNIQUE REFERENCES designs(id) ON DELETE RESTRICT,
      target_revision_id TEXT NOT NULL UNIQUE REFERENCES revisions(id) ON DELETE RESTRICT,
      id_map_json TEXT NOT NULL CHECK(json_valid(id_map_json) = 1),
      manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json) = 1),
      diagnostics_json TEXT NOT NULL CHECK(json_valid(diagnostics_json) = 1),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS portable_imports_org_created
      ON portable_imports(organization_id, created_at DESC, id DESC);

    CREATE TRIGGER IF NOT EXISTS portable_imports_immutable_update
    BEFORE UPDATE ON portable_imports
    BEGIN SELECT RAISE(ABORT, 'portable imports are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS portable_imports_immutable_delete
    BEFORE DELETE ON portable_imports
    BEGIN SELECT RAISE(ABORT, 'portable imports are immutable'); END;
  `);
}

function addRenderJobPersistence(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS render_jobs (
      id TEXT PRIMARY KEY,
      organization_id TEXT REFERENCES organizations(id) ON DELETE RESTRICT,
      design_id TEXT REFERENCES designs(id) ON DELETE RESTRICT,
      revision_id TEXT REFERENCES revisions(id) ON DELETE RESTRICT,
      document_id TEXT CHECK(document_id IS NULL OR length(document_id) BETWEEN 1 AND 256),
      document_revision INTEGER CHECK(document_revision IS NULL OR document_revision >= 0),
      scope_kind TEXT NOT NULL CHECK(scope_kind IN ('organization', 'internal')),
      operation TEXT NOT NULL CHECK(length(operation) BETWEEN 1 AND 128),
      kind TEXT NOT NULL CHECK(kind IN ('render', 'normalize_raster')),
      status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'succeeded', 'failed')),
      owner_id TEXT NOT NULL CHECK(
        length(owner_id) = 45 AND owner_id GLOB 'render_owner_*'
        AND substr(owner_id, 14) NOT GLOB '*[^0-9a-f]*'
      ),
      request_hash TEXT NOT NULL CHECK(
        length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'
      ),
      request_metadata_json TEXT NOT NULL CHECK(
        json_valid(request_metadata_json) = 1 AND length(CAST(request_metadata_json AS BLOB)) <= 8192
      ),
      renderer_version TEXT NOT NULL,
      renderer_ipc_protocol_version INTEGER NOT NULL CHECK(renderer_ipc_protocol_version > 0),
      raster_normalizer_version TEXT NOT NULL,
      output_sha256 TEXT CHECK(
        output_sha256 IS NULL OR (
          length(output_sha256) = 64 AND output_sha256 NOT GLOB '*[^0-9a-f]*'
        )
      ),
      output_bytes INTEGER CHECK(output_bytes IS NULL OR output_bytes > 0),
      output_width INTEGER CHECK(output_width IS NULL OR output_width > 0),
      output_height INTEGER CHECK(output_height IS NULL OR output_height > 0),
      output_renderer TEXT CHECK(output_renderer IS NULL OR output_renderer IN ('playwright', 'software', 'chromium')),
      warnings_json TEXT NOT NULL CHECK(
        json_valid(warnings_json) = 1 AND json_type(warnings_json) = 'array'
        AND length(CAST(warnings_json AS BLOB)) <= 8192
      ),
      error_code TEXT CHECK(error_code IS NULL OR (length(error_code) BETWEEN 1 AND 64)),
      error_message TEXT CHECK(error_message IS NULL OR (length(error_message) BETWEEN 1 AND 1000)),
      retryable INTEGER CHECK(retryable IS NULL OR retryable IN (0, 1)),
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      heartbeat_at TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL,
      CHECK(
        (scope_kind = 'organization' AND organization_id IS NOT NULL)
        OR (scope_kind = 'internal' AND organization_id IS NULL AND design_id IS NULL AND revision_id IS NULL)
      ),
      CHECK(design_id IS NULL OR organization_id IS NOT NULL),
      CHECK(
        length(created_at) = 24 AND substr(created_at, 11, 1) = 'T'
        AND substr(created_at, 24, 1) = 'Z' AND julianday(created_at) IS NOT NULL
      ),
      CHECK(
        started_at IS NULL OR (
          length(started_at) = 24 AND substr(started_at, 11, 1) = 'T'
          AND substr(started_at, 24, 1) = 'Z' AND julianday(started_at) IS NOT NULL
          AND started_at >= created_at
        )
      ),
      CHECK(
        completed_at IS NULL OR (
          length(completed_at) = 24 AND substr(completed_at, 11, 1) = 'T'
          AND substr(completed_at, 24, 1) = 'Z' AND julianday(completed_at) IS NOT NULL
          AND completed_at >= COALESCE(started_at, created_at)
        )
      ),
      CHECK(
        length(heartbeat_at) = 24 AND substr(heartbeat_at, 11, 1) = 'T'
        AND substr(heartbeat_at, 24, 1) = 'Z' AND julianday(heartbeat_at) IS NOT NULL
        AND heartbeat_at >= created_at
      ),
      CHECK(
        length(lease_expires_at) = 24 AND substr(lease_expires_at, 11, 1) = 'T'
        AND substr(lease_expires_at, 24, 1) = 'Z' AND julianday(lease_expires_at) IS NOT NULL
        AND lease_expires_at >= heartbeat_at
      ),
      CHECK(
        (status = 'queued'
          AND started_at IS NULL AND completed_at IS NULL
          AND output_sha256 IS NULL AND output_bytes IS NULL AND output_width IS NULL
          AND output_height IS NULL AND output_renderer IS NULL
          AND error_code IS NULL AND error_message IS NULL AND retryable IS NULL)
        OR
        (status = 'running'
          AND started_at IS NOT NULL AND completed_at IS NULL
          AND output_sha256 IS NULL AND output_bytes IS NULL AND output_width IS NULL
          AND output_height IS NULL AND output_renderer IS NULL
          AND error_code IS NULL AND error_message IS NULL AND retryable IS NULL)
        OR
        (status = 'succeeded'
          AND started_at IS NOT NULL AND completed_at IS NOT NULL
          AND output_sha256 IS NOT NULL AND output_bytes IS NOT NULL AND output_width IS NOT NULL
          AND output_height IS NOT NULL AND output_renderer IS NOT NULL
          AND error_code IS NULL AND error_message IS NULL AND retryable IS NULL)
        OR
        (status = 'failed'
          AND completed_at IS NOT NULL
          AND output_sha256 IS NULL AND output_bytes IS NULL AND output_width IS NULL
          AND output_height IS NULL AND output_renderer IS NULL
          AND error_code IS NOT NULL AND error_message IS NOT NULL AND retryable IS NOT NULL)
      ),
      CHECK(
        output_renderer IS NULL
        OR (kind = 'render' AND output_renderer IN ('playwright', 'software'))
        OR (kind = 'normalize_raster' AND output_renderer = 'chromium')
      )
    );
    CREATE INDEX IF NOT EXISTS render_jobs_status_created
      ON render_jobs(status, created_at, id);
    CREATE INDEX IF NOT EXISTS render_jobs_design_created
      ON render_jobs(design_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS render_jobs_retention
      ON render_jobs(status, completed_at, organization_id, id);

    CREATE TABLE IF NOT EXISTS render_job_delete_permits (
      job_id TEXT PRIMARY KEY REFERENCES render_jobs(id) ON DELETE CASCADE,
      organization_id TEXT REFERENCES organizations(id) ON DELETE RESTRICT,
      cutoff_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      CHECK(
        length(cutoff_at) = 24 AND substr(cutoff_at, 11, 1) = 'T'
        AND substr(cutoff_at, 24, 1) = 'Z' AND julianday(cutoff_at) IS NOT NULL
      ),
      CHECK(
        length(created_at) = 24 AND substr(created_at, 11, 1) = 'T'
        AND substr(created_at, 24, 1) = 'Z' AND julianday(created_at) IS NOT NULL
      )
    );

    CREATE TRIGGER IF NOT EXISTS render_jobs_initial_insert
    BEFORE INSERT ON render_jobs
    WHEN NEW.status != 'queued'
      OR NEW.started_at IS NOT NULL
      OR NEW.completed_at IS NOT NULL
      OR NEW.output_sha256 IS NOT NULL
      OR NEW.output_bytes IS NOT NULL
      OR NEW.output_width IS NOT NULL
      OR NEW.output_height IS NOT NULL
      OR NEW.output_renderer IS NOT NULL
      OR NEW.error_code IS NOT NULL
      OR NEW.error_message IS NOT NULL
      OR NEW.retryable IS NOT NULL
      OR NEW.warnings_json != '[]'
    BEGIN SELECT RAISE(ABORT, 'render jobs must begin in the canonical queued state'); END;

    CREATE TRIGGER IF NOT EXISTS render_jobs_lifecycle_update
    BEFORE UPDATE ON render_jobs
    WHEN OLD.status IN ('succeeded', 'failed')
      OR NEW.id IS NOT OLD.id
      OR NEW.organization_id IS NOT OLD.organization_id
      OR NEW.design_id IS NOT OLD.design_id
      OR NEW.revision_id IS NOT OLD.revision_id
      OR NEW.document_id IS NOT OLD.document_id
      OR NEW.document_revision IS NOT OLD.document_revision
      OR NEW.scope_kind IS NOT OLD.scope_kind
      OR NEW.operation IS NOT OLD.operation
      OR NEW.kind IS NOT OLD.kind
      OR NEW.owner_id IS NOT OLD.owner_id
      OR NEW.request_hash IS NOT OLD.request_hash
      OR NEW.request_metadata_json IS NOT OLD.request_metadata_json
      OR NEW.renderer_version IS NOT OLD.renderer_version
      OR NEW.renderer_ipc_protocol_version IS NOT OLD.renderer_ipc_protocol_version
      OR NEW.raster_normalizer_version IS NOT OLD.raster_normalizer_version
      OR NEW.created_at IS NOT OLD.created_at
      OR NOT (
        (OLD.status = 'queued' AND NEW.status IN ('queued', 'running', 'failed'))
        OR (OLD.status = 'running' AND NEW.status IN ('running', 'succeeded', 'failed'))
      )
      OR (OLD.status = 'queued' AND NEW.status = 'failed' AND NEW.started_at IS NOT OLD.started_at)
      OR (OLD.status = NEW.status AND NEW.started_at IS NOT OLD.started_at)
      OR (OLD.status = 'running' AND NEW.status != 'running' AND NEW.started_at IS NOT OLD.started_at)
      OR (NEW.status IN ('running', 'failed') AND NEW.warnings_json IS NOT OLD.warnings_json)
    BEGIN SELECT RAISE(ABORT, 'render jobs permit only valid lifecycle transitions'); END;

    CREATE TRIGGER IF NOT EXISTS render_jobs_retention_delete
    BEFORE DELETE ON render_jobs
    WHEN OLD.status NOT IN ('succeeded', 'failed')
      OR NOT EXISTS (
        SELECT 1 FROM render_job_delete_permits permit
        WHERE permit.job_id = OLD.id
          AND permit.organization_id IS OLD.organization_id
          AND OLD.completed_at <= permit.cutoff_at
      )
    BEGIN SELECT RAISE(ABORT, 'render jobs require an exact retention permit'); END;
  `);
}

function addHandoffExecutionDecisions(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS handoff_execution_decisions (
      id TEXT PRIMARY KEY,
      handoff_id TEXT NOT NULL REFERENCES handoffs(id) ON DELETE RESTRICT,
      handoff_version INTEGER NOT NULL CHECK(handoff_version > 0),
      sequence INTEGER NOT NULL CHECK(sequence > 0),
      kind TEXT NOT NULL CHECK(kind IN (
        'plan_approval',
        'isolation_choice',
        'diff_review',
        'validation_approval',
        'commit_approval',
        'push_authorization',
        'pull_request_request'
      )),
      outcome TEXT NOT NULL,
      supersedes_decision_id TEXT REFERENCES handoff_execution_decisions(id) ON DELETE RESTRICT,
      evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json) = 1)
        CHECK(length(evidence_json) BETWEEN 2 AND 32768),
      evidence_hash TEXT NOT NULL CHECK(length(evidence_hash) = 64),
      actor_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL,
      UNIQUE(handoff_id, sequence),
      FOREIGN KEY(handoff_id, handoff_version)
        REFERENCES handoff_versions(handoff_id, version) ON DELETE RESTRICT,
      CHECK(
        (kind IN ('plan_approval', 'diff_review', 'validation_approval', 'commit_approval')
          AND outcome IN ('approved', 'denied', 'revoked'))
        OR (kind = 'isolation_choice'
          AND outcome IN ('branch', 'worktree', 'denied', 'revoked'))
        OR (kind = 'push_authorization'
          AND outcome IN ('authorized', 'denied', 'revoked'))
        OR (kind = 'pull_request_request'
          AND outcome IN ('requested', 'not_requested', 'denied', 'revoked'))
      )
    );
    CREATE INDEX IF NOT EXISTS handoff_execution_decisions_handoff_sequence
      ON handoff_execution_decisions(handoff_id, sequence);
    CREATE INDEX IF NOT EXISTS handoff_execution_decisions_handoff_kind_sequence
      ON handoff_execution_decisions(handoff_id, kind, sequence DESC);

    CREATE TRIGGER IF NOT EXISTS handoff_execution_decisions_insert_integrity
    BEFORE INSERT ON handoff_execution_decisions
    WHEN
      NEW.sequence != COALESCE((
        SELECT MAX(existing.sequence) + 1
        FROM handoff_execution_decisions existing
        WHERE existing.handoff_id = NEW.handoff_id
      ), 1)
      OR NEW.handoff_version != (
        SELECT handoff.current_version FROM handoffs handoff WHERE handoff.id = NEW.handoff_id
      )
      OR (
        NEW.supersedes_decision_id IS NULL
        AND EXISTS (
          SELECT 1 FROM handoff_execution_decisions existing
          WHERE existing.handoff_id = NEW.handoff_id AND existing.kind = NEW.kind
        )
      )
      OR (
        NEW.supersedes_decision_id IS NOT NULL
        AND NEW.supersedes_decision_id IS NOT (
          SELECT existing.id
          FROM handoff_execution_decisions existing
          WHERE existing.handoff_id = NEW.handoff_id AND existing.kind = NEW.kind
          ORDER BY existing.sequence DESC LIMIT 1
        )
      )
      OR (
        NEW.outcome = 'revoked'
        AND (
          NEW.supersedes_decision_id IS NULL
          OR (SELECT previous.outcome FROM handoff_execution_decisions previous
              WHERE previous.id = NEW.supersedes_decision_id) IN ('denied', 'revoked')
        )
      )
      OR (
        NEW.kind = 'plan_approval'
        AND (SELECT handoff.status FROM handoffs handoff WHERE handoff.id = NEW.handoff_id)
          NOT IN ('in_review', 'approved', 'implementing')
      )
      OR (
        NEW.kind = 'isolation_choice'
        AND (SELECT handoff.status FROM handoffs handoff WHERE handoff.id = NEW.handoff_id)
          NOT IN ('approved', 'implementing')
      )
      OR (
        NEW.kind IN ('diff_review', 'validation_approval', 'commit_approval',
                     'push_authorization', 'pull_request_request')
        AND (SELECT handoff.status FROM handoffs handoff WHERE handoff.id = NEW.handoff_id) != 'implementing'
      )
    BEGIN SELECT RAISE(ABORT, 'handoff execution decision violates append-only CAS or lifecycle integrity'); END;

    CREATE TRIGGER IF NOT EXISTS handoff_execution_decisions_immutable_update
    BEFORE UPDATE ON handoff_execution_decisions
    BEGIN SELECT RAISE(ABORT, 'handoff execution decisions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS handoff_execution_decisions_immutable_delete
    BEFORE DELETE ON handoff_execution_decisions
    BEGIN SELECT RAISE(ABORT, 'handoff execution decisions are immutable'); END;
  `);
}

function addComponentSourcePersistence(sqlite: Database.Database): void {
  addColumn(sqlite, "component_definitions", `source_json TEXT
    CHECK(source_json IS NULL OR (
      json_valid(source_json) = 1
      AND length(CAST(source_json AS BLOB)) BETWEEN 2 AND 1048576
    ))`);
  addColumn(sqlite, "component_definitions", `source_hash TEXT
    CHECK(source_hash IS NULL OR (
      length(source_hash) = 64
      AND source_hash NOT GLOB '*[^0-9a-f]*'
    ))`);
  addColumn(sqlite, "design_system_upgrade_previews", `base_revision_id TEXT
    REFERENCES revisions(id) ON DELETE RESTRICT`);
  addColumn(sqlite, "design_system_upgrade_previews", `base_snapshot_hash TEXT
    REFERENCES snapshots(snapshot_hash) ON DELETE RESTRICT
    CHECK(base_snapshot_hash IS NULL OR (
      length(base_snapshot_hash) = 64
      AND base_snapshot_hash NOT GLOB '*[^0-9a-f]*'
    ))`);
  addColumn(sqlite, "design_system_upgrade_previews", `result_snapshot_hash TEXT
    REFERENCES snapshots(snapshot_hash) ON DELETE RESTRICT
    CHECK(result_snapshot_hash IS NULL OR (
      length(result_snapshot_hash) = 64
      AND result_snapshot_hash NOT GLOB '*[^0-9a-f]*'
    ))`);

  sqlite.exec(`
    CREATE TRIGGER IF NOT EXISTS component_definitions_source_insert_integrity
    BEFORE INSERT ON component_definitions
    WHEN (NEW.source_json IS NULL) != (NEW.source_hash IS NULL)
    BEGIN SELECT RAISE(ABORT, 'component definition source metadata must be paired'); END;

    CREATE TRIGGER IF NOT EXISTS design_system_upgrade_previews_exact_metadata_insert
    BEFORE INSERT ON design_system_upgrade_previews
    WHEN NOT (
      (NEW.base_revision_id IS NULL AND NEW.base_snapshot_hash IS NULL AND NEW.result_snapshot_hash IS NULL)
      OR
      (NEW.base_revision_id IS NOT NULL AND NEW.base_snapshot_hash IS NOT NULL AND NEW.result_snapshot_hash IS NOT NULL)
    )
    BEGIN SELECT RAISE(ABORT, 'design-system upgrade preview exact metadata must be complete'); END;

    CREATE TRIGGER IF NOT EXISTS design_system_upgrade_previews_exact_metadata_immutable
    BEFORE UPDATE ON design_system_upgrade_previews
    WHEN NEW.base_revision_id IS NOT OLD.base_revision_id
      OR NEW.base_snapshot_hash IS NOT OLD.base_snapshot_hash
      OR NEW.result_snapshot_hash IS NOT OLD.result_snapshot_hash
    BEGIN SELECT RAISE(ABORT, 'design-system upgrade preview exact metadata is immutable'); END;
  `);
}

const LEGACY_BOOTSTRAP_CREDENTIALS_CONSUME_ONCE_SQL = `
  CREATE TRIGGER bootstrap_credentials_consume_once
  BEFORE UPDATE ON bootstrap_credentials
  WHEN NEW.id IS NOT OLD.id
    OR NEW.token_hash IS NOT OLD.token_hash
    OR NEW.created_at IS NOT OLD.created_at
    OR OLD.consumed_at IS NOT NULL
    OR OLD.consumed_by IS NOT NULL
    OR NEW.consumed_at IS NULL
    OR NEW.consumed_by IS NULL
  BEGIN SELECT RAISE(ABORT, 'bootstrap credential can be consumed exactly once'); END
`;

const CANONICAL_BOOTSTRAP_CREDENTIALS_CONSUME_ONCE_SQL = `
  CREATE TRIGGER bootstrap_credentials_consume_once
  BEFORE UPDATE ON bootstrap_credentials
  WHEN NEW.id IS NOT OLD.id
    OR NEW.created_at IS NOT OLD.created_at
    OR OLD.consumed_at IS NOT NULL
    OR OLD.consumed_by IS NOT NULL
    OR (NEW.consumed_at IS NULL) != (NEW.consumed_by IS NULL)
    OR (NEW.consumed_at IS NOT NULL AND NEW.token_hash IS NOT OLD.token_hash)
  BEGIN SELECT RAISE(ABORT, 'bootstrap credential can be consumed exactly once'); END
`;

function addBrowserSessionAuthentication(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS password_accounts (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
      login_name TEXT NOT NULL CHECK(length(login_name) BETWEEN 3 AND 128),
      login_name_normalized TEXT NOT NULL CHECK(length(login_name_normalized) BETWEEN 3 AND 128),
      password_hash TEXT NOT NULL CHECK(length(password_hash) BETWEEN 80 AND 512),
      bootstrap_account INTEGER NOT NULL DEFAULT 1 CHECK(bootstrap_account = 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(organization_id, login_name_normalized),
      UNIQUE(principal_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS password_accounts_single_bootstrap
      ON password_accounts(bootstrap_account) WHERE bootstrap_account = 1;

    CREATE TABLE IF NOT EXISTS browser_sessions (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      account_id TEXT NOT NULL REFERENCES password_accounts(id) ON DELETE RESTRICT,
      principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
      token_hash TEXT NOT NULL UNIQUE CHECK(
        length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'
      ),
      csrf_token_hash TEXT NOT NULL CHECK(
        length(csrf_token_hash) = 64 AND csrf_token_hash NOT GLOB '*[^0-9a-f]*'
      ),
      created_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL,
      idle_expires_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      CHECK(idle_expires_at <= expires_at),
      CHECK(last_used_at >= created_at),
      CHECK(revoked_at IS NULL OR revoked_at >= created_at)
    );
    CREATE INDEX IF NOT EXISTS browser_sessions_principal_active
      ON browser_sessions(principal_id, revoked_at, idle_expires_at);

    CREATE TABLE IF NOT EXISTS login_attempts (
      identity_hash TEXT PRIMARY KEY CHECK(
        length(identity_hash) = 64 AND identity_hash NOT GLOB '*[^0-9a-f]*'
      ),
      failure_count INTEGER NOT NULL CHECK(failure_count BETWEEN 1 AND 1000),
      window_started_at TEXT NOT NULL,
      locked_until TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bootstrap_credentials (
      id TEXT PRIMARY KEY CHECK(id = 'initial_admin'),
      token_hash TEXT NOT NULL CHECK(
        length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'
      ),
      created_at TEXT NOT NULL,
      consumed_at TEXT,
      consumed_by TEXT REFERENCES principals(id) ON DELETE RESTRICT,
      CHECK(
        (consumed_at IS NULL AND consumed_by IS NULL)
        OR (consumed_at IS NOT NULL AND consumed_by IS NOT NULL)
      )
    );

    CREATE TRIGGER IF NOT EXISTS password_accounts_require_bootstrap_admin
    BEFORE INSERT ON password_accounts
    WHEN NEW.bootstrap_account != 1
      OR NOT EXISTS (
        SELECT 1 FROM principals p
        JOIN memberships m
          ON m.organization_id = p.organization_id AND m.principal_id = p.id
        WHERE p.id = NEW.principal_id
          AND p.organization_id = NEW.organization_id
          AND p.kind = 'human'
          AND p.disabled_at IS NULL
          AND m.role = 'organization_admin'
      )
    BEGIN SELECT RAISE(ABORT, 'password account requires one enabled bootstrap organization administrator'); END;

    CREATE TRIGGER IF NOT EXISTS password_accounts_identity_immutable
    BEFORE UPDATE ON password_accounts
    WHEN NEW.id IS NOT OLD.id
      OR NEW.organization_id IS NOT OLD.organization_id
      OR NEW.principal_id IS NOT OLD.principal_id
      OR NEW.login_name IS NOT OLD.login_name
      OR NEW.login_name_normalized IS NOT OLD.login_name_normalized
      OR NEW.bootstrap_account IS NOT OLD.bootstrap_account
      OR NEW.created_at IS NOT OLD.created_at
    BEGIN SELECT RAISE(ABORT, 'password account bootstrap identity is immutable'); END;

    CREATE TRIGGER IF NOT EXISTS password_accounts_immutable_delete
    BEFORE DELETE ON password_accounts
    BEGIN SELECT RAISE(ABORT, 'password accounts cannot be deleted'); END;

    CREATE TRIGGER IF NOT EXISTS browser_sessions_require_account_principal
    BEFORE INSERT ON browser_sessions
    WHEN NOT EXISTS (
      SELECT 1 FROM password_accounts a
      WHERE a.id = NEW.account_id
        AND a.organization_id = NEW.organization_id
        AND a.principal_id = NEW.principal_id
    )
    BEGIN SELECT RAISE(ABORT, 'browser session account and principal must match'); END;

    CREATE TRIGGER IF NOT EXISTS browser_sessions_identity_immutable
    BEFORE UPDATE ON browser_sessions
    WHEN NEW.id IS NOT OLD.id
      OR NEW.organization_id IS NOT OLD.organization_id
      OR NEW.account_id IS NOT OLD.account_id
      OR NEW.principal_id IS NOT OLD.principal_id
      OR NEW.token_hash IS NOT OLD.token_hash
      OR NEW.csrf_token_hash IS NOT OLD.csrf_token_hash
      OR NEW.created_at IS NOT OLD.created_at
      OR NEW.expires_at IS NOT OLD.expires_at
    BEGIN SELECT RAISE(ABORT, 'browser session identity and absolute expiry are immutable'); END;

    CREATE TRIGGER IF NOT EXISTS bootstrap_credentials_consume_once
    BEFORE UPDATE ON bootstrap_credentials
    WHEN NEW.id IS NOT OLD.id
      OR NEW.created_at IS NOT OLD.created_at
      OR OLD.consumed_at IS NOT NULL
      OR OLD.consumed_by IS NOT NULL
      OR (NEW.consumed_at IS NULL) != (NEW.consumed_by IS NULL)
      OR (NEW.consumed_at IS NOT NULL AND NEW.token_hash IS NOT OLD.token_hash)
    BEGIN SELECT RAISE(ABORT, 'bootstrap credential can be consumed exactly once'); END;

    CREATE TRIGGER IF NOT EXISTS bootstrap_credentials_immutable_delete
    BEFORE DELETE ON bootstrap_credentials
    BEGIN SELECT RAISE(ABORT, 'bootstrap credentials cannot be deleted'); END;
  `);
}

function addPreviewRenderMetadata(sqlite: Database.Database): void {
  addColumn(
    sqlite,
    "previews",
    `render_metadata_json TEXT CHECK(
      render_metadata_json IS NULL OR (
        json_valid(render_metadata_json) = 1
        AND length(CAST(render_metadata_json AS BLOB)) BETWEEN 2 AND 65536
      )
    )`,
  );
  sqlite.exec(`
    CREATE TRIGGER IF NOT EXISTS previews_render_metadata_immutable
    BEFORE UPDATE OF render_metadata_json ON previews
    WHEN OLD.render_metadata_json IS NOT NULL OR NEW.render_metadata_json IS NULL
    BEGIN SELECT RAISE(ABORT, 'preview render metadata is immutable once recorded'); END;
  `);
}

function canonicalizeBootstrapCredentialTrigger(sqlite: Database.Database): void {
  sqlite.exec(`
    DROP TRIGGER bootstrap_credentials_consume_once;
    ${CANONICAL_BOOTSTRAP_CREDENTIALS_CONSUME_ONCE_SQL};
  `);
}

const migrations: Migration[] = [
  { version: 1, name: "baseline_v1", up: (sqlite) => sqlite.exec(baselineSql) },
  { version: 2, name: "content_addressed_persistence", up: addPersistenceIntegrity },
  { version: 3, name: "enterprise_workflow_foundation", up: addEnterpriseWorkflowFoundation },
  { version: 4, name: "preview_retention", up: addPreviewRetention },
  { version: 5, name: "organization_scoped_outbox", up: addOrganizationScopedOutbox },
  { version: 6, name: "enterprise_workflow_integrity", up: addEnterpriseWorkflowIntegrity },
  { version: 7, name: "enterprise_delivery_operations", up: addEnterpriseDeliveryOperations },
  { version: 8, name: "enterprise_domain_models", up: addEnterpriseDomainModels },
  { version: 9, name: "audit_retention_execution", up: addAuditRetentionExecution },
  { version: 10, name: "portable_import_provenance", up: addPortableImportProvenance },
  { version: 11, name: "render_job_persistence", up: addRenderJobPersistence },
  { version: 12, name: "handoff_execution_decisions", up: addHandoffExecutionDecisions },
  { version: 13, name: "component_source_persistence", up: addComponentSourcePersistence },
  { version: 14, name: "browser_session_authentication", up: addBrowserSessionAuthentication },
  { version: 15, name: "preview_render_metadata", up: addPreviewRenderMetadata },
  { version: 16, name: "bootstrap_credential_trigger_canonicalization", up: canonicalizeBootstrapCredentialTrigger },
];

const migrationNames = new Set<string>();
for (const [index, migration] of migrations.entries()) {
  if (migration.version !== index + 1 || !migration.name || migrationNames.has(migration.name)) {
    throw new Error("Database migration definitions must use contiguous versions and unique nonempty names.");
  }
  migrationNames.add(migration.name);
}

export const DATABASE_MIGRATION_LEDGER: readonly Readonly<DatabaseMigrationLedgerEntry>[] = Object.freeze(
  migrations.map(({ version, name }) => Object.freeze({ version, name })),
);

export const DATABASE_SCHEMA_VERSION = DATABASE_MIGRATION_LEDGER.at(-1)?.version ?? 0;

export function validateDatabaseMigrationLedger(
  recorded: ReadonlyArray<{ version: unknown; name: unknown }>,
  options: { allowEmpty?: boolean } = {},
): number {
  if (recorded.length === 0) {
    if (options.allowEmpty) return 0;
    throw new Error("Database migration ledger is empty.");
  }
  const newest = recorded.at(-1)?.version;
  if (typeof newest === "number" && Number.isSafeInteger(newest) && newest > DATABASE_SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${newest} is newer than this application supports (${DATABASE_SCHEMA_VERSION}).`,
    );
  }
  for (const [index, row] of recorded.entries()) {
    const expected = DATABASE_MIGRATION_LEDGER[index];
    if (
      !Number.isSafeInteger(row.version)
      || typeof row.name !== "string"
      || !expected
      || expected.version !== row.version
      || expected.name !== row.name
    ) {
      throw new Error(`Database migration ledger is not a recognized contiguous prefix at version ${String(row.version)}.`);
    }
  }
  return recorded.at(-1)!.version as number;
}

interface RequiredTableShape {
  readonly name: string;
  readonly columns: readonly string[];
  readonly sqlFragments?: readonly string[];
  readonly sqlSha256?: string;
}

interface RequiredIndexShape {
  readonly name: string;
  readonly table: string;
  readonly columns: ReadonlyArray<{ readonly name: string; readonly descending?: boolean }>;
}

interface RequiredTriggerShape {
  readonly name: string;
  readonly table: string;
  readonly sqlFragments: readonly string[];
  readonly sqlSha256?: string;
  readonly sqlVariants?: readonly string[];
}

interface RequiredMigrationShape {
  readonly version: number;
  readonly tables: readonly RequiredTableShape[];
  readonly indexes: readonly RequiredIndexShape[];
  readonly triggers: readonly RequiredTriggerShape[];
  readonly forbiddenTriggers?: readonly string[];
}

const requiredEnterpriseMigrationShapes: readonly RequiredMigrationShape[] = [
  {
    version: 9,
    tables: [
      {
        name: "audit_retention_previews",
        columns: [
          "id", "organization_id", "actor_id", "configuration_hash", "policy_hash", "retention_days",
          "cutoff_at", "audit_event_ids_json", "audit_event_count", "audit_event_bytes", "audit_first_id",
          "audit_last_id", "audit_events_hash", "audit_has_more", "outbox_event_ids_json",
          "outbox_event_count", "outbox_event_bytes", "outbox_first_id", "outbox_last_id",
          "outbox_events_hash", "outbox_has_more", "plan_hash", "status", "created_at", "expires_at",
          "committed_run_id", "committed_at",
        ],
      },
      {
        name: "audit_retention_runs",
        columns: [
          "id", "organization_id", "preview_id", "actor_id", "idempotency_key", "request_hash",
          "configuration_hash", "policy_hash", "retention_days", "cutoff_at", "audit_event_ids_json",
          "audit_event_count", "audit_event_bytes", "audit_first_id", "audit_last_id", "audit_events_hash",
          "audit_has_more", "outbox_event_ids_json", "outbox_event_count", "outbox_event_bytes",
          "outbox_first_id", "outbox_last_id", "outbox_events_hash", "outbox_has_more", "plan_hash",
          "previous_run_hash", "run_hash", "commit_audit_event_id", "commit_outbox_event_id", "completed_at",
        ],
      },
      {
        name: "audit_retention_delete_permits",
        columns: ["run_id", "organization_id", "event_kind", "event_id"],
      },
    ],
    indexes: [
      {
        name: "audit_retention_previews_org_status_expiry",
        table: "audit_retention_previews",
        columns: [{ name: "organization_id" }, { name: "status" }, { name: "expires_at" }],
      },
      {
        name: "audit_retention_runs_org_completed",
        table: "audit_retention_runs",
        columns: [
          { name: "organization_id" },
          { name: "completed_at", descending: true },
          { name: "id", descending: true },
        ],
      },
      {
        name: "audit_retention_runs_org_sequence",
        table: "audit_retention_runs",
        columns: [{ name: "organization_id" }, { name: "commit_audit_event_id", descending: true }],
      },
      {
        name: "audit_retention_delete_permits_lookup",
        table: "audit_retention_delete_permits",
        columns: [{ name: "organization_id" }, { name: "event_kind" }, { name: "event_id" }],
      },
    ],
    triggers: [
      {
        name: "audit_events_retention_delete",
        table: "audit_events",
        sqlFragments: [
          "before delete on audit_events",
          "audit_retention_delete_permits",
          "audit_retention_runs",
          "old.action like 'audit_retention.%'",
          "old.created_at < r.cutoff_at",
          "raise(abort",
        ],
      },
      {
        name: "event_outbox_retention_delete",
        table: "event_outbox",
        sqlFragments: [
          "before delete on event_outbox",
          "old.published_at is null",
          "audit_retention_delete_permits",
          "audit_retention_runs",
          "p.event_kind = 'outbox'",
          "old.created_at < r.cutoff_at",
          "raise(abort",
        ],
      },
      {
        name: "audit_retention_runs_immutable_update",
        table: "audit_retention_runs",
        sqlFragments: ["before update on audit_retention_runs", "raise(abort"],
      },
      {
        name: "audit_retention_runs_immutable_delete",
        table: "audit_retention_runs",
        sqlFragments: ["before delete on audit_retention_runs", "raise(abort"],
      },
    ],
    forbiddenTriggers: ["audit_events_immutable_delete"],
  },
  {
    version: 10,
    tables: [
      {
        name: "portable_imports",
        columns: [
          "id", "organization_id", "mode", "bundle_sha256", "source_document_id",
          "source_document_revision", "source_revision_id", "source_revision_hash_claim", "target_design_id",
          "target_revision_id", "id_map_json", "manifest_json", "diagnostics_json", "created_by", "created_at",
        ],
      },
    ],
    indexes: [
      {
        name: "portable_imports_org_created",
        table: "portable_imports",
        columns: [
          { name: "organization_id" },
          { name: "created_at", descending: true },
          { name: "id", descending: true },
        ],
      },
    ],
    triggers: [
      {
        name: "portable_imports_immutable_update",
        table: "portable_imports",
        sqlFragments: ["before update on portable_imports", "raise(abort"],
      },
      {
        name: "portable_imports_immutable_delete",
        table: "portable_imports",
        sqlFragments: ["before delete on portable_imports", "raise(abort"],
      },
    ],
  },
  {
    version: 11,
    tables: [
      {
        name: "render_jobs",
        columns: [
          "id", "organization_id", "design_id", "revision_id", "document_id", "document_revision",
          "scope_kind", "operation", "kind", "status", "owner_id", "request_hash", "request_metadata_json", "renderer_version",
          "renderer_ipc_protocol_version", "raster_normalizer_version", "output_sha256", "output_bytes",
          "output_width", "output_height", "output_renderer", "warnings_json", "error_code",
          "error_message", "retryable", "created_at", "started_at", "completed_at", "heartbeat_at",
          "lease_expires_at",
        ],
        sqlFragments: [
          "check(scope_kind in ('organization', 'internal'))",
          "check(kind in ('render', 'normalize_raster'))",
          "check(status in ('queued', 'running', 'succeeded', 'failed'))",
          "json_valid(request_metadata_json) = 1",
          "status = 'queued'",
          "status = 'running'",
          "status = 'succeeded'",
          "status = 'failed'",
          "kind = 'normalize_raster' and output_renderer = 'chromium'",
        ],
        sqlSha256: "ff9dc84361a86355c07d83bbc99910938f8a67ed800b149fd87e224c84abd684",
      },
      {
        name: "render_job_delete_permits",
        columns: ["job_id", "organization_id", "cutoff_at", "created_at"],
        sqlFragments: [
          "job_id text primary key references render_jobs(id) on delete cascade",
          "organization_id text references organizations(id) on delete restrict",
          "julianday(cutoff_at) is not null",
        ],
        sqlSha256: "4929351eb018e80c1fa650be90d7f62bb5509f4b14d50c0699e93a8df7e5cd12",
      },
    ],
    indexes: [
      {
        name: "render_jobs_status_created",
        table: "render_jobs",
        columns: [{ name: "status" }, { name: "created_at" }, { name: "id" }],
      },
      {
        name: "render_jobs_design_created",
        table: "render_jobs",
        columns: [
          { name: "design_id" },
          { name: "created_at", descending: true },
          { name: "id", descending: true },
        ],
      },
      {
        name: "render_jobs_retention",
        table: "render_jobs",
        columns: [
          { name: "status" },
          { name: "completed_at" },
          { name: "organization_id" },
          { name: "id" },
        ],
      },
    ],
    triggers: [
      {
        name: "render_jobs_initial_insert",
        table: "render_jobs",
        sqlFragments: [
          "before insert on render_jobs",
          "new.status != 'queued'",
          "canonical queued state",
          "raise(abort",
        ],
        sqlSha256: "bbea9381087cc16a67355afcd55bede05f7c40d7b1553807a78263a818b12951",
      },
      {
        name: "render_jobs_lifecycle_update",
        table: "render_jobs",
        sqlFragments: [
          "before update on render_jobs",
          "old.status in ('succeeded', 'failed')",
          "old.status = 'queued' and new.status in ('queued', 'running', 'failed')",
          "old.status = 'running' and new.status in ('running', 'succeeded', 'failed')",
          "raise(abort",
        ],
        sqlSha256: "d68243e8d89866b703c7937689e8cf675f8d7e6583c214b8c8a0999897c8c010",
      },
      {
        name: "render_jobs_retention_delete",
        table: "render_jobs",
        sqlFragments: [
          "before delete on render_jobs",
          "render_job_delete_permits",
          "old.completed_at <= permit.cutoff_at",
          "raise(abort",
        ],
        sqlSha256: "0e461e8b12fdc8259db0dcaf70a485c4430337a1c09636c4669352e05f002991",
      },
    ],
  },
  {
    version: 12,
    tables: [
      {
        name: "handoff_execution_decisions",
        columns: [
          "id", "handoff_id", "handoff_version", "sequence", "kind", "outcome",
          "supersedes_decision_id", "evidence_json", "evidence_hash", "actor_id", "created_at",
        ],
        sqlFragments: [
          "foreign key(handoff_id, handoff_version) references handoff_versions(handoff_id, version) on delete restrict",
          "kind in ( 'plan_approval', 'isolation_choice', 'diff_review', 'validation_approval', 'commit_approval', 'push_authorization', 'pull_request_request' )",
          "kind = 'isolation_choice' and outcome in ('branch', 'worktree', 'denied', 'revoked')",
          "kind = 'push_authorization' and outcome in ('authorized', 'denied', 'revoked')",
          "kind = 'pull_request_request' and outcome in ('requested', 'not_requested', 'denied', 'revoked')",
          "json_valid(evidence_json) = 1",
          "length(evidence_json) between 2 and 32768",
          "length(evidence_hash) = 64",
        ],
      },
    ],
    indexes: [
      {
        name: "handoff_execution_decisions_handoff_sequence",
        table: "handoff_execution_decisions",
        columns: [{ name: "handoff_id" }, { name: "sequence" }],
      },
      {
        name: "handoff_execution_decisions_handoff_kind_sequence",
        table: "handoff_execution_decisions",
        columns: [
          { name: "handoff_id" },
          { name: "kind" },
          { name: "sequence", descending: true },
        ],
      },
    ],
    triggers: [
      {
        name: "handoff_execution_decisions_insert_integrity",
        table: "handoff_execution_decisions",
        sqlFragments: [
          "before insert on handoff_execution_decisions",
          "max(existing.sequence) + 1",
          "new.handoff_version != ( select handoff.current_version",
          "new.supersedes_decision_id is not ( select existing.id",
          "new.outcome = 'revoked'",
          "not in ('in_review', 'approved', 'implementing')",
          "!= 'implementing'",
          "raise(abort",
        ],
      },
      {
        name: "handoff_execution_decisions_immutable_update",
        table: "handoff_execution_decisions",
        sqlFragments: ["before update on handoff_execution_decisions", "raise(abort"],
      },
      {
        name: "handoff_execution_decisions_immutable_delete",
        table: "handoff_execution_decisions",
        sqlFragments: ["before delete on handoff_execution_decisions", "raise(abort"],
      },
    ],
  },
  {
    version: 13,
    tables: [
      {
        name: "component_definitions",
        columns: ["source_json", "source_hash"],
      },
      {
        name: "design_system_upgrade_previews",
        columns: ["base_revision_id", "base_snapshot_hash", "result_snapshot_hash"],
      },
    ],
    indexes: [],
    triggers: [
      {
        name: "component_definitions_source_insert_integrity",
        table: "component_definitions",
        sqlFragments: [
          "before insert on component_definitions",
          "new.source_json is null",
          "new.source_hash is null",
          "raise(abort",
        ],
      },
      {
        name: "design_system_upgrade_previews_exact_metadata_insert",
        table: "design_system_upgrade_previews",
        sqlFragments: [
          "before insert on design_system_upgrade_previews",
          "new.base_revision_id is null",
          "new.base_snapshot_hash is null",
          "new.result_snapshot_hash is null",
          "raise(abort",
        ],
      },
      {
        name: "design_system_upgrade_previews_exact_metadata_immutable",
        table: "design_system_upgrade_previews",
        sqlFragments: [
          "before update on design_system_upgrade_previews",
          "new.base_revision_id is not old.base_revision_id",
          "new.base_snapshot_hash is not old.base_snapshot_hash",
          "new.result_snapshot_hash is not old.result_snapshot_hash",
          "raise(abort",
        ],
      },
    ],
  },
  {
    version: 14,
    tables: [
      {
        name: "password_accounts",
        columns: [
          "id", "organization_id", "principal_id", "login_name", "login_name_normalized",
          "password_hash", "bootstrap_account", "created_at", "updated_at",
        ],
        sqlFragments: [
          "bootstrap_account integer not null default 1 check(bootstrap_account = 1)",
          "unique(organization_id, login_name_normalized)",
          "unique(principal_id)",
        ],
      },
      {
        name: "browser_sessions",
        columns: [
          "id", "organization_id", "account_id", "principal_id", "token_hash", "csrf_token_hash",
          "created_at", "last_used_at", "idle_expires_at", "expires_at", "revoked_at",
        ],
        sqlFragments: [
          "token_hash text not null unique",
          "check(idle_expires_at <= expires_at)",
          "check(revoked_at is null or revoked_at >= created_at)",
        ],
      },
      {
        name: "login_attempts",
        columns: [
          "identity_hash", "failure_count", "window_started_at", "locked_until", "updated_at",
        ],
        sqlFragments: ["failure_count integer not null check(failure_count between 1 and 1000)"],
      },
      {
        name: "bootstrap_credentials",
        columns: ["id", "token_hash", "created_at", "consumed_at", "consumed_by"],
        sqlFragments: [
          "id text primary key check(id = 'initial_admin')",
          "length(token_hash) = 64",
          "consumed_at is null and consumed_by is null",
        ],
      },
    ],
    indexes: [
      {
        name: "password_accounts_single_bootstrap",
        table: "password_accounts",
        columns: [{ name: "bootstrap_account" }],
      },
      {
        name: "browser_sessions_principal_active",
        table: "browser_sessions",
        columns: [{ name: "principal_id" }, { name: "revoked_at" }, { name: "idle_expires_at" }],
      },
    ],
    triggers: [
      {
        name: "password_accounts_require_bootstrap_admin",
        table: "password_accounts",
        sqlFragments: [
          "before insert on password_accounts",
          "p.kind = 'human'",
          "m.role = 'organization_admin'",
          "raise(abort",
        ],
      },
      {
        name: "password_accounts_identity_immutable",
        table: "password_accounts",
        sqlFragments: ["before update on password_accounts", "new.principal_id is not old.principal_id", "raise(abort"],
      },
      {
        name: "password_accounts_immutable_delete",
        table: "password_accounts",
        sqlFragments: ["before delete on password_accounts", "raise(abort"],
      },
      {
        name: "browser_sessions_require_account_principal",
        table: "browser_sessions",
        sqlFragments: ["before insert on browser_sessions", "password_accounts", "raise(abort"],
      },
      {
        name: "browser_sessions_identity_immutable",
        table: "browser_sessions",
        sqlFragments: ["before update on browser_sessions", "new.token_hash is not old.token_hash", "raise(abort"],
      },
      {
        name: "bootstrap_credentials_consume_once",
        table: "bootstrap_credentials",
        sqlFragments: [
          "before update on bootstrap_credentials",
          "old.consumed_at is not null",
          "raise(abort",
        ],
        sqlVariants: [
          LEGACY_BOOTSTRAP_CREDENTIALS_CONSUME_ONCE_SQL,
          CANONICAL_BOOTSTRAP_CREDENTIALS_CONSUME_ONCE_SQL,
        ],
      },
      {
        name: "bootstrap_credentials_immutable_delete",
        table: "bootstrap_credentials",
        sqlFragments: ["before delete on bootstrap_credentials", "raise(abort"],
      },
    ],
  },
  {
    version: 15,
    tables: [
      {
        name: "previews",
        columns: ["render_metadata_json"],
        sqlFragments: [
          "render_metadata_json text check",
          "json_valid(render_metadata_json) = 1",
          "length(cast(render_metadata_json as blob)) between 2 and 65536",
        ],
      },
    ],
    indexes: [],
    triggers: [
      {
        name: "previews_render_metadata_immutable",
        table: "previews",
        sqlFragments: [
          "before update of render_metadata_json on previews",
          "old.render_metadata_json is not null",
          "new.render_metadata_json is null",
          "raise(abort",
        ],
      },
    ],
  },
  {
    version: 16,
    tables: [],
    indexes: [],
    triggers: [
      {
        name: "bootstrap_credentials_consume_once",
        table: "bootstrap_credentials",
        sqlFragments: [
          "before update on bootstrap_credentials",
          "new.consumed_at is null) != (new.consumed_by is null",
          "new.consumed_at is not null and new.token_hash is not old.token_hash",
          "raise(abort",
        ],
        sqlVariants: [CANONICAL_BOOTSTRAP_CREDENTIALS_CONSUME_ONCE_SQL],
      },
    ],
  },
];

function quotedSchemaIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error(`Invalid internal schema identifier: ${value}.`);
  return `"${value}"`;
}

function normalizedSchemaSql(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function requiredSchemaObject(
  sqlite: Database.Database,
  type: "table" | "index" | "trigger",
  name: string,
  version: number,
): { table: string; sql: string | null } {
  const row = sqlite.prepare(
    "SELECT tbl_name AS table_name, sql FROM sqlite_master WHERE type = ? AND name = ?",
  ).get(type, name) as { table_name: unknown; sql: unknown } | undefined;
  if (!row || typeof row.table_name !== "string" || (row.sql !== null && typeof row.sql !== "string")) {
    throw new Error(`Database schema migration ${version} is missing required ${type} ${name}.`);
  }
  return { table: row.table_name, sql: row.sql as string | null };
}

export function validateDatabaseSchemaShape(sqlite: Database.Database, appliedVersion: number): void {
  if (!Number.isSafeInteger(appliedVersion) || appliedVersion < 0 || appliedVersion > DATABASE_SCHEMA_VERSION) {
    throw new Error(`Cannot validate unsupported database schema version ${String(appliedVersion)}.`);
  }
  for (const shape of requiredEnterpriseMigrationShapes) {
    if (appliedVersion < shape.version) continue;
    for (const table of shape.tables) {
      const object = requiredSchemaObject(sqlite, "table", table.name, shape.version);
      const rows = sqlite.prepare(`PRAGMA table_info(${quotedSchemaIdentifier(table.name)})`).all() as Array<{
        name: unknown;
      }>;
      const columns = new Set(rows.map((row) => row.name).filter((name): name is string => typeof name === "string"));
      const missing = table.columns.filter((column) => !columns.has(column));
      if (missing.length > 0) {
        throw new Error(
          `Database schema migration ${shape.version} table ${table.name} is missing required columns: ${missing.join(", ")}.`,
        );
      }
      if (table.sqlFragments && table.sqlFragments.length > 0) {
        if (object.sql === null) {
          throw new Error(`Database schema migration ${shape.version} table ${table.name} has unexpected SQL.`);
        }
        const sql = normalizedSchemaSql(object.sql);
        const missingSql = table.sqlFragments.filter((fragment) => !sql.includes(normalizedSchemaSql(fragment)));
        if (missingSql.length > 0) {
          throw new Error(`Database schema migration ${shape.version} table ${table.name} has unexpected SQL.`);
        }
      }
      if (table.sqlSha256) {
        if (object.sql === null
          || createHash("sha256").update(normalizedSchemaSql(object.sql)).digest("hex") !== table.sqlSha256) {
          throw new Error(`Database schema migration ${shape.version} table ${table.name} has unexpected SQL digest.`);
        }
      }
    }
    for (const index of shape.indexes) {
      const object = requiredSchemaObject(sqlite, "index", index.name, shape.version);
      if (object.table !== index.table) {
        throw new Error(
          `Database schema migration ${shape.version} index ${index.name} belongs to unexpected table ${object.table}.`,
        );
      }
      const actual = (sqlite.prepare(`PRAGMA index_xinfo(${quotedSchemaIdentifier(index.name)})`).all() as Array<{
        seqno: unknown;
        name: unknown;
        desc: unknown;
        key: unknown;
      }>)
        .filter((row) => row.key === 1)
        .sort((left, right) => Number(left.seqno) - Number(right.seqno))
        .map((row) => ({ name: row.name, descending: row.desc === 1 }));
      const expected = index.columns.map((column) => ({
        name: column.name,
        descending: column.descending === true,
      }));
      if (actual.length !== expected.length || actual.some((column, position) => (
        column.name !== expected[position]?.name || column.descending !== expected[position]?.descending
      ))) {
        throw new Error(`Database schema migration ${shape.version} index ${index.name} has unexpected columns.`);
      }
    }
    for (const trigger of shape.triggers) {
      const object = requiredSchemaObject(sqlite, "trigger", trigger.name, shape.version);
      if (object.table !== trigger.table || object.sql === null) {
        throw new Error(
          `Database schema migration ${shape.version} trigger ${trigger.name} has an unexpected target.`,
        );
      }
      const sql = normalizedSchemaSql(object.sql);
      const missing = trigger.sqlFragments.filter((fragment) => !sql.includes(normalizedSchemaSql(fragment)));
      if (missing.length > 0) {
        throw new Error(`Database schema migration ${shape.version} trigger ${trigger.name} has unexpected SQL.`);
      }
      if (trigger.sqlVariants
        && !trigger.sqlVariants.some((variant) => normalizedSchemaSql(variant) === sql)) {
        throw new Error(`Database schema migration ${shape.version} trigger ${trigger.name} has unexpected SQL.`);
      }
      if (trigger.sqlSha256
        && createHash("sha256").update(sql).digest("hex") !== trigger.sqlSha256) {
        throw new Error(`Database schema migration ${shape.version} trigger ${trigger.name} has unexpected SQL digest.`);
      }
    }
    for (const trigger of shape.forbiddenTriggers ?? []) {
      const row = sqlite.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?",
      ).get(trigger);
      if (row) {
        throw new Error(`Database schema migration ${shape.version} retains forbidden trigger ${trigger}.`);
      }
    }
  }
}

function runMigrations(
  sqlite: Database.Database,
  targetVersion = DATABASE_SCHEMA_VERSION,
  appliedAt: (migration: DatabaseMigrationLedgerEntry) => string = () => new Date().toISOString(),
): void {
  if (!Number.isSafeInteger(targetVersion) || targetVersion < 1 || targetVersion > DATABASE_SCHEMA_VERSION) {
    throw new Error(`Cannot migrate to unsupported database schema version ${String(targetVersion)}.`);
  }
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  const recorded = sqlite.prepare(
    "SELECT version, name FROM schema_migrations ORDER BY version",
  ).all() as Array<{ version: number; name: string }>;
  const recordedVersion = validateDatabaseMigrationLedger(recorded, { allowEmpty: true });
  if (recordedVersion > targetVersion) {
    throw new Error(
      `Database schema version ${recordedVersion} cannot be downgraded to ${targetVersion}.`,
    );
  }
  validateDatabaseSchemaShape(sqlite, recordedVersion);
  for (const migration of migrations) {
    if (migration.version > targetVersion) break;
    const transaction = sqlite.transaction(() => {
      const applied = sqlite.prepare(
        "SELECT name FROM schema_migrations WHERE version = ?",
      ).get(migration.version) as { name: string } | undefined;
      if (applied) {
        if (applied.name !== migration.name) {
          throw new Error(`Database migration ${migration.version} has unexpected name ${applied.name}.`);
        }
        return;
      }
      migration.up(sqlite);
      validateDatabaseSchemaShape(sqlite, migration.version);
      sqlite.prepare(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
      ).run(migration.version, migration.name, appliedAt(migration));
    });
    transaction.immediate();
  }
  validateDatabaseSchemaShape(sqlite, targetVersion);
}

/**
 * Builds a fresh, genuine historical schema for deterministic migration tests.
 *
 * This is deliberately prefix-only: it applies the same immutable migration
 * functions used by production and refuses to downgrade an existing database.
 * Fixture timestamps are stable so checked-in evidence does not depend on the
 * wall clock. Production startup always calls the latest migration target.
 */
export function applyDatabaseMigrationPrefixForTesting(
  sqlite: Database.Database,
  targetVersion: number,
): void {
  runMigrations(
    sqlite,
    targetVersion,
    (migration) => `2026-01-${String(migration.version).padStart(2, "0")}T00:00:00.000Z`,
  );
}

export class DesignerDatabase {
  readonly sqlite: Database.Database;
  readonly orm: ReturnType<typeof drizzle<typeof schema>>;

  constructor(filename: string) {
    if (filename !== ":memory:") fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.sqlite = new Database(filename);
    try {
      this.sqlite.pragma("foreign_keys = ON");
      this.sqlite.pragma("busy_timeout = 5000");
      if (filename !== ":memory:") this.sqlite.pragma("journal_mode = WAL");
      this.sqlite.pragma("synchronous = NORMAL");
      runMigrations(this.sqlite);
      this.writeVersionMetadata();
      this.orm = drizzle(this.sqlite, { schema });
    } catch (error) {
      this.sqlite.close();
      throw error;
    }
  }

  close(): void {
    this.sqlite.close();
  }

  schemaVersion(): number {
    const row = this.sqlite.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number | null };
    return row.version ?? 0;
  }

  metadata(key: string): string | null {
    const row = this.sqlite.prepare("SELECT value FROM system_metadata WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  readSnapshot(snapshotHash: string): string {
    return readSnapshotJson(this.sqlite, snapshotHash);
  }

  cleanup(now = new Date().toISOString()): void {
    this.cleanupPreviews(now);
    this.cleanupIdempotency(now);
    cleanupRetainedRenderJobs(this.sqlite, now);
  }

  cleanupPreviews(now = new Date().toISOString()): void {
    this.sqlite.prepare(
      "UPDATE previews SET status = 'expired' WHERE expires_at <= ? AND status IN ('ready', 'blocked')",
    ).run(now);
    const nowMilliseconds = Date.parse(now);
    if (!Number.isFinite(nowMilliseconds)) throw new Error("Preview cleanup requires a valid ISO timestamp.");
    const purgeBefore = new Date(nowMilliseconds - 86_400_000).toISOString();
    this.sqlite.prepare(
      "DELETE FROM previews WHERE status = 'expired' AND expires_at <= ?",
    ).run(purgeBefore);
    this.sqlite.prepare(
      `DELETE FROM snapshots
       WHERE NOT EXISTS (SELECT 1 FROM revisions WHERE revisions.snapshot_hash = snapshots.snapshot_hash)
         AND NOT EXISTS (
           SELECT 1 FROM previews
           WHERE previews.base_snapshot_hash = snapshots.snapshot_hash
              OR previews.result_snapshot_hash = snapshots.snapshot_hash
         )`,
    ).run();
  }

  cleanupIdempotency(now = new Date().toISOString()): void {
    this.sqlite.prepare("DELETE FROM idempotency WHERE expires_at <= ?").run(now);
  }

  private writeVersionMetadata(): void {
    const now = new Date().toISOString();
    const values: Record<string, string> = {
      database_schema_version: String(DATABASE_SCHEMA_VERSION),
      command_engine_version: DEFAULT_RUNTIME_VERSIONS.commandEngine,
      renderer_version: DEFAULT_RUNTIME_VERSIONS.renderer,
      font_bundle_version: DEFAULT_RUNTIME_VERSIONS.fontBundle,
      application_build_version: DEFAULT_RUNTIME_VERSIONS.application,
      export_format_version: DEFAULT_RUNTIME_VERSIONS.exportFormat,
    };
    const statement = this.sqlite.prepare(
      `INSERT INTO system_metadata (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    const transaction = this.sqlite.transaction(() => {
      for (const [key, value] of Object.entries(values)) statement.run(key, value, now);
    });
    transaction.immediate();
  }
}
