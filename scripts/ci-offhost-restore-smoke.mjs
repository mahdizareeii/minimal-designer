#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const IMAGE = "formaspec/server:local";
const EXPECTED_SCHEMA_VERSION = 13;
const MAX_COMMAND_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_BACKUP_BUNDLE_BYTES = 512 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;
const MAX_LOG_BYTES = 16 * 1024 * 1024;
const DISPOSABLE_PROJECT_PATTERN = /^formaspecdr(?:source|target)[a-f0-9]{10}$/u;
const DISPOSABLE_JOB_PATTERN = /^formaspecdrjob[a-f0-9]{12}$/u;
const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");
const COMPOSE_FILE = path.join(REPOSITORY_ROOT, "docker-compose.yml");
const DOCKER_CONTROL_ENVIRONMENT_KEYS = Object.freeze([
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
]);
const RUNTIME_UID_MARKER = "__FORMASPEC_RUNTIME_UID__=";
const NON_ROOT_COMMAND_WRAPPER = `uid="$(id -u)"
printf '${RUNTIME_UID_MARKER}%s\\n' "$uid" >&2
if [ "$uid" = "0" ]; then
  printf 'FormaSpec DR helper refused to run as root.\\n' >&2
  exit 126
fi
exec "$@"`;
const REQUIRED_VOLUME_KINDS = Object.freeze(["designer-backups", "designer-data", "renderer-socket"]);
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=",
  "base64",
);

function usage() {
  return `Usage: node scripts/ci-offhost-restore-smoke.mjs

Uses an existing local formaspec/server:local image without building or pulling.
It creates two random disposable Docker Compose projects, copies a verified
backup through separate host-temporary locations, restores it into the clean
target project, verifies database/assets/render/state, and removes both projects
and their volumes. Evidence defaults to artifacts/ci/offhost-restore-simulation.

This is a same-machine isolation simulation. It always remains release NO-GO
for real remote-host, network-transfer, and TLS disaster recovery evidence.
`;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function isNonRootUserSpec(value) {
  if (typeof value !== "string" || value === "" || value.trim() !== value) return false;
  const segments = value.split(":");
  const primary = segments[0];
  if (segments.length > 2 || primary === "" || primary === "root"
    || (/^\d+$/u.test(primary) && Number(primary) === 0)) return false;
  return segments.length === 1 || segments[1] !== "";
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function boundedText(value, maximumBytes) {
  const bytes = Buffer.from(String(value), "utf8");
  if (bytes.length <= maximumBytes) return bytes.toString("utf8");
  const suffix = Buffer.from("\n[truncated]\n", "utf8");
  return Buffer.concat([bytes.subarray(0, Math.max(0, maximumBytes - suffix.length)), suffix]).toString("utf8");
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    timeout: options.timeoutMs ?? 300_000,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      `${executable} ${args.join(" ")} failed with exit ${result.status ?? "unknown"}: `
      + `${boundedText(stderr || stdout, 12_000)}`,
    );
  }
  return { status: result.status ?? 1, stdout, stderr };
}

function docker(args, options = {}) {
  return run("docker", args, options);
}

export function assertDisposableComposeProject(project) {
  assert(DISPOSABLE_PROJECT_PATTERN.test(project), "Compose project is not a generated FormaSpec DR disposable project.");
  assert(!["formaspec", "minimalappdesigner", "minimal-app-designer", "default"].includes(project), "Default or production-like Compose project names are forbidden.");
  return project;
}

export function composeArguments(project, args) {
  return [
    "compose",
    "--file", COMPOSE_FILE,
    "--project-directory", REPOSITORY_ROOT,
    "--project-name", assertDisposableComposeProject(project),
    ...args,
  ];
}

export function sanitizeComposeEnvironment(environment) {
  const sanitized = { ...environment };
  for (const key of Object.keys(sanitized)) {
    if (key.startsWith("COMPOSE_")) delete sanitized[key];
  }
  return sanitized;
}

export function assertNoDockerControlOverrides(environment) {
  const present = Object.keys(environment).filter((key) => (
    DOCKER_CONTROL_ENVIRONMENT_KEYS.includes(key.toUpperCase())
    && typeof environment[key] === "string" && environment[key] !== ""
  ));
  assert(present.length === 0, `Docker daemon control overrides are forbidden: ${present.sort().join(", ")}.`);
  return true;
}

export function localDockerEndpointEvidence(contextName, context, options = {}) {
  assert(typeof contextName === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(contextName), "Docker context name is invalid.");
  assert(context?.Name === contextName, "Docker context inspection did not match the active context.");
  const host = context?.Endpoints?.docker?.Host;
  assert(typeof host === "string" && host.length > 0 && host.length <= 4_096, "Docker context has no bounded daemon endpoint.");
  const platform = options.platform ?? process.platform;
  if (host.startsWith("unix://")) {
    const endpoint = new URL(host);
    assert(endpoint.protocol === "unix:" && endpoint.hostname === ""
      && endpoint.search === "" && endpoint.hash === "", "Docker Unix endpoint is malformed.");
    const socketPath = decodeURIComponent(endpoint.pathname);
    assert(path.isAbsolute(socketPath), "Docker Unix endpoint path is not absolute.");
    const metadata = (options.lstat ?? lstatSync)(socketPath);
    assert(metadata.isSocket() && !metadata.isSymbolicLink(), "Docker Unix endpoint is not a real local socket.");
    return {
      contextName,
      endpointType: "unix-socket",
      endpoint: host,
      localEndpointVerified: true,
      controlEnvironmentOverridesRejected: true,
    };
  }
  const pipePrefix = "npipe:////./pipe/";
  if (platform === "win32" && host.startsWith(pipePrefix)) {
    const pipeName = host.slice(pipePrefix.length);
    assert(/^[A-Za-z0-9_.-]{1,200}$/u.test(pipeName), "Docker named-pipe endpoint is malformed.");
    return {
      contextName,
      endpointType: "windows-named-pipe",
      endpoint: host,
      localEndpointVerified: true,
      controlEnvironmentOverridesRejected: true,
    };
  }
  throw new Error("Docker context is not backed by an approved local Unix socket or Windows named pipe.");
}

function inspectLocalDockerContext() {
  assertNoDockerControlOverrides(process.env);
  const contextName = docker(["context", "show"], { timeoutMs: 30_000 }).stdout.trim();
  const contexts = parseJson(
    docker(["context", "inspect", contextName], { timeoutMs: 30_000 }).stdout,
    "Active Docker context inspection",
  );
  assert(Array.isArray(contexts) && contexts.length === 1, "Active Docker context inspection was incomplete.");
  return localDockerEndpointEvidence(contextName, contexts[0]);
}

