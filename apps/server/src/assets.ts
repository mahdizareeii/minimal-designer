import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { DomainError } from "./errors.js";

export interface ImageInfo {
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
}

export interface NormalizedImageAsset extends ImageInfo {
  data: Buffer;
}

export type RasterMimeType = NormalizedImageAsset["mimeType"];

export interface RasterNormalizationOptions {
  sourceMimeType: RasterMimeType;
  sourceWidth: number;
  sourceHeight: number;
  maxBytes: number;
  maxPixels: number;
}

export interface RasterNormalizationEngine {
  normalizeRaster(data: Buffer, options: RasterNormalizationOptions): Promise<NormalizedImageAsset>;
}

interface DetectedImageInfo extends ImageInfo {
  animated: boolean;
}

function assetDigest(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function assertAssetDigest(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new DomainError("VALIDATION_FAILED", "Asset content address must be a lowercase SHA-256 digest.", 422);
  }
}

function assetExtension(mimeType: RasterMimeType): "png" | "jpg" | "webp" {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  throw new DomainError("UNSUPPORTED_ASSET", "Only normalized PNG, JPEG, and WebP assets can be stored.", 422);
}

export function normalizedAssetArchivePath(sha256: string, mimeType: string): string {
  assertAssetDigest(sha256);
  const extension = assetExtension(mimeType as RasterMimeType);
  return `assets/sha256/${sha256.slice(0, 2)}/${sha256}.${extension}`;
}

function missingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function assertPrivateDirectory(directory: string, create: boolean): boolean {
  if (create) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(directory);
  } catch (error) {
    if (!create && missingFile(error)) return false;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new DomainError("INTERNAL_ERROR", "The content-addressed asset directory is not a safe regular directory.", 500);
  }
  return true;
}

/**
 * Stores normalized raster bytes under DATA_DIR/assets using only a verified
 * SHA-256 digest and a server-selected extension. User filenames never reach
 * filesystem path construction. Database BLOBs remain the compatibility and
 * quarantine copy; this store is the primary source whenever a verified file
 * exists.
 */
export class ContentAddressedRasterStore {
  private readonly rootDirectory: string;
  private readonly hashDirectory: string;

  constructor(dataDirectory: string) {
    this.rootDirectory = path.resolve(dataDirectory, "assets");
    this.hashDirectory = path.join(this.rootDirectory, "sha256");
    assertPrivateDirectory(this.rootDirectory, true);
    assertPrivateDirectory(this.hashDirectory, true);
  }

  writeNormalized(data: Buffer, mimeType: RasterMimeType, expectedSha256: string): void {
    assertAssetDigest(expectedSha256);
    if (assetDigest(data) !== expectedSha256) {
      throw new DomainError("VALIDATION_FAILED", "Normalized asset bytes do not match their SHA-256 content address.", 422);
    }
    const bucket = this.bucketDirectory(expectedSha256, true);
    const target = this.targetPath(expectedSha256, mimeType, bucket);
    const existing = this.readNormalized(expectedSha256, mimeType, data.length);
    if (existing) return;

    const temporary = path.join(bucket, `.${expectedSha256}.${randomUUID()}.tmp`);
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(descriptor, data);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      try {
        fs.renameSync(temporary, target);
      } catch (error) {
        // A second process may have won the same content-addressed write.
        // Accept that race only when the winner is the exact expected file.
        const winner = this.readNormalized(expectedSha256, mimeType, data.length);
        if (!winner) throw error;
      }
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError("INTERNAL_ERROR", "The normalized asset could not be persisted atomically.", 500, { cause: error });
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try {
        fs.rmSync(temporary, { force: true });
      } catch {
        // Best-effort cleanup; the generated temporary name is never exposed.
      }
    }

