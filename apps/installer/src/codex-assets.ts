import fs from "node:fs";
import path from "node:path";

const MAX_MANAGED_ASSET_BYTES = 256 * 1024;
const MANAGED_PLUGIN_VERSION = "0.4.0";

export interface ManagedCodexAssetIdentity {
  skillName: string;
  pluginName: string;
  marketplaceName: string;
  pluginId: string;
  displayName: string;
  mention: string;
}

export interface ManagedCodexAssetInventory {
  marketplaceName: string;
  marketplaceDisplayName: string;
  pluginVersion: string;
  identities: readonly ManagedCodexAssetIdentity[];
}

export const FORMASPEC_CODEX_IDENTITY: ManagedCodexAssetIdentity = Object.freeze({
  skillName: "formaspec",
  pluginName: "formaspec",
  marketplaceName: "formaspec",
  pluginId: "formaspec@formaspec",
  displayName: "FormaSpec",
  mention: "[@FormaSpec](plugin://formaspec@formaspec)",
});

export const FORMASPEC_CODEX_ASSET_INVENTORY: ManagedCodexAssetInventory = Object.freeze({
  marketplaceName: "formaspec",
  marketplaceDisplayName: "FormaSpec",
  pluginVersion: MANAGED_PLUGIN_VERSION,
  identities: Object.freeze([FORMASPEC_CODEX_IDENTITY]),
});

const REQUIRED_MANAGED_FILES = Object.freeze([
  "codex-marketplace/.agents/plugins/marketplace.json",
  ...FORMASPEC_CODEX_ASSET_INVENTORY.identities.flatMap((identity) => [
    `codex-marketplace/plugins/${identity.pluginName}/.codex-plugin/plugin.json`,
    `codex-marketplace/plugins/${identity.pluginName}/skills/${identity.skillName}/SKILL.md`,
    `codex-marketplace/plugins/${identity.pluginName}/skills/${identity.skillName}/agents/openai.yaml`,
  ]),
]);

const FORBIDDEN_LEGACY_MANAGED_PATHS = Object.freeze([
  "skills/formaspec",
  "skills/minimal-ui",
  "codex-marketplace/plugins/minimal-ui",
]);