function compose(project, args, environment, options = {}) {
  return docker(composeArguments(project, args), {
    ...options,
    cwd: REPOSITORY_ROOT,
    env: sanitizeComposeEnvironment(environment),
  });
}

export function restoreOneShotArguments(command, containerName) {
  assert(Array.isArray(command) && command.length > 0 && command.every((item) => typeof item === "string" && item.length > 0), "Restore command is invalid.");
  assert(DISPOSABLE_JOB_PATTERN.test(containerName), "Restore helper container name is not disposable.");
  return [
    "--profile", "operations", "run",
    "--name", containerName,
    "--no-deps", "-T", "--pull", "never",
    "restore-worker",
    "sh", "-eu", "-c", NON_ROOT_COMMAND_WRAPPER, "formaspec-dr-runtime",
    ...command,
  ];
}

export function disposableProjectStartArguments() {
  return ["up", "--detach", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "240"];
}

function restoreOneShot(project, environment, command, options = {}) {
  const { expectedImageId, evidenceSink, evidenceLabel, ...runOptions } = options;
  assert(/^sha256:[a-f0-9]{64}$/u.test(expectedImageId), "Restore helper expected image ID is invalid.");
  assert(Array.isArray(evidenceSink), "Restore helper evidence sink is required.");
  assert(/^[a-z][a-z0-9-]{2,63}$/u.test(evidenceLabel), "Restore helper evidence label is invalid.");
  const containerName = `formaspecdrjob${randomBytes(6).toString("hex")}`;
  let result;
  let containerEvidence;
  let failure;
  let removalExitCode;
  try {
    result = compose(project, restoreOneShotArguments(command, containerName), environment, {
      ...runOptions,
      allowFailure: true,
    });
    const inspected = parseJson(docker(["container", "inspect", containerName]).stdout, "Restore helper container inspection");
    assert(Array.isArray(inspected) && inspected.length === 1, "Restore helper container inspection was incomplete.");
    const container = inspected[0];
    assert(container?.Image === expectedImageId, "Restore helper ran from an unexpected image ID.");
    assert(isNonRootUserSpec(container?.Config?.User), "Restore helper container configuration permits a root user.");
    const markers = [...result.stderr.matchAll(new RegExp(`^${RUNTIME_UID_MARKER}(\\d+)$`, "gmu"))];
    assert(markers.length === 1, "Restore helper runtime UID proof was missing or ambiguous.");
    const runtimeUid = Number(markers[0][1]);
    assert(Number.isSafeInteger(runtimeUid) && runtimeUid > 0, "Restore helper did not prove a non-root runtime UID.");
    containerEvidence = {
      name: containerName,
      project,
      operation: evidenceLabel,
      imageId: container.Image,
      configuredUser: container.Config.User,
      runtimeUid,
      nonRootRuntimeVerified: true,
    };
    if (result.status !== 0) {
      throw new Error(
        `Restore helper failed with exit ${result.status}: ${boundedText(result.stderr || result.stdout, 12_000)}`,
      );
    }
  } catch (error) {
    failure = error;
  } finally {
    const removal = docker(["container", "rm", "--force", containerName], {
      allowFailure: true,
      timeoutMs: 30_000,
    });
    removalExitCode = removal.status;
    const remaining = docker([
      "ps", "--all", "--format", "{{.Names}}", "--filter", `name=${containerName}`,
    ], { allowFailure: true, timeoutMs: 30_000 });
    const exactRemaining = remaining.stdout.split(/\r?\n/u).filter((name) => name === containerName);
    if (remaining.status !== 0 || exactRemaining.length > 0) {
      const cleanupError = new Error("Restore helper container cleanup could not be verified.");
      failure = failure
        ? new Error(`${failure instanceof Error ? failure.message : String(failure)}; ${cleanupError.message}`)
        : cleanupError;
    }
  }
  if (failure) throw failure;
  containerEvidence.removedAfterRun = true;
  containerEvidence.removalExitCode = removalExitCode;
  evidenceSink.push(containerEvidence);
  return result;
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} was not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseJsonLine(value, label) {
  const lines = value.trim().split(/\r?\n/u).filter(Boolean);
  assert(lines.length === 1, `${label} did not return one bounded JSON line.`);
  return parseJson(lines[0], label);
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

function projectEnvironment(port) {
  const baseUrl = `http://127.0.0.1:${port}`;
  return sanitizeComposeEnvironment({
    ...process.env,
    APP_MODE: "local",
    AUTH_MODE: "none",
    BIND_ADDRESS: "127.0.0.1",
    PORT: String(port),
    PUBLIC_BASE_URL: baseUrl,
    FORMASPEC_CONTAINER_LOCAL: "true",
    FORMASPEC_ALLOW_SOFTWARE_RENDERER: "false",
    FORMASPEC_ALLOW_SYSTEM_CHROME: "false",
    FORMASPEC_ALLOWED_HOSTS: `127.0.0.1:${port},localhost:${port}`,
    DESIGNER_CORS_ORIGINS: baseUrl,
    DESIGNER_TOKEN: "",
    FORMASPEC_PROXY_SECRET: "",
  });
}

async function fetchResponse(url, options = {}) {
  const { timeoutMs = 120_000, ...requestOptions } = options;
  return fetch(url, {
    ...requestOptions,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function requestJson(url, options = {}) {
  const response = await fetchResponse(url, options);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${url} returned ${response.status}: ${boundedText(text, 4_000)}`);
  }
  return parseJson(text, url);
}

async function waitForJson(url, predicate, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "unavailable";
  while (Date.now() < deadline) {
    try {
      const response = await fetchResponse(url, { timeoutMs: 5_000 });
      const text = await response.text();
      const body = text.length === 0 ? null : parseJson(text, url);
      last = `${response.status}: ${boundedText(text, 1_000)}`;
      if (predicate(response.status, body)) return { status: response.status, body };
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Timed out waiting for ${url}; last result: ${last}`);
}

async function waitForReady(baseUrl) {
  const result = await waitForJson(`${baseUrl}/health/ready`, (status, body) => (
    status === 200 && body?.ok === true && body?.database === "ready"
    && body?.migrations === EXPECTED_SCHEMA_VERSION
    && body?.render?.ok === true && body?.render?.mode === "worker"
    && body?.render?.renderer === "playwright" && body?.render?.softwareFallback === false
  ));
  return result.body;
}

async function waitForMaintenance(baseUrl, operationId) {
  const result = await waitForJson(`${baseUrl}/health/ready`, (status, body) => (
    status === 503 && body?.ok === false && body?.status === "maintenance"
    && body?.database === "ready" && body?.migrations === EXPECTED_SCHEMA_VERSION
    && body?.maintenance?.operationId === operationId
    && body?.render?.ok === true && body?.render?.mode === "worker"
    && body?.render?.renderer === "playwright" && body?.render?.softwareFallback === false
  ));
  return result.body;
}

function pngEvidence(bytes) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  assert(bytes.length >= 24 && bytes.subarray(0, 8).equals(signature), "Render response was not a PNG.");
  assert(bytes.subarray(12, 16).toString("ascii") === "IHDR", "PNG is missing IHDR.");
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  assert(width > 0 && height > 0 && width <= 512 && height <= 512, "PNG dimensions exceed smoke bounds.");
  return { width, height, sizeBytes: bytes.length, sha256: sha256(bytes) };
}

async function renderDesign(baseUrl, designId) {
  const response = await fetchResponse(
    `${baseUrl}/api/designs/${encodeURIComponent(designId)}/render.png?maxSize=512`,
    { headers: { "x-formaspec-csrf": "1" } },
  );
  assert(response.ok, `Render returned ${response.status}.`);
  assert(response.headers.get("x-designer-renderer") === "playwright", "Render did not use Playwright.");
  return pngEvidence(Buffer.from(await response.arrayBuffer()));
}

async function uploadAsset(baseUrl, designId) {
  const boundary = `----formaspec-dr-${randomBytes(8).toString("hex")}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="pixel.png"\r\nContent-Type: image/png\r\n\r\n`),
    ONE_PIXEL_PNG,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const response = await fetchResponse(`${baseUrl}/api/assets?designId=${encodeURIComponent(designId)}`, {
    method: "POST",
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "x-formaspec-csrf": "1",
    },
    body,
  });
  const text = await response.text();
  assert(response.status === 201, `Asset upload returned ${response.status}: ${boundedText(text, 4_000)}`);
  const asset = parseJson(text, "Asset upload");
  assert(/^asset_[A-Za-z0-9_-]{8,}$/u.test(asset.id), "Asset upload returned an invalid ID.");
  assert(/^[a-f0-9]{64}$/u.test(asset.sha256), "Asset upload returned an invalid hash.");
  return asset;
}

