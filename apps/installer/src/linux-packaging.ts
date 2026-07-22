import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  assertChromiumOnlyBrowserPayload,
  assertContainedSymlinks,
  assertPinnedNodeLicense,
  copyRelocatableNodeModules,
  copyTreePreservingSymlinks,
  headlessShellDirectoryFromBrowserManifest,
  selectPackagedBrowserDirectories,
} from "./build-macos.js";
import { inspectManagedCodexAssets } from "./codex-assets.js";
import {
  LINUX_API_SERVICE,
  LINUX_CONFIG_ROOT,
  LINUX_INSTALL_ROOT,
  LINUX_RENDERER_SERVICE,
  assertLinuxPackageVersion,
  linuxApiServiceUnit,
  linuxApiWrapper,
  linuxAppStreamMetadata,
  linuxCompatibilityLauncher,
  linuxDesktopEntry,
  linuxEnvironmentFile,
  linuxFormaspecctlWrapper,
  linuxRendererServiceUnit,
  linuxRendererWrapper,
  linuxUrlHandler,
} from "./linux-layout.js";
import {
  runPackageCommand,
  spawnPackageCommandRunner,
  type PackageCommandRunner,
} from "./package-command.js";

export const PINNED_LINUX_NODE_VERSION = "24.14.0";
const DEFAULT_SOURCE_DATE_EPOCH = 0;
const MAX_SCANNED_TEXT_FILE_BYTES = 1024 * 1024;

const APPLICATION_PATHS = [
  "package.json",
  "pnpm-workspace.yaml",
  "apps/server/package.json",
  "apps/server/dist",
  "apps/web/package.json",
  "apps/web/dist",
  "apps/cli/package.json",
  "apps/cli/dist",
  "apps/cli/assets",
  "apps/local-bridge/package.json",
  "apps/local-bridge/dist",
  "apps/workspace-bridge/package.json",
  "apps/workspace-bridge/dist",
  "packages/core/package.json",
  "packages/core/dist",
] as const;

const APPLICATION_NODE_MODULES = [
  "node_modules",
  "apps/server/node_modules",
  "apps/cli/node_modules",
  "apps/local-bridge/node_modules",
  "apps/workspace-bridge/node_modules",
  "packages/core/node_modules",
] as const;

export interface LinuxPayloadOptions {
  workspaceRoot: string;
  payloadRoot: string;
  nodeExecutable: string;
  playwrightBrowsersDirectory: string;
  version: string;
  architecture: string;
  sourceDateEpoch?: number;
  commandRunner?: PackageCommandRunner;
}

function requirePath(target: string, kind: "file" | "directory"): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch (error) {
    throw new Error(`Required Linux packaging ${kind} is unavailable: ${target}`, { cause: error });
  }
  if ((kind === "file" && !stat.isFile()) || (kind === "directory" && !stat.isDirectory())) {
    throw new Error(`Required Linux packaging ${kind} is unavailable: ${target}`);
  }
}

export function assertLinuxPackagingHost(platform = process.platform): void {
  if (platform !== "linux") throw new Error("Native Linux packages must be built on Linux.");
}

export function assertExecutableFile(target: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    throw new Error(`Required packaging executable is unavailable: ${target}`, { cause: error });
  }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0) {
    throw new Error(`Required packaging executable is not a regular executable file: ${target}`);
  }
}

export function normalizeSourceDateEpoch(value: number | string | undefined): number {
  const parsed = value === undefined || value === "" ? DEFAULT_SOURCE_DATE_EPOCH : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 4_102_444_800) {
    throw new Error("SOURCE_DATE_EPOCH must be a whole Unix timestamp between 0 and 4102444800.");
  }
  return parsed;
}

function writeFile(target: string, contents: string, mode = 0o644): void {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
  fs.writeFileSync(target, contents, { mode });
}

function writeExecutable(target: string, contents: string): void {
  writeFile(target, contents, 0o755);
}

function nodeLicenseFiles(workspaceRoot: string): { license: string; provenance: string } {
  const directory = path.join(workspaceRoot, "apps/installer/assets/licenses");
  const license = path.join(directory, `node-v${PINNED_LINUX_NODE_VERSION}-LICENSE`);
  const provenance = path.join(directory, `node-v${PINNED_LINUX_NODE_VERSION}-provenance.json`);
  requirePath(license, "file");
  requirePath(provenance, "file");
  assertPinnedNodeLicense(
    fs.readFileSync(license),
    JSON.parse(fs.readFileSync(provenance, "utf8")) as unknown,
  );
  return { license, provenance };
}

