import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { AnyDesignDocumentSchema, type AnyDesignDocument } from "@designer/core";
import SqliteDatabase from "better-sqlite3";
import { z } from "zod";

import { appendAuditEvent, type AccessContext } from "./authorization.js";
import {
  BackupManager,
  MAX_BACKUP_BUNDLE_BYTES,
  RESTORE_JOURNAL_MAX_BYTES,
  committedRestoreJournalMatches,
  createForensicRecoveryBundle,
  finalizeTerminalRestoreJournal,
  inspectBackupBundle,
  inspectRestoreJournal,
  restoreVerifiedBackup,
  verifyPinnedBackupBundle,
  verifyPinnedForensicRecoveryBundle,
  type BackupRasterVerifier,
  type BackupVerificationResult,
} from "./backup.js";
import {
  DATABASE_SCHEMA_VERSION,
  DesignerDatabase,
  validateDatabaseMigrationLedger,
} from "./db/database.js";
import { DomainError } from "./errors.js";
import { MaintenanceStore, type MaintenanceStatus } from "./maintenance.js";
import { canonicalSnapshot } from "./persistence.js";
import { PngRenderer, type RenderHealth, type RenderOptions, type RenderResult } from "./render.js";
import {
  DEFAULT_MAX_ASSET_BYTES,
  DEFAULT_RENDER_MAX_PIXELS,
  MAX_RASTER_NORMALIZATION_BYTES,
  MAX_RASTER_NORMALIZATION_PIXELS,
  validateRendererLimitParity,
} from "./renderer-contract.js";
import { validateRendererEndpoint } from "./renderer-endpoint.js";
import {
  RestoreOperationStore,
  type RestoreOperationRecord,
  type RestoreOperationState,
} from "./restore-operation-store.js";
import { RestoreWorkerLockStore } from "./restore-worker-lock.js";

const backupIdSchema = z.string().regex(/^backup_[a-f0-9]{40}$/);
const operationIdSchema = z.string().min(16).max(120)
  .regex(/^restore_[A-Za-z0-9][A-Za-z0-9_-]+$/);
