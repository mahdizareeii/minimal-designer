import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  deterministicJson,
  evaluateLicense,
  npmPurl,
  sha256,
  validateLicensePolicy,
} from "./release-evidence-lib.mjs";

export const MACOS_PKG_EVIDENCE_VERSION = 2;
export const MACOS_PKG_EVIDENCE_FILES = Object.freeze([
  "artifact.cdx.json",
  "components.json",
  "verification.json",
  "SHA256SUMS",
]);

const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024 * 1024;
const MAX_TREE_ENTRIES = 200_000;
const MAX_TEXT_BYTES = 16 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_PACKAGE_MANIFEST_BYTES = 2 * 1024 * 1024;
const INSTALL_ROOT = "Library/Application Support/FormaSpec";
const APP_ROOT = `${INSTALL_ROOT}/app`;
export const MACOS_PACKAGED_WORKSPACE_TREES = Object.freeze([
  Object.freeze({ id: "core-dist", kind: "build-output", relativePath: "packages/core/dist" }),
  Object.freeze({ id: "server-dist", kind: "build-output", relativePath: "apps/server/dist" }),
  Object.freeze({ id: "web-dist", kind: "build-output", relativePath: "apps/web/dist" }),
  Object.freeze({ id: "cli-dist", kind: "build-output", relativePath: "apps/cli/dist" }),
  Object.freeze({ id: "local-bridge-dist", kind: "build-output", relativePath: "apps/local-bridge/dist" }),
  Object.freeze({ id: "workspace-bridge-dist", kind: "build-output", relativePath: "apps/workspace-bridge/dist" }),
  Object.freeze({ id: "cli-assets", kind: "packaged-assets", relativePath: "apps/cli/assets" }),
]);

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function assertString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function toPosix(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function assertSafeRelativePath(value, label) {
  const normalized = value.startsWith("./") ? value.slice(2) : value;
  if (
    normalized === "" ||
    normalized === "." ||
    path.posix.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new Error(`${label} is not a safe package-relative path: ${value}`);
  }
  return normalized;
}

function lstatRegular(filePath, maximumBytes, label) {
  const metadata = fs.lstatSync(filePath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be a regular file, not a symlink.`);
  }
  if (!Number.isSafeInteger(metadata.size) || metadata.size < 0 || metadata.size > maximumBytes) {
    throw new Error(`${label} exceeds ${maximumBytes} bytes.`);
  }
  return metadata;
}

function readText(filePath, maximumBytes, label) {
  lstatRegular(filePath, maximumBytes, label);
  return fs.readFileSync(filePath, "utf8");
}

function hashRegularFile(filePath, maximumBytes = MAX_ARTIFACT_BYTES) {
  const initial = lstatRegular(filePath, maximumBytes, filePath);
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | (typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0),
  );
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let total = 0;
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== initial.dev || opened.ino !== initial.ino || opened.size !== initial.size) {
      throw new Error(`File changed while opening: ${filePath}`);
    }
    while (true) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maximumBytes) throw new Error(`File exceeds ${maximumBytes} bytes: ${filePath}`);
      hash.update(buffer.subarray(0, bytesRead));
    }
    const final = fs.fstatSync(descriptor);
    if (final.dev !== opened.dev || final.ino !== opened.ino || final.size !== opened.size || total !== opened.size) {
      throw new Error(`File changed while hashing: ${filePath}`);
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return { sha256: hash.digest("hex"), size: total };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, [...args], {
    encoding: "utf8",
    shell: false,
    timeout: options.timeout ?? 300_000,
    maxBuffer: options.maxBuffer ?? MAX_COMMAND_OUTPUT_BYTES,
    env: { ...process.env, LC_ALL: "C", LANG: "C" },
  });
  if (result.error) throw result.error;
  if (!options.acceptStatus?.includes(result.status) && result.status !== 0) {
    const detail = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim().slice(0, 4_096);
    throw new Error(`${path.basename(command)} failed with exit code ${result.status ?? "unknown"}${detail ? `: ${detail}` : "."}`);
  }
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function parseSha256Sidecar(contents, expectedFilename) {
  const match = /^([a-f0-9]{64})  ([^\r\n]+)\n$/u.exec(contents);
  if (!match || match[2] !== expectedFilename || match[2].includes("/") || match[2].includes("\\")) {
    throw new Error("Installer checksum sidecar must contain one canonical SHA-256 line for the package filename.");
  }
  return match[1];
}

export function parseSha256Manifest(contents, allowedNames) {
  const result = new Map();
  for (const line of contents.split("\n")) {
    if (!line) continue;
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9._-]+)$/u.exec(line);
    if (!match || !allowedNames.includes(match[2]) || result.has(match[2])) {
      throw new Error("Evidence SHA256SUMS contains an unexpected or duplicate entry.");
    }
    result.set(match[2], match[1]);
  }
  if (result.size !== allowedNames.length || allowedNames.some((name) => !result.has(name))) {
    throw new Error("Evidence SHA256SUMS does not cover the required files exactly.");
  }
  return result;
}

function xmlAttribute(tag, name, label) {
  const match = new RegExp(`\\b${name}="([^"]*)"`, "u").exec(tag);
  if (!match) throw new Error(`${label} is missing XML attribute ${name}.`);
  return match[1]
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

export function parsePackageInfo(xml) {
  const root = /<pkg-info\b[^>]*>/u.exec(xml)?.[0];
  const payload = /<payload\b[^>]*\/>/u.exec(xml)?.[0];
  if (!root || !payload) throw new Error("PackageInfo is missing pkg-info or payload metadata.");
  const numberOfFiles = Number(xmlAttribute(payload, "numberOfFiles", "PackageInfo payload"));
  const installKBytes = Number(xmlAttribute(payload, "installKBytes", "PackageInfo payload"));
  if (!Number.isSafeInteger(numberOfFiles) || numberOfFiles <= 0 || numberOfFiles > MAX_TREE_ENTRIES) {
    throw new Error("PackageInfo numberOfFiles is outside the evidence limit.");
  }
  if (!Number.isSafeInteger(installKBytes) || installKBytes <= 0) {
    throw new Error("PackageInfo installKBytes is invalid.");
  }
  const scriptsBlock = /<scripts>([\s\S]*?)<\/scripts>/u.exec(xml)?.[1] ?? "";
  return {
    identifier: xmlAttribute(root, "identifier", "PackageInfo"),
    version: xmlAttribute(root, "version", "PackageInfo"),
    installLocation: xmlAttribute(root, "install-location", "PackageInfo"),
    auth: xmlAttribute(root, "auth", "PackageInfo"),
    generatorVersion: xmlAttribute(root, "generator-version", "PackageInfo"),
    numberOfFiles,
    installKBytes,
    scripts: ["preinstall", "postinstall"].filter((name) =>
      new RegExp(`<${name}\\b[^>]*\\bfile="\\./${name}"`, "u").test(scriptsBlock),
    ),
  };
}

export function scanPackageTree(rootDirectory) {
  const resolvedRoot = path.resolve(rootDirectory);
  const rootMetadata = fs.lstatSync(resolvedRoot);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error("Package tree root must be a real directory.");
  }
  const treeHash = createHash("sha256");
  const paths = new Set(["."]);
  const files = new Map();
  let entryCount = 1;
  let regularFileCount = 0;
  let directoryCount = 1;
  let symlinkCount = 0;
  let logicalBytes = 0;
  let appleDoubleEntryCount = 0;

  const rootMode = (rootMetadata.mode & 0o7777).toString(8).padStart(4, "0");
  treeHash.update(`d\t${rootMode}\t0\t-\t.\n`);

  function visit(directory) {
    const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = toPosix(path.relative(resolvedRoot, absolute));
      assertSafeRelativePath(relative, "Package tree entry");
      const metadata = fs.lstatSync(absolute);
      const mode = (metadata.mode & 0o7777).toString(8).padStart(4, "0");
      entryCount += 1;
      if (entryCount > MAX_TREE_ENTRIES) throw new Error(`Package tree exceeds ${MAX_TREE_ENTRIES} entries.`);
      paths.add(relative);
      if (relative.split("/").some((segment) => segment.startsWith("._"))) appleDoubleEntryCount += 1;

      if (metadata.isDirectory()) {
        directoryCount += 1;
        treeHash.update(`d\t${mode}\t0\t-\t${relative}\n`);
        visit(absolute);
        continue;
      }
      if (metadata.isSymbolicLink()) {
        symlinkCount += 1;
        const target = fs.readlinkSync(absolute);
        if (path.isAbsolute(target) || /[\u0000-\u001f\u007f]/u.test(target)) {
          throw new Error(`Package payload contains an unsafe symlink: ${relative}`);
        }
        const resolvedTarget = path.resolve(path.dirname(absolute), target);
        if (!isInside(resolvedRoot, resolvedTarget)) {
          throw new Error(`Package payload symlink escapes its root: ${relative}`);
        }
        treeHash.update(`l\t${mode}\t${Buffer.byteLength(target)}\t${sha256(target)}\t${relative}\n`);
        files.set(relative, { type: "symlink", mode, size: Buffer.byteLength(target), target });
        continue;
      }
      if (!metadata.isFile()) throw new Error(`Package tree contains an unsupported entry: ${relative}`);
      const digest = hashRegularFile(absolute, MAX_ARTIFACT_BYTES);
      regularFileCount += 1;
      logicalBytes += digest.size;
      if (logicalBytes > MAX_PAYLOAD_BYTES) throw new Error(`Package tree exceeds ${MAX_PAYLOAD_BYTES} logical bytes.`);
      treeHash.update(`f\t${mode}\t${digest.size}\t${digest.sha256}\t${relative}\n`);
      files.set(relative, { type: "file", mode, size: digest.size, sha256: digest.sha256, absolute });
    }
  }

  visit(resolvedRoot);
  return {
    entryCount,
    regularFileCount,
    directoryCount,
    symlinkCount,
    logicalBytes,
    appleDoubleEntryCount,
    treeSha256: treeHash.digest("hex"),
    paths,
    files,
  };
}

