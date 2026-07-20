import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http, { type RequestOptions } from "node:http";
import path from "node:path";

import {
  buildHardenedDockerRunArguments,
  readDockerRuntimeBinding,
  sanitizedDockerProcessEnvironment,
  verifyDockerRuntimeBinding,
  type DockerRuntimeBinding,
} from "./docker-runtime-binding.js";
import { CLI_SUPPORTED_DATABASE_VERSION } from "./migrations.js";
import { findExecutable, runCommand, type CommandRunner } from "./process.js";

const backupIdPattern = /^backup_[a-f0-9]{40}$/;
const operationIdPattern = /^restore_[A-Za-z0-9][A-Za-z0-9_-]{7,111}$/;
const MAX_HEALTH_RESPONSE_BYTES = 64 * 1024;

export const DOCKER_RESTORE_CAPABILITY = "HEALTHY_PLANNED_RESTORE_ONLY" as const;

export interface RestoreHealthRequest {
  connectHost: "127.0.0.1" | "::1";
  port: number;
  hostHeader: string;
  pathname: "/health/live" | "/health/ready" | "/health/render";
  timeoutMs: number;
}

export interface RestoreHealthResponse {
  status: number;
  body: unknown;
}

export type HealthRequester = (request: RestoreHealthRequest) => Promise<RestoreHealthResponse>;

export interface DockerRestoreIo {
  stdout(message: string): void;
}

export interface DockerRestoreDependencies {
  environment?: NodeJS.ProcessEnv;
  commandRunner?: CommandRunner;
  fetch?: typeof fetch;
  healthRequester?: HealthRequester;
  now?: () => Date;
  createOperationId?: () => string;
  dockerExecutable?: string;
  healthTimeoutMs?: number;
  healthPollIntervalMs?: number;
}

export function dockerRestoreHealthRequestOptions(request: RestoreHealthRequest): RequestOptions {
  return {
    hostname: request.connectHost,
    port: request.port,
    path: request.pathname,
    method: "GET",
    agent: false,
    headers: {
      accept: "application/json",
      "cache-control": "no-store",
      host: request.hostHeader,
    },
  };
}

function requestRestoreHealth(request: RestoreHealthRequest): Promise<RestoreHealthResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let deadline: NodeJS.Timeout | undefined;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      callback();
    };
    const healthRequest = http.request(dockerRestoreHealthRequestOptions(request), (response) => {
      const chunks: Buffer[] = [];
      let received = 0;
      response.once("error", (error) => finish(() => reject(error)));
      response.once("aborted", () => finish(() => reject(new Error("FormaSpec health response was aborted."))));
      response.once("close", () => {
        if (!response.complete) finish(() => reject(new Error("FormaSpec health response closed before completion.")));
      });
      response.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += buffer.length;
        if (received > MAX_HEALTH_RESPONSE_BYTES) {
          response.destroy(new Error("FormaSpec health response exceeded its fixed limit."));
          return;
        }
        chunks.push(buffer);
      });
      response.once("end", () => {
        if (received > MAX_HEALTH_RESPONSE_BYTES) return;
        let body: unknown = null;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        } catch {
          // The caller's strict predicate rejects malformed health JSON.
        }
        finish(() => resolve({ status: response.statusCode ?? 0, body }));
      });
    });
    deadline = setTimeout(() => {
      const error = new Error("FormaSpec health request exceeded its absolute deadline.");
      finish(() => reject(error));
      healthRequest.destroy(error);
    }, request.timeoutMs);
    deadline.unref?.();
    healthRequest.once("error", (error) => finish(() => reject(error)));
    healthRequest.end();
  });
}

