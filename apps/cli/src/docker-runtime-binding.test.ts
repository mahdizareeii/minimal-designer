import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildHardenedDockerRunArguments,
  captureDockerRuntimeBinding,
  dockerPublicPortBinding,
  dockerRuntimeBindingPath,
  persistDockerRuntimeBinding,
  readDockerRuntimeBinding,
  sanitizedPublicDockerBinding,
  verifyDockerRuntimeBinding,
} from "./docker-runtime-binding.js";
import type { CommandRunner } from "./process.js";

const temporaryDirectories: string[] = [];
const context = "desktop-linux";
const daemonId = "DAEMON:FIXTURE:0123456789";
const designerId = "a".repeat(64);
const rendererId = "b".repeat(64);
const imageId = `sha256:${"c".repeat(64)}`;
const designerConfigHash = "d".repeat(64);
const rendererConfigHash = "e".repeat(64);
const dataVolume = "minimalappdesigner_designer-data";
const backupVolume = "minimalappdesigner_designer-backups";
const socketVolume = "minimalappdesigner_renderer-socket";

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function projectFixture(port = 4310): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "formaspec-docker-binding-"));
  temporaryDirectories.push(root);
  const runDirectory = path.join(root, ".designer", "run");
  const environmentDirectory = path.join(root, ".designer", "env");
  fs.mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(environmentDirectory, { recursive: true, mode: 0o700 });
  const environmentFile = path.join(environmentDirectory, "docker.env");
  fs.writeFileSync(path.join(runDirectory, "mode"), "docker\n", { mode: 0o600 });
  fs.writeFileSync(path.join(runDirectory, "env-file"), `${environmentFile}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(runDirectory, "url"), `http://127.0.0.1:${port}\n`, { mode: 0o600 });
  fs.writeFileSync(environmentFile, [
    "APP_MODE=local",
    "FORMASPEC_CONTAINER_LOCAL=true",
    "BIND_ADDRESS=127.0.0.1",
    `PORT=${port}`,
    `PUBLIC_BASE_URL=http://127.0.0.1:${port}`,
    "AUTH_MODE=none",
    "DESIGNER_TOKEN=",
    "",
  ].join("\n"), { mode: 0o600 });
  return root;
}

interface RuntimeFixtureState {
  context: string;
  daemonId: string;
  designerId: string;
  rendererId: string;
  imageId: string;
  composeImageId: string;
  designerConfigHash: string;
  rendererConfigHash: string;
  dataVolume: string;
  backupVolume: string;
  socketVolume: string;
  rendererNetworkMode: string;
  host: string;
  port: number;
}

function defaultState(port = 4310): RuntimeFixtureState {
  return {
    context,
    daemonId,
    designerId,
    rendererId,
    imageId,
    composeImageId: imageId,
    designerConfigHash,
    rendererConfigHash,
    dataVolume,
    backupVolume,
    socketVolume,
    rendererNetworkMode: "none",
    host: "127.0.0.1",
    port,
  };
}

function composeLabels(
  service: "designer" | "renderer",
  configHash: string,
  projectRoot: string,
  currentImageId: string,
): Record<string, string> {
  return {
    "com.docker.compose.project": "minimalappdesigner",
    "com.docker.compose.service": service,
    "com.docker.compose.oneoff": "False",
    "com.docker.compose.container-number": "1",
    "com.docker.compose.config-hash": configHash,
    "com.docker.compose.image": currentImageId,
    "com.docker.compose.project.working_dir": projectRoot,
    "com.docker.compose.project.config_files": path.join(projectRoot, "docker-compose.yml"),
    "com.docker.compose.version": "5.1.4",
  };
}