const managedBackupFilename = /^formaspec-backup-[0-9TZ-]+\.tar$/;
const workerContainerIdSchema = z.string().min(1).max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const SYSTEM_ACTOR_ID = "system:restore-worker";
const SYSTEM_PRINCIPAL_ID = "system_restore_worker";
const ABANDONED_BACKUP_WORK_DIRECTORY = /^(?:\.formaspec-restore-source-|\.verify-|\.staging-|\.forensic-|\.forensic-bundle-|\.offline-input-|\.formaspec-orphan-cleanup-)[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const RESTORE_CAPACITY_RESERVE_BYTES = 64 * 1024 * 1024;
const RESTORE_CAPACITY_MAX_ENTRIES = 20_000;
const RESTORE_CAPACITY_MAX_TREE_BYTES = 16 * 1024 * 1024 * 1024;

const workerEnvironmentSchema = z.object({
  DATA_DIR: z.string().min(1).default("data"),
  BACKUP_DIR: z.string().min(1).optional(),
  DESIGNER_DATABASE_PATH: z.string().min(1).optional(),
  FORMASPEC_RESTORE_BACKUP_ID: backupIdSchema.optional(),
  FORMASPEC_RESTORE_OPERATION_ID: operationIdSchema.optional(),
  FORMASPEC_RESTORE_CONTAINER_ID: workerContainerIdSchema.optional(),
  FORMASPEC_RENDER_SOCKET: z.string().min(1).max(256).optional(),
  FORMASPEC_RENDER_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(15_000),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().max(MAX_RASTER_NORMALIZATION_BYTES)
    .default(DEFAULT_MAX_ASSET_BYTES),
  DESIGNER_MAX_ASSET_BYTES: z.coerce.number().int().positive().max(MAX_RASTER_NORMALIZATION_BYTES).optional(),
  DESIGNER_MAX_ASSET_PIXELS: z.coerce.number().int().positive().max(MAX_RASTER_NORMALIZATION_PIXELS).optional(),
  FORMASPEC_RENDER_MAX_PIXELS: z.coerce.number().int().positive().max(MAX_RASTER_NORMALIZATION_PIXELS)
    .default(DEFAULT_RENDER_MAX_PIXELS),
  FORMASPEC_RENDER_IPC_MAX_BYTES: z.coerce.number().int().min(1_048_576).max(256 * 1024 * 1024)
    .default(96 * 1024 * 1024),
  FORMASPEC_ALLOW_SYSTEM_CHROME: z.enum(["true", "false", "1", "0"]).optional()
    .transform((value) => value === "true" || value === "1"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
}).passthrough();

export interface RestoreWorkerConfig {
  dataDirectory: string;
  backupDirectory: string;
  databasePath: string;
  backupId: string;
  operationId: string;
  containerId?: string;
  renderSocket?: string;
  renderTimeoutMs: number;
  maxAssetBytes: number;
  maxAssetPixels: number;
  renderMaxPixels: number;
  renderIpcMaxBytes: number;
  allowSystemChrome: boolean;
  nodeEnvironment: "development" | "test" | "production";
}

export interface RestorePreflightConfig {
  backupDirectory: string;
  databasePath: string;
  backupId: string;
  renderSocket?: string;
  renderTimeoutMs?: number;
  maxAssetBytes?: number;
  maxAssetPixels?: number;
  renderMaxPixels?: number;
  renderIpcMaxBytes?: number;
  allowSystemChrome?: boolean;
  requireRasterVerifier?: boolean;
}

export interface RestorePreflightResult {
  status: "verified";
  backupId: string;
  organizationId: string;
  sizeBytes: number;
  databaseSchemaVersion: number;
  documentSchemaVersion: number;
  createdAt: string;
  entryCount: number;
  extractedBytes: number;
}

export interface OfflineRestorePreparationConfig {
  dataDirectory: string;
  backupDirectory: string;
  operationId: string;
  expectedSource: { sha256: string; sizeBytes: number };
  renderSocket?: string;
  renderTimeoutMs: number;
  maxAssetBytes: number;
  maxAssetPixels: number;
  renderMaxPixels: number;
  renderIpcMaxBytes: number;
  allowSystemChrome: boolean;
  nodeEnvironment: "development" | "test" | "production";
}

export interface OfflineRestorePreparationResult {
  status: "prepared";
  operationId: string;
  backupId: string;
  organizationId: string;
  targetFilename: string;
  targetSha256: string;
  targetSizeBytes: number;
  safetyBackupId: string;
  safetyFilename: string;
  safetySha256: string;
  safetySizeBytes: number;
}

export interface ForensicRollbackResult {
  status: "forensic_rolled_back" | "forensic_rollback_aborted";
  operationId: string;
  backupId: string;
  safetyBackupId: string;
  maintenancePhase: "rollback" | "verification";
  errorCode?: string;
}

export interface ForensicRollbackConfig {
  dataDirectory: string;
  backupDirectory: string;
  operationId: string;
  containerId?: string;
}

export interface RestoreWorkerRenderer {
  health(): Promise<RenderHealth>;
  render(
    document: AnyDesignDocument,
    options: RenderOptions,
    assetDataUrl: (id: string) => string | null,
  ): Promise<RenderResult>;
  normalizeRaster: PngRenderer["normalizeRaster"];
  close(): Promise<void>;
}

export interface RestoreWorkerDependencies {
  renderer?: RestoreWorkerRenderer;
  now?: () => Date;
  afterLockAcquired?: () => Promise<void> | void;
  afterSafetyBackup?: () => Promise<void> | void;
  afterCutover?: () => Promise<void> | void;
}

export interface RestoreWorkerResult {
  status: "restored";
  backupId: string;
  operationId: string;
  safetyBackupId: string;
  auditEventId: number;
  outboxEventId: number;
  schemaVersion: number;
  renderedDesignId: string | null;
  revoked: { grants: number; connections: number; nonces: number };
  maintenancePhase: "verification";
}

interface BackupRecordSnapshot {
  id: string;
  organizationId: string;
  filename: string;
  bundleSha256: string;
  status: "valid" | "restored";
  manifestJson: string | null;
  createdBy: string;
  createdAt: string;
  verifiedAt: string | null;
  sizeBytes: number | null;
  verificationJson: string | null;
  retentionClass: "manual" | "daily" | "weekly" | "monthly";
  completedAt: string | null;
}

interface VerifiedManagedBackup {
  record: BackupRecordSnapshot;
  bundlePath: string;
  sizeBytes: number;
  verification: BackupVerificationResult | null;
}

interface SafetyBackupRecord extends BackupRecordSnapshot {
  status: "valid";
  retentionClass: "manual";
  manifestJson: string;
  verifiedAt: string;
  sizeBytes: number;
  verificationJson: string;
  completedAt: string;
}

interface ForensicSafetyRecord extends BackupRecordSnapshot {
  status: "valid";
  retentionClass: "manual";
  manifestJson: null;
  verifiedAt: string;
  sizeBytes: number;
  verificationJson: null;
  completedAt: string;
}

type RestoreSafetyRecord = SafetyBackupRecord | ForensicSafetyRecord;

interface RestoreSmokeResult {
  schemaVersion: number;
  renderedDesignId: string | null;
}

function operationRecord(record: BackupRecordSnapshot): RestoreOperationRecord {
  if (record.sizeBytes === null) {
    throw new DomainError("VALIDATION_FAILED", "Restore operation requires a known backup size.", 422);
  }
  return {
    id: record.id,
    organizationId: record.organizationId,
    filename: record.filename,
    bundleSha256: record.bundleSha256,
    createdBy: record.createdBy,
    createdAt: record.createdAt,
    sizeBytes: record.sizeBytes,
    retentionClass: record.retentionClass,
  };
}

function recordFromOperationState(
  record: RestoreOperationRecord,
  status: "valid" | "restored",
): BackupRecordSnapshot {
  return {
    ...record,
    status,
    manifestJson: null,
    verifiedAt: null,
    verificationJson: null,
    completedAt: null,
  };
}

function preparedOperationState(
  config: Pick<RestoreWorkerConfig, "operationId" | "backupId">,
  target: VerifiedManagedBackup,
  safety: RestoreSafetyRecord,
  monotonicFloor: { auditEventId: number; outboxEventId: number },
  now: string,
  recovery?: { mode: "offline"; safetyKind: "forensic" },
): Extract<RestoreOperationState, { phase: "prepared" }> {
  return {
    format: "formaspec-restore-operation",
    version: 1,
    operationId: config.operationId,
    backupId: config.backupId,
    phase: "prepared",
    target: operationRecord({ ...target.record, sizeBytes: target.sizeBytes }),
    safety: { ...operationRecord(safety), retentionClass: "manual" },
    monotonicFloor,
    ...(recovery ? { recovery } : {}),
    smoke: null,
    result: null,
    errorCode: null,
    createdAt: now,
    updatedAt: now,
  };
}

function cutoverCommittedState(
  state: RestoreOperationState,
  smoke: RestoreSmokeResult,
  updatedAt: string,
): Extract<RestoreOperationState, { phase: "cutover_committed" }> {
  return {
    ...state,
    phase: "cutover_committed",
    smoke,
    result: null,
    errorCode: null,
    updatedAt,
  };
}

function reconciledOperationState(
  state: RestoreOperationState,
  smoke: RestoreSmokeResult,
  result: Pick<RestoreWorkerResult, "auditEventId" | "outboxEventId" | "revoked">,
  updatedAt: string,
): Extract<RestoreOperationState, { phase: "reconciled" }> {
  return {
    ...state,
    phase: "reconciled",
    smoke,
    result,
    errorCode: null,
    updatedAt,
  };
}

function rolledBackOperationState(
  state: RestoreOperationState,
  code: string,
  updatedAt: string,
): Extract<RestoreOperationState, { phase: "rolled_back" }> {
  return {
    ...state,
    phase: "rolled_back",
    smoke: null,
    result: null,
    errorCode: /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : "INTERNAL_ERROR",
    updatedAt,
  };
}

function parseRequestArguments(environment: NodeJS.ProcessEnv, argv: string[]): {
  backupId: string;
  operationId: string;
} {
  let backupId: string | undefined;
  let operationId: string | undefined;
  if (argv.length > 0) {
    if (environment.FORMASPEC_RESTORE_BACKUP_ID || environment.FORMASPEC_RESTORE_OPERATION_ID) {
      throw new Error("Restore worker IDs must come from either argv or environment, not both.");
    }
    if (argv.length !== 4) throw new Error("Restore worker requires exactly --backup-id and --operation-id.");
    const values = new Map<string, string>();
    for (let index = 0; index < argv.length; index += 2) {
      const flag = argv[index];
      const value = argv[index + 1];
      if (!flag || !value || !["--backup-id", "--operation-id"].includes(flag) || values.has(flag)) {
        throw new Error("Restore worker accepts only one --backup-id and one --operation-id.");
      }
      values.set(flag, value);
    }
    backupId = values.get("--backup-id");
    operationId = values.get("--operation-id");
  } else {
    backupId = environment.FORMASPEC_RESTORE_BACKUP_ID;
    operationId = environment.FORMASPEC_RESTORE_OPERATION_ID;
  }
  return {
    backupId: backupIdSchema.parse(backupId),
    operationId: operationIdSchema.parse(operationId),
  };
}

export function loadRestoreWorkerConfig(
  environment: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv.slice(2),
  platform: NodeJS.Platform = process.platform,
): RestoreWorkerConfig {
  const parsed = workerEnvironmentSchema.parse(environment);
  const request = parseRequestArguments(environment, argv);
  const maxAssetBytes = parsed.DESIGNER_MAX_ASSET_BYTES ?? parsed.MAX_UPLOAD_BYTES;
  const maxAssetPixels = parsed.DESIGNER_MAX_ASSET_PIXELS ?? parsed.FORMASPEC_RENDER_MAX_PIXELS;
  const dataDirectory = path.resolve(parsed.DATA_DIR);
  const backupDirectory = path.resolve(parsed.BACKUP_DIR ?? path.join(dataDirectory, "..", "backups"));
  const databasePath = path.resolve(parsed.DESIGNER_DATABASE_PATH ?? path.join(dataDirectory, "designer.sqlite"));
  if (databasePath !== path.join(dataDirectory, "designer.sqlite")) {
    throw new Error("Restore worker requires DESIGNER_DATABASE_PATH to be DATA_DIR/designer.sqlite.");
  }
  if (parsed.FORMASPEC_RENDER_SOCKET) validateRendererEndpoint(parsed.FORMASPEC_RENDER_SOCKET, platform);
  if (parsed.NODE_ENV === "production" && !parsed.FORMASPEC_RENDER_SOCKET) {
    throw new Error("Production restore verification requires the configured renderer-worker socket.");
  }
  if (parsed.NODE_ENV === "production" && parsed.FORMASPEC_ALLOW_SYSTEM_CHROME) {
    throw new Error("Production restore verification requires pinned Chromium.");
  }
  validateRendererLimitParity({
    maxAssetBytes,
    maxAssetPixels,
    renderMaxPixels: parsed.FORMASPEC_RENDER_MAX_PIXELS,
    renderIpcMaxBytes: parsed.FORMASPEC_RENDER_IPC_MAX_BYTES,
  });
  // Constructor enforces that the fixed maintenance marker lives outside the
  // data directory that restoreVerifiedBackup will cut over.
  new MaintenanceStore(backupDirectory, dataDirectory);
  return {
    dataDirectory,
    backupDirectory,
    databasePath,
    ...request,
    ...(parsed.FORMASPEC_RESTORE_CONTAINER_ID
      ? { containerId: parsed.FORMASPEC_RESTORE_CONTAINER_ID }
      : {}),
    ...(parsed.FORMASPEC_RENDER_SOCKET ? { renderSocket: parsed.FORMASPEC_RENDER_SOCKET } : {}),
    renderTimeoutMs: parsed.FORMASPEC_RENDER_TIMEOUT_MS,
    maxAssetBytes,
    maxAssetPixels,
    renderMaxPixels: parsed.FORMASPEC_RENDER_MAX_PIXELS,
    renderIpcMaxBytes: parsed.FORMASPEC_RENDER_IPC_MAX_BYTES,
    allowSystemChrome: parsed.FORMASPEC_ALLOW_SYSTEM_CHROME,
    nodeEnvironment: parsed.NODE_ENV,
  };
}

export function loadRestorePreflightConfig(
  environment: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv.slice(2),
  platform: NodeJS.Platform = process.platform,
): RestorePreflightConfig {
  if (argv.length > 0 && environment.FORMASPEC_RESTORE_BACKUP_ID) {
    throw new Error("Restore preflight backup ID must come from either argv or environment, not both.");
  }
  let backupId = environment.FORMASPEC_RESTORE_BACKUP_ID;
  if (argv.length > 0) {
    if (argv.length !== 2 || argv[0] !== "--backup-id") {
      throw new Error("Restore preflight requires exactly --backup-id.");
    }
    backupId = argv[1];
  }
  const parsed = workerEnvironmentSchema.parse(environment);
  const dataDirectory = path.resolve(parsed.DATA_DIR);
  const backupDirectory = path.resolve(parsed.BACKUP_DIR ?? path.join(dataDirectory, "..", "backups"));
  const databasePath = path.resolve(
    parsed.DESIGNER_DATABASE_PATH ?? path.join(dataDirectory, "designer.sqlite"),
  );
  if (databasePath !== path.join(dataDirectory, "designer.sqlite")) {
    throw new Error("Restore preflight requires DESIGNER_DATABASE_PATH to be DATA_DIR/designer.sqlite.");
  }
  if (parsed.FORMASPEC_RENDER_SOCKET) validateRendererEndpoint(parsed.FORMASPEC_RENDER_SOCKET, platform);
  if (parsed.NODE_ENV === "production" && !parsed.FORMASPEC_RENDER_SOCKET) {
    throw new Error("Production restore preflight requires the configured renderer-worker endpoint.");
  }
  if (parsed.NODE_ENV === "production" && parsed.FORMASPEC_ALLOW_SYSTEM_CHROME) {
    throw new Error("Production restore preflight requires pinned Chromium.");
  }
  const maxAssetBytes = parsed.DESIGNER_MAX_ASSET_BYTES ?? parsed.MAX_UPLOAD_BYTES;
  const maxAssetPixels = parsed.DESIGNER_MAX_ASSET_PIXELS ?? parsed.FORMASPEC_RENDER_MAX_PIXELS;
  validateRendererLimitParity({
    maxAssetBytes,
    maxAssetPixels,
    renderMaxPixels: parsed.FORMASPEC_RENDER_MAX_PIXELS,
    renderIpcMaxBytes: parsed.FORMASPEC_RENDER_IPC_MAX_BYTES,
  });
  new MaintenanceStore(backupDirectory, dataDirectory);
  return {
    backupDirectory,
    databasePath,
    backupId: backupIdSchema.parse(backupId),
    ...(parsed.FORMASPEC_RENDER_SOCKET ? { renderSocket: parsed.FORMASPEC_RENDER_SOCKET } : {}),
    renderTimeoutMs: parsed.FORMASPEC_RENDER_TIMEOUT_MS,
    maxAssetBytes,
    maxAssetPixels,
    renderMaxPixels: parsed.FORMASPEC_RENDER_MAX_PIXELS,
    renderIpcMaxBytes: parsed.FORMASPEC_RENDER_IPC_MAX_BYTES,
    allowSystemChrome: parsed.FORMASPEC_ALLOW_SYSTEM_CHROME,
    requireRasterVerifier: true,
  };
}

function strictFlagValues(arguments_: string[], allowed: readonly string[]): Map<string, string> {
  if (arguments_.length !== allowed.length * 2) {
    throw new Error(`Restore command requires exactly ${allowed.join(", ")}.`);
  }
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (!flag || !value || !allowed.includes(flag) || values.has(flag)) {
      throw new Error(`Restore command accepts only one of each: ${allowed.join(", ")}.`);
    }
    values.set(flag, value);
  }
  return values;
}

export function loadOfflineRestorePreparationConfig(
  environment: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv.slice(2),
  platform: NodeJS.Platform = process.platform,
): OfflineRestorePreparationConfig {
  const values = strictFlagValues(argv, ["--operation-id", "--expected-sha256", "--expected-size"]);
  const parsed = workerEnvironmentSchema.parse(environment);
  const dataDirectory = path.resolve(parsed.DATA_DIR);
  const backupDirectory = path.resolve(parsed.BACKUP_DIR ?? path.join(dataDirectory, "..", "backups"));
  const sizeBytes = Number(values.get("--expected-size"));
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_BACKUP_BUNDLE_BYTES) {
    throw new Error("Offline restore expected source size is invalid.");
  }
  if (parsed.FORMASPEC_RENDER_SOCKET) validateRendererEndpoint(parsed.FORMASPEC_RENDER_SOCKET, platform);
  if (parsed.NODE_ENV === "production" && !parsed.FORMASPEC_RENDER_SOCKET) {
    throw new Error("Production offline restore preparation requires the configured renderer-worker socket.");
  }
  if (parsed.NODE_ENV === "production" && parsed.FORMASPEC_ALLOW_SYSTEM_CHROME) {
    throw new Error("Production offline restore preparation requires pinned Chromium.");
  }
  const maxAssetBytes = parsed.DESIGNER_MAX_ASSET_BYTES ?? parsed.MAX_UPLOAD_BYTES;
  const maxAssetPixels = parsed.DESIGNER_MAX_ASSET_PIXELS ?? parsed.FORMASPEC_RENDER_MAX_PIXELS;
  validateRendererLimitParity({
    maxAssetBytes,
    maxAssetPixels,
    renderMaxPixels: parsed.FORMASPEC_RENDER_MAX_PIXELS,
    renderIpcMaxBytes: parsed.FORMASPEC_RENDER_IPC_MAX_BYTES,
  });
  new MaintenanceStore(backupDirectory, dataDirectory);
  return {
    dataDirectory,
    backupDirectory,
    operationId: operationIdSchema.parse(values.get("--operation-id")),
    expectedSource: {
      sha256: sha256Schema.parse(values.get("--expected-sha256")),
      sizeBytes,
    },
    ...(parsed.FORMASPEC_RENDER_SOCKET ? { renderSocket: parsed.FORMASPEC_RENDER_SOCKET } : {}),
    renderTimeoutMs: parsed.FORMASPEC_RENDER_TIMEOUT_MS,
    maxAssetBytes,
    maxAssetPixels,
    renderMaxPixels: parsed.FORMASPEC_RENDER_MAX_PIXELS,
    renderIpcMaxBytes: parsed.FORMASPEC_RENDER_IPC_MAX_BYTES,
    allowSystemChrome: parsed.FORMASPEC_ALLOW_SYSTEM_CHROME,
    nodeEnvironment: parsed.NODE_ENV,
  };
}

