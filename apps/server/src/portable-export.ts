import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { Inflate, zipSync } from "fflate";
import {
  DesignDocumentSchema,
  DesignDocumentV2Schema,
  ENGINE_VERSIONS,
  ProductSpecificationSchema,
  type AnyDesignDocument,
} from "@designer/core";

import { DomainError } from "./errors.js";
import { canonicalJson } from "./ids.js";

const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
const ZIP_STREAM_CHUNK_BYTES = 16 * 1024;
const ZIP_LOCAL_HEADER_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const ZIP_DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP64_SENTINEL_16 = 0xffff;
const ZIP64_SENTINEL_32 = 0xffff_ffff;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_DATA_DESCRIPTOR_FLAG = 0x0008;
const ZIP_ENCRYPTION_FLAGS = 0x2041;
const ZIP_SUPPORTED_FLAGS = 0x080e;
const ZIP_UNIX_FILE_TYPE_MASK = 0o170000;
const ZIP_UNIX_REGULAR_FILE = 0o100000;
const ZIP_DOS_NON_REGULAR_ATTRIBUTES = 0x18;
const ZIP_UNSUPPORTED_EXTRA_FIELDS = new Set([0x0001, 0x0017, 0x9901]);

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

export interface PortableAsset {
  id: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  sha256: string;
  data: Buffer;
}

export interface PortablePreview {
  name: string;
  png: Buffer;
}

export interface PortableExportInput {
  document: AnyDesignDocument;
  revisionId: string;
  revisionHash: string;
  designSystemVersion: number;
  assets?: PortableAsset[];
  previews?: PortablePreview[];
  productSpecification?: unknown;
  prototype?: unknown;
  designSystem?: unknown;
  tokens?: unknown;
  implementationMap?: unknown;
  createdAt?: string;
}

export interface PortableManifest {
  format: "formaspec-project";
  exportFormatVersion: number;
  documentSchemaVersion: number;
  designSystemVersion: number;
  applicationBuildVersion: string;
  rendererVersion: string;
  fontBundleVersion: string;
  revisionId: string;
  revisionHash: string;
  assetHashes: Record<string, string>;
  quarantinedAssetIds: string[];
  creationTime: string;
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function safeEntryName(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized
    || normalized.startsWith("/")
    || /^[a-z]:\//i.test(normalized)
    || /[\u0000-\u001f\u007f]/u.test(normalized)
    || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new DomainError("VALIDATION_FAILED", "Portable bundle contains an unsafe path.", 422);
  }
  return normalized;
}

function safeLeafName(value: string, label: string): string {
  const safe = safeEntryName(value);
  if (safe.includes("/")) throw new DomainError("VALIDATION_FAILED", `${label} must be an opaque ID, not a path.`, 422);
  return safe;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jsonEntry(value: unknown): Uint8Array {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

function assetExtension(mimeType: PortableAsset["mimeType"]): string {
  return mimeType === "image/png" ? "png" : mimeType === "image/jpeg" ? "jpg" : "webp";
}

function portableAssetRequiresQuarantine(asset: AnyDesignDocument["assets"][string]): boolean {
  if ("status" in asset) return asset.status === "legacy_quarantined";
  return asset.kind !== "image"
    || !["image/png", "image/jpeg", "image/webp"].includes(asset.mime_type)
    || asset.storage_key !== `asset:${asset.id}`
    || !asset.sha256
    || !asset.width
    || !asset.height;
}

function tokenType(token: Record<string, unknown>): string {
  const kind = String(token.family ?? token.kind ?? "string");
  if (["spacing", "dimension", "radius", "border_width", "font_size", "line_height", "letter_spacing"].includes(kind)) return "dimension";
  if (kind === "font_family") return "fontFamily";
  if (kind === "font_weight") return "fontWeight";
  return kind;
}

function toDtcgTokens(tokens: Record<string, unknown>): Record<string, unknown> {
  const createTokenGroup = (): Record<string, unknown> => Object.create(null) as Record<string, unknown>;
  const root = createTokenGroup();
  for (const tokenId of Object.keys(tokens).sort()) {
    const value = tokens[tokenId];
    if (!value || typeof value !== "object") continue;
    const token = value as Record<string, unknown>;
    const path = String(token.path ?? token.name ?? token.id ?? "token").split(".").filter(Boolean);
    let cursor = root;
    for (const segment of path.slice(0, -1)) {
      const existing = cursor[segment];
      if (!existing || typeof existing !== "object" || Array.isArray(existing) || "$value" in existing) {
        cursor[segment] = createTokenGroup();
      }
      cursor = cursor[segment] as Record<string, unknown>;
    }
    const name = path.at(-1) ?? String(token.id);
    const rawValue = token.value;
    const dtcgValue = rawValue && typeof rawValue === "object" && "token_id" in rawValue
      ? `{${String((rawValue as { token_id: unknown }).token_id)}}`
      : rawValue;
    cursor[name] = {
      $type: tokenType(token),
      $value: dtcgValue,
      ...(token.description ? { $description: String(token.description) } : {}),
      $extensions: { "com.formaspec": { id: token.id, layer: token.layer ?? "primitive" } },
    };
  }
  return root;
}

function legacyProductBrief(document: AnyDesignDocument): string {
  const value = (document.metadata as Record<string, unknown> | undefined)?.product_brief;
  return typeof value === "string" ? value : "";
}

interface PortableSemanticSidecars {
  productSpecification: unknown;
  prototype: unknown;
  designSystem: unknown;
  tokens: unknown;
  implementationMap: unknown;
}

function assertPortableSemanticEquality(entryName: string, actual: unknown, expected: unknown): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new DomainError(
      "VALIDATION_FAILED",
      `Portable semantic sidecar conflicts with document.json: ${entryName}`,
      422,
    );
  }
}

function validatePortableSemanticSidecars(
  document: AnyDesignDocument,
  sidecars: PortableSemanticSidecars,
  designSystemVersion: number,
): PortableSemanticSidecars {
  const expectedDesignSystemVersion = document.schema_version === 2
    ? document.design_system.release_version
    : 1;
  if (!Number.isSafeInteger(designSystemVersion)
    || designSystemVersion !== expectedDesignSystemVersion) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Portable manifest design-system version conflicts with document.json.",
      422,
      { details: { expectedDesignSystemVersion, actualDesignSystemVersion: designSystemVersion } },
    );
  }
  if (document.schema_version === 2) {
    assertPortableSemanticEquality("product-spec.json", sidecars.productSpecification, document.product_specification);
    assertPortableSemanticEquality("prototype.json", sidecars.prototype, document.prototype_links);
    assertPortableSemanticEquality("design-system.json", sidecars.designSystem, {
      pin: document.design_system,
      components: document.component_definitions,
    });
    assertPortableSemanticEquality(
      "tokens.dtcg.json",
      sidecars.tokens,
      toDtcgTokens(document.tokens as unknown as Record<string, unknown>),
    );
    assertPortableSemanticEquality("implementation-map.json", sidecars.implementationMap, document.implementation_mappings);
    return sidecars;
  }

  const externalProductSpecification = ProductSpecificationSchema.safeParse(sidecars.productSpecification);
  const placeholderProductSpecification = isRecord(sidecars.productSpecification)
    && Object.keys(sidecars.productSpecification).every((key) => key === "natural_language_brief")
    && typeof sidecars.productSpecification.natural_language_brief === "string";
  if (!externalProductSpecification.success && !placeholderProductSpecification) {
    throw new DomainError("VALIDATION_FAILED", "Portable V1 product-spec.json must be a strict product specification or the legacy brief placeholder.", 422, {
      details: { issues: externalProductSpecification.error.issues.slice(0, 100) },
    });
  }
  assertPortableSemanticEquality("prototype.json", sidecars.prototype, document.prototype_links);
  assertPortableSemanticEquality("design-system.json", sidecars.designSystem, { pin: null, components: {} });
  assertPortableSemanticEquality(
    "tokens.dtcg.json",
    sidecars.tokens,
    toDtcgTokens(document.tokens as unknown as Record<string, unknown>),
  );
  assertPortableSemanticEquality("implementation-map.json", sidecars.implementationMap, {});
  return sidecars;
}

