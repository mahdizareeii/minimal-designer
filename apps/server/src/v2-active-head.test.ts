import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createSequentialIdFactory,
  createStarterDocument,
  migrateDesignDocumentV1ToV2,
} from "@designer/core";
import { afterEach, describe, expect, it } from "vitest";

import { applyOperations } from "./core-adapter.js";
import { DesignerDatabase } from "./db/database.js";
import { EventHub } from "./events.js";
import { canonicalSnapshot } from "./persistence.js";
import { DesignerService } from "./service.js";

const temporaryDirectories: string[] = [];

function openService() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "formaspec-v2-head-"));
  temporaryDirectories.push(directory);
  const filename = path.join(directory, "designer.sqlite");
  const database = new DesignerDatabase(filename);
  const service = new DesignerService(database, new EventHub(), 900);
  return { database, service, filename };
}

function seedVerifiedBackup(
  database: DesignerDatabase,
  id: string,
  createdAt: string,
  organizationId = "organization_legacy",
  formatVersion: 1 | 2 = 2,
): void {
  const verification = {
    valid: true,
    manifest: {
      format: "formaspec-backup",
      formatVersion,
      createdAt,
      databaseSchemaVersion: database.schemaVersion(),
    },
    sqliteIntegrity: "ok",
    foreignKeyViolations: 0,
    extractedBytes: 1,
    entryCount: 1,
  };
  database.sqlite.prepare(
    `INSERT INTO backup_records
     (id, organization_id, filename, bundle_sha256, status, manifest_json, created_by, created_at, verified_at,
      size_bytes, verification_json, retention_class, completed_at)
     VALUES (?, ?, 'migration-gate.tar', ?, 'valid', ?, 'principal_local', ?, ?, 1, ?, 'manual', ?)`,
  ).run(
    id,
    organizationId,
    "a".repeat(64),
    JSON.stringify(verification.manifest),
    createdAt,
    createdAt,
    JSON.stringify(verification),
    createdAt,
  );
}

