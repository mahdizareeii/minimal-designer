import { randomUUID } from "node:crypto";
import { once } from "node:events";
import http, { type IncomingMessage, type ServerResponse } from "node:http";

import { PairingNonceStore } from "./pairing.js";
import { MemoryCredentialStore, type CredentialStore } from "./credentials.js";

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_MCP_PROBE_RESPONSE_BYTES = 1024 * 1024;
const MAX_UPSTREAM_HEALTH_RESPONSE_BYTES = 64 * 1024;
const DATA_STORE_ID_PATTERN = /^store_[a-f0-9]{32}$/;
const CODEX_REQUESTED_EXPIRY_SECONDS = 2_592_000;
const CODEX_REQUESTED_SCOPES = [
  "organization_policy:read",
  "context:write",
  "design:read", "design:preview", "design:write",
  "product_spec:read", "product_spec:preview", "product_spec:write",
  "planning:read", "planning:write",
  "task:read", "task:create", "task:claim", "task:update",
  "design_system:read", "workspace:inventory:read", "workspace:inventory:write",
  "implementation_mapping:read", "implementation_mapping:write", "handoff:read",
  "redesign:read", "redesign:assessment", "redesign:review",
  "redesign:interview", "redesign:proposal", "redesign:design", "redesign:handoff",
] as const;
const REQUIRED_CODEX_MCP_TOOLS = [
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
const ALLOWED_REQUEST_HEADERS = [
  "accept",
  "content-type",
  "last-event-id",
  "mcp-protocol-version",
  "mcp-session-id",
] as const;
const ALLOWED_RESPONSE_HEADERS = [
  "cache-control",
  "content-type",
  "mcp-protocol-version",
  "mcp-session-id",
] as const;

export interface UpstreamCredentialProvider {
  headers(): Promise<Readonly<Record<string, string>>>;
}

export class NoUpstreamCredentials implements UpstreamCredentialProvider {
  async headers(): Promise<Readonly<Record<string, string>>> {
    return {};
  }
}

export class StoredUpstreamCredentials implements UpstreamCredentialProvider {
  constructor(readonly store: CredentialStore) {}
  async headers(): Promise<Readonly<Record<string, string>>> {
    const token = await this.store.read();
    return token ? { authorization: `Bearer ${token}` } : {};
  }
}

export interface BridgeServerOptions {
  host?: "127.0.0.1" | "::1";
  port?: number;
  upstreamMcpUrl: string;
  buildId?: string;
  credentialProvider?: UpstreamCredentialProvider;
  credentialStore?: CredentialStore;
  pairingStore?: PairingNonceStore;
  instanceId?: string;
  expectedDataStoreId?: string;
  fetchImplementation?: typeof fetch;
  allowLegacySelfCreate?: boolean;
  controlErrorReporter?: (error: unknown) => void;
}

export interface AgentPairingTicket {
  nonce: string;
  connectionId?: string;
}

export interface RunningBridge {
  readonly host: "127.0.0.1" | "::1";
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

export function validateLoopbackMcpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("MCP URL must be a valid loopback HTTP URL.");
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (url.protocol !== "http:" || (host !== "127.0.0.1" && host !== "::1" && host !== "localhost")) {
    throw new Error("MCP URL must use HTTP on loopback.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("MCP URL must not contain credentials, query parameters, or a fragment.");
  }
  if (url.pathname !== "/mcp") throw new Error("MCP URL path must be /mcp.");
  return url;
}

async function readBody(request: IncomingMessage, limit = MAX_REQUEST_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Uint8Array);
    total += buffer.length;
    if (total > limit) throw new Error("REQUEST_TOO_LARGE");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  const body = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": body.length,
    "content-type": "application/json; charset=utf-8",
  });
  response.end(body);
}

function methodAllowed(method: string | undefined): method is "GET" | "POST" | "DELETE" {
  return method === "GET" || method === "POST" || method === "DELETE";
}

function createSerialExecutor() {
  let tail: Promise<void> = Promise.resolve();
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return null;
  return value;
}

interface AutomaticCodexConnectionPolicy {
  scopes: string[];
  expiresInSeconds: number;
  projectIds: string[];
}

interface StoredGrantAuthorizationContext {
  role: "agent";
  scopes: string[];
  projectIds: string[];
}

interface McpGrantProbe {
  serverName: "formaspec";
  essentialTools: string[];
}

