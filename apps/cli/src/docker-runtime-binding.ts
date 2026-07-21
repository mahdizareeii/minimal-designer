import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { findExecutable, runCommand, type CommandRunner } from "./process.js";

const BINDING_FORMAT = "formaspec-docker-runtime-binding";
const LEGACY_BINDING_VERSION = 1;
const BINDING_VERSION = 2;
const BINDING_FILENAME = "docker-runtime-binding.json";
export const DEFAULT_DOCKER_COMPOSE_PROJECT = "minimalappdesigner";
const CONTAINER_PORT = 4310;
const MAX_BINDING_BYTES = 16 * 1024;
const MAX_DOCKER_OUTPUT_BYTES = 256 * 1024;
const MAX_VOLUME_MOUNTPOINT_BYTES = 4096;
const INSPECT_FORMAT = [
  "{{json .Id}}",
  "{{json .Image}}",
  "{{json .Config.Labels}}",
  "{{json .Mounts}}",
  "{{json .HostConfig.NetworkMode}}",
  "{{json .HostConfig.PortBindings}}",
].join("\n");

const contextPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const composeProjectPattern = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const daemonIdPattern = /^[A-Za-z0-9][A-Za-z0-9:._-]{5,255}$/;
const containerIdPattern = /^[a-f0-9]{64}$/;
const imageIdPattern = /^sha256:[a-f0-9]{64}$/;
const volumeNamePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;
const configHashPattern = /^[a-f0-9]{64}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const containerNamePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const composeVersionPattern = /^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/;
const trustedHeaderPattern = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
const bearerTokenPattern = /^[A-Za-z0-9._-]{16,4096}$/;
const proxySecretPattern = /^[A-Za-z0-9._-]{32,256}$/;

type BoundService = "designer" | "renderer";
type LoopbackHost = "127.0.0.1" | "::1";
type RecordedRuntimeMode = "docker" | "server";
type ServerAccess = "none" | "ssh" | "proxy";

function isSafeTrustedIdentityHeader(value: string, csrfHeader = "x-formaspec-csrf"): boolean {
  const normalized = value.toLowerCase();
  const normalizedCsrf = csrfHeader.toLowerCase();
  return trustedHeaderPattern.test(value)
    && /^x-[a-z0-9][a-z0-9-]{0,125}$/.test(normalized)
    && normalized !== normalizedCsrf
    && !new Set([
      "x-api-key",
      "x-correlation-id",
      "x-forwarded-client-cert",
      "x-http-method-override",
      "x-real-ip",
      "x-request-id",
      "x-formaspec-csrf",
      "x-formaspec-proxy-secret",
    ]).has(normalized)
    && ![
      "x-auth",
      "x-csrf",
      "x-forwarded-",
      "x-original-",
      "x-proxy-",
      "x-rewrite-",
      "x-xsrf",
    ].some((prefix) => normalized.startsWith(prefix));
}

export interface DockerComposeBindingLabels {
  project: string;
  service: BoundService;
  oneoff: "False";
  containerNumber: "1";
  configHash: string;
  imageId: string;
  workingDirectory: string;
  configFile: string;
  composeVersion: string;
}

export interface DockerRuntimeBinding {
  format: typeof BINDING_FORMAT;
  version: typeof BINDING_VERSION;
  capturedAt: string;
  context: string;
  daemonId: string;
  composeProject: string;
  imageId: string;
  containers: {
    designer: string;
    renderer: string;
  };
  labels: {
    designer: DockerComposeBindingLabels & { service: "designer" };
    renderer: DockerComposeBindingLabels & { service: "renderer" };
  };
  volumes: {
    data: string;
    backups: string;
    rendererSocket: string;
  };
  renderer: {
    networkMode: "none";
  };
  publicBinding: {
    host: LoopbackHost;
    port: number;
    containerPort: typeof CONTAINER_PORT;
    origin: string;
  };
  runtime: {
    mode: RecordedRuntimeMode;
    serverAccess: ServerAccess;
    healthHostHeader: string;
    environmentIdentitySha256: string;
  };
}

export interface PublicDockerRuntimeBinding {
  loopback: true;
  host: LoopbackHost;
  port: number;
  containerPort: typeof CONTAINER_PORT;
  origin: string;
  rendererNetworkMode: "none";
  runtimeMode: RecordedRuntimeMode;
  serverAccess: ServerAccess;
  healthHostHeader: string;
}

export interface DockerRuntimeBindingDependencies {
  commandRunner?: CommandRunner;
  environment?: NodeJS.ProcessEnv;
  dockerExecutable?: string;
  context?: string;
  composeProject?: string;
  now?: () => Date;
}

export interface HardenedDockerRunOptions {
  containerName: string;
  command: readonly string[];
  interactive?: boolean;
  renderTimeoutMs?: number;
  renderMaxPixels?: number;
  renderIpcMaxBytes?: number;
}

interface RecordedDockerEnvironment {
  mode: RecordedRuntimeMode;
  serverAccess: ServerAccess;
  host: LoopbackHost;
  port: number;
  origin: string;
  healthHostHeader: string;
  environmentIdentitySha256: string;
}

interface RawMount {
  Type?: unknown;
  Name?: unknown;
  Destination?: unknown;
  RW?: unknown;
}

interface ContainerInspection {
  id: string;
  imageId: string;
  labels: DockerComposeBindingLabels;
  mounts: RawMount[];
  networkMode: string;
  portBindings: Record<string, unknown>;
}

interface VolumeInspection {
  name: string;
  mountpointIdentity: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has unexpected fields.`);
  }
}

function strictString(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function parseComposeProject(value: unknown, label: string): string {
  return strictString(value, composeProjectPattern, label);
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 40) throw new Error(`${label} is invalid.`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new Error(`${label} is invalid.`);
  return value;
}

function normalizedOrigin(host: LoopbackHost, port: number): string {
  return `http://${host === "::1" ? "[::1]" : host}:${port}`;
}

