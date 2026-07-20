import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type RepositoryPlatform = "web" | "android" | "ios" | "flutter" | "react-native" | "generic-git";
export type InventoryEntityKind = "component" | "screen" | "route" | "token" | "asset" | "flow" | "business-rule";

export interface InventoryLimits {
  maximumFiles: number;
  maximumTotalBytesRead: number;
  maximumFileBytes: number;
  maximumEntities: number;
  maximumFingerprintBytes: number;
}

export interface LocalInventoryEntity {
  id: string;
  kind: InventoryEntityKind;
  name: string;
  symbol: string | null;
  relativePath: string;
  locationId: string;
  line: number | null;
}

export interface LocalRepositoryInventory {
  schemaVersion: 1;
  repositoryFingerprint: string;
  generatedAt: string;
  platforms: RepositoryPlatform[];
  gitHead: string | null;
  excludedPatterns: string[];
  scannedFileCount: number;
  skippedFileCount: number;
  bytesRead: number;
  truncated: boolean;
  entities: LocalInventoryEntity[];
  excluded: Array<{ category: "secret" | "generated" | "policy" | "symlink" | "limit"; count: number }>;
}

export interface UploadRepositoryInventory extends Omit<LocalRepositoryInventory, "entities"> {
  entities: Array<Omit<LocalInventoryEntity, "relativePath">>;
}

const DEFAULT_LIMITS: InventoryLimits = {
  maximumFiles: 20_000,
  maximumTotalBytesRead: 32 * 1024 * 1024,
  maximumFileBytes: 512 * 1024,
  maximumEntities: 50_000,
  maximumFingerprintBytes: 512 * 1024 * 1024,
};

const GENERATED_DIRECTORIES = new Set([
  ".git", ".gradle", ".idea", ".next", ".nuxt", ".turbo", ".vite", ".vscode",
  "Pods", "DerivedData", "build", "coverage", "dist", "node_modules", "out", "target", "vendor",
]);

const SECRET_BASENAMES = new Set([
  ".env", ".env.local", ".env.production", ".npmrc", ".pypirc", "credentials", "credentials.json",
  "google-services.json", "GoogleService-Info.plist", "id_dsa", "id_ecdsa", "id_ed25519", "id_rsa",
  "local.properties", "secrets.json", "secrets.yaml", "secrets.yml",
]);

const SECRET_EXTENSIONS = new Set([".jks", ".key", ".keystore", ".p12", ".pem", ".pfx"]);
const SOURCE_EXTENSIONS = new Set([".css", ".dart", ".gradle", ".html", ".java", ".js", ".jsx", ".kt", ".kts", ".m", ".mm", ".scss", ".swift", ".ts", ".tsx", ".vue", ".xml"]);
const ASSET_EXTENSIONS = new Set([".avif", ".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"]);
const MAXIMUM_EXCLUDED_PATTERNS = 100;
const MAXIMUM_EXCLUDED_PATTERN_LENGTH = 240;
const MAXIMUM_PACKAGE_JSON_BYTES = 1024 * 1024;
const MAXIMUM_GIT_POINTER_BYTES = 16 * 1024;
const MAXIMUM_PACKED_REFS_BYTES = 4 * 1024 * 1024;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(filename: string, expected: fs.Stats): Promise<string> {
  const noFollow = process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW;
  const handle = await fs.promises.open(filename, fs.constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (!opened.isFile()
      || opened.dev !== expected.dev
      || opened.ino !== expected.ino
      || opened.size !== expected.size
      || opened.mtimeMs !== expected.mtimeMs
      || opened.ctimeMs !== expected.ctimeMs) {
      throw new Error("Repository contents changed while the inventory fingerprint was being computed; retry authorization.");
    }
    const hash = createHash("sha256");
    const stream = handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 });
    for await (const chunk of stream) hash.update(chunk as Buffer);
    const afterRead = await handle.stat();
    const current = await fs.promises.lstat(filename);
    if (!current.isFile() || current.isSymbolicLink()
      || afterRead.dev !== opened.dev || afterRead.ino !== opened.ino
      || afterRead.size !== opened.size || afterRead.mtimeMs !== opened.mtimeMs || afterRead.ctimeMs !== opened.ctimeMs
      || current.dev !== opened.dev || current.ino !== opened.ino
      || current.size !== opened.size || current.mtimeMs !== opened.mtimeMs || current.ctimeMs !== opened.ctimeMs) {
      throw new Error("Repository contents changed while the inventory fingerprint was being computed; retry authorization.");
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function readVerifiedSourceFile(filename: string, expected: fs.Stats, expectedHash: string): Promise<Buffer> {
  const noFollow = process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW;
  const handle = await fs.promises.open(filename, fs.constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino || opened.size !== expected.size) {
      throw new Error("Repository contents changed while source symbols were being inspected; retry authorization.");
    }
    const contents = await handle.readFile();
    const afterRead = await handle.stat();
    const current = await fs.promises.lstat(filename);
    if (sha256(contents) !== expectedHash
      || afterRead.dev !== opened.dev || afterRead.ino !== opened.ino
      || afterRead.size !== opened.size || afterRead.mtimeMs !== opened.mtimeMs || afterRead.ctimeMs !== opened.ctimeMs
      || !current.isFile() || current.isSymbolicLink()
      || current.dev !== opened.dev || current.ino !== opened.ino
      || current.size !== opened.size || current.mtimeMs !== opened.mtimeMs || current.ctimeMs !== opened.ctimeMs) {
      throw new Error("Repository contents changed while source symbols were being inspected; retry authorization.");
    }
    return contents;
  } finally {
    await handle.close();
  }
}

