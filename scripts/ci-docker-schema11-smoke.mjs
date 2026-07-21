#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawnSync } from "node:child_process";

const MAX_COMMAND_OUTPUT = 32 * 1024 * 1024;
const EXPECTED_SCHEMA_VERSION = 13;
const EXPECTED_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;
const EXPECTED_NANO_CPUS = 2_000_000_000;
const EXPECTED_PIDS_LIMIT = 256;

function usage() {
  return `Usage: node scripts/ci-docker-schema11-smoke.mjs

Builds a disposable Docker Compose project, proves schema-13 readiness,
Playwright rendering, API-restart persistence, runtime isolation, and cleanup.
Evidence is written under FORMASPEC_CI_EVIDENCE_DIR (default:
artifacts/ci/docker-schema11). The script never uses production data or marks
an artifact release-ready.
`;
}

function run(executable, arguments_, options = {}) {
  const result = spawnSync(executable, arguments_, {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    encoding: "utf8",
    maxBuffer: MAX_COMMAND_OUTPUT,
    timeout: options.timeoutMs ?? 300_000,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      `${executable} ${arguments_.join(" ")} failed with exit ${result.status ?? "unknown"}: ` +
      `${stderr.slice(0, 4_000) || stdout.slice(0, 4_000)}`,
    );
  }
  return { status: result.status ?? 1, stdout, stderr };
}

function docker(arguments_, options = {}) {
  return run("docker", arguments_, options);
}

function compose(project, arguments_, environment, options = {}) {
  return docker(["compose", "--project-name", project, ...arguments_], {
    ...options,
    env: environment,
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} was not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function pngMetadata(bytes) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  assert(bytes.length >= 24 && bytes.subarray(0, 8).equals(signature), "Renderer response was not a PNG.");
  assert(bytes.subarray(12, 16).toString("ascii") === "IHDR", "PNG is missing its leading IHDR chunk.");
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  assert(width > 0 && height > 0 && width <= 512 && height <= 512, "Rendered PNG dimensions are outside the smoke-test bounds.");
  return { width, height, sizeBytes: bytes.length, sha256: sha256(bytes) };
}

async function reserveLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string", "Could not reserve a loopback port.");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  if (!response.ok) throw new Error(`${options.method ?? "GET"} ${url} returned ${response.status}: ${text.slice(0, 2_000)}`);
  return parseJson(text, url);
}

async function waitForReadiness(baseUrl, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const health = await requestJson(`${baseUrl}/health/ready`);
      if (health?.ok === true) return health;
      lastError = new Error("Readiness body did not report ok=true.");
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`FormaSpec did not become ready: ${lastError instanceof Error ? lastError.message : "unknown error"}`);
}

function containerEvidence(container, service) {
  const user = container?.Config?.User;
  const host = container?.HostConfig;
  assert(typeof container?.Image === "string" && /^sha256:[a-f0-9]{64}$/u.test(container.Image), `${service} has no content-addressed image ID.`);
  assert(typeof user === "string" && user !== "" && user !== "0" && user !== "root", `${service} must run as a non-root image user.`);
  assert(host?.ReadonlyRootfs === true, `${service} must use a read-only root filesystem.`);
  assert(Array.isArray(host?.CapDrop) && host.CapDrop.includes("ALL"), `${service} must drop every Linux capability.`);
  assert(Array.isArray(host?.SecurityOpt) && host.SecurityOpt.includes("no-new-privileges:true"), `${service} must set no-new-privileges.`);
  assert(host?.PidsLimit === EXPECTED_PIDS_LIMIT, `${service} PID limit drifted.`);
  assert(host?.Memory === EXPECTED_MEMORY_BYTES, `${service} memory limit drifted.`);
  assert(host?.NanoCpus === EXPECTED_NANO_CPUS, `${service} CPU limit drifted.`);
  if (service === "renderer") {
    assert(host?.NetworkMode === "none", "Renderer must have no Docker network namespace access.");
    const destinations = (container.Mounts ?? []).map((mount) => mount.Destination).sort();
    assert(JSON.stringify(destinations) === JSON.stringify(["/run/formaspec"]), "Renderer received an unexpected persistent mount.");
  }
  return {
    user,
    imageId: container.Image,
    readOnlyRootFilesystem: host.ReadonlyRootfs,
    capabilitiesDropped: [...host.CapDrop].sort(),
    securityOptions: [...host.SecurityOpt].sort(),
    pidsLimit: host.PidsLimit,
    memoryBytes: host.Memory,
    nanoCpus: host.NanoCpus,
    networkMode: host.NetworkMode,
    mountDestinations: (container.Mounts ?? []).map((mount) => mount.Destination).sort(),
  };
}

