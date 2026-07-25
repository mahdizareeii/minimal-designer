import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { pathToFileURL } from "node:url";

import { verifyBackup, type BackupVerification } from "./backup.js";
import { createBridgeController, type BridgeController } from "./bridge-lifecycle.js";
import {
  connectCodex,
  FORMASPEC_CODEX_MENTION,
  isManagedCodexInstall,
} from "./codex.js";
import {
  captureDockerRuntimeBinding,
  dockerRuntimeBindingPath,
  persistDockerRuntimeBinding,
  readDockerRuntimeBinding,
  sanitizedPublicDockerBinding,
  verifyDockerRuntimeBinding,
} from "./docker-runtime-binding.js";
import {
  abortDockerRestore,
  assertBackupId,
  clearStaleDockerRestoreLock,
  dockerRestoreStatus,
  restoreDockerBackup,
  restoreDockerBackupOffline,
  resumeDockerRestore,
  resumeOfflineDockerRestore,
  rollbackDockerRestore,
  type DockerRestoreDependencies,
  type DockerRestoreAbortResult,
  type DockerRestoreOperationStatus,
  type DockerRestoreResult,
  type DockerRestoreStaleLockResult,
  type OfflineRestoreSource,
} from "./docker-restore.js";
import { runGenericMcpConfigCli } from "./generic-mcp-config.js";
import { CLI_SUPPORTED_DATABASE_VERSION, defaultDatabasePath, readMigrationStatus } from "./migrations.js";
import { localApiRequest } from "./local-api.js";
import { findExecutable, runCommand, type CommandRunner } from "./process.js";
import { findProjectRoot, launcherPath } from "./project.js";
import { resolveRuntimePaths } from "./runtime-paths.js";
import { runSupportBundleCli } from "./support-bundle-cli.js";

export type RestoreVerifiedBackup = (
  bundlePath: string,
  destinationDataDirectory: string,
  options: {
    databaseClosed: true;
    expectedSource?: { sha256: string; sizeBytes?: number };
    healthCheck?: (dataDirectory: string) => Promise<void>;
    sourcePinDirectory?: string;
  },
) => Promise<void>;

export interface CliIo {
  stdout(message: string): void;
  stderr(message: string): void;
  isInteractive: boolean;
}

export interface CliDependencies {
  environment?: NodeJS.ProcessEnv;
  projectRoot?: string;
  commandRunner?: CommandRunner;
  bridge?: BridgeController;
  io?: CliIo;
  confirm?: (message: string) => Promise<boolean>;
  backupVerifier?: (bundlePath: string) => Promise<BackupVerification>;
  restoreVerifiedBackup?: RestoreVerifiedBackup;
  dockerRestoreStatus?: (projectRoot: string, dependencies?: DockerRestoreDependencies) => Promise<DockerRestoreOperationStatus>;
  restoreDockerBackup?: (
    projectRoot: string,
    backupId: string,
    io: Pick<CliIo, "stdout">,
    dependencies?: DockerRestoreDependencies,
  ) => Promise<DockerRestoreResult>;
  restoreDockerBackupOffline?: (
    projectRoot: string,
    source: OfflineRestoreSource,
    io: Pick<CliIo, "stdout">,
    dependencies?: DockerRestoreDependencies,
  ) => Promise<DockerRestoreResult>;
  resumeDockerRestore?: (
    projectRoot: string,
    backupId: string | undefined,
    dependencies?: DockerRestoreDependencies,
  ) => Promise<DockerRestoreResult>;
  resumeOfflineDockerRestore?: (
    projectRoot: string,
    source: OfflineRestoreSource,
    dependencies?: DockerRestoreDependencies,
  ) => Promise<DockerRestoreResult>;
  rollbackDockerRestore?: (
    projectRoot: string,
    io: Pick<CliIo, "stdout">,
    dependencies?: DockerRestoreDependencies,
  ) => Promise<DockerRestoreResult>;
  abortDockerRestore?: (
    projectRoot: string,
    dependencies?: DockerRestoreDependencies,
  ) => Promise<DockerRestoreAbortResult>;
  clearStaleDockerRestoreLock?: (
    projectRoot: string,
    dependencies?: DockerRestoreDependencies,
  ) => Promise<DockerRestoreStaleLockResult>;
  recordDockerRuntimeBinding?: (projectRoot: string) => Promise<void>;
  now?: () => Date;
}

const defaultIo: CliIo = {
  stdout: (message) => process.stdout.write(`${message}\n`),
  stderr: (message) => process.stderr.write(`${message}\n`),
  isInteractive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
};

async function interactiveConfirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await terminal.question(`${message} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    terminal.close();
  }
}

function usage(): string {
  return `FormaSpec control CLI

Usage:
  formaspecctl install [local|docker] [--yes]
  formaspecctl doctor [auto|local|docker|server] [--strict]
  formaspecctl ensure-running [--json]
  formaspecctl status
  formaspecctl start [local|docker|server] [launcher options]
  formaspecctl stop
  formaspecctl restart
  formaspecctl migrate status [--json]
  formaspecctl backup create [--json]
  formaspecctl backup list [--json]
  formaspecctl backup schedule show|enable|disable|run [--at HH:MM] [--json]
  formaspecctl backup prune preview [--json]
  formaspecctl backup prune execute --preview-id <id> --plan-hash <sha256> --yes [--json]
  formaspecctl backup verify <formaspec-backup.tar> [--json]
  formaspecctl backup restore <formaspec-backup.tar> --yes [--json]
  formaspecctl backup restore --backup-id <id> --yes [--json]
  formaspecctl backup restore offline <formaspec-backup.tar> --yes [--json]
  formaspecctl backup restore status [--json]
  formaspecctl backup restore resume [--backup-id <id> | --offline-bundle <formaspec-backup.tar>] --yes [--json]
  formaspecctl backup restore rollback --yes [--json]
  formaspecctl backup restore abort --yes [--json]
  formaspecctl backup restore clear-stale-lock --yes [--json]
  formaspecctl audit retention preview|list [--json]
  formaspecctl audit retention execute --preview-id <id> --plan-hash <sha256> --yes [--idempotency-key <key>] [--json]
  formaspecctl agent connect codex [--pairing-nonce <nonce>] [--connection-id <id>] [--yes]
  formaspecctl agent config generic [--format all|json|toml] [--snippet-only]
  formaspecctl support-bundle preview [--json]
  formaspecctl support-bundle create [OUTPUT.tar] --yes [--json]

Global option:
  --yes      Authorize the requested safe setup changes without an interactive prompt
  --no-open  Do not open a browser after installation or startup`;
}

type RecordedRuntimeMode = "local" | "dev" | "docker" | "server";

type EnsureRunningBlockerCode =
  | "RUNTIME_NOT_RECORDED"
  | "RUNTIME_CONFIGURATION_INVALID"
  | "RUNTIME_NOT_READY"
  | "RUNTIME_START_FAILED"
  | "RUNTIME_IDENTITY_CONFLICT"
  | "DOCKER_CLI_REQUIRED"
  | "DOCKER_DESKTOP_REQUIRED";

export interface EnsureRunningResult {
  schemaVersion: 1;
  ok: boolean;
  status: "ready" | "started" | "blocked";
  mode: RecordedRuntimeMode | null;
  started: boolean;
  origin: string | null;
  webOrigin: string | null;
  dataStoreId: string | null;
  bridgeReady: boolean;
  blocker?: {
    code: EnsureRunningBlockerCode;
    message: string;
    action: string;
  };
}

function optionalRuntimeFile(
  projectRoot: string,
  filename: string,
  environment: NodeJS.ProcessEnv,
): string | undefined {
  const target = path.join(resolveRuntimePaths(projectRoot, environment).runDirectory, filename);
  if (!fs.existsSync(target)) return undefined;
  const value = fs.readFileSync(target, "utf8").trim();
  return value || undefined;
}

function recordedRuntimeMode(projectRoot: string, environment: NodeJS.ProcessEnv): RecordedRuntimeMode | undefined {
  const value = optionalRuntimeFile(projectRoot, "mode", environment);
  if (value === undefined) return undefined;
  if (value === "local" || value === "dev" || value === "docker" || value === "server") return value;
  throw new Error(`Recorded FormaSpec runtime mode is unknown: ${value}. Run 'formaspecctl stop' and inspect the configured runtime run directory before restoring.`);
}

function recordedProxyServerUrl(projectRoot: string, environment: NodeJS.ProcessEnv): string | null {
  if (recordedRuntimeMode(projectRoot, environment) !== "server") return null;
  const environmentFile = optionalRuntimeFile(projectRoot, "env-file", environment);
  const recordedUrl = optionalRuntimeFile(projectRoot, "url", environment);
  if (!environmentFile || !path.isAbsolute(environmentFile) || !recordedUrl?.startsWith("https://")) return null;
  try {
    const stat = fs.lstatSync(environmentFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) return null;
    const accessValues = fs.readFileSync(environmentFile, "utf8").split(/\r?\n/).flatMap((line) => {
      const match = /^DESIGNER_SERVER_ACCESS=(ssh|proxy)$/.exec(line.trim());
      return match ? [match[1]!] : [];
    });
    if (accessValues.length !== 1 || accessValues[0] !== "proxy") return null;
    const publicUrl = new URL(recordedUrl);
    if (publicUrl.protocol !== "https:" || publicUrl.username || publicUrl.password
      || publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash) return null;
    return publicUrl.origin;
  } catch {
    return null;
  }
}

function proxyServerBridgeMessage(publicUrl: string): string {
  return `FormaSpec proxy-server mode uses the public MCP endpoint at ${publicUrl}/mcp; the workstation loopback bridge is intentionally disabled. Connect Codex from Agent Connections or generate an explicit public client configuration.`;
}

function runtimeHealthTarget(
  projectRoot: string,
  environment: NodeJS.ProcessEnv,
): { origin: string; hostHeader?: string } {
  const rawPort = optionalRuntimeFile(projectRoot, "api-port", environment) ?? "4310";
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("The recorded FormaSpec API port is invalid.");
  }
  const mode = optionalRuntimeFile(projectRoot, "mode", environment);
  const recordedUrl = optionalRuntimeFile(projectRoot, "url", environment);
  if (mode === "server" && recordedUrl?.startsWith("https://")) {
    const publicUrl = new URL(recordedUrl);
    if (publicUrl.username || publicUrl.password || publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash) {
      throw new Error("The recorded FormaSpec public server URL is invalid.");
    }
    return { origin: `http://127.0.0.1:${port}`, hostHeader: publicUrl.host };
  }
  return { origin: `http://127.0.0.1:${port}` };
}