async function withAbsoluteDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("FormaSpec health probe exceeded its absolute deadline.")),
          timeoutMs,
        );
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export interface DockerRestoreOperationStatus {
  maintenance:
    | { active: false; markerValid: true }
    | { active: true; markerValid: false; phase: "unknown" }
    | {
      active: true;
      markerValid: true;
      phase: string;
      operationId: string;
      startedAt: string;
    };
  operation: null | {
    operationId: string;
    backupId: string;
    safetyBackupId: string;
    phase: "prepared" | "cutover_committed" | "reconciled" | "rolled_back";
    createdAt: string;
    updatedAt: string;
    smoke: null | { schemaVersion: number; renderedDesignId: string | null };
    result: null | {
      auditEventId: number;
      outboxEventId: number;
      revoked: { grants: number; connections: number; nonces: number };
    };
    errorCode: string | null;
  };
  workerLock:
    | { active: false; lockValid: true }
    | { active: true; lockValid: false }
    | {
      active: true;
      lockValid: true;
      operationId: string;
      ownerId: string;
      containerId: string | null;
      processId: number;
      acquiredAt: string;
    };
}

export interface DockerRestoreResult {
  status: "restored" | "rolled_back";
  operationId: string;
  backupId: string;
  safetyBackupId: string;
  maintenanceCleared: true;
  serviceReady: true;
  reconnectRequired: true;
  worker: Record<string, unknown> | null;
}

export interface DockerRestoreAbortResult {
  status: "aborted";
  operationId: string;
  maintenanceCleared: true;
  serviceReady: true;
}

export interface DockerRestoreStaleLockResult {
  status: "stale_lock_cleared";
  operationId: string;
  containerId: string;
}

function parseJsonLine(value: string, label: string): Record<string, unknown> {
  const candidates = value.trim().split("\n").reverse();
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Docker may print non-JSON progress lines around the one-shot result.
    }
  }
  throw new Error(`${label} did not return its structured result.`);
}

function assertOperationId(value: string): string {
  if (!operationIdPattern.test(value)) throw new Error("Restore operation ID is invalid.");
  return value;
}

export function assertBackupId(value: string): string {
  if (!backupIdPattern.test(value)) throw new Error("--backup-id requires an exact managed FormaSpec backup ID.");
  return value;
}

