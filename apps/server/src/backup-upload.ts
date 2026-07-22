import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FastifyRequest } from "fastify";

import { MAX_BACKUP_BUNDLE_BYTES } from "./backup.js";
import { DomainError } from "./errors.js";

// Browser uploads are deliberately tighter than the offline restore verifier.
// Larger backups remain supported through formaspecctl on the host.
export const MAX_BACKUP_UPLOAD_BYTES = Math.min(MAX_BACKUP_BUNDLE_BYTES, 1024 * 1024 * 1024);
const BACKUP_UPLOAD_MEDIA_TYPES = new Set([
  "application/octet-stream",
  "application/tar",
  "application/x-tar",
]);
const BACKUP_MULTIPART_HIGH_WATER_BYTES = 64 * 1024;

export interface BackupUploadFile {
  filename: string;
  directory: string;
  originalFilename: string;
  sizeBytes: number;
  sha256: string;
  cleanup(): Promise<void>;
}

export function backupUploadStagingRoot(): string {
  return path.join(os.tmpdir(), "formaspec-backup-imports");
}

async function writeAll(handle: fs.promises.FileHandle, chunk: Buffer, position: number): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    const result = await handle.write(chunk, offset, chunk.length - offset, position + offset);
    if (result.bytesWritten <= 0) throw new Error("Backup upload made no write progress.");
    offset += result.bytesWritten;
  }
}

async function privateUploadDirectory(): Promise<{ directory: string; device: bigint; inode: bigint }> {
  const base = backupUploadStagingRoot();
  await fs.promises.mkdir(base, { recursive: true, mode: 0o700 });
  const baseStat = await fs.promises.lstat(base, { bigint: true });
  if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) {
    throw new DomainError("TEMPORARILY_UNAVAILABLE", "The backup-import staging directory is unsafe.", 503);
  }
  await fs.promises.chmod(base, 0o700);
  const directory = await fs.promises.mkdtemp(path.join(base, "upload-"));
  await fs.promises.chmod(directory, 0o700);
  const stat = await fs.promises.lstat(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new DomainError("TEMPORARILY_UNAVAILABLE", "The backup-import staging directory is unsafe.", 503);
  }
  return { directory, device: stat.dev, inode: stat.ino };
}

async function cleanupPrivateDirectory(directory: string, device: bigint, inode: bigint): Promise<void> {
  let stat: fs.BigIntStats;
  try {
    stat = await fs.promises.lstat(directory, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== device || stat.ino !== inode) return;
  const children = await fs.promises.readdir(directory, { withFileTypes: true });
  for (const child of children) {
    if (!child.isFile() && !child.isSymbolicLink()) {
      throw new Error("Backup-import staging contains an unexpected non-file entry.");
    }
    await fs.promises.unlink(path.join(directory, child.name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  await fs.promises.rmdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

export async function stageBackupUploadStream(
  stream: AsyncIterable<unknown>,
  originalFilename: string,
  maximumBytes = MAX_BACKUP_UPLOAD_BYTES,
): Promise<BackupUploadFile> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > MAX_BACKUP_UPLOAD_BYTES) {
    throw new TypeError("Backup upload byte limit is invalid.");
  }
  const staging = await privateUploadDirectory();
  const archivePath = path.join(staging.directory, `bundle-${randomBytes(12).toString("hex")}.tar`);
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    await cleanupPrivateDirectory(staging.directory, staging.device, staging.inode);
    cleaned = true;
  };
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(
      archivePath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    const hash = createHash("sha256");
    let sizeBytes = 0;
    for await (const value of stream) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
      const nextSize = sizeBytes + chunk.length;
      if (nextSize > maximumBytes) {
        throw new DomainError("PAYLOAD_TOO_LARGE", "Backup upload exceeds the browser archive byte limit.", 413);
      }
      await writeAll(handle, chunk, sizeBytes);
      hash.update(chunk);
      sizeBytes = nextSize;
    }
    if (sizeBytes < 1) throw new DomainError("VALIDATION_FAILED", "The uploaded backup is empty.", 422);
    await handle.sync();
    await handle.close();
    handle = null;
    return {
      filename: archivePath,
      directory: staging.directory,
      originalFilename,
      sizeBytes,
      sha256: hash.digest("hex"),
      cleanup,
    };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await cleanup().catch(() => undefined);
    throw error;
  }
}

export async function streamBackupUpload(request: FastifyRequest): Promise<BackupUploadFile> {
  const part = await request.file({
    highWaterMark: BACKUP_MULTIPART_HIGH_WATER_BYTES,
    fileHwm: BACKUP_MULTIPART_HIGH_WATER_BYTES,
    throwFileSizeLimit: true,
    limits: {
      files: 1,
      fields: 0,
      parts: 1,
      headerPairs: 16,
      fileSize: MAX_BACKUP_UPLOAD_BYTES,
    },
  });
  if (!part) throw new DomainError("VALIDATION_FAILED", "A multipart FormaSpec backup file is required.", 422);
  if (!BACKUP_UPLOAD_MEDIA_TYPES.has(part.mimetype)) {
    part.file.resume();
    throw new DomainError("VALIDATION_FAILED", "The uploaded full backup must use a TAR-compatible media type.", 422);
  }
  let aborted = false;
  const onAborted = (): void => {
    aborted = true;
    part.file.destroy(new Error("Backup upload was aborted."));
  };
  request.raw.once("aborted", onAborted);
  let upload: BackupUploadFile | null = null;
  try {
    upload = await stageBackupUploadStream(part.file, part.filename);
    if (aborted) throw new DomainError("VALIDATION_FAILED", "Backup upload was aborted.", 400);
    if (part.file.truncated) {
      throw new DomainError("PAYLOAD_TOO_LARGE", "Backup upload exceeds the browser archive byte limit.", 413);
    }
    return upload;
  } catch (error) {
    await upload?.cleanup().catch(() => undefined);
    throw error;
  } finally {
    request.raw.off("aborted", onAborted);
  }
}
