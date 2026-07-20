import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export const RELEASE_EVIDENCE_FORMAT_VERSION = 1;
export const RELEASE_EVIDENCE_FILES = Object.freeze([
  "formaspec.cdx.json",
  "licenses.json",
  "SHA256SUMS",
]);

const MAX_JSON_BYTES = 128 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_LICENSE_FILE_BYTES = 4 * 1024 * 1024;
const MAX_PACKAGES = 100_000;
const DEPENDENCY_GROUPS = Object.freeze([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "unsavedDependencies",
]);
const LICENSE_FILE_PATTERN = /^(?:licen[sc]e|copying|notice|third[-_ ]party)(?:[._ -].*)?$/i;

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertPlainObject(value, label) {
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

function sortedUniqueStrings(values, label) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !value)) {
    throw new Error(`${label} must contain non-empty strings.`);
  }
  const sorted = [...new Set(values)].sort(compareText);
  if (sorted.length !== values.length || sorted.some((value, index) => value !== values[index])) {
    throw new Error(`${label} must be sorted and contain no duplicates.`);
  }
  return sorted;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sortJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, child]) => [key, sortJsonValue(child)]),
    );
  }
  return value;
}

export function deterministicJson(value) {
  return `${JSON.stringify(sortJsonValue(value), null, 2)}\n`;
}

