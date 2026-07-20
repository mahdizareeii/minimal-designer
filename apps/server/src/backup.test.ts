import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import Database from "better-sqlite3";
import tar from "tar-stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BackupManager,
  RESTORE_JOURNAL_MAX_BYTES,
  inspectRestoreJournal,
  restoreVerifiedBackup,
  verifyBackupBundle,
  type BackupManifest,
} from "./backup.js";
import { createDocument } from "./core-adapter.js";
import { DesignerDatabase } from "./db/database.js";
import { EventHub } from "./events.js";
import { DesignerService } from "./service.js";

const temporaryDirectories: string[] = [];
let mutatedBundleSequence = 0;
const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=",
  "base64",
);

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.promises.rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "formaspec-backup-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function createVerifiedBundle(root: string): Promise<string> {
  const data = path.join(root, "source-data");
  const backups = path.join(root, "backups");
  await fs.promises.mkdir(data, { recursive: true });
  await fs.promises.writeFile(path.join(data, "organization.formaspec.yaml"), "name: Test organization\n");
  const database = new DesignerDatabase(path.join(data, "designer.sqlite"));
  try {
    const service = new DesignerService(database, new EventHub(), 900);
    const created = service.createDesign("local", {
      name: "Backup integrity fixture",
      preset: "phone",
      idempotencyKey: "backup-integrity-create-0001",
    });
    const frameId = created.document.pages[0]?.children[0];
    if (!frameId) throw new Error("Backup fixture frame was not created.");
    const preview = service.createPreview("local", created.document.id, {
      baseVersion: 1,
      operations: [{ type: "update_node", node_id: frameId, patch: { name: "Committed backup frame" } }],
    });
    service.commitPreview("local", created.document.id, {
      previewId: preview.id,
      expectedBaseVersion: 1,
      idempotencyKey: "backup-integrity-commit-0001",
      message: "Create revision chain fixture",
    });
    return (await new BackupManager(database, data, backups).create()).path;
  } finally {
    database.close();
  }
}

function digest(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

async function readBundleEntries(bundle: string): Promise<Map<string, Buffer>> {
  const entries = new Map<string, Buffer>();
  const extract = tar.extract();
  extract.on("entry", (header, stream, next) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer | Uint8Array) => chunks.push(Buffer.from(chunk)));
    stream.once("error", next);
    stream.once("end", () => {
      entries.set(header.name, Buffer.concat(chunks));
      next();
    });
    stream.resume();
  });
  await pipeline(fs.createReadStream(bundle), extract);
  return entries;
}

async function writeBundleEntries(root: string, entries: ReadonlyMap<string, Buffer>): Promise<string> {
  mutatedBundleSequence += 1;
  const bundle = path.join(root, `mutated-${mutatedBundleSequence}.tar`);
  const pack = tar.pack();
  const writing = pipeline(pack, fs.createWriteStream(bundle));
  for (const [name, data] of entries) {
    await new Promise<void>((resolve, reject) => {
      pack.entry({ name, type: "file", size: data.length, mode: 0o600 }, data, (error) => (
        error ? reject(error) : resolve()
      ));
    });
  }
  pack.finalize();
  await writing;
  return bundle;
}

function parsedManifest(entries: ReadonlyMap<string, Buffer>): BackupManifest {
  return JSON.parse(entries.get("backup-manifest.json")!.toString("utf8")) as BackupManifest;
}

function replaceChecksum(entries: Map<string, Buffer>, filename: string, hash: string | null): void {
  const rows = entries.get("checksums.sha256")!.toString("utf8")
    .split("\n")
    .filter((line) => line.length > 0 && !line.endsWith(`  ${filename}`));
  if (hash !== null) rows.push(`${hash}  ${filename}`);
  entries.set("checksums.sha256", Buffer.from(`${rows.sort().join("\n")}\n`));
}

function rewriteManifest(entries: Map<string, Buffer>, manifest: unknown): void {
  const data = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  entries.set("backup-manifest.json", data);
  replaceChecksum(entries, "backup-manifest.json", digest(data));
}

function refreshPayloadIntegrity(entries: Map<string, Buffer>, manifest: BackupManifest, filename: string): void {
  const data = entries.get(filename)!;
  const record = manifest.files.find((file) => file.path === filename);
  if (!record) throw new Error(`Missing manifest fixture record: ${filename}`);
  record.sizeBytes = data.length;
  record.sha256 = digest(data);
  replaceChecksum(entries, filename, record.sha256);
  rewriteManifest(entries, manifest);
}

async function mutateBundle(
  root: string,
  source: string,
  mutation: (entries: Map<string, Buffer>) => void | Promise<void>,
): Promise<string> {
  const entries = await readBundleEntries(source);
  await mutation(entries);
  return writeBundleEntries(root, entries);
}

async function mutateDatabasePayload(
  root: string,
  entries: Map<string, Buffer>,
  mutation: (sqlite: Database.Database, manifest: BackupManifest) => void,
): Promise<void> {
  mutatedBundleSequence += 1;
  const filename = path.join(root, `database-mutation-${mutatedBundleSequence}.sqlite`);
  await fs.promises.writeFile(filename, entries.get("database.sqlite")!);
  const manifest = parsedManifest(entries);
  const sqlite = new Database(filename);
  try {
    mutation(sqlite, manifest);
  } finally {
    sqlite.close();
  }
  const data = await fs.promises.readFile(filename);
  entries.set("database.sqlite", data);
  const record = manifest.files.find((file) => file.path === "database.sqlite")!;
  record.sizeBytes = data.length;
  record.sha256 = digest(data);
  replaceChecksum(entries, "database.sqlite", record.sha256);
  rewriteManifest(entries, manifest);
}