function parseLoopbackHost(value: unknown, label: string): LoopbackHost {
  if (value !== "127.0.0.1" && value !== "::1") throw new Error(`${label} must be an exact loopback address.`);
  return value;
}

function parsePort(value: unknown, label: string): number {
  const port = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error(`${label} is invalid.`);
  return port;
}

function parseComposeLabels(
  value: unknown,
  service: BoundService,
  projectRoot: string,
  expectedProject: string,
  _containerImageId: string,
): DockerComposeBindingLabels {
  if (!isRecord(value)) throw new Error(`Docker ${service} labels are invalid.`);
  const project = value["com.docker.compose.project"];
  const actualService = value["com.docker.compose.service"];
  const oneoff = value["com.docker.compose.oneoff"];
  const containerNumber = value["com.docker.compose.container-number"];
  const configHash = value["com.docker.compose.config-hash"];
  const imageLabel = value["com.docker.compose.image"];
  const workingDirectory = value["com.docker.compose.project.working_dir"];
  const configFile = value["com.docker.compose.project.config_files"];
  const composeVersion = value["com.docker.compose.version"];
  if (project !== expectedProject || actualService !== service || oneoff !== "False" || containerNumber !== "1") {
    throw new Error(`Docker ${service} does not have the required Compose ownership labels.`);
  }
  const expectedWorkingDirectory = path.resolve(projectRoot);
  const expectedConfigFile = path.join(expectedWorkingDirectory, "docker-compose.yml");
  const composeImageId = strictString(imageLabel, imageIdPattern, `Docker ${service} Compose image label`);
  if (typeof workingDirectory !== "string" || path.resolve(workingDirectory) !== expectedWorkingDirectory
    || typeof configFile !== "string" || configFile.includes(",") || path.resolve(configFile) !== expectedConfigFile
  ) {
    throw new Error(`Docker ${service} Compose labels do not bind to this project and image.`);
  }
  return {
    project: expectedProject,
    service,
    oneoff: "False",
    containerNumber: "1",
    configHash: strictString(configHash, configHashPattern, `Docker ${service} Compose config hash`),
    imageId: composeImageId,
    workingDirectory: expectedWorkingDirectory,
    configFile: expectedConfigFile,
    composeVersion: strictString(composeVersion, composeVersionPattern, `Docker ${service} Compose version`),
  };
}

function parsePersistedLabels(value: unknown, service: BoundService, expectedProject: string): DockerComposeBindingLabels {
  if (!isRecord(value)) throw new Error(`Persisted Docker ${service} labels are invalid.`);
  assertExactKeys(value, [
    "project", "service", "oneoff", "containerNumber", "configHash", "imageId",
    "workingDirectory", "configFile", "composeVersion",
  ], `Persisted Docker ${service} labels`);
  if (value.project !== expectedProject || value.service !== service || value.oneoff !== "False"
    || value.containerNumber !== "1") {
    throw new Error(`Persisted Docker ${service} labels are invalid.`);
  }
  const workingDirectory = typeof value.workingDirectory === "string" && value.workingDirectory.length <= 4096
    && path.isAbsolute(value.workingDirectory) && !value.workingDirectory.includes("\0")
    ? path.resolve(value.workingDirectory)
    : undefined;
  const configFile = typeof value.configFile === "string" && value.configFile.length <= 4096
    && path.isAbsolute(value.configFile) && !value.configFile.includes("\0")
    ? path.resolve(value.configFile)
    : undefined;
  if (!workingDirectory || !configFile || configFile !== path.join(workingDirectory, "docker-compose.yml")) {
    throw new Error(`Persisted Docker ${service} project labels are invalid.`);
  }
  return {
    project: expectedProject,
    service,
    oneoff: "False",
    containerNumber: "1",
    configHash: strictString(value.configHash, configHashPattern, `Persisted Docker ${service} config hash`),
    imageId: strictString(value.imageId, imageIdPattern, `Persisted Docker ${service} image label`),
    workingDirectory,
    configFile,
    composeVersion: strictString(value.composeVersion, composeVersionPattern, `Persisted Docker ${service} Compose version`),
  };
}

function parseHealthHostHeader(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512
    || value !== value.trim().toLowerCase() || /[\s/@\\]/.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(`http://${value}`);
  } catch {
    throw new Error(`${label} is invalid.`);
  }
  if (!parsed.hostname || parsed.username || parsed.password || parsed.pathname !== "/"
    || parsed.search || parsed.hash || parsed.host.toLowerCase() !== value) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function runtimeBinding(value: unknown): DockerRuntimeBinding["runtime"] {
  if (!isRecord(value)) throw new Error("Persisted Docker runtime mode is invalid.");
  assertExactKeys(
    value,
    ["mode", "serverAccess", "healthHostHeader", "environmentIdentitySha256"],
    "Persisted Docker runtime mode",
  );
  const mode = value.mode;
  const serverAccess = value.serverAccess;
  if (mode !== "docker" && mode !== "server") throw new Error("Persisted Docker runtime mode is invalid.");
  if (serverAccess !== "none" && serverAccess !== "ssh" && serverAccess !== "proxy") {
    throw new Error("Persisted Docker server access mode is invalid.");
  }
  if ((mode === "docker" && serverAccess !== "none") || (mode === "server" && serverAccess === "none")) {
    throw new Error("Persisted Docker runtime and server access modes are inconsistent.");
  }
  return {
    mode,
    serverAccess,
    healthHostHeader: parseHealthHostHeader(value.healthHostHeader, "Persisted Docker health Host header"),
    environmentIdentitySha256: strictString(
      value.environmentIdentitySha256,
      sha256Pattern,
      "Persisted Docker environment SHA-256",
    ),
  };
}