async function readBoundedMetadataFile(filename: string, maximumBytes: number, label: string): Promise<string | null> {
  let expected: fs.Stats;
  try {
    expected = await fs.promises.lstat(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!expected.isFile() || expected.isSymbolicLink()) throw new Error(`${label} must be a non-symlinked regular file.`);
  if (expected.size > maximumBytes) throw new Error(`${label} exceeds the ${maximumBytes}-byte discovery limit.`);
  const noFollow = process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW;
  const handle = await fs.promises.open(filename, fs.constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino || opened.size !== expected.size) {
      throw new Error(`${label} changed while it was being inspected.`);
    }
    const contents = await handle.readFile();
    if (contents.byteLength > maximumBytes) throw new Error(`${label} exceeds the ${maximumBytes}-byte discovery limit.`);
    const afterRead = await handle.stat();
    const current = await fs.promises.lstat(filename);
    if (afterRead.dev !== opened.dev || afterRead.ino !== opened.ino
      || afterRead.size !== opened.size || afterRead.mtimeMs !== opened.mtimeMs || afterRead.ctimeMs !== opened.ctimeMs
      || !current.isFile() || current.isSymbolicLink()
      || current.dev !== opened.dev || current.ino !== opened.ino
      || current.size !== opened.size || current.mtimeMs !== opened.mtimeMs || current.ctimeMs !== opened.ctimeMs) {
      throw new Error(`${label} changed while it was being inspected.`);
    }
    return contents.toString("utf8");
  } finally {
    await handle.close();
  }
}

