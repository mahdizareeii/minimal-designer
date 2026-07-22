import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  assertWindowsMsiVersion,
  assertWindowsPackageArchitecture,
  assertWindowsRelativePath,
  WINDOWS_INSTALL_MANIFEST_RELATIVE_PATH,
  WINDOWS_PROTOCOL_HANDLER_RELATIVE_PATH,
  WINDOWS_SERVICE_CONFIGURATION_RELATIVE_PATH,
  WINDOWS_SERVICE_HOST_RELATIVE_PATH,
  WINDOWS_SERVICE_LICENSE_RELATIVE_PATH,
  WINDOWS_SERVICE_PROVENANCE_RELATIVE_PATH,
  windowsServiceConfiguration,
  windowsProtocolHandlerSource,
  windowsWixSource,
  type WindowsPackageArchitecture,
  type WindowsPayloadFile,
} from "./windows-layout.js";
import { inspectManagedCodexAssets } from "./codex-assets.js";
import {
  runPackageCommand,
  spawnPackageCommandRunner,
  type PackageCommandRunner,
} from "./package-command.js";

const MAX_WINDOWS_PAYLOAD_FILES = 100_000;
const MAX_WINDOWS_PAYLOAD_FILE_BYTES = 1024 * 1024 * 1024;
const MAX_WINDOWS_PAYLOAD_BYTES = 1_800_000_000;
const MAX_PROVENANCE_BYTES = 64 * 1024;
const MAX_LICENSE_BYTES = 2 * 1024 * 1024;
const MIN_WINDOWS_SOURCE_DATE_EPOCH = 315_532_800;
const MSI_COMPOUND_FILE_HEADER = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const SEMANTIC_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const SHA256 = /^[a-f0-9]{64}$/;

const REQUIRED_APPLICATION_FILES = [
  "runtime/node.exe",
  "app/designer",
  "app/pnpm-workspace.yaml",
  "app/apps/server/dist/index.js",
  "app/apps/server/dist/renderer-worker.js",
  "app/apps/web/dist/index.html",
  "app/apps/cli/dist/index.js",
  "app/apps/local-bridge/dist/index.js",
  "app/apps/workspace-bridge/dist/cli.js",
  "app/packages/core/dist/index.js",
] as const;

const RESERVED_STAGING_PATHS = [
  "service",
  WINDOWS_INSTALL_MANIFEST_RELATIVE_PATH,
] as const;

export const WINDOWS_SERVICE_HOST_PROVENANCE_FORMAT = "formaspec-windows-service-host-provenance";
export const WINDOWS_SERVICE_HOST_CONTRACT = "formaspec-windows-service-host-v1";
export const WINDOWS_WIX_PROVENANCE_FORMAT = "formaspec-wix-toolset-provenance";

const REQUIRED_SERVICE_HOST_CAPABILITIES = [
  "api-service",
  "open-editor",
  "protocol-handler",
  "renderer-service",
] as const;

const PERMISSIVE_SERVICE_HOST_LICENSES = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MIT",
]);

export interface WindowsServiceHostProvenance {
  format: typeof WINDOWS_SERVICE_HOST_PROVENANCE_FORMAT;
  formatVersion: 1;
  component: "FormaSpec Windows Service Host";
  version: string;
  architecture: WindowsPackageArchitecture;
  contract: typeof WINDOWS_SERVICE_HOST_CONTRACT;
  capabilities: string[];
  executableSha256: string;
  executableSizeBytes: number;
  licenseSpdx: string;
  licenseSha256: string;
  licenseSizeBytes: number;
  sourceUrl: string;
  sourceSha256: string;
}

export interface WindowsServiceHostInput {
  executable: string;
  provenance: string;
  license: string;
}

export interface VerifiedWindowsServiceHost {
  provenance: WindowsServiceHostProvenance;
  executableSha256: string;
  executableSizeBytes: number;
}

export interface WindowsPayloadManifest {
  format: "formaspec-windows-payload";
  formatVersion: 1;
  productVersion: string;
  architecture: WindowsPackageArchitecture;
  sourceDateEpoch: number;
  serviceHost: {
    component: string;
    version: string;
    contract: string;
    executableSha256: string;
    licenseSpdx: string;
    sourceUrl: string;
    sourceSha256: string;
  };
  files: WindowsPayloadFile[];
}

export interface StageWindowsPayloadOptions {
  applicationPayloadRoot: string;
  payloadRoot: string;
  serviceHost: WindowsServiceHostInput;
  version: string;
  architecture: string;
  sourceDateEpoch?: number | string;
}

export interface WixToolsetProvenance {
  format: typeof WINDOWS_WIX_PROVENANCE_FORMAT;
  formatVersion: 1;
  component: "WiX Toolset";
  version: string;
  executableSha256: string;
  executableSizeBytes: number;
  licenseSpdx: "MS-RL";
  sourceUrl: string;
  sourceSha256: string;
}

