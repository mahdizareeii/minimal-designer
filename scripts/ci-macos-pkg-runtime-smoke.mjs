#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  parsePackageInfo,
  parseSha256Sidecar,
  scanPackageTree,
} from "./macos-pkg-evidence-lib.mjs";

export const MACOS_RUNTIME_SMOKE_CONTRACT = Object.freeze({
  nodeVersion: "v24.14.0",
  playwrightRevision: "1228",
  schemaVersion: 16,
  mcpProtocolVersion: "2025-06-18",
  mcpToolCount: 52,
  mcpResourceCount: 25,
  maximumPackageBytes: 8 * 1024 * 1024 * 1024,
  maximumCommandOutputBytes: 16 * 1024 * 1024,
  maximumHttpResponseBytes: 16 * 1024 * 1024,
  startupTimeoutMs: 120_000,
  commandTimeoutMs: 180_000,
});

export const EXPECTED_MCP_TOOL_NAMES = Object.freeze([
  "context_get",
  "design_commit_archive_preview",
  "design_commit_preview",
  "design_create",
  "design_history",
  "design_lint",
  "design_list",
  "design_preview_archive_nodes",
  "design_preview_changes",
  "design_read",
  "design_render",
  "design_restore_revision",
  "design_system_list",
  "design_system_component_insert_preview",
  "design_system_project_pin_read",
  "design_system_read",
  "design_system_release_read",
  "design_system_revision_release_read",
  "design_system_upgrade_commit",
  "design_system_upgrade_preview",
  "handoff_create",
  "handoff_execution_decision_record",
  "handoff_execution_decisions_read",
  "handoff_list",
  "handoff_read",
  "handoff_submit_review",
  "handoff_update",
  "implementation_mapping_create",
  "implementation_mapping_read",
  "node_search",
  "organization_policy_read",
  "planning_session_create",
  "planning_session_list",
  "planning_session_read",
  "planning_session_save_answer",
  "product_spec_commit_preview",
  "product_spec_preview",
  "product_spec_read",
  "redesign_assessment_create",
  "redesign_assessment_read",
  "redesign_stage_artifact_read",
  "redesign_stage_artifact_write",
  "redesign_stage_revise",
  "redesign_stage_transition",
  "repository_inventory_list",
  "repository_inventory_persist",
  "repository_inventory_read",
  "task_claim",
  "task_create",
  "task_list",
  "task_read",
  "task_transition",
].sort(compareText));

export const EXPECTED_FIXED_RESOURCES = Object.freeze([
  Object.freeze({ name: "formaspec-schema-v1", uri: "formaspec://schema/v1" }),
  Object.freeze({ name: "formaspec-schema-v2", uri: "formaspec://schema/v2" }),
  Object.freeze({ name: "foundation-design-system", uri: "formaspec://design-systems/foundation/1" }),
  Object.freeze({ name: "organization-policy", uri: "formaspec://organizations/current/policy" }),
].sort((left, right) => compareText(left.name, right.name)));

export const EXPECTED_RESOURCE_TEMPLATES = Object.freeze([
  Object.freeze({ name: "agent-task", uri: "formaspec://tasks/{taskId}" }),
  Object.freeze({ name: "design-head", uri: "formaspec://designs/{designId}/head" }),
  Object.freeze({ name: "design-history", uri: "formaspec://designs/{designId}/history" }),
  Object.freeze({ name: "design-node-subtree", uri: "formaspec://designs/{designId}/versions/{version}/nodes/{nodeId}" }),
  Object.freeze({ name: "design-render", uri: "formaspec://designs/{designId}/versions/{version}/render.png" }),
  Object.freeze({ name: "design-system-project-pin", uri: "formaspec://designs/{designId}/design-system-pin" }),
  Object.freeze({ name: "design-system-release", uri: "formaspec://design-system-releases/{releaseId}" }),
  Object.freeze({ name: "design-system-revision-release", uri: "formaspec://designs/{designId}/revisions/{revisionId}/design-system-release" }),
  Object.freeze({ name: "design-system-upgrade-preview", uri: "formaspec://design-system-upgrade-previews/{previewId}" }),
  Object.freeze({ name: "design-tokens", uri: "formaspec://designs/{designId}/versions/{version}/tokens" }),
  Object.freeze({ name: "design-version", uri: "formaspec://designs/{designId}/versions/{version}" }),
  Object.freeze({ name: "engineering-handoff", uri: "formaspec://handoffs/{handoffId}" }),
  Object.freeze({ name: "handoff-execution-decisions", uri: "formaspec://handoffs/{handoffId}/execution-decisions" }),
  Object.freeze({ name: "implementation-mapping", uri: "formaspec://implementation-mappings/{mappingId}" }),
  Object.freeze({ name: "planning-session", uri: "formaspec://planning-sessions/{sessionId}" }),
  Object.freeze({ name: "preview-render", uri: "formaspec://designs/{designId}/previews/{previewId}/render.png" }),
  Object.freeze({ name: "product-specification", uri: "formaspec://designs/{designId}/product-specification/{version}" }),
  Object.freeze({ name: "product-specification-preview", uri: "formaspec://designs/{designId}/product-specification/previews/{previewId}" }),
  Object.freeze({ name: "redesign-assessment", uri: "formaspec://redesign-assessments/{assessmentId}" }),
  Object.freeze({ name: "redesign-stage-artifact", uri: "formaspec://redesign-assessments/{assessmentId}/stages/{stage}/artifact" }),
  Object.freeze({ name: "repository-inventory", uri: "formaspec://repository-inventories/{inventoryId}" }),
].sort((left, right) => compareText(left.name, right.name)));

const PACKAGE_PATTERN = /^FormaSpec-(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)-macos-(arm64|x64)-unsigned\.pkg$/u;
const INSTALL_ROOT_RELATIVE = "Library/Application Support/FormaSpec";
const SUMMARY_FILENAME = "NO-GO-SUMMARY.json";
const CHECKSUM_FILENAME = "SHA256SUMS";
const MAX_ERROR_TEXT = 8_000;
const CHILD_TERMINATION_TIMEOUT_MS = 5_000;
const FORBIDDEN_EXECUTABLES = new Set([
  "codex",
  "installer",
  "launchctl",
  "open",
  "osascript",
  "security",
]);
const SYSTEM_INSTALL_TARGETS = Object.freeze([
  "/Library/Application Support/FormaSpec",
  "/Library/LaunchAgents/com.formaspec.api.plist",
  "/Library/LaunchAgents/com.formaspec.renderer.plist",
  "/Applications/FormaSpec.app",
  "/usr/local/bin/formaspecctl",
]);
const RELEASE_BLOCKERS = Object.freeze([
  "Artifact-specific vulnerability and operating-system scanning remain absent.",
  "Chromium composite third-party license and LGPL notice policy still requires approval.",
  "Clean install, automatic startup, protocol registration, upgrade, uninstall, and reinstall were not exercised.",
  "Independent reproducibility, publisher signing, and Apple notarization remain absent.",
  "This smoke runs extracted bytes with workstation-user privileges and does not prove native service isolation or renderer egress denial.",
]);

