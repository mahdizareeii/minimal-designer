import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { scanFrameworkSource } from "./framework-scanners.js";

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
const SOURCE_EXTENSIONS = new Set([".css", ".dart", ".gradle", ".h", ".html", ".java", ".js", ".jsx", ".kt", ".kts", ".m", ".mm", ".scss", ".storyboard", ".swift", ".ts", ".tsx", ".vue", ".xib", ".xml"]);
const ASSET_EXTENSIONS = new Set([".avif", ".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"]);
const MAXIMUM_EXCLUDED_PATTERNS = 100;
const MAXIMUM_EXCLUDED_PATTERN_LENGTH = 240;
const MAXIMUM_PACKAGE_JSON_BYTES = 1024 * 1024;
const MAXIMUM_GIT_POINTER_BYTES = 16 * 1024;
const MAXIMUM_PACKED_REFS_BYTES = 4 * 1024 * 1024;
const MAXIMUM_PLATFORM_MARKER_DIRECTORIES = 2_000;
const MAXIMUM_PLATFORM_MARKER_ENTRIES = 20_000;
const MAXIMUM_PLATFORM_MARKER_DEPTH = 8;
const MAXIMUM_PLATFORM_MARKER_BYTES = 8 * 1024 * 1024;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function pathIsWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function descriptorPath(fd: number): string | null {
  if (process.platform === "darwin") return `/dev/fd/${fd}`;
  if (process.platform === "linux") return `/proc/self/fd/${fd}`;
  return null;
}

async function assertDescriptorPath(
  root: string,
  filename: string,
  handle: fs.promises.FileHandle,
  label: string,
): Promise<string | null> {
  const candidate = descriptorPath(handle.fd);
  if (!candidate) return null;
  let actual: string;
  let current: string;
  try {
    [actual, current] = await Promise.all([
      fs.promises.realpath(candidate),
      fs.promises.realpath(filename),
    ]);
  } catch (error) {
    throw new Error(`${label} changed while it was being inspected.`, { cause: error });
  }
  if (!pathIsWithin(root, current)) {
    throw new Error(`${label} escaped the selected repository or changed through a symbolic-link swap.`);
  }
  // macOS exposes /dev/fd descriptors but realpath intentionally leaves that
  // pseudo-path unresolved. The caller's before/open/after inode checks still
  // bind the handle to the exact lstat result before any bytes are consumed.
  if (path.resolve(actual) === path.resolve(candidate)
    || (process.platform === "darwin" && actual.startsWith("/dev/fd/"))) return candidate;
  if (!pathIsWithin(root, actual) || path.resolve(actual) !== path.resolve(current)) {
    throw new Error(`${label} escaped the selected repository or changed through a symbolic-link swap.`);
  }
  return candidate;
}

