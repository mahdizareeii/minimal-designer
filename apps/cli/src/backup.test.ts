import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import Database from "better-sqlite3";
import tar from "tar-stream";
import { afterEach, describe, expect, it } from "vitest";

import { verifyBackup, type BackupManifest } from "./backup.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function makeBackup(options: { badAssetChecksum?: boolean; formatVersion?: 1 | 2 } = {}): Promise<string> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "formaspec-backup-test-"));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, "source.sqlite");
  const sqlite = new Database(databasePath);
  sqlite.exec("PRAGMA foreign_keys = ON; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  sqlite.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?)").run(1, "baseline_v1", "2026-01-01T00:00:00.000Z");
  sqlite.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?)").run(2, "content_addressed_persistence", "2026-01-02T00:00:00.000Z");
  sqlite.close();
  const payload = new Map<string, Buffer>([
    ["database.sqlite", fs.readFileSync(databasePath)],
    ["asset-manifest.json", Buffer.from('{"files":[]}\n')],
    ["organization-config.yaml", Buffer.from("name: Test\n")],
  ]);
  const manifest: BackupManifest = {
    format: "formaspec-backup",
    formatVersion: options.formatVersion ?? 1,
    createdAt: "2026-01-03T00:00:00.000Z",
    applicationBuildVersion: "0.1.0",
    databaseSchemaVersion: 2,
    documentSchemaVersion: 1,
    commandEngineVersion: "1",
    rendererVersion: "1",
    fontBundleVersion: "1",
    files: [...payload].map(([name, data]) => ({
      path: name,
      sizeBytes: data.length,
      sha256: options.badAssetChecksum && name === "asset-manifest.json" ? "0".repeat(64) : sha256(data),
    })),
  };
  const manifestData = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const checksums = [
    ...[...payload].map(([name, data]) => `${sha256(data)}  ${name}`),
    `${sha256(manifestData)}  backup-manifest.json`,
  ].sort().join("\n");
  const entries = new Map(payload);
  entries.set("backup-manifest.json", manifestData);
  entries.set("checksums.sha256", Buffer.from(`${checksums}\n`));

  const bundle = path.join(directory, "backup.tar");
  const pack = tar.pack();
  const writing = pipeline(pack, fs.createWriteStream(bundle));
  for (const [name, data] of entries) {
    await new Promise<void>((resolve, reject) => {
      pack.entry({ name, type: "file", size: data.length, mode: 0o600 }, data, (error) => error ? reject(error) : resolve());
    });
  }
  pack.finalize();
  await writing;
  return bundle;
}

describe("backup verify", () => {
  it("verifies checksums, SQLite integrity, foreign keys, and the migration ledger", async () => {
    const bundle = await makeBackup();
    const bytes = await fs.promises.readFile(bundle);
    const result = await verifyBackup(bundle);
    expect(result).toMatchObject({
      valid: true,
      sqliteIntegrity: "ok",
      foreignKeyViolations: 0,
      migrationVersion: 2,
      entryCount: 5,
      bundleSizeBytes: bytes.length,
      bundleSha256: sha256(bytes),
    });
  });

  it("accepts the strict format-2 manifest emitted by current servers", async () => {
    await expect(verifyBackup(await makeBackup({ formatVersion: 2 }))).resolves.toMatchObject({
      valid: true,
      manifest: { formatVersion: 2 },
    });
  });

  it("rejects a manifest checksum mismatch", async () => {
    await expect(verifyBackup(await makeBackup({ badAssetChecksum: true }))).rejects.toThrow(/checksum failed/);
  });
});
