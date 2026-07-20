#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MACOS_API_LABEL,
  MACOS_INSTALL_ROOT,
  MACOS_RENDERER_LABEL,
  apiWrapper,
  applicationInfoPlist,
  assertPackageVersion,
  compatibilityLauncher,
  formaspecctlWrapper,
  launchAgentPlist,
  postinstallScript,
  preinstallScript,
  protocolHandler,
  rendererWrapper,
} from "./macos-layout.js";

function requirePath(target: string, kind: "file" | "directory"): void {
  const stat = fs.statSync(target);
  if ((kind === "file" && !stat.isFile()) || (kind === "directory" && !stat.isDirectory())) {
    throw new Error(`Required packaging ${kind} is unavailable: ${target}`);
  }
}

export function copyTreePreservingSymlinks(source: string, destination: string): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, {
    recursive: true,
    dereference: false,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
}

const NODE_MODULES_BUILD_METADATA = new Set([
  ".bin",
  ".cache",
  ".DS_Store",
  ".modules.yaml",
  ".package-map.json",
  ".pnpm-workspace-state-v1.json",
  ".turbo",
  ".vite",
]);

function isPathContained(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function copyNodeModulesEntry(
  source: string,
  destination: string,
  workspaceRoot: string,
  packagedAppRoot: string,
): void {
  const sourceStat = fs.lstatSync(source);
  if (sourceStat.isSymbolicLink()) {
    const sourceLink = fs.readlinkSync(source);
    const sourceTarget = path.resolve(path.dirname(source), sourceLink);
    if (!isPathContained(workspaceRoot, sourceTarget)) {
      throw new Error(`Application node_modules symlink escapes the workspace: ${source}`);
    }

    const workspaceRelativeTarget = path.relative(workspaceRoot, sourceTarget);
    const packagedTarget = path.resolve(packagedAppRoot, workspaceRelativeTarget);
    if (!isPathContained(packagedAppRoot, packagedTarget)) {
      throw new Error(`Application node_modules symlink cannot be relocated into the package: ${source}`);
    }

    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const unchangedTarget = path.resolve(path.dirname(destination), sourceLink);
    const packagedLink = !path.isAbsolute(sourceLink) && unchangedTarget === packagedTarget
      ? sourceLink
      : path.relative(path.dirname(destination), packagedTarget) || ".";
    fs.symlinkSync(packagedLink, destination);
    return;
  }

  if (sourceStat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true, mode: sourceStat.mode });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      if (NODE_MODULES_BUILD_METADATA.has(entry.name)) continue;
      copyNodeModulesEntry(
        path.join(source, entry.name),
        path.join(destination, entry.name),
        workspaceRoot,
        packagedAppRoot,
      );
    }
    fs.chmodSync(destination, sourceStat.mode);
    fs.utimesSync(destination, sourceStat.atime, sourceStat.mtime);
    return;
  }

  if (!sourceStat.isFile()) {
    throw new Error(`Application node_modules contains an unsupported filesystem entry: ${source}`);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  fs.chmodSync(destination, sourceStat.mode);
  fs.utimesSync(destination, sourceStat.atime, sourceStat.mtime);
}

export function copyRelocatableNodeModules(
  workspaceRoot: string,
  packagedAppRoot: string,
  workspaceRelativeNodeModules: string,
): void {
  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
  const resolvedPackagedAppRoot = path.resolve(packagedAppRoot);
  if (path.isAbsolute(workspaceRelativeNodeModules) || path.basename(workspaceRelativeNodeModules) !== "node_modules") {
    throw new Error(`Application dependency path must be a workspace-relative node_modules directory: ${workspaceRelativeNodeModules}`);
  }
  const source = path.resolve(resolvedWorkspaceRoot, workspaceRelativeNodeModules);
  const destination = path.resolve(resolvedPackagedAppRoot, workspaceRelativeNodeModules);
  if (!isPathContained(resolvedWorkspaceRoot, source) || !isPathContained(resolvedPackagedAppRoot, destination)) {
    throw new Error(`Application dependency path escapes its root: ${workspaceRelativeNodeModules}`);
  }
  const sourceStat = fs.lstatSync(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error(`Application dependency directory is unavailable: ${source}`);
  }
  copyNodeModulesEntry(source, destination, resolvedWorkspaceRoot, resolvedPackagedAppRoot);
}

