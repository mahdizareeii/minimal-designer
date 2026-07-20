import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { persistDockerRuntimeBinding, type DockerRuntimeBinding } from "./docker-runtime-binding.js";
import {
  abortDockerRestore,
  clearStaleDockerRestoreLock,
  dockerRestoreHealthRequestOptions,
  dockerRestoreStatus,
  restoreDockerBackup,
  resumeDockerRestore,
  rollbackDockerRestore,
  type DockerRestoreOperationStatus,
} from "./docker-restore.js";
import { CLI_SUPPORTED_DATABASE_VERSION } from "./migrations.js";
import type { CommandRunner } from "./process.js";

const temporaryDirectories: string[] = [];
const runtimeStates = new Map<string, { designerRunning: boolean; rendererRunning: boolean }>();
const operationId = "restore_0123456789abcdef0123456789abcdef";
const backupId = `backup_${"a".repeat(40)}`;
const safetyBackupId = `backup_${"b".repeat(40)}`;
const dockerContext = "desktop-linux";
const daemonId = "daemon:formaspec-test";
const designerContainerId = "1".repeat(64);
const rendererContainerId = "2".repeat(64);
const imageId = `sha256:${"3".repeat(64)}`;
const dataVolume = "minimalappdesigner_designer-data";
const backupVolume = "minimalappdesigner_designer-backups";
const socketVolume = "minimalappdesigner_renderer-socket";

afterEach(() => {
  runtimeStates.clear();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function projectFixture(mode = "docker"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "formaspec-docker-restore-"));
  temporaryDirectories.push(root);
  fs.mkdirSync(path.join(root, ".designer", "run"), { recursive: true });
  fs.mkdirSync(path.join(root, ".designer", "env"), { recursive: true });
  const environment = path.join(root, ".designer", "env", mode === "server" ? "server.env" : "docker.env");
  fs.writeFileSync(path.join(root, ".designer", "run", "mode"), `${mode}\n`);
  fs.writeFileSync(path.join(root, ".designer", "run", "env-file"), `${environment}\n`);
  const publicUrl = mode === "server" ? "https://designer.example.test" : "http://127.0.0.1:4310";
  fs.writeFileSync(path.join(root, ".designer", "run", "url"), `${publicUrl}\n`);
  fs.writeFileSync(environment, mode === "server" ? [
    "DESIGNER_SERVER_ACCESS=proxy",
    "APP_MODE=server",
    "FORMASPEC_CONTAINER_LOCAL=false",
    "BIND_ADDRESS=127.0.0.1",
    "PORT=4310",
    `PUBLIC_BASE_URL=${publicUrl}`,
    "AUTH_MODE=trusted-header",
    "DESIGNER_TOKEN=server-secret-token-0123456789abcdef",
    "FORMASPEC_PROXY_SECRET=proxy-secret-0123456789abcdef0123456789abcdef",
    "TRUSTED_USER_HEADER=x-designer-user",
    "FORMASPEC_ALLOWED_HOSTS=designer.example.test",
    "FORMASPEC_TRUSTED_PROXIES=127.0.0.1,::1,172.16.0.0/12",
    `DESIGNER_CORS_ORIGINS=${publicUrl}`,
    "MAX_UPLOAD_BYTES=5242880",
    "",
  ].join("\n") : [
    "APP_MODE=local",
    "FORMASPEC_CONTAINER_LOCAL=true",
    "BIND_ADDRESS=127.0.0.1",
    "PORT=4310",
    `PUBLIC_BASE_URL=${publicUrl}`,
    "AUTH_MODE=none",
    "DESIGNER_TOKEN=",
    "TRUSTED_USER_HEADER=x-designer-user",
    "MAX_UPLOAD_BYTES=5242880",
    "",
  ].join("\n"), { mode: 0o600 });
  fs.writeFileSync(path.join(root, "docker-compose.yml"), "services: {}\n");
  persistDockerRuntimeBinding(root, runtimeBinding(root));
  runtimeStates.set(root, { designerRunning: true, rendererRunning: true });
  return root;
}