export function loadForensicRollbackConfig(
  environment: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv.slice(2),
): ForensicRollbackConfig {
  const values = strictFlagValues(argv, ["--operation-id"]);
  const parsed = workerEnvironmentSchema.parse(environment);
  const dataDirectory = path.resolve(parsed.DATA_DIR);
  const backupDirectory = path.resolve(parsed.BACKUP_DIR ?? path.join(dataDirectory, "..", "backups"));
  new MaintenanceStore(backupDirectory, dataDirectory);
  return {
    dataDirectory,
    backupDirectory,
    operationId: operationIdSchema.parse(values.get("--operation-id")),
    ...(parsed.FORMASPEC_RESTORE_CONTAINER_ID ? { containerId: parsed.FORMASPEC_RESTORE_CONTAINER_ID } : {}),
  };
}

function systemAccess(organizationId: string): AccessContext {
  return {
    actorId: SYSTEM_ACTOR_ID,
    principalId: SYSTEM_PRINCIPAL_ID,
    organizationId,
    role: "organization_admin",
    scopes: ["*"],
    projectIds: [],
  };
}

function errorCode(error: unknown): string {
  return error instanceof DomainError ? error.code : "INTERNAL_ERROR";
}

export interface RestoreCapacityForecast {
  backupRequiredBytes: number;
  dataRequiredBytes: number;
  sharedRequiredBytes: number;
}

export function restoreCapacityForecast(input: {
  currentDataBytes: number;
  targetBundleBytes: number;
  targetExpandedBytes: number;
}): RestoreCapacityForecast {
  for (const value of [input.currentDataBytes, input.targetBundleBytes, input.targetExpandedBytes]) {
    if (!Number.isSafeInteger(value) || value < 0 || value > RESTORE_CAPACITY_MAX_TREE_BYTES) {
      throw new DomainError("VALIDATION_FAILED", "Restore capacity input exceeds the supported bound.", 422);
    }
  }
  const targetPayloadBytes = Math.max(input.targetBundleBytes, input.targetExpandedBytes);
  const backupRequiredBytes = Math.max(
    input.currentDataBytes * 3,
    input.currentDataBytes + targetPayloadBytes * 2,
  ) + RESTORE_CAPACITY_RESERVE_BYTES;
  const dataRequiredBytes = input.targetExpandedBytes + RESTORE_CAPACITY_RESERVE_BYTES;
  const sharedRequiredBytes = Math.max(backupRequiredBytes, dataRequiredBytes);
  if (![backupRequiredBytes, dataRequiredBytes, sharedRequiredBytes].every(Number.isSafeInteger)) {
    throw new DomainError("VALIDATION_FAILED", "Restore capacity forecast overflowed its supported bound.", 422);
  }
  return { backupRequiredBytes, dataRequiredBytes, sharedRequiredBytes };
}

async function boundedDirectoryBytes(root: string): Promise<number> {
  const resolvedRoot = path.resolve(root);
  const rootStat = await fs.promises.lstat(resolvedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new DomainError("VALIDATION_FAILED", "Restore data directory must be a real directory.", 422);
  }
  const pending = [resolvedRoot];
  let entries = 0;
  let bytes = 0;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      entries += 1;
      if (entries > RESTORE_CAPACITY_MAX_ENTRIES) {
        throw new DomainError("PAYLOAD_TOO_LARGE", "Restore data tree exceeds the capacity-preflight entry limit.", 413);
      }
      const absolute = path.join(directory, entry.name);
      const stat = await fs.promises.lstat(absolute);
      if (stat.isSymbolicLink()) {
        throw new DomainError("VALIDATION_FAILED", "Restore data tree contains a symbolic link.", 422);
      }
      if (stat.isDirectory()) {
        pending.push(absolute);
        continue;
      }
      if (!stat.isFile()) {
        throw new DomainError("VALIDATION_FAILED", "Restore data tree contains a non-regular entry.", 422);
      }
      bytes += stat.size;
      if (!Number.isSafeInteger(bytes) || bytes > RESTORE_CAPACITY_MAX_TREE_BYTES) {
        throw new DomainError("PAYLOAD_TOO_LARGE", "Restore data tree exceeds the capacity-preflight size limit.", 413);
      }
    }
  }
  return bytes;
}

function boundedCapacityBytes(value: bigint): number {
  return Number(value > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : value);
}

async function requireWholeRestoreCapacity(
  dataDirectory: string,
  backupDirectory: string,
  target: VerifiedManagedBackup,
): Promise<void> {
  const [currentDataBytes, dataStat, backupStat, dataFs, backupFs] = await Promise.all([
    boundedDirectoryBytes(dataDirectory),
    fs.promises.lstat(dataDirectory, { bigint: true }),
    fs.promises.lstat(backupDirectory, { bigint: true }),
    fs.promises.statfs(dataDirectory, { bigint: true }),
    fs.promises.statfs(backupDirectory, { bigint: true }),
  ]);
  if (!dataStat.isDirectory() || dataStat.isSymbolicLink()
    || !backupStat.isDirectory() || backupStat.isSymbolicLink()) {
    throw new DomainError("VALIDATION_FAILED", "Restore capacity preflight requires real data and backup directories.", 422);
  }
  const forecast = restoreCapacityForecast({
    currentDataBytes,
    targetBundleBytes: target.sizeBytes,
    targetExpandedBytes: target.verification?.extractedBytes ?? target.sizeBytes,
  });
  const sameFilesystem = dataStat.dev === backupStat.dev;
  const availableData = dataFs.bavail * dataFs.bsize;
  const availableBackup = backupFs.bavail * backupFs.bsize;
  const required = BigInt(sameFilesystem ? forecast.sharedRequiredBytes : forecast.backupRequiredBytes);
  if (availableBackup < required) {
    throw new DomainError(
      "TEMPORARILY_UNAVAILABLE",
      "Insufficient backup-volume capacity for the complete restore workflow.",
      507,
      {
        retryable: true,
        details: {
          volume: sameFilesystem ? "shared" : "backup",
          availableBytes: boundedCapacityBytes(availableBackup),
          requiredBytes: boundedCapacityBytes(required),
        },
      },
    );
  }
  if (!sameFilesystem && availableData < BigInt(forecast.dataRequiredBytes)) {
    throw new DomainError(
      "TEMPORARILY_UNAVAILABLE",
      "Insufficient data-volume capacity for the complete restore workflow.",
      507,
      {
        retryable: true,
        details: {
          volume: "data",
          availableBytes: boundedCapacityBytes(availableData),
          requiredBytes: forecast.dataRequiredBytes,
        },
      },
    );
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await fs.promises.open(directory, "r");
  try {
    await handle.sync().catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EINVAL" && error.code !== "ENOTSUP") throw error;
    });
  } finally {
    await handle.close();
  }
}

async function cleanupAbandonedBackupWorkDirectories(
  backupDirectory: string,
  options: { preserveRestoreSources: boolean },
): Promise<void> {
  const root = path.resolve(backupDirectory);
  const rootStat = await fs.promises.lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new DomainError("NOT_FOUND", "Managed backup directory is unavailable.", 404);
    }
    throw error;
  });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new DomainError("TEMPORARILY_UNAVAILABLE", "Managed backup directory is invalid.", 503);
  }

  const entries = (await fs.promises.readdir(root)).filter((name) => (
    ABANDONED_BACKUP_WORK_DIRECTORY.test(name)
    && !(options.preserveRestoreSources && name.startsWith(".formaspec-restore-source-"))
  ));
  for (const name of entries.sort()) {
    const candidate = path.join(root, name);
    const before = await fs.promises.lstat(candidate, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw new DomainError(
        "TEMPORARILY_UNAVAILABLE",
        "An abandoned backup work entry is not a real directory and requires operator inspection.",
        503,
      );
    }

    let handle: fs.promises.FileHandle | undefined;
    try {
      if (process.platform !== "win32") {
        handle = await fs.promises.open(
          candidate,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY,
        );
        const opened = await handle.stat({ bigint: true });
        if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino) {
          throw new DomainError(
            "TEMPORARILY_UNAVAILABLE",
            "An abandoned backup work directory changed while it was opened.",
            503,
          );
        }
      }

      const quarantined = path.join(root, `.formaspec-orphan-cleanup-${randomUUID()}`);
      await fs.promises.rename(candidate, quarantined);
      const moved = await fs.promises.lstat(quarantined, { bigint: true });
      if (!moved.isDirectory() || moved.isSymbolicLink()
        || moved.dev !== before.dev || moved.ino !== before.ino) {
        throw new DomainError(
          "TEMPORARILY_UNAVAILABLE",
          "An abandoned backup work directory changed during cleanup.",
          503,
        );
      }
      await handle?.close();
      handle = undefined;
      await syncDirectory(root);
      await fs.promises.rm(quarantined, { recursive: true, force: false });
      await syncDirectory(root);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}

async function assertManagedBundlePath(
  backupDirectory: string,
  filename: string,
  expectedPath?: string,
): Promise<string> {
  if (path.basename(filename) !== filename || !managedBackupFilename.test(filename)) {
    throw new DomainError("VALIDATION_FAILED", "Managed backup filename is invalid.", 422);
  }
  const root = path.resolve(backupDirectory);
  const rootStat = await fs.promises.lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new DomainError("NOT_FOUND", "Managed backup directory is unavailable.", 404);
    throw error;
  });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new DomainError("VALIDATION_FAILED", "Managed backup directory is not a real directory.", 422);
  }
  const candidate = path.resolve(root, filename);
  if (path.dirname(candidate) !== root || (expectedPath && path.resolve(expectedPath) !== candidate)) {
    throw new DomainError("VALIDATION_FAILED", "Managed backup escaped its configured directory.", 422);
  }
  const stat = await fs.promises.lstat(candidate).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new DomainError("NOT_FOUND", "Managed backup bundle is unavailable.", 404);
    throw error;
  });
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new DomainError("VALIDATION_FAILED", "Managed backup bundle is not a regular file.", 422);
  }
  const [realRoot, realCandidate] = await Promise.all([
    fs.promises.realpath(root),
    fs.promises.realpath(candidate),
  ]);
  if (path.dirname(realCandidate) !== realRoot) {
    throw new DomainError("VALIDATION_FAILED", "Managed backup bundle escaped its configured directory.", 422);
  }
  return candidate;
}