function strictPortableDocument(value: unknown, schemaVersion: number, context: "export" | "import"): AnyDesignDocument {
  if (schemaVersion !== 1 && schemaVersion !== 2) {
    throw new DomainError("VALIDATION_FAILED", "Unsupported document schema version.", 422);
  }
  const parsed = schemaVersion === 1
    ? DesignDocumentSchema.safeParse(value)
    : DesignDocumentV2Schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new DomainError(
    "VALIDATION_FAILED",
    context === "export"
      ? "Portable export document does not satisfy its strict schema."
      : "Portable document does not satisfy its strict schema.",
    422,
    { details: { issues: parsed.error.issues.slice(0, 100) } },
  );
}

export function createPortableProjectBundle(input: PortableExportInput): Buffer {
  const schemaVersion = Number(input.document.schema_version);
  if (schemaVersion !== 1 && schemaVersion !== 2) throw new DomainError("VALIDATION_FAILED", "Unsupported document schema version.", 422);
  const document = strictPortableDocument(input.document, schemaVersion, "export");
  const assets = input.assets ?? [];
  const providedAssetIds = new Set<string>();
  for (const asset of assets) {
    if (providedAssetIds.has(asset.id)) throw new DomainError("VALIDATION_FAILED", `Portable asset is duplicated: ${asset.id}`, 422);
    providedAssetIds.add(asset.id);
    const documentAsset = document.assets[asset.id];
    if (!documentAsset) throw new DomainError("VALIDATION_FAILED", `Portable asset is not declared by the document: ${asset.id}`, 422);
    if (portableAssetRequiresQuarantine(documentAsset)) {
      throw new DomainError("VALIDATION_FAILED", `Quarantined asset bytes must not be included in a portable bundle: ${asset.id}`, 422);
    }
    if (documentAsset.mime_type !== asset.mimeType
      || documentAsset.size_bytes !== asset.data.length
      || documentAsset.sha256 !== asset.sha256) {
      throw new DomainError("VALIDATION_FAILED", `Portable asset metadata does not match the document: ${asset.id}`, 422);
    }
  }
  const quarantinedAssetIds = Object.values(document.assets)
    .filter((asset) => portableAssetRequiresQuarantine(asset))
    .map((asset) => asset.id)
    .sort();
  const requiredAssetIds = Object.values(document.assets)
    .filter((asset) => !portableAssetRequiresQuarantine(asset))
    .map((asset) => asset.id)
    .sort();
  if (requiredAssetIds.length !== providedAssetIds.size
    || requiredAssetIds.some((assetId) => !providedAssetIds.has(assetId))) {
    throw new DomainError("VALIDATION_FAILED", "Portable bundle is missing one or more normalized document assets.", 422);
  }
  const assetHashes = Object.fromEntries(assets.map((asset) => [asset.id, asset.sha256]));
  const manifest: PortableManifest = {
    format: "formaspec-project",
    exportFormatVersion: ENGINE_VERSIONS.exportFormat,
    documentSchemaVersion: schemaVersion,
    designSystemVersion: input.designSystemVersion,
    applicationBuildVersion: ENGINE_VERSIONS.applicationBuild,
    rendererVersion: ENGINE_VERSIONS.renderer,
    fontBundleVersion: ENGINE_VERSIONS.fontBundle,
    revisionId: input.revisionId,
    revisionHash: input.revisionHash,
    assetHashes,
    quarantinedAssetIds,
    creationTime: input.createdAt ?? new Date().toISOString(),
  };
  const v2Document = document.schema_version === 2 ? document : null;
  const semanticSidecars = validatePortableSemanticSidecars(document, {
    productSpecification: input.productSpecification
      ?? v2Document?.product_specification
      ?? { natural_language_brief: legacyProductBrief(document) },
    prototype: input.prototype ?? document.prototype_links ?? {},
    designSystem: input.designSystem ?? {
      pin: v2Document?.design_system ?? null,
      components: v2Document?.component_definitions ?? {},
    },
    tokens: input.tokens ?? toDtcgTokens((document.tokens as Record<string, unknown> | undefined) ?? {}),
    implementationMap: input.implementationMap ?? v2Document?.implementation_mappings ?? {},
  }, manifest.designSystemVersion);
  const entries: Record<string, Uint8Array> = {
    "manifest.json": jsonEntry(manifest),
    "document.json": jsonEntry(document),
    "product-spec.json": jsonEntry(semanticSidecars.productSpecification),
    "prototype.json": jsonEntry(semanticSidecars.prototype),
    "design-system.json": jsonEntry(semanticSidecars.designSystem),
    "tokens.dtcg.json": jsonEntry(semanticSidecars.tokens),
    "implementation-map.json": jsonEntry(semanticSidecars.implementationMap),
  };
  for (const asset of assets) {
    if (sha256(asset.data) !== asset.sha256) throw new DomainError("VALIDATION_FAILED", `Asset hash mismatch: ${asset.id}`, 422);
    entries[`assets/${safeLeafName(asset.id, "Asset ID")}.${assetExtension(asset.mimeType)}`] = asset.data;
  }
  for (const preview of input.previews ?? []) {
    const name = safeEntryName(preview.name.replace(/\.png$/i, ""));
    entries[`previews/${name}.png`] = preview.png;
  }
  const checksumLines = Object.keys(entries).sort().map((name) => `${sha256(entries[name]!)}  ${name}`);
  entries["checksums.sha256"] = Buffer.from(`${checksumLines.join("\n")}\n`, "utf8");
  return Buffer.from(zipSync(entries, { level: 6, mtime: new Date("1980-01-01T00:00:00.000Z") }));
}

interface ZipCentralEntry {
  name: string;
  rawName: Buffer;
  versionNeeded: number;
  flags: number;
  compression: 0 | 8;
  modifiedTime: number;
  modifiedDate: number;
  crc32: number;
  compressedBytes: number;
  expandedBytes: number;
  localHeaderOffset: number;
  dataOffset: number;
  dataEnd: number;
}

interface ZipCentralDirectory {
  entries: ZipCentralEntry[];
  expandedBytes: number;
  directoryOffset: number;
}

function malformedZip(message = "Portable bundle ZIP structure is malformed."): DomainError {
  return new DomainError("VALIDATION_FAILED", message, 422);
}

function decodeZipEntryName(rawName: Buffer, flags: number): string {
  let decoded: string;
  try {
    if ((flags & ZIP_UTF8_FLAG) !== 0) decoded = new TextDecoder("utf-8", { fatal: true }).decode(rawName);
    else {
      if (rawName.some((byte) => byte > 0x7f)) {
        throw malformedZip("Portable bundle uses an unsupported filename encoding.");
      }
      decoded = rawName.toString("ascii");
    }
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw malformedZip("Portable bundle contains an invalid UTF-8 filename.");
  }
  if (decoded.includes("\\") || decoded.startsWith("./") || decoded.endsWith("/")) {
    throw new DomainError("VALIDATION_FAILED", "Portable bundle contains an unsafe path.", 422);
  }
  const safe = safeEntryName(decoded);
  if (safe !== decoded) throw new DomainError("VALIDATION_FAILED", "Portable bundle contains a non-canonical path.", 422);
  return safe;
}

function inspectZipExtraFields(data: Buffer, offset: number, length: number): void {
  const end = offset + length;
  let cursor = offset;
  while (cursor < end) {
    if (cursor + 4 > end) throw malformedZip("Portable bundle contains a malformed ZIP extra field.");
    const fieldId = data.readUInt16LE(cursor);
    const fieldLength = data.readUInt16LE(cursor + 2);
    cursor += 4;
    if (cursor + fieldLength > end) throw malformedZip("Portable bundle contains a malformed ZIP extra field.");
    if (ZIP_UNSUPPORTED_EXTRA_FIELDS.has(fieldId)) {
      throw malformedZip("Portable bundle uses an unsupported ZIP extension.");
    }
    cursor += fieldLength;
  }
}

