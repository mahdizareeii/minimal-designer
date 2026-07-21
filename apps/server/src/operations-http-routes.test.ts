import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { unzipSync, zipSync } from "fflate";
import {
  DesignDocumentV2Schema,
  ProductSpecificationSchema,
  createSequentialIdFactory,
  createStarterDocument,
  migrateDesignDocumentV1ToV2,
} from "@designer/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { loadConfig } from "./config.js";
import { canonicalJson } from "./ids.js";
import { DEFAULT_ORGANIZATION_POLICY } from "./organization-policy-model.js";
import { createPortableProjectBundle, readPortableProjectBundle } from "./portable-export.js";

const applications: DesignerApplication[] = [];
const temporaryDirectories: string[] = [];
const PROXY_SECRET = "proxy-secret-0123456789abcdef0123456789abcdef";

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.promises.rm(directory, { recursive: true, force: true })));
});

async function localApplication(): Promise<DesignerApplication> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "formaspec-operations-http-"));
  temporaryDirectories.push(root);
  const application = await buildApplication(loadConfig({
    APP_MODE: "local",
    HOST: "127.0.0.1",
    PORT: "4310",
    DATA_DIR: path.join(root, "data"),
    BACKUP_DIR: path.join(root, "backups"),
    DESIGNER_DATABASE_PATH: ":memory:",
    PUBLIC_BASE_URL: "http://127.0.0.1:4310",
    AUTH_MODE: "none",
    FORMASPEC_ALLOW_SOFTWARE_RENDERER: "true",
    DESIGNER_LOG_LEVEL: "silent",
  }));
  applications.push(application);
  await application.app.ready();
  return application;
}

async function persistentLocalApplication(root: string): Promise<DesignerApplication> {
  const application = await buildApplication(loadConfig({
    APP_MODE: "local",
    HOST: "127.0.0.1",
    PORT: "4310",
    DATA_DIR: path.join(root, "data"),
    BACKUP_DIR: path.join(root, "backups"),
    DESIGNER_DATABASE_PATH: path.join(root, "data", "designer.sqlite"),
    PUBLIC_BASE_URL: "http://127.0.0.1:4310",
    AUTH_MODE: "none",
    FORMASPEC_ALLOW_SOFTWARE_RENDERER: "true",
    DESIGNER_LOG_LEVEL: "silent",
  }));
  applications.push(application);
  await application.app.ready();
  return application;
}

async function closeTrackedApplication(application: DesignerApplication): Promise<void> {
  const index = applications.indexOf(application);
  if (index >= 0) applications.splice(index, 1);
  await application.app.close();
}