function backupRecord(sqlite: DesignerDatabase["sqlite"], backupId: string): BackupRecordSnapshot {
  const row = sqlite.prepare(
    `SELECT id, organization_id, filename, bundle_sha256, status, manifest_json, created_by, created_at,
            verified_at, size_bytes, verification_json, retention_class, completed_at
     FROM backup_records WHERE id = ?`,
  ).get(backupId) as {
    id: string;
    organization_id: string;
    filename: string;
    bundle_sha256: string | null;
    status: string;
    manifest_json: string | null;
    created_by: string;
    created_at: string;
    verified_at: string | null;
    size_bytes: number | null;
    verification_json: string | null;
    retention_class: string;
    completed_at: string | null;
  } | undefined;
  if (!row) throw new DomainError("NOT_FOUND", "Backup record not found.", 404);
  if (!/^[a-f0-9]{64}$/.test(row.bundle_sha256 ?? "") || !["valid", "restored"].includes(row.status)) {
    throw new DomainError("VALIDATION_FAILED", "Backup record is not verified and restorable.", 409);
  }
  if (!new Set(["manual", "daily", "weekly", "monthly"]).has(row.retention_class)) {
    throw new DomainError("VALIDATION_FAILED", "Backup retention metadata is invalid.", 422);
  }
  return {
    id: backupIdSchema.parse(row.id),
    organizationId: row.organization_id,
    filename: row.filename,
    bundleSha256: row.bundle_sha256!,
    status: row.status as "valid" | "restored",
    manifestJson: row.manifest_json,
    createdBy: row.created_by,
    createdAt: row.created_at,
    verifiedAt: row.verified_at,
    sizeBytes: row.size_bytes,
    verificationJson: row.verification_json,
    retentionClass: row.retention_class as BackupRecordSnapshot["retentionClass"],
    completedAt: row.completed_at,
  };
}

async function verifyManagedBackupRecord(
  record: BackupRecordSnapshot,
  backupDirectory: string,
  rasterVerifier?: BackupRasterVerifier,
): Promise<VerifiedManagedBackup> {
  const bundlePath = await assertManagedBundlePath(backupDirectory, record.filename);
  const pinned = await verifyPinnedBackupBundle(bundlePath, {
    expectedSource: {
      sha256: record.bundleSha256,
      ...(record.sizeBytes === null ? {} : { sizeBytes: record.sizeBytes }),
    },
    sourcePinDirectory: backupDirectory,
    ...(rasterVerifier ? { rasterVerifier, requireRasterVerifier: true } : {}),
  });
  const verification = pinned.verification;
  if (record.manifestJson !== null) {
    let persisted: unknown;
    try {
      persisted = JSON.parse(record.manifestJson);
    } catch (error) {
      throw new DomainError("VALIDATION_FAILED", "Persisted backup manifest metadata is malformed.", 422, { cause: error });
    }
    if (canonicalSnapshot(persisted).canonicalJson !== canonicalSnapshot(verification.manifest).canonicalJson) {
      throw new DomainError("VALIDATION_FAILED", "Persisted backup manifest does not match the managed bundle.", 422);
    }
  }
  if (record.verificationJson !== null) {
    let persisted: unknown;
    try {
      persisted = JSON.parse(record.verificationJson);
    } catch (error) {
      throw new DomainError("VALIDATION_FAILED", "Persisted backup verification metadata is malformed.", 422, { cause: error });
    }
    if (canonicalSnapshot(persisted).canonicalJson !== canonicalSnapshot(verification).canonicalJson) {
      throw new DomainError("VALIDATION_FAILED", "Persisted backup verification does not match the managed bundle.", 422);
    }
  }
  return { record, bundlePath, sizeBytes: pinned.sizeBytes, verification };
}

async function resolveManagedBackup(
  sqlite: DesignerDatabase["sqlite"],
  backupDirectory: string,
  backupId: string,
  rasterVerifier?: BackupRasterVerifier,
): Promise<VerifiedManagedBackup> {
  return verifyManagedBackupRecord(backupRecord(sqlite, backupId), backupDirectory, rasterVerifier);
}

export async function runRestorePreflight(
  config: RestorePreflightConfig,
  dependencies: Pick<RestoreWorkerDependencies, "renderer"> = {},
): Promise<RestorePreflightResult> {
  const backupId = backupIdSchema.parse(config.backupId);
  const databasePath = path.resolve(config.databasePath);
  const databaseStat = await fs.promises.lstat(databasePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new DomainError("NOT_FOUND", "FormaSpec database is unavailable.", 404);
    throw error;
  });
  if (!databaseStat.isFile() || databaseStat.isSymbolicLink()) {
    throw new DomainError("VALIDATION_FAILED", "FormaSpec database is not a regular file.", 422);
  }

  let record: BackupRecordSnapshot;
  const sqlite = new SqliteDatabase(databasePath, { readonly: true, fileMustExist: true });
  try {
    sqlite.pragma("query_only = ON");
    if (sqlite.pragma("query_only", { simple: true }) !== 1) {
      throw new DomainError("TEMPORARILY_UNAVAILABLE", "Restore preflight database is not query-only.", 503);
    }
    record = backupRecord(sqlite, backupId);
  } finally {
    sqlite.close();
  }
  let renderer: RestoreWorkerRenderer | undefined;
  try {
    if (config.requireRasterVerifier || dependencies.renderer) {
      renderer = dependencies.renderer ?? createRenderer({
        renderSocket: config.renderSocket,
        renderTimeoutMs: config.renderTimeoutMs ?? 15_000,
        renderMaxPixels: config.renderMaxPixels ?? DEFAULT_RENDER_MAX_PIXELS,
        renderIpcMaxBytes: config.renderIpcMaxBytes ?? 96 * 1024 * 1024,
        allowSystemChrome: config.allowSystemChrome ?? false,
      });
    }
    const rasterVerifier = renderer ? backupRasterVerifier(renderer, {
      maxAssetBytes: config.maxAssetBytes ?? DEFAULT_MAX_ASSET_BYTES,
      maxAssetPixels: config.maxAssetPixels ?? DEFAULT_RENDER_MAX_PIXELS,
    }) : undefined;
    const verified = await verifyManagedBackupRecord(record, config.backupDirectory, rasterVerifier);
    if (!verified.verification) {
      throw new DomainError("INTERNAL_ERROR", "Restore preflight lost verification metadata.", 500);
    }
    await requireWholeRestoreCapacity(
      path.dirname(databasePath),
      config.backupDirectory,
      verified,
    );
    return {
      status: "verified",
      backupId: verified.record.id,
      organizationId: verified.record.organizationId,
      sizeBytes: verified.sizeBytes,
      databaseSchemaVersion: verified.verification.manifest.databaseSchemaVersion,
      documentSchemaVersion: verified.verification.manifest.documentSchemaVersion,
      createdAt: verified.verification.manifest.createdAt,
      entryCount: verified.verification.entryCount,
      extractedBytes: verified.verification.extractedBytes,
    };
  } finally {
    if (!dependencies.renderer) await renderer?.close().catch(() => undefined);
  }
}

function offlineBackupId(bundleSha256: string): string {
  return `backup_${createHash("sha256").update(`offline\0${bundleSha256}`).digest("hex").slice(0, 40)}`;
}

function offlineManagedFilename(bundleSha256: string): string {
  const decimal = BigInt(`0x${createHash("sha256").update(`target\0${bundleSha256}`).digest("hex").slice(0, 24)}`)
    .toString(10)
    .padStart(29, "0");
  return `formaspec-backup-1970-01-01T00-00-00-000Z-${decimal}.tar`;
}

async function digestFile(filename: string): Promise<{ sha256: string; sizeBytes: number }> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of fs.createReadStream(filename)) {
    const buffer = Buffer.from(chunk as Buffer | Uint8Array);
    sizeBytes += buffer.length;
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes > MAX_BACKUP_BUNDLE_BYTES) {
      throw new DomainError("PAYLOAD_TOO_LARGE", "Offline restore source exceeds its fixed limit.", 413);
    }
    hash.update(buffer);
  }
  return { sha256: hash.digest("hex"), sizeBytes };
}

async function receiveOfflineRestoreSource(
  input: Readable,
  backupDirectory: string,
  expected: { sha256: string; sizeBytes: number },
): Promise<{ path: string; release(): Promise<void> }> {
  const root = path.resolve(backupDirectory);
  const directory = path.join(root, `.offline-input-${randomUUID()}`);
  await fs.promises.mkdir(directory, { mode: 0o700 });
  const filename = path.join(directory, "bundle.tar");
  let output: fs.promises.FileHandle | undefined;
  try {
    output = await fs.promises.open(filename, "wx", 0o600);
    const hash = createHash("sha256");
    let sizeBytes = 0;
    for await (const chunk of input) {
      const buffer = Buffer.from(chunk as Buffer | Uint8Array | string);
      sizeBytes += buffer.length;
      if (!Number.isSafeInteger(sizeBytes) || sizeBytes > expected.sizeBytes
        || sizeBytes > MAX_BACKUP_BUNDLE_BYTES) {
        throw new DomainError("PAYLOAD_TOO_LARGE", "Offline restore input exceeded its authorized size.", 413);
      }
      hash.update(buffer);
      let written = 0;
      while (written < buffer.length) {
        const result = await output.write(buffer, written, buffer.length - written, sizeBytes - buffer.length + written);
        if (result.bytesWritten < 1) throw new Error("Offline restore input write made no progress.");
        written += result.bytesWritten;
      }
    }
    if (sizeBytes !== expected.sizeBytes || hash.digest("hex") !== expected.sha256) {
      throw new DomainError("VALIDATION_FAILED", "Offline restore input did not match its authorized hash and size.", 422);
    }
    await output.sync();
    await output.close();
    output = undefined;
    await fs.promises.chmod(filename, 0o400);
    return {
      path: filename,
      release: async () => fs.promises.rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await output?.close().catch(() => undefined);
    await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function requireOfflineReceiveCapacity(
  backupDirectory: string,
  expectedSizeBytes: number,
): Promise<void> {
  const root = path.resolve(backupDirectory);
  const [stat, filesystem] = await Promise.all([
    fs.promises.lstat(root),
    fs.promises.statfs(root, { bigint: true }),
  ]);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new DomainError("VALIDATION_FAILED", "Offline restore requires a real backup directory.", 422);
  }
  const required = BigInt(expectedSizeBytes) + BigInt(RESTORE_CAPACITY_RESERVE_BYTES);
  const available = filesystem.bavail * filesystem.bsize;
  if (available < required) {
    throw new DomainError(
      "TEMPORARILY_UNAVAILABLE",
      "Insufficient backup-volume capacity to receive the authorized offline restore source.",
      507,
      {
        retryable: true,
        details: {
          volume: "backup",
          availableBytes: boundedCapacityBytes(available),
          requiredBytes: boundedCapacityBytes(required),
        },
      },
    );
  }
}

async function retainOfflineTarget(
  stagedPath: string,
  backupDirectory: string,
  expected: { sha256: string; sizeBytes: number },
): Promise<{ path: string; filename: string }> {
  const root = path.resolve(backupDirectory);
  const filename = offlineManagedFilename(expected.sha256);
  const destination = path.join(root, filename);
  const existing = await fs.promises.lstat(destination).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new DomainError("VALIDATION_FAILED", "Offline restore target path is not a regular file.", 422);
    }
    const digest = await digestFile(destination);
    if (digest.sha256 !== expected.sha256 || digest.sizeBytes !== expected.sizeBytes) {
      throw new DomainError("IDEMPOTENCY_CONFLICT", "Offline restore target path already contains different bytes.", 409);
    }
    return { path: destination, filename };
  }
  await fs.promises.rename(stagedPath, destination);
  await fs.promises.chmod(destination, 0o400);
  await syncDirectory(root);
  return { path: destination, filename };
}