function usage() {
  return `Usage: node scripts/ci-macos-pkg-runtime-smoke.mjs \\
  --pkg <unsigned.pkg> \\
  --output <evidence-directory>

Expands one unsigned FormaSpec macOS PKG into a private temporary directory,
starts only its extracted Node/API/renderer/CLI bytes, verifies the bounded
runtime contract, and writes a deterministic NO-GO summary. It never invokes
installer, launchctl, Keychain, Codex, a protocol handler, or a browser opener.
`;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, child]) => [key, canonicalValue(child)]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return `${JSON.stringify(canonicalValue(value), null, 2)}\n`;
}

function lstatRegular(filename, maximumBytes, label) {
  const metadata = fs.lstatSync(filename, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be a regular non-symlink file.`);
  }
  if (metadata.size < 1n || metadata.size > BigInt(maximumBytes)) {
    throw new Error(`${label} is outside the ${maximumBytes}-byte limit.`);
  }
  return metadata;
}

function hashRegularFile(filename, maximumBytes, label) {
  const initial = lstatRegular(filename, maximumBytes, label);
  const descriptor = fs.openSync(
    filename,
    fs.constants.O_RDONLY | (typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0),
  );
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let total = 0;
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.dev !== initial.dev || opened.ino !== initial.ino || opened.size !== initial.size) {
      throw new Error(`${label} changed while it was opened.`);
    }
    while (true) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maximumBytes) throw new Error(`${label} exceeded its byte limit while hashing.`);
      hash.update(buffer.subarray(0, bytesRead));
    }
    const final = fs.fstatSync(descriptor, { bigint: true });
    if (final.dev !== opened.dev || final.ino !== opened.ino || final.size !== opened.size || BigInt(total) !== opened.size) {
      throw new Error(`${label} changed while it was hashed.`);
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return { sha256: hash.digest("hex"), sizeBytes: total };
}

function readBoundedText(filename, maximumBytes, label) {
  lstatRegular(filename, maximumBytes, label);
  return fs.readFileSync(filename, "utf8");
}

function readBoundedJson(filename, maximumBytes, label) {
  try {
    return JSON.parse(readBoundedText(filename, maximumBytes, label));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isContained(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

export function requireContainedRegular(root, candidate, label, executable = false) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const realRoot = fs.realpathSync(resolvedRoot);
  if (!isContained(resolvedRoot, resolvedCandidate) && !isContained(realRoot, resolvedCandidate)) {
    throw new Error(`${label} escapes the extracted package payload.`);
  }
  const realCandidate = fs.realpathSync(resolvedCandidate);
  if (!isContained(realRoot, realCandidate)) throw new Error(`${label} resolves outside the extracted package payload.`);
  const metadata = fs.statSync(realCandidate);
  if (!metadata.isFile()) throw new Error(`${label} is not a regular file.`);
  if (executable && (metadata.mode & 0o111) === 0) throw new Error(`${label} is not executable.`);
  return realCandidate;
}

export function requireContainedDirectory(root, candidate, label) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const realRoot = fs.realpathSync(resolvedRoot);
  if (!isContained(resolvedRoot, resolvedCandidate) && !isContained(realRoot, resolvedCandidate)) {
    throw new Error(`${label} escapes the extracted package payload.`);
  }
  const realCandidate = fs.realpathSync(resolvedCandidate);
  if (!isContained(realRoot, realCandidate)) throw new Error(`${label} resolves outside the extracted package payload.`);
  const metadata = fs.statSync(realCandidate);
  if (!metadata.isDirectory()) throw new Error(`${label} is not a directory.`);
  return realCandidate;
}

export function assertNonInstallingExecutable(executable, extractedNode) {
  const basename = path.basename(executable).toLowerCase();
  if (FORBIDDEN_EXECUTABLES.has(basename)) {
    throw new Error(`The extracted-package smoke forbids invoking ${basename}.`);
  }
  const resolved = path.resolve(executable);
  if (resolved === "/usr/sbin/pkgutil") return;
  if (extractedNode !== undefined && resolved === path.resolve(extractedNode)) return;
  throw new Error(`The extracted-package smoke does not allow executable ${executable}.`);
}

function runPkgutil(arguments_, options = {}) {
  if (!Array.isArray(arguments_) || !["--check-signature", "--expand-full", "--pkg-info"].includes(arguments_[0])) {
    throw new Error("The extracted-package smoke allows only pkgutil receipt inspection, signature inspection, and private expansion.");
  }
  assertNonInstallingExecutable("/usr/sbin/pkgutil");
  const result = spawnSync("/usr/sbin/pkgutil", arguments_, {
    encoding: "utf8",
    shell: false,
    timeout: options.timeoutMs ?? MACOS_RUNTIME_SMOKE_CONTRACT.commandTimeoutMs,
    maxBuffer: MACOS_RUNTIME_SMOKE_CONTRACT.maximumCommandOutputBytes,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C", TZ: "UTC" },
  });
  if (result.error) throw result.error;
  const status = result.status ?? -1;
  if (status !== 0 && !options.acceptStatus?.includes(status)) {
    throw new Error(`pkgutil ${arguments_[0]} failed with exit ${status}: ${(result.stderr || result.stdout || "").trim().slice(0, 4_000)}`);
  }
  return { status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function runExtractedNode(nodeExecutable, arguments_, options) {
  assertNonInstallingExecutable(nodeExecutable, nodeExecutable);
  const result = spawnSync(nodeExecutable, arguments_, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    shell: false,
    timeout: options.timeoutMs ?? MACOS_RUNTIME_SMOKE_CONTRACT.commandTimeoutMs,
    maxBuffer: MACOS_RUNTIME_SMOKE_CONTRACT.maximumCommandOutputBytes,
  });
  if (result.error) throw result.error;
  const status = result.status ?? -1;
  if (status !== 0) {
    throw new Error(
      `Extracted Node command failed with exit ${status}: ${(result.stderr || result.stdout || "").trim().slice(0, 4_000)}`,
    );
  }
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function artifactMetadata(packagePath) {
  const match = PACKAGE_PATTERN.exec(path.basename(packagePath));
  if (!match) throw new Error("The selected artifact does not use the unsigned FormaSpec macOS PKG filename contract.");
  return { version: match[1], architecture: match[2] };
}

export function snapshotFilesystemTargets(targets = SYSTEM_INSTALL_TARGETS) {
  const result = {};
  for (const target of [...targets].sort(compareText)) {
    try {
      const metadata = fs.lstatSync(target, { bigint: true });
      result[target] = {
        state: "present",
        type: metadata.isSymbolicLink() ? "symlink" : metadata.isDirectory() ? "directory" : metadata.isFile() ? "file" : "other",
        device: metadata.dev.toString(),
        inode: metadata.ino.toString(),
        mode: (metadata.mode & 0o7777n).toString(8),
        size: metadata.size.toString(),
        modifiedNanoseconds: metadata.mtimeNs.toString(),
        ...(metadata.isSymbolicLink() ? { target: fs.readlinkSync(target) } : {}),
      };
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") result[target] = { state: "missing" };
      else throw error;
    }
  }
  return result;
}

export function filesystemTargetsUnchanged(before, after) {
  return canonicalJson(before) === canonicalJson(after);
}

function packageReceiptSnapshot() {
  const result = runPkgutil(["--pkg-info", "com.formaspec.pkg"], { acceptStatus: [1] });
  return {
    status: result.status,
    outputSha256: sha256(`${result.stdout}\n${result.stderr}`),
  };
}

function classifyUnsignedPackage(packagePath) {
  const result = runPkgutil(["--check-signature", packagePath], { acceptStatus: [1] });
  const output = `${result.stdout}\n${result.stderr}`;
  if (!/Status:\s+no signature/iu.test(output)) {
    throw new Error("The selected macOS package is signed, invalid, or has an unrecognized signature status; this verifier accepts only explicitly unsigned engineering artifacts.");
  }
  return { status: "unsigned", tool: "pkgutil", exitCode: result.status };
}

function findExactlyOneComponent(expandedRoot) {
  const components = fs.readdirSync(expandedRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && entry.name.endsWith(".pkg"))
    .map((entry) => entry.name)
    .sort(compareText);
  if (components.length !== 1) throw new Error("The expanded FormaSpec product must contain exactly one component package.");
  return path.join(expandedRoot, components[0]);
}

function browserRevisionFromManifest(appRoot, payloadRoot) {
  const playwrightPackage = requireContainedDirectory(
    payloadRoot,
    path.join(appRoot, "apps/server/node_modules/playwright"),
    "Packaged Playwright dependency",
  );
  const manifestPath = path.join(path.dirname(playwrightPackage), "playwright-core", "browsers.json");
  const manifest = readBoundedJson(manifestPath, 2 * 1024 * 1024, "Packaged Playwright browser manifest");
  const browser = Array.isArray(manifest?.browsers)
    ? manifest.browsers.find((candidate) => candidate?.name === "chromium-headless-shell")
    : undefined;
  if (!browser || typeof browser.revision !== "string" || !/^\d+$/u.test(browser.revision)) {
    throw new Error("The packaged Playwright manifest does not declare a Chromium headless-shell revision.");
  }
  return browser.revision;
}

export function inspectBrowserPayload(browserRoot, expectedRevision, architecture = process.arch) {
  const metadata = fs.lstatSync(browserRoot);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("The packaged Playwright browser root is unsafe or missing.");
  const directoryName = `chromium_headless_shell-${expectedRevision}`;
  const directories = fs.readdirSync(browserRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort(compareText);
  if (directories.length !== 1 || directories[0] !== directoryName) {
    throw new Error(`The package must contain only ${directoryName}; received ${directories.join(",") || "none"}.`);
  }
  const platformArchitecture = architecture === "arm64" ? "arm64" : architecture === "x64" ? "x64" : null;
  if (platformArchitecture === null) throw new Error(`Unsupported macOS runtime architecture: ${architecture}`);
  const executable = path.join(
    browserRoot,
    directoryName,
    `chrome-headless-shell-mac-${platformArchitecture}`,
    "chrome-headless-shell",
  );
  requireContainedRegular(browserRoot, executable, "Chromium headless-shell executable", true);
  const scan = scanPackageTree(browserRoot);
  return {
    directory: directoryName,
    revision: expectedRevision,
    executableRelativePath: path.relative(browserRoot, executable).split(path.sep).join("/"),
    entryCount: scan.entryCount,
    logicalBytes: scan.logicalBytes,
    contentTreeSha256: scan.treeSha256,
  };
}

export function inspectManagedCodexAssets(assetsRoot) {
  const root = requireContainedDirectory(assetsRoot, assetsRoot, "Packaged FormaSpec Codex asset root");
  const pluginVersion = "0.2.0";
  const identities = [
    {
      skillName: "formaspec",
      pluginName: "formaspec",
      pluginId: "formaspec@formaspec",
      displayName: "FormaSpec",
      mention: "[@FormaSpec](plugin://formaspec@formaspec)",
    },
    {
      skillName: "minimal-ui",
      pluginName: "minimal-ui",
      pluginId: "minimal-ui@formaspec",
      displayName: "Minimal UI",
      mention: "[@Minimal UI](plugin://minimal-ui@formaspec)",
    },
  ];
  const requiredFiles = [
    "codex-marketplace/.agents/plugins/marketplace.json",
    ...identities.flatMap((identity) => [
      `skills/${identity.skillName}/SKILL.md`,
      `skills/${identity.skillName}/agents/openai.yaml`,
      `codex-marketplace/plugins/${identity.pluginName}/.codex-plugin/plugin.json`,
      `codex-marketplace/plugins/${identity.pluginName}/skills/${identity.skillName}/SKILL.md`,
      `codex-marketplace/plugins/${identity.pluginName}/skills/${identity.skillName}/agents/openai.yaml`,
    ]),
  ];
  for (const relativePath of requiredFiles) {
    requireContainedRegular(root, path.join(root, ...relativePath.split("/")), `Packaged Codex asset ${relativePath}`);
  }
  const marketplace = readBoundedJson(
    path.join(root, "codex-marketplace/.agents/plugins/marketplace.json"),
    256 * 1024,
    "Packaged FormaSpec Codex marketplace manifest",
  );
  if (
    marketplace?.name !== "formaspec"
    || marketplace?.interface?.displayName !== "FormaSpec"
    || !Array.isArray(marketplace?.plugins)
    || marketplace.plugins.length !== identities.length
  ) throw new Error("Packaged Codex marketplace must expose exactly the FormaSpec and Minimal UI identities.");

  for (const identity of identities) {
    const pluginPath = `codex-marketplace/plugins/${identity.pluginName}/.codex-plugin/plugin.json`;
    const plugin = readBoundedJson(
      path.join(root, ...pluginPath.split("/")),
      256 * 1024,
      `Packaged ${identity.displayName} Codex plugin manifest`,
    );
    if (
      plugin?.name !== identity.pluginName
      || plugin?.version !== pluginVersion
      || plugin?.interface?.displayName !== identity.displayName
    ) {
      throw new Error(`Packaged Codex plugin identity is not ${identity.pluginId} at ${pluginVersion}.`);
    }

    const managedEntries = marketplace.plugins.filter((entry) => entry?.name === identity.pluginName);
    if (
      managedEntries.length !== 1
      || managedEntries[0]?.source?.source !== "local"
      || managedEntries[0]?.source?.path !== `./plugins/${identity.pluginName}`
      || managedEntries[0]?.policy?.installation !== "AVAILABLE"
      || managedEntries[0]?.policy?.authentication !== "ON_INSTALL"
      || managedEntries[0]?.category !== "Productivity"
    ) throw new Error(`Packaged Codex marketplace identity is not ${identity.pluginId}.`);

    for (const relativePath of [
      `skills/${identity.skillName}/SKILL.md`,
      `codex-marketplace/plugins/${identity.pluginName}/skills/${identity.skillName}/SKILL.md`,
    ]) {
      const contents = readBoundedText(path.join(root, ...relativePath.split("/")), 256 * 1024, relativePath);
      const escapedSkillName = identity.skillName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      if (!new RegExp(`^name:\\s*${escapedSkillName}\\s*$`, "mu").test(contents)) {
        throw new Error(`Packaged Codex skill identity is stale: ${relativePath}`);
      }
    }

    for (const relativePath of [
      `skills/${identity.skillName}/agents/openai.yaml`,
      `codex-marketplace/plugins/${identity.pluginName}/skills/${identity.skillName}/agents/openai.yaml`,
    ]) {
      const contents = readBoundedText(path.join(root, ...relativePath.split("/")), 256 * 1024, relativePath);
      const escapedDisplayName = identity.displayName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      const escapedSkillName = identity.skillName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      if (!new RegExp(`^\\s*display_name:\\s*["']${escapedDisplayName}["']\\s*$`, "mu").test(contents)
        || !new RegExp(`^\\s*default_prompt:\\s*["'][^"']*\\$${escapedSkillName}\\b[^"']*["']\\s*$`, "mu").test(contents)) {
        throw new Error(`Packaged Codex skill metadata is stale: ${relativePath}`);
      }
    }
  }

  return {
    marketplaceName: "formaspec",
    marketplaceDisplayName: "FormaSpec",
    pluginVersion,
    identities,
  };
}

