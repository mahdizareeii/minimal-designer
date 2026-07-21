import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { DesignerDatabase } from "./db/database.js";
import {
  HISTORICAL_FIXTURE_DIGESTS,
  HISTORICAL_FIXTURE_IDS,
  createHistoricalDatabaseFixture,
  schemaElevenPreservationFingerprint,
  schemaTwelvePreservationFingerprint,
} from "../test-fixtures/historical-database.js";

const temporaryDirectories: string[] = [];

function temporaryDatabase(name = "designer.sqlite"): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "formaspec-domain-migration-"));
  temporaryDirectories.push(directory);
  return path.join(directory, name);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("enterprise domain migration", () => {
  it("locks genuine historical schema and seeded-data digests to reviewed evidence", () => {
    const schema: Record<number, string> = {};
    let revisionOneHash = "";
    let revisionTwoHash = "";
    let assetSha256 = "";
    let schemaElevenRows = "";
    let schemaTwelveRows = "";
    for (const version of [1, 7, 8, 9, 10, 11, 12] as const) {
      const fixture = createHistoricalDatabaseFixture(temporaryDatabase(`schema-${version}-digest.sqlite`), version);
      schema[version] = fixture.evidence.schemaFingerprint;
      revisionOneHash = fixture.evidence.revisions[0]!.revisionHash;
      revisionTwoHash = fixture.evidence.revisions[1]!.revisionHash;
      assetSha256 = fixture.evidence.asset.sha256;
      schemaElevenRows = fixture.evidence.schemaElevenPreservationFingerprint ?? schemaElevenRows;
      schemaTwelveRows = fixture.evidence.schemaTwelvePreservationFingerprint ?? schemaTwelveRows;
      fixture.sqlite.close();
    }
    expect({ schema, revisionOneHash, revisionTwoHash, assetSha256, schemaElevenRows, schemaTwelveRows })
      .toEqual(HISTORICAL_FIXTURE_DIGESTS);
  });

  it("brings a clean database through enterprise domains, render jobs, and handoff execution decisions", () => {
    const database = new DesignerDatabase(temporaryDatabase());
    try {
      expect(database.schemaVersion()).toBe(13);
      expect(database.metadata("database_schema_version")).toBe("13");
      const tables = database.sqlite.prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN (
           'design_systems', 'design_system_tokens', 'component_definitions',
           'design_system_releases', 'project_design_system_pins',
           'design_system_upgrade_previews', 'repository_inventories',
           'implementation_mappings', 'handoffs', 'handoff_versions',
           'handoff_transitions', 'handoff_execution_decisions', 'redesign_assessments',
           'redesign_assessment_versions', 'redesign_transitions', 'render_jobs'
         ) ORDER BY name`,
      ).all() as Array<{ name: string }>;
      expect(tables.map((row) => row.name)).toEqual([
        "component_definitions",
        "design_system_releases",
        "design_system_tokens",
        "design_system_upgrade_previews",
        "design_systems",
        "handoff_execution_decisions",
        "handoff_transitions",
        "handoff_versions",
        "handoffs",
        "implementation_mappings",
        "project_design_system_pins",
        "redesign_assessment_versions",
        "redesign_assessments",
        "redesign_transitions",
        "render_jobs",
        "repository_inventories",
      ]);
    } finally {
      database.close();
    }
  });

  it("upgrades a genuine baseline V1 fixture without changing IDs, document bytes, assets, or derived hashes", () => {
    const source = temporaryDatabase("baseline-v1.sqlite");
    const fixture = createHistoricalDatabaseFixture(source, 1);
    expect(fixture.evidence.schemaFingerprint).toBe(HISTORICAL_FIXTURE_DIGESTS.schema[1]);
    expect(fixture.evidence.revisions.map((revision) => revision.revisionHash)).toEqual([
      HISTORICAL_FIXTURE_DIGESTS.revisionOneHash,
      HISTORICAL_FIXTURE_DIGESTS.revisionTwoHash,
    ]);
    expect(fixture.evidence.asset.sha256).toBe(HISTORICAL_FIXTURE_DIGESTS.assetSha256);
    fixture.sqlite.close();

    const upgraded = new DesignerDatabase(source);
    try {
      expect(upgraded.schemaVersion()).toBe(13);
      expect(upgraded.sqlite.prepare(
        "SELECT current_version, current_revision_id, organization_id FROM designs WHERE id = ?",
      ).get(fixture.evidence.designId)).toEqual({
        current_version: 2,
        current_revision_id: fixture.evidence.currentRevisionId,
        organization_id: "organization_legacy",
      });
      for (const expected of fixture.evidence.revisions) {
        const actual = upgraded.sqlite.prepare(
          `SELECT id, design_id, version, parent_revision_id, actor_id, message,
                  document_json, operations_json, snapshot_hash, operation_hash,
                  parent_revision_hash, revision_hash, created_at
           FROM revisions WHERE id = ?`,
        ).get(expected.id) as Record<string, unknown>;
        expect(actual).toEqual({
          id: expected.id,
          design_id: fixture.evidence.designId,
          version: expected.version,
          parent_revision_id: expected.parentRevisionId,
          actor_id: "local",
          message: expected.version === 1 ? "Create historical design" : "Attach historical asset",
          document_json: expected.documentJson,
          operations_json: expected.operationsJson,
          snapshot_hash: expected.snapshotHash,
          operation_hash: expected.operationHash,
          parent_revision_hash: expected.parentRevisionHash,
          revision_hash: expected.revisionHash,
          created_at: expected.createdAt,
        });
        expect(upgraded.readSnapshot(expected.snapshotHash)).toBe(expected.documentJson);
      }
      const asset = upgraded.sqlite.prepare(
        `SELECT id, design_id, organization_id, filename, mime_type, size_bytes, width, height,
                sha256, data, created_at FROM assets WHERE id = ?`,
      ).get(fixture.evidence.asset.id) as { data: Buffer } & Record<string, unknown>;
      expect(asset).toMatchObject({
        id: fixture.evidence.asset.id,
        design_id: fixture.evidence.designId,
        organization_id: "organization_legacy",
        filename: "historical-pixel.png",
        mime_type: "image/png",
        size_bytes: fixture.evidence.asset.bytes.length,
        width: 1,
        height: 1,
        sha256: fixture.evidence.asset.sha256,
      });
      expect(asset.data).toEqual(fixture.evidence.asset.bytes);
      expect(upgraded.sqlite.prepare("SELECT COUNT(*) AS count FROM handoff_execution_decisions").get())
        .toEqual({ count: 0 });
    } finally {
      upgraded.close();
    }
  });

  it("upgrades a genuine schema-11 fixture by adding only the decision schema and preserving enterprise rows byte-for-byte", () => {
    const source = temporaryDatabase("schema-11.sqlite");
    const fixture = createHistoricalDatabaseFixture(source, 11);
    expect(fixture.evidence.schemaFingerprint).toBe(HISTORICAL_FIXTURE_DIGESTS.schema[11]);
    expect(fixture.evidence.schemaElevenPreservationFingerprint)
      .toBe(HISTORICAL_FIXTURE_DIGESTS.schemaElevenRows);
    const before = fixture.evidence.schemaElevenPreservationFingerprint;
    fixture.sqlite.close();

    const upgraded = new DesignerDatabase(source);
    try {
      expect(upgraded.schemaVersion()).toBe(13);
      expect(upgraded.sqlite.prepare(
        "SELECT version, name FROM schema_migrations WHERE version >= 11 ORDER BY version",
      ).all()).toEqual([
        { version: 11, name: "render_job_persistence" },
        { version: 12, name: "handoff_execution_decisions" },
        { version: 13, name: "component_source_persistence" },
      ]);
      expect(schemaElevenPreservationFingerprint(upgraded.sqlite)).toBe(before);
      expect(upgraded.sqlite.prepare("SELECT organization_id FROM designs WHERE id = ?")
        .get(HISTORICAL_FIXTURE_IDS.designId)).toEqual({ organization_id: "organization_legacy" });
      expect(upgraded.sqlite.prepare("SELECT COUNT(*) AS count FROM handoff_execution_decisions").get())
        .toEqual({ count: 0 });
      expect(upgraded.sqlite.prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'trigger' AND name LIKE 'handoff_execution_decisions_%' ORDER BY name`,
      ).all()).toEqual([
        { name: "handoff_execution_decisions_immutable_delete" },
        { name: "handoff_execution_decisions_immutable_update" },
        { name: "handoff_execution_decisions_insert_integrity" },
      ]);
      expect(() => upgraded.sqlite.prepare(
        `INSERT INTO handoff_execution_decisions
         (id, handoff_id, handoff_version, sequence, kind, outcome, supersedes_decision_id,
          evidence_json, evidence_hash, actor_id, created_at)
         VALUES ('decision_invalid_fixture0001', ?, 1, 2, 'plan_approval', 'approved', NULL,
                 '{}', ?, 'principal_local', '2025-01-10T09:30:00.000Z')`,
      ).run(HISTORICAL_FIXTURE_IDS.handoffId, "0".repeat(64)))
        .toThrow(/append-only CAS or lifecycle integrity/);
      expect(upgraded.sqlite.prepare("SELECT COUNT(*) AS count FROM handoff_execution_decisions").get())
        .toEqual({ count: 0 });
    } finally {
      upgraded.close();
    }
  });

  it("upgrades a genuine schema-12 fixture without fabricating component sources or exact preview metadata", () => {
    const source = temporaryDatabase("schema-12.sqlite");
    const fixture = createHistoricalDatabaseFixture(source, 12);
    expect(fixture.evidence.schemaFingerprint).toBe(HISTORICAL_FIXTURE_DIGESTS.schema[12]);
    expect(fixture.evidence.schemaTwelvePreservationFingerprint)
      .toBe(HISTORICAL_FIXTURE_DIGESTS.schemaTwelveRows);
    const before = fixture.evidence.schemaTwelvePreservationFingerprint;
    fixture.sqlite.close();

    const upgraded = new DesignerDatabase(source);
    try {
      expect(upgraded.schemaVersion()).toBe(13);
      expect(upgraded.sqlite.prepare(
        "SELECT version, name FROM schema_migrations WHERE version >= 12 ORDER BY version",
      ).all()).toEqual([
        { version: 12, name: "handoff_execution_decisions" },
        { version: 13, name: "component_source_persistence" },
      ]);
      expect(schemaTwelvePreservationFingerprint(upgraded.sqlite)).toBe(before);
      expect(upgraded.sqlite.prepare(
        `SELECT source_json, source_hash FROM component_definitions
         WHERE design_system_id = ? AND component_id = ? AND version = 1`,
      ).get(
        HISTORICAL_FIXTURE_IDS.designSystemId,
        HISTORICAL_FIXTURE_IDS.componentDefinitionId,
      )).toEqual({ source_json: null, source_hash: null });
      expect(upgraded.sqlite.prepare(
        `SELECT base_revision_id, base_snapshot_hash, result_snapshot_hash
         FROM design_system_upgrade_previews WHERE id = ?`,
      ).get(HISTORICAL_FIXTURE_IDS.upgradePreviewId)).toEqual({
        base_revision_id: null,
        base_snapshot_hash: null,
        result_snapshot_hash: null,
      });

      const definition = upgraded.sqlite.prepare(
        `SELECT definition_json FROM component_definitions
         WHERE design_system_id = ? AND component_id = ? AND version = 1`,
      ).get(
        HISTORICAL_FIXTURE_IDS.designSystemId,
        HISTORICAL_FIXTURE_IDS.componentDefinitionId,
      ) as { definition_json: string };
      expect(() => upgraded.sqlite.prepare(
        `INSERT INTO component_definitions
         (design_system_id, component_id, version, status, definition_json, replacement_component_id,
          source_json, source_hash, created_by, created_at)
         VALUES (?, 'component_migration_pair_test', 1, 'draft', ?, NULL, '{}', NULL,
                 'principal_local', '2025-01-10T09:30:00.000Z')`,
      ).run(HISTORICAL_FIXTURE_IDS.designSystemId, definition.definition_json))
        .toThrow(/source metadata must be paired/);
      expect(() => upgraded.sqlite.prepare(
        `INSERT INTO component_definitions
         (design_system_id, component_id, version, status, definition_json, replacement_component_id,
          source_json, source_hash, created_by, created_at)
         VALUES (?, 'component_migration_hash_test', 1, 'draft', ?, NULL, '{}', ?,
                 'principal_local', '2025-01-10T09:30:00.000Z')`,
      ).run(HISTORICAL_FIXTURE_IDS.designSystemId, definition.definition_json, "A".repeat(64)))
        .toThrow(/CHECK constraint failed/);
      const oversizedUtf8Json = JSON.stringify({ value: "é".repeat(600_000) });
      expect(oversizedUtf8Json.length).toBeLessThan(1_048_576);
      expect(Buffer.byteLength(oversizedUtf8Json, "utf8")).toBeGreaterThan(1_048_576);
      expect(() => upgraded.sqlite.prepare(
        `INSERT INTO component_definitions
         (design_system_id, component_id, version, status, definition_json, replacement_component_id,
          source_json, source_hash, created_by, created_at)
         VALUES (?, 'component_migration_size_test', 1, 'draft', ?, NULL, ?, ?,
                 'principal_local', '2025-01-10T09:30:00.000Z')`,
      ).run(
        HISTORICAL_FIXTURE_IDS.designSystemId,
        definition.definition_json,
        oversizedUtf8Json,
        "a".repeat(64),
      )).toThrow(/CHECK constraint failed/);

      upgraded.sqlite.prepare(
        `INSERT INTO component_definitions
         (design_system_id, component_id, version, status, definition_json, replacement_component_id,
          source_json, source_hash, created_by, created_at)
         VALUES (?, 'component_migration_immutable_test', 1, 'draft', ?, NULL, '{}', ?,
                 'principal_local', '2025-01-10T09:30:00.000Z')`,
      ).run(HISTORICAL_FIXTURE_IDS.designSystemId, definition.definition_json, "a".repeat(64));
      expect(() => upgraded.sqlite.prepare(
        `UPDATE component_definitions SET source_hash = ?
         WHERE design_system_id = ? AND component_id = 'component_migration_immutable_test'`,
      ).run("b".repeat(64), HISTORICAL_FIXTURE_IDS.designSystemId)).toThrow(/immutable/);

      expect(() => upgraded.sqlite.prepare(
        `INSERT INTO design_system_upgrade_previews
         (id, organization_id, design_id, current_release_id, target_release_id,
          base_revision_id, base_snapshot_hash, result_snapshot_hash,
          diagnostics_json, preview_hash, status, created_by, created_at, expires_at, committed_at)
         VALUES ('upgrade_partial_exact_metadata', 'organization_legacy', ?, ?, ?, ?, NULL, NULL,
                 '{}', ?, 'ready', 'principal_local', '2025-01-10T09:30:00.000Z',
                 '2025-01-10T10:30:00.000Z', NULL)`,
      ).run(
        HISTORICAL_FIXTURE_IDS.designId,
        HISTORICAL_FIXTURE_IDS.designSystemReleaseId,
        HISTORICAL_FIXTURE_IDS.designSystemReleaseId,
        HISTORICAL_FIXTURE_IDS.revisionTwoId,
        "f".repeat(64),
      )).toThrow(/exact metadata must be complete/);
      expect(() => upgraded.sqlite.prepare(
        `UPDATE design_system_upgrade_previews
         SET base_revision_id = ?, base_snapshot_hash = ?, result_snapshot_hash = ?
         WHERE id = ?`,
      ).run(
        HISTORICAL_FIXTURE_IDS.revisionTwoId,
        fixture.evidence.revisions[1]!.snapshotHash,
        fixture.evidence.revisions[1]!.snapshotHash,
        HISTORICAL_FIXTURE_IDS.upgradePreviewId,
      )).toThrow(/exact metadata is immutable/);
    } finally {
      upgraded.close();
    }
  });

  it("rejects a tampered baseline V1 fixture atomically before recording migration 2", () => {
    const source = temporaryDatabase("tampered-baseline-v1.sqlite");
    const fixture = createHistoricalDatabaseFixture(source, 1);
    fixture.sqlite.exec("DROP TRIGGER revisions_immutable_update");
    fixture.sqlite.prepare("UPDATE revisions SET document_json = '{}' WHERE id = ?")
      .run(HISTORICAL_FIXTURE_IDS.revisionTwoId);
    fixture.sqlite.exec(`
      CREATE TRIGGER revisions_immutable_update
      BEFORE UPDATE ON revisions BEGIN SELECT RAISE(ABORT, 'revisions are immutable'); END;
    `);
    fixture.sqlite.close();

    expect(() => new DesignerDatabase(source)).toThrow(/schema-invalid revision/);
    const raw = new Database(source, { readonly: true });
    try {
      expect(raw.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 1 });
      expect(raw.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'snapshots'",
      ).get()).toBeUndefined();
    } finally {
      raw.close();
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
