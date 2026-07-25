import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ENGINE_VERSIONS } from "@designer/core";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { applyOperations, createDocument } from "./core-adapter.js";
import { applyDatabaseMigrationPrefixForTesting, DesignerDatabase } from "./db/database.js";
import { EventHub } from "./events.js";
import { canonicalSnapshot, DEFAULT_RUNTIME_VERSIONS, operationHash } from "./persistence.js";
import { DesignerService } from "./service.js";

const temporaryDirectories: string[] = [];

function databasePath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "formaspec-persistence-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "designer.sqlite");
}

function openService(filename: string, options: { ttl?: number; commandEngine?: string } = {}) {
  const database = new DesignerDatabase(filename);
  const events = new EventHub();
  const service = new DesignerService(database, events, options.ttl ?? 900, {
    ...(options.commandEngine ? { commandEngine: options.commandEngine } : {}),
  });
  return { database, events, service };
}

function starter(service: DesignerService, key = "create-persistence-0001") {
  const created = service.createDesign("alice", {
    name: "Persistence test",
    preset: "phone",
    idempotencyKey: key,
  });
  const frameId = created.document.pages[0]?.children[0];
  if (!frameId) throw new Error("Starter frame was not created.");
  return { created, frameId };
}

function renamePreview(service: DesignerService, designId: string, frameId: string, name: string) {
  return service.createPreview("alice", designId, {
    baseVersion: 1,
    operations: [{ type: "update_node", node_id: frameId, patch: { name } }],
  });
}

function thrown(callback: () => unknown): unknown {
  try {
    callback();
  } catch (error) {
    return error;
  }
  throw new Error("Expected callback to throw.");
}

