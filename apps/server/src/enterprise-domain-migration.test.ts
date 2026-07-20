import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { DesignerDatabase } from "./db/database.js";
import { EventHub } from "./events.js";
import { DesignerService } from "./service.js";

const temporaryDirectories: string[] = [];

function temporaryDatabase(name = "designer.sqlite"): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "formaspec-domain-migration-"));
  temporaryDirectories.push(directory);
  return path.join(directory, name);
}

function simulateVersionSevenDatabase(filename: string): void {
  const sqlite = new Database(filename);
  sqlite.exec(`
    DROP TRIGGER schema_migrations_immutable_update;
    DROP TRIGGER schema_migrations_immutable_delete;
    DROP TRIGGER audit_events_retention_delete;
    DROP TRIGGER event_outbox_retention_delete;
    DROP TRIGGER audit_retention_runs_immutable_update;
    DROP TRIGGER audit_retention_runs_immutable_delete;
    DROP TRIGGER portable_imports_immutable_update;
    DROP TRIGGER portable_imports_immutable_delete;

    DROP TABLE portable_imports;
    DROP TABLE audit_retention_delete_permits;
    DROP TABLE audit_retention_runs;
    DROP TABLE audit_retention_previews;

    DROP TABLE redesign_transitions;
    DROP TABLE redesign_assessment_versions;
    DROP TABLE redesign_assessments;
    DROP TABLE handoff_transitions;
    DROP TABLE handoff_versions;
    DROP TABLE handoffs;
    DROP TABLE implementation_mappings;
    DROP TABLE repository_inventories;
    DROP TABLE design_system_upgrade_previews;
    DROP TABLE project_design_system_pins;
    DROP TABLE design_system_releases;
    DROP TABLE component_definitions;
    DROP TABLE design_system_tokens;
    DROP TABLE design_systems;

    DELETE FROM schema_migrations WHERE version >= 8;

    CREATE TRIGGER audit_events_immutable_delete
    BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit events are immutable'); END;

    CREATE TRIGGER schema_migrations_immutable_update
    BEFORE UPDATE ON schema_migrations BEGIN SELECT RAISE(ABORT, 'schema migrations are immutable'); END;
    CREATE TRIGGER schema_migrations_immutable_delete
    BEFORE DELETE ON schema_migrations BEGIN SELECT RAISE(ABORT, 'schema migrations are immutable'); END;
  `);
  sqlite.close();
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("enterprise domain migration", () => {
  it("brings a clean database through the enterprise domain, audit-retention, and portable-import migrations", () => {
    const database = new DesignerDatabase(temporaryDatabase());
    try {
      expect(database.schemaVersion()).toBe(10);
      expect(database.metadata("database_schema_version")).toBe("10");
      const tables = database.sqlite.prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN (
           'design_systems', 'design_system_tokens', 'component_definitions',
           'design_system_releases', 'project_design_system_pins',
           'design_system_upgrade_previews', 'repository_inventories',
           'implementation_mappings', 'handoffs', 'handoff_versions',
           'handoff_transitions', 'redesign_assessments',
           'redesign_assessment_versions', 'redesign_transitions'
         ) ORDER BY name`,
      ).all() as Array<{ name: string }>;
      expect(tables.map((row) => row.name)).toEqual([
        "component_definitions",
        "design_system_releases",
        "design_system_tokens",
        "design_system_upgrade_previews",
        "design_systems",
        "handoff_transitions",
        "handoff_versions",
        "handoffs",
        "implementation_mappings",
        "project_design_system_pins",
        "redesign_assessment_versions",
        "redesign_assessments",
        "redesign_transitions",
        "repository_inventories",
      ]);
    } finally {
      database.close();
    }
  });

  it("upgrades a copied version-7 database without changing any stored V1 revision bytes or hashes", () => {
    const source = temporaryDatabase("version-7.sqlite");
    const initial = new DesignerDatabase(source);
    const service = new DesignerService(initial, new EventHub(), 900);
    const created = service.createDesign("local", {
      name: "Preserved V1 project",
      preset: "phone",
      idempotencyKey: "migration-v8-preserve-v1-0001",
    });
    const before = initial.sqlite.prepare(
      `SELECT id, design_id, version, parent_revision_id, actor_id, message,
              document_json, operations_json, snapshot_hash, operation_hash,
              parent_revision_hash, revision_hash, created_at
       FROM revisions WHERE id = ?`,
    ).get(created.revision.id);
    initial.close();

    simulateVersionSevenDatabase(source);
    const copied = path.join(path.dirname(source), "copied-version-7.sqlite");
    fs.copyFileSync(source, copied);

    const upgraded = new DesignerDatabase(copied);
    try {
      expect(upgraded.schemaVersion()).toBe(10);
      expect(upgraded.sqlite.prepare(
        "SELECT name FROM schema_migrations WHERE version = 8",
      ).get()).toEqual({ name: "enterprise_domain_models" });
      expect(upgraded.sqlite.prepare(
        "SELECT name FROM schema_migrations WHERE version = 9",
      ).get()).toEqual({ name: "audit_retention_execution" });
      expect(upgraded.sqlite.prepare(
        "SELECT name FROM schema_migrations WHERE version = 10",
      ).get()).toEqual({ name: "portable_import_provenance" });
      expect(upgraded.sqlite.prepare(
        `SELECT id, design_id, version, parent_revision_id, actor_id, message,
                document_json, operations_json, snapshot_hash, operation_hash,
                parent_revision_hash, revision_hash, created_at
         FROM revisions WHERE id = ?`,
      ).get(created.revision.id)).toEqual(before);
      expect(upgraded.sqlite.prepare(
        "SELECT current_version, current_revision_id FROM designs WHERE id = ?",
      ).get(created.document.id)).toEqual({
        current_version: 1,
        current_revision_id: created.revision.id,
      });
    } finally {
      upgraded.close();
    }
  });

  it("rejects invalid domain rows and keeps all versioned records immutable", () => {
    const database = new DesignerDatabase(temporaryDatabase());
    const now = "2026-07-19T12:00:00.000Z";
    try {
      expect(() => database.sqlite.prepare(
        `INSERT INTO design_systems
         (id, organization_id, name, description, status, created_by, created_at, updated_at)
         VALUES ('system_missing_org', 'organization_missing', 'Invalid', '', 'active', 'local', ?, ?)`,
      ).run(now, now)).toThrow(/FOREIGN KEY constraint failed/);

      database.sqlite.prepare(
        `INSERT INTO design_systems
         (id, organization_id, name, description, status, created_by, created_at, updated_at)
         VALUES ('system_test', 'organization_legacy', 'Test system', '', 'active', 'local', ?, ?)`,
      ).run(now, now);

      expect(() => database.sqlite.prepare(
        `INSERT INTO design_system_tokens
         (design_system_id, token_id, version, status, token_json, created_by, created_at)
         VALUES ('system_test', 'token_invalid_json', 1, 'draft', '{', 'local', ?)`,
      ).run(now)).toThrow(/CHECK constraint failed/);
      expect(() => database.sqlite.prepare(
        `INSERT INTO design_system_tokens
         (design_system_id, token_id, version, status, token_json, created_by, created_at)
         VALUES ('system_test', 'token_invalid_status', 1, 'unknown', '{}', 'local', ?)`,
      ).run(now)).toThrow(/CHECK constraint failed/);

      database.sqlite.prepare(
        `INSERT INTO design_system_tokens
         (design_system_id, token_id, version, status, token_json, created_by, created_at)
         VALUES ('system_test', 'token_valid', 1, 'draft', '{"value":"#000000"}', 'local', ?)`,
      ).run(now);
      expect(() => database.sqlite.prepare(
        "UPDATE design_system_tokens SET token_json = '{\"value\":\"#ffffff\"}' WHERE token_id = 'token_valid'",
      ).run()).toThrow(/immutable/);
      expect(() => database.sqlite.prepare(
        "DELETE FROM design_system_tokens WHERE token_id = 'token_valid'",
      ).run()).toThrow(/immutable/);
    } finally {
      database.close();
    }
  });
});