interface UpstreamRuntimeIdentity {
  origin: string;
  ready: boolean;
  dataStoreId: string | null;
}

class BridgeControlError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BridgeControlError";
  }
}

function validatePairingTicket(value: unknown): AgentPairingTicket {
  const ticket = recordValue(value);
  if (ticket === null
    || Object.keys(ticket).some((key) => key !== "nonce" && key !== "connectionId")
    || typeof ticket.nonce !== "string"
    || !/^fspair_[A-Za-z0-9_-]{43}$/.test(ticket.nonce)
    || (ticket.connectionId !== undefined
      && (typeof ticket.connectionId !== "string" || !/^connection_[a-f0-9]{32}$/.test(ticket.connectionId)))) {
    throw new BridgeControlError(422, "INVALID_PAIRING_TICKET", "The one-time pairing ticket is invalid.");
  }
  return {
    nonce: ticket.nonce,
    ...(typeof ticket.connectionId === "string" ? { connectionId: ticket.connectionId } : {}),
  };
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
}

async function readStoredGrantAuthorizationContext(
  apiOrigin: URL,
  token: string,
  fetchImplementation: typeof fetch,
): Promise<StoredGrantAuthorizationContext | null> {
  try {
    const response = await fetchImplementation(new URL("/api/agent-authorization-context", apiOrigin), {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const body = recordValue(await response.json());
    if (body === null
      || Object.keys(body).some((key) => key !== "role" && key !== "scopes" && key !== "projectIds")
      || body.role !== "agent") {
      return null;
    }
    const scopes = stringArray(body.scopes);
    const projectIds = stringArray(body.projectIds);
    if (scopes === null || projectIds === null) return null;
    return { role: "agent", scopes, projectIds };
  } catch {
    return null;
  }
}

async function probeMcpGrant(
  upstream: URL,
  token: string,
  fetchImplementation: typeof fetch,
): Promise<McpGrantProbe | null> {
  try {
    const call = async (
      id: string,
      method: string,
      params: Record<string, unknown>,
    ): Promise<Record<string, unknown> | null> => {
      const response = await fetchImplementation(upstream, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        redirect: "error",
        signal: AbortSignal.timeout(6_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return null;
      }
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_MCP_PROBE_RESPONSE_BYTES) {
        await response.body?.cancel();
        return null;
      }
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > MAX_MCP_PROBE_RESPONSE_BYTES) return null;
      const envelope = recordValue(JSON.parse(text));
      const result = recordValue(envelope?.result);
      return envelope?.jsonrpc === "2.0"
        && envelope.id === id
        && envelope.error === undefined
        && result !== null
        ? result
        : null;
    };
    const initialize = await call("formaspec-bridge-initialize", "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "formaspec-local-bridge", version: "0.2.0" },
    });
    const serverInfo = recordValue(initialize?.serverInfo);
    if (typeof initialize?.protocolVersion !== "string"
      || recordValue(initialize.capabilities) === null
      || serverInfo?.name !== "formaspec"
      || typeof serverInfo.version !== "string"
      || serverInfo.version.length === 0) return null;

    const toolsResult = await call("formaspec-bridge-tools", "tools/list", {});
    if (!Array.isArray(toolsResult?.tools)) return null;
    const toolNames = toolsResult.tools.map((tool) => recordValue(tool)?.name);
    if (!toolNames.every((name): name is string => typeof name === "string" && name.length > 0)) return null;
    const available = new Set(toolNames);
    if (!REQUIRED_CODEX_MCP_TOOLS.every((name) => available.has(name))) return null;
    return { serverName: "formaspec", essentialTools: [...REQUIRED_CODEX_MCP_TOOLS] };
  } catch {
    return null;
  }
}

async function probeUpstreamRuntimeIdentity(
  upstream: URL,
  fetchImplementation: typeof fetch,
): Promise<UpstreamRuntimeIdentity> {
  const unavailable = (): UpstreamRuntimeIdentity => ({
    origin: upstream.origin,
    ready: false,
    dataStoreId: null,
  });
  try {
    const response = await fetchImplementation(new URL("/health/ready", upstream.origin), {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(2_000),
    });
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_UPSTREAM_HEALTH_RESPONSE_BYTES) {
      await response.body?.cancel();
      return unavailable();
    }
    const bodyText = await response.text();
    if (Buffer.byteLength(bodyText, "utf8") > MAX_UPSTREAM_HEALTH_RESPONSE_BYTES) return unavailable();
    const body = recordValue(JSON.parse(bodyText));
    const dataStoreId = body?.dataStoreId;
    if (typeof dataStoreId !== "string" || !DATA_STORE_ID_PATTERN.test(dataStoreId)) {
      return unavailable();
    }
    return {
      origin: upstream.origin,
      ready: response.ok && body?.ok === true,
      dataStoreId,
    };
  } catch {
    return unavailable();
  }
}

