import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import Database from "better-sqlite3";
import tar from "tar-stream";

const MAX_ENTRIES = 20_000;
const MAX_EXPANDED_BYTES = 16 * 1024 * 1024 * 1024;
const MAX_CONTROL_FILE_BYTES = 4 * 1024 * 1024;

interface ScannedFile {
  sizeBytes: number;
  sha256: string;
  contents?: Buffer;
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

export interface BackupVerification {
  valid: true;
  manifest: BackupManifest;
  sqliteIntegrity: "ok";
  foreignKeyViolations: 0;
  migrationVersion: number;
  entryCount: number;
  expandedBytes: number;
  bundleSizeBytes: number;
  bundleSha256: string;
}

function portablePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0")) {
    throw new Error("Backup contains an invalid archive path.");
  }
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("Backup contains a path traversal entry.");
  }
  return parts.join("/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseManifest(data: Buffer): BackupManifest {
  const value = JSON.parse(data.toString("utf8")) as unknown;
  if (!isRecord(value) || value.format !== "formaspec-backup"
    || (value.formatVersion !== 1 && value.formatVersion !== 2)
    || typeof value.createdAt !== "string" || typeof value.applicationBuildVersion !== "string"
    || !Number.isSafeInteger(value.databaseSchemaVersion) || !Number.isSafeInteger(value.documentSchemaVersion)
    || typeof value.commandEngineVersion !== "string" || typeof value.rendererVersion !== "string"
    || typeof value.fontBundleVersion !== "string" || !Array.isArray(value.files)) {
    throw new Error("Backup manifest is unsupported or malformed.");
  }
  const files = value.files.map((entry) => {
    if (!isRecord(entry) || typeof entry.path !== "string" || !Number.isSafeInteger(entry.sizeBytes)
      || (entry.sizeBytes as number) < 0 || typeof entry.sha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error("Backup manifest contains an invalid file record.");
    }
    return { path: portablePath(entry.path), sizeBytes: entry.sizeBytes as number, sha256: entry.sha256 };
  });
  return { ...(value as Omit<BackupManifest, "files">), files };
}

function parseChecksums(data: Buffer): Map<string, string> {
  const checksums = new Map<string, string>();
  for (const line of data.toString("utf8").split("\n").filter(Boolean)) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (match === null) throw new Error("Backup checksum manifest is malformed.");
    const name = portablePath(match[2]!);
    if (checksums.has(name)) throw new Error(`Backup checksum manifest repeats ${name}.`);
    checksums.set(name, match[1]!);
  }
  return checksums;
}

async function scanArchive(bundlePath: string, databasePath: string): Promise<{
  files: Map<string, ScannedFile>;
  entryCount: number;
  expandedBytes: number;
  bundleSizeBytes: number;
  bundleSha256: string;
}> {
  const extract = tar.extract();
  const files = new Map<string, ScannedFile>();
  let entryCount = 0;
  let expandedBytes = 0;
  let bundleSizeBytes = 0;
  const bundleHash = createHash("sha256");
  const hashInput = new Transform({
    transform(chunk: Buffer | Uint8Array, _encoding, callback) {
      const buffer = Buffer.from(chunk);
      bundleSizeBytes += buffer.length;
      if (bundleSizeBytes > MAX_EXPANDED_BYTES) {
        callback(new Error("Backup bundle exceeds the verification limit."));
        return;
      }
      bundleHash.update(buffer);
      callback(null, buffer);
    },
  });

  extract.on("entry", (header, stream, next) => {
    let name = "";
    let entryFailure: Error | null = null;
    try {
      entryCount += 1;
      if (entryCount > MAX_ENTRIES) throw new Error("Backup has too many entries.");
      name = portablePath(header.name);
      if (header.type !== "file") throw new Error("Backup may contain regular files only.");
      if (files.has(name)) throw new Error(`Backup repeats archive path ${name}.`);
    } catch (error) {
      entryFailure = error as Error;
    }
    const retainContents = name === "backup-manifest.json" || name === "checksums.sha256";
    const chunks: Buffer[] = [];
    const hash = createHash("sha256");
    let sizeBytes = 0;
    const databaseOutput = name === "database.sqlite" && entryFailure === null
      ? fs.createWriteStream(databasePath, { flags: "wx", mode: 0o600 })
      : null;
    if (databaseOutput !== null) stream.pipe(databaseOutput);
    stream.on("data", (chunk: Buffer | Uint8Array) => {
      const buffer = Buffer.from(chunk);
      sizeBytes += buffer.length;
      expandedBytes += buffer.length;
      hash.update(buffer);
      if (expandedBytes > MAX_EXPANDED_BYTES && entryFailure === null) {
        entryFailure = new Error("Backup expands beyond the verification limit.");
      }
      if (retainContents) {
        if (sizeBytes > MAX_CONTROL_FILE_BYTES && entryFailure === null) {
          entryFailure = new Error(`${name} exceeds the control-file limit.`);
        } else if (entryFailure === null) {
          chunks.push(buffer);
        }
      }
    });
    stream.once("error", (error) => next(error));
    stream.once("end", () => {
      const finish = () => {
        if (entryFailure !== null) {
          next(entryFailure);
          return;
        }
        if (header.size !== undefined && header.size !== sizeBytes) {
          next(new Error(`Backup entry ${name} has an inconsistent size.`));
          return;
        }
        files.set(name, {
          sizeBytes,
          sha256: hash.digest("hex"),
          ...(retainContents ? { contents: Buffer.concat(chunks) } : {}),
        });
        next();
      };
      if (databaseOutput === null || databaseOutput.closed) finish();
      else databaseOutput.once("close", finish);
    });
  });
  await pipeline(fs.createReadStream(bundlePath), hashInput, extract);
  return {
    files,
    entryCount,
    expandedBytes,
    bundleSizeBytes,
    bundleSha256: bundleHash.digest("hex"),
  };
}