async function safeMarkerExists(root: string, relativePath: string, directory = false): Promise<boolean> {
  try {
    const stat = await fs.promises.lstat(path.join(root, relativePath));
    if (stat.isSymbolicLink()) return false;
    return directory ? stat.isDirectory() : stat.isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function safeMetadataParentPath(root: string, components: readonly string[], label: string): Promise<boolean> {
  let current = root;
  for (const component of components) {
    current = path.join(current, component);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} may not traverse a symbolic link.`);
  }
  return true;
}

function portablePath(value: string): string {
  return value.split(path.sep).join("/");
}

export function normalizeExcludedPatterns(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAXIMUM_EXCLUDED_PATTERNS) {
    throw new Error(`Repository exclusion patterns must be an array of at most ${MAXIMUM_EXCLUDED_PATTERNS} entries.`);
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const [index, candidate] of value.entries()) {
    if (typeof candidate !== "string") throw new Error(`Repository exclusion pattern ${index + 1} must be a string.`);
    const pattern = candidate.trim();
    if (pattern.length === 0 || pattern.length > MAXIMUM_EXCLUDED_PATTERN_LENGTH || /[\0\r\n]/.test(pattern)) {
      throw new Error(`Repository exclusion pattern ${index + 1} must contain 1 to ${MAXIMUM_EXCLUDED_PATTERN_LENGTH} safe characters.`);
    }
    if (seen.has(pattern)) throw new Error(`Repository exclusion pattern ${index + 1} is duplicated.`);
    seen.add(pattern);
    normalized.push(pattern);
  }
  return normalized;
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function excludedPatternExpression(pattern: string): RegExp {
  let portable = pattern.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/");
  const rootAnchored = portable.startsWith("/");
  if (rootAnchored) portable = portable.slice(1);
  if (portable.endsWith("/")) portable += "**";
  const containsSlash = portable.includes("/");
  let expression = rootAnchored || containsSlash ? "^" : "(?:^|/)";
  for (let index = 0; index < portable.length; index += 1) {
    const character = portable[index]!;
    if (character !== "*") {
      expression += character === "?" ? "[^/]" : escapeRegularExpression(character);
      continue;
    }
    if (portable[index + 1] !== "*") {
      expression += "[^/]*";
      continue;
    }
    while (portable[index + 1] === "*") index += 1;
    if (portable[index + 1] === "/") {
      expression += "(?:[^/]+/)*";
      index += 1;
    } else {
      expression += ".*";
    }
  }
  return new RegExp(`${expression}$`);
}

function excludedPathMatcher(patterns: readonly string[]): (relativePath: string, directory: boolean) => boolean {
  const expressions = patterns.map(excludedPatternExpression);
  return (relativePath, directory) => expressions.some((expression) => (
    expression.test(relativePath) || (directory && expression.test(`${relativePath}/`))
  ));
}

function secretPath(relativePath: string): boolean {
  const basename = path.basename(relativePath);
  const lower = basename.toLowerCase();
  return SECRET_BASENAMES.has(basename)
    || lower.startsWith(".env.")
    || lower.includes("secret")
    || lower.includes("credential")
    || SECRET_EXTENSIONS.has(path.extname(lower));
}

async function readGitHead(root: string): Promise<string | null> {
  const git = path.join(root, ".git");
  let gitStat: fs.Stats;
  try {
    gitStat = await fs.promises.lstat(git);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!gitStat.isDirectory() || gitStat.isSymbolicLink()) return null;
  const headPath = path.join(git, "HEAD");
  const headContents = await readBoundedMetadataFile(headPath, MAXIMUM_GIT_POINTER_BYTES, "Git HEAD");
  if (headContents === null) return null;
  const head = headContents.trim();
  const reference = /^ref: (.+)$/.exec(head)?.[1];
  if (!reference) return /^[a-f0-9]{40,64}$/i.test(head) ? head.toLowerCase() : null;
  if (!/^refs\/[A-Za-z0-9._/-]+$/.test(reference)
    || reference.split("/").some((part) => part.length === 0 || part === "." || part === "..")) return null;
  const referenceComponents = reference.split("/");
  const referencePath = path.join(git, ...referenceComponents);
  const safeReferenceParents = await safeMetadataParentPath(
    git,
    referenceComponents.slice(0, -1),
    "Git loose reference",
  );
  const looseReference = safeReferenceParents
    ? await readBoundedMetadataFile(referencePath, MAXIMUM_GIT_POINTER_BYTES, "Git loose reference")
    : null;
  if (looseReference !== null) {
    const value = looseReference.trim();
    return /^[a-f0-9]{40,64}$/i.test(value) ? value.toLowerCase() : null;
  }
  const packedRefs = path.join(git, "packed-refs");
  const packedReferenceContents = await readBoundedMetadataFile(packedRefs, MAXIMUM_PACKED_REFS_BYTES, "Git packed refs");
  if (packedReferenceContents === null) return null;
  for (const line of packedReferenceContents.split("\n")) {
    const [value, name] = line.trim().split(" ");
    if (name === reference && value && /^[a-f0-9]{40,64}$/i.test(value)) return value.toLowerCase();
  }
  return null;
}

async function detectPlatforms(
  root: string,
  excludedByPolicy: (relativePath: string, directory: boolean) => boolean,
): Promise<RepositoryPlatform[]> {
  const platforms = new Set<RepositoryPlatform>();
  const exists = async (name: string, directory = false) => (
    !excludedByPolicy(portablePath(name), directory) && await safeMarkerExists(root, name, directory)
  );
  let packageJson: Record<string, unknown> | null = null;
  if (await exists("package.json")) {
    const contents = await readBoundedMetadataFile(
      path.join(root, "package.json"),
      MAXIMUM_PACKAGE_JSON_BYTES,
      "package.json",
    );
    if (contents === null) throw new Error("package.json changed while it was being inspected.");
    try {
      packageJson = JSON.parse(contents) as Record<string, unknown>;
    } catch {
      packageJson = null;
    }
    platforms.add("web");
  }
  const dependencies = packageJson && typeof packageJson.dependencies === "object" && packageJson.dependencies !== null
    ? packageJson.dependencies as Record<string, unknown>
    : {};
  if ("react-native" in dependencies || await exists("metro.config.js") || await exists("metro.config.ts")) platforms.add("react-native");
  if (await exists("pubspec.yaml") || await exists("pubspec.yml")) platforms.add("flutter");
  if (await exists("settings.gradle") || await exists("settings.gradle.kts") || await exists("gradlew")) platforms.add("android");
  const topLevel = await fs.promises.readdir(root, { withFileTypes: true });
  if (await exists("Package.swift") || topLevel.some((entry) => (
    entry.isDirectory()
    && !entry.isSymbolicLink()
    && !excludedByPolicy(entry.name, true)
    && (entry.name.endsWith(".xcodeproj") || entry.name.endsWith(".xcworkspace"))
  ))) platforms.add("ios");
  if (platforms.size === 0) platforms.add("generic-git");
  return [...platforms].sort();
}

function entityId(kind: InventoryEntityKind, locationId: string, name: string, line: number | null): string {
  return `inv_${sha256(`${kind}\0${locationId}\0${name}\0${line ?? 0}`).slice(0, 40)}`;
}

function appendEntity(
  entities: LocalInventoryEntity[],
  maximumEntities: number,
  relativePath: string,
  kind: InventoryEntityKind,
  name: string,
  symbol: string | null,
  line: number | null,
): boolean {
  if (entities.length >= maximumEntities) return false;
  const locationId = `loc_${sha256(relativePath).slice(0, 40)}`;
  entities.push({
    id: entityId(kind, locationId, name, line),
    kind,
    name: name.slice(0, 240),
    symbol: symbol?.slice(0, 240) ?? null,
    relativePath,
    locationId,
    line,
  });
  return true;
}

function sourceEntities(relativePath: string, contents: string, maximumEntities: number, entities: LocalInventoryEntity[]): boolean {
  const lines = contents.split("\n");
  const screenLike = /(^|\/)(pages?|screens?|views?|routes?)(\/|$)/i.test(relativePath);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const lineNumber = index + 1;
    const component = /(?:export\s+)?(?:default\s+)?(?:function|class|const|let|var|struct)\s+([A-Z][A-Za-z0-9_]*)/.exec(line)?.[1]
      ?? /class\s+([A-Z][A-Za-z0-9_]*)\s+extends\s+(?:StatelessWidget|StatefulWidget)/.exec(line)?.[1];
    if (component && !appendEntity(entities, maximumEntities, relativePath, screenLike ? "screen" : "component", component, component, lineNumber)) return false;
    const route = /(?:path|route|routeName)\s*[:=]\s*["'`]([^"'`]{1,200})["'`]/.exec(line)?.[1]
      ?? /(?:GET|POST|PUT|PATCH|DELETE)\s+["'`]([^"'`]{1,200})["'`]/.exec(line)?.[1];
    if (route && !appendEntity(entities, maximumEntities, relativePath, "route", route, null, lineNumber)) return false;
    const cssToken = /(--[a-zA-Z0-9_-]+)\s*:/.exec(line)?.[1];
    const xmlToken = /<(?:color|dimen|string|style)\s+name=["']([^"']+)["']/.exec(line)?.[1];
    if ((cssToken || xmlToken) && !appendEntity(entities, maximumEntities, relativePath, "token", (cssToken ?? xmlToken)!, null, lineNumber)) return false;
    const flow = /(?:class|struct|function|const)\s+([A-Za-z0-9_]*(?:Flow|Journey|Workflow)[A-Za-z0-9_]*)/.exec(line)?.[1];
    if (flow && !appendEntity(entities, maximumEntities, relativePath, "flow", flow, flow, lineNumber)) return false;
    const rule = /(?:class|struct|function|const)\s+([A-Za-z0-9_]*(?:Policy|Rule|Validator|Constraint)[A-Za-z0-9_]*)/.exec(line)?.[1];
    if (rule && !appendEntity(entities, maximumEntities, relativePath, "business-rule", rule, rule, lineNumber)) return false;
  }
  return true;
}

export async function scanRepository(
  repositoryRoot: string,
  options: { limits?: Partial<InventoryLimits>; now?: Date; excludedPatterns?: readonly string[] } = {},
): Promise<LocalRepositoryInventory> {
  const root = await fs.promises.realpath(path.resolve(repositoryRoot));
  const rootStat = await fs.promises.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("The selected repository must be a real directory.");
  const limits: InventoryLimits = { ...DEFAULT_LIMITS, ...options.limits };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Inventory limit ${name} must be a positive integer.`);
  }
  const excludedPatterns = normalizeExcludedPatterns(options.excludedPatterns ?? []);
  const excludedByPolicy = excludedPathMatcher(excludedPatterns);
  const platforms = await detectPlatforms(root, excludedByPolicy);
  const gitHead = await readGitHead(root);
  const entities: LocalInventoryEntity[] = [];
  const excluded = { secret: 0, generated: 0, policy: 0, symlink: 0, limit: 0 };
  const fingerprintRows: string[] = [`platforms:${platforms.join(",")}`, `git:${gitHead ?? "none"}`];
  let scannedFileCount = 0;
  let skippedFileCount = 0;
  let bytesRead = 0;
  let fingerprintBytes = 0;
  let truncated = false;

  const visit = async (directory: string, prefix = ""): Promise<void> => {
    if (truncated) return;
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (truncated) return;
      const relativePath = portablePath(prefix ? `${prefix}/${entry.name}` : entry.name);
      const absolute = path.join(directory, entry.name);
      const stat = await fs.promises.lstat(absolute);
      if (stat.isSymbolicLink()) {
        excluded.symlink += 1;
        skippedFileCount += 1;
        continue;
      }
      if (entry.isDirectory()) {
        if (GENERATED_DIRECTORIES.has(entry.name)) {
          excluded.generated += 1;
          continue;
        }
        if (excludedByPolicy(relativePath, true)) {
          excluded.policy += 1;
          continue;
        }
        await visit(absolute, relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (secretPath(relativePath)) {
        excluded.secret += 1;
        skippedFileCount += 1;
        continue;
      }
      if (excludedByPolicy(relativePath, false)) {
        excluded.policy += 1;
        skippedFileCount += 1;
        continue;
      }
      if (scannedFileCount >= limits.maximumFiles) {
        excluded.limit += 1;
        skippedFileCount += 1;
        truncated = true;
        return;
      }
      scannedFileCount += 1;
      if (fingerprintBytes + stat.size > limits.maximumFingerprintBytes) {
        excluded.limit += 1;
        skippedFileCount += 1;
        truncated = true;
        return;
      }
      fingerprintBytes += stat.size;
      const contentHash = await sha256File(absolute, stat);
      fingerprintRows.push(`${relativePath}\0${stat.size}\0${contentHash}`);
      const extension = path.extname(entry.name).toLowerCase();
      if (ASSET_EXTENSIONS.has(extension)) {
        if (!appendEntity(entities, limits.maximumEntities, relativePath, "asset", path.basename(entry.name, extension), null, null)) {
          excluded.limit += 1;
          truncated = true;
          return;
        }
        continue;
      }
      if (!SOURCE_EXTENSIONS.has(extension) || stat.size > limits.maximumFileBytes) {
        skippedFileCount += 1;
        if (stat.size > limits.maximumFileBytes) excluded.limit += 1;
        continue;
      }
      if (bytesRead + stat.size > limits.maximumTotalBytesRead) {
        excluded.limit += 1;
        skippedFileCount += 1;
        truncated = true;
        return;
      }
      const contentsBuffer = await readVerifiedSourceFile(absolute, stat, contentHash);
      const contents = contentsBuffer.toString("utf8");
      bytesRead += contentsBuffer.byteLength;
      if (!sourceEntities(relativePath, contents, limits.maximumEntities, entities)) {
        excluded.limit += 1;
        truncated = true;
        return;
      }
    }
  };

  await visit(root);
  const repositoryFingerprint = sha256(fingerprintRows.sort().join("\n"));
  return {
    schemaVersion: 1,
    repositoryFingerprint,
    generatedAt: (options.now ?? new Date()).toISOString(),
    platforms,
    gitHead,
    excludedPatterns,
    scannedFileCount,
    skippedFileCount,
    bytesRead,
    truncated,
    entities,
    excluded: (Object.entries(excluded) as Array<[keyof typeof excluded, number]>).map(([category, count]) => ({ category, count })),
  };
}

export function inventoryForUpload(inventory: LocalRepositoryInventory): UploadRepositoryInventory {
  return {
    ...inventory,
    entities: inventory.entities.map(({ relativePath: _relativePath, ...entity }) => entity),
  };
}
