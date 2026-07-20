import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { z } from "zod";

import { finalizeTerminalRestoreJournal } from "./backup.js";
import {
  DATABASE_SCHEMA_VERSION,
  validateDatabaseMigrationLedger,
  validateDatabaseSchemaShape,
} from "./db/database.js";
import { DomainError } from "./errors.js";
import { MaintenanceStore, type MaintenanceStatus } from "./maintenance.js";
import { RestoreOperationStore, type RestoreOperationState } from "./restore-operation-store.js";
import { RestoreWorkerLockStore, type RestoreWorkerLockStatus } from "./restore-worker-lock.js";

const operationIdSchema = z.string().min(16).max(120)
  .regex(/^restore_[A-Za-z0-9][A-Za-z0-9_-]+$/);

const environmentSchema = z.object({
  DATA_DIR: z.string().min(1).default("data"),
  BACKUP_DIR: z.string().min(1).optional(),
  FORMASPEC_RESTORE_CONTAINER_ID: z.string().min(1).max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).optional(),
  HOSTNAME: z.string().min(1).max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).optional(),
}).passthrough();

export interface RestoreControlConfig {
  dataDirectory: string;
  backupDirectory: string;
  databasePath?: string;
  containerId?: string;
}

export interface RestoreControlStatus {
  maintenance:
    | { active: false; markerValid: true }
    | {
      active: true;
      markerValid: true;
      phase: string;
      operationId: string;
      startedAt: string;
    }
    | { active: true; markerValid: false; phase: "unknown" };
  operation: null | {
    operationId: string;
    backupId: string;
    safetyBackupId: string;
    phase: RestoreOperationState["phase"];
    createdAt: string;
    updatedAt: string;
    smoke: RestoreOperationState["smoke"];
    result: RestoreOperationState["result"];
    errorCode: RestoreOperationState["errorCode"];
  };
  workerLock:
    | { active: false; lockValid: true }
    | { active: true; lockValid: false }
    | {
      active: true;
      lockValid: true;
      operationId: string;
      ownerId: string;
      containerId: string | null;
      processId: number;
      acquiredAt: string;
    };
}

function parseOperationArgument(arguments_: readonly string[]): string {
  if (arguments_.length !== 2 || arguments_[0] !== "--operation-id") {
    throw new DomainError("VALIDATION_FAILED", "Restore control requires exactly --operation-id.", 422);
  }
  const operationId = operationIdSchema.safeParse(arguments_[1]);
  if (!operationId.success) {
    throw new DomainError("VALIDATION_FAILED", "Restore operation ID is invalid.", 422);
  }
  return operationId.data;
}

function publicMaintenance(status: MaintenanceStatus): RestoreControlStatus["maintenance"] {
  if (!status.active) return { active: false, markerValid: true };
  if (!status.markerValid) return { active: true, markerValid: false, phase: "unknown" };
  return {
    active: true,
    markerValid: true,
    phase: status.phase,
    operationId: status.operationId,
    startedAt: status.startedAt,
  };
}

function publicOperation(state: RestoreOperationState | null): RestoreControlStatus["operation"] {
  if (state === null) return null;
  return {
    operationId: state.operationId,
    backupId: state.backupId,
    safetyBackupId: state.safety.id,
    phase: state.phase,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    smoke: state.smoke,
    result: state.result,
    errorCode: state.errorCode,
  };
}

function publicWorkerLock(status: RestoreWorkerLockStatus): RestoreControlStatus["workerLock"] {
  if (!status.active) return { active: false, lockValid: true };
  if (!status.lockValid) return { active: true, lockValid: false };
  return {
    active: true,
    lockValid: true,
    operationId: status.operationId,
    ownerId: status.ownerId,
    containerId: status.containerId,
    processId: status.processId,
    acquiredAt: status.acquiredAt,
  };
}

export function loadRestoreControlConfig(environment: NodeJS.ProcessEnv = process.env): RestoreControlConfig {
  const parsed = environmentSchema.parse(environment);
  const dataDirectory = path.resolve(parsed.DATA_DIR);
  const backupDirectory = path.resolve(parsed.BACKUP_DIR ?? path.join(dataDirectory, "..", "backups"));
  // The constructor verifies that the maintenance control plane cannot be
  // replaced by the data-directory cutover it supervises.
  new MaintenanceStore(backupDirectory, dataDirectory);
  const containerId = parsed.FORMASPEC_RESTORE_CONTAINER_ID ?? parsed.HOSTNAME;
  return {
    dataDirectory,
    backupDirectory,
    databasePath: path.join(dataDirectory, "designer.sqlite"),
    ...(containerId ? { containerId } : {}),
  };
}