function bestEffortMonotonicFloor(databasePath: string): { auditEventId: number; outboxEventId: number } {
  let sqlite: SqliteDatabase.Database | undefined;
  try {
    const stat = fs.lstatSync(databasePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return { auditEventId: 0, outboxEventId: 0 };
    sqlite = new SqliteDatabase(databasePath, { readonly: true, fileMustExist: true });
    sqlite.pragma("query_only = ON");
    const readFloor = (table: "audit_events" | "event_outbox"): number => {
      const exists = sqlite!.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
      if (!exists) return 0;
      const row = sqlite!.prepare(`SELECT MAX(id) AS id FROM ${table}`).get() as { id: number | null };
      const hasSequence = sqlite!.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'").get();
      const sequence = hasSequence
        ? sqlite!.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?").get(table) as { seq: number } | undefined
        : undefined;
      return Math.max(row.id ?? 0, sequence?.seq ?? 0);
    };
    return { auditEventId: readFloor("audit_events"), outboxEventId: readFloor("event_outbox") };
  } catch {
    return { auditEventId: 0, outboxEventId: 0 };
  } finally {
    sqlite?.close();
  }
}

function offlinePreparationResult(
  state: Extract<RestoreOperationState, { phase: "prepared" }>,
): OfflineRestorePreparationResult {
  if (state.recovery?.mode !== "offline") {
    throw new DomainError("VERSION_CONFLICT", "Persisted restore state is not an offline recovery preparation.", 409);
  }
  return {
    status: "prepared",
    operationId: state.operationId,
    backupId: state.backupId,
    organizationId: state.target.organizationId,
    targetFilename: state.target.filename,
    targetSha256: state.target.bundleSha256,
    targetSizeBytes: state.target.sizeBytes,
    safetyBackupId: state.safety.id,
    safetyFilename: state.safety.filename,
    safetySha256: state.safety.bundleSha256,
    safetySizeBytes: state.safety.sizeBytes,
  };
}

export async function runOfflineRestorePreparation(
  config: OfflineRestorePreparationConfig,
  input: Readable,
  dependencies: Pick<RestoreWorkerDependencies, "renderer" | "now"> = {},
): Promise<OfflineRestorePreparationResult> {
  const maintenance = new MaintenanceStore(config.backupDirectory, config.dataDirectory);
  const operationStore = new RestoreOperationStore(config.backupDirectory);
  const lockStore = new RestoreWorkerLockStore(config.backupDirectory);
  const environmentContainerId = workerContainerIdSchema.safeParse(
    process.env.FORMASPEC_RESTORE_CONTAINER_ID ?? process.env.HOSTNAME,
  );
  const lease = await lockStore.acquire({
    operationId: config.operationId,
    ...(environmentContainerId.success ? { containerId: environmentContainerId.data } : {}),
  });
  let renderer: RestoreWorkerRenderer | undefined;
  let received: Awaited<ReturnType<typeof receiveOfflineRestoreSource>> | undefined;
  let forensicPredecessorOperationId: string | undefined;
  try {
    await requireMaintenance(maintenance, config.operationId, ["restore"]);
    const existing = await operationStore.read();
    if (existing !== null) {
      if (existing.operationId === config.operationId && existing.phase === "prepared"
        && existing.target.bundleSha256 === config.expectedSource.sha256
        && existing.target.sizeBytes === config.expectedSource.sizeBytes) {
        return offlinePreparationResult(existing);
      }
      if (existing.operationId !== config.operationId && existing.phase === "rolled_back"
        && existing.recovery?.mode === "offline") {
        forensicPredecessorOperationId = existing.operationId;
      } else {
        throw new DomainError("VERSION_CONFLICT", "A different restore operation is already prepared.", 409);
      }
    }
    await cleanupAbandonedBackupWorkDirectories(config.backupDirectory, { preserveRestoreSources: false });
    await requireOfflineReceiveCapacity(config.backupDirectory, config.expectedSource.sizeBytes);
    received = await receiveOfflineRestoreSource(input, config.backupDirectory, config.expectedSource);
    renderer = dependencies.renderer ?? createRenderer(config);
    const rasterVerifier = backupRasterVerifier(renderer, config);
    const inspection = await inspectBackupBundle(received.path, {
      rasterVerifier,
      requireRasterVerifier: true,
    });
    if (inspection.organizationIds.length < 1) {
      throw new DomainError("VALIDATION_FAILED", "Offline restore target has no organization.", 422);
    }
    const organizationId = inspection.organizationIds.includes("organization_legacy")
      ? "organization_legacy"
      : inspection.organizationIds[0]!;
    const targetId = offlineBackupId(config.expectedSource.sha256);
    const targetFilename = offlineManagedFilename(config.expectedSource.sha256);
    const now = dependencies.now ?? (() => new Date());
    const verifiedAt = now().toISOString();
    const targetRecord: BackupRecordSnapshot = {
      id: targetId,
      organizationId,
      filename: targetFilename,
      bundleSha256: config.expectedSource.sha256,
      status: "valid",
      manifestJson: JSON.stringify(inspection.verification.manifest),
      createdBy: SYSTEM_PRINCIPAL_ID,
      createdAt: inspection.verification.manifest.createdAt,
      verifiedAt,
      sizeBytes: config.expectedSource.sizeBytes,
      verificationJson: JSON.stringify(inspection.verification),
      retentionClass: "manual",
      completedAt: verifiedAt,
    };
    const target: VerifiedManagedBackup = {
      record: targetRecord,
      bundlePath: received.path,
      sizeBytes: config.expectedSource.sizeBytes,
      verification: inspection.verification,
    };
    await requireWholeRestoreCapacity(config.dataDirectory, config.backupDirectory, target);
    const retained = await retainOfflineTarget(received.path, config.backupDirectory, config.expectedSource);
    target.bundlePath = retained.path;
    const forensic = await createForensicRecoveryBundle(
      config.dataDirectory,
      config.backupDirectory,
      config.operationId,
      dependencies.now ?? (() => new Date()),
    );
    const safety: ForensicSafetyRecord = {
      id: safetyBackupId(forensic.filename, forensic.bundleSha256),
      organizationId,
      filename: forensic.filename,
      bundleSha256: forensic.bundleSha256,
      status: "valid",
      manifestJson: null,
      createdBy: SYSTEM_PRINCIPAL_ID,
      createdAt: forensic.createdAt,
      verifiedAt: forensic.createdAt,
      sizeBytes: forensic.sizeBytes,
      verificationJson: null,
      retentionClass: "manual",
      completedAt: forensic.createdAt,
    };
    if (safety.id === targetId) {
      throw new DomainError("IDEMPOTENCY_CONFLICT", "Offline target and forensic safety identifiers collided.", 409);
    }
    const timestamp = now().toISOString();
    const state = preparedOperationState(
      { operationId: config.operationId, backupId: targetId },
      target,
      safety,
      bestEffortMonotonicFloor(path.join(config.dataDirectory, "designer.sqlite")),
      timestamp,
      { mode: "offline", safetyKind: "forensic" },
    );
    if (forensicPredecessorOperationId) {
      await operationStore.archiveTerminal(forensicPredecessorOperationId);
    }
    await operationStore.write(state);
    return offlinePreparationResult(state);
  } finally {
    await received?.release().catch(() => undefined);
    if (!dependencies.renderer) await renderer?.close().catch(() => undefined);
    await lease.release();
  }
}

function safetyBackupId(filename: string, bundleSha256: string): string {
  return `backup_${createHash("sha256").update(`${filename}\0${bundleSha256}`).digest("hex").slice(0, 40)}`;
}

function insertBackupRecord(database: DesignerDatabase, record: BackupRecordSnapshot): void {
  database.sqlite.prepare(
    `INSERT INTO backup_records
     (id, organization_id, filename, bundle_sha256, status, manifest_json, created_by, created_at, verified_at,
      size_bytes, verification_json, retention_class, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       organization_id = excluded.organization_id,
       filename = excluded.filename,
       bundle_sha256 = excluded.bundle_sha256,
       status = excluded.status,
       manifest_json = excluded.manifest_json,
       created_by = excluded.created_by,
       created_at = excluded.created_at,
       verified_at = excluded.verified_at,
       size_bytes = excluded.size_bytes,
       verification_json = excluded.verification_json,
       retention_class = excluded.retention_class,
       completed_at = excluded.completed_at`,
  ).run(
    record.id,
    record.organizationId,
    record.filename,
    record.bundleSha256,
    record.status,
    record.manifestJson,
    record.createdBy,
    record.createdAt,
    record.verifiedAt,
    record.sizeBytes,
    record.verificationJson,
    record.retentionClass,
    record.completedAt,
  );
}

async function existingSafetyBackup(
  database: DesignerDatabase,
  config: RestoreWorkerConfig,
  target: VerifiedManagedBackup,
  rasterVerifier: BackupRasterVerifier,
): Promise<SafetyBackupRecord | null> {
  const audit = database.sqlite.prepare(
    `SELECT details_json FROM audit_events
     WHERE organization_id = ? AND action = 'backup.pre_restore_create'
       AND json_extract(details_json, '$.operationId') = ?
       AND json_extract(details_json, '$.targetBackupId') = ?
     ORDER BY id DESC LIMIT 1`,
  ).get(target.record.organizationId, config.operationId, target.record.id) as { details_json: string } | undefined;
  if (!audit) return null;
  const details = JSON.parse(audit.details_json) as Record<string, unknown>;
  const safetyId = backupIdSchema.safeParse(details.safetyBackupId);
  if (!safetyId.success) {
    throw new DomainError("VALIDATION_FAILED", "Persisted pre-restore audit is invalid.", 422);
  }
  const record = backupRecord(database.sqlite, safetyId.data);
  if (record.status !== "valid" || record.retentionClass !== "manual"
    || record.organizationId !== target.record.organizationId) {
    throw new DomainError("VALIDATION_FAILED", "Persisted safety backup is not reusable.", 422);
  }
  const verified = await verifyManagedBackupRecord(record, config.backupDirectory, rasterVerifier);
  if (!verified.verification) {
    throw new DomainError("INTERNAL_ERROR", "Safety backup verification metadata is missing.", 500);
  }
  const timestamp = record.verifiedAt ?? record.completedAt ?? verified.verification.manifest.createdAt;
  return {
    ...record,
    status: "valid",
    retentionClass: "manual",
    manifestJson: JSON.stringify(verified.verification.manifest),
    verifiedAt: timestamp,
    sizeBytes: verified.sizeBytes,
    verificationJson: JSON.stringify(verified.verification),
    completedAt: record.completedAt ?? timestamp,
  };
}

async function createSafetyBackup(
  database: DesignerDatabase,
  config: RestoreWorkerConfig,
  target: VerifiedManagedBackup,
  now: Date,
  rasterVerifier: BackupRasterVerifier,
): Promise<SafetyBackupRecord> {
  const existing = await existingSafetyBackup(database, config, target, rasterVerifier);
  if (existing) return existing;
  const created = await new BackupManager(
    database,
    config.dataDirectory,
    config.backupDirectory,
    rasterVerifier,
  ).create();
  const filename = path.basename(created.path);
  const bundlePath = await assertManagedBundlePath(config.backupDirectory, filename, created.path);
  const pinned = await verifyPinnedBackupBundle(bundlePath, {
    sourcePinDirectory: config.backupDirectory,
    rasterVerifier,
    requireRasterVerifier: true,
  });
  const id = safetyBackupId(filename, pinned.bundleSha256);
  if (id === target.record.id) throw new DomainError("IDEMPOTENCY_CONFLICT", "Safety backup collided with the restore target.", 409);
  const verifiedAt = now.toISOString();
  const record: SafetyBackupRecord = {
    id,
    organizationId: target.record.organizationId,
    filename,
    bundleSha256: pinned.bundleSha256,
    status: "valid",
    manifestJson: JSON.stringify(pinned.verification.manifest),
    createdBy: SYSTEM_PRINCIPAL_ID,
    createdAt: pinned.verification.manifest.createdAt,
    verifiedAt,
    sizeBytes: pinned.sizeBytes,
    verificationJson: JSON.stringify(pinned.verification),
    retentionClass: "manual",
    completedAt: verifiedAt,
  };
  const transaction = database.sqlite.transaction(() => {
    insertBackupRecord(database, record);
    appendAuditEvent(database.sqlite, systemAccess(record.organizationId), "backup.pre_restore_create", "backup", id, {
      operationId: config.operationId,
      targetBackupId: target.record.id,
      safetyBackupId: id,
      sizeBytes: pinned.sizeBytes,
    });
  });
  transaction.immediate();
  return record;
}

async function verifiedBackupsFromState(
  state: RestoreOperationState,
  config: Pick<RestoreWorkerConfig, "backupDirectory" | "dataDirectory">,
  rasterVerifier: BackupRasterVerifier,
): Promise<{ target: VerifiedManagedBackup; safety: RestoreSafetyRecord }> {
  const targetRecord = recordFromOperationState(state.target, "valid");
  const sourceIndependent = state.phase === "cutover_committed"
    || state.phase === "reconciled"
    || (state.phase === "prepared"
      && await committedRestoreJournalMatches(config.dataDirectory, state.target.bundleSha256));
  const target = sourceIndependent
    ? {
      record: targetRecord,
      bundlePath: path.join(path.resolve(config.backupDirectory), state.target.filename),
      sizeBytes: state.target.sizeBytes,
      verification: null,
    }
    : await verifyManagedBackupRecord(targetRecord, config.backupDirectory, rasterVerifier);
  let safety: RestoreSafetyRecord;
  if (state.recovery?.mode === "offline") {
    const safetyPath = await assertManagedBundlePath(config.backupDirectory, state.safety.filename);
    const verified = await verifyPinnedForensicRecoveryBundle(safetyPath, {
      expectedSource: {
        sha256: state.safety.bundleSha256,
        sizeBytes: state.safety.sizeBytes,
      },
      sourcePinDirectory: config.backupDirectory,
      expectedOperationId: state.operationId,
    });
    safety = {
      ...recordFromOperationState(state.safety, "valid"),
      status: "valid",
      retentionClass: "manual",
      manifestJson: null,
      verifiedAt: state.safety.createdAt,
      sizeBytes: verified.sizeBytes,
      verificationJson: null,
      completedAt: state.safety.createdAt,
    };
  } else {
    const verifiedSafety = await verifyManagedBackupRecord(
      recordFromOperationState(state.safety, "valid"),
      config.backupDirectory,
      rasterVerifier,
    );
    if (!verifiedSafety.verification) {
      throw new DomainError("INTERNAL_ERROR", "Persisted safety backup verification metadata is missing.", 500);
    }
    safety = {
      ...verifiedSafety.record,
      status: "valid",
      retentionClass: "manual",
      manifestJson: JSON.stringify(verifiedSafety.verification.manifest),
      verifiedAt: state.safety.createdAt,
      sizeBytes: verifiedSafety.sizeBytes,
      verificationJson: JSON.stringify(verifiedSafety.verification),
      completedAt: state.safety.createdAt,
    };
  }
  return { target, safety };
}

async function requireMaintenance(
  store: MaintenanceStore,
  operationId: string,
  allowedPhases: Array<"restore" | "verification" | "rollback">,
): Promise<Extract<MaintenanceStatus, { active: true; markerValid: true }>> {
  const status = await store.read();
  if (!status.active || !status.markerValid) {
    throw new DomainError("TEMPORARILY_UNAVAILABLE", "A valid active maintenance marker is required.", 503);
  }
  if (status.operationId !== operationId || !allowedPhases.includes(status.phase as never)) {
    throw new DomainError("VERSION_CONFLICT", "Maintenance operation does not match this restore worker.", 409, {
      details: { phase: status.phase },
    });
  }
  return status;
}

function requireMatchingOperationState(state: RestoreOperationState, config: RestoreWorkerConfig): void {
  if (state.operationId !== config.operationId || state.backupId !== config.backupId
    || state.target.id !== config.backupId || state.safety.id === state.target.id) {
    throw new DomainError("VERSION_CONFLICT", "Persisted restore operation does not match this worker request.", 409);
  }
}

async function setMaintenancePhase(
  store: MaintenanceStore,
  operationId: string,
  phase: "verification" | "rollback",
): Promise<void> {
  const status = await requireMaintenance(store, operationId, ["restore", "verification", "rollback"]);
  await store.write({
    schemaVersion: 1,
    active: true,
    phase,
    operationId,
    startedAt: status.startedAt,
  });
}

function assetDataUrl(database: DesignerDatabase, assetId: string): string | null {
  const row = database.sqlite.prepare(
    "SELECT mime_type, size_bytes, sha256, data FROM assets WHERE id = ?",
  ).get(assetId) as { mime_type: string; size_bytes: number; sha256: string; data: Buffer | Uint8Array } | undefined;
  if (!row) throw new DomainError("VALIDATION_FAILED", "Representative render references a missing asset.", 422);
  if (!new Set(["image/png", "image/jpeg", "image/webp"]).has(row.mime_type)
    || !/^[a-f0-9]{64}$/.test(row.sha256)) {
    throw new DomainError("VALIDATION_FAILED", "Representative render asset metadata is invalid.", 422);
  }
  const data = Buffer.from(row.data);
  if (data.length !== row.size_bytes || createHash("sha256").update(data).digest("hex") !== row.sha256) {
    throw new DomainError("VALIDATION_FAILED", "Representative render asset bytes failed integrity validation.", 422);
  }
  return `data:${row.mime_type};base64,${data.toString("base64")}`;
}

async function restoredHealthCheck(
  config: RestoreWorkerConfig,
  restoredDataDirectory: string,
  organizationId: string,
  maintenance: MaintenanceStore,
  renderer: RestoreWorkerRenderer,
): Promise<RestoreSmokeResult> {
  if (path.resolve(restoredDataDirectory) !== config.dataDirectory) {
    throw new DomainError("VALIDATION_FAILED", "Restore health check received an unexpected data directory.", 422);
  }
  await setMaintenancePhase(maintenance, config.operationId, "verification");
  let database: DesignerDatabase | undefined;
  try {
    database = new DesignerDatabase(config.databasePath);
    const integrity = database.sqlite.pragma("integrity_check", { simple: true }) as string;
    if (integrity !== "ok") throw new DomainError("VALIDATION_FAILED", "Restored SQLite integrity check failed.", 422);
    const foreignKeys = database.sqlite.pragma("foreign_key_check") as unknown[];
    if (foreignKeys.length > 0) {
      throw new DomainError("VALIDATION_FAILED", "Restored database has foreign-key violations.", 422, {
        details: { count: foreignKeys.length },
      });
    }
    const ledger = database.sqlite.prepare(
      "SELECT version, name FROM schema_migrations ORDER BY version",
    ).all() as Array<{ version: unknown; name: unknown }>;
    const schemaVersion = validateDatabaseMigrationLedger(ledger);
    if (schemaVersion !== DATABASE_SCHEMA_VERSION || database.schemaVersion() !== DATABASE_SCHEMA_VERSION) {
      throw new DomainError("VALIDATION_FAILED", "Restored database migrations did not reach the current schema.", 422);
    }
    const organization = database.sqlite.prepare("SELECT id FROM organizations WHERE id = ?").get(organizationId);
    if (!organization) throw new DomainError("VALIDATION_FAILED", "Restore target organization is missing.", 422);

    const rendererHealth = await renderer.health();
    if (!rendererHealth.ok || rendererHealth.softwareFallback || rendererHealth.renderer !== "playwright") {
      throw new DomainError("RENDER_FAILED", "Restore verification requires the deterministic Chromium renderer.", 503);
    }
    const representative = database.sqlite.prepare(
      `SELECT d.id AS design_id, r.document_json
       FROM designs d JOIN revisions r ON r.id = d.current_revision_id AND r.design_id = d.id
       WHERE d.organization_id = ?
       ORDER BY d.updated_at DESC, d.id LIMIT 1`,
    ).get(organizationId) as { design_id: string; document_json: string } | undefined;
    if (representative) {
      const document = AnyDesignDocumentSchema.parse(JSON.parse(representative.document_json));
      const rendered = await renderer.render(document, { maxSize: 512 }, (assetId) => assetDataUrl(database!, assetId));
      if (!rendered.png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        || rendered.width < 1 || rendered.height < 1 || rendered.renderer !== "playwright") {
        throw new DomainError("RENDER_FAILED", "Representative restore render was invalid.", 503);
      }
      return { schemaVersion, renderedDesignId: representative.design_id };
    }
    return { schemaVersion, renderedDesignId: null };
  } finally {
    if (database) {
      try {
        database.sqlite.pragma("wal_checkpoint(TRUNCATE)");
      } finally {
        database.close();
      }
    }
  }
}

function monotonicIdFloor(database: DesignerDatabase, table: "audit_events" | "event_outbox"): number {
  const row = database.sqlite.prepare(`SELECT MAX(id) AS id FROM ${table}`).get() as { id: number | null };
  const sequence = database.sqlite.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?").get(table) as {
    seq: number;
  } | undefined;
  return Math.max(row.id ?? 0, sequence?.seq ?? 0);
}