function upstreamIdentityMatches(
  identity: UpstreamRuntimeIdentity,
  expectedDataStoreId: string | undefined,
): boolean {
  return identity.dataStoreId !== null
    && (expectedDataStoreId === undefined || identity.dataStoreId === expectedDataStoreId);
}

async function readAutomaticCodexConnectionPolicy(
  apiOrigin: URL,
  fetchImplementation: typeof fetch,
): Promise<AutomaticCodexConnectionPolicy> {
  const policyResponse = await fetchImplementation(new URL("/api/organization/policy", apiOrigin), {
    method: "GET",
    headers: { accept: "application/json" },
    redirect: "error",
  });
  if (!policyResponse.ok) throw new Error("FormaSpec organization policy could not be read.");
  const policyBody = recordValue(await policyResponse.json());
  const organizationPolicy = recordValue(policyBody?.organizationPolicy);
  const policy = recordValue(organizationPolicy?.policy);
  const agents = recordValue(policy?.agents);
  const allowedAdapters = stringArray(agents?.allowedAdapters);
  const allowedScopes = stringArray(agents?.allowedScopes);
  const maximumExpirySeconds = agents?.maximumExpirySeconds;
  const requireProjectRestriction = agents?.requireProjectRestriction;
  if (agents?.enabled !== true) {
    throw new Error("Codex connections are disabled by FormaSpec organization policy.");
  }
  if (allowedAdapters === null || !allowedAdapters.includes("codex")) {
    throw new Error("The Codex adapter is disabled by FormaSpec organization policy.");
  }
  if (allowedScopes === null) {
    throw new Error("FormaSpec returned an invalid organization agent-scope policy.");
  }
  const allowedScopeSet = new Set(allowedScopes);
  const scopes = CODEX_REQUESTED_SCOPES.filter((scope) => allowedScopeSet.has(scope));
  if (scopes.length === 0) {
    throw new Error("FormaSpec organization policy does not allow any Codex workflow scopes.");
  }
  if (typeof maximumExpirySeconds !== "number"
    || !Number.isSafeInteger(maximumExpirySeconds)
    || maximumExpirySeconds < 300) {
    throw new Error("FormaSpec returned an invalid maximum agent-grant lifetime.");
  }
  if (typeof requireProjectRestriction !== "boolean") {
    throw new Error("FormaSpec returned an invalid project-restriction policy.");
  }

  let projectIds: string[] = [];
  if (requireProjectRestriction) {
    const projectsResponse = await fetchImplementation(new URL("/api/designs?limit=100", apiOrigin), {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
    });
    if (!projectsResponse.ok) throw new Error("FormaSpec projects could not be read for the required agent restriction.");
    const projectsBody = recordValue(await projectsResponse.json());
    const designs = projectsBody?.designs;
    if (!Array.isArray(designs)) throw new Error("FormaSpec returned an invalid project list.");
    projectIds = [...new Set(designs.map((design) => recordValue(design)?.id).filter(
      (projectId): projectId is string => typeof projectId === "string" && projectId.length > 0,
    ))].slice(0, 100);
    if (projectIds.length === 0) {
      throw new Error("Organization policy requires a project restriction; create a project before connecting Codex.");
    }
  }

  return {
    scopes,
    expiresInSeconds: Math.max(300, Math.min(CODEX_REQUESTED_EXPIRY_SECONDS, maximumExpirySeconds)),
    projectIds,
  };
}