function inspectExpandedPackage(expandedRoot, packageMetadata) {
  const componentRoot = findExactlyOneComponent(expandedRoot);
  const payloadRoot = path.join(componentRoot, "Payload");
  const packageInfo = parsePackageInfo(readBoundedText(path.join(componentRoot, "PackageInfo"), 2 * 1024 * 1024, "PackageInfo"));
  if (
    packageInfo.identifier !== "com.formaspec.pkg"
    || packageInfo.version !== packageMetadata.version
    || packageInfo.installLocation !== "/"
    || packageInfo.auth !== "root"
    || packageInfo.scripts.join(",") !== "preinstall,postinstall"
  ) throw new Error("Expanded PackageInfo does not match the FormaSpec unsigned installer contract.");

  const payload = scanPackageTree(payloadRoot);
  const installRoot = requireContainedDirectory(
    payloadRoot,
    path.join(payloadRoot, ...INSTALL_ROOT_RELATIVE.split("/")),
    "FormaSpec install root",
  );
  const appRoot = requireContainedDirectory(payloadRoot, path.join(installRoot, "app"), "Packaged application root");
  const nodeExecutable = requireContainedRegular(payloadRoot, path.join(installRoot, "runtime/node"), "Bundled Node runtime", true);
  const serverEntry = requireContainedRegular(payloadRoot, path.join(appRoot, "apps/server/dist/index.js"), "Packaged API entry point");
  const rendererEntry = requireContainedRegular(payloadRoot, path.join(appRoot, "apps/server/dist/renderer-worker.js"), "Packaged renderer entry point");
  const cliEntry = requireContainedRegular(payloadRoot, path.join(appRoot, "apps/cli/dist/index.js"), "Packaged CLI entry point");
  const codexAssets = inspectManagedCodexAssets(requireContainedDirectory(
    payloadRoot,
    path.join(appRoot, "apps/cli/assets"),
    "Packaged FormaSpec Codex assets",
  ));
  requireContainedRegular(payloadRoot, path.join(appRoot, "designer"), "Packaged compatibility launcher", true);
  requireContainedRegular(payloadRoot, path.join(appRoot, "pnpm-workspace.yaml"), "Packaged workspace marker");
  const manifest = readBoundedJson(path.join(installRoot, "install-manifest.json"), 64 * 1024, "Packaged install manifest");
  const expectedManifest = {
    format: "formaspec-native-install",
    version: 1,
    productVersion: packageMetadata.version,
    platform: "macos",
    architecture: packageMetadata.architecture,
    managedBy: "formaspec",
    signed: false,
  };
  if (canonicalJson(manifest) !== canonicalJson(expectedManifest)) {
    throw new Error("Packaged install manifest does not match the selected unsigned artifact.");
  }
  const declaredRevision = browserRevisionFromManifest(appRoot, payloadRoot);
  if (declaredRevision !== MACOS_RUNTIME_SMOKE_CONTRACT.playwrightRevision) {
    throw new Error(
      `Packaged Playwright revision ${declaredRevision} does not match required revision ${MACOS_RUNTIME_SMOKE_CONTRACT.playwrightRevision}.`,
    );
  }
  const browserRoot = requireContainedDirectory(
    payloadRoot,
    path.join(installRoot, "runtime/ms-playwright"),
    "Packaged browser root",
  );
  const browser = inspectBrowserPayload(browserRoot, declaredRevision, packageMetadata.architecture);
  return {
    componentRoot,
    payloadRoot,
    installRoot,
    appRoot,
    nodeExecutable,
    serverEntry,
    rendererEntry,
    cliEntry,
    codexAssets,
    browserRoot,
    browser,
    payload: {
      entryCount: payload.entryCount,
      regularFileCount: payload.regularFileCount,
      directoryCount: payload.directoryCount,
      symlinkCount: payload.symlinkCount,
      logicalBytes: payload.logicalBytes,
      contentTreeSha256: payload.treeSha256,
    },
  };
}