function ensureSequenceAtLeast(
  database: DesignerDatabase,
  table: "audit_events" | "event_outbox",
  minimum: number,
): void {
  const current = database.sqlite.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?").get(table) as {
    seq: number;
  } | undefined;
  if ((current?.seq ?? 0) >= minimum) return;
  if (current) database.sqlite.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = ?").run(minimum, table);
  else database.sqlite.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)").run(table, minimum);
}

function activeAgentCredentialCounts(database: DesignerDatabase): {
  grants: number;
  connections: number;
  nonces: number;
} {
  return {
    grants: (database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM agent_grants WHERE revoked_at IS NULL",
    ).get() as { count: number }).count,
    connections: (database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM agent_connections WHERE status <> 'revoked'",
    ).get() as { count: number }).count,
    nonces: (database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM pairing_nonces WHERE revoked_at IS NULL",
    ).get() as { count: number }).count,
  };
}

function requireAllAgentCredentialsRevoked(database: DesignerDatabase): void {
  const remainingActive = activeAgentCredentialCounts(database);
  if (remainingActive.grants === 0
    && remainingActive.connections === 0
    && remainingActive.nonces === 0) return;
  throw new DomainError(
    "VALIDATION_FAILED",
    "Restored agent access could not be revoked completely; reconciliation was rolled back.",
    422,
    { details: { remainingActive } },
  );
}

function rollbackJournalProvesCompletion(dataDirectory: string, bundleSha256: string): boolean {
  const filename = path.join(dataDirectory, ".formaspec-restore-journal", "journal.json");
  try {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > RESTORE_JOURNAL_MAX_BYTES) return false;
    const parsed = JSON.parse(fs.readFileSync(filename, "utf8")) as Record<string, unknown>;
    return parsed.format === "formaspec-restore-journal"
      && parsed.version === 1
      && parsed.phase === "rolled-back"
      && parsed.sourceBundleSha256 === bundleSha256;
  } catch {
    return false;
  }
}