function pinnedBrowserDirectory(workspaceRoot: string): string {
  const playwrightPackage = fs.realpathSync(path.join(workspaceRoot, "apps/server/node_modules/playwright"));
  const manifest = path.join(path.dirname(playwrightPackage), "playwright-core", "browsers.json");
  requirePath(manifest, "file");
  return headlessShellDirectoryFromBrowserManifest(JSON.parse(fs.readFileSync(manifest, "utf8")) as unknown);
}

function assertNodeRuntime(
  nodeExecutable: string,
  runner: PackageCommandRunner,
): void {
  assertExecutableFile(nodeExecutable);
  const result = runPackageCommand(runner, path.resolve(nodeExecutable), ["--version"], {
    env: {
      LANG: "C",
      LC_ALL: "C",
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      TZ: "UTC",
    },
  });
  if (result.stdout.trim() !== `v${PINNED_LINUX_NODE_VERSION}`) {
    throw new Error(`The Linux package requires the pinned Node.js v${PINNED_LINUX_NODE_VERSION} runtime.`);
  }
}

function assertNoLocalBuildPaths(root: string, forbiddenPaths: readonly string[]): void {
  const forbidden = forbiddenPaths.filter(Boolean).map((value) => Buffer.from(path.resolve(value)));
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!entry.isFile() || fs.statSync(absolute).size > MAX_SCANNED_TEXT_FILE_BYTES) continue;
      const bytes = fs.readFileSync(absolute);
      if (forbidden.some((needle) => bytes.includes(needle))) {
        throw new Error(`Linux installer payload leaks a local build path: ${absolute}`);
      }
    }
  };
  visit(root);
}

export function normalizeLinuxPayload(root: string, sourceDateEpoch: number): void {
  const timestamp = normalizeSourceDateEpoch(sourceDateEpoch);
  const visit = (target: string): void => {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) {
      fs.lutimesSync(target, timestamp, timestamp);
      return;
    }
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(target).sort((left, right) => left.localeCompare(right));
      for (const entry of entries) visit(path.join(target, entry));
      fs.chmodSync(target, 0o755);
      fs.utimesSync(target, timestamp, timestamp);
      return;
    }
    if (!stat.isFile()) throw new Error(`Linux installer payload contains an unsupported filesystem entry: ${target}`);
    fs.chmodSync(target, (stat.mode & 0o111) === 0 ? 0o644 : 0o755);
    fs.utimesSync(target, timestamp, timestamp);
  };
  visit(root);
}

export function sha256File(filename: string): string {
  return createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}

export function writeArtifactChecksum(filename: string): string {
  requirePath(filename, "file");
  const checksum = `${filename}.sha256`;
  fs.writeFileSync(checksum, `${sha256File(filename)}  ${path.basename(filename)}\n`, { mode: 0o644 });
  return checksum;
}