function parseBinding(
  value: unknown,
  legacyRuntime?: DockerRuntimeBinding["runtime"],
): DockerRuntimeBinding {
  if (!isRecord(value)) throw new Error("Persisted Docker runtime binding is invalid.");
  const version = value.version;
  const legacy = version === LEGACY_BINDING_VERSION;
  assertExactKeys(value, [
    "format", "version", "capturedAt", "context", "daemonId", "composeProject", "imageId",
    "containers", "labels", "volumes", "renderer", "publicBinding", ...(legacy ? [] : ["runtime"]),
  ], "Persisted Docker runtime binding");
  if (value.format !== BINDING_FORMAT
    || (version !== LEGACY_BINDING_VERSION && version !== BINDING_VERSION)) {
    throw new Error("Persisted Docker runtime binding format is unsupported.");
  }
  const composeProject = parseComposeProject(value.composeProject, "Persisted Docker Compose project");
  if (legacy && composeProject !== DEFAULT_DOCKER_COMPOSE_PROJECT) {
    throw new Error("Legacy Docker runtime binding has an unsupported Compose project.");
  }
  if (legacy && legacyRuntime === undefined) {
    throw new Error("Legacy Docker runtime binding requires its recorded runtime environment.");
  }
  if (!isRecord(value.containers) || !isRecord(value.labels) || !isRecord(value.volumes)
    || !isRecord(value.renderer) || !isRecord(value.publicBinding)) {
    throw new Error("Persisted Docker runtime binding is incomplete.");
  }
  assertExactKeys(value.containers, ["designer", "renderer"], "Persisted Docker containers");
  assertExactKeys(value.labels, ["designer", "renderer"], "Persisted Docker labels");
  assertExactKeys(value.volumes, ["data", "backups", "rendererSocket"], "Persisted Docker volumes");
  assertExactKeys(value.renderer, ["networkMode"], "Persisted Docker renderer state");
  assertExactKeys(value.publicBinding, ["host", "port", "containerPort", "origin"], "Persisted Docker public binding");

  const host = parseLoopbackHost(value.publicBinding.host, "Persisted Docker public host");
  const port = parsePort(value.publicBinding.port, "Persisted Docker public port");
  if (value.publicBinding.containerPort !== CONTAINER_PORT
    || value.publicBinding.origin !== normalizedOrigin(host, port)) {
    throw new Error("Persisted Docker public binding is inconsistent.");
  }
  if (value.renderer.networkMode !== "none") throw new Error("Persisted Docker renderer network mode is unsafe.");
  const containers = {
    designer: strictString(value.containers.designer, containerIdPattern, "Persisted designer container ID"),
    renderer: strictString(value.containers.renderer, containerIdPattern, "Persisted renderer container ID"),
  };
  if (containers.designer === containers.renderer) throw new Error("Persisted Docker container IDs must be distinct.");
  const imageId = strictString(value.imageId, imageIdPattern, "Persisted Docker image ID");
  const volumes = {
    data: strictString(value.volumes.data, volumeNamePattern, "Persisted data volume"),
    backups: strictString(value.volumes.backups, volumeNamePattern, "Persisted backup volume"),
    rendererSocket: strictString(value.volumes.rendererSocket, volumeNamePattern, "Persisted renderer socket volume"),
  };
  if (new Set(Object.values(volumes)).size !== 3) throw new Error("Persisted Docker volumes must be distinct.");
  const designerLabels = parsePersistedLabels(value.labels.designer, "designer", composeProject) as DockerRuntimeBinding["labels"]["designer"];
  const rendererLabels = parsePersistedLabels(value.labels.renderer, "renderer", composeProject) as DockerRuntimeBinding["labels"]["renderer"];
  if (designerLabels.imageId !== rendererLabels.imageId) {
    throw new Error("Persisted Docker Compose image labels do not match each other.");
  }
  const runtime = legacy ? legacyRuntime! : runtimeBinding(value.runtime);
  if ((runtime.mode === "docker" || runtime.serverAccess === "ssh")
    && runtime.healthHostHeader !== new URL(normalizedOrigin(host, port)).host) {
    throw new Error("Persisted local Docker health Host header is inconsistent.");
  }
  return {
    format: BINDING_FORMAT,
    version: BINDING_VERSION,
    capturedAt: canonicalTimestamp(value.capturedAt, "Docker runtime capture timestamp"),
    context: strictString(value.context, contextPattern, "Persisted Docker context"),
    daemonId: strictString(value.daemonId, daemonIdPattern, "Persisted Docker daemon ID"),
    composeProject,
    imageId,
    containers,
    labels: { designer: designerLabels, renderer: rendererLabels },
    volumes,
    renderer: { networkMode: "none" },
    publicBinding: { host, port, containerPort: CONTAINER_PORT, origin: normalizedOrigin(host, port) },
    runtime,
  };
}

function assertBindingProjectRoot(binding: DockerRuntimeBinding, projectRoot: string): void {
  const root = path.resolve(projectRoot);
  for (const labels of [binding.labels.designer, binding.labels.renderer]) {
    if (labels.workingDirectory !== root || labels.configFile !== path.join(root, "docker-compose.yml")) {
      throw new Error("Docker runtime binding does not belong to this FormaSpec project root and image.");
    }
  }
  if (binding.labels.designer.imageId !== binding.labels.renderer.imageId) {
    throw new Error("Docker runtime binding does not belong to one Compose image reference.");
  }
}

function ensureRealDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Docker runtime state directory is unsafe: ${directory}`);
}

function assertRealDirectory(directory: string, label: string): void {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory.`);
}

function assertRuntimeDirectory(projectRoot: string): string {
  const root = path.resolve(projectRoot);
  assertRealDirectory(root, "FormaSpec project root");
  assertRealDirectory(path.join(root, ".designer"), "FormaSpec runtime directory");
  const runDirectory = path.join(root, ".designer", "run");
  assertRealDirectory(runDirectory, "FormaSpec runtime state directory");
  return runDirectory;
}

function ensureRuntimeDirectory(projectRoot: string): string {
  const root = path.resolve(projectRoot);
  const projectStat = fs.lstatSync(root);
  if (!projectStat.isDirectory() || projectStat.isSymbolicLink()) throw new Error("FormaSpec project root must be a real directory.");
  const designerDirectory = path.join(root, ".designer");
  ensureRealDirectory(designerDirectory);
  const runDirectory = path.join(designerDirectory, "run");
  ensureRealDirectory(runDirectory);
  return runDirectory;
}

function syncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const descriptor = fs.openSync(directory, "r");
  try {
    try {
      fs.fsyncSync(descriptor);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EINVAL" && code !== "ENOTSUP") throw error;
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function readSmallRegularFile(filename: string, maxBytes: number, label: string): string {
  const entry = fs.lstatSync(filename);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size < 1 || entry.size > maxBytes) {
    throw new Error(`${label} must be a bounded regular file.`);
  }
  const descriptor = fs.openSync(
    filename,
    process.platform === "win32" ? fs.constants.O_RDONLY : fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes) throw new Error(`${label} changed while it was read.`);
    const buffer = Buffer.alloc(stat.size + 1);
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytesRead !== stat.size) throw new Error(`${label} changed while it was read.`);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

function parseEnvironmentFile(contents: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error("Recorded Docker environment contains an invalid line.");
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(key) || result.has(key) || value.includes("\0")) {
      throw new Error("Recorded Docker environment is ambiguous or invalid.");
    }
    result.set(key, value);
  }
  return result;
}

function isSensitiveEnvironmentKey(key: string): boolean {
  return /(^|_)(?:TOKEN|SECRET|PASSWORD|PASSCODE|API_KEY|PRIVATE_KEY|CREDENTIALS?)(?:_|$)/i.test(key);
}

function environmentIdentitySha256(values: Map<string, string>, stat: fs.Stats): string {
  const entries = [...values.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key, isSensitiveEnvironmentKey(key) ? "[redacted]" : value]);
  return createHash("sha256").update(JSON.stringify({
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    modifiedMs: stat.mtimeMs,
    entries,
  })).digest("hex");
}

function readRecordedDockerEnvironment(projectRoot: string): RecordedDockerEnvironment {
  const root = path.resolve(projectRoot);
  const runDirectory = assertRuntimeDirectory(root);
  assertRealDirectory(path.join(root, ".designer", "env"), "FormaSpec runtime environment directory");
  const modeValue = readSmallRegularFile(path.join(runDirectory, "mode"), 64, "Recorded Docker mode").trim();
  if (modeValue !== "docker" && modeValue !== "server") {
    throw new Error("Docker runtime binding requires a recorded Docker or server mode.");
  }
  const mode: RecordedRuntimeMode = modeValue;
  const expectedEnvironment = path.join(root, ".designer", "env", mode === "server" ? "server.env" : "docker.env");
  const recordedEnvironment = readSmallRegularFile(
    path.join(runDirectory, "env-file"),
    4096,
    "Recorded Docker environment path",
  ).trim();
  if (path.resolve(recordedEnvironment) !== expectedEnvironment) {
    throw new Error("Recorded Docker environment path does not match the managed runtime mode.");
  }
  const environmentStat = fs.lstatSync(expectedEnvironment);
  if (!environmentStat.isFile() || environmentStat.isSymbolicLink()
    || environmentStat.size < 1 || environmentStat.size > 16 * 1024) {
    throw new Error("Managed Docker environment must be a bounded regular file.");
  }
  if (process.platform !== "win32" && (environmentStat.mode & 0o777) !== 0o600) {
    throw new Error("Managed Docker environment permissions must be exactly 0600.");
  }
  const contents = readSmallRegularFile(expectedEnvironment, 16 * 1024, "Managed Docker environment");
  const values = parseEnvironmentFile(contents);
  const host = parseLoopbackHost(values.get("BIND_ADDRESS"), "Managed Docker bind address");
  const port = parsePort(values.get("PORT"), "Managed Docker port");
  const origin = normalizedOrigin(host, port);
  const recordedUrl = readSmallRegularFile(path.join(runDirectory, "url"), 2048, "Recorded Docker URL").trim();
  const environmentIdentity = environmentIdentitySha256(values, environmentStat);

  if (mode === "docker") {
    if (values.get("APP_MODE") !== "local" || values.get("FORMASPEC_CONTAINER_LOCAL") !== "true"
      || values.get("AUTH_MODE") !== "none" || (values.get("DESIGNER_TOKEN") ?? "") !== ""
      || (values.get("FORMASPEC_PROXY_SECRET") ?? "") !== "") {
      throw new Error("Managed Docker environment is not an unauthenticated loopback-local configuration.");
    }
    if (values.get("PUBLIC_BASE_URL") !== origin) {
      throw new Error("Managed Docker public URL does not match its loopback binding.");
    }
    if (recordedUrl !== origin) throw new Error("Recorded Docker URL does not match the managed local environment.");
    return {
      mode,
      serverAccess: "none",
      host,
      port,
      origin,
      healthHostHeader: new URL(origin).host,
      environmentIdentitySha256: environmentIdentity,
    };
  }

  const serverAccess = values.get("DESIGNER_SERVER_ACCESS");
  if (serverAccess !== "ssh" && serverAccess !== "proxy") {
    throw new Error("Managed server environment has an invalid access mode.");
  }
  const trustedHeader = values.get("TRUSTED_USER_HEADER");
  if (typeof trustedHeader !== "string"
    || !isSafeTrustedIdentityHeader(trustedHeader, values.get("FORMASPEC_CSRF_HEADER"))) {
    throw new Error("Managed server environment has an invalid trusted identity header.");
  }
  if (serverAccess === "ssh") {
    if (values.get("APP_MODE") !== "local" || values.get("FORMASPEC_CONTAINER_LOCAL") !== "true"
      || values.get("AUTH_MODE") !== "none" || (values.get("DESIGNER_TOKEN") ?? "") !== ""
      || (values.get("FORMASPEC_PROXY_SECRET") ?? "") !== ""
      || values.get("PUBLIC_BASE_URL") !== origin || recordedUrl !== origin) {
      throw new Error("Managed SSH-only server environment is not a loopback-local configuration.");
    }
    return {
      mode,
      serverAccess,
      host,
      port,
      origin,
      healthHostHeader: new URL(origin).host,
      environmentIdentitySha256: environmentIdentity,
    };
  }

  const bearerToken = values.get("DESIGNER_TOKEN") ?? "";
  const proxySecret = values.get("FORMASPEC_PROXY_SECRET") ?? "";
  const authMode = values.get("AUTH_MODE");
  const bootstrapTokenHash = values.get("FORMASPEC_BOOTSTRAP_TOKEN_HASH") ?? "";
  const trustedHeaderCredentialsValid = authMode === "trusted-header"
    && bearerTokenPattern.test(bearerToken)
    && bootstrapTokenHash === "";
  const sessionCredentialsValid = authMode === "session"
    && (bearerToken === "" || bearerTokenPattern.test(bearerToken))
    && (bootstrapTokenHash === "" || sha256Pattern.test(bootstrapTokenHash));
  if (values.get("APP_MODE") !== "server" || values.get("FORMASPEC_CONTAINER_LOCAL") !== "false"
    || (!trustedHeaderCredentialsValid && !sessionCredentialsValid)
    || !proxySecretPattern.test(proxySecret)
    || (bearerToken !== "" && proxySecret === bearerToken)) {
    throw new Error("Managed authenticated-proxy server environment is incomplete or unsafe.");
  }
  const publicBaseUrl = values.get("PUBLIC_BASE_URL");
  let publicUrl: URL;
  try {
    if (!publicBaseUrl) throw new Error("missing");
    publicUrl = new URL(publicBaseUrl);
  } catch {
    throw new Error("Managed trusted-proxy server public URL is invalid.");
  }
  if (publicUrl.protocol !== "https:" || publicUrl.username || publicUrl.password
    || (publicUrl.pathname !== "/" && publicUrl.pathname !== "") || publicUrl.search || publicUrl.hash
    || (publicBaseUrl !== publicUrl.origin && publicBaseUrl !== `${publicUrl.origin}/`)) {
    throw new Error("Managed trusted-proxy server public URL must be an exact HTTPS origin.");
  }
  const healthHostHeader = parseHealthHostHeader(publicUrl.host.toLowerCase(), "Managed server health Host header");
  const allowedHosts = values.get("FORMASPEC_ALLOWED_HOSTS");
  const normalizedAllowedHosts = allowedHosts?.trim().toLowerCase();
  if (normalizedAllowedHosts !== undefined
    && normalizedAllowedHosts !== healthHostHeader
    && normalizedAllowedHosts !== `${healthHostHeader}/`) {
    throw new Error("Managed server Host allowlist does not match its public HTTPS origin.");
  }
  const corsOrigins = values.get("DESIGNER_CORS_ORIGINS");
  if (corsOrigins !== undefined && corsOrigins !== publicBaseUrl) {
    throw new Error("Managed server CORS origin does not match its public HTTPS origin.");
  }
  if (recordedUrl !== publicBaseUrl) {
    throw new Error("Recorded server URL does not match the managed trusted-proxy environment.");
  }
  return {
    mode,
    serverAccess,
    host,
    port,
    origin,
    healthHostHeader,
    environmentIdentitySha256: environmentIdentity,
  };
}