function acquireApplicationLock(projectRoot: string): () => void {
  const root = path.resolve(projectRoot);
  const designerDirectory = path.join(root, ".designer");
  const runDirectory = path.join(designerDirectory, "run");
  const lockDirectory = path.join(runDirectory, "launcher.lock");
  for (const [directory, label] of [
    [root, "FormaSpec project root"],
    [designerDirectory, "FormaSpec runtime directory"],
    [runDirectory, "FormaSpec runtime state directory"],
  ] as const) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory.`);
  }
  const readOwner = (): string => {
    const pidFile = path.join(lockDirectory, "pid");
    const stat = fs.lstatSync(pidFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 32) {
      throw new Error("The FormaSpec launcher lock owner file is unsafe.");
    }
    const flags = process.platform === "win32"
      ? fs.constants.O_RDONLY
      : fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
    const descriptor = fs.openSync(pidFile, flags);
    try {
      const verified = fs.fstatSync(descriptor);
      if (!verified.isFile() || verified.size !== stat.size) {
        throw new Error("The FormaSpec launcher lock owner changed while it was read.");
      }
      const bytes = Buffer.alloc(verified.size + 1);
      const count = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
      if (count !== verified.size) throw new Error("The FormaSpec launcher lock owner changed while it was read.");
      return bytes.subarray(0, count).toString("utf8").trim();
    } finally {
      fs.closeSync(descriptor);
    }
  };
  try {
    fs.mkdirSync(lockDirectory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const lockStat = fs.lstatSync(lockDirectory);
    if (!lockStat.isDirectory() || lockStat.isSymbolicLink()) {
      throw new Error("The FormaSpec launcher lock path is unsafe.");
    }
    const entries = fs.readdirSync(lockDirectory);
    if (entries.length !== 1 || entries[0] !== "pid") {
      throw new Error("The FormaSpec launcher lock contains unexpected state and cannot be reclaimed automatically.");
    }
    const owner = readOwner();
    if (/^\d+$/.test(owner)) {
      try {
        process.kill(Number(owner), 0);
        throw new Error(`Another FormaSpec launcher operation is running (PID ${owner}).`);
      } catch (ownerError) {
        if (ownerError instanceof Error && ownerError.message.startsWith("Another FormaSpec")) throw ownerError;
        const code = (ownerError as NodeJS.ErrnoException).code;
        if (code !== "ESRCH") throw new Error("The FormaSpec launcher lock cannot be safely reclaimed.");
      }
    } else {
      throw new Error("The FormaSpec launcher lock owner is invalid and cannot be reclaimed automatically.");
    }
    fs.unlinkSync(path.join(lockDirectory, "pid"));
    fs.rmdirSync(lockDirectory);
    fs.mkdirSync(lockDirectory, { mode: 0o700 });
  }
  fs.writeFileSync(path.join(lockDirectory, "pid"), `${process.pid}\n`, { mode: 0o600, flag: "wx" });
  return () => {
    try {
      if (readOwner() !== String(process.pid)) return;
      fs.unlinkSync(path.join(lockDirectory, "pid"));
      fs.rmdirSync(lockDirectory);
    } catch {
      // Never remove a lock that no longer has the exact owner and shape created above.
    }
  };
}

class DockerRestoreSupervisor {
  readonly #projectRoot: string;
  readonly #binding: DockerRuntimeBinding;
  readonly #runner: CommandRunner;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #docker: string;
  readonly #healthRequester: HealthRequester;
  readonly #healthTimeoutMs: number;
  readonly #healthPollIntervalMs: number;

  constructor(projectRoot: string, dependencies: DockerRestoreDependencies) {
    this.#projectRoot = projectRoot;
    try {
      this.#binding = readDockerRuntimeBinding(projectRoot);
    } catch (error) {
      throw new Error(
        "The pinned Docker/server runtime binding is missing or invalid. Run 'formaspecctl restart' with the current installer before restore.",
        { cause: error },
      );
    }
    this.#runner = dependencies.commandRunner ?? runCommand;
    this.#environment = sanitizedDockerProcessEnvironment(dependencies.environment ?? process.env);
    this.#docker = dependencies.dockerExecutable
      ?? findExecutable("docker", dependencies.environment ?? process.env)
      ?? "";
    if (!this.#docker) throw new Error("Docker is not installed or not available in PATH.");
    this.#healthRequester = dependencies.healthRequester ?? (dependencies.fetch === undefined
      ? requestRestoreHealth
      : async (request) => {
        const host = request.connectHost === "::1" ? "[::1]" : request.connectHost;
        const response = await dependencies.fetch!(`http://${host}:${request.port}${request.pathname}`, {
          headers: {
            "cache-control": "no-store",
            host: request.hostHeader,
          },
          signal: AbortSignal.timeout(request.timeoutMs),
        });
        return {
          status: response.status,
          body: await response.json().catch(() => null) as unknown,
        };
      });
    this.#healthTimeoutMs = dependencies.healthTimeoutMs ?? 120_000;
    this.#healthPollIntervalMs = dependencies.healthPollIntervalMs ?? 250;
    if (!Number.isSafeInteger(this.#healthTimeoutMs) || this.#healthTimeoutMs < 1 || this.#healthTimeoutMs > 300_000
      || !Number.isSafeInteger(this.#healthPollIntervalMs) || this.#healthPollIntervalMs < 1
      || this.#healthPollIntervalMs > 10_000) {
      throw new Error("Restore health supervision timing is invalid.");
    }
  }

  async #verifiedBinding(): Promise<DockerRuntimeBinding> {
    return verifyDockerRuntimeBinding(this.#projectRoot, {
      commandRunner: this.#runner,
      environment: this.#environment,
      dockerExecutable: this.#docker,
      context: this.#binding.context,
    });
  }

  async #dockerCommand(arguments_: readonly string[], label: string, timeoutMs = 180_000): Promise<string> {
    const result = await this.#runner(this.#docker, arguments_, {
      cwd: this.#projectRoot,
      env: this.#environment,
      timeoutMs,
    });
    if (result.exitCode !== 0) {
      throw new Error(`${label} failed.`);
    }
    return result.stdout;
  }

  async #oneShot(
    containerName: string,
    command: readonly string[],
    label: string,
    timeoutMs = 180_000,
  ): Promise<string> {
    const binding = await this.#verifiedBinding();
    return this.#dockerCommand(
      buildHardenedDockerRunArguments(binding, { containerName, command }),
      label,
      timeoutMs,
    );
  }

  async #boundContainerRunning(
    binding: DockerRuntimeBinding,
    containerId: string,
    label: string,
  ): Promise<boolean> {
    const state = parseJsonLine(await this.#dockerCommand([
      "--context", binding.context,
      "inspect", "--type", "container", "--format", "{\"running\":{{json .State.Running}}}",
      containerId,
    ], `${label} state`), `${label} state`);
    if (typeof state.running !== "boolean") throw new Error(`${label} state is invalid.`);
    return state.running;
  }

  async control(
    command: "set" | "status" | "clear" | "clear-stale-lock" | "abort",
    operationId?: string,
  ): Promise<DockerRestoreOperationStatus> {
    const output = await this.#oneShot(
      `fs-control-${randomUUID().replaceAll("-", "").slice(0, 24)}`,
      [
      "node", "apps/server/dist/restore-control.js", command,
      ...(operationId === undefined ? [] : ["--operation-id", assertOperationId(operationId)]),
      ],
      `Restore control ${command}`,
    );
    const envelope = parseJsonLine(output, "Restore control");
    if (envelope.ok !== true || typeof envelope.status !== "object" || envelope.status === null) {
      throw new Error("Restore control returned an invalid status envelope.");
    }
    return envelope.status as DockerRestoreOperationStatus;
  }

  async preflight(backupId: string): Promise<Record<string, unknown>> {
    const output = await this.#oneShot(
      `fs-preflight-${randomUUID().replaceAll("-", "").slice(0, 24)}`,
      [
        "node", "apps/server/dist/restore-worker.js", "preflight",
        "--backup-id", assertBackupId(backupId),
      ],
      "Restore preflight",
      30 * 60_000,
    );
    const envelope = parseJsonLine(output, "Restore preflight");
    if (envelope.ok !== true || typeof envelope.preflight !== "object" || envelope.preflight === null) {
      throw new Error("Restore preflight returned an invalid result envelope.");
    }
    return envelope.preflight as Record<string, unknown>;
  }

  async stopApi(): Promise<void> {
    const binding = await this.#verifiedBinding();
    if (!await this.#boundContainerRunning(binding, binding.containers.designer, "Bound FormaSpec API")) return;
    await this.#dockerCommand(
      ["--context", binding.context, "stop", "--time", "30", binding.containers.designer],
      "Stopping the bound FormaSpec API",
    );
  }

  async ensureRenderer(): Promise<void> {
    const binding = await this.#verifiedBinding();
    if (await this.#boundContainerRunning(binding, binding.containers.renderer, "Bound FormaSpec renderer")) return;
    await this.#dockerCommand(
      ["--context", binding.context, "start", binding.containers.renderer],
      "Starting the bound FormaSpec renderer",
    );
  }

  async startApi(): Promise<void> {
    const binding = await this.#verifiedBinding();
    if (await this.#boundContainerRunning(binding, binding.containers.designer, "Bound FormaSpec API")) return;
    await this.#dockerCommand(
      ["--context", binding.context, "start", binding.containers.designer],
      "Starting the bound FormaSpec API",
    );
  }

  async worker(backupId: string, operationId: string): Promise<Record<string, unknown>> {
    const output = await this.#oneShot(
      `fs-${assertOperationId(operationId)}`,
      [
        "node", "apps/server/dist/restore-worker.js",
        "--backup-id", assertBackupId(backupId),
        "--operation-id", operationId,
      ],
      "Restore worker",
      30 * 60_000,
    );
    const envelope = parseJsonLine(output, "Restore worker");
    if (envelope.ok !== true || typeof envelope.result !== "object" || envelope.result === null) {
      throw new Error("Restore worker returned an invalid result envelope.");
    }
    return envelope.result as Record<string, unknown>;
  }

  async workerContainerRunning(containerId: string): Promise<boolean> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(containerId)) {
      throw new Error("Persisted restore worker container identity is invalid.");
    }
    const binding = await this.#verifiedBinding();
    const candidates = (await this.#dockerCommand([
      "--context", binding.context,
      "ps", "-aq", "--no-trunc", "--filter", `id=${containerId}`,
    ], "Restore worker container lookup")).trim().split(/\r?\n/).filter(Boolean);
    if (candidates.length === 0) return false;
    if (candidates.length !== 1 || !candidates[0]!.startsWith(containerId)) {
      throw new Error("Restore worker container identity is ambiguous.");
    }
    const running = parseJsonLine(await this.#dockerCommand([
      "--context", binding.context,
      "inspect", "--type", "container", "--format", "{\"running\":{{json .State.Running}}}",
      candidates[0]!,
    ], "Restore worker container state"), "Restore worker container state");
    if (typeof running.running !== "boolean") throw new Error("Restore worker container state is invalid.");
    return running.running;
  }

  async #waitFor(
    pathname: RestoreHealthRequest["pathname"],
    predicate: (status: number, body: unknown) => boolean,
  ): Promise<void> {
    const binding = await this.#verifiedBinding();
    const deadline = Date.now() + this.#healthTimeoutMs;
    let lastStatus = 0;
    while (Date.now() < deadline) {
      try {
        const remainingMs = Math.max(1, deadline - Date.now());
        const request = {
          connectHost: binding.publicBinding.host,
          port: binding.publicBinding.port,
          hostHeader: binding.runtime.healthHostHeader,
          pathname,
          timeoutMs: Math.min(5_000, remainingMs),
        } as const;
        const response = await withAbsoluteDeadline(
          this.#healthRequester(request),
          request.timeoutMs,
        );
        lastStatus = response.status;
        if (predicate(response.status, response.body)) return;
      } catch {
        // The supervised API may still be starting.
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(this.#healthPollIntervalMs, remainingMs)));
    }
    throw new Error(`FormaSpec health verification timed out at ${pathname} (last HTTP status ${lastStatus || "unavailable"}).`);
  }

  async verifyUnderMaintenance(operationId: string): Promise<void> {
    await this.#waitFor("/health/live", (status, body) => (
      status === 200 && typeof body === "object" && body !== null
      && (body as Record<string, unknown>).ok === true
    ));
    await this.#waitFor("/health/render", (status, body) => {
      if (status !== 200 || typeof body !== "object" || body === null) return false;
      const value = body as Record<string, unknown>;
      return value.ok === true && value.mode === "worker" && value.renderer === "playwright"
        && value.softwareFallback === false;
    });
    await this.#waitFor("/health/ready", (status, body) => {
      if (status !== 503 || typeof body !== "object" || body === null) return false;
      const value = body as Record<string, unknown>;
      const render = value.render;
      const maintenance = value.maintenance;
      return value.ok === false && value.status === "maintenance" && value.database === "ready"
        && value.migrations === CLI_SUPPORTED_DATABASE_VERSION
        && typeof render === "object" && render !== null
        && (render as Record<string, unknown>).ok === true
        && (render as Record<string, unknown>).mode === "worker"
        && (render as Record<string, unknown>).renderer === "playwright"
        && (render as Record<string, unknown>).softwareFallback === false
        && typeof maintenance === "object" && maintenance !== null
        && (maintenance as Record<string, unknown>).operationId === operationId;
    });
  }

  async verifyReady(): Promise<void> {
    await this.#waitFor("/health/live", (status, body) => (
      status === 200 && typeof body === "object" && body !== null
      && (body as Record<string, unknown>).ok === true
    ));
    await this.#waitFor("/health/render", (status, body) => {
      if (status !== 200 || typeof body !== "object" || body === null) return false;
      const value = body as Record<string, unknown>;
      return value.ok === true && value.mode === "worker" && value.renderer === "playwright"
        && value.softwareFallback === false;
    });
    await this.#waitFor("/health/ready", (status, body) => {
      if (status !== 200 || typeof body !== "object" || body === null) return false;
      const value = body as Record<string, unknown>;
      const render = value.render;
      return value.ok === true && value.database === "ready"
        && value.migrations === CLI_SUPPORTED_DATABASE_VERSION
        && typeof render === "object" && render !== null
        && (render as Record<string, unknown>).ok === true
        && (render as Record<string, unknown>).mode === "worker"
        && (render as Record<string, unknown>).renderer === "playwright"
        && (render as Record<string, unknown>).softwareFallback === false;
    });
  }
}

