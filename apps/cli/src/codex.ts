import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  FORMASPEC_ESSENTIAL_MCP_TOOLS,
  type AgentPairingTicket,
  type BridgeController,
} from "./bridge-lifecycle.js";
import { findExecutable, type CommandRunner } from "./process.js";

const MANAGED_MARKER = ".formaspec-managed.json";
const MANAGER_ID = "formaspecctl";
const MAX_CODEX_CONFIG_BYTES = 4 * 1024 * 1024;
const FORMASPEC_PLUGIN_VERSION = "0.3.0";

export const FORMASPEC_CODEX_PLUGIN_ID = "formaspec@formaspec";
export const FORMASPEC_CODEX_MENTION = "[@FormaSpec](plugin://formaspec@formaspec)";
const LEGACY_MINIMAL_UI_CODEX_PLUGIN_ID = "minimal-ui@formaspec";

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
  pairing?: AgentPairingTicket;
}

export interface ConnectCodexResult {
  codexPath: string;
  mcpUrl: string;
  pluginPath: string;
  pluginSkillPath: string;
  marketplacePath: string;
  removedManagedStandaloneSkillPaths: string[];
  removedLegacyMinimalUiPlugin: boolean;
  changedMcp: boolean;
  changedPlugin: boolean;
  changedApprovalPolicy: boolean;
}

export interface InspectManagedCodexOptions {
  environment: NodeJS.ProcessEnv;
  commandRunner: CommandRunner;
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

function hasManagedMarker(target: string): boolean {
  if (!fs.existsSync(target)) return false;
  try {
    const targetStat = fs.lstatSync(target);
    if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) return false;
    const markerPath = path.join(target, MANAGED_MARKER);
    const markerStat = fs.lstatSync(markerPath);
    if (!markerStat.isFile() || markerStat.isSymbolicLink()) return false;
    const marker = JSON.parse(fs.readFileSync(path.join(target, MANAGED_MARKER), "utf8")) as {
      manager?: unknown;
      schemaVersion?: unknown;
    };
    return marker.manager === MANAGER_ID && marker.schemaVersion === 1;
  } catch {
    return false;
  }
}

function isManagedInstallTarget(target: string): boolean {
  return !fs.existsSync(target) || hasManagedMarker(target);
}

function assertManagedStandaloneSkillOrAbsent(target: string, displayName: string): void {
  if (fs.existsSync(target) && !hasManagedMarker(target)) {
    throw new Error(
      `Unmanaged ${displayName} Codex skill collision at ${target}. FormaSpec preserved it; move or rename it before reconnecting.`,
    );
  }
}

function removeManagedStandaloneSkill(target: string): boolean {
  if (!fs.existsSync(target)) return false;
  if (!hasManagedMarker(target)) {
    throw new Error(`Refusing to remove the unmanaged Codex skill at ${target}.`);
  }
  fs.rmSync(target, { recursive: true, force: false });
  return true;
}

function installManagedMarketplace(target: string): void {
  const source = fileURLToPath(new URL("../assets/codex-marketplace", import.meta.url));
  if (!fs.existsSync(path.join(source, ".agents", "plugins", "marketplace.json"))
    || !fs.existsSync(path.join(source, "plugins", "formaspec", ".codex-plugin", "plugin.json"))) {
    throw new Error("Bundled FormaSpec Codex plugin marketplace is missing.");
  }
  if (!isManagedInstallTarget(target)) {
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
    const value = JSON.parse(stdout) as {
      installed?: Array<{ pluginId?: unknown; version?: unknown; installed?: unknown; enabled?: unknown }>;
    };
    const plugin = value.installed?.find((candidate) => candidate.pluginId === pluginId
      && candidate.installed === true && candidate.enabled === true);
    return typeof plugin?.version === "string" ? plugin.version : undefined;
  } catch {
    return undefined;
  }
}