export function sanitizedDockerProcessEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...environment };
  for (const key of [
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
    "DOCKER_API_VERSION",
    "COMPOSE_PROJECT_NAME",
    "COMPOSE_FILE",
    "COMPOSE_PROFILES",
  ]) delete result[key];
  for (const key of Object.keys(result)) {
    if (isSensitiveEnvironmentKey(key)) {
      delete result[key];
    }
  }
  return result;
}

function executableFor(dependencies: DockerRuntimeBindingDependencies): string {
  const environment = dependencies.environment ?? process.env;
  const executable = dependencies.dockerExecutable ?? findExecutable("docker", environment);
  if (!executable || !path.isAbsolute(executable)) throw new Error("Docker is not available through an absolute executable path.");
  return executable;
}

async function runDocker(
  runner: CommandRunner,
  executable: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
  label: string,
): Promise<string> {
  const result = await runner(executable, arguments_, { env: environment, timeoutMs: 30_000 });
  if (result.exitCode !== 0) throw new Error(`${label} failed.`);
  if (Buffer.byteLength(result.stdout) > MAX_DOCKER_OUTPUT_BYTES) throw new Error(`${label} returned excessive output.`);
  return result.stdout.trim();
}

async function resolveContext(
  runner: CommandRunner,
  executable: string,
  dependencies: DockerRuntimeBindingDependencies,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const requestedEnvironment = dependencies.environment ?? process.env;
  if (dependencies.context !== undefined) return strictString(dependencies.context, contextPattern, "Docker context");
  const requested = requestedEnvironment.DOCKER_CONTEXT;
  if (requested) return strictString(requested, contextPattern, "Docker context");
  if (requestedEnvironment.DOCKER_HOST) {
    throw new Error("DOCKER_HOST is not a stable runtime identity; configure and select a named Docker context.");
  }
  return strictString(
    await runDocker(runner, executable, ["context", "show"], environment, "Docker context discovery"),
    contextPattern,
    "Docker context",
  );
}

async function daemonId(
  runner: CommandRunner,
  executable: string,
  context: string,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const output = await runDocker(
    runner,
    executable,
    ["--context", context, "info", "--format", "{{json .ID}}"],
    environment,
    "Docker daemon inspection",
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(output) as unknown;
  } catch {
    throw new Error("Docker daemon inspection returned invalid JSON.");
  }
  return strictString(parsed, daemonIdPattern, "Docker daemon ID");
}

