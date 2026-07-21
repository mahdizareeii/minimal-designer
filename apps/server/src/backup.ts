import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import Database from "better-sqlite3";
import tar from "tar-stream";
import {
  ComponentDefinitionSchema,
  DesignDocumentSchema,
  DesignDocumentV2Schema,
  DesignSystemReleaseSchema,
  DesignSystemTokenSchema,
  DesignOperationListSchema,
  ENGINE_VERSIONS,
  FORMASPEC_FOUNDATION_RELEASE_ID,
  FORMASPEC_FOUNDATION_SYSTEM_ID,
  FORMASPEC_FOUNDATION_VERSION,
  type AnyDesignDocument,
} from "@designer/core";

import {
  normalizedAssetArchivePath,
  validateImageAsset,
  type RasterNormalizationEngine,
  type RasterNormalizationOptions,
} from "./assets.js";
import {
  validateDatabaseMigrationLedger,
  validateDatabaseSchemaShape,
  type DesignerDatabase,
} from "./db/database.js";
import {
  DESIGN_SYSTEM_ENTITY_JSON_MAX_BYTES,
  DESIGN_SYSTEM_RELEASE_JSON_MAX_BYTES,
} from "./design-system-limits.js";
import { DomainError } from "./errors.js";
import { canonicalJson } from "./ids.js";
import {
  organizationPolicyBackupJson,
  verifyOrganizationPolicyBackupConfiguration,
} from "./organization-policy-model.js";
import {
  canonicalSnapshot,
  operationHash,
  readSnapshotJson,
  revisionHash,
} from "./persistence.js";

const MAX_BACKUP_ENTRIES = 20_000;
export const MAX_BACKUP_BUNDLE_BYTES = 16 * 1024 * 1024 * 1024;
const MAX_BACKUP_EXPANDED_BYTES = MAX_BACKUP_BUNDLE_BYTES;
const MAX_BACKUP_CONTROL_BYTES = 4 * 1024 * 1024;
const MAX_BACKUP_VERSION_BYTES = 128;
const MAX_BACKUP_DATABASE_ROWS = 200_000;
const MAX_BACKUP_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MAX_BACKUP_JSON_BYTES = 16 * 1024 * 1024;
const MAX_BACKUP_OPERATION_BYTES = 1 * 1024 * 1024;
const MAX_FOREIGN_KEY_DIAGNOSTICS = 1_000;
const MAX_BACKUP_ASSET_BYTES = 256 * 1024 * 1024;
const MAX_BACKUP_ASSET_PIXELS = 400_000_000;
const RESTORE_JOURNAL_DIRECTORY = ".formaspec-restore-journal";
const RESTORE_JOURNAL_FILENAME = "journal.json";
const RESTORE_JOURNAL_FORMAT = "formaspec-restore-journal";
const RESTORE_JOURNAL_VERSION = 1;
export const RESTORE_JOURNAL_MAX_BYTES = 64 * 1024;
const MAX_RESTORE_JOURNAL_MESSAGE_BYTES = 4 * 1024;
const BACKUP_SPACE_RESERVE_BYTES = 16 * 1024 * 1024;
const FORENSIC_RECOVERY_MANIFEST = "forensic-recovery-manifest.json";
const FORENSIC_RECOVERY_PAYLOAD_ROOT = "recovery-data";
const FORENSIC_RECOVERY_FORMAT = "formaspec-forensic-recovery";
const FORENSIC_RECOVERY_VERSION = 1;

type RestoreJournalPhase =
  | "staging"
  | "moving-originals"
  | "moving-candidate"
  | "health-check"
  | "rolling-back"
  | "rolled-back"
  | "committed";

type RestoreMoveAction = "move-original" | "move-candidate" | "rollback-candidate" | "rollback-original";

interface RestoreMoveStep {
  sequence: number;
  action: RestoreMoveAction;
  entry: string;
  status: "planned" | "completed";
  plannedAt: string;
  completedAt?: string;
}

interface RestoreJournal {
  format: typeof RESTORE_JOURNAL_FORMAT;
  version: typeof RESTORE_JOURNAL_VERSION;
  restoreId: string;
  sourceBundleSha256: string;
  createdAt: string;
  updatedAt: string;
  phase: RestoreJournalPhase;
  candidateCutoverStarted: boolean;
  originalEntries: string[];
  candidateEntries: string[];
  steps: RestoreMoveStep[];
  failure?: {
    cutover: string;
    rollback?: string;
  };
}

export interface BackupManifest {
  format: "formaspec-backup";
  formatVersion: 1 | 2;
  createdAt: string;
  applicationBuildVersion: string;
  databaseSchemaVersion: number;
  documentSchemaVersion: number;
  commandEngineVersion: string;
  rendererVersion: string;
  fontBundleVersion: string;
  files: Array<{ path: string; sizeBytes: number; sha256: string }>;
}

export interface BackupVerificationResult {
  valid: true;
  manifest: BackupManifest;
  sqliteIntegrity: "ok";
  foreignKeyViolations: number;
  extractedBytes: number;
  entryCount: number;
}

export interface BackupInspectionResult {
  verification: BackupVerificationResult;
  organizationIds: string[];
}

export interface ForensicRecoveryManifest {
  format: typeof FORENSIC_RECOVERY_FORMAT;
  version: typeof FORENSIC_RECOVERY_VERSION;
  operationId: string;
  createdAt: string;
  files: Array<{ path: string; sizeBytes: number; sha256: string }>;
}

export interface ForensicRecoveryVerificationResult {
  valid: true;
  manifest: ForensicRecoveryManifest;
  extractedBytes: number;
  entryCount: number;
}

export interface ForensicRecoveryBundleResult {
  path: string;
  filename: string;
  bundleSha256: string;
  sizeBytes: number;
  createdAt: string;
  verification: ForensicRecoveryVerificationResult;
}

export interface BackupRasterVerifier {
  engine: RasterNormalizationEngine;
  limits: Pick<RasterNormalizationOptions, "maxBytes" | "maxPixels">;
}

export interface BackupVerificationOptions {
  rasterVerifier?: BackupRasterVerifier;
  requireRasterVerifier?: boolean;
}

const BACKUP_MANIFEST_KEYS = new Set([
  "format",
  "formatVersion",
  "createdAt",
  "applicationBuildVersion",
  "databaseSchemaVersion",
  "documentSchemaVersion",
  "commandEngineVersion",
  "rendererVersion",
  "fontBundleVersion",
  "files",
]);
const BACKUP_FILE_KEYS = new Set(["path", "sizeBytes", "sha256"]);
const FORENSIC_RECOVERY_MANIFEST_KEYS = new Set(["format", "version", "operationId", "createdAt", "files"]);
const ASSET_MANIFEST_KEYS = new Set(["files"]);
const BACKUP_CONTROL_PATHS = new Set(["backup-manifest.json", "checksums.sha256"]);
const REQUIRED_BACKUP_PAYLOAD_PATHS = ["database.sqlite", "asset-manifest.json", "organization-config.yaml"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function isBoundedVersionString(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.trim() === value
    && Buffer.byteLength(value, "utf8") <= MAX_BACKUP_VERSION_BYTES
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function portablePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0")) {
    throw new DomainError("VALIDATION_FAILED", "Backup contains an invalid archive path.", 422);
  }
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new DomainError("VALIDATION_FAILED", "Backup contains a path traversal entry.", 422);
  }
  return parts.join("/");
}

function canonicalBackupPath(value: string): string {
  const normalized = portablePath(value);
  if (normalized !== value) {
    throw new DomainError("VALIDATION_FAILED", "Backup paths must use canonical forward-slash notation.", 422);
  }
  return normalized;
}

function parseBackupManifest(contents: string): BackupManifest {
  let value: unknown;
  try {
    value = JSON.parse(contents) as unknown;
  } catch (error) {
    throw new DomainError("VALIDATION_FAILED", "Backup manifest is not valid JSON.", 422, { cause: error });
  }
  if (
    !isRecord(value)
    || !hasExactKeys(value, BACKUP_MANIFEST_KEYS)
    || value.format !== "formaspec-backup"
    || (value.formatVersion !== 1 && value.formatVersion !== 2)
    || !isCanonicalIsoTimestamp(value.createdAt)
    || !isBoundedVersionString(value.applicationBuildVersion)
    || !Number.isSafeInteger(value.databaseSchemaVersion)
    || (value.databaseSchemaVersion as number) < 1
    || !Number.isSafeInteger(value.documentSchemaVersion)
    || (value.documentSchemaVersion as number) < 1
    || !isBoundedVersionString(value.commandEngineVersion)
    || !isBoundedVersionString(value.rendererVersion)
    || !isBoundedVersionString(value.fontBundleVersion)
    || !Array.isArray(value.files)
    || value.files.length > MAX_BACKUP_ENTRIES
  ) {
    throw new DomainError("VALIDATION_FAILED", "Backup manifest is unsupported or malformed.", 422);
  }
  const seen = new Set<string>();
  const files = value.files.map((entry): BackupManifest["files"][number] => {
    if (
      !isRecord(entry)
      || !hasExactKeys(entry, BACKUP_FILE_KEYS)
      || typeof entry.path !== "string"
      || !Number.isSafeInteger(entry.sizeBytes)
      || (entry.sizeBytes as number) < 0
      || (entry.sizeBytes as number) > MAX_BACKUP_EXPANDED_BYTES
      || typeof entry.sha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(entry.sha256)
    ) {
      throw new DomainError("VALIDATION_FAILED", "Backup manifest contains an invalid file record.", 422);
    }
    const normalized = canonicalBackupPath(entry.path);
    if (BACKUP_CONTROL_PATHS.has(normalized)) {
      throw new DomainError("VALIDATION_FAILED", `Backup manifest cannot declare control file ${normalized}.`, 422);
    }
    if (seen.has(normalized)) {
      throw new DomainError("VALIDATION_FAILED", `Backup manifest repeats ${normalized}.`, 422);
    }
    seen.add(normalized);
    return { path: normalized, sizeBytes: entry.sizeBytes as number, sha256: entry.sha256 };
  });
  return {
    format: "formaspec-backup",
    formatVersion: value.formatVersion,
    createdAt: value.createdAt,
    applicationBuildVersion: value.applicationBuildVersion,
    databaseSchemaVersion: value.databaseSchemaVersion as number,
    documentSchemaVersion: value.documentSchemaVersion as number,
    commandEngineVersion: value.commandEngineVersion,
    rendererVersion: value.rendererVersion,
    fontBundleVersion: value.fontBundleVersion,
    files,
  };
}

function parseForensicRecoveryManifest(contents: string): ForensicRecoveryManifest {
  let value: unknown;
  try {
    value = JSON.parse(contents) as unknown;
  } catch (error) {
    throw new DomainError("VALIDATION_FAILED", "Forensic recovery manifest is not valid JSON.", 422, { cause: error });
  }
  if (
    !isRecord(value)
    || !hasExactKeys(value, FORENSIC_RECOVERY_MANIFEST_KEYS)
    || value.format !== FORENSIC_RECOVERY_FORMAT
    || value.version !== FORENSIC_RECOVERY_VERSION
    || typeof value.operationId !== "string"
    || !/^restore_[A-Za-z0-9][A-Za-z0-9_-]{7,111}$/.test(value.operationId)
    || !isCanonicalIsoTimestamp(value.createdAt)
    || !Array.isArray(value.files)
    || value.files.length > MAX_BACKUP_ENTRIES
  ) {
    throw new DomainError("VALIDATION_FAILED", "Forensic recovery manifest is unsupported or malformed.", 422);
  }
  const seen = new Set<string>();
  const files = value.files.map((entry): ForensicRecoveryManifest["files"][number] => {
    if (
      !isRecord(entry)
      || !hasExactKeys(entry, BACKUP_FILE_KEYS)
      || typeof entry.path !== "string"
      || !Number.isSafeInteger(entry.sizeBytes)
      || (entry.sizeBytes as number) < 0
      || (entry.sizeBytes as number) > MAX_BACKUP_EXPANDED_BYTES
      || typeof entry.sha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(entry.sha256)
    ) {
      throw new DomainError("VALIDATION_FAILED", "Forensic recovery manifest contains an invalid file record.", 422);
    }
    const normalized = canonicalBackupPath(entry.path);
    if (!normalized.startsWith(`${FORENSIC_RECOVERY_PAYLOAD_ROOT}/`)) {
      throw new DomainError("VALIDATION_FAILED", "Forensic recovery payload escaped its reserved root.", 422);
    }
    if (seen.has(normalized)) {
      throw new DomainError("VALIDATION_FAILED", `Forensic recovery manifest repeats ${normalized}.`, 422);
    }
    seen.add(normalized);
    return { path: normalized, sizeBytes: entry.sizeBytes as number, sha256: entry.sha256 };
  });
  return {
    format: FORENSIC_RECOVERY_FORMAT,
    version: FORENSIC_RECOVERY_VERSION,
    operationId: value.operationId,
    createdAt: value.createdAt,
    files,
  };
}

function parseBackupChecksums(contents: string): Map<string, string> {
  const checksums = new Map<string, string>();
  const lines = contents.split("\n").filter((line) => line.length > 0);
  if (lines.length > MAX_BACKUP_ENTRIES + 1) {
    throw new DomainError("VALIDATION_FAILED", "Backup checksum manifest has too many rows.", 422);
  }
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match) throw new DomainError("VALIDATION_FAILED", "Backup checksum manifest is malformed.", 422);
    const name = canonicalBackupPath(match[2]!);
    if (checksums.has(name)) {
      throw new DomainError("VALIDATION_FAILED", `Backup checksum manifest repeats ${name}.`, 422);
    }
    checksums.set(name, match[1]!);
  }
  return checksums;
}

function parseAssetManifest(contents: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(contents) as unknown;
  } catch (error) {
    throw new DomainError("VALIDATION_FAILED", "Asset manifest is not valid JSON.", 422, { cause: error });
  }
  if (!isRecord(value) || !hasExactKeys(value, ASSET_MANIFEST_KEYS) || !Array.isArray(value.files)) {
    throw new DomainError("VALIDATION_FAILED", "Asset manifest is malformed.", 422);
  }
  if (value.files.length > MAX_BACKUP_ENTRIES) {
    throw new DomainError("VALIDATION_FAILED", "Asset manifest has too many entries.", 422);
  }
  const seen = new Set<string>();
  return value.files.map((entry) => {
    if (typeof entry !== "string") {
      throw new DomainError("VALIDATION_FAILED", "Asset manifest contains a non-string path.", 422);
    }
    const normalized = canonicalBackupPath(entry);
    if (!normalized.startsWith("assets/")) {
      throw new DomainError("VALIDATION_FAILED", "Asset manifest may list only assets/** files.", 422);
    }
    if (seen.has(normalized)) {
      throw new DomainError("VALIDATION_FAILED", `Asset manifest repeats ${normalized}.`, 422);
    }
    seen.add(normalized);
    return normalized;
  });
}

function normalizedAssetPathDigest(assetPath: string): string {
  const match = /^assets\/sha256\/([a-f0-9]{2})\/([a-f0-9]{64})\.(png|jpg|webp)$/.exec(assetPath);
  if (!match || match[1] !== match[2]!.slice(0, 2)) {
    throw new DomainError(
      "VALIDATION_FAILED",
      `Asset path does not use the normalized content-addressed convention: ${assetPath}.`,
      422,
    );
  }
  return match[2]!;
}