function assertSupportedZipEntry(
  name: string,
  versionMadeBy: number,
  versionNeeded: number,
  flags: number,
  compression: number,
  externalAttributes: number,
  diskStart: number,
): asserts compression is 0 | 8 {
  if ((flags & ZIP_ENCRYPTION_FLAGS) !== 0) {
    throw malformedZip(`Portable bundle entry is encrypted: ${name}`);
  }
  if ((flags & ~ZIP_SUPPORTED_FLAGS) !== 0 || (compression === 0 && (flags & 0x0006) !== 0)) {
    throw malformedZip(`Portable bundle entry uses unsupported ZIP flags: ${name}`);
  }
  if (compression !== 0 && compression !== 8) {
    throw malformedZip(`Portable bundle entry uses an unsupported compression method: ${name}`);
  }
  const minimumVersion = compression === 8 ? 20 : 10;
  if (versionNeeded < minimumVersion || versionNeeded > 20 || diskStart !== 0) {
    throw malformedZip(`Portable bundle entry uses an unsupported ZIP feature: ${name}`);
  }
  const creatorSystem = versionMadeBy >>> 8;
  if (creatorSystem !== 0 && creatorSystem !== 3 && creatorSystem !== 19) {
    throw malformedZip(`Portable bundle entry uses unsupported file attributes: ${name}`);
  }
  if ((externalAttributes & ZIP_DOS_NON_REGULAR_ATTRIBUTES) !== 0) {
    throw malformedZip(`Portable bundle contains a non-regular entry: ${name}`);
  }
  if (creatorSystem === 3 || creatorSystem === 19) {
    const unixMode = externalAttributes >>> 16;
    const fileType = unixMode & ZIP_UNIX_FILE_TYPE_MASK;
    if (fileType !== 0 && fileType !== ZIP_UNIX_REGULAR_FILE) {
      throw malformedZip(`Portable bundle contains a non-regular entry: ${name}`);
    }
  }
}

function inspectCentralDirectory(data: Buffer): ZipCentralDirectory {
  if (data.length > MAX_ARCHIVE_BYTES) throw new DomainError("PAYLOAD_TOO_LARGE", "Portable bundle exceeds the archive byte limit.", 413);
  let eocd = -1;
  for (let index = data.length - 22; index >= Math.max(0, data.length - 65_557); index -= 1) {
    if (data.readUInt32LE(index) !== ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE) continue;
    const commentLength = data.readUInt16LE(index + 20);
    if (index + 22 + commentLength === data.length) { eocd = index; break; }
  }
  if (eocd < 0) throw malformedZip("Portable bundle has no valid ZIP directory.");
  const diskNumber = data.readUInt16LE(eocd + 4);
  const directoryDisk = data.readUInt16LE(eocd + 6);
  const entriesOnDisk = data.readUInt16LE(eocd + 8);
  const entryCount = data.readUInt16LE(eocd + 10);
  const directorySize = data.readUInt32LE(eocd + 12);
  const directoryOffset = data.readUInt32LE(eocd + 16);
  if (diskNumber !== 0 || directoryDisk !== 0 || entriesOnDisk !== entryCount) {
    throw malformedZip("Portable bundle uses unsupported multi-disk ZIP storage.");
  }
  if (entryCount === ZIP64_SENTINEL_16 || directorySize === ZIP64_SENTINEL_32 || directoryOffset === ZIP64_SENTINEL_32) {
    throw malformedZip("Portable bundle uses unsupported ZIP64 storage.");
  }
  if (entryCount > MAX_ENTRIES) throw new DomainError("PAYLOAD_TOO_LARGE", "Portable bundle entry count exceeds the configured limit.", 413);
  const directoryEnd = directoryOffset + directorySize;
  if (directoryEnd !== eocd || directoryOffset > eocd) throw malformedZip("Portable bundle directory is malformed.");

  const entries: ZipCentralEntry[] = [];
  const seen = new Set<string>();
  const seenOffsets = new Set<number>();
  let expandedBytes = 0;
  let cursor = directoryOffset;
  for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
    if (cursor + 46 > directoryEnd || data.readUInt32LE(cursor) !== ZIP_CENTRAL_HEADER_SIGNATURE) {
      throw malformedZip("Portable bundle directory is malformed.");
    }
    const versionMadeBy = data.readUInt16LE(cursor + 4);
    const versionNeeded = data.readUInt16LE(cursor + 6);
    const flags = data.readUInt16LE(cursor + 8);
    const compression = data.readUInt16LE(cursor + 10);
    const modifiedTime = data.readUInt16LE(cursor + 12);
    const modifiedDate = data.readUInt16LE(cursor + 14);
    const crc = data.readUInt32LE(cursor + 16);
    const compressedBytes = data.readUInt32LE(cursor + 20);
    const entryBytes = data.readUInt32LE(cursor + 24);
    const nameLength = data.readUInt16LE(cursor + 28);
    const extraLength = data.readUInt16LE(cursor + 30);
    const commentLength = data.readUInt16LE(cursor + 32);
    const diskStart = data.readUInt16LE(cursor + 34);
    const externalAttributes = data.readUInt32LE(cursor + 38);
    const localHeaderOffset = data.readUInt32LE(cursor + 42);
    const entryEnd = cursor + 46 + nameLength + extraLength + commentLength;
    if (entryEnd > directoryEnd) throw malformedZip("Portable bundle directory is malformed.");
    if (entryBytes > MAX_ENTRY_BYTES) {
      throw new DomainError("PAYLOAD_TOO_LARGE", "A portable bundle entry exceeds the 64 MiB expansion limit.", 413);
    }
    if (compressedBytes === ZIP64_SENTINEL_32 || localHeaderOffset === ZIP64_SENTINEL_32) {
      throw malformedZip("Portable bundle uses unsupported ZIP64 entries.");
    }
    const rawName = Buffer.from(data.subarray(cursor + 46, cursor + 46 + nameLength));
    const name = decodeZipEntryName(rawName, flags);
    assertSupportedZipEntry(name, versionMadeBy, versionNeeded, flags, compression, externalAttributes, diskStart);
    inspectZipExtraFields(data, cursor + 46 + nameLength, extraLength);
    expandedBytes += entryBytes;
    if (expandedBytes > MAX_EXPANDED_BYTES) throw new DomainError("PAYLOAD_TOO_LARGE", "Portable bundle expands beyond the configured limit.", 413);
    if (seen.has(name)) throw malformedZip(`Portable bundle contains duplicate entry: ${name}`);
    if (seenOffsets.has(localHeaderOffset)) throw malformedZip("Portable bundle contains overlapping local entries.");
    seen.add(name);
    seenOffsets.add(localHeaderOffset);
    entries.push({
      name,
      rawName,
      versionNeeded,
      flags,
      compression,
      modifiedTime,
      modifiedDate,
      crc32: crc,
      compressedBytes,
      expandedBytes: entryBytes,
      localHeaderOffset,
      dataOffset: 0,
      dataEnd: 0,
    });
    cursor = entryEnd;
  }
  if (cursor !== directoryEnd || entries.length !== entryCount) throw malformedZip("Portable bundle entry count is inconsistent.");

  const localEntries = [...entries].sort((left, right) => left.localHeaderOffset - right.localHeaderOffset);
  if (localEntries.length > 0 && localEntries[0]!.localHeaderOffset !== 0) {
    throw malformedZip("Portable bundle contains data outside regular ZIP entries.");
  }
  for (let index = 0; index < localEntries.length; index += 1) {
    const entry = localEntries[index]!;
    const nextOffset = localEntries[index + 1]?.localHeaderOffset ?? directoryOffset;
    const offset = entry.localHeaderOffset;
    if (offset + 30 > nextOffset || data.readUInt32LE(offset) !== ZIP_LOCAL_HEADER_SIGNATURE) {
      throw malformedZip("Portable bundle local entry is malformed.");
    }
    const versionNeeded = data.readUInt16LE(offset + 4);
    const flags = data.readUInt16LE(offset + 6);
    const compression = data.readUInt16LE(offset + 8);
    const modifiedTime = data.readUInt16LE(offset + 10);
    const modifiedDate = data.readUInt16LE(offset + 12);
    const crc = data.readUInt32LE(offset + 14);
    const compressedBytes = data.readUInt32LE(offset + 18);
    const expandedEntryBytes = data.readUInt32LE(offset + 22);
    const nameLength = data.readUInt16LE(offset + 26);
    const extraLength = data.readUInt16LE(offset + 28);
    const headerEnd = offset + 30 + nameLength + extraLength;
    if (headerEnd > nextOffset) throw malformedZip("Portable bundle local entry is malformed.");
    const rawName = Buffer.from(data.subarray(offset + 30, offset + 30 + nameLength));
    if (!rawName.equals(entry.rawName)
      || versionNeeded !== entry.versionNeeded
      || flags !== entry.flags
      || compression !== entry.compression
      || modifiedTime !== entry.modifiedTime
      || modifiedDate !== entry.modifiedDate) {
      throw malformedZip("Portable bundle local and central entry metadata do not match.");
    }
    inspectZipExtraFields(data, offset + 30 + nameLength, extraLength);
    const usesDescriptor = (flags & ZIP_DATA_DESCRIPTOR_FLAG) !== 0;
    if (usesDescriptor) {
      if ((crc !== 0 && crc !== entry.crc32)
        || (compressedBytes !== 0 && compressedBytes !== entry.compressedBytes)
        || (expandedEntryBytes !== 0 && expandedEntryBytes !== entry.expandedBytes)) {
        throw malformedZip("Portable bundle local and central entry sizes do not match.");
      }
    } else if (crc !== entry.crc32
      || compressedBytes !== entry.compressedBytes
      || expandedEntryBytes !== entry.expandedBytes) {
      throw malformedZip("Portable bundle local and central entry sizes do not match.");
    }
    if (entry.compression === 0 && entry.compressedBytes !== entry.expandedBytes) {
      throw malformedZip(`Portable stored entry has inconsistent sizes: ${entry.name}`);
    }
    if (entry.compression === 8 && entry.compressedBytes === 0) {
      throw malformedZip(`Portable bundle compressed stream is malformed: ${entry.name}`);
    }
    const dataEnd = headerEnd + entry.compressedBytes;
    if (dataEnd > nextOffset) throw malformedZip("Portable bundle compressed entry exceeds its local record.");
    if (usesDescriptor) {
      const descriptorLength = nextOffset - dataEnd;
      const descriptorHasSignature = descriptorLength === 16;
      if (descriptorLength !== 12 && descriptorLength !== 16) throw malformedZip("Portable bundle data descriptor is malformed.");
      let descriptorOffset = dataEnd;
      if (descriptorHasSignature) {
        if (data.readUInt32LE(descriptorOffset) !== ZIP_DATA_DESCRIPTOR_SIGNATURE) throw malformedZip("Portable bundle data descriptor is malformed.");
        descriptorOffset += 4;
      }
      if (data.readUInt32LE(descriptorOffset) !== entry.crc32
        || data.readUInt32LE(descriptorOffset + 4) !== entry.compressedBytes
        || data.readUInt32LE(descriptorOffset + 8) !== entry.expandedBytes) {
        throw malformedZip("Portable bundle data descriptor does not match its central entry.");
      }
    } else if (dataEnd !== nextOffset) {
      throw malformedZip("Portable bundle contains unlisted or overlapping local data.");
    }
    entry.dataOffset = headerEnd;
    entry.dataEnd = dataEnd;
  }
  return { entries, expandedBytes, directoryOffset };
}