export interface WindowsMsiBuildOptions {
  payloadRoot: string;
  outputDirectory: string;
  version: string;
  architecture: string;
  sourceDateEpoch?: number | string;
  wixExecutable: string;
  wixProvenance: string;
  commandRunner?: PackageCommandRunner;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], description: string): void {
  const actual = Object.keys(value).sort(compareText);
  const wanted = [...expected].sort(compareText);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${description} contains missing or unsupported fields.`);
  }
}

function requireAbsolutePath(value: string, description: string): string {
  if (!path.isAbsolute(value) || value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new Error(`${description} must be an absolute path without control characters.`);
  }
  return path.resolve(value);
}

function requireRegularFile(value: string, description: string): fs.Stats {
  const target = requireAbsolutePath(value, description);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    throw new Error(`${description} is unavailable: ${target}`, { cause: error });
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${description} must be a regular non-symlink file: ${target}`);
  return stat;
}

function requireDirectory(value: string, description: string): fs.Stats {
  const target = requireAbsolutePath(value, description);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    throw new Error(`${description} is unavailable: ${target}`, { cause: error });
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${description} must be a regular non-symlink directory: ${target}`);
  return stat;
}

function readBoundedFile(filename: string, maximumBytes: number, description: string): Buffer {
  const stat = requireRegularFile(filename, description);
  if (stat.size < 1 || stat.size > maximumBytes) {
    throw new Error(`${description} must be non-empty and no larger than ${maximumBytes} bytes.`);
  }
  return fs.readFileSync(filename);
}

export function sha256WindowsFile(filename: string): string {
  const stat = requireRegularFile(filename, "Hash input");
  const hash = createHash("sha256");
  const descriptor = fs.openSync(filename, "r");
  const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, stat.size)));
  try {
    let offset = 0;
    while (offset < stat.size) {
      const length = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
      if (length <= 0) throw new Error(`Could not read complete hash input: ${filename}`);
      hash.update(buffer.subarray(0, length));
      offset += length;
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function parseJsonFile(filename: string, description: string): { raw: string; value: unknown } {
  const raw = readBoundedFile(filename, MAX_PROVENANCE_BYTES, description).toString("utf8");
  try {
    return { raw, value: JSON.parse(raw) as unknown };
  } catch (error) {
    throw new Error(`${description} is malformed JSON.`, { cause: error });
  }
}

function assertSafeHttpsSourceUrl(value: unknown, description: string): string {
  if (typeof value !== "string" || value.length > 2_048) throw new Error(`${description} source URL is invalid.`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new Error(`${description} source URL is invalid.`, { cause: error });
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || !parsed.hostname) {
    throw new Error(`${description} source URL must be credential-free HTTPS.`);
  }
  return value;
}

function assertSha256(value: unknown, description: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${description} must be a lowercase SHA-256 digest.`);
  return value;
}

function assertSafeVersion(value: unknown, description: string): string {
  if (typeof value !== "string" || !SEMANTIC_VERSION.test(value)) throw new Error(`${description} must be a semantic version.`);
  return value;
}

function assertPositiveSafeSize(value: unknown, description: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 1 || value > maximum) {
    throw new Error(`${description} is invalid.`);
  }
  return value;
}

export function windowsPeArchitecture(filename: string): WindowsPackageArchitecture {
  const stat = requireRegularFile(filename, "Windows executable");
  if (stat.size < 134) throw new Error(`Windows executable is too small to contain a PE header: ${filename}`);
  const descriptor = fs.openSync(filename, "r");
  try {
    const dos = Buffer.alloc(64);
    if (fs.readSync(descriptor, dos, 0, dos.length, 0) !== dos.length || dos.toString("ascii", 0, 2) !== "MZ") {
      throw new Error(`Windows executable does not contain an MZ header: ${filename}`);
    }
    const peOffset = dos.readUInt32LE(0x3c);
    if (peOffset < 64 || peOffset > stat.size - 6 || peOffset > 16 * 1024 * 1024) {
      throw new Error(`Windows executable PE header offset is invalid: ${filename}`);
    }
    const coff = Buffer.alloc(6);
    if (fs.readSync(descriptor, coff, 0, coff.length, peOffset) !== coff.length
      || coff.toString("binary", 0, 4) !== "PE\0\0") {
      throw new Error(`Windows executable does not contain a PE signature: ${filename}`);
    }
    const machine = coff.readUInt16LE(4);
    if (machine === 0x8664) return "x64";
    if (machine === 0xaa64) return "arm64";
    throw new Error(`Windows executable uses unsupported PE machine type 0x${machine.toString(16)}: ${filename}`);
  } finally {
    fs.closeSync(descriptor);
  }
}