function requireNoRetiredPublicIdentity(contents: string, description: string): void {
  if (/minimal-ui|minimal ui/iu.test(contents)) {
    throw new Error(`${description} must not advertise a retired agent identity.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

function requireInterfaceDisplayName(
  value: Record<string, unknown>,
  displayName: string,
  description: string,
): void {
  if (!isRecord(value.interface) || value.interface.displayName !== displayName) {
    throw new Error(`${description} must display the managed agent as ${displayName}.`);
  }
}

function requireSkillIdentity(contents: string, identity: ManagedCodexAssetIdentity, description: string): void {
  if (!new RegExp(`^name:\\s*${identity.skillName}\\s*$`, "mu").test(contents)) {
    throw new Error(`${description} must use the managed ${identity.skillName} skill name.`);
  }
}

function requireOpenAiIdentity(contents: string, identity: ManagedCodexAssetIdentity, description: string): void {
  const displayName = identity.displayName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const skillName = identity.skillName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`^\\s*display_name:\\s*["']${displayName}["']\\s*$`, "mu").test(contents)
    || !new RegExp(`^\\s*default_prompt:\\s*["'][^"']*\\$${skillName}\\b[^"']*["']\\s*$`, "mu").test(contents)) {
    throw new Error(`${description} must expose the managed $${identity.skillName} agent identity.`);
  }
}

export function inspectManagedCodexAssets(assetsRoot: string): ManagedCodexAssetInventory {
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
  for (const relativePath of REQUIRED_MANAGED_FILES) requireRegularFile(root, relativePath);
  for (const relativePath of FORBIDDEN_LEGACY_MANAGED_PATHS) {
    if (fs.existsSync(path.join(root, ...relativePath.split("/")))) {
      throw new Error(`Legacy duplicate FormaSpec Codex asset must not be packaged: ${relativePath}`);
    }
  }

  const marketplacePath = "codex-marketplace/.agents/plugins/marketplace.json";
  requireNoRetiredPublicIdentity(readText(root, marketplacePath), "Managed FormaSpec Codex marketplace");
  const marketplace = readJson(root, marketplacePath);
  if (marketplace.name !== FORMASPEC_CODEX_ASSET_INVENTORY.marketplaceName) {
    throw new Error("Managed FormaSpec Codex marketplace must use the formaspec marketplace name.");
  }
  requireInterfaceDisplayName(
    marketplace,
    FORMASPEC_CODEX_ASSET_INVENTORY.marketplaceDisplayName,
    "Managed FormaSpec Codex marketplace",
  );
  if (!Array.isArray(marketplace.plugins)) {
    throw new Error("Managed FormaSpec Codex marketplace plugin inventory is malformed.");
  }
  if (marketplace.plugins.length !== FORMASPEC_CODEX_ASSET_INVENTORY.identities.length) {
    throw new Error("Managed FormaSpec Codex marketplace must contain exactly one managed agent identity.");
  }

  for (const identity of FORMASPEC_CODEX_ASSET_INVENTORY.identities) {
    const pluginPath = `codex-marketplace/plugins/${identity.pluginName}/.codex-plugin/plugin.json`;
    requireNoRetiredPublicIdentity(
      readText(root, pluginPath),
      `Managed ${identity.displayName} Codex plugin manifest`,
    );
    const plugin = readJson(root, pluginPath);
    if (plugin.name !== identity.pluginName || plugin.version !== MANAGED_PLUGIN_VERSION) {
      throw new Error(`Managed ${identity.displayName} Codex plugin manifest must use ${identity.pluginName} at ${MANAGED_PLUGIN_VERSION}.`);
    }
    requireInterfaceDisplayName(plugin, identity.displayName, `Managed ${identity.displayName} Codex plugin manifest`);

    const managedEntries = marketplace.plugins.filter((entry): entry is Record<string, unknown> => (
      isRecord(entry) && entry.name === identity.pluginName
    ));
    if (managedEntries.length !== 1) {
      throw new Error(`Managed FormaSpec Codex marketplace must contain exactly one ${identity.pluginName} plugin entry.`);
    }
    const source = managedEntries[0]?.source;
    const policy = managedEntries[0]?.policy;
    if (!isRecord(source) || source.source !== "local" || source.path !== `./plugins/${identity.pluginName}`) {
      throw new Error(`Managed FormaSpec Codex marketplace must resolve the plugin from ./plugins/${identity.pluginName}.`);
    }
    if (!isRecord(policy)
      || policy.installation !== "AVAILABLE"
      || policy.authentication !== "ON_INSTALL"
      || managedEntries[0]?.category !== "Productivity") {
      throw new Error(`Managed ${identity.displayName} Codex marketplace policy is invalid.`);
    }

    const pluginSkill = readText(root, `codex-marketplace/plugins/${identity.pluginName}/skills/${identity.skillName}/SKILL.md`);
    requireNoRetiredPublicIdentity(pluginSkill, `Managed ${identity.displayName} Codex plugin skill`);
    requireSkillIdentity(
      pluginSkill,
      identity,
      `Managed ${identity.displayName} Codex plugin skill`,
    );
    const pluginMetadata = readText(
      root,
      `codex-marketplace/plugins/${identity.pluginName}/skills/${identity.skillName}/agents/openai.yaml`,
    );
    requireNoRetiredPublicIdentity(pluginMetadata, `Managed ${identity.displayName} Codex plugin skill metadata`);
    requireOpenAiIdentity(
      pluginMetadata,
      identity,
      `Managed ${identity.displayName} Codex plugin skill metadata`,
    );
  }

  return {
    ...FORMASPEC_CODEX_ASSET_INVENTORY,
    identities: FORMASPEC_CODEX_ASSET_INVENTORY.identities.map((identity) => ({ ...identity })),
  };
}