const legacyBootstrapCredentialsConsumeOnceSql = `
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

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("content-addressed persistence", () => {
  it("persists one stable data-store identity and keeps separate databases distinct", () => {
    const firstFilename = databasePath();
    const secondFilename = databasePath();

    const firstOpen = new DesignerDatabase(firstFilename);
    const firstId = firstOpen.dataStoreId();
    expect(firstId).toMatch(/^store_[a-f0-9]{32}$/);
    expect(firstOpen.metadata("data_store_id")).toBe(firstId);
    expect(firstOpen.schemaVersion()).toBe(18);
    firstOpen.close();

    const reopened = new DesignerDatabase(firstFilename);
    expect(reopened.dataStoreId()).toBe(firstId);
    expect(reopened.schemaVersion()).toBe(18);
    reopened.close();

    const second = new DesignerDatabase(secondFilename);
    expect(second.dataStoreId()).toMatch(/^store_[a-f0-9]{32}$/);
    expect(second.dataStoreId()).not.toBe(firstId);
    expect(second.schemaVersion()).toBe(18);
    second.close();
  });

  it("returns the strict inactive context shape for cleared and stale exact contexts", () => {
    const opened = openService(databasePath());
    try {
      const { created } = starter(opened.service, "create-context-freshness-0001");
      const pageId = created.document.pages[0]!.id;
      const nodeId = created.document.pages[0]!.children[0]!;
      opened.service.setContext("local", {
        designId: created.document.id,
        pageId,
        selection: [nodeId],
      });
      opened.database.sqlite.prepare(
        "UPDATE contexts SET updated_at = '2000-01-01T00:00:00.000Z' WHERE actor_id = 'local'",
      ).run();

      const inactive = { designId: null, pageId: null, selection: [], updatedAt: null };
      expect(opened.service.getContext("local")).toEqual(inactive);
      expect(opened.service.getContext("local", { workspaceFallback: true })).toEqual(inactive);
      expect(opened.service.setContext("local", { designId: null, selection: [] })).toEqual(inactive);
      expect(opened.service.getContext("local", { workspaceFallback: true })).toEqual(inactive);
    } finally {
      opened.database.close();
    }
  });

  it("does not let a stale exact context hide a fresh workspace editor", () => {
    const opened = openService(databasePath());
    try {
      const { created } = starter(opened.service, "create-context-fallback-0001");
      const pageId = created.document.pages[0]!.id;
      const nodeId = created.document.pages[0]!.children[0]!;
      opened.service.setContext("local", {
        designId: created.document.id,
        pageId,
        selection: [],
      });
      opened.database.sqlite.prepare(
        "UPDATE contexts SET updated_at = '2000-01-01T00:00:00.000Z' WHERE actor_id = 'local'",
      ).run();
      opened.service.setContext("fresh-workspace-editor", {
        designId: created.document.id,
        pageId,
        selection: [nodeId],
      });

      expect(opened.service.getContext("local", { workspaceFallback: true })).toMatchObject({
        designId: created.document.id,
        pageId,
        selection: [nodeId],
        contextSource: "workspace",
      });
    } finally {
      opened.database.close();
    }
  });

  it("keeps actor-scoped client context leases isolated, collapses matches, and releases one tab only", () => {
    const opened = openService(databasePath());
    try {
      const { created } = starter(opened.service, "create-client-context-leases-0001");
      const pageId = created.document.pages[0]!.id;
      const nodeId = created.document.pages[0]!.children[0]!;
      const firstClient = "tab_context_first_0001";
      const secondClient = "tab_context_second_0001";

      opened.service.setContext("local", {
        designId: created.document.id,
        pageId,
        selection: [],
        clientContextId: firstClient,
      });
      opened.service.setContext("local", {
        designId: created.document.id,
        pageId,
        selection: [],
        clientContextId: secondClient,
      });
      expect(opened.service.getContext("local")).toMatchObject({
        designId: created.document.id,
        pageId,
        selection: [],
        contextSource: "actor",
      });
      expect(opened.database.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM contexts WHERE organization_id = 'organization_legacy'",
      ).get()).toEqual({ count: 2 });

      opened.service.setContext("local", {
        designId: created.document.id,
        pageId,
        selection: [nodeId],
        clientContextId: secondClient,
      });
      expect(thrown(() => opened.service.getContext("local"))).toMatchObject({ code: "AMBIGUOUS_CONTEXT" });

      opened.service.setContext("local", {
        designId: created.document.id,
        pageId,
        selection: [],
        clientContextId: firstClient,
      });
      expect(thrown(() => opened.service.getContext("local"))).toMatchObject({ code: "AMBIGUOUS_CONTEXT" });

      expect(opened.service.setContext("local", {
        designId: null,
        selection: [],
        clientContextId: firstClient,
      })).toEqual({ designId: null, pageId: null, selection: [], updatedAt: null });
      expect(opened.service.getContext("local")).toMatchObject({
        designId: created.document.id,
        pageId,
        selection: [nodeId],
        contextSource: "actor",
      });
      expect(opened.database.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM contexts WHERE organization_id = 'organization_legacy'",
      ).get()).toEqual({ count: 1 });

      expect(thrown(() => opened.service.setContext("local", {
        designId: created.document.id,
        selection: [],
        clientContextId: "../not-an-opaque-client",
      }))).toMatchObject({ code: "VALIDATION_FAILED" });
    } finally {
      opened.database.close();
    }
  });

  it("ignores and removes expired client leases without deleting stale legacy context rows", () => {
    const opened = openService(databasePath());
    try {
      const { created } = starter(opened.service, "create-expired-client-context-0001");
      const pageId = created.document.pages[0]!.id;
      const nodeId = created.document.pages[0]!.children[0]!;

      opened.service.setContext("local", {
        designId: created.document.id,
        pageId,
        selection: [],
        clientContextId: "expired_browser_tab_0001",
      });
      opened.service.setContext("local", {
        designId: created.document.id,
        pageId,
        selection: [nodeId],
        clientContextId: "fresh_browser_tab_0001",
      });
      opened.service.setContext("legacy-stale-actor", {
        designId: created.document.id,
        pageId,
        selection: [],
      });
      opened.database.sqlite.prepare(
        `UPDATE contexts
         SET updated_at = '2000-01-01T00:00:00.000Z'
         WHERE selection_json = '[]'`,
      ).run();

      expect(opened.service.getContext("local")).toMatchObject({
        designId: created.document.id,
        pageId,
        selection: [nodeId],
        contextSource: "actor",
      });
      expect(opened.database.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM contexts WHERE actor_id GLOB '__client_context__*'",
      ).get()).toEqual({ count: 1 });
      expect(opened.database.sqlite.prepare(
        "SELECT updated_at FROM contexts WHERE actor_id = 'legacy-stale-actor'",
      ).get()).toEqual({ updated_at: "2000-01-01T00:00:00.000Z" });
    } finally {
      opened.database.close();
    }
  });

  it("upgrades exact legacy schema-14 and schema-15 bootstrap triggers without losing credential data", () => {
    for (const historicalVersion of [14, 15]) {
      const filename = databasePath();
      const historical = new Database(filename);
      historical.pragma("foreign_keys = ON");
      applyDatabaseMigrationPrefixForTesting(historical, historicalVersion);
      historical.prepare(
        `INSERT INTO bootstrap_credentials (id, token_hash, created_at, consumed_at, consumed_by)
         VALUES ('initial_admin', ?, '2026-07-01T00:00:00.000Z', NULL, NULL)`,
      ).run("a".repeat(64));
      historical.exec(`
        DROP TRIGGER bootstrap_credentials_consume_once;
        ${legacyBootstrapCredentialsConsumeOnceSql};
      `);
      historical.close();

      const upgraded = new DesignerDatabase(filename);
      try {
        expect(upgraded.schemaVersion()).toBe(18);
        expect(upgraded.sqlite.prepare(
          "SELECT version, name FROM schema_migrations WHERE version >= 14 ORDER BY version",
        ).all()).toEqual([
          { version: 14, name: "browser_session_authentication" },
          { version: 15, name: "preview_render_metadata" },
          { version: 16, name: "bootstrap_credential_trigger_canonicalization" },
          { version: 17, name: "product_organization_foundation" },
          { version: 18, name: "product_archive_restore_integrity" },
        ]);
        expect(upgraded.sqlite.prepare(
          "SELECT id, token_hash, created_at, consumed_at, consumed_by FROM bootstrap_credentials",
        ).get()).toEqual({
          id: "initial_admin",
          token_hash: "a".repeat(64),
          created_at: "2026-07-01T00:00:00.000Z",
          consumed_at: null,
          consumed_by: null,
        });
        const trigger = upgraded.sqlite.prepare(
          "SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = 'bootstrap_credentials_consume_once'",
        ).get() as { sql: string };
        const normalizedTrigger = trigger.sql.replace(/\s+/g, " ").trim().toLowerCase();
        expect(normalizedTrigger).toContain("(new.consumed_at is null) != (new.consumed_by is null)");
        expect(normalizedTrigger).toContain("new.consumed_at is not null and new.token_hash is not old.token_hash");
        expect(normalizedTrigger).not.toContain("or new.consumed_at is null or new.consumed_by is null");
        expect(() => upgraded.sqlite.prepare(
          "UPDATE bootstrap_credentials SET token_hash = ? WHERE id = 'initial_admin'",
        ).run("b".repeat(64))).not.toThrow();
      } finally {
        upgraded.close();
      }
    }
  });

  it("runs numbered migrations, records independent versions, and backfills a legacy V1 database", () => {
    const filename = databasePath();
    const legacy = new Database(filename);
    legacy.exec(`
      CREATE TABLE designs (
        id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, name TEXT NOT NULL,
        current_version INTEGER NOT NULL, current_revision_id TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE revisions (
        id TEXT PRIMARY KEY, design_id TEXT NOT NULL, version INTEGER NOT NULL,
        parent_revision_id TEXT, actor_id TEXT NOT NULL, message TEXT,
        document_json TEXT NOT NULL, operations_json TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(design_id, version)
      );
      CREATE TABLE previews (
        id TEXT PRIMARY KEY, design_id TEXT NOT NULL, actor_id TEXT NOT NULL,
        root_base_version INTEGER NOT NULL, base_preview_id TEXT, operation_hash TEXT NOT NULL,
        operations_json TEXT NOT NULL, document_json TEXT NOT NULL, diagnostics_json TEXT NOT NULL,
        committable INTEGER NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
      );
    `);
    const now = "2026-01-02T03:04:05.000Z";
    const document = createDocument("document_legacy12345678", "Legacy design", now, "web");
    legacy.prepare(
      `INSERT INTO designs VALUES (?, 'alice', ?, 1, ?, ?, ?)`,
    ).run(document.id, document.name, "revision_legacy12345678", now, now);
    legacy.prepare(
      `INSERT INTO revisions VALUES (?, ?, 1, NULL, 'alice', 'Legacy create', ?, '[]', ?)`,
    ).run("revision_legacy12345678", document.id, JSON.stringify(document), now);
    const frameId = document.pages[0]?.children[0];
    if (!frameId) throw new Error("Legacy starter frame was not created.");
    const legacyOperations = [{ type: "update_node", node_id: frameId, patch: { name: "Legacy preview" } }];
    const previewTime = "2026-01-02T03:05:05.000Z";
    const previewDocument = applyOperations(document, legacyOperations, {
      expectedRevision: 1,
      now: previewTime,
    }).document;
    legacy.prepare(
      `INSERT INTO previews VALUES (?, ?, 'alice', 1, NULL, 'legacy-operation-hash', ?, ?, '[]', 1, ?, ?)`,
    ).run(
      "preview_legacy12345678",
      document.id,
      JSON.stringify(legacyOperations),
      JSON.stringify(previewDocument),
      previewTime,
      "2099-01-01T00:00:00.000Z",
    );
    legacy.close();

    const opened = openService(filename);
    try {
      expect(opened.database.schemaVersion()).toBe(18);
      expect(opened.database.sqlite.prepare(
        "SELECT version, name FROM schema_migrations ORDER BY version",
      ).all()).toEqual([
        { version: 1, name: "baseline_v1" },
        { version: 2, name: "content_addressed_persistence" },
        { version: 3, name: "enterprise_workflow_foundation" },
        { version: 4, name: "preview_retention" },
        { version: 5, name: "organization_scoped_outbox" },
        { version: 6, name: "enterprise_workflow_integrity" },
        { version: 7, name: "enterprise_delivery_operations" },
        { version: 8, name: "enterprise_domain_models" },
        { version: 9, name: "audit_retention_execution" },
        { version: 10, name: "portable_import_provenance" },
        { version: 11, name: "render_job_persistence" },
        { version: 12, name: "handoff_execution_decisions" },
        { version: 13, name: "component_source_persistence" },
        { version: 14, name: "browser_session_authentication" },
        { version: 15, name: "preview_render_metadata" },
        { version: 16, name: "bootstrap_credential_trigger_canonicalization" },
        { version: 17, name: "product_organization_foundation" },
        { version: 18, name: "product_archive_restore_integrity" },
      ]);
      expect(opened.database.metadata("database_schema_version")).toBe("18");
      expect(DEFAULT_RUNTIME_VERSIONS).toMatchObject({
        commandEngine: ENGINE_VERSIONS.commandEngine,
        renderer: ENGINE_VERSIONS.renderer,
        fontBundle: ENGINE_VERSIONS.fontBundle,
      });
      expect(ENGINE_VERSIONS).toMatchObject({
        rasterNormalizer: "1",
        rendererIpcProtocol: 2,
      });
      expect(opened.database.metadata("command_engine_version")).toBe(ENGINE_VERSIONS.commandEngine);
      expect(opened.database.metadata("renderer_version")).toBe(ENGINE_VERSIONS.renderer);
      expect(opened.database.metadata("font_bundle_version")).toBe(ENGINE_VERSIONS.fontBundle);
      expect(opened.database.sqlite.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'portable_exports'",
      ).get()).toEqual({ name: "portable_exports" });
      expect(opened.database.sqlite.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'operational_locks'",
      ).get()).toEqual({ name: "operational_locks" });
      expect(opened.database.sqlite.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'design_system_releases'",
      ).get()).toEqual({ name: "design_system_releases" });

      const result = opened.service.getDesign("alice", document.id);
      expect(result.document).toEqual(document);
      expect(result.revision.snapshotHash).toBe(canonicalSnapshot(document).hash);
      expect(result.revision.revisionHash).toMatch(/^[a-f0-9]{64}$/);
      expect(opened.database.readSnapshot(result.revision.snapshotHash)).toBe(canonicalSnapshot(document).canonicalJson);
      const migratedPreview = opened.service.getPreview("alice", document.id, "preview_legacy12345678");
      expect(migratedPreview.operationHash).toBe(operationHash(legacyOperations));
      expect(migratedPreview.resultSnapshotHash).toBe(canonicalSnapshot(previewDocument).hash);
      expect(migratedPreview.renderMetadata).toBeNull();
      expect(opened.database.sqlite.prepare(
        `SELECT command_engine_version, renderer_version, font_bundle_version, render_metadata_json
         FROM previews WHERE id = ?`,
      ).get(migratedPreview.id)).toEqual({
        command_engine_version: "1",
        renderer_version: "2",
        font_bundle_version: "1",
        render_metadata_json: null,
      });
      expect(thrown(() => opened.service.commitPreview("alice", document.id, {
        previewId: migratedPreview.id,
        expectedBaseVersion: 1,
        idempotencyKey: "legacy-preview-commit-0001",
        message: "Commit migrated preview",
      }))).toMatchObject({ code: "PREVIEW_ENGINE_MISMATCH" });
      const freshPreview = opened.service.createPreview("alice", document.id, {
        baseVersion: 1,
        operations: legacyOperations,
      });
      const freshCommit = opened.service.commitPreview("alice", document.id, {
        previewId: freshPreview.id,
        expectedBaseVersion: 1,
        idempotencyKey: "fresh-preview-commit-0001",
        message: "Commit current-engine preview",
      });
      expect(freshCommit.document.nodes[frameId]?.name).toBe("Legacy preview");
      expect(() => opened.database.sqlite.prepare("UPDATE revisions SET message = 'tamper'").run()).toThrow(/immutable/);
      expect(() => opened.database.sqlite.prepare("DELETE FROM schema_migrations WHERE version = 1").run()).toThrow(/immutable/);
    } finally {
      opened.database.close();
    }
  });

  it("fails startup when a current migration ledger is missing required enterprise schema objects", () => {
    const cases: Array<{
      mutate: (sqlite: Database.Database) => void;
      expected: RegExp;
    }> = [
      {
        mutate: (sqlite) => sqlite.exec("DROP TABLE portable_imports"),
        expected: /migration 10 is missing required table portable_imports/,
      },
      {
        mutate: (sqlite) => sqlite.exec("DROP TRIGGER audit_events_retention_delete"),
        expected: /migration 9 is missing required trigger audit_events_retention_delete/,
      },
      {
        mutate: (sqlite) => sqlite.exec("DROP TABLE render_jobs"),
        expected: /migration 11 is missing required table render_jobs/,
      },
      {
        mutate: (sqlite) => sqlite.exec("DROP TABLE handoff_execution_decisions"),
        expected: /migration 12 is missing required table handoff_execution_decisions/,
      },
      {
        mutate: (sqlite) => sqlite.exec("DROP TRIGGER handoff_execution_decisions_insert_integrity"),
        expected: /migration 12 is missing required trigger handoff_execution_decisions_insert_integrity/,
      },
      {
        mutate: (sqlite) => sqlite.exec("DROP TRIGGER previews_render_metadata_immutable"),
        expected: /migration 15 is missing required trigger previews_render_metadata_immutable/,
      },
      {
        mutate: (sqlite) => {
          const row = sqlite.prepare(
            "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'render_jobs'",
          ).get() as { sql: string };
          const modified = row.sql.replace("CHECK(kind IN ('render', 'normalize_raster'))", "");
          if (modified === row.sql) throw new Error("Render-job CHECK fixture did not match the current migration SQL.");
          sqlite.unsafeMode(true);
          sqlite.exec("PRAGMA writable_schema = ON");
          sqlite.prepare("UPDATE sqlite_schema SET sql = ? WHERE type = 'table' AND name = 'render_jobs'").run(modified);
          sqlite.exec("PRAGMA writable_schema = OFF");
          sqlite.unsafeMode(false);
        },
        expected: /migration 11 table render_jobs has unexpected SQL/,
      },
      {
        mutate: (sqlite) => {
          const row = sqlite.prepare(
            "SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = 'render_jobs_lifecycle_update'",
          ).get() as { sql: string };
          sqlite.unsafeMode(true);
          sqlite.exec("PRAGMA writable_schema = ON");
          sqlite.prepare(
            "UPDATE sqlite_schema SET sql = ? WHERE type = 'trigger' AND name = 'render_jobs_lifecycle_update'",
          ).run(`${row.sql} /* retained fragments but altered schema object */`);
          sqlite.exec("PRAGMA writable_schema = OFF");
          sqlite.unsafeMode(false);
        },
        expected: /migration 11 trigger render_jobs_lifecycle_update has unexpected SQL digest/,
      },
      {
        mutate: (sqlite) => sqlite.exec(`
          DROP TRIGGER bootstrap_credentials_consume_once;
          ${legacyBootstrapCredentialsConsumeOnceSql};
        `),
        expected: /migration 16 trigger bootstrap_credentials_consume_once has unexpected SQL/,
      },
    ];

    for (const fixture of cases) {
      const filename = databasePath();
      const created = new DesignerDatabase(filename);
      created.close();
      const tampered = new Database(filename);
      try {
        fixture.mutate(tampered);
      } finally {
        tampered.close();
      }

      expect(() => new DesignerDatabase(filename)).toThrow(fixture.expected);
      const inspected = new Database(filename, { readonly: true });
      try {
        expect(inspected.prepare("SELECT MAX(version) AS version FROM schema_migrations").get())
          .toEqual({ version: 18 });
      } finally {
        inspected.close();
      }
    }
  });

  it("rejects schema-invalid legacy documents without recording the integrity migration", () => {
    const filename = databasePath();
    const legacy = new Database(filename);
    legacy.exec(`
      CREATE TABLE designs (
        id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, name TEXT NOT NULL,
        current_version INTEGER NOT NULL, current_revision_id TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE revisions (
        id TEXT PRIMARY KEY, design_id TEXT NOT NULL, version INTEGER NOT NULL,
        parent_revision_id TEXT, actor_id TEXT NOT NULL, message TEXT,
        document_json TEXT NOT NULL, operations_json TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(design_id, version)
      );
      INSERT INTO designs VALUES (
        'document_invalid12345678', 'alice', 'Invalid', 1, 'revision_invalid12345678',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
      INSERT INTO revisions VALUES (
        'revision_invalid12345678', 'document_invalid12345678', 1, NULL, 'alice',
        'Invalid', '{}', '[]', '2026-01-01T00:00:00.000Z'
      );
    `);
    legacy.close();

    expect(() => new DesignerDatabase(filename)).toThrow(/schema-invalid revision .* document/);
    const inspected = new Database(filename, { readonly: true });
    try {
      expect(inspected.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all()).toEqual([
        { version: 1, name: "baseline_v1" },
      ]);
      expect(inspected.prepare("PRAGMA table_info(revisions)").all()).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "snapshot_hash" })]),
      );
    } finally {
      inspected.close();
    }
  });

  it("commits the exact preview snapshot and publishes its outbox event only after commit", () => {
    const opened = openService(databasePath());
    try {
      const { created, frameId } = starter(opened.service);
      const preview = renamePreview(opened.service, created.document.id, frameId, "Exact snapshot");
      const previewRow = opened.database.sqlite.prepare(
        "SELECT document_json, result_snapshot_hash, operation_hash FROM previews WHERE id = ?",
      ).get(preview.id) as { document_json: string; result_snapshot_hash: string; operation_hash: string };
      const observed: Array<{ version: number; status: string; idempotencyRows: number }> = [];
      const unsubscribe = opened.events.subscribe("observer", (event) => {
        if (event.type !== "design.updated" || event.data.designId !== created.document.id || event.data.version !== 2) return;
        const design = opened.database.sqlite.prepare(
          "SELECT current_version AS version FROM designs WHERE id = ?",
        ).get(created.document.id) as { version: number };
        const status = opened.database.sqlite.prepare(
          "SELECT status FROM previews WHERE id = ?",
        ).get(preview.id) as { status: string };
        const idempotency = opened.database.sqlite.prepare(
          "SELECT COUNT(*) AS count FROM idempotency WHERE key = 'commit-exact-0001'",
        ).get() as { count: number };
        observed.push({ version: design.version, status: status.status, idempotencyRows: idempotency.count });
      });

      const committed = opened.service.commitPreview("alice", created.document.id, {
        previewId: preview.id,
        expectedBaseVersion: 1,
        idempotencyKey: "commit-exact-0001",
        message: "Commit exact snapshot",
      });
      unsubscribe();

      const revisionRow = opened.database.sqlite.prepare(
        `SELECT document_json, snapshot_hash, operation_hash, parent_revision_hash, revision_hash
         FROM revisions WHERE id = ?`,
      ).get(committed.revision.id) as {
        document_json: string;
        snapshot_hash: string;
        operation_hash: string;
        parent_revision_hash: string;
        revision_hash: string;
      };
      expect(revisionRow.document_json).toBe(previewRow.document_json);
      expect(revisionRow.snapshot_hash).toBe(previewRow.result_snapshot_hash);
      expect(revisionRow.operation_hash).toBe(previewRow.operation_hash);
      expect(committed.document).toEqual(preview.document);
      expect(committed.revision.snapshotHash).toBe(preview.resultSnapshotHash);
      expect(revisionRow.parent_revision_hash).toBe(created.revision.revisionHash);
      expect(revisionRow.revision_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(observed).toEqual([{ version: 2, status: "committed", idempotencyRows: 1 }]);
      expect(opened.database.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM event_outbox WHERE published_at IS NULL",
      ).get()).toEqual({ count: 0 });
      const replay = opened.service.eventsSince("reconnected-user", 0);
      expect(replay).toMatchObject({ gap: false, hasMore: false, earliestId: 1, latestId: 2 });
      expect(replay.events.map((event) => [event.id, event.type, event.data.version])).toEqual([
        [1, "design.updated", 1],
        [2, "design.updated", 2],
      ]);
      expect(opened.service.eventsSince("reconnected-user", 0, 1).hasMore).toBe(true);
    } finally {
      opened.database.close();
    }
  });

  it("scopes durable replay and live workspace events to one organization", () => {
    const opened = openService(databasePath());
    try {
      const legacyAllowed = starter(opened.service, "create-org-legacy-0001");
      const legacyDenied = starter(opened.service, "create-org-legacy-0002");
      const tenantActor = "tenant-editor";
      const tenantPrincipal = `principal_${createHash("sha256").update(tenantActor).digest("hex").slice(0, 24)}`;
      const now = new Date().toISOString();
      opened.database.sqlite.prepare(
        `INSERT INTO organizations (id, name, config_json, created_at, updated_at)
         VALUES ('organization_tenant', 'Tenant', '{}', ?, ?)`,
      ).run(now, now);
      opened.database.sqlite.prepare(
        `INSERT INTO principals (id, organization_id, kind, display_name, external_id, created_at)
         VALUES (?, 'organization_tenant', 'human', 'Tenant editor', ?, ?)`,
      ).run(tenantPrincipal, tenantActor, now);
      opened.database.sqlite.prepare(
        `INSERT INTO memberships (organization_id, principal_id, role, created_at)
         VALUES ('organization_tenant', ?, 'design_editor', ?)`,
      ).run(tenantPrincipal, now);
      opened.database.sqlite.prepare(
        `INSERT INTO principals (id, organization_id, kind, display_name, external_id, created_at)
         VALUES ('principal_limited_agent', 'organization_legacy', 'agent', 'Limited agent', 'limited-agent', ?)`,
      ).run(now);
      opened.database.sqlite.prepare(
        `INSERT INTO memberships (organization_id, principal_id, role, created_at)
         VALUES ('organization_legacy', 'principal_limited_agent', 'agent', ?)`,
      ).run(now);
      opened.database.sqlite.prepare(
        `INSERT INTO agent_connections
         (id, organization_id, principal_id, adapter, display_name, status, scopes_json, project_ids_json,
          expires_at, created_at, updated_at)
         VALUES ('connection_limited', 'organization_legacy', 'principal_limited_agent', 'generic_mcp',
                 'Limited agent', 'active', '["design:read"]', ?, '2099-01-01T00:00:00.000Z', ?, ?)`,
      ).run(JSON.stringify([legacyAllowed.created.document.id]), now, now);
      opened.database.sqlite.prepare(
        `INSERT INTO agent_grants
         (id, organization_id, principal_id, token_hash, scopes_json, project_ids_json, expires_at, created_at)
         VALUES ('limited', 'organization_legacy', 'principal_limited_agent', 'limited-token-hash',
                 '["design:read"]', ?, '2099-01-01T00:00:00.000Z', ?)`,
      ).run(JSON.stringify([legacyAllowed.created.document.id]), now);

      const legacyLive: string[] = [];
      const tenantLive: string[] = [];
      const stopLegacy = opened.events.subscribe(
        "alice",
        (event) => legacyLive.push(String(event.data.designId ?? "")),
        opened.service.eventOrganizationId("alice"),
      );
      const stopTenant = opened.events.subscribe(
        tenantActor,
        (event) => tenantLive.push(String(event.data.designId ?? "")),
        opened.service.eventOrganizationId(tenantActor),
      );
      const tenant = opened.service.createDesign(tenantActor, {
        name: "Tenant design",
        preset: "web",
        idempotencyKey: "create-org-tenant-0001",
      });
      const tenantFrameId = tenant.document.pages[0]?.children[0];
      if (!tenantFrameId) throw new Error("Tenant starter frame was not created.");
      const tenantPreview = opened.service.createPreview(tenantActor, tenant.document.id, {
        baseVersion: 1,
        operations: [{ type: "update_node", node_id: tenantFrameId, patch: { name: "Tenant preview" } }],
      });
      stopLegacy();
      stopTenant();

      expect(legacyLive).toEqual([]);
      expect(tenantLive).toEqual([tenant.document.id]);
      const legacyReplay = opened.service.eventsSince("alice", 0);
      const tenantReplay = opened.service.eventsSince(tenantActor, 0);
      const restrictedReplay = opened.service.eventsSince("grant_limited", 0);
      expect(opened.service.listDesigns("grant_limited").designs.map((design) => design.id)).toEqual([
        legacyAllowed.created.document.id,
      ]);
      expect(legacyReplay.events.map((event) => event.organizationId)).toEqual([
        "organization_legacy",
        "organization_legacy",
      ]);
      expect(tenantReplay.events.map((event) => event.organizationId)).toEqual(["organization_tenant"]);
      expect(legacyReplay.events.some((event) => event.data.designId === tenant.document.id)).toBe(false);
      expect(tenantReplay.events.every((event) => event.data.designId === tenant.document.id)).toBe(true);
      expect(restrictedReplay.events.map((event) => event.data.designId)).toEqual([legacyAllowed.created.document.id]);
      expect(restrictedReplay.events.some((event) => event.data.designId === legacyDenied.created.document.id)).toBe(false);
      expect(opened.database.sqlite.prepare(
        "SELECT organization_id FROM previews WHERE id = ?",
      ).get(tenantPreview.id)).toEqual({ organization_id: "organization_tenant" });
      expect(thrown(() => opened.service.getPreview("alice", tenant.document.id, tenantPreview.id))).toMatchObject({
        code: "NOT_FOUND",
      });
    } finally {
      opened.database.close();
    }
  });

  it("persists previews, temporary IDs, committed status, and idempotency across restarts", () => {
    const filename = databasePath();
    let opened = openService(filename);
    const { created, frameId } = starter(opened.service);
    const preview = opened.service.createPreview("alice", created.document.id, {
      baseVersion: 1,
      operations: [{
        type: "create_tree",
        parent: { node_id: frameId },
        root_ids: ["tmp:card"],
        nodes: [{
          id: "tmp:card",
          type: "rectangle",
          name: "Restart card",
          layout: { x: 8, y: 8, width: 100, height: 80, mode: "absolute", width_sizing: "fixed", height_sizing: "fixed" },
          style: { fill: "#ffffff" },
          visible: true,
          locked: false,
          archived: false,
          metadata: {},
        }],
      }],
    });
    const temporaryId = (preview.createdIds as { temporary: Record<string, string> }).temporary["tmp:card"];
    opened.database.close();

    opened = openService(filename);
    const restoredPreview = opened.service.getPreview("alice", created.document.id, preview.id);
    expect((restoredPreview.createdIds as { temporary: Record<string, string> }).temporary["tmp:card"]).toBe(temporaryId);
    const committed = opened.service.commitPreview("alice", created.document.id, {
      previewId: preview.id,
      expectedBaseVersion: 1,
      idempotencyKey: "restart-commit-0001",
      message: "Restart-safe commit",
    });
    opened.database.close();

    opened = openService(filename);
    try {
      const replay = opened.service.commitPreview("alice", created.document.id, {
        previewId: preview.id,
        expectedBaseVersion: 1,
        idempotencyKey: "restart-commit-0001",
        message: "Restart-safe commit",
        kind: "ordinary",
      });
      expect(replay.revision.id).toBe(committed.revision.id);
      expect(opened.service.getPreview("alice", created.document.id, preview.id).status).toBe("committed");
      expect(opened.database.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM revisions WHERE design_id = ?",
      ).get(created.document.id)).toEqual({ count: 2 });
    } finally {
      opened.database.close();
    }
  });

  it("enforces expiry, engine versions, and already-committed preview status", () => {
    const opened = openService(databasePath());
    try {
      const { created, frameId } = starter(opened.service);
      const expired = renamePreview(opened.service, created.document.id, frameId, "Expired");
      const recentlyExpiredAt = new Date(Date.now() - 3_600_000).toISOString();
      opened.database.sqlite.prepare(
        "UPDATE previews SET expires_at = ? WHERE id = ?",
      ).run(recentlyExpiredAt, expired.id);
      expect(thrown(() => opened.service.commitPreview("alice", created.document.id, {
        previewId: expired.id,
        expectedBaseVersion: 1,
        idempotencyKey: "expired-commit-0001",
        message: "Must expire",
      }))).toMatchObject({ code: "PREVIEW_EXPIRED", statusCode: 410 });
      expect(opened.database.sqlite.prepare("SELECT status FROM previews WHERE id = ?").get(expired.id)).toEqual({ status: "expired" });

      const purged = renamePreview(opened.service, created.document.id, frameId, "Purged");
      const purgedSnapshotHash = purged.resultSnapshotHash;
      opened.database.sqlite.prepare(
        "UPDATE previews SET expires_at = ? WHERE id = ?",
      ).run(new Date(Date.now() - 172_800_000).toISOString(), purged.id);
      opened.database.cleanupPreviews();
      expect(opened.database.sqlite.prepare("SELECT 1 FROM previews WHERE id = ?").get(purged.id)).toBeUndefined();
      expect(opened.database.sqlite.prepare(
        "SELECT 1 FROM snapshots WHERE snapshot_hash = ?",
      ).get(purgedSnapshotHash)).toBeUndefined();

      const mismatch = renamePreview(opened.service, created.document.id, frameId, "Old engine");
      opened.database.sqlite.prepare(
        "UPDATE previews SET command_engine_version = 'old-engine' WHERE id = ?",
      ).run(mismatch.id);
      expect(thrown(() => opened.service.commitPreview("alice", created.document.id, {
        previewId: mismatch.id,
        expectedBaseVersion: 1,
        idempotencyKey: "mismatch-commit-0001",
        message: "Must mismatch",
      }))).toMatchObject({ code: "PREVIEW_ENGINE_MISMATCH", statusCode: 409 });

      const ready = renamePreview(opened.service, created.document.id, frameId, "Committed once");
      const committed = opened.service.commitPreview("alice", created.document.id, {
        previewId: ready.id,
        expectedBaseVersion: 1,
        idempotencyKey: "once-commit-0001",
        message: "Commit once",
      });
      expect(thrown(() => opened.service.commitPreview("alice", created.document.id, {
        previewId: ready.id,
        expectedBaseVersion: 1,
        idempotencyKey: "once-commit-0002",
        message: "Commit twice",
      }))).toMatchObject({
        code: "PREVIEW_ALREADY_COMMITTED",
        details: { committedRevisionId: committed.revision.id },
      });
    } finally {
      opened.database.close();
    }
  });

  it("rolls back atomically, preserves idempotency, and reports stale preview conflicts", () => {
    const opened = openService(databasePath());
    try {
      const { created, frameId } = starter(opened.service);
      const rollback = renamePreview(opened.service, created.document.id, frameId, "Rollback");
      opened.database.sqlite.exec(`
        CREATE TRIGGER fail_preview_commit BEFORE UPDATE ON previews
        WHEN NEW.status = 'committed' BEGIN SELECT RAISE(ABORT, 'forced rollback'); END;
      `);
      expect(() => opened.service.commitPreview("alice", created.document.id, {
        previewId: rollback.id,
        expectedBaseVersion: 1,
        idempotencyKey: "rollback-commit-0001",
        message: "Force rollback",
      })).toThrow(/forced rollback/);
      opened.database.sqlite.exec("DROP TRIGGER fail_preview_commit");
      expect(opened.service.getDesign("alice", created.document.id).revision.version).toBe(1);
      expect(opened.database.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM revisions WHERE design_id = ?",
      ).get(created.document.id)).toEqual({ count: 1 });
      expect(opened.database.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM idempotency WHERE key = 'rollback-commit-0001'",
      ).get()).toEqual({ count: 0 });
      expect(opened.database.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM event_outbox",
      ).get()).toEqual({ count: 1 });

      const first = renamePreview(opened.service, created.document.id, frameId, "First");
      const stale = renamePreview(opened.service, created.document.id, frameId, "Stale");
      const committed = opened.service.commitPreview("alice", created.document.id, {
        previewId: first.id,
        expectedBaseVersion: 1,
        idempotencyKey: "conflict-commit-0001",
        message: "First wins",
      });
      const replay = opened.service.commitPreview("alice", created.document.id, {
        previewId: first.id,
        expectedBaseVersion: 1,
        idempotencyKey: "conflict-commit-0001",
        message: "First wins",
      });
      expect(replay.revision.id).toBe(committed.revision.id);
      expect(thrown(() => opened.service.commitPreview("alice", created.document.id, {
        previewId: first.id,
        expectedBaseVersion: 1,
        idempotencyKey: "conflict-commit-0001",
        message: "Different request",
      }))).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      expect(thrown(() => opened.service.commitPreview("alice", created.document.id, {
        previewId: stale.id,
        expectedBaseVersion: 1,
        idempotencyKey: "conflict-commit-0002",
        message: "Stale loses",
      }))).toMatchObject({ code: "VERSION_CONFLICT", statusCode: 409 });
      expect(opened.service.getPreview("alice", created.document.id, stale.id).status).toBe("ready");
      expect(opened.service.getDesign("alice", created.document.id).revision.version).toBe(2);
    } finally {
      opened.database.close();
    }
  });

  it("blocks archive operations from ordinary revisions and preview commits", () => {
    const opened = openService(databasePath());
    try {
      const { created, frameId } = starter(opened.service);
      expect(thrown(() => opened.service.applyRevision("alice", created.document.id, {
        baseVersion: 1,
        operations: [{ type: "archive_nodes", node_ids: [frameId] }],
        idempotencyKey: "archive-bypass-0001",
      }))).toMatchObject({ code: "VALIDATION_FAILED", details: { requiredPreviewKind: "archive" } });
      expect(thrown(() => opened.service.createPreview("alice", created.document.id, {
        baseVersion: 1,
        operations: [{ type: "archive_nodes", node_ids: [frameId] }],
      }))).toMatchObject({ code: "VALIDATION_FAILED", details: { requiredPreviewKind: "archive" } });

      const archivePreview = opened.service.createPreview("alice", created.document.id, {
        baseVersion: 1,
        operations: [{ type: "archive_nodes", node_ids: [frameId] }],
        kind: "archive",
      });
      expect(thrown(() => opened.service.commitPreview("alice", created.document.id, {
        previewId: archivePreview.id,
        expectedBaseVersion: 1,
        idempotencyKey: "archive-bypass-0002",
        message: "Wrong commit path",
      }))).toMatchObject({
        code: "VALIDATION_FAILED",
        details: { requiredTool: "design_commit_archive_preview" },
      });
      const committed = opened.service.commitPreview("alice", created.document.id, {
        previewId: archivePreview.id,
        expectedBaseVersion: 1,
        idempotencyKey: "archive-commit-0001",
        message: "Archive through explicit path",
        kind: "archive",
      });
      expect(committed.document.nodes[frameId]?.archived).toBe(true);
      expect(opened.database.sqlite.prepare(
        "SELECT kind, status, committed_revision_id FROM previews WHERE id = ?",
      ).get(archivePreview.id)).toEqual({
        kind: "archive",
        status: "committed",
        committed_revision_id: committed.revision.id,
      });

    } finally {
      opened.database.close();
    }
  });
});