function environmentIdentitySha256(filename: string): string {
  const values = new Map<string, string>();
  for (const line of fs.readFileSync(filename, "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    values.set(line.slice(0, separator), line.slice(separator + 1));
  }
  const stat = fs.lstatSync(filename);
  const entries = [...values.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [
      key,
      /(^|_)(?:TOKEN|SECRET|PASSWORD|PASSCODE|API_KEY|PRIVATE_KEY|CREDENTIALS?)(?:_|$)/i.test(key)
        ? "[redacted]"
        : value,
    ]);
  return createHash("sha256").update(JSON.stringify({
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    modifiedMs: stat.mtimeMs,
    entries,
  })).digest("hex");
}

function runtimeBinding(root: string): DockerRuntimeBinding {
  const composeFile = path.join(root, "docker-compose.yml");
  const commonLabels = {
    project: "minimalappdesigner" as const,
    oneoff: "False" as const,
    containerNumber: "1" as const,
    imageId,
    workingDirectory: root,
    configFile: composeFile,
    composeVersion: "2.39.0",
  };
  return {
    format: "formaspec-docker-runtime-binding",
    version: 2,
    capturedAt: "2026-07-19T12:00:00.000Z",
    context: dockerContext,
    daemonId,
    composeProject: "minimalappdesigner",
    imageId,
    containers: { designer: designerContainerId, renderer: rendererContainerId },
    labels: {
      designer: {
        ...commonLabels,
        service: "designer",
        configHash: "4".repeat(64),
      },
      renderer: {
        ...commonLabels,
        service: "renderer",
        configHash: "5".repeat(64),
      },
    },
    volumes: { data: dataVolume, backups: backupVolume, rendererSocket: socketVolume },
    renderer: { networkMode: "none" },
    publicBinding: {
      host: "127.0.0.1",
      port: 4310,
      containerPort: 4310,
      origin: "http://127.0.0.1:4310",
    },
    runtime: {
      mode: fs.readFileSync(path.join(root, ".designer", "run", "mode"), "utf8").trim() as "docker" | "server",
      serverAccess: fs.readFileSync(path.join(root, ".designer", "run", "mode"), "utf8").trim() === "server"
        ? "proxy"
        : "none",
      healthHostHeader: fs.readFileSync(path.join(root, ".designer", "run", "mode"), "utf8").trim() === "server"
        ? "designer.example.test"
        : "127.0.0.1:4310",
      environmentIdentitySha256: environmentIdentitySha256(path.join(
        root,
        ".designer",
        "env",
        fs.readFileSync(path.join(root, ".designer", "run", "mode"), "utf8").trim() === "server"
          ? "server.env"
          : "docker.env",
      )),
    },
  };
}

function dockerIdentityResponse(args: readonly string[], root: string): { exitCode: number; stdout: string; stderr: string } | null {
  const state = runtimeStates.get(root)!;
  if (args.includes("info")) {
    return { exitCode: 0, stdout: `${JSON.stringify(daemonId)}\n`, stderr: "" };
  }
  if (args.includes("ps") && args.includes("-aq")) {
    const serviceFilter = args.find((argument) => argument.startsWith("label=com.docker.compose.service="));
    if (serviceFilter === "label=com.docker.compose.service=designer") {
      return { exitCode: 0, stdout: `${designerContainerId}\n`, stderr: "" };
    }
    if (serviceFilter === "label=com.docker.compose.service=renderer") {
      return { exitCode: 0, stdout: `${rendererContainerId}\n`, stderr: "" };
    }
  }
  if (args.includes("volume") && args.includes("inspect")) {
    const name = args.at(-1)!;
    return {
      exitCode: 0,
      stdout: `${JSON.stringify({
        Name: name,
        Driver: "local",
        Scope: "local",
        Options: null,
        Mountpoint: `/var/lib/docker/volumes/${name}/_data`,
      })}\n`,
      stderr: "",
    };
  }
  const formatIndex = args.indexOf("--format");
  if (args.includes("inspect") && formatIndex >= 0 && args[formatIndex + 1]?.includes(".State.Running")) {
    const id = args.at(-1);
    const running = id === designerContainerId ? state.designerRunning : state.rendererRunning;
    return { exitCode: 0, stdout: `${JSON.stringify({ running })}\n`, stderr: "" };
  }
  if (args.includes("inspect") && formatIndex >= 0 && args[formatIndex + 1]?.includes("{{json .Id}}")) {
    const id = args.at(-1);
    const designer = id === designerContainerId;
    const service = designer ? "designer" : "renderer";
    const labels = {
      "com.docker.compose.project": "minimalappdesigner",
      "com.docker.compose.service": service,
      "com.docker.compose.oneoff": "False",
      "com.docker.compose.container-number": "1",
      "com.docker.compose.config-hash": (designer ? "4" : "5").repeat(64),
      "com.docker.compose.image": imageId,
      "com.docker.compose.project.working_dir": root,
      "com.docker.compose.project.config_files": path.join(root, "docker-compose.yml"),
      "com.docker.compose.version": "2.39.0",
    };
    const mounts = designer
      ? [
        { Type: "volume", Name: dataVolume, Destination: "/data", RW: true },
        { Type: "volume", Name: backupVolume, Destination: "/backups", RW: true },
        { Type: "volume", Name: socketVolume, Destination: "/run/formaspec", RW: true },
      ]
      : [{ Type: "volume", Name: socketVolume, Destination: "/run/formaspec", RW: true }];
    const ports = designer
      ? { "4310/tcp": [{ HostIp: "127.0.0.1", HostPort: "4310" }] }
      : {};
    return {
      exitCode: 0,
      stdout: [id, imageId, labels, mounts, designer ? "minimalappdesigner_default" : "none", ports]
        .map((value) => JSON.stringify(value)).join("\n"),
      stderr: "",
    };
  }
  if (args.includes("stop") && args.at(-1) === designerContainerId) {
    state.designerRunning = false;
    return { exitCode: 0, stdout: `${designerContainerId}\n`, stderr: "" };
  }
  if (args.includes("start") && args.at(-1) === designerContainerId) {
    state.designerRunning = true;
    return { exitCode: 0, stdout: `${designerContainerId}\n`, stderr: "" };
  }
  if (args.includes("start") && args.at(-1) === rendererContainerId) {
    state.rendererRunning = true;
    return { exitCode: 0, stdout: `${rendererContainerId}\n`, stderr: "" };
  }
  return null;
}

function terminalStatus(active: boolean, phase: "reconciled" | "rolled_back" = "reconciled"): DockerRestoreOperationStatus {
  return {
    maintenance: active
      ? {
        active: true,
        markerValid: true,
        phase: phase === "reconciled" ? "verification" : "rollback",
        operationId,
        startedAt: "2026-07-19T12:00:00.000Z",
      }
      : { active: false, markerValid: true },
    operation: {
      operationId,
      backupId,
      safetyBackupId,
      phase,
      createdAt: "2026-07-19T12:00:00.000Z",
      updatedAt: "2026-07-19T12:01:00.000Z",
      smoke: { schemaVersion: CLI_SUPPORTED_DATABASE_VERSION, renderedDesignId: "design_fixture" },
      result: phase === "reconciled"
        ? {
          auditEventId: 11,
          outboxEventId: 13,
          revoked: { grants: 1, connections: 1, nonces: 2 },
        }
        : null,
      errorCode: phase === "rolled_back" ? "RENDER_FAILED" : null,
    },
    workerLock: { active: false, lockValid: true },
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function healthyFetch(expectedHost = "127.0.0.1:4310"): typeof fetch {
  return async (input, init) => {
    expect(new Headers(init?.headers).get("host")).toBe(expectedHost);
    const pathname = new URL(String(input)).pathname;
    if (pathname === "/health/render") {
      return response({ ok: true, mode: "worker", renderer: "playwright", softwareFallback: false });
    }
    if (pathname === "/health/ready") {
      return response({
        ok: true,
        database: "ready",
        migrations: CLI_SUPPORTED_DATABASE_VERSION,
        render: { ok: true, mode: "worker", renderer: "playwright", softwareFallback: false },
      });
    }
    return response({ ok: true, service: "formaspec-api" });
  };
}

describe("Docker restore supervision", () => {
  it("builds the production health request with an explicit public Host over loopback", () => {
    expect(dockerRestoreHealthRequestOptions({
      connectHost: "127.0.0.1",
      port: 4310,
      hostHeader: "designer.example.test",
      pathname: "/health/ready",
      timeoutMs: 5_000,
    })).toMatchObject({
      hostname: "127.0.0.1",
      port: 4310,
      path: "/health/ready",
      method: "GET",
      agent: false,
      headers: { host: "designer.example.test" },
    });
  });

  it("enforces an absolute wall-clock deadline when a health requester never settles", async () => {
    const root = projectFixture();
    const runner: CommandRunner = async (_executable, args) => {
      const identity = dockerIdentityResponse(args, root);
      if (identity) return identity;
      if (args.includes("apps/server/dist/restore-control.js")) {
        return {
          exitCode: 0,
          stdout: `${JSON.stringify({ ok: true, status: terminalStatus(false) })}\n`,
          stderr: "",
        };
      }
      return { exitCode: 1, stdout: "", stderr: "unexpected command" };
    };
    const startedAt = Date.now();
    await expect(resumeDockerRestore(root, undefined, {
      commandRunner: runner,
      dockerExecutable: "/usr/bin/docker",
      healthRequester: () => new Promise(() => undefined),
      healthTimeoutMs: 25,
      healthPollIntervalMs: 1,
    })).rejects.toThrow(/health verification timed out at \/health\/live/);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("classifies the supervised path as healthy planned restore rather than offline disaster recovery", async () => {
    const root = projectFixture();
    const runner: CommandRunner = async (_executable, args) => (
      dockerIdentityResponse(args, root) ?? { exitCode: 1, stdout: "", stderr: "unexpected command" }
    );
    await expect(restoreDockerBackup(root, backupId, { stdout: () => undefined }, {
      commandRunner: runner,
      dockerExecutable: "/usr/bin/docker",
      healthRequester: async () => ({ status: 503, body: { ok: false, database: "unavailable" } }),
      healthTimeoutMs: 5,
      healthPollIntervalMs: 1,
      createOperationId: () => operationId,
    })).rejects.toThrow(/HEALTHY_PLANNED_RESTORE_ONLY.*offline disaster recovery is not implemented/);
  });

  it("refuses a symlinked runtime lock path without deleting its external target", async () => {
    if (process.platform === "win32") return;
    const root = projectFixture();
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "formaspec-external-run-"));
    temporaryDirectories.push(external);
    const marker = path.join(external, "must-survive");
    fs.writeFileSync(marker, "preserve\n");
    const runDirectory = path.join(root, ".designer", "run");
    fs.rmSync(runDirectory, { recursive: true });
    fs.symlinkSync(external, runDirectory, "dir");

    await expect(abortDockerRestore(root)).rejects.toThrow(/runtime state directory must be a real directory/);
    expect(fs.readFileSync(marker, "utf8")).toBe("preserve\n");
    expect(fs.lstatSync(runDirectory).isSymbolicLink()).toBe(true);
  });

  it("fences, stops only the API, runs the one-shot worker, verifies, and clears maintenance", async () => {
    const root = projectFixture();
    const commands: string[][] = [];
    let maintenance = false;
    let maintenanceReadyAttempts = 0;
    let readyAttempts = 0;
    let operation: DockerRestoreOperationStatus["operation"] = null;
    const runner: CommandRunner = async (_executable, args) => {
      commands.push([...args]);
      const identity = dockerIdentityResponse(args, root);
      if (identity) return identity;
      const controlIndex = args.indexOf("apps/server/dist/restore-control.js");
      if (controlIndex >= 0) {
        const command = args[controlIndex + 1];
        if (command === "set") maintenance = true;
        if (command === "clear") maintenance = false;
        return {
          exitCode: 0,
          stdout: `${JSON.stringify({
            ok: true,
            status: {
              maintenance: maintenance
                ? {
                  active: true,
                  markerValid: true,
                  phase: operation?.phase === "reconciled" ? "verification" : "restore",
                  operationId,
                  startedAt: "2026-07-19T12:00:00.000Z",
                }
                : { active: false, markerValid: true },
              operation,
              workerLock: { active: false, lockValid: true },
            },
          })}\n`,
          stderr: "",
        };
      }
      if (args.includes("apps/server/dist/restore-worker.js")) {
        const restoreWorkerIndex = args.indexOf("apps/server/dist/restore-worker.js");
        if (args[restoreWorkerIndex + 1] === "preflight") {
          return {
            exitCode: 0,
            stdout: `${JSON.stringify({ ok: true, preflight: { status: "verified", backupId } })}\n`,
            stderr: "",
          };
        }
        operation = terminalStatus(true).operation;
        return {
          exitCode: 0,
          stdout: `${JSON.stringify({ ok: true, result: { status: "restored", backupId, operationId, safetyBackupId } })}\n`,
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const fetchMock: typeof fetch = async (input, init) => {
      expect(new Headers(init?.headers).get("host")).toBe("127.0.0.1:4310");
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/health/render") {
        return response({ ok: true, mode: "worker", renderer: "playwright", softwareFallback: false });
      }
      if (pathname === "/health/ready" && maintenance) {
        maintenanceReadyAttempts += 1;
        return response({
          ok: false,
          status: "maintenance",
          database: "ready",
          migrations: maintenanceReadyAttempts === 1
            ? CLI_SUPPORTED_DATABASE_VERSION - 1
            : CLI_SUPPORTED_DATABASE_VERSION,
          render: { ok: true, mode: "worker", renderer: "playwright", softwareFallback: false },
          maintenance: { active: true, phase: "verification", operationId },
        }, 503);
      }
      if (pathname === "/health/ready") {
        readyAttempts += 1;
        return response({
          ok: true,
          database: "ready",
          migrations: readyAttempts === 1
            ? CLI_SUPPORTED_DATABASE_VERSION - 1
            : CLI_SUPPORTED_DATABASE_VERSION,
          render: { ok: true, mode: "worker", renderer: "playwright", softwareFallback: false },
        });
      }
      if (pathname === "/api/designs") return response({ designs: [] });
      return response({ ok: true });
    };

    const result = await restoreDockerBackup(root, backupId, { stdout: () => undefined }, {
      commandRunner: runner,
      dockerExecutable: "/usr/bin/docker",
      fetch: fetchMock,
      createOperationId: () => operationId,
    });

    expect(result).toMatchObject({
      status: "restored",
      operationId,
      backupId,
      safetyBackupId,
      maintenanceCleared: true,
      serviceReady: true,
      reconnectRequired: true,
    });
    const flattened = commands.map((command) => command.join(" "));
    const preflightIndex = flattened.findIndex((command) => command.includes("restore-worker.js preflight --backup-id"));
    const setIndex = flattened.findIndex((command) => command.includes("restore-control.js set"));
    const stopIndex = flattened.findIndex((command) => command.includes(`stop --time 30 ${designerContainerId}`));
    const workerIndex = flattened.findIndex((command) => command.includes("restore-worker.js --backup-id"));
    const startIndex = flattened.findIndex((command) => command.includes(`start ${designerContainerId}`));
    const clearIndex = flattened.findIndex((command) => command.includes("restore-control.js clear"));
    expect(preflightIndex).toBeGreaterThanOrEqual(0);
    expect(setIndex).toBeGreaterThan(preflightIndex);
    expect(stopIndex).toBeGreaterThan(setIndex);
    expect(workerIndex).toBeGreaterThan(stopIndex);
    expect(startIndex).toBeGreaterThan(workerIndex);
    expect(clearIndex).toBeGreaterThan(startIndex);
    expect(maintenanceReadyAttempts).toBe(2);
    expect(readyAttempts).toBe(3);
    expect(fs.existsSync(path.join(root, ".designer", "run", "launcher.lock"))).toBe(false);
  });

  it("aborts maintenance when a worker fails before creating restore evidence", async () => {
    const root = projectFixture();
    let maintenance = false;
    const commands: string[][] = [];
    const runner: CommandRunner = async (_executable, args) => {
      commands.push([...args]);
      const identity = dockerIdentityResponse(args, root);
      if (identity) return identity;
      const controlIndex = args.indexOf("apps/server/dist/restore-control.js");
      if (controlIndex >= 0) {
        const command = args[controlIndex + 1];
        if (command === "set") maintenance = true;
        if (command === "abort") maintenance = false;
        return {
          exitCode: 0,
          stdout: `${JSON.stringify({
            ok: true,
            status: {
              maintenance: maintenance
                ? { active: true, markerValid: true, phase: "restore", operationId, startedAt: "2026-07-19T12:00:00.000Z" }
                : { active: false, markerValid: true },
              operation: null,
              workerLock: { active: false, lockValid: true },
            },
          })}\n`,
          stderr: "",
        };
      }
      if (args.includes("apps/server/dist/restore-worker.js")) {
        const restoreWorkerIndex = args.indexOf("apps/server/dist/restore-worker.js");
        if (args[restoreWorkerIndex + 1] === "preflight") {
          return {
            exitCode: 0,
            stdout: `${JSON.stringify({ ok: true, preflight: { status: "verified", backupId } })}\n`,
            stderr: "",
          };
        }
        return { exitCode: 1, stdout: "", stderr: "restore failed" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    await expect(restoreDockerBackup(root, backupId, { stdout: () => undefined }, {
      commandRunner: runner,
      dockerExecutable: "/usr/bin/docker",
      createOperationId: () => operationId,
      fetch: healthyFetch(),
    })).rejects.toThrow(/Restore worker failed/);
    expect(maintenance).toBe(false);
    expect(commands.some((args) => args.includes("start") && args.includes(designerContainerId))).toBe(true);
    expect(fs.existsSync(path.join(root, ".designer", "run", "launcher.lock"))).toBe(false);
  });

  it("restarts and verifies the unchanged API when a resumed pre-cutover worker fails", async () => {
    const root = projectFixture();
    let maintenance = true;
    let apiStarts = 0;
    const runner: CommandRunner = async (_executable, args) => {
      if (args.includes("start") && args.at(-1) === designerContainerId) apiStarts += 1;
      const identity = dockerIdentityResponse(args, root);
      if (identity) return identity;
      const controlIndex = args.indexOf("apps/server/dist/restore-control.js");
      if (controlIndex >= 0) {
        if (args[controlIndex + 1] === "abort") maintenance = false;
        return {
          exitCode: 0,
          stdout: `${JSON.stringify({
            ok: true,
            status: {
              maintenance: maintenance
                ? {
                  active: true,
                  markerValid: true,
                  phase: "restore",
                  operationId,
                  startedAt: "2026-07-19T12:00:00.000Z",
                }
                : { active: false, markerValid: true },
              operation: null,
              workerLock: { active: false, lockValid: true },
            },
          })}\n`,
          stderr: "",
        };
      }
      if (args.includes("apps/server/dist/restore-worker.js")) {
        const workerIndex = args.indexOf("apps/server/dist/restore-worker.js");
        if (args[workerIndex + 1] === "preflight") {
          return {
            exitCode: 0,
            stdout: `${JSON.stringify({ ok: true, preflight: { status: "verified", backupId } })}\n`,
            stderr: "",
          };
        }
        return { exitCode: 1, stdout: "", stderr: "resume worker failed" };
      }
      return { exitCode: 1, stdout: "", stderr: "unexpected command" };
    };

    await expect(resumeDockerRestore(root, backupId, {
      commandRunner: runner,
      dockerExecutable: "/usr/bin/docker",
      fetch: healthyFetch(),
    })).rejects.toThrow(/Restore worker failed/);
    expect(maintenance).toBe(false);
    expect(apiStarts).toBe(1);
    expect(runtimeStates.get(root)?.designerRunning).toBe(true);
  });

  it("restarts and verifies the unchanged API when a rollback worker fails before cutover", async () => {
    const root = projectFixture();
    let maintenance = false;
    let operation: DockerRestoreOperationStatus["operation"] = terminalStatus(false).operation;
    let apiStarts = 0;
    const rollbackOperationId = "restore_dddddddddddddddddddddddddddddddd";
    const runner: CommandRunner = async (_executable, args) => {
      if (args.includes("start") && args.at(-1) === designerContainerId) apiStarts += 1;
      const identity = dockerIdentityResponse(args, root);
      if (identity) return identity;
      const controlIndex = args.indexOf("apps/server/dist/restore-control.js");
      if (controlIndex >= 0) {
        const command = args[controlIndex + 1];
        if (command === "set") {
          maintenance = true;
          operation = null;
        }
        if (command === "abort") maintenance = false;
        return {
          exitCode: 0,
          stdout: `${JSON.stringify({
            ok: true,
            status: {
              maintenance: maintenance
                ? {
                  active: true,
                  markerValid: true,
                  phase: "restore",
                  operationId: rollbackOperationId,
                  startedAt: "2026-07-19T12:00:00.000Z",
                }
                : { active: false, markerValid: true },
              operation,
              workerLock: { active: false, lockValid: true },
            },
          })}\n`,
          stderr: "",
        };
      }
      if (args.includes("apps/server/dist/restore-worker.js")) {
        const workerIndex = args.indexOf("apps/server/dist/restore-worker.js");
        if (args[workerIndex + 1] === "preflight") {
          return {
            exitCode: 0,
            stdout: `${JSON.stringify({ ok: true, preflight: { status: "verified", backupId: safetyBackupId } })}\n`,
            stderr: "",
          };
        }
        return { exitCode: 1, stdout: "", stderr: "rollback worker failed" };
      }
      return { exitCode: 1, stdout: "", stderr: "unexpected command" };
    };

    await expect(rollbackDockerRestore(root, { stdout: () => undefined }, {
      commandRunner: runner,
      dockerExecutable: "/usr/bin/docker",
      fetch: healthyFetch(),
      createOperationId: () => rollbackOperationId,
    })).rejects.toThrow(/Restore worker failed/);
    expect(maintenance).toBe(false);
    expect(apiStarts).toBe(1);
    expect(runtimeStates.get(root)?.designerRunning).toBe(true);
  });

  it("returns an AggregateError when pre-cutover abort succeeds but the unchanged API cannot restart", async () => {
    const root = projectFixture();
    let maintenance = false;
    const runner: CommandRunner = async (_executable, args) => {
      if (args.includes("start") && args.at(-1) === designerContainerId) {
        return { exitCode: 1, stdout: "", stderr: "start failed" };
      }
      const identity = dockerIdentityResponse(args, root);
      if (identity) return identity;
      const controlIndex = args.indexOf("apps/server/dist/restore-control.js");
      if (controlIndex >= 0) {
        const command = args[controlIndex + 1];
        if (command === "set") maintenance = true;
        if (command === "abort") maintenance = false;
        return {
          exitCode: 0,
          stdout: `${JSON.stringify({
            ok: true,
            status: {
              maintenance: maintenance
                ? {
                  active: true,
                  markerValid: true,
                  phase: "restore",
                  operationId,
                  startedAt: "2026-07-19T12:00:00.000Z",
                }
                : { active: false, markerValid: true },
              operation: null,
              workerLock: { active: false, lockValid: true },
            },
          })}\n`,
          stderr: "",
        };
      }
      if (args.includes("apps/server/dist/restore-worker.js")) {
        const workerIndex = args.indexOf("apps/server/dist/restore-worker.js");
        if (args[workerIndex + 1] === "preflight") {
          return {
            exitCode: 0,
            stdout: `${JSON.stringify({ ok: true, preflight: { status: "verified", backupId } })}\n`,
            stderr: "",
          };
        }
        return { exitCode: 1, stdout: "", stderr: "restore worker failed" };
      }
      return { exitCode: 1, stdout: "", stderr: "unexpected command" };
    };

    let caught: unknown;
    try {
      await restoreDockerBackup(root, backupId, { stdout: () => undefined }, {
        commandRunner: runner,
        dockerExecutable: "/usr/bin/docker",
        fetch: healthyFetch(),
        createOperationId: () => operationId,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect(caught).toMatchObject({
      message: "Restore was safely aborted before cutover, but the unchanged FormaSpec API did not restart cleanly.",
    });
    expect((caught as AggregateError).errors).toHaveLength(2);
    expect(maintenance).toBe(false);
    expect(fs.existsSync(path.join(root, ".designer", "run", "launcher.lock"))).toBe(false);
  });

  it("requires the backup ID when resuming before the durable worker journal exists", async () => {
    const root = projectFixture();
    const runner: CommandRunner = async (_executable, args) => {
      const identity = dockerIdentityResponse(args, root);
      if (identity) return identity;
      if (args.includes("apps/server/dist/restore-control.js")) {
        return {
          exitCode: 0,
          stdout: `${JSON.stringify({
            ok: true,
            status: {
              maintenance: {
                active: true,
                markerValid: true,
                phase: "restore",
                operationId,
                startedAt: "2026-07-19T12:00:00.000Z",
              },
              operation: null,
              workerLock: { active: false, lockValid: true },
            },
          })}\n`,
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await expect(resumeDockerRestore(root, undefined, {
      commandRunner: runner,
      dockerExecutable: "/usr/bin/docker",
    })).rejects.toThrow(/rerun resume with --backup-id/);
  });

  it("rolls a reconciled restore back by targeting its verified safety backup under one lock", async () => {
    const root = projectFixture("server");
    const rollbackOperationId = "restore_cccccccccccccccccccccccccccccccc";
    const nextSafetyBackupId = `backup_${"c".repeat(40)}`;
    let maintenance = false;
    let currentOperation = terminalStatus(false).operation;
    let workerTarget = "";
    const runner: CommandRunner = async (_executable, args) => {
      const identity = dockerIdentityResponse(args, root);
      if (identity) return identity;
      const controlIndex = args.indexOf("apps/server/dist/restore-control.js");
      if (controlIndex >= 0) {
        const command = args[controlIndex + 1];
        if (command === "set") {
          maintenance = true;
          currentOperation = null;
        }
        if (command === "clear") maintenance = false;
        return {
          exitCode: 0,
          stdout: `${JSON.stringify({
            ok: true,
            status: {
              maintenance: maintenance
                ? {
                  active: true,
                  markerValid: true,
                  phase: currentOperation?.phase === "reconciled" ? "verification" : "restore",
                  operationId: rollbackOperationId,
                  startedAt: "2026-07-19T13:00:00.000Z",
                }
                : { active: false, markerValid: true },
              operation: currentOperation,
              workerLock: { active: false, lockValid: true },
            },
          })}\n`,
          stderr: "",
        };
      }
      if (args.includes("apps/server/dist/restore-worker.js")) {
        const restoreWorkerIndex = args.indexOf("apps/server/dist/restore-worker.js");
        if (args[restoreWorkerIndex + 1] === "preflight") {
          return {
            exitCode: 0,
            stdout: `${JSON.stringify({ ok: true, preflight: { status: "verified", backupId: safetyBackupId } })}\n`,
            stderr: "",
          };
        }
        workerTarget = args[args.indexOf("--backup-id") + 1]!;
        currentOperation = {
          ...terminalStatus(true).operation!,
          operationId: rollbackOperationId,
          backupId: safetyBackupId,
          safetyBackupId: nextSafetyBackupId,
        };
        return {
          exitCode: 0,
          stdout: `${JSON.stringify({ ok: true, result: { status: "restored" } })}\n`,
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const fetchMock: typeof fetch = async (input, init) => {
      expect(new Headers(init?.headers).get("host")).toBe("designer.example.test");
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/health/render") {
        return response({ ok: true, mode: "worker", renderer: "playwright", softwareFallback: false });
      }
      if (pathname === "/health/ready" && maintenance) {
        return response({
          ok: false,
          status: "maintenance",
          database: "ready",
          migrations: CLI_SUPPORTED_DATABASE_VERSION,
          render: { ok: true, mode: "worker", renderer: "playwright", softwareFallback: false },
          maintenance: { active: true, phase: "verification", operationId: rollbackOperationId },
        }, 503);
      }
      if (pathname === "/api/designs") return response({ designs: [] });
      return response({
        ok: true,
        database: "ready",
        migrations: CLI_SUPPORTED_DATABASE_VERSION,
        render: { ok: true, mode: "worker", renderer: "playwright", softwareFallback: false },
      });
    };
    const result = await rollbackDockerRestore(root, { stdout: () => undefined }, {
      commandRunner: runner,
      dockerExecutable: "/usr/bin/docker",
      fetch: fetchMock,
      createOperationId: () => rollbackOperationId,
    });
    expect(workerTarget).toBe(safetyBackupId);
    expect(result).toMatchObject({
      status: "restored",
      operationId: rollbackOperationId,
      backupId: safetyBackupId,
      safetyBackupId: nextSafetyBackupId,
    });
    expect(fs.existsSync(path.join(root, ".designer", "run", "launcher.lock"))).toBe(false);
  });

  it("aborts a proven pre-cutover operation and restarts the unchanged bound API", async () => {
    const root = projectFixture();
    let maintenance = true;
    const runner: CommandRunner = async (_executable, args) => {
      const identity = dockerIdentityResponse(args, root);
      if (identity) return identity;
      const controlIndex = args.indexOf("apps/server/dist/restore-control.js");
      if (controlIndex >= 0) {
        if (args[controlIndex + 1] === "abort") maintenance = false;
        return {
          exitCode: 0,
          stdout: `${JSON.stringify({
            ok: true,
            status: {
              maintenance: maintenance
                ? {
                  active: true,
                  markerValid: true,
                  phase: "restore",
                  operationId,
                  startedAt: "2026-07-19T12:00:00.000Z",
                }
                : { active: false, markerValid: true },
              operation: null,
              workerLock: { active: false, lockValid: true },
            },
          })}\n`,
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const result = await abortDockerRestore(root, {
      commandRunner: runner,
      dockerExecutable: "/usr/bin/docker",
      fetch: healthyFetch(),
    });
    expect(result).toEqual({
      status: "aborted",
      operationId,
      maintenanceCleared: true,
      serviceReady: true,
    });
    expect(maintenance).toBe(false);
  });

  it("clears a shared lock only after the bound daemon proves its worker container is absent", async () => {
    const root = projectFixture();
    const staleContainerId = "abcdef123456";
    let lockActive = true;
    let clearCalls = 0;
    const runner: CommandRunner = async (_executable, args) => {
      const identity = dockerIdentityResponse(args, root);
      if (identity) return identity;
      if (args.includes("ps") && args.some((argument) => argument === `id=${staleContainerId}`)) {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      const controlIndex = args.indexOf("apps/server/dist/restore-control.js");
      if (controlIndex >= 0) {
        if (args[controlIndex + 1] === "clear-stale-lock") {
          clearCalls += 1;
          lockActive = false;
        }
        return {
          exitCode: 0,
          stdout: `${JSON.stringify({
            ok: true,
            status: {
              maintenance: {
                active: true,
                markerValid: true,
                phase: "restore",
                operationId,
                startedAt: "2026-07-19T12:00:00.000Z",
              },
              operation: null,
              workerLock: lockActive
                ? {
                  active: true,
                  lockValid: true,
                  operationId,
                  ownerId: `worker_${"d".repeat(32)}`,
                  containerId: staleContainerId,
                  processId: 7,
                  acquiredAt: "2026-07-19T12:01:00.000Z",
                }
                : { active: false, lockValid: true },
            },
          })}\n`,
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const result = await clearStaleDockerRestoreLock(root, {
      commandRunner: runner,
      dockerExecutable: "/usr/bin/docker",
    });
    expect(result).toEqual({
      status: "stale_lock_cleared",
      operationId,
      containerId: staleContainerId,
    });
    expect(clearCalls).toBe(1);
  });

  it("clears a proven stale control lock after maintenance was already removed", async () => {
    const root = projectFixture();
    const staleContainerId = "abcdef654321";
    let lockActive = true;
    const runner: CommandRunner = async (_executable, args) => {
      const identity = dockerIdentityResponse(args, root);
      if (identity) return identity;
      if (args.includes("ps") && args.some((argument) => argument === `id=${staleContainerId}`)) {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      const controlIndex = args.indexOf("apps/server/dist/restore-control.js");
      if (controlIndex >= 0) {
        if (args[controlIndex + 1] === "clear-stale-lock") lockActive = false;
        return {
          exitCode: 0,
          stdout: `${JSON.stringify({
            ok: true,
            status: {
              maintenance: { active: false, markerValid: true },
              operation: terminalStatus(false).operation,
              workerLock: lockActive
                ? {
                  active: true,
                  lockValid: true,
                  operationId,
                  ownerId: `worker_${"e".repeat(32)}`,
                  containerId: staleContainerId,
                  processId: 7,
                  acquiredAt: "2026-07-19T12:01:00.000Z",
                }
                : { active: false, lockValid: true },
            },
          })}\n`,
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await expect(resumeDockerRestore(root, undefined, {
      commandRunner: runner,
      dockerExecutable: "/usr/bin/docker",
    })).rejects.toThrow(/stale restore control or worker lock/);
    await expect(clearStaleDockerRestoreLock(root, {
      commandRunner: runner,
      dockerExecutable: "/usr/bin/docker",
    })).resolves.toMatchObject({ status: "stale_lock_cleared", operationId });
  });

  it("reads server restore status only through the pinned Compose binding and redacts bearer environments", async () => {
    const serverRoot = projectFixture("server");
    const secret = "server-secret-token-0123456789abcdef";
    const proxySecret = "proxy-secret-0123456789abcdef0123456789abcdef";
    const runner: CommandRunner = async (_executable, args, options) => {
      expect(options?.env?.DESIGNER_TOKEN).toBeUndefined();
      expect(options?.env?.FORMASPEC_MCP_TOKEN).toBeUndefined();
      expect(options?.env?.FORMASPEC_PROXY_SECRET).toBeUndefined();
      expect(args.join(" ")).not.toContain(secret);
      expect(args.join(" ")).not.toContain(proxySecret);
      const identity = dockerIdentityResponse(args, serverRoot);
      if (identity) return identity;
      if (args.includes("apps/server/dist/restore-control.js")) {
        return {
          exitCode: 0,
          stdout: `${JSON.stringify({ ok: true, status: terminalStatus(false) })}\n`,
          stderr: "",
        };
      }
      return { exitCode: 1, stdout: "", stderr: "unexpected command" };
    };
    await expect(dockerRestoreStatus(serverRoot, {
      commandRunner: runner,
      dockerExecutable: "/usr/bin/docker",
      environment: {
        PATH: "/usr/bin",
        DESIGNER_TOKEN: secret,
        FORMASPEC_MCP_TOKEN: secret,
        FORMASPEC_PROXY_SECRET: proxySecret,
      },
    })).resolves.toMatchObject({ operation: { phase: "reconciled" } });

    const root = projectFixture();
    fs.writeFileSync(path.join(root, ".designer", "run", "env-file"), "/tmp/untrusted.env\n");
    await expect(dockerRestoreStatus(root, { dockerExecutable: "/usr/bin/docker" }))
      .rejects.toThrow(/does not match the managed runtime mode/);
  });

  it("uses the exact server Host header and rejects a schema mismatch before declaring recovery ready", async () => {
    const root = projectFixture("server");
    const runner: CommandRunner = async (_executable, args) => {
      const identity = dockerIdentityResponse(args, root);
      if (identity) return identity;
      if (args.includes("apps/server/dist/restore-control.js")) {
        return {
          exitCode: 0,
          stdout: `${JSON.stringify({ ok: true, status: terminalStatus(false) })}\n`,
          stderr: "",
        };
      }
      return { exitCode: 1, stdout: "", stderr: "unexpected command" };
    };

    await expect(resumeDockerRestore(root, undefined, {
      commandRunner: runner,
      dockerExecutable: "/usr/bin/docker",
      fetch: healthyFetch("designer.example.test"),
    })).resolves.toMatchObject({ status: "restored", serviceReady: true });

    const mismatchedSchemaFetch: typeof fetch = async (input, init) => {
      expect(new Headers(init?.headers).get("host")).toBe("designer.example.test");
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/health/render") {
        return response({ ok: true, mode: "worker", renderer: "playwright", softwareFallback: false });
      }
      if (pathname === "/health/ready") {
        return response({
          ok: true,
          database: "ready",
          migrations: CLI_SUPPORTED_DATABASE_VERSION - 1,
          render: { ok: true, mode: "worker", renderer: "playwright", softwareFallback: false },
        });
      }
      return response({ ok: true, service: "formaspec-api" });
    };
    await expect(resumeDockerRestore(root, undefined, {
      commandRunner: runner,
      dockerExecutable: "/usr/bin/docker",
      fetch: mismatchedSchemaFetch,
      healthTimeoutMs: 5,
      healthPollIntervalMs: 1,
    })).rejects.toThrow(/health verification timed out at \/health\/ready/);
  });
});
