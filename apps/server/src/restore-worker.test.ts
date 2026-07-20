import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { BackupManager } from "./backup.js";
import { DesignerDatabase } from "./db/database.js";
import { DomainError } from "./errors.js";
import { EventHub } from "./events.js";
import { MaintenanceStore } from "./maintenance.js";
import {
  DEFAULT_MAX_ASSET_BYTES,
  DEFAULT_RENDER_MAX_PIXELS,
} from "./renderer-contract.js";
import {
  loadRestorePreflightConfig,
  loadRestoreWorkerConfig,
  restoreCapacityForecast,
  runRestorePreflight,
  runRestoreWorker,
  type RestoreWorkerConfig,
  type RestoreWorkerRenderer,
} from "./restore-worker.js";
import { RestoreWorkerLockStore } from "./restore-worker-lock.js";
import { RestoreOperationStore } from "./restore-operation-store.js";
import { DesignerService } from "./service.js";

const temporaryDirectories: string[] = [];
const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=",
  "base64",
);

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.promises.rm(directory, { recursive: true, force: true })));
});

interface RestoreFixture {
  root: string;
  dataDirectory: string;
  backupDirectory: string;
  databasePath: string;
  operationId: string;
  targetBackupId: string;
  targetBundlePath: string;
  retainedDesignId: string;
  postBackupDesignId: string;
  maxAuditEventId: number;
  maxOutboxEventId: number;
  config: RestoreWorkerConfig;
}

class FakeRenderer implements RestoreWorkerRenderer {
  healthCalls = 0;
  renderCalls = 0;
  normalizeCalls = 0;
  closeCalls = 0;

  constructor(private readonly renderFailure?: DomainError) {}

  async health() {
    this.healthCalls += 1;
    return {
      ok: true as const,
      mode: "worker" as const,
      renderer: "playwright" as const,
      softwareFallback: false,
      warnings: [],
    };
  }

  async render() {
    this.renderCalls += 1;
    if (this.renderFailure) throw this.renderFailure;
    return {
      png: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      width: 390,
      height: 844,
      renderer: "playwright" as const,
      warnings: [],
    };
  }

  async normalizeRaster() {
    this.normalizeCalls += 1;
    return {
      data: onePixelPng,
      mimeType: "image/png" as const,
      width: 1,
      height: 1,
    };
  }

  async close() {
    this.closeCalls += 1;
  }
}

function maximumId(database: DesignerDatabase, table: "audit_events" | "event_outbox"): number {
  return (database.sqlite.prepare(`SELECT MAX(id) AS id FROM ${table}`).get() as { id: number | null }).id ?? 0;
}

async function relativeEntries(root: string, directory = root): Promise<string[]> {
  const entries = await fs.promises.readdir(directory, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute);
    result.push(`${entry.isDirectory() ? "d" : entry.isSymbolicLink() ? "l" : "f"}:${relative}`);
    if (entry.isDirectory()) result.push(...await relativeEntries(root, absolute));
  }
  return result.sort();
}

function installActiveAgent(database: DesignerDatabase): void {
  const now = "2026-07-20T00:00:00.000Z";
  database.sqlite.prepare(
    `INSERT INTO principals (id, organization_id, kind, display_name, external_id, created_at)
     VALUES ('principal_restore_agent', 'organization_legacy', 'agent', 'Restore agent', 'restore-agent', ?)`,
  ).run(now);
  database.sqlite.prepare(
    `INSERT INTO memberships (organization_id, principal_id, role, created_at)
     VALUES ('organization_legacy', 'principal_restore_agent', 'agent', ?)`,
  ).run(now);
  database.sqlite.prepare(
    `INSERT INTO agent_connections
     (id, organization_id, principal_id, adapter, display_name, status, scopes_json, project_ids_json,
      expires_at, created_at, updated_at)
     VALUES ('connection_restore_agent', 'organization_legacy', 'principal_restore_agent', 'codex',
             'Restore agent', 'active', '["design:read"]', '[]', '2099-01-01T00:00:00.000Z', ?, ?)`,
  ).run(now, now);
  database.sqlite.prepare(
    `INSERT INTO agent_grants
     (id, organization_id, principal_id, token_hash, scopes_json, project_ids_json, created_at, expires_at)
     VALUES ('grant_restore_agent', 'organization_legacy', 'principal_restore_agent', ?, '["design:read"]', '[]', ?,
             '2099-01-01T00:00:00.000Z')`,
  ).run(createHash("sha256").update("restore-agent-token").digest("hex"), now);
  database.sqlite.prepare(
    `INSERT INTO pairing_nonces (nonce_hash, connection_id, created_by, expires_at, consumed_at, created_at, revoked_at)
     VALUES (?, 'connection_restore_agent', 'principal_local', '2099-01-01T00:00:00.000Z', NULL, ?, NULL)`,
  ).run(createHash("sha256").update("restore-pairing-nonce").digest("hex"), now);
}

