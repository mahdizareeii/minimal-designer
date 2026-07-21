#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertLinuxPackageVersion,
  linuxDebPostInstallScript,
  linuxDebPostRemoveScript,
  linuxDebPreInstallScript,
  linuxDebPreRemoveScript,
  linuxPackageArchitecture,
} from "./linux-layout.js";
import {
  assertExecutableFile,
  assertLinuxPackagingHost,
  normalizeLinuxPayload,
  normalizeSourceDateEpoch,
  stageLinuxPayload,
  writeArtifactChecksum,
} from "./linux-packaging.js";
import {
  runPackageCommand,
  spawnPackageCommandRunner,
  type PackageCommandRunner,
} from "./package-command.js";

export interface DebPayloadBuildOptions {
  payloadRoot: string;
  outputDirectory: string;
  version: string;
  architecture: string;
  sourceDateEpoch: number;
  dpkgDebExecutable: string;
  commandRunner?: PackageCommandRunner;
  platform?: NodeJS.Platform;
}

export interface LinuxDebBuildOptions {
  workspaceRoot: string;
  outputDirectory: string;
  nodeExecutable: string;
  playwrightBrowsersDirectory: string;
  version: string;
  architecture?: string;
  sourceDateEpoch?: number;
  dpkgDebExecutable?: string;
  commandRunner?: PackageCommandRunner;
}

function installedSizeKiB(payloadRoot: string): number {
  let bytes = 0;
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (directory === payloadRoot && entry.name === "DEBIAN") continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(absolute);
      else if (entry.isFile()) bytes += fs.statSync(absolute).size;
    }
  };
  visit(payloadRoot);
  return Math.max(1, Math.ceil(bytes / 1024));
}

export function debianControl(
  payloadRoot: string,
  version: string,
  architecture: string,
): string {
  const productVersion = assertLinuxPackageVersion(version);
  return `Package: formaspec
Version: ${productVersion}
Section: graphics
Priority: optional
Architecture: ${linuxPackageArchitecture(architecture, "deb")}
Maintainer: FormaSpec Project
Installed-Size: ${installedSizeKiB(payloadRoot)}
Depends: systemd, xdg-utils, desktop-file-utils, ca-certificates, passwd
Description: AI-first structured UI design workspace
 FormaSpec is a self-hosted browser editor and MCP design service. This native
 package contains its pinned Node.js and Chromium headless-shell runtimes and
 binds the application API to host loopback.
`;
}

function writeDebianMetadata(
  payloadRoot: string,
  version: string,
  architecture: string,
): void {
  const controlRoot = path.join(payloadRoot, "DEBIAN");
  if (fs.existsSync(controlRoot)) throw new Error("Debian control metadata already exists in the payload root.");
  fs.mkdirSync(controlRoot, { recursive: true, mode: 0o755 });
  fs.writeFileSync(path.join(controlRoot, "control"), debianControl(payloadRoot, version, architecture), { mode: 0o644 });
  fs.writeFileSync(path.join(controlRoot, "conffiles"), "/etc/formaspec/formaspec.env\n", { mode: 0o644 });
  for (const [name, contents] of [
    ["preinst", linuxDebPreInstallScript()],
    ["postinst", linuxDebPostInstallScript()],
    ["prerm", linuxDebPreRemoveScript()],
    ["postrm", linuxDebPostRemoveScript()],
  ] as const) fs.writeFileSync(path.join(controlRoot, name), contents, { mode: 0o755 });
}

function assertBuiltArtifact(filename: string): void {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1) {
    throw new Error(`dpkg-deb did not create a regular non-empty artifact: ${filename}`);
  }
}