async function finishTerminalOperation(
  supervisor: DockerRestoreSupervisor,
  status: DockerRestoreOperationStatus,
  worker: Record<string, unknown> | null,
): Promise<DockerRestoreResult> {
  const operation = status.operation;
  if (operation === null || (operation.phase !== "reconciled" && operation.phase !== "rolled_back")) {
    throw new Error("Restore operation has not reached a durable terminal state.");
  }
  await supervisor.startApi();
  await supervisor.verifyUnderMaintenance(operation.operationId);
  // The worker has already performed full semantic database verification and
  // a representative deterministic render. The restarted API now proved the
  // same database/schema/renderer while still fenced. Removing maintenance is
  // therefore the final state mutation; the following readiness poll is
  // observational and a crash cannot expose unverified restored data.
  await supervisor.control("clear", operation.operationId);
  await supervisor.verifyReady();
  return {
    status: operation.phase === "rolled_back" ? "rolled_back" : "restored",
    operationId: operation.operationId,
    backupId: operation.backupId,
    safetyBackupId: operation.safetyBackupId,
    maintenanceCleared: true,
    serviceReady: true,
    reconnectRequired: true,
    worker,
  };
}

async function executeWorkerAndFinish(
  supervisor: DockerRestoreSupervisor,
  backupId: string,
  operationId: string,
): Promise<DockerRestoreResult> {
  await supervisor.ensureRenderer();
  await supervisor.stopApi();
  const worker = await supervisor.worker(backupId, operationId);
  const terminal = await supervisor.control("status", operationId);
  return finishTerminalOperation(supervisor, terminal, worker);
}

