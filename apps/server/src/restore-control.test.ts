import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { createForensicRecoveryBundle } from "./backup.js";
import { DesignerDatabase } from "./db/database.js";
import { MaintenanceStore } from "./maintenance.js";
import { loadRestoreControlConfig, runRestoreControl } from "./restore-control.js";
import { RestoreOperationStore, type RestoreOperationState } from "./restore-operation-store.js";
import { RestoreWorkerLockStore } from "./restore-worker-lock.js";

const temporaryDirectories: string[] = [];
const operationId = "restore_0123456789abcdef0123456789abcdef";
const backupId = `backup_${"a".repeat(40)}`;
const safetyBackupId = `backup_${"b".repeat(40)}`;
const timestamp = "2026-07-19T12:00:00.000Z";

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.promises.rm(directory, { recursive: true, force: true })
  )));
});

async function fixture(): Promise<{ dataDirectory: string; backupDirectory: string }> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "formaspec-restore-control-"));
  temporaryDirectories.push(root);
  const dataDirectory = path.join(root, "data");
  const backupDirectory = path.join(root, "backups");
  await Promise.all([
    fs.promises.mkdir(dataDirectory),
    fs.promises.mkdir(backupDirectory),
  ]);
  return { dataDirectory, backupDirectory };
}

function reconciledState(): RestoreOperationState {
  const record = {
    id: backupId,
    organizationId: "organization_legacy",
    filename: "formaspec-backup-20260719T120000Z.tar",
    bundleSha256: "c".repeat(64),
    createdBy: "system:restore-worker",
    createdAt: timestamp,
    sizeBytes: 1234,
    retentionClass: "manual" as const,
  };
  return {
    format: "formaspec-restore-operation",
    version: 1,
    operationId,
    backupId,
    phase: "reconciled",
    target: record,
    safety: {
      ...record,
      id: safetyBackupId,
      filename: "formaspec-backup-20260719T120001Z.tar",
      bundleSha256: "d".repeat(64),
    },
    monotonicFloor: { auditEventId: 7, outboxEventId: 9 },
    smoke: { schemaVersion: 10, renderedDesignId: "design_fixture" },
    result: {
      auditEventId: 8,
      outboxEventId: 10,
      revoked: { grants: 1, connections: 1, nonces: 2 },
    },
    errorCode: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function preparedState(): RestoreOperationState {
  const terminal = reconciledState();
  return {
    ...terminal,
    phase: "prepared",
    smoke: null,
    result: null,
    errorCode: null,
  };
}

function rolledBackState(): RestoreOperationState {
  const terminal = reconciledState();
  return {
    ...terminal,
    phase: "rolled_back",
    smoke: null,
    result: null,
    errorCode: "RENDER_FAILED",
  };
}

describe("external restore control", () => {
  it("sets maintenance idempotently and refuses another owner", async () => {
    const config = await fixture();
    const first = await runRestoreControl(
      ["set", "--operation-id", operationId],
      config,
      () => new Date(timestamp),
    );
    expect(first.maintenance).toEqual({
      active: true,
      markerValid: true,
      phase: "restore",
      operationId,
      startedAt: timestamp,
    });

    const second = await runRestoreControl(
      ["set", "--operation-id", operationId],
      config,
      () => new Date("2026-07-19T13:00:00.000Z"),
    );
    expect(second.maintenance).toEqual(first.maintenance);

    await expect(runRestoreControl(
      ["set", "--operation-id", "restore_ffffffffffffffffffffffffffffffff"],
      config,
    )).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  });

  it("archives terminal state before publishing the next maintenance owner and completes on retry", async () => {
    const config = await fixture();
    const previousOperationId = "restore_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    await new RestoreOperationStore(config.backupDirectory).write({
      ...reconciledState(),
      operationId: previousOperationId,
    });
    const historyPath = path.join(config.backupDirectory, ".formaspec", "restore-history");
    await fs.promises.writeFile(historyPath, "blocks archive directory creation", { mode: 0o600 });

    await expect(runRestoreControl(
      ["set", "--operation-id", operationId],
      config,
      () => new Date(timestamp),
    )).rejects.toBeDefined();
    await expect(new MaintenanceStore(config.backupDirectory, config.dataDirectory).read())
      .resolves.toEqual({ active: false, markerValid: true });
    await expect(new RestoreOperationStore(config.backupDirectory).read())
      .resolves.toMatchObject({ operationId: previousOperationId, phase: "reconciled" });
    await expect(new RestoreWorkerLockStore(config.backupDirectory).read())
      .resolves.toEqual({ active: false, lockValid: true });

    await fs.promises.unlink(historyPath);
    const retried = await runRestoreControl(
      ["set", "--operation-id", operationId],
      config,
      () => new Date("2026-07-20T10:00:00.000Z"),
    );
    expect(retried).toMatchObject({
      maintenance: { active: true, operationId, startedAt: "2026-07-20T10:00:00.000Z" },
      operation: null,
      workerLock: { active: false, lockValid: true },
    });
  });

  it("loads the real one-shot container identity for stale-lock proof", async () => {
    const config = await fixture();
    const loaded = loadRestoreControlConfig({
      DATA_DIR: config.dataDirectory,
      BACKUP_DIR: config.backupDirectory,
      HOSTNAME: "abcdef123456",
    });
    expect(loaded).toEqual({
      ...config,
      databasePath: path.join(config.dataDirectory, "designer.sqlite"),
      containerId: "abcdef123456",
    });
  });

  it("clears maintenance only after a matching durable terminal state", async () => {
    const config = await fixture();
    await runRestoreControl(["set", "--operation-id", operationId], config, () => new Date(timestamp));
    await expect(runRestoreControl(["clear", "--operation-id", operationId], config))
      .rejects.toMatchObject({ code: "VERSION_CONFLICT" });

    await new RestoreOperationStore(config.backupDirectory).write(reconciledState());
    const cleared = await runRestoreControl(["clear", "--operation-id", operationId], config);
    expect(cleared.maintenance).toEqual({ active: false, markerValid: true });
    expect(cleared.operation).toMatchObject({
      operationId,
      backupId,
      safetyBackupId,
      phase: "reconciled",
    });

    const nextOperationId = "restore_ffffffffffffffffffffffffffffffff";
    const next = await runRestoreControl(
      ["set", "--operation-id", nextOperationId],
      config,
      () => new Date("2026-07-19T13:00:00.000Z"),
    );
    expect(next.maintenance).toMatchObject({ active: true, operationId: nextOperationId, phase: "restore" });
    expect(next.operation).toBeNull();
    const history = await fs.promises.readdir(path.join(config.backupDirectory, ".formaspec", "restore-history"));
    expect(history).toHaveLength(1);
    expect(history[0]).toMatch(new RegExp(`^${operationId}-[a-f0-9-]+\\.json$`));
  });

  it("returns bounded status without paths, filenames, or hashes", async () => {
    const config = await fixture();
    await new RestoreOperationStore(config.backupDirectory).write(reconciledState());
    const status = await runRestoreControl(["status"], config);
    const serialized = JSON.stringify(status);
    expect(status.operation).toMatchObject({ backupId, safetyBackupId, phase: "reconciled" });
    expect(serialized).not.toContain("filename");
    expect(serialized).not.toContain("bundleSha256");
    expect(serialized).not.toContain(config.dataDirectory);
    expect(serialized).not.toContain(config.backupDirectory);
  });

  it("reports bounded worker ownership and clears a proven stale lock only by exact operation ID", async () => {
    const config = await fixture();
    const lockStore = new RestoreWorkerLockStore(config.backupDirectory);
    await lockStore.acquire({
      operationId,
      ownerId: `worker_${"a".repeat(32)}`,
      containerId: "restore-container",
      processId: 77,
      acquiredAt: timestamp,
    });

    const status = await runRestoreControl(["status"], config);
    expect(status.workerLock).toEqual({
      active: true,
      lockValid: true,
      operationId,
      ownerId: `worker_${"a".repeat(32)}`,
      containerId: "restore-container",
      processId: 77,
      acquiredAt: timestamp,
    });
    expect(JSON.stringify(status)).not.toContain(config.backupDirectory);

    await expect(runRestoreControl(
      ["clear-stale-lock", "--operation-id", "restore_ffffffffffffffffffffffffffffffff"],
      config,
    )).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    await expect(lockStore.read()).resolves.toMatchObject({ active: true, operationId });

    const cleared = await runRestoreControl(
      ["clear-stale-lock", "--operation-id", operationId],
      config,
    );
    expect(cleared.workerLock).toEqual({ active: false, lockValid: true });
  });

  it("aborts only a pristine matching pre-cutover maintenance state", async () => {
    const config = await fixture();
    const database = new DesignerDatabase(path.join(config.dataDirectory, "designer.sqlite"));
    database.close();
    await runRestoreControl(["set", "--operation-id", operationId], config, () => new Date(timestamp));

    const aborted = await runRestoreControl(["abort", "--operation-id", operationId], config);
    expect(aborted).toMatchObject({
      maintenance: { active: false, markerValid: true },
      operation: null,
      workerLock: { active: false, lockValid: true },
    });
  });

  it("does not clear pristine restore maintenance when the live database cannot be verified", async () => {
    const config = await fixture();
    await fs.promises.writeFile(path.join(config.dataDirectory, "designer.sqlite"), "corrupt-live-database");
    await runRestoreControl(["set", "--operation-id", operationId], config, () => new Date(timestamp));

    await expect(runRestoreControl(["abort", "--operation-id", operationId], config))
      .rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(new MaintenanceStore(config.backupDirectory, config.dataDirectory).read())
      .resolves.toMatchObject({ active: true, operationId });
    await expect(new RestoreOperationStore(config.backupDirectory).read()).resolves.toBeNull();
  });

  it("cancels a prepared restore only after proving the untouched live database and absent journal", async () => {
    const config = await fixture();
    const database = new DesignerDatabase(path.join(config.dataDirectory, "designer.sqlite"));
    database.close();
    await new RestoreOperationStore(config.backupDirectory).write(preparedState());
    await runRestoreControl(["set", "--operation-id", operationId], config, () => new Date(timestamp));

    const aborted = await runRestoreControl(["abort", "--operation-id", operationId], config);
    expect(aborted).toMatchObject({
      maintenance: { active: false, markerValid: true },
      operation: null,
      workerLock: { active: false, lockValid: true },
    });
    expect(fs.existsSync(path.join(config.dataDirectory, "designer.sqlite"))).toBe(true);
    const history = await fs.promises.readdir(path.join(config.backupDirectory, ".formaspec", "restore-history"));
    expect(history).toHaveLength(1);
  });

  it("keeps an offline prepared restore fenced when the unchanged database is corrupt", async () => {
    const config = await fixture();
    const databasePath = path.join(config.dataDirectory, "designer.sqlite");
    await fs.promises.writeFile(databasePath, "corrupt-pre-restore-database");
    const forensic = await createForensicRecoveryBundle(
      config.dataDirectory,
      config.backupDirectory,
      operationId,
    );
    const state = preparedState();
    state.recovery = { mode: "offline", safetyKind: "forensic" };
    state.safety = {
      ...state.safety,
      filename: forensic.filename,
      bundleSha256: forensic.bundleSha256,
      sizeBytes: forensic.sizeBytes,
      createdAt: forensic.createdAt,
    };
    await new RestoreOperationStore(config.backupDirectory).write(state);
    await runRestoreControl(["set", "--operation-id", operationId], config, () => new Date(timestamp));

    await expect(runRestoreControl(["abort", "--operation-id", operationId], config))
      .rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await fs.promises.readFile(databasePath, "utf8")).toBe("corrupt-pre-restore-database");
    await expect(new MaintenanceStore(config.backupDirectory, config.dataDirectory).read())
      .resolves.toMatchObject({ active: true, operationId });
    await expect(new RestoreOperationStore(config.backupDirectory).read())
      .resolves.toMatchObject({ phase: "prepared", operationId });
  });

  it("hands an active forensic-rollback fence directly to a new recovery operation without an unfenced gap", async () => {
    const config = await fixture();
    const nextOperationId = "restore_ffffffffffffffffffffffffffffffff";
    const state = rolledBackState();
    state.recovery = { mode: "offline", safetyKind: "forensic" };
    await new RestoreOperationStore(config.backupDirectory).write(state);
    await new MaintenanceStore(config.backupDirectory, config.dataDirectory).write({
      schemaVersion: 1,
      active: true,
      phase: "rollback",
      operationId,
      startedAt: timestamp,
    });

    await expect(runRestoreControl(["clear", "--operation-id", operationId], config))
      .rejects.toMatchObject({
        code: "VERSION_CONFLICT",
        message: expect.stringMatching(/cannot be unfenced directly/),
      });

    await expect(runRestoreControl(
      ["set", "--operation-id", nextOperationId],
      config,
      () => new Date("2026-07-19T13:00:00.000Z"),
    )).resolves.toMatchObject({
      maintenance: {
        active: true,
        markerValid: true,
        phase: "restore",
        operationId: nextOperationId,
      },
      operation: { phase: "rolled_back", operationId },
    });
    expect(fs.existsSync(path.join(config.backupDirectory, ".formaspec", "restore-history"))).toBe(false);
  });

  it("refuses prepared cancellation when a current ledger masks a missing migration-10 table", async () => {
    const config = await fixture();
    const databasePath = path.join(config.dataDirectory, "designer.sqlite");
    const database = new DesignerDatabase(databasePath);
    database.close();
    const tampered = new Database(databasePath);
    try {
      tampered.exec("DROP TABLE portable_imports");
    } finally {
      tampered.close();
    }
    await new RestoreOperationStore(config.backupDirectory).write(preparedState());
    await runRestoreControl(["set", "--operation-id", operationId], config, () => new Date(timestamp));

    await expect(runRestoreControl(["abort", "--operation-id", operationId], config)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      details: { reason: expect.stringContaining("missing required table portable_imports") },
    });
    await expect(new MaintenanceStore(config.backupDirectory, config.dataDirectory).read())
      .resolves.toMatchObject({ active: true, operationId });
    await expect(new RestoreOperationStore(config.backupDirectory).read())
      .resolves.toMatchObject({ phase: "prepared", operationId });
  });

  it("cleans a proven rolled-back journal before removing maintenance", async () => {
    const config = await fixture();
    await runRestoreControl(["set", "--operation-id", operationId], config, () => new Date(timestamp));
    await new MaintenanceStore(config.backupDirectory, config.dataDirectory).write({
      schemaVersion: 1,
      active: true,
      phase: "rollback",
      operationId,
      startedAt: timestamp,
    });
    await new RestoreOperationStore(config.backupDirectory).write(rolledBackState());
    const journalRoot = path.join(config.dataDirectory, ".formaspec-restore-journal");
    await fs.promises.mkdir(path.join(journalRoot, "candidate"), { recursive: true });
    await fs.promises.mkdir(path.join(journalRoot, "rollback"), { recursive: true });
    await fs.promises.writeFile(path.join(journalRoot, "journal.json"), `${JSON.stringify({
      format: "formaspec-restore-journal",
      version: 1,
      restoreId: "00000000-0000-4000-8000-000000000000",
      sourceBundleSha256: "c".repeat(64),
      createdAt: timestamp,
      updatedAt: timestamp,
      phase: "rolled-back",
      candidateCutoverStarted: true,
      originalEntries: [],
      candidateEntries: [],
      steps: [],
    })}\n`);

    const cleared = await runRestoreControl(["clear", "--operation-id", operationId], config);
    expect(cleared.maintenance).toEqual({ active: false, markerValid: true });
    expect(fs.existsSync(journalRoot)).toBe(false);
  });

  it("refuses abort for the wrong ID or any lock, operation, or restore-journal evidence", async () => {
    const wrongId = await fixture();
    await runRestoreControl(["set", "--operation-id", operationId], wrongId, () => new Date(timestamp));
    await expect(runRestoreControl(
      ["abort", "--operation-id", "restore_ffffffffffffffffffffffffffffffff"],
      wrongId,
    )).rejects.toMatchObject({ code: "VERSION_CONFLICT" });

    const locked = await fixture();
    await runRestoreControl(["set", "--operation-id", operationId], locked, () => new Date(timestamp));
    await new RestoreWorkerLockStore(locked.backupDirectory).acquire({ operationId, acquiredAt: timestamp });
    await expect(runRestoreControl(["abort", "--operation-id", operationId], locked))
      .rejects.toMatchObject({ code: "VERSION_CONFLICT" });

    const persisted = await fixture();
    await runRestoreControl(["set", "--operation-id", operationId], persisted, () => new Date(timestamp));
    await new RestoreOperationStore(persisted.backupDirectory).write(reconciledState());
    await expect(runRestoreControl(["abort", "--operation-id", operationId], persisted))
      .rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    await expect(new RestoreWorkerLockStore(persisted.backupDirectory).read())
      .resolves.toEqual({ active: false, lockValid: true });

    const journaled = await fixture();
    await runRestoreControl(["set", "--operation-id", operationId], journaled, () => new Date(timestamp));
    await fs.promises.mkdir(path.join(journaled.dataDirectory, ".formaspec-restore-journal"));
    await expect(runRestoreControl(["abort", "--operation-id", operationId], journaled))
      .rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    await expect(new RestoreWorkerLockStore(journaled.backupDirectory).read())
      .resolves.toEqual({ active: false, lockValid: true });
  });

  it("fails closed for a malformed marker", async () => {
    const config = await fixture();
    const markerDirectory = path.join(config.backupDirectory, ".formaspec");
    await fs.promises.mkdir(markerDirectory);
    await fs.promises.writeFile(path.join(markerDirectory, "maintenance.json"), "not-json");
    const status = await new MaintenanceStore(config.backupDirectory, config.dataDirectory).read();
    expect(status).toEqual({ active: true, markerValid: false, phase: "unknown" });
    await expect(runRestoreControl(["set", "--operation-id", operationId], config))
      .rejects.toMatchObject({ code: "TEMPORARILY_UNAVAILABLE" });
  });
});