function inspectionOutput(service: "designer" | "renderer", state: RuntimeFixtureState, projectRoot: string): string {
  const isDesigner = service === "designer";
  const mounts = isDesigner
    ? [
      { Type: "volume", Name: state.dataVolume, Destination: "/data", RW: true },
      { Type: "volume", Name: state.backupVolume, Destination: "/backups", RW: true },
      { Type: "volume", Name: state.socketVolume, Destination: "/run/formaspec", RW: true },
    ]
    : [{ Type: "volume", Name: state.socketVolume, Destination: "/run/formaspec", RW: true }];
  const ports = isDesigner
    ? { "4310/tcp": [{ HostIp: state.host, HostPort: String(state.port) }] }
    : {};
  return [
    JSON.stringify(isDesigner ? state.designerId : state.rendererId),
    JSON.stringify(state.imageId),
    JSON.stringify(composeLabels(
      service,
      isDesigner ? state.designerConfigHash : state.rendererConfigHash,
      projectRoot,
      state.composeImageId,
    )),
    JSON.stringify(mounts),
    JSON.stringify(isDesigner ? "minimalappdesigner_default" : state.rendererNetworkMode),
    JSON.stringify(ports),
    "",
  ].join("\n");
}

function fixtureRunner(state: RuntimeFixtureState, calls: string[][], projectRoot: string): CommandRunner {
  return async (_executable, args, options) => {
    calls.push([...args]);
    expect(options?.env?.DOCKER_HOST).toBeUndefined();
    expect(options?.env?.DOCKER_CONTEXT).toBeUndefined();
    if (args[0] === "context" && args[1] === "show") {
      return { exitCode: 0, stdout: `${state.context}\n`, stderr: "" };
    }
    if (args[0] !== "--context" || args[1] !== state.context) {
      return { exitCode: 1, stdout: "", stderr: "context missing" };
    }
    if (args[2] === "info") {
      return { exitCode: 0, stdout: `${JSON.stringify(state.daemonId)}\n`, stderr: "" };
    }
    if (args[2] === "ps") {
      const designer = args.includes("label=com.docker.compose.service=designer");
      const renderer = args.includes("label=com.docker.compose.service=renderer");
      if (designer === renderer) return { exitCode: 1, stdout: "", stderr: "invalid service filter" };
      return { exitCode: 0, stdout: `${designer ? state.designerId : state.rendererId}\n`, stderr: "" };
    }
    if (args[2] === "inspect") {
      const id = args.at(-1);
      if (id === state.designerId) return { exitCode: 0, stdout: inspectionOutput("designer", state, projectRoot), stderr: "" };
      if (id === state.rendererId) return { exitCode: 0, stdout: inspectionOutput("renderer", state, projectRoot), stderr: "" };
    }
    return { exitCode: 1, stdout: "", stderr: "unexpected command" };
  };
}