export async function dockerRestoreStatus(
  projectRoot: string,
  dependencies: DockerRestoreDependencies = {},
): Promise<DockerRestoreOperationStatus> {
  return new DockerRestoreSupervisor(projectRoot, dependencies).control("status");
}

export async function abortDockerRestore(
  projectRoot: string,
  dependencies: DockerRestoreDependencies = {},
): Promise<DockerRestoreAbortResult> {
  const release = acquireApplicationLock(projectRoot);
  try {
    const supervisor = new DockerRestoreSupervisor(projectRoot, dependencies);
    const status = await supervisor.control("status");
    if (!status.maintenance.active || !status.maintenance.markerValid) {
      throw new Error("No valid active restore maintenance operation is available to abort.");
    }
    if (status.operation !== null && status.operation.phase !== "prepared") {
      throw new Error("Restore already passed the cancellable prepared phase and must be resumed or rolled back.");
    }
    if (status.workerLock.active) {
      throw new Error("Restore cannot abort while shared worker-lock evidence exists.");
    }
    const operationId = assertOperationId(status.maintenance.operationId);
    await supervisor.control("abort", operationId);
    await supervisor.startApi();
    await supervisor.verifyReady();
    return { status: "aborted", operationId, maintenanceCleared: true, serviceReady: true };
  } finally {
    release();
  }
}

