import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import Database from "better-sqlite3";
import tar from "tar-stream";
import { afterEach, describe, expect, it } from "vitest";

import { runSupportBundleCli, type SupportBundleCliIo } from "./support-bundle-cli.js";
import {
  SUPPORT_BUNDLE_LIMITS,
  createSupportBundle,
  previewSupportBundle,
  type SupportBundleManifest,
  type SupportBundleSidecar,
} from "./support-bundle.js";

const temporaryDirectories: string[] = [];
const fixedNow = new Date("2026-07-19T12:34:56.000Z");

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "formaspec-support-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function writeMigrationDatabase(root: string, version = 10): void {
  const filename = path.join(root, "data", "designer.sqlite");
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const sqlite = new Database(filename);
  sqlite.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  for (let current = 1; current <= version; current += 1) {
    sqlite.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?)").run(
      current,
      `migration_${current}`,
      `2026-01-${String(current).padStart(2, "0")}T00:00:00.000Z`,
    );
  }
  sqlite.close();
}

async function extractArchive(filename: string): Promise<{
  files: Map<string, Buffer>;
  order: string[];
  headers: Map<string, tar.Headers>;
}> {
  const extract = tar.extract();
  const files = new Map<string, Buffer>();
  const order: string[] = [];
  const headers = new Map<string, tar.Headers>();
  extract.on("entry", (header, stream, next) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer | Uint8Array) => chunks.push(Buffer.from(chunk)));
    stream.once("error", next);
    stream.once("end", () => {
      order.push(header.name);
      headers.set(header.name, header);
      files.set(header.name, Buffer.concat(chunks));
      next();
    });
  });
  await pipeline(fs.createReadStream(filename), extract);
  return { files, order, headers };
}

function parseChecksums(data: Buffer): Map<string, string> {
  return new Map(data.toString("utf8").trim().split("\n").map((line) => {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (match === null) throw new Error(`Malformed checksum line: ${line}`);
    return [match[2]!, match[1]!];
  }));
}

function collectingIo(): SupportBundleCliIo & { output: string[]; errors: string[] } {
  const output: string[] = [];
  const errors: string[] = [];
  return { output, errors, stdout: (message) => output.push(message), stderr: (message) => errors.push(message) };
}