function readBoundedFile(filePath, maximumBytes, label) {
  const metadata = lstatSync(filePath, { bigint: true });
  if (metadata.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink.`);
  }
  if (!metadata.isFile()) {
    throw new Error(`${label} is not a regular file.`);
  }
  if (metadata.size > BigInt(maximumBytes)) {
    throw new Error(`${label} exceeds ${maximumBytes} bytes.`);
  }
  return readFileSync(filePath);
}

function readJsonFile(filePath, maximumBytes, label) {
  const bytes = readBoundedFile(filePath, maximumBytes, label);
  try {
    return { bytes, value: JSON.parse(bytes.toString("utf8")) };
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isPathInside(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function normalizeRelativePath(rootDir, filePath) {
  const relative = path.relative(rootDir, filePath).split(path.sep).join("/");
  if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new Error(`Evidence input must be inside the repository: ${filePath}`);
  }
  return relative;
}

function packageKey(name, version) {
  return `${name}\u0000${version}`;
}

export function npmPurl(name, version) {
  assertString(name, "Package name");
  assertString(version, "Package version");
  if (name.startsWith("@")) {
    const slash = name.indexOf("/");
    if (slash <= 1 || slash === name.length - 1) {
      throw new Error(`Invalid scoped npm package name: ${name}`);
    }
    return `pkg:npm/${encodeURIComponent(name.slice(0, slash))}/${encodeURIComponent(name.slice(slash + 1))}@${encodeURIComponent(version)}`;
  }
  return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}

function splitNpmName(name) {
  if (!name.startsWith("@")) {
    return { name };
  }
  const slash = name.indexOf("/");
  return { group: name.slice(0, slash), name: name.slice(slash + 1) };
}

function unquoteYamlScalar(value) {
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    return JSON.parse(value);
  }
  return value;
}

function parseLockPackageKey(rawKey) {
  const key = unquoteYamlScalar(rawKey);
  const separator = key.lastIndexOf("@");
  if (separator <= 0 || separator === key.length - 1) {
    throw new Error(`Unsupported pnpm lock package key: ${key}`);
  }
  const name = key.slice(0, separator);
  const version = key.slice(separator + 1);
  if (!name || !version || version.includes("(")) {
    throw new Error(`Unsupported pnpm lock package key: ${key}`);
  }
  return { name, version };
}

export function parsePnpmLockPackages(lockText) {
  if (typeof lockText !== "string" || !lockText.startsWith("lockfileVersion:")) {
    throw new Error("pnpm-lock.yaml is missing a supported lockfile header.");
  }

  const packages = new Map();
  let inPackages = false;
  let current;
  for (const line of lockText.split(/\r?\n/u)) {
    if (line === "packages:") {
      inPackages = true;
      current = undefined;
      continue;
    }
    if (!inPackages) {
      continue;
    }
    if (/^[A-Za-z][A-Za-z0-9_-]*:/u.test(line)) {
      break;
    }

    const packageMatch = /^  (\S.*):\s*$/u.exec(line);
    if (packageMatch) {
      const parsed = parseLockPackageKey(packageMatch[1]);
      const key = packageKey(parsed.name, parsed.version);
      if (packages.has(key)) {
        throw new Error(`Duplicate pnpm lock package: ${parsed.name}@${parsed.version}`);
      }
      current = { ...parsed };
      packages.set(key, current);
      if (packages.size > MAX_PACKAGES) {
        throw new Error(`pnpm lock package count exceeds ${MAX_PACKAGES}.`);
      }
      continue;
    }

    if (current) {
      const integrityMatch = /\bintegrity:\s*([A-Za-z0-9+/_=-]+)/u.exec(line);
      if (integrityMatch) {
        current.integrity = integrityMatch[1];
      }
    }
  }

  if (packages.size === 0) {
    throw new Error("pnpm-lock.yaml contains no package records.");
  }
  return packages;
}

function integrityToCycloneDxHash(integrity, label) {
  const match = /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/u.exec(assertString(integrity, `${label} integrity`));
  if (!match) {
    throw new Error(`${label} has an unsupported integrity value.`);
  }
  const algorithm = match[1].toUpperCase().replace("SHA", "SHA-");
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length * 8 !== Number(match[1].slice(3))) {
    throw new Error(`${label} has a malformed integrity digest.`);
  }
  return { alg: algorithm, content: bytes.toString("hex") };
}

export function validateLicensePolicy(input) {
  const policy = assertPlainObject(input, "License policy");
  if (policy.schemaVersion !== 1 || policy.mode !== "permissive-only") {
    throw new Error("License policy must use schemaVersion 1 and mode permissive-only.");
  }
  const allowedLicenseIds = sortedUniqueStrings(policy.allowedLicenseIds, "allowedLicenseIds");
  const allowedExpressions = sortedUniqueStrings(policy.allowedExpressions, "allowedExpressions");
  const forbiddenLicensePrefixes = sortedUniqueStrings(
    policy.forbiddenLicensePrefixes,
    "forbiddenLicensePrefixes",
  );
  for (const expression of allowedExpressions) {
    const identifiers = expression.match(/[A-Za-z0-9][A-Za-z0-9.+-]*/gu) ?? [];
    const licenseIdentifiers = identifiers.filter((identifier) => !["AND", "OR", "WITH"].includes(identifier));
    if (licenseIdentifiers.length === 0 || licenseIdentifiers.some((identifier) => !allowedLicenseIds.includes(identifier))) {
      throw new Error(`Allowed expression contains an unapproved identifier: ${expression}`);
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    mode: "permissive-only",
    allowedLicenseIds,
    allowedExpressions,
    forbiddenLicensePrefixes,
  });
}

function normalizeLicenseExpression(value) {
  return assertString(value, "License expression").trim().replace(/\s+/gu, " ");
}

export function evaluateLicense(expressionValue, policyValue) {
  const policy = validateLicensePolicy(policyValue);
  const expression = normalizeLicenseExpression(expressionValue);
  if (policy.allowedLicenseIds.includes(expression) || policy.allowedExpressions.includes(expression)) {
    return { allowed: true, reason: "allowlisted" };
  }
  const identifiers = expression.match(/[A-Za-z0-9][A-Za-z0-9.+-]*/gu) ?? [];
  const forbidden = identifiers.find((identifier) =>
    policy.forbiddenLicensePrefixes.some((prefix) => identifier.startsWith(prefix)),
  );
  if (forbidden) {
    return { allowed: false, reason: "forbidden-license", identifier: forbidden };
  }
  return { allowed: false, reason: "not-allowlisted" };
}

export function normalizePnpmLicenseReport(reportValue) {
  const report = assertPlainObject(reportValue, "pnpm license report");
  const packages = new Map();
  for (const [licenseValue, entriesValue] of Object.entries(report).sort(([left], [right]) => compareText(left, right))) {
    const license = normalizeLicenseExpression(licenseValue);
    if (!Array.isArray(entriesValue)) {
      throw new Error(`pnpm license group ${license} must be an array.`);
    }
    for (const entryValue of entriesValue) {
      const entry = assertPlainObject(entryValue, `pnpm license entry for ${license}`);
      const name = assertString(entry.name, "pnpm package name");
      if (!Array.isArray(entry.versions) || entry.versions.length === 0) {
        throw new Error(`pnpm package ${name} has no versions.`);
      }
      const paths = Array.isArray(entry.paths)
        ? [...new Set(entry.paths.map((candidate) => assertString(candidate, `${name} package path`)))].sort(compareText)
        : [];
      for (const versionValue of entry.versions) {
        const version = assertString(versionValue, `${name} version`);
        const key = packageKey(name, version);
        const existing = packages.get(key);
        if (existing && existing.license !== license) {
          throw new Error(`${name}@${version} declares conflicting licenses: ${existing.license} and ${license}.`);
        }
        packages.set(key, { name, version, license, paths: [...new Set([...(existing?.paths ?? []), ...paths])].sort(compareText) });
        if (packages.size > MAX_PACKAGES) {
          throw new Error(`Installed package count exceeds ${MAX_PACKAGES}.`);
        }
      }
    }
  }
  return packages;
}

export function mergePnpmLicenseReports(allValue, productionValue, developmentValue, inferredScopes = new Map()) {
  const all = normalizePnpmLicenseReport(allValue);
  const production = normalizePnpmLicenseReport(productionValue);
  const development = normalizePnpmLicenseReport(developmentValue);

  for (const [scope, report] of [
    ["production", production],
    ["development", development],
  ]) {
    for (const [key, entry] of report) {
      const canonical = all.get(key);
      if (!canonical || canonical.license !== entry.license) {
        throw new Error(`${entry.name}@${entry.version} has inconsistent ${scope} license evidence.`);
      }
    }
  }

  return [...all.entries()]
    .map(([key, entry]) => {
      const scopes = [];
      if (development.has(key)) scopes.push("development");
      if (production.has(key)) scopes.push("production");
      for (const scope of inferredScopes.get(key) ?? []) {
        if (!scopes.includes(scope)) scopes.push(scope);
      }
      scopes.sort(compareText);
      if (scopes.length === 0) scopes.push("unclassified");
      return { ...entry, scopes };
    })
    .sort((left, right) => compareText(npmPurl(left.name, left.version), npmPurl(right.name, right.version)));
}

function manifestLicenseExpression(manifest) {
  if (typeof manifest.license === "string") {
    return normalizeLicenseExpression(manifest.license);
  }
  if (manifest.license && typeof manifest.license === "object" && typeof manifest.license.type === "string") {
    return normalizeLicenseExpression(manifest.license.type);
  }
  if (Array.isArray(manifest.licenses)) {
    const values = manifest.licenses
      .map((license) => (typeof license === "string" ? license : license?.type))
      .filter((license) => typeof license === "string")
      .map(normalizeLicenseExpression);
    if (values.length > 0) return values.join(" OR ");
  }
  return undefined;
}

export function collectPackageLicenseEvidence(rootDir, packageEntry) {
  const nodeModulesRoot = realpathSync(path.join(rootDir, "node_modules"));
  const manifestHashes = new Set();
  const licenseFiles = new Map();
  let matchingManifestCount = 0;

  for (const candidate of packageEntry.paths) {
    if (!existsSync(candidate)) continue;
    const resolvedDirectory = realpathSync(candidate);
    if (!isPathInside(nodeModulesRoot, resolvedDirectory)) {
      throw new Error(`${packageEntry.name}@${packageEntry.version} resolves outside node_modules.`);
    }
    const manifestPath = path.join(resolvedDirectory, "package.json");
    if (!existsSync(manifestPath)) continue;
    const { bytes, value } = readJsonFile(
      manifestPath,
      MAX_MANIFEST_BYTES,
      `${packageEntry.name}@${packageEntry.version} package manifest`,
    );
    const manifest = assertPlainObject(value, `${packageEntry.name}@${packageEntry.version} package manifest`);
    if (manifest.name !== packageEntry.name || manifest.version !== packageEntry.version) continue;
    matchingManifestCount += 1;
    const declaredLicense = manifestLicenseExpression(manifest);
    if (declaredLicense !== packageEntry.license) {
      throw new Error(
        `${packageEntry.name}@${packageEntry.version} manifest license ${declaredLicense ?? "<missing>"} does not match pnpm evidence ${packageEntry.license}.`,
      );
    }
    manifestHashes.add(sha256(bytes));

    for (const directoryEntry of readdirSync(resolvedDirectory, { withFileTypes: true })) {
      if (!LICENSE_FILE_PATTERN.test(directoryEntry.name)) continue;
      if (directoryEntry.isSymbolicLink()) {
        throw new Error(`${packageEntry.name}@${packageEntry.version} has a symlinked ${directoryEntry.name}.`);
      }
      if (!directoryEntry.isFile()) continue;
      const licensePath = path.join(resolvedDirectory, directoryEntry.name);
      const licenseBytes = readBoundedFile(
        licensePath,
        MAX_LICENSE_FILE_BYTES,
        `${packageEntry.name}@${packageEntry.version} ${directoryEntry.name}`,
      );
      const digest = sha256(licenseBytes);
      const existing = licenseFiles.get(directoryEntry.name);
      if (existing && existing !== digest) {
        throw new Error(`${packageEntry.name}@${packageEntry.version} has conflicting ${directoryEntry.name} files.`);
      }
      licenseFiles.set(directoryEntry.name, digest);
    }
  }

  if (matchingManifestCount === 0) {
    throw new Error(`${packageEntry.name}@${packageEntry.version} has no installed manifest evidence.`);
  }
  if (manifestHashes.size !== 1) {
    throw new Error(`${packageEntry.name}@${packageEntry.version} has inconsistent installed manifests.`);
  }
  return {
    ...packageEntry,
    packageManifestSha256: [...manifestHashes][0],
    licenseEvidence: [...licenseFiles.entries()]
      .map(([file, digest]) => ({ file, sha256: digest }))
      .sort((left, right) => compareText(left.file, right.file)),
  };
}

export function readWorkspaceManifests(rootDir) {
  const manifestPaths = [path.join(rootDir, "package.json")];
  for (const parentName of ["apps", "packages"]) {
    const parentPath = path.join(rootDir, parentName);
    if (!existsSync(parentPath)) continue;
    for (const entry of readdirSync(parentPath, { withFileTypes: true }).sort((left, right) => compareText(left.name, right.name))) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(parentPath, entry.name, "package.json");
      if (existsSync(manifestPath) && lstatSync(manifestPath).isFile()) manifestPaths.push(manifestPath);
    }
  }

  const names = new Set();
  return manifestPaths.map((manifestPath) => {
    const { bytes, value } = readJsonFile(manifestPath, MAX_MANIFEST_BYTES, `${manifestPath} workspace manifest`);
    const manifest = assertPlainObject(value, `${manifestPath} workspace manifest`);
    const name = assertString(manifest.name, `${manifestPath} name`);
    const version = assertString(manifest.version, `${manifestPath} version`);
    if (names.has(name)) throw new Error(`Duplicate workspace package name: ${name}`);
    names.add(name);
    return {
      directory: path.dirname(manifestPath),
      relativePath: normalizeRelativePath(rootDir, manifestPath),
      name,
      version,
      private: manifest.private === true,
      sha256: sha256(bytes),
      manifest,
    };
  });
}

function licenseChoice(expression) {
  if (/^[A-Za-z0-9][A-Za-z0-9.+-]*$/u.test(expression)) {
    return { license: { id: expression } };
  }
  return { expression };
}

function workspaceComponent(workspace, type = "library") {
  return {
    "bom-ref": npmPurl(workspace.name, workspace.version),
    type,
    ...splitNpmName(workspace.name),
    version: workspace.version,
    purl: npmPurl(workspace.name, workspace.version),
    properties: [
      { name: "formaspec:first-party", value: "true" },
      { name: "formaspec:workspace:manifest", value: workspace.relativePath },
      { name: "formaspec:workspace:private", value: String(workspace.private) },
      { name: "formaspec:workspace:manifest-sha256", value: workspace.sha256 },
    ].sort((left, right) => compareText(left.name, right.name)),
  };
}

function dependencyGroupEntries(node) {
  return DEPENDENCY_GROUPS.flatMap((group) => {
    const value = node?.[group];
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    return Object.entries(value)
      .sort(([left], [right]) => compareText(left, right))
      .map(([name, child]) => ({ group, name, child }));
  });
}

function dependencyGroups(node) {
  return dependencyGroupEntries(node).map(({ name, child }) => [name, child]);
}

export function classifyPnpmDependencyScopes(dependencyList, installedKeys) {
  if (!Array.isArray(dependencyList)) throw new Error("pnpm dependency list must be an array.");
  const scopes = new Map();
  let visits = 0;

  function visit(name, nodeValue, scope, ancestors) {
    const node = assertPlainObject(nodeValue, `${name} dependency entry`);
    visits += 1;
    if (visits > MAX_PACKAGES * 20) throw new Error("pnpm dependency scope graph exceeds the traversal limit.");
    if (typeof node.version === "string") {
      const key = packageKey(name, node.version);
      if (installedKeys.has(key)) {
        const values = scopes.get(key) ?? new Set();
        values.add(scope);
        scopes.set(key, values);
        const cycleKey = `${key}\u0000${scope}`;
        if (ancestors.has(cycleKey)) return;
        ancestors = new Set([...ancestors, cycleKey]);
      }
    }
    for (const { name: childName, child } of dependencyGroupEntries(node)) {
      visit(childName, child, scope, ancestors);
    }
  }

  for (const rootValue of dependencyList) {
    const root = assertPlainObject(rootValue, "pnpm workspace dependency root");
    for (const { group, name, child } of dependencyGroupEntries(root)) {
      const scope = group === "devDependencies" ? "development" : "production";
      visit(name, child, scope, new Set());
    }
  }
  return scopes;
}

function assertWorkspaceListCoverage(rootDir, dependencyList, workspaces) {
  const expected = new Map(workspaces.map((workspace) => [path.resolve(workspace.directory), workspace]));
  const found = new Set();
  for (const rootValue of dependencyList) {
    const root = assertPlainObject(rootValue, "pnpm workspace dependency root");
    const rootPath = assertString(root.path, "pnpm workspace root path");
    const resolvedPath = path.resolve(rootPath);
    if (!isPathInside(rootDir, resolvedPath)) {
      throw new Error(`pnpm listed a workspace outside the repository: ${rootPath}`);
    }
    const workspace = expected.get(resolvedPath);
    if (!workspace || workspace.name !== root.name || workspace.version !== root.version) {
      throw new Error(`Workspace manifest discovery does not match pnpm at ${rootPath}.`);
    }
    found.add(resolvedPath);
  }
  if (found.size !== expected.size) {
    const missing = [...expected.entries()]
      .filter(([directory]) => !found.has(directory))
      .map(([, workspace]) => workspace.relativePath)
      .sort(compareText);
    throw new Error(`pnpm did not list every workspace manifest: ${missing.join(", ")}`);
  }
}

function buildDependencyGraph(dependencyList, workspaces, componentRefs) {
  const workspaceByDirectory = new Map(workspaces.map((workspace) => [path.resolve(workspace.directory), workspace]));
  const workspaceByNameVersion = new Map(
    workspaces.map((workspace) => [packageKey(workspace.name, workspace.version), workspace]),
  );
  const edges = new Map([...componentRefs].map((ref) => [ref, new Set()]));
  let visitedOccurrences = 0;

  function resolveRef(name, node) {
    if (node && typeof node.path === "string") {
      const workspace = workspaceByDirectory.get(path.resolve(node.path));
      if (workspace) return npmPurl(workspace.name, workspace.version);
    }
    if (node && typeof node.version === "string") {
      const workspace = workspaceByNameVersion.get(packageKey(name, node.version));
      if (workspace) return npmPurl(workspace.name, workspace.version);
      const candidate = npmPurl(name, node.version);
      if (componentRefs.has(candidate)) return candidate;
    }
    return undefined;
  }

  function visit(ref, node, ancestors) {
    visitedOccurrences += 1;
    if (visitedOccurrences > MAX_PACKAGES * 20) {
      throw new Error("pnpm dependency graph exceeds the traversal limit.");
    }
    const children = edges.get(ref) ?? new Set();
    edges.set(ref, children);
    for (const [name, childValue] of dependencyGroups(node)) {
      const child = assertPlainObject(childValue, `${name} dependency entry`);
      const childRef = resolveRef(name, child);
      if (!childRef) continue;
      children.add(childRef);
      if (!ancestors.has(childRef)) {
        visit(childRef, child, new Set([...ancestors, childRef]));
      }
    }
  }

  if (!Array.isArray(dependencyList)) {
    throw new Error("pnpm dependency list must be an array.");
  }
  for (const rootValue of dependencyList) {
    const root = assertPlainObject(rootValue, "pnpm workspace dependency root");
    const name = assertString(root.name, "pnpm workspace root name");
    const version = assertString(root.version, `${name} workspace version`);
    const ref = npmPurl(name, version);
    if (componentRefs.has(ref)) visit(ref, root, new Set([ref]));
  }

  return [...edges.entries()]
    .map(([ref, children]) => ({ ref, dependsOn: [...children].sort(compareText) }))
    .sort((left, right) => compareText(left.ref, right.ref));
}

export function buildReleaseEvidence(input) {
  const policy = validateLicensePolicy(input.policy);
  const rootWorkspace = input.workspaces.find((workspace) => workspace.relativePath === "package.json");
  if (!rootWorkspace) throw new Error("Root workspace manifest is missing.");
  const lockPackages = input.lockPackages;
  if (!(lockPackages instanceof Map)) throw new Error("lockPackages must be a Map.");

  const packages = input.packages.map((packageEntry) => {
    const lockEntry = lockPackages.get(packageKey(packageEntry.name, packageEntry.version));
    if (!lockEntry?.integrity) {
      throw new Error(`${packageEntry.name}@${packageEntry.version} has no lockfile integrity.`);
    }
    const evaluation = packageEntry.scopes.includes("unclassified")
      ? { allowed: false, reason: "unclassified-scope" }
      : evaluateLicense(packageEntry.license, policy);
    const purl = npmPurl(packageEntry.name, packageEntry.version);
    return {
      name: packageEntry.name,
      version: packageEntry.version,
      purl,
      license: packageEntry.license,
      scopes: [...packageEntry.scopes].sort(compareText),
      integrity: lockEntry.integrity,
      packageManifestSha256: packageEntry.packageManifestSha256,
      licenseEvidence: packageEntry.licenseEvidence,
      policyStatus: evaluation.allowed ? "allowed" : "denied",
      policyReason: evaluation.reason,
      policyIdentifier: evaluation.identifier,
    };
  }).sort((left, right) => compareText(left.purl, right.purl));

  const violations = packages
    .filter((packageEntry) => packageEntry.policyStatus !== "allowed")
    .map((packageEntry) => ({
      name: packageEntry.name,
      version: packageEntry.version,
      purl: packageEntry.purl,
      license: packageEntry.license,
      scopes: packageEntry.scopes,
      reason: packageEntry.policyReason,
      ...(packageEntry.policyIdentifier ? { identifier: packageEntry.policyIdentifier } : {}),
    }));

  const thirdPartyComponents = packages.map((packageEntry) => ({
    "bom-ref": packageEntry.purl,
    type: "library",
    ...splitNpmName(packageEntry.name),
    version: packageEntry.version,
    purl: packageEntry.purl,
    scope: packageEntry.scopes.includes("production") ? "required" : "optional",
    hashes: [integrityToCycloneDxHash(packageEntry.integrity, `${packageEntry.name}@${packageEntry.version}`)],
    licenses: [licenseChoice(packageEntry.license)],
    properties: [
      { name: "formaspec:dependency:scope", value: packageEntry.scopes.join(",") },
      { name: "formaspec:evidence:package-manifest-sha256", value: packageEntry.packageManifestSha256 },
      { name: "formaspec:license:policy-status", value: packageEntry.policyStatus },
    ].sort((left, right) => compareText(left.name, right.name)),
  }));

  const workspaceComponents = input.workspaces
    .filter((workspace) => workspace !== rootWorkspace)
    .map((workspace) => workspaceComponent(workspace))
    .sort((left, right) => compareText(left["bom-ref"], right["bom-ref"]));
  const rootComponent = workspaceComponent(rootWorkspace, "application");
  const components = [...workspaceComponents, ...thirdPartyComponents].sort((left, right) =>
    compareText(left["bom-ref"], right["bom-ref"]),
  );
  const componentRefs = new Set([rootComponent["bom-ref"], ...components.map((component) => component["bom-ref"])]);
  const dependencies = buildDependencyGraph(input.dependencyList, input.workspaces, componentRefs);
  const manifestRecords = input.workspaces
    .map((workspace) => ({ path: workspace.relativePath, sha256: workspace.sha256 }))
    .sort((left, right) => compareText(left.path, right.path));
  const manifestSetSha256 = sha256(deterministicJson(manifestRecords));
  const policyStatus = violations.length === 0 ? "pass" : "fail";

  const bom = {
    $schema: "https://cyclonedx.org/schema/bom-1.6.schema.json",
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      component: rootComponent,
      tools: {
        components: [
          {
            type: "application",
            name: "formaspec-release-evidence",
            version: String(RELEASE_EVIDENCE_FORMAT_VERSION),
          },
        ],
      },
      properties: [
        { name: "formaspec:evidence:deterministic", value: "true" },
        { name: "formaspec:evidence:target", value: input.target },
        { name: "formaspec:license:policy-sha256", value: input.policySha256 },
        { name: "formaspec:license:policy-status", value: policyStatus },
        { name: "formaspec:pnpm-lock:sha256", value: input.lockfileSha256 },
        { name: "formaspec:workspace-manifests:sha256", value: manifestSetSha256 },
      ].sort((left, right) => compareText(left.name, right.name)),
    },
    components,
    dependencies,
  };

  const licenseReport = {
    schemaVersion: RELEASE_EVIDENCE_FORMAT_VERSION,
    format: "formaspec-license-evidence",
    target: input.target,
    packageManager: input.packageManager,
    inputs: {
      lockfile: { path: "pnpm-lock.yaml", sha256: input.lockfileSha256 },
      manifests: manifestRecords,
      manifestSetSha256,
      policy: { path: input.policyRelativePath, sha256: input.policySha256 },
    },
    policy: {
      mode: policy.mode,
      status: policyStatus,
      allowedLicenseIds: policy.allowedLicenseIds,
      allowedExpressions: policy.allowedExpressions,
      forbiddenLicensePrefixes: policy.forbiddenLicensePrefixes,
    },
    summary: {
      workspaceComponentCount: input.workspaces.length,
      installedThirdPartyComponentCount: packages.length,
      lockfilePackageCount: lockPackages.size,
      allowedComponentCount: packages.length - violations.length,
      deniedComponentCount: violations.length,
      productionViolationCount: violations.filter((violation) => violation.scopes.includes("production")).length,
      developmentViolationCount: violations.filter((violation) => violation.scopes.includes("development")).length,
    },
    packages: packages.map((packageEntry) => ({
      name: packageEntry.name,
      version: packageEntry.version,
      purl: packageEntry.purl,
      license: packageEntry.license,
      scopes: packageEntry.scopes,
      integrity: packageEntry.integrity,
      packageManifestSha256: packageEntry.packageManifestSha256,
      licenseEvidence: packageEntry.licenseEvidence,
      policyStatus: packageEntry.policyStatus,
      policyReason: packageEntry.policyReason,
      ...(packageEntry.policyIdentifier ? { policyIdentifier: packageEntry.policyIdentifier } : {}),
    })),
    violations,
    limitations: [
      "This evidence covers the installed pnpm workspace for one explicit target; each native installer and container image requires artifact-specific SBOM and license evidence.",
      "License metadata and hashed notice files are inventory evidence, not legal advice or vulnerability scanning.",
    ],
  };

  return { bom, licenseReport };
}

export function renderReleaseEvidence(evidence) {
  const files = new Map([
    ["formaspec.cdx.json", deterministicJson(evidence.bom)],
    ["licenses.json", deterministicJson(evidence.licenseReport)],
  ]);
  const checksumLines = [...files.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([name, contents]) => `${sha256(contents)}  ${name}`);
  files.set("SHA256SUMS", `${checksumLines.join("\n")}\n`);
  return files;
}

function assertSafeEvidenceDirectory(outputDir) {
  if (existsSync(outputDir)) {
    const metadata = lstatSync(outputDir);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("Release evidence output must be a real directory, not a symlink.");
    }
  }
}

export function writeReleaseEvidence(outputDir, files) {
  assertSafeEvidenceDirectory(outputDir);
  mkdirSync(outputDir, { recursive: true, mode: 0o755 });
  for (const name of RELEASE_EVIDENCE_FILES) {
    const contents = files.get(name);
    if (typeof contents !== "string") throw new Error(`Missing generated evidence file: ${name}`);
    const destination = path.join(outputDir, name);
    if (existsSync(destination) && lstatSync(destination).isSymbolicLink()) {
      throw new Error(`Refusing to replace symlinked evidence file: ${name}`);
    }
    const temporary = path.join(outputDir, `.${name}.${process.pid}.tmp`);
    try {
      writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
      chmodSync(temporary, 0o644);
      renameSync(temporary, destination);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}

export function verifyReleaseEvidence(outputDir, expectedFiles) {
  const differences = [];
  for (const name of RELEASE_EVIDENCE_FILES) {
    const expected = expectedFiles.get(name);
    const filePath = path.join(outputDir, name);
    if (!existsSync(filePath)) {
      differences.push(`${name} is missing`);
      continue;
    }
    if (lstatSync(filePath).isSymbolicLink()) {
      differences.push(`${name} is a symlink`);
      continue;
    }
    const actual = readBoundedFile(filePath, MAX_JSON_BYTES, name).toString("utf8");
    if (actual !== expected) differences.push(`${name} does not match current lock/manifests/policy`);
  }
  return differences;
}

function runPnpm(rootDir, args) {
  const npmExecPath = process.env.npm_execpath;
  const usePinnedExecPath = npmExecPath && /(?:^|[/\\])pnpm(?:\.c?js|\.mjs)?$/iu.test(npmExecPath);
  const command = usePinnedExecPath ? process.execPath : "pnpm";
  const commandArgs = usePinnedExecPath ? [npmExecPath, ...args] : args;
  try {
    return execFileSync(command, commandArgs, {
      cwd: rootDir,
      encoding: "utf8",
      maxBuffer: MAX_JSON_BYTES,
      timeout: 120_000,
      env: {
        ...process.env,
        CI: "1",
        NO_UPDATE_NOTIFIER: "1",
        npm_config_offline: "true",
        pnpm_config_update_notifier: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr).slice(0, 4_096) : "";
    throw new Error(`pnpm ${args.join(" ")} failed${stderr ? `: ${stderr}` : "."}`);
  }
}

function runPnpmJson(rootDir, args) {
  const output = runPnpm(rootDir, args);
  if (Buffer.byteLength(output, "utf8") > MAX_JSON_BYTES) {
    throw new Error(`pnpm ${args.join(" ")} output exceeds ${MAX_JSON_BYTES} bytes.`);
  }
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`pnpm ${args.join(" ")} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function collectRepositoryReleaseEvidence({
  rootDir,
  policyPath = path.join(rootDir, "release", "license-policy.json"),
  target = `${process.platform}-${process.arch}`,
}) {
  const resolvedRoot = realpathSync(rootDir);
  const lockfilePath = path.join(resolvedRoot, "pnpm-lock.yaml");
  const lockfileBytes = readBoundedFile(lockfilePath, MAX_JSON_BYTES, "pnpm-lock.yaml");
  const installedLockfilePath = path.join(resolvedRoot, "node_modules", ".pnpm", "lock.yaml");
  if (!existsSync(installedLockfilePath)) {
    throw new Error("node_modules is not installed; run pnpm install --frozen-lockfile first.");
  }
  const installedLockfileBytes = readBoundedFile(installedLockfilePath, MAX_JSON_BYTES, "installed pnpm lockfile");
  if (!lockfileBytes.equals(installedLockfileBytes)) {
    throw new Error("Installed dependencies do not match pnpm-lock.yaml; run pnpm install --frozen-lockfile.");
  }

  const workspaces = readWorkspaceManifests(resolvedRoot);
  const rootWorkspace = workspaces.find((workspace) => workspace.relativePath === "package.json");
  const packageManager = assertString(rootWorkspace?.manifest.packageManager, "Root packageManager");
  const packageManagerMatch = /^pnpm@(\d+\.\d+\.\d+)$/u.exec(packageManager);
  if (!packageManagerMatch) throw new Error("Root packageManager must pin an exact pnpm version.");
  const actualPnpmVersion = runPnpm(resolvedRoot, ["--version"]).trim();
  if (actualPnpmVersion !== packageManagerMatch[1]) {
    throw new Error(`Expected ${packageManager}, but pnpm ${actualPnpmVersion} is running.`);
  }

  const policyResolvedPath = realpathSync(policyPath);
  if (!isPathInside(resolvedRoot, policyResolvedPath)) {
    throw new Error("License policy must be stored inside the repository.");
  }
  const { bytes: policyBytes, value: policyValue } = readJsonFile(
    policyResolvedPath,
    MAX_MANIFEST_BYTES,
    "License policy",
  );
  const policy = validateLicensePolicy(policyValue);
  const lockPackages = parsePnpmLockPackages(lockfileBytes.toString("utf8"));
  const allLicenses = runPnpmJson(resolvedRoot, ["licenses", "list", "--json"]);
  const installedKeys = new Set(normalizePnpmLicenseReport(allLicenses).keys());
  const dependencyList = runPnpmJson(resolvedRoot, ["list", "--recursive", "--depth", "Infinity", "--json"]);
  assertWorkspaceListCoverage(resolvedRoot, dependencyList, workspaces);
  const inferredScopes = classifyPnpmDependencyScopes(dependencyList, installedKeys);
  const packageEntries = mergePnpmLicenseReports(
    allLicenses,
    runPnpmJson(resolvedRoot, ["licenses", "list", "--prod", "--json"]),
    runPnpmJson(resolvedRoot, ["licenses", "list", "--dev", "--json"]),
    inferredScopes,
  ).map((packageEntry) => collectPackageLicenseEvidence(resolvedRoot, packageEntry));

  return buildReleaseEvidence({
    target,
    packageManager,
    lockfileSha256: sha256(lockfileBytes),
    policy,
    policySha256: sha256(policyBytes),
    policyRelativePath: normalizeRelativePath(resolvedRoot, policyResolvedPath),
    lockPackages,
    workspaces,
    packages: packageEntries,
    dependencyList,
  });
}