async function createRestoreFixture(
  label: string,
  beforeTargetBackup?: (database: DesignerDatabase) => void,
): Promise<RestoreFixture> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `formaspec-restore-worker-${label}-`));
  temporaryDirectories.push(root);
  const dataDirectory = path.join(root, "data");
  const backupDirectory = path.join(root, "backups");
  const databasePath = path.join(dataDirectory, "designer.sqlite");
  const operationId = `restore_${createHash("sha256").update(label).digest("hex").slice(0, 24)}`;
  const database = new DesignerDatabase(databasePath);
  const service = new DesignerService(database, new EventHub(), 900);
  const retained = service.createDesign("local", {
    name: "Retained target design",
    preset: "phone",
    idempotencyKey: `restore-retained-${label}-0001`,
  });
  installActiveAgent(database);
  beforeTargetBackup?.(database);

  const target = await new BackupManager(database, dataDirectory, backupDirectory).create();
  const filename = path.basename(target.path);
  const bytes = await fs.promises.readFile(target.path);
  const bundleSha256 = createHash("sha256").update(bytes).digest("hex");
  const targetBackupId = `backup_${createHash("sha256").update(`${filename}\0${bundleSha256}`).digest("hex").slice(0, 40)}`;
  const verifiedAt = "2026-07-20T00:01:00.000Z";
  database.sqlite.prepare(
    `INSERT INTO backup_records
     (id, organization_id, filename, bundle_sha256, status, manifest_json, created_by, created_at, verified_at,
      size_bytes, verification_json, retention_class, completed_at)
     VALUES (?, 'organization_legacy', ?, ?, 'valid', ?, 'principal_local', ?, ?, ?, ?, 'manual', ?)`,
  ).run(
    targetBackupId,
    filename,
    bundleSha256,
    JSON.stringify(target.verification.manifest),
    target.verification.manifest.createdAt,
    verifiedAt,
    bytes.length,
    JSON.stringify(target.verification),
    verifiedAt,
  );

  const postBackup = service.createDesign("local", {
    name: "Post-backup design",
    preset: "web",
    idempotencyKey: `restore-post-${label}-0001`,
  });
  const maxAuditEventId = maximumId(database, "audit_events");
  const maxOutboxEventId = maximumId(database, "event_outbox");
  database.sqlite.prepare("UPDATE sqlite_sequence SET seq = 500 WHERE name = 'audit_events'").run();
  database.sqlite.prepare("UPDATE sqlite_sequence SET seq = 700 WHERE name = 'event_outbox'").run();
  database.sqlite.pragma("wal_checkpoint(TRUNCATE)");
  database.close();

  const maintenance = new MaintenanceStore(backupDirectory, dataDirectory);
  await maintenance.write({
    schemaVersion: 1,
    active: true,
    phase: "restore",
    operationId,
    startedAt: "2026-07-20T00:02:00.000Z",
  });
  return {
    root,
    dataDirectory,
    backupDirectory,
    databasePath,
    operationId,
    targetBackupId,
    targetBundlePath: target.path,
    retainedDesignId: retained.document.id,
    postBackupDesignId: postBackup.document.id,
    maxAuditEventId,
    maxOutboxEventId,
    config: {
      dataDirectory,
      backupDirectory,
      databasePath,
      backupId: targetBackupId,
      operationId,
      renderTimeoutMs: 5_000,
      maxAssetBytes: 2 * 1024 * 1024,
      maxAssetPixels: 4_000_000,
      renderMaxPixels: 4_000_000,
      renderIpcMaxBytes: 2 * 1024 * 1024,
      allowSystemChrome: false,
      nodeEnvironment: "test",
    },
  };
}

