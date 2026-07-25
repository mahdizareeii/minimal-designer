import { createHash } from "node:crypto";

export type WindowsPackageArchitecture = "x64" | "arm64";

export const WINDOWS_INSTALL_DIRECTORY_NAME = "FormaSpec";
export const WINDOWS_PROGRAM_DATA_DIRECTORY_NAME = "FormaSpec";
export const WINDOWS_API_SERVICE_NAME = "FormaSpecApi";
export const WINDOWS_RENDERER_SERVICE_NAME = "FormaSpecRenderer";
export const WINDOWS_SERVICE_HOST_RELATIVE_PATH = "service/FormaSpec.ServiceHost.exe";
export const WINDOWS_SERVICE_CONFIGURATION_RELATIVE_PATH = "service/formaspec-service.json";
export const WINDOWS_PROTOCOL_HANDLER_RELATIVE_PATH = "service/formaspec-protocol-handler.cjs";
export const WINDOWS_SERVICE_PROVENANCE_RELATIVE_PATH = "service/service-host-provenance.json";
export const WINDOWS_SERVICE_LICENSE_RELATIVE_PATH = "service/SERVICE-HOST-LICENSE.txt";
export const WINDOWS_INSTALL_MANIFEST_RELATIVE_PATH = "install-manifest.json";

const MSI_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const WINDOWS_PATH_SEGMENT = /^[A-Za-z0-9@+(),._ -]+$/;
const WINDOWS_RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;

const UPGRADE_NAMESPACE = "f9329622-e8ca-4a73-bc35-c6de3ac14acf";
const COMPONENT_NAMESPACE = "4dddf9ed-faa8-4d8c-94de-932d950af557";

export interface WindowsPayloadFile {
  relativePath: string;
  size: number;
  sha256: string;
}

export interface WindowsWixSourceOptions {
  version: string;
  architecture: WindowsPackageArchitecture;
  files: readonly WindowsPayloadFile[];
}

export type WindowsProtocolAction =
  | { kind: "open" }
  | { kind: "connect"; pairingNonce?: string; connectionId?: string }
  | { kind: "review"; designId: string; previewId: string; taskId: string; storeId: string };

