import path from "node:path";

import {
  createSupportBundle,
  defaultSupportBundlePath,
  previewSupportBundle,
  type SupportBundleManifest,
  type SupportBundleOptions,
} from "./support-bundle.js";

export interface SupportBundleCliIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

export interface SupportBundleCliDependencies extends Omit<SupportBundleOptions, "projectRoot"> {
  projectRoot: string;
  io: SupportBundleCliIo;
  assumeYes?: boolean;
}

interface ParsedArguments {
  command: "preview" | "create";
  json: boolean;
  authorized: boolean;
  outputPath?: string;
}

function usage(): string {
  return `FormaSpec support bundle

Usage:
  formaspecctl support-bundle preview [--json]
  formaspecctl support-bundle create [OUTPUT.tar] --yes [--json]

Preview is read-only and prints the exact bounded inventory. Creation requires
explicit --yes and also writes OUTPUT.tar.manifest.json for local review.
Databases, assets, backups, environment values, source, and credentials are
never included.`;
}

function parseArguments(rawArguments: readonly string[], assumeYes: boolean): ParsedArguments | "help" {
  if (rawArguments.some((argument) => argument === "--help" || argument === "-h")) return "help";
  const arguments_ = [...rawArguments];
  const command = arguments_.shift();
  if (command !== "preview" && command !== "create") {
    throw new Error("Use: formaspecctl support-bundle preview | support-bundle create [OUTPUT.tar] --yes");
  }
  let json = false;
  let authorized = assumeYes;
  let outputPath: string | undefined;
  for (const argument of arguments_) {
    if (argument === "--json") {
      if (json) throw new Error("--json may be supplied only once.");
      json = true;
      continue;
    }
    if (argument === "--yes") {
      if (authorized) throw new Error("--yes may be supplied only once.");
      authorized = true;
      continue;
    }
    if (argument.startsWith("--")) throw new Error(`Unknown support-bundle option: ${argument}`);
    if (command === "preview") throw new Error("support-bundle preview does not accept an output path.");
    if (outputPath !== undefined) throw new Error("support-bundle create accepts at most one output path.");
    outputPath = argument;
  }
  return {
    command,
    json,
    authorized,
    ...(outputPath === undefined ? {} : { outputPath }),
  };
}

function printPreview(manifest: SupportBundleManifest, io: SupportBundleCliIo): void {
  io.stdout(`FormaSpec support-bundle preview (${manifest.entries.length} files, ${manifest.totalPayloadBytes} payload bytes)`);
  io.stdout(`Created-at value: ${manifest.createdAt}`);
  for (const entry of manifest.entries) {
    io.stdout(`  ${entry.path}  ${entry.sizeBytes} bytes  sha256=${entry.sha256}${entry.truncated ? "  truncated" : ""}${entry.redactionCount > 0 ? `  redactions=${entry.redactionCount}` : ""}`);
  }
  io.stdout("Excluded: databases/WAL, assets/designs, backups/exports, environment values, source/workspace data, and credentials.");
  io.stdout("Review this inventory and the sanitized logs locally before authorizing creation with --yes.");
}

export async function runSupportBundleCli(
  rawArguments: readonly string[],
  dependencies: SupportBundleCliDependencies,
): Promise<number> {
  try {
    const parsed = parseArguments(rawArguments, dependencies.assumeYes ?? false);
    if (parsed === "help") {
      dependencies.io.stdout(usage());
      return 0;
    }
    const fixedNow = dependencies.now?.() ?? new Date();
    const common: SupportBundleOptions = {
      projectRoot: dependencies.projectRoot,
      now: () => fixedNow,
      ...(dependencies.environment === undefined ? {} : { environment: dependencies.environment }),
      ...(dependencies.applicationVersion === undefined ? {} : { applicationVersion: dependencies.applicationVersion }),
      ...(dependencies.homeDirectory === undefined ? {} : { homeDirectory: dependencies.homeDirectory }),
      ...(dependencies.migrationReader === undefined ? {} : { migrationReader: dependencies.migrationReader }),
      ...(dependencies.pidIsAlive === undefined ? {} : { pidIsAlive: dependencies.pidIsAlive }),
    };
    if (parsed.command === "preview") {
      const preview = previewSupportBundle(common);
      if (parsed.json) dependencies.io.stdout(JSON.stringify(preview.manifest));
      else printPreview(preview.manifest, dependencies.io);
      return 0;
    }
    if (!parsed.authorized) {
      throw new Error("support-bundle create is disabled until you review 'support-bundle preview' and rerun with explicit --yes.");
    }
    const outputPath = parsed.outputPath === undefined
      ? defaultSupportBundlePath(dependencies.projectRoot, fixedNow, dependencies.environment)
      : path.resolve(parsed.outputPath);
    const created = await createSupportBundle({
      ...common,
      outputPath,
      authorized: true,
    });
    if (parsed.json) {
      dependencies.io.stdout(JSON.stringify({
        bundlePath: created.bundlePath,
        previewManifestPath: created.previewManifestPath,
        archiveSizeBytes: created.archiveSizeBytes,
        archiveSha256: created.archiveSha256,
        entryCount: created.manifest.entries.length,
      }));
    } else {
      dependencies.io.stdout(`Support bundle created: ${created.bundlePath}`);
      dependencies.io.stdout(`Local preview manifest: ${created.previewManifestPath}`);
      dependencies.io.stdout(`Archive SHA-256: ${created.archiveSha256}`);
      dependencies.io.stdout("Review the sidecar and sanitized log entries before sharing the archive.");
    }
    return 0;
  } catch (error) {
    dependencies.io.stderr(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
