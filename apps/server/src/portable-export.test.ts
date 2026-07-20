import { createHash } from "node:crypto";

import { unzipSync, zipSync } from "fflate";
import {
  DesignDocumentSchema,
  DesignDocumentV2Schema,
  createSequentialIdFactory,
  createStarterDocument,
  migrateDesignDocumentV1ToV2,
} from "@designer/core";
import { describe, expect, it } from "vitest";

import { canonicalJson } from "./ids.js";
import { createPortableProjectBundle, readPortableProjectBundle } from "./portable-export.js";

function rewriteBundleJson(
  bundle: Buffer,
  entryName: string,
  mutate: (value: Record<string, unknown>) => void,
): Buffer {
  const entries = unzipSync(bundle);
  const entry = entries[entryName];
  if (!entry) throw new Error(`Missing test bundle entry: ${entryName}`);
  const value = JSON.parse(Buffer.from(entry).toString("utf8")) as Record<string, unknown>;
  mutate(value);
  entries[entryName] = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  const payloadNames = Object.keys(entries).filter((name) => name !== "checksums.sha256").sort();
  entries["checksums.sha256"] = Buffer.from(`${payloadNames.map((name) => (
    `${createHash("sha256").update(entries[name]!).digest("hex")}  ${name}`
  )).join("\n")}\n`, "utf8");
  return Buffer.from(zipSync(entries, { level: 6, mtime: new Date("1980-01-01T00:00:00.000Z") }));
}

function endOfCentralDirectoryOffset(bundle: Buffer): number {
  for (let offset = bundle.length - 22; offset >= Math.max(0, bundle.length - 65_557); offset -= 1) {
    if (bundle.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bundle.readUInt16LE(offset + 20) === bundle.length) return offset;
  }
  throw new Error("Missing test EOCD record.");
}

function centralEntryOffset(bundle: Buffer, entryName: string): number {
  const eocd = endOfCentralDirectoryOffset(bundle);
  const count = bundle.readUInt16LE(eocd + 10);
  let cursor = bundle.readUInt32LE(eocd + 16);
  for (let index = 0; index < count; index += 1) {
    if (bundle.readUInt32LE(cursor) !== 0x02014b50) throw new Error("Malformed test central directory.");
    const nameLength = bundle.readUInt16LE(cursor + 28);
    const extraLength = bundle.readUInt16LE(cursor + 30);
    const commentLength = bundle.readUInt16LE(cursor + 32);
    const name = bundle.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    if (name === entryName) return cursor;
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`Missing test central entry: ${entryName}`);
}