async function listFiles(root: string, prefix = ""): Promise<string[]> {
  if (!fs.existsSync(root)) return [];
  const entries = await fs.promises.readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(absolute, relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

async function regularFileBytes(root: string): Promise<number> {
  let total = 0;
  for (const relative of await listFiles(root)) {
    const stat = await fs.promises.lstat(path.join(root, relative));
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new DomainError("VALIDATION_FAILED", "Backup source contains a non-regular file.", 422);
    }
    total += stat.size;
    if (!Number.isSafeInteger(total) || total > MAX_BACKUP_EXPANDED_BYTES) {
      throw new DomainError("PAYLOAD_TOO_LARGE", "Backup source exceeds the configured size limit.", 413);
    }
  }
  return total;
}

async function copyForensicDataTree(sourceRoot: string, destinationRoot: string): Promise<void> {
  const source = path.resolve(sourceRoot);
  const destination = path.resolve(destinationRoot);
  if (destination === source || destination.startsWith(`${source}${path.sep}`)
    || source.startsWith(`${destination}${path.sep}`)) {
    throw new DomainError("VALIDATION_FAILED", "Forensic recovery staging must be outside the live data tree.", 422);
  }
  let sourceStat: fs.BigIntStats;
  try {
    sourceStat = await fs.promises.lstat(source, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new DomainError("VALIDATION_FAILED", "Forensic recovery requires a real data directory.", 422);
  }
  if (await pathExists(path.join(source, RESTORE_JOURNAL_DIRECTORY))) {
    throw new DomainError(
      "VERSION_CONFLICT",
      "Forensic recovery cannot snapshot data while a restore journal is active.",
      409,
    );
  }

  let files = 0;
  let entriesSeen = 0;
  let totalBytes = 0;
  const copyDirectory = async (relativeDirectory: string, depth: number): Promise<void> => {
    if (depth > 64) {
      throw new DomainError("PAYLOAD_TOO_LARGE", "Forensic recovery source exceeds the directory-depth limit.", 413);
    }
    const sourceDirectory = relativeDirectory
      ? path.join(source, ...relativeDirectory.split("/"))
      : source;
    const before = await fs.promises.lstat(sourceDirectory, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw new DomainError("VALIDATION_FAILED", "Forensic recovery source contains a non-real directory.", 422);
    }
    const entries = await fs.promises.readdir(sourceDirectory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = canonicalBackupPath(relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name);
      entriesSeen += 1;
      if (entriesSeen > MAX_BACKUP_ENTRIES || Buffer.byteLength(relative, "utf8") > 4096) {
        throw new DomainError("PAYLOAD_TOO_LARGE", "Forensic recovery source exceeds its entry or path limit.", 413);
      }
      if (!relativeDirectory && relative === RESTORE_JOURNAL_DIRECTORY) {
        throw new DomainError("VERSION_CONFLICT", "Forensic recovery found active restore-journal state.", 409);
      }
      const sourcePath = path.join(source, ...relative.split("/"));
      const entryStat = await fs.promises.lstat(sourcePath, { bigint: true });
      if (entryStat.isSymbolicLink()) {
        throw new DomainError("VALIDATION_FAILED", `Forensic recovery rejects symbolic link ${relative}.`, 422);
      }
      if (entryStat.isDirectory()) {
        await copyDirectory(relative, depth + 1);
        continue;
      }
      if (!entryStat.isFile()) {
        throw new DomainError("VALIDATION_FAILED", `Forensic recovery rejects non-regular entry ${relative}.`, 422);
      }
      files += 1;
      if (entryStat.size > BigInt(MAX_BACKUP_EXPANDED_BYTES)) {
        throw new DomainError("PAYLOAD_TOO_LARGE", "Forensic recovery source contains an oversized file.", 413);
      }
      totalBytes += Number(entryStat.size);
      if (files > MAX_BACKUP_ENTRIES || !Number.isSafeInteger(totalBytes)
        || totalBytes > MAX_BACKUP_EXPANDED_BYTES) {
        throw new DomainError("PAYLOAD_TOO_LARGE", "Forensic recovery source exceeds its fixed limits.", 413);
      }
      const targetPath = path.join(destination, FORENSIC_RECOVERY_PAYLOAD_ROOT, ...relative.split("/"));
      await fs.promises.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
      const input = await fs.promises.open(
        sourcePath,
        process.platform === "win32"
          ? fs.constants.O_RDONLY
          : fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
      );
      let output: fs.promises.FileHandle | undefined;
      try {
        const opened = await input.stat({ bigint: true });
        if (!opened.isFile() || opened.dev !== entryStat.dev || opened.ino !== entryStat.ino
          || opened.size !== entryStat.size) {
          throw new DomainError("TEMPORARILY_UNAVAILABLE", `Forensic recovery source changed before ${relative} was copied.`, 503);
        }
        output = await fs.promises.open(targetPath, "wx", 0o600);
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        let position = 0;
        while (position < Number(opened.size)) {
          const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, Number(opened.size) - position), position);
          if (bytesRead < 1) {
            throw new DomainError("TEMPORARILY_UNAVAILABLE", `Forensic recovery source changed while ${relative} was copied.`, 503);
          }
          let written = 0;
          while (written < bytesRead) {
            const result = await output.write(buffer, written, bytesRead - written, position + written);
            if (result.bytesWritten < 1) throw new Error("Forensic recovery copy made no progress.");
            written += result.bytesWritten;
          }
          position += bytesRead;
        }
        const after = await input.stat({ bigint: true });
        if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
          || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs) {
          throw new DomainError("TEMPORARILY_UNAVAILABLE", `Forensic recovery source changed while ${relative} was copied.`, 503);
        }
        await output.sync();
      } finally {
        await output?.close().catch(() => undefined);
        await input.close().catch(() => undefined);
      }
    }
    const after = await fs.promises.lstat(sourceDirectory, { bigint: true });
    if (!after.isDirectory() || after.dev !== before.dev || after.ino !== before.ino
      || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
      throw new DomainError("TEMPORARILY_UNAVAILABLE", "Forensic recovery data changed while it was captured.", 503);
    }
  };
  await copyDirectory("", 0);
}

async function requireFilesystemCapacity(
  directory: string,
  payloadBytes: number,
  copies: number,
  purpose: string,
): Promise<void> {
  if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 0
    || !Number.isSafeInteger(copies) || copies < 1 || copies > 4) {
    throw new DomainError("INTERNAL_ERROR", "Backup capacity estimate is invalid.", 500);
  }
  const requiredBytes = BigInt(payloadBytes) * BigInt(copies) + BigInt(BACKUP_SPACE_RESERVE_BYTES);
  const stat = await fs.promises.statfs(directory, { bigint: true }).catch((error) => {
    throw new DomainError(
      "TEMPORARILY_UNAVAILABLE",
      `Filesystem capacity could not be verified before ${purpose}.`,
      503,
      { retryable: true, cause: error },
    );
  });
  const availableBytes = stat.bavail * stat.bsize;
  if (availableBytes >= requiredBytes) return;
  const bounded = (value: bigint): number => Number(value > BigInt(Number.MAX_SAFE_INTEGER)
    ? BigInt(Number.MAX_SAFE_INTEGER)
    : value);
  throw new DomainError(
    "TEMPORARILY_UNAVAILABLE",
    `Insufficient filesystem capacity for ${purpose}.`,
    507,
    {
      retryable: true,
      details: {
        availableBytes: bounded(availableBytes),
        requiredBytes: bounded(requiredBytes),
      },
    },
  );
}

async function copyReferencedAssetFiles(
  databasePath: string,
  sourceDataDirectory: string,
  stagingDirectory: string,
): Promise<void> {
  const sqlite = new Database(databasePath, { readonly: true, fileMustExist: true });
  const copied = new Set<string>();
  try {
    boundedTableCount(sqlite, "assets");
    const rows = sqlite.prepare(
      "SELECT sha256, mime_type FROM assets ORDER BY sha256, mime_type",
    ).iterate() as Iterable<{ sha256: unknown; mime_type: unknown }>;
    for (const row of rows) {
      if (typeof row.sha256 !== "string" || typeof row.mime_type !== "string") {
        throw new DomainError("VALIDATION_FAILED", "Backup database contains invalid asset storage metadata.", 422);
      }
      let archivePath: string;
      try {
        archivePath = normalizedAssetArchivePath(row.sha256, row.mime_type);
      } catch (error) {
        throw new DomainError("VALIDATION_FAILED", "Backup database contains unsupported asset storage metadata.", 422, {
          cause: error,
        });
      }
      if (copied.has(archivePath)) continue;
      const source = path.join(sourceDataDirectory, ...archivePath.split("/"));
      let stat: fs.Stats;
      try {
        stat = await fs.promises.lstat(source);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new DomainError("VALIDATION_FAILED", `Normalized asset source is not a safe regular file: ${archivePath}.`, 422);
      }
      const destination = path.join(stagingDirectory, ...archivePath.split("/"));
      await fs.promises.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
      copied.add(archivePath);
    }
  } finally {
    sqlite.close();
  }
}

async function fileDigest(filename: string): Promise<{ sizeBytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of fs.createReadStream(filename)) {
    const buffer = Buffer.from(chunk as Buffer | Uint8Array);
    sizeBytes += buffer.length;
    hash.update(buffer);
  }
  return { sizeBytes, sha256: hash.digest("hex") };
}

async function writeDeterministicTar(sourceDirectory: string, destination: string): Promise<void> {
  const pack = tar.pack();
  const output = fs.createWriteStream(destination, { mode: 0o600 });
  const piping = pipeline(pack, output);
  for (const relative of await listFiles(sourceDirectory)) {
    const absolute = path.join(sourceDirectory, relative);
    const stat = await fs.promises.stat(absolute);
    const entry = pack.entry({
      name: portablePath(relative),
      size: stat.size,
      mode: 0o600,
      uid: 0,
      gid: 0,
      mtime: new Date(0),
      type: "file",
    });
    await pipeline(fs.createReadStream(absolute), entry);
  }
  pack.finalize();
  await piping;
}

async function extractTar(bundlePath: string, destination: string): Promise<{ entryCount: number; expandedBytes: number }> {
  await fs.promises.mkdir(destination, { recursive: true, mode: 0o700 });
  const extract = tar.extract();
  let entryCount = 0;
  let expandedBytes = 0;
  let terminalError: Error | null = null;
  const seen = new Set<string>();
  const resolvedDestination = path.resolve(destination);
  extract.on("entry", (header, stream, next) => {
    // Destroying the extractor propagates its terminal error to the active
    // entry stream too. Keep that secondary emission from becoming an
    // uncaught exception; pipeline(extract) remains the authoritative error.
    stream.on("error", () => undefined);
    entryCount += 1;
    try {
      if (entryCount > MAX_BACKUP_ENTRIES) throw new DomainError("PAYLOAD_TOO_LARGE", "Backup has too many entries.", 413);
      const name = portablePath(header.name);
      if (seen.has(name)) throw new DomainError("VALIDATION_FAILED", "Backup contains a duplicate archive path.", 422);
      seen.add(name);
      if (header.type !== "file") throw new DomainError("VALIDATION_FAILED", "Backup may contain regular files only.", 422);
      if (header.size !== undefined && expandedBytes + header.size > MAX_BACKUP_EXPANDED_BYTES) {
        throw new DomainError("PAYLOAD_TOO_LARGE", "Backup expands beyond the configured limit.", 413);
      }
      const target = path.resolve(destination, ...name.split("/"));
      if (!target.startsWith(`${resolvedDestination}${path.sep}`)) throw new DomainError("VALIDATION_FAILED", "Backup path escapes the restore root.", 422);
      let size = 0;
      stream.pause();
      void fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
        .then(() => {
          const output = fs.createWriteStream(target, { flags: "wx", mode: 0o600 });
          let settled = false;
          const fail = (error: Error) => {
            if (settled) return;
            settled = true;
            output.destroy();
            terminalError ??= error;
            extract.destroy();
          };
          stream.on("data", (chunk: Buffer | Uint8Array) => {
            size += Buffer.byteLength(chunk);
            expandedBytes += Buffer.byteLength(chunk);
            if (expandedBytes > MAX_BACKUP_EXPANDED_BYTES) {
              fail(new DomainError("PAYLOAD_TOO_LARGE", "Backup expands beyond the configured limit.", 413));
            }
          });
          stream.once("error", fail);
          output.once("error", fail);
          output.once("finish", () => {
            if (settled) return;
            if (header.size !== undefined && header.size !== size) {
              fail(new DomainError("VALIDATION_FAILED", "Backup entry size is inconsistent.", 422));
              return;
            }
            settled = true;
            next();
          });
          stream.pipe(output);
          stream.resume();
        })
        .catch((error) => {
          terminalError ??= error as Error;
          extract.destroy();
        });
    } catch (error) {
      stream.resume();
      terminalError ??= error as Error;
      extract.destroy();
    }
  });
  try {
    await pipeline(fs.createReadStream(bundlePath), extract);
  } catch (error) {
    throw terminalError ?? error;
  }
  if (terminalError) throw terminalError;
  return { entryCount, expandedBytes };
}

async function readBackupControlFile(filename: string, label: string): Promise<string> {
  const stat = await fs.promises.stat(filename);
  if (!stat.isFile() || stat.size > MAX_BACKUP_CONTROL_BYTES) {
    throw new DomainError("VALIDATION_FAILED", `${label} exceeds the control-file limit.`, 422);
  }
  return fs.promises.readFile(filename, "utf8");
}

function verifyDatabaseMigrationLedger(sqlite: Database.Database, manifestVersion: number): number {
  const table = sqlite.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
  ).get();
  if (!table) throw new DomainError("VALIDATION_FAILED", "Backup database has no migration ledger.", 422);
  let rows: Array<{ version: unknown; name: unknown }>;
  try {
    rows = sqlite.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all() as Array<{
      version: unknown;
      name: unknown;
    }>;
  } catch (error) {
    throw new DomainError("VALIDATION_FAILED", "Backup database migration ledger is malformed.", 422, { cause: error });
  }
  let migrationVersion: number;
  try {
    migrationVersion = validateDatabaseMigrationLedger(rows);
  } catch (error) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Backup database migration ledger is not a recognized contiguous prefix.",
      422,
      { cause: error, details: { reason: error instanceof Error ? error.message : String(error) } },
    );
  }
  try {
    validateDatabaseSchemaShape(sqlite, migrationVersion);
  } catch (error) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Backup database schema does not match its applied migration ledger.",
      422,
      { cause: error, details: { reason: error instanceof Error ? error.message : String(error) } },
    );
  }
  if (manifestVersion !== migrationVersion) {
    throw new DomainError(
      "VALIDATION_FAILED",
      `Backup manifest database version ${manifestVersion} does not match its migration ledger ${migrationVersion}.`,
      422,
    );
  }
  return migrationVersion;
}

function boundedTableCount(
  sqlite: Database.Database,
  table: "assets" | "snapshots" | "revisions" | "designs" | "design_systems" | "design_system_tokens"
    | "component_definitions" | "design_system_releases" | "project_design_system_pins",
): number {
  const row = sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count?: unknown } | undefined;
  if (!row || !Number.isSafeInteger(row.count) || (row.count as number) < 0 || (row.count as number) > MAX_BACKUP_DATABASE_ROWS) {
    throw new DomainError("VALIDATION_FAILED", `Backup ${table} row count exceeds the verification limit.`, 422);
  }
  return row.count as number;
}

function parseBoundedStoredJson(
  value: unknown,
  label: string,
  maximumBytes = MAX_BACKUP_JSON_BYTES,
): unknown {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw new DomainError("VALIDATION_FAILED", `${label} is missing or exceeds the JSON verification limit.`, 422);
  }
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new DomainError("VALIDATION_FAILED", `${label} is not valid JSON.`, 422, { cause: error });
  }
}

