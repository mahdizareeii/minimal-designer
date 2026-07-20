import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import tar from "tar-stream";

import { CLI_SUPPORTED_DATABASE_VERSION, defaultDatabasePath, readMigrationStatus } from "./migrations.js";

export const SUPPORT_BUNDLE_LIMITS = Object.freeze({
  maxConfigFileBytes: 64 * 1024,
  maxConfigKeysPerFile: 256,
  maxStateFileBytes: 16 * 1024,
  maxLogReadBytes: 256 * 1024,
  maxLogOutputBytes: 192 * 1024,
  maxLogLines: 2_000,
  maxPayloadFiles: 16,
  maxPayloadBytes: 512 * 1024,
  maxArchiveBytes: 768 * 1024,
});

const REDACTED = "<redacted>";
const CONFIG_FILES = ["docker.env", "server.env"] as const;
const LOG_FILES = [
  { source: "local.log", archivePath: "logs/local.log" },
  { source: "formaspec-bridge.log", archivePath: "logs/formaspec-bridge.log" },
] as const;

type SupportBundleEntryKind = "diagnostic" | "redacted-log";

export interface SupportBundleEntryManifest {
  path: string;
  kind: SupportBundleEntryKind;
  sizeBytes: number;
  sha256: string;
  truncated: boolean;
  redactionCount: number;
}

export interface SupportBundleManifest {
  format: "formaspec-support-bundle";
  formatVersion: 1;
  createdAt: string;
  generator: "formaspecctl";
  privacy: {
    reviewRequiredBeforeSharing: true;
    included: readonly string[];
    excluded: readonly string[];
  };
  limits: typeof SUPPORT_BUNDLE_LIMITS;
  entries: SupportBundleEntryManifest[];
  totalPayloadBytes: number;
}

export interface SupportBundlePreview {
  manifest: SupportBundleManifest;
}

export interface SupportBundleSidecar {
  format: "formaspec-support-bundle-local-preview";
  formatVersion: 1;
  archiveFilename: string;
  archiveSizeBytes: number;
  archiveSha256: string;
  manifest: SupportBundleManifest;
}

export interface CreatedSupportBundle {
  bundlePath: string;
  previewManifestPath: string;
  archiveSizeBytes: number;
  archiveSha256: string;
  manifest: SupportBundleManifest;
}

export interface SupportBundleOptions {
  projectRoot: string;
  now?: () => Date;
  applicationVersion?: string;
  homeDirectory?: string;
  migrationReader?: typeof readMigrationStatus;
  pidIsAlive?: (pid: number) => boolean | null;
}

export interface CreateSupportBundleOptions extends SupportBundleOptions {
  outputPath: string;
  authorized: boolean;
}

interface PayloadEntry {
  path: string;
  kind: SupportBundleEntryKind;
  data: Buffer;
  truncated: boolean;
  redactionCount: number;
}

interface PreparedSupportBundle {
  manifest: SupportBundleManifest;
  payload: PayloadEntry[];
  manifestData: Buffer;
  checksumsData: Buffer;
}

interface BoundedRead {
  state: "available" | "absent" | "unsafe" | "too-large" | "unreadable";
  data?: Buffer;
}

interface ConfigInventory {
  diagnostic: {
    sources: Array<{
      file: string;
      state: "available" | "absent" | "unsafe" | "too-large" | "unreadable";
      keys: Array<{ key: string; value: typeof REDACTED }>;
      keysTruncated: boolean;
    }>;
  };
  valuesToRedact: string[];
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (typeof value !== "object" || value === null) return value;
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) result[key] = canonicalize(source[key]);
  return result;
}

function canonicalJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(canonicalize(value), null, 2)}\n`, "utf8");
}

function readBoundedRegularFile(filename: string, maxBytes: number): BoundedRead {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filename);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { state: "absent" } : { state: "unreadable" };
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return { state: "unsafe" };
  if (stat.size > maxBytes) return { state: "too-large" };
  try {
    const descriptor = fs.openSync(filename, "r");
    try {
      const opened = fs.fstatSync(descriptor);
      if (!opened.isFile() || opened.size > maxBytes) return { state: opened.size > maxBytes ? "too-large" : "unsafe" };
      const data = Buffer.alloc(opened.size);
      let offset = 0;
      while (offset < data.length) {
        const count = fs.readSync(descriptor, data, offset, data.length - offset, offset);
        if (count === 0) break;
        offset += count;
      }
      if (offset !== data.length) return { state: "unreadable" };
      return { state: "available", data };
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    return { state: "unreadable" };
  }
}

function readLogTail(filename: string): { state: BoundedRead["state"]; data?: Buffer; sourceTruncated: boolean } {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filename);
  } catch (error) {
    return {
      state: (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable",
      sourceTruncated: false,
    };
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return { state: "unsafe", sourceTruncated: false };
  try {
    const descriptor = fs.openSync(filename, "r");
    try {
      const opened = fs.fstatSync(descriptor);
      if (!opened.isFile()) return { state: "unsafe", sourceTruncated: false };
      const readBytes = Math.min(opened.size, SUPPORT_BUNDLE_LIMITS.maxLogReadBytes);
      const start = opened.size - readBytes;
      const data = Buffer.alloc(readBytes);
      let offset = 0;
      while (offset < data.length) {
        const count = fs.readSync(descriptor, data, offset, data.length - offset, start + offset);
        if (count === 0) break;
        offset += count;
      }
      if (offset !== data.length) return { state: "unreadable", sourceTruncated: start > 0 };
      return { state: "available", data, sourceTruncated: start > 0 };
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    return { state: "unreadable", sourceTruncated: false };
  }
}

function packageVersion(): string {
  const filename = fileURLToPath(new URL("../package.json", import.meta.url));
  const read = readBoundedRegularFile(filename, 64 * 1024);
  if (read.state !== "available" || read.data === undefined) return "unknown";
  try {
    const value = JSON.parse(read.data.toString("utf8")) as { version?: unknown };
    return typeof value.version === "string" && /^[0-9A-Za-z.+-]{1,64}$/.test(value.version) ? value.version : "unknown";
  } catch {
    return "unknown";
  }
}

function stripOuterQuotes(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'")))) return value.slice(1, -1);
  return value;
}

function collectConfigInventory(projectRoot: string): ConfigInventory {
  const sources: ConfigInventory["diagnostic"]["sources"] = [];
  const valuesToRedact = new Set<string>();
  for (const file of CONFIG_FILES) {
    const read = readBoundedRegularFile(
      path.join(projectRoot, ".designer", "env", file),
      SUPPORT_BUNDLE_LIMITS.maxConfigFileBytes,
    );
    const keys = new Set<string>();
    let keysTruncated = false;
    if (read.state === "available" && read.data !== undefined) {
      for (const line of read.data.toString("utf8").split(/\r?\n/)) {
        const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
        if (match === null) continue;
        if (keys.size < SUPPORT_BUNDLE_LIMITS.maxConfigKeysPerFile) keys.add(match[1]!);
        else keysTruncated = true;
        const rawValue = stripOuterQuotes(match[2]!.trim());
        // Very short, ordinary values (for example "local" or "server") are
        // too collision-prone for exact replacement. Labeled secret patterns
        // below still redact short values when they appear in a log.
        if (rawValue.length >= 8 && rawValue.length <= 4_096) valuesToRedact.add(rawValue);
      }
    }
    sources.push({
      file,
      state: read.state,
      keys: [...keys].sort().map((key) => ({ key, value: REDACTED })),
      keysTruncated,
    });
  }
  return { diagnostic: { sources }, valuesToRedact: [...valuesToRedact].sort((left, right) => right.length - left.length) };
}

function validPort(value: string): number | null {
  if (!/^\d{1,5}$/.test(value)) return null;
  const port = Number(value);
  return port >= 1 && port <= 65_535 ? port : null;
}

function urlClassification(value: string): "loopback-http" | "loopback-https" | "private-network" | "public-https" | "other" | "invalid" {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "invalid";
  }
  if (url.username || url.password) return "invalid";
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (loopback && url.protocol === "http:") return "loopback-http";
  if (loopback && url.protocol === "https:") return "loopback-https";
  const privateIpv4 = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host);
  if (privateIpv4) return "private-network";
  if (url.protocol === "https:") return "public-https";
  return "other";
}

function defaultPidIsAlive(pid: number): boolean | null {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    return null;
  }
}

function scalarState(projectRoot: string, name: string): { state: BoundedRead["state"]; value?: string } {
  const read = readBoundedRegularFile(
    path.join(projectRoot, ".designer", "run", name),
    SUPPORT_BUNDLE_LIMITS.maxStateFileBytes,
  );
  if (read.state !== "available" || read.data === undefined) return { state: read.state };
  const value = read.data.toString("utf8").trim();
  return { state: "available", value };
}

function collectRuntimeState(projectRoot: string, pidIsAlive: (pid: number) => boolean | null): unknown {
  const modeState = scalarState(projectRoot, "mode");
  const pidState = scalarState(projectRoot, "pid");
  const apiPortState = scalarState(projectRoot, "api-port");
  const webPortState = scalarState(projectRoot, "web-port");
  const urlState = scalarState(projectRoot, "url");
  const environmentFileState = scalarState(projectRoot, "env-file");
  const knownModes = new Set(["local", "dev", "docker", "server"]);
  const parsedPid = pidState.value !== undefined && /^\d+$/.test(pidState.value) ? Number(pidState.value) : null;
  const validPid = parsedPid !== null && Number.isSafeInteger(parsedPid) && parsedPid > 1 ? parsedPid : null;
  const bridgeRead = readBoundedRegularFile(
    path.join(projectRoot, ".designer", "run", "formaspec-bridge.json"),
    SUPPORT_BUNDLE_LIMITS.maxStateFileBytes,
  );
  let bridge: Record<string, unknown> = { state: bridgeRead.state };
  if (bridgeRead.state === "available" && bridgeRead.data !== undefined) {
    try {
      const value = JSON.parse(bridgeRead.data.toString("utf8")) as Record<string, unknown>;
      const bridgePid = Number.isSafeInteger(value.pid) && (value.pid as number) > 1 ? value.pid as number : null;
      bridge = {
        state: "valid",
        schemaVersion: Number.isSafeInteger(value.schemaVersion) ? value.schemaVersion : null,
        pidRecorded: bridgePid !== null,
        processAlive: bridgePid === null ? null : pidIsAlive(bridgePid),
        urlClassification: typeof value.url === "string" ? urlClassification(value.url) : "invalid",
        instanceIdRecorded: typeof value.instanceId === "string" && value.instanceId.length > 0,
      };
    } catch {
      bridge = { state: "invalid" };
    }
  }
  let launcherLockPresent = false;
  try {
    const lock = fs.lstatSync(path.join(projectRoot, ".designer", "run", "launcher.lock"));
    launcherLockPresent = lock.isDirectory() && !lock.isSymbolicLink();
  } catch {
    launcherLockPresent = false;
  }
  return {
    launcher: {
      modeState: modeState.state,
      mode: modeState.value !== undefined && knownModes.has(modeState.value) ? modeState.value : null,
      modeValid: modeState.value !== undefined && knownModes.has(modeState.value),
      pidRecorded: validPid !== null,
      processAlive: validPid === null ? null : pidIsAlive(validPid),
      apiPort: apiPortState.value === undefined ? null : validPort(apiPortState.value),
      webPort: webPortState.value === undefined ? null : validPort(webPortState.value),
      serviceUrlRecorded: urlState.value !== undefined && urlState.value.length > 0,
      serviceUrlClassification: urlState.value === undefined || urlState.value.length === 0
        ? null
        : urlClassification(urlState.value),
      environmentFileRecorded: environmentFileState.value !== undefined && environmentFileState.value.length > 0,
      launcherLockPresent,
    },
    bridge,
  };
}

function collectMigrationStatus(projectRoot: string, migrationReader: typeof readMigrationStatus): unknown {
  const database = defaultDatabasePath(projectRoot);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(database);
  } catch (error) {
    return {
      available: false,
      reason: (error as NodeJS.ErrnoException).code === "ENOENT" ? "database-not-found" : "database-unreadable",
      supportedVersion: CLI_SUPPORTED_DATABASE_VERSION,
    };
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return { available: false, reason: "database-unsafe", supportedVersion: CLI_SUPPORTED_DATABASE_VERSION };
  }
  try {
    const status = migrationReader(database);
    return {
      available: true,
      latestAppliedVersion: status.latestAppliedVersion,
      supportedVersion: status.supportedVersion,
      state: status.state,
      appliedMigrationCount: status.migrations.length,
    };
  } catch {
    return { available: false, reason: "ledger-unreadable-or-invalid", supportedVersion: CLI_SUPPORTED_DATABASE_VERSION };
  }
}

function replaceAllCount(value: string, search: string, replacement: string): { value: string; count: number } {
  if (search.length === 0 || !value.includes(search)) return { value, count: 0 };
  const parts = value.split(search);
  return { value: parts.join(replacement), count: parts.length - 1 };
}

function regexReplaceCount(
  value: string,
  pattern: RegExp,
  replacement: string | ((substring: string, ...arguments_: string[]) => string),
): { value: string; count: number } {
  let count = 0;
  const replaced = value.replace(pattern, (...arguments_: [string, ...string[]]) => {
    count += 1;
    if (typeof replacement === "string") return replacement;
    return replacement(...arguments_);
  });
  return { value: replaced, count };
}

function stripUnsafeControlCharacters(value: string): string {
  const withoutAnsi = value
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
  let result = "";
  for (const character of withoutAnsi) {
    const code = character.codePointAt(0)!;
    if (character === "\n" || character === "\t" || (code >= 0x20 && code !== 0x7f)) result += character;
  }
  return result;
}

export function redactSupportLog(
  input: string,
  options: { projectRoot: string; homeDirectory: string; explicitValues?: readonly string[] },
): { text: string; redactionCount: number } {
  let text = stripUnsafeControlCharacters(input.replaceAll("\r\n", "\n").replaceAll("\r", "\n"));
  let redactionCount = 0;
  const exactValues = [options.projectRoot, options.homeDirectory, ...(options.explicitValues ?? [])]
    .filter((value, index, all) => value.length >= 4 && all.indexOf(value) === index)
    .sort((left, right) => right.length - left.length);
  for (const exactValue of exactValues) {
    const replacement = exactValue === options.projectRoot
      ? "<PROJECT_ROOT>"
      : exactValue === options.homeDirectory ? "<HOME>" : REDACTED;
    const result = replaceAllCount(text, exactValue, replacement);
    text = result.value;
    redactionCount += result.count;
    if (path.sep === "\\") {
      const normalized = exactValue.replaceAll("\\", "/");
      const normalizedResult = replaceAllCount(text, normalized, replacement);
      text = normalizedResult.value;
      redactionCount += normalizedResult.count;
    }
  }
  const patterns: Array<[RegExp, string | ((substring: string, ...arguments_: string[]) => string)]> = [
    [/-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/g, REDACTED],
    [/(\b(?:authorization|proxy-authorization|cookie|set-cookie)\b\s*[:=]\s*)[^\n]+/gi, (_match, prefix) => `${prefix}${REDACTED}`],
    [/("(?:access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|password|passwd|secret|token|credential|private[_-]?key|mcp[_-]?token|instance[_-]?id)"\s*:\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,}&\r\n]+)/gi, (_match, prefix) => `${prefix}"${REDACTED}"`],
    [/(\b(?:access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|password|passwd|secret|token|credential|private[_-]?key|mcp[_-]?token|instance[_-]?id)\b\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&\r\n]+)/gi, (_match, prefix) => `${prefix}${REDACTED}`],
    [/\bhttps?:\/\/[^\s"'<>]+/gi, "<redacted-url>"],
    [/([?&](?:access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|password|secret|token|credential)=)[^&#\s]+/gi, (_match, prefix) => `${prefix}${REDACTED}`],
    [/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+(?::[^/\s@]*)?@/gi, (_match, prefix) => `${prefix}${REDACTED}@`],
    [/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, REDACTED],
    [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED],
    [/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g, REDACTED],
  ];
  for (const [pattern, replacement] of patterns) {
    const result = regexReplaceCount(text, pattern, replacement);
    text = result.value;
    redactionCount += result.count;
  }
  return { text, redactionCount };
}

function limitSanitizedLog(text: string): { text: string; truncated: boolean } {
  let truncated = false;
  let lines = text.split("\n");
  if (lines.length > SUPPORT_BUNDLE_LIMITS.maxLogLines) {
    lines = lines.slice(-SUPPORT_BUNDLE_LIMITS.maxLogLines);
    truncated = true;
  }
  text = lines.join("\n");
  let data = Buffer.from(text, "utf8");
  if (data.length > SUPPORT_BUNDLE_LIMITS.maxLogOutputBytes) {
    data = data.subarray(data.length - SUPPORT_BUNDLE_LIMITS.maxLogOutputBytes);
    text = data.toString("utf8");
    const newline = text.indexOf("\n");
    if (newline >= 0) text = text.slice(newline + 1);
    truncated = true;
  }
  if (text.length > 0 && !text.endsWith("\n")) text += "\n";
  return { text, truncated };
}

function collectLogEntries(projectRoot: string, homeDirectory: string, explicitValues: readonly string[]): PayloadEntry[] {
  const entries: PayloadEntry[] = [];
  for (const log of LOG_FILES) {
    const read = readLogTail(path.join(projectRoot, ".designer", "logs", log.source));
    if (read.state !== "available" || read.data === undefined) continue;
    let source = read.data.toString("utf8");
    if (read.sourceTruncated) {
      const firstLineEnd = source.indexOf("\n");
      source = firstLineEnd >= 0 ? source.slice(firstLineEnd + 1) : "";
    }
    const redacted = redactSupportLog(source, { projectRoot, homeDirectory, explicitValues });
    const limited = limitSanitizedLog(redacted.text);
    entries.push({
      path: log.archivePath,
      kind: "redacted-log",
      data: Buffer.from(limited.text, "utf8"),
      truncated: read.sourceTruncated || limited.truncated,
      redactionCount: redacted.redactionCount,
    });
  }
  return entries;
}

function versionsDiagnostic(applicationVersion: string): unknown {
  return {
    formaspecctl: applicationVersion,
    supportBundleFormat: 1,
    databaseVersionSupported: CLI_SUPPORTED_DATABASE_VERSION,
    runtime: { name: "node", version: process.version },
    operatingSystem: { platform: process.platform, architecture: process.arch, release: os.release() },
  };
}

function diagnosticEntry(pathname: string, value: unknown): PayloadEntry {
  return {
    path: pathname,
    kind: "diagnostic",
    data: canonicalJson(value),
    truncated: false,
    redactionCount: 0,
  };
}

function assertPayloadBounds(payload: readonly PayloadEntry[]): void {
  if (payload.length > SUPPORT_BUNDLE_LIMITS.maxPayloadFiles) {
    throw new Error("Support bundle exceeds the payload file-count limit.");
  }
  const paths = new Set<string>();
  let total = 0;
  for (const entry of payload) {
    if (!/^(?:diagnostics|logs)\/[A-Za-z0-9._-]+$/.test(entry.path) || paths.has(entry.path)) {
      throw new Error("Support bundle contains an invalid or duplicate payload path.");
    }
    paths.add(entry.path);
    total += entry.data.length;
    if (total > SUPPORT_BUNDLE_LIMITS.maxPayloadBytes) {
      throw new Error("Support bundle exceeds the payload byte limit.");
    }
  }
}

function prepareSupportBundle(options: SupportBundleOptions): PreparedSupportBundle {
  const projectRoot = path.resolve(options.projectRoot);
  const now = options.now?.() ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("Support bundle creation time is invalid.");
  const applicationVersion = options.applicationVersion ?? packageVersion();
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const config = collectConfigInventory(projectRoot);
  const pidIsAlive = options.pidIsAlive ?? defaultPidIsAlive;
  const payload: PayloadEntry[] = [
    diagnosticEntry("diagnostics/versions.json", versionsDiagnostic(applicationVersion)),
    diagnosticEntry(
      "diagnostics/migration-status.json",
      collectMigrationStatus(projectRoot, options.migrationReader ?? readMigrationStatus),
    ),
    diagnosticEntry("diagnostics/runtime-state.json", collectRuntimeState(projectRoot, pidIsAlive)),
    diagnosticEntry("diagnostics/config-keys.json", config.diagnostic),
    ...collectLogEntries(projectRoot, homeDirectory, config.valuesToRedact),
  ].sort((left, right) => left.path.localeCompare(right.path));
  assertPayloadBounds(payload);
  const entries = payload.map((entry): SupportBundleEntryManifest => ({
    path: entry.path,
    kind: entry.kind,
    sizeBytes: entry.data.length,
    sha256: sha256(entry.data),
    truncated: entry.truncated,
    redactionCount: entry.redactionCount,
  }));
  const totalPayloadBytes = entries.reduce((total, entry) => total + entry.sizeBytes, 0);
  const manifest: SupportBundleManifest = {
    format: "formaspec-support-bundle",
    formatVersion: 1,
    createdAt: now.toISOString(),
    generator: "formaspecctl",
    privacy: {
      reviewRequiredBeforeSharing: true,
      included: [
        "bounded FormaSpec/runtime version metadata",
        "read-only migration status when the source-local ledger is readable",
        "sanitized launcher and local-bridge state metadata",
        "configuration key names with every value redacted",
        "bounded tails of allowlisted logs after secret and private-path redaction",
      ],
      excluded: [
        "databases and WAL files",
        "assets and design documents",
        "backups and portable exports",
        "environment values and environment dumps",
        "repository source and workspace inventories",
        "credentials, tokens, grants, authorization headers, and credential-store data",
      ],
    },
    limits: SUPPORT_BUNDLE_LIMITS,
    entries,
    totalPayloadBytes,
  };
  const manifestData = canonicalJson(manifest);
  const checksums = [
    ...entries.map((entry) => `${entry.sha256}  ${entry.path}`),
    `${sha256(manifestData)}  support-manifest.json`,
  ].sort().join("\n");
  return { manifest, payload, manifestData, checksumsData: Buffer.from(`${checksums}\n`, "utf8") };
}

export function previewSupportBundle(options: SupportBundleOptions): SupportBundlePreview {
  return { manifest: prepareSupportBundle(options).manifest };
}

async function archiveBuffer(prepared: PreparedSupportBundle): Promise<Buffer> {
  const archiveEntries = [
    ...prepared.payload.map((entry) => ({ path: entry.path, data: entry.data })),
    { path: "checksums.sha256", data: prepared.checksumsData },
    { path: "support-manifest.json", data: prepared.manifestData },
  ].sort((left, right) => left.path.localeCompare(right.path));
  if (archiveEntries.length > SUPPORT_BUNDLE_LIMITS.maxPayloadFiles + 2) {
    throw new Error("Support bundle exceeds the archive file-count limit.");
  }
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  let archiveBytes = 0;
  const completed = new Promise<void>((resolve, reject) => {
    pack.on("data", (chunk: Buffer | Uint8Array) => {
      const data = Buffer.from(chunk);
      archiveBytes += data.length;
      if (archiveBytes > SUPPORT_BUNDLE_LIMITS.maxArchiveBytes) {
        reject(new Error("Support bundle exceeds the archive byte limit."));
        pack.destroy();
        return;
      }
      chunks.push(data);
    });
    pack.once("end", resolve);
    pack.once("error", reject);
  });
  for (const entry of archiveEntries) {
    await new Promise<void>((resolve, reject) => {
      pack.entry({
        name: entry.path,
        type: "file",
        size: entry.data.length,
        mode: 0o600,
        uid: 0,
        gid: 0,
        uname: "",
        gname: "",
        mtime: new Date(0),
      }, entry.data, (error) => error ? reject(error) : resolve());
    });
  }
  pack.finalize();
  await completed;
  return Buffer.concat(chunks);
}

function writeExclusive(filename: string, data: Buffer): void {
  fs.writeFileSync(filename, data, { flag: "wx", mode: 0o600 });
}

export async function createSupportBundle(options: CreateSupportBundleOptions): Promise<CreatedSupportBundle> {
  if (options.authorized !== true) {
    throw new Error("Support bundle creation requires explicit --yes authorization after reviewing the preview manifest.");
  }
  const prepared = prepareSupportBundle(options);
  const archive = await archiveBuffer(prepared);
  const bundlePath = path.resolve(options.outputPath);
  const previewManifestPath = `${bundlePath}.manifest.json`;
  const parent = path.dirname(bundlePath);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error("Support bundle output parent must be a real directory.");
  }
  const archiveSha256 = sha256(archive);
  const sidecar: SupportBundleSidecar = {
    format: "formaspec-support-bundle-local-preview",
    formatVersion: 1,
    archiveFilename: path.basename(bundlePath),
    archiveSizeBytes: archive.length,
    archiveSha256,
    manifest: prepared.manifest,
  };
  const sidecarData = canonicalJson(sidecar);
  let archiveWritten = false;
  try {
    writeExclusive(bundlePath, archive);
    archiveWritten = true;
    writeExclusive(previewManifestPath, sidecarData);
  } catch (error) {
    if (archiveWritten) fs.rmSync(bundlePath, { force: true });
    throw error;
  }
  return {
    bundlePath,
    previewManifestPath,
    archiveSizeBytes: archive.length,
    archiveSha256,
    manifest: prepared.manifest,
  };
}

export function defaultSupportBundlePath(projectRoot: string, now = new Date()): string {
  if (!Number.isFinite(now.getTime())) throw new Error("Support bundle creation time is invalid.");
  const timestamp = now.toISOString().replaceAll(/[:.]/g, "-");
  return path.join(path.resolve(projectRoot), ".designer", "support-bundles", `formaspec-support-${timestamp}.tar`);
}