async function findServiceContainer(
  runner: CommandRunner,
  executable: string,
  context: string,
  composeProject: string,
  service: BoundService,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const output = await runDocker(runner, executable, [
    "--context", context, "ps", "-aq", "--no-trunc",
    "--filter", `label=com.docker.compose.project=${composeProject}`,
    "--filter", `label=com.docker.compose.service=${service}`,
  ], environment, `Docker ${service} container discovery`);
  const ids = output.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  if (ids.length !== 1) throw new Error(`Expected exactly one Docker ${service} container for ${composeProject}.`);
  return strictString(ids[0], containerIdPattern, `Docker ${service} container ID`);
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
}

function canonicalVolumeMountpoint(value: unknown, label: string): string {
  if (typeof value !== "string" || Buffer.byteLength(value) < 2
    || Buffer.byteLength(value) > MAX_VOLUME_MOUNTPOINT_BYTES || /[\0\r\n]/.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  if (path.posix.isAbsolute(value)) {
    const normalized = path.posix.normalize(value);
    if (normalized !== value || normalized === "/") throw new Error(`${label} is invalid.`);
    return `posix:${normalized}`;
  }
  if (path.win32.isAbsolute(value)) {
    const normalized = path.win32.normalize(value);
    if (normalized !== value || /^[A-Za-z]:\\$/.test(normalized) || normalized === "\\\\") {
      throw new Error(`${label} is invalid.`);
    }
    return `win32:${normalized.toLowerCase()}`;
  }
  throw new Error(`${label} must be an absolute path.`);
}

async function inspectVolume(
  runner: CommandRunner,
  executable: string,
  context: string,
  expectedName: string,
  environment: NodeJS.ProcessEnv,
): Promise<VolumeInspection> {
  const output = await runDocker(runner, executable, [
    "--context", context, "volume", "inspect", "--format", "{{json .}}", expectedName,
  ], environment, `Docker volume ${expectedName} inspection`);
  const value = parseJson(output, `Docker volume ${expectedName} inspection`);
  if (!isRecord(value) || value.Name !== expectedName) {
    throw new Error(`Docker volume ${expectedName} inspection changed identity.`);
  }
  if (value.Driver !== "local" || value.Scope !== "local") {
    throw new Error(`Docker volume ${expectedName} must use the local driver and local scope.`);
  }
  if (value.Options !== null && (!isRecord(value.Options) || Object.keys(value.Options).length !== 0)) {
    throw new Error(`Docker volume ${expectedName} must not use driver options.`);
  }
  return {
    name: expectedName,
    mountpointIdentity: canonicalVolumeMountpoint(
      value.Mountpoint,
      `Docker volume ${expectedName} mountpoint`,
    ),
  };
}

async function inspectContainer(
  runner: CommandRunner,
  executable: string,
  context: string,
  expectedId: string,
  service: BoundService,
  projectRoot: string,
  composeProject: string,
  environment: NodeJS.ProcessEnv,
): Promise<ContainerInspection> {
  const output = await runDocker(runner, executable, [
    "--context", context, "inspect", "--type", "container", "--format", INSPECT_FORMAT, expectedId,
  ], environment, `Docker ${service} container inspection`);
  const lines = output.split(/\r?\n/);
  if (lines.length !== 6) throw new Error(`Docker ${service} inspection returned an unexpected shape.`);
  const id = strictString(parseJson(lines[0]!, `Docker ${service} ID`), containerIdPattern, `Docker ${service} ID`);
  if (id !== expectedId) throw new Error(`Docker ${service} inspection changed identity.`);
  const imageId = strictString(parseJson(lines[1]!, `Docker ${service} image`), imageIdPattern, `Docker ${service} image ID`);
  const labels = parseComposeLabels(
    parseJson(lines[2]!, `Docker ${service} labels`),
    service,
    projectRoot,
    composeProject,
    imageId,
  );
  const mountsValue = parseJson(lines[3]!, `Docker ${service} mounts`);
  if (!Array.isArray(mountsValue) || mountsValue.some((mount) => !isRecord(mount))) {
    throw new Error(`Docker ${service} mounts are invalid.`);
  }
  const networkModeValue = parseJson(lines[4]!, `Docker ${service} network mode`);
  if (typeof networkModeValue !== "string" || networkModeValue.length > 64) {
    throw new Error(`Docker ${service} network mode is invalid.`);
  }
  const portBindingsValue = parseJson(lines[5]!, `Docker ${service} port bindings`);
  const portBindings = portBindingsValue === null ? {} : portBindingsValue;
  if (!isRecord(portBindings)) throw new Error(`Docker ${service} port bindings are invalid.`);
  return {
    id,
    imageId,
    labels,
    mounts: mountsValue as RawMount[],
    networkMode: networkModeValue,
    portBindings,
  };
}

function exactNamedVolume(
  inspection: ContainerInspection,
  destination: string,
  service: BoundService,
): string {
  const matching = inspection.mounts.filter((mount) => mount.Destination === destination);
  if (matching.length !== 1) throw new Error(`Docker ${service} must have exactly one ${destination} mount.`);
  const mount = matching[0]!;
  if (mount.Type !== "volume" || mount.RW !== true) {
    throw new Error(`Docker ${service} ${destination} mount must be a writable named volume.`);
  }
  return strictString(mount.Name, volumeNamePattern, `Docker ${service} ${destination} volume`);
}

function requireExactMountDestinations(
  inspection: ContainerInspection,
  expected: readonly string[],
  service: BoundService,
): void {
  const actual = inspection.mounts.map((mount) => mount.Destination);
  if (actual.some((destination) => typeof destination !== "string")
    || actual.length !== expected.length
    || [...actual as string[]].sort().some((destination, index) => destination !== [...expected].sort()[index])) {
    throw new Error(`Docker ${service} has unexpected persistent mounts.`);
  }
}

function requireRendererMountDestinations(inspection: ContainerInspection): void {
  const destinations = inspection.mounts.map((mount) => mount.Destination);
  if (destinations.length !== 1
    || destinations[0] !== "/run/formaspec"
    || inspection.mounts[0]?.Type !== "volume"
    || inspection.mounts[0]?.RW !== true) {
    throw new Error("Docker renderer has unexpected persistent mounts.");
  }
}

function verifyDesignerPortBinding(
  inspection: ContainerInspection,
  recorded: RecordedDockerEnvironment,
): void {
  const active = Object.entries(inspection.portBindings).filter(([, bindings]) => Array.isArray(bindings) && bindings.length > 0);
  if (active.length !== 1 || active[0]![0] !== `${CONTAINER_PORT}/tcp`) {
    throw new Error("Docker designer must publish only the FormaSpec API port.");
  }
  const bindings = active[0]![1] as unknown[];
  if (bindings.length !== 1 || !isRecord(bindings[0])) throw new Error("Docker designer API port binding is ambiguous.");
  const binding = bindings[0];
  if (binding.HostIp !== recorded.host || parsePort(binding.HostPort, "Docker designer published port") !== recorded.port) {
    throw new Error("Docker designer published port does not match the recorded loopback environment.");
  }
}

async function captureWithContext(
  projectRoot: string,
  context: string,
  composeProject: string,
  dependencies: DockerRuntimeBindingDependencies,
): Promise<DockerRuntimeBinding> {
  const environment = sanitizedDockerProcessEnvironment(dependencies.environment ?? process.env);
  const runner = dependencies.commandRunner ?? runCommand;
  const executable = executableFor(dependencies);
  const recorded = readRecordedDockerEnvironment(projectRoot);
  const currentDaemonId = await daemonId(runner, executable, context, environment);
  const designerId = await findServiceContainer(runner, executable, context, composeProject, "designer", environment);
  const rendererId = await findServiceContainer(runner, executable, context, composeProject, "renderer", environment);
  const [designer, renderer] = await Promise.all([
    inspectContainer(runner, executable, context, designerId, "designer", projectRoot, composeProject, environment),
    inspectContainer(runner, executable, context, rendererId, "renderer", projectRoot, composeProject, environment),
  ]);
  if (designer.imageId !== renderer.imageId) throw new Error("Docker designer and renderer must use the exact same image ID.");
  if (designer.labels.imageId !== renderer.labels.imageId) {
    throw new Error("Docker designer and renderer must use the same Compose image reference.");
  }
  if (renderer.networkMode !== "none") throw new Error("Docker renderer must use network mode none.");
  requireExactMountDestinations(designer, ["/data", "/backups", "/run/formaspec"], "designer");
  requireRendererMountDestinations(renderer);
  const data = exactNamedVolume(designer, "/data", "designer");
  const backups = exactNamedVolume(designer, "/backups", "designer");
  const designerSocket = exactNamedVolume(designer, "/run/formaspec", "designer");
  const rendererSocket = exactNamedVolume(renderer, "/run/formaspec", "renderer");
  if (designerSocket !== rendererSocket) throw new Error("Docker designer and renderer do not share the same renderer socket volume.");
  if (new Set([data, backups, rendererSocket]).size !== 3) throw new Error("Docker runtime volumes must be distinct.");
  const inspectedVolumes = await Promise.all([data, backups, rendererSocket].map((volume) => (
    inspectVolume(runner, executable, context, volume, environment)
  )));
  if (new Set(inspectedVolumes.map((volume) => volume.mountpointIdentity)).size !== inspectedVolumes.length) {
    throw new Error("Docker runtime volume backing mountpoints must be distinct.");
  }
  verifyDesignerPortBinding(designer, recorded);
  return parseBinding({
    format: BINDING_FORMAT,
    version: BINDING_VERSION,
    capturedAt: (dependencies.now?.() ?? new Date()).toISOString(),
    context,
    daemonId: currentDaemonId,
    composeProject,
    imageId: designer.imageId,
    containers: { designer: designer.id, renderer: renderer.id },
    labels: { designer: designer.labels, renderer: renderer.labels },
    volumes: { data, backups, rendererSocket },
    renderer: { networkMode: "none" },
    publicBinding: {
      host: recorded.host,
      port: recorded.port,
      containerPort: CONTAINER_PORT,
      origin: recorded.origin,
    },
    runtime: {
      mode: recorded.mode,
      serverAccess: recorded.serverAccess,
      healthHostHeader: recorded.healthHostHeader,
      environmentIdentitySha256: recorded.environmentIdentitySha256,
    },
  });
}

function comparableBinding(binding: DockerRuntimeBinding): string {
  return JSON.stringify({ ...binding, capturedAt: "" });
}

function assertPositiveInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) throw new Error(`${label} is invalid.`);
  return candidate;
}