function localEntryLayout(bundle: Buffer, entryName: string): {
  centralOffset: number;
  localOffset: number;
  dataOffset: number;
  compressedBytes: number;
} {
  const centralOffset = centralEntryOffset(bundle, entryName);
  const localOffset = bundle.readUInt32LE(centralOffset + 42);
  if (bundle.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("Malformed test local header.");
  const nameLength = bundle.readUInt16LE(localOffset + 26);
  const extraLength = bundle.readUInt16LE(localOffset + 28);
  return {
    centralOffset,
    localOffset,
    dataOffset: localOffset + 30 + nameLength + extraLength,
    compressedBytes: bundle.readUInt32LE(centralOffset + 20),
  };
}

function deterministicNoise(size: number): Buffer {
  const output = Buffer.allocUnsafe(size);
  let state = 0x9e37_79b9;
  for (let index = 0; index < output.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    output[index] = state & 0xff;
  }
  return output;
}

function appendCompressedEntryBytes(bundle: Buffer, entryName: string, trailing: Buffer): Buffer {
  const layout = localEntryLayout(bundle, entryName);
  const eocd = endOfCentralDirectoryOffset(bundle);
  const insertOffset = layout.dataOffset + layout.compressedBytes;
  const output = Buffer.concat([
    bundle.subarray(0, insertOffset),
    trailing,
    bundle.subarray(insertOffset),
  ]);
  const shiftedCentral = layout.centralOffset + trailing.length;
  const shiftedEocd = eocd + trailing.length;
  output.writeUInt32LE(layout.compressedBytes + trailing.length, layout.localOffset + 18);
  output.writeUInt32LE(layout.compressedBytes + trailing.length, shiftedCentral + 20);
  output.writeUInt32LE(bundle.readUInt32LE(eocd + 16) + trailing.length, shiftedEocd + 16);
  return output;
}

function withDataDescriptor(bundle: Buffer, entryName: string, signature: boolean): Buffer {
  const layout = localEntryLayout(bundle, entryName);
  const eocd = endOfCentralDirectoryOffset(bundle);
  const descriptor = Buffer.alloc(signature ? 16 : 12);
  let cursor = 0;
  if (signature) {
    descriptor.writeUInt32LE(0x08074b50, cursor);
    cursor += 4;
  }
  descriptor.writeUInt32LE(bundle.readUInt32LE(layout.centralOffset + 16), cursor);
  descriptor.writeUInt32LE(layout.compressedBytes, cursor + 4);
  descriptor.writeUInt32LE(bundle.readUInt32LE(layout.centralOffset + 24), cursor + 8);
  const insertOffset = layout.dataOffset + layout.compressedBytes;
  const output = Buffer.concat([
    bundle.subarray(0, insertOffset),
    descriptor,
    bundle.subarray(insertOffset),
  ]);
  const shiftedCentral = layout.centralOffset + descriptor.length;
  const shiftedEocd = eocd + descriptor.length;
  output.writeUInt16LE(output.readUInt16LE(layout.localOffset + 6) | 0x0008, layout.localOffset + 6);
  output.fill(0, layout.localOffset + 14, layout.localOffset + 26);
  output.writeUInt16LE(output.readUInt16LE(shiftedCentral + 8) | 0x0008, shiftedCentral + 8);
  output.writeUInt32LE(bundle.readUInt32LE(eocd + 16) + descriptor.length, shiftedEocd + 16);
  return output;
}

describe("portable FormaSpec project bundles", () => {
  it("exports and imports canonical project data with verified assets", () => {
    const document = createStarterDocument({
      name: "Portable project",
      now: "2026-04-01T00:00:00.000Z",
      idFactory: createSequentialIdFactory("portable"),
    });
    const asset = Buffer.from("normalized-raster-fixture");
    const hash = createHash("sha256").update(asset).digest("hex");
    document.assets.asset_portable_00000001 = {
      id: "asset_portable_00000001",
      name: "Portable image",
      kind: "image",
      mime_type: "image/png",
      size_bytes: asset.length,
      storage_key: "asset:asset_portable_00000001",
      sha256: hash,
      width: 1,
      height: 1,
      metadata: {},
    };
    const bundle = createPortableProjectBundle({
      document,
      revisionId: "revision_portable_00000001",
      revisionHash: "a".repeat(64),
      designSystemVersion: 1,
      assets: [{ id: "asset_portable_00000001", mimeType: "image/png", sha256: hash, data: asset }],
      previews: [{ name: "desktop", png: Buffer.from("png-preview") }],
      createdAt: "2026-04-02T00:00:00.000Z",
    });

    const imported = readPortableProjectBundle(bundle);
    expect(DesignDocumentSchema.safeParse(imported.document).success).toBe(true);
    expect(canonicalJson(imported.document)).toBe(canonicalJson(document));
    expect(imported.manifest.documentSchemaVersion).toBe(1);
    expect(imported.manifest.revisionId).toBe("revision_portable_00000001");
    expect(imported.manifest.revisionHash).toBe("a".repeat(64));
    expect(imported.assets["assets/asset_portable_00000001.png"]?.equals(asset)).toBe(true);
    expect(imported.previews["previews/desktop.png"]?.toString()).toBe("png-preview");
  });

  it("round-trips a canonical strict V2 document without projecting away V2-only fields", () => {
    const ids = createSequentialIdFactory("portablev2");
    const source = createStarterDocument({
      name: "Portable V2 project",
      now: "2026-04-01T00:00:00.000Z",
      idFactory: ids,
    });
    const tokenId = ids("token");
    source.tokens[tokenId] = {
      id: tokenId,
      name: "Surface",
      path: "color.surface",
      kind: "color",
      value: "#ffffff",
      archived: false,
      metadata: {},
    };
    const document = migrateDesignDocumentV1ToV2(source, {
      migratedAt: "2026-04-02T00:00:00.000Z",
      sourceRevisionId: "revision_portablev2_00000001",
      sourceSnapshotHash: "c".repeat(64),
      verifiedBackupId: "backup_portablev2_00000001",
    });
    document.pages[0]!.locale = "fa-IR";
    document.pages[0]!.text_direction = "rtl";
    const frameId = document.pages[0]!.children[0]!;
    const frame = document.nodes[frameId]!;
    if (frame.type !== "frame") throw new Error("Expected starter root to be a frame.");
    frame.locale = "fa-IR";
    frame.text_direction = "rtl";
    frame.user_story = "As a buyer, I can review the order in Persian.";
    frame.semantics.role = "navigation";
    document.tokens[tokenId]!.modes = { dark: "#111827", high_contrast: "#000000" };
    document.product_specification.natural_language_brief = "A bilingual checkout that preserves business rules.";
    document.product_specification.summary = "Revision-pinned product context.";
    document.implementation_mappings.target_portablev2_00000001 = {
      id: "target_portablev2_00000001",
      target_type: "screen",
      source_id: frameId,
      platform: "web",
      symbol: "CheckoutPage",
      connection_id: "connection_portablev2_00000001",
      mapping_version: 3,
      notes: "V2-only implementation provenance",
    };
    const canonicalDocument = DesignDocumentV2Schema.parse(document);
    const bundle = createPortableProjectBundle({
      document: canonicalDocument,
      revisionId: "revision_portablev2_00000002",
      revisionHash: "d".repeat(64),
      designSystemVersion: canonicalDocument.design_system.release_version,
      createdAt: "2026-04-03T00:00:00.000Z",
    });

    const imported = readPortableProjectBundle(bundle);
    expect(DesignDocumentV2Schema.safeParse(imported.document).success).toBe(true);
    expect(canonicalJson(imported.document)).toBe(canonicalJson(canonicalDocument));
    expect(imported.manifest).toMatchObject({
      documentSchemaVersion: 2,
      revisionId: "revision_portablev2_00000002",
      revisionHash: "d".repeat(64),
      designSystemVersion: canonicalDocument.design_system.release_version,
    });
    expect(imported.document.schema_version).toBe(2);
    if (imported.document.schema_version !== 2) throw new Error("Expected a V2 portable document.");
    expect(imported.document.pages[0]).toMatchObject({ locale: "fa-IR", text_direction: "rtl" });
    expect(imported.document.nodes[frameId]).toMatchObject({
      user_story: "As a buyer, I can review the order in Persian.",
      semantics: { role: "navigation" },
    });
    expect(imported.document.tokens[tokenId]?.modes).toEqual({ dark: "#111827", high_contrast: "#000000" });
    expect(imported.document.product_specification.summary).toBe("Revision-pinned product context.");
    expect(imported.document.implementation_mappings.target_portablev2_00000001).toMatchObject({
      symbol: "CheckoutPage",
      mapping_version: 3,
    });
    expect(imported.document.migration).toMatchObject({
      source_revision_id: "revision_portablev2_00000001",
      source_snapshot_hash: "c".repeat(64),
      verified_backup_id: "backup_portablev2_00000001",
    });
    expect(imported.productSpecification).toEqual(canonicalDocument.product_specification);
  });

  it("round-trips quarantined V1 assets by metadata without treating unsafe bytes as render-ready", () => {
    const source = createStarterDocument({
      name: "Portable legacy quarantine",
      now: "2026-04-01T00:00:00.000Z",
      idFactory: createSequentialIdFactory("portablelegacy"),
    });
    source.assets.asset_portablelegacy_font0001 = {
      id: "asset_portablelegacy_font0001",
      name: "Company font",
      kind: "font",
      mime_type: "font/woff2",
      size_bytes: 256,
      storage_key: "legacy/fonts/company.woff2",
      sha256: "a".repeat(64),
      metadata: { family: "Company Sans" },
    };
    source.assets.asset_portablelegacy_gif00001 = {
      id: "asset_portablelegacy_gif00001",
      name: "Legacy animation",
      kind: "image",
      mime_type: "image/gif",
      size_bytes: 64,
      storage_key: "legacy/images/animation.gif",
      sha256: "b".repeat(64),
      width: 24,
      height: 24,
      metadata: { animated: true },
    };
    const document = migrateDesignDocumentV1ToV2(DesignDocumentSchema.parse(source), {
      migratedAt: "2026-04-02T00:00:00.000Z",
    });
    const bundle = createPortableProjectBundle({
      document,
      revisionId: "revision_portablelegacy_0001",
      revisionHash: "c".repeat(64),
      designSystemVersion: document.design_system.release_version,
      createdAt: "2026-04-03T00:00:00.000Z",
    });

    const imported = readPortableProjectBundle(bundle);
    expect(canonicalJson(imported.document)).toBe(canonicalJson(document));
    expect(imported.assets).toEqual({});
    expect(imported.manifest.assetHashes).toEqual({});
    expect(imported.manifest.quarantinedAssetIds.sort()).toEqual([
      "asset_portablelegacy_font0001",
      "asset_portablelegacy_gif00001",
    ].sort());
    if (imported.document.schema_version !== 2) throw new Error("Expected strict V2 import.");
    expect(imported.document.assets.asset_portablelegacy_font0001).toMatchObject({
      kind: "font",
      status: "legacy_quarantined",
    });
  });

  it("requires bytes for normalized assets and accepts legacy manifests without a quarantine field", () => {
    const source = createStarterDocument({
      now: "2026-04-01T00:00:00.000Z",
      idFactory: createSequentialIdFactory("portablecompat"),
    });
    const data = Buffer.from("normalized-ready-asset");
    const hash = createHash("sha256").update(data).digest("hex");
    source.assets.asset_portablecompat_0000001 = {
      id: "asset_portablecompat_0000001",
      name: "ready.png",
      kind: "image",
      mime_type: "image/png",
      size_bytes: data.length,
      storage_key: "asset:asset_portablecompat_0000001",
      sha256: hash,
      width: 1,
      height: 1,
      metadata: {},
    };
    expect(() => createPortableProjectBundle({
      document: source,
      revisionId: "revision_portablecompat_0001",
      revisionHash: "d".repeat(64),
      designSystemVersion: 1,
    })).toThrow(/missing one or more normalized/);

    const noAssetDocument = createStarterDocument({
      now: "2026-04-01T00:00:00.000Z",
      idFactory: createSequentialIdFactory("portableold"),
    });
    const currentBundle = createPortableProjectBundle({
      document: noAssetDocument,
      revisionId: "revision_portableold_000001",
      revisionHash: "e".repeat(64),
      designSystemVersion: 1,
    });
    const legacyBundle = rewriteBundleJson(currentBundle, "manifest.json", (manifest) => {
      delete manifest.quarantinedAssetIds;
    });
    expect(readPortableProjectBundle(legacyBundle).manifest.quarantinedAssetIds).toEqual([]);
  });

  it("rejects traversal entries before extraction", () => {
    for (const entryName of ["../outside.txt", "C:/outside.txt", "line\nbreak.txt"]) {
      const malicious = Buffer.from(zipSync({ [entryName]: Buffer.from("bad") }));
      expect(() => readPortableProjectBundle(malicious)).toThrow(/unsafe path/);
    }
  });

  it("streams a compressed entry across bounded chunks and rejects malformed chunked DEFLATE", () => {
    const document = createStarterDocument({
      now: "2026-04-01T00:00:00.000Z",
      idFactory: createSequentialIdFactory("portablechunk"),
    });
    const preview = deterministicNoise(128 * 1024);
    const bundle = createPortableProjectBundle({
      document,
      revisionId: "revision_portablechunk_0001",
      revisionHash: "9".repeat(64),
      designSystemVersion: 1,
      previews: [{ name: "chunked", png: preview }],
    });
    const layout = localEntryLayout(bundle, "previews/chunked.png");
    expect(layout.compressedBytes).toBeGreaterThan(16 * 1024);
    expect(readPortableProjectBundle(bundle).previews["previews/chunked.png"]?.equals(preview)).toBe(true);

    const malformed = Buffer.from(bundle);
    malformed[layout.dataOffset] = (malformed[layout.dataOffset]! & ~0x06) | 0x06;
    expect(() => readPortableProjectBundle(malformed)).toThrow(/compressed stream is malformed/);

    const emptyDeflate = Buffer.from(zipSync({ "payload.bin": Buffer.alloc(0) }, { level: 0 }));
    const emptyLayout = localEntryLayout(emptyDeflate, "payload.bin");
    emptyDeflate.writeUInt16LE(8, emptyLayout.centralOffset + 10);
    emptyDeflate.writeUInt16LE(8, emptyLayout.localOffset + 8);
    expect(() => readPortableProjectBundle(emptyDeflate)).toThrow(/compressed stream is malformed/);

    const trailing = appendCompressedEntryBytes(
      Buffer.from(zipSync({ "payload.bin": Buffer.from("valid DEFLATE followed by hidden bytes") })),
      "payload.bin",
      Buffer.from([0xde, 0xad, 0xbe, 0xef]),
    );
    expect(() => readPortableProjectBundle(trailing)).toThrow(/compressed stream is malformed/);
  });

  it("accepts signed and signatureless data descriptors and rejects descriptor mismatches", () => {
    const source = Buffer.from(zipSync({ "payload.bin": deterministicNoise(48 * 1024) }));
    for (const signature of [true, false]) {
      const descriptorBundle = withDataDescriptor(source, "payload.bin", signature);
      expect(() => readPortableProjectBundle(descriptorBundle)).toThrow(/missing manifest\.json/);
    }

    const mismatched = withDataDescriptor(source, "payload.bin", true);
    const layout = localEntryLayout(mismatched, "payload.bin");
    const descriptorOffset = layout.dataOffset + layout.compressedBytes + 4;
    mismatched.writeUInt32LE(mismatched.readUInt32LE(descriptorOffset) ^ 0xffff_ffff, descriptorOffset);
    expect(() => readPortableProjectBundle(mismatched)).toThrow(/data descriptor does not match/);
  });

  it("rejects encrypted, unsupported, mismatched, symlink, and DOS-directory entries before extraction", () => {
    const document = createStarterDocument({
      now: "2026-04-01T00:00:00.000Z",
      idFactory: createSequentialIdFactory("portableheaders"),
    });
    const bundle = createPortableProjectBundle({
      document,
      revisionId: "revision_portableheaders_0001",
      revisionHash: "8".repeat(64),
      designSystemVersion: 1,
    });
    const layout = localEntryLayout(bundle, "manifest.json");

    const encrypted = Buffer.from(bundle);
    encrypted.writeUInt16LE(encrypted.readUInt16LE(layout.centralOffset + 8) | 0x0001, layout.centralOffset + 8);
    expect(() => readPortableProjectBundle(encrypted)).toThrow(/encrypted/);

    const unsupported = Buffer.from(bundle);
    unsupported.writeUInt16LE(99, layout.centralOffset + 10);
    expect(() => readPortableProjectBundle(unsupported)).toThrow(/unsupported compression method/);

    const underDeclaredVersion = Buffer.from(bundle);
    underDeclaredVersion.writeUInt16LE(10, layout.centralOffset + 6);
    expect(() => readPortableProjectBundle(underDeclaredVersion)).toThrow(/unsupported ZIP feature/);

    const mismatchedName = Buffer.from(bundle);
    mismatchedName[layout.localOffset + 30] = "M".charCodeAt(0);
    expect(() => readPortableProjectBundle(mismatchedName)).toThrow(/local and central entry metadata do not match/);

    const symlink = Buffer.from(bundle);
    symlink.writeUInt16LE((3 << 8) | (symlink.readUInt16LE(layout.centralOffset + 4) & 0xff), layout.centralOffset + 4);
    symlink.writeUInt32LE((0o120777 * 0x1_0000) >>> 0, layout.centralOffset + 38);
    expect(() => readPortableProjectBundle(symlink)).toThrow(/non-regular entry/);

    const directory = Buffer.from(bundle);
    directory.writeUInt32LE(0x10, layout.centralOffset + 38);
    expect(() => readPortableProjectBundle(directory)).toThrow(/non-regular entry/);
  });

  it("rejects duplicate central names, inconsistent counts, and actual ZIP-bomb expansion", () => {
    const document = createStarterDocument({
      now: "2026-04-01T00:00:00.000Z",
      idFactory: createSequentialIdFactory("portablecoverage"),
    });
    const bundle = createPortableProjectBundle({
      document,
      revisionId: "revision_portablecoverage_0001",
      revisionHash: "7".repeat(64),
      designSystemVersion: 1,
    });

    const duplicate = Buffer.from(bundle);
    const documentCentral = centralEntryOffset(duplicate, "document.json");
    duplicate.write("manifest.json", documentCentral + 46, "ascii");
    expect(() => readPortableProjectBundle(duplicate)).toThrow(/duplicate entry/);

    const inconsistentCount = Buffer.from(bundle);
    const eocd = endOfCentralDirectoryOffset(inconsistentCount);
    const count = inconsistentCount.readUInt16LE(eocd + 10);
    inconsistentCount.writeUInt16LE(count - 1, eocd + 8);
    inconsistentCount.writeUInt16LE(count - 1, eocd + 10);
    expect(() => readPortableProjectBundle(inconsistentCount)).toThrow(/entry count is inconsistent/);

    const falseDeclaration = Buffer.from(zipSync({ "payload.bin": Buffer.alloc(1024, 0x61) }));
    const falseLayout = localEntryLayout(falseDeclaration, "payload.bin");
    falseDeclaration.writeUInt32LE(1, falseLayout.centralOffset + 24);
    falseDeclaration.writeUInt32LE(1, falseLayout.localOffset + 22);
    try {
      readPortableProjectBundle(falseDeclaration);
      throw new Error("Expected false expansion metadata to be rejected.");
    } catch (error) {
      expect(error).toMatchObject({ code: "VALIDATION_FAILED", statusCode: 422 });
      expect(error).toHaveProperty("message", expect.stringMatching(/emitted more data than declared/));
    }

    const declaredLimit = 64 * 1024 * 1024;
    const bomb = Buffer.from(zipSync({ "payload.bin": Buffer.alloc(declaredLimit + 1, 0x61) }, { level: 9 }));
    const bombLayout = localEntryLayout(bomb, "payload.bin");
    bomb.writeUInt32LE(declaredLimit, bombLayout.centralOffset + 24);
    bomb.writeUInt32LE(declaredLimit, bombLayout.localOffset + 22);
    try {
      readPortableProjectBundle(bomb);
      throw new Error("Expected actual expansion to be rejected.");
    } catch (error) {
      expect(error).toMatchObject({ code: "PAYLOAD_TOO_LARGE", statusCode: 413 });
      expect(error).toHaveProperty("message", expect.stringMatching(/emitted data beyond|emitted more data/));
    }
  });

  it("rejects collection ID/key mismatches even when the archive checksums are valid", () => {
    const document = createStarterDocument({
      now: "2026-04-01T00:00:00.000Z",
      idFactory: createSequentialIdFactory("mismatch"),
    });
    const validBundle = createPortableProjectBundle({
      document,
      revisionId: "revision_mismatch_00000001",
      revisionHash: "b".repeat(64),
      designSystemVersion: 1,
    });
    const bundle = rewriteBundleJson(validBundle, "document.json", (value) => {
      const nodes = value.nodes as Record<string, Record<string, unknown>>;
      Object.values(nodes)[0]!.id = "node_mismatch_99999999";
    });
    expect(() => readPortableProjectBundle(bundle)).toThrow(/ID\/key mismatch/);
  });

  it("rejects schema-crossing V1 fields and incomplete V2 documents even with valid checksums", () => {
    const source = createStarterDocument({
      now: "2026-04-01T00:00:00.000Z",
      idFactory: createSequentialIdFactory("strictportable"),
    });
    const v1Bundle = createPortableProjectBundle({
      document: source,
      revisionId: "revision_strictportable_00000001",
      revisionHash: "e".repeat(64),
      designSystemVersion: 1,
    });
    const v1WithV2Field = rewriteBundleJson(v1Bundle, "document.json", (value) => {
      value.component_definitions = {};
    });
    expect(() => readPortableProjectBundle(v1WithV2Field)).toThrow(/strict schema/);

    const v2Document = migrateDesignDocumentV1ToV2(source, {
      migratedAt: "2026-04-02T00:00:00.000Z",
    });
    const v2Bundle = createPortableProjectBundle({
      document: v2Document,
      revisionId: "revision_strictportable_00000002",
      revisionHash: "f".repeat(64),
      designSystemVersion: v2Document.design_system.release_version,
    });
    const incompleteV2 = rewriteBundleJson(v2Bundle, "document.json", (value) => {
      delete value.product_specification;
    });
    expect(() => readPortableProjectBundle(incompleteV2)).toThrow(/strict schema/);
  });
});