function updateCrc32(crc: number, data: Uint8Array): number {
  let value = crc;
  for (let index = 0; index < data.length; index += 1) {
    value = CRC32_TABLE[(value ^ data[index]!) & 0xff]! ^ (value >>> 8);
  }
  return value >>> 0;
}

function assertInflateFullyConsumed(inflater: Inflate, entryName: string): void {
  // Pinned fflate retains the terminal partial byte in `p`; any additional byte is trailing data.
  const progress = inflater as unknown as {
    p?: Uint8Array;
    s?: { f?: number; l?: unknown; p?: number };
  };
  const bitOffset = progress.s?.p;
  const expectedBufferedBytes = bitOffset === 0 ? 0 : 1;
  if (progress.s?.f !== 1
    || progress.s.l != null
    || bitOffset === undefined
    || progress.p?.length !== expectedBufferedBytes) {
    throw malformedZip(`Portable bundle compressed stream is malformed: ${entryName}`);
  }
}

function extractPortableEntries(data: Buffer, inspected: ZipCentralDirectory): Record<string, Uint8Array> {
  const entries: Record<string, Uint8Array> = {};
  let actualExpandedBytes = 0;
  for (const entry of inspected.entries) {
    const output = Buffer.allocUnsafe(entry.expandedBytes);
    let outputOffset = 0;
    let crc = 0xffff_ffff;
    let sawFinal = entry.compression === 0;
    const emit = (chunk: Uint8Array, final: boolean): void => {
      const nextEntryBytes = outputOffset + chunk.length;
      const nextExpandedBytes = actualExpandedBytes + chunk.length;
      if (nextEntryBytes > MAX_ENTRY_BYTES || nextExpandedBytes > MAX_EXPANDED_BYTES) {
        throw new DomainError("PAYLOAD_TOO_LARGE", "Portable bundle emitted data beyond the configured expansion limit.", 413);
      }
      if (nextEntryBytes > entry.expandedBytes) {
        throw malformedZip(`Portable bundle entry emitted more data than declared: ${entry.name}`);
      }
      output.set(chunk, outputOffset);
      outputOffset = nextEntryBytes;
      actualExpandedBytes = nextExpandedBytes;
      crc = updateCrc32(crc, chunk);
      if (final) sawFinal = true;
    };
    try {
      if (entry.compression === 0) {
        for (let offset = entry.dataOffset; offset < entry.dataEnd; offset += ZIP_STREAM_CHUNK_BYTES) {
          const end = Math.min(offset + ZIP_STREAM_CHUNK_BYTES, entry.dataEnd);
          emit(data.subarray(offset, end), end === entry.dataEnd);
        }
      } else {
        const inflater = new Inflate((chunk, final) => emit(chunk, final));
        if (entry.dataOffset === entry.dataEnd) inflater.push(new Uint8Array(), true);
        else {
          for (let offset = entry.dataOffset; offset < entry.dataEnd; offset += ZIP_STREAM_CHUNK_BYTES) {
            const end = Math.min(offset + ZIP_STREAM_CHUNK_BYTES, entry.dataEnd);
            inflater.push(data.subarray(offset, end), end === entry.dataEnd);
          }
        }
        assertInflateFullyConsumed(inflater, entry.name);
      }
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError("VALIDATION_FAILED", `Portable bundle compressed stream is malformed: ${entry.name}`, 422, { cause: error });
    }
    if (!sawFinal || outputOffset !== entry.expandedBytes) {
      throw malformedZip(`Portable bundle entry emitted an unexpected byte count: ${entry.name}`);
    }
    if (((crc ^ 0xffff_ffff) >>> 0) !== entry.crc32) {
      throw malformedZip(`Portable bundle entry failed its ZIP CRC check: ${entry.name}`);
    }
    entries[entry.name] = output;
  }
  if (actualExpandedBytes !== inspected.expandedBytes || Object.keys(entries).length !== inspected.entries.length) {
    throw malformedZip("Portable bundle extraction did not cover every declared entry.");
  }
  return entries;
}

export interface ImportedPortableProject {
  manifest: PortableManifest;
  document: AnyDesignDocument;
  productSpecification: unknown;
  prototype: unknown;
  designSystem: unknown;
  tokens: unknown;
  implementationMap: unknown;
  assets: Record<string, Buffer>;
  previews: Record<string, Buffer>;
}

