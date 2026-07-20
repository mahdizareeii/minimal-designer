import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { ContentAddressedRasterStore, normalizeImageAsset } from "./assets.js";
import { restoreVerifiedBackup } from "./backup.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { DesignerDatabase } from "./db/database.js";

const sourcePng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=",
  "base64",
);

const applications = new Set<DesignerApplication>();
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all([...applications].map((application) => application.app.close()));
  applications.clear();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.promises.rm(directory, { recursive: true, force: true })));
});

async function temporaryRoot(label: string): Promise<string> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `formaspec-assets-${label}-`));
  temporaryDirectories.push(root);
  return root;
}

function applicationConfig(dataDirectory: string, backupDirectory: string): ServerConfig {
  return loadConfig({
    APP_MODE: "local",
    HOST: "127.0.0.1",
    PORT: "4310",
    DATA_DIR: dataDirectory,
    BACKUP_DIR: backupDirectory,
    PUBLIC_BASE_URL: "http://127.0.0.1:4310",
    AUTH_MODE: "none",
    FORMASPEC_ALLOW_SOFTWARE_RENDERER: "true",
    DESIGNER_LOG_LEVEL: "silent",
  });
}

async function openApplication(config: ServerConfig): Promise<DesignerApplication> {
  const application = await buildApplication(config);
  applications.add(application);
  await application.app.ready();
  return application;
}

async function closeApplication(application: DesignerApplication): Promise<void> {
  applications.delete(application);
  await application.app.close();
}

