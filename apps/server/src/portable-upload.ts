import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FastifyRequest } from "fastify";

import { DomainError } from "./errors.js";

export const MAX_PORTABLE_ARCHIVE_BYTES = 256 * 1024 * 1024;
const PORTABLE_UPLOAD_MEDIA_TYPES = new Set([
  "application/zip",
  "application/octet-stream",
  "application/x-zip-compressed",
]);
const PORTABLE_MULTIPART_HIGH_WATER_BYTES = 64 * 1024;

export interface PortableUploadFile {
  filename: string;
  directory: string;
  sizeBytes: number;
  sha256: string;
  cleanup(): Promise<void>;
}

export function portableUploadStagingRoot(): string {
  return path.join(os.tmpdir(), "formaspec-portable-imports");
}

async function writeAll(handle: fs.promises.FileHandle, chunk: Buffer, position: number): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    const result = await handle.write(chunk, offset, chunk.length - offset, position + offset);
    if (result.bytesWritten <= 0) throw new Error("Portable upload made no write progress.");
    offset += result.bytesWritten;
  }
}

async function privateUploadDirectory(): Promise<{ directory: string; device: bigint; inode: bigint }> {
  const base = portableUploadStagingRoot();
  await fs.promises.mkdir(base, { recursive: true, mode: 0o700 });
  const baseStat = await fs.promises.lstat(base, { bigint: true });
  if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) {
    throw new DomainError("TEMPORARILY_UNAVAILABLE", "The portable-import staging directory is unsafe.", 503);
  }
  await fs.promises.chmod(base, 0o700);
  const directory = await fs.promises.mkdtemp(path.join(base, "upload-"));
  await fs.promises.chmod(directory, 0o700);
  const stat = await fs.promises.lstat(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new DomainError("TEMPORARILY_UNAVAILABLE", "The portable-import staging directory is unsafe.", 503);
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
      throw new Error("Portable-import staging contains an unexpected non-file entry.");
    }
    await fs.promises.unlink(path.join(directory, child.name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  await fs.promises.rmdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

export async function stagePortableUploadStream(
  stream: AsyncIterable<unknown>,
  maximumBytes = MAX_PORTABLE_ARCHIVE_BYTES,
  onStaged?: (directory: string) => void,
): Promise<PortableUploadFile> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > MAX_PORTABLE_ARCHIVE_BYTES) {
    throw new TypeError("Portable upload byte limit is invalid.");
  }
  const staging = await privateUploadDirectory();
  const archivePath = path.join(staging.directory, `archive-${randomBytes(12).toString("hex")}.zip`);
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    await cleanupPrivateDirectory(staging.directory, staging.device, staging.inode);
    cleaned = true;
  };
  let handle: fs.promises.FileHandle | null = null;
  try {
    onStaged?.(staging.directory);
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
        throw new DomainError("PAYLOAD_TOO_LARGE", "Portable bundle exceeds the archive byte limit.", 413);
      }
      await writeAll(handle, chunk, sizeBytes);
      hash.update(chunk);
      sizeBytes = nextSize;
    }
    await handle.sync();
    await handle.close();
    handle = null;
    return {
      filename: archivePath,
      directory: staging.directory,
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

export async function streamPortableUpload(request: FastifyRequest): Promise<PortableUploadFile> {
  const part = await request.file({
    highWaterMark: PORTABLE_MULTIPART_HIGH_WATER_BYTES,
    fileHwm: PORTABLE_MULTIPART_HIGH_WATER_BYTES,
    throwFileSizeLimit: true,
    limits: {
      files: 1,
      fields: 0,
      parts: 1,
      headerPairs: 16,
      fileSize: MAX_PORTABLE_ARCHIVE_BYTES,
    },
  });
  if (!part) throw new DomainError("VALIDATION_FAILED", "A multipart FormaSpec bundle is required.", 422);
  if (!PORTABLE_UPLOAD_MEDIA_TYPES.has(part.mimetype)) {
    part.file.resume();
    throw new DomainError("VALIDATION_FAILED", "The uploaded portable bundle must use a ZIP-compatible media type.", 422);
  }
  let aborted = false;
  const onAborted = (): void => {
    aborted = true;
    part.file.destroy(new Error("Portable upload was aborted."));
  };
  request.raw.once("aborted", onAborted);
  let upload: PortableUploadFile | null = null;
  try {
    upload = await stagePortableUploadStream(part.file);
    if (aborted) throw new DomainError("VALIDATION_FAILED", "Portable upload was aborted.", 400);
    if (part.file.truncated) {
      throw new DomainError("PAYLOAD_TOO_LARGE", "Portable bundle exceeds the archive byte limit.", 413);
    }
    return upload;
  } catch (error) {
    await upload?.cleanup().catch(() => undefined);
    throw error;
  } finally {
    request.raw.off("aborted", onAborted);
  }
}
