import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveRuntimePaths } from "./runtime-paths.js";

interface BridgeState {
  schemaVersion: 1;
  pid: number;
  url: string;
  instanceId: string;
  buildId?: string;
  upstreamMcpUrl?: string;
}

interface BridgeHealthProbe {
  running: boolean;
  buildId: string | null;
}

export interface BridgeStatus {
  running: boolean;
  url: string;
  owned: boolean;
}

export const FORMASPEC_ESSENTIAL_MCP_TOOLS = [
  "organization_policy_read",
  "context_get",
  "design_list",
  "design_read",
  "node_search",
  "design_preview_changes",
  "design_render",
  "design_lint",
  "task_create",
  "task_read",
  "task_claim",
  "task_transition",
] as const;

export interface AgentVerification {
  verified: true;
  checks: string[];
  serverName: "formaspec";
  essentialTools: string[];
}

export interface BridgeController {
  ensureStarted(): Promise<BridgeStatus>;
  authorizeAgent(pairing?: AgentPairingTicket): Promise<{ connectionId: string; status: string; expiresAt: string | null }>;
  verifyAgent(): Promise<AgentVerification>;
  stop(): Promise<boolean>;
  status(): Promise<BridgeStatus>;
}

export interface AgentPairingTicket {
  nonce: string;
  connectionId?: string;
}

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) throw new Error("Bridge port is invalid.");
  return parsed;
}

function validateBridgeMcpUrl(value: string): void {
  const url = new URL(value);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (url.protocol !== "http:" || (host !== "127.0.0.1" && host !== "::1" && host !== "localhost")
    || url.pathname !== "/mcp" || url.username || url.password || url.search || url.hash) {
    throw new Error("Bridge MCP URL must be a credential-free loopback /mcp URL.");
  }
}

function readApiPort(runtimeDirectory: string): number {
  const portFile = path.join(runtimeDirectory, "run", "api-port");
  if (!fs.existsSync(portFile)) return 4310;
  try {
    const value = fs.readFileSync(portFile, "utf8").trim();
    return parsePort(value, 4310);
  } catch (error) {
    throw new Error(`Recorded API port is invalid: ${portFile}`, { cause: error });
  }
}

type UpstreamAuthMode = "none" | "session" | "trusted-header" | "token" | "unknown";

function normalizedAuthMode(value: string | undefined): UpstreamAuthMode | null {
  return value === "none" || value === "session" || value === "trusted-header" || value === "token" || value === "unknown"
    ? value
    : null;
}

function readBoundedRegularFile(filename: string, maximumBytes: number): string | null {
  try {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumBytes) return null;
    return fs.readFileSync(filename, "utf8");
  } catch {
    return null;
  }
}

function authModeFromEnvironmentFile(filename: string): UpstreamAuthMode | null {
  const contents = readBoundedRegularFile(filename, 16 * 1024);
  if (contents === null) return null;
  const values = contents.split(/\r?\n/).flatMap((line) => {
    const match = /^AUTH_MODE=(none|session|trusted-header|token)$/.exec(line.trim());
    return match ? [match[1]!] : [];
  });
  if (values.length !== 1) return null;
  return normalizedAuthMode(values[0]);
}

function recordedUpstreamAuthMode(runtimeDirectory: string, environment: NodeJS.ProcessEnv): UpstreamAuthMode {
  const explicit = normalizedAuthMode(environment.FORMASPEC_UPSTREAM_AUTH_MODE);
  if (explicit !== null) return explicit;
  const runDirectory = path.join(runtimeDirectory, "run");
  const mode = readBoundedRegularFile(path.join(runDirectory, "mode"), 64)?.trim();
  if (mode === "local" || mode === "dev") return "none";
  if (mode === "docker" || mode === "server") {
    const environmentFile = readBoundedRegularFile(path.join(runDirectory, "env-file"), 4096)?.trim();
    if (environmentFile && path.isAbsolute(environmentFile)) {
      const recorded = authModeFromEnvironmentFile(environmentFile);
      if (recorded !== null) return recorded;
    }
  }
  return normalizedAuthMode(environment.AUTH_MODE) ?? "unknown";
}

async function bridgeHealth(url: string): Promise<BridgeHealthProbe> {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(800) });
    if (!response.ok) return { running: false, buildId: null };
    const body = await response.json() as { service?: unknown; status?: unknown; buildId?: unknown };
    const running = body.service === "formaspec-local-bridge" && (body.status === "ok" || body.status === "stopping");
    return {
      running,
      buildId: running && typeof body.buildId === "string" ? body.buildId : null,
    };
  } catch {
    return { running: false, buildId: null };
  }
}