function recordedPort(
  projectRoot: string,
  environment: NodeJS.ProcessEnv,
  filename: "api-port" | "web-port",
  fallback?: number,
): number {
  const raw = optionalRuntimeFile(projectRoot, filename, environment);
  if (raw === undefined && fallback !== undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`The recorded FormaSpec ${filename} is invalid.`);
  }
  return value;
}

function recordedWebOrigin(
  projectRoot: string,
  environment: NodeJS.ProcessEnv,
  mode: RecordedRuntimeMode,
  healthOrigin: string,
): string {
  const value = optionalRuntimeFile(projectRoot, "url", environment) ?? healthOrigin;
  const url = new URL(value);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopbackHttp = url.protocol === "http:" && ["127.0.0.1", "::1", "localhost"].includes(host);
  const publicHttps = url.protocol === "https:" && host !== "" && !["127.0.0.1", "::1", "localhost"].includes(host);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash
    || (mode === "server" ? !loopbackHttp && !publicHttps : !loopbackHttp)) {
    throw new Error("The recorded FormaSpec web origin is invalid for its runtime mode.");
  }
  if (mode !== "server" || loopbackHttp) {
    const expectedPort = mode === "dev"
      ? recordedPort(projectRoot, environment, "web-port")
      : Number(new URL(healthOrigin).port);
    const actualPort = Number(url.port || (url.protocol === "https:" ? "443" : "80"));
    if (actualPort !== expectedPort) {
      throw new Error("The recorded FormaSpec web origin does not match the recorded runtime ports.");
    }
  }
  return url.origin;
}

function ensureRunningBlocked(
  mode: RecordedRuntimeMode | null,
  code: EnsureRunningBlockerCode,
  message: string,
  action: string,
  details: Partial<Pick<EnsureRunningResult, "origin" | "webOrigin" | "dataStoreId">> = {},
): EnsureRunningResult {
  return {
    schemaVersion: 1,
    ok: false,
    status: "blocked",
    mode,
    started: false,
    origin: details.origin ?? null,
    webOrigin: details.webOrigin ?? null,
    dataStoreId: details.dataStoreId ?? null,
    bridgeReady: false,
    blocker: { code, message, action },
  };
}

function printEnsureRunningResult(result: EnsureRunningResult, json: boolean, io: CliIo): void {
  if (json) {
    io.stdout(JSON.stringify(result));
    return;
  }
  if (result.ok) {
    io.stdout(`FormaSpec ${result.status === "started" ? "started" : "is ready"} in recorded ${result.mode} mode at ${result.webOrigin}.`);
    io.stdout(`Data store: ${result.dataStoreId}; bridge: ${result.bridgeReady ? "ready" : "not required"}.`);
    return;
  }
  io.stdout(`FormaSpec runtime recovery is blocked: ${result.blocker?.message ?? "unknown blocker"}`);
  io.stdout(result.blocker?.action ?? "Inspect the recorded runtime before retrying.");
}