export function readPortableProjectBundle(data: Buffer): ImportedPortableProject {
  const inspected = inspectCentralDirectory(data);
  const entries = extractPortableEntries(data, inspected);
  for (const required of [
    "manifest.json",
    "document.json",
    "product-spec.json",
    "prototype.json",
    "design-system.json",
    "tokens.dtcg.json",
    "implementation-map.json",
    "checksums.sha256",
  ]) if (!entries[required]) throw new DomainError("VALIDATION_FAILED", `Portable bundle is missing ${required}.`, 422);

  const checksumRows = Buffer.from(entries["checksums.sha256"]!).toString("utf8").split("\n").filter(Boolean);
  const expected = new Map<string, string>();
  for (const row of checksumRows) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(row);
    if (!match) throw new DomainError("VALIDATION_FAILED", "Portable checksum manifest is malformed.", 422);
    const name = safeEntryName(match[2]!);
    if (name === "checksums.sha256" || expected.has(name)) {
      throw new DomainError("VALIDATION_FAILED", "Portable checksum manifest contains a duplicate or self-reference.", 422);
    }
    expected.set(name, match[1]!);
  }
  const payloadNames = Object.keys(entries).filter((name) => name !== "checksums.sha256");
  if (expected.size !== payloadNames.length || [...expected.keys()].some((name) => !(name in entries))) {
    throw new DomainError("VALIDATION_FAILED", "Portable checksum manifest does not exactly cover the archive payload.", 422);
  }
  for (const [name, value] of Object.entries(entries)) {
    if (name === "checksums.sha256") continue;
    if (expected.get(name) !== sha256(value)) throw new DomainError("VALIDATION_FAILED", `Portable checksum failed: ${name}`, 422);
  }
  const parse = (name: string): unknown => {
    try { return JSON.parse(Buffer.from(entries[name]!).toString("utf8")) as unknown; }
    catch { throw new DomainError("VALIDATION_FAILED", `Portable JSON is malformed: ${name}`, 422); }
  };
  const parsedManifest = parse("manifest.json");
  const parsedDocument = parse("document.json");
  if (!isRecord(parsedManifest) || !isRecord(parsedManifest.assetHashes)
    || typeof parsedManifest.revisionId !== "string"
    || typeof parsedManifest.revisionHash !== "string"
    || !/^[a-f0-9]{64}$/.test(parsedManifest.revisionHash)
    || typeof parsedManifest.creationTime !== "string"
    || !Number.isFinite(Date.parse(parsedManifest.creationTime))) {
    throw new DomainError("VALIDATION_FAILED", "Portable manifest is malformed.", 422);
  }
  const parsedAssetHashes = parsedManifest.assetHashes as Record<string, unknown>;
  if (!Object.entries(parsedAssetHashes).every(([id, hash]) =>
    safeLeafName(id, "Asset ID") === id && typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash))) {
    throw new DomainError("VALIDATION_FAILED", "Portable asset hash manifest is malformed.", 422);
  }
  const rawQuarantinedAssetIds = parsedManifest.quarantinedAssetIds ?? [];
  if (!Array.isArray(rawQuarantinedAssetIds)
    || rawQuarantinedAssetIds.some((id) => typeof id !== "string" || safeLeafName(id, "Asset ID") !== id)
    || new Set(rawQuarantinedAssetIds).size !== rawQuarantinedAssetIds.length
    || rawQuarantinedAssetIds.some((id) => id in parsedAssetHashes)) {
    throw new DomainError("VALIDATION_FAILED", "Portable quarantined-asset manifest is malformed.", 422);
  }
  if (!isRecord(parsedDocument)) throw new DomainError("VALIDATION_FAILED", "Portable document must be a JSON object.", 422);
  const manifest = {
    ...parsedManifest,
    quarantinedAssetIds: rawQuarantinedAssetIds,
  } as unknown as PortableManifest;
  const document = parsedDocument;
  if (manifest.format !== "formaspec-project" || manifest.exportFormatVersion !== ENGINE_VERSIONS.exportFormat) {
    throw new DomainError("VALIDATION_FAILED", "Portable export format is unsupported.", 422);
  }
  if (Number(document.schema_version) !== manifest.documentSchemaVersion || ![1, 2].includes(manifest.documentSchemaVersion)) {
    throw new DomainError("VALIDATION_FAILED", "Portable document schema does not match its manifest.", 422);
  }
  for (const collectionName of ["nodes", "tokens", "assets", "prototype_links", "component_definitions", "implementation_mappings"]) {
    const collection = document[collectionName];
    if (!collection || typeof collection !== "object" || Array.isArray(collection)) continue;
    for (const [id, value] of Object.entries(collection as Record<string, unknown>)) {
      if (value && typeof value === "object" && "id" in value && String((value as { id: unknown }).id) !== id) {
        throw new DomainError("VALIDATION_FAILED", `Portable ${collectionName} contains an ID/key mismatch.`, 422);
      }
    }
  }
  const validatedDocument = strictPortableDocument(document, manifest.documentSchemaVersion, "import");
  const assets = Object.fromEntries(Object.entries(entries).filter(([name]) => name.startsWith("assets/")).map(([name, value]) => [name, Buffer.from(value)]));
  for (const name of Object.keys(assets)) {
    if (!(pathAssetId(name) in manifest.assetHashes)) {
      throw new DomainError("VALIDATION_FAILED", `Portable bundle contains an unlisted asset: ${name}`, 422);
    }
  }
  for (const [assetId, hash] of Object.entries(manifest.assetHashes)) {
    const match = Object.entries(assets).find(([name]) => pathAssetId(name) === assetId);
    if (!match || sha256(match[1]) !== hash) throw new DomainError("VALIDATION_FAILED", `Portable asset is missing or corrupt: ${assetId}`, 422);
  }
  const documentAssetIds = isRecord(validatedDocument.assets) ? Object.keys(validatedDocument.assets).sort() : [];
  const manifestAssetIds = [...Object.keys(manifest.assetHashes), ...manifest.quarantinedAssetIds].sort();
  if (documentAssetIds.length !== manifestAssetIds.length || documentAssetIds.some((id, index) => id !== manifestAssetIds[index])) {
    throw new DomainError("VALIDATION_FAILED", "Portable asset manifest does not exactly match document asset references.", 422);
  }
  for (const assetId of manifest.quarantinedAssetIds) {
    const documentAsset = validatedDocument.assets[assetId];
    if (!documentAsset || !portableAssetRequiresQuarantine(documentAsset)) {
      throw new DomainError("VALIDATION_FAILED", `Portable manifest quarantines a render-ready asset: ${assetId}`, 422);
    }
  }
  for (const [assetId, hash] of Object.entries(manifest.assetHashes)) {
    const documentAsset = validatedDocument.assets[assetId];
    const match = Object.entries(assets).find(([name]) => pathAssetId(name) === assetId);
    const expectedName = documentAsset && !portableAssetRequiresQuarantine(documentAsset)
      ? `assets/${assetId}.${assetExtension(documentAsset.mime_type as PortableAsset["mimeType"])}`
      : null;
    if (!documentAsset || portableAssetRequiresQuarantine(documentAsset)
      || documentAsset.sha256 !== hash
      || documentAsset.size_bytes !== match?.[1].length
      || match?.[0] !== expectedName) {
      throw new DomainError("VALIDATION_FAILED", `Portable normalized asset metadata is inconsistent: ${assetId}`, 422);
    }
  }
  const semanticSidecars = validatePortableSemanticSidecars(validatedDocument, {
    productSpecification: parse("product-spec.json"),
    prototype: parse("prototype.json"),
    designSystem: parse("design-system.json"),
    tokens: parse("tokens.dtcg.json"),
    implementationMap: parse("implementation-map.json"),
  }, manifest.designSystemVersion);
  return {
    manifest,
    document: validatedDocument,
    ...semanticSidecars,
    assets,
    previews: Object.fromEntries(Object.entries(entries).filter(([name]) => name.startsWith("previews/")).map(([name, value]) => [name, Buffer.from(value)])),
  };
}

function pathAssetId(name: string): string {
  const base = name.slice("assets/".length);
  const dot = base.lastIndexOf(".");
  return dot === -1 ? base : base.slice(0, dot);
}

