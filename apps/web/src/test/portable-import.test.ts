import { afterEach, describe, expect, it, vi } from "vitest";

import {
  importPortableProject,
  registerBackupImport,
  validateBackupImport,
  validatePortableImport,
} from "../lib/api";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("portable project import API", () => {
  it("validates without mutation and commits only with an explicit idempotency key and mode", async () => {
    const file = new File(["portable bundle"], "project.formaspec.zip", {
      type: "application/zip",
    });
    const validationResponse = {
      valid: true,
      validationOnly: true,
      mutationsApplied: false,
      manifest: { format: "formaspec-project" },
      project: {
        id: "document_portableweb_0001",
        name: "Portable web",
        schemaVersion: 1,
        pageCount: 1,
        nodeCount: 4,
        tokenCount: 2,
        assetCount: 0,
        previewCount: 0,
      },
    } as const;
    const importResponse = {
      importId: `import_${"e".repeat(40)}`,
      imported: true,
      mutationsApplied: true,
      mode: "clone",
      bundleSha256: "a".repeat(64),
      source: {
        projectId: validationResponse.project.id,
        revisionId: "revision_portableweb_0001",
        revisionHashClaim: "b".repeat(64),
        documentRevision: 8,
        productSpecificationVersion: 3,
      },
      project: {
        id: "document_portableweb_clone0001",
        name: validationResponse.project.name,
        version: 1,
        revisionId: "revision_portableweb_clone0001",
        snapshotHash: "c".repeat(64),
        revisionHash: "d".repeat(64),
        schemaVersion: 1,
        assetCount: 0,
        quarantinedAssetCount: 0,
        productSpecificationVersion: 1,
      },
      idMapping: {
        [validationResponse.project.id]: "document_portableweb_clone0001",
      },
      diagnostics: [{
        code: "SOURCE_REVISION_HASH_IS_CLAIMED",
        severity: "info",
        message: "Source provenance only.",
      }],
      deepLink: "/design/document_portableweb_clone0001",
    } as const;
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify(validationResponse), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(importResponse), {
        status: 201,
        headers: { "content-type": "application/json" },
      }));

    expect(await validatePortableImport(file)).toEqual(validationResponse);
    expect(await importPortableProject(file, "clone", "portable-import-web-0001")).toEqual(importResponse);

    expect(fetch.mock.calls[0]?.[0]).toBe("/api/imports/validate");
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(fetch.mock.calls[0]?.[1]?.body).toBeInstanceOf(FormData);
    expect((fetch.mock.calls[0]?.[1]?.body as FormData).get("file")).toBe(file);
    expect(fetch.mock.calls[1]?.[0]).toBe("/api/imports?mode=clone");
    expect(fetch.mock.calls[1]?.[1]?.method).toBe("POST");
    expect(fetch.mock.calls[1]?.[1]?.headers).toMatchObject({
      "idempotency-key": "portable-import-web-0001",
    });
    expect((fetch.mock.calls[1]?.[1]?.body as FormData).get("file")).toBe(file);
  });
});

describe("full backup registration API", () => {
  it("validates first and binds managed registration to the exact selected SHA-256", async () => {
    const file = new File(["full backup"], "formaspec-backup.tar", {
      type: "application/x-tar",
    });
    const bundleSha256 = "a".repeat(64);
    const backup = {
      id: `backup_${"b".repeat(40)}`,
      filename: "formaspec-backup-1970-01-01T00-00-00-000Z-00000000000000000000000000001.tar",
      status: "valid",
      bundleSha256,
      createdAt: "2026-07-22T00:00:00.000Z",
      verifiedAt: "2026-07-22T00:01:00.000Z",
      sizeBytes: 11,
      retentionClass: "manual",
      completedAt: "2026-07-22T00:01:00.000Z",
      downloadUrl: `/api/backups/backup_${"b".repeat(40)}/download`,
      manifest: {
        format: "formaspec-backup",
        formatVersion: 2,
        createdAt: "2026-07-22T00:00:00.000Z",
        databaseSchemaVersion: 16,
        documentSchemaVersion: 2,
        fileCount: 4,
      },
    } as const;
    const validation = {
      valid: true,
      validationOnly: true,
      mutationsApplied: false,
      bundleSha256,
      sizeBytes: 11,
      destructiveRestoreRequired: true,
      manifest: backup.manifest,
      verification: {
        sqliteIntegrity: "ok",
        foreignKeyViolations: 0,
        extractedBytes: 1024,
        entryCount: 6,
      },
    } as const;
    const registration = {
      registered: true,
      alreadyRegistered: false,
      destructiveRestoreRequired: true,
      backup,
    } as const;
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify(validation), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(registration), {
        status: 201,
        headers: { "content-type": "application/json" },
      }));

    expect(await validateBackupImport(file)).toEqual(validation);
    expect(await registerBackupImport(file, bundleSha256)).toEqual(registration);

    expect(fetch.mock.calls[0]?.[0]).toBe("/api/backups/imports/validate");
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("POST");
    expect((fetch.mock.calls[0]?.[1]?.body as FormData).get("file")).toBe(file);
    expect(fetch.mock.calls[1]?.[0]).toBe(`/api/backups/imports?expectedSha256=${bundleSha256}`);
    expect(fetch.mock.calls[1]?.[1]?.method).toBe("POST");
    expect((fetch.mock.calls[1]?.[1]?.body as FormData).get("file")).toBe(file);
  });
});