export function parseWindowsProtocolUrl(value: string): WindowsProtocolAction {
  if (value.length > 2_048 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("FormaSpec protocol URL is malformed.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("FormaSpec protocol URL is malformed.");
  }
  if (url.protocol !== "formaspec:" || url.username || url.password || url.port || url.hash || url.pathname) {
    throw new Error("FormaSpec protocol URL is malformed.");
  }
  if ((url.hostname === "" || url.hostname === "open") && url.search === "") return { kind: "open" };
  if (url.hostname === "open-review") {
    const review = /^\?design=(document_[A-Za-z0-9][A-Za-z0-9_-]{7,199})&preview=(preview_[A-Za-z0-9][A-Za-z0-9_-]{7,199})&task=(task_[a-f0-9]{32})&store=(store_[a-f0-9]{32})$/.exec(url.search);
    if (!review) throw new Error("FormaSpec review URL is malformed.");
    return {
      kind: "review",
      designId: review[1]!,
      previewId: review[2]!,
      taskId: review[3]!,
      storeId: review[4]!,
    };
  }
  if (url.hostname !== "connect-agent") throw new Error("FormaSpec protocol action is unsupported.");
  if (url.search === "") return { kind: "connect" };
  const nonceOnly = /^\?nonce=(fspair_[A-Za-z0-9_-]{43})$/.exec(url.search);
  if (nonceOnly) return { kind: "connect", pairingNonce: nonceOnly[1]! };
  const withConnection = /^\?connection=(connection_[a-f0-9]{32})&nonce=(fspair_[A-Za-z0-9_-]{43})$/.exec(url.search);
  if (withConnection) {
    return { kind: "connect", connectionId: withConnection[1]!, pairingNonce: withConnection[2]! };
  }
  throw new Error("FormaSpec pairing URL is malformed.");
}

export function windowsProtocolHandlerSource(): string {
  return `"use strict";
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function fail(message) {
  process.stderr.write(\`\${message}\\n\`);
  process.exitCode = 2;
  return null;
}

function parseProtocolUrl(value) {
  if (typeof value !== "string" || value.length > 2048 || /[\\u0000-\\u001f\\u007f]/.test(value)) {
    return fail("FormaSpec protocol URL is malformed.");
  }
  let url;
  try { url = new URL(value); } catch { return fail("FormaSpec protocol URL is malformed."); }
  if (url.protocol !== "formaspec:" || url.username || url.password || url.port || url.hash || url.pathname) {
    return fail("FormaSpec protocol URL is malformed.");
  }
  if ((url.hostname === "" || url.hostname === "open") && url.search === "") return { kind: "open" };
  if (url.hostname === "open-review") {
    const review = /^\\?design=(document_[A-Za-z0-9][A-Za-z0-9_-]{7,199})&preview=(preview_[A-Za-z0-9][A-Za-z0-9_-]{7,199})&task=(task_[a-f0-9]{32})&store=(store_[a-f0-9]{32})$/.exec(url.search);
    if (!review) return fail("FormaSpec review URL is malformed.");
    return { kind: "review", designId: review[1], previewId: review[2], taskId: review[3], storeId: review[4] };
  }
  if (url.hostname !== "connect-agent") return fail("FormaSpec protocol action is unsupported.");
  if (url.search === "") return { kind: "connect" };
  const nonceOnly = /^\\?nonce=(fspair_[A-Za-z0-9_-]{43})$/.exec(url.search);
  if (nonceOnly) return { kind: "connect", pairingNonce: nonceOnly[1] };
  const withConnection = /^\\?connection=(connection_[a-f0-9]{32})&nonce=(fspair_[A-Za-z0-9_-]{43})$/.exec(url.search);
  if (withConnection) return { kind: "connect", connectionId: withConnection[1], pairingNonce: withConnection[2] };
  return fail("FormaSpec pairing URL is malformed.");
}

function openEditor(installRoot) {
  if (process.platform !== "win32") return;
  const serviceHost = path.join(installRoot, "service", "FormaSpec.ServiceHost.exe");
  if (!fs.existsSync(serviceHost)) return;
  const child = spawn(serviceHost, ["--open-editor"], {
    detached: true,
    shell: false,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

function openExternalUrl(target) {
  if (process.platform !== "win32") return;
  const child = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", target], {
    detached: true,
    shell: false,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

function packagedEnvironment(installRoot) {
  const programData = process.env.ProgramData || process.env.PROGRAMDATA;
  const stateRoot = programData ? path.join(programData, "FormaSpec") : path.join(installRoot, "state");
  let upstreamAuthMode = "unknown";
  try {
    const configurationPath = path.join(installRoot, "service", "formaspec-service.json");
    const stat = fs.lstatSync(configurationPath);
    if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 65536) {
      const configuration = JSON.parse(fs.readFileSync(configurationPath, "utf8"));
      const configured = configuration && configuration.api && configuration.api.environment
        ? configuration.api.environment.AUTH_MODE
        : undefined;
      if (["none", "session", "trusted-header", "token"].includes(configured)) upstreamAuthMode = configured;
    }
  } catch {}
  return {
    ...process.env,
    FORMASPEC_RUNTIME_DIR: process.env.FORMASPEC_RUNTIME_DIR || path.join(stateRoot, "runtime"),
    FORMASPEC_DATA_DIR: process.env.FORMASPEC_DATA_DIR || path.join(stateRoot, "data"),
    FORMASPEC_BACKUP_DIR: process.env.FORMASPEC_BACKUP_DIR || path.join(stateRoot, "backups"),
    FORMASPEC_LOG_DIR: process.env.FORMASPEC_LOG_DIR || path.join(stateRoot, "logs"),
    FORMASPEC_SUPPORT_DIR: process.env.FORMASPEC_SUPPORT_DIR || path.join(stateRoot, "support-bundles"),
    FORMASPEC_UPSTREAM_AUTH_MODE: upstreamAuthMode,
    PLAYWRIGHT_BROWSERS_PATH: path.join(installRoot, "runtime", "ms-playwright"),
    PATH: [path.join(installRoot, "runtime"), process.env.PATH || ""].filter(Boolean).join(path.delimiter),
  };
}

function resolveReviewTarget(action, installRoot) {
  const cliEntry = path.join(installRoot, "app", "apps", "cli", "dist", "index.js");
  if (!fs.existsSync(cliEntry)) return fail("The packaged formaspecctl entry point is unavailable.");
  const result = spawnSync(process.execPath, [cliEntry, "ensure-running", "--json"], {
    cwd: path.join(installRoot, "app"),
    env: packagedEnvironment(installRoot),
    encoding: "utf8",
    maxBuffer: 256 * 1024,
    shell: false,
    timeout: 180000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    return fail("FormaSpec could not resume its recorded runtime. Run formaspecctl ensure-running --json for the blocker.");
  }
  let ensured;
  try { ensured = JSON.parse(result.stdout); } catch { return fail("FormaSpec ensure-running returned invalid JSON."); }
  if (!ensured || ensured.schemaVersion !== 1 || ensured.ok !== true
    || typeof ensured.dataStoreId !== "string" || typeof ensured.webOrigin !== "string") {
    return fail("FormaSpec ensure-running did not return a ready runtime identity.");
  }
  if (ensured.dataStoreId !== action.storeId) {
    return fail("FormaSpec review belongs to data store " + action.storeId
      + ", but the recorded runtime exposes " + ensured.dataStoreId + ".");
  }
  let target;
  try { target = new URL(ensured.webOrigin); } catch { return fail("FormaSpec ensure-running returned an invalid web origin."); }
  const host = target.hostname.toLowerCase().replace(/^\\[|\\]$/g, "");
  const loopbackHttp = target.protocol === "http:" && ["127.0.0.1", "::1", "localhost"].includes(host);
  const publicHttps = target.protocol === "https:" && host !== "" && !["127.0.0.1", "::1", "localhost"].includes(host);
  if ((!loopbackHttp && !publicHttps) || target.username || target.password || target.pathname !== "/"
    || target.search || target.hash) {
    return fail("FormaSpec ensure-running returned an invalid web origin.");
  }
  target.pathname = "/design/" + action.designId + "/previews/" + action.previewId + "/review";
  target.searchParams.set("task", action.taskId);
  target.searchParams.set("store", action.storeId);
  return target.toString();
}

function main() {
  const action = parseProtocolUrl(process.argv[2] || "");
  if (!action) return;
  const installRoot = path.dirname(__dirname);
  if (action.kind === "open") {
    openEditor(installRoot);
    return;
  }
  if (action.kind === "review") {
    const target = resolveReviewTarget(action, installRoot);
    if (target) openExternalUrl(target);
    return;
  }
  const cliEntry = path.join(installRoot, "app", "apps", "cli", "dist", "index.js");
  if (!fs.existsSync(cliEntry)) {
    fail("The packaged formaspecctl entry point is unavailable.");
    return;
  }
  const cliArguments = ["agent", "connect", "codex"];
  if (action.pairingNonce) cliArguments.push("--pairing-nonce", action.pairingNonce);
  if (action.connectionId) cliArguments.push("--connection-id", action.connectionId);
  cliArguments.push("--yes");
  const child = spawn(process.execPath, [cliEntry, ...cliArguments], {
    cwd: path.join(installRoot, "app"),
    detached: true,
    env: packagedEnvironment(installRoot),
    shell: false,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  openEditor(installRoot);
}

if (require.main === module) main();
module.exports = { parseProtocolUrl };
`;
}

interface DirectoryNode {
  relativePath: string;
  directories: Map<string, DirectoryNode>;
  files: WindowsPayloadFile[];
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function identifier(prefix: string, value: string): string {
  return `${prefix}_${sha256(value).toString("hex").slice(0, 28)}`;
}

function deterministicGuid(namespace: string, value: string): string {
  const bytes = sha256(`${namespace}\0${value}`).subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex").toUpperCase();
  return `{${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}}`;
}

export function assertWindowsMsiVersion(value: string): string {
  const match = MSI_VERSION.exec(value);
  if (!match) {
    throw new Error("Windows MSI version must be a three-part numeric release version without prerelease or build metadata.");
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const build = Number(match[3]);
  if (major > 255 || minor > 255 || build > 65_535) {
    throw new Error("Windows MSI version fields exceed Windows Installer limits (255.255.65535).");
  }
  return value;
}

export function assertWindowsPackageArchitecture(value: string): WindowsPackageArchitecture {
  if (value !== "x64" && value !== "arm64") {
    throw new Error(`Unsupported Windows installer architecture: ${value}`);
  }
  return value;
}

export function assertWindowsRelativePath(value: string): string {
  if (!value || value.length > 240 || value.startsWith("/") || value.startsWith("\\") || value.includes("\\")) {
    throw new Error(`Windows payload path must be a bounded forward-slash relative path: ${value}`);
  }
  if (value !== value.normalize("NFC")) throw new Error(`Windows payload path must use NFC normalization: ${value}`);
  const segments = value.split("/");
  for (const segment of segments) {
    if (!segment || segment === "." || segment === ".." || segment.length > 120
      || !WINDOWS_PATH_SEGMENT.test(segment) || segment.endsWith(".") || segment.endsWith(" ")
      || WINDOWS_RESERVED_NAME.test(segment) || segment.includes("$")) {
      throw new Error(`Windows payload path contains an unsafe or unsupported segment: ${value}`);
    }
  }
  return value;
}

export function assertWindowsPayloadPathSet(values: readonly string[]): string[] {
  const folded = new Set<string>();
  return values.map((value) => {
    const relativePath = assertWindowsRelativePath(value);
    const key = relativePath.toLowerCase();
    if (folded.has(key)) throw new Error(`Windows payload contains a case-insensitive path collision: ${relativePath}`);
    folded.add(key);
    return relativePath;
  });
}

export function windowsUpgradeCode(architecture: WindowsPackageArchitecture): string {
  // Both architectures own the same install directory, services, protocol,
  // shortcuts, and ProgramData roots. They must therefore be one mutually
  // exclusive product family on Windows ARM64 rather than co-installable
  // products that can remove each other's shared resources.
  assertWindowsPackageArchitecture(architecture);
  return deterministicGuid(UPGRADE_NAMESPACE, "upgrade:formaspec");
}

export function windowsProductCode(version: string, architecture: WindowsPackageArchitecture): string {
  return deterministicGuid(
    UPGRADE_NAMESPACE,
    `product:${assertWindowsPackageArchitecture(architecture)}:${assertWindowsMsiVersion(version)}`,
  );
}

export function windowsServiceConfiguration(version: string, architecture: WindowsPackageArchitecture): string {
  const configuration = {
    format: "formaspec-windows-service-host",
    formatVersion: 1,
    productVersion: assertWindowsMsiVersion(version),
    architecture: assertWindowsPackageArchitecture(architecture),
    stateRoot: "%ProgramData%\\FormaSpec",
    renderer: {
      executable: "runtime\\node.exe",
      arguments: ["app\\apps\\server\\dist\\renderer-worker.js"],
      environment: {
        NODE_ENV: "production",
        PLAYWRIGHT_BROWSERS_PATH: "%ProgramFiles%\\FormaSpec\\runtime\\ms-playwright",
        FORMASPEC_RENDER_SOCKET: "\\\\.\\pipe\\formaspec-renderer",
        FORMASPEC_RENDER_TIMEOUT_MS: "15000",
        FORMASPEC_RENDER_MAX_PIXELS: "32000000",
        DESIGNER_MAX_ASSET_PIXELS: "32000000",
        MAX_UPLOAD_BYTES: "5242880",
        FORMASPEC_RENDER_CONCURRENCY: "2",
        FORMASPEC_RENDER_QUEUE_LIMIT: "32",
        FORMASPEC_RENDER_IPC_MAX_BYTES: "100663296",
        FORMASPEC_ALLOW_SYSTEM_CHROME: "false",
        LANG: "en-US",
        TZ: "UTC",
      },
    },
    api: {
      executable: "runtime\\node.exe",
      arguments: ["app\\apps\\server\\dist\\index.js"],
      environment: {
        APP_MODE: "local",
        HOST: "127.0.0.1",
        PORT: "4310",
        PUBLIC_BASE_URL: "http://127.0.0.1:4310",
        AUTH_MODE: "none",
        DATA_DIR: "%ProgramData%\\FormaSpec\\data",
        BACKUP_DIR: "%ProgramData%\\FormaSpec\\backups",
        FORMASPEC_RENDER_SOCKET: "\\\\.\\pipe\\formaspec-renderer",
        FORMASPEC_RENDER_TIMEOUT_MS: "15000",
        FORMASPEC_RENDER_MAX_PIXELS: "32000000",
        DESIGNER_MAX_ASSET_PIXELS: "32000000",
        MAX_UPLOAD_BYTES: "5242880",
        FORMASPEC_RENDER_IPC_MAX_BYTES: "100663296",
        FORMASPEC_ALLOW_SYSTEM_CHROME: "false",
        LANG: "en-US",
        TZ: "UTC",
      },
    },
    interactive: {
      editorUrl: "http://127.0.0.1:4310",
      allowedProtocol: "formaspec",
    },
  };
  return `${JSON.stringify(configuration, null, 2)}\n`;
}

function assertPayloadFileList(files: readonly WindowsPayloadFile[]): WindowsPayloadFile[] {
  if (files.length === 0) throw new Error("Windows MSI payload cannot be empty.");
  const paths = assertWindowsPayloadPathSet(files.map((file) => file.relativePath));
  const byFoldedPath = new Set(paths.map((relativePath) => relativePath.toLowerCase()));
  const normalized = files.map((file, index) => {
    const relativePath = paths[index]!;
    if (!Number.isSafeInteger(file.size) || file.size < 0) {
      throw new Error(`Windows payload file size is invalid: ${relativePath}`);
    }
    if (!/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error(`Windows payload SHA-256 is invalid: ${relativePath}`);
    }
    return { ...file, relativePath };
  }).sort((left, right) => compareText(left.relativePath, right.relativePath));

  for (const required of [
    WINDOWS_SERVICE_HOST_RELATIVE_PATH,
    WINDOWS_SERVICE_CONFIGURATION_RELATIVE_PATH,
    WINDOWS_PROTOCOL_HANDLER_RELATIVE_PATH,
    WINDOWS_SERVICE_PROVENANCE_RELATIVE_PATH,
    WINDOWS_SERVICE_LICENSE_RELATIVE_PATH,
    WINDOWS_INSTALL_MANIFEST_RELATIVE_PATH,
  ]) {
    if (!byFoldedPath.has(required.toLowerCase())) throw new Error(`Windows MSI payload is missing required file: ${required}`);
  }
  return normalized;
}

function buildDirectoryTree(files: readonly WindowsPayloadFile[]): DirectoryNode {
  const root: DirectoryNode = { relativePath: "", directories: new Map(), files: [] };
  for (const file of files) {
    const segments = file.relativePath.split("/");
    const filename = segments.pop();
    if (filename === undefined) throw new Error("Windows payload file path is malformed.");
    let node = root;
    for (const segment of segments) {
      const relativePath = node.relativePath ? `${node.relativePath}/${segment}` : segment;
      const existing = node.directories.get(segment);
      if (existing) {
        node = existing;
      } else {
        const created: DirectoryNode = { relativePath, directories: new Map(), files: [] };
        node.directories.set(segment, created);
        node = created;
      }
    }
    node.files.push(file);
  }
  return root;
}

function componentId(relativePath: string): string {
  return identifier("Cmp", relativePath.toLowerCase());
}

function fileId(relativePath: string): string {
  return identifier("Fil", relativePath.toLowerCase());
}

function directoryId(relativePath: string): string {
  return identifier("Dir", relativePath.toLowerCase());
}

function sourcePath(relativePath: string): string {
  return `$(var.PayloadRoot)\\${relativePath.replaceAll("/", "\\")}`;
}

function regularComponent(file: WindowsPayloadFile, architecture: WindowsPackageArchitecture, indent: string): string[] {
  const id = componentId(file.relativePath);
  const filename = file.relativePath.split("/").at(-1);
  if (filename === undefined) throw new Error("Windows payload filename is unavailable.");
  return [
    `${indent}<Component Id="${id}" Guid="${deterministicGuid(COMPONENT_NAMESPACE, `${architecture}:${file.relativePath.toLowerCase()}`)}" Bitness="always64">`,
    `${indent}  <File Id="${fileId(file.relativePath)}" Source="${xml(sourcePath(file.relativePath))}" Name="${xml(filename)}" KeyPath="yes" Vital="yes" />`,
    `${indent}</Component>`,
  ];
}

function serviceHostComponent(architecture: WindowsPackageArchitecture, indent: string): string[] {
  const relativePath = WINDOWS_SERVICE_HOST_RELATIVE_PATH;
  const id = componentId(relativePath);
  return [
    `${indent}<Component Id="${id}" Guid="${deterministicGuid(COMPONENT_NAMESPACE, `${architecture}:${relativePath.toLowerCase()}`)}" Bitness="always64">`,
    `${indent}  <File Id="${fileId(relativePath)}" Source="${xml(sourcePath(relativePath))}" Name="FormaSpec.ServiceHost.exe" KeyPath="yes" Vital="yes" />`,
    `${indent}  <ServiceInstall Id="InstallRendererService" Name="${WINDOWS_RENDERER_SERVICE_NAME}" DisplayName="FormaSpec Renderer" Description="Isolated FormaSpec Chromium renderer" Type="ownProcess" Start="auto" ErrorControl="normal" Account="LocalSystem" Arguments="--service renderer --config &quot;[INSTALLFOLDER]service\\formaspec-service.json&quot;" Vital="yes" />`,
    `${indent}  <ServiceControl Id="ControlRendererService" Name="${WINDOWS_RENDERER_SERVICE_NAME}" Start="install" Stop="both" Remove="uninstall" Wait="yes" />`,
    `${indent}  <ServiceInstall Id="InstallApiService" Name="${WINDOWS_API_SERVICE_NAME}" DisplayName="FormaSpec" Description="FormaSpec loopback API and editor" Type="ownProcess" Start="auto" ErrorControl="normal" Account="LocalSystem" Arguments="--service api --config &quot;[INSTALLFOLDER]service\\formaspec-service.json&quot;" Vital="yes">`,
    `${indent}    <ServiceDependency Id="${WINDOWS_RENDERER_SERVICE_NAME}" />`,
    `${indent}  </ServiceInstall>`,
    `${indent}  <ServiceControl Id="ControlApiService" Name="${WINDOWS_API_SERVICE_NAME}" Start="install" Stop="both" Remove="uninstall" Wait="yes" />`,
    `${indent}</Component>`,
  ];
}

function renderDirectoryNode(
  node: DirectoryNode,
  architecture: WindowsPackageArchitecture,
  indent: string,
): string[] {
  const lines: string[] = [];
  for (const file of node.files.sort((left, right) => compareText(left.relativePath, right.relativePath))) {
    lines.push(...(file.relativePath === WINDOWS_SERVICE_HOST_RELATIVE_PATH
      ? serviceHostComponent(architecture, indent)
      : regularComponent(file, architecture, indent)));
  }
  for (const [name, child] of [...node.directories.entries()].sort(([left], [right]) => compareText(left, right))) {
    lines.push(`${indent}<Directory Id="${directoryId(child.relativePath)}" Name="${xml(name)}">`);
    lines.push(...renderDirectoryNode(child, architecture, `${indent}  `));
    lines.push(`${indent}</Directory>`);
  }
  return lines;
}

function permanentProgramDataComponent(id: string, directory: string, name: string, architecture: WindowsPackageArchitecture): string {
  return `    <DirectoryRef Id="${directory}">
      <Component Id="${id}" Guid="${deterministicGuid(COMPONENT_NAMESPACE, `${architecture}:programdata:${name}`)}" Bitness="always64" Permanent="yes" NeverOverwrite="yes">
        <CreateFolder />
        <RegistryValue Root="HKLM" Key="Software\\FormaSpec\\Installer" Name="${name}" Type="integer" Value="1" KeyPath="yes" />
      </Component>
    </DirectoryRef>`;
}

export function windowsWixSource(options: WindowsWixSourceOptions): string {
  const version = assertWindowsMsiVersion(options.version);
  const architecture = assertWindowsPackageArchitecture(options.architecture);
  const files = assertPayloadFileList(options.files);
  const tree = buildDirectoryTree(files);
  const payloadComponentIds = files.map((file) => componentId(file.relativePath));
  const productCode = windowsProductCode(version, architecture);
  const upgradeCode = windowsUpgradeCode(architecture);
  const installTree = renderDirectoryNode(tree, architecture, "      ").join("\n");
  const componentReferences = [
    ...payloadComponentIds,
    "ProgramDataRootComponent",
    "ProgramDataDataComponent",
    "ProgramDataBackupsComponent",
    "ProgramDataConfigComponent",
    "StartMenuComponent",
    "ProtocolComponent",
  ].map((id) => `      <ComponentRef Id="${id}" />`).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">
  <Package Name="FormaSpec" Manufacturer="FormaSpec" Version="${version}" Language="1033" ProductCode="${productCode}" UpgradeCode="${upgradeCode}" Scope="perMachine" InstallerVersion="500" Compressed="yes">
    <SummaryInformation Description="FormaSpec AI-first structured UI designer" Manufacturer="FormaSpec" />
    <MajorUpgrade AllowSameVersionUpgrades="no" DowngradeErrorMessage="A newer version of FormaSpec is already installed." Schedule="afterInstallInitialize" />
    <MediaTemplate EmbedCab="yes" CompressionLevel="high" />
    <Launch Condition="VersionNT64" Message="FormaSpec requires 64-bit Windows." />
    <Property Id="ARPNOMODIFY" Value="1" />
    <Feature Id="MainFeature" Title="FormaSpec" Level="1">
${componentReferences}
    </Feature>
  </Package>

  <Fragment>
    <StandardDirectory Id="ProgramFiles6432Folder">
      <Directory Id="INSTALLFOLDER" Name="${WINDOWS_INSTALL_DIRECTORY_NAME}" />
    </StandardDirectory>
    <StandardDirectory Id="CommonAppDataFolder">
      <Directory Id="FORMASPECPROGRAMDATA" Name="${WINDOWS_PROGRAM_DATA_DIRECTORY_NAME}">
        <Directory Id="FORMASPECDATA" Name="data" />
        <Directory Id="FORMASPECBACKUPS" Name="backups" />
        <Directory Id="FORMASPECCONFIG" Name="config" />
      </Directory>
    </StandardDirectory>
    <StandardDirectory Id="ProgramMenuFolder">
      <Directory Id="FORMASPECPROGRAMMENU" Name="FormaSpec" />
    </StandardDirectory>
  </Fragment>

  <Fragment>
    <DirectoryRef Id="INSTALLFOLDER">
${installTree}
      <Component Id="ProtocolComponent" Guid="${deterministicGuid(COMPONENT_NAMESPACE, `${architecture}:protocol`)}" Bitness="always64">
        <RegistryKey Root="HKLM" Key="Software\\Classes\\formaspec">
          <RegistryValue Type="string" Value="URL:FormaSpec Protocol" />
          <RegistryValue Name="URL Protocol" Type="string" Value="" />
          <RegistryKey Key="DefaultIcon">
            <RegistryValue Type="string" Value="&quot;[INSTALLFOLDER]service\\FormaSpec.ServiceHost.exe&quot;,0" />
          </RegistryKey>
          <RegistryKey Key="shell\\open\\command">
            <RegistryValue Type="string" Value="&quot;[INSTALLFOLDER]runtime\\node.exe&quot; &quot;[INSTALLFOLDER]service\\formaspec-protocol-handler.cjs&quot; &quot;%1&quot;" KeyPath="yes" />
          </RegistryKey>
        </RegistryKey>
      </Component>
    </DirectoryRef>
${permanentProgramDataComponent("ProgramDataRootComponent", "FORMASPECPROGRAMDATA", "ProgramDataRoot", architecture)}
${permanentProgramDataComponent("ProgramDataDataComponent", "FORMASPECDATA", "DataDirectory", architecture)}
${permanentProgramDataComponent("ProgramDataBackupsComponent", "FORMASPECBACKUPS", "BackupsDirectory", architecture)}
${permanentProgramDataComponent("ProgramDataConfigComponent", "FORMASPECCONFIG", "ConfigDirectory", architecture)}
    <DirectoryRef Id="FORMASPECPROGRAMMENU">
      <Component Id="StartMenuComponent" Guid="${deterministicGuid(COMPONENT_NAMESPACE, `${architecture}:start-menu`)}" Bitness="always64">
        <Shortcut Id="FormaSpecStartMenuShortcut" Name="FormaSpec" Description="Open the FormaSpec editor" Target="[INSTALLFOLDER]service\\FormaSpec.ServiceHost.exe" Arguments="--open-editor" WorkingDirectory="INSTALLFOLDER" Advertise="no" />
        <RemoveFolder Id="RemoveFormaSpecProgramMenu" Directory="FORMASPECPROGRAMMENU" On="uninstall" />
        <RegistryValue Root="HKLM" Key="Software\\FormaSpec\\Installer" Name="StartMenuShortcut" Type="integer" Value="1" KeyPath="yes" />
      </Component>
    </DirectoryRef>
  </Fragment>
</Wix>
`;
}