export async function clearStaleDockerRestoreLock(
  projectRoot: string,
  dependencies: DockerRestoreDependencies = {},
): Promise<DockerRestoreStaleLockResult> {
  const release = acquireApplicationLock(projectRoot);
  try {
    const supervisor = new DockerRestoreSupervisor(projectRoot, dependencies);
    const status = await supervisor.control("status");
    if (status.maintenance.active && !status.maintenance.markerValid) {
      throw new Error("Active restore maintenance is invalid and requires operator inspection.");
    }
    if (!status.workerLock.active || !status.workerLock.lockValid) {
      throw new Error("No valid restore worker lock is available for stale-lock recovery.");
    }
    if (status.maintenance.active && status.workerLock.operationId !== status.maintenance.operationId) {
      throw new Error("Restore worker lock and maintenance ownership do not match.");
    }
    if (!status.maintenance.active && status.operation !== null
      && status.workerLock.operationId !== status.operation.operationId) {
      throw new Error("Restore worker lock and durable operation ownership do not match.");
    }
    if (status.workerLock.containerId === null) {
      throw new Error("Restore worker lock has no container identity; operator inspection is required.");
    }
    if (await supervisor.workerContainerRunning(status.workerLock.containerId)) {
      throw new Error("The restore worker container is still running; its shared lock is not stale.");
    }
    await supervisor.control("clear-stale-lock", status.workerLock.operationId);
    return {
      status: "stale_lock_cleared",
      operationId: status.workerLock.operationId,
      containerId: status.workerLock.containerId,
    };
  } finally {
    release();
  }
}