function collectRuntimeFiles(root: string, extension: ".js" | ".ts"): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.endsWith(extension)) files.push(absolute);
    }
  };
  visit(root);
  return files.sort((left, right) => left.localeCompare(right));
}

function runtimeBuildId(root: string, extension: ".js" | ".ts"): string {
  const hash = createHash("sha256");
  for (const file of collectRuntimeFiles(root, extension)) {
    hash.update(path.relative(root, file));
    hash.update("\0");
    hash.update(fs.readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function readState(statePath: string): BridgeState | null {
  try {
    const value = JSON.parse(fs.readFileSync(statePath, "utf8")) as Partial<BridgeState>;
    if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.pid) || typeof value.url !== "string"
      || typeof value.instanceId !== "string" || value.instanceId.length < 16
      || (value.upstreamMcpUrl !== undefined && typeof value.upstreamMcpUrl !== "string")) return null;
    validateBridgeMcpUrl(`${value.url}/mcp`);
    if (value.upstreamMcpUrl !== undefined) validateBridgeMcpUrl(value.upstreamMcpUrl);
    return value as BridgeState;
  } catch {
    return null;
  }
}

function writeState(statePath: string, state: BridgeState): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const temporary = `${statePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, statePath);
}

export function createBridgeController(projectRoot: string, environment: NodeJS.ProcessEnv): BridgeController {
  const bridgePort = parsePort(environment.FORMASPEC_BRIDGE_PORT, 4312);
  const bridgeUrl = `http://127.0.0.1:${bridgePort}`;
  validateBridgeMcpUrl(`${bridgeUrl}/mcp`);
  const paths = resolveRuntimePaths(projectRoot, environment);
  const runtimeDirectory = paths.runtimeDirectory;
  const runDirectory = paths.runDirectory;
  const statePath = path.join(runDirectory, "formaspec-bridge.json");
  const logPath = path.join(paths.logDirectory, "formaspec-bridge.log");
  const builtEntry = fileURLToPath(new URL("../../local-bridge/dist/index.js", import.meta.url));
  const sourceEntry = fileURLToPath(new URL("../../local-bridge/src/index.ts", import.meta.url));
  const tsxEntry = fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url));
  const resolveRuntime = (): { arguments: string[]; buildId: string } => {
    if (fs.existsSync(builtEntry)) {
      return {
        arguments: [builtEntry],
        buildId: runtimeBuildId(path.dirname(builtEntry), ".js"),
      };
    }
    if (fs.existsSync(sourceEntry) && fs.existsSync(tsxEntry)) {
      return {
        arguments: [tsxEntry, sourceEntry],
        buildId: runtimeBuildId(path.dirname(sourceEntry), ".ts"),
      };
    }
    throw new Error("The local bridge is neither built nor available through the workspace tsx runtime.");
  };

  return {
    async status(): Promise<BridgeStatus> {
      const state = readState(statePath);
      const probe = await bridgeHealth(bridgeUrl);
      return { running: probe.running, url: bridgeUrl, owned: probe.running && state?.url === bridgeUrl };
    },

    async ensureStarted(): Promise<BridgeStatus> {
      const runtime = resolveRuntime();
      const state = readState(statePath);
      const probe = await bridgeHealth(bridgeUrl);
      const upstreamMcpUrl = `http://127.0.0.1:${readApiPort(runtimeDirectory)}/mcp`;
      if (probe.running
        && probe.buildId === runtime.buildId
        && state?.url === bridgeUrl
        && state.upstreamMcpUrl === upstreamMcpUrl) {
        return { running: true, url: bridgeUrl, owned: true };
      }
      if (probe.running) {
        if (state?.url !== bridgeUrl) {
          throw new Error("An incompatible unowned process is already using the FormaSpec bridge port.");
        }
        await this.stop();
      }
      fs.rmSync(statePath, { force: true });
      fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
      const log = fs.openSync(logPath, "a", 0o600);
      const instanceId = randomUUID();
      const child = spawn(process.execPath, runtime.arguments, {
        shell: false,
        detached: true,
        stdio: ["ignore", log, log],
        env: {
          ...(environment.HOME === undefined ? {} : { HOME: environment.HOME }),
          ...(environment.USERPROFILE === undefined ? {} : { USERPROFILE: environment.USERPROFILE }),
          ...(environment.PATH === undefined ? {} : { PATH: environment.PATH }),
          ...(environment.TMPDIR === undefined ? {} : { TMPDIR: environment.TMPDIR }),
          ...(environment.TEMP === undefined ? {} : { TEMP: environment.TEMP }),
          ...(environment.TMP === undefined ? {} : { TMP: environment.TMP }),
          ...(environment.LANG === undefined ? {} : { LANG: environment.LANG }),
          ...(environment.LC_ALL === undefined ? {} : { LC_ALL: environment.LC_ALL }),
          ...(environment.TZ === undefined ? {} : { TZ: environment.TZ }),
          FORMASPEC_BRIDGE_HOST: "127.0.0.1",
          FORMASPEC_BRIDGE_PORT: String(bridgePort),
          FORMASPEC_BRIDGE_INSTANCE_ID: instanceId,
          FORMASPEC_BRIDGE_BUILD_ID: runtime.buildId,
          FORMASPEC_UPSTREAM_MCP_URL: upstreamMcpUrl,
          FORMASPEC_UPSTREAM_AUTH_MODE: recordedUpstreamAuthMode(runtimeDirectory, environment),
        },
      });
      fs.closeSync(log);
      child.unref();
      if (child.pid === undefined) throw new Error("The local bridge process did not start.");
      const nextState: BridgeState = {
        schemaVersion: 1,
        pid: child.pid,
        url: bridgeUrl,
        instanceId,
        buildId: runtime.buildId,
        upstreamMcpUrl,
      };
      writeState(statePath, nextState);
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const started = await bridgeHealth(bridgeUrl);
        if (started.running && started.buildId === runtime.buildId) {
          return { running: true, url: bridgeUrl, owned: true };
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      child.kill("SIGTERM");
      fs.rmSync(statePath, { force: true });
      throw new Error(`The local bridge did not become healthy. Inspect ${logPath}.`);
    },

    async authorizeAgent(pairing?: AgentPairingTicket): Promise<{ connectionId: string; status: string; expiresAt: string | null }> {
      await this.ensureStarted();
      const state = readState(statePath);
      if (state === null) throw new Error("The owned bridge state is unavailable; refusing to authorize an unowned process.");
      const response = await fetch(`${state.url}/_control/authorize-agent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          instanceId: state.instanceId,
          ...(pairing === undefined ? {} : { pairing }),
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => ({})) as { error?: unknown };
        throw new Error(`The local bridge could not authorize Codex${typeof detail.error === "string" ? `: ${detail.error}` : "."}`);
      }
      const body = await response.json() as { connectionId?: unknown; status?: unknown; expiresAt?: unknown };
      if (typeof body.connectionId !== "string" || typeof body.status !== "string") {
        throw new Error("The local bridge returned invalid agent-authorization metadata.");
      }
      return {
        connectionId: body.connectionId,
        status: body.status,
        expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : null,
      };
    },

    async verifyAgent(): Promise<AgentVerification> {
      const state = readState(statePath);
      if (state === null || !(await bridgeHealth(state.url)).running) {
        throw new Error("The local bridge is stopped; run './designer start local' before verifying the Codex MCP connection.");
      }
      const response = await fetch(`${state.url}/_control/verify-agent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instanceId: state.instanceId }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => ({})) as { error?: unknown };
        throw new Error(`The Codex MCP authorization could not be verified${typeof detail.error === "string" ? `: ${detail.error}` : "."}`);
      }
      const body = await response.json() as {
        verified?: unknown;
        checks?: unknown;
        serverName?: unknown;
        essentialTools?: unknown;
      };
      const essentialTools = Array.isArray(body.essentialTools)
        && body.essentialTools.every((tool) => typeof tool === "string")
        ? body.essentialTools as string[]
        : null;
      if (body.verified !== true || !Array.isArray(body.checks)
        || !body.checks.every((check) => typeof check === "string")
        || body.serverName !== "formaspec"
        || essentialTools === null
        || !FORMASPEC_ESSENTIAL_MCP_TOOLS.every((tool) => essentialTools.includes(tool))) {
        throw new Error("The local bridge returned invalid MCP verification metadata.");
      }
      return {
        verified: true,
        checks: body.checks,
        serverName: "formaspec",
        essentialTools,
      };
    },

    async stop(): Promise<boolean> {
      const state = readState(statePath);
      if (state === null) return false;
      if (!(await bridgeHealth(state.url)).running) {
        fs.rmSync(statePath, { force: true });
        return false;
      }
      const response = await fetch(`${state.url}/_control/shutdown`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instanceId: state.instanceId }),
        signal: AbortSignal.timeout(1500),
      });
      if (!response.ok) throw new Error("Bridge rejected the shutdown request; ownership state was preserved.");
      for (let attempt = 0; attempt < 30; attempt += 1) {
        if (!(await bridgeHealth(state.url)).running) {
          fs.rmSync(statePath, { force: true });
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("Bridge did not stop; ownership state was preserved.");
    },
  };
}