async function verifyHealthEndpoint(
  origin: string,
  pathname: "/health/ready" | "/health/render",
  hostHeader?: string,
): Promise<{ dataStoreId: string | null; ready: boolean; status: number }> {
  const response = await fetch(`${origin}${pathname}`, {
    headers: { accept: "application/json", ...(hostHeader === undefined ? {} : { host: hostHeader }) },
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > 65_536) {
    await response.body?.cancel();
    throw new Error("response was too large");
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > 65_536) throw new Error("response was too large");
  const body = JSON.parse(text) as { ok?: unknown; dataStoreId?: unknown };
  if (body === null || typeof body !== "object") throw new Error("response was not a JSON object");
  if (pathname === "/health/ready") {
    if (typeof body.dataStoreId !== "string" || !/^store_[a-f0-9]{32}$/.test(body.dataStoreId)) {
      throw new Error("response did not report a valid dataStoreId");
    }
    return {
      dataStoreId: body.dataStoreId,
      ready: response.ok && body.ok === true,
      status: response.status,
    };
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (body.ok !== true) throw new Error("response did not report ok=true");
  return { dataStoreId: null, ready: true, status: response.status };
}

async function concurrentDockerDataStore(
  projectRoot: string,
  primaryOrigin: string,
  primaryDataStoreId: string | null,
): Promise<{ origin: string; dataStoreId: string } | null> {
  if (primaryDataStoreId === null) return null;
  const bindingPath = dockerRuntimeBindingPath(projectRoot);
  if (!fs.existsSync(bindingPath)) return null;
  const docker = sanitizedPublicDockerBinding(readDockerRuntimeBinding(projectRoot));
  if (docker.origin === primaryOrigin) return null;
  try {
    const identity = await verifyHealthEndpoint(
      docker.origin,
      "/health/ready",
      docker.healthHostHeader || undefined,
    );
    if (identity.dataStoreId === null || identity.dataStoreId === primaryDataStoreId) return null;
    return { origin: docker.origin, dataStoreId: identity.dataStoreId };
  } catch {
    return null;
  }
}

function managedPidIsAlive(projectRoot: string, environment: NodeJS.ProcessEnv): boolean {
  const value = optionalRuntimeFile(projectRoot, "pid", environment);
  if (value === undefined) return false;
  if (!/^\d+$/.test(value)) throw new Error("Recorded FormaSpec PID is invalid; refusing an offline restore.");
  const pid = Number(value);
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Recorded FormaSpec PID is invalid; refusing an offline restore.");
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

async function loadRestoreVerifiedBackup(projectRoot: string): Promise<RestoreVerifiedBackup> {
  const modulePath = path.join(projectRoot, "apps", "server", "dist", "backup.js");
  if (!fs.existsSync(modulePath)) {
    throw new Error("The built FormaSpec restore engine is missing. Run 'pnpm --filter @designer/server build' before a source-local restore.");
  }
  const loaded = await import(pathToFileURL(modulePath).href) as { restoreVerifiedBackup?: unknown };
  if (typeof loaded.restoreVerifiedBackup !== "function") {
    throw new Error("The built FormaSpec server does not expose the required restoreVerifiedBackup engine.");
  }
  return loaded.restoreVerifiedBackup as RestoreVerifiedBackup;
}

function assertSourceLocalRestoreMode(
  projectRoot: string,
  mode: RecordedRuntimeMode | undefined,
  environment: NodeJS.ProcessEnv,
): void {
  if (resolveRuntimePaths(projectRoot, environment).usesExternalStatePaths) {
    throw new Error(
      "Source-local restore is disabled for an environment-managed native runtime. Use a future supervised native restore workflow; no native data was changed.",
    );
  }
  if (mode === "docker") {
    throw new Error("backup restore supports only the source-local ./data directory. The recorded Docker runtime uses a managed volume; no Docker data was changed.");
  }
  if (mode === "server") {
    throw new Error("A server runtime must restore an exact managed backup ID through the supervised maintenance workflow; arbitrary source-local bundle paths cannot target server volumes. No server data was changed.");
  }
  if (mode === undefined) {
    const recordedEnvironment = optionalRuntimeFile(projectRoot, "env-file", environment);
    if (recordedEnvironment !== undefined) {
      throw new Error("Runtime state references a Compose environment without a recorded mode. Refusing to guess whether the data is local, Docker, or server-managed.");
    }
    if (managedPidIsAlive(projectRoot, environment)) {
      throw new Error("A FormaSpec process is running without a recognized local runtime mode. Stop it explicitly before restoring.");
    }
  }
}

function assertDockerRestoreMode(mode: RecordedRuntimeMode | undefined): void {
  if (mode !== "docker" && mode !== "server") {
    throw new Error("Offline disaster recovery requires the recorded Docker/server runtime and its pinned volume binding.");
  }
}

function preRestoreBackupPath(projectRoot: string, now: Date, environment: NodeJS.ProcessEnv): string {
  const timestamp = now.toISOString().replaceAll(/[:.]/g, "-");
  return path.join(
    resolveRuntimePaths(projectRoot, environment).backupDirectory,
    `pre-restore-${timestamp}-${randomUUID().slice(0, 8)}`,
  );
}

function validateStartArguments(arguments_: string[]): string[] {
  const allowedTargets = new Set(["local", "docker", "server"]);
  const target = arguments_[0] !== undefined && allowedTargets.has(arguments_[0]) ? arguments_[0] : "docker";
  const options = target === arguments_[0] ? arguments_.slice(1) : arguments_;
  const result = [target];
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index]!;
    if (option === "--no-open" && target !== "server") result.push(option);
    else if (option === "--no-build" && target !== "local") result.push(option);
    else if (option === "--port" && target !== "server") {
      const value = options[index + 1];
      if (value === undefined || !/^\d{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 65_535) {
        throw new Error("--port requires a valid port number.");
      }
      result.push(option, value);
      index += 1;
    } else {
      throw new Error(`Unsupported start option for ${target}: ${option}`);
    }
  }
  return result;
}

export async function runCli(rawArguments: readonly string[], dependencies: CliDependencies = {}): Promise<number> {
  const environment = dependencies.environment ?? process.env;
  const io = dependencies.io ?? defaultIo;
  const runner = dependencies.commandRunner ?? runCommand;
  const confirm = dependencies.confirm ?? interactiveConfirm;
  const arguments_ = [...rawArguments];
  let globalNoOpen = false;
  while (arguments_[0] === "--yes" || arguments_[0] === "--no-open") {
    if (arguments_.shift() === "--no-open") globalNoOpen = true;
  }
  const assumeYes = rawArguments.includes("--yes");
  for (let index = arguments_.length - 1; index >= 0; index -= 1) {
    if (arguments_[index] === "--yes") arguments_.splice(index, 1);
  }

  try {
    const command = arguments_.shift();
    if (command === undefined || command === "help" || command === "--help" || command === "-h") {
      io.stdout(usage());
      return 0;
    }
    let resolvedProjectRoot: string | undefined = dependencies.projectRoot;
    let resolvedBridge: BridgeController | undefined = dependencies.bridge;
    const projectRoot = (): string => {
      resolvedProjectRoot ??= findProjectRoot();
      return resolvedProjectRoot;
    };
    const runtimePaths = () => resolveRuntimePaths(projectRoot(), environment);
    const requestLocalApi = <T>(pathname: string, init?: RequestInit): Promise<T> =>
      localApiRequest<T>(projectRoot(), pathname, init, environment);
    const bridge = (): BridgeController => {
      resolvedBridge ??= createBridgeController(projectRoot(), environment);
      return resolvedBridge;
    };
    const recordDockerBinding = async (): Promise<void> => {
      const root = projectRoot();
      if (dependencies.recordDockerRuntimeBinding) {
        await dependencies.recordDockerRuntimeBinding(root);
      } else {
        const binding = await captureDockerRuntimeBinding(root, {
          environment,
          commandRunner: runner,
        });
        persistDockerRuntimeBinding(root, binding);
      }
      io.stdout("Pinned the exact Docker daemon, Compose project, image, containers, runtime mode, and data volumes for safe restore.");
    };
    const delegate = async (launcherArguments: string[]): Promise<number> => {
      const root = projectRoot();
      const result = await runner(launcherPath(root), launcherArguments, {
        cwd: root,
        env: { ...environment, FORMASPEC_LEGACY_DELEGATE: "1" },
        inherit: true,
      });
      return result.exitCode;
    };
    const delegateQuiet = async (
      launcherArguments: string[],
      environmentOverrides: NodeJS.ProcessEnv = {},
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
      const root = projectRoot();
      return runner(launcherPath(root), launcherArguments, {
        cwd: root,
        env: { ...environment, ...environmentOverrides, FORMASPEC_LEGACY_DELEGATE: "1" },
        inherit: false,
        timeoutMs: 180_000,
        maxOutputBytes: 256 * 1024,
      });
    };
    const startRecordedDevelopmentRuntime = async (apiPort: number, webPort: number): Promise<void> => {
      const root = projectRoot();
      const logDirectory = runtimePaths().logDirectory;
      fs.mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
      const log = fs.openSync(path.join(logDirectory, "ensure-running-dev.log"), "a", 0o600);
      const child = spawn(launcherPath(root), [
        "--yes",
        "--no-open",
        "dev",
        "--api-port",
        String(apiPort),
        "--web-port",
        String(webPort),
        "--skip-setup",
      ], {
        cwd: root,
        detached: true,
        env: { ...environment, FORMASPEC_LEGACY_DELEGATE: "1" },
        shell: false,
        stdio: ["ignore", log, log],
      });
      fs.closeSync(log);
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.unref();
    };
    const reportCodexConnection = (result: Awaited<ReturnType<typeof connectCodex>>): void => {
      io.stdout(`Codex MCP 'formaspec' verified at ${result.mcpUrl}.`);
      io.stdout(`Managed FormaSpec plugin installed at ${result.pluginPath}.`);
      io.stdout(`Canonical FormaSpec skill installed inside the plugin at ${result.pluginSkillPath}.`);
      if (result.removedLegacyMinimalUiPlugin) io.stdout("Removed the installer-owned legacy duplicate plugin identity.");
      if (result.removedManagedStandaloneSkillPaths.length > 0) {
        io.stdout(`Removed installer-owned duplicate standalone skills: ${result.removedManagedStandaloneSkillPaths.join(", ")}.`);
      }
      io.stdout(`Codex mention: ${FORMASPEC_CODEX_MENTION}`);
      io.stdout("Use FormaSpec in a new Codex task so it loads the updated single identity.");
    };
    const offerCodexConnection = async (alreadyAuthorized = false): Promise<void> => {
      if (findExecutable("codex", environment) === null) {
        io.stdout("Codex was not detected; FormaSpec is running and can be connected later with 'formaspecctl agent connect codex'.");
        return;
      }
      let managedRefresh = false;
      if (!alreadyAuthorized && !assumeYes) {
        try {
          const bridgeStatus = await bridge().status();
          if (bridgeStatus.running) {
            await bridge().verifyAgent();
            managedRefresh = await isManagedCodexInstall({ environment, commandRunner: runner });
          }
        } catch {
          managedRefresh = false;
        }
      }
      if (managedRefresh) io.stdout("Refreshing the already-authorized managed Codex connection and FormaSpec plugin.");
      const authorized = alreadyAuthorized || assumeYes || managedRefresh || await confirm(
        "Allow FormaSpec to configure Codex, install the single managed FormaSpec plugin, remove installer-owned legacy duplicate identities, and verify the loopback MCP connection?",
      );
      if (!authorized) {
        io.stdout("Codex connection skipped. Run 'formaspecctl agent connect codex' when ready.");
        return;
      }
      try {
        reportCodexConnection(await connectCodex({
          environment,
          commandRunner: runner,
          bridge: bridge(),
          confirm,
          assumeYes: true,
        }));
      } catch (cause) {
        if (cause instanceof Error && cause.message.includes("PAIRING_TICKET_REQUIRED")) {
          io.stdout("Codex needs a one-time pairing ticket in authenticated mode. Open FormaSpec Administration and choose Connect Codex.");
          return;
        }
        throw cause;
      }
    };

    if (command === "install") {
      const target = arguments_.shift() ?? "docker";
      if (target !== "local" && target !== "docker") throw new Error("Use: formaspecctl install [local|docker] [--yes]");
      if (arguments_[0] === "--no-open") {
        globalNoOpen = true;
        arguments_.shift();
      }
      if (arguments_.length > 0) throw new Error(`Unexpected install option: ${arguments_[0]}`);
      const authorized = assumeYes || await confirm(
        `Allow FormaSpec to prepare the ${target} runtime, start the local service, configure the bridge, and connect supported Codex?`,
      );
      if (!authorized) throw new Error("FormaSpec installation was cancelled; no setup command was run.");
      const setupExitCode = await delegate(["--yes", "setup", target]);
      if (setupExitCode !== 0) return setupExitCode;
      const startExitCode = await delegate(["--yes", "start", target, ...(globalNoOpen ? ["--no-open"] : [])]);
      if (startExitCode !== 0) return startExitCode;
      if (target === "docker") await recordDockerBinding();
      const bridgeStatus = await bridge().ensureStarted();
      io.stdout(`FormaSpec bridge is ready at ${bridgeStatus.url}.`);
      await offerCodexConnection(true);
      io.stdout("FormaSpec installation and startup completed.");
      return 0;
    }

    if (command === "doctor") {
      const target = arguments_.shift() ?? "auto";
      if (!["auto", "local", "docker", "server"].includes(target)) throw new Error(`Unknown doctor target: ${target}`);
      const strict = arguments_.shift();
      if (strict !== undefined && strict !== "--strict") throw new Error(`Unexpected doctor option: ${strict}`);
      if (arguments_.length > 0) throw new Error(`Unexpected doctor option: ${arguments_[0]}`);
      const exitCode = await delegate(["doctor", target, ...(strict === undefined ? [] : [strict])]);
      let runtimeUnavailable = false;
      let runtimeReady = false;
      let runtimeDataStoreId: string | null = null;
      const healthTarget = runtimeHealthTarget(projectRoot(), environment);
      for (const [pathname, label] of [
        ["/health/ready", "Server readiness"],
        ["/health/render", "Renderer health"],
      ] as const) {
        try {
          const health = await verifyHealthEndpoint(healthTarget.origin, pathname, healthTarget.hostHeader);
          if (pathname === "/health/ready") {
            runtimeDataStoreId = health.dataStoreId;
            runtimeReady = health.ready;
          }
          if (health.ready) {
            io.stdout(`${label}: verified (${healthTarget.origin}${pathname})`);
          } else {
            runtimeUnavailable = true;
            io.stdout(`${label}: unavailable (HTTP ${health.status}; retained data-store identity ${health.dataStoreId})`);
          }
        } catch (error) {
          runtimeUnavailable = true;
          io.stdout(`${label}: unavailable (${error instanceof Error ? error.message : String(error)})`);
        }
      }
      const competingDocker = await concurrentDockerDataStore(
        projectRoot(),
        healthTarget.origin,
        runtimeDataStoreId,
      );
      if (competingDocker !== null) {
        io.stdout(`Multiple active FormaSpec data stores: the recorded UI/API is ${healthTarget.origin} (${runtimeDataStoreId}), while the known Docker runtime identifies itself at ${competingDocker.origin} (${competingDocker.dataStoreId}). Stop the unintended runtime before using Codex.`);
        return 1;
      }
      const codex = findExecutable("codex", environment);
      io.stdout(codex === null ? "Codex: not detected" : `Codex: detected at ${codex}`);
      const proxyServerUrl = recordedProxyServerUrl(projectRoot(), environment);
      if (proxyServerUrl !== null) {
        io.stdout(proxyServerBridgeMessage(proxyServerUrl));
        return exitCode === 0 && !runtimeUnavailable ? 0 : 1;
      }
      const bridgeStatus = await bridge().status();
      io.stdout(`Local bridge: ${bridgeStatus.running ? "running" : "stopped"} (${bridgeStatus.url})`);
      if (!bridgeStatus.running) {
        const recordedMode = recordedRuntimeMode(projectRoot(), environment);
        const recoveryMode = recordedMode === "docker" || recordedMode === "server"
          ? recordedMode
          : target === "docker" || target === "server"
            ? target
            : "local";
        io.stdout(`Codex MCP authorization: not checked because the bridge is stopped. Run './designer start ${recoveryMode}', then rerun doctor.`);
        return 1;
      }
      io.stdout(`Bridge upstream: ${bridgeStatus.upstreamOrigin ?? "unavailable"}; data store: ${bridgeStatus.dataStoreId ?? "unavailable"}`);
      if (bridgeStatus.upstreamOrigin !== healthTarget.origin
        || runtimeDataStoreId === null
        || bridgeStatus.dataStoreId !== runtimeDataStoreId) {
        io.stdout(`Codex runtime mismatch: the UI/API is ${healthTarget.origin} (${runtimeDataStoreId ?? "unknown data store"}), but the bridge targets ${bridgeStatus.upstreamOrigin ?? "an unavailable upstream"} (${bridgeStatus.dataStoreId ?? "unknown data store"}). Run './designer restart' or start the intended mode again to realign Codex.`);
        return 1;
      }
      if (!runtimeReady || !bridgeStatus.upstreamReady) {
        io.stdout(`Codex runtime identity is aligned at ${healthTarget.origin} (${runtimeDataStoreId}), but the UI/API or bridge upstream is temporarily not ready. Keep this mode running and retry doctor after maintenance or renderer recovery.`);
        return 1;
      }
      try {
        const verification = await bridge().verifyAgent();
        if (verification.upstreamOrigin !== healthTarget.origin || verification.dataStoreId !== runtimeDataStoreId) {
          io.stdout("Codex MCP authorization: unavailable (the verified MCP upstream changed during diagnostics; restart FormaSpec and retry)");
          return 1;
        }
        io.stdout(`Codex MCP authorization: verified as ${verification.serverName} (${verification.checks.join(" + ")}; ${verification.essentialTools.length} essential tools)`);
      } catch (error) {
        io.stdout(`Codex MCP authorization: unavailable (${error instanceof Error ? error.message : String(error)})`);
        return 1;
      }
      return exitCode === 0 && !runtimeUnavailable ? 0 : 1;
    }

    if (command === "ensure-running") {
      const option = arguments_.shift();
      if (option !== undefined && option !== "--json") throw new Error(`Unexpected ensure-running option: ${option}`);
      const json = option === "--json";
      if (arguments_.length > 0) throw new Error(`Unexpected ensure-running option: ${arguments_[0]}`);

      let mode: RecordedRuntimeMode | undefined;
      let healthTarget: { origin: string; hostHeader?: string };
      let webOrigin: string;
      try {
        mode = recordedRuntimeMode(projectRoot(), environment);
        if (mode === undefined) {
          const result = ensureRunningBlocked(
            null,
            "RUNTIME_NOT_RECORDED",
            "No runtime mode is recorded, so FormaSpec cannot choose a data store safely.",
            "Start the intended mode explicitly once with formaspecctl start local|docker|server, then retry. FormaSpec will not guess or switch modes.",
          );
          printEnsureRunningResult(result, json, io);
          return 1;
        }
        healthTarget = runtimeHealthTarget(projectRoot(), environment);
        webOrigin = recordedWebOrigin(projectRoot(), environment, mode, healthTarget.origin);
      } catch (error) {
        const result = ensureRunningBlocked(
          mode ?? null,
          "RUNTIME_CONFIGURATION_INVALID",
          error instanceof Error ? error.message : String(error),
          "Inspect the recorded FormaSpec runtime files and run formaspecctl doctor auto; do not start a different mode.",
        );
        printEnsureRunningResult(result, json, io);
        return 1;
      }

      let dockerBinding: ReturnType<typeof readDockerRuntimeBinding> | undefined;
      let dockerEnvironment: NodeJS.ProcessEnv = {};
      if (mode === "docker" || mode === "server") {
        const bindingPath = dockerRuntimeBindingPath(projectRoot());
        if (fs.existsSync(bindingPath)) {
          try {
            dockerBinding = readDockerRuntimeBinding(projectRoot());
            const publicBinding = sanitizedPublicDockerBinding(dockerBinding);
            const effectiveHealthHostHeader = healthTarget.hostHeader ?? new URL(healthTarget.origin).host;
            if (publicBinding.runtimeMode !== mode
              || publicBinding.origin !== healthTarget.origin
              || effectiveHealthHostHeader !== publicBinding.healthHostHeader) {
              throw new Error("The recorded runtime and pinned Docker binding identify different modes or endpoints.");
            }
            dockerEnvironment = { DOCKER_CONTEXT: dockerBinding.context };
          } catch (error) {
            const result = ensureRunningBlocked(
              mode,
              "RUNTIME_CONFIGURATION_INVALID",
              error instanceof Error ? error.message : String(error),
              "Run formaspecctl doctor auto and repair the pinned Docker runtime binding before retrying. Do not start local mode.",
              { origin: healthTarget.origin, webOrigin },
            );
            printEnsureRunningResult(result, json, io);
            return 1;
          }
        }
      }

      let identity: Awaited<ReturnType<typeof verifyHealthEndpoint>> | undefined;
      try {
        identity = await verifyHealthEndpoint(healthTarget.origin, "/health/ready", healthTarget.hostHeader);
      } catch {
        identity = undefined;
      }
      if (identity !== undefined && !identity.ready) {
        const result = ensureRunningBlocked(
          mode,
          "RUNTIME_NOT_READY",
          `The recorded ${mode} runtime reports data store ${identity.dataStoreId} but is temporarily not ready (HTTP ${identity.status}).`,
          "Keep the recorded runtime selected and retry after maintenance or renderer recovery; FormaSpec will not restart it while its identity is visible.",
          { origin: healthTarget.origin, webOrigin, dataStoreId: identity.dataStoreId },
        );
        printEnsureRunningResult(result, json, io);
        return 1;
      }

      let started = false;
      if (identity === undefined) {
        if (mode === "docker" || mode === "server") {
          const dockerPath = findExecutable("docker", { ...environment, ...dockerEnvironment });
          if (dockerPath === null) {
            const result = ensureRunningBlocked(
              mode,
              "DOCKER_CLI_REQUIRED",
              `The recorded ${mode} runtime requires Docker, but the Docker CLI is unavailable.`,
              "Install Docker Desktop/Engine and its CLI, then rerun formaspecctl ensure-running --json. Do not start local mode because it uses a different data store.",
              { origin: healthTarget.origin, webOrigin },
            );
            printEnsureRunningResult(result, json, io);
            return 1;
          }
          const dockerInfo = await runner(
            dockerPath,
            [
              ...(dockerBinding === undefined ? [] : ["--context", dockerBinding.context]),
              "info",
              "--format",
              "{{.ServerVersion}}",
            ],
            {
              env: { ...environment, ...dockerEnvironment },
              timeoutMs: 15_000,
              maxOutputBytes: 64 * 1024,
            },
          ).catch(() => ({ exitCode: 1, stdout: "", stderr: "" }));
          if (dockerInfo.exitCode !== 0) {
            const result = ensureRunningBlocked(
              mode,
              "DOCKER_DESKTOP_REQUIRED",
              `Docker Desktop/Engine is stopped or unreachable for the recorded ${mode} runtime.`,
              "Start Docker Desktop/Engine, then rerun formaspecctl ensure-running --json. The recorded Docker data store remains selected; do not start local mode.",
              { origin: healthTarget.origin, webOrigin },
            );
            printEnsureRunningResult(result, json, io);
            return 1;
          }
        }

        let startFailure: string | undefined;
        if (mode === "dev") {
          try {
            await startRecordedDevelopmentRuntime(
              recordedPort(projectRoot(), environment, "api-port", 4310),
              recordedPort(projectRoot(), environment, "web-port"),
            );
          } catch (error) {
            startFailure = error instanceof Error ? error.message : String(error);
          }
        } else {
          const apiPort = recordedPort(projectRoot(), environment, "api-port", 4310);
          const launcherArguments = mode === "local"
            ? ["--yes", "start", "local", "--port", String(apiPort), "--no-open"]
            : mode === "docker"
              ? ["--yes", "start", "docker", "--port", String(apiPort), "--no-open", "--no-build"]
              : ["--yes", "start", "server", "--no-build"];
          try {
            const launched = await delegateQuiet(launcherArguments, dockerEnvironment);
            if (launched.exitCode !== 0) {
              const detail = launched.stderr.trim() || launched.stdout.trim();
              startFailure = detail === "" ? `launcher exited with status ${launched.exitCode}` : detail.slice(0, 2_000);
            }
          } catch (error) {
            startFailure = error instanceof Error ? error.message : String(error);
          }
        }
        if (startFailure !== undefined) {
          const result = ensureRunningBlocked(
            mode,
            "RUNTIME_START_FAILED",
            `The fixed FormaSpec launcher could not resume recorded ${mode} mode: ${startFailure}`,
            `Run formaspecctl doctor ${mode === "dev" ? "local" : mode} and repair that recorded runtime. Do not start a different mode.`,
            { origin: healthTarget.origin, webOrigin },
          );
          printEnsureRunningResult(result, json, io);
          return 1;
        }
        started = true;
        const attempts = mode === "dev" ? 120 : 20;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          try {
            identity = await verifyHealthEndpoint(healthTarget.origin, "/health/ready", healthTarget.hostHeader);
            if (identity.ready) break;
          } catch {
            identity = undefined;
          }
          if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 250));
        }
        if (identity === undefined || !identity.ready || identity.dataStoreId === null) {
          const result = ensureRunningBlocked(
            mode,
            "RUNTIME_START_FAILED",
            `The fixed FormaSpec launcher resumed recorded ${mode} mode, but its health endpoint did not become ready.`,
            `Run formaspecctl doctor ${mode === "dev" ? "local" : mode} and inspect the recorded runtime logs; do not start a different mode.`,
            { origin: healthTarget.origin, webOrigin, dataStoreId: identity?.dataStoreId ?? null },
          );
          printEnsureRunningResult(result, json, io);
          return 1;
        }
        if (mode === "docker" || mode === "server") {
          try {
            if (dockerBinding === undefined) {
              const captured = await captureDockerRuntimeBinding(projectRoot(), {
                environment: { ...environment, ...dockerEnvironment },
                commandRunner: runner,
              });
              persistDockerRuntimeBinding(projectRoot(), captured);
            } else {
              await verifyDockerRuntimeBinding(projectRoot(), {
                environment: { ...environment, ...dockerEnvironment },
                commandRunner: runner,
                context: dockerBinding.context,
                composeProject: dockerBinding.composeProject,
              });
            }
          } catch (error) {
            const result = ensureRunningBlocked(
              mode,
              "RUNTIME_IDENTITY_CONFLICT",
              error instanceof Error ? error.message : String(error),
              "Stop the resumed runtime and repair its pinned Docker binding before retrying. Do not switch to local mode.",
              { origin: healthTarget.origin, webOrigin, dataStoreId: identity.dataStoreId },
            );
            printEnsureRunningResult(result, json, io);
            return 1;
          }
        }
      }

      if (identity === undefined || !identity.ready || identity.dataStoreId === null) {
        const result = ensureRunningBlocked(
          mode,
          "RUNTIME_NOT_READY",
          `The recorded ${mode} runtime does not expose a ready data-store identity.`,
          `Run formaspecctl doctor ${mode === "dev" ? "local" : mode}; do not start a different mode.`,
          { origin: healthTarget.origin, webOrigin },
        );
        printEnsureRunningResult(result, json, io);
        return 1;
      }
      const competingDocker = await concurrentDockerDataStore(
        projectRoot(),
        healthTarget.origin,
        identity.dataStoreId,
      );
      if (competingDocker !== null) {
        const result = ensureRunningBlocked(
          mode,
          "RUNTIME_IDENTITY_CONFLICT",
          `Another FormaSpec runtime is active at ${competingDocker.origin} with data store ${competingDocker.dataStoreId}.`,
          "Stop the unintended runtime, then retry. FormaSpec will not choose between active data stores.",
          { origin: healthTarget.origin, webOrigin, dataStoreId: identity.dataStoreId },
        );
        printEnsureRunningResult(result, json, io);
        return 1;
      }

      let bridgeReady = false;
      if (recordedProxyServerUrl(projectRoot(), environment) === null) {
        try {
          const bridgeStatus = await bridge().ensureStarted();
          if (bridgeStatus.upstreamOrigin !== healthTarget.origin
            || bridgeStatus.dataStoreId !== identity.dataStoreId
            || !bridgeStatus.upstreamReady) {
            throw new Error("The local bridge resolved a different runtime or data store.");
          }
          bridgeReady = true;
        } catch (error) {
          const result = ensureRunningBlocked(
            mode,
            "RUNTIME_IDENTITY_CONFLICT",
            error instanceof Error ? error.message : String(error),
            "Stop the mismatched bridge/runtime and rerun formaspecctl ensure-running --json; FormaSpec will not retarget the bridge silently.",
            { origin: healthTarget.origin, webOrigin, dataStoreId: identity.dataStoreId },
          );
          printEnsureRunningResult(result, json, io);
          return 1;
        }
      }

      const result: EnsureRunningResult = {
        schemaVersion: 1,
        ok: true,
        status: started ? "started" : "ready",
        mode,
        started,
        origin: healthTarget.origin,
        webOrigin,
        dataStoreId: identity.dataStoreId,
        bridgeReady,
      };
      printEnsureRunningResult(result, json, io);
      return 0;
    }

    if (command === "status") {
      if (arguments_.length > 0) throw new Error(`Unexpected status option: ${arguments_[0]}`);
      const exitCode = await delegate(["status"]);
      const healthTarget = runtimeHealthTarget(projectRoot(), environment);
      let runtimeDataStoreId: string | null = null;
      let runtimeReady = false;
      try {
        const health = await verifyHealthEndpoint(
          healthTarget.origin,
          "/health/ready",
          healthTarget.hostHeader,
        );
        runtimeDataStoreId = health.dataStoreId;
        runtimeReady = health.ready;
        io.stdout(health.ready
          ? `FormaSpec UI/API is ready at ${healthTarget.origin} (data store ${runtimeDataStoreId}).`
          : `FormaSpec UI/API identity is available at ${healthTarget.origin} (data store ${runtimeDataStoreId}), but readiness returned HTTP ${health.status}.`);
      } catch (error) {
        io.stdout(`FormaSpec UI/API identity is unavailable at ${healthTarget.origin} (${error instanceof Error ? error.message : String(error)}).`);
      }
      const competingDocker = await concurrentDockerDataStore(
        projectRoot(),
        healthTarget.origin,
        runtimeDataStoreId,
      );
      if (competingDocker !== null) {
        io.stdout(`FormaSpec status: multiple active data stores. Recorded UI/API ${healthTarget.origin} uses ${runtimeDataStoreId}; Docker ${competingDocker.origin} uses ${competingDocker.dataStoreId}. Stop the unintended runtime.`);
        return 1;
      }
      const proxyServerUrl = recordedProxyServerUrl(projectRoot(), environment);
      if (proxyServerUrl !== null) {
        io.stdout(proxyServerBridgeMessage(proxyServerUrl));
        return runtimeReady ? exitCode : 1;
      }
      const bridgeStatus = await bridge().status();
      io.stdout(`FormaSpec bridge is ${bridgeStatus.running ? "running" : "stopped"} at ${bridgeStatus.url}.`);
      if (bridgeStatus.running) {
        io.stdout(`FormaSpec bridge upstream is ${bridgeStatus.upstreamOrigin ?? "unavailable"} (data store ${bridgeStatus.dataStoreId ?? "unavailable"}).`);
      }
      if (bridgeStatus.running && (bridgeStatus.upstreamOrigin !== healthTarget.origin
        || runtimeDataStoreId === null
        || bridgeStatus.dataStoreId !== runtimeDataStoreId)) {
        io.stdout("FormaSpec status: runtime mismatch. Start the intended runtime again or run './designer restart' before using Codex.");
        return 1;
      }
      if (bridgeStatus.running && (!runtimeReady || !bridgeStatus.upstreamReady)) {
        io.stdout("FormaSpec status: UI/API and bridge data-store identity match, but the runtime is temporarily not ready.");
        return 1;
      }
      return exitCode;
    }

    if (command === "start") {
      const startArguments = validateStartArguments([...arguments_, ...(globalNoOpen ? ["--no-open"] : [])]);
      const exitCode = await delegate([...(assumeYes ? ["--yes"] : []), "start", ...startArguments]);
      if (exitCode !== 0) return exitCode;
      if (startArguments[0] === "docker" || startArguments[0] === "server") await recordDockerBinding();
      const proxyServerUrl = recordedProxyServerUrl(projectRoot(), environment);
      if (proxyServerUrl !== null) {
        io.stdout(proxyServerBridgeMessage(proxyServerUrl));
        return 0;
      }
      const bridgeStatus = await bridge().ensureStarted();
      io.stdout(`FormaSpec bridge is ready at ${bridgeStatus.url}.`);
      await offerCodexConnection();
      return 0;
    }

    if (command === "stop") {
      if (arguments_.length > 0) throw new Error(`Unexpected stop option: ${arguments_[0]}`);
      await bridge().stop();
      return await delegate(["stop"]);
    }

    if (command === "restart") {
      if (arguments_.length > 0) throw new Error(`Unexpected restart option: ${arguments_[0]}`);
      await bridge().stop();
      const exitCode = await delegate(["restart"]);
      if (exitCode !== 0) return exitCode;
      if (["docker", "server"].includes(recordedRuntimeMode(projectRoot(), environment) ?? "")) await recordDockerBinding();
      const proxyServerUrl = recordedProxyServerUrl(projectRoot(), environment);
      if (proxyServerUrl !== null) {
        io.stdout(proxyServerBridgeMessage(proxyServerUrl));
        return 0;
      }
      const bridgeStatus = await bridge().ensureStarted();
      io.stdout(`FormaSpec bridge is ready at ${bridgeStatus.url}.`);
      await offerCodexConnection();
      return 0;
    }

    if (command === "migrate") {
      if (arguments_.shift() !== "status") throw new Error("Use: formaspecctl migrate status [--json]");
      const option = arguments_.shift();
      if (option !== undefined && option !== "--json") throw new Error(`Unexpected migrate status option: ${option}`);
      const json = option === "--json";
      if (arguments_.length > 0) throw new Error(`Unexpected migrate status option: ${arguments_[0]}`);
      const database = defaultDatabasePath(projectRoot(), environment);
      if (!fs.existsSync(database)) throw new Error(`Database is not available at ${database}. Docker volume databases must be verified through a FormaSpec backup.`);
      const status = readMigrationStatus(database);
      if (json) io.stdout(JSON.stringify(status));
      else {
        io.stdout(`Database: ${status.databasePath}`);
        io.stdout(`Migration ledger: ${status.latestAppliedVersion}/${status.supportedVersion} (${status.state})`);
        for (const migration of status.migrations) io.stdout(`  ${migration.version} ${migration.name} ${migration.appliedAt}`);
      }
      return 0;
    }

    if (command === "support-bundle") {
      return await runSupportBundleCli(arguments_, {
        projectRoot: projectRoot(),
        environment,
        io,
        assumeYes,
      });
    }

    if (command === "audit") {
      if (arguments_.shift() !== "retention") {
        throw new Error("Use: formaspecctl audit retention preview|list|execute [options]");
      }
      const retentionCommand = arguments_.shift();
      type CandidateSummary = {
        count: number;
        bytes: number;
        firstId: number | null;
        lastId: number | null;
        sha256: string;
        hasMore: boolean;
      };
      type RetentionPreview = {
        previewId: string;
        configurationHash: string;
        policyHash: string;
        retentionDays: number;
        cutoffAt: string;
        planHash: string;
        auditEvents: CandidateSummary;
        outboxEvents: CandidateSummary;
        generatedAt: string;
        expiresAt: string;
      };
      type RetentionRun = Omit<RetentionPreview, "generatedAt" | "expiresAt"> & {
        runId: string;
        previousRunHash: string | null;
        runHash: string;
        commitAuditEventId: number;
        commitOutboxEventId: number;
        completedAt: string;
      };
      if (retentionCommand === "list") {
        const option = arguments_.shift();
        if (option !== undefined && option !== "--json") throw new Error(`Unexpected audit retention list option: ${option}`);
        if (arguments_.length > 0) throw new Error(`Unexpected audit retention list option: ${arguments_[0]}`);
        const { runs } = await requestLocalApi<{ runs: RetentionRun[] }>(
          "/api/organization/audit-retention/runs",
        );
        if (option === "--json") io.stdout(JSON.stringify(runs));
        else if (runs.length === 0) io.stdout("No audit-retention runs were found.");
        else for (const run of runs) {
          io.stdout(`${run.runId}  completed=${run.completedAt}  audit=${run.auditEvents.count}  outbox=${run.outboxEvents.count}  sha256=${run.runHash}`);
        }
        return 0;
      }
      if (retentionCommand === "preview") {
        const option = arguments_.shift();
        if (option !== undefined && option !== "--json") throw new Error(`Unexpected audit retention preview option: ${option}`);
        if (arguments_.length > 0) throw new Error(`Unexpected audit retention preview option: ${arguments_[0]}`);
        const { preview } = await requestLocalApi<{ preview: RetentionPreview }>(
          "/api/organization/audit-retention/previews",
          { method: "POST", body: JSON.stringify({}) },
        );
        if (option === "--json") io.stdout(JSON.stringify(preview));
        else {
          io.stdout(`Audit-retention preview: ${preview.previewId}`);
          io.stdout(`Policy: ${preview.retentionDays} days; cutoff: ${preview.cutoffAt}; expires: ${preview.expiresAt}`);
          io.stdout(`Would prune ${preview.auditEvents.count} audit events (${preview.auditEvents.bytes} canonical bytes) and ${preview.outboxEvents.count} published outbox events (${preview.outboxEvents.bytes} canonical bytes).`);
          if (preview.auditEvents.hasMore || preview.outboxEvents.hasMore) {
            io.stdout("This is a bounded batch; create another preview after committing it to continue retention.");
          }
          io.stdout(`Plan hash: ${preview.planHash}`);
          io.stdout(`Review the exact counts and hashes, then run: formaspecctl audit retention execute --preview-id ${preview.previewId} --plan-hash ${preview.planHash} --yes`);
        }
        return 0;
      }
      if (retentionCommand === "execute") {
        let previewId: string | undefined;
        let planHash: string | undefined;
        let idempotencyKey: string | undefined;
        let json = false;
        while (arguments_.length > 0) {
          const option = arguments_.shift();
          if (option === "--json") json = true;
          else if (option === "--preview-id") previewId = arguments_.shift();
          else if (option === "--plan-hash") planHash = arguments_.shift();
          else if (option === "--idempotency-key") idempotencyKey = arguments_.shift();
          else throw new Error(`Unexpected audit retention execute option: ${option}`);
        }
        if (!assumeYes) {
          throw new Error("audit retention is destructive. Create and review a preview, then rerun execute with explicit --yes authorization.");
        }
        if (!previewId || !/^audit_retention_preview_[a-f0-9]{32}$/.test(previewId)) {
          throw new Error("--preview-id requires an exact audit-retention preview ID.");
        }
        if (!planHash || !/^[a-f0-9]{64}$/.test(planHash)) {
          throw new Error("--plan-hash requires the exact audit-retention preview SHA-256.");
        }
        idempotencyKey ??= `audit-retention:${previewId}`;
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(idempotencyKey)) {
          throw new Error("--idempotency-key must be 8-200 safe identifier characters.");
        }
        const { result } = await requestLocalApi<{ result: RetentionRun }>(`/api/organization/audit-retention/previews/${previewId}/commit`, {
          method: "POST",
          body: JSON.stringify({ expectedPlanHash: planHash, idempotencyKey }),
        });
        if (json) io.stdout(JSON.stringify(result));
        else {
          io.stdout(`Audit retention committed: ${result.runId}`);
          io.stdout(`Pruned ${result.auditEvents.count} audit events and ${result.outboxEvents.count} published outbox events.`);
          io.stdout(`Immutable run hash: ${result.runHash}; completed: ${result.completedAt}`);
        }
        return 0;
      }
      throw new Error("Use: formaspecctl audit retention preview|list|execute [options]");
    }

    if (command === "backup") {
      const backupCommand = arguments_.shift();
      if (backupCommand === "schedule") {
        const scheduleCommand = arguments_.shift();
        if (!scheduleCommand || !["show", "enable", "disable", "run"].includes(scheduleCommand)) {
          throw new Error("Use: formaspecctl backup schedule show|enable|disable|run [--at HH:MM] [--json]");
        }
        let json = false;
        let at: string | undefined;
        while (arguments_.length > 0) {
          const option = arguments_.shift();
          if (option === "--json") json = true;
          else if (option === "--at") {
            at = arguments_.shift();
            if (!at || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(at)) throw new Error("--at requires a UTC time in HH:MM form.");
          } else throw new Error(`Unexpected backup schedule option: ${option}`);
        }
        if (at !== undefined && scheduleCommand !== "enable") throw new Error("--at is supported only by backup schedule enable.");

        type Schedule = {
          enabled: boolean;
          cronExpression: string;
          timezone: "UTC";
          retention: { daily: number; weekly: number; monthly: number };
          updatedAt: string | null;
          lastScheduledBackupAt: string | null;
          nextDueAt: string | null;
          supervision?: {
            status: "disabled" | "healthy" | "warning" | "critical";
            dueAt: string | null;
            graceEndsAt: string | null;
            currentWindowCovered: boolean;
            retention: { candidateCount: number; candidateBytes: number; protectedCount: number; planHash: string };
            alerts: Array<{ code: string; severity: "warning" | "critical"; message: string }>;
          };
        };
        if (scheduleCommand === "run") {
          const result = await requestLocalApi<{ run: {
            status: "disabled" | "already_completed" | "created";
            dueAt: string | null;
            nextDueAt: string | null;
            retentionClass: string | null;
            backup: { id: string; filename: string } | null;
          } }>("/api/backups/schedule/run", { method: "POST", body: JSON.stringify({}) });
          if (json) io.stdout(JSON.stringify(result.run));
          else if (result.run.status === "disabled") io.stdout("Managed backup scheduling is disabled.");
          else if (result.run.status === "already_completed") {
            io.stdout(`Scheduled window already completed: ${result.run.dueAt}; backup=${result.run.backup?.id ?? "unknown"}`);
          } else {
            io.stdout(`Scheduled backup created: ${result.run.backup?.filename ?? "unknown"}`);
            io.stdout(`Window: ${result.run.dueAt}; retention class: ${result.run.retentionClass}`);
          }
          return 0;
        }

        const current = await requestLocalApi<{ schedule: Schedule }>("/api/backups/schedule");
        let schedule = current.schedule;
        if (scheduleCommand === "enable" || scheduleCommand === "disable") {
          const cronExpression = at === undefined
            ? schedule.cronExpression
            : `${Number(at.slice(3, 5))} ${Number(at.slice(0, 2))} * * *`;
          const updated = await requestLocalApi<{ schedule: Schedule }>("/api/backups/schedule", {
            method: "PUT",
            body: JSON.stringify({ enabled: scheduleCommand === "enable", cronExpression }),
          });
          schedule = updated.schedule;
        }
        if (json) io.stdout(JSON.stringify(schedule));
        else {
          io.stdout(`Managed backup schedule: ${schedule.enabled ? "enabled" : "disabled"}`);
          io.stdout(`UTC cron: ${schedule.cronExpression}; retention: ${schedule.retention.daily} daily / ${schedule.retention.weekly} weekly / ${schedule.retention.monthly} monthly`);
          io.stdout(`Last scheduled backup: ${schedule.lastScheduledBackupAt ?? "never"}; next due: ${schedule.nextDueAt ?? "disabled"}`);
          if (schedule.supervision) {
            io.stdout(`Backup supervision: ${schedule.supervision.status}; current window covered: ${schedule.supervision.currentWindowCovered ? "yes" : "no"}; retention candidates: ${schedule.supervision.retention.candidateCount}`);
            for (const alert of schedule.supervision.alerts) {
              io.stdout(`  ${alert.severity.toUpperCase()} ${alert.code}: ${alert.message}`);
            }
          }
        }
        return 0;
      }
      if (backupCommand === "prune") {
        const pruneCommand = arguments_.shift();
        if (pruneCommand === "preview") {
          const option = arguments_.shift();
          if (option !== undefined && option !== "--json") throw new Error(`Unexpected backup prune preview option: ${option}`);
          if (arguments_.length > 0) throw new Error(`Unexpected backup prune preview option: ${arguments_[0]}`);
          const preview = await requestLocalApi<{ preview: {
            previewId: string;
            planHash: string;
            expiresAt: string;
            candidates: Array<{ id: string; filename: string; sizeBytes: number; retentionClass: string }>;
            retainedCount: number;
            manualExemptCount: number;
            protectedCount: number;
            totalCandidateBytes: number;
          } }>("/api/backups/prune/previews", { method: "POST", body: JSON.stringify({}) });
          if (option === "--json") io.stdout(JSON.stringify(preview.preview));
          else {
            io.stdout(`Prune preview: ${preview.preview.previewId}`);
            io.stdout(`Plan hash: ${preview.preview.planHash}; expires: ${preview.preview.expiresAt}`);
            io.stdout(`Would prune ${preview.preview.candidates.length} scheduled backups (${preview.preview.totalCandidateBytes} bytes).`);
            io.stdout(`Manual backups exempt: ${preview.preview.manualExemptCount}; retained scheduled backups: ${preview.preview.retainedCount}; protected/incomplete: ${preview.preview.protectedCount}.`);
            for (const candidate of preview.preview.candidates) {
              io.stdout(`  ${candidate.id}  ${candidate.retentionClass}  ${candidate.sizeBytes}  ${candidate.filename}`);
            }
            io.stdout(`Review this exact list, then run: formaspecctl backup prune execute --preview-id ${preview.preview.previewId} --plan-hash ${preview.preview.planHash} --yes`);
          }
          return 0;
        }
        if (pruneCommand === "execute") {
          let previewId: string | undefined;
          let planHash: string | undefined;
          let json = false;
          while (arguments_.length > 0) {
            const option = arguments_.shift();
            if (option === "--json") json = true;
            else if (option === "--preview-id") previewId = arguments_.shift();
            else if (option === "--plan-hash") planHash = arguments_.shift();
            else throw new Error(`Unexpected backup prune execute option: ${option}`);
          }
          if (!assumeYes) throw new Error("backup prune is destructive. Create and review a preview, then rerun execute with explicit --yes authorization.");
          if (!previewId || !/^backup_prune_preview_[a-f0-9]{32}$/.test(previewId)) throw new Error("--preview-id requires an exact backup-prune preview ID.");
          if (!planHash || !/^[a-f0-9]{64}$/.test(planHash)) throw new Error("--plan-hash requires the exact preview SHA-256.");
          const committed = await requestLocalApi<{ result: {
            previewId: string;
            planHash: string;
            prunedBackupIds: string[];
            prunedBytes: number;
            cleanupPending: boolean;
          } }>(`/api/backups/prune/previews/${previewId}/commit`, {
            method: "POST",
            body: JSON.stringify({ expectedPlanHash: planHash }),
          });
          if (json) io.stdout(JSON.stringify(committed.result));
          else {
            io.stdout(`Pruned ${committed.result.prunedBackupIds.length} scheduled backups (${committed.result.prunedBytes} bytes).`);
            if (committed.result.cleanupPending) io.stdout("Warning: staged filesystem cleanup remains pending; inspect the backup operations audit.");
          }
          return 0;
        }
        throw new Error("Use: formaspecctl backup prune preview|execute [options]");
      }
      if (backupCommand === "create" || backupCommand === "list") {
        const option = arguments_.shift();
        if (option !== undefined && option !== "--json") throw new Error(`Unexpected backup ${backupCommand} option: ${option}`);
        if (arguments_.length > 0) throw new Error(`Unexpected backup ${backupCommand} option: ${arguments_[0]}`);
        const json = option === "--json";
        if (backupCommand === "create") {
          const result = await requestLocalApi<{ backup: {
            id: string;
            filename: string;
            status: string;
            bundleSha256: string | null;
            verifiedAt: string | null;
          } }>("/api/backups", { method: "POST", body: JSON.stringify({}) });
          if (json) io.stdout(JSON.stringify(result.backup));
          else {
            io.stdout(`Backup created: ${result.backup.filename}`);
            io.stdout(`Record: ${result.backup.id}; status: ${result.backup.status}; verified: ${result.backup.verifiedAt ?? "not verified"}`);
            if (result.backup.bundleSha256) io.stdout(`SHA-256: ${result.backup.bundleSha256}`);
          }
          return 0;
        }
        const result = await requestLocalApi<{ backups: Array<{
          id: string;
          filename: string;
          status: string;
          createdAt: string;
          verifiedAt: string | null;
        }> }>("/api/backups");
        if (json) io.stdout(JSON.stringify(result.backups));
        else if (result.backups.length === 0) io.stdout("No managed FormaSpec backups were found.");
        else for (const backup of result.backups) {
          io.stdout(`${backup.id}  ${backup.status}  ${backup.filename}  created=${backup.createdAt}  verified=${backup.verifiedAt ?? "never"}`);
        }
        return 0;
      }
      if (backupCommand === "restore") {
        const subject = arguments_.shift();
        const dockerDependencies: DockerRestoreDependencies = { environment, commandRunner: runner };
        const reportDockerResult = (result: DockerRestoreResult, json: boolean): void => {
          if (json) {
            io.stdout(JSON.stringify(result));
            return;
          }
          if (result.status === "restored") {
            io.stdout(`Managed backup restored: ${result.backupId}`);
            io.stdout(`Pre-restore safety backup: ${result.safetyBackupId}`);
          } else if (result.status === "rolled_back") {
            io.stdout(`Restore operation rolled back safely: ${result.operationId}`);
          } else if (result.status === "forensic_rolled_back") {
            io.stdout(`Forensic pre-restore bytes restored: ${result.safetyBackupId}`);
            io.stdout("The previous data may still contain corruption. The API remains stopped and maintenance stays active; apply another verified offline restore before serving traffic.");
          } else {
            io.stdout(`Forensic rollback was aborted safely; verified restored target ${result.backupId} remains active.`);
          }
          if (result.serviceReady) {
            io.stdout("FormaSpec passed database and deterministic renderer verification and is ready.");
            io.stdout("All restored agent grants were revoked. Reconnect Codex with 'formaspecctl agent connect codex'.");
          }
        };
        if (subject === "offline") {
          const bundle = arguments_.shift();
          if (bundle === undefined || bundle.startsWith("--")) {
            throw new Error("backup restore offline requires an explicitly selected verified bundle path.");
          }
          const option = arguments_.shift();
          if (option !== undefined && option !== "--json") throw new Error(`Unexpected offline restore option: ${option}`);
          if (arguments_.length > 0) throw new Error(`Unexpected offline restore option: ${arguments_[0]}`);
          if (!assumeYes) {
            throw new Error("offline disaster recovery replaces the pinned Docker/server data volume. Rerun with explicit --yes authorization.");
          }
          const root = projectRoot();
          assertDockerRestoreMode(recordedRuntimeMode(root, environment));
          const resolvedBundle = path.resolve(bundle);
          const verification = await (dependencies.backupVerifier ?? verifyBackup)(resolvedBundle);
          if (verification.migrationVersion > CLI_SUPPORTED_DATABASE_VERSION) {
            throw new Error(
              `Backup database version ${verification.migrationVersion} is newer than this formaspecctl supports (${CLI_SUPPORTED_DATABASE_VERSION}); no data was changed.`,
            );
          }
          await bridge().stop();
          const result = await (dependencies.restoreDockerBackupOffline ?? restoreDockerBackupOffline)(
            root,
            {
              path: resolvedBundle,
              sha256: verification.bundleSha256,
              sizeBytes: verification.bundleSizeBytes,
            },
            io,
            dockerDependencies,
          );
          reportDockerResult(result, option === "--json");
          return 0;
        }
        if (subject === "status") {
          const option = arguments_.shift();
          if (option !== undefined && option !== "--json") throw new Error(`Unexpected backup restore status option: ${option}`);
          if (arguments_.length > 0) throw new Error(`Unexpected backup restore status option: ${arguments_[0]}`);
          const status = await (dependencies.dockerRestoreStatus ?? dockerRestoreStatus)(projectRoot(), dockerDependencies);
          if (option === "--json") io.stdout(JSON.stringify(status));
          else {
            if (!status.maintenance.active) io.stdout("Restore maintenance: inactive");
            else if (!status.maintenance.markerValid) io.stdout("Restore maintenance: active with invalid state; operator inspection is required");
            else io.stdout(`Restore maintenance: ${status.maintenance.phase} (${status.maintenance.operationId})`);
            if (status.operation === null) io.stdout("Durable restore operation: not created");
            else {
              io.stdout(`Durable restore operation: ${status.operation.phase} (${status.operation.operationId})`);
              io.stdout(`Target backup: ${status.operation.backupId}; safety backup: ${status.operation.safetyBackupId}`);
              if (status.operation.errorCode) io.stdout(`Terminal error code: ${status.operation.errorCode}`);
            }
            if (!status.workerLock.active) io.stdout("Shared restore worker lock: inactive");
            else if (!status.workerLock.lockValid) io.stdout("Shared restore worker lock: invalid; operator inspection is required");
            else {
              io.stdout(`Shared restore worker lock: active (${status.workerLock.operationId})`);
              io.stdout(`Worker container: ${status.workerLock.containerId ?? "unavailable"}; acquired: ${status.workerLock.acquiredAt}`);
            }
          }
          return 0;
        }
        if (subject === "abort" || subject === "clear-stale-lock") {
          const option = arguments_.shift();
          if (option !== undefined && option !== "--json") {
            throw new Error(`Unexpected backup restore ${subject} option: ${option}`);
          }
          if (arguments_.length > 0) throw new Error(`Unexpected backup restore ${subject} option: ${arguments_[0]}`);
          if (!assumeYes) {
            throw new Error(`backup restore ${subject} changes recovery state. Rerun with explicit --yes authorization.`);
          }
          if (subject === "abort") {
            const result = await (dependencies.abortDockerRestore ?? abortDockerRestore)(projectRoot(), dockerDependencies);
            if (option === "--json") io.stdout(JSON.stringify(result));
            else {
              io.stdout(`Restore operation aborted before cutover: ${result.operationId}`);
              io.stdout("Maintenance cleared and the unchanged FormaSpec service is ready.");
            }
          } else {
            const result = await (dependencies.clearStaleDockerRestoreLock ?? clearStaleDockerRestoreLock)(
              projectRoot(),
              dockerDependencies,
            );
            if (option === "--json") io.stdout(JSON.stringify(result));
            else {
              io.stdout(`Cleared proven-stale restore worker lock: ${result.operationId}`);
              io.stdout("Run 'formaspecctl backup restore resume --yes' to continue recovery.");
            }
          }
          return 0;
        }
        if (subject === "resume") {
          let backupId: string | undefined;
          let offlineBundle: string | undefined;
          let json = false;
          while (arguments_.length > 0) {
            const option = arguments_.shift();
            if (option === "--json") json = true;
            else if (option === "--backup-id") {
              const value = arguments_.shift();
              if (value === undefined) throw new Error("--backup-id requires a managed backup ID.");
              backupId = assertBackupId(value);
            } else if (option === "--offline-bundle") {
              const value = arguments_.shift();
              if (value === undefined) throw new Error("--offline-bundle requires a verified bundle path.");
              offlineBundle = path.resolve(value);
            } else throw new Error(`Unexpected backup restore resume option: ${option}`);
          }
          if (!assumeYes) throw new Error("backup restore resume may complete a database cutover. Rerun with explicit --yes authorization.");
          if (backupId !== undefined && offlineBundle !== undefined) {
            throw new Error("backup restore resume accepts either --backup-id or --offline-bundle, not both.");
          }
          await bridge().stop();
          let result: DockerRestoreResult;
          if (offlineBundle !== undefined) {
            const root = projectRoot();
            assertDockerRestoreMode(recordedRuntimeMode(root, environment));
            const verification = await (dependencies.backupVerifier ?? verifyBackup)(offlineBundle);
            if (verification.migrationVersion > CLI_SUPPORTED_DATABASE_VERSION) {
              throw new Error(
                `Backup database version ${verification.migrationVersion} is newer than this formaspecctl supports (${CLI_SUPPORTED_DATABASE_VERSION}); no data was changed.`,
              );
            }
            result = await (dependencies.resumeOfflineDockerRestore ?? resumeOfflineDockerRestore)(
              root,
              {
                path: offlineBundle,
                sha256: verification.bundleSha256,
                sizeBytes: verification.bundleSizeBytes,
              },
              dockerDependencies,
            );
          } else {
            result = await (dependencies.resumeDockerRestore ?? resumeDockerRestore)(
              projectRoot(),
              backupId,
              dockerDependencies,
            );
          }
          reportDockerResult(result, json);
          return 0;
        }
        if (subject === "rollback") {
          const option = arguments_.shift();
          if (option !== undefined && option !== "--json") throw new Error(`Unexpected backup restore rollback option: ${option}`);
          if (arguments_.length > 0) throw new Error(`Unexpected backup restore rollback option: ${arguments_[0]}`);
          if (!assumeYes) throw new Error("backup restore rollback restores the verified safety backup. Rerun with explicit --yes authorization.");
          await bridge().stop();
          const result = await (dependencies.rollbackDockerRestore ?? rollbackDockerRestore)(
            projectRoot(),
            io,
            dockerDependencies,
          );
          reportDockerResult(result, option === "--json");
          return 0;
        }
        if (subject === "--backup-id") {
          const value = arguments_.shift();
          if (value === undefined) throw new Error("--backup-id requires a managed backup ID.");
          const backupId = assertBackupId(value);
          const option = arguments_.shift();
          if (option !== undefined && option !== "--json") throw new Error(`Unexpected backup restore option: ${option}`);
          if (arguments_.length > 0) throw new Error(`Unexpected backup restore option: ${arguments_[0]}`);
          if (!assumeYes) {
            throw new Error("backup restore replaces the pinned Docker/server data volume. Review the managed backup and rerun with explicit --yes authorization.");
          }
          await bridge().stop();
          const result = await (dependencies.restoreDockerBackup ?? restoreDockerBackup)(
            projectRoot(),
            backupId,
            io,
            dockerDependencies,
          );
          reportDockerResult(result, option === "--json");
          return 0;
        }

        const bundle = subject;
        if (bundle === undefined || bundle.startsWith("--")) {
          throw new Error("backup restore requires a source-local bundle path or Docker --backup-id.");
        }
        const option = arguments_.shift();
        if (option !== undefined && option !== "--json") throw new Error(`Unexpected backup restore option: ${option}`);
        const json = option === "--json";
        if (arguments_.length > 0) throw new Error(`Unexpected backup restore option: ${arguments_[0]}`);
        if (!assumeYes) {
          throw new Error("backup restore replaces the source-local ./data directory. Review the bundle and rerun with explicit --yes authorization.");
        }

        const root = projectRoot();
        const mode = recordedRuntimeMode(root, environment);
        assertSourceLocalRestoreMode(root, mode, environment);
        const resolvedBundle = path.resolve(bundle);
        const verification = await (dependencies.backupVerifier ?? verifyBackup)(resolvedBundle);
        if (verification.migrationVersion > CLI_SUPPORTED_DATABASE_VERSION) {
          throw new Error(
            `Backup database version ${verification.migrationVersion} is newer than this formaspecctl supports (${CLI_SUPPORTED_DATABASE_VERSION}); no data was changed.`,
          );
        }

        const dataDirectory = runtimePaths().dataDirectory;
        if (fs.existsSync(dataDirectory)) {
          const dataStat = fs.lstatSync(dataDirectory);
          if (!dataStat.isDirectory() || dataStat.isSymbolicLink()) {
            throw new Error(`The source-local data target must be a real directory: ${dataDirectory}`);
          }
        }
        const restore = dependencies.restoreVerifiedBackup ?? await loadRestoreVerifiedBackup(root);

        await bridge().stop();
        if (mode === "local" || mode === "dev") {
          const stopExitCode = await delegate(["stop"]);
          if (stopExitCode !== 0) throw new Error("FormaSpec did not stop cleanly; restore was cancelled before data mutation.");
        }
        if (managedPidIsAlive(root, environment)) {
          throw new Error("The managed FormaSpec process is still running after stop; restore was cancelled before data mutation.");
        }

        let preRestoreBackup: string | null = null;
        if (fs.existsSync(dataDirectory)) {
          preRestoreBackup = preRestoreBackupPath(root, dependencies.now?.() ?? new Date(), environment);
          const backupExitCode = await delegate(["backup", preRestoreBackup]);
          if (backupExitCode !== 0) {
            throw new Error("The pre-restore safety backup failed; restore was cancelled and the active data directory was not replaced.");
          }
        }

        await restore(resolvedBundle, dataDirectory, {
          databaseClosed: true,
          expectedSource: {
            sha256: verification.bundleSha256,
            sizeBytes: verification.bundleSizeBytes,
          },
          healthCheck: async (restoredDataDirectory) => {
            const status = readMigrationStatus(path.join(restoredDataDirectory, "designer.sqlite"));
            if (status.latestAppliedVersion !== verification.migrationVersion) {
              throw new Error(
                `Restored migration ledger ${status.latestAppliedVersion} does not match the verified bundle ${verification.migrationVersion}.`,
              );
            }
            if (status.state === "newer") {
              throw new Error(`Restored database version ${status.latestAppliedVersion} is newer than this formaspecctl supports.`);
            }
          },
        });

        const result = {
          restored: true as const,
          bundle: resolvedBundle,
          destination: dataDirectory,
          migrationVersion: verification.migrationVersion,
          preRestoreBackup,
          serviceState: "stopped" as const,
        };
        if (json) io.stdout(JSON.stringify(result));
        else {
          io.stdout(`Backup restored to: ${dataDirectory}`);
          io.stdout(`Verified migration version: ${verification.migrationVersion}`);
          if (preRestoreBackup === null) io.stdout("Pre-restore backup: not needed because no existing source-local data directory was present.");
          else io.stdout(`Pre-restore safety copy: ${preRestoreBackup}`);
          io.stdout("FormaSpec remains stopped. Inspect the restored data, then run 'formaspecctl start local'.");
        }
        return 0;
      }
      if (backupCommand !== "verify") throw new Error("Use: formaspecctl backup create|list|schedule|prune|verify|restore [arguments]");
      const bundle = arguments_.shift();
      if (bundle === undefined || bundle.startsWith("--")) throw new Error("backup verify requires a bundle path.");
      const option = arguments_.shift();
      if (option !== undefined && option !== "--json") throw new Error(`Unexpected backup verify option: ${option}`);
      const json = option === "--json";
      if (arguments_.length > 0) throw new Error(`Unexpected backup verify option: ${arguments_[0]}`);
      const verification = await verifyBackup(path.resolve(bundle));
      if (json) io.stdout(JSON.stringify(verification));
      else {
        io.stdout(`Backup verified: ${path.resolve(bundle)}`);
        io.stdout(`Database integrity: ${verification.sqliteIntegrity}; migration version: ${verification.migrationVersion}`);
        io.stdout(`Entries: ${verification.entryCount}; expanded bytes: ${verification.expandedBytes}`);
      }
      return 0;
    }

    if (command === "agent") {
      const agentCommand = arguments_.shift();
      if (agentCommand === "config" && arguments_.shift() === "generic") {
        const hasExplicitUrl = arguments_.some((argument) => argument === "--url" || argument.startsWith("--url="));
        const proxyServerUrl = recordedProxyServerUrl(projectRoot(), environment);
        const status = proxyServerUrl === null ? await bridge().status() : null;
        return runGenericMcpConfigCli([
          ...arguments_,
          ...(hasExplicitUrl ? [] : ["--url", proxyServerUrl === null ? `${status!.url}/mcp` : `${proxyServerUrl}/mcp`]),
        ], io);
      }
      if (agentCommand !== "connect" || arguments_.shift() !== "codex") {
        throw new Error("Use: formaspecctl agent connect codex [--pairing-nonce <nonce>] [--connection-id <id>] [--yes] | agent config generic [options]");
      }
      let pairingNonce: string | undefined;
      let connectionId: string | undefined;
      while (arguments_.length > 0) {
        const option = arguments_.shift();
        if (option === "--pairing-nonce") {
          if (pairingNonce !== undefined) throw new Error("--pairing-nonce may be specified only once.");
          pairingNonce = arguments_.shift();
          if (pairingNonce === undefined || !/^fspair_[A-Za-z0-9_-]{43}$/.test(pairingNonce)) {
            throw new Error("--pairing-nonce requires an exact one-time FormaSpec pairing nonce.");
          }
        } else if (option === "--connection-id") {
          if (connectionId !== undefined) throw new Error("--connection-id may be specified only once.");
          connectionId = arguments_.shift();
          if (connectionId === undefined || !/^connection_[a-f0-9]{32}$/.test(connectionId)) {
            throw new Error("--connection-id requires an exact FormaSpec connection ID.");
          }
        } else {
          throw new Error(`Unexpected Codex connection option: ${option}`);
        }
      }
      if (connectionId !== undefined && pairingNonce === undefined) {
        throw new Error("--connection-id may be used only with --pairing-nonce.");
      }
      const proxyServerUrl = recordedProxyServerUrl(projectRoot(), environment);
      if (proxyServerUrl !== null) {
        throw new Error(proxyServerBridgeMessage(proxyServerUrl));
      }
      const result = await connectCodex({
        environment,
        commandRunner: runner,
        bridge: bridge(),
        confirm,
        assumeYes,
        ...(pairingNonce === undefined ? {} : {
          pairing: {
            nonce: pairingNonce,
            ...(connectionId === undefined ? {} : { connectionId }),
          },
        }),
      });
      reportCodexConnection(result);
      return 0;
    }

    throw new Error(`Unknown command: ${command}`);
  } catch (error) {
    io.stderr(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
