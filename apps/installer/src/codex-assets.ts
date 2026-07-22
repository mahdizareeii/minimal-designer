import fs from "node:fs";
import path from "node:path";

const MAX_MANAGED_ASSET_BYTES = 256 * 1024;

export const FORMASPEC_CODEX_IDENTITY = Object.freeze({
  skillName: "formaspec",
  pluginName: "formaspec",
  marketplaceName: "formaspec",
  pluginId: "formaspec@formaspec",
  displayName: "FormaSpec",
  mention: "[@FormaSpec](plugin://formaspec@formaspec)",
});

const REQUIRED_MANAGED_FILES = Object.freeze([
  "skills/formaspec/SKILL.md",
  "skills/formaspec/agents/openai.yaml",
  "codex-marketplace/.agents/plugins/marketplace.json",
  "codex-marketplace/plugins/formaspec/.codex-plugin/plugin.json",
  "codex-marketplace/plugins/formaspec/skills/formaspec/SKILL.md",
  "codex-marketplace/plugins/formaspec/skills/formaspec/agents/openai.yaml",
]);

const LEGACY_MANAGED_PATHS = Object.freeze([
  "skills/minimal-ui",
  "codex-marketplace/plugins/minimal-ui",
]);

export interface ManagedCodexAssetIdentity {
  skillName: string;
  pluginName: string;
  marketplaceName: string;
  pluginId: string;
  displayName: string;
  mention: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function entryExists(filename: string): boolean {
  try {
    fs.lstatSync(filename);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function requireRegularFile(root: string, relativePath: string): string {
  const filename = path.join(root, ...relativePath.split("/"));
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filename);
  } catch (error) {
    throw new Error(`Required managed FormaSpec Codex asset is unavailable: ${relativePath}`, { cause: error });
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 1 || stat.size > MAX_MANAGED_ASSET_BYTES) {
    throw new Error(`Managed FormaSpec Codex asset must be a bounded regular file: ${relativePath}`);
  }
  return filename;
}

function readText(root: string, relativePath: string): string {
  return fs.readFileSync(requireRegularFile(root, relativePath), "utf8");
}

function readJson(root: string, relativePath: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readText(root, relativePath));
  } catch (error) {
    throw new Error(`Managed FormaSpec Codex JSON is invalid: ${relativePath}`, { cause: error });
  }
  if (!isRecord(parsed)) throw new Error(`Managed FormaSpec Codex JSON must be an object: ${relativePath}`);
  return parsed;
}

function requireInterfaceDisplayName(value: Record<string, unknown>, description: string): void {
  if (!isRecord(value.interface) || value.interface.displayName !== FORMASPEC_CODEX_IDENTITY.displayName) {
    throw new Error(`${description} must display the managed agent as FormaSpec.`);
  }
}

function requireSkillIdentity(contents: string, description: string): void {
  if (!/^name:\s*formaspec\s*$/mu.test(contents)) {
    throw new Error(`${description} must use the managed FormaSpec skill name.`);
  }
}

function requireOpenAiIdentity(contents: string, description: string): void {
  if (!/^\s*display_name:\s*["']FormaSpec["']\s*$/mu.test(contents)
    || !/^\s*default_prompt:\s*["'][^"']*\$formaspec\b[^"']*["']\s*$/mu.test(contents)) {
    throw new Error(`${description} must expose the managed $formaspec agent identity.`);
  }
}

export function inspectManagedCodexAssets(assetsRoot: string): ManagedCodexAssetIdentity {
  const root = path.resolve(assetsRoot);
  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(root);
  } catch (error) {
    throw new Error(`Managed FormaSpec Codex asset root is unavailable: ${root}`, { cause: error });
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Managed FormaSpec Codex asset root must be a regular directory: ${root}`);
  }
  for (const relativePath of LEGACY_MANAGED_PATHS) {
    if (entryExists(path.join(root, ...relativePath.split("/")))) {
      throw new Error(`Packaged Codex assets still contain the legacy managed path: ${relativePath}`);
    }
  }
  for (const relativePath of REQUIRED_MANAGED_FILES) requireRegularFile(root, relativePath);

  const plugin = readJson(root, "codex-marketplace/plugins/formaspec/.codex-plugin/plugin.json");
  if (plugin.name !== FORMASPEC_CODEX_IDENTITY.pluginName) {
    throw new Error("Managed FormaSpec Codex plugin manifest must use the formaspec plugin name.");
  }
  requireInterfaceDisplayName(plugin, "Managed FormaSpec Codex plugin manifest");

  const marketplace = readJson(root, "codex-marketplace/.agents/plugins/marketplace.json");
  if (marketplace.name !== FORMASPEC_CODEX_IDENTITY.marketplaceName) {
    throw new Error("Managed FormaSpec Codex marketplace must use the formaspec marketplace name.");
  }
  requireInterfaceDisplayName(marketplace, "Managed FormaSpec Codex marketplace");
  if (!Array.isArray(marketplace.plugins)) {
    throw new Error("Managed FormaSpec Codex marketplace plugin inventory is malformed.");
  }
  const managedEntries = marketplace.plugins.filter((entry): entry is Record<string, unknown> => (
    isRecord(entry) && entry.name === FORMASPEC_CODEX_IDENTITY.pluginName
  ));
  if (managedEntries.length !== 1) {
    throw new Error("Managed FormaSpec Codex marketplace must contain exactly one formaspec plugin entry.");
  }
  const source = managedEntries[0]?.source;
  if (!isRecord(source) || source.source !== "local" || source.path !== "./plugins/formaspec") {
    throw new Error("Managed FormaSpec Codex marketplace must resolve the plugin from ./plugins/formaspec.");
  }

  requireSkillIdentity(readText(root, "skills/formaspec/SKILL.md"), "Managed FormaSpec Codex skill");
  requireOpenAiIdentity(
    readText(root, "skills/formaspec/agents/openai.yaml"),
    "Managed FormaSpec Codex skill metadata",
  );
  requireSkillIdentity(
    readText(root, "codex-marketplace/plugins/formaspec/skills/formaspec/SKILL.md"),
    "Managed FormaSpec Codex plugin skill",
  );
  requireOpenAiIdentity(
    readText(root, "codex-marketplace/plugins/formaspec/skills/formaspec/agents/openai.yaml"),
    "Managed FormaSpec Codex plugin skill metadata",
  );

  return { ...FORMASPEC_CODEX_IDENTITY };
}