function thrown(callback: () => unknown): unknown {
  try {
    callback();
  } catch (error) {
    return error;
  }
  throw new Error("Expected callback to throw.");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("V1/V2 active-head compatibility", () => {
  it("returns an explicit domain error for unsupported V2-native edits", () => {
    const ids = createSequentialIdFactory("v2domain");
    const source = createStarterDocument({ now: "2026-01-01T00:00:00.000Z", idFactory: ids });
    const tokenId = ids("token");
    source.tokens[tokenId] = {
      id: tokenId,
      name: "Surface",
      path: "color.surface",
      kind: "color",
      value: "#ffffff",
      archived: false,
      metadata: {},
    };
    const migrated = migrateDesignDocumentV1ToV2(source, { migratedAt: "2026-02-01T00:00:00.000Z" });
    migrated.tokens[tokenId]!.modes = { dark: "#111111" };

    expect(thrown(() => applyOperations(migrated, [{
      type: "upsert_token",
      token: { ...source.tokens[tokenId]!, value: "#eeeeee" },
    }], {
      expectedRevision: migrated.revision,
      now: "2026-03-01T00:00:00.000Z",
    }))).toMatchObject({
      code: "UNSUPPORTED_DOCUMENT_FEATURE",
      details: { issues: [expect.objectContaining({ code: "V2_TOKEN_EDIT_UNSUPPORTED" })] },
    });
  });

  it("keeps typed V2 accessibility edits authoritative across generic metadata operation order", () => {
    const ids = createSequentialIdFactory("v2a11yorder");
    const source = createStarterDocument({ now: "2026-01-01T00:00:00.000Z", idFactory: ids });
    source.revision = 1;
    const frameId = source.pages[0]!.children[0]!;
    const frame = source.nodes[frameId]!;
    if (frame.type !== "frame") throw new Error("Expected starter frame");
    frame.role = "button";
    const migrated = migrateDesignDocumentV1ToV2(source, { migratedAt: "2026-02-01T00:00:00.000Z" });

    const cases = [
      {
        expected: "Typed before generic",
        operations: [
          { type: "update_node" as const, node_id: frameId, patch: { accessibility_label: "Typed before generic" } },
          { type: "update_node" as const, node_id: frameId, patch: {
            metadata: { source: "generic-after", accessible_label: "Generic after" },
            metadata_mode: "replace" as const,
          } },
        ],
      },
      {
        expected: "Typed after generic",
        operations: [
          { type: "update_node" as const, node_id: frameId, patch: {
            metadata: { source: "generic-before", accessible_label: "Generic before" },
            metadata_mode: "replace" as const,
          } },
          { type: "update_node" as const, node_id: frameId, patch: { accessibility_label: "Typed after generic" } },
        ],
      },
      {
        expected: "Last explicit label",
        operations: [
          { type: "update_node" as const, node_id: frameId, patch: { accessibility_label: "First explicit label" } },
          { type: "update_node" as const, node_id: frameId, patch: { accessibility_label: "Last explicit label" } },
          { type: "update_node" as const, node_id: frameId, patch: {
            metadata: { source: "generic-last", accessible_label: "Generic last" },
            metadata_mode: "replace" as const,
          } },
        ],
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const result = applyOperations(migrated, testCase.operations, {
        expectedRevision: migrated.revision,
        now: `2026-03-0${index + 1}T00:00:00.000Z`,
      });
      if (result.document.schema_version !== 2) throw new Error("Expected V2 result.");
      expect(result.document.nodes[frameId]?.semantics).toMatchObject({
        role: "button",
        accessibility_label: testCase.expected,
      });
      expect(result.document.nodes[frameId]?.metadata).not.toHaveProperty("accessible_label");
      expect(result.diagnostics.some((item) => item.code === "interactive_accessible_name_missing")).toBe(false);
    }
  });

  it("creates one backup-gated system migration revision and keeps V1 history immutable", () => {
    const opened = openService();
    try {
      const created = opened.service.createDesign("local", {
        name: "Migration fixture",
        preset: "phone",
        idempotencyKey: "create-v2-migration-fixture",
      });
      const sourceSnapshot = canonicalSnapshot(created.canonicalDocument);
      expect(thrown(() => opened.service.migrateDesignHeadToV2("local", created.design.id, {
        expectedBaseVersion: 1,
        backupId: "backup_missing00000001",
        idempotencyKey: "migrate-without-backup",
      }))).toMatchObject({ code: "NOT_FOUND" });

      const backupId = "backup_v2migration00000001";
      seedVerifiedBackup(opened.database, backupId, created.design.updatedAt);
      const migrated = opened.service.migrateDesignHeadToV2("local", created.design.id, {
        expectedBaseVersion: 1,
        backupId,
        idempotencyKey: "migrate-v2-head-0001",
      });

      expect(migrated.migrated).toBe(true);
      expect(migrated.result.schemaVersion).toBe(2);
      expect(migrated.result.document.schema_version).toBe(1);
      expect(migrated.result.canonicalDocument.schema_version).toBe(2);
      expect(migrated.result.diagnostics.some((item) => item.code === "V2_COMPATIBILITY_PROJECTION")).toBe(true);
      expect(migrated.result.diagnostics.some((item) => item.code === "raw_design_value")).toBe(true);
      if (migrated.result.canonicalDocument.schema_version !== 2) throw new Error("Expected V2 head.");
      expect(migrated.result.canonicalDocument.migration).toMatchObject({
        source_schema_version: 1,
        source_revision_id: created.revision.id,
        source_snapshot_hash: sourceSnapshot.hash,
        verified_backup_id: backupId,
      });
      expect(opened.service.getDesign("local", created.design.id, 1).canonicalDocument).toEqual(created.canonicalDocument);
      expect(opened.database.sqlite.prepare(
        "SELECT actor_id, message FROM revisions WHERE id = ?",
      ).get(migrated.result.revision.id)).toEqual({
        actor_id: "system_formaspec_v2_migration",
        message: "System migration from document schema V1 to V2",
      });

      const replay = opened.service.migrateDesignHeadToV2("local", created.design.id, {
        expectedBaseVersion: 1,
        backupId,
        idempotencyKey: "migrate-v2-head-0001",
      });
      expect(replay.migrated).toBe(true);
      expect(replay.result.revision.id).toBe(migrated.result.revision.id);
      const alreadyMigrated = opened.service.migrateDesignHeadToV2("local", created.design.id, {
        expectedBaseVersion: 2,
        backupId,
        idempotencyKey: "migrate-v2-head-0002",
      });
      expect(alreadyMigrated.migrated).toBe(false);
      expect(alreadyMigrated.result.revision.id).toBe(migrated.result.revision.id);
      expect(opened.database.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM revisions WHERE design_id = ?",
      ).get(created.design.id)).toEqual({ count: 2 });
    } finally {
      opened.database.close();
    }
  });

  it("preserves every legacy asset ID while quarantining non-renderable V1 asset kinds", () => {
    const opened = openService();
    try {
      const created = opened.service.createDesign("local", {
        name: "Legacy asset migration fixture",
        preset: "phone",
        idempotencyKey: "create-v2-legacy-asset-fixture",
      });
      const fontAssetId = "asset_v1legacyfont00000001";
      const gifAssetId = "asset_v1legacygif000000001";
      const withAssets = opened.service.applyRevision("local", created.design.id, {
        baseVersion: 1,
        operations: [
          {
            type: "upsert_asset",
            asset: {
              id: fontAssetId,
              name: "Legacy font",
              kind: "font",
              mime_type: "font/woff2",
              size_bytes: 256,
              storage_key: "legacy/fonts/company.woff2",
              sha256: "a".repeat(64),
              metadata: { family: "Company Sans" },
            },
          },
          {
            type: "upsert_asset",
            asset: {
              id: gifAssetId,
              name: "Legacy image",
              kind: "image",
              mime_type: "image/gif",
              size_bytes: 64,
              storage_key: "legacy/images/animation.gif",
              sha256: "b".repeat(64),
              width: 24,
              height: 24,
              metadata: { animated: false },
            },
          },
        ],
        idempotencyKey: "add-v2-legacy-asset-fixtures",
      });
      const historical = structuredClone(withAssets.canonicalDocument);
      const backupId = "backup_v2legacyassets000001";
      seedVerifiedBackup(opened.database, backupId, withAssets.design.updatedAt);

      const migrated = opened.service.migrateDesignHeadToV2("local", created.design.id, {
        expectedBaseVersion: 2,
        backupId,
        idempotencyKey: "migrate-v2-legacy-assets",
      });

      expect(migrated.result.canonicalDocument.schema_version).toBe(2);
      if (migrated.result.canonicalDocument.schema_version !== 2) throw new Error("Expected V2 head.");
      expect(migrated.result.canonicalDocument.assets[fontAssetId]).toMatchObject({
        id: fontAssetId,
        kind: "font",
        mime_type: "font/woff2",
        status: "legacy_quarantined",
      });
      expect(migrated.result.canonicalDocument.assets[gifAssetId]).toMatchObject({
        id: gifAssetId,
        kind: "image",
        mime_type: "image/gif",
        status: "legacy_quarantined",
      });
      expect(migrated.result.canonicalDocument.migration?.quarantined_asset_ids.sort()).toEqual([
        fontAssetId,
        gifAssetId,
      ].sort());
      expect(opened.service.getDesign("local", created.design.id, 2).canonicalDocument).toEqual(historical);
    } finally {
      opened.database.close();
    }
  });

  it("keeps preview and commit behavior working on a migrated V2 head", () => {
    const opened = openService();
    try {
      const created = opened.service.createDesign("local", {
        name: "Editable V2 fixture",
        preset: "web",
        idempotencyKey: "create-editable-v2-fixture",
      });
      const backupId = "backup_v2editable000000001";
      seedVerifiedBackup(opened.database, backupId, created.design.updatedAt);
      const migrated = opened.service.migrateDesignHeadToV2("local", created.design.id, {
        expectedBaseVersion: 1,
        backupId,
        idempotencyKey: "migrate-editable-v2-head",
      });
      const frameId = migrated.result.document.pages[0]!.children[0]!;
      const productSpecification = migrated.result.canonicalDocument.schema_version === 2
        ? structuredClone(migrated.result.canonicalDocument.product_specification)
        : null;

      const preview = opened.service.createPreview("local", created.design.id, {
        baseVersion: 2,
        operations: [{
          type: "update_node",
          node_id: frameId,
          patch: {
            name: "Edited V2 frame",
            role: "button",
            accessibility_label: "Open checkout",
          },
        }],
      });
      expect(preview.schemaVersion).toBe(2);
      expect(preview.document.nodes[frameId]).toMatchObject({
        name: "Edited V2 frame",
        role: "button",
        metadata: { accessible_label: "Open checkout" },
      });
      expect(preview.canonicalDocument.schema_version).toBe(2);
      if (preview.canonicalDocument.schema_version !== 2) throw new Error("Expected V2 preview.");
      expect(preview.canonicalDocument.nodes[frameId]?.semantics).toMatchObject({
        role: "button",
        accessibility_label: "Open checkout",
      });
      expect(preview.diagnostics.some((item) => item.code === "interactive_accessible_name_missing")).toBe(false);
      expect(canonicalSnapshot(preview.canonicalDocument).hash).toBe(preview.resultSnapshotHash);

      const committed = opened.service.commitPreview("local", created.design.id, {
        previewId: preview.id,
        expectedBaseVersion: 2,
        idempotencyKey: "commit-editable-v2-preview",
        message: "Edit migrated head",
      });
      expect(committed.schemaVersion).toBe(2);
      expect(committed.document.nodes[frameId]).toMatchObject({
        name: "Edited V2 frame",
        role: "button",
        metadata: { accessible_label: "Open checkout" },
      });
      expect(committed.canonicalDocument.schema_version).toBe(2);
      if (committed.canonicalDocument.schema_version !== 2) throw new Error("Expected V2 commit.");
      expect(committed.canonicalDocument.nodes[frameId]?.semantics).toMatchObject({
        role: "button",
        accessibility_label: "Open checkout",
      });
      expect(committed.diagnostics.some((item) => item.code === "interactive_accessible_name_missing")).toBe(false);
      expect(committed.canonicalDocument.product_specification).toEqual(productSpecification);
      expect(opened.service.getDesign("local", created.design.id, 1).schemaVersion).toBe(1);
      expect(opened.service.getDesign("local", created.design.id).schemaVersion).toBe(2);
    } finally {
      opened.database.close();
    }
  });

  it("reopens a V2 head and replays the persisted migration idempotency response", () => {
    const first = openService();
    const created = first.service.createDesign("local", {
      name: "Restart-safe V2 fixture",
      preset: "phone",
      idempotencyKey: "create-restart-v2-fixture",
    });
    const backupId = "backup_v2restart000000001";
    seedVerifiedBackup(first.database, backupId, created.design.updatedAt);
    const migrated = first.service.migrateDesignHeadToV2("local", created.design.id, {
      expectedBaseVersion: 1,
      backupId,
      idempotencyKey: "migrate-restart-v2-head",
    });
    first.database.close();

    const database = new DesignerDatabase(first.filename);
    const service = new DesignerService(database, new EventHub(), 900);
    try {
      expect(service.getDesign("local", created.design.id).schemaVersion).toBe(2);
      const replay = service.migrateDesignHeadToV2("local", created.design.id, {
        expectedBaseVersion: 1,
        backupId,
        idempotencyKey: "migrate-restart-v2-head",
      });
      expect(replay.migrated).toBe(true);
      expect(replay.result.revision.id).toBe(migrated.result.revision.id);
      expect(database.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM revisions WHERE design_id = ?",
      ).get(created.design.id)).toEqual({ count: 2 });
    } finally {
      database.close();
    }
  });

  it("rejects stale backup evidence and non-admin migration attempts", () => {
    const opened = openService();
    try {
      const created = opened.service.createDesign("local", {
        name: "Migration authorization fixture",
        preset: "tablet",
        idempotencyKey: "create-v2-auth-fixture",
      });
      const staleBackupId = "backup_v2stale00000000001";
      seedVerifiedBackup(
        opened.database,
        staleBackupId,
        new Date(Date.parse(created.design.updatedAt) - 1_000).toISOString(),
      );
      expect(thrown(() => opened.service.migrateDesignHeadToV2("local", created.design.id, {
        expectedBaseVersion: 1,
        backupId: staleBackupId,
        idempotencyKey: "migrate-stale-backup",
      }))).toMatchObject({ code: "VALIDATION_FAILED", statusCode: 409 });
      expect(thrown(() => opened.service.migrateDesignHeadToV2("alice", created.design.id, {
        expectedBaseVersion: 1,
        backupId: staleBackupId,
        idempotencyKey: "migrate-non-admin",
      }))).toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
      expect(opened.service.getDesign("local", created.design.id).schemaVersion).toBe(1);
    } finally {
      opened.database.close();
    }
  });
});