function parseStoredDesignDocument(value: unknown, label: string) {
  const parsed = parseBoundedStoredJson(value, label);
  if (!isRecord(parsed)) {
    throw new DomainError("VALIDATION_FAILED", `${label} is not a design document.`, 422);
  }
  const result = parsed.schema_version === 1
    ? DesignDocumentSchema.safeParse(parsed)
    : parsed.schema_version === 2
      ? DesignDocumentV2Schema.safeParse(parsed)
      : null;
  if (!result?.success) {
    throw new DomainError("VALIDATION_FAILED", `${label} does not match a supported strict document schema.`, 422, {
      ...(result ? { details: { issueCount: Math.min(result.error.issues.length, 100) } } : {}),
    });
  }
  return result.data;
}

function parseStoredOperations(value: unknown, label: string) {
  const parsed = parseBoundedStoredJson(value, label);
  const result = DesignOperationListSchema.safeParse(parsed);
  if (!result.success) {
    throw new DomainError("VALIDATION_FAILED", `${label} does not match the strict operation schema.`, 422, {
      details: { issueCount: Math.min(result.error.issues.length, 100) },
    });
  }
  if (result.data.length > 500) {
    throw new DomainError("VALIDATION_FAILED", `${label} exceeds the 500-operation verification limit.`, 422);
  }
  return result.data;
}

function verifyAssetManifestFileSet(
  assetManifestPaths: readonly string[],
  manifestFiles: ReadonlyMap<string, BackupManifest["files"][number]>,
): Map<string, BackupManifest["files"][number]> {
  const declaredAssets = new Set(assetManifestPaths);
  const archiveAssets = new Map<string, BackupManifest["files"][number]>();
  for (const [filePath, record] of manifestFiles) {
    if (filePath.startsWith("assets/")) archiveAssets.set(filePath, record);
  }
  if (declaredAssets.size !== archiveAssets.size) {
    throw new DomainError("VALIDATION_FAILED", "Asset manifest does not match the exact archived assets/** file set.", 422);
  }
  for (const assetPath of declaredAssets) {
    const record = archiveAssets.get(assetPath);
    if (!record) {
      throw new DomainError("VALIDATION_FAILED", `Asset manifest references a missing archived asset: ${assetPath}.`, 422);
    }
    const pathDigest = normalizedAssetPathDigest(assetPath);
    if (record.sha256 !== pathDigest) {
      throw new DomainError("VALIDATION_FAILED", `Archived asset path/hash mismatch: ${assetPath}.`, 422);
    }
  }
  for (const assetPath of archiveAssets.keys()) {
    if (!declaredAssets.has(assetPath)) {
      throw new DomainError("VALIDATION_FAILED", `Archived asset is missing from asset-manifest.json: ${assetPath}.`, 422);
    }
  }
  return archiveAssets;
}

async function verifyRasterDecode(
  data: Buffer,
  claimedMimeType: string,
  source: { mimeType: "image/png" | "image/jpeg" | "image/webp"; width: number; height: number },
  verifier: BackupRasterVerifier | undefined,
  label: string,
): Promise<void> {
  if (!verifier) return;
  try {
    const normalized = await verifier.engine.normalizeRaster(data, {
      sourceMimeType: source.mimeType,
      sourceWidth: source.width,
      sourceHeight: source.height,
      maxBytes: verifier.limits.maxBytes,
      maxPixels: verifier.limits.maxPixels,
    });
    if (normalized.mimeType !== "image/png") {
      throw new Error("The isolated raster verifier returned a non-canonical MIME type.");
    }
    const decoded = validateImageAsset(normalized.data, normalized.mimeType, verifier.limits);
    if (decoded.width !== normalized.width || decoded.height !== normalized.height) {
      throw new Error("The isolated raster verifier returned inconsistent decoded dimensions.");
    }
  } catch (error) {
    throw new DomainError(
      "VALIDATION_FAILED",
      `${label} failed isolated full-image decode for ${claimedMimeType}.`,
      422,
      { cause: error },
    );
  }
}

async function verifyDatabaseAssetReferences(
  sqlite: Database.Database,
  archivedAssets: ReadonlyMap<string, BackupManifest["files"][number]>,
  extractedRoot: string,
  migrationVersion: number,
  options: BackupVerificationOptions,
): Promise<Map<string, VerifiedDatabaseAsset>> {
  const assetCount = boundedTableCount(sqlite, "assets");
  if (assetCount > 0 && options.requireRasterVerifier && !options.rasterVerifier) {
    throw new DomainError(
      "TEMPORARILY_UNAVAILABLE",
      "Backup asset verification requires the isolated raster worker.",
      503,
      { retryable: true },
    );
  }
  const referencedFiles = new Set<string>();
  const verifiedFiles = new Map<string, {
    mimeType: "image/png" | "image/jpeg" | "image/webp";
    width: number;
    height: number;
  }>();
  const fullyDecoded = new Set<string>();
  const databaseAssets = new Map<string, VerifiedDatabaseAsset>();
  const readFallback = sqlite.prepare("SELECT data FROM assets WHERE id = ?");
  const rows = sqlite.prepare(
    `SELECT id, design_id, mime_type, size_bytes, width, height, sha256, length(data) AS data_bytes,
            ${migrationVersion >= 3 ? "organization_id" : "NULL"} AS organization_id
     FROM assets ORDER BY id`,
  ).iterate() as Iterable<{
    id: unknown;
    design_id: unknown;
    organization_id: unknown;
    mime_type: unknown;
    size_bytes: unknown;
    width: unknown;
    height: unknown;
    sha256: unknown;
    data_bytes: unknown;
  }>;
  for (const row of rows) {
    if (
      typeof row.id !== "string"
      || !row.id
      || (row.design_id !== null && (typeof row.design_id !== "string" || !row.design_id))
      || (row.organization_id !== null && (typeof row.organization_id !== "string" || !row.organization_id))
      || (migrationVersion >= 3 && row.organization_id === null)
      || typeof row.mime_type !== "string"
      || !Number.isSafeInteger(row.size_bytes)
      || (row.size_bytes as number) < 0
      || (row.size_bytes as number) > MAX_BACKUP_ASSET_BYTES
      || !Number.isSafeInteger(row.width)
      || (row.width as number) < 1
      || !Number.isSafeInteger(row.height)
      || (row.height as number) < 1
      || typeof row.sha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(row.sha256)
      || !Number.isSafeInteger(row.data_bytes)
      || (row.data_bytes as number) < 0
    ) {
      throw new DomainError("VALIDATION_FAILED", "Backup database contains an invalid asset record.", 422);
    }
    const databaseAsset: VerifiedDatabaseAsset = {
      id: row.id,
      designId: row.design_id as string | null,
      organizationId: row.organization_id as string | null,
      mimeType: row.mime_type,
      sizeBytes: row.size_bytes as number,
      width: row.width as number,
      height: row.height as number,
      sha256: row.sha256,
    };
    let expectedPath: string;
    try {
      expectedPath = normalizedAssetArchivePath(row.sha256, row.mime_type);
    } catch (error) {
      throw new DomainError("VALIDATION_FAILED", `Backup asset ${row.id} has unsupported content metadata.`, 422, { cause: error });
    }
    const archived = archivedAssets.get(expectedPath);
    if (archived) {
      if (archived.sha256 !== row.sha256 || archived.sizeBytes !== row.size_bytes) {
        throw new DomainError("VALIDATION_FAILED", `Backup asset ${row.id} does not match its normalized file.`, 422);
      }
      let image = verifiedFiles.get(expectedPath);
      if (!image) {
        const bytes = fs.readFileSync(path.join(extractedRoot, ...expectedPath.split("/")));
        try {
          image = validateImageAsset(bytes, row.mime_type, {
            maxBytes: MAX_BACKUP_ASSET_BYTES,
            maxPixels: MAX_BACKUP_ASSET_PIXELS,
          });
          await verifyRasterDecode(
            bytes,
            row.mime_type,
            image,
            options.rasterVerifier,
            `Backup normalized asset ${expectedPath}`,
          );
          if (options.rasterVerifier) fullyDecoded.add(expectedPath);
        } catch (error) {
          if (error instanceof DomainError && error.code === "VALIDATION_FAILED") throw error;
          throw new DomainError("VALIDATION_FAILED", `Backup normalized asset is invalid: ${expectedPath}.`, 422, { cause: error });
        }
        verifiedFiles.set(expectedPath, image);
      } else if (options.rasterVerifier && !fullyDecoded.has(expectedPath)) {
        throw new DomainError("INTERNAL_ERROR", "Backup raster verification cache lost its decode evidence.", 500);
      }
      if (image.width !== row.width || image.height !== row.height) {
        throw new DomainError("VALIDATION_FAILED", `Backup asset ${row.id} dimensions do not match its normalized file.`, 422);
      }
      referencedFiles.add(expectedPath);
      databaseAssets.set(databaseAsset.id, databaseAsset);
      continue;
    }
    if (row.data_bytes !== row.size_bytes) {
      throw new DomainError("VALIDATION_FAILED", `Backup legacy asset ${row.id} has invalid BLOB size metadata.`, 422);
    }
    const fallback = readFallback.get(row.id) as { data?: unknown } | undefined;
    if (!fallback || !Buffer.isBuffer(fallback.data)
      || createHash("sha256").update(fallback.data).digest("hex") !== row.sha256) {
      throw new DomainError(
        "VALIDATION_FAILED",
        `Backup legacy asset ${row.id} has no normalized file and its quarantine BLOB is invalid.`,
        422,
      );
    }
    try {
      const image = validateImageAsset(fallback.data, row.mime_type, {
        maxBytes: MAX_BACKUP_ASSET_BYTES,
        maxPixels: MAX_BACKUP_ASSET_PIXELS,
      });
      if (image.width !== row.width || image.height !== row.height) {
        throw new DomainError("VALIDATION_FAILED", `Backup legacy asset ${row.id} dimensions do not match its BLOB.`, 422);
      }
      await verifyRasterDecode(
        fallback.data,
        row.mime_type,
        image,
        options.rasterVerifier,
        `Backup legacy asset ${row.id}`,
      );
    } catch (error) {
      if (error instanceof DomainError && error.code === "VALIDATION_FAILED") throw error;
      throw new DomainError("VALIDATION_FAILED", `Backup legacy asset ${row.id} is not a valid normalized image.`, 422, { cause: error });
    }
    databaseAssets.set(databaseAsset.id, databaseAsset);
  }
  for (const assetPath of archivedAssets.keys()) {
    if (!referencedFiles.has(assetPath)) {
      throw new DomainError("VALIDATION_FAILED", `Backup contains an unreferenced normalized asset: ${assetPath}.`, 422);
    }
  }
  return databaseAssets;
}

interface VerifiedDatabaseAsset {
  id: string;
  designId: string | null;
  organizationId: string | null;
  mimeType: string;
  sizeBytes: number;
  width: number;
  height: number;
  sha256: string;
}

interface VerifiedDesignOwnership {
  id: string;
  organizationId: string | null;
}

interface VerifiedDesignSystemPin {
  designSystemId: string;
  releaseId: string;
  releaseVersion: number;
}

interface VerifiedDesignSystemRow {
  id: string;
  organizationId: string;
}

interface VerifiedDesignSystemReleaseRow {
  id: string;
  designSystemId: string;
  version: number;
  status: "draft" | "published" | "deprecated";
}

interface VerifiedDesignSystemState {
  systemsById: ReadonlyMap<string, VerifiedDesignSystemRow>;
  releasesById: ReadonlyMap<string, VerifiedDesignSystemReleaseRow>;
  pinsByDesignId: ReadonlyMap<string, VerifiedDesignSystemPin>;
}

function isFoundationDesignSystemPin(pin: VerifiedDesignSystemPin): boolean {
  return pin.designSystemId === FORMASPEC_FOUNDATION_SYSTEM_ID
    && pin.releaseId === FORMASPEC_FOUNDATION_RELEASE_ID
    && pin.releaseVersion === FORMASPEC_FOUNDATION_VERSION;
}

function hasExactObjectKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function isValidReleaseDiagnostic(value: unknown): boolean {
  if (!isRecord(value) || !hasExactObjectKeys(value, [
    "code",
    "severity",
    "safety",
    "message",
    ...(value.entityKind === undefined ? [] : ["entityKind"]),
    ...(value.entityId === undefined ? [] : ["entityId"]),
    ...(value.path === undefined ? [] : ["path"]),
  ])) return false;
  return typeof value.code === "string"
    && value.code.length >= 1
    && value.code.length <= 160
    && (value.severity === "info" || value.severity === "warning" || value.severity === "error")
    && (value.safety === "safe" || value.safety === "review_required" || value.safety === "blocked")
    && typeof value.message === "string"
    && value.message.length >= 1
    && value.message.length <= 4_000
    && (value.entityKind === undefined
      || value.entityKind === "release"
      || value.entityKind === "token"
      || value.entityKind === "component"
      || value.entityKind === "project")
    && (value.entityId === undefined
      || (typeof value.entityId === "string" && value.entityId.length >= 1 && value.entityId.length <= 300))
    && (value.path === undefined || (typeof value.path === "string" && value.path.length <= 500));
}

function versionedEntityKey(systemId: string, entityId: string, version: number): string {
  return `${systemId}\0${entityId}\0${version}`;
}

function verifiedDocumentDesignSystemPin(document: AnyDesignDocument): VerifiedDesignSystemPin | null {
  if (document.schema_version !== 2) return null;
  return {
    designSystemId: document.design_system.design_system_id,
    releaseId: document.design_system.release_id,
    releaseVersion: document.design_system.release_version,
  };
}