function workspaceTreeSnapshot(rootDirectory) {
  const scan = scanPackageTree(rootDirectory);
  const entries = [...scan.paths]
    .sort(compareText)
    .map((relativePath) => {
      const file = scan.files.get(relativePath);
      if (!file) return { path: relativePath, type: "directory" };
      if (file.type === "file") {
        return {
          path: relativePath,
          type: "file",
          size: file.size,
          sha256: file.sha256,
        };
      }
      return {
        path: relativePath,
        type: "symlink",
        size: file.size,
        sha256: sha256(file.target),
        target: file.target,
      };
    });
  const pathSetSha256 = sha256(`${entries.map((entry) => entry.path).join("\n")}\n`);
  const contentTreeSha256 = sha256(entries.map((entry) => {
    if (entry.type === "directory") return `d\t${entry.path}\n`;
    if (entry.type === "file") return `f\t${entry.size}\t${entry.sha256}\t${entry.path}\n`;
    return `l\t${entry.size}\t${entry.sha256}\t${entry.path}\t${entry.target}\n`;
  }).join(""));
  return {
    entries,
    pathSetSha256,
    contentTreeSha256,
    entryCount: scan.entryCount,
    regularFileCount: scan.regularFileCount,
    directoryCount: scan.directoryCount,
    symlinkCount: scan.symlinkCount,
    logicalBytes: scan.logicalBytes,
  };
}

function compareWorkspaceTreeSnapshots(expected, actual, relativePath) {
  const expectedByPath = new Map(expected.entries.map((entry) => [entry.path, entry]));
  const actualByPath = new Map(actual.entries.map((entry) => [entry.path, entry]));
  const missing = [...expectedByPath.keys()].filter((entryPath) => !actualByPath.has(entryPath)).sort(compareText);
  const extra = [...actualByPath.keys()].filter((entryPath) => !expectedByPath.has(entryPath)).sort(compareText);
  const mismatched = [...expectedByPath.keys()]
    .filter((entryPath) => {
      const artifactEntry = actualByPath.get(entryPath);
      if (!artifactEntry) return false;
      const sourceEntry = expectedByPath.get(entryPath);
      return sourceEntry.type !== artifactEntry.type
        || sourceEntry.size !== artifactEntry.size
        || sourceEntry.sha256 !== artifactEntry.sha256
        || sourceEntry.target !== artifactEntry.target;
    })
    .sort(compareText);
  if (missing.length > 0 || extra.length > 0 || mismatched.length > 0) {
    const summarize = (values) => values.length === 0 ? "none" : values.slice(0, 8).join(",");
    throw new Error(
      `Packaged workspace tree ${relativePath} does not match the current workspace build ` +
        `(missing=${summarize(missing)}; extra=${summarize(extra)}; mismatched=${summarize(mismatched)}).`,
    );
  }
}

export function verifyPackagedWorkspaceTrees(
  workspaceRoot,
  payloadRoot,
  treeSpecifications = MACOS_PACKAGED_WORKSPACE_TREES,
) {
  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
  const resolvedPayloadRoot = path.resolve(payloadRoot);
  if (!Array.isArray(treeSpecifications) || treeSpecifications.length === 0) {
    throw new Error("At least one packaged workspace tree must be verified.");
  }
  const seenIds = new Set();
  const seenPaths = new Set();
  const trees = [];
  for (const specificationValue of treeSpecifications) {
    const specification = assertObject(specificationValue, "Packaged workspace tree specification");
    const id = assertString(specification.id, "Packaged workspace tree id");
    const kind = assertString(specification.kind, "Packaged workspace tree kind");
    const relativePath = assertSafeRelativePath(
      assertString(specification.relativePath, "Packaged workspace tree path"),
      "Packaged workspace tree path",
    );
    if (seenIds.has(id) || seenPaths.has(relativePath)) {
      throw new Error(`Packaged workspace tree specification is duplicated: ${id}/${relativePath}`);
    }
    seenIds.add(id);
    seenPaths.add(relativePath);

    const sourceRoot = path.join(resolvedWorkspaceRoot, ...relativePath.split("/"));
    const artifactRelativePath = `${APP_ROOT}/${relativePath}`;
    const artifactRoot = path.join(resolvedPayloadRoot, ...artifactRelativePath.split("/"));
    const sourceBefore = workspaceTreeSnapshot(sourceRoot);
    const artifact = workspaceTreeSnapshot(artifactRoot);
    compareWorkspaceTreeSnapshots(sourceBefore, artifact, relativePath);
    trees.push({
      id,
      kind,
      workspacePath: relativePath,
      artifactPath: artifactRelativePath,
      entryCount: sourceBefore.entryCount,
      regularFileCount: sourceBefore.regularFileCount,
      directoryCount: sourceBefore.directoryCount,
      symlinkCount: sourceBefore.symlinkCount,
      logicalBytes: sourceBefore.logicalBytes,
      pathSetSha256: sourceBefore.pathSetSha256,
      contentTreeSha256: sourceBefore.contentTreeSha256,
      entries: sourceBefore.entries,
    });
  }
  trees.sort((left, right) => compareText(left.id, right.id));
  for (const tree of trees) {
    const finalSource = workspaceTreeSnapshot(
      path.join(resolvedWorkspaceRoot, ...tree.workspacePath.split("/")),
    );
    if (
      finalSource.pathSetSha256 !== tree.pathSetSha256 ||
      finalSource.contentTreeSha256 !== tree.contentTreeSha256
    ) {
      throw new Error(`Workspace build output changed during package verification: ${tree.workspacePath}`);
    }
  }
  const contentSha256 = sha256(trees.map((tree) =>
    `${tree.id}\t${tree.kind}\t${tree.workspacePath}\t${tree.pathSetSha256}\t${tree.contentTreeSha256}\n`,
  ).join(""));
  return {
    status: "pass",
    treeCount: trees.length,
    entryCount: trees.reduce((total, tree) => total + tree.entryCount, 0),
    regularFileCount: trees.reduce((total, tree) => total + tree.regularFileCount, 0),
    directoryCount: trees.reduce((total, tree) => total + tree.directoryCount, 0),
    symlinkCount: trees.reduce((total, tree) => total + tree.symlinkCount, 0),
    logicalBytes: trees.reduce((total, tree) => total + tree.logicalBytes, 0),
    contentSha256,
    trees,
  };
}