describe("verified FormaSpec backups", () => {
  it("creates, verifies, and restores a consistent bundle without replacing the source-local mount root", async () => {
    const root = await temporaryDirectory();
    const data = path.join(root, "data");
    const backups = path.join(root, "backups");
    await fs.promises.mkdir(data, { recursive: true });
    await fs.promises.writeFile(path.join(data, "organization.formaspec.yaml"), "name: Test organization\n");
    const database = new DesignerDatabase(path.join(data, "designer.sqlite"));
    try {
      const manager = new BackupManager(database, data, backups);
      const created = await manager.create();
      expect(path.basename(created.path)).toMatch(/^formaspec-backup-.*\.tar$/);
      expect(created.verification.valid).toBe(true);
      expect(created.verification.sqliteIntegrity).toBe("ok");

      const verified = await verifyBackupBundle(created.path);
      expect(verified.manifest.format).toBe("formaspec-backup");
      expect(verified.manifest.files.some((file) => file.path === "database.sqlite")).toBe(true);

      const restored = path.join(root, "restored-data");
      await fs.promises.mkdir(restored);
      await fs.promises.writeFile(path.join(restored, "old-only.txt"), "remove after verified cutover");
      const originalRootInode = (await fs.promises.stat(restored)).ino;
      await restoreVerifiedBackup(created.path, restored, {
        databaseClosed: true,
        healthCheck: async (directory) => {
          const restoredDatabase = new DesignerDatabase(path.join(directory, "designer.sqlite"));
          restoredDatabase.close();
        },
      });
      expect((await fs.promises.stat(restored)).ino).toBe(originalRootInode);
      expect(fs.existsSync(path.join(restored, "old-only.txt"))).toBe(false);
      expect(fs.existsSync(path.join(restored, ".formaspec-restore-journal"))).toBe(false);
      const restoredOrganizationConfiguration = await fs.promises.readFile(
        path.join(restored, "organization.formaspec.yaml"),
        "utf8",
      );
      expect(restoredOrganizationConfiguration).not.toContain("Test organization");
      expect(JSON.parse(restoredOrganizationConfiguration)).toMatchObject({
        format: "formaspec-organization-config",
        schema_version: 1,
        organizations: [{ id: "organization_legacy", name: "FormaSpec workspace" }],
      });
      const restoredDatabase = new Database(path.join(restored, "designer.sqlite"), { readonly: true });
      try {
        expect((restoredDatabase.prepare("SELECT COUNT(*) AS count FROM operational_locks").get() as { count: number }).count).toBe(0);
      } finally {
        restoredDatabase.close();
      }
    } finally {
      database.close();
    }
  });

  it("fails before verification extraction when filesystem capacity is insufficient", async () => {
    const root = await temporaryDirectory();
    const bundle = await createVerifiedBundle(root);
    const statfs = vi.spyOn(fs.promises, "statfs").mockImplementation(async () => ({
      type: 0n,
      bsize: 1n,
      blocks: 1n,
      bfree: 1n,
      bavail: 1n,
      files: 1n,
      ffree: 1n,
    }) as never);
    try {
      await expect(verifyBackupBundle(bundle)).rejects.toMatchObject({
        code: "TEMPORARILY_UNAVAILABLE",
        statusCode: 507,
      });
    } finally {
      statfs.mockRestore();
    }
    expect((await fs.promises.readdir(path.dirname(bundle))).filter((name) => name.startsWith(".verify-")))
      .toEqual([]);
  });

  it("accepts and restores schema-7 through schema-11 migration-ledger prefixes", async () => {
    const root = await temporaryDirectory();
    const schemaEleven = await createVerifiedBundle(root);
    await expect(verifyBackupBundle(schemaEleven)).resolves.toMatchObject({
      valid: true,
      manifest: { databaseSchemaVersion: 11 },
    });

    const schemaTen = await mutateBundle(root, schemaEleven, async (entries) => {
      await mutateDatabasePayload(root, entries, (sqlite, manifest) => {
        sqlite.exec(`
          PRAGMA foreign_keys = OFF;
          DROP TRIGGER schema_migrations_immutable_update;
          DROP TRIGGER schema_migrations_immutable_delete;
          DROP TRIGGER render_jobs_initial_insert;
          DROP TRIGGER render_jobs_lifecycle_update;
          DROP TRIGGER render_jobs_retention_delete;

          DROP TABLE render_job_delete_permits;
          DROP TABLE render_jobs;

          DELETE FROM schema_migrations WHERE version = 11;
          UPDATE system_metadata SET value = '10' WHERE key = 'database_schema_version';

          CREATE TRIGGER schema_migrations_immutable_update
          BEFORE UPDATE ON schema_migrations BEGIN SELECT RAISE(ABORT, 'schema migrations are immutable'); END;
          CREATE TRIGGER schema_migrations_immutable_delete
          BEFORE DELETE ON schema_migrations BEGIN SELECT RAISE(ABORT, 'schema migrations are immutable'); END;
          PRAGMA foreign_keys = ON;
        `);
        manifest.databaseSchemaVersion = 10;
      });
    });
    await expect(verifyBackupBundle(schemaTen)).resolves.toMatchObject({
      valid: true,
      manifest: { databaseSchemaVersion: 10 },
    });

    const schemaNine = await mutateBundle(root, schemaTen, async (entries) => {
      await mutateDatabasePayload(root, entries, (sqlite, manifest) => {
        sqlite.exec(`
          PRAGMA foreign_keys = OFF;
          DROP TRIGGER schema_migrations_immutable_update;
          DROP TRIGGER schema_migrations_immutable_delete;
          DROP TRIGGER portable_imports_immutable_update;
          DROP TRIGGER portable_imports_immutable_delete;

          DROP TABLE portable_imports;

          DELETE FROM schema_migrations WHERE version = 10;
          UPDATE system_metadata SET value = '9' WHERE key = 'database_schema_version';

          CREATE TRIGGER schema_migrations_immutable_update
          BEFORE UPDATE ON schema_migrations BEGIN SELECT RAISE(ABORT, 'schema migrations are immutable'); END;
          CREATE TRIGGER schema_migrations_immutable_delete
          BEFORE DELETE ON schema_migrations BEGIN SELECT RAISE(ABORT, 'schema migrations are immutable'); END;
          PRAGMA foreign_keys = ON;
        `);
        manifest.databaseSchemaVersion = 9;
      });
    });
    await expect(verifyBackupBundle(schemaNine)).resolves.toMatchObject({
      valid: true,
      manifest: { databaseSchemaVersion: 9 },
    });

    const schemaEight = await mutateBundle(root, schemaNine, async (entries) => {
      await mutateDatabasePayload(root, entries, (sqlite, manifest) => {
        sqlite.exec(`
          PRAGMA foreign_keys = OFF;
          DROP TRIGGER schema_migrations_immutable_update;
          DROP TRIGGER schema_migrations_immutable_delete;
          DROP TRIGGER audit_events_retention_delete;
          DROP TRIGGER event_outbox_retention_delete;
          DROP TRIGGER audit_retention_runs_immutable_update;
          DROP TRIGGER audit_retention_runs_immutable_delete;

          DROP TABLE audit_retention_delete_permits;
          DROP TABLE audit_retention_runs;
          DROP TABLE audit_retention_previews;

          DELETE FROM schema_migrations WHERE version = 9;
          UPDATE system_metadata SET value = '8' WHERE key = 'database_schema_version';

          CREATE TRIGGER audit_events_immutable_delete
          BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit events are immutable'); END;
          CREATE TRIGGER schema_migrations_immutable_update
          BEFORE UPDATE ON schema_migrations BEGIN SELECT RAISE(ABORT, 'schema migrations are immutable'); END;
          CREATE TRIGGER schema_migrations_immutable_delete
          BEFORE DELETE ON schema_migrations BEGIN SELECT RAISE(ABORT, 'schema migrations are immutable'); END;
          PRAGMA foreign_keys = ON;
        `);
        manifest.databaseSchemaVersion = 8;
      });
    });
    await expect(verifyBackupBundle(schemaEight)).resolves.toMatchObject({
      valid: true,
      manifest: { databaseSchemaVersion: 8 },
    });

    const schemaSeven = await mutateBundle(root, schemaEight, async (entries) => {
      await mutateDatabasePayload(root, entries, (sqlite, manifest) => {
        sqlite.exec(`
          PRAGMA foreign_keys = OFF;
          DROP TRIGGER schema_migrations_immutable_update;
          DROP TRIGGER schema_migrations_immutable_delete;

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

          DELETE FROM schema_migrations WHERE version = 8;
          UPDATE system_metadata SET value = '7' WHERE key = 'database_schema_version';

          CREATE TRIGGER schema_migrations_immutable_update
          BEFORE UPDATE ON schema_migrations BEGIN SELECT RAISE(ABORT, 'schema migrations are immutable'); END;
          CREATE TRIGGER schema_migrations_immutable_delete
          BEFORE DELETE ON schema_migrations BEGIN SELECT RAISE(ABORT, 'schema migrations are immutable'); END;
          PRAGMA foreign_keys = ON;
        `);
        manifest.databaseSchemaVersion = 7;
      });
    });
    await expect(verifyBackupBundle(schemaSeven)).resolves.toMatchObject({
      valid: true,
      manifest: { databaseSchemaVersion: 7 },
    });

    for (const [sourceVersion, bundle] of [
      [10, schemaTen],
      [9, schemaNine],
      [8, schemaEight],
      [7, schemaSeven],
    ] as const) {
      const restored = path.join(root, `restored-schema-${sourceVersion}`);
      await fs.promises.mkdir(restored);
      await restoreVerifiedBackup(bundle, restored, {
        databaseClosed: true,
        healthCheck: async (directory) => {
          const upgraded = new DesignerDatabase(path.join(directory, "designer.sqlite"));
          upgraded.close();
        },
      });
      const upgraded = new DesignerDatabase(path.join(restored, "designer.sqlite"));
      try {
        expect(upgraded.schemaVersion()).toBe(11);
        expect(upgraded.metadata("database_schema_version")).toBe("11");
        expect(upgraded.sqlite.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'audit_retention_runs'",
        ).get()).toEqual({ name: "audit_retention_runs" });
        expect(upgraded.sqlite.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'portable_imports'",
        ).get()).toEqual({ name: "portable_imports" });
        expect(upgraded.sqlite.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'render_jobs'",
        ).get()).toEqual({ name: "render_jobs" });
      } finally {
        upgraded.close();
      }
    }
  });

  it("rejects ledger-only migration-9 through migration-11 schema tampering", async () => {
    const root = await temporaryDirectory();
    const source = await createVerifiedBundle(root);
    const mutations: Array<{
      expectedReason: string;
      apply: (sqlite: Database.Database) => void;
    }> = [
      {
        expectedReason: "missing required table render_jobs",
        apply: (sqlite) => sqlite.exec("DROP TABLE render_jobs"),
      },
      {
        expectedReason: "missing required table render_job_delete_permits",
        apply: (sqlite) => sqlite.exec("DROP TABLE render_job_delete_permits"),
      },
      {
        expectedReason: "missing required index render_jobs_retention",
        apply: (sqlite) => sqlite.exec("DROP INDEX render_jobs_retention"),
      },
      {
        expectedReason: "missing required trigger render_jobs_initial_insert",
        apply: (sqlite) => sqlite.exec("DROP TRIGGER render_jobs_initial_insert"),
      },
      {
        expectedReason: "missing required trigger render_jobs_retention_delete",
        apply: (sqlite) => sqlite.exec("DROP TRIGGER render_jobs_retention_delete"),
      },
      {
        expectedReason: "missing required table portable_imports",
        apply: (sqlite) => sqlite.exec("DROP TABLE portable_imports"),
      },
      {
        expectedReason: "missing required index portable_imports_org_created",
        apply: (sqlite) => sqlite.exec("DROP INDEX portable_imports_org_created"),
      },
      {
        expectedReason: "missing required trigger portable_imports_immutable_delete",
        apply: (sqlite) => sqlite.exec("DROP TRIGGER portable_imports_immutable_delete"),
      },
      {
        expectedReason: "missing required columns: diagnostics_json",
        apply: (sqlite) => sqlite.exec("ALTER TABLE portable_imports DROP COLUMN diagnostics_json"),
      },
      {
        expectedReason: "missing required table audit_retention_delete_permits",
        apply: (sqlite) => sqlite.exec("DROP TABLE audit_retention_delete_permits"),
      },
      {
        expectedReason: "missing required index audit_retention_runs_org_sequence",
        apply: (sqlite) => sqlite.exec("DROP INDEX audit_retention_runs_org_sequence"),
      },
      {
        expectedReason: "missing required trigger event_outbox_retention_delete",
        apply: (sqlite) => sqlite.exec("DROP TRIGGER event_outbox_retention_delete"),
      },
      {
        expectedReason: "retains forbidden trigger audit_events_immutable_delete",
        apply: (sqlite) => sqlite.exec(`
          CREATE TRIGGER audit_events_immutable_delete
          BEFORE DELETE ON audit_events
          BEGIN SELECT RAISE(ABORT, 'audit events are immutable'); END;
        `),
      },
    ];

    for (const mutation of mutations) {
      const bundle = await mutateBundle(root, source, async (entries) => {
        await mutateDatabasePayload(root, entries, (sqlite) => mutation.apply(sqlite));
      });
      const error = await verifyBackupBundle(bundle).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toMatchObject({
        code: "VALIDATION_FAILED",
        details: { reason: expect.stringContaining(mutation.expectedReason) },
      });
    }
  });

  it("validates only supported structural invariants for a schema-1 legacy database", async () => {
    const root = await temporaryDirectory();
    const source = await createVerifiedBundle(root);
    const legacy = await mutateBundle(root, source, async (entries) => {
      const filename = path.join(root, "legacy-schema-1.sqlite");
      const sqlite = new Database(filename);
      const now = "2026-01-01T00:00:00.000Z";
      const document = createDocument("document_legacybackup0001", "Legacy backup", now, "phone");
      try {
        sqlite.exec(`
          CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
          CREATE TABLE designs(
            id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, name TEXT NOT NULL,
            current_version INTEGER NOT NULL, current_revision_id TEXT NOT NULL,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
          );
          CREATE TABLE revisions(
            id TEXT PRIMARY KEY, design_id TEXT NOT NULL, version INTEGER NOT NULL,
            parent_revision_id TEXT, actor_id TEXT NOT NULL, message TEXT,
            document_json TEXT NOT NULL, operations_json TEXT NOT NULL, created_at TEXT NOT NULL,
            UNIQUE(design_id, version)
          );
          CREATE TABLE assets(
            id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, design_id TEXT, filename TEXT NOT NULL,
            mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, width INTEGER NOT NULL,
            height INTEGER NOT NULL, sha256 TEXT NOT NULL, data BLOB NOT NULL, created_at TEXT NOT NULL
          );
          INSERT INTO schema_migrations VALUES (1, 'baseline_v1', '${now}');
        `);
        sqlite.prepare("INSERT INTO designs VALUES (?, 'local', ?, 1, 'revision_legacybackup0001', ?, ?)")
          .run(document.id, document.name, now, now);
        sqlite.prepare(
          "INSERT INTO revisions VALUES ('revision_legacybackup0001', ?, 1, NULL, 'local', 'Legacy', ?, '[]', ?)",
        ).run(document.id, JSON.stringify(document), now);
      } finally {
        sqlite.close();
      }
      const data = await fs.promises.readFile(filename);
      entries.set("database.sqlite", data);
      const manifest = parsedManifest(entries);
      manifest.databaseSchemaVersion = 1;
      const record = manifest.files.find((file) => file.path === "database.sqlite")!;
      record.sizeBytes = data.length;
      record.sha256 = digest(data);
      replaceChecksum(entries, "database.sqlite", record.sha256);
      rewriteManifest(entries, manifest);
    });
    await expect(verifyBackupBundle(legacy)).resolves.toMatchObject({
      valid: true,
      manifest: { databaseSchemaVersion: 1 },
    });
  });

  it("rejects unknown manifest properties, incorrect types, and invalid timestamps or version strings", async () => {
    const root = await temporaryDirectory();
    const source = await createVerifiedBundle(root);
    const mutations: Array<(manifest: BackupManifest & Record<string, unknown>) => void> = [
      (manifest) => { manifest.unexpected = true; },
      (manifest) => { (manifest.files[0] as unknown as Record<string, unknown>).unexpected = true; },
      (manifest) => { manifest.databaseSchemaVersion = "8" as unknown as number; },
      (manifest) => { manifest.createdAt = "2026-07-20"; },
      (manifest) => { manifest.commandEngineVersion = ""; },
      (manifest) => { manifest.rendererVersion = "v".repeat(129); },
    ];
    for (const mutation of mutations) {
      const bundle = await mutateBundle(root, source, (entries) => {
        const manifest = parsedManifest(entries) as BackupManifest & Record<string, unknown>;
        mutation(manifest);
        rewriteManifest(entries, manifest);
      });
      await expect(verifyBackupBundle(bundle)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    }
  });

  it("rejects duplicate manifest paths and duplicate checksum rows", async () => {
    const root = await temporaryDirectory();
    const source = await createVerifiedBundle(root);
    const duplicateManifest = await mutateBundle(root, source, (entries) => {
      const manifest = parsedManifest(entries);
      manifest.files.push({ ...manifest.files[0]! });
      rewriteManifest(entries, manifest);
    });
    await expect(verifyBackupBundle(duplicateManifest)).rejects.toThrow(/manifest repeats/);

    const duplicateChecksum = await mutateBundle(root, source, (entries) => {
      const rows = entries.get("checksums.sha256")!.toString("utf8").trimEnd().split("\n");
      entries.set("checksums.sha256", Buffer.from(`${rows.join("\n")}\n${rows[0]}\n`));
    });
    await expect(verifyBackupBundle(duplicateChecksum)).rejects.toThrow(/checksum manifest repeats/);
  });

  it("rejects undeclared archive payloads and missing checksum coverage", async () => {
    const root = await temporaryDirectory();
    const source = await createVerifiedBundle(root);
    const undeclared = await mutateBundle(root, source, (entries) => {
      entries.set("undeclared.txt", Buffer.from("not in the manifest"));
    });
    await expect(verifyBackupBundle(undeclared)).rejects.toThrow(/undeclared payload/);

    const missingCoverage = await mutateBundle(root, source, (entries) => {
      replaceChecksum(entries, "organization-config.yaml", null);
    });
    await expect(verifyBackupBundle(missingCoverage)).rejects.toThrow(/checksum coverage is missing/);

    const missingRequiredPayload = await mutateBundle(root, source, (entries) => {
      const manifest = parsedManifest(entries);
      manifest.files = manifest.files.filter((file) => file.path !== "asset-manifest.json");
      entries.delete("asset-manifest.json");
      replaceChecksum(entries, "asset-manifest.json", null);
      rewriteManifest(entries, manifest);
    });
    await expect(verifyBackupBundle(missingRequiredPayload)).rejects.toThrow(/missing required payload/);
  });

  it("generates organization configuration from the database and rejects a self-consistently tampered policy export", async () => {
    const root = await temporaryDirectory();
    const source = await createVerifiedBundle(root);
    const entries = await readBundleEntries(source);
    const generated = entries.get("organization-config.yaml")!.toString("utf8");
    expect(generated).not.toContain("Test organization");
    expect(JSON.parse(generated)).toMatchObject({
      format: "formaspec-organization-config",
      organizations: [{ id: "organization_legacy", policy_hash: expect.stringMatching(/^[a-f0-9]{64}$/) }],
    });

    const tampered = await mutateBundle(root, source, (mutatedEntries) => {
      const manifest = parsedManifest(mutatedEntries);
      const configuration = JSON.parse(mutatedEntries.get("organization-config.yaml")!.toString("utf8")) as {
        organizations: Array<{ policy: { agents: { enabled: boolean } }; policy_hash: string }>;
      };
      configuration.organizations[0]!.policy.agents.enabled = false;
      configuration.organizations[0]!.policy_hash = "f".repeat(64);
      mutatedEntries.set("organization-config.yaml", Buffer.from(`${JSON.stringify(configuration, null, 2)}\n`));
      refreshPayloadIntegrity(mutatedEntries, manifest, "organization-config.yaml");
    });
    await expect(verifyBackupBundle(tampered)).rejects.toThrow(/does not match the database policy ledger/);

    const legacyFormatOne = await mutateBundle(root, source, (mutatedEntries) => {
      const manifest = parsedManifest(mutatedEntries);
      manifest.formatVersion = 1;
      mutatedEntries.set("organization-config.yaml", Buffer.from("name: Historical FormaSpec workspace\n"));
      refreshPayloadIntegrity(mutatedEntries, manifest, "organization-config.yaml");
    });
    await expect(verifyBackupBundle(legacyFormatOne)).resolves.toMatchObject({
      valid: true,
      manifest: { formatVersion: 1 },
    });
  });

  it("strictly matches asset-manifest entries and rejects orphan normalized assets", async () => {
    const root = await temporaryDirectory();
    const source = await createVerifiedBundle(root);
    const assetSha = digest(onePixelPng);
    const assetPath = `assets/sha256/${assetSha.slice(0, 2)}/${assetSha}.png`;

    const duplicateAssetManifest = await mutateBundle(root, source, (entries) => {
      const manifest = parsedManifest(entries);
      entries.set("asset-manifest.json", Buffer.from(`${JSON.stringify({ files: [assetPath, assetPath] }, null, 2)}\n`));
      refreshPayloadIntegrity(entries, manifest, "asset-manifest.json");
    });
    await expect(verifyBackupBundle(duplicateAssetManifest)).rejects.toThrow(/Asset manifest repeats/);

    const orphanAsset = await mutateBundle(root, source, (entries) => {
      const manifest = parsedManifest(entries);
      entries.set(assetPath, onePixelPng);
      manifest.files.push({ path: assetPath, sizeBytes: onePixelPng.length, sha256: assetSha });
      replaceChecksum(entries, assetPath, assetSha);
      entries.set("asset-manifest.json", Buffer.from(`${JSON.stringify({ files: [assetPath] }, null, 2)}\n`));
      refreshPayloadIntegrity(entries, manifest, "asset-manifest.json");
    });
    await expect(verifyBackupBundle(orphanAsset)).rejects.toThrow(/unreferenced normalized asset/);
  });

  it("excludes unreferenced content-addressed files from new backups without deleting local quarantine data", async () => {
    const root = await temporaryDirectory();
    const data = path.join(root, "orphan-source-data");
    const backups = path.join(root, "orphan-backups");
    await fs.promises.mkdir(data, { recursive: true });
    await fs.promises.writeFile(path.join(data, "organization.formaspec.yaml"), "name: Orphan asset test\n");
    const sha256 = digest(onePixelPng);
    const assetPath = `assets/sha256/${sha256.slice(0, 2)}/${sha256}.png`;
    const orphan = path.join(data, ...assetPath.split("/"));
    await fs.promises.mkdir(path.dirname(orphan), { recursive: true });
    await fs.promises.writeFile(orphan, onePixelPng);
    const database = new DesignerDatabase(path.join(data, "designer.sqlite"));
    try {
      const created = await new BackupManager(database, data, backups).create();
      const entries = await readBundleEntries(created.path);
      expect(entries.has(assetPath)).toBe(false);
      expect(JSON.parse(entries.get("asset-manifest.json")!.toString("utf8")))
        .toEqual({ files: [] });
      await expect(fs.promises.readFile(orphan)).resolves.toEqual(onePixelPng);
    } finally {
      database.close();
    }
  });

  it("accepts a verified legacy asset BLOB fallback and rejects a corrupt fallback", async () => {
    const root = await temporaryDirectory();
    const source = await createVerifiedBundle(root);
    const sha256 = digest(onePixelPng);
    const validLegacy = await mutateBundle(root, source, async (entries) => {
      await mutateDatabasePayload(root, entries, (sqlite) => {
        sqlite.prepare(
          `INSERT INTO assets
           (id, actor_id, design_id, filename, mime_type, size_bytes, width, height, sha256, data, created_at, organization_id)
           VALUES ('asset_legacybackup0001', 'local', NULL, 'legacy.png', 'image/png', ?, 1, 1, ?, ?,
                   '2026-07-20T00:00:00.000Z', 'organization_legacy')`,
        ).run(onePixelPng.length, sha256, onePixelPng);
      });
    });
    await expect(verifyBackupBundle(validLegacy)).resolves.toMatchObject({ valid: true });
    await expect(verifyBackupBundle(validLegacy, { requireRasterVerifier: true }))
      .rejects.toMatchObject({ code: "TEMPORARILY_UNAVAILABLE", statusCode: 503 });

    let decodeCalls = 0;
    const rasterVerifier = {
      limits: { maxBytes: 1024 * 1024, maxPixels: 1024 * 1024 },
      engine: {
        async normalizeRaster(data: Buffer, options: {
          sourceMimeType: "image/png" | "image/jpeg" | "image/webp";
          sourceWidth: number;
          sourceHeight: number;
          maxBytes: number;
          maxPixels: number;
        }) {
          decodeCalls += 1;
          expect(data).toEqual(onePixelPng);
          expect(options).toMatchObject({
            sourceMimeType: "image/png",
            sourceWidth: 1,
            sourceHeight: 1,
            maxBytes: 1024 * 1024,
            maxPixels: 1024 * 1024,
          });
          return { data: onePixelPng, mimeType: "image/png" as const, width: 1, height: 1 };
        },
      },
    };
    await expect(verifyBackupBundle(validLegacy, {
      rasterVerifier,
      requireRasterVerifier: true,
    })).resolves.toMatchObject({ valid: true });
    expect(decodeCalls).toBe(1);

    await expect(verifyBackupBundle(validLegacy, {
      requireRasterVerifier: true,
      rasterVerifier: {
        ...rasterVerifier,
        engine: {
          async normalizeRaster() {
            throw new Error("full decode rejected fixture");
          },
        },
      },
    })).rejects.toThrow(/failed isolated full-image decode/);

    const corruptLegacy = await mutateBundle(root, source, async (entries) => {
      await mutateDatabasePayload(root, entries, (sqlite) => {
        const corrupt = Buffer.from("not-a-normalized-image");
        sqlite.prepare(
          `INSERT INTO assets
           (id, actor_id, design_id, filename, mime_type, size_bytes, width, height, sha256, data, created_at, organization_id)
           VALUES ('asset_legacybackup0002', 'local', NULL, 'legacy.png', 'image/png', ?, 1, 1, ?, ?,
                   '2026-07-20T00:00:00.000Z', 'organization_legacy')`,
        ).run(corrupt.length, digest(corrupt), corrupt);
      });
    });
    await expect(verifyBackupBundle(corruptLegacy)).rejects.toThrow(/not a valid normalized image/);
  });

  it("rejects historical managed asset references that are missing, cross-project, or cross-organization", async () => {
    const createInvalidBackup = async (
      label: string,
      setup: (database: DesignerDatabase, service: DesignerService, designId: string) => Promise<void> | void,
      expected: RegExp,
    ) => {
      const root = await temporaryDirectory();
      const data = path.join(root, `asset-reference-${label}`);
      const backups = path.join(root, `asset-reference-${label}-backups`);
      await fs.promises.mkdir(data, { recursive: true });
      await fs.promises.writeFile(path.join(data, "organization.formaspec.yaml"), "name: Asset reference test\n");
      const database = new DesignerDatabase(path.join(data, "designer.sqlite"));
      try {
        const service = new DesignerService(database, new EventHub(), 900);
        const created = service.createDesign("local", {
          name: `Asset reference ${label}`,
          preset: "phone",
          idempotencyKey: `asset-reference-create-${label}`,
        });
        await setup(database, service, created.document.id);
        await expect(new BackupManager(database, data, backups).create()).rejects.toThrow(expected);
      } finally {
        database.close();
      }
    };

    const documentAsset = (id: string) => ({
      id,
      name: "managed.png",
      kind: "image" as const,
      mime_type: "image/png",
      size_bytes: onePixelPng.length,
      storage_key: `asset:${id}`,
      sha256: digest(onePixelPng),
      width: 1,
      height: 1,
      metadata: {},
    });

    await createInvalidBackup("missing", (_database, service, designId) => {
      const asset = documentAsset("asset_missingbackup000000000001");
      service.applyRevision("local", designId, {
        baseVersion: 1,
        operations: [{ type: "upsert_asset", asset }],
        idempotencyKey: "asset-reference-missing-revision",
      });
    }, /without a database record/);

    await createInvalidBackup("cross-project", (_database, service, designId) => {
      const second = service.createDesign("local", {
        name: "Asset owner",
        preset: "phone",
        idempotencyKey: "asset-reference-owner-create",
      });
      const stored = service.saveAsset("local", {
        designId: second.document.id,
        filename: "managed.png",
        mimeType: "image/png",
        width: 1,
        height: 1,
        data: onePixelPng,
      });
      service.applyRevision("local", designId, {
        baseVersion: 1,
        operations: [{ type: "upsert_asset", asset: documentAsset(stored.id) }],
        idempotencyKey: "asset-reference-cross-project-revision",
      });
    }, /linked to a different project/);

    await createInvalidBackup("cross-organization", (database, service, designId) => {
      const stored = service.saveAsset("local", {
        designId,
        filename: "managed.png",
        mimeType: "image/png",
        width: 1,
        height: 1,
        data: onePixelPng,
      });
      service.applyRevision("local", designId, {
        baseVersion: 1,
        operations: [{ type: "upsert_asset", asset: documentAsset(stored.id) }],
        idempotencyKey: "asset-reference-cross-organization-revision",
      });
      const now = "2026-07-20T00:00:00.000Z";
      database.sqlite.prepare(
        "INSERT INTO organizations (id, name, config_json, created_at, updated_at) VALUES (?, ?, '{}', ?, ?)",
      ).run("organization_asset_attacker", "Asset attacker", now, now);
      database.sqlite.prepare("UPDATE assets SET organization_id = ? WHERE id = ?")
        .run("organization_asset_attacker", stored.id);
    }, /belongs to a different organization/);
  });

  it("rejects a bad backup-manifest checksum and invalid manifest sizes or hashes", async () => {
    const root = await temporaryDirectory();
    const source = await createVerifiedBundle(root);
    const badManifestChecksum = await mutateBundle(root, source, (entries) => {
      replaceChecksum(entries, "backup-manifest.json", "0".repeat(64));
    });
    await expect(verifyBackupBundle(badManifestChecksum)).rejects.toThrow(/manifest checksum failed/);

    const invalidRecords: Array<(record: BackupManifest["files"][number]) => void> = [
      (record) => { record.sizeBytes = -1; },
      (record) => { record.sha256 = "A".repeat(64); },
    ];
    for (const mutation of invalidRecords) {
      const bundle = await mutateBundle(root, source, (entries) => {
        const manifest = parsedManifest(entries);
        mutation(manifest.files[0]!);
        rewriteManifest(entries, manifest);
      });
      await expect(verifyBackupBundle(bundle)).rejects.toThrow(/invalid file record/);
    }
  });

  it("rejects renamed, non-contiguous, and unsupported migration-ledger entries", async () => {
    const root = await temporaryDirectory();
    const source = await createVerifiedBundle(root);
    const mutations: Array<(sqlite: Database.Database, manifest: BackupManifest) => void> = [
      (sqlite) => {
        sqlite.exec(`
          DROP TRIGGER schema_migrations_immutable_update;
          DROP TRIGGER schema_migrations_immutable_delete;
          UPDATE schema_migrations SET name = 'renamed_migration' WHERE version = 8;
        `);
      },
      (sqlite) => {
        sqlite.exec(`
          DROP TRIGGER schema_migrations_immutable_update;
          DROP TRIGGER schema_migrations_immutable_delete;
          DELETE FROM schema_migrations WHERE version = 4;
        `);
      },
      (sqlite, manifest) => {
        sqlite.exec(`
          DROP TRIGGER schema_migrations_immutable_update;
          DROP TRIGGER schema_migrations_immutable_delete;
          INSERT INTO schema_migrations(version, name, applied_at)
          VALUES (12, 'unsupported_future_migration', '2026-07-20T00:00:00.000Z');
        `);
        manifest.databaseSchemaVersion = 12;
      },
    ];
    for (const mutation of mutations) {
      const bundle = await mutateBundle(root, source, async (entries) => {
        await mutateDatabasePayload(root, entries, mutation);
      });
      await expect(verifyBackupBundle(bundle)).rejects.toThrow(/recognized contiguous prefix/);
    }

    const mismatchedManifest = await mutateBundle(root, source, (entries) => {
      const manifest = parsedManifest(entries);
      manifest.databaseSchemaVersion = 7;
      rewriteManifest(entries, manifest);
    });
    await expect(verifyBackupBundle(mismatchedManifest)).rejects.toThrow(/does not match its migration ledger 11/);
  });

  it("rejects snapshot, revision-chain, and project-head integrity tampering", async () => {
    const root = await temporaryDirectory();
    const source = await createVerifiedBundle(root);
    const mutations: Array<(sqlite: Database.Database) => void> = [
      (sqlite) => {
        sqlite.exec(`
          DROP TRIGGER snapshots_immutable_update;
          UPDATE snapshots SET uncompressed_bytes = uncompressed_bytes + 1
          WHERE snapshot_hash = (SELECT snapshot_hash FROM revisions ORDER BY version LIMIT 1);
        `);
      },
      (sqlite) => {
        sqlite.exec(`
          DROP TRIGGER revisions_immutable_update;
          UPDATE revisions SET operation_hash = '${"0".repeat(64)}' WHERE version = 2;
        `);
      },
      (sqlite) => {
        sqlite.exec(`
          DROP TRIGGER revisions_immutable_update;
          UPDATE revisions SET document_json = '{}' WHERE version = 2;
        `);
      },
      (sqlite) => {
        sqlite.exec(`
          DROP TRIGGER revisions_immutable_update;
          UPDATE revisions SET operations_json = '[{"type":"unknown_operation"}]' WHERE version = 2;
        `);
      },
      (sqlite) => {
        sqlite.exec(`
          UPDATE designs
          SET current_version = 1,
              current_revision_id = (SELECT id FROM revisions WHERE design_id = designs.id AND version = 1);
        `);
      },
    ];
    for (const mutation of mutations) {
      const bundle = await mutateBundle(root, source, async (entries) => {
        await mutateDatabasePayload(root, entries, (sqlite) => mutation(sqlite));
      });
      await expect(verifyBackupBundle(bundle)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    }
  });

  it("rolls back a failed candidate move, retains the journal, and cleans it on a bounded retry", async () => {
    const root = await temporaryDirectory();
    const bundle = await createVerifiedBundle(root);
    const destination = path.join(root, "data");
    await fs.promises.mkdir(destination);
    await fs.promises.writeFile(path.join(destination, "designer.sqlite"), "original-database-bytes");
    await fs.promises.writeFile(path.join(destination, "keep.txt"), "original-only");
    const originalRename = fs.promises.rename.bind(fs.promises);
    const rename = vi.spyOn(fs.promises, "rename").mockImplementation(async (source, target) => {
      const sourcePath = String(source);
      const targetPath = String(target);
      if (
        sourcePath.includes(`${path.sep}.formaspec-restore-journal${path.sep}candidate${path.sep}`)
        && path.dirname(targetPath) === destination
        && path.basename(sourcePath) === "designer.sqlite"
      ) {
        throw new Error("injected candidate move failure");
      }
      return originalRename(source, target);
    });

    try {
      await expect(restoreVerifiedBackup(bundle, destination, { databaseClosed: true }))
        .rejects.toThrow("injected candidate move failure");
    } finally {
      rename.mockRestore();
    }

    expect(await fs.promises.readFile(path.join(destination, "designer.sqlite"), "utf8")).toBe("original-database-bytes");
    expect(await fs.promises.readFile(path.join(destination, "keep.txt"), "utf8")).toBe("original-only");
    const journalPath = path.join(destination, ".formaspec-restore-journal", "journal.json");
    const journal = JSON.parse(await fs.promises.readFile(journalPath, "utf8")) as Record<string, unknown>;
    expect(journal).toMatchObject({
      phase: "rolled-back",
      failure: { cutover: "injected candidate move failure" },
    });
    expect(journal).not.toHaveProperty("sourceBundlePath");

    await restoreVerifiedBackup(bundle, destination, { databaseClosed: true });
    expect(fs.existsSync(path.join(destination, ".formaspec-restore-journal"))).toBe(false);
    expect(fs.existsSync(path.join(destination, "keep.txt"))).toBe(false);
    const restoredDatabase = new Database(path.join(destination, "designer.sqlite"), { readonly: true });
    restoredDatabase.close();
  });

  it("preserves the only saved originals when rollback fails and resumes rollback on retry", async () => {
    const root = await temporaryDirectory();
    const bundle = await createVerifiedBundle(root);
    const destination = path.join(root, "data");
    await fs.promises.mkdir(destination);
    await fs.promises.writeFile(path.join(destination, "keep.txt"), "irreplaceable-original");
    const originalRename = fs.promises.rename.bind(fs.promises);
    const rename = vi.spyOn(fs.promises, "rename").mockImplementation(async (source, target) => {
      const sourcePath = String(source);
      const targetPath = String(target);
      if (
        sourcePath.includes(`${path.sep}.formaspec-restore-journal${path.sep}rollback${path.sep}`)
        && path.basename(sourcePath) === "keep.txt"
        && targetPath === path.join(destination, "keep.txt")
      ) {
        throw new Error("injected rollback move failure");
      }
      return originalRename(source, target);
    });

    try {
      await expect(restoreVerifiedBackup(bundle, destination, {
        databaseClosed: true,
        healthCheck: async () => {
          throw new Error("injected health failure");
        },
      })).rejects.toThrow("Restore cutover failed and rollback did not complete");
    } finally {
      rename.mockRestore();
    }

    const journalRoot = path.join(destination, ".formaspec-restore-journal");
    expect(await fs.promises.readFile(path.join(journalRoot, "rollback", "keep.txt"), "utf8"))
      .toBe("irreplaceable-original");
    expect(JSON.parse(await fs.promises.readFile(path.join(journalRoot, "journal.json"), "utf8"))).toMatchObject({
      phase: "rolling-back",
      failure: {
        cutover: "injected health failure",
        rollback: "injected rollback move failure",
      },
    });

    await restoreVerifiedBackup(bundle, destination, { databaseClosed: true });
    expect(fs.existsSync(journalRoot)).toBe(false);
    expect(fs.existsSync(path.join(destination, "keep.txt"))).toBe(false);
    const restoredDatabase = new Database(path.join(destination, "designer.sqlite"), { readonly: true });
    restoredDatabase.close();
  });

  it("reruns health verification before cleaning a committed crash journal", async () => {
    const root = await temporaryDirectory();
    const bundle = await createVerifiedBundle(root);
    const destination = path.join(root, "committed-retry");
    await fs.promises.mkdir(destination);
    let injected = false;
    let healthChecks = 0;
    const originalRemove = fs.promises.rm.bind(fs.promises);
    const remove = vi.spyOn(fs.promises, "rm").mockImplementation(async (target, options) => {
      const filename = String(target);
      if (!injected && filename.endsWith(`${path.sep}.formaspec-restore-journal${path.sep}candidate`)) {
        injected = true;
        throw new Error("injected post-commit cleanup interruption");
      }
      return originalRemove(target, options);
    });
    try {
      await expect(restoreVerifiedBackup(bundle, destination, {
        databaseClosed: true,
        healthCheck: async () => { healthChecks += 1; },
      })).rejects.toThrow(/post-commit cleanup interruption/);
    } finally {
      remove.mockRestore();
    }

    const journalPath = path.join(destination, ".formaspec-restore-journal", "journal.json");
    expect(JSON.parse(await fs.promises.readFile(journalPath, "utf8"))).toMatchObject({ phase: "committed" });
    await restoreVerifiedBackup(bundle, destination, {
      databaseClosed: true,
      healthCheck: async () => { healthChecks += 1; },
    });
    expect(healthChecks).toBe(2);
    expect(fs.existsSync(path.dirname(journalPath))).toBe(false);
  });

  it("retains a committed journal when private source cleanup fails", async () => {
    const root = await temporaryDirectory();
    const bundle = await createVerifiedBundle(root);
    const destination = path.join(root, "source-cleanup-retry");
    const pinDirectory = path.join(root, "pins");
    await fs.promises.mkdir(destination);
    await fs.promises.mkdir(pinDirectory);
    let injected = false;
    let healthChecks = 0;
    const originalRemove = fs.promises.rm.bind(fs.promises);
    const remove = vi.spyOn(fs.promises, "rm").mockImplementation(async (target, options) => {
      const filename = String(target);
      if (!injected && path.basename(filename).startsWith(".formaspec-restore-source-")) {
        injected = true;
        throw new Error("injected pinned-source cleanup interruption");
      }
      return originalRemove(target, options);
    });
    try {
      await expect(restoreVerifiedBackup(bundle, destination, {
        databaseClosed: true,
        sourcePinDirectory: pinDirectory,
        healthCheck: async () => { healthChecks += 1; },
      })).rejects.toThrow(/pinned-source cleanup interruption/);
    } finally {
      remove.mockRestore();
    }

    const journalPath = path.join(destination, ".formaspec-restore-journal", "journal.json");
    expect(JSON.parse(await fs.promises.readFile(journalPath, "utf8"))).toMatchObject({ phase: "committed" });
    await restoreVerifiedBackup(bundle, destination, {
      databaseClosed: true,
      sourcePinDirectory: pinDirectory,
      healthCheck: async () => { healthChecks += 1; },
    });
    expect(healthChecks).toBe(2);
    expect(fs.existsSync(path.dirname(journalPath))).toBe(false);
    expect((await fs.promises.readdir(pinDirectory)).filter((entry) => entry.startsWith(".formaspec-restore-source-")))
      .toEqual([]);
  });

  it("rejects archive path traversal", async () => {
    const root = await temporaryDirectory();
    const bundle = path.join(root, "malicious.tar");
    const pack = tar.pack();
    const writing = pipeline(pack, fs.createWriteStream(bundle));
    pack.entry({ name: "../escaped.txt" }, "not allowed");
    pack.finalize();
    await writing;
    await expect(verifyBackupBundle(bundle)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(fs.existsSync(path.join(root, "escaped.txt"))).toBe(false);
  });

  it("rejects oversized and symbolic restore journals without reading their targets", async () => {
    const root = await temporaryDirectory();
    const data = path.join(root, "journal-data");
    const journalRoot = path.join(data, ".formaspec-restore-journal");
    await fs.promises.mkdir(journalRoot, { recursive: true });
    const journalPath = path.join(journalRoot, "journal.json");
    await fs.promises.writeFile(journalPath, "x".repeat(RESTORE_JOURNAL_MAX_BYTES + 1));
    await expect(inspectRestoreJournal(data)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    if (process.platform !== "win32") {
      const outside = path.join(root, "outside-journal.json");
      await fs.promises.writeFile(outside, JSON.stringify({ secret: "must-not-be-read" }));
      await fs.promises.rm(journalPath);
      await fs.promises.symlink(outside, journalPath);
      await expect(inspectRestoreJournal(data)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    }
  });
});