function loadVerifiedDesignSystemState(
  sqlite: Database.Database,
  migrationVersion: number,
  designsById: ReadonlyMap<string, VerifiedDesignOwnership>,
): VerifiedDesignSystemState | null {
  if (migrationVersion < 8) return null;
  boundedTableCount(sqlite, "design_systems");
  boundedTableCount(sqlite, "design_system_tokens");
  boundedTableCount(sqlite, "component_definitions");
  boundedTableCount(sqlite, "design_system_releases");
  boundedTableCount(sqlite, "project_design_system_pins");

  const systemsById = new Map<string, VerifiedDesignSystemRow>();
  const systemRows = sqlite.prepare(
    "SELECT id, organization_id, status FROM design_systems ORDER BY id",
  ).iterate() as Iterable<{ id: unknown; organization_id: unknown; status: unknown }>;
  for (const row of systemRows) {
    if (typeof row.id !== "string"
      || !row.id
      || row.id === FORMASPEC_FOUNDATION_SYSTEM_ID
      || systemsById.has(row.id)
      || typeof row.organization_id !== "string"
      || !row.organization_id
      || (row.status !== "active" && row.status !== "archived")) {
      throw new DomainError("VALIDATION_FAILED", "Backup database contains an invalid design-system record.", 422);
    }
    systemsById.set(row.id, { id: row.id, organizationId: row.organization_id });
  }

  const tokenVersions = new Set<string>();
  const tokenRows = sqlite.prepare(
    `SELECT design_system_id, token_id, version, status, token_json
     FROM design_system_tokens ORDER BY design_system_id, token_id, version`,
  ).iterate() as Iterable<{
    design_system_id: unknown;
    token_id: unknown;
    version: unknown;
    status: unknown;
    token_json: unknown;
  }>;
  for (const row of tokenRows) {
    if (typeof row.design_system_id !== "string"
      || !systemsById.has(row.design_system_id)
      || typeof row.token_id !== "string"
      || !row.token_id
      || !Number.isSafeInteger(row.version)
      || (row.version as number) < 1
      || (row.status !== "draft" && row.status !== "published" && row.status !== "deprecated")) {
      throw new DomainError("VALIDATION_FAILED", "Backup database contains an invalid design-system token version.", 422);
    }
    const parsed = DesignSystemTokenSchema.safeParse(parseBoundedStoredJson(
      row.token_json,
      `Backup design-system token ${row.token_id}@${row.version}`,
      DESIGN_SYSTEM_ENTITY_JSON_MAX_BYTES,
    ));
    const key = versionedEntityKey(row.design_system_id, row.token_id, row.version as number);
    if (!parsed.success
      || canonicalJson(parsed.data) !== row.token_json
      || parsed.data.id !== row.token_id
      || tokenVersions.has(key)) {
      throw new DomainError("VALIDATION_FAILED", `Backup design-system token metadata is inconsistent: ${row.token_id}.`, 422);
    }
    tokenVersions.add(key);
  }

  const componentVersions = new Set<string>();
  const componentRows = sqlite.prepare(
    `SELECT design_system_id, component_id, version, status, definition_json, replacement_component_id
     FROM component_definitions ORDER BY design_system_id, component_id, version`,
  ).iterate() as Iterable<{
    design_system_id: unknown;
    component_id: unknown;
    version: unknown;
    status: unknown;
    definition_json: unknown;
    replacement_component_id: unknown;
  }>;
  for (const row of componentRows) {
    if (typeof row.design_system_id !== "string"
      || !systemsById.has(row.design_system_id)
      || typeof row.component_id !== "string"
      || !row.component_id
      || !Number.isSafeInteger(row.version)
      || (row.version as number) < 1
      || (row.status !== "draft" && row.status !== "published" && row.status !== "deprecated")
      || (row.replacement_component_id !== null && typeof row.replacement_component_id !== "string")) {
      throw new DomainError("VALIDATION_FAILED", "Backup database contains an invalid component-definition version.", 422);
    }
    const parsed = ComponentDefinitionSchema.safeParse(parseBoundedStoredJson(
      row.definition_json,
      `Backup component definition ${row.component_id}@${row.version}`,
      DESIGN_SYSTEM_ENTITY_JSON_MAX_BYTES,
    ));
    const key = versionedEntityKey(row.design_system_id, row.component_id, row.version as number);
    if (!parsed.success
      || canonicalJson(parsed.data) !== row.definition_json
      || parsed.data.id !== row.component_id
      || parsed.data.version !== row.version
      || parsed.data.status !== row.status
      || (parsed.data.replacement_component_id ?? null) !== row.replacement_component_id
      || componentVersions.has(key)) {
      throw new DomainError("VALIDATION_FAILED", `Backup component-definition metadata is inconsistent: ${row.component_id}.`, 422);
    }
    componentVersions.add(key);
  }

  const releasesById = new Map<string, VerifiedDesignSystemReleaseRow>();
  const releaseRows = sqlite.prepare(
    `SELECT id, design_system_id, version, name, status, release_json, created_at, published_at
     FROM design_system_releases ORDER BY id`,
  ).iterate() as Iterable<{
    id: unknown;
    design_system_id: unknown;
    version: unknown;
    name: unknown;
    status: unknown;
    release_json: unknown;
    created_at: unknown;
    published_at: unknown;
  }>;
  for (const row of releaseRows) {
    if (typeof row.id !== "string"
      || !row.id
      || row.id === FORMASPEC_FOUNDATION_RELEASE_ID
      || releasesById.has(row.id)
      || typeof row.design_system_id !== "string"
      || !row.design_system_id
      || !Number.isSafeInteger(row.version)
      || (row.version as number) < 1
      || typeof row.name !== "string"
      || !row.name
      || (row.status !== "draft" && row.status !== "published" && row.status !== "deprecated")
      || typeof row.created_at !== "string"
      || (row.published_at !== null && typeof row.published_at !== "string")) {
      throw new DomainError("VALIDATION_FAILED", "Backup database contains an invalid design-system release record.", 422);
    }
    if (!systemsById.has(row.design_system_id)) {
      throw new DomainError("VALIDATION_FAILED", `Backup design-system release references a missing system: ${row.id}.`, 422);
    }
    const payload = parseBoundedStoredJson(
      row.release_json,
      `Backup design-system release ${row.id}`,
      DESIGN_SYSTEM_RELEASE_JSON_MAX_BYTES,
    );
    const parsedRelease = isRecord(payload)
      ? DesignSystemReleaseSchema.safeParse(payload.release)
      : { success: false as const };
    if (!parsedRelease.success
      || !isRecord(payload)
      || !hasExactObjectKeys(payload, ["format", "format_version", "release", "token_versions", "component_versions", "diagnostics"])
      || payload.format !== "formaspec-design-system-release"
      || payload.format_version !== 1
      || !Array.isArray(payload.token_versions)
      || payload.token_versions.length > 20_000
      || !Array.isArray(payload.component_versions)
      || payload.component_versions.length > 5_000
      || !Array.isArray(payload.diagnostics)
      || payload.diagnostics.length > 20_000
      || !payload.diagnostics.every(isValidReleaseDiagnostic)
      || canonicalJson(payload) !== row.release_json
      || parsedRelease.data.id !== row.id
      || parsedRelease.data.design_system_id !== row.design_system_id
      || parsedRelease.data.version !== row.version
      || parsedRelease.data.name !== row.name
      || parsedRelease.data.status !== row.status
      || parsedRelease.data.created_at !== row.created_at
      || (parsedRelease.data.published_at ?? null) !== row.published_at) {
      throw new DomainError("VALIDATION_FAILED", `Backup design-system release metadata is inconsistent: ${row.id}.`, 422);
    }
    const selectedTokenIds: string[] = [];
    for (const selection of payload.token_versions) {
      if (!isRecord(selection)
        || !hasExactObjectKeys(selection, ["token_id", "version"])
        || typeof selection.token_id !== "string"
        || !Number.isSafeInteger(selection.version)
        || (selection.version as number) < 1
        || !tokenVersions.has(versionedEntityKey(row.design_system_id, selection.token_id, selection.version as number))) {
        throw new DomainError("VALIDATION_FAILED", `Backup design-system release selects an invalid token version: ${row.id}.`, 422);
      }
      selectedTokenIds.push(selection.token_id);
    }
    const selectedComponents: Array<{ component_definition_id: string; version: number }> = [];
    for (const selection of payload.component_versions) {
      if (!isRecord(selection)
        || !hasExactObjectKeys(selection, ["component_definition_id", "version"])
        || typeof selection.component_definition_id !== "string"
        || !Number.isSafeInteger(selection.version)
        || (selection.version as number) < 1
        || !componentVersions.has(versionedEntityKey(
          row.design_system_id,
          selection.component_definition_id,
          selection.version as number,
        ))) {
        throw new DomainError("VALIDATION_FAILED", `Backup design-system release selects an invalid component version: ${row.id}.`, 422);
      }
      selectedComponents.push({
        component_definition_id: selection.component_definition_id,
        version: selection.version as number,
      });
    }
    if (canonicalJson(parsedRelease.data.token_ids) !== canonicalJson(selectedTokenIds)
      || canonicalJson(parsedRelease.data.component_versions) !== canonicalJson(selectedComponents)) {
      throw new DomainError("VALIDATION_FAILED", `Backup design-system release selections are inconsistent: ${row.id}.`, 422);
    }
    releasesById.set(row.id, {
      id: row.id,
      designSystemId: row.design_system_id,
      version: row.version as number,
      status: row.status,
    });
  }

  const pinsByDesignId = new Map<string, VerifiedDesignSystemPin>();
  const pinRows = sqlite.prepare(
    `SELECT design_id, organization_id, design_system_id, release_id, release_version, pinned_by, pinned_at
     FROM project_design_system_pins ORDER BY design_id`,
  ).iterate() as Iterable<{
    design_id: unknown;
    organization_id: unknown;
    design_system_id: unknown;
    release_id: unknown;
    release_version: unknown;
    pinned_by: unknown;
    pinned_at: unknown;
  }>;
  for (const row of pinRows) {
    if (typeof row.design_id !== "string"
      || !row.design_id
      || pinsByDesignId.has(row.design_id)
      || typeof row.organization_id !== "string"
      || !row.organization_id
      || typeof row.design_system_id !== "string"
      || !row.design_system_id
      || typeof row.release_id !== "string"
      || !row.release_id
      || !Number.isSafeInteger(row.release_version)
      || (row.release_version as number) < 1
      || typeof row.pinned_by !== "string"
      || !row.pinned_by
      || typeof row.pinned_at !== "string") {
      throw new DomainError("VALIDATION_FAILED", "Backup database contains an invalid project design-system pin.", 422);
    }
    const design = designsById.get(row.design_id);
    const system = systemsById.get(row.design_system_id);
    const release = releasesById.get(row.release_id);
    if (!design
      || design.organizationId !== row.organization_id
      || !system
      || system.organizationId !== row.organization_id
      || !release
      || release.designSystemId !== row.design_system_id
      || release.version !== row.release_version
      || release.status === "draft") {
      throw new DomainError(
        "VALIDATION_FAILED",
        `Backup project design-system pin is inconsistent: ${row.design_id}.`,
        422,
      );
    }
    pinsByDesignId.set(row.design_id, {
      designSystemId: row.design_system_id,
      releaseId: row.release_id,
      releaseVersion: row.release_version as number,
    });
  }
  return { systemsById, releasesById, pinsByDesignId };
}

function verifyDocumentDesignSystemReference(
  document: AnyDesignDocument,
  design: VerifiedDesignOwnership,
  state: VerifiedDesignSystemState | null,
): void {
  const pin = verifiedDocumentDesignSystemPin(document);
  if (!pin || isFoundationDesignSystemPin(pin)) return;
  const release = state?.releasesById.get(pin.releaseId);
  const system = state?.systemsById.get(pin.designSystemId);
  if (!release
    || !system
    || system.organizationId !== design.organizationId
    || release.designSystemId !== pin.designSystemId
    || release.version !== pin.releaseVersion
    || release.status === "draft") {
    throw new DomainError(
      "VALIDATION_FAILED",
      `Backup revision ${document.id}@${document.revision} references an invalid design-system release.`,
      422,
    );
  }
}

function verifyDocumentAssetReferences(
  document: AnyDesignDocument,
  databaseAssets: ReadonlyMap<string, VerifiedDatabaseAsset>,
  design: VerifiedDesignOwnership,
): void {
  for (const node of Object.values(document.nodes)) {
    if (node.type === "image" && node.asset_id && !document.assets[node.asset_id]) {
      throw new DomainError(
        "VALIDATION_FAILED",
        `Backup revision ${document.id}@${document.revision} has an image node referencing missing asset ${node.asset_id}.`,
        422,
      );
    }
  }

  for (const asset of Object.values(document.assets)) {
    const managedV1 = document.schema_version === 1 && asset.storage_key === `asset:${asset.id}`;
    const readyV2 = document.schema_version === 2 && asset.status === "ready";
    const row = databaseAssets.get(asset.id);
    if (!row) {
      if (managedV1 || readyV2) {
        throw new DomainError(
          "VALIDATION_FAILED",
          `Backup revision ${document.id}@${document.revision} references managed asset ${asset.id} without a database record.`,
          422,
        );
      }
      continue;
    }
    if (row.designId !== null && row.designId !== document.id) {
      throw new DomainError(
        "VALIDATION_FAILED",
        `Backup asset ${asset.id} is linked to a different project than revision ${document.id}@${document.revision}.`,
        422,
      );
    }
    if (design.organizationId !== null && row.organizationId !== design.organizationId) {
      throw new DomainError(
        "VALIDATION_FAILED",
        `Backup asset ${asset.id} belongs to a different organization than project ${document.id}.`,
        422,
      );
    }
    const sha256 = asset.sha256;
    const width = asset.width;
    const height = asset.height;
    if (asset.kind !== "image"
      || asset.mime_type !== row.mimeType
      || asset.size_bytes !== row.sizeBytes
      || ((managedV1 || readyV2) && sha256 !== row.sha256)
      || (sha256 !== undefined && sha256 !== row.sha256)
      || (width !== undefined && width !== row.width)
      || (height !== undefined && height !== row.height)) {
      throw new DomainError(
        "VALIDATION_FAILED",
        `Backup revision asset metadata does not match the immutable database asset ${asset.id}.`,
        422,
      );
    }
  }
}

function verifySnapshotIntegrity(sqlite: Database.Database): Set<string> {
  boundedTableCount(sqlite, "snapshots");
  const hashes = new Set<string>();
  let totalUncompressedBytes = 0;
  const rows = sqlite.prepare(
    `SELECT snapshot_hash, encoding, uncompressed_bytes, length(document_brotli) AS compressed_bytes
     FROM snapshots ORDER BY snapshot_hash`,
  ).iterate() as Iterable<{
    snapshot_hash: unknown;
    encoding: unknown;
    uncompressed_bytes: unknown;
    compressed_bytes: unknown;
  }>;
  for (const row of rows) {
    if (
      typeof row.snapshot_hash !== "string"
      || !/^[a-f0-9]{64}$/.test(row.snapshot_hash)
      || row.encoding !== "br"
      || !Number.isSafeInteger(row.uncompressed_bytes)
      || (row.uncompressed_bytes as number) < 0
      || (row.uncompressed_bytes as number) > MAX_BACKUP_SNAPSHOT_BYTES
      || !Number.isSafeInteger(row.compressed_bytes)
      || (row.compressed_bytes as number) < 0
      || (row.compressed_bytes as number) > MAX_BACKUP_SNAPSHOT_BYTES
      || hashes.has(row.snapshot_hash)
    ) {
      throw new DomainError("VALIDATION_FAILED", "Backup database contains invalid snapshot metadata.", 422);
    }
    totalUncompressedBytes += row.uncompressed_bytes as number;
    if (!Number.isSafeInteger(totalUncompressedBytes) || totalUncompressedBytes > MAX_BACKUP_EXPANDED_BYTES) {
      throw new DomainError("VALIDATION_FAILED", "Backup snapshots exceed the aggregate verification limit.", 422);
    }
    let canonicalJson: string;
    try {
      canonicalJson = readSnapshotJson(sqlite, row.snapshot_hash, { maxUncompressedBytes: MAX_BACKUP_SNAPSHOT_BYTES });
    } catch (error) {
      throw new DomainError("VALIDATION_FAILED", `Backup snapshot integrity failed: ${row.snapshot_hash}.`, 422, { cause: error });
    }
    const parsed = parseStoredDesignDocument(canonicalJson, `Backup snapshot ${row.snapshot_hash}`);
    const canonical = canonicalSnapshot(parsed);
    if (canonical.hash !== row.snapshot_hash || canonical.canonicalJson !== canonicalJson) {
      throw new DomainError("VALIDATION_FAILED", `Backup snapshot is not canonical: ${row.snapshot_hash}.`, 422);
    }
    hashes.add(row.snapshot_hash);
  }
  return hashes;
}

interface VerifiedRevisionHead {
  id: string;
  version: number;
  revisionHash: string | null;
  documentName: string;
  schemaVersion: 1 | 2;
  designSystemPin: VerifiedDesignSystemPin | null;
}