async function readVerifiedDirectory(
  root: string,
  directory: string,
  label: string,
  hooks: {
    afterHandleVerified?: () => void | Promise<void>;
    afterDirectoryOpened?: () => void | Promise<void>;
  } = {},
): Promise<fs.Dirent[]> {
  const expected = await fs.promises.lstat(directory);
  if (!expected.isDirectory() || expected.isSymbolicLink()) throw new Error(`${label} must be a non-symlinked directory.`);
  const noFollow = process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW;
  const directoryOnly = process.platform === "win32" ? 0 : fs.constants.O_DIRECTORY;
  const handle = await fs.promises.open(directory, fs.constants.O_RDONLY | noFollow | directoryOnly);
  let openedDirectory: fs.Dir | null = null;
  try {
    const opened = await handle.stat();
    if (!opened.isDirectory() || opened.dev !== expected.dev || opened.ino !== expected.ino) {
      throw new Error(`${label} changed while it was being inspected.`);
    }
    const currentBeforeOpen = await fs.promises.lstat(directory);
    if (!currentBeforeOpen.isDirectory() || currentBeforeOpen.isSymbolicLink()
      || currentBeforeOpen.dev !== opened.dev || currentBeforeOpen.ino !== opened.ino) {
      throw new Error(`${label} changed while it was being inspected.`);
    }
    await hooks.afterHandleVerified?.();
    openedDirectory = await fs.promises.opendir(directory);
    await hooks.afterDirectoryOpened?.();
    const entries: fs.Dirent[] = [];
    while (true) {
      const beforeRead = await fs.promises.lstat(directory);
      if (!beforeRead.isDirectory() || beforeRead.isSymbolicLink()
        || beforeRead.dev !== opened.dev || beforeRead.ino !== opened.ino) {
        throw new Error(`${label} changed while it was being inspected.`);
      }
      const entry = await openedDirectory.read();
      const afterEntry = await fs.promises.lstat(directory);
      if (!afterEntry.isDirectory() || afterEntry.isSymbolicLink()
        || afterEntry.dev !== opened.dev || afterEntry.ino !== opened.ino) {
        throw new Error(`${label} changed while it was being inspected.`);
      }
      if (entry === null) break;
      entries.push(entry);
    }
    const verificationEntries = await fs.promises.readdir(directory, { withFileTypes: true });
    const entrySignature = (entry: fs.Dirent) => `${entry.name}\0${entry.isDirectory() ? "d" : entry.isFile() ? "f" : entry.isSymbolicLink() ? "l" : "o"}`;
    const openedSignature = entries.map(entrySignature).sort();
    const verifiedSignature = verificationEntries.map(entrySignature).sort();
    if (openedSignature.length !== verifiedSignature.length
      || openedSignature.some((value, index) => value !== verifiedSignature[index])) {
      throw new Error(`${label} changed while it was being inspected.`);
    }
    const afterRead = await handle.stat();
    const current = await fs.promises.lstat(directory);
    if (!current.isDirectory() || current.isSymbolicLink()
      || afterRead.dev !== opened.dev || afterRead.ino !== opened.ino
      || current.dev !== opened.dev || current.ino !== opened.ino) {
      throw new Error(`${label} changed while it was being inspected.`);
    }
    return entries;
  } finally {
    if (openedDirectory) await openedDirectory.close().catch(() => undefined);
    await handle.close();
  }
}