function multipart(filename: string, mimeType: string, data: Buffer): { boundary: string; body: Buffer } {
  const boundary = "----formaspec-operations-test";
  return {
    boundary,
    body: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

function chunkedBody(data: Buffer): Readable {
  const chunks: Buffer[] = [];
  const widths = [1, 3, 7, 31, 257, 4093];
  let offset = 0;
  let index = 0;
  while (offset < data.length) {
    const end = Math.min(data.length, offset + widths[index % widths.length]!);
    chunks.push(data.subarray(offset, end));
    offset = end;
    index += 1;
  }
  return Readable.from(chunks);
}

function rewritePortableJson(
  bundle: Buffer,
  entryName: string,
  mutate: (value: Record<string, unknown>) => void,
): Buffer {
  const entries = unzipSync(bundle);
  const entry = entries[entryName];
  if (!entry) throw new Error(`Missing portable entry: ${entryName}`);
  const value = JSON.parse(Buffer.from(entry).toString("utf8")) as Record<string, unknown>;
  mutate(value);
  entries[entryName] = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  const payloadNames = Object.keys(entries).filter((name) => name !== "checksums.sha256").sort();
  entries["checksums.sha256"] = Buffer.from(`${payloadNames.map((name) => (
    `${createHash("sha256").update(entries[name]!).digest("hex")}  ${name}`
  )).join("\n")}\n`, "utf8");
  return Buffer.from(zipSync(entries, { level: 6, mtime: new Date("1980-01-01T00:00:00.000Z") }));
}

async function createProject(application: DesignerApplication): Promise<{ id: string; version: number }> {
  const response = await application.app.inject({
    method: "POST",
    url: "/api/designs",
    payload: { name: "Portable checkout", preset: "phone", idempotencyKey: "operations-create-project-0001" },
  });
  expect(response.statusCode).toBe(201);
  const body = response.json<{ version: number; document: { id: string } }>();
  return { id: body.document.id, version: body.version };
}

function customPinnedV2Document(
  seed: string,
  pin: { designSystemId: string; releaseId: string; releaseVersion: number },
) {
  const source = createStarterDocument({
    name: `Portable custom pin ${seed}`,
    now: "2026-07-20T00:00:00.000Z",
    idFactory: createSequentialIdFactory(seed),
  });
  const migrated = migrateDesignDocumentV1ToV2(source, {
    migratedAt: "2026-07-20T00:01:00.000Z",
    sourceRevisionId: `revision_${seed}_source0001`,
    sourceSnapshotHash: "a".repeat(64),
    verifiedBackupId: `backup_${seed}_verified0001`,
  });
  return DesignDocumentV2Schema.parse({
    ...migrated,
    design_system: {
      design_system_id: pin.designSystemId,
      release_id: pin.releaseId,
      release_version: pin.releaseVersion,
    },
  });
}

function seedVerifiedMigrationBackup(
  application: DesignerApplication,
  id: string,
  createdAt: string,
): void {
  const verification = {
    valid: true,
    manifest: {
      format: "formaspec-backup",
      formatVersion: 1,
      createdAt,
      databaseSchemaVersion: application.database.schemaVersion(),
    },
    sqliteIntegrity: "ok",
    foreignKeyViolations: 0,
    extractedBytes: 1,
    entryCount: 1,
  };
  application.database.sqlite.prepare(
    `INSERT INTO backup_records
     (id, organization_id, filename, bundle_sha256, status, manifest_json, created_by, created_at, verified_at,
      size_bytes, verification_json, retention_class, completed_at)
     VALUES (?, 'organization_legacy', 'portable-migration-gate.tar', ?, 'valid', ?, 'principal_local', ?, ?, 1, ?, 'manual', ?)`,
  ).run(
    id,
    "a".repeat(64),
    JSON.stringify(verification.manifest),
    createdAt,
    createdAt,
    JSON.stringify(verification),
    createdAt,
  );
}

async function seedManagedBackup(
  application: DesignerApplication,
  index: number,
  retentionClass: "manual" | "daily" | "weekly" | "monthly",
  completedAt: string,
): Promise<{ id: string; filename: string; path: string }> {
  const data = Buffer.from(`managed-backup-${retentionClass}-${index}`);
  const bundleSha256 = createHash("sha256").update(data).digest("hex");
  const id = `backup_${createHash("sha256").update(`${retentionClass}:${index}`).digest("hex").slice(0, 40)}`;
  const filename = `formaspec-backup-${completedAt.replaceAll(/[:.]/g, "-")}.tar`;
  await fs.promises.mkdir(application.config.backupDir, { recursive: true });
  const bundlePath = path.join(application.config.backupDir, filename);
  await fs.promises.writeFile(bundlePath, data);
  application.database.sqlite.prepare(
    `INSERT INTO backup_records
     (id, organization_id, filename, bundle_sha256, status, manifest_json, created_by, created_at, verified_at,
      size_bytes, verification_json, retention_class, completed_at)
     VALUES (?, 'organization_legacy', ?, ?, 'valid', NULL, 'principal_local', ?, ?, ?, NULL, ?, ?)`,
  ).run(id, filename, bundleSha256, completedAt, completedAt, data.length, retentionClass, completedAt);
  return { id, filename, path: bundlePath };
}

describe("operational backup and portable bundle HTTP routes", () => {
  it("accepts a genuinely chunked multipart bundle without buffering the request body", async () => {
    const source = await localApplication();
    const target = await localApplication();
    const project = await createProject(source);
    const exported = await source.app.inject({
      method: "GET",
      url: `/api/designs/${project.id}/export.formaspec.zip?includePreviews=false`,
    });
    expect(exported.statusCode).toBe(200);
    const upload = multipart("chunked.formaspec.zip", "application/zip", exported.rawPayload);
    const originalMkdtemp = fs.promises.mkdtemp.bind(fs.promises);
    const stagedDirectories: string[] = [];
    const mkdtemp = vi.spyOn(fs.promises, "mkdtemp").mockImplementation(async (prefix, options) => {
      const created = await originalMkdtemp(prefix, options as BufferEncoding | { encoding: BufferEncoding } | undefined);
      const createdPath = String(created);
      if (String(prefix).includes("formaspec-portable-imports")) stagedDirectories.push(createdPath);
      return created as never;
    });
    let imported;
    try {
      imported = await target.app.inject({
        method: "POST",
        url: "/api/imports",
        headers: {
          "content-type": `multipart/form-data; boundary=${upload.boundary}`,
          "idempotency-key": "portable-chunked-import-0001",
        },
        payload: chunkedBody(upload.body),
      });
    } finally {
      mkdtemp.mockRestore();
    }
    expect(imported.statusCode).toBe(201);
    expect(imported.json()).toMatchObject({
      bundleSha256: createHash("sha256").update(exported.rawPayload).digest("hex"),
      project: { id: project.id, version: 1 },
    });
    expect(target.service.getDesign("local", project.id).canonicalDocument.id).toBe(project.id);
    expect(stagedDirectories).toEqual([expect.stringContaining("upload-")]);
    await expect(fs.promises.lstat(stagedDirectories[0]!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("exports a strict project bundle, validates it without mutation, and includes the committed product specification", async () => {
    const application = await localApplication();
    const project = await createProject(application);

    const specificationPreview = await application.app.inject({
      method: "POST",
      url: `/api/designs/${project.id}/product-specification/previews`,
      payload: {
        baseVersion: 0,
        naturalLanguageBrief: "A bilingual checkout with guarded refunds and accessible error states.",
      },
    });
    expect(specificationPreview.statusCode).toBe(201);
    const previewId = specificationPreview.json<{ previewId: string }>().previewId;
    const committed = await application.app.inject({
      method: "POST",
      url: `/api/designs/${project.id}/product-specification/previews/${previewId}/commit`,
      payload: {
        expectedBaseVersion: 0,
        idempotencyKey: "operations-product-spec-0001",
        message: "Document checkout rules",
      },
    });
    expect(committed.statusCode).toBe(200);

    const exported = await application.app.inject({
      method: "GET",
      url: `/api/designs/${project.id}/export.formaspec.zip`,
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers["content-type"]).toContain("application/zip");
    expect(exported.headers["x-formaspec-bundle-sha256"]).toMatch(/^[a-f0-9]{64}$/);
    const bundle = readPortableProjectBundle(exported.rawPayload);
    expect(bundle.document).not.toHaveProperty("product_specification");
    expect(bundle.productSpecification).toMatchObject({
      natural_language_brief: "A bilingual checkout with guarded refunds and accessible error states.",
    });
    expect(Object.keys(bundle.previews)).toContain("previews/project-preview.png");

    const upload = multipart("project.formaspec.zip", "application/zip", exported.rawPayload);
    const validated = await application.app.inject({
      method: "POST",
      url: "/api/imports/validate",
      headers: { "content-type": `multipart/form-data; boundary=${upload.boundary}` },
      payload: upload.body,
    });
    expect(validated.statusCode).toBe(200);
    expect(validated.json()).toMatchObject({
      valid: true,
      validationOnly: true,
      mutationsApplied: false,
      project: { id: project.id, schemaVersion: 1 },
    });

    const mutationCounts = Object.fromEntries(["designs", "revisions", "assets", "portable_imports", "idempotency"].map((table) => [
      table,
      (application.database.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
    ]));
    const invalidUpload = multipart("invalid.formaspec.zip", "application/zip", Buffer.from("not-a-zip"));
    const invalid = await application.app.inject({
      method: "POST",
      url: "/api/imports/validate",
      headers: { "content-type": `multipart/form-data; boundary=${invalidUpload.boundary}` },
      payload: invalidUpload.body,
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_FAILED");
    for (const table of ["designs", "revisions", "assets", "portable_imports", "idempotency"]) {
      expect((application.database.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count)
        .toBe(mutationCounts[table]);
    }
  });

  it("imports a conflict-free V1 bundle atomically and persists its external product specification as local version 1", async () => {
    const source = await localApplication();
    const target = await localApplication();
    const project = await createProject(source);
    const specificationPreview = source.enterprise.previewProductSpecification("local", {
      designId: project.id,
      baseVersion: 0,
      naturalLanguageBrief: "Imported product rules must remain attached to the imported design.",
    });
    const sourceSpecification = source.enterprise.commitProductSpecificationPreview("local", {
      designId: project.id,
      previewId: specificationPreview.id,
      expectedBaseVersion: 0,
      idempotencyKey: "portable-import-source-specification",
      message: "Seed portable product context",
    });
    const exported = await source.app.inject({
      method: "GET",
      url: `/api/designs/${project.id}/export.formaspec.zip?includePreviews=false`,
    });
    expect(exported.statusCode).toBe(200);
    const sourceBundle = readPortableProjectBundle(exported.rawPayload);

    const concurrentTarget = await localApplication();
    const concurrentUploads = [
      multipart("source-a.formaspec.zip", "application/zip", exported.rawPayload),
      multipart("source-b.formaspec.zip", "application/zip", exported.rawPayload),
    ];
    const concurrent = await Promise.all(concurrentUploads.map((candidate, index) => concurrentTarget.app.inject({
      method: "POST",
      url: "/api/imports",
      headers: {
        "content-type": `multipart/form-data; boundary=${candidate.boundary}`,
        "idempotency-key": `portable-import-concurrent-000${index + 1}`,
      },
      payload: candidate.body,
    })));
    expect(concurrent.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    expect((concurrentTarget.database.sqlite.prepare("SELECT COUNT(*) AS count FROM designs").get() as { count: number }).count).toBe(1);
    expect((concurrentTarget.database.sqlite.prepare("SELECT COUNT(*) AS count FROM revisions").get() as { count: number }).count).toBe(1);
    expect((concurrentTarget.database.sqlite.prepare("SELECT COUNT(*) AS count FROM portable_imports").get() as { count: number }).count).toBe(1);

    const rollbackTarget = await localApplication();
    rollbackTarget.database.sqlite.exec(`
      CREATE TRIGGER portable_import_product_spec_failure
      BEFORE INSERT ON product_specifications
      BEGIN SELECT RAISE(ABORT, 'injected portable product-spec failure'); END;
    `);
    const rollbackUpload = multipart("source-rollback.formaspec.zip", "application/zip", exported.rawPayload);
    const rolledBack = await rollbackTarget.app.inject({
      method: "POST",
      url: "/api/imports",
      headers: {
        "content-type": `multipart/form-data; boundary=${rollbackUpload.boundary}`,
        "idempotency-key": "portable-import-rollback-0001",
      },
      payload: rollbackUpload.body,
    });
    expect(rolledBack.statusCode).toBe(500);
    for (const table of ["designs", "revisions", "product_specifications", "portable_imports", "idempotency"]) {
      expect((rollbackTarget.database.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count).toBe(0);
    }
    expect((rollbackTarget.database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'portable_import.commit'",
    ).get() as { count: number }).count).toBe(0);
    expect((rollbackTarget.database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM event_outbox WHERE event_type IN ('design.created', 'product_spec.committed')",
    ).get() as { count: number }).count).toBe(0);

    const upload = multipart("source.formaspec.zip", "application/zip", exported.rawPayload);
    const imported = await target.app.inject({
      method: "POST",
      url: "/api/imports",
      headers: {
        "content-type": `multipart/form-data; boundary=${upload.boundary}`,
        "idempotency-key": "portable-import-conflict-free-0001",
      },
      payload: upload.body,
    });
    expect(imported.statusCode).toBe(201);
    const result = imported.json<{
      importId: string;
      bundleSha256: string;
      mode: string;
      source: { revisionId: string; revisionHashClaim: string; productSpecificationVersion: number };
      project: { id: string; version: number; revisionId: string; productSpecificationVersion: number };
      idMapping: Record<string, string>;
      designSystemPin: null;
      diagnostics: Array<{ code: string }>;
    }>();
    expect(result).toMatchObject({
      mode: "conflict_fail",
      source: {
        revisionId: sourceBundle.manifest.revisionId,
        revisionHashClaim: sourceBundle.manifest.revisionHash,
        productSpecificationVersion: sourceSpecification.version,
      },
      project: {
        id: project.id,
        version: 1,
        productSpecificationVersion: 1,
      },
    });
    expect(result.project.revisionId).not.toBe(sourceBundle.manifest.revisionId);
    expect(result.importId).toMatch(/^import_[a-f0-9]{40}$/);
    expect(result.designSystemPin).toBeNull();
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("SOURCE_REVISION_HASH_IS_CLAIMED");
    expect(result.idMapping[project.id]).toBe(project.id);

    const importedDesign = target.service.getDesign("local", project.id);
    expect(importedDesign.revision.version).toBe(1);
    expect(importedDesign.canonicalDocument.revision).toBe(1);
    expect(importedDesign.canonicalDocument.metadata.formaspec_import).toMatchObject({
      mode: "conflict_fail",
      source_revision_id: sourceBundle.manifest.revisionId,
      source_revision_hash_claim: sourceBundle.manifest.revisionHash,
    });
    const importedSpecification = target.enterprise.readProductSpecification("local", project.id);
    expect(importedSpecification).toMatchObject({
      version: 1,
      revisionId: result.project.revisionId,
      specification: {
        version: 1,
        natural_language_brief: "Imported product rules must remain attached to the imported design.",
      },
    });

    const retryUpload = multipart("source.formaspec.zip", "application/zip", exported.rawPayload);
    const retry = await target.app.inject({
      method: "POST",
      url: "/api/imports",
      headers: {
        "content-type": `multipart/form-data; boundary=${retryUpload.boundary}`,
        "idempotency-key": "portable-import-conflict-free-0001",
      },
      payload: retryUpload.body,
    });
    expect(retry.statusCode).toBe(201);
    expect(retry.json()).toEqual(imported.json());
    expect((target.database.sqlite.prepare("SELECT COUNT(*) AS count FROM designs").get() as { count: number }).count).toBe(1);
    expect((target.database.sqlite.prepare("SELECT COUNT(*) AS count FROM revisions").get() as { count: number }).count).toBe(1);
    expect((target.database.sqlite.prepare("SELECT COUNT(*) AS count FROM product_specifications").get() as { count: number }).count).toBe(1);
    expect((target.database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM event_outbox WHERE event_type = 'product_spec.committed'",
    ).get() as { count: number }).count).toBe(1);
    expect((target.database.sqlite.prepare("SELECT COUNT(*) AS count FROM portable_imports").get() as { count: number }).count).toBe(1);
    expect(target.database.sqlite.prepare(
      `SELECT id, mode, bundle_sha256, source_document_id, source_document_revision,
              source_revision_id, source_revision_hash_claim, target_design_id, target_revision_id, created_by
       FROM portable_imports WHERE id = ?`,
    ).get(result.importId)).toMatchObject({
      id: result.importId,
      mode: "conflict_fail",
      bundle_sha256: result.bundleSha256,
      source_document_id: project.id,
      source_document_revision: sourceBundle.document.revision,
      source_revision_id: sourceBundle.manifest.revisionId,
      source_revision_hash_claim: sourceBundle.manifest.revisionHash,
      target_design_id: project.id,
      target_revision_id: result.project.revisionId,
      created_by: "principal_local",
    });
    expect(() => target.database.sqlite.prepare(
      "UPDATE portable_imports SET mode = 'clone' WHERE id = ?",
    ).run(result.importId)).toThrow(/portable imports are immutable/);
  });

  it("replays the exact portable import response after a database restart", async () => {
    const source = await localApplication();
    const project = await createProject(source);
    const exported = await source.app.inject({
      method: "GET",
      url: `/api/designs/${project.id}/export.formaspec.zip?includePreviews=false`,
    });
    expect(exported.statusCode).toBe(200);
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "formaspec-portable-restart-"));
    temporaryDirectories.push(root);
    let target = await persistentLocalApplication(root);
    const firstUpload = multipart("restart.formaspec.zip", "application/zip", exported.rawPayload);
    const first = await target.app.inject({
      method: "POST",
      url: "/api/imports",
      headers: {
        "content-type": `multipart/form-data; boundary=${firstUpload.boundary}`,
        "idempotency-key": "portable-import-restart-0001",
      },
      payload: firstUpload.body,
    });
    expect(first.statusCode).toBe(201);
    const firstResult = first.json();
    await closeTrackedApplication(target);

    target = await persistentLocalApplication(root);
    const retryUpload = multipart("restart.formaspec.zip", "application/zip", exported.rawPayload);
    const retry = await target.app.inject({
      method: "POST",
      url: "/api/imports",
      headers: {
        "content-type": `multipart/form-data; boundary=${retryUpload.boundary}`,
        "idempotency-key": "portable-import-restart-0001",
      },
      payload: retryUpload.body,
    });
    expect(retry.statusCode).toBe(201);
    expect(retry.json()).toEqual(firstResult);
    expect(target.database.sqlite.prepare("SELECT COUNT(*) AS count FROM designs").get()).toEqual({ count: 1 });
    expect(target.database.sqlite.prepare("SELECT COUNT(*) AS count FROM revisions").get()).toEqual({ count: 1 });
    expect(target.database.sqlite.prepare("SELECT COUNT(*) AS count FROM portable_imports").get()).toEqual({ count: 1 });
  });

  it("uses deterministic clone remapping, rejects default ID conflicts atomically, and scopes idempotency to the exact mode", async () => {
    const application = await localApplication();
    const project = await createProject(application);
    const initialDocument = application.service.getDesign("local", project.id).canonicalDocument;
    const literalNodeId = initialDocument.pages[0]!.children[0]!;
    application.service.applyRevision("local", project.id, {
      baseVersion: 1,
      operations: [{
        type: "set_metadata",
        target: { kind: "document" },
        metadata: {
          literal_reference_example: literalNodeId,
          organization_design_system: "system_formaspec_foundation",
        },
      }],
      idempotencyKey: "portable-clone-source-metadata",
      message: "Preserve arbitrary metadata during clone remapping",
    });
    const specificationPreview = application.enterprise.previewProductSpecification("local", {
      designId: project.id,
      baseVersion: 0,
      naturalLanguageBrief: "Clone every project-scoped reference without changing organization-global pins.",
    });
    application.enterprise.commitProductSpecificationPreview("local", {
      designId: project.id,
      previewId: specificationPreview.id,
      expectedBaseVersion: 0,
      idempotencyKey: "portable-clone-source-specification",
    });
    const exported = await application.app.inject({
      method: "GET",
      url: `/api/designs/${project.id}/export.formaspec.zip?includePreviews=false`,
    });
    expect(exported.statusCode).toBe(200);

    const conflictUpload = multipart("source.formaspec.zip", "application/zip", exported.rawPayload);
    const designsBeforeConflict = (application.database.sqlite.prepare("SELECT COUNT(*) AS count FROM designs").get() as { count: number }).count;
    const conflict = await application.app.inject({
      method: "POST",
      url: "/api/imports",
      headers: {
        "content-type": `multipart/form-data; boundary=${conflictUpload.boundary}`,
        "idempotency-key": "portable-import-conflict-0001",
      },
      payload: conflictUpload.body,
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json<{ error: { code: string } }>().error.code).toBe("VERSION_CONFLICT");
    expect((application.database.sqlite.prepare("SELECT COUNT(*) AS count FROM designs").get() as { count: number }).count).toBe(designsBeforeConflict);
    expect((application.database.sqlite.prepare("SELECT COUNT(*) AS count FROM portable_imports").get() as { count: number }).count).toBe(0);

    const cloneUpload = multipart("source.formaspec.zip", "application/zip", exported.rawPayload);
    const cloned = await application.app.inject({
      method: "POST",
      url: "/api/imports?mode=clone",
      headers: {
        "content-type": `multipart/form-data; boundary=${cloneUpload.boundary}`,
        "idempotency-key": "portable-import-clone-0001",
      },
      payload: cloneUpload.body,
    });
    expect(cloned.statusCode).toBe(201);
    const clone = cloned.json<{
      project: { id: string; revisionId: string };
      idMapping: Record<string, string>;
    }>();
    expect(clone.project.id).not.toBe(project.id);
    expect(clone.idMapping[project.id]).toBe(clone.project.id);
    expect(Object.entries(clone.idMapping).every(([sourceId, targetId]) => sourceId !== targetId)).toBe(true);
    const sourceDocument = application.service.getDesign("local", project.id).canonicalDocument;
    const clonedDocument = application.service.getDesign("local", clone.project.id).canonicalDocument;
    expect(clonedDocument.pages[0]?.id).toBe(clone.idMapping[sourceDocument.pages[0]!.id]);
    expect(Object.keys(clonedDocument.nodes).sort()).toEqual(
      Object.keys(sourceDocument.nodes).map((nodeId) => clone.idMapping[nodeId]!).sort(),
    );
    expect(clonedDocument.metadata).toMatchObject({
      literal_reference_example: literalNodeId,
      organization_design_system: "system_formaspec_foundation",
    });
    const clonedSpecification = application.enterprise.readProductSpecification("local", clone.project.id);
    expect(clonedSpecification).toMatchObject({
      version: 1,
      revisionId: clone.project.revisionId,
      specification: {
        id: clone.idMapping[sourceDocument.schema_version === 2
          ? sourceDocument.product_specification.id
          : application.enterprise.readProductSpecification("local", project.id).specification.id],
        version: 1,
      },
    });

    const retryUpload = multipart("source.formaspec.zip", "application/zip", exported.rawPayload);
    const retry = await application.app.inject({
      method: "POST",
      url: "/api/imports?mode=clone",
      headers: {
        "content-type": `multipart/form-data; boundary=${retryUpload.boundary}`,
        "idempotency-key": "portable-import-clone-0001",
      },
      payload: retryUpload.body,
    });
    expect(retry.statusCode).toBe(201);
    expect(retry.json()).toEqual(cloned.json());

    const mismatchedModeUpload = multipart("source.formaspec.zip", "application/zip", exported.rawPayload);
    const mismatchedMode = await application.app.inject({
      method: "POST",
      url: "/api/imports",
      headers: {
        "content-type": `multipart/form-data; boundary=${mismatchedModeUpload.boundary}`,
        "idempotency-key": "portable-import-clone-0001",
      },
      payload: mismatchedModeUpload.body,
    });
    expect(mismatchedMode.statusCode).toBe(409);
    expect(mismatchedMode.json<{ error: { code: string } }>().error.code).toBe("IDEMPOTENCY_CONFLICT");

    const secondCloneUpload = multipart("source.formaspec.zip", "application/zip", exported.rawPayload);
    const secondClone = await application.app.inject({
      method: "POST",
      url: "/api/imports?mode=clone",
      headers: {
        "content-type": `multipart/form-data; boundary=${secondCloneUpload.boundary}`,
        "idempotency-key": "portable-import-clone-0002",
      },
      payload: secondCloneUpload.body,
    });
    expect(secondClone.statusCode).toBe(201);
    expect(secondClone.json<{ project: { id: string } }>().project.id).not.toBe(clone.project.id);
  });

  it("remaps typed V2 specification and implementation references without rewriting metadata or organization-global IDs", async () => {
    const application = await localApplication();
    const source = createStarterDocument({
      name: "Typed V2 clone",
      now: "2026-07-20T00:00:00.000Z",
      idFactory: createSequentialIdFactory("portabletypedv2"),
    });
    const rootNodeId = source.pages[0]!.children[0]!;
    const document = migrateDesignDocumentV1ToV2(source, {
      migratedAt: "2026-07-20T00:01:00.000Z",
      sourceRevisionId: "revision_portabletypedv2_0001",
      sourceSnapshotHash: "a".repeat(64),
      verifiedBackupId: "backup_portabletypedv2_0001",
    });
    const audienceId = "audience_portabletypedv2_0001";
    const roleId = "role_portabletypedv2_000001";
    const stateId = "state_portabletypedv2_00001";
    const flowId = "flow_portabletypedv2_000001";
    const stepId = "step_portabletypedv2_000001";
    const ruleId = "rule_portabletypedv2_000001";
    const criterionId = "criterion_portabletypedv2_0001";
    document.product_specification = ProductSpecificationSchema.parse({
      id: "spec_portabletypedv2_000001",
      version: 4,
      natural_language_brief: "Keep typed links valid when cloning this portable V2 project.",
      audiences: [{ id: audienceId, title: "Buyer", description: "Places an order", links: {}, needs: [] }],
      roles: [{ id: roleId, title: "Buyer", description: "Checkout actor", links: {}, audience_ids: [audienceId], capabilities: [] }],
      screen_states: [{ id: stateId, title: "Review", description: "Review order", links: { node_ids: [rootNodeId] }, state: "default" }],
      flows: [{
        id: flowId,
        title: "Checkout",
        description: "Review and submit",
        links: { node_ids: [rootNodeId] },
        role_ids: [roleId],
        steps: [{ id: stepId, title: "Review", actor_role_id: roleId, screen_state_id: stateId, conditions: [] }],
      }],
      business_rules: [{
        id: ruleId,
        title: "Confirm total",
        description: "The buyer confirms the final total.",
        links: { node_ids: [rootNodeId] },
        conditions: [],
        outcomes: ["Show confirmation"],
        priority: "critical",
      }],
      acceptance_criteria: [{
        id: criterionId,
        title: "Total remains visible",
        description: "The final total is visible before submit.",
        links: { node_ids: [rootNodeId], implementation_target_ids: ["target_portabletypedv2_0001"] },
        given: ["A cart exists"],
        when: ["The buyer reviews checkout"],
        then: ["The total is visible"],
      }],
    });
    const root = document.nodes[rootNodeId]!;
    root.semantics.business_rule_ids = [ruleId];
    root.semantics.acceptance_criterion_ids = [criterionId];
    document.implementation_mappings.target_portabletypedv2_0001 = {
      id: "target_portabletypedv2_0001",
      target_type: "screen",
      source_id: rootNodeId,
      platform: "web",
      symbol: "CheckoutPage",
      connection_id: "connection_externalworkspace_0001",
      mapping_version: 2,
    };
    document.metadata = {
      literal_reference_example: rootNodeId,
      implementation_connection: "connection_externalworkspace_0001",
    };
    const canonical = DesignDocumentV2Schema.parse(document);
    const bundle = createPortableProjectBundle({
      document: canonical,
      revisionId: "revision_portabletypedv2_0002",
      revisionHash: "b".repeat(64),
      designSystemVersion: canonical.design_system.release_version,
    });
    const mismatchedBundle = rewritePortableJson(bundle, "product-spec.json", (specification) => {
      specification.natural_language_brief = "A mismatched sidecar must never become a second mutation source.";
    });
    const mismatchUpload = multipart("typed-v2-mismatch.formaspec.zip", "application/zip", mismatchedBundle);
    const mismatch = await application.app.inject({
      method: "POST",
      url: "/api/imports?mode=clone",
      headers: {
        "content-type": `multipart/form-data; boundary=${mismatchUpload.boundary}`,
        "idempotency-key": "portable-typed-v2-mismatch-0001",
      },
      payload: mismatchUpload.body,
    });
    expect(mismatch.statusCode).toBe(422);
    expect(mismatch.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_FAILED");
    expect(application.database.sqlite.prepare("SELECT COUNT(*) AS count FROM designs").get()).toEqual({ count: 0 });
    expect(application.database.sqlite.prepare("SELECT COUNT(*) AS count FROM portable_imports").get()).toEqual({ count: 0 });

    const upload = multipart("typed-v2.formaspec.zip", "application/zip", bundle);
    const imported = await application.app.inject({
      method: "POST",
      url: "/api/imports?mode=clone",
      headers: {
        "content-type": `multipart/form-data; boundary=${upload.boundary}`,
        "idempotency-key": "portable-typed-v2-clone-0001",
      },
      payload: upload.body,
    });
    expect(imported.statusCode, imported.body).toBe(201);
    const result = imported.json<{
      project: { id: string };
      idMapping: Record<string, string>;
      designSystemPin: {
        designSystemId: string;
        releaseId: string;
        releaseVersion: number;
        source: string;
      };
    }>();
    expect(result.designSystemPin).toEqual({
      designSystemId: "system_formaspec_foundation",
      releaseId: "release_formaspec_foundation_1",
      releaseVersion: 1,
      source: "formaspec_foundation_default",
    });
    const cloned = application.service.getDesign("local", result.project.id).canonicalDocument;
    expect(cloned.schema_version).toBe(2);
    if (cloned.schema_version !== 2) throw new Error("Expected a strict V2 clone.");
    const clonedRootId = result.idMapping[rootNodeId]!;
    const clonedRoot = cloned.nodes[clonedRootId]!;
    expect(cloned.design_system).toEqual(canonical.design_system);
    expect(cloned.metadata).toMatchObject(canonical.metadata);
    expect(cloned.product_specification).toMatchObject({
      id: result.idMapping[canonical.product_specification.id],
      version: 1,
      audiences: [{ id: result.idMapping[audienceId] }],
      roles: [{ id: result.idMapping[roleId], audience_ids: [result.idMapping[audienceId]] }],
      screen_states: [{ id: result.idMapping[stateId], links: { node_ids: [clonedRootId] } }],
      flows: [{
        id: result.idMapping[flowId],
        role_ids: [result.idMapping[roleId]],
        steps: [{
          id: result.idMapping[stepId],
          actor_role_id: result.idMapping[roleId],
          screen_state_id: result.idMapping[stateId],
        }],
      }],
      business_rules: [{ id: result.idMapping[ruleId], links: { node_ids: [clonedRootId] } }],
      acceptance_criteria: [{
        id: result.idMapping[criterionId],
        links: { implementation_target_ids: [result.idMapping.target_portabletypedv2_0001] },
      }],
    });
    expect(clonedRoot.semantics).toMatchObject({
      business_rule_ids: [result.idMapping[ruleId]],
      acceptance_criterion_ids: [result.idMapping[criterionId]],
    });
    expect(cloned.implementation_mappings[result.idMapping.target_portabletypedv2_0001!]).toMatchObject({
      id: result.idMapping.target_portabletypedv2_0001,
      source_id: clonedRootId,
      connection_id: "connection_externalworkspace_0001",
    });
    expect(cloned.migration?.compatibility?.frame_roles).toHaveProperty(clonedRootId);
    expect(cloned.migration).toMatchObject({
      source_revision_id: "revision_portabletypedv2_0001",
      verified_backup_id: "backup_portabletypedv2_0001",
    });
    expect(application.database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM project_design_system_pins WHERE design_id = ?",
    ).get(result.project.id)).toEqual({ count: 0 });
  });

  it("binds custom V2 portable imports to an exact local published release atomically", async () => {
    const application = await localApplication();
    const system = application.designSystems.createDesignSystem("local", { name: "Portable company system" });
    const release = application.designSystems.createRelease("local", system.id, {
      expectedLatestVersion: 0,
      name: "Portable release 1",
      status: "published",
      tokenVersions: [],
      componentVersions: [],
    });
    const document = customPinnedV2Document("portablecustompin", {
      designSystemId: system.id,
      releaseId: release.id,
      releaseVersion: release.version,
    });
    const bundle = createPortableProjectBundle({
      document,
      revisionId: "revision_portablecustompin_0001",
      revisionHash: "c".repeat(64),
      designSystemVersion: release.version,
    });
    const upload = multipart("custom-pin.formaspec.zip", "application/zip", bundle);
    const imported = await application.app.inject({
      method: "POST",
      url: "/api/imports",
      headers: {
        "content-type": `multipart/form-data; boundary=${upload.boundary}`,
        "idempotency-key": "portable-custom-pin-import-0001",
      },
      payload: upload.body,
    });
    expect(imported.statusCode, imported.body).toBe(201);
    const result = imported.json<{
      project: { id: string };
      designSystemPin: {
        designSystemId: string;
        releaseId: string;
        releaseVersion: number;
        source: string;
      };
    }>();
    expect(result.designSystemPin).toEqual({
      designSystemId: system.id,
      releaseId: release.id,
      releaseVersion: release.version,
      source: "project_design_system_pins",
    });
    expect(application.database.sqlite.prepare(
      `SELECT design_id, organization_id, design_system_id, release_id, release_version, pinned_by
       FROM project_design_system_pins WHERE design_id = ?`,
    ).get(result.project.id)).toEqual({
      design_id: result.project.id,
      organization_id: "organization_legacy",
      design_system_id: system.id,
      release_id: release.id,
      release_version: release.version,
      pinned_by: "principal_local",
    });
    expect(application.service.getDesign("local", result.project.id).canonicalDocument).toMatchObject({
      schema_version: 2,
      design_system: {
        design_system_id: system.id,
        release_id: release.id,
        release_version: release.version,
      },
    });
    const storedAudit = application.database.sqlite.prepare(
      "SELECT details_json FROM audit_events WHERE action = 'portable_import.commit' ORDER BY id DESC LIMIT 1",
    ).get() as { details_json: string };
    expect(JSON.parse(storedAudit.details_json)).toMatchObject({
      designSystemPin: {
        designSystemId: system.id,
        releaseId: release.id,
        releaseVersion: release.version,
        source: "project_design_system_pins",
      },
    });

    const retryUpload = multipart("custom-pin.formaspec.zip", "application/zip", bundle);
    const retry = await application.app.inject({
      method: "POST",
      url: "/api/imports",
      headers: {
        "content-type": `multipart/form-data; boundary=${retryUpload.boundary}`,
        "idempotency-key": "portable-custom-pin-import-0001",
      },
      payload: retryUpload.body,
    });
    expect(retry.statusCode).toBe(201);
    expect(retry.json()).toEqual(imported.json());
    expect(application.database.sqlite.prepare("SELECT COUNT(*) AS count FROM project_design_system_pins").get())
      .toEqual({ count: 1 });

    const rollback = await localApplication();
    const rollbackSystem = rollback.designSystems.createDesignSystem("local", { name: "Rollback system" });
    const rollbackRelease = rollback.designSystems.createRelease("local", rollbackSystem.id, {
      expectedLatestVersion: 0,
      name: "Rollback release",
      status: "published",
      tokenVersions: [],
      componentVersions: [],
    });
    const rollbackDocument = customPinnedV2Document("portablepinrollback", {
      designSystemId: rollbackSystem.id,
      releaseId: rollbackRelease.id,
      releaseVersion: rollbackRelease.version,
    });
    const rollbackBundle = createPortableProjectBundle({
      document: rollbackDocument,
      revisionId: "revision_portablepinrollback_0001",
      revisionHash: "d".repeat(64),
      designSystemVersion: rollbackRelease.version,
    });
    rollback.database.sqlite.exec(`
      CREATE TRIGGER portable_import_pin_failure
      BEFORE INSERT ON project_design_system_pins
      BEGIN SELECT RAISE(ABORT, 'injected portable pin failure'); END;
    `);
    const rollbackUpload = multipart("custom-pin-rollback.formaspec.zip", "application/zip", rollbackBundle);
    const rolledBack = await rollback.app.inject({
      method: "POST",
      url: "/api/imports",
      headers: {
        "content-type": `multipart/form-data; boundary=${rollbackUpload.boundary}`,
        "idempotency-key": "portable-custom-pin-rollback-0001",
      },
      payload: rollbackUpload.body,
    });
    expect(rolledBack.statusCode).toBe(500);
    for (const table of ["designs", "revisions", "project_design_system_pins", "portable_imports", "idempotency"]) {
      expect(rollback.database.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
    expect(rollback.database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'portable_import.commit'",
    ).get()).toEqual({ count: 0 });
  });

  it("rejects unavailable, mismatched, draft, and archived custom V2 portable release pins without project mutation", async () => {
    const application = await localApplication();
    const system = application.designSystems.createDesignSystem("local", { name: "Portable validation system" });
    const published = application.designSystems.createRelease("local", system.id, {
      expectedLatestVersion: 0,
      name: "Published release",
      status: "published",
      tokenVersions: [],
      componentVersions: [],
    });
    const draft = application.designSystems.createRelease("local", system.id, {
      expectedLatestVersion: 1,
      name: "Draft release",
      status: "draft",
      tokenVersions: [],
      componentVersions: [],
    });
    const cases = [
      {
        seed: "portablepinmissing",
        releaseId: "release_portablepinmissing_0001",
        releaseVersion: 1,
      },
      {
        seed: "portablepinversion",
        releaseId: published.id,
        releaseVersion: published.version + 1,
      },
      {
        seed: "portablepindraft",
        releaseId: draft.id,
        releaseVersion: draft.version,
      },
    ];
    for (const [index, candidate] of cases.entries()) {
      const document = customPinnedV2Document(candidate.seed, {
        designSystemId: system.id,
        releaseId: candidate.releaseId,
        releaseVersion: candidate.releaseVersion,
      });
      const bundle = createPortableProjectBundle({
        document,
        revisionId: `revision_${candidate.seed}_0001`,
        revisionHash: String(index + 1).repeat(64),
        designSystemVersion: candidate.releaseVersion,
      });
      const upload = multipart(`${candidate.seed}.formaspec.zip`, "application/zip", bundle);
      const rejected = await application.app.inject({
        method: "POST",
        url: "/api/imports",
        headers: {
          "content-type": `multipart/form-data; boundary=${upload.boundary}`,
          "idempotency-key": `portable-invalid-custom-pin-000${index + 1}`,
        },
        payload: upload.body,
      });
      expect(rejected.statusCode, rejected.body).toBe(422);
      expect(rejected.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_FAILED");
    }
    expect(application.database.sqlite.prepare("SELECT COUNT(*) AS count FROM designs").get()).toEqual({ count: 0 });
    expect(application.database.sqlite.prepare("SELECT COUNT(*) AS count FROM revisions").get()).toEqual({ count: 0 });
    expect(application.database.sqlite.prepare("SELECT COUNT(*) AS count FROM project_design_system_pins").get())
      .toEqual({ count: 0 });
    expect(application.database.sqlite.prepare("SELECT COUNT(*) AS count FROM portable_imports").get()).toEqual({ count: 0 });
    expect(application.database.sqlite.prepare("SELECT COUNT(*) AS count FROM idempotency").get()).toEqual({ count: 0 });

    application.designSystems.updateDesignSystem("local", system.id, {
      expectedUpdatedAt: application.designSystems.readDesignSystem("local", system.id).updatedAt,
      status: "archived",
    });
    const archivedDocument = customPinnedV2Document("portablepinarchived", {
      designSystemId: system.id,
      releaseId: published.id,
      releaseVersion: published.version,
    });
    const archivedBundle = createPortableProjectBundle({
      document: archivedDocument,
      revisionId: "revision_portablepinarchived_0001",
      revisionHash: "e".repeat(64),
      designSystemVersion: published.version,
    });
    const archivedUpload = multipart("archived-pin.formaspec.zip", "application/zip", archivedBundle);
    const archived = await application.app.inject({
      method: "POST",
      url: "/api/imports",
      headers: {
        "content-type": `multipart/form-data; boundary=${archivedUpload.boundary}`,
        "idempotency-key": "portable-invalid-archived-pin-0001",
      },
      payload: archivedUpload.body,
    });
    expect(archived.statusCode, archived.body).toBe(422);
    expect(application.database.sqlite.prepare("SELECT COUNT(*) AS count FROM designs").get()).toEqual({ count: 0 });
  });

  it("fully decodes and normalizes portable assets before any project mutation", async () => {
    const application = await localApplication();
    const source = createStarterDocument({
      name: "Portable image project",
      now: "2026-07-20T00:00:00.000Z",
      idFactory: createSequentialIdFactory("portableimportasset"),
    });
    const assetId = "asset_portableimportasset_0001";
    const invalidBytes = Buffer.from("not a decoded PNG");
    const invalidHash = createHash("sha256").update(invalidBytes).digest("hex");
    source.assets[assetId] = {
      id: assetId,
      name: "Unsafe image",
      kind: "image",
      mime_type: "image/png",
      size_bytes: invalidBytes.length,
      storage_key: `asset:${assetId}`,
      sha256: invalidHash,
      width: 1,
      height: 1,
      metadata: {},
    };
    const invalidBundle = createPortableProjectBundle({
      document: source,
      revisionId: "revision_portableimportasset_0001",
      revisionHash: "a".repeat(64),
      designSystemVersion: 1,
      assets: [{ id: assetId, mimeType: "image/png", sha256: invalidHash, data: invalidBytes }],
    });
    const invalidUpload = multipart("invalid-asset.formaspec.zip", "application/zip", invalidBundle);
    const rejected = await application.app.inject({
      method: "POST",
      url: "/api/imports",
      headers: {
        "content-type": `multipart/form-data; boundary=${invalidUpload.boundary}`,
        "idempotency-key": "portable-invalid-asset-0001",
      },
      payload: invalidUpload.body,
    });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json<{ error: { code: string } }>().error.code).toBe("UNSUPPORTED_ASSET");
    expect((application.database.sqlite.prepare("SELECT COUNT(*) AS count FROM designs").get() as { count: number }).count).toBe(0);
    expect((application.database.sqlite.prepare("SELECT COUNT(*) AS count FROM revisions").get() as { count: number }).count).toBe(0);
    expect((application.database.sqlite.prepare("SELECT COUNT(*) AS count FROM assets").get() as { count: number }).count).toBe(0);
    expect((application.database.sqlite.prepare("SELECT COUNT(*) AS count FROM portable_imports").get() as { count: number }).count).toBe(0);

    const validBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=",
      "base64",
    );
    const validHash = createHash("sha256").update(validBytes).digest("hex");
    source.assets[assetId] = {
      ...source.assets[assetId]!,
      name: "Imported company mark.webp",
      size_bytes: validBytes.length,
      sha256: validHash,
    };
    const validBundle = createPortableProjectBundle({
      document: source,
      revisionId: "revision_portableimportasset_0002",
      revisionHash: "b".repeat(64),
      designSystemVersion: 1,
      assets: [{ id: assetId, mimeType: "image/png", sha256: validHash, data: validBytes }],
    });
    const collisionTarget = await localApplication();
    collisionTarget.database.sqlite.prepare(
      `INSERT INTO assets
       (id, actor_id, design_id, filename, mime_type, size_bytes, width, height, sha256, data, created_at, organization_id)
       VALUES (?, 'local', NULL, 'existing.png', 'image/png', ?, 1, 1, ?, ?, ?, 'organization_legacy')`,
    ).run(assetId, validBytes.length, validHash, validBytes, "2026-07-20T00:00:00.000Z");
    const collisionUpload = multipart("asset-conflict.formaspec.zip", "application/zip", validBundle);
    const assetConflict = await collisionTarget.app.inject({
      method: "POST",
      url: "/api/imports",
      headers: {
        "content-type": `multipart/form-data; boundary=${collisionUpload.boundary}`,
        "idempotency-key": "portable-asset-conflict-0001",
      },
      payload: collisionUpload.body,
    });
    expect(assetConflict.statusCode).toBe(409);
    expect(assetConflict.json<{ error: { code: string; details: { conflictingAssetIds: string[] } } }>().error).toMatchObject({
      code: "VERSION_CONFLICT",
      details: { conflictingAssetIds: [assetId] },
    });
    expect((collisionTarget.database.sqlite.prepare("SELECT COUNT(*) AS count FROM designs").get() as { count: number }).count).toBe(0);
    expect((collisionTarget.database.sqlite.prepare("SELECT COUNT(*) AS count FROM revisions").get() as { count: number }).count).toBe(0);
    expect((collisionTarget.database.sqlite.prepare("SELECT COUNT(*) AS count FROM portable_imports").get() as { count: number }).count).toBe(0);

    const validUpload = multipart("valid-asset.formaspec.zip", "application/zip", validBundle);
    const accepted = await application.app.inject({
      method: "POST",
      url: "/api/imports",
      headers: {
        "content-type": `multipart/form-data; boundary=${validUpload.boundary}`,
        "idempotency-key": "portable-valid-asset-0001",
      },
      payload: validUpload.body,
    });
    expect(accepted.statusCode, accepted.body).toBe(201);
    expect(accepted.json()).toMatchObject({ project: { id: source.id, version: 1, assetCount: 1 } });
    const importedDocument = application.service.getDesign("local", source.id).canonicalDocument;
    const importedAssetMetadata = importedDocument.assets[assetId]!;
    expect(importedAssetMetadata).toMatchObject({
      id: assetId,
      mime_type: "image/png",
      storage_key: `asset:${assetId}`,
      width: 1,
      height: 1,
    });
    const storedAsset = application.service.getAsset("local", assetId);
    expect(storedAsset).toMatchObject({
      id: assetId,
      designId: source.id,
      filename: "Imported company mark.png",
      mimeType: "image/png",
      width: 1,
      height: 1,
      sha256: importedAssetMetadata.sha256,
    });
    expect(createHash("sha256").update(storedAsset.data).digest("hex")).toBe(importedAssetMetadata.sha256);
  });

  it("uses the organization preview default while allowing an explicit portable-export override", async () => {
    const application = await localApplication();
    const project = await createProject(application);
    const current = application.policies.read("local");
    const policy = structuredClone(DEFAULT_ORGANIZATION_POLICY);
    policy.exports.includePreviewsByDefault = false;
    application.policies.update("local", { expectedConfigurationHash: current.configurationHash, policy });

    const withoutPreview = await application.app.inject({
      method: "GET",
      url: `/api/designs/${project.id}/export.formaspec.zip`,
    });
    expect(withoutPreview.statusCode).toBe(200);
    expect(Object.keys(readPortableProjectBundle(withoutPreview.rawPayload).previews)).toEqual([]);

    const withPreview = await application.app.inject({
      method: "GET",
      url: `/api/designs/${project.id}/export.formaspec.zip?includePreviews=true`,
    });
    expect(withPreview.statusCode).toBe(200);
    expect(Object.keys(readPortableProjectBundle(withPreview.rawPayload).previews)).toEqual([
      "previews/project-preview.png",
    ]);
  });

  it("applies the organization portable-bundle policy to export, validation, and mutation", async () => {
    const application = await localApplication();
    const project = await createProject(application);
    const exported = await application.app.inject({
      method: "GET",
      url: `/api/designs/${project.id}/export.formaspec.zip?includePreviews=false`,
    });
    expect(exported.statusCode).toBe(200);
    const current = application.policies.read("local");
    const policy = structuredClone(DEFAULT_ORGANIZATION_POLICY);
    policy.exports.allowPortableBundles = false;
    application.policies.update("local", { expectedConfigurationHash: current.configurationHash, policy });

    const blockedExport = await application.app.inject({
      method: "GET",
      url: `/api/designs/${project.id}/export.formaspec.zip`,
    });
    expect(blockedExport.statusCode).toBe(403);
    const validationUpload = multipart("blocked.formaspec.zip", "application/zip", exported.rawPayload);
    const blockedValidation = await application.app.inject({
      method: "POST",
      url: "/api/imports/validate",
      headers: { "content-type": `multipart/form-data; boundary=${validationUpload.boundary}` },
      payload: validationUpload.body,
    });
    expect(blockedValidation.statusCode).toBe(403);
    const importUpload = multipart("blocked.formaspec.zip", "application/zip", exported.rawPayload);
    const blockedImport = await application.app.inject({
      method: "POST",
      url: "/api/imports?mode=clone",
      headers: {
        "content-type": `multipart/form-data; boundary=${importUpload.boundary}`,
        "idempotency-key": "portable-policy-disabled-0001",
      },
      payload: importUpload.body,
    });
    expect(blockedImport.statusCode).toBe(403);
    expect(application.database.sqlite.prepare("SELECT COUNT(*) AS count FROM portable_imports").get()).toEqual({ count: 0 });
  });

  it("enforces backup enablement, schedule, and retention from organization policy", async () => {
    const application = await localApplication();
    const current = application.policies.read("local");
    const policy = structuredClone(DEFAULT_ORGANIZATION_POLICY);
    policy.backups.enabled = false;
    policy.backups.scheduleUtc = "25 4 * * *";
    policy.backups.retention = { daily: 2, weekly: 1, monthly: 3 };
    application.policies.update("local", { expectedConfigurationHash: current.configurationHash, policy });

    const schedule = await application.app.inject({ method: "GET", url: "/api/backups/schedule" });
    expect(schedule.statusCode).toBe(200);
    expect(schedule.json()).toMatchObject({
      schedule: {
        enabled: false,
        cronExpression: "25 4 * * *",
        retention: { daily: 2, weekly: 1, monthly: 3 },
        nextDueAt: null,
      },
    });

    const create = await application.app.inject({ method: "POST", url: "/api/backups", payload: {} });
    expect(create.statusCode).toBe(403);
    expect(create.json<{ error: { code: string } }>().error.code).toBe("FORBIDDEN");
    const enable = await application.app.inject({
      method: "PUT",
      url: "/api/backups/schedule",
      payload: { enabled: true, cronExpression: "25 4 * * *" },
    });
    expect(enable.statusCode).toBe(403);
    const run = await application.app.inject({ method: "POST", url: "/api/backups/schedule/run", payload: {} });
    expect(run.statusCode).toBe(200);
    expect(run.json()).toMatchObject({ run: { status: "disabled", backup: null } });
  });

  it("exports the selected historical V1 revision and the canonical V2 head with exact provenance", async () => {
    const application = await localApplication();
    const project = await createProject(application);
    const v1Revision = application.service.getDesign("local", project.id, 1);

    const specificationPreview = application.enterprise.previewProductSpecification("local", {
      designId: project.id,
      baseVersion: 0,
      naturalLanguageBrief: "External V1 product context must keep its established export behavior.",
    });
    application.enterprise.commitProductSpecificationPreview("local", {
      designId: project.id,
      previewId: specificationPreview.id,
      expectedBaseVersion: 0,
      idempotencyKey: "portable-v2-product-spec-commit",
      message: "Seed V1 portable context",
    });

    const backupId = "backup_portablev2_00000001";
    seedVerifiedMigrationBackup(application, backupId, v1Revision.design.updatedAt);
    const migrated = application.service.migrateDesignHeadToV2("local", project.id, {
      expectedBaseVersion: 1,
      backupId,
      idempotencyKey: "portable-v2-head-migration",
    });
    expect(migrated.result.schemaVersion).toBe(2);

    const exportedV1 = await application.app.inject({
      method: "GET",
      url: `/api/designs/${project.id}/export.formaspec.zip?version=1`,
    });
    expect(exportedV1.statusCode).toBe(200);
    const bundleV1 = readPortableProjectBundle(exportedV1.rawPayload);
    expect(bundleV1.manifest).toMatchObject({
      documentSchemaVersion: 1,
      revisionId: v1Revision.revision.id,
      revisionHash: v1Revision.revision.revisionHash,
    });
    expect(exportedV1.headers["x-formaspec-revision-id"]).toBe(v1Revision.revision.id);
    expect(canonicalJson(bundleV1.document)).toBe(canonicalJson(v1Revision.canonicalDocument));
    expect(bundleV1.productSpecification).toMatchObject({
      natural_language_brief: "External V1 product context must keep its established export behavior.",
    });

    const exportedV2 = await application.app.inject({
      method: "GET",
      url: `/api/designs/${project.id}/export.formaspec.zip`,
    });
    expect(exportedV2.statusCode).toBe(200);
    const bundleV2 = readPortableProjectBundle(exportedV2.rawPayload);
    expect(bundleV2.manifest).toMatchObject({
      documentSchemaVersion: 2,
      revisionId: migrated.result.revision.id,
      revisionHash: migrated.result.revision.revisionHash,
    });
    expect(exportedV2.headers["x-formaspec-revision-id"]).toBe(migrated.result.revision.id);
    expect(canonicalJson(bundleV2.document)).toBe(canonicalJson(migrated.result.canonicalDocument));
    expect(bundleV2.document.schema_version).toBe(2);
    if (bundleV2.document.schema_version !== 2) throw new Error("Expected a V2 portable document.");
    expect(bundleV2.document.migration).toMatchObject({
      source_revision_id: v1Revision.revision.id,
      source_snapshot_hash: v1Revision.revision.snapshotHash,
      verified_backup_id: backupId,
    });
    expect(bundleV2.document.design_system.release_version).toBeGreaterThan(0);
    expect(bundleV2.productSpecification).toEqual(bundleV2.document.product_specification);

    const uploadV2 = multipart("project-v2.formaspec.zip", "application/zip", exportedV2.rawPayload);
    const validatedV2 = await application.app.inject({
      method: "POST",
      url: "/api/imports/validate",
      headers: { "content-type": `multipart/form-data; boundary=${uploadV2.boundary}` },
      payload: uploadV2.body,
    });
    expect(validatedV2.statusCode).toBe(200);
    expect(validatedV2.json()).toMatchObject({
      valid: true,
      validationOnly: true,
      mutationsApplied: false,
      manifest: {
        documentSchemaVersion: 2,
        revisionId: migrated.result.revision.id,
        revisionHash: migrated.result.revision.revisionHash,
      },
      project: { id: project.id, schemaVersion: 2 },
    });

    const cloneUpload = multipart("project-v2.formaspec.zip", "application/zip", exportedV2.rawPayload);
    const clonedV2 = await application.app.inject({
      method: "POST",
      url: "/api/imports?mode=clone",
      headers: {
        "content-type": `multipart/form-data; boundary=${cloneUpload.boundary}`,
        "idempotency-key": "portable-v2-clone-import-0001",
      },
      payload: cloneUpload.body,
    });
    expect(clonedV2.statusCode, clonedV2.body).toBe(201);
    const cloneResult = clonedV2.json<{
      project: { id: string; revisionId: string; schemaVersion: number; productSpecificationVersion: number };
      idMapping: Record<string, string>;
    }>();
    expect(cloneResult.project).toMatchObject({ schemaVersion: 2, productSpecificationVersion: 1 });
    const clonedDocument = application.service.getDesign("local", cloneResult.project.id).canonicalDocument;
    expect(clonedDocument.schema_version).toBe(2);
    if (clonedDocument.schema_version !== 2) throw new Error("Expected a strict V2 clone.");
    expect(clonedDocument.revision).toBe(1);
    expect(clonedDocument.design_system).toEqual(bundleV2.document.design_system);
    expect(clonedDocument.product_specification).toMatchObject({
      id: cloneResult.idMapping[bundleV2.document.product_specification.id],
      version: 1,
      natural_language_brief: bundleV2.document.product_specification.natural_language_brief,
    });
    expect(clonedDocument.migration).toMatchObject({
      source_schema_version: bundleV2.document.migration?.source_schema_version,
      source_revision_id: bundleV2.document.migration?.source_revision_id,
      source_snapshot_hash: bundleV2.document.migration?.source_snapshot_hash,
      verified_backup_id: bundleV2.document.migration?.verified_backup_id,
    });
    expect(clonedDocument.migration?.compatibility?.frame_roles).toEqual(Object.fromEntries(
      Object.entries(bundleV2.document.migration?.compatibility?.frame_roles ?? {}).map(([nodeId, role]) => [
        cloneResult.idMapping[nodeId],
        role,
      ]),
    ));
    expect(application.enterprise.readProductSpecification("local", cloneResult.project.id)).toMatchObject({
      version: 1,
      revisionId: cloneResult.project.revisionId,
      specification: clonedDocument.product_specification,
    });
  });

  it("creates, records, verifies, lists, and downloads only managed verified backups", async () => {
    const application = await localApplication();
    await createProject(application);

    const created = await application.app.inject({ method: "POST", url: "/api/backups", payload: {} });
    expect(created.statusCode).toBe(201);
    const backup = created.json<{ backup: { id: string; filename: string; status: string; bundleSha256: string } }>().backup;
    expect(backup.id).toMatch(/^backup_[a-f0-9]{40}$/);
    expect(backup.filename).toMatch(/^formaspec-backup-.*\.tar$/);
    expect(backup.status).toBe("valid");
    expect(backup.bundleSha256).toMatch(/^[a-f0-9]{64}$/);

    const listed = await application.app.inject({ method: "GET", url: "/api/backups" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ backups: Array<{ id: string }> }>().backups.map((item) => item.id)).toContain(backup.id);

    const verified = await application.app.inject({ method: "POST", url: `/api/backups/${backup.id}/verify`, payload: {} });
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toMatchObject({ backup: { id: backup.id, status: "valid" } });

    const downloaded = await application.app.inject({ method: "GET", url: `/api/backups/${backup.id}/download` });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.headers["content-type"]).toContain("application/x-tar");
    expect(downloaded.headers["x-formaspec-bundle-sha256"]).toBe(backup.bundleSha256);
    expect(downloaded.rawPayload.length).toBeGreaterThan(1_000);

    const bundlePath = path.join(application.config.backupDir, backup.filename);
    const originalBytes = await fs.promises.readFile(bundlePath);
    const pinnedDownload = await application.operations.openBackupDownload("local", backup.id);
    await fs.promises.rename(bundlePath, `${bundlePath}.original`);
    await fs.promises.writeFile(bundlePath, Buffer.from("replacement bytes must never reach the active download"));
    const pinnedChunks: Buffer[] = [];
    for await (const chunk of pinnedDownload.stream) pinnedChunks.push(Buffer.from(chunk));
    const pinnedBytes = Buffer.concat(pinnedChunks);
    expect(pinnedBytes).toEqual(originalBytes);
    expect(createHash("sha256").update(pinnedBytes).digest("hex")).toBe(backup.bundleSha256);

    const unknown = await application.app.inject({ method: "GET", url: `/api/backups/${"backup_" + "0".repeat(40)}/download` });
    expect(unknown.statusCode).toBe(404);
  });

  it("exports bounded design-token values for supported platform targets", async () => {
    const application = await localApplication();
    const project = await createProject(application);
    const updated = await application.app.inject({
      method: "POST",
      url: `/api/designs/${project.id}/revisions`,
      payload: {
        baseVersion: 1,
        idempotencyKey: "operations-token-export-0001",
        message: "Add semantic color",
        operations: [{
          type: "upsert_token",
          token: {
            id: "token_actionprimary0001",
            name: "Primary action background",
            path: "action.primary.background",
            kind: "color",
            value: "#3366ff",
            archived: false,
            metadata: { layer: "semantic" },
          },
        }],
      },
    });
    expect(updated.statusCode).toBe(200);

    const css = await application.app.inject({
      method: "GET",
      url: `/api/designs/${project.id}/tokens/export/css?version=2`,
    });
    expect(css.statusCode).toBe(200);
    expect(css.headers["content-disposition"]).toContain("formaspec-tokens.css");
    expect(css.body).toContain("--action-primary-background: #3366ff;");

    const android = await application.app.inject({
      method: "GET",
      url: `/api/designs/${project.id}/tokens/export/android_xml?version=2`,
    });
    expect(android.statusCode).toBe(200);
    expect(android.body).toContain('<color name="action_primary_background">#3366ff</color>');
  });

  it("serializes backup creation through an expiring operational lock", async () => {
    const application = await localApplication();
    const now = new Date();
    application.database.sqlite.prepare(
      `INSERT INTO operational_locks
       (name, organization_id, holder_id, purpose, metadata_json, acquired_at, expires_at)
       VALUES ('backup', 'organization_legacy', 'existing-holder', 'Test concurrent backup', '{}', ?, ?)`,
    ).run(now.toISOString(), new Date(now.getTime() + 60_000).toISOString());

    const blocked = await application.app.inject({ method: "POST", url: "/api/backups", payload: {} });
    expect(blocked.statusCode).toBe(503);
    expect(blocked.json<{ error: { code: string; retryable: boolean } }>().error).toMatchObject({
      code: "TEMPORARILY_UNAVAILABLE",
      retryable: true,
    });
  });

  it("configures a fixed 7/4/12 UTC schedule and runs each due window idempotently", async () => {
    const application = await localApplication();
    const initial = await application.app.inject({ method: "GET", url: "/api/backups/schedule" });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({
      schedule: {
        enabled: false,
        cronExpression: "0 2 * * *",
        timezone: "UTC",
        retention: { daily: 7, weekly: 4, monthly: 12 },
      },
    });

    const configured = await application.app.inject({
      method: "PUT",
      url: "/api/backups/schedule",
      payload: { enabled: true, cronExpression: "15 3 * * *" },
    });
    expect(configured.statusCode).toBe(200);
    expect(configured.json()).toMatchObject({ schedule: { enabled: true, cronExpression: "15 3 * * *" } });

    const first = await application.app.inject({ method: "POST", url: "/api/backups/schedule/run", payload: {} });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ run: { status: "created", retentionClass: "monthly" } });
    const firstBackup = first.json<{ run: { backup: { id: string } } }>().run.backup.id;

    const retry = await application.app.inject({ method: "POST", url: "/api/backups/schedule/run", payload: {} });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ run: { status: "already_completed", backup: { id: firstBackup } } });
    const supervised = application.operations.getBackupSchedule("local");
    expect(supervised.supervision).toMatchObject({
      status: "healthy",
      currentWindowCovered: true,
      latestAttempt: { status: "already_completed" },
      retention: { candidateCount: 0 },
      alerts: [],
    });
    expect((application.database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM backup_records WHERE retention_class <> 'manual'",
    ).get() as { count: number }).count).toBe(1);
    const actions = application.database.sqlite.prepare(
      "SELECT action FROM audit_events WHERE action LIKE 'backup.schedule_%' ORDER BY id",
    ).all() as Array<{ action: string }>;
    expect(actions.map((row) => row.action)).toEqual([
      "backup.schedule_update",
      "backup.schedule_run_started",
      "backup.schedule_run",
      "backup.schedule_run_started",
      "backup.schedule_run",
    ]);

    vi.spyOn(application.backups, "create").mockRejectedValueOnce(new Error("private filesystem detail"));
    const nextWindow = new Date(Date.now() + 36 * 60 * 60 * 1_000);
    await expect(application.operations.runScheduledBackup("local", nextWindow)).rejects.toThrow("private filesystem detail");
    expect(application.operations.getBackupSchedule("local", nextWindow).supervision).toMatchObject({
      status: "critical",
      currentWindowCovered: false,
      latestAttempt: { status: "failed", errorCode: "INTERNAL_ERROR", retryable: true },
      alerts: expect.arrayContaining([expect.objectContaining({ code: "SCHEDULE_RUN_FAILED", severity: "critical" })]),
    });
    expect(application.operations.backupSupervisionHealth(nextWindow)).toMatchObject({
      status: "critical",
      enabledSchedules: 1,
      criticalSchedules: 1,
    });
    const failedAudit = application.database.sqlite.prepare(
      "SELECT details_json FROM audit_events WHERE action = 'backup.schedule_run_failed' ORDER BY id DESC LIMIT 1",
    ).get() as { details_json: string };
    expect(JSON.parse(failedAudit.details_json)).toMatchObject({ errorCode: "INTERNAL_ERROR", retryable: true });
    expect(failedAudit.details_json).not.toContain("private filesystem detail");
  });

  it("requires an exact preview and never automatically prunes manual backups", async () => {
    const application = await localApplication();
    const seeded: Array<{ id: string; filename: string; path: string }> = [];
    for (let index = 1; index <= 8; index += 1) {
      seeded.push(await seedManagedBackup(application, index, "daily", `2026-07-${String(index).padStart(2, "0")}T00:00:00.000Z`));
    }
    for (let index = 1; index <= 5; index += 1) {
      seeded.push(await seedManagedBackup(application, 100 + index, "weekly", `2026-05-${String(index).padStart(2, "0")}T00:00:00.000Z`));
    }
    for (let index = 1; index <= 13; index += 1) {
      seeded.push(await seedManagedBackup(application, 200 + index, "monthly", new Date(Date.UTC(2024, index - 1, 1)).toISOString()));
    }
    const manual = await seedManagedBackup(application, 999, "manual", "2020-01-01T00:00:00.000Z");

    const previewResponse = await application.app.inject({ method: "POST", url: "/api/backups/prune/previews", payload: {} });
    expect(previewResponse.statusCode).toBe(201);
    const preview = previewResponse.json<{ preview: {
      previewId: string;
      planHash: string;
      candidates: Array<{ id: string }>;
      retainedCount: number;
      manualExemptCount: number;
    } }>().preview;
    expect(preview.previewId).toMatch(/^backup_prune_preview_[a-f0-9]{32}$/);
    expect(preview.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.candidates).toHaveLength(3);
    expect(preview.retainedCount).toBe(23);
    expect(preview.manualExemptCount).toBe(1);
    expect(preview.candidates.some((candidate) => candidate.id === manual.id)).toBe(false);

    const wrongHash = await application.app.inject({
      method: "POST",
      url: `/api/backups/prune/previews/${preview.previewId}/commit`,
      payload: { expectedPlanHash: "f".repeat(64) },
    });
    expect(wrongHash.statusCode).toBe(409);
    expect(wrongHash.json<{ error: { code: string } }>().error.code).toBe("VERSION_CONFLICT");

    const committed = await application.app.inject({
      method: "POST",
      url: `/api/backups/prune/previews/${preview.previewId}/commit`,
      payload: { expectedPlanHash: preview.planHash },
    });
    expect(committed.statusCode).toBe(200);
    expect(committed.json()).toMatchObject({
      result: { previewId: preview.previewId, planHash: preview.planHash, cleanupPending: false },
    });
    const prunedIds = committed.json<{ result: { prunedBackupIds: string[] } }>().result.prunedBackupIds;
    expect(prunedIds).toHaveLength(3);
    for (const id of prunedIds) {
      const source = seeded.find((item) => item.id === id);
      expect(source).toBeDefined();
      expect(fs.existsSync(source!.path)).toBe(false);
    }
    expect(fs.existsSync(manual.path)).toBe(true);
    expect((application.database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM backup_records WHERE retention_class = 'manual'",
    ).get() as { count: number }).count).toBe(1);
    expect((application.database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'backup.prune_commit'",
    ).get() as { count: number }).count).toBe(1);
  });

  it("revalidates immutable bundle bytes and expiry before a prune commit", async () => {
    const application = await localApplication();
    for (let index = 1; index <= 8; index += 1) {
      await seedManagedBackup(application, 500 + index, "daily", `2025-01-${String(index).padStart(2, "0")}T00:00:00.000Z`);
    }
    const preview = await application.operations.previewBackupPrune("local", new Date("2026-07-19T10:00:00.000Z"));
    const candidate = preview.candidates[0]!;
    await fs.promises.writeFile(path.join(application.config.backupDir, candidate.filename), "tampered");
    await expect(application.operations.executeBackupPrune(
      "local",
      preview.previewId,
      preview.planHash,
      new Date("2026-07-19T10:01:00.000Z"),
    )).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(application.database.sqlite.prepare("SELECT id FROM backup_records WHERE id = ?").get(candidate.id)).toBeDefined();

    const second = await application.operations.previewBackupPrune("local", new Date("2026-07-19T11:00:00.000Z"))
      .catch((error: unknown) => error);
    expect(second).toMatchObject({ code: "VALIDATION_FAILED" });

    application.database.sqlite.prepare("UPDATE backup_records SET bundle_sha256 = ?, size_bytes = ? WHERE id = ?").run(
      createHash("sha256").update("tampered").digest("hex"),
      Buffer.byteLength("tampered"),
      candidate.id,
    );
    const expiring = await application.operations.previewBackupPrune("local", new Date("2026-07-19T12:00:00.000Z"));
    await expect(application.operations.executeBackupPrune(
      "local",
      expiring.previewId,
      expiring.planHash,
      new Date("2026-07-19T12:16:00.000Z"),
    )).rejects.toMatchObject({ code: "PREVIEW_EXPIRED" });
  });

  it("requires Organization Administrator permission", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "formaspec-operations-auth-"));
    temporaryDirectories.push(root);
    const application = await buildApplication(loadConfig({
      APP_MODE: "server",
      HOST: "0.0.0.0",
      PORT: "4310",
      DATA_DIR: path.join(root, "data"),
      BACKUP_DIR: path.join(root, "backups"),
      DESIGNER_DATABASE_PATH: ":memory:",
      PUBLIC_BASE_URL: "https://design.example.com",
      AUTH_MODE: "trusted-header",
      DESIGNER_TOKEN: "operations-bootstrap-token",
      FORMASPEC_TRUSTED_PROXIES: "127.0.0.1",
      FORMASPEC_PROXY_SECRET: PROXY_SECRET,
      DESIGNER_CORS_ORIGINS: "https://design.example.com",
      DESIGNER_LOG_LEVEL: "silent",
    }));
    applications.push(application);

    const bootstrap = await application.app.inject({
      method: "GET",
      url: "/api/organization/policy",
      headers: {
        host: "design.example.com",
        "x-designer-user": "admin@example.com",
        "x-formaspec-proxy-secret": PROXY_SECRET,
      },
    });
    expect(bootstrap.statusCode).toBe(200);
    const current = application.policies.read("trusted:admin@example.com");
    const policy = structuredClone(DEFAULT_ORGANIZATION_POLICY);
    policy.identity.roleMappings = [
      { claim: "identity", value: "admin@example.com", role: "organization_admin" },
      { claim: "trusted_user", value: "viewer@example.com", role: "viewer" },
    ];
    application.policies.update("trusted:admin@example.com", {
      expectedConfigurationHash: current.configurationHash,
      policy,
    });

    const response = await application.app.inject({
      method: "GET",
      url: "/api/backups",
      headers: {
        host: "design.example.com",
        "x-designer-user": "viewer@example.com",
        "x-formaspec-proxy-secret": PROXY_SECRET,
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("FORBIDDEN");

    const upload = multipart("viewer.formaspec.zip", "application/zip", Buffer.from("authorization precedes parsing"));
    const importResponse = await application.app.inject({
      method: "POST",
      url: "/api/imports",
      headers: {
        host: "design.example.com",
        origin: "https://design.example.com",
        "x-formaspec-csrf": "1",
        "x-designer-user": "viewer@example.com",
        "x-formaspec-proxy-secret": PROXY_SECRET,
        "idempotency-key": "portable-viewer-forbidden-0001",
        "content-type": `multipart/form-data; boundary=${upload.boundary}`,
      },
      payload: upload.body,
    });
    expect(importResponse.statusCode).toBe(403);
    expect(importResponse.json<{ error: { code: string } }>().error.code).toBe("FORBIDDEN");
    expect(application.database.sqlite.prepare("SELECT COUNT(*) AS count FROM portable_imports").get()).toEqual({ count: 0 });
  });
});