function hasInstalledPlugin(stdout: string, pluginId: string): boolean {
  try {
    const value = JSON.parse(stdout) as {
      installed?: Array<{ pluginId?: unknown; installed?: unknown }>;
    };
    return value.installed?.some((candidate) => candidate.pluginId === pluginId && candidate.installed === true) === true;
  } catch {
    return false;
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

function isCredentialFreeLoopbackConfiguration(stdout: string): boolean {
  try {
    const configuration = JSON.parse(stdout) as CodexMcpConfiguration;
    if (configuration.transport?.type !== "streamable_http"
      || typeof configuration.transport.url !== "string"
      || configuration.transport.bearer_token_env_var != null
      || configuration.transport.http_headers != null
      || configuration.transport.env_http_headers != null) return false;
    const url = new URL(configuration.transport.url);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return url.protocol === "http:"
      && ["127.0.0.1", "::1", "localhost"].includes(host)
      && url.pathname === "/mcp"
      && !url.username
      && !url.password
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}

export async function isManagedCodexInstall(options: InspectManagedCodexOptions): Promise<boolean> {
  const codexPath = findExecutable("codex", options.environment);
  if (codexPath === null) return false;
  let codexHome: string;
  try {
    codexHome = resolveCodexHome(options.environment);
  } catch {
    return false;
  }
  const managedTargets = [
    path.join(codexHome, "skills", "formaspec"),
    path.join(codexHome, "skills", "minimal-ui"),
    path.join(codexHome, "formaspec-marketplace"),
  ];
  if (!hasManagedMarker(managedTargets[2]!)) return false;
  if (managedTargets.slice(0, 2).some((target) => fs.existsSync(target) && !hasManagedMarker(target))) return false;
  const existing = await options.commandRunner(codexPath, ["mcp", "get", "formaspec", "--json"], {
    env: options.environment,
    timeoutMs: 15_000,
  });
  if (existing.exitCode !== 0 || !isCredentialFreeLoopbackConfiguration(existing.stdout)) return false;
  const marketplaceList = await options.commandRunner(codexPath, ["plugin", "marketplace", "list", "--json"], {
    env: options.environment,
    timeoutMs: 15_000,
  });
  if (marketplaceList.exitCode !== 0) return false;
  const configuredRoot = parseMarketplaceRoot(marketplaceList.stdout, "formaspec");
  return configuredRoot === undefined || configuredRoot === path.normalize(managedTargets[2]!);
}

interface CodexConfigText {
  configPath: string;
  stat: fs.Stats;
  newline: "\n" | "\r\n";
  lines: string[];
}

function readCodexConfigText(codexHome: string): CodexConfigText {
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
  return {
    configPath,
    stat,
    newline: original.includes("\r\n") ? "\r\n" : "\n",
    lines: original.split(/\r?\n/),
  };
}

function codexConfigTableRange(lines: string[], header: string): { start: number; end: number } | undefined {
  const expected = parseTomlTableHeader(header);
  if (expected === undefined) throw new Error(`Invalid internal Codex configuration table header: ${header}`);
  const headers = scanTomlTableHeaders(lines);
  const tableIndexes = headers.flatMap((candidate, index) => candidate.array === expected.array
    && candidate.path.length === expected.path.length
    && candidate.path.every((segment, segmentIndex) => segment === expected.path[segmentIndex])
    ? [index]
    : []);
  if (tableIndexes.length > 1) throw new Error(`Codex configuration contains a duplicate ${header} table.`);
  const tableIndex = tableIndexes[0];
  if (tableIndex === undefined) return undefined;
  return { start: headers[tableIndex]!.line, end: headers[tableIndex + 1]?.line ?? lines.length };
}

function writeCodexConfigText(codexHome: string, config: CodexConfigText, lines: string[]): void {
  const updated = lines.join(config.newline);
  const temporary = path.join(codexHome, `.config.toml.formaspec-${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    const fileMode = config.stat.mode & 0o777;
    descriptor = fs.openSync(temporary, "wx", fileMode === 0 ? 0o600 : fileMode);
    fs.writeFileSync(descriptor, updated, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, config.configPath);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}

function ensureManagedMcpApprovalPolicy(codexHome: string): boolean {
  const config = readCodexConfigText(codexHome);
  const table = codexConfigTableRange(config.lines, "[mcp_servers.formaspec]");
  if (!table) {
    throw new Error("Codex configuration must contain exactly one managed [mcp_servers.formaspec] table.");
  }
  const { start: tableStart, end: tableEnd } = table;
  const policyIndexes: number[] = [];
  for (let index = tableStart + 1; index < tableEnd; index += 1) {
    if (/^\s*default_tools_approval_mode\s*=/.test(config.lines[index]!)) policyIndexes.push(index);
  }
  if (policyIndexes.length > 1) throw new Error("Codex FormaSpec MCP approval policy is duplicated.");
  const desired = 'default_tools_approval_mode = "writes"';
  if (policyIndexes.length === 1 && config.lines[policyIndexes[0]!]!.trim() === desired) return false;
  if (policyIndexes.length === 1) {
    config.lines[policyIndexes[0]!] = desired;
  } else {
    let insertionIndex = tableStart + 1;
    for (let index = tableStart + 1; index < tableEnd; index += 1) {
      if (/^\s*url\s*=/.test(config.lines[index]!)) insertionIndex = index + 1;
    }
    config.lines.splice(insertionIndex, 0, desired);
  }
  writeCodexConfigText(codexHome, config, config.lines);
  return true;
}

type TomlMultilineString = "basic" | "literal" | undefined;

interface TomlTableHeader {
  line: number;
  path: string[];
  array: boolean;
}

function isTomlWhitespace(character: string | undefined): boolean {
  return character === " " || character === "\t";
}

function parseTomlBasicKey(line: string, start: number): { value: string; end: number } | undefined {
  let value = "";
  for (let index = start + 1; index < line.length; index += 1) {
    const character = line[index]!;
    if (character === '"') return { value, end: index + 1 };
    if (character !== "\\") {
      value += character;
      continue;
    }
    const escape = line[index + 1];
    const simpleEscapes: Record<string, string> = {
      b: "\b",
      t: "\t",
      n: "\n",
      f: "\f",
      r: "\r",
      '"': '"',
      "\\": "\\",
    };
    if (escape !== undefined && simpleEscapes[escape] !== undefined) {
      value += simpleEscapes[escape];
      index += 1;
      continue;
    }
    const digits = escape === "u" ? 4 : escape === "U" ? 8 : 0;
    if (digits === 0) return undefined;
    const hexadecimal = line.slice(index + 2, index + 2 + digits);
    if (hexadecimal.length !== digits || !/^[0-9A-Fa-f]+$/.test(hexadecimal)) return undefined;
    const codePoint = Number.parseInt(hexadecimal, 16);
    if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return undefined;
    value += String.fromCodePoint(codePoint);
    index += digits + 1;
  }
  return undefined;
}

function parseTomlLiteralKey(line: string, start: number): { value: string; end: number } | undefined {
  const end = line.indexOf("'", start + 1);
  return end === -1 ? undefined : { value: line.slice(start + 1, end), end: end + 1 };
}

function parseTomlTableHeader(line: string): { path: string[]; array: boolean } | undefined {
  let index = 0;
  while (isTomlWhitespace(line[index])) index += 1;
  if (line[index] !== "[") return undefined;
  const isArrayTable = line[index + 1] === "[";
  index += isArrayTable ? 2 : 1;

  const path: string[] = [];
  while (index < line.length) {
    while (isTomlWhitespace(line[index])) index += 1;
    let key: { value: string; end: number } | undefined;
    if (line[index] === '"') {
      key = parseTomlBasicKey(line, index);
    } else if (line[index] === "'") {
      key = parseTomlLiteralKey(line, index);
    } else {
      const match = /^[A-Za-z0-9_-]+/.exec(line.slice(index));
      if (match !== null) key = { value: match[0], end: index + match[0].length };
    }
    if (key === undefined) return undefined;
    path.push(key.value);
    index = key.end;
    while (isTomlWhitespace(line[index])) index += 1;

    if (line[index] === ".") {
      index += 1;
      continue;
    }
    if (isArrayTable ? line.slice(index, index + 2) !== "]]" : line[index] !== "]") return undefined;
    index += isArrayTable ? 2 : 1;
    while (isTomlWhitespace(line[index])) index += 1;
    return index === line.length || line[index] === "#" ? { path, array: isArrayTable } : undefined;
  }
  return undefined;
}

function tomlMultilineStringAfterLine(line: string, initial: TomlMultilineString): TomlMultilineString {
  let multiline = initial;
  for (let index = 0; index < line.length;) {
    if (multiline === "basic") {
      if (line.startsWith('"""', index)) {
        multiline = undefined;
        index += 3;
      } else if (line[index] === "\\") {
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }
    if (multiline === "literal") {
      if (line.startsWith("'''", index)) {
        multiline = undefined;
        index += 3;
      } else {
        index += 1;
      }
      continue;
    }

    if (line[index] === "#") break;
    if (line.startsWith('"""', index)) {
      multiline = "basic";
      index += 3;
      continue;
    }
    if (line.startsWith("'''", index)) {
      multiline = "literal";
      index += 3;
      continue;
    }
    if (line[index] === '"') {
      index += 1;
      while (index < line.length && line[index] !== '"') {
        index += line[index] === "\\" ? 2 : 1;
      }
      index += line[index] === '"' ? 1 : 0;
      continue;
    }
    if (line[index] === "'") {
      const end = line.indexOf("'", index + 1);
      index = end === -1 ? line.length : end + 1;
      continue;
    }
    index += 1;
  }
  return multiline;
}

function scanTomlTableHeaders(lines: string[]): TomlTableHeader[] {
  const headers: TomlTableHeader[] = [];
  let multiline: TomlMultilineString;
  for (let line = 0; line < lines.length; line += 1) {
    if (multiline === undefined) {
      const table = parseTomlTableHeader(lines[line]!);
      if (table !== undefined) headers.push({ line, ...table });
    }
    multiline = tomlMultilineStringAfterLine(lines[line]!, multiline);
  }
  return headers;
}

function legacyMinimalUiPluginTableRanges(lines: string[]): Array<{ start: number; end: number }> {
  const targetPath = ["plugins", LEGACY_MINIMAL_UI_CODEX_PLUGIN_ID];
  const headers = scanTomlTableHeaders(lines);
  return headers.flatMap((header, index) => header.path.length >= targetPath.length
    && targetPath.every((segment, segmentIndex) => header.path[segmentIndex] === segment)
    ? [{
      start: header.line,
      end: headers[index + 1]?.line ?? (lines.at(-1) === "" ? lines.length - 1 : lines.length),
    }]
    : []);
}

function removeLegacyMinimalUiPluginConfiguration(codexHome: string): boolean {
  const config = readCodexConfigText(codexHome);
  const ranges = legacyMinimalUiPluginTableRanges(config.lines);
  if (ranges.length === 0) return false;
  for (const range of [...ranges].reverse()) {
    config.lines.splice(range.start, range.end - range.start);
  }
  writeCodexConfigText(codexHome, config, config.lines);
  const verified = readCodexConfigText(codexHome);
  if (legacyMinimalUiPluginTableRanges(verified.lines).length > 0) {
    throw new Error("Codex configuration still contains the exact legacy Minimal UI plugin table after cleanup.");
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
  const legacyFormaSpecSkillPath = path.join(codexHome, "skills", "formaspec");
  const legacyMinimalUiSkillPath = path.join(codexHome, "skills", "minimal-ui");
  const marketplacePath = path.join(codexHome, "formaspec-marketplace");
  const pluginPath = path.join(marketplacePath, "plugins", "formaspec");
  const pluginSkillPath = path.join(pluginPath, "skills", "formaspec");
  assertManagedStandaloneSkillOrAbsent(legacyFormaSpecSkillPath, "FormaSpec");
  assertManagedStandaloneSkillOrAbsent(legacyMinimalUiSkillPath, "legacy duplicate");
  if (!isManagedInstallTarget(marketplacePath)) {
    throw new Error(`Refusing to overwrite the unmanaged Codex marketplace at ${marketplacePath}. Move or rename it first.`);
  }
  if (!options.assumeYes && !await options.confirm(
    `Allow FormaSpec to configure the 'formaspec' MCP server, install the single managed FormaSpec plugin, and remove installer-owned legacy duplicate identities in ${codexHome}?`,
  )) {
    throw new Error("Codex connection was cancelled; no Codex files were changed.");
  }

  const bridge = await options.bridge.ensureStarted();
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
  const pluginsBeforeMarketplaceRefresh = await options.commandRunner(codexPath, ["plugin", "list", "--json"], {
    env: options.environment,
    timeoutMs: 15_000,
  });
  if (pluginsBeforeMarketplaceRefresh.exitCode !== 0) {
    throw new Error("Codex could not inspect installed plugins before refreshing the managed marketplace.");
  }
  const needsFormaSpecPluginInstall = installedPluginVersion(
    pluginsBeforeMarketplaceRefresh.stdout,
    FORMASPEC_CODEX_PLUGIN_ID,
  ) !== FORMASPEC_PLUGIN_VERSION;
  const hadLegacyMinimalUiPlugin = hasInstalledPlugin(
    pluginsBeforeMarketplaceRefresh.stdout,
    LEGACY_MINIMAL_UI_CODEX_PLUGIN_ID,
  );
  let changedPlugin = needsFormaSpecPluginInstall || hadLegacyMinimalUiPlugin;
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
  if (needsFormaSpecPluginInstall) {
    const pluginAdded = await options.commandRunner(codexPath, ["plugin", "add", FORMASPEC_CODEX_PLUGIN_ID, "--json"], {
      env: options.environment,
      timeoutMs: 20_000,
    });
    if (pluginAdded.exitCode !== 0) throw new Error("Codex could not install the managed FormaSpec plugin.");
  }
  const primaryPluginVerification = await options.commandRunner(codexPath, ["plugin", "list", "--json"], {
    env: options.environment,
    timeoutMs: 15_000,
  });
  if (primaryPluginVerification.exitCode !== 0
    || installedPluginVersion(primaryPluginVerification.stdout, FORMASPEC_CODEX_PLUGIN_ID) !== FORMASPEC_PLUGIN_VERSION) {
    throw new Error("Codex could not verify the FormaSpec 0.3.0 plugin before legacy identity removal.");
  }
  const hasLegacyMinimalUiPlugin = hasInstalledPlugin(
    primaryPluginVerification.stdout,
    LEGACY_MINIMAL_UI_CODEX_PLUGIN_ID,
  );
  if (hasLegacyMinimalUiPlugin) {
    const pluginRemoved = await options.commandRunner(codexPath, ["plugin", "remove", LEGACY_MINIMAL_UI_CODEX_PLUGIN_ID, "--json"], {
      env: options.environment,
      timeoutMs: 20_000,
    });
    if (pluginRemoved.exitCode !== 0) {
      throw new Error("Codex verified FormaSpec 0.3.0 but could not remove the legacy duplicate plugin; managed standalone skills were preserved for a safe retry.");
    }
  }
  const verifiedPlugins = await options.commandRunner(codexPath, ["plugin", "list", "--json"], {
    env: options.environment,
    timeoutMs: 15_000,
  });
  if (verifiedPlugins.exitCode !== 0
    || installedPluginVersion(verifiedPlugins.stdout, FORMASPEC_CODEX_PLUGIN_ID) !== FORMASPEC_PLUGIN_VERSION
    || hasInstalledPlugin(verifiedPlugins.stdout, LEGACY_MINIMAL_UI_CODEX_PLUGIN_ID)) {
    throw new Error("Codex could not verify a single installed FormaSpec identity after legacy cleanup.");
  }
  let removedLegacyMinimalUiPluginConfiguration: boolean;
  try {
    removedLegacyMinimalUiPluginConfiguration = removeLegacyMinimalUiPluginConfiguration(codexHome);
  } catch (error) {
    throw new Error(
      "Codex verified the single FormaSpec plugin but the exact legacy Minimal UI plugin configuration could not be removed safely; managed standalone skills were preserved for a safe retry.",
      { cause: error },
    );
  }
  changedPlugin ||= removedLegacyMinimalUiPluginConfiguration;
  const removedManagedStandaloneSkillPaths = [legacyFormaSpecSkillPath, legacyMinimalUiSkillPath]
    .filter((target) => removeManagedStandaloneSkill(target));
  // Consume the one-time ticket only after Codex configuration and the single
  // managed plugin are installed and verified. A local setup failure must
  // leave the pending ticket retryable instead of making the server advertise
  // an active connection that Codex cannot use.
  await options.bridge.authorizeAgent(options.pairing);
  const verification = await options.bridge.verifyAgent();
  if (!verification.verified
    || !verification.checks.includes("initialize")
    || !verification.checks.includes("tools/list")
    || verification.serverName !== "formaspec"
    || !FORMASPEC_ESSENTIAL_MCP_TOOLS.every((tool) => verification.essentialTools.includes(tool))) {
    throw new Error("The authorized FormaSpec MCP connection did not identify FormaSpec and expose its essential design-preview tools.");
  }
  return {
    codexPath,
    mcpUrl,
    pluginPath,
    pluginSkillPath,
    marketplacePath,
    removedManagedStandaloneSkillPaths,
    removedLegacyMinimalUiPlugin: hasLegacyMinimalUiPlugin,
    changedMcp,
    changedPlugin,
    changedApprovalPolicy,
  };
}