async function proxyMcpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  upstream: URL,
  credentialProvider: UpstreamCredentialProvider,
  fetchImplementation: typeof fetch,
  expectedDataStoreId?: string,
): Promise<void> {
  if (!methodAllowed(request.method)) {
    sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" });
    return;
  }
  const upstreamIdentity = await probeUpstreamRuntimeIdentity(upstream, fetchImplementation);
  if (!upstreamIdentity.ready) {
    sendJson(response, 503, { error: "UPSTREAM_NOT_READY" });
    return;
  }
  if (!upstreamIdentityMatches(upstreamIdentity, expectedDataStoreId)) {
    sendJson(response, 409, { error: "UPSTREAM_DATA_STORE_MISMATCH" });
    return;
  }
  const headers = new Headers();
  for (const name of ALLOWED_REQUEST_HEADERS) {
    const value = request.headers[name];
    if (typeof value === "string") headers.set(name, value);
  }
  const credentials = await credentialProvider.headers();
  for (const [name, value] of Object.entries(credentials)) {
    if (!/^[A-Za-z0-9-]+$/.test(name) || /[\r\n]/.test(value)) throw new Error("Invalid upstream credential header.");
    headers.set(name, value);
  }
  const upstreamAuthorization = headers.get("authorization");
  if (!upstreamAuthorization || !/^Bearer fsg_[A-Za-z0-9_-]+$/.test(upstreamAuthorization)) {
    sendJson(response, 401, { error: "BRIDGE_AUTH_REQUIRED" });
    return;
  }
  const body = request.method === "POST" ? await readBody(request) : undefined;
  const upstreamResponse = await fetchImplementation(upstream, {
    method: request.method,
    headers,
    ...(body === undefined ? {} : { body: new Uint8Array(body) }),
    redirect: "error",
  });
  response.statusCode = upstreamResponse.status;
  for (const name of ALLOWED_RESPONSE_HEADERS) {
    const value = upstreamResponse.headers.get(name);
    if (value !== null) response.setHeader(name, value);
  }
  response.setHeader("x-content-type-options", "nosniff");
  if (upstreamResponse.body === null) {
    response.end();
    return;
  }
  const reader = upstreamResponse.body.getReader();
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    if (!response.write(Buffer.from(chunk.value))) await once(response, "drain");
  }
  response.end();
}

async function authorizeAgentConnection(
  upstream: URL,
  credentialStore: CredentialStore,
  fetchImplementation: typeof fetch,
): Promise<Record<string, unknown>> {
  const apiOrigin = new URL(upstream.origin);
  const policy = await readAutomaticCodexConnectionPolicy(apiOrigin, fetchImplementation);
  let existingToken = await credentialStore.read();
  if (existingToken && !/^fsg_[A-Za-z0-9_-]+$/.test(existingToken)) {
    await credentialStore.clear();
    existingToken = null;
  }
  if (existingToken) {
    if (await probeMcpGrant(upstream, existingToken, fetchImplementation) !== null) {
      const authorizationContext = await readStoredGrantAuthorizationContext(
        apiOrigin,
        existingToken,
        fetchImplementation,
      );
      if (authorizationContext
        && sameStringSet(authorizationContext.scopes, policy.scopes)
        && sameStringSet(authorizationContext.projectIds, policy.projectIds)) {
        return {
          connectionId: "stored",
          status: "active",
          expiresAt: null,
          credentialStored: true,
          reused: true,
        };
      }
      await credentialStore.clear();
      existingToken = null;
    } else {
      await credentialStore.clear();
      existingToken = null;
    }
  }

  const connectionResponse = await fetchImplementation(new URL("/api/agent-connections", apiOrigin), {
    method: "POST",
    headers: { "content-type": "application/json", "x-formaspec-csrf": "1" },
    body: JSON.stringify({
      adapter: "codex",
      displayName: "Codex through the local FormaSpec bridge",
      scopes: policy.scopes,
      ...(policy.projectIds.length > 0 ? { projectIds: policy.projectIds } : {}),
      expiresInSeconds: policy.expiresInSeconds,
      replaceExisting: true,
    }),
    redirect: "error",
  });
  if (!connectionResponse.ok) throw new Error("FormaSpec rejected creation of the scoped Codex connection.");
  const challenge = await connectionResponse.json() as { connection?: { id?: unknown }; nonce?: unknown };
  if (typeof challenge.nonce !== "string" || typeof challenge.connection?.id !== "string") {
    throw new Error("FormaSpec returned an invalid pairing challenge.");
  }
  const pairResponse = await fetchImplementation(new URL("/api/agent-connections/pair", apiOrigin), {
    method: "POST",
    headers: { "content-type": "application/json", "x-formaspec-csrf": "1" },
    body: JSON.stringify({ nonce: challenge.nonce }),
    redirect: "error",
  });
  if (!pairResponse.ok) throw new Error("FormaSpec rejected the one-time Codex pairing challenge.");
  const paired = await pairResponse.json() as {
    connection?: { id?: unknown; status?: unknown; expiresAt?: unknown };
    grant?: { token?: unknown };
  };
  if (typeof paired.grant?.token !== "string"
    || !/^fsg_[A-Za-z0-9_-]+$/.test(paired.grant.token)
    || typeof paired.connection?.id !== "string") {
    throw new Error("FormaSpec returned an invalid scoped agent grant.");
  }
  if (await probeMcpGrant(upstream, paired.grant.token, fetchImplementation) === null) {
    throw new Error("The new scoped Codex grant could not initialize MCP and list its tools.");
  }
  await credentialStore.write(paired.grant.token);
  return {
    connectionId: paired.connection.id,
    status: paired.connection.status,
    expiresAt: paired.connection.expiresAt,
    credentialStored: true,
    verified: true,
  };
}