export interface StreamedPortableEntry {
  readonly kind: "private_file";
  readonly filename: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface StreamedImportedPortableProject {
  manifest: PortableManifest;
  document: AnyDesignDocument;
  productSpecification: unknown;
  prototype: unknown;
  designSystem: unknown;
  tokens: unknown;
  implementationMap: unknown;
  assets: Record<string, StreamedPortableEntry>;
  previews: Record<string, StreamedPortableEntry>;
}

interface FileZipCentralDirectory extends ZipCentralDirectory {
  archiveBytes: number;
}

async function readExact(handle: fs.promises.FileHandle, offset: number, length: number): Promise<Buffer> {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
    throw malformedZip();
  }
  const output = Buffer.allocUnsafe(length);
  let completed = 0;
  while (completed < length) {
    const result = await handle.read(output, completed, length - completed, offset + completed);
    if (result.bytesRead === 0) throw malformedZip();
    completed += result.bytesRead;
  }
  return output;
}

async function inspectCentralDirectoryFile(
  handle: fs.promises.FileHandle,
  archiveBytes: number,
): Promise<FileZipCentralDirectory> {
  if (archiveBytes > MAX_ARCHIVE_BYTES) {
    throw new DomainError("PAYLOAD_TOO_LARGE", "Portable bundle exceeds the archive byte limit.", 413);
  }
  if (archiveBytes < 22) throw malformedZip("Portable bundle has no valid ZIP directory.");
  const tailBytes = Math.min(archiveBytes, 65_557);
  const tailOffset = archiveBytes - tailBytes;
  const tail = await readExact(handle, tailOffset, tailBytes);
  let relativeEocd = -1;
  for (let index = tail.length - 22; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) !== ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE) continue;
    const commentLength = tail.readUInt16LE(index + 20);
    if (tailOffset + index + 22 + commentLength === archiveBytes) {
      relativeEocd = index;
      break;
    }
  }
  if (relativeEocd < 0) throw malformedZip("Portable bundle has no valid ZIP directory.");
  const eocd = tailOffset + relativeEocd;
  const diskNumber = tail.readUInt16LE(relativeEocd + 4);
  const directoryDisk = tail.readUInt16LE(relativeEocd + 6);
  const entriesOnDisk = tail.readUInt16LE(relativeEocd + 8);
  const entryCount = tail.readUInt16LE(relativeEocd + 10);
  const directorySize = tail.readUInt32LE(relativeEocd + 12);
  const directoryOffset = tail.readUInt32LE(relativeEocd + 16);
  if (diskNumber !== 0 || directoryDisk !== 0 || entriesOnDisk !== entryCount) {
    throw malformedZip("Portable bundle uses unsupported multi-disk ZIP storage.");
  }
  if (entryCount === ZIP64_SENTINEL_16 || directorySize === ZIP64_SENTINEL_32 || directoryOffset === ZIP64_SENTINEL_32) {
    throw malformedZip("Portable bundle uses unsupported ZIP64 storage.");
  }
  if (entryCount > MAX_ENTRIES) {
    throw new DomainError("PAYLOAD_TOO_LARGE", "Portable bundle entry count exceeds the configured limit.", 413);
  }
  if (directoryOffset + directorySize !== eocd || directoryOffset > eocd) {
    throw malformedZip("Portable bundle directory is malformed.");
  }

  const entries: ZipCentralEntry[] = [];
  const seen = new Set<string>();
  const seenOffsets = new Set<number>();
  let expandedBytes = 0;
  let cursor = directoryOffset;
  const directoryEnd = eocd;
  for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
    if (cursor + 46 > directoryEnd) throw malformedZip("Portable bundle directory is malformed.");
    const header = await readExact(handle, cursor, 46);
    if (header.readUInt32LE(0) !== ZIP_CENTRAL_HEADER_SIGNATURE) {
      throw malformedZip("Portable bundle directory is malformed.");
    }
    const versionMadeBy = header.readUInt16LE(4);
    const versionNeeded = header.readUInt16LE(6);
    const flags = header.readUInt16LE(8);
    const compression = header.readUInt16LE(10);
    const modifiedTime = header.readUInt16LE(12);
    const modifiedDate = header.readUInt16LE(14);
    const crc = header.readUInt32LE(16);
    const compressedBytes = header.readUInt32LE(20);
    const entryBytes = header.readUInt32LE(24);
    const nameLength = header.readUInt16LE(28);
    const extraLength = header.readUInt16LE(30);
    const commentLength = header.readUInt16LE(32);
    const diskStart = header.readUInt16LE(34);
    const externalAttributes = header.readUInt32LE(38);
    const localHeaderOffset = header.readUInt32LE(42);
    const variableLength = nameLength + extraLength + commentLength;
    const entryEnd = cursor + 46 + variableLength;
    if (entryEnd > directoryEnd) throw malformedZip("Portable bundle directory is malformed.");
    if (entryBytes > MAX_ENTRY_BYTES) {
      throw new DomainError("PAYLOAD_TOO_LARGE", "A portable bundle entry exceeds the 64 MiB expansion limit.", 413);
    }
    if (compressedBytes === ZIP64_SENTINEL_32 || localHeaderOffset === ZIP64_SENTINEL_32) {
      throw malformedZip("Portable bundle uses unsupported ZIP64 entries.");
    }
    const variable = await readExact(handle, cursor + 46, variableLength);
    const rawName = Buffer.from(variable.subarray(0, nameLength));
    const name = decodeZipEntryName(rawName, flags);
    assertSupportedZipEntry(name, versionMadeBy, versionNeeded, flags, compression, externalAttributes, diskStart);
    inspectZipExtraFields(variable, nameLength, extraLength);
    expandedBytes += entryBytes;
    if (expandedBytes > MAX_EXPANDED_BYTES) {
      throw new DomainError("PAYLOAD_TOO_LARGE", "Portable bundle expands beyond the configured limit.", 413);
    }
    if (seen.has(name)) throw malformedZip(`Portable bundle contains duplicate entry: ${name}`);
    if (seenOffsets.has(localHeaderOffset)) throw malformedZip("Portable bundle contains overlapping local entries.");
    seen.add(name);
    seenOffsets.add(localHeaderOffset);
    entries.push({
      name,
      rawName,
      versionNeeded,
      flags,
      compression,
      modifiedTime,
      modifiedDate,
      crc32: crc,
      compressedBytes,
      expandedBytes: entryBytes,
      localHeaderOffset,
      dataOffset: 0,
      dataEnd: 0,
    });
    cursor = entryEnd;
  }
  if (cursor !== directoryEnd || entries.length !== entryCount) {
    throw malformedZip("Portable bundle entry count is inconsistent.");
  }

  const localEntries = [...entries].sort((left, right) => left.localHeaderOffset - right.localHeaderOffset);
  if (localEntries.length > 0 && localEntries[0]!.localHeaderOffset !== 0) {
    throw malformedZip("Portable bundle contains data outside regular ZIP entries.");
  }
  for (let index = 0; index < localEntries.length; index += 1) {
    const entry = localEntries[index]!;
    const nextOffset = localEntries[index + 1]?.localHeaderOffset ?? directoryOffset;
    const offset = entry.localHeaderOffset;
    if (offset + 30 > nextOffset) throw malformedZip("Portable bundle local entry is malformed.");
    const header = await readExact(handle, offset, 30);
    if (header.readUInt32LE(0) !== ZIP_LOCAL_HEADER_SIGNATURE) {
      throw malformedZip("Portable bundle local entry is malformed.");
    }
    const versionNeeded = header.readUInt16LE(4);
    const flags = header.readUInt16LE(6);
    const compression = header.readUInt16LE(8);
    const modifiedTime = header.readUInt16LE(10);
    const modifiedDate = header.readUInt16LE(12);
    const crc = header.readUInt32LE(14);
    const compressedBytes = header.readUInt32LE(18);
    const expandedEntryBytes = header.readUInt32LE(22);
    const nameLength = header.readUInt16LE(26);
    const extraLength = header.readUInt16LE(28);
    const headerEnd = offset + 30 + nameLength + extraLength;
    if (headerEnd > nextOffset) throw malformedZip("Portable bundle local entry is malformed.");
    const variable = await readExact(handle, offset + 30, nameLength + extraLength);
    const rawName = Buffer.from(variable.subarray(0, nameLength));
    if (!rawName.equals(entry.rawName)
      || versionNeeded !== entry.versionNeeded
      || flags !== entry.flags
      || compression !== entry.compression
      || modifiedTime !== entry.modifiedTime
      || modifiedDate !== entry.modifiedDate) {
      throw malformedZip("Portable bundle local and central entry metadata do not match.");
    }
    inspectZipExtraFields(variable, nameLength, extraLength);
    const usesDescriptor = (flags & ZIP_DATA_DESCRIPTOR_FLAG) !== 0;
    if (usesDescriptor) {
      if ((crc !== 0 && crc !== entry.crc32)
        || (compressedBytes !== 0 && compressedBytes !== entry.compressedBytes)
        || (expandedEntryBytes !== 0 && expandedEntryBytes !== entry.expandedBytes)) {
        throw malformedZip("Portable bundle local and central entry sizes do not match.");
      }
    } else if (crc !== entry.crc32
      || compressedBytes !== entry.compressedBytes
      || expandedEntryBytes !== entry.expandedBytes) {
      throw malformedZip("Portable bundle local and central entry sizes do not match.");
    }
    if (entry.compression === 0 && entry.compressedBytes !== entry.expandedBytes) {
      throw malformedZip(`Portable stored entry has inconsistent sizes: ${entry.name}`);
    }
    if (entry.compression === 8 && entry.compressedBytes === 0) {
      throw malformedZip(`Portable bundle compressed stream is malformed: ${entry.name}`);
    }
    const dataEnd = headerEnd + entry.compressedBytes;
    if (dataEnd > nextOffset) throw malformedZip("Portable bundle compressed entry exceeds its local record.");
    if (usesDescriptor) {
      const descriptorLength = nextOffset - dataEnd;
      if (descriptorLength !== 12 && descriptorLength !== 16) {
        throw malformedZip("Portable bundle data descriptor is malformed.");
      }
      const descriptor = await readExact(handle, dataEnd, descriptorLength);
      let descriptorOffset = 0;
      if (descriptorLength === 16) {
        if (descriptor.readUInt32LE(0) !== ZIP_DATA_DESCRIPTOR_SIGNATURE) {
          throw malformedZip("Portable bundle data descriptor is malformed.");
        }
        descriptorOffset = 4;
      }
      if (descriptor.readUInt32LE(descriptorOffset) !== entry.crc32
        || descriptor.readUInt32LE(descriptorOffset + 4) !== entry.compressedBytes
        || descriptor.readUInt32LE(descriptorOffset + 8) !== entry.expandedBytes) {
        throw malformedZip("Portable bundle data descriptor does not match its central entry.");
      }
    } else if (dataEnd !== nextOffset) {
      throw malformedZip("Portable bundle contains unlisted or overlapping local data.");
    }
    entry.dataOffset = headerEnd;
    entry.dataEnd = dataEnd;
  }
  return { entries, expandedBytes, directoryOffset, archiveBytes };
}