export async function restoreDockerBackup(
  projectRoot: string,
  backupId: string,
  io: DockerRestoreIo,
  dependencies: DockerRestoreDependencies = {},
): Promise<DockerRestoreResult> {
  const release = acquireApplicationLock(projectRoot);
  try {
    const supervisor = new DockerRestoreSupervisor(projectRoot, dependencies);
    const operationId = assertOperationId(
      dependencies.createOperationId?.() ?? `restore_${randomUUID().replaceAll("-", "")}`,
    );
    await supervisor.ensureRenderer();
    try {
      await supervisor.verifyReady();
      await supervisor.preflight(backupId);
    } catch (error) {
      throw new Error(
        `${DOCKER_RESTORE_CAPABILITY}: supervised Docker/server restore requires a healthy current API and database for backup resolution and preflight; offline disaster recovery is not implemented.`,
        { cause: error },
      );
    }
    io.stdout(`Restore operation: ${operationId}`);
    let fenced = false;
    try {
      await supervisor.control("set", operationId);
      fenced = true;
      return await executeWorkerAndFinish(supervisor, assertBackupId(backupId), operationId);
    } catch (error) {
      if (fenced) {
        const aborted = await supervisor.control("abort", operationId).then(
          () => true,
          () => false,
        );
        if (!aborted) {
          throw new Error(
            "Restore did not complete and maintenance remains active. Run 'formaspecctl backup restore status' before resume, stale-lock recovery, or rollback.",
            { cause: error },
          );
        }
        try {
          await supervisor.startApi();
          await supervisor.verifyReady();
        } catch (restartError) {
          throw new AggregateError(
            [error, restartError],
            "Restore was safely aborted before cutover, but the unchanged FormaSpec API did not restart cleanly.",
          );
        }
      }
      throw error;
    }
  } finally {
    release();
  }
}

export async function resumeDockerRestore(
  projectRoot: string,
  explicitBackupId: string | undefined,
  dependencies: DockerRestoreDependencies = {},
): Promise<DockerRestoreResult> {
  const release = acquireApplicationLock(projectRoot);
  try {
    const supervisor = new DockerRestoreSupervisor(projectRoot, dependencies);
    let status = await supervisor.control("status");
    if (!status.maintenance.active) {
      if (status.workerLock.active) {
        throw new Error(status.workerLock.lockValid
          ? "A stale restore control or worker lock blocks startup; prove its container is absent and clear it first."
          : "Restore worker lock state is invalid and requires operator inspection.");
      }
      if (status.operation?.phase !== "reconciled" && status.operation?.phase !== "rolled_back") {
        throw new Error("No active or durably completed restore operation is available to resume.");
      }
      await supervisor.verifyReady();
      return {
        status: status.operation.phase === "rolled_back" ? "rolled_back" : "restored",
        operationId: status.operation.operationId,
        backupId: status.operation.backupId,
        safetyBackupId: status.operation.safetyBackupId,
        maintenanceCleared: true,
        serviceReady: true,
        reconnectRequired: true,
        worker: null,
      };
    }
    if (!status.maintenance.markerValid) {
      throw new Error("Active restore maintenance is invalid and requires operator inspection.");
    }
    if (status.workerLock.active) {
      throw new Error(status.workerLock.lockValid
        ? "A restore worker still owns the shared volume lock; inspect its container before retrying."
        : "Restore worker lock state is invalid and requires operator inspection.");
    }
    const operationId = assertOperationId(status.maintenance.operationId);
    if (status.operation !== null && status.operation.operationId !== operationId) {
      if (status.operation.phase !== "reconciled" && status.operation.phase !== "rolled_back") {
        throw new Error("Maintenance and unfinished restore operation ownership do not match.");
      }
      await supervisor.control("set", operationId);
      status = await supervisor.control("status", operationId);
    }
    if (status.operation?.phase === "reconciled" || status.operation?.phase === "rolled_back") {
      return finishTerminalOperation(supervisor, status, null);
    }
    const backupId = status.operation?.backupId ?? explicitBackupId;
    if (backupId === undefined) {
      throw new Error("This restore stopped before its durable operation record was created; rerun resume with --backup-id.");
    }
    if (explicitBackupId !== undefined && status.operation !== null
      && explicitBackupId !== status.operation.backupId) {
      throw new Error("The supplied backup ID does not match the persisted restore operation.");
    }
    if (status.operation === null) await supervisor.preflight(backupId);
    try {
      return await executeWorkerAndFinish(supervisor, assertBackupId(backupId), operationId);
    } catch (error) {
      const aborted = status.operation === null
        ? await supervisor.control("abort", operationId).then(() => true, () => false)
        : false;
      if (status.operation === null && !aborted) {
        throw new Error(
          "Restore resume did not complete and maintenance remains active. Inspect restore status before retrying.",
          { cause: error },
        );
      }
      if (aborted) {
        try {
          await supervisor.startApi();
          await supervisor.verifyReady();
        } catch (restartError) {
          throw new AggregateError(
            [error, restartError],
            "Restore resume was safely aborted before cutover, but the unchanged FormaSpec API did not restart cleanly.",
          );
        }
      }
      throw error;
    }
  } finally {
    release();
  }
}

