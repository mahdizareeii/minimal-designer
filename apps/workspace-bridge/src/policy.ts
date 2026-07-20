import type {
  LocalRepositoryInventory,
  RepositoryPlatform,
  UploadRepositoryInventory,
} from "./inventory.js";
import { inventoryForUpload, normalizeExcludedPatterns } from "./inventory.js";

export const REPOSITORY_CONNECTION_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REPOSITORY_CONNECTION_TIMEOUT_MS = 10_000;

const REPOSITORY_PLATFORMS = new Set<RepositoryPlatform>([
  "web", "android", "ios", "flutter", "react-native", "generic-git",
]);

export interface RepositoryScanPolicy {
  excludedPatterns: string[];
  allowedPlatforms: RepositoryPlatform[];
  maximumInventoryBytes: number;
  maximumInventoryEntities: number;
}

export interface RepositoryPolicyConnection {
  apiUrl?: string;
  mcpUrl?: string;
  bearerToken?: string;
}

export interface PersistedRepositoryInventory {
  id: string;
  repositoryFingerprint: string;
  inventoryHash: string;
  status: "active";
  deduplicated: boolean;
  createdAt: string;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export async function readBoundedResponseObject(response: Response, label: string): Promise<Record<string, unknown>> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > REPOSITORY_CONNECTION_MAX_RESPONSE_BYTES) {
      throw new Error(`${label} exceeded the bounded response limit.`);
    }
  }
  if (response.body === null) throw new Error(`${label} returned an empty response.`);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > REPOSITORY_CONNECTION_MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`${label} exceeded the bounded response limit.`);
    }
    chunks.push(Buffer.from(chunk.value));
  }
  try {
    const value = recordValue(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
    if (value === null) throw new Error("not an object");
    return value;
  } catch (error) {
    throw new Error(`${label} returned malformed JSON.`, { cause: error });
  }
}

export function validateApiOrigin(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("FormaSpec API URL is invalid.");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback = hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("FormaSpec API URL must use HTTPS, or HTTP on loopback.");
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("FormaSpec API URL must be a credential-free origin without a path, query, or fragment.");
  }
  return new URL(url.origin);
}

export function validateMcpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("FormaSpec MCP URL is invalid.");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback = hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("FormaSpec MCP URL must use HTTPS, or HTTP on loopback.");
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/mcp") {
    throw new Error("FormaSpec MCP URL must identify the credential-free /mcp endpoint without query or fragment.");
  }
  return url;
}

export function repositoryPolicyConnectionFromEnvironment(
  environment: NodeJS.ProcessEnv,
): RepositoryPolicyConnection | null {
  let apiUrl = environment.FORMASPEC_API_URL ?? environment.DESIGNER_API_URL;
  const mcpUrl = apiUrl === undefined ? environment.FORMASPEC_UPSTREAM_MCP_URL : undefined;
  if (apiUrl === undefined && mcpUrl === undefined) return null;
  const bearerToken = environment.FORMASPEC_API_TOKEN?.trim();
  if (bearerToken !== undefined && (bearerToken.length === 0 || /[\r\n]/.test(bearerToken))) {
    throw new Error("FORMASPEC_API_TOKEN is invalid.");
  }
  return {
    ...(apiUrl === undefined
      ? { mcpUrl: validateMcpUrl(mcpUrl as string).toString() }
      : { apiUrl: validateApiOrigin(apiUrl).origin }),
    ...(bearerToken === undefined ? {} : { bearerToken }),
  };
}

