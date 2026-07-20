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

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
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

function readGitHead(root: string): string | null {
  const git = path.join(root, ".git");
  if (!fs.existsSync(git) || !fs.lstatSync(git).isDirectory()) return null;
  const headPath = path.join(git, "HEAD");
  if (!fs.existsSync(headPath)) return null;
  const head = fs.readFileSync(headPath, "utf8").trim();
  const reference = /^ref: (.+)$/.exec(head)?.[1];
  if (!reference) return /^[a-f0-9]{40,64}$/i.test(head) ? head.toLowerCase() : null;
  if (reference.includes("..") || path.isAbsolute(reference)) return null;
  const referencePath = path.join(git, ...reference.split("/"));
  if (fs.existsSync(referencePath)) {
    const value = fs.readFileSync(referencePath, "utf8").trim();
    return /^[a-f0-9]{40,64}$/i.test(value) ? value.toLowerCase() : null;
  }
  const packedRefs = path.join(git, "packed-refs");
  if (!fs.existsSync(packedRefs)) return null;
  for (const line of fs.readFileSync(packedRefs, "utf8").split("\n")) {
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
  const exists = (name: string, directory = false) => !excludedByPolicy(portablePath(name), directory) && fs.existsSync(path.join(root, name));
  let packageJson: Record<string, unknown> | null = null;
  if (exists("package.json")) {
    try {
      packageJson = JSON.parse(await fs.promises.readFile(path.join(root, "package.json"), "utf8")) as Record<string, unknown>;
    } catch {
      packageJson = null;
    }
    platforms.add("web");
  }
  const dependencies = packageJson && typeof packageJson.dependencies === "object" && packageJson.dependencies !== null
    ? packageJson.dependencies as Record<string, unknown>
    : {};
  if ("react-native" in dependencies || exists("metro.config.js") || exists("metro.config.ts")) platforms.add("react-native");
  if (exists("pubspec.yaml") || exists("pubspec.yml")) platforms.add("flutter");
  if (exists("settings.gradle") || exists("settings.gradle.kts") || exists("gradlew")) platforms.add("android");
  const topLevel = await fs.promises.readdir(root, { withFileTypes: true });
  if (exists("Package.swift") || topLevel.some((entry) => (
    !excludedByPolicy(entry.name, entry.isDirectory())
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
  const gitHead = readGitHead(root);
  const entities: LocalInventoryEntity[] = [];
  const excluded = { secret: 0, generated: 0, policy: 0, symlink: 0, limit: 0 };
  const fingerprintRows: string[] = [`platforms:${platforms.join(",")}`, `git:${gitHead ?? "none"}`];
  let scannedFileCount = 0;
  let skippedFileCount = 0;
  let bytesRead = 0;
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
      fingerprintRows.push(`${relativePath}\0${stat.size}`);
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
      const contents = await fs.promises.readFile(absolute, "utf8");
      bytesRead += Buffer.byteLength(contents);
      fingerprintRows.push(sha256(contents));
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