function verifySafetyRecord(database: DesignerDatabase, safety: SafetyBackupRecord): void {
  const row = database.sqlite.prepare(
    "SELECT bundle_sha256, status, retention_class FROM backup_records WHERE id = ?",
  ).get(safety.id) as { bundle_sha256: string; status: string; retention_class: string } | undefined;
  if (!row || row.bundle_sha256 !== safety.bundleSha256 || row.status !== "valid" || row.retention_class !== "manual") {
    throw new DomainError("INTERNAL_ERROR", "Rollback did not restore the verified safety-backup record.", 500);
  }
}

async function appendRollbackAudit(
  config: RestoreWorkerConfig,
  target: VerifiedManagedBackup,
  safety: RestoreSafetyRecord,
  error: unknown,
  maintenance: MaintenanceStore,
  operationStore: RestoreOperationStore,
  operationState: RestoreOperationState,
  recordedAt: string,
): Promise<void> {
  if (operationState.recovery?.mode === "offline") {
    let database: DesignerDatabase | undefined;
    try {
      database = new DesignerDatabase(config.databasePath);
      const organization = database.sqlite.prepare("SELECT id FROM organizations WHERE id = ?")
        .get(target.record.organizationId);
      if (organization) {
        const transaction = database.sqlite.transaction(() => {
          appendAuditEvent(database!.sqlite, systemAccess(target.record.organizationId), "backup.restore_rolled_back", "backup", target.record.id, {
            operationId: config.operationId,
            targetBackupId: target.record.id,
            safetyBackupId: safety.id,
            safetyKind: "forensic",
            errorCode: errorCode(error),
          });
        });
        transaction.immediate();
        database.sqlite.pragma("wal_checkpoint(TRUNCATE)");
      }
    } catch {
      // The exact pre-restore bytes may intentionally contain a corrupt
      // database. Durable operation/maintenance state remains the recovery
      // audit source when an application audit row cannot be appended.
    } finally {
      database?.close();
    }
    await operationStore.write(rolledBackOperationState(operationState, errorCode(error), recordedAt));
    await setMaintenancePhase(maintenance, config.operationId, "rollback");
    return;
  }
  let database: DesignerDatabase | undefined;
  try {
    database = new DesignerDatabase(config.databasePath);
    if (safety.manifestJson === null) {
      throw new DomainError("INTERNAL_ERROR", "Verified restore rollback lost its safety-backup metadata.", 500);
    }
    verifySafetyRecord(database, safety);
    const transaction = database.sqlite.transaction(() => {
      appendAuditEvent(database!.sqlite, systemAccess(target.record.organizationId), "backup.restore_rolled_back", "backup", target.record.id, {
        operationId: config.operationId,
        targetBackupId: target.record.id,
        safetyBackupId: safety.id,
        errorCode: errorCode(error),
      });
    });
    transaction.immediate();
    database.sqlite.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    database?.close();
  }
  await operationStore.write(rolledBackOperationState(operationState, errorCode(error), recordedAt));
  await setMaintenancePhase(maintenance, config.operationId, "rollback");
}