export async function verifyBackup(bundlePath: string): Promise<BackupVerification> {
  const resolved = path.resolve(bundlePath);
  const bundleStat = await fs.promises.lstat(resolved);
  if (!bundleStat.isFile() || bundleStat.isSymbolicLink()) throw new Error("Backup must be a regular, non-symlink file.");
  const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), `formaspec-backup-${randomUUID()}-`));
  const databasePath = path.join(temporary, "database.sqlite");
  try {
    const scanned = await scanArchive(resolved, databasePath);
    const manifestFile = scanned.files.get("backup-manifest.json");
    const checksumFile = scanned.files.get("checksums.sha256");
    const databaseFile = scanned.files.get("database.sqlite");
    if (manifestFile?.contents === undefined || checksumFile?.contents === undefined || databaseFile === undefined) {
      throw new Error("Backup is missing its manifest, checksums, or database.");
    }
    const manifest = parseManifest(manifestFile.contents);
    const checksums = parseChecksums(checksumFile.contents);
    if (checksums.get("backup-manifest.json") !== manifestFile.sha256) {
      throw new Error("Backup manifest checksum failed.");
    }
    const manifestPaths = new Set<string>();
    for (const expected of manifest.files) {
      if (manifestPaths.has(expected.path)) throw new Error(`Backup manifest repeats ${expected.path}.`);
      manifestPaths.add(expected.path);
      const actual = scanned.files.get(expected.path);
      if (actual === undefined || actual.sizeBytes !== expected.sizeBytes || actual.sha256 !== expected.sha256
        || checksums.get(expected.path) !== expected.sha256) {
        throw new Error(`Backup checksum failed: ${expected.path}.`);
      }
    }
    for (const name of scanned.files.keys()) {
      if (name !== "backup-manifest.json" && name !== "checksums.sha256" && !manifestPaths.has(name)) {
        throw new Error(`Backup contains an unlisted payload: ${name}.`);
      }
    }
    for (const name of checksums.keys()) {
      if (name !== "backup-manifest.json" && !manifestPaths.has(name)) {
        throw new Error(`Backup checksum manifest contains an unlisted path: ${name}.`);
      }
    }

    const sqlite = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      sqlite.pragma("query_only = ON");
      const integrity = sqlite.pragma("integrity_check", { simple: true }) as string;
      if (integrity !== "ok") throw new Error(`SQLite integrity check failed: ${integrity}.`);
      const foreignKeys = sqlite.pragma("foreign_key_check") as unknown[];
      if (foreignKeys.length > 0) throw new Error(`Backup database has ${foreignKeys.length} foreign-key violations.`);
      const ledger = sqlite.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
      ).get();
      if (ledger === undefined) throw new Error("Backup database has no migration ledger.");
      const migration = sqlite.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as {
        version: number | null;
      };
      const migrationVersion = migration.version ?? 0;
      if (manifest.databaseSchemaVersion !== migrationVersion) {
        throw new Error(`Backup manifest database version ${manifest.databaseSchemaVersion} does not match its migration ledger ${migrationVersion}.`);
      }
      return {
        valid: true,
        manifest,
        sqliteIntegrity: "ok",
        foreignKeyViolations: 0,
        migrationVersion,
        entryCount: scanned.entryCount,
        expandedBytes: scanned.expandedBytes,
        bundleSizeBytes: scanned.bundleSizeBytes,
        bundleSha256: scanned.bundleSha256,
      };
    } finally {
      sqlite.close();
    }
  } finally {
    await fs.promises.rm(temporary, { recursive: true, force: true });
  }
}
