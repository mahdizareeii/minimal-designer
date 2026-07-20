import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { BridgeController } from "./bridge-lifecycle.js";
import { findExecutable, type CommandRunner } from "./process.js";

const MANAGED_MARKER = ".formaspec-managed.json";
const MANAGER_ID = "formaspecctl";
const MAX_CODEX_CONFIG_BYTES = 4 * 1024 * 1024;

interface CodexMcpConfiguration {
  transport?: {
    type?: unknown;
    url?: unknown;
    bearer_token_env_var?: unknown;
    http_headers?: unknown;
    env_http_headers?: unknown;
  };
}

export interface ConnectCodexOptions {
  environment: NodeJS.ProcessEnv;
  commandRunner: CommandRunner;
  bridge: BridgeController;
  confirm: (message: string) => Promise<boolean>;
  assumeYes: boolean;
}

export interface ConnectCodexResult {
  codexPath: string;
  mcpUrl: string;
  skillPath: string;
  pluginPath: string;
  marketplacePath: string;
  changedMcp: boolean;
  changedPlugin: boolean;
  changedApprovalPolicy: boolean;
}

function resolveCodexHome(environment: NodeJS.ProcessEnv): string {
  const configured = environment.CODEX_HOME;
  if (configured !== undefined && configured.trim() !== "") {
    if (!path.isAbsolute(configured)) throw new Error("CODEX_HOME must be an absolute path.");
    return path.normalize(configured);
  }
  const home = environment.HOME ?? environment.USERPROFILE;
  if (home === undefined || !path.isAbsolute(home)) throw new Error("A valid home directory is required to install the Codex skill.");
  return path.join(path.normalize(home), ".codex");
}

function isManagedSkill(target: string): boolean {
  if (!fs.existsSync(target)) return true;
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(target, MANAGED_MARKER), "utf8")) as {
      manager?: unknown;
      schemaVersion?: unknown;
    };
    return marker.manager === MANAGER_ID && marker.schemaVersion === 1;
  } catch {
    return false;
  }
}