function parseServiceHostProvenance(value: unknown): WindowsServiceHostProvenance {
  if (!isRecord(value)) throw new Error("Windows service-host provenance must be an object.");
  assertExactKeys(value, [
    "format",
    "formatVersion",
    "component",
    "version",
    "architecture",
    "contract",
    "capabilities",
    "executableSha256",
    "executableSizeBytes",
    "licenseSpdx",
    "licenseSha256",
    "licenseSizeBytes",
    "sourceUrl",
    "sourceSha256",
  ], "Windows service-host provenance");
  if (value.format !== WINDOWS_SERVICE_HOST_PROVENANCE_FORMAT || value.formatVersion !== 1
    || value.component !== "FormaSpec Windows Service Host" || value.contract !== WINDOWS_SERVICE_HOST_CONTRACT) {
    throw new Error("Windows service-host provenance identity or contract is unsupported.");
  }
  const version = assertSafeVersion(value.version, "Windows service-host version");
  const architecture = assertWindowsPackageArchitecture(String(value.architecture));
  if (!Array.isArray(value.capabilities) || value.capabilities.some((item) => typeof item !== "string")) {
    throw new Error("Windows service-host capabilities are malformed.");
  }
  const capabilities = [...value.capabilities].sort(compareText);
  if (capabilities.length !== REQUIRED_SERVICE_HOST_CAPABILITIES.length
    || capabilities.some((capability, index) => capability !== REQUIRED_SERVICE_HOST_CAPABILITIES[index])) {
    throw new Error(`Windows service host must declare exactly: ${REQUIRED_SERVICE_HOST_CAPABILITIES.join(", ")}.`);
  }
  if (typeof value.licenseSpdx !== "string" || !PERMISSIVE_SERVICE_HOST_LICENSES.has(value.licenseSpdx)) {
    throw new Error("Windows service host must use an approved permissive SPDX license.");
  }
  return {
    format: WINDOWS_SERVICE_HOST_PROVENANCE_FORMAT,
    formatVersion: 1,
    component: "FormaSpec Windows Service Host",
    version,
    architecture,
    contract: WINDOWS_SERVICE_HOST_CONTRACT,
    capabilities,
    executableSha256: assertSha256(value.executableSha256, "Windows service-host executable hash"),
    executableSizeBytes: assertPositiveSafeSize(value.executableSizeBytes, "Windows service-host executable size", MAX_WINDOWS_PAYLOAD_FILE_BYTES),
    licenseSpdx: value.licenseSpdx,
    licenseSha256: assertSha256(value.licenseSha256, "Windows service-host license hash"),
    licenseSizeBytes: assertPositiveSafeSize(value.licenseSizeBytes, "Windows service-host license size", MAX_LICENSE_BYTES),
    sourceUrl: assertSafeHttpsSourceUrl(value.sourceUrl, "Windows service host"),
    sourceSha256: assertSha256(value.sourceSha256, "Windows service-host source hash"),
  };
}

export function verifyWindowsServiceHost(
  input: WindowsServiceHostInput,
  expectedArchitecture: WindowsPackageArchitecture,
): VerifiedWindowsServiceHost {
  const executable = requireAbsolutePath(input.executable, "Windows service-host executable");
  if (path.extname(executable).toLowerCase() !== ".exe") throw new Error("Windows service-host executable must use the .exe extension.");
  const executableStat = requireRegularFile(executable, "Windows service-host executable");
  const provenance = parseServiceHostProvenance(parseJsonFile(input.provenance, "Windows service-host provenance").value);
  const license = readBoundedFile(input.license, MAX_LICENSE_BYTES, "Windows service-host license");
  const executableHash = sha256WindowsFile(executable);
  const licenseHash = createHash("sha256").update(license).digest("hex");
  if (provenance.architecture !== expectedArchitecture || windowsPeArchitecture(executable) !== expectedArchitecture) {
    throw new Error(`Windows service host does not match requested ${expectedArchitecture} architecture.`);
  }
  if (provenance.executableSizeBytes !== executableStat.size || provenance.executableSha256 !== executableHash) {
    throw new Error("Windows service-host executable failed its exact provenance integrity check.");
  }
  if (provenance.licenseSizeBytes !== license.length || provenance.licenseSha256 !== licenseHash) {
    throw new Error("Windows service-host license failed its exact provenance integrity check.");
  }
  return { provenance, executableSha256: executableHash, executableSizeBytes: executableStat.size };
}

export function normalizeWindowsSourceDateEpoch(value: number | string | undefined): number {
  const parsed = value === undefined || value === "" ? MIN_WINDOWS_SOURCE_DATE_EPOCH : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < MIN_WINDOWS_SOURCE_DATE_EPOCH || parsed > 4_102_444_800) {
    throw new Error("Windows SOURCE_DATE_EPOCH must be a whole Unix timestamp between 315532800 and 4102444800 (CAB timestamps begin in 1980).");
  }
  return parsed;
}