function multipart(filename: string, data = sourcePng): { boundary: string; body: Buffer } {
  const boundary = "----formaspec-content-addressed-asset";
  return {
    boundary,
    body: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

async function upload(application: DesignerApplication, filename: string): Promise<{
  id: string;
  sha256: string;
  sizeBytes: number;
  responseBody: string;
}> {
  const uploadBody = multipart(filename);
  const response = await application.app.inject({
    method: "POST",
    url: "/api/assets",
    headers: { "content-type": `multipart/form-data; boundary=${uploadBody.boundary}` },
    payload: uploadBody.body,
  });
  expect(response.statusCode).toBe(201);
  const asset = response.json<{ id: string; sha256: string; sizeBytes: number }>();
  return { ...asset, responseBody: response.body };
}

function relativeAssetPath(sha256: string): string {
  return path.join("assets", "sha256", sha256.slice(0, 2), `${sha256}.png`);
}

async function regularFiles(root: string, prefix = ""): Promise<string[]> {
  if (!fs.existsSync(root)) return [];
  const entries = await fs.promises.readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relative = prefix ? path.join(prefix, entry.name) : entry.name;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await regularFiles(absolute, relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files.sort();
}

describe("content-addressed normalized raster storage", () => {
  it("deduplicates normalized bytes and never uses or exposes user filenames as paths", async () => {
    const root = await temporaryRoot("dedup");
    const dataDirectory = path.join(root, "data");
    const application = await openApplication(applicationConfig(dataDirectory, path.join(root, "backups")));

    const first = await upload(application, "../../executive roadmap.png");
    const expectedRelative = relativeAssetPath(first.sha256);
    const expectedPath = path.join(dataDirectory, expectedRelative);
    const firstStat = await fs.promises.stat(expectedPath);
    const persisted = await fs.promises.readFile(expectedPath);
    expect(createHash("sha256").update(persisted).digest("hex")).toBe(first.sha256);

    const second = await upload(application, "..\\..\\different-name.png");
    const secondStat = await fs.promises.stat(expectedPath);
    expect(second.id).not.toBe(first.id);
    expect(second.sha256).toBe(first.sha256);
    expect(secondStat.ino).toBe(firstStat.ino);
    expect(await regularFiles(path.join(dataDirectory, "assets"))).toEqual([
      path.join("sha256", first.sha256.slice(0, 2), `${first.sha256}.png`),
    ]);
    expect(first.responseBody).not.toContain(dataDirectory);
    expect(first.responseBody).not.toContain("sha256/");

    const fetched = await application.app.inject({ method: "GET", url: `/api/assets/${second.id}` });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.rawPayload.equals(persisted)).toBe(true);
  });

  it("reads verified files after restart and explicitly falls back to verified legacy BLOBs", async () => {
    const root = await temporaryRoot("restart");
    const dataDirectory = path.join(root, "data");
    const config = applicationConfig(dataDirectory, path.join(root, "backups"));
    let application = await openApplication(config);
    const uploaded = await upload(application, "restart.png");
    const primaryPath = path.join(dataDirectory, relativeAssetPath(uploaded.sha256));
    const primaryBytes = await fs.promises.readFile(primaryPath);

    application.database.sqlite.prepare("UPDATE assets SET data = ? WHERE id = ?").run(Buffer.from("quarantined legacy bytes"), uploaded.id);
    await closeApplication(application);

    application = await openApplication(config);
    const restarted = await application.app.inject({ method: "GET", url: `/api/assets/${uploaded.id}` });
    expect(restarted.statusCode).toBe(200);
    expect(restarted.rawPayload.equals(primaryBytes)).toBe(true);
    const fileBackedBackup = await application.backups.create();
    expect(fileBackedBackup.verification.valid).toBe(true);

    const legacy = { data: sourcePng, mimeType: "image/png" as const, width: 1, height: 1 };
    const legacySha256 = createHash("sha256").update(legacy.data).digest("hex");
    const legacyId = "asset_legacycompat0001";
    application.database.sqlite.prepare(
      `INSERT INTO assets
       (id, actor_id, design_id, filename, mime_type, size_bytes, width, height, sha256, data, created_at, organization_id)
       VALUES (?, 'local', NULL, 'legacy.png', 'image/png', ?, ?, ?, ?, ?, ?, 'organization_legacy')`,
    ).run(legacyId, legacy.data.length, legacy.width, legacy.height, legacySha256, legacy.data, new Date().toISOString());
    expect(fs.existsSync(path.join(dataDirectory, relativeAssetPath(legacySha256)))).toBe(false);

    const legacyResponse = await application.app.inject({ method: "GET", url: `/api/assets/${legacyId}` });
    expect(legacyResponse.statusCode).toBe(200);
    expect(legacyResponse.rawPayload.equals(legacy.data)).toBe(true);
    application.database.sqlite.prepare("UPDATE assets SET data = ? WHERE id = ?").run(Buffer.from("tampered"), legacyId);
    const corruptLegacy = await application.app.inject({ method: "GET", url: `/api/assets/${legacyId}` });
    expect(corruptLegacy.statusCode).toBe(500);
    expect(corruptLegacy.json<{ error: { code: string } }>().error.code).toBe("INTERNAL_ERROR");
  });

  it("rejects traversal-like digests and detects stored-file tampering", async () => {
    const root = await temporaryRoot("integrity");
    const dataDirectory = path.join(root, "data");
    const sha256 = createHash("sha256").update(sourcePng).digest("hex");
    const store = new ContentAddressedRasterStore(dataDirectory);

    expect(() => store.writeNormalized(sourcePng, "image/png", `../${sha256}`)).toThrowError(expect.objectContaining({
      code: "VALIDATION_FAILED",
    }));
    store.writeNormalized(sourcePng, "image/png", sha256);
    const storedPath = path.join(dataDirectory, relativeAssetPath(sha256));
    await fs.promises.writeFile(storedPath, "tampered-content");
    expect(() => store.readNormalized(sha256, "image/png", sourcePng.length)).toThrowError(expect.objectContaining({
      code: "INTERNAL_ERROR",
    }));
    expect((await regularFiles(root)).some((filename) => filename.includes(".."))).toBe(false);
  });

  it("includes generated content-addressed assets in verified backup and restore", async () => {
    const root = await temporaryRoot("backup");
    const dataDirectory = path.join(root, "data");
    const backups = path.join(root, "backups");
    const config = applicationConfig(dataDirectory, backups);
    let application = await openApplication(config);
    const uploaded = await upload(application, "backup.png");
    const expectedRelative = relativeAssetPath(uploaded.sha256).replaceAll(path.sep, "/");
    const expectedBytes = await fs.promises.readFile(path.join(dataDirectory, relativeAssetPath(uploaded.sha256)));
    const backup = await application.backups.create();
    expect(backup.verification.manifest.files.some((file) => file.path === expectedRelative)).toBe(true);
    await closeApplication(application);

    const restoredData = path.join(root, "restored-data");
    await restoreVerifiedBackup(backup.path, restoredData, {
      databaseClosed: true,
      healthCheck: async (directory) => {
        const restored = new DesignerDatabase(path.join(directory, "designer.sqlite"));
        try {
          expect(restored.sqlite.pragma("integrity_check", { simple: true })).toBe("ok");
        } finally {
          restored.close();
        }
      },
    });
    expect((await fs.promises.readFile(path.join(restoredData, relativeAssetPath(uploaded.sha256)))).equals(expectedBytes)).toBe(true);

    application = await openApplication(applicationConfig(restoredData, path.join(root, "restored-backups")));
    const restoredResponse = await application.app.inject({ method: "GET", url: `/api/assets/${uploaded.id}` });
    expect(restoredResponse.statusCode).toBe(200);
    expect(restoredResponse.rawPayload.equals(expectedBytes)).toBe(true);
  });
});