class ManagedProcess {
  constructor(label, executable, arguments_, options) {
    assertNonInstallingExecutable(executable, executable);
    this.label = label;
    this.stdout = "";
    this.stderr = "";
    this.exited = false;
    this.exitCode = null;
    this.signal = null;
    this.spawnError = null;
    this.outputOverflow = false;
    this.child = spawn(executable, arguments_, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const collect = (kind, chunk) => {
      const current = this[kind];
      if (Buffer.byteLength(current) + chunk.length > MACOS_RUNTIME_SMOKE_CONTRACT.maximumCommandOutputBytes) {
        this.outputOverflow = true;
        this.killGroup("SIGKILL");
        return;
      }
      this[kind] += chunk.toString("utf8");
    };
    this.child.stdout.on("data", (chunk) => collect("stdout", chunk));
    this.child.stderr.on("data", (chunk) => collect("stderr", chunk));
    this.exitPromise = new Promise((resolve) => {
      this.child.once("error", (error) => {
        this.spawnError = error;
        this.exited = true;
        resolve({ error });
      });
      this.child.once("exit", (code, signal) => {
        this.exited = true;
        this.exitCode = code;
        this.signal = signal;
        resolve({ code, signal });
      });
    });
  }

  diagnostic() {
    const output = (this.stderr || this.stdout || "no output").trim().slice(-4_000);
    return `${this.label} exited with ${this.exitCode ?? this.signal ?? "unknown"}: ${output}`;
  }

  assertRunning() {
    if (this.outputOverflow) throw new Error(`${this.label} exceeded the bounded output limit.`);
    if (this.spawnError) throw new Error(`${this.label} could not start: ${this.spawnError.message}`);
    if (this.exited) throw new Error(this.diagnostic());
  }

  killGroup(signal) {
    const pid = this.child.pid;
    if (!pid || this.exited) return;
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "ESRCH") throw error;
    }
  }

  async terminate() {
    if (!this.exited) {
      this.killGroup("SIGTERM");
      const completed = await Promise.race([
        this.exitPromise.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), CHILD_TERMINATION_TIMEOUT_MS)),
      ]);
      if (!completed) {
        this.killGroup("SIGKILL");
        await this.exitPromise;
      }
    } else {
      await this.exitPromise;
    }
    return { exitCode: this.exitCode, signal: this.signal, outputOverflow: this.outputOverflow };
  }
}