function verifyRevisionAndHeadIntegrity(
  sqlite: Database.Database,
  migrationVersion: number,
  snapshotHashes: ReadonlySet<string>,
  databaseAssets: ReadonlyMap<string, VerifiedDatabaseAsset>,
): void {
  boundedTableCount(sqlite, "revisions");
  boundedTableCount(sqlite, "designs");
  const designRows = sqlite.prepare(
    `SELECT id, name, current_version, current_revision_id,
            ${migrationVersion >= 3 ? "organization_id" : "NULL"} AS organization_id
     FROM designs ORDER BY id`,
  ).all() as Array<{
    id: unknown;
    name: unknown;
    current_version: unknown;
    current_revision_id: unknown;
    organization_id: unknown;
  }>;
  const designsById = new Map<string, VerifiedDesignOwnership>();
  for (const design of designRows) {
    if (typeof design.id !== "string"
      || !design.id
      || designsById.has(design.id)
      || typeof design.name !== "string"
      || !Number.isSafeInteger(design.current_version)
      || typeof design.current_revision_id !== "string"
      || (migrationVersion >= 3 && (typeof design.organization_id !== "string" || !design.organization_id))
      || (migrationVersion < 3 && design.organization_id !== null)) {
      throw new DomainError("VALIDATION_FAILED", "Backup database contains an invalid project head tuple.", 422);
    }
    designsById.set(design.id, {
      id: design.id,
      organizationId: design.organization_id as string | null,
    });
  }
  const designSystemState = loadVerifiedDesignSystemState(sqlite, migrationVersion, designsById);
  const hasIntegrityHashes = migrationVersion >= 2;
  const columns = hasIntegrityHashes
    ? ", snapshot_hash, operation_hash, parent_revision_hash, revision_hash"
    : "";
  const rows = sqlite.prepare(
    `SELECT id, design_id, version, parent_revision_id, actor_id, message,
            length(CAST(document_json AS BLOB)) AS document_bytes,
            length(CAST(operations_json AS BLOB)) AS operation_bytes,
            created_at${columns}
     FROM revisions ORDER BY design_id, version, id`,
  ).iterate() as Iterable<Record<string, unknown>>;
  const readPayloads = sqlite.prepare(
    "SELECT document_json, operations_json FROM revisions WHERE id = ?",
  );
  const heads = new Map<string, VerifiedRevisionHead>();
  const revisionIds = new Set<string>();
  const revisionHashes = new Set<string>();
  for (const row of rows) {
    if (
      typeof row.id !== "string"
      || !row.id
      || revisionIds.has(row.id)
      || typeof row.design_id !== "string"
      || !row.design_id
      || !Number.isSafeInteger(row.version)
      || (row.version as number) < 1
      || (row.parent_revision_id !== null && typeof row.parent_revision_id !== "string")
      || typeof row.actor_id !== "string"
      || (row.message !== null && typeof row.message !== "string")
      || typeof row.created_at !== "string"
      || !Number.isSafeInteger(row.document_bytes)
      || (row.document_bytes as number) < 0
      || (row.document_bytes as number) > MAX_BACKUP_JSON_BYTES
      || !Number.isSafeInteger(row.operation_bytes)
      || (row.operation_bytes as number) < 0
      || (row.operation_bytes as number) > MAX_BACKUP_OPERATION_BYTES
    ) {
      throw new DomainError("VALIDATION_FAILED", "Backup database contains invalid revision metadata.", 422);
    }
    const payloads = readPayloads.get(row.id) as { document_json?: unknown; operations_json?: unknown } | undefined;
    const document = parseStoredDesignDocument(payloads?.document_json, `Backup revision ${row.id} document`);
    const operations = parseStoredOperations(payloads?.operations_json, `Backup revision ${row.id} operations`);
    if (document.id !== row.design_id || document.revision !== row.version) {
      throw new DomainError("VALIDATION_FAILED", `Backup revision document identity mismatch: ${row.id}.`, 422);
    }
    const design = designsById.get(row.design_id);
    if (!design) {
      throw new DomainError("VALIDATION_FAILED", `Backup revision references a missing project: ${row.design_id}.`, 422);
    }
    verifyDocumentAssetReferences(document, databaseAssets, design);
    verifyDocumentDesignSystemReference(document, design, designSystemState);
    const prior = heads.get(row.design_id);
    if (!prior) {
      if (row.version !== 1 || row.parent_revision_id !== null) {
        throw new DomainError("VALIDATION_FAILED", `Backup revision chain starts incorrectly for project ${row.design_id}.`, 422);
      }
    } else if (row.version !== prior.version + 1 || row.parent_revision_id !== prior.id) {
      throw new DomainError("VALIDATION_FAILED", `Backup revision chain is non-contiguous for project ${row.design_id}.`, 422);
    }

    let verifiedRevisionHash: string | null = null;
    if (hasIntegrityHashes) {
      if (
        typeof row.snapshot_hash !== "string"
        || !/^[a-f0-9]{64}$/.test(row.snapshot_hash)
        || !snapshotHashes.has(row.snapshot_hash)
        || typeof row.operation_hash !== "string"
        || !/^[a-f0-9]{64}$/.test(row.operation_hash)
        || typeof row.revision_hash !== "string"
        || !/^[a-f0-9]{64}$/.test(row.revision_hash)
        || revisionHashes.has(row.revision_hash)
        || (prior ? row.parent_revision_hash !== prior.revisionHash : row.parent_revision_hash !== null)
      ) {
        throw new DomainError("VALIDATION_FAILED", `Backup revision integrity metadata is invalid: ${row.id}.`, 422);
      }
      const documentSnapshot = canonicalSnapshot(document);
      if (documentSnapshot.hash !== row.snapshot_hash || operationHash(operations) !== row.operation_hash) {
        throw new DomainError("VALIDATION_FAILED", `Backup revision payload hash mismatch: ${row.id}.`, 422);
      }
      const computedRevisionHash = revisionHash({
        parentRevisionHash: prior?.revisionHash ?? null,
        snapshotHash: row.snapshot_hash,
        operationHash: row.operation_hash,
        metadata: {
          id: row.id,
          designId: row.design_id,
          version: row.version as number,
          parentRevisionId: row.parent_revision_id as string | null,
          actorId: row.actor_id,
          message: row.message as string | null,
          createdAt: row.created_at,
        },
      });
      if (computedRevisionHash !== row.revision_hash) {
        throw new DomainError("VALIDATION_FAILED", `Backup revision hash mismatch: ${row.id}.`, 422);
      }
      verifiedRevisionHash = row.revision_hash;
      revisionHashes.add(row.revision_hash);
    }
    revisionIds.add(row.id);
    heads.set(row.design_id, {
      id: row.id,
      version: row.version as number,
      revisionHash: verifiedRevisionHash,
      documentName: document.name,
      schemaVersion: document.schema_version,
      designSystemPin: verifiedDocumentDesignSystemPin(document),
    });
  }

  const seenDesigns = new Set<string>();
  for (const design of designRows) {
    const designId = design.id as string;
    if (seenDesigns.has(designId)) throw new DomainError("VALIDATION_FAILED", "Backup database repeats a project head tuple.", 422);
    const head = heads.get(designId);
    if (
      !head
      || head.version !== design.current_version
      || head.id !== design.current_revision_id
      || head.documentName !== design.name
    ) {
      throw new DomainError("VALIDATION_FAILED", `Backup project head is inconsistent: ${designId}.`, 422);
    }
    const persistedPin = designSystemState?.pinsByDesignId.get(designId);
    if (head.schemaVersion === 2) {
      if (!head.designSystemPin) {
        throw new DomainError("VALIDATION_FAILED", `Backup V2 project head is missing its design-system pin: ${designId}.`, 422);
      }
      if (persistedPin) {
        if (persistedPin.designSystemId !== head.designSystemPin.designSystemId
          || persistedPin.releaseId !== head.designSystemPin.releaseId
          || persistedPin.releaseVersion !== head.designSystemPin.releaseVersion) {
          throw new DomainError(
            "VALIDATION_FAILED",
            `Backup V2 project head does not match its persisted design-system pin: ${designId}.`,
            422,
          );
        }
      } else if (!isFoundationDesignSystemPin(head.designSystemPin)) {
        throw new DomainError(
          "VALIDATION_FAILED",
          `Backup V2 project head has no persisted custom design-system pin: ${designId}.`,
          422,
        );
      }
    }
    seenDesigns.add(designId);
  }
  if (seenDesigns.size !== heads.size) {
    throw new DomainError("VALIDATION_FAILED", "Backup revisions reference a project without a matching head tuple.", 422);
  }
}

async function verifyExtractedBackup(
  root: string,
  metrics: { entryCount: number; expandedBytes: number },
  options: BackupVerificationOptions,
): Promise<BackupVerificationResult> {
  const manifestPath = path.join(root, "backup-manifest.json");
  const checksumPath = path.join(root, "checksums.sha256");
  const databasePath = path.join(root, "database.sqlite");
  if (!fs.existsSync(manifestPath) || !fs.existsSync(checksumPath) || !fs.existsSync(databasePath)) {
    throw new DomainError("VALIDATION_FAILED", "Backup is missing required files.", 422);
  }
  const manifestContents = await readBackupControlFile(manifestPath, "Backup manifest");
  const checksumContents = await readBackupControlFile(checksumPath, "Backup checksum manifest");
  const manifest = parseBackupManifest(manifestContents);
  const checksums = parseBackupChecksums(checksumContents);
  if (!checksums.has("backup-manifest.json")) {
    throw new DomainError("VALIDATION_FAILED", "Backup checksum coverage is missing: backup-manifest.json.", 422);
  }
  const manifestDigest = await fileDigest(manifestPath);
  if (checksums.get("backup-manifest.json") !== manifestDigest.sha256) {
    throw new DomainError("VALIDATION_FAILED", "Backup manifest checksum failed.", 422);
  }

  const manifestPaths = new Set(manifest.files.map((file) => file.path));
  const manifestFiles = new Map(manifest.files.map((file) => [file.path, file]));
  for (const required of REQUIRED_BACKUP_PAYLOAD_PATHS) {
    if (!manifestPaths.has(required)) {
      throw new DomainError("VALIDATION_FAILED", `Backup manifest is missing required payload ${required}.`, 422);
    }
  }
  const allowedArchivePaths = new Set(["backup-manifest.json", "checksums.sha256", ...manifestPaths]);
  const archivePaths = await listFiles(root);
  const archivePathSet = new Set(archivePaths);
  for (const relative of archivePaths) {
    const normalized = canonicalBackupPath(relative);
    if (!allowedArchivePaths.has(normalized)) {
      throw new DomainError("VALIDATION_FAILED", `Backup contains an undeclared payload: ${normalized}.`, 422);
    }
  }
  for (const expected of allowedArchivePaths) {
    if (!archivePathSet.has(expected)) {
      throw new DomainError("VALIDATION_FAILED", `Backup file is missing: ${expected}.`, 422);
    }
  }

  const requiredChecksumPaths = new Set(["backup-manifest.json", ...manifestPaths]);
  for (const checksumPath of checksums.keys()) {
    if (!requiredChecksumPaths.has(checksumPath)) {
      throw new DomainError(
        "VALIDATION_FAILED",
        `Backup checksum manifest contains an undeclared path: ${checksumPath}.`,
        422,
      );
    }
  }
  for (const required of requiredChecksumPaths) {
    if (!checksums.has(required)) {
      throw new DomainError("VALIDATION_FAILED", `Backup checksum coverage is missing: ${required}.`, 422);
    }
  }

  for (const file of manifest.files) {
    const relative = file.path;
    const absolute = path.join(root, ...relative.split("/"));
    const actual = await fileDigest(absolute);
    if (file.sizeBytes !== actual.sizeBytes || file.sha256 !== actual.sha256 || checksums.get(relative) !== actual.sha256) {
      throw new DomainError("VALIDATION_FAILED", `Backup checksum failed: ${relative}.`, 422);
    }
  }
  const assetManifestContents = await readBackupControlFile(
    path.join(root, "asset-manifest.json"),
    "Asset manifest",
  );
  const organizationConfigContents = await readBackupControlFile(
    path.join(root, "organization-config.yaml"),
    "Organization configuration",
  );
  const archivedAssets = verifyAssetManifestFileSet(parseAssetManifest(assetManifestContents), manifestFiles);

  let sqlite: Database.Database;
  try {
    sqlite = new Database(databasePath, { readonly: true, fileMustExist: true });
  } catch (error) {
    throw new DomainError("VALIDATION_FAILED", "Backup database is not a readable SQLite database.", 422, { cause: error });
  }
  try {
    sqlite.pragma("query_only = ON");
    const integrity = sqlite.pragma("integrity_check", { simple: true }) as string;
    if (integrity !== "ok") throw new DomainError("VALIDATION_FAILED", `SQLite integrity check failed: ${integrity}`, 422);
    let foreignKeyViolations = 0;
    for (const _row of sqlite.prepare("PRAGMA foreign_key_check").iterate()) {
      foreignKeyViolations += 1;
      if (foreignKeyViolations > MAX_FOREIGN_KEY_DIAGNOSTICS) {
        throw new DomainError("VALIDATION_FAILED", "Backup contains too many foreign-key violations.", 422, {
          details: { countAtLeast: foreignKeyViolations },
        });
      }
    }
    if (foreignKeyViolations > 0) {
      throw new DomainError("VALIDATION_FAILED", "Backup contains foreign-key violations.", 422, {
        details: { count: foreignKeyViolations },
      });
    }
    const migrationVersion = verifyDatabaseMigrationLedger(sqlite, manifest.databaseSchemaVersion);
    if (manifest.formatVersion >= 2 && migrationVersion >= 3) {
      verifyOrganizationPolicyBackupConfiguration(sqlite, organizationConfigContents);
    }
    const databaseAssets = await verifyDatabaseAssetReferences(sqlite, archivedAssets, root, migrationVersion, options);
    const snapshotHashes = migrationVersion >= 2 ? verifySnapshotIntegrity(sqlite) : new Set<string>();
    verifyRevisionAndHeadIntegrity(sqlite, migrationVersion, snapshotHashes, databaseAssets);
    return {
      valid: true,
      manifest,
      sqliteIntegrity: "ok",
      foreignKeyViolations,
      extractedBytes: metrics.expandedBytes,
      entryCount: metrics.entryCount,
    };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError("VALIDATION_FAILED", "Backup database validation failed.", 422, { cause: error });
  } finally {
    sqlite.close();
  }
}

async function verifyExtractedForensicRecovery(
  root: string,
  metrics: { entryCount: number; expandedBytes: number },
  expectedOperationId?: string,
): Promise<ForensicRecoveryVerificationResult> {
  const manifestPath = path.join(root, FORENSIC_RECOVERY_MANIFEST);
  const checksumPath = path.join(root, "checksums.sha256");
  if (!fs.existsSync(manifestPath) || !fs.existsSync(checksumPath)) {
    throw new DomainError("VALIDATION_FAILED", "Forensic recovery bundle is missing required control files.", 422);
  }
  const manifestContents = await readBackupControlFile(manifestPath, "Forensic recovery manifest");
  const checksumContents = await readBackupControlFile(checksumPath, "Forensic recovery checksums");
  const manifest = parseForensicRecoveryManifest(manifestContents);
  if (expectedOperationId !== undefined && manifest.operationId !== expectedOperationId) {
    throw new DomainError("VERSION_CONFLICT", "Forensic recovery bundle belongs to a different restore operation.", 409);
  }
  const checksums = parseBackupChecksums(checksumContents);
  const manifestDigest = await fileDigest(manifestPath);
  if (checksums.get(FORENSIC_RECOVERY_MANIFEST) !== manifestDigest.sha256) {
    throw new DomainError("VALIDATION_FAILED", "Forensic recovery manifest checksum failed.", 422);
  }
  const payloadPaths = new Set(manifest.files.map((file) => file.path));
  const allowedPaths = new Set([FORENSIC_RECOVERY_MANIFEST, "checksums.sha256", ...payloadPaths]);
  const archivePaths = await listFiles(root);
  const archivePathSet = new Set(archivePaths);
  for (const relative of archivePaths) {
    const normalized = canonicalBackupPath(relative);
    if (!allowedPaths.has(normalized)) {
      throw new DomainError("VALIDATION_FAILED", `Forensic recovery bundle contains undeclared payload ${normalized}.`, 422);
    }
  }
  for (const expected of allowedPaths) {
    if (!archivePathSet.has(expected)) {
      throw new DomainError("VALIDATION_FAILED", `Forensic recovery file is missing: ${expected}.`, 422);
    }
  }
  const requiredChecksums = new Set([FORENSIC_RECOVERY_MANIFEST, ...payloadPaths]);
  if (checksums.size !== requiredChecksums.size) {
    throw new DomainError("VALIDATION_FAILED", "Forensic recovery checksum coverage is not exact.", 422);
  }
  for (const required of requiredChecksums) {
    if (!checksums.has(required)) {
      throw new DomainError("VALIDATION_FAILED", `Forensic recovery checksum is missing: ${required}.`, 422);
    }
  }
  for (const file of manifest.files) {
    const actual = await fileDigest(path.join(root, ...file.path.split("/")));
    if (actual.sizeBytes !== file.sizeBytes || actual.sha256 !== file.sha256
      || checksums.get(file.path) !== actual.sha256) {
      throw new DomainError("VALIDATION_FAILED", `Forensic recovery checksum failed: ${file.path}.`, 422);
    }
  }
  return {
    valid: true,
    manifest,
    extractedBytes: metrics.expandedBytes,
    entryCount: metrics.entryCount,
  };
}