async function verifyPreparedAbortDatabase(config: RestoreControlConfig): Promise<void> {
  const databasePath = path.resolve(config.databasePath ?? path.join(config.dataDirectory, "designer.sqlite"));
  const expectedDatabasePath = path.join(path.resolve(config.dataDirectory), "designer.sqlite");
  if (databasePath !== expectedDatabasePath) {
    throw new DomainError("VALIDATION_FAILED", "Prepared restore cancellation requires the canonical data database.", 422);
  }
  const stat = await fs.promises.lstat(databasePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new DomainError("NOT_FOUND", "Live FormaSpec database is unavailable.", 404);
    throw error;
  });
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new DomainError("VALIDATION_FAILED", "Live FormaSpec database is not a regular file.", 422);
  }
  const sqlite = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    sqlite.pragma("query_only = ON");
    if (sqlite.pragma("integrity_check", { simple: true }) !== "ok") {
      throw new DomainError("VALIDATION_FAILED", "Live database integrity failed before restore cancellation.", 422);
    }
    let foreignKeyViolations = 0;
    for (const _row of sqlite.prepare("PRAGMA foreign_key_check").iterate()) {
      foreignKeyViolations += 1;
      if (foreignKeyViolations > 1_000) break;
    }
    if (foreignKeyViolations > 0) {
      throw new DomainError("VALIDATION_FAILED", "Live database has foreign-key violations before restore cancellation.", 422, {
        details: { countAtLeast: foreignKeyViolations },
      });
    }
    const ledger = sqlite.prepare(
      "SELECT version, name FROM schema_migrations ORDER BY version",
    ).all() as Array<{ version: unknown; name: unknown }>;
    let schemaVersion: number;
    try {
      schemaVersion = validateDatabaseMigrationLedger(ledger);
      validateDatabaseSchemaShape(sqlite, schemaVersion);
    } catch (error) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "Live database schema does not match its migration ledger before restore cancellation.",
        422,
        { cause: error, details: { reason: error instanceof Error ? error.message : String(error) } },
      );
    }
    if (schemaVersion !== DATABASE_SCHEMA_VERSION) {
      throw new DomainError("VALIDATION_FAILED", "Live database schema is not current before restore cancellation.", 422);
    }
  } finally {
    sqlite.close();
  }
}

async function readStatus(
  maintenance: MaintenanceStore,
  operationStore: RestoreOperationStore,
  workerLock: RestoreWorkerLockStore,
  expectedOperationId?: string,
): Promise<RestoreControlStatus> {
  const [maintenanceStatus, operation, lockStatus] = await Promise.all([
    maintenance.read(),
    operationStore.read(),
    workerLock.read(),
  ]);
  if (expectedOperationId !== undefined) {
    if (maintenanceStatus.active && maintenanceStatus.markerValid
      && maintenanceStatus.operationId !== expectedOperationId) {
      throw new DomainError("VERSION_CONFLICT", "Maintenance belongs to a different restore operation.", 409);
    }
    if (operation !== null && operation.operationId !== expectedOperationId) {
      throw new DomainError("VERSION_CONFLICT", "Persisted restore state belongs to a different operation.", 409);
    }
    if (lockStatus.active && lockStatus.lockValid && lockStatus.operationId !== expectedOperationId) {
      throw new DomainError("VERSION_CONFLICT", "Restore worker lock belongs to a different operation.", 409);
    }
  }
  return {
    maintenance: publicMaintenance(maintenanceStatus),
    operation: publicOperation(operation),
    workerLock: publicWorkerLock(lockStatus),
  };
}