    if (!this.readNormalized(expectedSha256, mimeType, data.length)) {
      throw new DomainError("INTERNAL_ERROR", "The normalized asset write could not be verified.", 500);
    }
  }

  readNormalized(expectedSha256: string, mimeType: RasterMimeType, expectedBytes: number): Buffer | null {
    assertAssetDigest(expectedSha256);
    const bucket = this.bucketDirectory(expectedSha256, false);
    if (!bucket) return null;
    const target = this.targetPath(expectedSha256, mimeType, bucket);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(target);
    } catch (error) {
      if (missingFile(error)) return null;
      throw new DomainError("INTERNAL_ERROR", "The normalized asset could not be inspected.", 500, { cause: error });
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new DomainError("INTERNAL_ERROR", "The normalized asset is not a safe regular file.", 500);
    }
    let data: Buffer;
    try {
      data = fs.readFileSync(target);
    } catch (error) {
      throw new DomainError("INTERNAL_ERROR", "The normalized asset could not be read.", 500, { cause: error });
    }
    if (data.length !== expectedBytes || assetDigest(data) !== expectedSha256) {
      throw new DomainError("INTERNAL_ERROR", "The normalized asset failed its size or SHA-256 integrity check.", 500);
    }
    return data;
  }

  private bucketDirectory(sha256: string, create: true): string;
  private bucketDirectory(sha256: string, create: false): string | null;
  private bucketDirectory(sha256: string, create: boolean): string | null {
    assertPrivateDirectory(this.rootDirectory, create);
    if (!assertPrivateDirectory(this.hashDirectory, create)) return null;
    const bucket = path.join(this.hashDirectory, sha256.slice(0, 2));
    return assertPrivateDirectory(bucket, create) ? bucket : null;
  }

  private targetPath(sha256: string, mimeType: RasterMimeType, bucket: string): string {
    const filename = `${sha256}.${assetExtension(mimeType)}`;
    const target = path.resolve(bucket, filename);
    if (path.dirname(target) !== bucket || path.basename(target) !== filename) {
      throw new DomainError("INTERNAL_ERROR", "The normalized asset content address was not path-safe.", 500);
    }
    return target;
  }
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngInfo(data: Buffer): DetectedImageInfo | null {
  if (data.length < 45 || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return null;
  let offset = 8;
  let width = 0;
  let height = 0;
  let sawHeader = false;
  let sawImageData = false;
  let sawEnd = false;
  let animated = false;
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > data.length) return null;
    const type = data.toString("ascii", offset + 4, offset + 8);
    const chunk = data.subarray(offset + 4, offset + 8 + length);
    if (crc32(chunk) !== data.readUInt32BE(offset + 8 + length)) return null;
    if (!sawHeader) {
      if (type !== "IHDR" || length !== 13) return null;
      width = data.readUInt32BE(offset + 8);
      height = data.readUInt32BE(offset + 12);
      sawHeader = true;
    } else if (type === "IDAT") {
      sawImageData = true;
    } else if (type === "acTL") {
      animated = true;
    } else if (type === "IEND") {
      if (length !== 0 || chunkEnd !== data.length) return null;
      sawEnd = true;
      break;
    }
    offset = chunkEnd;
  }
  return sawHeader && sawImageData && sawEnd
    ? { mimeType: "image/png", width, height, animated }
    : null;
}