async function sha256File(root: string, filename: string, expected: fs.Stats): Promise<string> {
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
    await assertDescriptorPath(root, filename, handle, "Repository file");
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

async function readVerifiedSourceFile(root: string, filename: string, expected: fs.Stats, expectedHash: string): Promise<Buffer> {
  const noFollow = process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW;
  const handle = await fs.promises.open(filename, fs.constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino || opened.size !== expected.size) {
      throw new Error("Repository contents changed while source symbols were being inspected; retry authorization.");
    }
    await assertDescriptorPath(root, filename, handle, "Repository source file");
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

async function readBoundedMetadataFile(root: string, filename: string, maximumBytes: number, label: string): Promise<string | null> {
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
    await assertDescriptorPath(root, filename, handle, label);
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
  const components = portablePath(relativePath).split("/");
  if (components.some((component) => component.length === 0 || component === "." || component === "..")) return false;
  let parent = root;
  for (const component of components.slice(0, -1)) {
    parent = path.join(parent, component);
    try {
      const parentStat = await fs.promises.lstat(parent);
      if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  try {
    const stat = await fs.promises.lstat(path.join(root, ...components));
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
  const gitMarker = path.join(root, ".git");
  let gitStat: fs.Stats;
  try {
    gitStat = await fs.promises.lstat(gitMarker);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (gitStat.isSymbolicLink()) throw new Error(".git may not be a symbolic link.");
  let gitDirectory: string;
  let commonDirectory: string;
  if (gitStat.isDirectory()) {
    gitDirectory = gitMarker;
    commonDirectory = gitMarker;
  } else if (gitStat.isFile()) {
    const pointer = await readBoundedMetadataFile(root, gitMarker, MAXIMUM_GIT_POINTER_BYTES, ".git worktree pointer");
    const value = /^gitdir: ([^\r\n]+)\s*$/.exec(pointer ?? "")?.[1]?.trim();
    if (!value) throw new Error(".git worktree pointer is invalid.");
    if (!path.isAbsolute(value) && value.split(/[\\/]+/).some((component) => component === "..")) {
      throw new Error(".git worktree pointer may not traverse outside the selected worktree.");
    }
    const unresolved = path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
    const unresolvedStat = await fs.promises.lstat(unresolved);
    if (!unresolvedStat.isDirectory() || unresolvedStat.isSymbolicLink()) {
      throw new Error(".git worktree target must be a non-symlinked directory.");
    }
    gitDirectory = await fs.promises.realpath(unresolved);
    const backReference = await readBoundedMetadataFile(
      gitDirectory,
      path.join(gitDirectory, "gitdir"),
      MAXIMUM_GIT_POINTER_BYTES,
      "Git worktree back-reference",
    );
    if (backReference === null) throw new Error("Git worktree metadata is missing its back-reference.");
    const backReferenceValue = backReference.trim();
    if (!backReferenceValue || backReferenceValue.includes("\0")) {
      throw new Error("Git worktree back-reference is invalid.");
    }
    const resolvedBackReference = path.resolve(gitDirectory, backReferenceValue);
    const [canonicalBackReference, canonicalGitMarker] = await Promise.all([
      fs.promises.realpath(resolvedBackReference),
      fs.promises.realpath(gitMarker),
    ]);
    if (path.resolve(canonicalBackReference) !== path.resolve(canonicalGitMarker)) {
      throw new Error("Git worktree metadata does not point back to the selected worktree.");
    }
    const commonPointer = await readBoundedMetadataFile(
      gitDirectory,
      path.join(gitDirectory, "commondir"),
      MAXIMUM_GIT_POINTER_BYTES,
      "Git worktree common-directory pointer",
    );
    if (commonPointer === null) throw new Error("Git worktree metadata is missing commondir.");
    const commonValue = commonPointer.trim();
    if (!commonValue || commonValue.includes("\0")) throw new Error("Git worktree commondir is invalid.");
    const commonUnresolved = path.resolve(gitDirectory, commonValue);
    const commonStat = await fs.promises.lstat(commonUnresolved);
    if (!commonStat.isDirectory() || commonStat.isSymbolicLink()) {
      throw new Error("Git worktree common directory must be a non-symlinked directory.");
    }
    commonDirectory = await fs.promises.realpath(commonUnresolved);
    if (!pathIsWithin(commonDirectory, gitDirectory)) {
      throw new Error("Git worktree metadata must remain within its common Git directory.");
    }
  } else {
    throw new Error(".git must be a non-symlinked directory or bounded worktree pointer file.");
  }

  const headPath = path.join(gitDirectory, "HEAD");
  const headContents = await readBoundedMetadataFile(gitDirectory, headPath, MAXIMUM_GIT_POINTER_BYTES, "Git HEAD");
  if (headContents === null) return null;
  const head = headContents.trim();
  const reference = /^ref: (.+)$/.exec(head)?.[1];
  if (!reference) return /^[a-f0-9]{40,64}$/i.test(head) ? head.toLowerCase() : null;
  if (!/^refs\/[A-Za-z0-9._/-]+$/.test(reference)
    || reference.split("/").some((part) => part.length === 0 || part === "." || part === "..")) return null;
  const referenceComponents = reference.split("/");
  const referenceRoots = gitDirectory === commonDirectory ? [gitDirectory] : [gitDirectory, commonDirectory];
  let looseReference: string | null = null;
  for (const referenceRoot of referenceRoots) {
    const referencePath = path.join(referenceRoot, ...referenceComponents);
    const safeReferenceParents = await safeMetadataParentPath(
      referenceRoot,
      referenceComponents.slice(0, -1),
      "Git loose reference",
    );
    looseReference = safeReferenceParents
      ? await readBoundedMetadataFile(referenceRoot, referencePath, MAXIMUM_GIT_POINTER_BYTES, "Git loose reference")
      : null;
    if (looseReference !== null) break;
  }
  if (looseReference !== null) {
    const value = looseReference.trim();
    return /^[a-f0-9]{40,64}$/i.test(value) ? value.toLowerCase() : null;
  }
  const packedRefs = path.join(commonDirectory, "packed-refs");
  const packedReferenceContents = await readBoundedMetadataFile(commonDirectory, packedRefs, MAXIMUM_PACKED_REFS_BYTES, "Git packed refs");
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
  maximumMarkerBytes: number,
): Promise<{ platforms: RepositoryPlatform[]; truncated: boolean }> {
  const platforms = new Set<RepositoryPlatform>();
  const exists = async (name: string, directory = false) => (
    !excludedByPolicy(portablePath(name), directory) && await safeMarkerExists(root, name, directory)
  );
  let packageJson: Record<string, unknown> | null = null;
  if (await exists("package.json")) {
    const contents = await readBoundedMetadataFile(
      root,
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
  if (!platforms.has("web") && (
    await exists("index.html")
    || await exists("vite.config.js") || await exists("vite.config.ts")
    || await exists("next.config.js") || await exists("next.config.mjs") || await exists("next.config.ts")
  )) platforms.add("web");
  const dependencySections = ["dependencies", "devDependencies", "peerDependencies"]
    .map((name) => packageJson?.[name])
    .filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null);
  const hasDependency = (name: string) => dependencySections.some((section) => name in section);
  if (hasDependency("react-native")
    || await exists("metro.config.js") || await exists("metro.config.ts")
    || await exists("react-native.config.js")) platforms.add("react-native");
  if (await exists("pubspec.yaml") || await exists("pubspec.yml")) platforms.add("flutter");
  if (await exists("settings.gradle") || await exists("settings.gradle.kts") || await exists("gradlew")
    || await exists("AndroidManifest.xml")
    || await exists("android/settings.gradle") || await exists("android/settings.gradle.kts")
    || await exists("android/gradlew") || await exists("android/app/src/main/AndroidManifest.xml")) platforms.add("android");

  let markerDirectories = 0;
  let markerEntries = 0;
  let markerBytesRead = 0;
  let markerLimitReached = false;
  const visitPlatformMarkers = async (directory: string, prefix: string, depth: number): Promise<void> => {
    if (markerLimitReached) return;
    if (depth > MAXIMUM_PLATFORM_MARKER_DEPTH) {
      markerLimitReached = true;
      return;
    }
    markerDirectories += 1;
    if (markerDirectories > MAXIMUM_PLATFORM_MARKER_DIRECTORIES) {
      markerLimitReached = true;
      return;
    }
    const entries = await readVerifiedDirectory(root, directory, `Platform marker directory ${prefix || "."}`);
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      markerEntries += 1;
      if (markerEntries > MAXIMUM_PLATFORM_MARKER_ENTRIES) {
        markerLimitReached = true;
        return;
      }
      const relativePath = portablePath(prefix ? `${prefix}/${entry.name}` : entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (GENERATED_DIRECTORIES.has(entry.name) || excludedByPolicy(relativePath, true)) continue;
        if (entry.name.endsWith(".xcodeproj") || entry.name.endsWith(".xcworkspace")) {
          platforms.add("ios");
          continue;
        }
        await visitPlatformMarkers(path.join(directory, entry.name), relativePath, depth + 1);
        continue;
      }
      if (!entry.isFile() || excludedByPolicy(relativePath, false) || secretPath(relativePath)) continue;
      const lower = entry.name.toLowerCase();
      if (lower === "package.json") {
        const packageStat = await fs.promises.lstat(path.join(directory, entry.name));
        if (!packageStat.isFile() || packageStat.isSymbolicLink()) continue;
        if (markerBytesRead + packageStat.size > maximumMarkerBytes) {
          markerLimitReached = true;
          return;
        }
        markerBytesRead += packageStat.size;
        const contents = await readBoundedMetadataFile(
          root,
          path.join(directory, entry.name),
          MAXIMUM_PACKAGE_JSON_BYTES,
          `Nested package.json ${relativePath}`,
        );
        if (contents !== null) {
          platforms.add("web");
          try {
            const parsed = JSON.parse(contents) as Record<string, unknown>;
            const sections = ["dependencies", "devDependencies", "peerDependencies"]
              .map((name) => parsed[name])
              .filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null);
            if (sections.some((section) => "react-native" in section)) platforms.add("react-native");
          } catch {
            // Invalid package metadata is ignored here and remains bounded.
          }
        }
      } else if (["index.html", "vite.config.js", "vite.config.ts", "next.config.js", "next.config.mjs", "next.config.ts"].includes(lower)) {
        platforms.add("web");
      } else if (["metro.config.js", "metro.config.ts", "react-native.config.js"].includes(lower)) {
        platforms.add("react-native");
      } else if (lower === "pubspec.yaml" || lower === "pubspec.yml") {
        platforms.add("flutter");
      } else if (["settings.gradle", "settings.gradle.kts", "gradlew", "androidmanifest.xml"].includes(lower)) {
        platforms.add("android");
      } else if (lower === "package.swift") {
        platforms.add("ios");
      }
    }
  };
  await visitPlatformMarkers(root, "", 0);

  const topLevel = await readVerifiedDirectory(root, root, "Repository root");
  let nestedAppleProject = false;
  for (const appleDirectory of ["ios", "macos"]) {
    if (!await exists(appleDirectory, true)) continue;
    const entries = await readVerifiedDirectory(root, path.join(root, appleDirectory), `${appleDirectory} project directory`);
    if (entries.some((entry) => entry.isDirectory()
      && !entry.isSymbolicLink()
      && !excludedByPolicy(`${appleDirectory}/${entry.name}`, true)
      && (entry.name.endsWith(".xcodeproj") || entry.name.endsWith(".xcworkspace")))) {
      nestedAppleProject = true;
      break;
    }
  }
  if (await exists("Package.swift") || nestedAppleProject || topLevel.some((entry) => (
    entry.isDirectory()
    && !entry.isSymbolicLink()
    && !excludedByPolicy(entry.name, true)
    && (entry.name.endsWith(".xcodeproj") || entry.name.endsWith(".xcworkspace"))
  ))) platforms.add("ios");
  if (platforms.size === 0) platforms.add("generic-git");
  return { platforms: [...platforms].sort(), truncated: markerLimitReached };
}

function entityLocationId(
  relativePath: string,
  kind: InventoryEntityKind,
  name: string,
  symbol: string | null,
): string {
  return `loc_${sha256(`${relativePath}\0${kind}\0${symbol ?? name}`).slice(0, 40)}`;
}

function entityId(kind: InventoryEntityKind, locationId: string, name: string, symbol: string | null): string {
  return `inv_${sha256(`${kind}\0${locationId}\0${name}\0${symbol ?? ""}`).slice(0, 40)}`;
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
  const normalizedName = name.slice(0, 240);
  const normalizedSymbol = symbol?.slice(0, 240) ?? null;
  const locationId = entityLocationId(relativePath, kind, normalizedName, normalizedSymbol);
  entities.push({
    id: entityId(kind, locationId, normalizedName, normalizedSymbol),
    kind,
    name: normalizedName,
    symbol: normalizedSymbol,
    relativePath,
    locationId,
    line,
  });
  return true;
}

function sourceEntities(
  relativePath: string,
  contents: string,
  platforms: readonly RepositoryPlatform[],
  maximumEntities: number,
  entities: LocalInventoryEntity[],
): boolean {
  const scan = scanFrameworkSource({
    relativePath,
    contents,
    platforms,
    maximumEntities: Math.max(0, maximumEntities - entities.length),
  });
  for (const entity of scan.entities) {
    if (!appendEntity(
      entities,
      maximumEntities,
      relativePath,
      entity.kind,
      entity.name,
      entity.symbol,
      entity.line,
    )) return false;
  }
  return !scan.truncated;
}

export async function scanRepository(
  repositoryRoot: string,
  options: {
    limits?: Partial<InventoryLimits>;
    now?: Date;
    excludedPatterns?: readonly string[];
    /** Internal deterministic race-test hook; never populated from remote input. */
    beforeDirectoryRead?: (directory: string, relativePath: string) => void | Promise<void>;
    /** Internal deterministic race-test hooks around pathname-based opendir. */
    afterDirectoryHandleVerified?: (directory: string, relativePath: string) => void | Promise<void>;
    afterDirectoryOpened?: (directory: string, relativePath: string) => void | Promise<void>;
  } = {},
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
  const platformDetection = await detectPlatforms(
    root,
    excludedByPolicy,
    Math.min(MAXIMUM_PLATFORM_MARKER_BYTES, limits.maximumTotalBytesRead),
  );
  const platforms = platformDetection.platforms;
  const gitHead = await readGitHead(root);
  const entities: LocalInventoryEntity[] = [];
  const excluded = { secret: 0, generated: 0, policy: 0, symlink: 0, limit: platformDetection.truncated ? 1 : 0 };
  const fingerprintRows: string[] = [`platforms:${platforms.join(",")}`, `git:${gitHead ?? "none"}`];
  let scannedFileCount = 0;
  let skippedFileCount = 0;
  let bytesRead = 0;
  let fingerprintBytes = 0;
  let truncated = platformDetection.truncated;

  const visit = async (directory: string, prefix = ""): Promise<void> => {
    if (truncated) return;
    await options.beforeDirectoryRead?.(directory, prefix);
    const entries = await readVerifiedDirectory(root, directory, `Repository directory ${prefix || "."}`, {
      afterHandleVerified: () => options.afterDirectoryHandleVerified?.(directory, prefix),
      afterDirectoryOpened: () => options.afterDirectoryOpened?.(directory, prefix),
    });
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
      if (stat.isDirectory()) {
        if (GENERATED_DIRECTORIES.has(entry.name)) {
          excluded.generated += 1;
          continue;
        }
        if (excludedByPolicy(relativePath, true)) {
          excluded.policy += 1;
          continue;
        }
        if (platforms.includes("ios") && /\.(?:appiconset|imageset)$/i.test(entry.name)) {
          const assetName = entry.name.replace(/\.(?:appiconset|imageset)$/i, "");
          fingerprintRows.push(`semantic-directory:${relativePath}`);
          if (!appendEntity(entities, limits.maximumEntities, relativePath, "asset", assetName, null, null)) {
            excluded.limit += 1;
            truncated = true;
            return;
          }
        } else if (platforms.includes("ios") && /\.colorset$/i.test(entry.name)) {
          const tokenName = entry.name.replace(/\.colorset$/i, "");
          fingerprintRows.push(`semantic-directory:${relativePath}`);
          if (!appendEntity(entities, limits.maximumEntities, relativePath, "token", tokenName, null, null)) {
            excluded.limit += 1;
            truncated = true;
            return;
          }
        }
        await visit(absolute, relativePath);
        continue;
      }
      if (!stat.isFile()) continue;
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
      const contentHash = await sha256File(root, absolute, stat);
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
      const contentsBuffer = await readVerifiedSourceFile(root, absolute, stat, contentHash);
      const contents = contentsBuffer.toString("utf8");
      bytesRead += contentsBuffer.byteLength;
      if (!sourceEntities(relativePath, contents, platforms, limits.maximumEntities, entities)) {
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