export async function rollbackDockerRestore(
  projectRoot: string,
  io: DockerRestoreIo,
  dependencies: DockerRestoreDependencies = {},
): Promise<DockerRestoreResult> {
  const release = acquireApplicationLock(projectRoot);
  try {
    const supervisor = new DockerRestoreSupervisor(projectRoot, dependencies);
    const status = await supervisor.control("status");
    if (status.operation === null) throw new Error("No persisted restore operation is available to roll back.");
    if (status.maintenance.active && !status.maintenance.markerValid) {
      throw new Error("Restore maintenance state is invalid and requires operator inspection.");
    }
    if (status.workerLock.active) {
      throw new Error(status.workerLock.lockValid
        ? "A restore worker still owns the shared volume lock; inspect its container before rollback."
        : "Restore worker lock state is invalid and requires operator inspection.");
    }
    if (status.operation.phase === "rolled_back") {
      if (status.maintenance.active) return finishTerminalOperation(supervisor, status, null);
      await supervisor.verifyReady();
      return {
        status: "rolled_back",
        operationId: status.operation.operationId,
        backupId: status.operation.backupId,
        safetyBackupId: status.operation.safetyBackupId,
        maintenanceCleared: true,
        serviceReady: true,
        reconnectRequired: true,
        worker: null,
      };
    }
    if (status.operation.phase !== "reconciled") {
      throw new Error("An interrupted restore must be resumed first; its verified rollback state is not yet conclusive.");
    }
    const safetyBackupId = status.operation.safetyBackupId;
    if (status.maintenance.active) await finishTerminalOperation(supervisor, status, null);
    else await supervisor.verifyReady();
    const operationId = assertOperationId(
      dependencies.createOperationId?.() ?? `restore_${randomUUID().replaceAll("-", "")}`,
    );
    await supervisor.ensureRenderer();
    await supervisor.preflight(safetyBackupId);
    io.stdout(`Rollback restore operation: ${operationId}`);
    let fenced = false;
    try {
      await supervisor.control("set", operationId);
      fenced = true;
      return await executeWorkerAndFinish(supervisor, safetyBackupId, operationId);
    } catch (error) {
      if (fenced) {
        const aborted = await supervisor.control("abort", operationId).then(() => true, () => false);
        if (!aborted) {
          throw new Error(
            "Rollback restore did not complete and maintenance remains active. Inspect restore status before retrying.",
            { cause: error },
          );
        }
        try {
          await supervisor.startApi();
          await supervisor.verifyReady();
        } catch (restartError) {
          throw new AggregateError(
            [error, restartError],
            "Rollback restore was safely aborted before cutover, but the unchanged FormaSpec API did not restart cleanly.",
          );
        }
      }
      throw error;
    }
  } finally {
    release();
  }
}
