import path from "node:path";

import { DomainError } from "./errors.js";

export interface ImageInfo {
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngInfo(data: Buffer): ImageInfo | null {
  if (data.length < 45 || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return null;
  let offset = 8;
  let width = 0;
  let height = 0;
  let sawHeader = false;
  let sawImageData = false;
  let sawEnd = false;
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
    } else if (type === "IEND") {
      if (length !== 0 || chunkEnd !== data.length) return null;
      sawEnd = true;
      break;
    }
    offset = chunkEnd;
  }
  return sawHeader && sawImageData && sawEnd
    ? { mimeType: "image/png", width, height }
    : null;
}

function jpegInfo(data: Buffer): ImageInfo | null {
  if (data.length < 4
    || data[0] !== 0xff
    || data[1] !== 0xd8
    || data.lastIndexOf(Buffer.from([0xff, 0xd9])) < 2) return null;
  let offset = 2;
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
    if (startOfFrame.has(marker)) {
      return { mimeType: "image/jpeg", height: data.readUInt16BE(offset + 3), width: data.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  return null;
}

function webpInfo(data: Buffer): ImageInfo | null {
  if (data.length < 30
    || data.toString("ascii", 0, 4) !== "RIFF"
    || data.toString("ascii", 8, 12) !== "WEBP"
    || data.readUInt32LE(4) + 8 !== data.length) return null;
  const format = data.toString("ascii", 12, 16);
  if (format === "VP8X") {
    const width = 1 + data.readUIntLE(24, 3);
    const height = 1 + data.readUIntLE(27, 3);
    return { mimeType: "image/webp", width, height };
  }
  if (format === "VP8L" && data[20] === 0x2f) {
    const bits = data.readUInt32LE(21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >>> 14) & 0x3fff) + 1;
    return { mimeType: "image/webp", width, height };
  }
  if (format === "VP8 " && data.length >= 30 && data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a) {
    return {
      mimeType: "image/webp",
      width: data.readUInt16LE(26) & 0x3fff,
      height: data.readUInt16LE(28) & 0x3fff,
    };
  }
  return null;
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
  if (claimedMimeType && claimedMimeType !== "application/octet-stream" && claimedMimeType !== info.mimeType) {
    throw new DomainError("UNSUPPORTED_ASSET", "The declared MIME type does not match the image bytes.", 422, {
      details: { claimedMimeType, detectedMimeType: info.mimeType },
    });
  }
  if (info.width * info.height > limits.maxPixels) {
    throw new DomainError("PAYLOAD_TOO_LARGE", `Image exceeds the ${limits.maxPixels} pixel limit.`, 413, {
      details: { width: info.width, height: info.height },
    });
  }
  return info;
}

export function safeFilename(filename: string | undefined, mimeType: string): string {
  const fallbackExtension = mimeType === "image/png" ? ".png" : mimeType === "image/jpeg" ? ".jpg" : ".webp";
  const base = path.basename(filename ?? `asset${fallbackExtension}`)
    .replaceAll(/[^A-Za-z0-9._ -]/g, "_")
    .slice(0, 180)
    .trim();
  return base || `asset${fallbackExtension}`;
}