function rendererEgressEvidence(containerId) {
  const canarySource = String.raw`
import dns from "node:dns/promises";
import net from "node:net";
import os from "node:os";

const errorCode = (error) => error && typeof error === "object" && "code" in error
  ? String(error.code)
  : "UNKNOWN";
const withTimeout = (promise, milliseconds) => Promise.race([
  promise,
  new Promise((_, reject) => {
    const error = new Error("Canary timed out");
    error.code = "TIMEOUT";
    setTimeout(() => reject(error), milliseconds).unref();
  }),
]);

let dnsResult;
try {
  await withTimeout(dns.lookup("example.com"), 3_000);
  dnsResult = { blocked: false, code: "RESOLVED" };
} catch (error) {
  dnsResult = { blocked: true, code: errorCode(error) };
}

const tcpResult = await new Promise((resolve) => {
  const socket = net.createConnection({ host: "1.1.1.1", port: 443 });
  const finish = (result) => {
    socket.destroy();
    resolve(result);
  };
  socket.setTimeout(3_000, () => finish({ blocked: true, code: "TIMEOUT" }));
  socket.once("connect", () => finish({ blocked: false, code: "CONNECTED" }));
  socket.once("error", (error) => finish({ blocked: true, code: errorCode(error) }));
});

const externalInterfaces = Object.entries(os.networkInterfaces())
  .flatMap(([name, entries]) => (entries ?? []).map((entry) => ({ name, ...entry })))
  .filter((entry) => entry.internal !== true)
  .map((entry) => ({ name: entry.name, family: entry.family }));
const result = {
  dns: dnsResult,
  tcp: tcpResult,
  externalInterfaceCount: externalInterfaces.length,
  externalInterfaces,
};
process.stdout.write(JSON.stringify(result));
if (!dnsResult.blocked || !tcpResult.blocked || externalInterfaces.length !== 0) process.exitCode = 1;
`;
  const result = docker([
    "exec",
    containerId,
    "node",
    "--input-type=module",
    "--eval",
    canarySource,
  ], { allowFailure: true, timeoutMs: 15_000 });
  const output = result.stdout.trim();
  assert(result.status === 0, `Renderer egress canary failed: ${(result.stderr || output).slice(0, 2_000)}`);
  const evidence = parseJson(output, "renderer egress canary");
  assert(evidence?.dns?.blocked === true, "Renderer unexpectedly resolved the external DNS canary.");
  assert(evidence?.tcp?.blocked === true, "Renderer unexpectedly connected to the external TCP canary.");
  assert(evidence?.externalInterfaceCount === 0, "Renderer exposed a non-loopback network interface.");
  return evidence;
}

function volumeEvidence(volumes) {
  assert(Array.isArray(volumes) && volumes.length === 3, `Expected exactly three Compose volumes, received ${volumes?.length ?? "unknown"}.`);
  const mountpoints = new Set();
  const normalized = volumes.map((volume) => {
    assert(volume.Driver === "local", `Volume ${volume.Name} does not use the local driver.`);
    assert(volume.Scope === "local", `Volume ${volume.Name} does not have local scope.`);
    assert(volume.Options === null || (typeof volume.Options === "object" && Object.keys(volume.Options).length === 0), `Volume ${volume.Name} has driver options.`);
    assert(typeof volume.Mountpoint === "string" && path.isAbsolute(volume.Mountpoint) && volume.Mountpoint.length <= 4_096, `Volume ${volume.Name} has an unsafe mountpoint.`);
    assert(!mountpoints.has(volume.Mountpoint), `Volume ${volume.Name} aliases another backing mountpoint.`);
    mountpoints.add(volume.Mountpoint);
    return {
      name: volume.Name,
      driver: volume.Driver,
      scope: volume.Scope,
      options: volume.Options,
      mountpoint: volume.Mountpoint,
    };
  });
  return normalized.sort((left, right) => left.name.localeCompare(right.name));
}