export function buildDebFromPayload(options: DebPayloadBuildOptions): string {
  assertLinuxPackagingHost(options.platform ?? process.platform);
  const version = assertLinuxPackageVersion(options.version);
  const sourceDateEpoch = normalizeSourceDateEpoch(options.sourceDateEpoch);
  assertExecutableFile(options.dpkgDebExecutable);
  const runner = options.commandRunner ?? spawnPackageCommandRunner;
  writeDebianMetadata(options.payloadRoot, version, options.architecture);
  normalizeLinuxPayload(options.payloadRoot, sourceDateEpoch);
  fs.mkdirSync(options.outputDirectory, { recursive: true, mode: 0o755 });
  const packageArchitecture = linuxPackageArchitecture(options.architecture, "deb");
  const output = path.resolve(
    options.outputDirectory,
    `FormaSpec-${version}-linux-${packageArchitecture}-unsigned.deb`,
  );
  fs.rmSync(output, { force: true });
  fs.rmSync(`${output}.sha256`, { force: true });
  try {
    runPackageCommand(
      runner,
      path.resolve(options.dpkgDebExecutable),
      [
        "--root-owner-group",
        "--uniform-compression",
        "--compression=xz",
        "--compression-level=9",
        "--build",
        path.resolve(options.payloadRoot),
        output,
      ],
      {
        env: {
          HOME: path.dirname(path.resolve(options.payloadRoot)),
          LC_ALL: "C",
          LANG: "C",
          PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          SOURCE_DATE_EPOCH: String(sourceDateEpoch),
          TMPDIR: os.tmpdir(),
          TZ: "UTC",
        },
      },
    );
    assertBuiltArtifact(output);
    writeArtifactChecksum(output);
    return output;
  } catch (error) {
    fs.rmSync(output, { force: true });
    fs.rmSync(`${output}.sha256`, { force: true });
    throw error;
  }
}

export function buildUnsignedLinuxDeb(options: LinuxDebBuildOptions): string {
  assertLinuxPackagingHost();
  const architecture = options.architecture ?? process.arch;
  linuxPackageArchitecture(architecture, "deb");
  const sourceDateEpoch = normalizeSourceDateEpoch(options.sourceDateEpoch);
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "formaspec-linux-deb-"));
  const payloadRoot = path.join(staging, "payload");
  try {
    stageLinuxPayload({
      workspaceRoot: options.workspaceRoot,
      payloadRoot,
      nodeExecutable: options.nodeExecutable,
      playwrightBrowsersDirectory: options.playwrightBrowsersDirectory,
      version: options.version,
      architecture,
      sourceDateEpoch,
      ...(options.commandRunner === undefined ? {} : { commandRunner: options.commandRunner }),
    });
    return buildDebFromPayload({
      payloadRoot,
      outputDirectory: options.outputDirectory,
      version: options.version,
      architecture,
      sourceDateEpoch,
      dpkgDebExecutable: options.dpkgDebExecutable ?? "/usr/bin/dpkg-deb",
      ...(options.commandRunner === undefined ? {} : { commandRunner: options.commandRunner }),
      platform: process.platform,
    });
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function findWorkspaceRoot(): string {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  if (!fs.existsSync(path.join(root, "pnpm-workspace.yaml"))) throw new Error("FormaSpec workspace root was not found.");
  return root;
}

export function linuxDebBuildUsage(): string {
  return `Usage: build-linux-deb \\
  [--output <absolute-directory>] \\
  [--version <version>] \\
  [--node <absolute-node>] \\
  [--playwright-browsers <absolute-directory>] \\
  [--dpkg-deb <absolute-executable>] \\
  [--source-date-epoch <unix-seconds>]

The command runs only on Linux and emits an unsigned DEB plus SHA-256 file.
It never downloads, signs, installs, or starts the generated package.
`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(linuxDebBuildUsage());
  } else {
    const workspaceRoot = findWorkspaceRoot();
    const rootPackage = JSON.parse(fs.readFileSync(path.join(workspaceRoot, "package.json"), "utf8")) as { version?: unknown };
    const version = argument("--version") ?? (typeof rootPackage.version === "string" ? rootPackage.version : "0.0.0");
    const outputDirectory = path.resolve(argument("--output") ?? path.join(workspaceRoot, "artifacts", "installers"));
    const nodeExecutable = path.resolve(argument("--node") ?? process.execPath);
    const browsers = path.resolve(
      argument("--playwright-browsers")
        ?? process.env.PLAYWRIGHT_BROWSERS_PATH
        ?? path.join(os.homedir(), ".cache", "ms-playwright"),
    );
    const sourceDateEpoch = normalizeSourceDateEpoch(argument("--source-date-epoch") ?? process.env.SOURCE_DATE_EPOCH);
    const output = buildUnsignedLinuxDeb({
      workspaceRoot,
      outputDirectory,
      nodeExecutable,
      playwrightBrowsersDirectory: browsers,
      version,
      sourceDateEpoch,
      ...(argument("--dpkg-deb") === undefined ? {} : { dpkgDebExecutable: path.resolve(argument("--dpkg-deb")!) }),
    });
    process.stdout.write(`${output}\n`);
  }
}