function copyRegularTree(sourceRoot: string, destinationRoot: string): void {
  const foldedPaths = new Set<string>();
  const visit = (source: string, destination: string, relative: string): void => {
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink()) throw new Error(`Windows payload cannot contain symlinks or junction-like links: ${relative || "."}`);
    if (stat.isDirectory()) {
      fs.mkdirSync(destination, { recursive: false });
      for (const entry of fs.readdirSync(source).sort(compareText)) {
        const childRelative = relative ? `${relative}/${entry}` : entry;
        assertWindowsRelativePath(childRelative);
        const folded = childRelative.toLowerCase();
        if (foldedPaths.has(folded)) throw new Error(`Windows payload contains a case-insensitive path collision: ${childRelative}`);
        foldedPaths.add(folded);
        visit(path.join(source, entry), path.join(destination, entry), childRelative);
      }
      return;
    }
    if (!stat.isFile()) throw new Error(`Windows payload contains an unsupported filesystem entry: ${relative}`);
    if (stat.size > MAX_WINDOWS_PAYLOAD_FILE_BYTES) throw new Error(`Windows payload file exceeds the per-file limit: ${relative}`);
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  };
  visit(sourceRoot, destinationRoot, "");
}

function collectWindowsPayloadFiles(root: string, excluded = new Set<string>()): WindowsPayloadFile[] {
  requireDirectory(root, "Windows payload root");
  const files: WindowsPayloadFile[] = [];
  const foldedPaths = new Set<string>();
  let totalBytes = 0;
  const visit = (directory: string, relativeDirectory: string): void => {
    for (const entry of fs.readdirSync(directory).sort(compareText)) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry}` : entry;
      assertWindowsRelativePath(relativePath);
      const absolute = path.join(directory, entry);
      const stat = fs.lstatSync(absolute);
      const folded = relativePath.toLowerCase();
      if (foldedPaths.has(folded)) throw new Error(`Windows payload contains a case-insensitive path collision: ${relativePath}`);
      foldedPaths.add(folded);
      if (stat.isSymbolicLink()) throw new Error(`Windows payload cannot contain symlinks or junction-like links: ${relativePath}`);
      if (stat.isDirectory()) {
        visit(absolute, relativePath);
        continue;
      }
      if (!stat.isFile()) throw new Error(`Windows payload contains an unsupported filesystem entry: ${relativePath}`);
      if (excluded.has(relativePath)) continue;
      if (stat.size > MAX_WINDOWS_PAYLOAD_FILE_BYTES) throw new Error(`Windows payload file exceeds the per-file limit: ${relativePath}`);
      totalBytes += stat.size;
      if (files.length + 1 > MAX_WINDOWS_PAYLOAD_FILES || totalBytes > MAX_WINDOWS_PAYLOAD_BYTES) {
        throw new Error("Windows payload exceeds its bounded file-count or total-size limit.");
      }
      files.push({ relativePath, size: stat.size, sha256: sha256WindowsFile(absolute) });
    }
  };
  visit(root, "");
  return files.sort((left, right) => compareText(left.relativePath, right.relativePath));
}

function assertRequiredApplicationPayload(payloadRoot: string, architecture: WindowsPackageArchitecture): void {
  for (const relativePath of REQUIRED_APPLICATION_FILES) {
    requireRegularFile(path.join(payloadRoot, ...relativePath.split("/")), `Required Windows payload file ${relativePath}`);
  }
  inspectManagedCodexAssets(path.join(payloadRoot, "app/apps/cli/assets"));
  if (windowsPeArchitecture(path.join(payloadRoot, "runtime", "node.exe")) !== architecture) {
    throw new Error(`Bundled Windows Node.js runtime does not match requested ${architecture} architecture.`);
  }
  const files = collectWindowsPayloadFiles(payloadRoot);
  const browserExecutables = files.filter((file) => file.relativePath.toLowerCase().startsWith("runtime/ms-playwright/")
    && file.relativePath.toLowerCase().endsWith("/headless_shell.exe"));
  if (browserExecutables.length !== 1) {
    throw new Error("Windows payload must contain exactly one pinned Chromium headless_shell.exe runtime.");
  }
  if (files.some((file) => /(?:^|\/)(?:ffmpeg|firefox|webkit)(?:[./_-]|$)/i.test(file.relativePath))) {
    throw new Error("Windows payload contains an unused or disallowed browser runtime.");
  }
  const browserExecutable = path.join(payloadRoot, ...browserExecutables[0]!.relativePath.split("/"));
  if (windowsPeArchitecture(browserExecutable) !== architecture) {
    throw new Error(`Bundled Chromium headless shell does not match requested ${architecture} architecture.`);
  }
}

function writeFile(target: string, contents: string | Buffer): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents, { flag: "wx" });
}

function canonicalManifest(manifest: WindowsPayloadManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function manifestFor(
  version: string,
  architecture: WindowsPackageArchitecture,
  sourceDateEpoch: number,
  serviceHost: VerifiedWindowsServiceHost,
  files: WindowsPayloadFile[],
): WindowsPayloadManifest {
  return {
    format: "formaspec-windows-payload",
    formatVersion: 1,
    productVersion: version,
    architecture,
    sourceDateEpoch,
    serviceHost: {
      component: serviceHost.provenance.component,
      version: serviceHost.provenance.version,
      contract: serviceHost.provenance.contract,
      executableSha256: serviceHost.provenance.executableSha256,
      licenseSpdx: serviceHost.provenance.licenseSpdx,
      sourceUrl: serviceHost.provenance.sourceUrl,
      sourceSha256: serviceHost.provenance.sourceSha256,
    },
    files,
  };
}

export function normalizeWindowsPayload(root: string, sourceDateEpoch: number): void {
  const timestamp = normalizeWindowsSourceDateEpoch(sourceDateEpoch);
  const visit = (target: string): void => {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error(`Windows payload cannot contain symlinks or junction-like links: ${target}`);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(target).sort(compareText)) visit(path.join(target, entry));
      fs.utimesSync(target, timestamp, timestamp);
      return;
    }
    if (!stat.isFile()) throw new Error(`Windows payload contains an unsupported filesystem entry: ${target}`);
    fs.utimesSync(target, timestamp, timestamp);
  };
  visit(root);
}

export function stageWindowsPayload(options: StageWindowsPayloadOptions): WindowsPayloadManifest {
  const version = assertWindowsMsiVersion(options.version);
  const architecture = assertWindowsPackageArchitecture(options.architecture);
  const sourceDateEpoch = normalizeWindowsSourceDateEpoch(options.sourceDateEpoch);
  const applicationRoot = requireAbsolutePath(options.applicationPayloadRoot, "Prepared Windows application payload");
  const payloadRoot = requireAbsolutePath(options.payloadRoot, "Windows staging payload root");
  requireDirectory(applicationRoot, "Prepared Windows application payload");
  if (fs.existsSync(payloadRoot)) throw new Error(`Windows staging payload root already exists: ${payloadRoot}`);
  const reserved = new Set(RESERVED_STAGING_PATHS.map((value) => value.toLowerCase()));
  for (const entry of fs.readdirSync(applicationRoot)) {
    if (reserved.has(entry.toLowerCase())) {
      throw new Error(`Prepared Windows application payload uses installer-reserved path: ${entry}`);
    }
  }
  const verifiedServiceHost = verifyWindowsServiceHost(options.serviceHost, architecture);
  try {
    copyRegularTree(applicationRoot, payloadRoot);
    assertRequiredApplicationPayload(payloadRoot, architecture);
    writeFile(
      path.join(payloadRoot, ...WINDOWS_SERVICE_HOST_RELATIVE_PATH.split("/")),
      fs.readFileSync(options.serviceHost.executable),
    );
    writeFile(
      path.join(payloadRoot, ...WINDOWS_SERVICE_PROVENANCE_RELATIVE_PATH.split("/")),
      fs.readFileSync(options.serviceHost.provenance),
    );
    writeFile(
      path.join(payloadRoot, ...WINDOWS_SERVICE_LICENSE_RELATIVE_PATH.split("/")),
      fs.readFileSync(options.serviceHost.license),
    );
    writeFile(
      path.join(payloadRoot, ...WINDOWS_SERVICE_CONFIGURATION_RELATIVE_PATH.split("/")),
      windowsServiceConfiguration(version, architecture),
    );
    writeFile(
      path.join(payloadRoot, ...WINDOWS_PROTOCOL_HANDLER_RELATIVE_PATH.split("/")),
      windowsProtocolHandlerSource(),
    );
    const files = collectWindowsPayloadFiles(payloadRoot);
    const manifest = manifestFor(version, architecture, sourceDateEpoch, verifiedServiceHost, files);
    writeFile(path.join(payloadRoot, WINDOWS_INSTALL_MANIFEST_RELATIVE_PATH), canonicalManifest(manifest));
    normalizeWindowsPayload(payloadRoot, sourceDateEpoch);
    verifyWindowsPayload(payloadRoot, version, architecture, sourceDateEpoch);
    return manifest;
  } catch (error) {
    fs.rmSync(payloadRoot, { recursive: true, force: true });
    throw error;
  }
}

function parseManifest(value: unknown): WindowsPayloadManifest {
  if (!isRecord(value)) throw new Error("Windows payload manifest must be an object.");
  assertExactKeys(value, [
    "format",
    "formatVersion",
    "productVersion",
    "architecture",
    "sourceDateEpoch",
    "serviceHost",
    "files",
  ], "Windows payload manifest");
  if (value.format !== "formaspec-windows-payload" || value.formatVersion !== 1) {
    throw new Error("Windows payload manifest format is unsupported.");
  }
  const productVersion = assertWindowsMsiVersion(String(value.productVersion));
  const architecture = assertWindowsPackageArchitecture(String(value.architecture));
  const sourceDateEpoch = normalizeWindowsSourceDateEpoch(value.sourceDateEpoch as number);
  if (!isRecord(value.serviceHost)) throw new Error("Windows payload service-host metadata is malformed.");
  assertExactKeys(value.serviceHost, [
    "component",
    "version",
    "contract",
    "executableSha256",
    "licenseSpdx",
    "sourceUrl",
    "sourceSha256",
  ], "Windows payload service-host metadata");
  if (!Array.isArray(value.files)) throw new Error("Windows payload file inventory is malformed.");
  const files = value.files.map((entry): WindowsPayloadFile => {
    if (!isRecord(entry)) throw new Error("Windows payload file entry is malformed.");
    assertExactKeys(entry, ["relativePath", "size", "sha256"], "Windows payload file entry");
    const relativePath = assertWindowsRelativePath(String(entry.relativePath));
    const size = typeof entry.size === "number" && Number.isSafeInteger(entry.size) && entry.size >= 0
      ? entry.size
      : NaN;
    if (!Number.isSafeInteger(size)) throw new Error(`Windows payload file size is invalid: ${relativePath}`);
    return { relativePath, size, sha256: assertSha256(entry.sha256, `Windows payload hash for ${relativePath}`) };
  });
  if (value.serviceHost.component !== "FormaSpec Windows Service Host"
    || value.serviceHost.contract !== WINDOWS_SERVICE_HOST_CONTRACT
    || typeof value.serviceHost.licenseSpdx !== "string"
    || !PERMISSIVE_SERVICE_HOST_LICENSES.has(value.serviceHost.licenseSpdx)) {
    throw new Error("Windows payload service-host metadata is unsupported.");
  }
  return {
    format: "formaspec-windows-payload",
    formatVersion: 1,
    productVersion,
    architecture,
    sourceDateEpoch,
    serviceHost: {
      component: "FormaSpec Windows Service Host",
      version: assertSafeVersion(value.serviceHost.version, "Windows payload service-host version"),
      contract: WINDOWS_SERVICE_HOST_CONTRACT,
      executableSha256: assertSha256(value.serviceHost.executableSha256, "Windows payload service-host executable hash"),
      licenseSpdx: value.serviceHost.licenseSpdx,
      sourceUrl: assertSafeHttpsSourceUrl(value.serviceHost.sourceUrl, "Windows payload service host"),
      sourceSha256: assertSha256(value.serviceHost.sourceSha256, "Windows payload service-host source hash"),
    },
    files,
  };
}

function fileInventoriesEqual(left: readonly WindowsPayloadFile[], right: readonly WindowsPayloadFile[]): boolean {
  return left.length === right.length && left.every((entry, index) => {
    const candidate = right[index];
    return candidate !== undefined && entry.relativePath === candidate.relativePath
      && entry.size === candidate.size && entry.sha256 === candidate.sha256;
  });
}

export function verifyWindowsPayload(
  payloadRootValue: string,
  expectedVersion: string,
  expectedArchitecture: WindowsPackageArchitecture,
  expectedSourceDateEpoch?: number,
): WindowsPayloadManifest {
  const payloadRoot = requireAbsolutePath(payloadRootValue, "Windows payload root");
  requireDirectory(payloadRoot, "Windows payload root");
  const manifestPath = path.join(payloadRoot, WINDOWS_INSTALL_MANIFEST_RELATIVE_PATH);
  const parsed = parseJsonFile(manifestPath, "Windows payload manifest");
  const manifest = parseManifest(parsed.value);
  if (parsed.raw !== canonicalManifest(manifest)) throw new Error("Windows payload manifest is not canonical JSON.");
  if (manifest.productVersion !== assertWindowsMsiVersion(expectedVersion)
    || manifest.architecture !== assertWindowsPackageArchitecture(expectedArchitecture)) {
    throw new Error("Windows payload manifest does not match the requested product version or architecture.");
  }
  if (expectedSourceDateEpoch !== undefined && manifest.sourceDateEpoch !== normalizeWindowsSourceDateEpoch(expectedSourceDateEpoch)) {
    throw new Error("Windows payload manifest does not match the requested source epoch.");
  }
  assertRequiredApplicationPayload(payloadRoot, manifest.architecture);
  const serviceHost = verifyWindowsServiceHost({
    executable: path.join(payloadRoot, ...WINDOWS_SERVICE_HOST_RELATIVE_PATH.split("/")),
    provenance: path.join(payloadRoot, ...WINDOWS_SERVICE_PROVENANCE_RELATIVE_PATH.split("/")),
    license: path.join(payloadRoot, ...WINDOWS_SERVICE_LICENSE_RELATIVE_PATH.split("/")),
  }, manifest.architecture);
  const expectedConfiguration = windowsServiceConfiguration(manifest.productVersion, manifest.architecture);
  const actualConfiguration = fs.readFileSync(
    path.join(payloadRoot, ...WINDOWS_SERVICE_CONFIGURATION_RELATIVE_PATH.split("/")),
    "utf8",
  );
  if (actualConfiguration !== expectedConfiguration) throw new Error("Windows service-host configuration was modified after staging.");
  const actualFiles = collectWindowsPayloadFiles(payloadRoot, new Set([WINDOWS_INSTALL_MANIFEST_RELATIVE_PATH]));
  if (!fileInventoriesEqual(manifest.files, actualFiles)) throw new Error("Windows payload file inventory or hashes do not match the manifest.");
  if (manifest.serviceHost.version !== serviceHost.provenance.version
    || manifest.serviceHost.executableSha256 !== serviceHost.executableSha256
    || manifest.serviceHost.licenseSpdx !== serviceHost.provenance.licenseSpdx
    || manifest.serviceHost.sourceUrl !== serviceHost.provenance.sourceUrl
    || manifest.serviceHost.sourceSha256 !== serviceHost.provenance.sourceSha256) {
    throw new Error("Windows payload service-host metadata does not match its verified provenance.");
  }
  return manifest;
}

export function generateWindowsWixSource(
  payloadRoot: string,
  version: string,
  architecture: WindowsPackageArchitecture,
): string {
  verifyWindowsPayload(payloadRoot, version, architecture);
  return windowsWixSource({
    version,
    architecture,
    files: collectWindowsPayloadFiles(payloadRoot),
  });
}

function parseWixProvenance(value: unknown): WixToolsetProvenance {
  if (!isRecord(value)) throw new Error("WiX Toolset provenance must be an object.");
  assertExactKeys(value, [
    "format",
    "formatVersion",
    "component",
    "version",
    "executableSha256",
    "executableSizeBytes",
    "licenseSpdx",
    "sourceUrl",
    "sourceSha256",
  ], "WiX Toolset provenance");
  if (value.format !== WINDOWS_WIX_PROVENANCE_FORMAT || value.formatVersion !== 1
    || value.component !== "WiX Toolset" || value.licenseSpdx !== "MS-RL") {
    throw new Error("WiX Toolset provenance identity or license is unsupported.");
  }
  const version = assertSafeVersion(value.version, "WiX Toolset version");
  if (!version.startsWith("4.")) throw new Error("Windows MSI builds require an explicitly pinned WiX Toolset v4 executable.");
  return {
    format: WINDOWS_WIX_PROVENANCE_FORMAT,
    formatVersion: 1,
    component: "WiX Toolset",
    version,
    executableSha256: assertSha256(value.executableSha256, "WiX Toolset executable hash"),
    executableSizeBytes: assertPositiveSafeSize(value.executableSizeBytes, "WiX Toolset executable size", MAX_WINDOWS_PAYLOAD_FILE_BYTES),
    licenseSpdx: "MS-RL",
    sourceUrl: assertSafeHttpsSourceUrl(value.sourceUrl, "WiX Toolset"),
    sourceSha256: assertSha256(value.sourceSha256, "WiX Toolset source hash"),
  };
}

function verifyWixToolset(
  executableValue: string,
  provenancePath: string,
  runner: PackageCommandRunner,
  commandOptions: { cwd: string; env: NodeJS.ProcessEnv },
): WixToolsetProvenance {
  const executable = requireAbsolutePath(executableValue, "WiX Toolset executable");
  if (path.extname(executable).toLowerCase() !== ".exe") throw new Error("WiX Toolset executable must use the .exe extension.");
  const stat = requireRegularFile(executable, "WiX Toolset executable");
  const provenance = parseWixProvenance(parseJsonFile(provenancePath, "WiX Toolset provenance").value);
  if (stat.size !== provenance.executableSizeBytes || sha256WindowsFile(executable) !== provenance.executableSha256) {
    throw new Error("WiX Toolset executable failed its exact provenance integrity check.");
  }
  const result = runPackageCommand(runner, executable, ["--version"], {
    ...commandOptions,
    timeoutMs: 30_000,
  });
  if (result.stdout.trim() !== provenance.version) {
    throw new Error(`WiX Toolset executable must report exactly version ${provenance.version}.`);
  }
  return provenance;
}

export function assertWindowsPackagingHost(platform = process.platform): void {
  if (platform !== "win32") throw new Error("Native Windows MSI packages must be built on Windows.");
}

function windowsPackagingEnvironment(
  source: NodeJS.ProcessEnv,
  buildRoot: string,
  sourceDateEpoch: number,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    DOTNET_CLI_HOME: buildRoot,
    DOTNET_CLI_TELEMETRY_OPTOUT: "1",
    DOTNET_EnableDiagnostics: "0",
    DOTNET_NOLOGO: "1",
    LC_ALL: "C",
    SOURCE_DATE_EPOCH: String(sourceDateEpoch),
    TEMP: buildRoot,
    TMP: buildRoot,
    TZ: "UTC",
  };
  for (const key of ["SystemRoot", "WINDIR", "COMSPEC"] as const) {
    const value = source[key] ?? source[key.toUpperCase()];
    if (value === undefined) continue;
    if (value.length < 1 || value.length > 4096 || /[\0\r\n]/.test(value)) {
      throw new Error(`Windows packaging environment ${key} is invalid.`);
    }
    environment[key] = value;
  }
  return environment;
}

function assertMsiArtifact(filename: string): void {
  const stat = requireRegularFile(filename, "WiX MSI output");
  if (stat.size < MSI_COMPOUND_FILE_HEADER.length) throw new Error("WiX did not create a valid non-empty MSI artifact.");
  const header = Buffer.alloc(MSI_COMPOUND_FILE_HEADER.length);
  const descriptor = fs.openSync(filename, "r");
  try {
    if (fs.readSync(descriptor, header, 0, header.length, 0) !== header.length
      || !header.equals(MSI_COMPOUND_FILE_HEADER)) {
      throw new Error("WiX output does not contain a Windows Installer compound-file header.");
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

export function writeWindowsArtifactChecksum(filename: string): string {
  requireRegularFile(filename, "Windows installer artifact");
  const checksum = `${filename}.sha256`;
  fs.writeFileSync(checksum, `${sha256WindowsFile(filename)}  ${path.basename(filename)}\n`, { flag: "wx" });
  return checksum;
}

export function buildUnsignedWindowsMsi(options: WindowsMsiBuildOptions): string {
  const platform = options.platform ?? process.platform;
  assertWindowsPackagingHost(platform);
  const version = assertWindowsMsiVersion(options.version);
  const architecture = assertWindowsPackageArchitecture(options.architecture);
  const sourceDateEpoch = normalizeWindowsSourceDateEpoch(options.sourceDateEpoch);
  const sourcePayloadRoot = requireAbsolutePath(options.payloadRoot, "Windows payload root");
  const outputDirectory = requireAbsolutePath(options.outputDirectory, "Windows MSI output directory");
  const wixExecutable = requireAbsolutePath(options.wixExecutable, "WiX Toolset executable");
  const runner = options.commandRunner ?? spawnPackageCommandRunner;
  verifyWindowsPayload(sourcePayloadRoot, version, architecture, sourceDateEpoch);
  const buildRoot = fs.mkdtempSync(path.join(os.tmpdir(), "formaspec-wix-v4-"));
  const payloadRoot = path.join(buildRoot, "payload");
  const sourcePath = path.join(buildRoot, "formaspec.wxs");
  const output = path.join(outputDirectory, `FormaSpec-${version}-windows-${architecture}-unsigned.msi`);
  try {
    const environment = windowsPackagingEnvironment(
      options.environment ?? process.env,
      buildRoot,
      sourceDateEpoch,
    );
    verifyWixToolset(wixExecutable, options.wixProvenance, runner, { cwd: buildRoot, env: environment });
    copyRegularTree(sourcePayloadRoot, payloadRoot);
    normalizeWindowsPayload(payloadRoot, sourceDateEpoch);
    verifyWindowsPayload(payloadRoot, version, architecture, sourceDateEpoch);
    fs.writeFileSync(sourcePath, generateWindowsWixSource(payloadRoot, version, architecture), { flag: "wx" });
    fs.utimesSync(sourcePath, sourceDateEpoch, sourceDateEpoch);
    fs.mkdirSync(outputDirectory, { recursive: true });
    fs.rmSync(output, { force: true });
    fs.rmSync(`${output}.sha256`, { force: true });
    runPackageCommand(
      runner,
      wixExecutable,
      [
        "build",
        sourcePath,
        "-arch", architecture,
        "-d", `PayloadRoot=${payloadRoot}`,
        "-bindpath", payloadRoot,
        "-pdbtype", "none",
        "-nologo",
        "-out", output,
      ],
      {
        cwd: buildRoot,
        env: environment,
        timeoutMs: 30 * 60_000,
      },
    );
    assertMsiArtifact(output);
    writeWindowsArtifactChecksum(output);
    return output;
  } catch (error) {
    fs.rmSync(output, { force: true });
    fs.rmSync(`${output}.sha256`, { force: true });
    throw error;
  } finally {
    fs.rmSync(buildRoot, { recursive: true, force: true });
  }
}

export function windowsMsiPrerequisiteSummary(): string {
  return [
    "Windows WiX v4 MSI build prerequisites (fail closed):",
    "- Run the build on native Windows x64 or arm64.",
    "- Supply a prepared, self-contained Windows FormaSpec payload with matching Node.js and Chromium PE binaries.",
    "- Supply a native FormaSpec service-host executable implementing formaspec-windows-service-host-v1.",
    "- Supply exact service-host executable, source, and permissive-license provenance plus the matching license text.",
    "- Supply an exact-hash WiX Toolset v4 executable and provenance record.",
    "- Signing is intentionally absent; the produced artifact is named unsigned and still requires signing lifecycle evidence.",
  ].join("\n");
}
