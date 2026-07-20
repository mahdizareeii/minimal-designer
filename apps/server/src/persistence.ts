import { createHash } from "node:crypto";
import {
  brotliCompressSync,
  brotliDecompressSync,
  constants as zlibConstants,
} from "node:zlib";

import { ENGINE_VERSIONS } from "@designer/core";
import type Database from "better-sqlite3";

import { canonicalJson, hashPayload } from "./ids.js";

export interface RuntimeVersions {
  commandEngine: string;
  renderer: string;
  fontBundle: string;
  application: string;
  exportFormat: string;
}

export const DEFAULT_RUNTIME_VERSIONS: RuntimeVersions = {
  commandEngine: ENGINE_VERSIONS.commandEngine,
  renderer: ENGINE_VERSIONS.renderer,
  fontBundle: ENGINE_VERSIONS.fontBundle,
  application: ENGINE_VERSIONS.applicationBuild,
  exportFormat: String(ENGINE_VERSIONS.exportFormat),
};

export interface StoredSnapshot {
  hash: string;
  canonicalJson: string;
  canonicalBytes: Buffer;
}

interface SnapshotRow {
  document_brotli: Buffer;
  uncompressed_bytes: number;
}

export function canonicalSnapshot(document: unknown): StoredSnapshot {
  const json = canonicalJson(document);
  const bytes = Buffer.from(json, "utf8");
  return {
    hash: createHash("sha256").update(bytes).digest("hex"),
    canonicalJson: json,
    canonicalBytes: bytes,
  };
}

export function storeSnapshot(sqlite: Database.Database, document: unknown, now: string): StoredSnapshot {
  const snapshot = canonicalSnapshot(document);
  const compressed = brotliCompressSync(snapshot.canonicalBytes, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 5,
      [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
    },
  });
  sqlite.prepare(
    `INSERT OR IGNORE INTO snapshots
     (snapshot_hash, encoding, document_brotli, uncompressed_bytes, created_at)
     VALUES (?, 'br', ?, ?, ?)`,
  ).run(snapshot.hash, compressed, snapshot.canonicalBytes.length, now);
  return snapshot;
}

export function readSnapshotJson(
  sqlite: Database.Database,
  snapshotHash: string,
  options: { maxUncompressedBytes?: number } = {},
): string {
  const row = sqlite.prepare(
    "SELECT document_brotli, uncompressed_bytes FROM snapshots WHERE snapshot_hash = ?",
  ).get(snapshotHash) as SnapshotRow | undefined;
  if (!row) throw new Error(`Snapshot not found: ${snapshotHash}`);
  if (
    !Number.isSafeInteger(row.uncompressed_bytes)
    || row.uncompressed_bytes < 0
    || (options.maxUncompressedBytes !== undefined && row.uncompressed_bytes > options.maxUncompressedBytes)
  ) {
    throw new Error(`Snapshot size is invalid or exceeds the verification limit: ${snapshotHash}`);
  }
  const bytes = brotliDecompressSync(row.document_brotli, {
    ...(options.maxUncompressedBytes !== undefined ? { maxOutputLength: options.maxUncompressedBytes } : {}),
  });
  if (bytes.length !== row.uncompressed_bytes) {
    throw new Error(`Snapshot size mismatch: ${snapshotHash}`);
  }
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  if (actualHash !== snapshotHash) throw new Error(`Snapshot hash mismatch: ${snapshotHash}`);
  return bytes.toString("utf8");
}

export function operationHash(operations: unknown): string {
  return hashPayload(operations);
}

export function revisionHash(input: {
  parentRevisionHash: string | null;
  snapshotHash: string;
  operationHash: string;
  metadata: {
    id: string;
    designId: string;
    version: number;
    parentRevisionId: string | null;
    actorId: string;
    message: string | null;
    createdAt: string;
  };
}): string {
  return hashPayload({
    parentRevisionHash: input.parentRevisionHash,
    snapshotHash: input.snapshotHash,
    operationHash: input.operationHash,
    metadata: input.metadata,
  });
}

export function changedNodeIds(baseDocument: unknown, resultDocument: unknown): string[] {
  const baseNodes = isRecord(baseDocument) && isRecord(baseDocument.nodes) ? baseDocument.nodes : {};
  const resultNodes = isRecord(resultDocument) && isRecord(resultDocument.nodes) ? resultDocument.nodes : {};
  const ids = new Set([...Object.keys(baseNodes), ...Object.keys(resultNodes)]);
  return [...ids]
    .filter((id) => canonicalJson(baseNodes[id]) !== canonicalJson(resultNodes[id]))
    .sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