describe("Docker runtime binding", () => {
  it("captures exact runtime identity through an explicit context and persists strict mode-0600 state", async () => {
    const root = projectFixture(4321);
    const state = defaultState(4321);
    const calls: string[][] = [];
    const binding = await captureDockerRuntimeBinding(root, {
      commandRunner: fixtureRunner(state, calls, root),
      dockerExecutable: "/usr/bin/docker",
      environment: { PATH: "/usr/bin", DOCKER_CONTEXT: context, DOCKER_HOST: "tcp://ignored.invalid:2375" },
      now: () => new Date("2026-07-20T01:02:03.000Z"),
    });

    expect(binding).toMatchObject({
      capturedAt: "2026-07-20T01:02:03.000Z",
      context,
      daemonId,
      composeProject: "minimalappdesigner",
      imageId,
      containers: { designer: designerId, renderer: rendererId },
      volumes: { data: dataVolume, backups: backupVolume, rendererSocket: socketVolume },
      renderer: { networkMode: "none" },
      publicBinding: { host: "127.0.0.1", port: 4321, containerPort: 4310, origin: "http://127.0.0.1:4321" },
    });
    expect(calls.some((args) => args[0] === "context")).toBe(false);
    expect(calls.every((args) => args[0] === "--context" && args[1] === context)).toBe(true);

    const filename = persistDockerRuntimeBinding(root, binding);
    expect(filename).toBe(dockerRuntimeBindingPath(root));
    if (process.platform !== "win32") expect(fs.statSync(filename).mode & 0o777).toBe(0o600);
    expect(readDockerRuntimeBinding(root)).toEqual(binding);

    const publicBinding = sanitizedPublicDockerBinding(binding);
    expect(publicBinding).toEqual({
      loopback: true,
      host: "127.0.0.1",
      port: 4321,
      containerPort: 4310,
      origin: "http://127.0.0.1:4321",
      rendererNetworkMode: "none",
    });
    const serializedPublic = JSON.stringify(publicBinding);
    expect(serializedPublic).not.toContain(daemonId);
    expect(serializedPublic).not.toContain(dataVolume);
    expect(dockerPublicPortBinding(binding)).toBe("127.0.0.1:4321:4310/tcp");
  });

  it("pins the runtime image ID separately from Docker Compose's manifest-list image label", async () => {
    const root = projectFixture();
    const state = {
      ...defaultState(),
      composeImageId: `sha256:${"f".repeat(64)}`,
    };
    const binding = await captureDockerRuntimeBinding(root, {
      commandRunner: fixtureRunner(state, [], root),
      dockerExecutable: "/usr/bin/docker",
      environment: { PATH: "/usr/bin", DOCKER_CONTEXT: context },
    });

    expect(binding.imageId).toBe(imageId);
    expect(binding.labels.designer.imageId).toBe(state.composeImageId);
    expect(binding.labels.renderer.imageId).toBe(state.composeImageId);
    const filename = persistDockerRuntimeBinding(root, binding);
    expect(readDockerRuntimeBinding(root)).toEqual(binding);
    expect(filename).toBe(dockerRuntimeBindingPath(root));
  });

  it("verifies the persisted context explicitly and fails closed on daemon, container, image, or volume drift", async () => {
    const root = projectFixture();
    const initial = defaultState();
    const captureCalls: string[][] = [];
    const binding = await captureDockerRuntimeBinding(root, {
      commandRunner: fixtureRunner(initial, captureCalls, root),
      dockerExecutable: "/usr/bin/docker",
      environment: { PATH: "/usr/bin", DOCKER_CONTEXT: context },
      now: () => new Date("2026-07-20T02:00:00.000Z"),
    });
    persistDockerRuntimeBinding(root, binding);

    const verificationCalls: string[][] = [];
    await expect(verifyDockerRuntimeBinding(root, {
      commandRunner: fixtureRunner({ ...initial, dataVolume: "different_data_volume" }, verificationCalls, root),
      dockerExecutable: "/usr/bin/docker",
      environment: { PATH: "/usr/bin", DOCKER_CONTEXT: "unexpected-current-context" },
    })).rejects.toThrow(/runtime identity drifted/);
    expect(verificationCalls.length).toBeGreaterThan(0);
    expect(verificationCalls.every((args) => args[0] === "--context" && args[1] === context)).toBe(true);

    await expect(verifyDockerRuntimeBinding(root, {
      commandRunner: fixtureRunner(initial, [], root),
      dockerExecutable: "/usr/bin/docker",
      context: "another-context",
    })).rejects.toThrow(/does not match the persisted runtime binding/);
  });

  it("rejects ambiguous endpoint routing, non-loopback publication, unsafe renderer networking, and mismatched images", async () => {
    const root = projectFixture();
    let calls: string[][] = [];
    await expect(captureDockerRuntimeBinding(root, {
      commandRunner: fixtureRunner(defaultState(), calls, root),
      dockerExecutable: "/usr/bin/docker",
      environment: { PATH: "/usr/bin", DOCKER_HOST: "tcp://remote.invalid:2375" },
    })).rejects.toThrow(/DOCKER_HOST is not a stable runtime identity/);
    expect(calls).toHaveLength(0);

    calls = [];
    await expect(captureDockerRuntimeBinding(root, {
      commandRunner: fixtureRunner({ ...defaultState(), host: "0.0.0.0" }, calls, root),
      dockerExecutable: "/usr/bin/docker",
      context,
    })).rejects.toThrow(/does not match the recorded loopback environment/);

    calls = [];
    await expect(captureDockerRuntimeBinding(root, {
      commandRunner: fixtureRunner({ ...defaultState(), rendererNetworkMode: "bridge" }, calls, root),
      dockerExecutable: "/usr/bin/docker",
      context,
    })).rejects.toThrow(/network mode none/);

    const mismatchedImageRunner: CommandRunner = async (executable, args, options) => {
      const result = await fixtureRunner(defaultState(), calls, root)(executable, args, options);
      if (args[2] === "inspect" && args.at(-1) === rendererId && result.exitCode === 0) {
        const lines = result.stdout.trim().split(/\r?\n/);
        const differentImageId = `sha256:${"f".repeat(64)}`;
        lines[1] = JSON.stringify(differentImageId);
        const labels = JSON.parse(lines[2]!) as Record<string, string>;
        labels["com.docker.compose.image"] = differentImageId;
        lines[2] = JSON.stringify(labels);
        return { ...result, stdout: `${lines.join("\n")}\n` };
      }
      return result;
    };
    await expect(captureDockerRuntimeBinding(root, {
      commandRunner: mismatchedImageRunner,
      dockerExecutable: "/usr/bin/docker",
      context,
    })).rejects.toThrow(/exact same image ID/);

    const sensitiveRendererMountRunner: CommandRunner = async (executable, args, options) => {
      const result = await fixtureRunner(defaultState(), calls, root)(executable, args, options);
      if (args[2] === "inspect" && args.at(-1) === rendererId && result.exitCode === 0) {
        const lines = result.stdout.trim().split(/\r?\n/);
        const mounts = JSON.parse(lines[3]!) as Array<Record<string, unknown>>;
        mounts.push({ Type: "volume", Name: dataVolume, Destination: "/data", RW: true });
        lines[3] = JSON.stringify(mounts);
        return { ...result, stdout: `${lines.join("\n")}\n` };
      }
      return result;
    };
    await expect(captureDockerRuntimeBinding(root, {
      commandRunner: sensitiveRendererMountRunner,
      dockerExecutable: "/usr/bin/docker",
      context,
    })).rejects.toThrow(/renderer has unexpected persistent mounts/);
  });

  it("builds an exact hardened one-shot docker run with pinned image and volumes", async () => {
    const root = projectFixture();
    const binding = await captureDockerRuntimeBinding(root, {
      commandRunner: fixtureRunner(defaultState(), [], root),
      dockerExecutable: "/usr/bin/docker",
      context,
      now: () => new Date("2026-07-20T03:00:00.000Z"),
    });
    const args = buildHardenedDockerRunArguments(binding, {
      containerName: "formaspec-restore-01234567",
      command: ["node", "apps/server/dist/restore-worker.js", "--backup-id", `backup_${"1".repeat(40)}`],
    });

    expect(args.slice(0, 4)).toEqual(["--context", context, "run", "--rm"]);
    expect(args).toEqual(expect.arrayContaining([
      "--network=none",
      "--read-only",
      "--user=pwuser",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges:true",
      "--pids-limit=256",
      "--memory=2g",
      "--cpus=2.0",
      `--mount=type=volume,src=${dataVolume},dst=/data`,
      `--mount=type=volume,src=${backupVolume},dst=/backups`,
      `--mount=type=volume,src=${socketVolume},dst=/run/formaspec`,
      imageId,
    ]));
    expect(args.indexOf(imageId)).toBeLessThan(args.indexOf("node"));
    expect(args.some((argument) => argument.startsWith("--publish") || argument === "-p")).toBe(false);
    expect(args.some((argument) => argument.includes("DOCKER_HOST") || argument.includes("DESIGNER_TOKEN"))).toBe(false);
  });

  it("fails closed for relaxed permissions and tampered persisted fields", async () => {
    const root = projectFixture();
    const binding = await captureDockerRuntimeBinding(root, {
      commandRunner: fixtureRunner(defaultState(), [], root),
      dockerExecutable: "/usr/bin/docker",
      context,
    });
    const filename = persistDockerRuntimeBinding(root, binding);
    if (process.platform !== "win32") {
      fs.chmodSync(filename, 0o644);
      expect(() => readDockerRuntimeBinding(root)).toThrow(/permissions must be exactly 0600/);
      fs.chmodSync(filename, 0o600);
    }
    const parsed = JSON.parse(fs.readFileSync(filename, "utf8")) as Record<string, unknown>;
    parsed.extra = "not allowed";
    fs.writeFileSync(filename, `${JSON.stringify(parsed)}\n`, { mode: 0o600 });
    expect(() => readDockerRuntimeBinding(root)).toThrow(/unexpected fields/);
  });
});