async function reserveLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string", "Could not reserve a loopback port.");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function createPrivateRuntimeRoot(temporaryRoot) {
  const stateRoot = path.join(temporaryRoot, "state");
  const runtimeDirectory = path.join(stateRoot, "runtime");
  const result = {
    stateRoot,
    runtimeDirectory,
    runDirectory: path.join(runtimeDirectory, "run"),
    dataDirectory: path.join(stateRoot, "data"),
    backupDirectory: path.join(stateRoot, "backups"),
    logDirectory: path.join(stateRoot, "logs"),
    supportDirectory: path.join(stateRoot, "support-bundles"),
    homeDirectory: path.join(stateRoot, "home"),
    temporaryDirectory: path.join(stateRoot, "tmp"),
  };
  for (const directory of Object.values(result)) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return result;
}

function runtimeEnvironment(layout, privatePaths, port) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const socketPath = path.join(privatePaths.runDirectory, "renderer.sock");
  if (Buffer.byteLength(socketPath) >= 96) throw new Error("Private renderer socket path is too long for a portable Unix-domain socket.");
  const environment = {
    APP_MODE: "local",
    AUTH_MODE: "none",
    BACKUP_DIR: privatePaths.backupDirectory,
    DATA_DIR: privatePaths.dataDirectory,
    DESIGNER_AUTH_REQUIRED: "false",
    DESIGNER_AUTH_TOKEN: "",
    DESIGNER_CORS_ORIGINS: baseUrl,
    DESIGNER_DATABASE_PATH: path.join(privatePaths.dataDirectory, "designer.sqlite"),
    DESIGNER_LOG_LEVEL: "silent",
    DESIGNER_MAX_ASSET_PIXELS: "32000000",
    DESIGNER_TOKEN: "",
    FORMASPEC_ALLOW_SOFTWARE_RENDERER: "false",
    FORMASPEC_ALLOW_SYSTEM_CHROME: "false",
    FORMASPEC_BACKUP_DIR: privatePaths.backupDirectory,
    FORMASPEC_DATA_DIR: privatePaths.dataDirectory,
    FORMASPEC_LOG_DIR: privatePaths.logDirectory,
    FORMASPEC_RENDER_CONCURRENCY: "2",
    FORMASPEC_RENDER_IPC_MAX_BYTES: "100663296",
    FORMASPEC_RENDER_MAX_PIXELS: "32000000",
    FORMASPEC_RENDER_QUEUE_LIMIT: "32",
    FORMASPEC_RENDER_SOCKET: socketPath,
    FORMASPEC_RENDER_TIMEOUT_MS: "15000",
    FORMASPEC_RUNTIME_DIR: privatePaths.runtimeDirectory,
    FORMASPEC_SUPPORT_DIR: privatePaths.supportDirectory,
    HOME: privatePaths.homeDirectory,
    HOST: "127.0.0.1",
    LANG: "C",
    LC_ALL: "C",
    MAX_UPLOAD_BYTES: "5242880",
    NODE_ENV: "production",
    NO_COLOR: "1",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    PLAYWRIGHT_BROWSERS_PATH: layout.browserRoot,
    PORT: String(port),
    PUBLIC_BASE_URL: baseUrl,
    TMPDIR: `${privatePaths.temporaryDirectory}${path.sep}`,
    TZ: "UTC",
    XDG_CACHE_HOME: path.join(privatePaths.stateRoot, "xdg-cache"),
    XDG_CONFIG_HOME: path.join(privatePaths.stateRoot, "xdg-config"),
    XDG_DATA_HOME: path.join(privatePaths.stateRoot, "xdg-data"),
    XDG_STATE_HOME: path.join(privatePaths.stateRoot, "xdg-state"),
  };
  for (const key of ["XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) {
    fs.mkdirSync(environment[key], { recursive: true, mode: 0o700 });
  }
  return { baseUrl, socketPath, environment };
}

function writeRuntimeState(privatePaths, port) {
  const values = {
    mode: "local\n",
    "api-port": `${port}\n`,
    url: `http://127.0.0.1:${port}\n`,
  };
  for (const [name, value] of Object.entries(values)) {
    const filename = path.join(privatePaths.runDirectory, name);
    fs.writeFileSync(filename, value, { mode: 0o600 });
  }
}

async function fetchBounded(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 10_000),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MACOS_RUNTIME_SMOKE_CONTRACT.maximumHttpResponseBytes) {
    throw new Error(`${options.method ?? "GET"} ${url} exceeded the bounded response limit.`);
  }
  return { response, bytes };
}