function writeJson(filename, value) {
  writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(usage());
    return;
  }
  if (process.argv.length > 2) throw new Error(usage());

  const evidenceDirectory = path.resolve(process.env.FORMASPEC_CI_EVIDENCE_DIR ?? "artifacts/ci/docker-schema11");
  mkdirSync(evidenceDirectory, { recursive: true, mode: 0o755 });
  const project = `formaspeccischema13${randomBytes(5).toString("hex")}`;
  const port = await reserveLoopbackPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const environment = {
    ...process.env,
    APP_MODE: "local",
    AUTH_MODE: "none",
    BIND_ADDRESS: "127.0.0.1",
    PORT: String(port),
    PUBLIC_BASE_URL: baseUrl,
    FORMASPEC_CONTAINER_LOCAL: "true",
    FORMASPEC_ALLOW_SOFTWARE_RENDERER: "false",
    FORMASPEC_ALLOW_SYSTEM_CHROME: "false",
    DESIGNER_TOKEN: "",
    FORMASPEC_PROXY_SECRET: "",
  };
  const summary = {
    format: "formaspec-docker-schema13-ci-evidence",
    schemaVersion: 1,
    releaseStatus: "NO-GO",
    verificationStatus: "FAILED",
    sourceSha: process.env.FORMASPEC_CI_SOURCE_SHA ?? "local-uncommitted-source",
    composeProject: project,
    endpoint: baseUrl,
    checks: {},
    blockers: [
      "This disposable smoke is not a vulnerability scan or independent reproducibility proof.",
      "Native installer lifecycle, signing, notarization, and offline disaster recovery remain separate gates.",
    ],
  };
  let started = false;
  let cleaned = false;

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (started) {
      const logs = compose(project, ["logs", "--no-color", "--timestamps"], environment, { allowFailure: true, timeoutMs: 60_000 });
      writeFileSync(path.join(evidenceDirectory, "compose.log"), `${logs.stdout}${logs.stderr}`, { mode: 0o600 });
    }
    compose(project, ["down", "--volumes", "--remove-orphans", "--timeout", "20"], environment, { allowFailure: true, timeoutMs: 120_000 });
  };
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      cleanup();
      process.exit(128 + (signal === "SIGINT" ? 2 : 15));
    });
  }

  try {
    // Set before `up` so a partially created topology still retains logs and is
    // always torn down when image build or service startup fails midway.
    started = true;
    compose(project, ["up", "--build", "--detach", "--wait", "--wait-timeout", "240"], environment, { timeoutMs: 900_000 });
    const health = await waitForReadiness(baseUrl);
    assert(health.migrations === EXPECTED_SCHEMA_VERSION, `Expected schema migration ${EXPECTED_SCHEMA_VERSION}, received ${health.migrations}.`);
    assert(health.render?.ok === true, "Readiness did not report a healthy renderer.");
    assert(health.render?.mode === "worker" && health.render?.renderer === "playwright", "Readiness did not report the external Playwright worker.");
    assert(health.render?.softwareFallback === false, "Docker readiness reported software fallback.");

    const containerIds = {};
    for (const service of ["designer", "renderer"]) {
      const id = compose(project, ["ps", "--quiet", service], environment).stdout.trim();
      assert(/^[a-f0-9]{12,64}$/.test(id), `Could not resolve the ${service} container ID.`);
      containerIds[service] = id;
    }
    const containers = {};
    for (const [service, id] of Object.entries(containerIds)) {
      const inspected = parseJson(docker(["inspect", id]).stdout, `${service} docker inspect`);
      assert(Array.isArray(inspected) && inspected.length === 1, `Unexpected ${service} inspect result.`);
      containers[service] = containerEvidence(inspected[0], service);
    }
    assert(containers.designer.imageId === containers.renderer.imageId, "API and renderer did not use the same formaspec/server image bytes.");
    const rendererEgress = rendererEgressEvidence(containerIds.renderer);

    const volumeNames = docker([
      "volume", "ls", "--quiet", "--filter", `label=com.docker.compose.project=${project}`,
    ]).stdout.trim().split(/\r?\n/u).filter(Boolean);
    const inspectedVolumes = volumeNames.length === 0
      ? []
      : parseJson(docker(["volume", "inspect", ...volumeNames]).stdout, "Docker volume inspect");
    const volumes = volumeEvidence(inspectedVolumes);

    const created = await requestJson(`${baseUrl}/api/designs`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-formaspec-csrf": "1" },
      body: JSON.stringify({ name: "Schema 13 Docker CI", preset: "web", idempotencyKey: "docker-schema13-ci-create-0001" }),
    });
    const designId = created?.document?.id;
    assert(typeof designId === "string" && designId.length > 0, "Create-design response did not include a document ID.");
    assert(created.version === 1, "Fresh design did not begin at revision 1.");

    const firstRenderResponse = await fetch(`${baseUrl}/api/designs/${encodeURIComponent(designId)}/render.png?maxSize=512`, {
      headers: { "x-formaspec-csrf": "1" },
    });
    assert(firstRenderResponse.ok, `Initial PNG render returned ${firstRenderResponse.status}.`);
    assert(firstRenderResponse.headers.get("x-designer-renderer") === "playwright", "Initial render did not use Playwright.");
    const firstRender = pngMetadata(Buffer.from(await firstRenderResponse.arrayBuffer()));

    compose(project, ["restart", "designer"], environment, { timeoutMs: 120_000 });
    const restartedHealth = await waitForReadiness(baseUrl);
    assert(restartedHealth.migrations === EXPECTED_SCHEMA_VERSION, "Schema version changed after API restart.");
    const persisted = await requestJson(`${baseUrl}/api/designs/${encodeURIComponent(designId)}`);
    assert(persisted.version === created.version && persisted.revisionId === created.revisionId, "Design head did not persist across API restart.");
    const secondRenderResponse = await fetch(`${baseUrl}/api/designs/${encodeURIComponent(designId)}/render.png?maxSize=512`, {
      headers: { "x-formaspec-csrf": "1" },
    });
    assert(secondRenderResponse.ok, `Post-restart PNG render returned ${secondRenderResponse.status}.`);
    assert(secondRenderResponse.headers.get("x-designer-renderer") === "playwright", "Post-restart render did not use Playwright.");
    const secondRender = pngMetadata(Buffer.from(await secondRenderResponse.arrayBuffer()));
    assert(secondRender.sha256 === firstRender.sha256, "Deterministic PNG bytes changed after API restart.");

    summary.checks = {
      toolchain: {
        docker: docker(["--version"]).stdout.trim(),
        compose: docker(["compose", "version"]).stdout.trim(),
      },
      readiness: health,
      apiRestartReadiness: restartedHealth,
      design: { id: designId, version: created.version, revisionId: created.revisionId },
      firstRender,
      secondRender,
      deterministicRenderAcrossRestart: true,
      containers,
      rendererEgress,
      volumes,
    };
    summary.verificationStatus = "PASS";
  } catch (error) {
    summary.error = error instanceof Error ? error.message.slice(0, 8_000) : String(error).slice(0, 8_000);
    throw error;
  } finally {
    cleanup();
    const remainingContainers = docker([
      "ps", "--all", "--quiet", "--filter", `label=com.docker.compose.project=${project}`,
    ], { allowFailure: true }).stdout.trim();
    const remainingVolumes = docker([
      "volume", "ls", "--quiet", "--filter", `label=com.docker.compose.project=${project}`,
    ], { allowFailure: true }).stdout.trim();
    summary.checks.cleanup = {
      containersRemoved: remainingContainers === "",
      volumesRemoved: remainingVolumes === "",
    };
    if (remainingContainers !== "" || remainingVolumes !== "") {
      summary.verificationStatus = "FAILED";
      summary.error ??= "Disposable Compose resources remained after cleanup.";
    }
    writeJson(path.join(evidenceDirectory, "summary.json"), summary);
  }
  if (summary.verificationStatus !== "PASS") throw new Error(summary.error ?? "Docker smoke failed.");
  process.stdout.write(`Docker schema-13 smoke passed; retained evidence: ${evidenceDirectory}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