async function extractPortableEntriesToFiles(
  handle: fs.promises.FileHandle,
  inspected: FileZipCentralDirectory,
  extractionDirectory: string,
): Promise<Record<string, StreamedPortableEntry>> {
  const entries: Record<string, StreamedPortableEntry> = {};
  let actualExpandedBytes = 0;
  for (const [index, entry] of inspected.entries.entries()) {
    const filename = path.join(extractionDirectory, `entry-${String(index).padStart(5, "0")}.bin`);
    const output = await fs.promises.open(
      filename,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    let outputOffset = 0;
    let crc = 0xffff_ffff;
    let sawFinal = entry.compression === 0;
    const hash = createHash("sha256");
    const emit = (chunk: Uint8Array, final: boolean): void => {
      const nextEntryBytes = outputOffset + chunk.length;
      const nextExpandedBytes = actualExpandedBytes + chunk.length;
      if (nextEntryBytes > MAX_ENTRY_BYTES || nextExpandedBytes > MAX_EXPANDED_BYTES) {
        throw new DomainError("PAYLOAD_TOO_LARGE", "Portable bundle emitted data beyond the configured expansion limit.", 413);
      }
      if (nextEntryBytes > entry.expandedBytes) {
        throw malformedZip(`Portable bundle entry emitted more data than declared: ${entry.name}`);
      }
      let written = 0;
      while (written < chunk.length) {
        const count = fs.writeSync(output.fd, chunk, written, chunk.length - written, outputOffset + written);
        if (count <= 0) throw new Error("Portable extraction made no write progress.");
        written += count;
      }
      outputOffset = nextEntryBytes;
      actualExpandedBytes = nextExpandedBytes;
      crc = updateCrc32(crc, chunk);
      hash.update(chunk);
      if (final) sawFinal = true;
    };
    try {
      if (entry.compression === 0) {
        for (let offset = entry.dataOffset; offset < entry.dataEnd; offset += ZIP_STREAM_CHUNK_BYTES) {
          const length = Math.min(ZIP_STREAM_CHUNK_BYTES, entry.dataEnd - offset);
          emit(await readExact(handle, offset, length), offset + length === entry.dataEnd);
        }
      } else {
        const inflater = new Inflate((chunk, final) => emit(chunk, final));
        if (entry.dataOffset === entry.dataEnd) inflater.push(new Uint8Array(), true);
        else {
          for (let offset = entry.dataOffset; offset < entry.dataEnd; offset += ZIP_STREAM_CHUNK_BYTES) {
            const length = Math.min(ZIP_STREAM_CHUNK_BYTES, entry.dataEnd - offset);
            inflater.push(await readExact(handle, offset, length), offset + length === entry.dataEnd);
          }
        }
        assertInflateFullyConsumed(inflater, entry.name);
      }
      if (!sawFinal || outputOffset !== entry.expandedBytes) {
        throw malformedZip(`Portable bundle entry emitted an unexpected byte count: ${entry.name}`);
      }
      if (((crc ^ 0xffff_ffff) >>> 0) !== entry.crc32) {
        throw malformedZip(`Portable bundle entry failed its ZIP CRC check: ${entry.name}`);
      }
      await output.sync();
      entries[entry.name] = {
        kind: "private_file",
        filename,
        sizeBytes: outputOffset,
        sha256: hash.digest("hex"),
      };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError("VALIDATION_FAILED", `Portable bundle compressed stream is malformed: ${entry.name}`, 422, { cause: error });
    } finally {
      await output.close().catch(() => undefined);
    }
  }
  if (actualExpandedBytes !== inspected.expandedBytes || Object.keys(entries).length !== inspected.entries.length) {
    throw malformedZip("Portable bundle extraction did not cover every declared entry.");
  }
  return entries;
}

export async function readStreamedPortableEntry(entry: StreamedPortableEntry): Promise<Buffer> {
  const handle = await fs.promises.open(entry.filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== entry.sizeBytes) {
      throw new DomainError("VALIDATION_FAILED", "A staged portable entry changed during import.", 422);
    }
    const data = await readExact(handle, 0, entry.sizeBytes);
    if (sha256(data) !== entry.sha256) {
      throw new DomainError("VALIDATION_FAILED", "A staged portable entry changed during import.", 422);
    }
    return data;
  } finally {
    await handle.close();
  }
}