async function requireNoRestoreJournal(dataDirectory: string): Promise<void> {
  const journalPath = path.join(path.resolve(dataDirectory), ".formaspec-restore-journal");
  try {
    await fs.promises.lstat(journalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return;
    throw new DomainError(
      "TEMPORARILY_UNAVAILABLE",
      "Restore journal state could not be checked safely.",
      503,
      { cause: error },
    );
  }
  throw new DomainError(
    "VERSION_CONFLICT",
    "Restore maintenance cannot abort while restore journal evidence exists.",
    409,
  );
}

export async function runRestoreControl(
  arguments_: readonly string[],
  config: RestoreControlConfig = loadRestoreControlConfig(),
  now: () => Date = () => new Date(),
): Promise<RestoreControlStatus> {
  const [command, ...rest] = arguments_;
  const maintenance = new MaintenanceStore(config.backupDirectory, config.dataDirectory);
  const operationStore = new RestoreOperationStore(config.backupDirectory);
  const workerLock = new RestoreWorkerLockStore(config.backupDirectory);

  if (command === "status") {
    if (rest.length === 0) return readStatus(maintenance, operationStore, workerLock);
    return readStatus(maintenance, operationStore, workerLock, parseOperationArgument(rest));
  }

  if (command === "set") {
    const operationId = parseOperationArgument(rest);
    const lease = await workerLock.acquire({
      operationId,
      ...(config.containerId ? { containerId: config.containerId } : {}),
    });
    try {
      const [maintenanceStatus, operation] = await Promise.all([
        maintenance.read(),
        operationStore.read(),
      ]);
      if (maintenanceStatus.active && !maintenanceStatus.markerValid) {
        throw new DomainError(
          "TEMPORARILY_UNAVAILABLE",
          "Maintenance state is invalid and requires operator inspection.",
          503,
        );
      }
      if (maintenanceStatus.active && maintenanceStatus.operationId !== operationId) {
        throw new DomainError("VERSION_CONFLICT", "Another restore operation already owns maintenance mode.", 409);
      }
      if (operation !== null && operation.operationId !== operationId
        && operation.phase !== "reconciled" && operation.phase !== "rolled_back") {
        throw new DomainError("VERSION_CONFLICT", "An unfinished restore operation already exists.", 409);
      }
      // Archive an unrelated terminal operation before publishing the next
      // maintenance owner. A crash between these actions leaves the live API
      // unfenced and the old terminal state safely archived; no restore
      // cutover has begun. Retrying the command is idempotent.
      if (operation !== null && operation.operationId !== operationId) {
        await operationStore.archiveTerminal(operation.operationId);
      }
      if (!maintenanceStatus.active) {
        await maintenance.write({
          schemaVersion: 1,
          active: true,
          phase: "restore",
          operationId,
          startedAt: now().toISOString(),
        });
      }
    } finally {
      await lease.release();
    }
    return readStatus(maintenance, operationStore, workerLock, operationId);
  }

  if (command === "clear") {
    const operationId = parseOperationArgument(rest);
    const lease = await workerLock.acquire({
      operationId,
      ...(config.containerId ? { containerId: config.containerId } : {}),
    });
    try {
      const [status, operation] = await Promise.all([
        maintenance.read(),
        operationStore.read(),
      ]);
      if (!status.active || !status.markerValid || status.operationId !== operationId) {
        throw new DomainError("VERSION_CONFLICT", "A matching valid maintenance marker is required.", 409);
      }
      if (operation === null || operation.operationId !== operationId
        || (operation.phase !== "reconciled" && operation.phase !== "rolled_back")) {
        throw new DomainError(
          "VERSION_CONFLICT",
          "Restore maintenance cannot clear before durable completion or rollback.",
          409,
        );
      }
      if (operation.phase === "rolled_back") {
        await finalizeTerminalRestoreJournal(config.dataDirectory, "rolled-back");
      }
      await maintenance.clear();
    } finally {
      await lease.release();
    }
    return readStatus(maintenance, operationStore, workerLock, operationId);
  }

  if (command === "clear-stale-lock") {
    const operationId = parseOperationArgument(rest);
    await workerLock.clearStale(operationId);
    return readStatus(maintenance, operationStore, workerLock);
  }

  if (command === "abort") {
    const operationId = parseOperationArgument(rest);
    const initialMaintenance = await maintenance.read();
    if (!initialMaintenance.active || !initialMaintenance.markerValid
      || initialMaintenance.operationId !== operationId) {
      throw new DomainError("VERSION_CONFLICT", "A matching valid maintenance marker is required.", 409);
    }
    const lease = await workerLock.acquire({
      operationId,
      ...(config.containerId ? { containerId: config.containerId } : {}),
    });
    try {
      const [currentMaintenance, operation] = await Promise.all([
        maintenance.read(),
        operationStore.read(),
      ]);
      if (!currentMaintenance.active || !currentMaintenance.markerValid
        || currentMaintenance.operationId !== operationId) {
        throw new DomainError("VERSION_CONFLICT", "Maintenance state changed before abort.", 409);
      }
      if (operation !== null && (operation.operationId !== operationId || operation.phase !== "prepared")) {
        throw new DomainError(
          "VERSION_CONFLICT",
          "Restore maintenance can cancel only pristine or prepared pre-cutover state.",
          409,
        );
      }
      await requireNoRestoreJournal(config.dataDirectory);
      if (operation?.phase === "prepared") {
        await verifyPreparedAbortDatabase(config);
        await operationStore.archivePreparedCancellation(operationId);
      }
      await maintenance.clear();
    } finally {
      await lease.release();
    }
    return readStatus(maintenance, operationStore, workerLock);
  }

  throw new DomainError(
    "VALIDATION_FAILED",
    "Use restore-control status|set|clear|clear-stale-lock|abort [--operation-id ID].",
    422,
  );
}

function errorCode(error: unknown): string {
  return error instanceof DomainError ? error.code : "INTERNAL_ERROR";
}

async function main(): Promise<void> {
  const status = await runRestoreControl(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify({ ok: true, status })}\n`);
}

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entrypoint === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: {
        code: errorCode(error),
        message: error instanceof Error ? error.message : "FormaSpec restore control failed.",
      },
    })}\n`);
    process.exitCode = 1;
  });
}