async function reuseStoredAgentConnection(
  upstream: URL,
  credentialStore: CredentialStore,
  fetchImplementation: typeof fetch,
): Promise<Record<string, unknown> | null> {
  const token = await credentialStore.read();
  if (!token || !/^fsg_[A-Za-z0-9_-]+$/.test(token)) {
    if (token) await credentialStore.clear();
    return null;
  }
  const authorizationContext = await readStoredGrantAuthorizationContext(
    new URL(upstream.origin),
    token,
    fetchImplementation,
  );
  if (authorizationContext === null || await probeMcpGrant(upstream, token, fetchImplementation) === null) {
    await credentialStore.clear();
    return null;
  }
  return {
    connectionId: "stored",
    status: "active",
    expiresAt: null,
    credentialStored: true,
    reused: true,
    verified: true,
  };
}

async function pairIssuedAgentConnection(
  upstream: URL,
  credentialStore: CredentialStore,
  fetchImplementation: typeof fetch,
  ticket: AgentPairingTicket,
): Promise<Record<string, unknown>> {
  const apiOrigin = new URL(upstream.origin);
  const pairResponse = await fetchImplementation(new URL("/api/agent-connections/pair", apiOrigin), {
    method: "POST",
    headers: { "content-type": "application/json", "x-formaspec-csrf": "1" },
    body: JSON.stringify({ nonce: ticket.nonce }),
    redirect: "error",
  });
  if (!pairResponse.ok) {
    await pairResponse.body?.cancel();
    throw new BridgeControlError(409, "PAIRING_TICKET_REJECTED", "FormaSpec rejected the one-time pairing ticket.");
  }
  const paired = await pairResponse.json() as {
    connection?: { id?: unknown; status?: unknown; expiresAt?: unknown };
    grant?: { token?: unknown; scopes?: unknown; projectIds?: unknown };
  };
  const connectionId = paired.connection?.id;
  const token = paired.grant?.token;
  const scopes = stringArray(paired.grant?.scopes);
  const projectIds = stringArray(paired.grant?.projectIds);
  if (typeof connectionId !== "string"
    || !/^connection_[a-f0-9]{32}$/.test(connectionId)
    || paired.connection?.status !== "active"
    || typeof paired.connection.expiresAt !== "string"
    || typeof token !== "string"
    || !/^fsg_[A-Za-z0-9_-]+$/.test(token)
    || scopes === null
    || projectIds === null) {
    throw new BridgeControlError(502, "INVALID_PAIRED_GRANT", "FormaSpec returned an invalid scoped agent grant.");
  }
  if (ticket.connectionId !== undefined && ticket.connectionId !== connectionId) {
    throw new BridgeControlError(409, "PAIRING_CONNECTION_MISMATCH", "The pairing ticket activated a different connection.");
  }
  const verifiedContext = await readStoredGrantAuthorizationContext(apiOrigin, token, fetchImplementation);
  if (await probeMcpGrant(upstream, token, fetchImplementation) === null
    || verifiedContext === null
    || !sameStringSet(verifiedContext.scopes, scopes)
    || !sameStringSet(verifiedContext.projectIds, projectIds)) {
    throw new BridgeControlError(502, "PAIRED_GRANT_VERIFICATION_FAILED", "The paired grant could not be verified.");
  }
  await credentialStore.write(token);
  return {
    connectionId,
    status: "active",
    expiresAt: paired.connection.expiresAt,
    credentialStored: true,
    verified: true,
  };
}