export async function readRepositoryScanPolicy(
  connection: RepositoryPolicyConnection,
  options: { fetchImplementation?: typeof fetch } = {},
): Promise<RepositoryScanPolicy> {
  if ((connection.apiUrl === undefined) === (connection.mcpUrl === undefined)) {
    throw new Error("FormaSpec policy connection must configure exactly one API or MCP endpoint.");
  }
  const headers = new Headers({ accept: "application/json" });
  if (connection.bearerToken !== undefined) {
    if (connection.bearerToken.length === 0 || /[\r\n]/.test(connection.bearerToken)) {
      throw new Error("FormaSpec API bearer token is invalid.");
    }
    headers.set("authorization", `Bearer ${connection.bearerToken}`);
  }
  let response: Response;
  let organizationPolicy: Record<string, unknown> | null;
  if (connection.mcpUrl !== undefined) {
    headers.set("accept", "application/json, text/event-stream");
    headers.set("content-type", "application/json");
    response = await (options.fetchImplementation ?? fetch)(validateMcpUrl(connection.mcpUrl), {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "formaspec-workspace-policy",
        method: "tools/call",
        params: { name: "organization_policy_read", arguments: { format: "json" } },
      }),
      redirect: "error",
      signal: AbortSignal.timeout(REPOSITORY_CONNECTION_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`FormaSpec organization policy request failed with HTTP ${response.status}.`);
    const body = await readBoundedResponseObject(response, "FormaSpec organization policy");
    const result = recordValue(body?.result);
    const structured = recordValue(result?.structuredContent);
    if (structured?.ok !== true) throw new Error("FormaSpec MCP organization-policy tool returned an error.");
    organizationPolicy = recordValue(structured.organizationPolicy);
  } else {
    const origin = validateApiOrigin(connection.apiUrl as string);
    response = await (options.fetchImplementation ?? fetch)(new URL("/api/organization/policy", origin), {
      method: "GET",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(REPOSITORY_CONNECTION_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`FormaSpec organization policy request failed with HTTP ${response.status}.`);
    const body = await readBoundedResponseObject(response, "FormaSpec organization policy");
    organizationPolicy = recordValue(body?.organizationPolicy);
  }
  const policy = recordValue(organizationPolicy?.policy);
  const repositories = recordValue(policy?.repositories);
  if (repositories?.enabled !== true
    || repositories.requireExplicitGrant !== true
    || repositories.readOnlyByDefault !== true) {
    throw new Error("Workspace Bridge repository inventory is disabled or not read-only by organization policy.");
  }
  const excludedPatterns = normalizeExcludedPatterns(repositories.excludedPatterns);
  if (!Array.isArray(repositories.allowedPlatforms)
    || repositories.allowedPlatforms.length === 0
    || repositories.allowedPlatforms.some((platform) => typeof platform !== "string" || !REPOSITORY_PLATFORMS.has(platform as RepositoryPlatform))) {
    throw new Error("FormaSpec returned an invalid repository platform policy.");
  }
  const allowedPlatforms = [...new Set(repositories.allowedPlatforms as RepositoryPlatform[])];
  if (allowedPlatforms.length !== repositories.allowedPlatforms.length) {
    throw new Error("FormaSpec repository platform policy contains duplicate entries.");
  }
  const maximumInventoryBytes = repositories.maximumInventoryBytes;
  const maximumInventoryEntities = repositories.maximumInventoryEntities;
  if (typeof maximumInventoryBytes !== "number" || !Number.isSafeInteger(maximumInventoryBytes)
    || maximumInventoryBytes < 1_024 || maximumInventoryBytes > 1_048_576
    || typeof maximumInventoryEntities !== "number" || !Number.isSafeInteger(maximumInventoryEntities)
    || maximumInventoryEntities < 1 || maximumInventoryEntities > 10_000) {
    throw new Error("FormaSpec returned invalid repository inventory limits.");
  }
  return { excludedPatterns, allowedPlatforms, maximumInventoryBytes, maximumInventoryEntities };
}

export async function persistRepositoryInventory(
  connection: RepositoryPolicyConnection,
  inventory: UploadRepositoryInventory,
  options: { fetchImplementation?: typeof fetch } = {},
): Promise<PersistedRepositoryInventory> {
  if ((connection.apiUrl === undefined) === (connection.mcpUrl === undefined)) {
    throw new Error("FormaSpec policy connection must configure exactly one API or MCP endpoint.");
  }
  const headers = new Headers({ accept: "application/json", "content-type": "application/json" });
  if (connection.bearerToken !== undefined) {
    if (connection.bearerToken.length === 0 || /[\r\n]/.test(connection.bearerToken)) {
      throw new Error("FormaSpec API bearer token is invalid.");
    }
    headers.set("authorization", `Bearer ${connection.bearerToken}`);
  }
  let response: Response;
  let persisted: Record<string, unknown> | null;
  if (connection.mcpUrl !== undefined) {
    headers.set("accept", "application/json, text/event-stream");
    response = await (options.fetchImplementation ?? fetch)(validateMcpUrl(connection.mcpUrl), {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "formaspec-workspace-inventory",
        method: "tools/call",
        params: { name: "repository_inventory_persist", arguments: { inventory } },
      }),
      redirect: "error",
      signal: AbortSignal.timeout(REPOSITORY_CONNECTION_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`FormaSpec repository inventory upload failed with HTTP ${response.status}.`);
    const body = await readBoundedResponseObject(response, "FormaSpec repository inventory persistence");
    const result = recordValue(body?.result);
    const structured = recordValue(result?.structuredContent);
    if (structured?.ok !== true) throw new Error("FormaSpec MCP repository-inventory tool returned an error.");
    persisted = recordValue(structured.inventory);
  } else {
    response = await (options.fetchImplementation ?? fetch)(
      new URL("/api/repository-inventories", validateApiOrigin(connection.apiUrl as string)),
      {
        method: "POST",
        headers,
        body: JSON.stringify(inventory),
        redirect: "error",
        signal: AbortSignal.timeout(REPOSITORY_CONNECTION_TIMEOUT_MS),
      },
    );
    if (!response.ok) throw new Error(`FormaSpec repository inventory upload failed with HTTP ${response.status}.`);
    const body = await readBoundedResponseObject(response, "FormaSpec repository inventory persistence");
    persisted = recordValue(body?.inventory);
  }
  if (persisted === null
    || typeof persisted.id !== "string" || !/^inventory_[a-f0-9]{32}$/.test(persisted.id)
    || persisted.repositoryFingerprint !== inventory.repositoryFingerprint
    || typeof persisted.inventoryHash !== "string" || !/^[a-f0-9]{64}$/.test(persisted.inventoryHash)
    || persisted.status !== "active"
    || typeof persisted.deduplicated !== "boolean"
    || typeof persisted.createdAt !== "string" || !Number.isFinite(Date.parse(persisted.createdAt))) {
    throw new Error("FormaSpec returned an invalid persisted repository inventory.");
  }
  return persisted as unknown as PersistedRepositoryInventory;
}

export function assertInventoryMatchesPolicy(
  inventory: LocalRepositoryInventory,
  policy: RepositoryScanPolicy,
): void {
  if (inventory.excludedPatterns.length !== policy.excludedPatterns.length
    || inventory.excludedPatterns.some((pattern, index) => pattern !== policy.excludedPatterns[index])) {
    throw new Error("Repository exclusion policy changed; create a new explicit grant before inspecting or uploading.");
  }
  const disallowedPlatforms = inventory.platforms.filter((platform) => !policy.allowedPlatforms.includes(platform));
  if (disallowedPlatforms.length > 0) {
    throw new Error(`Repository platform is disallowed by organization policy: ${disallowedPlatforms.join(", ")}.`);
  }
  if (inventory.entities.length > policy.maximumInventoryEntities) {
    throw new Error("Repository inventory exceeds the organization-policy entity limit.");
  }
  if (Buffer.byteLength(JSON.stringify(inventoryForUpload(inventory)), "utf8") > policy.maximumInventoryBytes) {
    throw new Error("Repository inventory exceeds the organization-policy byte limit.");
  }
}