describe("one-shot restore worker", () => {
  it("forecasts the complete safety-backup, pin, verification, and candidate capacity peak", () => {
    const reserve = 64 * 1024 * 1024;
    expect(restoreCapacityForecast({
      currentDataBytes: 100,
      targetBundleBytes: 80,
      targetExpandedBytes: 120,
    })).toEqual({
      backupRequiredBytes: reserve + 340,
      dataRequiredBytes: reserve + 120,
      sharedRequiredBytes: reserve + 340,
    });
    expect(() => restoreCapacityForecast({
      currentDataBytes: Number.MAX_SAFE_INTEGER,
      targetBundleBytes: 1,
      targetExpandedBytes: 1,
    })).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });

  it("preflights a managed backup before maintenance using query-only state and leaves no persistent mutation", async () => {
    const fixture = await createRestoreFixture("preflight");
    await new MaintenanceStore(fixture.backupDirectory, fixture.dataDirectory).clear();
    const databaseBefore = createHash("sha256")
      .update(await fs.promises.readFile(fixture.databasePath))
      .digest("hex");
    const backupEntriesBefore = await relativeEntries(fixture.backupDirectory);
    const dataEntriesBefore = (await relativeEntries(fixture.dataDirectory)).filter((entry) => (
      entry !== "f:designer.sqlite-shm" && entry !== "f:designer.sqlite-wal"
    ));

    const result = await runRestorePreflight({
      backupDirectory: fixture.backupDirectory,
      databasePath: fixture.databasePath,
      backupId: fixture.targetBackupId,
    });

    expect(result).toMatchObject({
      status: "verified",
      backupId: fixture.targetBackupId,
      organizationId: "organization_legacy",
      databaseSchemaVersion: 11,
      documentSchemaVersion: 2,
    });
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.entryCount).toBeGreaterThan(0);
    expect(result.extractedBytes).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain(fixture.backupDirectory);
    expect(createHash("sha256")
      .update(await fs.promises.readFile(fixture.databasePath))
      .digest("hex")).toBe(databaseBefore);
    expect(await relativeEntries(fixture.backupDirectory)).toEqual(backupEntriesBefore);
    expect((await relativeEntries(fixture.dataDirectory)).filter((entry) => (
      entry !== "f:designer.sqlite-shm" && entry !== "f:designer.sqlite-wal"
    ))).toEqual(dataEntriesBefore);
    await expect(new MaintenanceStore(fixture.backupDirectory, fixture.dataDirectory).read())
      .resolves.toEqual({ active: false, markerValid: true });
    await expect(new RestoreOperationStore(fixture.backupDirectory).read()).resolves.toBeNull();
    await expect(new RestoreWorkerLockStore(fixture.backupDirectory).read())
      .resolves.toEqual({ active: false, lockValid: true });
  });

  it("uses the isolated raster worker to fully decode backup assets during preflight", async () => {
    const fixture = await createRestoreFixture("preflight-raster-decode", (database) => {
      database.sqlite.prepare(
        `INSERT INTO assets
         (id, actor_id, design_id, filename, mime_type, size_bytes, width, height, sha256, data, created_at,
          organization_id)
         VALUES ('asset_restorepreflight0001', 'local', NULL, 'legacy.png', 'image/png', ?, 1, 1, ?, ?,
                 '2026-07-20T00:00:00.000Z', 'organization_legacy')`,
      ).run(
        onePixelPng.length,
        createHash("sha256").update(onePixelPng).digest("hex"),
        onePixelPng,
      );
    });
    await new MaintenanceStore(fixture.backupDirectory, fixture.dataDirectory).clear();
    const renderer = new FakeRenderer();

    await expect(runRestorePreflight({
      backupDirectory: fixture.backupDirectory,
      databasePath: fixture.databasePath,
      backupId: fixture.targetBackupId,
      maxAssetBytes: 2 * 1024 * 1024,
      maxAssetPixels: 4_000_000,
      requireRasterVerifier: true,
    }, { renderer })).resolves.toMatchObject({ status: "verified" });

    expect(renderer.normalizeCalls).toBe(1);
    expect(renderer.closeCalls).toBe(0);
  });

  it("keeps full raster decode enabled for target, safety-backup, and restore verification", async () => {
    const fixture = await createRestoreFixture("worker-raster-decode", (database) => {
      database.sqlite.prepare(
        `INSERT INTO assets
         (id, actor_id, design_id, filename, mime_type, size_bytes, width, height, sha256, data, created_at,
          organization_id)
         VALUES ('asset_restoreworker000001', 'local', NULL, 'legacy.png', 'image/png', ?, 1, 1, ?, ?,
                 '2026-07-20T00:00:00.000Z', 'organization_legacy')`,
      ).run(
        onePixelPng.length,
        createHash("sha256").update(onePixelPng).digest("hex"),
        onePixelPng,
      );
    });
    const renderer = new FakeRenderer();

    await expect(runRestoreWorker(fixture.config, { renderer }))
      .resolves.toMatchObject({ status: "restored", backupId: fixture.targetBackupId });

    expect(renderer.normalizeCalls).toBeGreaterThanOrEqual(3);
    expect(renderer.closeCalls).toBe(1);
  });

  it("rejects a restore before maintenance when the whole-workflow capacity forecast cannot fit", async () => {
    const fixture = await createRestoreFixture("preflight-capacity");
    await new MaintenanceStore(fixture.backupDirectory, fixture.dataDirectory).clear();
    const originalStatfs = fs.promises.statfs.bind(fs.promises);
    let calls = 0;
    const statfs = vi.spyOn(fs.promises, "statfs").mockImplementation(async (...args) => {
      calls += 1;
      if (calls <= 2) return originalStatfs(...args as [fs.PathLike, { bigint: true }]);
      return {
        type: 0n,
        bsize: 1n,
        blocks: 1n,
        bfree: 1n,
        bavail: 1n,
        files: 1n,
        ffree: 1n,
      } as never;
    });
    try {
      await expect(runRestorePreflight({
        backupDirectory: fixture.backupDirectory,
        databasePath: fixture.databasePath,
        backupId: fixture.targetBackupId,
      })).rejects.toMatchObject({
        code: "TEMPORARILY_UNAVAILABLE",
        statusCode: 507,
      });
    } finally {
      statfs.mockRestore();
    }
    await expect(new MaintenanceStore(fixture.backupDirectory, fixture.dataDirectory).read())
      .resolves.toEqual({ active: false, markerValid: true });
    await expect(new RestoreOperationStore(fixture.backupDirectory).read()).resolves.toBeNull();
  });

  it("rejects a tampered managed backup during preflight without creating restore state", async () => {
    const fixture = await createRestoreFixture("preflight-tamper");
    await new MaintenanceStore(fixture.backupDirectory, fixture.dataDirectory).clear();
    await fs.promises.appendFile(fixture.targetBundlePath, "tampered");

    await expect(runRestorePreflight({
      backupDirectory: fixture.backupDirectory,
      databasePath: fixture.databasePath,
      backupId: fixture.targetBackupId,
    })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(new MaintenanceStore(fixture.backupDirectory, fixture.dataDirectory).read())
      .resolves.toEqual({ active: false, markerValid: true });
    await expect(new RestoreOperationStore(fixture.backupDirectory).read()).resolves.toBeNull();
  });

  it("loads the preflight CLI without requiring an operation ID", () => {
    expect(loadRestorePreflightConfig({
      DATA_DIR: "/srv/formaspec/data",
      BACKUP_DIR: "/srv/formaspec/backups",
    }, ["--backup-id", `backup_${"a".repeat(40)}`])).toMatchObject({
      backupDirectory: "/srv/formaspec/backups",
      databasePath: "/srv/formaspec/data/designer.sqlite",
      backupId: `backup_${"a".repeat(40)}`,
      maxAssetBytes: DEFAULT_MAX_ASSET_BYTES,
      maxAssetPixels: DEFAULT_RENDER_MAX_PIXELS,
      renderMaxPixels: DEFAULT_RENDER_MAX_PIXELS,
      requireRasterVerifier: true,
    });
  });

  it("accepts a Windows named pipe for native restore-worker rendering", () => {
    const backupId = `backup_${"a".repeat(40)}`;
    const operationId = "restore_windows_native_renderer";
    const renderSocket = String.raw`\\.\pipe\formaspec-renderer-user`;
    expect(loadRestoreWorkerConfig({
      DATA_DIR: "C:\\FormaSpec\\data",
      BACKUP_DIR: "C:\\FormaSpec\\backups",
      DESIGNER_DATABASE_PATH: path.resolve("C:\\FormaSpec\\data", "designer.sqlite"),
      FORMASPEC_RENDER_SOCKET: renderSocket,
      NODE_ENV: "production",
    }, ["--backup-id", backupId, "--operation-id", operationId], "win32")).toMatchObject({
      backupId,
      operationId,
      renderSocket,
      nodeEnvironment: "production",
    });
  });

  it("rejects a concurrent worker before either worker can open or mutate the database", async () => {
    const fixture = await createRestoreFixture("exclusive-lock");
    const databaseBefore = createHash("sha256")
      .update(await fs.promises.readFile(fixture.databasePath))
      .digest("hex");
    let announceLock!: () => void;
    const lockAcquired = new Promise<void>((resolve) => {
      announceLock = resolve;
    });
    let releaseFirst!: () => void;
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = runRestoreWorker(fixture.config, {
      afterLockAcquired: async () => {
        announceLock();
        await holdFirst;
        throw new Error("stop after lock-only concurrency check");
      },
    });
    await lockAcquired;

    let secondEntered = false;
    await expect(runRestoreWorker(fixture.config, {
      afterLockAcquired: () => {
        secondEntered = true;
      },
    })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(secondEntered).toBe(false);
    expect(createHash("sha256")
      .update(await fs.promises.readFile(fixture.databasePath))
      .digest("hex")).toBe(databaseBefore);

    releaseFirst();
    await expect(first).rejects.toThrow("stop after lock-only concurrency check");
    await expect(new RestoreWorkerLockStore(fixture.backupDirectory).read())
      .resolves.toEqual({ active: false, lockValid: true });
  });

  it("cleans only exact crash-work directories while holding the restore lock", async () => {
    const fixture = await createRestoreFixture("orphan-cleanup");
    const abandoned = [
      ".formaspec-restore-source-00000000-0000-4000-8000-000000000001",
      ".verify-00000000-0000-4000-8000-000000000002",
      ".staging-00000000-0000-4000-8000-000000000003",
      ".formaspec-orphan-cleanup-00000000-0000-4000-8000-000000000004",
    ];
    for (const name of abandoned) {
      const directory = path.join(fixture.backupDirectory, name);
      await fs.promises.mkdir(directory);
      await fs.promises.writeFile(path.join(directory, "leftover"), "crash residue");
    }
    const nearMatch = path.join(fixture.backupDirectory, ".verify-operator-owned");
    await fs.promises.mkdir(nearMatch);

    await expect(runRestoreWorker(fixture.config, {
      renderer: new FakeRenderer(),
      now: () => new Date("2026-07-20T00:02:30.000Z"),
    })).resolves.toMatchObject({ status: "restored" });
    for (const name of abandoned) expect(fs.existsSync(path.join(fixture.backupDirectory, name))).toBe(false);
    expect(fs.existsSync(nearMatch)).toBe(true);
  });

  it("refuses to follow an exact-prefix orphan symlink", async () => {
    if (process.platform === "win32") return;
    const fixture = await createRestoreFixture("orphan-symlink");
    const outside = path.join(fixture.root, "outside-orphan-target");
    await fs.promises.mkdir(outside);
    await fs.promises.writeFile(path.join(outside, "preserve.txt"), "must survive");
    await fs.promises.symlink(
      outside,
      path.join(fixture.backupDirectory, ".verify-00000000-0000-4000-8000-000000000005"),
    );

    await expect(runRestoreWorker(fixture.config, { renderer: new FakeRenderer() })).rejects.toMatchObject({
      code: "TEMPORARILY_UNAVAILABLE",
    });
    expect(await fs.promises.readFile(path.join(outside, "preserve.txt"), "utf8")).toBe("must survive");
    await expect(new RestoreOperationStore(fixture.backupDirectory).read()).resolves.toBeNull();
  });

  it("restores, reconciles manual backups, revokes agent access, and preserves monotonic audit IDs", async () => {
    const fixture = await createRestoreFixture("success");
    const renderer = new FakeRenderer();
    const result = await runRestoreWorker(fixture.config, {
      renderer,
      now: () => new Date("2026-07-20T00:03:00.000Z"),
    });

    expect(result).toMatchObject({
      status: "restored",
      backupId: fixture.targetBackupId,
      operationId: fixture.operationId,
      schemaVersion: 11,
      renderedDesignId: fixture.retainedDesignId,
      revoked: { grants: 1, connections: 1, nonces: 1 },
      maintenancePhase: "verification",
    });
    expect(result.safetyBackupId).toMatch(/^backup_[a-f0-9]{40}$/);
    expect(result.safetyBackupId).not.toBe(fixture.targetBackupId);
    expect(result.auditEventId).toBeGreaterThan(fixture.maxAuditEventId);
    expect(result.outboxEventId).toBeGreaterThan(fixture.maxOutboxEventId);
    expect(result.auditEventId).toBeGreaterThan(500);
    expect(result.outboxEventId).toBeGreaterThan(700);
    expect(renderer).toMatchObject({ healthCalls: 1, renderCalls: 1, closeCalls: 1 });

    const restored = new DesignerDatabase(fixture.databasePath);
    try {
      expect(restored.sqlite.prepare("SELECT id FROM designs ORDER BY id").all()).toEqual([
        { id: fixture.retainedDesignId },
      ]);
      expect(restored.sqlite.prepare("SELECT id FROM designs WHERE id = ?").get(fixture.postBackupDesignId)).toBeUndefined();
      expect(restored.sqlite.prepare(
        "SELECT status, retention_class FROM backup_records WHERE id = ?",
      ).get(fixture.targetBackupId)).toEqual({ status: "restored", retention_class: "manual" });
      expect(restored.sqlite.prepare(
        "SELECT status, retention_class FROM backup_records WHERE id = ?",
      ).get(result.safetyBackupId)).toEqual({ status: "valid", retention_class: "manual" });
      expect(restored.sqlite.prepare(
        "SELECT revoked_at FROM agent_grants WHERE id = 'grant_restore_agent'",
      ).get()).toMatchObject({ revoked_at: "2026-07-20T00:03:00.000Z" });
      expect(restored.sqlite.prepare(
        "SELECT status FROM agent_connections WHERE id = 'connection_restore_agent'",
      ).get()).toEqual({ status: "revoked" });
      expect(restored.sqlite.prepare(
        "SELECT revoked_at FROM pairing_nonces WHERE connection_id = 'connection_restore_agent'",
      ).get()).toMatchObject({ revoked_at: "2026-07-20T00:03:00.000Z" });
      expect(restored.sqlite.prepare(
        "SELECT action, target_id FROM audit_events WHERE id = ?",
      ).get(result.auditEventId)).toEqual({ action: "backup.restore_commit", target_id: fixture.targetBackupId });
      const outbox = restored.sqlite.prepare(
        "SELECT event_type, payload_json FROM event_outbox WHERE id = ?",
      ).get(result.outboxEventId) as { event_type: string; payload_json: string };
      expect(outbox.event_type).toBe("backup.operation");
      expect(JSON.parse(outbox.payload_json)).toMatchObject({
        action: "backup.restore_commit",
        targetId: fixture.targetBackupId,
        details: {
          operationId: fixture.operationId,
          targetBackupId: fixture.targetBackupId,
          safetyBackupId: result.safetyBackupId,
          schemaVersion: 11,
          revokedGrants: 1,
          revokedConnections: 1,
          revokedNonces: 1,
        },
      });
    } finally {
      restored.close();
    }
    expect(fs.existsSync(fixture.targetBundlePath)).toBe(true);
    expect(fs.existsSync(path.join(fixture.dataDirectory, ".formaspec-restore-journal"))).toBe(false);
    expect((await fs.promises.readdir(fixture.backupDirectory))
      .filter((entry) => entry.startsWith(".formaspec-restore-source-"))).toEqual([]);
    await expect(new MaintenanceStore(fixture.backupDirectory, fixture.dataDirectory).read()).resolves.toMatchObject({
      active: true,
      markerValid: true,
      phase: "verification",
      operationId: fixture.operationId,
    });
  });

  it("fails closed if a restored audit trigger reactivates credentials during reconciliation", async () => {
    const fixture = await createRestoreFixture("revocation-trigger", (database) => {
      database.sqlite.exec(`
        CREATE TRIGGER reactivate_restore_agent_after_outbox
        AFTER INSERT ON event_outbox
        WHEN NEW.event_type = 'backup.operation'
          AND json_extract(NEW.payload_json, '$.action') = 'backup.restore_commit'
        BEGIN
          UPDATE agent_grants SET revoked_at = NULL WHERE id = 'grant_restore_agent';
          UPDATE agent_connections SET status = 'active' WHERE id = 'connection_restore_agent';
          UPDATE pairing_nonces SET revoked_at = NULL WHERE connection_id = 'connection_restore_agent';
        END;
      `);
    });

    await expect(runRestoreWorker(fixture.config, {
      renderer: new FakeRenderer(),
      now: () => new Date("2026-07-20T00:03:30.000Z"),
    })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: "Restored agent access could not be revoked completely; reconciliation was rolled back.",
    });

    const original = new DesignerDatabase(fixture.databasePath);
    try {
      expect(original.sqlite.prepare("SELECT id FROM designs WHERE id = ?").get(fixture.retainedDesignId))
        .toEqual({ id: fixture.retainedDesignId });
      expect(original.sqlite.prepare("SELECT id FROM designs WHERE id = ?").get(fixture.postBackupDesignId))
        .toBeUndefined();
      expect(original.sqlite.prepare(
        "SELECT revoked_at FROM agent_grants WHERE id = 'grant_restore_agent'",
      ).get()).toEqual({ revoked_at: null });
      expect(original.sqlite.prepare(
        "SELECT status FROM agent_connections WHERE id = 'connection_restore_agent'",
      ).get()).toEqual({ status: "active" });
      expect(original.sqlite.prepare(
        "SELECT revoked_at FROM pairing_nonces WHERE connection_id = 'connection_restore_agent'",
      ).get()).toEqual({ revoked_at: null });
      expect((original.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'backup.restore_commit'",
      ).get() as { count: number }).count).toBe(0);
    } finally {
      original.close();
    }
    await expect(new RestoreOperationStore(fixture.backupDirectory).read()).resolves.toMatchObject({
      phase: "cutover_committed",
      operationId: fixture.operationId,
    });
    await expect(new MaintenanceStore(fixture.backupDirectory, fixture.dataDirectory).read()).resolves.toMatchObject({
      active: true,
      phase: "verification",
      operationId: fixture.operationId,
    });
  });

  it("audits a proven rollback, preserves the original database, and leaves maintenance active", async () => {
    const fixture = await createRestoreFixture("rollback");
    const renderer = new FakeRenderer(new DomainError("RENDER_FAILED", "Injected representative render failure.", 503));
    await expect(runRestoreWorker(fixture.config, {
      renderer,
      now: () => new Date("2026-07-20T00:04:00.000Z"),
    })).rejects.toMatchObject({ code: "RENDER_FAILED" });
    expect(renderer).toMatchObject({ healthCalls: 1, renderCalls: 1, closeCalls: 1 });

    const original = new DesignerDatabase(fixture.databasePath);
    let safetyBackupId: string;
    try {
      expect(original.sqlite.prepare("SELECT id FROM designs WHERE id = ?").get(fixture.postBackupDesignId))
        .toEqual({ id: fixture.postBackupDesignId });
      const rollbackAudit = original.sqlite.prepare(
        `SELECT target_id, details_json FROM audit_events
         WHERE action = 'backup.restore_rolled_back' ORDER BY id DESC LIMIT 1`,
      ).get() as { target_id: string; details_json: string };
      expect(rollbackAudit.target_id).toBe(fixture.targetBackupId);
      const details = JSON.parse(rollbackAudit.details_json) as { safetyBackupId: string; errorCode: string };
      safetyBackupId = details.safetyBackupId;
      expect(details.errorCode).toBe("RENDER_FAILED");
      expect(original.sqlite.prepare(
        "SELECT status, retention_class FROM backup_records WHERE id = ?",
      ).get(safetyBackupId)).toEqual({ status: "valid", retention_class: "manual" });
      expect(original.sqlite.prepare(
        "SELECT status FROM backup_records WHERE id = ?",
      ).get(fixture.targetBackupId)).toEqual({ status: "valid" });
      expect(original.sqlite.prepare(
        "SELECT revoked_at FROM agent_grants WHERE id = 'grant_restore_agent'",
      ).get()).toEqual({ revoked_at: null });
      expect(original.sqlite.prepare(
        "SELECT status FROM agent_connections WHERE id = 'connection_restore_agent'",
      ).get()).toEqual({ status: "active" });
      const rollbackEvent = original.sqlite.prepare(
        `SELECT payload_json FROM event_outbox
         WHERE event_type = 'backup.operation'
           AND json_extract(payload_json, '$.action') = 'backup.restore_rolled_back'
         ORDER BY id DESC LIMIT 1`,
      ).get() as { payload_json: string };
      expect(JSON.parse(rollbackEvent.payload_json)).toMatchObject({
        details: {
          operationId: fixture.operationId,
          targetBackupId: fixture.targetBackupId,
          safetyBackupId,
          errorCode: "RENDER_FAILED",
        },
      });
    } finally {
      original.close();
    }
    expect(fs.existsSync(path.join(fixture.dataDirectory, ".formaspec-restore-journal", "journal.json"))).toBe(true);
    await expect(new MaintenanceStore(fixture.backupDirectory, fixture.dataDirectory).read()).resolves.toMatchObject({
      active: true,
      markerValid: true,
      phase: "rollback",
      operationId: fixture.operationId,
    });
  });

  it("resumes reconciliation after a post-cutover crash without creating another safety backup", async () => {
    const fixture = await createRestoreFixture("crash-resume");
    const firstRenderer = new FakeRenderer();
    await expect(runRestoreWorker(fixture.config, {
      renderer: firstRenderer,
      now: () => new Date("2026-07-20T00:05:00.000Z"),
      afterCutover: () => {
        throw new Error("simulated process death after cutover");
      },
    })).rejects.toThrow(/simulated process death/);
    expect(firstRenderer).toMatchObject({ healthCalls: 1, renderCalls: 1, closeCalls: 1 });

    const statePath = path.join(fixture.backupDirectory, ".formaspec", "restore-operation.json");
    const cutoverState = JSON.parse(await fs.promises.readFile(statePath, "utf8")) as {
      phase: string;
      operationId: string;
      target: { filename: string };
      safety: { id: string; filename: string };
    };
    expect(cutoverState).toMatchObject({
      phase: "cutover_committed",
      operationId: fixture.operationId,
      target: { filename: path.basename(fixture.targetBundlePath) },
      safety: { id: expect.stringMatching(/^backup_[a-f0-9]{40}$/) },
    });
    const serializedState = JSON.stringify(cutoverState);
    expect(serializedState).not.toContain(fixture.dataDirectory);
    expect(serializedState).not.toContain(fixture.backupDirectory);
    const bundlesAfterCrash = (await fs.promises.readdir(fixture.backupDirectory))
      .filter((filename) => filename.endsWith(".tar"))
      .sort();
    expect(bundlesAfterCrash).toContain(cutoverState.target.filename);
    expect(bundlesAfterCrash).toContain(cutoverState.safety.filename);
    await fs.promises.unlink(fixture.targetBundlePath);
    const bundlesAfterTargetLoss = bundlesAfterCrash.filter((filename) => filename !== cutoverState.target.filename);

    const beforeReconciliation = new DesignerDatabase(fixture.databasePath);
    try {
      expect(beforeReconciliation.sqlite.prepare(
        "SELECT id FROM backup_records WHERE id = ?",
      ).get(fixture.targetBackupId)).toBeUndefined();
      expect(beforeReconciliation.sqlite.prepare(
        "SELECT status FROM agent_connections WHERE id = 'connection_restore_agent'",
      ).get()).toEqual({ status: "active" });
    } finally {
      beforeReconciliation.close();
    }

    const resumeRenderer = new FakeRenderer();
    const resumed = await runRestoreWorker(fixture.config, {
      renderer: resumeRenderer,
      now: () => new Date("2026-07-20T00:06:00.000Z"),
    });
    expect(resumed).toMatchObject({
      status: "restored",
      safetyBackupId: cutoverState.safety.id,
      revoked: { grants: 1, connections: 1, nonces: 1 },
    });
    expect(resumeRenderer).toMatchObject({ healthCalls: 0, renderCalls: 0, closeCalls: 0 });
    expect((await fs.promises.readdir(fixture.backupDirectory)).filter((filename) => filename.endsWith(".tar")).sort())
      .toEqual(bundlesAfterTargetLoss);

    const reconciledState = JSON.parse(await fs.promises.readFile(statePath, "utf8")) as {
      phase: string;
      result: { auditEventId: number; outboxEventId: number };
    };
    expect(reconciledState).toMatchObject({
      phase: "reconciled",
      result: { auditEventId: resumed.auditEventId, outboxEventId: resumed.outboxEventId },
    });

    const replayRenderer = new FakeRenderer();
    const replayed = await runRestoreWorker(fixture.config, { renderer: replayRenderer });
    expect(replayed).toEqual(resumed);
    expect(replayRenderer).toMatchObject({ healthCalls: 0, renderCalls: 0, closeCalls: 0 });
  });

  it("recovers a prepared operation from a committed journal after the target bundle is lost", async () => {
    const fixture = await createRestoreFixture("prepared-committed-journal");
    const originalRemove = fs.promises.rm.bind(fs.promises);
    let interrupted = false;
    const remove = vi.spyOn(fs.promises, "rm").mockImplementation(async (target, options) => {
      const filename = String(target);
      if (!interrupted && filename.endsWith(`${path.sep}.formaspec-restore-journal${path.sep}candidate`)) {
        interrupted = true;
        throw new Error("injected committed-journal cleanup interruption");
      }
      return originalRemove(target, options);
    });
    try {
      await expect(runRestoreWorker(fixture.config, {
        renderer: new FakeRenderer(),
        now: () => new Date("2026-07-20T00:06:30.000Z"),
      })).rejects.toThrow(/committed-journal cleanup interruption/);
    } finally {
      remove.mockRestore();
    }

    await expect(new RestoreOperationStore(fixture.backupDirectory).read()).resolves.toMatchObject({
      phase: "prepared",
      operationId: fixture.operationId,
    });
    const journalPath = path.join(fixture.dataDirectory, ".formaspec-restore-journal", "journal.json");
    expect(JSON.parse(await fs.promises.readFile(journalPath, "utf8"))).toMatchObject({
      phase: "committed",
    });
    await fs.promises.unlink(fixture.targetBundlePath);

    const resumedRenderer = new FakeRenderer();
    const resumed = await runRestoreWorker(fixture.config, {
      renderer: resumedRenderer,
      now: () => new Date("2026-07-20T00:06:31.000Z"),
    });
    expect(resumed).toMatchObject({
      status: "restored",
      backupId: fixture.targetBackupId,
      revoked: { grants: 1, connections: 1, nonces: 1 },
    });
    expect(resumedRenderer).toMatchObject({ healthCalls: 1, renderCalls: 1, closeCalls: 1 });
    expect(fs.existsSync(journalPath)).toBe(false);
    expect(fs.existsSync(fixture.targetBundlePath)).toBe(false);
  });

  it("reuses the operation safety backup after a crash before external state persistence", async () => {
    const fixture = await createRestoreFixture("safety-resume");
    await expect(runRestoreWorker(fixture.config, {
      renderer: new FakeRenderer(),
      now: () => new Date("2026-07-20T00:07:00.000Z"),
      afterSafetyBackup: () => {
        throw new Error("simulated process death after safety backup");
      },
    })).rejects.toThrow(/simulated process death/);
    const statePath = path.join(fixture.backupDirectory, ".formaspec", "restore-operation.json");
    expect(fs.existsSync(statePath)).toBe(false);
    const bundlesAfterCrash = (await fs.promises.readdir(fixture.backupDirectory))
      .filter((filename) => filename.endsWith(".tar"))
      .sort();
    expect(bundlesAfterCrash).toHaveLength(2);

    const resumed = await runRestoreWorker(fixture.config, {
      renderer: new FakeRenderer(),
      now: () => new Date("2026-07-20T00:08:00.000Z"),
    });
    expect(resumed.status).toBe("restored");
    expect((await fs.promises.readdir(fixture.backupDirectory)).filter((filename) => filename.endsWith(".tar")).sort())
      .toEqual(bundlesAfterCrash);
  });

  it("rejects tampered managed bytes before creating a safety backup or touching the data directory", async () => {
    const fixture = await createRestoreFixture("tamper");
    await fs.promises.appendFile(fixture.targetBundlePath, "tampered");
    const renderer = new FakeRenderer();
    await expect(runRestoreWorker(fixture.config, { renderer })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: "Restore source changed after managed verification.",
    });
    expect(renderer).toMatchObject({ healthCalls: 0, renderCalls: 0, closeCalls: 0 });

    const database = new DesignerDatabase(fixture.databasePath);
    try {
      expect(database.sqlite.prepare("SELECT id FROM designs WHERE id = ?").get(fixture.postBackupDesignId))
        .toEqual({ id: fixture.postBackupDesignId });
      expect((database.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM backup_records WHERE id <> ?",
      ).get(fixture.targetBackupId) as { count: number }).count).toBe(0);
      expect((database.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM audit_events WHERE action LIKE 'backup.%restore%'",
      ).get() as { count: number }).count).toBe(0);
    } finally {
      database.close();
    }
    await expect(new MaintenanceStore(fixture.backupDirectory, fixture.dataDirectory).read()).resolves.toMatchObject({
      active: true,
      phase: "restore",
    });
  });

  it("rejects a valid bundle swapped in after managed verification and before cutover", async () => {
    const fixture = await createRestoreFixture("source-swap");
    const renderer = new FakeRenderer();
    await expect(runRestoreWorker(fixture.config, {
      renderer,
      afterSafetyBackup: async () => {
        const safetyFilename = (await fs.promises.readdir(fixture.backupDirectory))
          .find((filename) => filename.endsWith(".tar") && filename !== path.basename(fixture.targetBundlePath));
        if (!safetyFilename) throw new Error("safety backup fixture is missing");
        await fs.promises.copyFile(
          path.join(fixture.backupDirectory, safetyFilename),
          fixture.targetBundlePath,
        );
      },
    })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: "Restore source changed after managed verification.",
    });
    expect(renderer).toMatchObject({ healthCalls: 0, renderCalls: 0, closeCalls: 1 });

    const database = new DesignerDatabase(fixture.databasePath);
    try {
      expect(database.sqlite.prepare("SELECT id FROM designs WHERE id = ?").get(fixture.postBackupDesignId))
        .toEqual({ id: fixture.postBackupDesignId });
    } finally {
      database.close();
    }
    expect(fs.existsSync(path.join(fixture.dataDirectory, ".formaspec-restore-journal"))).toBe(false);
    await expect(new RestoreOperationStore(fixture.backupDirectory).read()).resolves.toMatchObject({
      phase: "prepared",
      operationId: fixture.operationId,
    });

    const preservedSource = path.join(
      fixture.backupDirectory,
      ".formaspec-restore-source-00000000-0000-4000-8000-000000000006",
    );
    await fs.promises.mkdir(preservedSource);
    await fs.promises.writeFile(path.join(preservedSource, "bundle.tar"), "operator recovery evidence");
    await expect(runRestoreWorker(fixture.config, { renderer: new FakeRenderer() })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: "Restore source changed after managed verification.",
    });
    expect(fs.existsSync(preservedSource)).toBe(true);
  });

  it("requires the active maintenance marker to match the requested operation", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "formaspec-restore-worker-marker-"));
    temporaryDirectories.push(root);
    const dataDirectory = path.join(root, "data");
    const backupDirectory = path.join(root, "backups");
    const maintenance = new MaintenanceStore(backupDirectory, dataDirectory);
    await maintenance.write({
      schemaVersion: 1,
      active: true,
      phase: "restore",
      operationId: "restore_aaaaaaaaaaaaaaaa",
      startedAt: "2026-07-20T00:00:00.000Z",
    });
    const renderer = new FakeRenderer();
    await expect(runRestoreWorker({
      dataDirectory,
      backupDirectory,
      databasePath: path.join(dataDirectory, "designer.sqlite"),
      backupId: `backup_${"a".repeat(40)}`,
      operationId: "restore_bbbbbbbbbbbbbbbb",
      renderTimeoutMs: 5_000,
      maxAssetBytes: 2 * 1024 * 1024,
      maxAssetPixels: 4_000_000,
      renderMaxPixels: 4_000_000,
      renderIpcMaxBytes: 2 * 1024 * 1024,
      allowSystemChrome: false,
      nodeEnvironment: "test",
    }, { renderer })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(renderer.closeCalls).toBe(0);
    expect(fs.existsSync(dataDirectory)).toBe(false);
  });

  it("accepts only strict opaque IDs and refuses path or source ambiguity", () => {
    const environment = {
      DATA_DIR: "/tmp/formaspec-restore-worker-config/data",
      BACKUP_DIR: "/tmp/formaspec-restore-worker-config/backups",
      NODE_ENV: "test",
    };
    const backupId = `backup_${"a".repeat(40)}`;
    const operationId = "restore_0123456789abcdef";
    expect(loadRestoreWorkerConfig(environment, [
      "--operation-id", operationId,
      "--backup-id", backupId,
    ])).toMatchObject({ backupId, operationId });
    expect(() => loadRestoreWorkerConfig(environment, ["--backup-id", "/tmp/secret.tar", "--operation-id", operationId]))
      .toThrow();
    expect(() => loadRestoreWorkerConfig(environment, ["--backup-id", backupId, "--data-dir", "/tmp/other"]))
      .toThrow(/accepts only/);
    expect(() => loadRestoreWorkerConfig({
      ...environment,
      FORMASPEC_RESTORE_BACKUP_ID: backupId,
      FORMASPEC_RESTORE_OPERATION_ID: operationId,
    }, ["--backup-id", backupId, "--operation-id", operationId])).toThrow(/either argv or environment/);
    expect(() => loadRestoreWorkerConfig({
      ...environment,
      DESIGNER_DATABASE_PATH: "/tmp/outside.sqlite",
      FORMASPEC_RESTORE_BACKUP_ID: backupId,
      FORMASPEC_RESTORE_OPERATION_ID: operationId,
    }, [])).toThrow(/DATA_DIR\/designer.sqlite/);
  });
});