async function requestJson(url, options = {}) {
  const { response, bytes } = await fetchBounded(url, options);
  const text = bytes.toString("utf8");
  if (!response.ok) throw new Error(`${options.method ?? "GET"} ${url} returned ${response.status}: ${text.slice(0, 2_000)}`);
  try {
    return { response, value: JSON.parse(text) };
  } catch (error) {
    throw new Error(`${url} did not return JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function waitForReadiness(baseUrl, processes) {
  const deadline = Date.now() + MACOS_RUNTIME_SMOKE_CONTRACT.startupTimeoutMs;
  let lastError = new Error("readiness was not attempted");
  while (Date.now() < deadline) {
    for (const process_ of processes) process_.assertRunning();
    try {
      const { value } = await requestJson(`${baseUrl}/health/ready`, { timeoutMs: 2_000 });
      if (value?.ok === true) return value;
      lastError = new Error("Readiness did not report ok=true.");
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Extracted FormaSpec did not become ready: ${lastError.message}`);
}

function normalizedRenderHealth(value) {
  if (
    value?.ok !== true
    || value.mode !== "worker"
    || value.renderer !== "playwright"
    || value.softwareFallback !== false
    || !Array.isArray(value.warnings)
    || typeof value.contract !== "object"
  ) throw new Error("Renderer health does not match the external Playwright no-fallback contract.");
  return {
    ok: true,
    mode: value.mode,
    renderer: value.renderer,
    softwareFallback: value.softwareFallback,
    warnings: [...value.warnings].sort(compareText),
    contract: {
      ipcProtocolVersion: value.contract.ipcProtocolVersion,
      rendererVersion: value.contract.rendererVersion,
      rasterNormalizerVersion: value.contract.rasterNormalizerVersion,
      maxMessageBytes: value.contract.maxMessageBytes,
      maxBytes: value.contract.maxBytes,
      maxPixels: value.contract.maxPixels,
    },
  };
}

function pngMetadata(bytes) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature) || bytes.subarray(12, 16).toString("ascii") !== "IHDR") {
    throw new Error("The extracted renderer response is not a valid leading-IHDR PNG.");
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 512 || height > 512) {
    throw new Error("The extracted renderer PNG dimensions are outside the 512-pixel smoke bound.");
  }
  return { width, height, sizeBytes: bytes.length, sha256: sha256(bytes) };
}

let mcpRequestId = 1;

async function mcpRequest(baseUrl, method, params = {}) {
  const { value } = await requestJson(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: mcpRequestId++, method, params }),
    timeoutMs: 30_000,
  });
  if (value?.error) throw new Error(`MCP ${method} returned ${value.error.message ?? "an error"}.`);
  if (!value?.result || typeof value.result !== "object") throw new Error(`MCP ${method} returned no result.`);
  return value.result;
}

function parseCliJson(stdout, label) {
  const lines = stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      // Continue past any preceding diagnostic lines.
    }
  }
  throw new Error(`${label} did not emit a JSON result.`);
}

function runCli(layout, environment, arguments_) {
  const result = runExtractedNode(layout.nodeExecutable, [layout.cliEntry, ...arguments_], {
    cwd: layout.appRoot,
    env: environment,
  });
  return parseCliJson(result.stdout, `formaspecctl ${arguments_.join(" ")}`);
}

function validatePrivateRegularFile(root, filename, label) {
  const resolved = path.resolve(filename);
  if (!isContained(root, resolved)) throw new Error(`${label} escaped its private evidence directory.`);
  const metadata = fs.lstatSync(resolved);
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`${label} is not a private regular file.`);
  return resolved;
}

function sanitizeText(value, replacements) {
  let result = String(value);
  for (const replacement of replacements) {
    if (!replacement.value) continue;
    result = result.split(replacement.value).join(replacement.label);
  }
  return result.slice(0, MAX_ERROR_TEXT);
}

export function writeNoGoSummary(outputDirectory, summary) {
  if (fs.existsSync(outputDirectory)) throw new Error("macOS runtime-smoke evidence output already exists.");
  fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const text = canonicalJson(summary);
  fs.writeFileSync(path.join(outputDirectory, SUMMARY_FILENAME), text, { mode: 0o644 });
  fs.writeFileSync(
    path.join(outputDirectory, CHECKSUM_FILENAME),
    `${sha256(text)}  ${SUMMARY_FILENAME}\n`,
    { mode: 0o644 },
  );
  return { text, sha256: sha256(text) };
}