export function assertContainedSymlinks(root: string): void {
  const resolvedRoot = path.resolve(root);
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = fs.readlinkSync(absolute);
        if (path.isAbsolute(target)) throw new Error(`Installer payload contains an absolute symlink: ${absolute}`);
        const resolvedTarget = path.resolve(path.dirname(absolute), target);
        if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
          throw new Error(`Installer payload symlink escapes its root: ${absolute}`);
        }
      } else if (entry.isDirectory()) visit(absolute);
    }
  };
  visit(resolvedRoot);
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
      if (!entry.isFile() || fs.statSync(absolute).size > 1024 * 1024) continue;
      const bytes = fs.readFileSync(absolute);
      if (forbidden.some((needle) => bytes.includes(needle))) {
        throw new Error(`Installer payload leaks a local build path: ${absolute}`);
      }
    }
  };
  visit(root);
}

function writeExecutable(target: string, contents: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents, { mode: 0o755 });
}

function writeFile(target: string, contents: string, mode = 0o644): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents, { mode });
}

function command(executable: string, args: readonly string[]): void {
  const result = spawnSync(executable, [...args], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(executable)} failed with exit code ${result.status ?? "unknown"}.`);
}

function commandOutput(executable: string, args: readonly string[]): string {
  const result = spawnSync(executable, [...args], {
    encoding: "utf8",
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${path.basename(executable)} failed with exit code ${result.status ?? "unknown"}: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function findWorkspaceRoot(): string {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  requirePath(path.join(root, "pnpm-workspace.yaml"), "file");
  return root;
}

function sha256(filename: string): string {
  return createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}

const PINNED_NODE_VERSION = "24.14.0";
const PINNED_NODE_LICENSE_SHA256 = "4573185d56580da2b890ba34a85a409257640f1c5632eade4300137266194d18";
const PINNED_NODE_LICENSE_SIZE = 156_926;
const PINNED_NODE_SOURCE_ARCHIVE_SHA256 = "9fe025ef4028aba95d16e7810518bf4a5e8abfb0bdc07d8a3fdbb0afd538d77f";

export function assertPinnedNodeVersion(versionOutput: string): void {
  if (versionOutput.trim() !== `v${PINNED_NODE_VERSION}`) {
    throw new Error(`The macOS package requires the pinned Node.js v${PINNED_NODE_VERSION} runtime.`);
  }
}

export function assertPinnedNodeLicense(license: Buffer, provenanceValue: unknown): void {
  if (license.length !== PINNED_NODE_LICENSE_SIZE
    || createHash("sha256").update(license).digest("hex") !== PINNED_NODE_LICENSE_SHA256) {
    throw new Error(`The vendored Node.js v${PINNED_NODE_VERSION} LICENSE failed its exact integrity check.`);
  }
  if (!provenanceValue || typeof provenanceValue !== "object") {
    throw new Error("The vendored Node.js LICENSE provenance is malformed.");
  }
  const provenance = provenanceValue as Record<string, unknown>;
  if (provenance.format !== "formaspec-vendored-license-provenance"
    || provenance.formatVersion !== 1
    || provenance.component !== "Node.js"
    || provenance.version !== PINNED_NODE_VERSION
    || provenance.sourceArchiveSha256 !== PINNED_NODE_SOURCE_ARCHIVE_SHA256
    || provenance.licenseSha256 !== PINNED_NODE_LICENSE_SHA256
    || provenance.licenseSizeBytes !== PINNED_NODE_LICENSE_SIZE) {
    throw new Error("The vendored Node.js LICENSE provenance does not match the pinned runtime.");
  }
}

function pinnedNodeLicenseFiles(workspaceRoot: string): { license: string; provenance: string } {
  const directory = path.join(workspaceRoot, "apps/installer/assets/licenses");
  const license = path.join(directory, `node-v${PINNED_NODE_VERSION}-LICENSE`);
  const provenance = path.join(directory, `node-v${PINNED_NODE_VERSION}-provenance.json`);
  requirePath(license, "file");
  requirePath(provenance, "file");
  assertPinnedNodeLicense(
    fs.readFileSync(license),
    JSON.parse(fs.readFileSync(provenance, "utf8")) as unknown,
  );
  return { license, provenance };
}

function assertPinnedNodeExecutable(nodeExecutable: string): void {
  const result = spawnSync(nodeExecutable, ["--version"], { encoding: "utf8", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("The pinned Node.js runtime could not report its version.");
  assertPinnedNodeVersion(result.stdout);
}

const PACKAGED_BROWSER_DIRECTORY = /^chromium_headless_shell-\d+$/;
const FORBIDDEN_BROWSER_PAYLOAD_NAME = /(?:ffmpeg|firefox|webkit|lgpl)/i;

export function headlessShellDirectoryFromBrowserManifest(value: unknown): string {
  if (!value || typeof value !== "object" || !("browsers" in value) || !Array.isArray(value.browsers)) {
    throw new Error("The pinned Playwright browser manifest is malformed.");
  }
  const browser = value.browsers.find((candidate): candidate is { name: string; revision: string } => (
    Boolean(candidate)
    && typeof candidate === "object"
    && "name" in candidate
    && candidate.name === "chromium-headless-shell"
    && "revision" in candidate
    && typeof candidate.revision === "string"
  ));
  if (!browser || !/^\d+$/.test(browser.revision)) {
    throw new Error("The pinned Playwright Chromium headless-shell revision is unavailable.");
  }
  return `chromium_headless_shell-${browser.revision}`;
}

function pinnedHeadlessShellDirectory(workspaceRoot: string): string {
  const playwrightPackage = fs.realpathSync(path.join(workspaceRoot, "apps/server/node_modules/playwright"));
  const manifest = path.join(path.dirname(playwrightPackage), "playwright-core", "browsers.json");
  requirePath(manifest, "file");
  return headlessShellDirectoryFromBrowserManifest(JSON.parse(fs.readFileSync(manifest, "utf8")) as unknown);
}

export function selectPackagedBrowserDirectories(
  playwrightBrowsersDirectory: string,
  pinnedDirectory: string,
): string[] {
  if (!PACKAGED_BROWSER_DIRECTORY.test(pinnedDirectory)) {
    throw new Error("The pinned Playwright Chromium headless-shell directory is invalid.");
  }
  const entry = fs.readdirSync(playwrightBrowsersDirectory, { withFileTypes: true })
    .find((candidate) => candidate.isDirectory() && candidate.name === pinnedDirectory);
  if (!entry) throw new Error("The pinned Playwright Chromium headless-shell payload is unavailable.");
  return [entry.name];
}

export function assertChromiumOnlyBrowserPayload(root: string): void {
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (FORBIDDEN_BROWSER_PAYLOAD_NAME.test(entry.name)) {
        throw new Error(`Installer browser payload contains an unused or disallowed artifact: ${absolute}`);
      }
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(absolute);
    }
  };
  const topLevel = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  if (topLevel.some((name) => !PACKAGED_BROWSER_DIRECTORY.test(name))) {
    throw new Error("Installer browser payload contains a non-Chromium browser directory.");
  }
  visit(root);
}

export function assertNoAppleDoubleFiles(root: string): void {
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.name.startsWith("._")) {
        throw new Error(`Installer payload contains an AppleDouble sidecar: ${absolute}`);
      }
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(absolute);
    }
  };
  visit(root);
}

const OMITTED_MAC_METADATA = new Set([".AppleDouble", ".DS_Store", "__MACOSX"]);

export function removeMacMetadataFiles(root: string): void {
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (OMITTED_MAC_METADATA.has(entry.name)) {
        fs.rmSync(absolute, { recursive: true, force: true });
      } else if (entry.isDirectory() && !entry.isSymbolicLink()) {
        visit(absolute);
      }
    }
  };
  visit(root);
}

export function isAppleDoubleArchivePath(value: string): boolean {
  return value.split("/").some((segment) => segment.startsWith("._"));
}

export function filterAppleDoubleBomListing(listing: string): { listing: string; numberOfFiles: number } {
  const lines = listing.split(/\r?\n/).filter(Boolean);
  const filtered = lines.filter((line) => {
    const [filename] = line.split("\t", 1);
    return filename !== undefined && !isAppleDoubleArchivePath(filename);
  });
  if (filtered.length === 0) throw new Error("Installer BOM does not contain any package payload entries.");
  return { listing: `${filtered.join("\n")}\n`, numberOfFiles: filtered.length };
}

export function updatePackageInfoPayloadCount(packageInfo: string, numberOfFiles: number): string {
  if (!Number.isSafeInteger(numberOfFiles) || numberOfFiles < 1) {
    throw new Error("Installer payload file count is invalid.");
  }
  const marker = /(<payload\s+numberOfFiles=")\d+("\s+installKBytes="\d+"\s*\/>)/;
  if (!marker.test(packageInfo)) throw new Error("Installer PackageInfo payload metadata is malformed.");
  return packageInfo.replace(marker, `$1${numberOfFiles}$2`);
}

function rebuildComponentPayloadWithoutMacMetadata(
  component: string,
  staging: string,
): string {
  const expanded = path.join(staging, "component-expanded");
  const cleanPayload = path.join(staging, "Payload.clean");
  const bomListing = path.join(staging, "Bom.clean.listing");
  const cleanComponent = path.join(staging, "FormaSpec.clean.component.pkg");
  command("/usr/sbin/pkgutil", ["--expand-full", component, expanded]);
  const expandedPayload = path.join(expanded, "Payload");
  requirePath(expandedPayload, "directory");
  command("/usr/bin/bsdtar", [
    "-czf", cleanPayload,
    "--format", "cpio",
    "--no-xattrs",
    "--no-acls",
    "--no-fflags",
    "--no-mac-metadata",
    "--uid", "0",
    "--gid", "0",
    "--uname", "root",
    "--gname", "wheel",
    "--options", "gzip:!timestamp",
    "-C", expandedPayload,
    ".",
  ]);
  const archivePaths = commandOutput("/usr/bin/bsdtar", ["-tf", cleanPayload]).split(/\r?\n/).filter(Boolean);
  if (archivePaths.some(isAppleDoubleArchivePath)) {
    throw new Error("Installer payload archive still contains AppleDouble metadata.");
  }

  const filteredBom = filterAppleDoubleBomListing(
    commandOutput("/usr/bin/lsbom", [path.join(expanded, "Bom")]),
  );
  fs.writeFileSync(bomListing, filteredBom.listing, { mode: 0o600 });
  command("/usr/bin/mkbom", ["-i", bomListing, path.join(expanded, "Bom")]);
  const rebuiltBom = commandOutput("/usr/bin/lsbom", [path.join(expanded, "Bom")]);
  if (rebuiltBom.split(/\r?\n/).some((line) => {
    const [filename] = line.split("\t", 1);
    return filename !== undefined && isAppleDoubleArchivePath(filename);
  })) throw new Error("Installer BOM still contains AppleDouble metadata.");

  const packageInfoPath = path.join(expanded, "PackageInfo");
  fs.writeFileSync(
    packageInfoPath,
    updatePackageInfoPayloadCount(fs.readFileSync(packageInfoPath, "utf8"), filteredBom.numberOfFiles),
  );
  fs.rmSync(expandedPayload, { recursive: true, force: true });
  fs.renameSync(cleanPayload, expandedPayload);
  command("/usr/sbin/pkgutil", ["--flatten", expanded, cleanComponent]);
  return cleanComponent;
}

export interface MacPackageBuildOptions {
  workspaceRoot: string;
  outputDirectory: string;
  nodeExecutable: string;
  playwrightBrowsersDirectory: string;
  version: string;
}

export function buildUnsignedMacPackage(options: MacPackageBuildOptions): string {
  if (process.platform !== "darwin") throw new Error("The macOS PKG target must be built on macOS.");
  const version = assertPackageVersion(options.version);
  requirePath(options.nodeExecutable, "file");
  assertPinnedNodeExecutable(options.nodeExecutable);
  const nodeLicenseFiles = pinnedNodeLicenseFiles(options.workspaceRoot);
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
  ]) requirePath(path.join(options.workspaceRoot, required), required.endsWith(".js") || required.endsWith(".html") ? "file" : "directory");

  fs.mkdirSync(options.outputDirectory, { recursive: true, mode: 0o700 });
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "formaspec-macos-pkg-"));
  const payload = path.join(staging, "payload");
  const scripts = path.join(staging, "scripts");
  const component = path.join(staging, "FormaSpec.component.pkg");
  const installRoot = path.join(payload, ...MACOS_INSTALL_ROOT.split("/").filter(Boolean));
  const appRoot = path.join(installRoot, "app");
  try {
    for (const relative of [
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
    ]) copyTreePreservingSymlinks(path.join(options.workspaceRoot, relative), path.join(appRoot, relative));

    for (const relative of [
      "node_modules",
      "apps/server/node_modules",
      "apps/cli/node_modules",
      "apps/local-bridge/node_modules",
      "apps/workspace-bridge/node_modules",
      "packages/core/node_modules",
    ]) copyRelocatableNodeModules(options.workspaceRoot, appRoot, relative);

    copyTreePreservingSymlinks(options.nodeExecutable, path.join(installRoot, "runtime", "node"));
    fs.chmodSync(path.join(installRoot, "runtime", "node"), 0o755);
    const runtimeLicenses = path.join(installRoot, "runtime", "licenses");
    copyTreePreservingSymlinks(
      nodeLicenseFiles.license,
      path.join(runtimeLicenses, path.basename(nodeLicenseFiles.license)),
    );
    copyTreePreservingSymlinks(
      nodeLicenseFiles.provenance,
      path.join(runtimeLicenses, path.basename(nodeLicenseFiles.provenance)),
    );
    assertPinnedNodeLicense(
      fs.readFileSync(path.join(runtimeLicenses, path.basename(nodeLicenseFiles.license))),
      JSON.parse(fs.readFileSync(path.join(runtimeLicenses, path.basename(nodeLicenseFiles.provenance)), "utf8")) as unknown,
    );
    const browserTarget = path.join(installRoot, "runtime", "ms-playwright");
    fs.mkdirSync(browserTarget, { recursive: true });
    const pinnedBrowserDirectory = pinnedHeadlessShellDirectory(options.workspaceRoot);
    for (const browserDirectory of selectPackagedBrowserDirectories(
      options.playwrightBrowsersDirectory,
      pinnedBrowserDirectory,
    )) {
      copyTreePreservingSymlinks(
        path.join(options.playwrightBrowsersDirectory, browserDirectory),
        path.join(browserTarget, browserDirectory),
      );
    }
    assertChromiumOnlyBrowserPayload(browserTarget);

    writeExecutable(path.join(installRoot, "bin", "formaspec-api"), apiWrapper());
    writeExecutable(path.join(installRoot, "bin", "formaspec-renderer"), rendererWrapper());
    writeExecutable(path.join(installRoot, "bin", "formaspecctl"), formaspecctlWrapper());
    writeExecutable(path.join(appRoot, "designer"), compatibilityLauncher(version));
    writeFile(path.join(installRoot, "VERSION"), `${version}\n`);
    writeFile(path.join(installRoot, "install-manifest.json"), `${JSON.stringify({
      format: "formaspec-native-install",
      version: 1,
      productVersion: version,
      platform: "macos",
      architecture: process.arch,
      managedBy: "formaspec",
      signed: false,
    }, null, 2)}\n`, 0o644);

    writeExecutable(path.join(payload, "usr", "local", "bin", "formaspecctl"), formaspecctlWrapper());
    writeFile(
      path.join(payload, "Library", "LaunchAgents", `${MACOS_RENDERER_LABEL}.plist`),
      launchAgentPlist(MACOS_RENDERER_LABEL, `${MACOS_INSTALL_ROOT}/bin/formaspec-renderer`),
    );
    writeFile(
      path.join(payload, "Library", "LaunchAgents", `${MACOS_API_LABEL}.plist`),
      launchAgentPlist(MACOS_API_LABEL, `${MACOS_INSTALL_ROOT}/bin/formaspec-api`),
    );
    const appBundle = path.join(payload, "Applications", "FormaSpec.app", "Contents");
    writeFile(path.join(appBundle, "Info.plist"), applicationInfoPlist(version));
    writeExecutable(path.join(appBundle, "MacOS", "FormaSpec"), protocolHandler());

    writeExecutable(path.join(scripts, "preinstall"), preinstallScript());
    writeExecutable(path.join(scripts, "postinstall"), postinstallScript());

    // macOS provenance/resource-fork xattrs otherwise become thousands of `._*`
    // AppleDouble entries inside the component package archive.
    removeMacMetadataFiles(payload);
    command("/usr/bin/xattr", ["-crs", payload]);
    assertNoAppleDoubleFiles(payload);
    assertContainedSymlinks(payload);
    assertNoLocalBuildPaths(payload, [options.workspaceRoot, os.homedir()]);

    const filename = `FormaSpec-${version}-macos-${process.arch}-unsigned.pkg`;
    const output = path.resolve(options.outputDirectory, filename);
    fs.rmSync(output, { force: true });
    fs.rmSync(`${output}.sha256`, { force: true });
    command("/usr/bin/pkgbuild", [
      "--root", payload,
      "--scripts", scripts,
      "--identifier", "com.formaspec.pkg",
      "--version", version,
      "--install-location", "/",
      component,
    ]);
    const cleanComponent = rebuildComponentPayloadWithoutMacMetadata(component, staging);
    command("/usr/bin/productbuild", ["--package", cleanComponent, output]);
    const digest = sha256(output);
    fs.writeFileSync(`${output}.sha256`, `${digest}  ${path.basename(output)}\n`, { mode: 0o600 });
    return output;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const workspaceRoot = findWorkspaceRoot();
  const rootPackage = JSON.parse(fs.readFileSync(path.join(workspaceRoot, "package.json"), "utf8")) as { version?: unknown };
  const version = argument("--version") ?? (typeof rootPackage.version === "string" ? rootPackage.version : "0.0.0");
  const outputDirectory = path.resolve(argument("--output") ?? path.join(workspaceRoot, "artifacts", "installers"));
  const nodeExecutable = path.resolve(argument("--node") ?? process.execPath);
  const defaultBrowsers = path.join(os.homedir(), "Library", "Caches", "ms-playwright");
  const playwrightBrowsersDirectory = path.resolve(
    argument("--playwright-browsers") ?? process.env.PLAYWRIGHT_BROWSERS_PATH ?? defaultBrowsers,
  );
  const output = buildUnsignedMacPackage({
    workspaceRoot,
    outputDirectory,
    nodeExecutable,
    playwrightBrowsersDirectory,
    version,
  });
  process.stdout.write(`${output}\n`);
}