describe("FormaSpec support bundles", () => {
  it("contains only bounded diagnostics and redacted allowlisted logs with valid checksums", async () => {
    const root = temporaryDirectory();
    const home = path.join(root, "private-home");
    const secret = "company-super-secret-value";
    fs.mkdirSync(path.join(root, ".designer", "env"), { recursive: true });
    fs.mkdirSync(path.join(root, ".designer", "run"), { recursive: true });
    fs.mkdirSync(path.join(root, ".designer", "logs"), { recursive: true });
    fs.writeFileSync(path.join(root, ".designer", "env", "server.env"), [
      "APP_MODE=server",
      `MCP_BEARER_TOKEN=${secret}`,
      "FORMASPEC_PUBLIC_URL=https://private.example.test/designs",
      "IDENTITY_HEADER=X-Company-Identity",
    ].join("\n"));
    fs.writeFileSync(path.join(root, ".designer", "run", "mode"), "server\n");
    fs.writeFileSync(path.join(root, ".designer", "run", "pid"), "4242\n");
    fs.writeFileSync(path.join(root, ".designer", "run", "api-port"), "4310\n");
    fs.writeFileSync(path.join(root, ".designer", "run", "web-port"), "4311\n");
    fs.writeFileSync(path.join(root, ".designer", "run", "url"), "https://private.example.test/\n");
    fs.writeFileSync(path.join(root, ".designer", "run", "env-file"), `${root}/.designer/env/server.env\n`);
    fs.writeFileSync(path.join(root, ".designer", "run", "formaspec-bridge.json"), JSON.stringify({
      schemaVersion: 1,
      pid: 4242,
      url: "http://127.0.0.1:4312",
      instanceId: "bridge-instance-secret-value",
    }));
    fs.writeFileSync(path.join(root, ".designer", "logs", "local.log"), [
      `workspace=${root}/apps/server/src/index.ts`,
      `home=${home}/Library/Keychains`,
      `configured=${secret}`,
      "Authorization: Bearer bearer-secret-1234567890",
      'request={"password":"password-secret","token":"token-secret"}',
      "url=https://user:password@private.example.test/path?api_key=query-secret",
      "provider=sk-proj-abcdefghijklmnopqrstuvwxyz012345",
      "jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signatureabcdefgh",
      "-----BEGIN PRIVATE KEY-----",
      "private-key-secret",
      "-----END PRIVATE KEY-----",
      "ordinary diagnostic line",
    ].join("\n"));
    fs.writeFileSync(path.join(root, ".designer", "logs", "formaspec-bridge.log"), "client_secret=another-secret\nbridge ready\n");
    writeMigrationDatabase(root);
    fs.mkdirSync(path.join(root, "data", "assets"), { recursive: true });
    fs.writeFileSync(path.join(root, "data", "assets", "never-include.txt"), "asset-secret");
    fs.mkdirSync(path.join(root, ".designer", "backups"), { recursive: true });
    fs.writeFileSync(path.join(root, ".designer", "backups", "never-include.tar"), "backup-secret");
    fs.writeFileSync(path.join(root, "repository-source.ts"), "export const sourceSecret = 'source-secret';\n");

    const output = path.join(root, "out", "support.tar");
    const created = await createSupportBundle({
      projectRoot: root,
      outputPath: output,
      authorized: true,
      now: () => fixedNow,
      applicationVersion: "1.2.3-test",
      homeDirectory: home,
      pidIsAlive: () => true,
    });
    const extracted = await extractArchive(output);
    expect(extracted.order).toEqual([...extracted.order].sort());
    expect([...extracted.files.keys()]).toEqual([
      "checksums.sha256",
      "diagnostics/config-keys.json",
      "diagnostics/migration-status.json",
      "diagnostics/runtime-state.json",
      "diagnostics/versions.json",
      "logs/formaspec-bridge.log",
      "logs/local.log",
      "support-manifest.json",
    ]);
    for (const header of extracted.headers.values()) {
      expect(header.type).toBe("file");
      expect(header.mode).toBe(0o600);
      expect(header.uid).toBe(0);
      expect(header.gid).toBe(0);
      expect(header.mtime?.toISOString()).toBe("1970-01-01T00:00:00.000Z");
    }
    const combined = Buffer.concat([...extracted.files.values()]).toString("utf8");
    for (const forbidden of [
      secret,
      "private.example.test",
      "bridge-instance-secret-value",
      "bearer-secret-1234567890",
      "password-secret",
      "token-secret",
      "query-secret",
      "abcdefghijklmnopqrstuvwxyz012345",
      "signatureabcdefgh",
      "private-key-secret",
      "another-secret",
      "asset-secret",
      "backup-secret",
      "source-secret",
      root,
      home,
    ]) expect(combined).not.toContain(forbidden);
    expect(combined).toContain("<redacted>");
    expect(combined).toContain("<PROJECT_ROOT>");
    expect(combined).toContain("<HOME>");
    expect(combined).toContain("ordinary diagnostic line");

    const config = JSON.parse(extracted.files.get("diagnostics/config-keys.json")!.toString("utf8")) as {
      sources: Array<{ file: string; keys: Array<{ key: string; value: string }> }>;
    };
    expect(config.sources.find((source) => source.file === "server.env")?.keys).toEqual([
      { key: "APP_MODE", value: "<redacted>" },
      { key: "FORMASPEC_PUBLIC_URL", value: "<redacted>" },
      { key: "IDENTITY_HEADER", value: "<redacted>" },
      { key: "MCP_BEARER_TOKEN", value: "<redacted>" },
    ]);
    const migration = JSON.parse(extracted.files.get("diagnostics/migration-status.json")!.toString("utf8"));
    expect(migration).toEqual({
      appliedMigrationCount: 10,
      available: true,
      latestAppliedVersion: 10,
      state: "current",
      supportedVersion: 10,
    });
    const runtime = JSON.parse(extracted.files.get("diagnostics/runtime-state.json")!.toString("utf8"));
    expect(runtime).toMatchObject({
      launcher: {
        mode: "server",
        processAlive: true,
        apiPort: 4310,
        serviceUrlClassification: "public-https",
        environmentFileRecorded: true,
      },
      bridge: {
        state: "valid",
        processAlive: true,
        urlClassification: "loopback-http",
        instanceIdRecorded: true,
      },
    });

    const checksums = parseChecksums(extracted.files.get("checksums.sha256")!);
    expect(checksums.size).toBe(extracted.files.size - 1);
    for (const [name, data] of extracted.files) {
      if (name !== "checksums.sha256") expect(checksums.get(name)).toBe(sha256(data));
    }
    const manifest = JSON.parse(extracted.files.get("support-manifest.json")!.toString("utf8")) as SupportBundleManifest;
    expect(manifest.entries).toEqual(created.manifest.entries);
    expect(manifest.privacy.reviewRequiredBeforeSharing).toBe(true);
    expect(manifest.totalPayloadBytes).toBeLessThanOrEqual(SUPPORT_BUNDLE_LIMITS.maxPayloadBytes);

    const sidecar = JSON.parse(fs.readFileSync(created.previewManifestPath, "utf8")) as SupportBundleSidecar;
    expect(sidecar.archiveSha256).toBe(sha256(fs.readFileSync(output)));
    expect(sidecar.archiveSizeBytes).toBe(fs.statSync(output).size);
    expect(sidecar.archiveFilename).toBe("support.tar");
    expect(sidecar.manifest).toEqual(manifest);
  });

  it("refuses creation without explicit authorization and does not write anything", async () => {
    const root = temporaryDirectory();
    const output = path.join(root, "support.tar");
    await expect(createSupportBundle({
      projectRoot: root,
      outputPath: output,
      authorized: false,
      now: () => fixedNow,
    })).rejects.toThrow(/explicit --yes authorization/);
    expect(fs.existsSync(output)).toBe(false);
    expect(fs.existsSync(`${output}.manifest.json`)).toBe(false);
  });

  it("produces byte-identical archives for an identical bounded snapshot", async () => {
    const root = temporaryDirectory();
    fs.mkdirSync(path.join(root, ".designer", "logs"), { recursive: true });
    fs.writeFileSync(path.join(root, ".designer", "logs", "local.log"), "stable log\n");
    const common = {
      projectRoot: root,
      authorized: true,
      now: () => fixedNow,
      applicationVersion: "1.0.0",
      homeDirectory: "/nonexistent-home",
      pidIsAlive: () => false,
    } as const;
    const first = path.join(root, "first.tar");
    const second = path.join(root, "second.tar");
    await createSupportBundle({ ...common, outputPath: first });
    await createSupportBundle({ ...common, outputPath: second });
    expect(fs.readFileSync(first)).toEqual(fs.readFileSync(second));
    expect(sha256(fs.readFileSync(first))).toBe(sha256(fs.readFileSync(second)));
  });

  it("bounds oversized logs and never follows a symlinked allowlisted log", async () => {
    const root = temporaryDirectory();
    const logs = path.join(root, ".designer", "logs");
    fs.mkdirSync(logs, { recursive: true });
    const lines = Array.from({ length: 20_000 }, (_, index) => `line-${String(index).padStart(5, "0")} ${"x".repeat(64)}`);
    fs.writeFileSync(path.join(logs, "local.log"), `${lines.join("\n")}\n`);
    const secretTarget = path.join(root, "credential-store-dump.txt");
    fs.writeFileSync(secretTarget, "symlink-secret-must-not-be-read\n");
    fs.symlinkSync(secretTarget, path.join(logs, "formaspec-bridge.log"));
    const output = path.join(root, "bounded.tar");
    const created = await createSupportBundle({
      projectRoot: root,
      outputPath: output,
      authorized: true,
      now: () => fixedNow,
    });
    const local = created.manifest.entries.find((entry) => entry.path === "logs/local.log");
    expect(local).toMatchObject({ truncated: true });
    expect(local!.sizeBytes).toBeLessThanOrEqual(SUPPORT_BUNDLE_LIMITS.maxLogOutputBytes);
    expect(created.manifest.entries.some((entry) => entry.path === "logs/formaspec-bridge.log")).toBe(false);
    expect(fs.readFileSync(output).toString("utf8")).not.toContain("symlink-secret-must-not-be-read");
    expect(created.archiveSizeBytes).toBeLessThanOrEqual(SUPPORT_BUNDLE_LIMITS.maxArchiveBytes);
  });

  it("reports unavailable migration/config state without copying unsafe files", () => {
    const root = temporaryDirectory();
    fs.mkdirSync(path.join(root, ".designer", "env"), { recursive: true });
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    fs.symlinkSync(path.join(root, "outside.sqlite"), path.join(root, "data", "designer.sqlite"));
    fs.writeFileSync(path.join(root, ".designer", "env", "server.env"), "X".repeat(SUPPORT_BUNDLE_LIMITS.maxConfigFileBytes + 1));
    const preview = previewSupportBundle({ projectRoot: root, now: () => fixedNow });
    expect(preview.manifest.entries.map((entry) => entry.path)).toEqual([
      "diagnostics/config-keys.json",
      "diagnostics/migration-status.json",
      "diagnostics/runtime-state.json",
      "diagnostics/versions.json",
    ]);
    expect(preview.manifest.totalPayloadBytes).toBeLessThan(SUPPORT_BUNDLE_LIMITS.maxPayloadBytes);
  });

  it("provides a read-only preview and requires --yes in the standalone CLI adapter", async () => {
    const root = temporaryDirectory();
    const io = collectingIo();
    expect(await runSupportBundleCli(["preview", "--json"], {
      projectRoot: root,
      io,
      now: () => fixedNow,
      applicationVersion: "test",
    })).toBe(0);
    const preview = JSON.parse(io.output.at(-1)!) as SupportBundleManifest;
    expect(preview.format).toBe("formaspec-support-bundle");
    expect(fs.existsSync(path.join(root, ".designer"))).toBe(false);

    const unauthorizedOutput = path.join(root, "unauthorized.tar");
    expect(await runSupportBundleCli(["create", unauthorizedOutput], {
      projectRoot: root,
      io,
      now: () => fixedNow,
    })).toBe(1);
    expect(io.errors.at(-1)).toMatch(/explicit --yes/);
    expect(fs.existsSync(unauthorizedOutput)).toBe(false);

    const authorizedOutput = path.join(root, "authorized.tar");
    expect(await runSupportBundleCli(["create", authorizedOutput, "--yes", "--json"], {
      projectRoot: root,
      io,
      now: () => fixedNow,
    })).toBe(0);
    const result = JSON.parse(io.output.at(-1)!) as { bundlePath: string; previewManifestPath: string };
    expect(result.bundlePath).toBe(authorizedOutput);
    expect(fs.existsSync(result.bundlePath)).toBe(true);
    expect(fs.existsSync(result.previewManifestPath)).toBe(true);
  });
});