function existingReconciliation(
  database: DesignerDatabase,
  config: RestoreWorkerConfig,
  target: VerifiedManagedBackup,
  safety: RestoreSafetyRecord,
  smoke: RestoreSmokeResult,
): Omit<RestoreWorkerResult, "status" | "backupId" | "operationId" | "safetyBackupId" | "maintenancePhase"> | null {
  const audit = database.sqlite.prepare(
    `SELECT id, details_json FROM audit_events
     WHERE organization_id = ? AND action = 'backup.restore_commit'
       AND json_extract(details_json, '$.operationId') = ?
     ORDER BY id DESC LIMIT 1`,
  ).get(target.record.organizationId, config.operationId) as { id: number; details_json: string } | undefined;
  if (!audit) return null;
  const details = JSON.parse(audit.details_json) as Record<string, unknown>;
  const counts = [details.revokedGrants, details.revokedConnections, details.revokedNonces];
  if (details.targetBackupId !== target.record.id || details.safetyBackupId !== safety.id
    || details.schemaVersion !== smoke.schemaVersion
    || !counts.every((value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) {
    throw new DomainError("VALIDATION_FAILED", "Persisted restore reconciliation audit is invalid.", 422);
  }
  const outbox = database.sqlite.prepare(
    `SELECT id FROM event_outbox
     WHERE event_type = 'backup.operation' AND json_extract(payload_json, '$.auditEventId') = ?`,
  ).get(audit.id) as { id: number } | undefined;
  if (!outbox) throw new DomainError("INTERNAL_ERROR", "Persisted restore audit is missing its outbox event.", 500);
  return {
    auditEventId: audit.id,
    outboxEventId: outbox.id,
    schemaVersion: smoke.schemaVersion,
    renderedDesignId: smoke.renderedDesignId,
    revoked: {
      grants: details.revokedGrants as number,
      connections: details.revokedConnections as number,
      nonces: details.revokedNonces as number,
    },
  };
}

function reconcileAfterRestore(
  config: RestoreWorkerConfig,
  target: VerifiedManagedBackup,
  safety: RestoreSafetyRecord,
  smoke: RestoreSmokeResult,
  monotonicFloor: { auditEventId: number; outboxEventId: number },
  now: Date,
): Omit<RestoreWorkerResult, "status" | "backupId" | "operationId" | "safetyBackupId" | "maintenancePhase"> {
  const database = new DesignerDatabase(config.databasePath);
  try {
    const existing = existingReconciliation(database, config, target, safety, smoke);
    if (existing) {
      if (existing.auditEventId <= monotonicFloor.auditEventId || existing.outboxEventId <= monotonicFloor.outboxEventId) {
        throw new DomainError("INTERNAL_ERROR", "Persisted restore audit identifiers are not monotonic.", 500);
      }
      return existing;
    }
    const completedAt = now.toISOString();
    const restoredTarget: BackupRecordSnapshot = {
      ...target.record,
      status: "restored",
      manifestJson: target.verification ? JSON.stringify(target.verification.manifest) : null,
      verifiedAt: completedAt,
      sizeBytes: target.sizeBytes,
      verificationJson: target.verification ? JSON.stringify(target.verification) : null,
      completedAt,
    };
    let result: Omit<RestoreWorkerResult, "status" | "backupId" | "operationId" | "safetyBackupId" | "maintenancePhase"> | undefined;
    const transaction = database.sqlite.transaction(() => {
      const organization = database.sqlite.prepare("SELECT id FROM organizations WHERE id = ?")
        .get(target.record.organizationId);
      if (!organization) throw new DomainError("VALIDATION_FAILED", "Restore target organization is missing.", 422);
      ensureSequenceAtLeast(database, "audit_events", monotonicFloor.auditEventId);
      ensureSequenceAtLeast(database, "event_outbox", monotonicFloor.outboxEventId);
      insertBackupRecord(database, restoredTarget);
      if (safety.manifestJson !== null) insertBackupRecord(database, safety);
      const grants = database.sqlite.prepare(
        "UPDATE agent_grants SET revoked_at = COALESCE(revoked_at, ?) WHERE revoked_at IS NULL",
      ).run(completedAt).changes;
      const connections = database.sqlite.prepare(
        "UPDATE agent_connections SET status = 'revoked', updated_at = ? WHERE status <> 'revoked'",
      ).run(completedAt).changes;
      const nonces = database.sqlite.prepare(
        "UPDATE pairing_nonces SET revoked_at = COALESCE(revoked_at, ?) WHERE revoked_at IS NULL",
      ).run(completedAt).changes;
      requireAllAgentCredentialsRevoked(database);
      const auditEventId = appendAuditEvent(
        database.sqlite,
        systemAccess(target.record.organizationId),
        "backup.restore_commit",
        "backup",
        target.record.id,
        {
          operationId: config.operationId,
          targetBackupId: target.record.id,
          safetyBackupId: safety.id,
          safetyKind: safety.manifestJson === null ? "forensic" : "verified",
          schemaVersion: smoke.schemaVersion,
          renderedDesignId: smoke.renderedDesignId,
          revokedGrants: grants,
          revokedConnections: connections,
          revokedNonces: nonces,
        },
      );
      const outbox = database.sqlite.prepare(
        `SELECT id FROM event_outbox
         WHERE event_type = 'backup.operation' AND json_extract(payload_json, '$.auditEventId') = ?`,
      ).get(auditEventId) as { id: number } | undefined;
      if (!outbox) throw new DomainError("INTERNAL_ERROR", "Restore audit event did not enter the durable outbox.", 500);
      if (auditEventId <= monotonicFloor.auditEventId || outbox.id <= monotonicFloor.outboxEventId) {
        throw new DomainError("INTERNAL_ERROR", "Restore audit identifiers were not monotonic across cutover.", 500);
      }
      // The restored database may contain hostile audit/outbox triggers. Make
      // this the final database check in the transaction so a trigger cannot
      // reactivate credentials after the initial revocation and still commit.
      requireAllAgentCredentialsRevoked(database);
      result = {
        auditEventId,
        outboxEventId: outbox.id,
        schemaVersion: smoke.schemaVersion,
        renderedDesignId: smoke.renderedDesignId,
        revoked: { grants, connections, nonces },
      };
    });
    transaction.immediate();
    database.sqlite.pragma("wal_checkpoint(TRUNCATE)");
    if (!result) throw new DomainError("INTERNAL_ERROR", "Restore reconciliation did not complete.", 500);
    return result;
  } finally {
    database.close();
  }
}

type RestoreRendererConfig = Pick<
  RestoreWorkerConfig,
  "renderSocket" | "renderTimeoutMs" | "renderMaxPixels" | "renderIpcMaxBytes" | "allowSystemChrome"
>;

function createRenderer(config: RestoreRendererConfig): RestoreWorkerRenderer {
  return new PngRenderer({
    timeoutMs: config.renderTimeoutMs,
    maxPixels: config.renderMaxPixels,
    concurrency: 1,
    queueLimit: 1,
    allowSoftwareFallback: false,
    allowSystemChrome: config.allowSystemChrome,
    ...(config.renderSocket ? { socketPath: config.renderSocket } : {}),
    ipcMaxMessageBytes: config.renderIpcMaxBytes,
  });
}

function backupRasterVerifier(
  renderer: RestoreWorkerRenderer,
  limits: Pick<RestoreWorkerConfig, "maxAssetBytes" | "maxAssetPixels">,
  onUse?: () => void,
): BackupRasterVerifier {
  return {
    engine: {
      async normalizeRaster(data, options) {
        onUse?.();
        return renderer.normalizeRaster(data, options);
      },
    },
    limits: {
      maxBytes: limits.maxAssetBytes,
      maxPixels: limits.maxAssetPixels,
    },
  };
}

async function runRestoreWorkerWithLockHeld(
  config: RestoreWorkerConfig,
  dependencies: RestoreWorkerDependencies = {},
): Promise<RestoreWorkerResult> {
  backupIdSchema.parse(config.backupId);
  operationIdSchema.parse(config.operationId);
  const maintenance = new MaintenanceStore(config.backupDirectory, config.dataDirectory);
  const operationStore = new RestoreOperationStore(config.backupDirectory);
  const maintenanceStatus = await requireMaintenance(
    maintenance,
    config.operationId,
    ["restore", "verification", "rollback"],
  );
  const now = dependencies.now ?? (() => new Date());
  let operationState = await operationStore.read();
  if (operationState) requireMatchingOperationState(operationState, config);
  await cleanupAbandonedBackupWorkDirectories(config.backupDirectory, {
    // A crashed pin can be the only remaining copy of the requested source.
    // Preserve every exact restore-source directory until the durable active
    // operation reaches a terminal state; verification/staging leftovers are
    // still safe to remove under the exclusive worker lock.
    preserveRestoreSources: operationState?.phase === "prepared"
      || operationState?.phase === "cutover_committed",
  });
  if (!operationState && maintenanceStatus.phase !== "restore") {
    throw new DomainError("VERSION_CONFLICT", "Restore operation state is missing for the active maintenance phase.", 409);
  }
  if (operationState?.phase === "rolled_back") {
    throw new DomainError("VERSION_CONFLICT", "This restore operation already rolled back and requires supervisor review.", 409, {
      details: { errorCode: operationState.errorCode },
    });
  }
  if (operationState?.phase === "reconciled") {
    await requireMaintenance(maintenance, config.operationId, ["verification"]);
    return {
      status: "restored",
      backupId: config.backupId,
      operationId: config.operationId,
      safetyBackupId: operationState.safety.id,
      auditEventId: operationState.result.auditEventId,
      outboxEventId: operationState.result.outboxEventId,
      schemaVersion: operationState.smoke.schemaVersion,
      renderedDesignId: operationState.smoke.renderedDesignId,
      revoked: operationState.result.revoked,
      maintenancePhase: "verification",
    };
  }
  let renderer: RestoreWorkerRenderer | undefined;
  let rendererUsed = false;
  let database: DesignerDatabase | undefined;
  let target: VerifiedManagedBackup | undefined;
  let safety: RestoreSafetyRecord | undefined;
  try {
    renderer = dependencies.renderer ?? createRenderer(config);
    const rasterVerifier = backupRasterVerifier(renderer, config, () => {
      rendererUsed = true;
    });
    if (operationState) {
      ({ target, safety } = await verifiedBackupsFromState(operationState, config, rasterVerifier));
    } else {
      database = new DesignerDatabase(config.databasePath);
      target = await resolveManagedBackup(
        database.sqlite,
        config.backupDirectory,
        config.backupId,
        rasterVerifier,
      );
      safety = await createSafetyBackup(database, config, target, now(), rasterVerifier);
      await dependencies.afterSafetyBackup?.();
      const stateTimestamp = now().toISOString();
      operationState = preparedOperationState(config, target, safety, {
        auditEventId: monotonicIdFloor(database, "audit_events"),
        outboxEventId: monotonicIdFloor(database, "event_outbox"),
      }, stateTimestamp);
      await operationStore.write(operationState);
      await requireMaintenance(maintenance, config.operationId, ["restore"]);
      database.sqlite.pragma("wal_checkpoint(TRUNCATE)");
      database.close();
      database = undefined;
    }

    if (operationState.phase === "prepared") {
      await requireMaintenance(maintenance, config.operationId, ["restore", "verification"]);
      let smoke: RestoreSmokeResult | undefined;
      try {
        rendererUsed = true;
        await restoreVerifiedBackup(target.bundlePath, config.dataDirectory, {
          databaseClosed: true,
          expectedSource: {
            sha256: target.record.bundleSha256,
            sizeBytes: target.sizeBytes,
          },
          sourcePinDirectory: config.backupDirectory,
          rasterVerifier,
          requireRasterVerifier: true,
          healthCheck: async (restoredDataDirectory) => {
            rendererUsed = true;
            smoke = await restoredHealthCheck(
              config,
              restoredDataDirectory,
              target!.record.organizationId,
              maintenance,
              renderer!,
            );
          },
        });
      } catch (error) {
        if (rollbackJournalProvesCompletion(config.dataDirectory, target.record.bundleSha256)) {
          try {
            await appendRollbackAudit(
              config,
              target,
              safety,
              error,
              maintenance,
              operationStore,
              operationState,
              now().toISOString(),
            );
          } catch (auditError) {
            throw new AggregateError([error, auditError], "Restore rolled back but rollback auditing failed.");
          }
        }
        throw error;
      }
      if (!smoke) throw new DomainError("INTERNAL_ERROR", "Restore completed without health-check evidence.", 500);
      operationState = cutoverCommittedState(operationState, smoke, now().toISOString());
      await operationStore.write(operationState);
      await dependencies.afterCutover?.();
    }

    if (operationState.phase !== "cutover_committed") {
      throw new DomainError("INTERNAL_ERROR", "Restore operation did not reach reconciliation.", 500);
    }
    await requireMaintenance(maintenance, config.operationId, ["verification"]);
    const reconciled = reconcileAfterRestore(
      config,
      target,
      safety,
      operationState.smoke,
      operationState.monotonicFloor,
      now(),
    );
    operationState = reconciledOperationState(
      operationState,
      operationState.smoke,
      {
        auditEventId: reconciled.auditEventId,
        outboxEventId: reconciled.outboxEventId,
        revoked: reconciled.revoked,
      },
      now().toISOString(),
    );
    await operationStore.write(operationState);
    return {
      status: "restored",
      backupId: config.backupId,
      operationId: config.operationId,
      safetyBackupId: safety.id,
      ...reconciled,
      maintenancePhase: "verification",
    };
  } finally {
    database?.close();
    if (rendererUsed) await renderer?.close().catch(() => undefined);
  }
}

export async function runRestoreWorker(
  config: RestoreWorkerConfig,
  dependencies: RestoreWorkerDependencies = {},
): Promise<RestoreWorkerResult> {
  backupIdSchema.parse(config.backupId);
  operationIdSchema.parse(config.operationId);
  const environmentContainerId = workerContainerIdSchema.safeParse(
    process.env.FORMASPEC_RESTORE_CONTAINER_ID ?? process.env.HOSTNAME,
  );
  const containerId = config.containerId
    ?? (environmentContainerId.success ? environmentContainerId.data : undefined);
  const lockStore = new RestoreWorkerLockStore(config.backupDirectory);
  const lease = await lockStore.acquire({
    operationId: config.operationId,
    ...(containerId ? { containerId } : {}),
  });
  let primaryError: unknown;
  try {
    await dependencies.afterLockAcquired?.();
    return await runRestoreWorkerWithLockHeld(config, dependencies);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await lease.release();
    } catch (releaseError) {
      if (primaryError !== undefined) {
        throw new AggregateError(
          [primaryError, releaseError],
          "Restore worker failed and its shared lock could not be released safely.",
        );
      }
      throw releaseError;
    }
  }
}

export async function runForensicRollback(
  config: ForensicRollbackConfig,
): Promise<ForensicRollbackResult> {
  const maintenance = new MaintenanceStore(config.backupDirectory, config.dataDirectory);
  const operationStore = new RestoreOperationStore(config.backupDirectory);
  const lockStore = new RestoreWorkerLockStore(config.backupDirectory);
  const environmentContainerId = workerContainerIdSchema.safeParse(
    config.containerId ?? process.env.FORMASPEC_RESTORE_CONTAINER_ID ?? process.env.HOSTNAME,
  );
  const lease = await lockStore.acquire({
    operationId: config.operationId,
    ...(environmentContainerId.success ? { containerId: environmentContainerId.data } : {}),
  });
  try {
    await requireMaintenance(maintenance, config.operationId, ["restore", "rollback"]);
    const state = await operationStore.read();
    if (!state || state.operationId !== config.operationId || state.phase !== "reconciled"
      || state.recovery?.mode !== "offline") {
      throw new DomainError("VERSION_CONFLICT", "A reconciled offline restore is required for forensic rollback.", 409);
    }
    const safetyPath = await assertManagedBundlePath(config.backupDirectory, state.safety.filename);
    try {
      await verifyPinnedForensicRecoveryBundle(safetyPath, {
        expectedSource: {
          sha256: state.safety.bundleSha256,
          sizeBytes: state.safety.sizeBytes,
        },
        sourcePinDirectory: config.backupDirectory,
        expectedOperationId: config.operationId,
      });
      await restoreVerifiedBackup(safetyPath, config.dataDirectory, {
        databaseClosed: true,
        expectedSource: {
          sha256: state.safety.bundleSha256,
          sizeBytes: state.safety.sizeBytes,
        },
        sourcePinDirectory: config.backupDirectory,
        sourceFormat: "forensic-recovery",
        expectedForensicOperationId: config.operationId,
      });
    } catch (error) {
      const journal = await inspectRestoreJournal(config.dataDirectory);
      if (journal.present && journal.phase === "committed") {
        await finalizeTerminalRestoreJournal(config.dataDirectory, "committed");
      } else if (journal.present && journal.phase === "rolled-back") {
        await finalizeTerminalRestoreJournal(config.dataDirectory, "rolled-back");
      } else if (journal.present) {
        throw error;
      } else {
        await setMaintenancePhase(maintenance, config.operationId, "verification");
        return {
          status: "forensic_rollback_aborted",
          operationId: config.operationId,
          backupId: state.backupId,
          safetyBackupId: state.safety.id,
          maintenancePhase: "verification",
          errorCode: errorCode(error),
        };
      }
      if (journal.phase === "rolled-back") {
        await setMaintenancePhase(maintenance, config.operationId, "verification");
        return {
          status: "forensic_rollback_aborted",
          operationId: config.operationId,
          backupId: state.backupId,
          safetyBackupId: state.safety.id,
          maintenancePhase: "verification",
          errorCode: errorCode(error),
        };
      }
    }
    await operationStore.write(rolledBackOperationState(state, "OPERATOR_ROLLBACK", new Date().toISOString()));
    await setMaintenancePhase(maintenance, config.operationId, "rollback");
    return {
      status: "forensic_rolled_back",
      operationId: config.operationId,
      backupId: state.backupId,
      safetyBackupId: state.safety.id,
      maintenancePhase: "rollback",
    };
  } finally {
    await lease.release();
  }
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  if (arguments_[0] === "offline-prepare") {
    const result = await runOfflineRestorePreparation(
      loadOfflineRestorePreparationConfig(process.env, arguments_.slice(1)),
      process.stdin,
    );
    process.stdout.write(`${JSON.stringify({ ok: true, preparation: result })}\n`);
    return;
  }
  if (arguments_[0] === "forensic-rollback") {
    const result = await runForensicRollback(loadForensicRollbackConfig(process.env, arguments_.slice(1)));
    process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
    return;
  }
  if (arguments_[0] === "preflight") {
    const result = await runRestorePreflight(loadRestorePreflightConfig(process.env, arguments_.slice(1)));
    process.stdout.write(`${JSON.stringify({ ok: true, preflight: result })}\n`);
    return;
  }
  const result = await runRestoreWorker(loadRestoreWorkerConfig(process.env, arguments_));
  process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
}

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entrypoint === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: {
        code: errorCode(error),
        message: process.argv[2] === "preflight"
          ? "FormaSpec restore preflight did not complete; no restore state was created."
          : process.argv[2] === "offline-prepare"
            ? "FormaSpec offline restore preparation did not complete; live data was not cut over."
            : process.argv[2] === "forensic-rollback"
              ? "FormaSpec forensic rollback did not complete; maintenance remains active."
              : "FormaSpec restore worker did not complete; maintenance remains active.",
      },
    })}\n`);
    process.exitCode = 1;
  });
}