export function parseArguments(arguments_) {
  if (arguments_.includes("--help") || arguments_.includes("-h")) return { help: true };
  const values = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument !== "--pkg" && argument !== "--output") throw new Error(`Unknown argument: ${argument}\n\n${usage()}`);
    const value = arguments_[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.\n\n${usage()}`);
    if (values[argument]) throw new Error(`${argument} may be supplied only once.`);
    values[argument] = path.resolve(value);
    index += 1;
  }
  if (!values["--pkg"] || !values["--output"]) throw new Error(usage());
  return { packagePath: values["--pkg"], outputDirectory: values["--output"] };
}

export async function runMacPackageRuntimeSmoke(options) {
  if (process.platform !== "darwin") throw new Error("The extracted macOS PKG runtime smoke requires macOS package tools.");
  const packagePath = path.resolve(options.packagePath);
  const outputDirectory = path.resolve(options.outputDirectory);
  if (fs.existsSync(outputDirectory)) throw new Error("macOS runtime-smoke evidence output already exists.");
  const packageMetadata = artifactMetadata(packagePath);
  if (packageMetadata.architecture !== process.arch) {
    throw new Error(`The ${packageMetadata.architecture} package cannot be executed on this ${process.arch} Node host.`);
  }
  const artifact = hashRegularFile(
    packagePath,
    MACOS_RUNTIME_SMOKE_CONTRACT.maximumPackageBytes,
    "Selected macOS package",
  );
  const sidecarDigest = parseSha256Sidecar(
    readBoundedText(`${packagePath}.sha256`, 4_096, "Selected package checksum sidecar"),
    path.basename(packagePath),
  );
  if (sidecarDigest !== artifact.sha256) throw new Error("Selected package checksum sidecar does not match the artifact bytes.");

  const temporaryRoot = fs.mkdtempSync(path.join("/tmp", "formaspec-pkg-smoke-"));
  fs.chmodSync(temporaryRoot, 0o700);
  const expandedRoot = path.join(temporaryRoot, "expanded");
  const privatePaths = createPrivateRuntimeRoot(temporaryRoot);
  const installedBefore = snapshotFilesystemTargets();
  const receiptBefore = packageReceiptSnapshot();
  const summary = {
    format: "formaspec-macos-extracted-runtime-smoke",
    schemaVersion: 1,
    releaseStatus: "NO-GO",
    verificationStatus: "FAILED",
    artifact: {
      filename: path.basename(packagePath),
      version: packageMetadata.version,
      architecture: packageMetadata.architecture,
      sha256: artifact.sha256,
      sizeBytes: artifact.sizeBytes,
      checksumSidecarStatus: "pass",
      signed: false,
    },
    checks: {},
    safety: {
      packageInstalled: false,
      installerInvoked: false,
      launchctlInvoked: false,
      keychainInvoked: false,
      codexInvoked: false,
      browserOpenerInvoked: false,
      systemInstallTargetsUnchanged: false,
      packageReceiptUnchanged: false,
      childProcessGroupsTerminated: false,
      privateTemporaryDirectoryRemoved: false,
    },
    blockers: [...RELEASE_BLOCKERS].sort(compareText),
  };
  const processes = [];
  let failure;
  let port;
  let rendererSocketPath;

  const terminateProcesses = async () => {
    const results = [];
    for (const process_ of [...processes].reverse()) results.push(await process_.terminate());
    summary.safety.childProcessGroupsTerminated = results.every((result) => !result.outputOverflow);
  };

  const signalHandler = (signal) => {
    failure = failure ?? new Error(`Runtime smoke interrupted by ${signal}.`);
    void terminateProcesses().finally(() => {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  };
  process.once("SIGINT", signalHandler);
  process.once("SIGTERM", signalHandler);

  try {
    const signature = classifyUnsignedPackage(packagePath);
    runPkgutil(["--expand-full", packagePath, expandedRoot], { timeoutMs: 600_000 });
    const layout = inspectExpandedPackage(expandedRoot, packageMetadata);
    const nodeVersion = runExtractedNode(layout.nodeExecutable, ["--version"], {
      cwd: layout.appRoot,
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C", TZ: "UTC" },
    }).stdout.trim();
    if (nodeVersion !== MACOS_RUNTIME_SMOKE_CONTRACT.nodeVersion) {
      throw new Error(`Bundled Node ${nodeVersion} does not match ${MACOS_RUNTIME_SMOKE_CONTRACT.nodeVersion}.`);
    }

    port = await reserveLoopbackPort();
    writeRuntimeState(privatePaths, port);
    fs.writeFileSync(path.join(privatePaths.logDirectory, "local.log"), "FormaSpec extracted-package runtime smoke.\n", { mode: 0o600 });
    const { baseUrl, socketPath, environment } = runtimeEnvironment(layout, privatePaths, port);
    rendererSocketPath = socketPath;
    const renderer = new ManagedProcess("Extracted renderer", layout.nodeExecutable, [layout.rendererEntry], {
      cwd: layout.appRoot,
      env: environment,
    });
    processes.push(renderer);
    const api = new ManagedProcess("Extracted API", layout.nodeExecutable, [layout.serverEntry], {
      cwd: layout.appRoot,
      env: environment,
    });
    processes.push(api);

    const ready = await waitForReadiness(baseUrl, processes);
    const { value: live } = await requestJson(`${baseUrl}/health/live`);
    if (live?.ok !== true || live.service !== "formaspec-api") throw new Error("API liveness contract failed.");
    const { value: renderHealthValue } = await requestJson(`${baseUrl}/health/render`);
    const renderHealth = normalizedRenderHealth(renderHealthValue);
    const readyRender = normalizedRenderHealth(ready.render);
    if (ready.migrations !== MACOS_RUNTIME_SMOKE_CONTRACT.schemaVersion || ready.database !== "ready") {
      throw new Error(`Readiness did not report schema ${MACOS_RUNTIME_SMOKE_CONTRACT.schemaVersion} and a ready database.`);
    }

    const { value: created } = await requestJson(`${baseUrl}/api/designs`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-formaspec-csrf": "1" },
      body: JSON.stringify({
        name: "Extracted macOS package runtime smoke",
        preset: "web",
        idempotencyKey: "macos-extracted-pkg-runtime-smoke-create-0001",
      }),
      timeoutMs: 30_000,
    });
    const designId = created?.document?.id;
    if (typeof designId !== "string" || designId.length === 0 || created.version !== 1) {
      throw new Error("Extracted API could not create a fresh smoke design at version 1.");
    }
    const rendered = await fetchBounded(
      `${baseUrl}/api/designs/${encodeURIComponent(designId)}/render.png?maxSize=512`,
      { headers: { "x-formaspec-csrf": "1" }, timeoutMs: 30_000 },
    );
    if (!rendered.response.ok) throw new Error(`Extracted PNG render returned ${rendered.response.status}.`);
    if (!rendered.response.headers.get("content-type")?.includes("image/png")) throw new Error("Extracted render did not return image/png.");
    if (rendered.response.headers.get("x-designer-renderer") !== "playwright") {
      throw new Error("Extracted render did not use Playwright.");
    }
    const png = pngMetadata(rendered.bytes);

    const initialized = await mcpRequest(baseUrl, "initialize", {
      protocolVersion: MACOS_RUNTIME_SMOKE_CONTRACT.mcpProtocolVersion,
      capabilities: {},
      clientInfo: { name: "formaspec-macos-pkg-runtime-smoke", version: "1.0.0" },
    });
    if (initialized.serverInfo?.name !== "formaspec" || initialized.serverInfo?.version !== packageMetadata.version) {
      throw new Error("Extracted MCP server identity or version is incorrect.");
    }
    if (
      typeof initialized.instructions !== "string"
      || initialized.instructions.length > 512
      || !initialized.instructions.includes("FormaSpec")
      || !initialized.instructions.includes("Preview, inspect, and lint")
    ) throw new Error("Extracted MCP instructions do not contain the bounded FormaSpec workflow.");
    const toolsResult = await mcpRequest(baseUrl, "tools/list", {});
    const toolNames = Array.isArray(toolsResult.tools)
      ? toolsResult.tools.map((tool) => tool?.name).filter((name) => typeof name === "string").sort(compareText)
      : [];
    if (canonicalJson(toolNames) !== canonicalJson(EXPECTED_MCP_TOOL_NAMES)) {
      throw new Error(`Extracted MCP tool inventory differs from the exact ${MACOS_RUNTIME_SMOKE_CONTRACT.mcpToolCount}-tool contract.`);
    }
    const fixedResourcesResult = await mcpRequest(baseUrl, "resources/list", {});
    const templatesResult = await mcpRequest(baseUrl, "resources/templates/list", {});
    const fixedResources = (Array.isArray(fixedResourcesResult.resources) ? fixedResourcesResult.resources : [])
      .map((resource) => ({ name: resource?.name, uri: resource?.uri }))
      .sort((left, right) => compareText(String(left.name), String(right.name)));
    const templates = (Array.isArray(templatesResult.resourceTemplates) ? templatesResult.resourceTemplates : [])
      .map((resource) => ({ name: resource?.name, uri: resource?.uriTemplate }))
      .sort((left, right) => compareText(String(left.name), String(right.name)));
    if (canonicalJson(fixedResources) !== canonicalJson(EXPECTED_FIXED_RESOURCES)) {
      throw new Error("Extracted MCP fixed-resource inventory differs from the exact four-resource contract.");
    }
    if (canonicalJson(templates) !== canonicalJson(EXPECTED_RESOURCE_TEMPLATES)) {
      throw new Error("Extracted MCP resource-template inventory differs from the exact 21-template contract.");
    }
    const resources = [
      ...fixedResources,
      ...templates,
    ].sort((left, right) => compareText(String(left.name), String(right.name)));
    if (resources.length !== MACOS_RUNTIME_SMOKE_CONTRACT.mcpResourceCount) {
      throw new Error(`Extracted MCP resource inventory does not contain ${MACOS_RUNTIME_SMOKE_CONTRACT.mcpResourceCount} resources.`);
    }

    const migration = runCli(layout, environment, ["migrate", "status", "--json"]);
    if (
      migration?.latestAppliedVersion !== MACOS_RUNTIME_SMOKE_CONTRACT.schemaVersion
      || migration?.supportedVersion !== MACOS_RUNTIME_SMOKE_CONTRACT.schemaVersion
      || migration?.state !== "current"
      || path.resolve(migration.databasePath) !== path.join(privatePaths.dataDirectory, "designer.sqlite")
    ) throw new Error("Packaged formaspecctl migrate status did not resolve the private native data directory.");

    const backup = runCli(layout, environment, ["backup", "create", "--json"]);
    if (backup?.status !== "valid" || typeof backup.filename !== "string" || !/^[A-Za-z0-9._-]+$/u.test(backup.filename)) {
      throw new Error("Packaged formaspecctl backup create did not return one valid private backup.");
    }
    validatePrivateRegularFile(privatePaths.backupDirectory, path.join(privatePaths.backupDirectory, backup.filename), "Created backup");
    const backups = runCli(layout, environment, ["backup", "list", "--json"]);
    if (!Array.isArray(backups) || backups.length !== 1 || backups[0]?.id !== backup.id) {
      throw new Error("Packaged formaspecctl backup list did not read the private backup directory through the extracted API.");
    }

    const supportPreview = runCli(layout, environment, ["support-bundle", "preview", "--json"]);
    if (
      supportPreview?.format !== "formaspec-support-bundle"
      || !Array.isArray(supportPreview.entries)
      || !supportPreview.entries.some((entry) => entry?.path === "logs/local.log")
    ) throw new Error("Packaged support-bundle preview did not inspect the private native log directory.");
    const support = runCli(layout, environment, ["support-bundle", "create", "--yes", "--json"]);
    const supportBundlePath = validatePrivateRegularFile(privatePaths.supportDirectory, support?.bundlePath, "Created support bundle");
    validatePrivateRegularFile(privatePaths.supportDirectory, support?.previewManifestPath, "Support-bundle preview manifest");

    summary.checks = {
      extraction: {
        method: "pkgutil --expand-full",
        privateDirectoryMode: "0700",
        payload: layout.payload,
      },
      signature,
      runtime: {
        nodeVersion,
        browser: layout.browser,
        codexAssets: layout.codexAssets,
      },
      health: {
        live: { ok: live.ok, service: live.service },
        ready: {
          ok: ready.ok,
          database: ready.database,
          migrations: ready.migrations,
          render: readyRender,
        },
        render: renderHealth,
      },
      rendering: {
        ...png,
        renderer: "playwright",
      },
      mcp: {
        protocolVersion: initialized.protocolVersion,
        serverName: initialized.serverInfo.name,
        serverVersion: initialized.serverInfo.version,
        formaspecWorkflowPresent: true,
        toolCount: toolNames.length,
        toolNames,
        resourceCount: resources.length,
        resources,
      },
      cli: {
        migration: {
          latestAppliedVersion: migration.latestAppliedVersion,
          supportedVersion: migration.supportedVersion,
          state: migration.state,
          privateDataDirectoryResolved: true,
        },
        backup: {
          createdStatus: backup.status,
          listedCount: backups.length,
          privateBackupDirectoryResolved: true,
        },
        supportBundle: {
          previewEntryCount: supportPreview.entries.length,
          previewEntryPaths: supportPreview.entries.map((entry) => entry.path).sort(compareText),
          privateLogDirectoryResolved: true,
          privateSupportDirectoryResolved: isContained(privatePaths.supportDirectory, supportBundlePath),
        },
      },
    };
    summary.verificationStatus = "PASS";
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  } finally {
    process.removeListener("SIGINT", signalHandler);
    process.removeListener("SIGTERM", signalHandler);
    try {
      await terminateProcesses();
    } catch (error) {
      const cleanupError = error instanceof Error ? error : new Error(String(error));
      failure = failure ?? cleanupError;
      summary.safety.childProcessGroupsTerminated = false;
    }
    if (rendererSocketPath !== undefined && fs.existsSync(rendererSocketPath)) {
      failure = failure ?? new Error("Renderer Unix socket remained after extracted process cleanup.");
      summary.safety.childProcessGroupsTerminated = false;
    }
    const installedAfter = snapshotFilesystemTargets();
    const receiptAfter = packageReceiptSnapshot();
    summary.safety.systemInstallTargetsUnchanged = filesystemTargetsUnchanged(installedBefore, installedAfter);
    summary.safety.packageReceiptUnchanged = canonicalJson(receiptBefore) === canonicalJson(receiptAfter);
    if (!summary.safety.systemInstallTargetsUnchanged || !summary.safety.packageReceiptUnchanged) {
      failure = failure ?? new Error("System installation targets or the package receipt changed during the non-installing smoke.");
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    summary.safety.privateTemporaryDirectoryRemoved = !fs.existsSync(temporaryRoot);
    if (!summary.safety.privateTemporaryDirectoryRemoved) {
      failure = failure ?? new Error("Private extracted-package temporary data was not removed.");
    }
    if (failure) {
      summary.verificationStatus = "FAILED";
      summary.error = {
        code: "MACOS_EXTRACTED_RUNTIME_SMOKE_FAILED",
        message: sanitizeText(failure.message, [
          { value: temporaryRoot, label: "<private-temp>" },
          { value: packagePath, label: `<selected-pkg>/${path.basename(packagePath)}` },
          { value: outputDirectory, label: "<evidence-output>" },
          { value: os.homedir(), label: "<home>" },
          ...(port === undefined ? [] : [{ value: String(port), label: "<loopback-port>" }]),
        ]),
      };
    }
  }

  const evidence = writeNoGoSummary(outputDirectory, summary);
  if (failure) {
    const error = new Error(`${failure.message}\nNO-GO evidence: ${path.join(outputDirectory, SUMMARY_FILENAME)}`);
    error.cause = failure;
    throw error;
  }
  return { summary, summarySha256: evidence.sha256, outputDirectory };
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(usage());
    return;
  }
  const result = await runMacPackageRuntimeSmoke(parsed);
  process.stdout.write(
    `Extracted macOS PKG runtime smoke: PASS, release NO-GO; summary SHA-256 ${result.summarySha256}; ${result.outputDirectory}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