export function parseBomPaths(contents) {
  const paths = new Set();
  for (const line of contents.split(/\r?\n/u)) {
    if (!line) continue;
    const normalized = line === "." ? "." : assertSafeRelativePath(line, "BOM entry");
    if (paths.has(normalized)) throw new Error(`BOM contains a duplicate path: ${normalized}`);
    paths.add(normalized);
    if (paths.size > MAX_TREE_ENTRIES) throw new Error(`BOM exceeds ${MAX_TREE_ENTRIES} paths.`);
  }
  if (!paths.has(".")) throw new Error("BOM is missing its root entry.");
  return paths;
}

function comparePathSets(expected, actual, label) {
  const missing = [...expected].filter((value) => !actual.has(value)).sort(compareText);
  const extra = [...actual].filter((value) => !expected.has(value)).sort(compareText);
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `${label} does not match extracted payload paths (missing=${missing.slice(0, 5).join(",")}; extra=${extra.slice(0, 5).join(",")}).`,
    );
  }
}

function isAppleDoublePath(relativePath) {
  return relativePath !== "." && relativePath.split("/").some((segment) => segment.startsWith("._"));
}

function readJson(filePath, maximumBytes, label) {
  const text = readText(filePath, maximumBytes, label);
  try {
    return { text, value: JSON.parse(text) };
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function propertiesMap(component) {
  return new Map((component.properties ?? []).map((property) => [property.name, property.value]));
}

export function readSourceReleaseEvidence(sourceDirectory) {
  const checksumPath = path.join(sourceDirectory, "SHA256SUMS");
  const checksumText = readText(checksumPath, MAX_TEXT_BYTES, "Source evidence SHA256SUMS");
  const sums = parseSha256Manifest(checksumText, ["formaspec.cdx.json", "licenses.json"]);
  const bomPath = path.join(sourceDirectory, "formaspec.cdx.json");
  const licensePath = path.join(sourceDirectory, "licenses.json");
  const bomText = readText(bomPath, MAX_TEXT_BYTES, "Source CycloneDX SBOM");
  const licenseText = readText(licensePath, MAX_TEXT_BYTES, "Source license evidence");
  if (sha256(bomText) !== sums.get("formaspec.cdx.json") || sha256(licenseText) !== sums.get("licenses.json")) {
    throw new Error("Source evidence checksums do not match their JSON files.");
  }
  const bom = JSON.parse(bomText);
  const licenses = JSON.parse(licenseText);
  if (bom.bomFormat !== "CycloneDX" || bom.specVersion !== "1.6") {
    throw new Error("Source SBOM is not CycloneDX 1.6.");
  }
  if (licenses.policy?.status !== "pass" || licenses.violations?.length !== 0) {
    throw new Error("Source dependency license policy must pass before packaging evidence is linked.");
  }
  const target = licenses.target;
  const bomTarget = (bom.metadata?.properties ?? []).find((property) => property.name === "formaspec:evidence:target")?.value;
  if (typeof target !== "string" || bomTarget !== target) throw new Error("Source evidence target metadata is inconsistent.");
  const rootComponent = assertObject(bom.metadata?.component, "Source SBOM root component");
  const components = [rootComponent, ...(bom.components ?? [])];
  const byPurl = new Map();
  for (const componentValue of components) {
    const component = assertObject(componentValue, "Source SBOM component");
    const purl = assertString(component.purl, "Source SBOM component purl");
    if (byPurl.has(purl)) throw new Error(`Source SBOM contains duplicate purl: ${purl}`);
    byPurl.set(purl, component);
  }
  const thirdPartyPurls = new Set((licenses.packages ?? []).map((entry) => assertString(entry.purl, "License package purl")));
  for (const purl of thirdPartyPurls) {
    if (!byPurl.has(purl)) throw new Error(`License report package is absent from source SBOM: ${purl}`);
  }
  const workspaceComponents = [...byPurl.values()].filter(
    (component) => propertiesMap(component).get("formaspec:first-party") === "true",
  );
  return {
    target,
    bom,
    licenses,
    bomSha256: sums.get("formaspec.cdx.json"),
    licensesSha256: sums.get("licenses.json"),
    byPurl,
    thirdPartyPurls,
    workspaceComponents,
  };
}

function mergeComponentRecord(records, record) {
  const existing = records.get(record.purl);
  if (!existing) {
    records.set(record.purl, { ...record, paths: [record.path], instanceCount: 1 });
    return;
  }
  if (existing.manifestSha256 !== record.manifestSha256 || existing.name !== record.name || existing.version !== record.version) {
    throw new Error(`Packaged component has inconsistent manifests: ${record.purl}`);
  }
  existing.instanceCount += 1;
  if (!existing.paths.includes(record.path)) existing.paths.push(record.path);
  existing.paths.sort(compareText);
}

function packageRecord(manifestPath, payloadRoot, kind) {
  const { text, value } = readJson(manifestPath, MAX_PACKAGE_MANIFEST_BYTES, `${manifestPath} package manifest`);
  const manifest = assertObject(value, `${manifestPath} package manifest`);
  const name = assertString(manifest.name, `${manifestPath} package name`);
  const version = assertString(manifest.version, `${manifestPath} package version`);
  return {
    purl: npmPurl(name, version),
    name,
    version,
    kind,
    manifestSha256: sha256(text),
    path: toPosix(path.relative(payloadRoot, manifestPath)),
  };
}

export function scanPackagedNpmComponents(payloadRoot, sourceEvidence) {
  const records = new Map();
  const appRoot = path.join(payloadRoot, ...APP_ROOT.split("/"));
  const pnpmRoot = path.join(appRoot, "node_modules", ".pnpm");
  const pnpmMetadata = fs.lstatSync(pnpmRoot);
  if (pnpmMetadata.isSymbolicLink() || !pnpmMetadata.isDirectory()) {
    throw new Error("Packaged pnpm virtual store is missing.");
  }

  for (const storeEntry of fs.readdirSync(pnpmRoot, { withFileTypes: true }).sort((left, right) => compareText(left.name, right.name))) {
    if (!storeEntry.isDirectory() || storeEntry.isSymbolicLink() || storeEntry.name === "node_modules") continue;
    const nodeModules = path.join(pnpmRoot, storeEntry.name, "node_modules");
    if (!fs.existsSync(nodeModules) || !fs.lstatSync(nodeModules).isDirectory()) continue;
    for (const entry of fs.readdirSync(nodeModules, { withFileTypes: true }).sort((left, right) => compareText(left.name, right.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (entry.name.startsWith("@")) {
        const scopePath = path.join(nodeModules, entry.name);
        for (const child of fs.readdirSync(scopePath, { withFileTypes: true }).sort((left, right) => compareText(left.name, right.name))) {
          if (!child.isDirectory() || child.isSymbolicLink()) continue;
          const manifestPath = path.join(scopePath, child.name, "package.json");
          if (fs.existsSync(manifestPath) && fs.lstatSync(manifestPath).isFile()) {
            mergeComponentRecord(records, packageRecord(manifestPath, payloadRoot, "third-party"));
          }
        }
      } else {
        const manifestPath = path.join(nodeModules, entry.name, "package.json");
        if (fs.existsSync(manifestPath) && fs.lstatSync(manifestPath).isFile()) {
          mergeComponentRecord(records, packageRecord(manifestPath, payloadRoot, "third-party"));
        }
      }
    }
  }

  const excludedSourceWorkspaces = [];
  for (const component of sourceEvidence.workspaceComponents) {
    const properties = propertiesMap(component);
    const manifestRelative = assertString(properties.get("formaspec:workspace:manifest"), "Workspace manifest property");
    const manifestPath = path.join(appRoot, ...manifestRelative.split("/"));
    if (!fs.existsSync(manifestPath)) {
      excludedSourceWorkspaces.push({ purl: component.purl, manifest: manifestRelative, reason: "workspace-not-packaged" });
      continue;
    }
    mergeComponentRecord(records, packageRecord(manifestPath, payloadRoot, "workspace"));
  }

  return {
    records,
    excludedSourceWorkspaces: excludedSourceWorkspaces.sort((left, right) => compareText(left.purl, right.purl)),
  };
}

function plistValue(plistPath, key) {
  return run("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plistPath]).stdout.trim();
}

function fileDescription(filePath) {
  return run("/usr/bin/file", ["-b", filePath]).stdout.trim().replace(/\s+/gu, " ");
}

function keyFile(scan, relativePath, required = true) {
  const entry = scan.files.get(relativePath);
  if (!entry || entry.type !== "file") {
    if (required) throw new Error(`Required package payload file is missing: ${relativePath}`);
    return undefined;
  }
  return {
    path: relativePath,
    sha256: entry.sha256,
    size: entry.size,
    mode: entry.mode,
  };
}

function runtimeLicenseStatus(expression, policy, evidencePresent) {
  const evaluated = evaluateLicense(expression, policy);
  if (!evidencePresent) return { status: "fail", reason: "license-evidence-missing" };
  return evaluated.allowed
    ? { status: "pass", reason: evaluated.reason }
    : { status: "fail", reason: evaluated.reason, identifier: evaluated.identifier };
}

export function inspectPackagedRuntimes(payloadRoot, payloadScan, policyValue, architecture) {
  const policy = validateLicensePolicy(policyValue);
  const runtimeRootRelative = `${INSTALL_ROOT}/runtime`;
  const runtimeRoot = path.join(payloadRoot, ...runtimeRootRelative.split("/"));
  const components = [];
  const blockers = [];

  const nodeRelative = `${runtimeRootRelative}/node`;
  const nodeFile = keyFile(payloadScan, nodeRelative);
  const nodeProvenancePath = [...payloadScan.files.keys()].find((candidate) =>
    candidate.startsWith(`${runtimeRootRelative}/licenses/node-v`) && candidate.endsWith("-provenance.json"),
  );
  let nodeVersion = "unreported";
  let nodeLicensePath;
  let nodeLicenseSha256;
  let nodeProvenanceSha256;
  let nodeSourceArchiveSha256;
  let nodeLicenseValid = false;
  let nodeLicenseContainsForbiddenText = false;
  if (nodeProvenancePath) {
    const provenanceFile = keyFile(payloadScan, nodeProvenancePath);
    const { value: provenanceValue } = readJson(
      path.join(payloadRoot, ...nodeProvenancePath.split("/")),
      MAX_TEXT_BYTES,
      "Node runtime license provenance",
    );
    const provenance = assertObject(provenanceValue, "Node runtime license provenance");
    nodeVersion = assertString(provenance.version, "Node runtime provenance version");
    const expectedLicenseFilename = `node-v${nodeVersion}-LICENSE`;
    nodeLicensePath = `${runtimeRootRelative}/licenses/${expectedLicenseFilename}`;
    const licenseFile = keyFile(payloadScan, nodeLicensePath, false);
    if (
      provenance.format === "formaspec-vendored-license-provenance" &&
      provenance.formatVersion === 1 &&
      provenance.component === "Node.js" &&
      provenance.licenseFile === expectedLicenseFilename &&
      provenance.archivePath === `node-v${nodeVersion}/LICENSE` &&
      provenance.sourceArchive === `https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}.tar.xz` &&
      provenance.checksumManifest === `https://nodejs.org/dist/v${nodeVersion}/SHASUMS256.txt` &&
      typeof provenance.sourceArchiveSha256 === "string" &&
      /^[a-f0-9]{64}$/u.test(provenance.sourceArchiveSha256) &&
      typeof provenance.licenseSha256 === "string" &&
      /^[a-f0-9]{64}$/u.test(provenance.licenseSha256) &&
      Number.isSafeInteger(provenance.licenseSizeBytes) &&
      provenance.licenseSizeBytes > 0 &&
      licenseFile &&
      licenseFile.sha256 === provenance.licenseSha256 &&
      licenseFile.size === provenance.licenseSizeBytes
    ) {
      const licenseText = readText(
        path.join(payloadRoot, ...nodeLicensePath.split("/")),
        MAX_TEXT_BYTES,
        "Node runtime license",
      );
      nodeLicenseContainsForbiddenText = [
        "GNU AFFERO GENERAL PUBLIC LICENSE",
        "GNU GENERAL PUBLIC LICENSE",
        "GNU LESSER GENERAL PUBLIC LICENSE",
        "SERVER SIDE PUBLIC LICENSE",
      ].some((marker) => licenseText.includes(marker));
      nodeLicenseValid = !nodeLicenseContainsForbiddenText;
      nodeLicenseSha256 = licenseFile.sha256;
      nodeProvenanceSha256 = provenanceFile.sha256;
      nodeSourceArchiveSha256 = provenance.sourceArchiveSha256;
    }
  }
  const nodeRef = `pkg:generic/nodejs-runtime@${encodeURIComponent(nodeVersion)}?arch=${encodeURIComponent(architecture)}`;
  const nodePolicy = runtimeLicenseStatus("MIT", policy, nodeLicenseValid);
  components.push({
    "bom-ref": nodeRef,
    type: "framework",
    name: "Node.js bundled runtime",
    version: nodeVersion,
    purl: nodeRef,
    hashes: [{ alg: "SHA-256", content: nodeFile.sha256 }],
    licenses: [{ license: { id: "MIT" } }],
    properties: [
      { name: "formaspec:artifact:path", value: nodeRelative },
      { name: "formaspec:artifact:file-description", value: fileDescription(nodeFile.path ? path.join(payloadRoot, ...nodeFile.path.split("/")) : "") },
      { name: "formaspec:license:evidence", value: nodeLicensePath ?? "missing" },
      { name: "formaspec:license:evidence-sha256", value: nodeLicenseSha256 ?? "missing" },
      { name: "formaspec:license:provenance", value: nodeProvenancePath ?? "missing" },
      { name: "formaspec:license:provenance-sha256", value: nodeProvenanceSha256 ?? "missing" },
      { name: "formaspec:license:contains-forbidden-text", value: String(nodeLicenseContainsForbiddenText) },
      { name: "formaspec:license:policy-status", value: nodePolicy.status },
      { name: "formaspec:runtime:source-archive-sha256", value: nodeSourceArchiveSha256 ?? "missing" },
    ].sort((left, right) => compareText(left.name, right.name)),
  });
  if (nodePolicy.status !== "pass") {
    blockers.push({
      code: nodeLicenseContainsForbiddenText
        ? "NODE_RUNTIME_LICENSE_FORBIDDEN"
        : "NODE_RUNTIME_LICENSE_EVIDENCE_MISSING",
      component: nodeRef,
      detail: nodePolicy.reason,
    });
  }

  const browsersRoot = path.join(runtimeRoot, "ms-playwright");
  const browserEntries = fs.readdirSync(browsersRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && entry.name !== ".links")
    .map((entry) => entry.name)
    .sort(compareText);
  const recognized = new Set();

  for (const directoryName of browserEntries) {
    const chromiumMatch = /^chromium-(\d+)$/u.exec(directoryName);
    const headlessMatch = /^chromium_headless_shell-(\d+)$/u.exec(directoryName);
    const ffmpegMatch = /^ffmpeg-(\d+)$/u.exec(directoryName);
    if (chromiumMatch) {
      recognized.add(directoryName);
      const prefix = `${runtimeRootRelative}/ms-playwright/${directoryName}`;
      const infoPath = [...payloadScan.files.keys()].find((candidate) =>
        candidate.startsWith(`${prefix}/`) && candidate.endsWith("Google Chrome for Testing.app/Contents/Info.plist"),
      );
      const executablePath = [...payloadScan.files.keys()].find((candidate) =>
        candidate.startsWith(`${prefix}/`) && candidate.endsWith("Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
      );
      if (!infoPath || !executablePath) throw new Error("Chromium browser payload is incomplete.");
      const executable = keyFile(payloadScan, executablePath);
      const version = plistValue(path.join(payloadRoot, ...infoPath.split("/")), "CFBundleShortVersionString");
      const ref = `pkg:generic/chrome-for-testing@${encodeURIComponent(version)}?arch=${encodeURIComponent(architecture)}`;
      const expression = "LicenseRef-Chrome-for-Testing-Unverified";
      const status = runtimeLicenseStatus(expression, policy, false);
      components.push({
        "bom-ref": ref,
        type: "application",
        name: "Google Chrome for Testing",
        version,
        purl: ref,
        hashes: [{ alg: "SHA-256", content: executable.sha256 }],
        licenses: [{ expression }],
        properties: [
          { name: "formaspec:artifact:path", value: executablePath },
          { name: "formaspec:playwright:revision", value: chromiumMatch[1] },
          { name: "formaspec:license:evidence", value: "missing-root-license" },
          { name: "formaspec:license:policy-status", value: status.status },
        ].sort((left, right) => compareText(left.name, right.name)),
      });
      blockers.push({ code: "CHROME_RUNTIME_LICENSE_UNVERIFIED", component: ref, detail: status.reason });
      continue;
    }
    if (headlessMatch) {
      recognized.add(directoryName);
      const prefix = `${runtimeRootRelative}/ms-playwright/${directoryName}`;
      const executablePath = [...payloadScan.files.keys()].find((candidate) =>
        candidate.startsWith(`${prefix}/`) && /\/chrome-headless-shell(?:-mac-[^/]+)?$/u.test(candidate),
      );
      const licensePath = [...payloadScan.files.keys()].find((candidate) =>
        candidate.startsWith(`${prefix}/`) && path.posix.basename(candidate) === "LICENSE.headless_shell",
      );
      if (!executablePath || !licensePath) throw new Error("Chromium headless-shell payload is incomplete.");
      const executable = keyFile(payloadScan, executablePath);
      const licenseText = readText(path.join(payloadRoot, ...licensePath.split("/")), MAX_TEXT_BYTES, "Chromium license bundle");
      const containsLesserGpl = licenseText.includes("GNU LESSER GENERAL PUBLIC LICENSE");
      const ref = `pkg:generic/chromium-headless-shell@playwright-${headlessMatch[1]}?arch=${encodeURIComponent(architecture)}`;
      const expression = "LicenseRef-Chromium-Composite";
      const status = runtimeLicenseStatus(expression, policy, true);
      components.push({
        "bom-ref": ref,
        type: "application",
        name: "Chromium headless shell",
        version: `playwright-${headlessMatch[1]}`,
        purl: ref,
        hashes: [{ alg: "SHA-256", content: executable.sha256 }],
        licenses: [{ expression }],
        properties: [
          { name: "formaspec:artifact:path", value: executablePath },
          { name: "formaspec:license:evidence", value: licensePath },
          { name: "formaspec:license:evidence-sha256", value: sha256(licenseText) },
          { name: "formaspec:license:contains-lgpl-text", value: String(containsLesserGpl) },
          { name: "formaspec:license:policy-status", value: status.status },
        ].sort((left, right) => compareText(left.name, right.name)),
      });
      blockers.push({
        code: containsLesserGpl ? "CHROMIUM_RUNTIME_CONTAINS_LGPL_NOTICES" : "CHROMIUM_RUNTIME_LICENSE_UNREVIEWED",
        component: ref,
        detail: status.reason,
      });
      continue;
    }
    if (ffmpegMatch) {
      recognized.add(directoryName);
      const prefix = `${runtimeRootRelative}/ms-playwright/${directoryName}`;
      const executablePath = [...payloadScan.files.keys()].find((candidate) =>
        candidate.startsWith(`${prefix}/`) && /^ffmpeg(?:-mac)?$/u.test(path.posix.basename(candidate)),
      );
      const licensePath = [...payloadScan.files.keys()].find((candidate) =>
        candidate.startsWith(`${prefix}/`) && path.posix.basename(candidate) === "COPYING.LGPLv2.1",
      );
      if (!executablePath || !licensePath) throw new Error("Playwright FFmpeg payload is incomplete.");
      const executable = keyFile(payloadScan, executablePath);
      const ref = `pkg:generic/playwright-ffmpeg@${ffmpegMatch[1]}?arch=${encodeURIComponent(architecture)}`;
      const expression = "LGPL-2.1-only";
      const status = runtimeLicenseStatus(expression, policy, true);
      components.push({
        "bom-ref": ref,
        type: "application",
        name: "Playwright FFmpeg",
        version: ffmpegMatch[1],
        purl: ref,
        hashes: [{ alg: "SHA-256", content: executable.sha256 }],
        licenses: [{ license: { id: expression } }],
        properties: [
          { name: "formaspec:artifact:path", value: executablePath },
          { name: "formaspec:license:evidence", value: licensePath },
          { name: "formaspec:license:policy-status", value: status.status },
        ].sort((left, right) => compareText(left.name, right.name)),
      });
      blockers.push({ code: "FFMPEG_RUNTIME_LICENSE_FORBIDDEN", component: ref, detail: status.reason });
      continue;
    }
  }

  for (const directoryName of browserEntries.filter((entry) => !recognized.has(entry))) {
    blockers.push({
      code: "UNINVENTORIED_PLAYWRIGHT_RUNTIME",
      component: `runtime:${directoryName}`,
      detail: "unexpected-runtime-directory",
    });
  }
  if (!browserEntries.some((entry) => /^chromium(?:_headless_shell)?-/u.test(entry))) {
    throw new Error("The macOS package does not contain a Chromium renderer runtime.");
  }
  return {
    components: components.sort((left, right) => compareText(left["bom-ref"], right["bom-ref"])),
    blockers: blockers.sort((left, right) => compareText(`${left.code}:${left.component}`, `${right.code}:${right.component}`)),
    browserDirectories: browserEntries,
  };
}

function artifactFilenameMetadata(filename) {
  const match = /^FormaSpec-(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)-macos-(arm64|x64)-unsigned\.pkg$/u.exec(filename);
  if (!match) throw new Error("macOS artifact filename does not match the unsigned FormaSpec PKG contract.");
  return { version: match[1], architecture: match[2] };
}

function classifyPackageSignature(packagePath) {
  const result = run("/usr/sbin/pkgutil", ["--check-signature", packagePath], { acceptStatus: [0, 1] });
  const output = `${result.stdout}\n${result.stderr}`;
  if (/Status:\s+no signature/iu.test(output)) return { status: "unsigned", tool: "pkgutil", exitCode: result.status };
  if (result.status === 0) return { status: "signed", tool: "pkgutil", exitCode: result.status };
  return { status: "invalid-or-unrecognized", tool: "pkgutil", exitCode: result.status };
}

function requiredKeyFiles(scan) {
  return [
    "Applications/FormaSpec.app/Contents/Info.plist",
    "Applications/FormaSpec.app/Contents/MacOS/FormaSpec",
    "Library/LaunchAgents/com.formaspec.api.plist",
    "Library/LaunchAgents/com.formaspec.renderer.plist",
    `${INSTALL_ROOT}/VERSION`,
    `${INSTALL_ROOT}/install-manifest.json`,
    `${INSTALL_ROOT}/bin/formaspec-api`,
    `${INSTALL_ROOT}/bin/formaspec-renderer`,
    `${INSTALL_ROOT}/bin/formaspecctl`,
    `${APP_ROOT}/designer`,
    `${APP_ROOT}/apps/server/dist/index.js`,
    `${APP_ROOT}/apps/server/dist/renderer-worker.js`,
    `${APP_ROOT}/apps/web/dist/index.html`,
    `${APP_ROOT}/apps/cli/dist/index.js`,
    `${APP_ROOT}/apps/local-bridge/dist/index.js`,
    `${APP_ROOT}/apps/workspace-bridge/dist/cli.js`,
    `${APP_ROOT}/packages/core/dist/index.js`,
    `${INSTALL_ROOT}/runtime/node`,
    "usr/local/bin/formaspecctl",
  ].map((relativePath) => keyFile(scan, relativePath));
}

function appendComponentProperties(component, additions) {
  const properties = new Map((component.properties ?? []).map((entry) => [entry.name, entry.value]));
  for (const entry of additions) properties.set(entry.name, entry.value);
  return {
    ...component,
    properties: [...properties.entries()]
      .map(([name, value]) => ({ name, value }))
      .sort((left, right) => compareText(left.name, right.name)),
  };
}

export function buildMacPackageEvidence(input) {
  const source = input.sourceEvidence;
  const workspaceTrees = assertObject(input.workspaceTreeVerification, "Workspace tree verification");
  if (workspaceTrees.status !== "pass" || !Array.isArray(workspaceTrees.trees) || workspaceTrees.trees.length === 0) {
    throw new Error("Workspace build outputs must pass exact artifact comparison before evidence is generated.");
  }
  const workspaceTreeSummary = {
    status: workspaceTrees.status,
    treeCount: workspaceTrees.treeCount,
    entryCount: workspaceTrees.entryCount,
    regularFileCount: workspaceTrees.regularFileCount,
    directoryCount: workspaceTrees.directoryCount,
    symlinkCount: workspaceTrees.symlinkCount,
    logicalBytes: workspaceTrees.logicalBytes,
    contentSha256: workspaceTrees.contentSha256,
    trees: workspaceTrees.trees.map(({ entries: _entries, ...tree }) => tree),
  };
  const packaged = [...input.packagedComponents.records.values()]
    .map((entry) => ({ ...entry, paths: [...entry.paths].sort(compareText) }))
    .sort((left, right) => compareText(left.purl, right.purl));
  const payloadPurls = new Set(packaged.map((entry) => entry.purl));
  const missingThirdParty = [...source.thirdPartyPurls].filter((purl) => !payloadPurls.has(purl)).sort(compareText);
  const unknownPayload = packaged.filter((entry) => !source.byPurl.has(entry.purl)).map((entry) => entry.purl).sort(compareText);
  const matched = packaged.filter((entry) => source.byPurl.has(entry.purl));
  const manifestMismatches = matched
    .flatMap((entry) => {
      const sourceComponent = source.byPurl.get(entry.purl);
      const properties = propertiesMap(sourceComponent);
      const expected = entry.kind === "workspace"
        ? properties.get("formaspec:workspace:manifest-sha256")
        : properties.get("formaspec:evidence:package-manifest-sha256");
      return expected === entry.manifestSha256
        ? []
        : [{ purl: entry.purl, expectedSha256: expected ?? "missing", artifactSha256: entry.manifestSha256 }];
    })
    .sort((left, right) => compareText(left.purl, right.purl));
  const sourceLinkageStatus =
    missingThirdParty.length === 0 && unknownPayload.length === 0 && manifestMismatches.length === 0 ? "pass" : "fail";

  const blockerMap = new Map();
  function addBlocker(blocker) {
    blockerMap.set(`${blocker.code}:${blocker.component ?? "artifact"}`, blocker);
  }
  for (const blocker of input.runtimeInventory.blockers) addBlocker(blocker);
  if (input.payload.appleDoubleEntryCount > 0) {
    addBlocker({
      code: "APPLEDOUBLE_PAYLOAD_ENTRIES_PRESENT",
      detail: `${input.payload.appleDoubleEntryCount} AppleDouble metadata entries remain in the installer BOM.`,
    });
  }
  if (sourceLinkageStatus !== "pass") {
    addBlocker({
      code: "SOURCE_SBOM_LINKAGE_FAILED",
      detail: `missing=${missingThirdParty.length};unknown=${unknownPayload.length};manifest-mismatches=${manifestMismatches.length}`,
    });
  }
  addBlocker({ code: "PACKAGE_UNSIGNED", detail: "No Developer ID Installer signature is present." });
  addBlocker({ code: "NOTARIZATION_EVIDENCE_MISSING", detail: "No Apple notarization ticket or stapling evidence is available." });
  addBlocker({ code: "VULNERABILITY_SCAN_MISSING", detail: "No external dependency, binary, or OS vulnerability scan is attached." });
  addBlocker({ code: "REPRODUCIBILITY_EVIDENCE_MISSING", detail: "A second independent build has not reproduced the artifact bytes." });
  const blockers = [...blockerMap.values()].sort((left, right) => compareText(`${left.code}:${left.component ?? ""}`, `${right.code}:${right.component ?? ""}`));

  const sourceComponents = matched.map((record) =>
    appendComponentProperties(source.byPurl.get(record.purl), [
      { name: "formaspec:artifact:instance-count", value: String(record.instanceCount) },
      { name: "formaspec:artifact:manifest-sha256", value: record.manifestSha256 },
      { name: "formaspec:artifact:paths", value: record.paths.join(",") },
      { name: "formaspec:artifact:source-sbom-ref", value: record.purl },
    ]),
  );
  const componentRefs = new Set([...sourceComponents.map((component) => component["bom-ref"]), ...input.runtimeInventory.components.map((component) => component["bom-ref"])]);
  const artifactRef = `pkg:generic/formaspec@${encodeURIComponent(input.artifact.version)}?arch=${encodeURIComponent(input.artifact.architecture)}&packaging=pkg`;
  const sourceRootRef = source.bom.metadata.component["bom-ref"];
  const dependencies = (source.bom.dependencies ?? [])
    .filter((entry) => componentRefs.has(entry.ref))
    .map((entry) => ({ ref: entry.ref, dependsOn: (entry.dependsOn ?? []).filter((ref) => componentRefs.has(ref)).sort(compareText) }));
  dependencies.push({
    ref: artifactRef,
    dependsOn: [sourceRootRef, ...input.runtimeInventory.components.map((component) => component["bom-ref"])]
      .filter((ref) => componentRefs.has(ref))
      .sort(compareText),
  });
  dependencies.sort((left, right) => compareText(left.ref, right.ref));

  const artifactComponent = {
    "bom-ref": artifactRef,
    type: "application",
    name: "FormaSpec macOS unsigned installer",
    version: input.artifact.version,
    purl: artifactRef,
    hashes: [{ alg: "SHA-256", content: input.artifact.sha256 }],
    externalReferences: [
      {
        type: "bom",
        url: `urn:formaspec:source-sbom:sha256:${source.bomSha256}`,
        hashes: [{ alg: "SHA-256", content: source.bomSha256 }],
      },
      {
        type: "distribution",
        url: `urn:formaspec:artifact:sha256:${input.artifact.sha256}`,
        hashes: [{ alg: "SHA-256", content: input.artifact.sha256 }],
      },
    ],
    properties: [
      { name: "formaspec:artifact:filename", value: input.artifact.filename },
      { name: "formaspec:artifact:payload-tree-sha256", value: input.payload.treeSha256 },
      { name: "formaspec:artifact:signed", value: "false" },
      { name: "formaspec:release:decision", value: "no-go" },
      { name: "formaspec:source-sbom:sha256", value: source.bomSha256 },
      { name: "formaspec:workspace-trees:sha256", value: workspaceTrees.contentSha256 },
    ].sort((left, right) => compareText(left.name, right.name)),
  };

  const bom = {
    $schema: "https://cyclonedx.org/schema/bom-1.6.schema.json",
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      component: artifactComponent,
      tools: {
        components: [{ type: "application", name: "formaspec-macos-pkg-evidence", version: String(MACOS_PKG_EVIDENCE_VERSION) }],
      },
      properties: [
        { name: "formaspec:evidence:deterministic", value: "true" },
        { name: "formaspec:evidence:integrity-status", value: "pass" },
        { name: "formaspec:evidence:release-decision", value: "no-go" },
      ].sort((left, right) => compareText(left.name, right.name)),
    },
    components: [...sourceComponents, ...input.runtimeInventory.components].sort((left, right) => compareText(left["bom-ref"], right["bom-ref"])),
    dependencies,
  };

  const componentInventory = {
    format: "formaspec-macos-pkg-components",
    schemaVersion: MACOS_PKG_EVIDENCE_VERSION,
    artifact: {
      filename: input.artifact.filename,
      sha256: input.artifact.sha256,
      version: input.artifact.version,
      architecture: input.artifact.architecture,
    },
    sourceSbom: { filename: "formaspec.cdx.json", sha256: source.bomSha256, target: source.target },
    summary: {
      packagedNpmComponentCount: packaged.length,
      matchedSourceComponentCount: matched.length,
      missingSourceThirdPartyCount: missingThirdParty.length,
      unknownPayloadComponentCount: unknownPayload.length,
      manifestMismatchCount: manifestMismatches.length,
      excludedSourceWorkspaceCount: input.packagedComponents.excludedSourceWorkspaces.length,
      runtimeComponentCount: input.runtimeInventory.components.length,
      workspaceTreeCount: workspaceTrees.treeCount,
      workspaceTreeEntryCount: workspaceTrees.entryCount,
      workspaceTreeRegularFileCount: workspaceTrees.regularFileCount,
    },
    components: packaged,
    runtimes: input.runtimeInventory.components.map((component) => ({
      bomRef: component["bom-ref"],
      name: component.name,
      version: component.version,
      hashes: component.hashes,
      licenses: component.licenses,
      properties: component.properties,
    })),
    missingSourceThirdParty: missingThirdParty,
    unknownPayloadComponents: unknownPayload,
    manifestMismatches,
    excludedSourceWorkspaces: input.packagedComponents.excludedSourceWorkspaces,
    workspaceTrees,
  };

  const verification = {
    format: "formaspec-macos-pkg-verification",
    schemaVersion: MACOS_PKG_EVIDENCE_VERSION,
    integrityStatus: "pass",
    releaseDecision: "no-go",
    artifact: input.artifact,
    signature: input.signature,
    package: input.packageMetadata,
    payload: {
      entryCount: input.payload.entryCount,
      regularFileCount: input.payload.regularFileCount,
      directoryCount: input.payload.directoryCount,
      symlinkCount: input.payload.symlinkCount,
      logicalBytes: input.payload.logicalBytes,
      treeSha256: input.payload.treeSha256,
      bomPathCount: input.payload.bomPathCount,
      bomPathSetSha256: input.payload.bomPathSetSha256,
      appleDoubleEntryCount: input.payload.appleDoubleEntryCount,
      extractedAppleDoubleEntryCount: input.payload.extractedAppleDoubleEntryCount,
    },
    installerScripts: input.installerScripts,
    keyFiles: input.keyFiles,
    sourceEvidence: {
      target: source.target,
      sbomSha256: source.bomSha256,
      licensesSha256: source.licensesSha256,
      sourceLicensePolicyStatus: source.licenses.policy.status,
      linkageStatus: sourceLinkageStatus,
    },
    workspaceTrees: workspaceTreeSummary,
    runtimeDirectories: input.runtimeInventory.browserDirectories,
    blockers,
    checksPerformed: [
      "artifact SHA-256 and canonical sidecar",
      "pkgutil signature classification",
      "full flat-PKG expansion in a private temporary directory",
      "PackageInfo, install manifest, bundle identity, scripts, and required payload paths",
      "BOM-to-extracted-tree exact path equality",
      "mode/content/symlink-aware payload tree hash",
      "packaged npm manifest inventory linked to the source CycloneDX SBOM",
      "exact workspace dist and managed CLI asset path/content-hash equality",
      "bundled Node and Playwright runtime inventory with local license evidence",
    ],
    limitations: [
      "The artifact is unsigned and not notarized; checksums prove integrity, not publisher identity.",
      "No external vulnerability database, binary scanner, Apple service, or signing credential is used.",
      "Reproducibility requires an independent second build and is not proven by one artifact hash.",
    ],
  };
  return { bom, componentInventory, verification };
}

export function renderMacPackageEvidence(evidence) {
  const files = new Map([
    ["artifact.cdx.json", deterministicJson(evidence.bom)],
    ["components.json", deterministicJson(evidence.componentInventory)],
    ["verification.json", deterministicJson(evidence.verification)],
  ]);
  const lines = [...files.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([name, contents]) => `${sha256(contents)}  ${name}`);
  files.set("SHA256SUMS", `${lines.join("\n")}\n`);
  return files;
}

function assertOutputDirectory(outputDirectory) {
  if (fs.existsSync(outputDirectory)) {
    const metadata = fs.lstatSync(outputDirectory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("Artifact evidence output must be a real directory.");
  }
}

export function writeMacPackageEvidence(outputDirectory, files) {
  assertOutputDirectory(outputDirectory);
  fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o755 });
  for (const name of MACOS_PKG_EVIDENCE_FILES) {
    const contents = files.get(name);
    if (typeof contents !== "string") throw new Error(`Missing artifact evidence output: ${name}`);
    const destination = path.join(outputDirectory, name);
    if (fs.existsSync(destination) && fs.lstatSync(destination).isSymbolicLink()) {
      throw new Error(`Refusing to replace symlinked artifact evidence: ${name}`);
    }
    const temporary = path.join(outputDirectory, `.${name}.${process.pid}.tmp`);
    try {
      fs.writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
      fs.chmodSync(temporary, 0o644);
      fs.renameSync(temporary, destination);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
}

export function verifyMacPackageEvidence(outputDirectory, expectedFiles) {
  const differences = [];
  for (const name of MACOS_PKG_EVIDENCE_FILES) {
    const filePath = path.join(outputDirectory, name);
    if (!fs.existsSync(filePath)) {
      differences.push(`${name} is missing`);
      continue;
    }
    const metadata = fs.lstatSync(filePath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      differences.push(`${name} is not a regular file`);
      continue;
    }
    const actual = readText(filePath, MAX_TEXT_BYTES, name);
    if (actual !== expectedFiles.get(name)) differences.push(`${name} does not match the current artifact and source evidence`);
  }
  return differences;
}

export function collectMacPackageEvidence({ packagePath, sourceEvidenceDirectory, policyPath, workspaceRoot }) {
  if (process.platform !== "darwin") throw new Error("macOS PKG evidence must run on macOS with pkgutil.");
  const resolvedWorkspaceRoot = path.resolve(assertString(workspaceRoot, "Workspace root"));
  const resolvedPackage = path.resolve(packagePath);
  const packageMetadata = artifactFilenameMetadata(path.basename(resolvedPackage));
  const artifactHash = hashRegularFile(resolvedPackage);
  const sidecarPath = `${resolvedPackage}.sha256`;
  const sidecarDigest = parseSha256Sidecar(
    readText(sidecarPath, 4_096, "Installer checksum sidecar"),
    path.basename(resolvedPackage),
  );
  if (sidecarDigest !== artifactHash.sha256) throw new Error("Installer checksum sidecar does not match the PKG bytes.");
  const signature = classifyPackageSignature(resolvedPackage);
  if (signature.status !== "unsigned") throw new Error(`Expected an unsigned PKG, received signature status ${signature.status}.`);
  const sourceEvidence = readSourceReleaseEvidence(path.resolve(sourceEvidenceDirectory));
  const expectedTarget = `darwin-${packageMetadata.architecture}`;
  if (sourceEvidence.target !== expectedTarget) {
    throw new Error(`Source evidence target ${sourceEvidence.target} does not match package target ${expectedTarget}.`);
  }
  const { value: policyValue } = readJson(path.resolve(policyPath), MAX_TEXT_BYTES, "License policy");
  const policy = validateLicensePolicy(policyValue);

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "formaspec-pkg-evidence-"));
  fs.chmodSync(temporary, 0o700);
  const expanded = path.join(temporary, "expanded");
  try {
    run("/usr/sbin/pkgutil", ["--expand-full", resolvedPackage, expanded], { timeout: 600_000 });
    const components = fs.readdirSync(expanded, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && entry.name.endsWith(".pkg"))
      .map((entry) => entry.name)
      .sort(compareText);
    if (components.length !== 1) throw new Error("FormaSpec product archive must contain exactly one component package.");
    const componentRoot = path.join(expanded, components[0]);
    const payloadRoot = path.join(componentRoot, "Payload");
    const scriptsRoot = path.join(componentRoot, "Scripts");
    const packageInfoText = readText(path.join(componentRoot, "PackageInfo"), MAX_TEXT_BYTES, "PackageInfo");
    const parsedPackageInfo = parsePackageInfo(packageInfoText);
    if (
      parsedPackageInfo.identifier !== "com.formaspec.pkg" ||
      parsedPackageInfo.version !== packageMetadata.version ||
      parsedPackageInfo.installLocation !== "/" ||
      parsedPackageInfo.auth !== "root" ||
      parsedPackageInfo.scripts.join(",") !== "preinstall,postinstall"
    ) {
      throw new Error("PackageInfo does not match the FormaSpec unsigned installer contract.");
    }
    const payloadScan = scanPackageTree(payloadRoot);
    const bomOutput = run("/usr/bin/lsbom", ["-s", path.join(componentRoot, "Bom")]).stdout;
    const bomPaths = parseBomPaths(bomOutput);
    const appleDoubleBomPaths = [...bomPaths].filter(isAppleDoublePath).sort(compareText);
    const contentBomPaths = new Set([...bomPaths].filter((entry) => !isAppleDoublePath(entry)));
    comparePathSets(contentBomPaths, payloadScan.paths, "Installer BOM content entries");
    if (parsedPackageInfo.numberOfFiles !== bomPaths.size) {
      throw new Error("PackageInfo file count does not match the installer BOM.");
    }
    const bomPathSetSha256 = sha256(`${[...bomPaths].sort(compareText).join("\n")}\n`);

    const installManifestPath = path.join(payloadRoot, ...`${INSTALL_ROOT}/install-manifest.json`.split("/"));
    const { value: installManifestValue } = readJson(installManifestPath, MAX_TEXT_BYTES, "Install manifest");
    const installManifest = assertObject(installManifestValue, "Install manifest");
    const expectedManifest = {
      format: "formaspec-native-install",
      version: 1,
      productVersion: packageMetadata.version,
      platform: "macos",
      architecture: packageMetadata.architecture,
      managedBy: "formaspec",
      signed: false,
    };
    if (deterministicJson(installManifest) !== deterministicJson(expectedManifest)) {
      throw new Error("Install manifest does not exactly match the unsigned macOS artifact.");
    }
    const appInfoPath = path.join(payloadRoot, "Applications", "FormaSpec.app", "Contents", "Info.plist");
    if (
      plistValue(appInfoPath, "CFBundleIdentifier") !== "com.formaspec.app" ||
      plistValue(appInfoPath, "CFBundleShortVersionString") !== packageMetadata.version
    ) {
      throw new Error("FormaSpec application bundle identity/version is invalid.");
    }

    const workspaceTreeVerification = verifyPackagedWorkspaceTrees(
      resolvedWorkspaceRoot,
      payloadRoot,
    );
    const packagedComponents = scanPackagedNpmComponents(payloadRoot, sourceEvidence);
    const runtimeInventory = inspectPackagedRuntimes(payloadRoot, payloadScan, policy, packageMetadata.architecture);
    const scriptScan = scanPackageTree(scriptsRoot);
    const installerScripts = ["preinstall", "postinstall"].map((name) => keyFile(scriptScan, name));
    const keyFiles = requiredKeyFiles(payloadScan);
    return buildMacPackageEvidence({
      artifact: {
        filename: path.basename(resolvedPackage),
        sha256: artifactHash.sha256,
        size: artifactHash.size,
        checksumSidecar: `${path.basename(resolvedPackage)}.sha256`,
        checksumSidecarStatus: "pass",
        version: packageMetadata.version,
        architecture: packageMetadata.architecture,
        signed: false,
      },
      signature,
      packageMetadata: {
        identifier: parsedPackageInfo.identifier,
        version: parsedPackageInfo.version,
        installLocation: parsedPackageInfo.installLocation,
        auth: parsedPackageInfo.auth,
        generatorVersion: parsedPackageInfo.generatorVersion,
        installKBytes: parsedPackageInfo.installKBytes,
        componentFilename: components[0],
      },
      payload: {
        ...payloadScan,
        bomPathCount: bomPaths.size,
        bomPathSetSha256,
        appleDoubleEntryCount: appleDoubleBomPaths.length,
        extractedAppleDoubleEntryCount: payloadScan.appleDoubleEntryCount,
      },
      installerScripts,
      keyFiles,
      sourceEvidence,
      packagedComponents,
      workspaceTreeVerification,
      runtimeInventory,
    });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