export async function startBridgeServer(options: BridgeServerOptions): Promise<RunningBridge> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4312;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new Error("Bridge port is invalid.");
  const upstream = validateLoopbackMcpUrl(options.upstreamMcpUrl);
  const buildId = options.buildId ?? "development";
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(buildId)) throw new Error("Bridge build ID is invalid.");
  const credentialStore = options.credentialStore ?? new MemoryCredentialStore();
  const credentialProvider = options.credentialProvider ?? new StoredUpstreamCredentials(credentialStore);
  const pairingStore = options.pairingStore ?? new PairingNonceStore();
  const instanceId = options.instanceId ?? randomUUID();
  const expectedDataStoreId = options.expectedDataStoreId;
  if (expectedDataStoreId !== undefined && !DATA_STORE_ID_PATTERN.test(expectedDataStoreId)) {
    throw new Error("The expected FormaSpec data-store identity is invalid.");
  }
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const allowLegacySelfCreate = options.allowLegacySelfCreate === true;
  const serializeAgentAuthorization = createSerialExecutor();
  let shuttingDown = false;

  const server = http.createServer((request, response) => {
    void (async () => {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      const address = server.address();
      const expectedHost = address && typeof address !== "string"
        ? `${host === "::1" ? `[${host}]` : host}:${address.port}`
        : null;
      if (!expectedHost || request.headers.host !== expectedHost) {
        sendJson(response, 403, { error: "BRIDGE_HOST_FORBIDDEN" });
        return;
      }
      if (requestUrl.pathname === "/mcp") {
        if (request.headers.origin !== undefined || request.headers["sec-fetch-site"] !== undefined) {
          sendJson(response, 403, { error: "BRIDGE_CROSS_SITE_FORBIDDEN" });
          return;
        }
        if (request.method === "POST") {
          const contentType = request.headers["content-type"];
          const mediaType = typeof contentType === "string" ? contentType.split(";", 1)[0]?.trim().toLowerCase() : undefined;
          if (mediaType !== "application/json") {
            sendJson(response, 415, { error: "UNSUPPORTED_MEDIA_TYPE" });
            return;
          }
        }
      }
      if (request.method === "GET" && requestUrl.pathname === "/health") {
        const upstreamIdentity = await probeUpstreamRuntimeIdentity(upstream, fetchImplementation);
        const identityMatches = upstreamIdentityMatches(upstreamIdentity, expectedDataStoreId);
        sendJson(response, 200, {
          service: "formaspec-local-bridge",
          status: shuttingDown ? "stopping" : "ok",
          buildId,
          upstreamConfigured: true,
          upstreamOrigin: upstreamIdentity.origin,
          upstreamReady: upstreamIdentity.ready && identityMatches,
          dataStoreId: upstreamIdentity.dataStoreId,
          expectedDataStoreId: expectedDataStoreId ?? null,
          identityMatches,
          pairing: pairingStore.publicState(),
        });
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/pairing-nonces") {
        sendJson(response, 201, pairingStore.issue());
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/pairing-nonces/consume") {
        const body = JSON.parse((await readBody(request, 4096)).toString("utf8")) as { nonce?: unknown };
        const consumed = typeof body.nonce === "string" && pairingStore.consume(body.nonce);
        sendJson(response, consumed ? 200 : 409, { consumed });
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/_control/shutdown") {
        const body = JSON.parse((await readBody(request, 4096)).toString("utf8")) as { instanceId?: unknown };
        if (body.instanceId !== instanceId) {
          sendJson(response, 403, { error: "CONTROL_AUTHORIZATION_FAILED" });
          return;
        }
        shuttingDown = true;
        sendJson(response, 202, { stopping: true });
        setImmediate(() => server.close());
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/_control/identity") {
        const body = JSON.parse((await readBody(request, 4096)).toString("utf8")) as { instanceId?: unknown };
        if (body.instanceId !== instanceId) {
          sendJson(response, 403, { error: "CONTROL_AUTHORIZATION_FAILED" });
          return;
        }
        const upstreamIdentity = await probeUpstreamRuntimeIdentity(upstream, fetchImplementation);
        const identityMatches = upstreamIdentityMatches(upstreamIdentity, expectedDataStoreId);
        sendJson(response, 200, {
          owned: true,
          status: shuttingDown ? "stopping" : "ok",
          buildId,
          upstreamOrigin: upstreamIdentity.origin,
          upstreamReady: upstreamIdentity.ready && identityMatches,
          dataStoreId: upstreamIdentity.dataStoreId,
          expectedDataStoreId: expectedDataStoreId ?? null,
          identityMatches,
        });
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/_control/authorize-agent") {
        const body = JSON.parse((await readBody(request, 4096)).toString("utf8")) as {
          instanceId?: unknown;
          pairing?: unknown;
        };
        if (body.instanceId !== instanceId) {
          sendJson(response, 403, { error: "CONTROL_AUTHORIZATION_FAILED" });
          return;
        }
        const upstreamIdentity = await probeUpstreamRuntimeIdentity(upstream, fetchImplementation);
        if (!upstreamIdentity.ready) {
          throw new BridgeControlError(503, "UPSTREAM_NOT_READY", "The configured FormaSpec runtime is not ready.");
        }
        if (!upstreamIdentityMatches(upstreamIdentity, expectedDataStoreId)) {
          throw new BridgeControlError(409, "UPSTREAM_DATA_STORE_MISMATCH", "The configured FormaSpec data store changed.");
        }
        const pairing = body.pairing === undefined ? undefined : validatePairingTicket(body.pairing);
        const result = await serializeAgentAuthorization(
          async () => {
            if (pairing !== undefined) {
              return pairIssuedAgentConnection(upstream, credentialStore, fetchImplementation, pairing);
            }
            if (allowLegacySelfCreate) {
              return authorizeAgentConnection(upstream, credentialStore, fetchImplementation);
            }
            const reused = await reuseStoredAgentConnection(upstream, credentialStore, fetchImplementation);
            if (reused !== null) return reused;
            throw new BridgeControlError(
              409,
              "PAIRING_TICKET_REQUIRED",
              "A browser-issued one-time pairing ticket is required.",
            );
          },
        );
        sendJson(response, 200, result);
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/_control/verify-agent") {
        const body = JSON.parse((await readBody(request, 4096)).toString("utf8")) as { instanceId?: unknown };
        if (body.instanceId !== instanceId) {
          sendJson(response, 403, { error: "CONTROL_AUTHORIZATION_FAILED" });
          return;
        }
        const token = await credentialStore.read();
        if (!token || !/^fsg_[A-Za-z0-9_-]+$/.test(token)) {
          sendJson(response, 409, { error: "AGENT_AUTHORIZATION_MISSING" });
          return;
        }
        const [probe, upstreamIdentity] = await Promise.all([
          probeMcpGrant(upstream, token, fetchImplementation),
          probeUpstreamRuntimeIdentity(upstream, fetchImplementation),
        ]);
        if (probe === null) {
          sendJson(response, 502, { error: "AGENT_AUTHORIZATION_VERIFICATION_FAILED" });
          return;
        }
        if (!upstreamIdentity.ready || !upstreamIdentityMatches(upstreamIdentity, expectedDataStoreId)) {
          sendJson(response, 502, { error: "UPSTREAM_IDENTITY_UNAVAILABLE" });
          return;
        }
        sendJson(response, 200, {
          verified: true,
          checks: ["initialize", "tools/list"],
          serverName: probe.serverName,
          essentialTools: probe.essentialTools,
          upstreamOrigin: upstreamIdentity.origin,
          dataStoreId: upstreamIdentity.dataStoreId,
        });
        return;
      }
      if (requestUrl.pathname === "/mcp") {
        await proxyMcpRequest(
          request,
          response,
          upstream,
          credentialProvider,
          fetchImplementation,
          expectedDataStoreId,
        );
        return;
      }
      sendJson(response, 404, { error: "NOT_FOUND" });
    })().catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof Error && error.message === "REQUEST_TOO_LARGE") {
        sendJson(response, 413, { error: "PAYLOAD_TOO_LARGE" });
      } else if (error instanceof BridgeControlError) {
        sendJson(response, error.statusCode, { error: error.code });
      } else {
        options.controlErrorReporter?.(error);
        sendJson(response, 502, { error: "BRIDGE_REQUEST_FAILED" });
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Bridge did not obtain a TCP address.");
  }
  const displayHost = host === "::1" ? "[::1]" : host;
  return {
    host,
    port: address.port,
    url: `http://${displayHost}:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