export async function readPortableProjectBundleFile(
  filename: string,
  extractionDirectory: string,
): Promise<StreamedImportedPortableProject> {
  const archive = await fs.promises.open(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let entries: Record<string, StreamedPortableEntry>;
  try {
    const stat = await archive.stat();
    if (!stat.isFile()) throw malformedZip("Portable bundle storage is not a regular file.");
    const inspected = await inspectCentralDirectoryFile(archive, stat.size);
    entries = await extractPortableEntriesToFiles(archive, inspected, extractionDirectory);
  } finally {
    await archive.close();
  }
  for (const required of [
    "manifest.json",
    "document.json",
    "product-spec.json",
    "prototype.json",
    "design-system.json",
    "tokens.dtcg.json",
    "implementation-map.json",
    "checksums.sha256",
  ]) if (!entries[required]) throw new DomainError("VALIDATION_FAILED", `Portable bundle is missing ${required}.`, 422);

  const checksumData = await readStreamedPortableEntry(entries["checksums.sha256"]!);
  const checksumRows = checksumData.toString("utf8").split("\n").filter(Boolean);
  const expected = new Map<string, string>();
  for (const row of checksumRows) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(row);
    if (!match) throw new DomainError("VALIDATION_FAILED", "Portable checksum manifest is malformed.", 422);
    const name = safeEntryName(match[2]!);
    if (name === "checksums.sha256" || expected.has(name)) {
      throw new DomainError("VALIDATION_FAILED", "Portable checksum manifest contains a duplicate or self-reference.", 422);
    }
    expected.set(name, match[1]!);
  }
  const payloadNames = Object.keys(entries).filter((name) => name !== "checksums.sha256");
  if (expected.size !== payloadNames.length || [...expected.keys()].some((name) => !(name in entries))) {
    throw new DomainError("VALIDATION_FAILED", "Portable checksum manifest does not exactly cover the archive payload.", 422);
  }
  for (const [name, entry] of Object.entries(entries)) {
    if (name !== "checksums.sha256" && expected.get(name) !== entry.sha256) {
      throw new DomainError("VALIDATION_FAILED", `Portable checksum failed: ${name}`, 422);
    }
  }
  const parse = async (name: string): Promise<unknown> => {
    try { return JSON.parse((await readStreamedPortableEntry(entries[name]!)).toString("utf8")) as unknown; }
    catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError("VALIDATION_FAILED", `Portable JSON is malformed: ${name}`, 422);
    }
  };
  const parsedManifest = await parse("manifest.json");
  const parsedDocument = await parse("document.json");
  if (!isRecord(parsedManifest) || !isRecord(parsedManifest.assetHashes)
    || typeof parsedManifest.revisionId !== "string"
    || typeof parsedManifest.revisionHash !== "string"
    || !/^[a-f0-9]{64}$/.test(parsedManifest.revisionHash)
    || typeof parsedManifest.creationTime !== "string"
    || !Number.isFinite(Date.parse(parsedManifest.creationTime))) {
    throw new DomainError("VALIDATION_FAILED", "Portable manifest is malformed.", 422);
  }
  const parsedAssetHashes = parsedManifest.assetHashes as Record<string, unknown>;
  if (!Object.entries(parsedAssetHashes).every(([id, hash]) =>
    safeLeafName(id, "Asset ID") === id && typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash))) {
    throw new DomainError("VALIDATION_FAILED", "Portable asset hash manifest is malformed.", 422);
  }
  const rawQuarantinedAssetIds = parsedManifest.quarantinedAssetIds ?? [];
  if (!Array.isArray(rawQuarantinedAssetIds)
    || rawQuarantinedAssetIds.some((id) => typeof id !== "string" || safeLeafName(id, "Asset ID") !== id)
    || new Set(rawQuarantinedAssetIds).size !== rawQuarantinedAssetIds.length
    || rawQuarantinedAssetIds.some((id) => id in parsedAssetHashes)) {
    throw new DomainError("VALIDATION_FAILED", "Portable quarantined-asset manifest is malformed.", 422);
  }
  if (!isRecord(parsedDocument)) throw new DomainError("VALIDATION_FAILED", "Portable document must be a JSON object.", 422);
  const manifest = { ...parsedManifest, quarantinedAssetIds: rawQuarantinedAssetIds } as unknown as PortableManifest;
  const document = parsedDocument;
  if (manifest.format !== "formaspec-project" || manifest.exportFormatVersion !== ENGINE_VERSIONS.exportFormat) {
    throw new DomainError("VALIDATION_FAILED", "Portable export format is unsupported.", 422);
  }
  if (Number(document.schema_version) !== manifest.documentSchemaVersion || ![1, 2].includes(manifest.documentSchemaVersion)) {
    throw new DomainError("VALIDATION_FAILED", "Portable document schema does not match its manifest.", 422);
  }
  for (const collectionName of ["nodes", "tokens", "assets", "prototype_links", "component_definitions", "implementation_mappings"]) {
    const collection = document[collectionName];
    if (!collection || typeof collection !== "object" || Array.isArray(collection)) continue;
    for (const [id, value] of Object.entries(collection as Record<string, unknown>)) {
      if (value && typeof value === "object" && "id" in value && String((value as { id: unknown }).id) !== id) {
        throw new DomainError("VALIDATION_FAILED", `Portable ${collectionName} contains an ID/key mismatch.`, 422);
      }
    }
  }
  const validatedDocument = strictPortableDocument(document, manifest.documentSchemaVersion, "import");
  const assets = Object.fromEntries(Object.entries(entries).filter(([name]) => name.startsWith("assets/")));
  for (const name of Object.keys(assets)) {
    if (!(pathAssetId(name) in manifest.assetHashes)) {
      throw new DomainError("VALIDATION_FAILED", `Portable bundle contains an unlisted asset: ${name}`, 422);
    }
  }
  for (const [assetId, hash] of Object.entries(manifest.assetHashes)) {
    const match = Object.entries(assets).find(([name]) => pathAssetId(name) === assetId);
    if (!match || match[1].sha256 !== hash) {
      throw new DomainError("VALIDATION_FAILED", `Portable asset is missing or corrupt: ${assetId}`, 422);
    }
  }
  const documentAssetIds = isRecord(validatedDocument.assets) ? Object.keys(validatedDocument.assets).sort() : [];
  const manifestAssetIds = [...Object.keys(manifest.assetHashes), ...manifest.quarantinedAssetIds].sort();
  if (documentAssetIds.length !== manifestAssetIds.length || documentAssetIds.some((id, index) => id !== manifestAssetIds[index])) {
    throw new DomainError("VALIDATION_FAILED", "Portable asset manifest does not exactly match document asset references.", 422);
  }
  for (const assetId of manifest.quarantinedAssetIds) {
    const documentAsset = validatedDocument.assets[assetId];
    if (!documentAsset || !portableAssetRequiresQuarantine(documentAsset)) {
      throw new DomainError("VALIDATION_FAILED", `Portable manifest quarantines a render-ready asset: ${assetId}`, 422);
    }
  }
  for (const [assetId, hash] of Object.entries(manifest.assetHashes)) {
    const documentAsset = validatedDocument.assets[assetId];
    const match = Object.entries(assets).find(([name]) => pathAssetId(name) === assetId);
    const expectedName = documentAsset && !portableAssetRequiresQuarantine(documentAsset)
      ? `assets/${assetId}.${assetExtension(documentAsset.mime_type as PortableAsset["mimeType"])}`
      : null;
    if (!documentAsset || portableAssetRequiresQuarantine(documentAsset)
      || documentAsset.sha256 !== hash
      || documentAsset.size_bytes !== match?.[1].sizeBytes
      || match?.[0] !== expectedName) {
      throw new DomainError("VALIDATION_FAILED", `Portable normalized asset metadata is inconsistent: ${assetId}`, 422);
    }
  }
  const [productSpecification, prototype, designSystem, tokens, implementationMap] = await Promise.all([
    parse("product-spec.json"),
    parse("prototype.json"),
    parse("design-system.json"),
    parse("tokens.dtcg.json"),
    parse("implementation-map.json"),
  ]);
  const semanticSidecars = validatePortableSemanticSidecars(validatedDocument, {
    productSpecification,
    prototype,
    designSystem,
    tokens,
    implementationMap,
  }, manifest.designSystemVersion);
  return {
    manifest,
    document: validatedDocument,
    ...semanticSidecars,
    assets,
    previews: Object.fromEntries(Object.entries(entries).filter(([name]) => name.startsWith("previews/"))),
  };
}
