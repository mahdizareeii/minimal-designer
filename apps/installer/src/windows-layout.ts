import { createHash } from "node:crypto";

export type WindowsPackageArchitecture = "x64" | "arm64";

export const WINDOWS_INSTALL_DIRECTORY_NAME = "FormaSpec";
export const WINDOWS_PROGRAM_DATA_DIRECTORY_NAME = "FormaSpec";
export const WINDOWS_API_SERVICE_NAME = "FormaSpecApi";
export const WINDOWS_RENDERER_SERVICE_NAME = "FormaSpecRenderer";
export const WINDOWS_SERVICE_HOST_RELATIVE_PATH = "service/FormaSpec.ServiceHost.exe";
export const WINDOWS_SERVICE_CONFIGURATION_RELATIVE_PATH = "service/formaspec-service.json";
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
  return deterministicGuid(UPGRADE_NAMESPACE, `upgrade:${assertWindowsPackageArchitecture(architecture)}`);
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
            <RegistryValue Type="string" Value="&quot;[INSTALLFOLDER]service\\FormaSpec.ServiceHost.exe&quot; --protocol &quot;%1&quot;" KeyPath="yes" />
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