export function dockerRuntimeBindingPath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), ".designer", "run", BINDING_FILENAME);
}

export async function captureDockerRuntimeBinding(
  projectRoot: string,
  dependencies: DockerRuntimeBindingDependencies = {},
): Promise<DockerRuntimeBinding> {
  const environment = sanitizedDockerProcessEnvironment(dependencies.environment ?? process.env);
  const runner = dependencies.commandRunner ?? runCommand;
  const executable = executableFor(dependencies);
  const context = await resolveContext(runner, executable, dependencies, environment);
  const composeProject = parseComposeProject(
    dependencies.composeProject ?? DEFAULT_DOCKER_COMPOSE_PROJECT,
    "Docker Compose project",
  );
  return captureWithContext(projectRoot, context, composeProject, dependencies);
}

export function persistDockerRuntimeBinding(projectRoot: string, binding: DockerRuntimeBinding): string {
  const validated = parseBinding(binding);
  assertBindingProjectRoot(validated, projectRoot);
  const runDirectory = ensureRuntimeDirectory(projectRoot);
  const destination = path.join(runDirectory, BINDING_FILENAME);
  const serialized = `${JSON.stringify(validated)}\n`;
  if (Buffer.byteLength(serialized) > MAX_BINDING_BYTES) throw new Error("Docker runtime binding exceeds its fixed size limit.");
  const temporary = path.join(runDirectory, `.${BINDING_FILENAME}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, serialized, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, destination);
    fs.chmodSync(destination, 0o600);
    syncDirectory(runDirectory);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
  return destination;
}

export function readDockerRuntimeBinding(projectRoot: string): DockerRuntimeBinding {
  assertRuntimeDirectory(projectRoot);
  const filename = dockerRuntimeBindingPath(projectRoot);
  const entry = fs.lstatSync(filename);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size < 1 || entry.size > MAX_BINDING_BYTES) {
    throw new Error("Persisted Docker runtime binding is not a bounded regular file.");
  }
  if (process.platform !== "win32" && (entry.mode & 0o777) !== 0o600) {
    throw new Error("Persisted Docker runtime binding permissions must be exactly 0600.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readSmallRegularFile(filename, MAX_BINDING_BYTES, "Persisted Docker runtime binding")) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Persisted Docker runtime binding is malformed.");
    throw error;
  }
  const legacyRuntime = isRecord(parsed) && parsed.version === LEGACY_BINDING_VERSION
    ? (() => {
      const recorded = readRecordedDockerEnvironment(projectRoot);
      return {
        mode: recorded.mode,
        serverAccess: recorded.serverAccess,
        healthHostHeader: recorded.healthHostHeader,
        environmentIdentitySha256: recorded.environmentIdentitySha256,
      } satisfies DockerRuntimeBinding["runtime"];
    })()
    : undefined;
  const binding = parseBinding(parsed, legacyRuntime);
  assertBindingProjectRoot(binding, projectRoot);
  return binding;
}

export async function verifyDockerRuntimeBinding(
  projectRoot: string,
  dependencies: DockerRuntimeBindingDependencies = {},
): Promise<DockerRuntimeBinding> {
  const persisted = readDockerRuntimeBinding(projectRoot);
  if (dependencies.context !== undefined && dependencies.context !== persisted.context) {
    throw new Error("Requested Docker context does not match the persisted runtime binding.");
  }
  if (dependencies.composeProject !== undefined
    && parseComposeProject(dependencies.composeProject, "Requested Docker Compose project") !== persisted.composeProject) {
    throw new Error("Requested Docker Compose project does not match the persisted runtime binding.");
  }
  const current = await captureWithContext(projectRoot, persisted.context, persisted.composeProject, {
    ...dependencies,
    context: persisted.context,
    now: () => new Date(persisted.capturedAt),
  });
  if (comparableBinding(current) !== comparableBinding(persisted)) {
    throw new Error("Docker runtime identity drifted; refusing to target its data volumes.");
  }
  return persisted;
}

export function sanitizedPublicDockerBinding(binding: DockerRuntimeBinding): PublicDockerRuntimeBinding {
  const validated = parseBinding(binding);
  return {
    loopback: true,
    host: validated.publicBinding.host,
    port: validated.publicBinding.port,
    containerPort: CONTAINER_PORT,
    origin: validated.publicBinding.origin,
    rendererNetworkMode: "none",
    runtimeMode: validated.runtime.mode,
    serverAccess: validated.runtime.serverAccess,
    healthHostHeader: validated.runtime.healthHostHeader,
  };
}

export function dockerPublicPortBinding(binding: DockerRuntimeBinding): string {
  const publicBinding = sanitizedPublicDockerBinding(binding);
  const host = publicBinding.host === "::1" ? "[::1]" : publicBinding.host;
  return `${host}:${publicBinding.port}:${publicBinding.containerPort}/tcp`;
}

export function buildHardenedDockerRunArguments(
  binding: DockerRuntimeBinding,
  options: HardenedDockerRunOptions,
): string[] {
  const validated = parseBinding(binding);
  const containerName = strictString(options.containerName, containerNamePattern, "Docker one-shot container name");
  if (options.command.length < 1 || options.command.length > 256
    || options.command.some((argument) => typeof argument !== "string" || argument.length > 8192 || argument.includes("\0"))
    || options.command.reduce((total, argument) => total + Buffer.byteLength(argument), 0) > 64 * 1024) {
    throw new Error("Docker one-shot command is invalid or too large.");
  }
  const renderTimeoutMs = assertPositiveInteger(options.renderTimeoutMs, 15_000, 1_000, 60_000, "Renderer timeout");
  const renderMaxPixels = assertPositiveInteger(options.renderMaxPixels, 32_000_000, 1, 64_000_000, "Renderer pixel limit");
  const renderIpcMaxBytes = assertPositiveInteger(
    options.renderIpcMaxBytes,
    96 * 1024 * 1024,
    1024 * 1024,
    256 * 1024 * 1024,
    "Renderer IPC limit",
  );
  return [
    "--context", validated.context,
    "run", "--rm", "--init", `--name=${containerName}`, "--pull=never",
    `--label=com.formaspec.runtime.compose-project=${validated.composeProject}`,
    `--label=com.formaspec.runtime.binding-version=${BINDING_VERSION}`,
    ...(options.interactive ? ["--interactive"] : []),
    "--network=none", "--read-only", "--user=pwuser",
    "--cap-drop=ALL", "--security-opt=no-new-privileges:true",
    "--pids-limit=256", "--memory=2g", "--cpus=2.0",
    "--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=512m,mode=1777",
    "--env=DATA_DIR=/data",
    "--env=BACKUP_DIR=/backups",
    "--env=FORMASPEC_RENDER_SOCKET=/run/formaspec/renderer.sock",
    `--env=FORMASPEC_RENDER_TIMEOUT_MS=${renderTimeoutMs}`,
    `--env=FORMASPEC_RENDER_MAX_PIXELS=${renderMaxPixels}`,
    `--env=FORMASPEC_RENDER_IPC_MAX_BYTES=${renderIpcMaxBytes}`,
    "--env=FORMASPEC_ALLOW_SYSTEM_CHROME=false",
    "--env=NODE_ENV=production",
    `--mount=type=volume,src=${validated.volumes.data},dst=/data`,
    `--mount=type=volume,src=${validated.volumes.backups},dst=/backups`,
    `--mount=type=volume,src=${validated.volumes.rendererSocket},dst=/run/formaspec`,
    validated.imageId,
    ...options.command,
  ];
}