function installManagedSkill(target: string): void {
  const source = fileURLToPath(new URL("../assets/skills/minimal-ui", import.meta.url));
  if (!fs.existsSync(path.join(source, "SKILL.md"))) throw new Error("Bundled minimal-ui skill is missing.");
  if (!isManagedSkill(target)) {
    throw new Error(`Refusing to overwrite the unmanaged Codex skill at ${target}. Move or rename it first.`);
  }
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stage = path.join(parent, `.minimal-ui.stage-${process.pid}`);
  const previous = path.join(parent, `.minimal-ui.previous-${process.pid}`);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.rmSync(previous, { recursive: true, force: true });
  fs.cpSync(source, stage, { recursive: true, errorOnExist: true });
  fs.writeFileSync(path.join(stage, MANAGED_MARKER), `${JSON.stringify({
    manager: MANAGER_ID,
    schemaVersion: 1,
    installedAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });
  try {
    if (fs.existsSync(target)) fs.renameSync(target, previous);
    fs.renameSync(stage, target);
    fs.rmSync(previous, { recursive: true, force: true });
  } catch (error) {
    if (!fs.existsSync(target) && fs.existsSync(previous)) fs.renameSync(previous, target);
    throw error;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

function installManagedMarketplace(target: string): void {
  const source = fileURLToPath(new URL("../assets/codex-marketplace", import.meta.url));
  if (!fs.existsSync(path.join(source, ".agents", "plugins", "marketplace.json"))
    || !fs.existsSync(path.join(source, "plugins", "minimal-ui", ".codex-plugin", "plugin.json"))) {
    throw new Error("Bundled Minimal UI Codex plugin marketplace is missing.");
  }
  if (!isManagedSkill(target)) {
    throw new Error(`Refusing to overwrite the unmanaged Codex marketplace at ${target}. Move or rename it first.`);
  }
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stage = path.join(parent, `.formaspec-marketplace.stage-${process.pid}`);
  const previous = path.join(parent, `.formaspec-marketplace.previous-${process.pid}`);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.rmSync(previous, { recursive: true, force: true });
  fs.cpSync(source, stage, { recursive: true, errorOnExist: true });
  fs.writeFileSync(path.join(stage, MANAGED_MARKER), `${JSON.stringify({
    manager: MANAGER_ID,
    schemaVersion: 1,
    installedAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });
  try {
    if (fs.existsSync(target)) fs.renameSync(target, previous);
    fs.renameSync(stage, target);
    fs.rmSync(previous, { recursive: true, force: true });
  } catch (error) {
    if (!fs.existsSync(target) && fs.existsSync(previous)) fs.renameSync(previous, target);
    throw error;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

function parseMarketplaceRoot(stdout: string, marketplaceName: string): string | undefined {
  try {
    const value = JSON.parse(stdout) as { marketplaces?: Array<{ name?: unknown; root?: unknown }> };
    const marketplace = value.marketplaces?.find((candidate) => candidate.name === marketplaceName);
    return typeof marketplace?.root === "string" ? path.normalize(marketplace.root) : undefined;
  } catch {
    return undefined;
  }
}

function installedPluginVersion(stdout: string, pluginId: string): string | undefined {
  try {
    const value = JSON.parse(stdout) as { installed?: Array<{ pluginId?: unknown; version?: unknown; installed?: unknown }> };
    const plugin = value.installed?.find((candidate) => candidate.pluginId === pluginId && candidate.installed === true);
    return typeof plugin?.version === "string" ? plugin.version : undefined;
  } catch {
    return undefined;
  }
}

function isDesiredConfiguration(stdout: string, mcpUrl: string): boolean {
  try {
    const configuration = JSON.parse(stdout) as CodexMcpConfiguration;
    return configuration.transport?.type === "streamable_http"
      && configuration.transport.url === mcpUrl
      && configuration.transport.bearer_token_env_var == null
      && configuration.transport.http_headers == null
      && configuration.transport.env_http_headers == null;
  } catch {
    return false;
  }
}

function ensureManagedMcpApprovalPolicy(codexHome: string): boolean {
  const configPath = path.join(codexHome, "config.toml");
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("Codex saved the MCP entry but its configuration file is unavailable.");
    }
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CODEX_CONFIG_BYTES) {
    throw new Error("Codex configuration is not a safe bounded regular file.");
  }
  const original = fs.readFileSync(configPath, "utf8");
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original.split(/\r?\n/);
  const tableIndexes = lines.flatMap((line, index) => line.trim() === "[mcp_servers.formaspec]" ? [index] : []);
  if (tableIndexes.length !== 1) {
    throw new Error("Codex configuration must contain exactly one managed [mcp_servers.formaspec] table.");
  }
  const tableStart = tableIndexes[0]!;
  let tableEnd = lines.length;
  for (let index = tableStart + 1; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index]!)) {
      tableEnd = index;
      break;
    }
  }
  const policyIndexes: number[] = [];
  for (let index = tableStart + 1; index < tableEnd; index += 1) {
    if (/^\s*default_tools_approval_mode\s*=/.test(lines[index]!)) policyIndexes.push(index);
  }
  if (policyIndexes.length > 1) throw new Error("Codex FormaSpec MCP approval policy is duplicated.");
  const desired = 'default_tools_approval_mode = "writes"';
  if (policyIndexes.length === 1 && lines[policyIndexes[0]!]!.trim() === desired) return false;
  if (policyIndexes.length === 1) {
    lines[policyIndexes[0]!] = desired;
  } else {
    let insertionIndex = tableStart + 1;
    for (let index = tableStart + 1; index < tableEnd; index += 1) {
      if (/^\s*url\s*=/.test(lines[index]!)) insertionIndex = index + 1;
    }
    lines.splice(insertionIndex, 0, desired);
  }
  const updated = lines.join(newline);
  const temporary = path.join(codexHome, `.config.toml.formaspec-${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    const fileMode = stat.mode & 0o777;
    descriptor = fs.openSync(temporary, "wx", fileMode === 0 ? 0o600 : fileMode);
    fs.writeFileSync(descriptor, updated, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, configPath);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
  return true;
}

export async function connectCodex(options: ConnectCodexOptions): Promise<ConnectCodexResult> {
  const codexPath = findExecutable("codex", options.environment);
  if (codexPath === null) throw new Error("Codex CLI was not found in a trusted absolute PATH entry.");
  const version = await options.commandRunner(codexPath, ["--version"], {
    env: options.environment,
    timeoutMs: 10_000,
  });
  if (version.exitCode !== 0) throw new Error("Codex CLI was found but could not run.");

  const codexHome = resolveCodexHome(options.environment);
  const skillPath = path.join(codexHome, "skills", "minimal-ui");
  const marketplacePath = path.join(codexHome, "formaspec-marketplace");
  const pluginPath = path.join(marketplacePath, "plugins", "minimal-ui");
  if (!isManagedSkill(skillPath)) {
    throw new Error(`Refusing to overwrite the unmanaged Codex skill at ${skillPath}. Move or rename it first.`);
  }
  if (!isManagedSkill(marketplacePath)) {
    throw new Error(`Refusing to overwrite the unmanaged Codex marketplace at ${marketplacePath}. Move or rename it first.`);
  }
  if (!options.assumeYes && !await options.confirm(
    `Allow FormaSpec to configure the 'formaspec' MCP server and install the managed Minimal UI skill/plugin in ${codexHome}?`,
  )) {
    throw new Error("Codex connection was cancelled; no Codex files were changed.");
  }

  const bridge = await options.bridge.ensureStarted();
  await options.bridge.authorizeAgent();
  const mcpUrl = `${bridge.url}/mcp`;
  const existing = await options.commandRunner(codexPath, ["mcp", "get", "formaspec", "--json"], {
    env: options.environment,
    timeoutMs: 15_000,
  });
  const changedMcp = existing.exitCode !== 0 || !isDesiredConfiguration(existing.stdout, mcpUrl);
  if (changedMcp) {
    const added = await options.commandRunner(codexPath, ["mcp", "add", "formaspec", "--url", mcpUrl], {
      env: options.environment,
      timeoutMs: 15_000,
    });
    if (added.exitCode !== 0) throw new Error("Codex could not save the FormaSpec MCP configuration.");
  }
  const changedApprovalPolicy = ensureManagedMcpApprovalPolicy(codexHome);
  const verified = await options.commandRunner(codexPath, ["mcp", "get", "formaspec"], {
    env: options.environment,
    timeoutMs: 15_000,
  });
  if (verified.exitCode !== 0) throw new Error("Codex could not verify the FormaSpec MCP configuration.");
  const verifiedJson = await options.commandRunner(codexPath, ["mcp", "get", "formaspec", "--json"], {
    env: options.environment,
    timeoutMs: 15_000,
  });
  if (verifiedJson.exitCode !== 0 || !isDesiredConfiguration(verifiedJson.stdout, mcpUrl)) {
    throw new Error("Codex verification returned an unexpected or credential-bearing MCP configuration.");
  }
  installManagedMarketplace(marketplacePath);
  const marketplaceList = await options.commandRunner(codexPath, ["plugin", "marketplace", "list", "--json"], {
    env: options.environment,
    timeoutMs: 15_000,
  });
  if (marketplaceList.exitCode !== 0) throw new Error("Codex could not inspect configured plugin marketplaces.");
  const configuredRoot = parseMarketplaceRoot(marketplaceList.stdout, "formaspec");
  if (configuredRoot !== undefined && configuredRoot !== path.normalize(marketplacePath)) {
    throw new Error(`Codex already has a different marketplace named formaspec at ${configuredRoot}.`);
  }
  if (configuredRoot === undefined) {
    const marketplaceAdded = await options.commandRunner(
      codexPath,
      ["plugin", "marketplace", "add", marketplacePath, "--json"],
      { env: options.environment, timeoutMs: 20_000 },
    );
    if (marketplaceAdded.exitCode !== 0) throw new Error("Codex could not register the managed FormaSpec plugin marketplace.");
  }
  const plugins = await options.commandRunner(codexPath, ["plugin", "list", "--json"], {
    env: options.environment,
    timeoutMs: 15_000,
  });
  if (plugins.exitCode !== 0) throw new Error("Codex could not inspect installed plugins.");
  const changedPlugin = installedPluginVersion(plugins.stdout, "minimal-ui@formaspec") !== "0.2.0";
  if (changedPlugin) {
    const pluginAdded = await options.commandRunner(codexPath, ["plugin", "add", "minimal-ui@formaspec", "--json"], {
      env: options.environment,
      timeoutMs: 20_000,
    });
    if (pluginAdded.exitCode !== 0) throw new Error("Codex could not install the managed Minimal UI plugin.");
  }
  installManagedSkill(skillPath);
  return { codexPath, mcpUrl, skillPath, pluginPath, marketplacePath, changedMcp, changedPlugin, changedApprovalPolicy };
}