function jpegInfo(data: Buffer): DetectedImageInfo | null {
  if (data.length < 4
    || data[0] !== 0xff
    || data[1] !== 0xd8
    || data.lastIndexOf(Buffer.from([0xff, 0xd9])) < 2) return null;
  let offset = 2;
  let multiPicture = false;
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  while (offset + 8 < data.length) {
    if (data[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = data[offset + 1];
    if (marker === undefined) break;
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > data.length) break;
    const length = data.readUInt16BE(offset);
    if (length < 2 || offset + length > data.length) break;
    if (marker === 0xe2 && length >= 6 && data.toString("ascii", offset + 2, offset + 6) === "MPF\0") {
      multiPicture = true;
    }
    if (startOfFrame.has(marker)) {
      return {
        mimeType: "image/jpeg",
        height: data.readUInt16BE(offset + 3),
        width: data.readUInt16BE(offset + 5),
        animated: multiPicture,
      };
    }
    offset += length;
  }
  return null;
}

function webpInfo(data: Buffer): DetectedImageInfo | null {
  if (data.length < 30
    || data.toString("ascii", 0, 4) !== "RIFF"
    || data.toString("ascii", 8, 12) !== "WEBP"
    || data.readUInt32LE(4) + 8 !== data.length) return null;
  let offset = 12;
  let width = 0;
  let height = 0;
  let animated = false;
  while (offset + 8 <= data.length) {
    const format = data.toString("ascii", offset, offset + 4);
    const length = data.readUInt32LE(offset + 4);
    const payload = offset + 8;
    const end = payload + length;
    const next = end + (length % 2);
    if (end > data.length || next > data.length) return null;
    if (format === "VP8X") {
      if (length < 10) return null;
      animated ||= Boolean(data[payload]! & 0x02);
      width = 1 + data.readUIntLE(payload + 4, 3);
      height = 1 + data.readUIntLE(payload + 7, 3);
    } else if (format === "ANIM" || format === "ANMF") {
      animated = true;
    } else if (format === "VP8L" && length >= 5 && data[payload] === 0x2f) {
      const bits = data.readUInt32LE(payload + 1);
      width ||= (bits & 0x3fff) + 1;
      height ||= ((bits >>> 14) & 0x3fff) + 1;
    } else if (format === "VP8 " && length >= 10
      && data[payload + 3] === 0x9d && data[payload + 4] === 0x01 && data[payload + 5] === 0x2a) {
      width ||= data.readUInt16LE(payload + 6) & 0x3fff;
      height ||= data.readUInt16LE(payload + 8) & 0x3fff;
    }
    offset = next;
  }
  return offset === data.length && width > 0 && height > 0
    ? { mimeType: "image/webp", width, height, animated }
    : null;
}

export function validateImageAsset(
  data: Buffer,
  claimedMimeType: string | undefined,
  limits: { maxBytes: number; maxPixels: number },
): ImageInfo {
  if (data.length === 0) throw new DomainError("UNSUPPORTED_ASSET", "The uploaded asset is empty.", 422);
  if (data.length > limits.maxBytes) {
    throw new DomainError("PAYLOAD_TOO_LARGE", `Asset exceeds the ${limits.maxBytes} byte limit.`, 413);
  }
  const info = pngInfo(data) ?? jpegInfo(data) ?? webpInfo(data);
  if (!info || info.width < 1 || info.height < 1) {
    throw new DomainError("UNSUPPORTED_ASSET", "Only valid PNG, JPEG, and WebP images are supported.", 422);
  }
  if (info.animated) {
    throw new DomainError("UNSUPPORTED_ASSET", "Animated or multi-page images are not supported.", 422);
  }
  if (claimedMimeType && claimedMimeType !== "application/octet-stream" && claimedMimeType !== info.mimeType) {
    throw new DomainError("UNSUPPORTED_ASSET", "The declared MIME type does not match the image bytes.", 422, {
      details: { claimedMimeType, detectedMimeType: info.mimeType },
    });
  }
  const pixels = info.width * info.height;
  if (!Number.isSafeInteger(pixels) || pixels > limits.maxPixels) {
    throw new DomainError("PAYLOAD_TOO_LARGE", `Image exceeds the ${limits.maxPixels} pixel limit.`, 413, {
      details: { width: info.width, height: info.height },
    });
  }
  return info;
}

export async function normalizeImageAsset(
  data: Buffer,
  claimedMimeType: string | undefined,
  limits: { maxBytes: number; maxPixels: number },
  engine: RasterNormalizationEngine,
): Promise<NormalizedImageAsset> {
  const detected = validateImageAsset(data, claimedMimeType, limits);
  try {
    const normalized = await engine.normalizeRaster(data, {
      sourceMimeType: detected.mimeType,
      sourceWidth: detected.width,
      sourceHeight: detected.height,
      maxBytes: limits.maxBytes,
      maxPixels: limits.maxPixels,
    });
    if (normalized.mimeType !== "image/png") {
      throw new DomainError("INTERNAL_ERROR", "The raster worker returned a non-canonical output format.", 500);
    }
    const info = validateImageAsset(normalized.data, normalized.mimeType, limits);
    if (info.width !== normalized.width || info.height !== normalized.height) {
      throw new DomainError("INTERNAL_ERROR", "The raster worker returned inconsistent dimensions.", 500);
    }
    return { ...info, data: normalized.data };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError("UNSUPPORTED_ASSET", "The image could not be normalized safely.", 422);
  }
}

export function safeFilename(filename: string | undefined, mimeType: string): string {
  const fallbackExtension = mimeType === "image/png" ? ".png" : mimeType === "image/jpeg" ? ".jpg" : ".webp";
  const base = path.parse(path.basename(filename ?? "asset")).name
    .replaceAll(/[^A-Za-z0-9._ -]/g, "_")
    .slice(0, 180)
    .trim();
  return `${base || "asset"}${fallbackExtension}`;
}