async function fetchAsset(baseUrl, assetId) {
  const response = await fetchResponse(`${baseUrl}/api/assets/${encodeURIComponent(assetId)}`);
  assert(response.ok, `Asset fetch returned ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    mimeType: response.headers.get("content-type"),
    etag: response.headers.get("etag"),
    sizeBytes: bytes.length,
    sha256: sha256(bytes),
  };
}

function inspectRunningProjectContainers(project, environment, expectedImageId) {
  assert(/^sha256:[a-f0-9]{64}$/u.test(expectedImageId), "Expected project image ID is invalid.");
  const ids = compose(project, ["ps", "--all", "--quiet"], environment, {
    timeoutMs: 30_000,
  }).stdout.trim().split(/\r?\n/u).filter(Boolean);
  assert(ids.length === 2, `Expected two service containers for ${project}, received ${ids.length}.`);
  const inspected = parseJson(
    docker(["container", "inspect", ...ids], { timeoutMs: 30_000 }).stdout,
    `${project} container inspection`,
  );
  assert(Array.isArray(inspected) && inspected.length === 2, `${project} container inspection was incomplete.`);
  const containers = inspected.map((container) => {
    const service = container?.Config?.Labels?.["com.docker.compose.service"];
    assert(["designer", "renderer"].includes(service), `${project} has an unexpected running service.`);
    assert(container?.Config?.Labels?.["com.docker.compose.project"] === project, `${project}/${service} has the wrong project label.`);
    assert(container?.State?.Running === true, `${project}/${service} is not running.`);
    assert(container?.Image === expectedImageId, `${project}/${service} ran from an unexpected image ID.`);
    assert(isNonRootUserSpec(container?.Config?.User), `${project}/${service} container configuration permits a root user.`);
    const uidText = docker(["container", "exec", container.Id, "id", "-u"], {
      timeoutMs: 30_000,
    }).stdout.trim();
    const runtimeUid = Number(uidText);
    assert(/^\d+$/u.test(uidText) && Number.isSafeInteger(runtimeUid) && runtimeUid > 0, `${project}/${service} did not prove a non-root runtime UID.`);
    return {
      id: container.Id,
      name: String(container.Name ?? "").replace(/^\//u, ""),
      service,
      imageId: container.Image,
      configuredUser: container.Config.User,
      runtimeUid,
      nonRootRuntimeVerified: true,
    };
  }).sort((left, right) => left.service.localeCompare(right.service));
  assert(new Set(containers.map((container) => container.service)).size === 2, `${project} service container identities are not unique.`);
  return {
    expectedImageId,
    allImageIdsMatch: true,
    allRuntimeUsersNonRoot: true,
    containers,
  };
}

function inspectProjectVolumes(project) {
  const names = docker([
    "volume", "ls", "--quiet", "--filter", `label=com.docker.compose.project=${project}`,
  ]).stdout.trim().split(/\r?\n/u).filter(Boolean);
  assert(names.length === 3, `Expected three disposable Compose volumes for ${project}, received ${names.length}.`);
  const inspected = parseJson(docker(["volume", "inspect", ...names]).stdout, `${project} volume inspection`);
  assert(Array.isArray(inspected) && inspected.length === 3, `${project} volume inspection was incomplete.`);
  const volumes = inspected.map((volume) => {
    const kind = volume?.Labels?.["com.docker.compose.volume"];
    assert(REQUIRED_VOLUME_KINDS.includes(kind), `${project} has an unexpected Compose volume kind.`);
    assert(volume.Driver === "local" && volume.Scope === "local", `${project}/${kind} is not a local disposable volume.`);
    assert(typeof volume.Name === "string" && volume.Name.length > 0, `${project}/${kind} has no volume name.`);
    assert(typeof volume.Mountpoint === "string" && path.isAbsolute(volume.Mountpoint), `${project}/${kind} has no absolute mountpoint.`);
    return { kind, name: volume.Name, mountpoint: volume.Mountpoint, driver: volume.Driver, scope: volume.Scope };
  }).sort((left, right) => left.kind.localeCompare(right.kind));
  assert(new Set(volumes.map((volume) => volume.kind)).size === 3, `${project} volume kinds are not unique.`);
  return volumes;
}

export function distinctVolumeEvidence(sourceVolumes, targetVolumes) {
  assert(Array.isArray(sourceVolumes) && Array.isArray(targetVolumes), "Volume evidence must be arrays.");
  const sourceNames = new Set(sourceVolumes.map((volume) => volume.name));
  const sourceMountpoints = new Set(sourceVolumes.map((volume) => volume.mountpoint));
  const sharedNames = targetVolumes.filter((volume) => sourceNames.has(volume.name)).map((volume) => volume.name);
  const sharedMountpoints = targetVolumes.filter((volume) => sourceMountpoints.has(volume.mountpoint)).map((volume) => volume.mountpoint);
  const sourceData = sourceVolumes.find((volume) => volume.kind === "designer-data");
  const targetData = targetVolumes.find((volume) => volume.kind === "designer-data");
  assert(sourceData && targetData, "Source and target data-volume identities are required.");
  assert(sharedNames.length === 0, "Source and target Compose projects share a named volume.");
  assert(sharedMountpoints.length === 0, "Source and target Compose projects alias a volume mountpoint.");
  assert(sourceData.name !== targetData.name && sourceData.mountpoint !== targetData.mountpoint, "Source and target data volumes are not independent.");
  return {
    allVolumeNamesDistinct: true,
    allMountpointsDistinct: true,
    sourceDataVolume: sourceData,
    targetDataVolume: targetData,
  };
}

function directoryIdentity(directory) {
  const resolved = realpathSync(directory);
  const metadata = lstatSync(resolved, { bigint: true });
  assert(metadata.isDirectory() && !metadata.isSymbolicLink(), "Transfer location is not a real directory.");
  return { device: String(metadata.dev), inode: String(metadata.ino), basename: path.basename(resolved) };
}

function regularFile(filename, maximumBytes, label) {
  const metadata = lstatSync(filename, { bigint: true });
  assert(metadata.isFile() && !metadata.isSymbolicLink(), `${label} must be a regular non-symlink file.`);
  assert(metadata.size > 0n && metadata.size <= BigInt(maximumBytes), `${label} size is outside the bounded range.`);
  const bytes = readFileSync(filename);
  return { bytes, sizeBytes: bytes.length, sha256: sha256(bytes) };
}

function databaseProbe(runOneShot, project, environment, designId, assetId, options = {}) {
  assert(typeof runOneShot === "function", "Database probe restore helper is required.");
  const expectEntities = options.expectEntities ?? true;
  assert(/^[A-Za-z][A-Za-z0-9_-]{2,200}$/u.test(designId), "Database probe design ID is invalid.");
  assert(/^asset_[A-Za-z0-9_-]{8,}$/u.test(assetId), "Database probe asset ID is invalid.");
  const program = `
import { createRequire } from "node:module";
const require = createRequire("/app/apps/server/dist/formaspec-dr-probe.cjs");
const Database = require("better-sqlite3");
const database = new Database("/data/designer.sqlite", { readonly: true, fileMustExist: true });
try {
  const integrity = database.pragma("integrity_check", { simple: true });
  const foreignKeys = database.pragma("foreign_key_check");
  const migration = database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get();
  const design = database.prepare(
    "SELECT d.current_version AS version, d.current_revision_id AS revisionId, r.snapshot_hash AS snapshotHash, r.revision_hash AS revisionHash FROM designs d JOIN revisions r ON r.id = d.current_revision_id AND r.design_id = d.id WHERE d.id = ?"
  ).get(${JSON.stringify(designId)});
  const asset = database.prepare(
    "SELECT id, design_id AS designId, sha256, size_bytes AS sizeBytes, mime_type AS mimeType, width, height FROM assets WHERE id = ?"
  ).get(${JSON.stringify(assetId)});
  const state = {
    integrity,
    foreignKeyViolations: foreignKeys.length,
    migrationVersion: migration?.version ?? null,
    design: design ?? null,
    asset: asset ?? null,
    designCount: database.prepare("SELECT COUNT(*) AS count FROM designs").get().count,
    assetCount: database.prepare("SELECT COUNT(*) AS count FROM assets").get().count,
  };
  process.stdout.write(JSON.stringify(state));
} finally {
  database.close();
}
`;
  const result = runOneShot(project, environment, [
    "node", "--input-type=module", "--eval", program,
  ], {
    timeoutMs: 120_000,
    evidenceLabel: options.evidenceLabel ?? "database-probe",
  });
  const probe = parseJsonLine(result.stdout, `${project} database probe`);
  assert(probe.integrity === "ok", `${project} SQLite integrity_check did not return ok.`);
  assert(probe.foreignKeyViolations === 0, `${project} SQLite foreign_key_check found violations.`);
  assert(probe.migrationVersion === EXPECTED_SCHEMA_VERSION, `${project} migration version drifted.`);
  if (expectEntities) {
    assert(probe.design && probe.asset, `${project} database probe did not find restored state.`);
  } else {
    assert(!probe.design && !probe.asset, `${project} database probe found source entities before restore.`);
  }
  return probe;
}

function writeBoundedFile(filename, content, mode) {
  const bytes = Buffer.from(content, "utf8");
  assert(bytes.length <= MAX_LOG_BYTES, `${path.basename(filename)} exceeds the evidence log limit.`);
  assert(!existsSync(filename), `Evidence file already exists: ${path.basename(filename)}`);
  writeFileSync(filename, bytes, { mode, flag: "wx" });
}

function writeEvidence(evidenceDirectory, summary, logs) {
  validateNoGoEvidence(summary);
  for (const [name, content] of Object.entries(logs)) {
    writeBoundedFile(path.join(evidenceDirectory, name), boundedText(content, MAX_LOG_BYTES), 0o600);
  }
  const manifest = `${JSON.stringify(summary, null, 2)}\n`;
  assert(Buffer.byteLength(manifest, "utf8") <= MAX_EVIDENCE_BYTES, "DR evidence manifest exceeds its bounded size.");
  const manifestName = "NO-GO-SUMMARY.json";
  writeBoundedFile(path.join(evidenceDirectory, manifestName), manifest, 0o644);
  const checksums = `${sha256(Buffer.from(manifest, "utf8"))}  ${manifestName}\n`;
  assert(!existsSync(path.join(evidenceDirectory, "SHA256SUMS")), "Evidence checksum file already exists.");
  writeFileSync(
    path.join(evidenceDirectory, "SHA256SUMS"),
    checksums,
    { mode: 0o644, flag: "wx" },
  );
}

function prepareEvidenceDirectory(evidenceDirectory) {
  if (!existsSync(evidenceDirectory)) mkdirSync(evidenceDirectory, { recursive: true, mode: 0o755 });
  const metadata = lstatSync(evidenceDirectory);
  assert(metadata.isDirectory() && !metadata.isSymbolicLink(), "Evidence target must be a real directory.");
  for (const filename of ["NO-GO-SUMMARY.json", "SHA256SUMS"]) {
    assert(!existsSync(path.join(evidenceDirectory, filename)), `Evidence target already contains ${filename}.`);
  }
}

export function initialNoGoEvidence({ sourceProject, targetProject, sourceEndpoint, targetEndpoint }) {
  assertDisposableComposeProject(sourceProject);
  assertDisposableComposeProject(targetProject);
  assert(sourceProject !== targetProject, "Source and target Compose projects must differ.");
  return {
    format: "formaspec-offhost-restore-simulation-evidence",
    schemaVersion: 1,
    releaseStatus: "NO-GO",
    verificationStatus: "FAILED",
    evidenceLevel: "same-host-disposable-isolation-simulation",
    sourceSha: process.env.FORMASPEC_CI_SOURCE_SHA ?? "local-uncommitted-source",
    sourceProject,
    targetProject,
    sourceEndpoint,
    targetEndpoint,
    claims: {
      copiedVerifiedBundleToSeparateDisposableLocation: false,
      independentComposeProjects: false,
      independentDataVolumes: false,
      cleanTargetRestoreVerified: false,
      sqliteIntegrityVerified: false,
      foreignKeysVerified: false,
      assetsVerified: false,
      deterministicRenderVerified: false,
      designHashStateVerified: false,
      disposableResourcesCleaned: false,
      realRemoteHostVerified: false,
      realNetworkTransferVerified: false,
      tlsVerified: false,
    },
    checks: {},
    blockers: [
      "Release remains NO-GO for off-host disaster recovery.",
      "This evidence uses two isolated disposable Docker Compose projects on one machine; it is not a real remote-host restore.",
      "No network transfer, TLS, DNS, firewall, object storage, remote credentials, latency, bandwidth, or remote operator runbook was exercised.",
      "Independent external retention, scheduled remote replication, remote-host capacity, and organization recovery-time/recovery-point objectives remain unproven.",
      "The smoke uses a prebuilt local image checkpoint; its relationship to the current source tree is not independently proven by this script.",
    ],
  };
}

export function validateNoGoEvidence(summary) {
  assert(summary?.releaseStatus === "NO-GO", "DR simulation evidence must remain release NO-GO.");
  assert(summary?.evidenceLevel === "same-host-disposable-isolation-simulation", "DR evidence level overclaims its environment.");
  assert(summary?.claims?.realRemoteHostVerified === false, "DR simulation cannot claim a real remote host.");
  assert(summary?.claims?.realNetworkTransferVerified === false, "DR simulation cannot claim a real network transfer.");
  assert(summary?.claims?.tlsVerified === false, "DR simulation cannot claim TLS evidence.");
  assert(Array.isArray(summary?.blockers) && summary.blockers.length >= 4, "DR simulation blockers are incomplete.");
  return summary;
}

function cleanupProject(project, environment, logs) {
  let logCaptureSucceeded = false;
  try {
    const output = compose(project, ["logs", "--no-color", "--timestamps"], environment, {
      allowFailure: true,
      timeoutMs: 60_000,
    });
    logCaptureSucceeded = output.status === 0;
    logs[`${project}.log`] = `${output.stdout}${output.stderr}`;
  } catch (error) {
    logs[`${project}.log`] = `[log capture failed before cleanup]\n${boundedText(
      error instanceof Error ? error.message : String(error),
      4_000,
    )}\n`;
  }
  const down = compose(project, ["down", "--volumes", "--remove-orphans", "--timeout", "20"], environment, {
    allowFailure: true,
    timeoutMs: 120_000,
  });
  const containers = docker([
    "ps", "--all", "--quiet", "--filter", `label=com.docker.compose.project=${project}`,
  ], { allowFailure: true, timeoutMs: 30_000 });
  const volumes = docker([
    "volume", "ls", "--quiet", "--filter", `label=com.docker.compose.project=${project}`,
  ], { allowFailure: true, timeoutMs: 30_000 });
  const networks = docker([
    "network", "ls", "--quiet", "--filter", `label=com.docker.compose.project=${project}`,
  ], { allowFailure: true, timeoutMs: 30_000 });
  const remainingContainers = containers.stdout.trim();
  const remainingVolumes = volumes.stdout.trim();
  const remainingNetworks = networks.stdout.trim();
  return {
    logCaptureSucceeded,
    downSucceeded: down.status === 0,
    downExitCode: down.status,
    downDiagnostic: down.status === 0 ? undefined : boundedText(down.stderr || down.stdout, 2_000),
    containerInspectionSucceeded: containers.status === 0,
    containerInspectionExitCode: containers.status,
    containersRemoved: containers.status === 0 && remainingContainers === "",
    remainingContainers: remainingContainers || undefined,
    volumeInspectionSucceeded: volumes.status === 0,
    volumeInspectionExitCode: volumes.status,
    volumesRemoved: volumes.status === 0 && remainingVolumes === "",
    remainingVolumes: remainingVolumes || undefined,
    networkInspectionSucceeded: networks.status === 0,
    networkInspectionExitCode: networks.status,
    networksRemoved: networks.status === 0 && remainingNetworks === "",
    remainingNetworks: remainingNetworks || undefined,
  };
}

export function cleanupProjectComplete(cleanup) {
  return cleanup?.logCaptureSucceeded === true
    && cleanup?.downSucceeded === true
    && cleanup?.containerInspectionSucceeded === true
    && cleanup?.containersRemoved === true
    && cleanup?.volumeInspectionSucceeded === true
    && cleanup?.volumesRemoved === true
    && cleanup?.networkInspectionSucceeded === true
    && cleanup?.networksRemoved === true;
}

function safeCleanupProject(project, environment, logs) {
  try {
    return cleanupProject(project, environment, logs);
  } catch (error) {
    return {
      logCaptureSucceeded: false,
      downSucceeded: false,
      containerInspectionSucceeded: false,
      containersRemoved: false,
      volumeInspectionSucceeded: false,
      volumesRemoved: false,
      networkInspectionSucceeded: false,
      networksRemoved: false,
      error: boundedText(error instanceof Error ? error.message : String(error), 2_000),
    };
  }
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(usage());
    return;
  }
  if (process.argv.length > 2) throw new Error(usage());

  const evidenceDirectory = path.resolve(
    process.env.FORMASPEC_CI_EVIDENCE_DIR ?? "artifacts/ci/offhost-restore-simulation",
  );
  assert(evidenceDirectory.length <= 4_096 && !/[\r\n\0]/u.test(evidenceDirectory), "Evidence directory is invalid.");
  prepareEvidenceDirectory(evidenceDirectory);
  const suffix = randomBytes(5).toString("hex");
  const sourceProject = assertDisposableComposeProject(`formaspecdrsource${suffix}`);
  const targetProject = assertDisposableComposeProject(`formaspecdrtarget${suffix}`);
  const sourcePort = await reserveLoopbackPort();
  const targetPort = await reserveLoopbackPort();
  assert(sourcePort !== targetPort, "Source and target loopback ports collided.");
  const sourceEndpoint = `http://127.0.0.1:${sourcePort}`;
  const targetEndpoint = `http://127.0.0.1:${targetPort}`;
  const sourceEnvironment = projectEnvironment(sourcePort);
  const targetEnvironment = projectEnvironment(targetPort);
  const summary = initialNoGoEvidence({ sourceProject, targetProject, sourceEndpoint, targetEndpoint });
  const logs = {};
  const sourceDownloadDirectory = mkdtempSync(path.join(os.tmpdir(), "formaspec-dr-source-copy-"));
  const transferDirectory = mkdtempSync(path.join(os.tmpdir(), "formaspec-dr-transfer-copy-"));
  let failure;
  let emergencyCleaning = false;

  const emergencyCleanup = (signal, exitCode) => {
    if (emergencyCleaning) return;
    emergencyCleaning = true;
    summary.verificationStatus = "FAILED";
    summary.error = `Interrupted by ${signal}; disposable cleanup was attempted.`;
    const cleanup = {};
    cleanup.target = safeCleanupProject(targetProject, targetEnvironment, logs);
    cleanup.source = safeCleanupProject(sourceProject, sourceEnvironment, logs);
    rmSync(sourceDownloadDirectory, { recursive: true, force: true });
    rmSync(transferDirectory, { recursive: true, force: true });
    cleanup.transferLocationsRemoved = !existsSync(sourceDownloadDirectory) && !existsSync(transferDirectory);
    summary.checks.cleanup = cleanup;
    summary.claims.disposableResourcesCleaned = cleanupProjectComplete(cleanup.source)
      && cleanupProjectComplete(cleanup.target) && cleanup.transferLocationsRemoved;
    try {
      writeEvidence(evidenceDirectory, summary, logs);
    } catch {
      // Signal cleanup must still terminate even if evidence storage is unavailable.
    }
    process.exit(exitCode);
  };
  const onSigint = () => emergencyCleanup("SIGINT", 130);
  const onSigterm = () => emergencyCleanup("SIGTERM", 143);
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  try {
    const composeMetadata = lstatSync(COMPOSE_FILE);
    assert(composeMetadata.isFile() && !composeMetadata.isSymbolicLink(), "Pinned Docker Compose file is unavailable or unsafe.");
    const dockerContext = inspectLocalDockerContext();
    const toolchain = {
      docker: docker(["--version"]).stdout.trim(),
      compose: docker(["compose", "version"]).stdout.trim(),
      context: dockerContext,
    };
    const images = parseJson(docker(["image", "inspect", IMAGE]).stdout, "FormaSpec image inspection");
    assert(Array.isArray(images) && images.length === 1, "Pinned FormaSpec image is unavailable; this smoke never builds or pulls dependencies.");
    const imageId = images[0]?.Id;
    const imageUser = images[0]?.Config?.User;
    assert(/^sha256:[a-f0-9]{64}$/u.test(imageId), "FormaSpec image is not content-addressed.");
    assert(isNonRootUserSpec(imageUser), "FormaSpec image must configure a non-root primary user.");
    const oneShotContainers = [];
    const runRestoreHelper = (project, environment, command, options = {}) => restoreOneShot(
      project,
      environment,
      command,
      { ...options, expectedImageId: imageId, evidenceSink: oneShotContainers },
    );

    compose(sourceProject, disposableProjectStartArguments(), sourceEnvironment, {
      timeoutMs: 300_000,
    });
    const sourceReady = await waitForReady(sourceEndpoint);
    const sourceContainers = inspectRunningProjectContainers(sourceProject, sourceEnvironment, imageId);
    const created = await requestJson(`${sourceEndpoint}/api/designs`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-formaspec-csrf": "1" },
      body: JSON.stringify({
        name: "Off-host restore simulation source",
        preset: "web",
        idempotencyKey: "offhost-restore-source-design-0001",
      }),
    });
    const designId = created?.document?.id;
    const revisionId = created?.revisionId;
    assert(typeof designId === "string" && typeof revisionId === "string", "Source design identity is incomplete.");
    const asset = await uploadAsset(sourceEndpoint, designId);
    const sourceAsset = await fetchAsset(sourceEndpoint, asset.id);
    assert(sourceAsset.sha256 === asset.sha256, "Source asset bytes do not match their normalized hash.");
    const sourceRender = await renderDesign(sourceEndpoint, designId);
    const sourceDatabase = databaseProbe(
      runRestoreHelper,
      sourceProject,
      sourceEnvironment,
      designId,
      asset.id,
      { evidenceLabel: "source-database-probe" },
    );
    assert(sourceDatabase.design.revisionId === revisionId, "Source database head does not match the API revision.");
    assert(sourceDatabase.asset.sha256 === asset.sha256, "Source database asset hash does not match the API.");
    assert(sourceDatabase.asset.mimeType === sourceAsset.mimeType
      && sourceDatabase.asset.width === 1 && sourceDatabase.asset.height === 1, "Source normalized asset metadata is unexpected.");

    const createdBackup = await requestJson(`${sourceEndpoint}/api/backups`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-formaspec-csrf": "1" },
      body: "{}",
      timeoutMs: 300_000,
    });
    const backupId = createdBackup?.backup?.id;
    assert(/^backup_[a-f0-9]{40}$/u.test(backupId), "Backup API returned an invalid backup ID.");
    const verifiedBackup = await requestJson(`${sourceEndpoint}/api/backups/${backupId}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-formaspec-csrf": "1" },
      body: "{}",
      timeoutMs: 300_000,
    });
    const backup = verifiedBackup?.backup;
    assert(backup?.status === "valid" && /^[a-f0-9]{64}$/u.test(backup.bundleSha256), "Source backup did not reach verified valid state.");
    assert(Number.isSafeInteger(backup.sizeBytes) && backup.sizeBytes > 0 && backup.sizeBytes <= MAX_BACKUP_BUNDLE_BYTES, "Verified backup size is invalid.");
    const download = await fetchResponse(`${sourceEndpoint}/api/backups/${backupId}/download`, { timeoutMs: 300_000 });
    assert(download.ok, `Backup download returned ${download.status}.`);
    assert(download.headers.get("x-formaspec-backup-id") === backupId, "Backup download ID header drifted.");
    assert(download.headers.get("x-formaspec-bundle-sha256") === backup.bundleSha256, "Backup download hash header drifted.");
    const declaredLength = Number(download.headers.get("content-length"));
    assert(declaredLength === backup.sizeBytes && declaredLength <= MAX_BACKUP_BUNDLE_BYTES, "Backup download length is invalid.");
    const downloadedBytes = Buffer.from(await download.arrayBuffer());
    assert(downloadedBytes.length === backup.sizeBytes && sha256(downloadedBytes) === backup.bundleSha256, "Downloaded backup bytes failed their immutable pin.");

    const sourceBundlePath = path.join(sourceDownloadDirectory, "verified-source-backup.tar");
    const transferredBundlePath = path.join(transferDirectory, "copied-offhost-simulation-backup.tar");
    writeFileSync(sourceBundlePath, downloadedBytes, { mode: 0o600 });
    copyFileSync(sourceBundlePath, transferredBundlePath);
    chmodSync(transferredBundlePath, 0o600);
    const sourceCopy = regularFile(sourceBundlePath, MAX_BACKUP_BUNDLE_BYTES, "Source downloaded backup");
    const transferredCopy = regularFile(transferredBundlePath, MAX_BACKUP_BUNDLE_BYTES, "Transferred backup copy");
    assert(sourceCopy.sha256 === backup.bundleSha256 && transferredCopy.sha256 === sourceCopy.sha256
      && transferredCopy.sizeBytes === sourceCopy.sizeBytes, "Copied backup bytes changed between disposable locations.");
    const sourceLocation = directoryIdentity(sourceDownloadDirectory);
    const transferLocation = directoryIdentity(transferDirectory);
    assert(sourceLocation.device !== transferLocation.device || sourceLocation.inode !== transferLocation.inode, "Source download and transfer copy directories are not distinct.");

    compose(targetProject, disposableProjectStartArguments(), targetEnvironment, {
      timeoutMs: 300_000,
    });
    const targetCleanReady = await waitForReady(targetEndpoint);
    const targetContainers = inspectRunningProjectContainers(targetProject, targetEnvironment, imageId);
    const cleanProbe = await fetchResponse(`${targetEndpoint}/api/designs/${encodeURIComponent(designId)}`);
    assert(cleanProbe.status === 404, "Independent target was not clean before restore.");
    const targetCleanDatabase = databaseProbe(
      runRestoreHelper,
      targetProject,
      targetEnvironment,
      designId,
      asset.id,
      { expectEntities: false, evidenceLabel: "clean-target-database-probe" },
    );
    assert(targetCleanDatabase.designCount === 0 && targetCleanDatabase.assetCount === 0, "Independent target database was not empty before restore.");
    const sourceVolumes = inspectProjectVolumes(sourceProject);
    const targetVolumes = inspectProjectVolumes(targetProject);
    const volumeSeparation = distinctVolumeEvidence(sourceVolumes, targetVolumes);

    compose(sourceProject, ["stop", "--timeout", "30"], sourceEnvironment, { timeoutMs: 120_000 });
    const sourceRunning = compose(sourceProject, ["ps", "--quiet", "--status", "running"], sourceEnvironment, {
      allowFailure: true,
      timeoutMs: 30_000,
    });
    assert(sourceRunning.status === 0 && sourceRunning.stdout.trim() === "", "Source project stop could not be verified before independent target restore.");

    const operationId = `restore_${randomBytes(16).toString("hex")}`;
    const maintenanceSet = parseJsonLine(runRestoreHelper(targetProject, targetEnvironment, [
      "node", "apps/server/dist/restore-control.js", "set", "--operation-id", operationId,
    ], { evidenceLabel: "maintenance-set" }).stdout, "Target maintenance set");
    assert(maintenanceSet.ok === true && maintenanceSet.status?.maintenance?.active === true, "Target maintenance fence was not established.");
    compose(targetProject, ["stop", "--timeout", "30", "designer"], targetEnvironment, { timeoutMs: 120_000 });

    const pinnedTransfer = regularFile(transferredBundlePath, MAX_BACKUP_BUNDLE_BYTES, "Pinned transfer backup");
    assert(pinnedTransfer.sha256 === backup.bundleSha256 && pinnedTransfer.sizeBytes === backup.sizeBytes, "Transfer bundle changed before target ingestion.");
    const preparationEnvelope = parseJsonLine(runRestoreHelper(targetProject, targetEnvironment, [
      "node", "apps/server/dist/restore-worker.js", "offline-prepare",
      "--operation-id", operationId,
      "--expected-sha256", pinnedTransfer.sha256,
      "--expected-size", String(pinnedTransfer.sizeBytes),
    ], {
      input: pinnedTransfer.bytes,
      timeoutMs: 30 * 60_000,
      evidenceLabel: "offline-prepare",
    }).stdout, "Offline restore preparation");
    const preparation = preparationEnvelope.preparation;
    assert(preparationEnvelope.ok === true && preparation?.status === "prepared"
      && preparation?.operationId === operationId && /^backup_[a-f0-9]{40}$/u.test(preparation?.backupId), "Offline restore preparation metadata is invalid.");
    assert(preparation.targetSha256 === pinnedTransfer.sha256
      && preparation.targetSizeBytes === pinnedTransfer.sizeBytes, "Offline restore preparation did not preserve the transferred bundle pin.");

    const workerEnvelope = parseJsonLine(runRestoreHelper(targetProject, targetEnvironment, [
      "node", "apps/server/dist/restore-worker.js",
      "--backup-id", preparation.backupId,
      "--operation-id", operationId,
    ], { timeoutMs: 30 * 60_000, evidenceLabel: "restore-worker" }).stdout, "Offline restore worker");
    const worker = workerEnvelope.result;
    assert(workerEnvelope.ok === true && worker?.status === "restored" && worker?.operationId === operationId
      && worker?.backupId === preparation.backupId && worker?.schemaVersion === EXPECTED_SCHEMA_VERSION
      && worker?.safetyBackupId === preparation.safetyBackupId
      && worker?.renderedDesignId === designId && worker?.maintenancePhase === "verification", "Restore worker evidence is incomplete.");

    compose(targetProject, ["start", "designer"], targetEnvironment, { timeoutMs: 120_000 });
    const maintenanceReady = await waitForMaintenance(targetEndpoint, operationId);
    const maintenanceClear = parseJsonLine(runRestoreHelper(targetProject, targetEnvironment, [
      "node", "apps/server/dist/restore-control.js", "clear", "--operation-id", operationId,
    ], { evidenceLabel: "maintenance-clear" }).stdout, "Target maintenance clear");
    assert(maintenanceClear.ok === true && maintenanceClear.status?.maintenance?.active === false, "Target maintenance fence did not clear after verified restore.");
    const targetReady = await waitForReady(targetEndpoint);

    const targetDesign = await requestJson(`${targetEndpoint}/api/designs/${encodeURIComponent(designId)}`);
    assert(targetDesign.version === created.version && targetDesign.revisionId === revisionId, "Restored design state does not match the source head.");
    const targetAsset = await fetchAsset(targetEndpoint, asset.id);
    assert(targetAsset.sha256 === sourceAsset.sha256 && targetAsset.sizeBytes === sourceAsset.sizeBytes
      && targetAsset.etag === sourceAsset.etag && targetAsset.mimeType === sourceAsset.mimeType, "Restored asset bytes, MIME type, or immutable headers changed.");
    const targetRender = await renderDesign(targetEndpoint, designId);
    assert(targetRender.sha256 === sourceRender.sha256, "Deterministic render changed after independent restore.");
    const targetDatabase = databaseProbe(
      runRestoreHelper,
      targetProject,
      targetEnvironment,
      designId,
      asset.id,
      { evidenceLabel: "restored-target-database-probe" },
    );
    assert(targetDatabase.design.version === sourceDatabase.design.version
      && targetDatabase.design.revisionId === sourceDatabase.design.revisionId
      && targetDatabase.design.snapshotHash === sourceDatabase.design.snapshotHash
      && targetDatabase.design.revisionHash === sourceDatabase.design.revisionHash, "Restored revision integrity state differs from source.");
    assert(targetDatabase.asset.sha256 === sourceDatabase.asset.sha256
      && targetDatabase.asset.sizeBytes === sourceDatabase.asset.sizeBytes
      && targetDatabase.asset.designId === sourceDatabase.asset.designId
      && targetDatabase.asset.mimeType === sourceDatabase.asset.mimeType
      && targetDatabase.asset.width === sourceDatabase.asset.width
      && targetDatabase.asset.height === sourceDatabase.asset.height, "Restored asset database state differs from source.");
    assert(targetDatabase.designCount === sourceDatabase.designCount
      && targetDatabase.assetCount === sourceDatabase.assetCount, "Restored design or asset totals differ from source.");
    assert(oneShotContainers.length === 7, "Restore helper container verification coverage is incomplete.");
    const targetVolumesAfterRestore = inspectProjectVolumes(targetProject);
    assert(JSON.stringify(targetVolumesAfterRestore) === JSON.stringify(targetVolumes), "Target volume identity changed during restore.");

    summary.checks = {
      toolchain,
      image: {
        reference: IMAGE,
        imageId,
        imageUser,
        buildOrPullPerformed: false,
        pullPolicy: "never",
        sourceContainers,
        targetContainers,
        oneShotContainers,
        evidenceClass: "prebuilt-local-checkpoint",
        currentSourceRelationship: "unverified",
      },
      topology: {
        sourceProject,
        targetProject,
        sourceVolumes,
        targetVolumes,
        volumeSeparation,
        sourceStoppedBeforeTargetRestore: true,
      },
      source: {
        readiness: sourceReady,
        design: { id: designId, version: created.version, revisionId },
        asset: { id: asset.id, ...sourceAsset },
        render: sourceRender,
        database: sourceDatabase,
        verifiedBackup: backup,
      },
      transfer: {
        sourceLocation,
        copiedLocation: transferLocation,
        locationsDistinct: true,
        sourceCopy: { sizeBytes: sourceCopy.sizeBytes, sha256: sourceCopy.sha256 },
        copiedBundle: { sizeBytes: transferredCopy.sizeBytes, sha256: transferredCopy.sha256 },
      },
      target: {
        cleanTargetBeforeRestore: true,
        cleanReadiness: targetCleanReady,
        cleanDatabase: targetCleanDatabase,
        preparation,
        worker,
        maintenanceReadiness: maintenanceReady,
        readiness: targetReady,
        design: { id: designId, version: targetDesign.version, revisionId: targetDesign.revisionId },
        asset: { id: asset.id, ...targetAsset },
        render: targetRender,
        database: targetDatabase,
      },
      comparisons: {
        bundleHashPreserved: true,
        bundleSizePreserved: true,
        preparationTargetPinMatchesTransfer: true,
        restoreWorkerLinkedToPreparation: true,
        revisionAndSnapshotHashesMatch: true,
        assetHashAndBytesMatch: true,
        assetMetadataMatches: true,
        designAndAssetCountsMatch: true,
        deterministicRenderMatches: true,
        sqliteIntegrityOk: true,
        foreignKeyViolations: 0,
      },
    };
    Object.assign(summary.claims, {
      copiedVerifiedBundleToSeparateDisposableLocation: true,
      independentComposeProjects: true,
      independentDataVolumes: true,
      cleanTargetRestoreVerified: true,
      sqliteIntegrityVerified: true,
      foreignKeysVerified: true,
      assetsVerified: true,
      deterministicRenderVerified: true,
      designHashStateVerified: true,
    });
    summary.verificationStatus = "PASS";
  } catch (error) {
    failure = error;
    summary.error = boundedText(error instanceof Error ? error.message : String(error), 12_000);
  } finally {
    const cleanup = {};
    cleanup.target = safeCleanupProject(targetProject, targetEnvironment, logs);
    cleanup.source = safeCleanupProject(sourceProject, sourceEnvironment, logs);
    rmSync(sourceDownloadDirectory, { recursive: true, force: true });
    rmSync(transferDirectory, { recursive: true, force: true });
    cleanup.transferLocationsRemoved = !existsSync(sourceDownloadDirectory) && !existsSync(transferDirectory);
    summary.checks.cleanup = cleanup;
    summary.claims.disposableResourcesCleaned = cleanupProjectComplete(cleanup.source)
      && cleanupProjectComplete(cleanup.target) && cleanup.transferLocationsRemoved;
    if (!summary.claims.disposableResourcesCleaned) {
      summary.verificationStatus = "FAILED";
      summary.error ??= "Disposable DR smoke resources remained after cleanup.";
      failure ??= new Error(summary.error);
    }
    validateNoGoEvidence(summary);
    writeEvidence(evidenceDirectory, summary, logs);
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }

  if (failure) throw failure;
  assert(summary.verificationStatus === "PASS", "Off-host restore simulation did not pass.");
  process.stdout.write(`Off-host restore simulation passed; release remains NO-GO. Evidence: ${evidenceDirectory}\n`);
}

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entrypoint === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