function restoreErrorMessage(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  while (Buffer.byteLength(message, "utf8") > MAX_RESTORE_JOURNAL_MESSAGE_BYTES) {
    message = message.slice(0, Math.max(0, message.length - 256));
  }
  return message;
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EINVAL" || code === "ENOTSUP";
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.promises.open(directory, "r");
  try {
    try {
      await handle.sync();
    } catch (error) {
      if (!isUnsupportedDirectorySync(error)) throw error;
    }
  } finally {
    await handle.close();
  }
}

async function syncMoveParents(source: string, destination: string): Promise<void> {
  const directories = new Set([path.dirname(source), path.dirname(destination)]);
  for (const directory of directories) await syncDirectory(directory);
}

async function pathExists(filename: string): Promise<boolean> {
  try {
    await fs.promises.lstat(filename);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function restoreEntryName(value: unknown): string {
  if (typeof value !== "string") {
    throw new DomainError("VALIDATION_FAILED", "The restore journal contains an invalid entry name.", 422);
  }
  const normalized = portablePath(value);
  if (normalized.includes("/") || normalized === RESTORE_JOURNAL_DIRECTORY) {
    throw new DomainError("VALIDATION_FAILED", "The restore journal contains an unsafe top-level entry.", 422);
  }
  return normalized;
}

async function topLevelEntries(root: string, excluded = new Set<string>()): Promise<string[]> {
  if (!await pathExists(root)) return [];
  const entries = await fs.promises.readdir(root);
  return entries
    .filter((entry) => !excluded.has(entry))
    .map(restoreEntryName)
    .sort((left, right) => left.localeCompare(right));
}

function restoreJournalPaths(destination: string): {
  root: string;
  candidate: string;
  rollback: string;
  journal: string;
} {
  const root = path.join(destination, RESTORE_JOURNAL_DIRECTORY);
  return {
    root,
    candidate: path.join(root, "candidate"),
    rollback: path.join(root, "rollback"),
    journal: path.join(root, RESTORE_JOURNAL_FILENAME),
  };
}

function parseRestoreJournal(value: unknown): RestoreJournal {
  if (!value || typeof value !== "object") {
    throw new DomainError("VALIDATION_FAILED", "The restore journal is malformed.", 422);
  }
  const candidate = value as Partial<RestoreJournal>;
  const phases = new Set<RestoreJournalPhase>([
    "staging",
    "moving-originals",
    "moving-candidate",
    "health-check",
    "rolling-back",
    "rolled-back",
    "committed",
  ]);
  const actions = new Set<RestoreMoveAction>([
    "move-original",
    "move-candidate",
    "rollback-candidate",
    "rollback-original",
  ]);
  if (
    candidate.format !== RESTORE_JOURNAL_FORMAT
    || candidate.version !== RESTORE_JOURNAL_VERSION
    || typeof candidate.restoreId !== "string"
    || !/^[a-f0-9-]{36}$/.test(candidate.restoreId)
    || !/^[a-f0-9]{64}$/.test(candidate.sourceBundleSha256 ?? "")
    || !isCanonicalIsoTimestamp(candidate.createdAt)
    || !isCanonicalIsoTimestamp(candidate.updatedAt)
    || !phases.has(candidate.phase as RestoreJournalPhase)
    || typeof candidate.candidateCutoverStarted !== "boolean"
    || !Array.isArray(candidate.originalEntries)
    || !Array.isArray(candidate.candidateEntries)
    || !Array.isArray(candidate.steps)
    || candidate.originalEntries.length > MAX_BACKUP_ENTRIES
    || candidate.candidateEntries.length > MAX_BACKUP_ENTRIES
    || candidate.steps.length > MAX_BACKUP_ENTRIES
  ) {
    throw new DomainError("VALIDATION_FAILED", "The restore journal is unsupported or incomplete.", 422);
  }
  const originalEntries = candidate.originalEntries.map(restoreEntryName);
  const candidateEntries = candidate.candidateEntries.map(restoreEntryName);
  if (new Set(originalEntries).size !== originalEntries.length || new Set(candidateEntries).size !== candidateEntries.length) {
    throw new DomainError("VALIDATION_FAILED", "The restore journal contains duplicate top-level entries.", 422);
  }
  const steps = candidate.steps.map((step, index): RestoreMoveStep => {
    if (
      !step
      || typeof step !== "object"
      || (step as RestoreMoveStep).sequence !== index + 1
      || !actions.has((step as RestoreMoveStep).action)
      || !["planned", "completed"].includes((step as RestoreMoveStep).status)
      || !isCanonicalIsoTimestamp((step as RestoreMoveStep).plannedAt)
      || ((step as RestoreMoveStep).completedAt !== undefined
        && !isCanonicalIsoTimestamp((step as RestoreMoveStep).completedAt))
    ) {
      throw new DomainError("VALIDATION_FAILED", "The restore journal contains an invalid move step.", 422);
    }
    return { ...(step as RestoreMoveStep), entry: restoreEntryName((step as RestoreMoveStep).entry) };
  });
  if (candidate.failure !== undefined) {
    if (!isRecord(candidate.failure)
      || typeof candidate.failure.cutover !== "string"
      || Buffer.byteLength(candidate.failure.cutover, "utf8") > MAX_RESTORE_JOURNAL_MESSAGE_BYTES
      || (candidate.failure.rollback !== undefined
        && (typeof candidate.failure.rollback !== "string"
          || Buffer.byteLength(candidate.failure.rollback, "utf8") > MAX_RESTORE_JOURNAL_MESSAGE_BYTES))) {
      throw new DomainError("VALIDATION_FAILED", "The restore journal contains invalid failure metadata.", 422);
    }
  }
  return {
    format: RESTORE_JOURNAL_FORMAT,
    version: RESTORE_JOURNAL_VERSION,
    restoreId: candidate.restoreId,
    sourceBundleSha256: candidate.sourceBundleSha256!,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
    phase: candidate.phase as RestoreJournalPhase,
    candidateCutoverStarted: candidate.candidateCutoverStarted,
    originalEntries,
    candidateEntries,
    steps,
    ...(candidate.failure ? { failure: candidate.failure } : {}),
  };
}

async function writeRestoreJournal(journalRoot: string, journal: RestoreJournal): Promise<void> {
  journal.updatedAt = new Date().toISOString();
  const validated = parseRestoreJournal(journal);
  const serialized = `${JSON.stringify(validated, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > RESTORE_JOURNAL_MAX_BYTES) {
    throw new DomainError("PAYLOAD_TOO_LARGE", "The restore journal exceeds its fixed safety limit.", 413);
  }
  const rootStat = await fs.promises.lstat(journalRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new DomainError("VALIDATION_FAILED", "The restore journal root is not a real directory.", 422);
  }
  const destination = path.join(journalRoot, RESTORE_JOURNAL_FILENAME);
  const temporary = path.join(journalRoot, `.journal-${randomUUID()}.tmp`);
  const handle = await fs.promises.open(temporary, "wx", 0o600);
  try {
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.promises.rename(temporary, destination);
    await syncDirectory(journalRoot);
  } finally {
    await fs.promises.rm(temporary, { force: true });
  }
}

async function readRestoreJournal(destination: string): Promise<RestoreJournal | null> {
  const locations = restoreJournalPaths(destination);
  if (!await pathExists(locations.root)) return null;
  const stat = await fs.promises.lstat(locations.root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new DomainError("VALIDATION_FAILED", "The reserved restore-journal path is not a real directory.", 422);
  }
  if (!await pathExists(locations.journal)) {
    const entries = await fs.promises.readdir(locations.root);
    if (entries.length === 0) {
      await fs.promises.rmdir(locations.root);
      return null;
    }
    throw new DomainError(
      "VALIDATION_FAILED",
      "An incomplete restore journal has no recoverable ledger; its files were preserved for operator inspection.",
      422,
    );
  }
  let handle: fs.promises.FileHandle | undefined;
  try {
    const entry = await fs.promises.lstat(locations.journal, { bigint: true });
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > BigInt(RESTORE_JOURNAL_MAX_BYTES)) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "The restore journal is not a bounded regular file; it was preserved for operator inspection.",
        422,
      );
    }
    handle = await fs.promises.open(
      locations.journal,
      process.platform === "win32"
        ? fs.constants.O_RDONLY
        : fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || stat.size > BigInt(RESTORE_JOURNAL_MAX_BYTES)
      || stat.dev !== entry.dev || stat.ino !== entry.ino) {
      throw new DomainError("VALIDATION_FAILED", "The restore journal changed while it was opened.", 422);
    }
    const buffer = Buffer.alloc(RESTORE_JOURNAL_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > RESTORE_JOURNAL_MAX_BYTES) {
      throw new DomainError("VALIDATION_FAILED", "The restore journal exceeds its fixed safety limit.", 422);
    }
    return parseRestoreJournal(JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")) as unknown);
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(
      "VALIDATION_FAILED",
      "The restore journal cannot be parsed; its files were preserved for operator inspection.",
      422,
      { details: { reason: restoreErrorMessage(error) } },
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export type RestoreJournalInspection =
  | { present: false }
  | {
    present: true;
    phase: RestoreJournalPhase;
    candidateCutoverStarted: boolean;
  };

/**
 * Read only the bounded restore-journal state needed to decide whether the
 * normal API may safely open SQLite. Paths, hashes, and move entries are never
 * exposed to the caller.
 */
export async function inspectRestoreJournal(dataDirectory: string): Promise<RestoreJournalInspection> {
  const journal = await readRestoreJournal(path.resolve(dataDirectory));
  return journal === null
    ? { present: false }
    : {
      present: true,
      phase: journal.phase,
      candidateCutoverStarted: journal.candidateCutoverStarted,
    };
}

export async function committedRestoreJournalMatches(
  dataDirectory: string,
  expectedBundleSha256: string,
): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/.test(expectedBundleSha256)) {
    throw new DomainError("VALIDATION_FAILED", "Expected restore bundle hash is invalid.", 422);
  }
  const journal = await readRestoreJournal(path.resolve(dataDirectory));
  return journal?.phase === "committed" && journal.sourceBundleSha256 === expectedBundleSha256;
}

export async function finalizeTerminalRestoreJournal(
  dataDirectory: string,
  expectedPhase: "committed" | "rolled-back",
): Promise<{ cleaned: boolean }> {
  const destination = path.resolve(dataDirectory);
  const journal = await readRestoreJournal(destination);
  if (journal === null) return { cleaned: false };
  if (journal.phase !== expectedPhase) {
    throw new DomainError(
      "VERSION_CONFLICT",
      `Restore journal phase ${journal.phase} cannot be finalized as ${expectedPhase}.`,
      409,
    );
  }
  if (expectedPhase === "rolled-back") await assertOriginalEntriesAreLive(destination, journal);
  await cleanupRestoreJournal(destination);
  return { cleaned: true };
}

async function moveWithoutReplacement(source: string, destination: string): Promise<void> {
  if (!await pathExists(source)) {
    throw new DomainError("INTERNAL_ERROR", `Restore move source is missing: ${path.basename(source)}`, 500);
  }
  if (await pathExists(destination)) {
    throw new DomainError("INTERNAL_ERROR", `Restore move target already exists: ${path.basename(destination)}`, 500);
  }
  await fs.promises.rename(source, destination);
  await syncMoveParents(source, destination);
}

async function recordedRestoreMove(
  journalRoot: string,
  journal: RestoreJournal,
  action: RestoreMoveAction,
  entry: string,
  source: string,
  destination: string,
): Promise<void> {
  let step = [...journal.steps].reverse().find((candidate) => (
    candidate.action === action && candidate.entry === entry && candidate.status === "planned"
  ));
  if (!step) {
    step = {
      sequence: journal.steps.length + 1,
      action,
      entry,
      status: "planned",
      plannedAt: new Date().toISOString(),
    };
    journal.steps.push(step);
    await writeRestoreJournal(journalRoot, journal);
  }
  await moveWithoutReplacement(source, destination);
  step.status = "completed";
  step.completedAt = new Date().toISOString();
  await writeRestoreJournal(journalRoot, journal);
}

async function setRestorePhase(journalRoot: string, journal: RestoreJournal, phase: RestoreJournalPhase): Promise<void> {
  journal.phase = phase;
  await writeRestoreJournal(journalRoot, journal);
}

async function rollbackRestoreCutover(destination: string, journal: RestoreJournal): Promise<void> {
  const locations = restoreJournalPaths(destination);
  await setRestorePhase(locations.root, journal, "rolling-back");

  if (journal.candidateCutoverStarted) {
    for (const entry of [...journal.candidateEntries].reverse()) {
      const live = path.join(destination, entry);
      const staged = path.join(locations.candidate, entry);
      const liveExists = await pathExists(live);
      const stagedExists = await pathExists(staged);
      if (liveExists && stagedExists) {
        throw new DomainError(
          "INTERNAL_ERROR",
          `Rollback found both live and staged candidate entries for ${entry}; neither copy was removed.`,
          500,
        );
      }
      if (liveExists) {
        await recordedRestoreMove(locations.root, journal, "rollback-candidate", entry, live, staged);
      }
    }
  }

  for (const entry of journal.originalEntries) {
    const live = path.join(destination, entry);
    const rollback = path.join(locations.rollback, entry);
    const liveExists = await pathExists(live);
    const rollbackExists = await pathExists(rollback);
    if (liveExists && rollbackExists) {
      throw new DomainError(
        "INTERNAL_ERROR",
        `Rollback found both live and saved original entries for ${entry}; neither copy was removed.`,
        500,
      );
    }
    if (rollbackExists) {
      await recordedRestoreMove(locations.root, journal, "rollback-original", entry, rollback, live);
    } else if (!liveExists) {
      throw new DomainError("INTERNAL_ERROR", `Rollback cannot locate the original entry ${entry}.`, 500);
    }
  }
  await setRestorePhase(locations.root, journal, "rolled-back");
}

async function assertOriginalEntriesAreLive(destination: string, journal: RestoreJournal): Promise<void> {
  const locations = restoreJournalPaths(destination);
  for (const entry of journal.originalEntries) {
    if (!await pathExists(path.join(destination, entry)) || await pathExists(path.join(locations.rollback, entry))) {
      throw new DomainError(
        "INTERNAL_ERROR",
        `Restore recovery cannot prove that original entry ${entry} is live; the journal was preserved.`,
        500,
      );
    }
  }
}

async function cleanupRestoreJournal(destination: string): Promise<void> {
  const locations = restoreJournalPaths(destination);
  await fs.promises.rm(locations.candidate, { recursive: true, force: true });
  await fs.promises.rm(locations.rollback, { recursive: true, force: true });
  if (await pathExists(locations.root)) {
    for (const entry of await fs.promises.readdir(locations.root)) {
      if (entry.startsWith(".journal-") && entry.endsWith(".tmp")) {
        await fs.promises.rm(path.join(locations.root, entry), { force: true });
      }
    }
  }
  await fs.promises.rm(locations.journal, { force: true });
  if (await pathExists(locations.root)) await fs.promises.rmdir(locations.root);
}

async function recoverExistingRestoreJournal(destination: string, requestedBundleSha256: string): Promise<"continue" | "already-committed"> {
  const journal = await readRestoreJournal(destination);
  if (!journal) return "continue";
  const locations = restoreJournalPaths(destination);

  if (journal.phase === "committed") {
    const sameBundle = requestedBundleSha256 === journal.sourceBundleSha256;
    if (sameBundle) return "already-committed";
    await cleanupRestoreJournal(destination);
    return "continue";
  }

  if (journal.phase === "rolled-back") {
    await assertOriginalEntriesAreLive(destination, journal);
    await cleanupRestoreJournal(destination);
    return "continue";
  }

  const hasCutoverSteps = journal.steps.some((step) => step.action === "move-original" || step.action === "move-candidate");
  if (journal.phase === "staging" && !hasCutoverSteps) {
    await cleanupRestoreJournal(destination);
    return "continue";
  }

  await rollbackRestoreCutover(destination, journal);
  await assertOriginalEntriesAreLive(destination, journal);
  await cleanupRestoreJournal(destination);
  return "continue";
}

export class BackupManager {
  constructor(
    private readonly database: Pick<DesignerDatabase, "sqlite">,
    private readonly dataDirectory: string,
    private readonly backupDirectory: string,
    readonly rasterVerifier?: BackupRasterVerifier,
  ) {}

  async create(): Promise<{ path: string; verification: BackupVerificationResult }> {
    await fs.promises.mkdir(this.backupDirectory, { recursive: true, mode: 0o700 });
    const sourceBytes = await regularFileBytes(this.dataDirectory);
    await requireFilesystemCapacity(
      this.backupDirectory,
      sourceBytes,
      3,
      "creating a verified backup",
    );
    const now = new Date();
    const timestamp = now.toISOString().replaceAll(/[:.]/g, "-");
    const staging = path.join(this.backupDirectory, `.staging-${randomUUID()}`);
    const bundle = path.join(this.backupDirectory, `formaspec-backup-${timestamp}.tar`);
    await fs.promises.mkdir(staging, { recursive: true, mode: 0o700 });
    try {
      const stagedDatabasePath = path.join(staging, "database.sqlite");
      await this.database.sqlite.backup(stagedDatabasePath);
      const stagedDatabase = new Database(stagedDatabasePath);
      let stagedDatabaseSchemaVersion: number;
      let stagedOrganizationConfiguration: string;
      try {
        const locksTable = stagedDatabase.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'operational_locks'",
        ).get();
        if (locksTable) stagedDatabase.prepare("DELETE FROM operational_locks").run();
        const migrationRows = stagedDatabase.prepare(
          "SELECT version, name FROM schema_migrations ORDER BY version",
        ).all() as Array<{ version: unknown; name: unknown }>;
        stagedDatabaseSchemaVersion = validateDatabaseMigrationLedger(migrationRows);
        validateDatabaseSchemaShape(stagedDatabase, stagedDatabaseSchemaVersion);
        stagedOrganizationConfiguration = organizationPolicyBackupJson(stagedDatabase);
      } finally {
        stagedDatabase.close();
      }
      await copyReferencedAssetFiles(stagedDatabasePath, this.dataDirectory, staging);
      const assetFiles = (await listFiles(path.join(staging, "assets"))).map((relative) => `assets/${relative}`);
      await fs.promises.writeFile(path.join(staging, "asset-manifest.json"), `${JSON.stringify({ files: assetFiles }, null, 2)}\n`, { mode: 0o600 });
      await fs.promises.writeFile(
        path.join(staging, "organization-config.yaml"),
        stagedOrganizationConfiguration,
        { mode: 0o600 },
      );

      const payloadFiles = (await listFiles(staging)).filter((file) => file !== "backup-manifest.json" && file !== "checksums.sha256");
      const fileRecords = await Promise.all(payloadFiles.map(async (relative) => {
        const digest = await fileDigest(path.join(staging, relative));
        return { path: portablePath(relative), sizeBytes: digest.sizeBytes, sha256: digest.sha256 };
      }));
      const manifest: BackupManifest = {
        format: "formaspec-backup",
        formatVersion: 2,
        createdAt: now.toISOString(),
        applicationBuildVersion: ENGINE_VERSIONS.applicationBuild,
        databaseSchemaVersion: stagedDatabaseSchemaVersion,
        documentSchemaVersion: ENGINE_VERSIONS.documentSchema,
        commandEngineVersion: ENGINE_VERSIONS.commandEngine,
        rendererVersion: ENGINE_VERSIONS.renderer,
        fontBundleVersion: ENGINE_VERSIONS.fontBundle,
        files: fileRecords,
      };
      await fs.promises.writeFile(path.join(staging, "backup-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      const allWithoutChecksums = await listFiles(staging);
      const checksumLines = await Promise.all(allWithoutChecksums.map(async (relative) => {
        const digest = await fileDigest(path.join(staging, relative));
        return `${digest.sha256}  ${portablePath(relative)}`;
      }));
      await fs.promises.writeFile(path.join(staging, "checksums.sha256"), `${checksumLines.sort().join("\n")}\n`, { mode: 0o600 });
      const stagedBytes = await regularFileBytes(staging);
      await requireFilesystemCapacity(
        this.backupDirectory,
        stagedBytes,
        2,
        "writing and verifying the backup bundle",
      );
      await writeDeterministicTar(staging, bundle);
      const verification = await verifyBackupBundle(bundle, {
        ...(this.rasterVerifier ? { rasterVerifier: this.rasterVerifier, requireRasterVerifier: true } : {}),
      });
      return { path: bundle, verification };
    } catch (error) {
      await fs.promises.rm(bundle, { force: true });
      throw error;
    } finally {
      await fs.promises.rm(staging, { recursive: true, force: true });
    }
  }
}

function deterministicRecoveryFilename(namespace: string): string {
  const digest = createHash("sha256").update(namespace).digest("hex").slice(0, 24);
  const decimal = BigInt(`0x${digest}`).toString(10).padStart(29, "0");
  return `formaspec-backup-1970-01-01T00-00-00-000Z-${decimal}.tar`;
}

export async function createForensicRecoveryBundle(
  dataDirectory: string,
  backupDirectory: string,
  operationId: string,
  _now: () => Date = () => new Date(),
): Promise<ForensicRecoveryBundleResult> {
  if (!/^restore_[A-Za-z0-9][A-Za-z0-9_-]{7,111}$/.test(operationId)) {
    throw new DomainError("VALIDATION_FAILED", "Forensic recovery operation ID is invalid.", 422);
  }
  const backupRoot = path.resolve(backupDirectory);
  await fs.promises.mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const backupRootStat = await fs.promises.lstat(backupRoot);
  if (!backupRootStat.isDirectory() || backupRootStat.isSymbolicLink()) {
    throw new DomainError("VALIDATION_FAILED", "Forensic recovery backup root must be a real directory.", 422);
  }
  const staging = path.join(backupRoot, `.forensic-${randomUUID()}`);
  const bundleStaging = path.join(backupRoot, `.forensic-bundle-${randomUUID()}`);
  const temporaryBundle = path.join(bundleStaging, "bundle.tar");
  const filename = deterministicRecoveryFilename(`safety\0${operationId}`);
  const destination = path.join(backupRoot, filename);
  // The durable restore-operation record carries the operator timestamp. Keep
  // snapshot bytes deterministic so a crash before state publication can
  // safely recreate and compare the same operation's forensic bundle.
  const createdAt = new Date(0).toISOString();
  await fs.promises.mkdir(staging, { mode: 0o700 });
  await fs.promises.mkdir(bundleStaging, { mode: 0o700 });
  try {
    const sourceBytes = await regularFileBytes(path.resolve(dataDirectory));
    await requireFilesystemCapacity(
      backupRoot,
      sourceBytes,
      2,
      "capturing the forensic recovery snapshot",
    );
    await copyForensicDataTree(dataDirectory, staging);
    const payloadFiles = (await listFiles(path.join(staging, FORENSIC_RECOVERY_PAYLOAD_ROOT)))
      .map((relative) => `${FORENSIC_RECOVERY_PAYLOAD_ROOT}/${relative}`);
    const files = await Promise.all(payloadFiles.map(async (relative) => {
      const digest = await fileDigest(path.join(staging, ...relative.split("/")));
      return { path: relative, sizeBytes: digest.sizeBytes, sha256: digest.sha256 };
    }));
    const manifest: ForensicRecoveryManifest = {
      format: FORENSIC_RECOVERY_FORMAT,
      version: FORENSIC_RECOVERY_VERSION,
      operationId,
      createdAt,
      files,
    };
    await fs.promises.writeFile(
      path.join(staging, FORENSIC_RECOVERY_MANIFEST),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o600 },
    );
    const checksumSources = await listFiles(staging);
    const checksumLines = await Promise.all(checksumSources.map(async (relative) => {
      const digest = await fileDigest(path.join(staging, ...relative.split("/")));
      return `${digest.sha256}  ${portablePath(relative)}`;
    }));
    await fs.promises.writeFile(
      path.join(staging, "checksums.sha256"),
      `${checksumLines.sort().join("\n")}\n`,
      { mode: 0o600 },
    );
    const stagedBytes = await regularFileBytes(staging);
    await requireFilesystemCapacity(backupRoot, stagedBytes, 2, "creating the forensic recovery snapshot");
    await writeDeterministicTar(staging, temporaryBundle);
    const digest = await fileDigest(temporaryBundle);
    if (await pathExists(destination)) {
      const existing = await fs.promises.lstat(destination);
      if (!existing.isFile() || existing.isSymbolicLink()) {
        throw new DomainError("VALIDATION_FAILED", "Forensic recovery destination is not a regular file.", 422);
      }
      const existingDigest = await fileDigest(destination);
      if (existingDigest.sha256 !== digest.sha256 || existingDigest.sizeBytes !== digest.sizeBytes) {
        throw new DomainError("IDEMPOTENCY_CONFLICT", "Forensic recovery operation already has different safety bytes.", 409);
      }
      await fs.promises.rm(temporaryBundle, { force: true });
    } else {
      await fs.promises.rename(temporaryBundle, destination);
      await fs.promises.chmod(destination, 0o400);
      await syncDirectory(backupRoot);
    }
    const verification = await verifyForensicRecoveryBundle(destination, { expectedOperationId: operationId });
    const finalDigest = await fileDigest(destination);
    return {
      path: destination,
      filename,
      bundleSha256: finalDigest.sha256,
      sizeBytes: finalDigest.sizeBytes,
      createdAt,
      verification,
    };
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true });
    await fs.promises.rm(bundleStaging, { recursive: true, force: true });
  }
}

export async function inspectBackupBundle(
  bundlePath: string,
  options: BackupVerificationOptions = {},
): Promise<BackupInspectionResult> {
  const resolved = path.resolve(bundlePath);
  const source = await fs.promises.lstat(resolved).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new DomainError("NOT_FOUND", "Backup bundle is unavailable.", 404);
    throw error;
  });
  if (!source.isFile() || source.isSymbolicLink()) {
    throw new DomainError("VALIDATION_FAILED", "Backup bundle must be a regular non-symbolic file.", 422);
  }
  if (source.size > MAX_BACKUP_EXPANDED_BYTES) {
    throw new DomainError("PAYLOAD_TOO_LARGE", "Backup bundle exceeds the configured size limit.", 413);
  }
  await requireFilesystemCapacity(
    path.dirname(resolved),
    source.size,
    1,
    "extracting backup verification data",
  );
  const temporary = path.join(path.dirname(resolved), `.verify-${randomUUID()}`);
  try {
    const metrics = await extractTar(resolved, temporary);
    const verification = await verifyExtractedBackup(temporary, metrics, options);
    const database = new Database(path.join(temporary, "database.sqlite"), { readonly: true, fileMustExist: true });
    let organizationIds: string[];
    try {
      database.pragma("query_only = ON");
      const organizationsTable = database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'organizations'",
      ).get();
      organizationIds = organizationsTable
        ? (database.prepare("SELECT id FROM organizations ORDER BY id").all() as Array<{ id: string }>).map((row) => row.id)
        : ["organization_legacy"];
    } finally {
      database.close();
    }
    if (organizationIds.length < 1 || organizationIds.length > 16
      || organizationIds.some((id) => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(id))) {
      throw new DomainError("VALIDATION_FAILED", "Backup organization inventory is invalid.", 422);
    }
    return {
      verification,
      organizationIds,
    };
  } finally {
    await fs.promises.rm(temporary, { recursive: true, force: true });
  }
}

export async function verifyBackupBundle(
  bundlePath: string,
  options: BackupVerificationOptions = {},
): Promise<BackupVerificationResult> {
  return (await inspectBackupBundle(bundlePath, options)).verification;
}

export async function verifyForensicRecoveryBundle(
  bundlePath: string,
  options: { expectedOperationId?: string } = {},
): Promise<ForensicRecoveryVerificationResult> {
  const resolved = path.resolve(bundlePath);
  const source = await fs.promises.lstat(resolved).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new DomainError("NOT_FOUND", "Forensic recovery bundle is unavailable.", 404);
    throw error;
  });
  if (!source.isFile() || source.isSymbolicLink()) {
    throw new DomainError("VALIDATION_FAILED", "Forensic recovery bundle must be a regular non-symbolic file.", 422);
  }
  if (source.size > MAX_BACKUP_EXPANDED_BYTES) {
    throw new DomainError("PAYLOAD_TOO_LARGE", "Forensic recovery bundle exceeds the configured size limit.", 413);
  }
  await requireFilesystemCapacity(path.dirname(resolved), source.size, 1, "verifying the forensic recovery snapshot");
  const temporary = path.join(path.dirname(resolved), `.verify-${randomUUID()}`);
  try {
    const metrics = await extractTar(resolved, temporary);
    return await verifyExtractedForensicRecovery(temporary, metrics, options.expectedOperationId);
  } finally {
    await fs.promises.rm(temporary, { recursive: true, force: true });
  }
}

export interface ExpectedRestoreSource {
  sha256: string;
  sizeBytes?: number;
}

interface PinnedRestoreSource {
  path: string;
  sha256: string;
  sizeBytes: number;
  release(): Promise<void>;
}

async function pinRestoreSource(
  bundlePath: string,
  expected?: ExpectedRestoreSource,
  pinDirectory?: string,
): Promise<PinnedRestoreSource> {
  if (expected && !/^[a-f0-9]{64}$/.test(expected.sha256)) {
    throw new DomainError("VALIDATION_FAILED", "Restore source requires a valid expected SHA-256.", 422);
  }
  if (expected?.sizeBytes !== undefined && (
    !Number.isSafeInteger(expected.sizeBytes)
    || expected.sizeBytes < 0
    || expected.sizeBytes > MAX_BACKUP_EXPANDED_BYTES
  )) {
    throw new DomainError("VALIDATION_FAILED", "Restore source requires a valid expected size.", 422);
  }

  const resolved = path.resolve(bundlePath);
  const pinRoot = path.resolve(pinDirectory ?? os.tmpdir());
  const pinRootStat = await fs.promises.lstat(pinRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new DomainError("NOT_FOUND", "Restore source pin directory is unavailable.", 404);
    }
    throw error;
  });
  if (!pinRootStat.isDirectory() || pinRootStat.isSymbolicLink()) {
    throw new DomainError("VALIDATION_FAILED", "Restore source pin location must be a real directory.", 422);
  }
  const directory = await fs.promises.mkdtemp(path.join(pinRoot, ".formaspec-restore-source-"));
  await fs.promises.chmod(directory, 0o700);
  const pinnedPath = path.join(directory, "bundle.tar");
  let source: fs.promises.FileHandle | undefined;
  let destination: fs.promises.FileHandle | undefined;
  try {
    const pathStat = await fs.promises.lstat(resolved);
    if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
      throw new DomainError("VALIDATION_FAILED", "Restore source must be a regular non-symbolic file.", 422);
    }
    source = await fs.promises.open(
      resolved,
      process.platform === "win32"
        ? fs.constants.O_RDONLY
        : fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const before = await source.stat();
    if (!before.isFile() || before.size > MAX_BACKUP_EXPANDED_BYTES) {
      throw new DomainError("PAYLOAD_TOO_LARGE", "Restore source exceeds the configured bundle limit.", 413);
    }
    if (expected?.sizeBytes !== undefined && before.size !== expected.sizeBytes) {
      throw new DomainError("VALIDATION_FAILED", "Restore source changed after managed verification.", 422);
    }
    await requireFilesystemCapacity(pinRoot, before.size, 1, "pinning the restore source");

    destination = await fs.promises.open(pinnedPath, "wx", 0o600);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      if (position > MAX_BACKUP_EXPANDED_BYTES) {
        throw new DomainError("PAYLOAD_TOO_LARGE", "Restore source exceeds the configured bundle limit.", 413);
      }
      hash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const result = await destination.write(buffer, written, bytesRead - written, position - bytesRead + written);
        if (result.bytesWritten < 1) throw new Error("Pinned restore source write made no progress.");
        written += result.bytesWritten;
      }
    }
    const after = await source.stat();
    if (position !== before.size || after.size !== before.size
      || after.dev !== before.dev || after.ino !== before.ino
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new DomainError("VALIDATION_FAILED", "Restore source changed while it was being pinned.", 422);
    }
    const sha256 = hash.digest("hex");
    if (expected && (sha256 !== expected.sha256
      || (expected.sizeBytes !== undefined && position !== expected.sizeBytes))) {
      throw new DomainError("VALIDATION_FAILED", "Restore source changed after managed verification.", 422);
    }
    await destination.sync();
    await destination.close();
    destination = undefined;
    await fs.promises.chmod(pinnedPath, 0o400);
    return {
      path: pinnedPath,
      sha256,
      sizeBytes: position,
      release: async () => {
        await fs.promises.rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await destination?.close().catch(() => undefined);
    await source?.close().catch(() => undefined);
    await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    await destination?.close().catch(() => undefined);
    await source?.close().catch(() => undefined);
  }
}

export async function verifyPinnedBackupBundle(
  bundlePath: string,
  options: {
    expectedSource?: ExpectedRestoreSource;
    sourcePinDirectory?: string;
    rasterVerifier?: BackupRasterVerifier;
    requireRasterVerifier?: boolean;
  } = {},
): Promise<{
  verification: BackupVerificationResult;
  bundleSha256: string;
  sizeBytes: number;
}> {
  const pinnedSource = await pinRestoreSource(
    bundlePath,
    options.expectedSource,
    options.sourcePinDirectory,
  );
  let primaryError: unknown;
  try {
    const verification = await verifyBackupBundle(pinnedSource.path, {
      ...(options.rasterVerifier ? { rasterVerifier: options.rasterVerifier } : {}),
      ...(options.requireRasterVerifier === undefined
        ? {}
        : { requireRasterVerifier: options.requireRasterVerifier }),
    });
    return {
      verification,
      bundleSha256: pinnedSource.sha256,
      sizeBytes: pinnedSource.sizeBytes,
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await pinnedSource.release();
    } catch (cleanupError) {
      if (primaryError !== undefined) {
        throw new AggregateError(
          [primaryError, cleanupError],
          "Backup verification failed and its private pinned source could not be cleaned up.",
        );
      }
      throw cleanupError;
    }
  }
}

export async function verifyPinnedForensicRecoveryBundle(
  bundlePath: string,
  options: {
    expectedSource: ExpectedRestoreSource;
    sourcePinDirectory?: string;
    expectedOperationId?: string;
  },
): Promise<{
  verification: ForensicRecoveryVerificationResult;
  bundleSha256: string;
  sizeBytes: number;
}> {
  const pinnedSource = await pinRestoreSource(
    bundlePath,
    options.expectedSource,
    options.sourcePinDirectory,
  );
  let primaryError: unknown;
  try {
    const verification = await verifyForensicRecoveryBundle(pinnedSource.path, {
      ...(options.expectedOperationId ? { expectedOperationId: options.expectedOperationId } : {}),
    });
    return {
      verification,
      bundleSha256: pinnedSource.sha256,
      sizeBytes: pinnedSource.sizeBytes,
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await pinnedSource.release();
    } catch (cleanupError) {
      if (primaryError !== undefined) {
        throw new AggregateError(
          [primaryError, cleanupError],
          "Forensic recovery verification failed and its private pinned source could not be cleaned up.",
        );
      }
      throw cleanupError;
    }
  }
}

export async function openPinnedBackupStream(
  bundlePath: string,
  options: {
    expectedSource: ExpectedRestoreSource;
    sourcePinDirectory?: string;
  },
): Promise<{
  stream: fs.ReadStream;
  bundleSha256: string;
  sizeBytes: number;
}> {
  const pinnedSource = await pinRestoreSource(
    bundlePath,
    options.expectedSource,
    options.sourcePinDirectory,
  );
  let handle: fs.promises.FileHandle | undefined;
  let stream: fs.ReadStream | undefined;
  try {
    handle = await fs.promises.open(
      pinnedSource.path,
      process.platform === "win32"
        ? fs.constants.O_RDONLY
        : fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    stream = handle.createReadStream({ autoClose: true, start: 0 });
    handle = undefined;
    if (process.platform === "win32") {
      stream.once("close", () => {
        void pinnedSource.release().catch(() => undefined);
      });
    } else {
      // An unlinked, already-open descriptor cannot be path-swapped or
      // modified through the managed backup pathname while it is streamed.
      await pinnedSource.release();
    }
    return {
      stream,
      bundleSha256: pinnedSource.sha256,
      sizeBytes: pinnedSource.sizeBytes,
    };
  } catch (error) {
    stream?.destroy();
    await handle?.close().catch(() => undefined);
    await pinnedSource.release().catch(() => undefined);
    throw error;
  }
}

export async function restoreVerifiedBackup(
  bundlePath: string,
  destinationDataDirectory: string,
  options: {
    databaseClosed: true;
    expectedSource?: ExpectedRestoreSource;
    healthCheck?: (dataDirectory: string) => Promise<void>;
    sourcePinDirectory?: string;
    rasterVerifier?: BackupRasterVerifier;
    requireRasterVerifier?: boolean;
    sourceFormat?: "formaspec-backup" | "forensic-recovery";
    expectedForensicOperationId?: string;
  },
): Promise<void> {
  if (options.databaseClosed !== true) throw new DomainError("VALIDATION_FAILED", "Restore requires the database service to be stopped.", 409);
  const destination = path.resolve(destinationDataDirectory);
  if (destination === path.parse(destination).root) {
    throw new DomainError("VALIDATION_FAILED", "Restore cannot target a filesystem root.", 422);
  }
  if (await pathExists(destination)) {
    const stat = await fs.promises.lstat(destination);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new DomainError("VALIDATION_FAILED", "Restore requires a real destination data directory.", 422);
    }
  } else {
    await fs.promises.mkdir(destination, { recursive: true, mode: 0o700 });
  }

  if (options.expectedSource
    && await committedRestoreJournalMatches(destination, options.expectedSource.sha256)) {
    await options.healthCheck?.(destination);
    await finalizeTerminalRestoreJournal(destination, "committed");
    return;
  }

  const sourcePinDirectory = path.resolve(options.sourcePinDirectory ?? path.dirname(destination));
  if (sourcePinDirectory === destination || sourcePinDirectory.startsWith(`${destination}${path.sep}`)) {
    throw new DomainError("VALIDATION_FAILED", "Restore source pin storage must remain outside the data cutover directory.", 422);
  }
  const pinnedSource = await pinRestoreSource(bundlePath, options.expectedSource, sourcePinDirectory);
  let pinnedSourceReleased = false;
  const releasePinnedSource = async (): Promise<void> => {
    if (pinnedSourceReleased) return;
    await pinnedSource.release();
    pinnedSourceReleased = true;
  };
  let restoreError: unknown;
  try {
  if (await recoverExistingRestoreJournal(destination, pinnedSource.sha256) === "already-committed") {
    await options.healthCheck?.(destination);
    await releasePinnedSource();
    await cleanupRestoreJournal(destination);
    return;
  }
  const sourceFormat = options.sourceFormat ?? "formaspec-backup";
  if (sourceFormat === "forensic-recovery") {
    await verifyForensicRecoveryBundle(pinnedSource.path, {
      ...(options.expectedForensicOperationId
        ? { expectedOperationId: options.expectedForensicOperationId }
        : {}),
    });
  } else {
    await verifyBackupBundle(pinnedSource.path, {
      ...(options.rasterVerifier ? { rasterVerifier: options.rasterVerifier } : {}),
      ...(options.requireRasterVerifier === undefined
        ? {}
        : { requireRasterVerifier: options.requireRasterVerifier }),
    });
  }
  await requireFilesystemCapacity(
    destination,
    pinnedSource.sizeBytes,
    1,
    "staging the restore candidate",
  );
  const bundleSha256 = pinnedSource.sha256;
  const locations = restoreJournalPaths(destination);
  await fs.promises.mkdir(locations.root, { mode: 0o700 });
  await fs.promises.mkdir(locations.candidate, { mode: 0o700 });
  await fs.promises.mkdir(locations.rollback, { mode: 0o700 });
  const now = new Date().toISOString();
  const journal: RestoreJournal = {
    format: RESTORE_JOURNAL_FORMAT,
    version: RESTORE_JOURNAL_VERSION,
    restoreId: randomUUID(),
    sourceBundleSha256: bundleSha256,
    createdAt: now,
    updatedAt: now,
    phase: "staging",
    candidateCutoverStarted: false,
    originalEntries: [],
    candidateEntries: [],
    steps: [],
  };
  try {
    await writeRestoreJournal(locations.root, journal);
  } catch (error) {
    try {
      await cleanupRestoreJournal(destination);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Restore journal initialization failed and its empty staging area could not be cleaned up.",
      );
    }
    throw error;
  }

  let cutoverStarted = false;
  try {
    await extractTar(pinnedSource.path, locations.candidate);
    await fs.promises.rm(path.join(locations.candidate, "checksums.sha256"), { force: true });
    if (sourceFormat === "forensic-recovery") {
      await fs.promises.rm(path.join(locations.candidate, FORENSIC_RECOVERY_MANIFEST), { force: true });
      const payloadRoot = path.join(locations.candidate, FORENSIC_RECOVERY_PAYLOAD_ROOT);
      if (await pathExists(payloadRoot)) {
        const payloadEntries = await topLevelEntries(payloadRoot);
        for (const entry of payloadEntries) {
          await moveWithoutReplacement(
            path.join(payloadRoot, entry),
            path.join(locations.candidate, entry),
          );
        }
        await fs.promises.rmdir(payloadRoot);
      }
    } else {
      await fs.promises.rm(path.join(locations.candidate, "backup-manifest.json"), { force: true });
      await fs.promises.rm(path.join(locations.candidate, "asset-manifest.json"), { force: true });
      if (await pathExists(path.join(locations.candidate, "database.sqlite"))) {
        await moveWithoutReplacement(
          path.join(locations.candidate, "database.sqlite"),
          path.join(locations.candidate, "designer.sqlite"),
        );
      }
      if (await pathExists(path.join(locations.candidate, "organization-config.yaml"))) {
        await moveWithoutReplacement(
          path.join(locations.candidate, "organization-config.yaml"),
          path.join(locations.candidate, "organization.formaspec.yaml"),
        );
      }
    }

    journal.candidateEntries = await topLevelEntries(locations.candidate);
    if (journal.candidateEntries.includes(RESTORE_JOURNAL_DIRECTORY)) {
      throw new DomainError("VALIDATION_FAILED", "Backup uses the reserved restore-journal path.", 422);
    }
    journal.originalEntries = await topLevelEntries(destination, new Set([RESTORE_JOURNAL_DIRECTORY]));
    await setRestorePhase(locations.root, journal, "moving-originals");
    cutoverStarted = true;
    for (const entry of journal.originalEntries) {
      await recordedRestoreMove(
        locations.root,
        journal,
        "move-original",
        entry,
        path.join(destination, entry),
        path.join(locations.rollback, entry),
      );
    }

    journal.candidateCutoverStarted = true;
    await setRestorePhase(locations.root, journal, "moving-candidate");
    for (const entry of journal.candidateEntries) {
      await recordedRestoreMove(
        locations.root,
        journal,
        "move-candidate",
        entry,
        path.join(locations.candidate, entry),
        path.join(destination, entry),
      );
    }

    await setRestorePhase(locations.root, journal, "health-check");
    await options.healthCheck?.(destination);
    await setRestorePhase(locations.root, journal, "committed");
  } catch (error) {
    if (!cutoverStarted) {
      try {
        await cleanupRestoreJournal(destination);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Restore staging failed and its uncommitted journal could not be cleaned up.",
        );
      }
      throw error;
    }

    journal.failure = { cutover: restoreErrorMessage(error) };
    try {
      await writeRestoreJournal(locations.root, journal);
    } catch {
      // The last durable phase and planned move still permit filesystem-based
      // recovery. Never remove the journal merely because this annotation fails.
    }
    try {
      await rollbackRestoreCutover(destination, journal);
    } catch (rollbackError) {
      journal.failure.rollback = restoreErrorMessage(rollbackError);
      try {
        await writeRestoreJournal(locations.root, journal);
      } catch {
        // Preserve every surviving live/staged/rollback entry for the next
        // bounded recovery attempt or operator inspection.
      }
      throw new AggregateError(
        [error, rollbackError],
        "Restore cutover failed and rollback did not complete; the recovery journal was preserved.",
      );
    }
    throw error;
  }

  // A committed journal means the candidate passed its health check. Cleanup
  // is deliberately outside the rollback catch: a cleanup error must never
  // replace the healthy candidate with the old data or delete the only copy.
  // Release the private source first. If that cleanup fails, retain the
  // committed journal so a supervisor retry can re-run health verification
  // instead of reporting an ambiguous failure after deleting all evidence.
  await releasePinnedSource();
  await cleanupRestoreJournal(destination);
  } catch (error) {
    restoreError = error;
    throw error;
  } finally {
    try {
      await releasePinnedSource();
    } catch (cleanupError) {
      if (restoreError !== undefined) {
        throw new AggregateError(
          [restoreError, cleanupError],
          "Restore failed and its private pinned source could not be cleaned up.",
        );
      }
      throw cleanupError;
    }
  }
}