export function stageLinuxPayload(options: LinuxPayloadOptions): void {
  const version = assertLinuxPackageVersion(options.version);
  const sourceDateEpoch = normalizeSourceDateEpoch(options.sourceDateEpoch);
  const runner = options.commandRunner ?? spawnPackageCommandRunner;
  requirePath(options.workspaceRoot, "directory");
  if (fs.existsSync(options.payloadRoot)) throw new Error(`Linux payload staging root already exists: ${options.payloadRoot}`);
  assertNodeRuntime(options.nodeExecutable, runner);
  requirePath(options.playwrightBrowsersDirectory, "directory");
  for (const required of [
    "apps/server/dist/index.js",
    "apps/server/dist/renderer-worker.js",
    "apps/web/dist/index.html",
    "apps/cli/dist/index.js",
    "apps/local-bridge/dist/index.js",
    "apps/workspace-bridge/dist/cli.js",
    "packages/core/dist/index.js",
    "node_modules/.pnpm",
    "docs/LICENSING.md",
    "docs/LINUX_PACKAGING.md",
  ]) {
    const extension = path.extname(required);
    requirePath(path.join(options.workspaceRoot, required), extension ? "file" : "directory");
  }

  const installRoot = path.join(options.payloadRoot, ...LINUX_INSTALL_ROOT.split("/").filter(Boolean));
  const appRoot = path.join(installRoot, "app");
  for (const relative of APPLICATION_PATHS) {
    copyTreePreservingSymlinks(path.join(options.workspaceRoot, relative), path.join(appRoot, relative));
  }
  inspectManagedCodexAssets(path.join(appRoot, "apps/cli/assets"));
  for (const relative of APPLICATION_NODE_MODULES) {
    copyRelocatableNodeModules(options.workspaceRoot, appRoot, relative);
  }

  copyTreePreservingSymlinks(options.nodeExecutable, path.join(installRoot, "runtime", "node"));
  fs.chmodSync(path.join(installRoot, "runtime", "node"), 0o755);
  const licenseFiles = nodeLicenseFiles(options.workspaceRoot);
  const runtimeLicenses = path.join(installRoot, "runtime", "licenses");
  copyTreePreservingSymlinks(licenseFiles.license, path.join(runtimeLicenses, path.basename(licenseFiles.license)));
  copyTreePreservingSymlinks(licenseFiles.provenance, path.join(runtimeLicenses, path.basename(licenseFiles.provenance)));
  assertPinnedNodeLicense(
    fs.readFileSync(path.join(runtimeLicenses, path.basename(licenseFiles.license))),
    JSON.parse(fs.readFileSync(path.join(runtimeLicenses, path.basename(licenseFiles.provenance)), "utf8")) as unknown,
  );

  const browserTarget = path.join(installRoot, "runtime", "ms-playwright");
  fs.mkdirSync(browserTarget, { recursive: true, mode: 0o755 });
  const browserDirectory = pinnedBrowserDirectory(options.workspaceRoot);
  for (const selected of selectPackagedBrowserDirectories(options.playwrightBrowsersDirectory, browserDirectory)) {
    copyTreePreservingSymlinks(
      path.join(options.playwrightBrowsersDirectory, selected),
      path.join(browserTarget, selected),
    );
  }
  assertChromiumOnlyBrowserPayload(browserTarget);

  writeExecutable(path.join(installRoot, "bin", "formaspec-api"), linuxApiWrapper());
  writeExecutable(path.join(installRoot, "bin", "formaspec-renderer"), linuxRendererWrapper());
  writeExecutable(path.join(installRoot, "bin", "formaspecctl"), linuxFormaspecctlWrapper());
  writeExecutable(path.join(appRoot, "designer"), linuxCompatibilityLauncher(version));
  writeFile(path.join(installRoot, "VERSION"), `${version}\n`);
  writeFile(path.join(installRoot, "install-manifest.json"), `${JSON.stringify({
    format: "formaspec-native-install",
    version: 1,
    productVersion: version,
    platform: "linux",
    architecture: options.architecture,
    managedBy: "formaspec",
    signed: false,
  }, null, 2)}\n`);

  writeExecutable(path.join(options.payloadRoot, "usr/bin/formaspecctl"), linuxFormaspecctlWrapper());
  writeExecutable(path.join(options.payloadRoot, "usr/bin/designer"), linuxCompatibilityLauncher(version));
  writeExecutable(path.join(options.payloadRoot, "usr/bin/formaspec-open"), linuxUrlHandler());
  writeFile(
    path.join(options.payloadRoot, "usr/lib/systemd/system", LINUX_RENDERER_SERVICE),
    linuxRendererServiceUnit(),
  );
  writeFile(
    path.join(options.payloadRoot, "usr/lib/systemd/system", LINUX_API_SERVICE),
    linuxApiServiceUnit(),
  );
  writeFile(path.join(options.payloadRoot, ...LINUX_CONFIG_ROOT.split("/").filter(Boolean), "formaspec.env"), linuxEnvironmentFile());
  writeFile(path.join(options.payloadRoot, "usr/share/applications/formaspec.desktop"), linuxDesktopEntry());
  writeFile(
    path.join(options.payloadRoot, "usr/share/metainfo/com.formaspec.FormaSpec.metainfo.xml"),
    linuxAppStreamMetadata(version),
  );
  copyTreePreservingSymlinks(
    path.join(options.workspaceRoot, "docs/LICENSING.md"),
    path.join(options.payloadRoot, "usr/share/doc/formaspec/LICENSING.md"),
  );
  copyTreePreservingSymlinks(
    path.join(options.workspaceRoot, "docs/LINUX_PACKAGING.md"),
    path.join(options.payloadRoot, "usr/share/doc/formaspec/LINUX_PACKAGING.md"),
  );
  writeFile(path.join(options.payloadRoot, "usr/share/doc/formaspec/RUNTIME-NOTICES.txt"), [
    `The bundled Node.js v${PINNED_LINUX_NODE_VERSION} license and exact provenance are under ${LINUX_INSTALL_ROOT}/runtime/licenses.`,
    `The pinned Chromium headless-shell payload and its upstream notice files are under ${LINUX_INSTALL_ROOT}/runtime/ms-playwright.`,
    "No FFmpeg, Firefox, WebKit, system Chromium, Node package manager, or package-registry client is added by this installer.",
    "Artifact-specific legal, vulnerability, reproducibility, and lifecycle evidence remains required before distribution.",
    "",
  ].join("\n"));

  assertContainedSymlinks(options.payloadRoot);
  assertNoLocalBuildPaths(options.payloadRoot, [options.workspaceRoot, os.homedir()]);
  normalizeLinuxPayload(options.payloadRoot, sourceDateEpoch);
}
