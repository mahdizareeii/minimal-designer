import {
  ComponentDefinitionSchema,
  type AnyDesignDocument,
  type ComponentDefinition,
  type RedesignStageArtifact,
  type RedesignStageArtifactMap,
} from "@designer/core";

import type {
  DesignDocument,
  DesignOperation,
  DesignProjectSummary,
  DevicePreset,
  ParentReference,
  RevisionSummary,
} from "../domain";
import { createClientKey, normalizeDocument, normalizeOperations } from "../domain";
import { normalizeConflictRecoveryOperations } from "./conflict-recovery";
import type { OrganizationPolicy } from "./organization-policy";

const API_ROOT = "/api";
export const AUTHENTICATION_REQUIRED_EVENT = "formaspec:authentication-required";

let browserCsrfToken = "1";

function rememberBrowserCsrfToken(value: string | undefined): void {
  browserCsrfToken = value && value.length >= 32 ? value : "1";
}

export class ApiError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number;
  readonly details: unknown;

  constructor(message: string, options: { code?: string; retryable?: boolean; status?: number; details?: unknown } = {}) {
    super(message);
    this.name = "ApiError";
    this.code = options.code ?? "REQUEST_FAILED";
    this.retryable = options.retryable ?? false;
    this.status = options.status ?? 0;
    this.details = options.details;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_ROOT}${path}`, {
      ...init,
      credentials: "same-origin",
      headers: {
        ...(init?.body instanceof FormData ? {} : { "content-type": "application/json" }),
        "x-formaspec-csrf": browserCsrfToken,
        ...init?.headers,
      },
    });
  } catch (error) {
    throw new ApiError(error instanceof Error ? error.message : "The design server is unavailable.", {
      code: "NETWORK_ERROR",
      retryable: true,
    });
  }

  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    const domain = body as { error?: { code?: string; message?: string; retryable?: boolean; details?: unknown } } | undefined;
    if (response.status === 401 && typeof window !== "undefined") {
      window.dispatchEvent(new Event(AUTHENTICATION_REQUIRED_EVENT));
    }
    throw new ApiError(domain?.error?.message ?? `Request failed with status ${response.status}.`, {
      code: domain?.error?.code,
      retryable: domain?.error?.retryable,
      status: response.status,
      details: domain?.error?.details,
    });
  }

  if (response.status === 204) return undefined as T;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response as unknown as T;
  return response.json() as Promise<T>;
}

export type BrowserAuthenticationMode = "local" | "none" | "session" | "trusted-header" | "token";

export interface BrowserAuthenticationStatus {
  mode: BrowserAuthenticationMode;
  bootstrapRequired: boolean;
  bootstrapTokenRequired?: boolean;
  authenticated: boolean;
  csrfToken?: string;
  account?: {
    principalId: string;
    organizationId: string;
    loginName: string;
    displayName: string;
    role: string;
  };
}

function rememberAuthentication(status: BrowserAuthenticationStatus): BrowserAuthenticationStatus {
  rememberBrowserCsrfToken(status.mode === "session" && status.authenticated ? status.csrfToken : undefined);
  return status;
}

export async function readBrowserAuthentication(): Promise<BrowserAuthenticationStatus> {
  return rememberAuthentication(await request<BrowserAuthenticationStatus>("/auth/status"));
}

export async function bootstrapBrowserAdministrator(input: {
  loginName: string;
  displayName?: string;
  password: string;
  bootstrapToken?: string;
}): Promise<BrowserAuthenticationStatus> {
  return rememberAuthentication(await request<BrowserAuthenticationStatus>("/auth/bootstrap", {
    method: "POST",
    headers: { "x-formaspec-csrf": "1" },
    body: JSON.stringify(input),
  }));
}

export async function loginBrowserAdministrator(input: {
  loginName: string;
  password: string;
}): Promise<BrowserAuthenticationStatus> {
  return rememberAuthentication(await request<BrowserAuthenticationStatus>("/auth/login", {
    method: "POST",
    headers: { "x-formaspec-csrf": "1" },
    body: JSON.stringify(input),
  }));
}

export async function logoutBrowserAdministrator(): Promise<void> {
  await request<void>("/auth/logout", { method: "POST", body: JSON.stringify({}) });
  rememberBrowserCsrfToken(undefined);
}

function asProjectSummary(input: unknown): DesignProjectSummary {
  const value = input as Record<string, unknown>;
  return {
    id: String(value.id),
    name: String(value.name ?? "Untitled design"),
    version: Number(value.version ?? value.revision ?? 1),
    ...(value.revisionId || value.revision_id ? { revisionId: String(value.revisionId ?? value.revision_id) } : {}),
    ...(value.preset ? { preset: value.preset as DevicePreset } : {}),
    updatedAt: String(value.updatedAt ?? value.updated_at ?? new Date().toISOString()),
    ...(value.thumbnailUrl || value.thumbnail_url ? { thumbnailUrl: String(value.thumbnailUrl ?? value.thumbnail_url) } : {}),
  };
}

export async function listDesigns(): Promise<DesignProjectSummary[]> {
  const result = await request<unknown>("/designs");
  const value = result as { designs?: unknown[]; data?: unknown[] };
  const rows = Array.isArray(result) ? result : value.designs ?? value.data ?? [];
  return rows.map(asProjectSummary);
}

export async function createDesign(
  name: string,
  preset: DevicePreset,
  idempotencyKey: string,
): Promise<DesignDocument> {
  const result = await request<unknown>("/designs", {
    method: "POST",
    body: JSON.stringify({ name, preset, idempotencyKey }),
  });
  return normalizeDocument(result);
}

export async function readDesign(id: string, version?: number): Promise<DesignDocument> {
  const suffix = version === undefined ? "" : `?version=${encodeURIComponent(version)}`;
  return normalizeDocument(await request<unknown>(`/designs/${encodeURIComponent(id)}${suffix}`));
}

export interface CommitResult {
  version: number;
  revisionId?: string;
  document?: DesignDocument;
}

export async function commitRevision(
  id: string,
  baseVersion: number,
  operations: DesignOperation[],
  idempotencyKey: string,
  message = "Manual editor changes",
): Promise<CommitResult> {
  const result = await request<Record<string, unknown>>(`/designs/${encodeURIComponent(id)}/revisions`, {
    method: "POST",
    body: JSON.stringify({ baseVersion, operations: normalizeOperations(operations), idempotencyKey, message }),
  });
  const possibleDocument = result.design ?? result.document;
  return {
    version: Number(result.version ?? result.revision ?? baseVersion + 1),
    ...(result.revisionId || result.revision_id ? { revisionId: String(result.revisionId ?? result.revision_id) } : {}),
    ...(possibleDocument ? { document: normalizeDocument(possibleDocument) } : {}),
  };
}

export interface DuplicateConflictDraftResult {
  duplicated: true;
  source: {
    projectId: string;
    baseVersion: number;
    baseRevisionId: string;
    baseSnapshotHash: string;
    baseRevisionHash: string;
    currentVersion: number;
    currentRevisionId: string;
  };
  project: {
    id: string;
    name: string;
    version: number;
    revisionId: string;
    snapshotHash: string;
    operationHash: string;
    revisionHash: string;
    schemaVersion: number;
    assetCount: number;
    productSpecificationVersion: 1 | null;
    implementationMappingCount: number;
  };
  idMapping: Record<string, string>;
  diagnostics: unknown[];
  deepLink: string;
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ApiError(`${label} is invalid.`, { code: "INVALID_RESPONSE" });
  return value as Record<string, unknown>;
}

function requiredExactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const record = requiredRecord(value, label);
  const allowed = new Set(keys);
  const unexpected = Object.keys(record).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new ApiError(`${label} contains unsupported fields: ${unexpected.sort().join(", ")}.`, { code: "INVALID_RESPONSE" });
  }
  return record;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new ApiError(`${label} is invalid.`, { code: "INVALID_RESPONSE" });
  return value;
}

function requiredNonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new ApiError(`${label} is invalid.`, { code: "INVALID_RESPONSE" });
  return value as number;
}

function requiredPositiveInteger(value: unknown, label: string): number {
  const parsed = requiredNonnegativeInteger(value, label);
  if (parsed < 1) throw new ApiError(`${label} is invalid.`, { code: "INVALID_RESPONSE" });
  return parsed;
}

function requiredOpaqueId(value: unknown, label: string): string {
  const parsed = requiredString(value, label);
  if (!/^[A-Za-z][A-Za-z0-9_-]{7,191}$/.test(parsed)) throw new ApiError(`${label} is invalid.`, { code: "INVALID_RESPONSE" });
  return parsed;
}

function requiredHash(value: unknown, label: string): string {
  const parsed = requiredString(value, label);
  if (!/^[a-f0-9]{64}$/.test(parsed)) throw new ApiError(`${label} is invalid.`, { code: "INVALID_RESPONSE" });
  return parsed;
}

function parseDuplicateConflictDraftResult(
  input: unknown,
  expectedSourceProjectId: string,
  expectedBaseVersion: number,
): DuplicateConflictDraftResult {
  const result = requiredExactRecord(
    input,
    ["duplicated", "source", "project", "idMapping", "diagnostics", "deepLink"],
    "Conflict-recovery duplicate response",
  );
  if (result.duplicated !== true) throw new ApiError("Conflict-recovery duplicate response did not confirm success.", { code: "INVALID_RESPONSE" });
  const source = requiredExactRecord(
    result.source,
    ["projectId", "baseVersion", "baseRevisionId", "baseSnapshotHash", "baseRevisionHash", "currentVersion", "currentRevisionId"],
    "Conflict-recovery source",
  );
  const project = requiredExactRecord(
    result.project,
    ["id", "name", "version", "revisionId", "snapshotHash", "operationHash", "revisionHash", "schemaVersion", "assetCount", "productSpecificationVersion", "implementationMappingCount"],
    "Duplicated project",
  );
  const rawIdMapping = requiredRecord(result.idMapping, "Conflict-recovery ID mapping");
  const idMapping = Object.fromEntries(Object.entries(rawIdMapping).map(([sourceId, targetId]) => [
    sourceId,
    requiredOpaqueId(targetId, `Conflict-recovery ID mapping for ${sourceId}`),
  ]));
  const sourceProjectId = requiredOpaqueId(source.projectId, "Conflict-recovery source project ID");
  const baseVersion = requiredPositiveInteger(source.baseVersion, "Conflict-recovery source base version");
  if (sourceProjectId !== expectedSourceProjectId || baseVersion !== expectedBaseVersion) {
    throw new ApiError("Conflict-recovery duplicate response does not match the requested source project and base version.", { code: "INVALID_RESPONSE" });
  }
  const projectId = requiredOpaqueId(project.id, "Duplicated project ID");
  if (idMapping[expectedSourceProjectId] !== projectId) {
    throw new ApiError("Conflict-recovery duplicate response does not map the source project to the duplicated project.", { code: "INVALID_RESPONSE" });
  }
  const projectVersion = requiredPositiveInteger(project.version, "Duplicated project version");
  if (projectVersion !== 1) throw new ApiError("Duplicated project version is invalid.", { code: "INVALID_RESPONSE" });
  const schemaVersion = requiredPositiveInteger(project.schemaVersion, "Duplicated project schema version");
  if (schemaVersion !== 1 && schemaVersion !== 2) throw new ApiError("Duplicated project schema version is invalid.", { code: "INVALID_RESPONSE" });
  const productSpecificationVersion = project.productSpecificationVersion === null
    ? null
    : requiredPositiveInteger(project.productSpecificationVersion, "Duplicated product-specification version");
  if (productSpecificationVersion !== null && productSpecificationVersion !== 1) {
    throw new ApiError("Duplicated product-specification version is invalid.", { code: "INVALID_RESPONSE" });
  }
  if (!Array.isArray(result.diagnostics) || result.diagnostics.some((item) => typeof item !== "object" || item === null || Array.isArray(item))) {
    throw new ApiError("Conflict-recovery diagnostics are invalid.", { code: "INVALID_RESPONSE" });
  }
  const deepLink = requiredString(result.deepLink, "Duplicated project deep link");
  if (deepLink !== `/design/${encodeURIComponent(projectId)}`) {
    throw new ApiError("Duplicated project deep link is invalid.", { code: "INVALID_RESPONSE" });
  }
  return {
    duplicated: true,
    source: {
      projectId: sourceProjectId,
      baseVersion,
      baseRevisionId: requiredOpaqueId(source.baseRevisionId, "Conflict-recovery source base revision ID"),
      baseSnapshotHash: requiredHash(source.baseSnapshotHash, "Conflict-recovery source snapshot hash"),
      baseRevisionHash: requiredHash(source.baseRevisionHash, "Conflict-recovery source revision hash"),
      currentVersion: requiredPositiveInteger(source.currentVersion, "Conflict-recovery source current version"),
      currentRevisionId: requiredOpaqueId(source.currentRevisionId, "Conflict-recovery source current revision ID"),
    },
    project: {
      id: projectId,
      name: requiredString(project.name, "Duplicated project name"),
      version: 1,
      revisionId: requiredOpaqueId(project.revisionId, "Duplicated project revision ID"),
      snapshotHash: requiredHash(project.snapshotHash, "Duplicated project snapshot hash"),
      operationHash: requiredHash(project.operationHash, "Duplicated project operation hash"),
      revisionHash: requiredHash(project.revisionHash, "Duplicated project revision hash"),
      schemaVersion,
      assetCount: requiredNonnegativeInteger(project.assetCount, "Duplicated project asset count"),
      productSpecificationVersion,
      implementationMappingCount: requiredNonnegativeInteger(project.implementationMappingCount, "Duplicated implementation-mapping count"),
    },
    idMapping,
    diagnostics: structuredClone(result.diagnostics),
    deepLink,
  };
}

export async function duplicateConflictDraft(
  id: string,
  baseVersion: number,
  operations: DesignOperation[],
  idempotencyKey: string,
  name?: string,
): Promise<DuplicateConflictDraftResult> {
  const normalizedOperations = normalizeConflictRecoveryOperations(normalizeOperations(operations));
  const result = await request<unknown>(`/designs/${encodeURIComponent(id)}/conflict-recovery/duplicate`, {
    method: "POST",
    body: JSON.stringify({
      baseVersion,
      operations: normalizedOperations,
      idempotencyKey,
      ...(name === undefined ? {} : { name }),
    }),
  });
  return parseDuplicateConflictDraftResult(result, id, baseVersion);
}

export async function listHistory(id: string): Promise<RevisionSummary[]> {
  const result = await request<unknown>(`/designs/${encodeURIComponent(id)}/history`);
  const envelope = result as { revisions?: unknown[]; history?: unknown[] };
  const rows = Array.isArray(result) ? result : envelope.revisions ?? envelope.history ?? [];
  return rows.map((item) => {
    const value = item as Record<string, unknown>;
    return {
      id: String(value.id ?? value.revisionId ?? value.revision_id ?? value.version),
      version: Number(value.version ?? value.revision ?? 0),
      message: String(value.message ?? "Saved revision"),
      ...(value.actor ? { actor: String(value.actor) } : {}),
      createdAt: String(value.createdAt ?? value.created_at ?? new Date().toISOString()),
    };
  });
}

export async function restoreRevision(
  id: string,
  targetVersion: number,
  expectedBaseVersion: number,
  idempotencyKey: string,
): Promise<CommitResult> {
  const result = await request<Record<string, unknown>>(`/designs/${encodeURIComponent(id)}/restore`, {
    method: "POST",
    body: JSON.stringify({ targetVersion, expectedBaseVersion, idempotencyKey }),
  });
  return {
    version: Number(result.version ?? result.revision ?? expectedBaseVersion + 1),
    ...(result.revisionId || result.revision_id ? { revisionId: String(result.revisionId ?? result.revision_id) } : {}),
    ...(result.design || result.document ? { document: normalizeDocument(result.design ?? result.document) } : {}),
  };
}

export interface ArchivePreviewResult {
  previewId: string;
  rootBaseVersion: number;
  changedNodeIds: string[];
  canCommit: boolean;
  document: DesignDocument;
}

export async function createArchivePreview(
  id: string,
  baseVersion: number,
  operations: DesignOperation[],
): Promise<ArchivePreviewResult> {
  const result = await request<Record<string, unknown>>(`/designs/${encodeURIComponent(id)}/archive-previews`, {
    method: "POST",
    body: JSON.stringify({ baseVersion, operations: normalizeOperations(operations) }),
  });
  return {
    previewId: String(result.previewId),
    rootBaseVersion: Number(result.rootBaseVersion ?? baseVersion),
    changedNodeIds: Array.isArray(result.changedNodeIds) ? result.changedNodeIds.map(String) : [],
    canCommit: Boolean(result.canCommit),
    document: normalizeDocument(result.document),
  };
}

export async function commitArchivePreview(
  id: string,
  previewId: string,
  expectedBaseVersion: number,
  idempotencyKey: string,
  message = "Archive reviewed layers",
): Promise<CommitResult> {
  const result = await request<Record<string, unknown>>(
    `/designs/${encodeURIComponent(id)}/archive-previews/${encodeURIComponent(previewId)}/commit`,
    {
      method: "POST",
      body: JSON.stringify({ expectedBaseVersion, idempotencyKey, message }),
    },
  );
  return {
    version: Number(result.version ?? result.revision ?? expectedBaseVersion + 1),
    ...(result.revisionId || result.revision_id ? { revisionId: String(result.revisionId ?? result.revision_id) } : {}),
    ...(result.document ? { document: normalizeDocument(result.document) } : {}),
  };
}

export async function updateContext(input: {
  designId: string | null;
  pageId?: string;
  selectedNodeIds: string[];
}): Promise<void> {
  await request<void>("/context", { method: "PUT", body: JSON.stringify(input) });
}

export function renderUrl(id: string, options: { version?: number; pageId?: string; nodeId?: string; maxSize?: number } = {}): string {
  const params = new URLSearchParams();
  if (options.version !== undefined) params.set("version", String(options.version));
  if (options.pageId) params.set("pageId", options.pageId);
  if (options.nodeId) params.set("nodeId", options.nodeId);
  if (options.maxSize) params.set("maxSize", String(options.maxSize));
  const query = params.toString();
  return `${API_ROOT}/designs/${encodeURIComponent(id)}/render.png${query ? `?${query}` : ""}`;
}

export function previewRenderUrl(id: string, previewId: string, maxSize = 2048, taskId?: string): string {
  const params = new URLSearchParams({ maxSize: String(maxSize) });
  if (taskId) params.set("taskId", taskId);
  return `${API_ROOT}/designs/${encodeURIComponent(id)}/previews/${encodeURIComponent(previewId)}/render.png?${params}`;
}

export function exportUrl(id: string, version?: number): string {
  const query = version === undefined ? "" : `?version=${encodeURIComponent(version)}`;
  return `${API_ROOT}/designs/${encodeURIComponent(id)}/export${query}`;
}

export function portableExportUrl(id: string, version?: number): string {
  const query = version === undefined ? "" : `?version=${encodeURIComponent(version)}`;
  return `${API_ROOT}/designs/${encodeURIComponent(id)}/export.formaspec.zip${query}`;
}

export interface BackupRecord {
  id: string;
  filename: string;
  status: "creating" | "valid" | "invalid" | "restored";
  bundleSha256: string | null;
  createdAt: string;
  verifiedAt: string | null;
  sizeBytes: number | null;
  retentionClass: "manual" | "daily" | "weekly" | "monthly";
  completedAt: string | null;
  downloadUrl: string;
  manifest: null | {
    format: "formaspec-backup";
    formatVersion: 1 | 2;
    createdAt: string;
    databaseSchemaVersion: number;
    documentSchemaVersion: number;
    fileCount: number;
  };
}

export async function listBackups(): Promise<BackupRecord[]> {
  const result = await request<{ backups?: BackupRecord[] }>("/backups");
  return result.backups ?? [];
}

export async function createBackup(): Promise<BackupRecord> {
  const result = await request<{ backup: BackupRecord }>("/backups", {
    method: "POST",
    body: JSON.stringify({}),
  });
  return result.backup;
}

export async function verifyBackup(backupId: string): Promise<BackupRecord> {
  const result = await request<{ backup: BackupRecord }>(`/backups/${encodeURIComponent(backupId)}/verify`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  return result.backup;
}

export function backupDownloadUrl(backupId: string): string {
  return `${API_ROOT}/backups/${encodeURIComponent(backupId)}/download`;
}

export interface PortableImportValidation {
  valid: true;
  validationOnly: true;
  mutationsApplied: false;
  manifest: Record<string, unknown>;
  project: {
    id: string | null;
    name: string | null;
    schemaVersion: number;
    pageCount: number;
    nodeCount: number;
    tokenCount: number;
    assetCount: number;
    previewCount: number;
  };
}

export async function validatePortableImport(file: File): Promise<PortableImportValidation> {
  const body = new FormData();
  body.append("file", file);
  return request<PortableImportValidation>("/imports/validate", { method: "POST", body });
}

export type PortableImportMode = "conflict_fail" | "clone";

export interface PortableImportResult {
  importId: string;
  imported: true;
  mutationsApplied: true;
  mode: PortableImportMode;
  bundleSha256: string;
  source: {
    projectId: string;
    revisionId: string;
    revisionHashClaim: string;
    documentRevision: number;
    productSpecificationVersion: number | null;
  };
  project: {
    id: string;
    name: string;
    version: 1;
    revisionId: string;
    snapshotHash: string;
    revisionHash: string;
    schemaVersion: 1 | 2;
    assetCount: number;
    quarantinedAssetCount: number;
    productSpecificationVersion: 1 | null;
  };
  idMapping: Record<string, string>;
  diagnostics: Array<{
    code: string;
    severity: "info" | "warning";
    message: string;
    details?: Record<string, unknown>;
  }>;
  deepLink: string;
}

export async function importPortableProject(
  file: File,
  mode: PortableImportMode,
  idempotencyKey = createClientKey("portable_import"),
): Promise<PortableImportResult> {
  const body = new FormData();
  body.append("file", file);
  return request<PortableImportResult>(`/imports?mode=${encodeURIComponent(mode)}`, {
    method: "POST",
    headers: { "idempotency-key": idempotencyKey },
    body,
  });
}

export interface AgentConnectionRecord {
  id: string;
  adapter: "codex" | "generic_mcp";
  displayName: string;
  status: "pending" | "active" | "expired" | "revoked" | "error";
  scopes: string[];
  projectIds: string[];
  principalId: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationPolicyRecord {
  organizationId: string;
  organizationName: string;
  policy: OrganizationPolicy;
  policyHash: string;
  configurationHash: string;
  source: "default" | "stored" | "legacy_quarantined" | "corrupt_fail_closed";
  diagnostics: Array<{ code: string; severity: "warning" | "error"; message: string }>;
  updatedAt: string;
}

export async function readOrganizationPolicy(): Promise<OrganizationPolicyRecord> {
  const result = await request<{ organizationPolicy: OrganizationPolicyRecord }>("/organization/policy");
  return result.organizationPolicy;
}

export async function updateOrganizationPolicy(
  expectedConfigurationHash: string,
  policy: OrganizationPolicy | Record<string, unknown>,
): Promise<OrganizationPolicyRecord> {
  const result = await request<{ organizationPolicy: OrganizationPolicyRecord }>("/organization/policy", {
    method: "PUT",
    body: JSON.stringify({ expectedConfigurationHash, policy }),
  });
  return result.organizationPolicy;
}

export function organizationConfigurationUrl(): string {
  return `${API_ROOT}/organization/configuration`;
}

export interface AgentPairingChallenge {
  connection: AgentConnectionRecord;
  nonce: string;
  expiresAt: string;
}

export async function listAgentConnections(): Promise<AgentConnectionRecord[]> {
  const result = await request<{ connections?: AgentConnectionRecord[] }>("/agent-connections");
  return result.connections ?? [];
}

const defaultAgentScopes = [
  "organization_policy:read",
  "context:write",
  "design:read",
  "design:preview",
  "design:write",
  "product_spec:read",
  "product_spec:preview",
  "product_spec:write",
  "planning:read",
  "planning:write",
  "task:read",
  "task:create",
  "task:claim",
  "task:update",
  "design_system:read",
  "workspace:inventory:read",
  "workspace:inventory:write",
  "implementation_mapping:read",
  "implementation_mapping:write",
  "handoff:read",
  "redesign:read",
  "redesign:assessment",
  "redesign:review",
  "redesign:interview",
  "redesign:proposal",
  "redesign:design",
  "redesign:handoff",
];

export async function createCodexConnection(): Promise<AgentPairingChallenge> {
  const organizationPolicy = await readOrganizationPolicy();
  const agents = organizationPolicy.policy.agents as {
    enabled?: unknown;
    allowedAdapters?: unknown;
    allowedScopes?: unknown;
    maximumExpirySeconds?: unknown;
    requireProjectRestriction?: unknown;
  } | undefined;
  if (agents?.enabled !== true || !Array.isArray(agents.allowedAdapters) || !agents.allowedAdapters.includes("codex")) {
    throw new ApiError("Codex connections are disabled by organization policy.", { code: "FORBIDDEN", status: 403 });
  }
  const allowedScopes = new Set(Array.isArray(agents.allowedScopes)
    ? agents.allowedScopes.filter((scope): scope is string => typeof scope === "string")
    : []);
  const scopes = defaultAgentScopes.filter((scope) => allowedScopes.has(scope));
  if (scopes.length === 0) {
    throw new ApiError("Organization policy does not allow any Codex workflow scopes.", { code: "FORBIDDEN", status: 403 });
  }
  const maximumExpirySeconds = typeof agents.maximumExpirySeconds === "number"
    ? agents.maximumExpirySeconds
    : 86_400;
  let projectIds: string[] | undefined;
  if (agents.requireProjectRestriction === true) {
    const projects = await listDesigns();
    if (projects.length === 0) {
      throw new ApiError("Organization policy requires a project restriction; create a project before connecting Codex.", {
        code: "FORBIDDEN",
        status: 403,
      });
    }
    projectIds = projects.slice(0, 100).map((project) => project.id);
  }
  return request<AgentPairingChallenge>("/agent-connections", {
    method: "POST",
    body: JSON.stringify({
      adapter: "codex",
      displayName: "Codex — Minimal UI",
      scopes,
      ...(projectIds ? { projectIds } : {}),
      expiresInSeconds: Math.max(300, Math.min(86_400, maximumExpirySeconds)),
      replaceExisting: true,
    }),
  });
}

export async function reconnectAgentConnection(connectionId: string): Promise<AgentPairingChallenge> {
  return request<AgentPairingChallenge>(`/agent-connections/${encodeURIComponent(connectionId)}/reconnect`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function revokeAgentConnection(connectionId: string): Promise<AgentConnectionRecord> {
  return request<AgentConnectionRecord>(`/agent-connections/${encodeURIComponent(connectionId)}/revoke`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function uploadAsset(file: File, designId: string): Promise<{
  url: string;
  operation: DesignOperation;
}> {
  const body = new FormData();
  body.append("file", file);
  const result = await request<Record<string, unknown>>(`/assets?designId=${encodeURIComponent(designId)}`, {
    method: "POST",
    body,
  });
  return {
    url: String(result.url ?? ""),
    operation: normalizeOperations([result.operation as DesignOperation])[0]!,
  };
}

export interface ProductSpecificationRecord {
  version: number;
  naturalLanguageBrief: string;
  specification: Record<string, unknown> | null;
  specificationHash?: string;
  createdAt?: string;
}

function asProductSpecificationRecord(input: unknown): ProductSpecificationRecord {
  const envelope = input as Record<string, unknown> | null;
  const raw = (envelope?.specification && typeof envelope.specification === "object")
    ? envelope.specification as Record<string, unknown>
    : null;
  const naturalLanguageBrief = String(
    envelope?.naturalLanguageBrief
      ?? envelope?.natural_language_brief
      ?? raw?.natural_language_brief
      ?? "",
  );
  return {
    version: Number(envelope?.version ?? raw?.version ?? 0),
    naturalLanguageBrief,
    specification: raw,
    ...(typeof envelope?.specificationHash === "string" ? { specificationHash: envelope.specificationHash } : {}),
    ...(typeof envelope?.createdAt === "string" ? { createdAt: envelope.createdAt } : {}),
  };
}

export async function readProductSpecification(designId: string): Promise<ProductSpecificationRecord> {
  return asProductSpecificationRecord(await request<unknown>(
    `/designs/${encodeURIComponent(designId)}/product-specification`,
  ));
}

export interface ProductSpecificationPreview extends ProductSpecificationRecord {
  previewId: string;
  expiresAt: string;
  canCommit: boolean;
  diagnostics: unknown[];
}

export async function previewProductSpecification(
  designId: string,
  baseVersion: number,
  naturalLanguageBrief: string,
): Promise<ProductSpecificationPreview> {
  const result = await request<Record<string, unknown>>(
    `/designs/${encodeURIComponent(designId)}/product-specification/previews`,
    {
      method: "POST",
      body: JSON.stringify({ baseVersion, naturalLanguageBrief }),
    },
  );
  return {
    ...asProductSpecificationRecord(result),
    previewId: String(result.previewId ?? result.id),
    expiresAt: String(result.expiresAt ?? ""),
    canCommit: Boolean(result.canCommit),
    diagnostics: Array.isArray(result.diagnostics) ? result.diagnostics : [],
  };
}

export async function commitProductSpecification(
  designId: string,
  previewId: string,
  expectedBaseVersion: number,
  idempotencyKey: string,
): Promise<ProductSpecificationRecord> {
  return asProductSpecificationRecord(await request<unknown>(
    `/designs/${encodeURIComponent(designId)}/product-specification/previews/${encodeURIComponent(previewId)}/commit`,
    {
      method: "POST",
      body: JSON.stringify({
        expectedBaseVersion,
        idempotencyKey,
        message: "Update product brief",
      }),
    },
  ));
}

export type AgentTaskStatus =
  | "queued"
  | "claimed"
  | "in_progress"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

export interface AgentTaskTransitionRecord {
  id: string;
  fromStatus: AgentTaskStatus | null;
  toStatus: AgentTaskStatus;
  actorId: string;
  message: string | null;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface AgentTaskRecord {
  id: string;
  status: AgentTaskStatus;
  designId: string;
  baseVersion: number;
  brief: string;
  expectedOutput: string;
  selection: string[];
  claimedBy: string | null;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  transitions: AgentTaskTransitionRecord[];
  launchUrl: string;
}

function asAgentTaskRecord(input: unknown, launchUrl?: string): AgentTaskRecord {
  const task = input as Record<string, unknown>;
  const id = String(task.id);
  const transitions = Array.isArray(task.transitions) ? task.transitions.map((item) => {
    const transition = item as Record<string, unknown>;
    const data = transition.data && typeof transition.data === "object" && !Array.isArray(transition.data)
      ? transition.data as Record<string, unknown>
      : {};
    return {
      id: String(transition.id),
      fromStatus: transition.fromStatus === null || transition.from_status === null
        ? null
        : String(transition.fromStatus ?? transition.from_status) as AgentTaskStatus,
      toStatus: String(transition.toStatus ?? transition.to_status) as AgentTaskStatus,
      actorId: String(transition.actorId ?? transition.actor_id ?? ""),
      message: transition.message === null || transition.message === undefined ? null : String(transition.message),
      data,
      createdAt: String(transition.createdAt ?? transition.created_at ?? ""),
    } satisfies AgentTaskTransitionRecord;
  }) : [];
  return {
    id,
    status: String(task.status ?? transitions.at(-1)?.toStatus ?? "queued") as AgentTaskStatus,
    designId: String(task.designId ?? task.design_id ?? ""),
    baseVersion: Number(task.baseVersion ?? task.base_version ?? 0),
    brief: String(task.brief ?? ""),
    expectedOutput: String(task.expectedOutput ?? task.expected_output ?? "design_preview"),
    selection: Array.isArray(task.selection) ? task.selection.map(String) : [],
    claimedBy: task.claimedBy === null || task.claimed_by === null
      ? null
      : String(task.claimedBy ?? task.claimed_by ?? "") || null,
    createdBy: String(task.createdBy ?? task.created_by ?? ""),
    createdAt: String(task.createdAt ?? task.created_at ?? new Date().toISOString()),
    expiresAt: String(task.expiresAt ?? task.expires_at ?? ""),
    transitions,
    launchUrl: launchUrl ?? String(task.launchUrl ?? task.launch_url ?? `formaspec://connect-agent?task=${encodeURIComponent(id)}`),
  };
}

export function taskPreviewId(task: AgentTaskRecord | null): string | null {
  if (!task || task.expectedOutput !== "design_preview") return null;
  for (let index = task.transitions.length - 1; index >= 0; index -= 1) {
    const previewId = task.transitions[index]?.data.previewId;
    if (typeof previewId === "string" && previewId.length > 0) return previewId;
  }
  return null;
}

export async function createAgentTask(input: {
  designId: string;
  baseVersion: number;
  brief: string;
  selection: string[];
  expectedOutput?: string;
}): Promise<AgentTaskRecord> {
  const result = await request<Record<string, unknown>>(
    `/designs/${encodeURIComponent(input.designId)}/agent-tasks`,
    {
      method: "POST",
      body: JSON.stringify({
        brief: input.brief,
        selection: input.selection,
        baseVersion: input.baseVersion,
        expectedOutput: input.expectedOutput ?? "design_preview",
        idempotencyKey: createClientKey("agent_task"),
      }),
    },
  );
  const task = result.task && typeof result.task === "object" ? result.task : result;
  return asAgentTaskRecord(task, String(result.launchUrl ?? result.launch_url ?? "") || undefined);
}

export async function listAgentTasks(designId: string, limit = 25): Promise<AgentTaskRecord[]> {
  const result = await request<{ tasks?: unknown[] }>(
    `/designs/${encodeURIComponent(designId)}/agent-tasks?limit=${encodeURIComponent(limit)}`,
  );
  return (result.tasks ?? []).map((task) => asAgentTaskRecord(task));
}

export async function transitionAgentTask(input: {
  taskId: string;
  expectedStatus: AgentTaskStatus;
  toStatus: "in_progress" | "awaiting_approval" | "completed" | "failed" | "cancelled" | "expired";
  message?: string;
  data?: Record<string, unknown>;
}): Promise<AgentTaskRecord> {
  const result = await request<{ task?: unknown }>(`/agent-tasks/${encodeURIComponent(input.taskId)}/transition`, {
    method: "POST",
    body: JSON.stringify({
      expectedStatus: input.expectedStatus,
      toStatus: input.toStatus,
      ...(input.message === undefined ? {} : { message: input.message }),
      ...(input.data === undefined ? {} : { data: input.data }),
    }),
  });
  return asAgentTaskRecord(result.task);
}

export interface DesignPreviewDiagnostic {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  nodeId?: string;
  path?: string;
}

export interface DesignPreviewRecord {
  previewId: string;
  designId: string;
  rootBaseVersion: number;
  proposedVersion: number;
  baseRevisionId: string;
  baseSnapshotHash: string;
  operationHash: string;
  resultSnapshotHash: string;
  expiresAt: string;
  canCommit: boolean;
  destructive: boolean;
  kind: "ordinary" | "archive";
  status: "ready" | "blocked" | "expired" | "committed";
  committedRevisionId: string | null;
  changedNodeIds: string[];
  versions: { commandEngine: string; renderer: string; fontBundle: string };
  diagnostics: DesignPreviewDiagnostic[];
  document: DesignDocument;
}

function asDesignPreviewRecord(input: unknown): DesignPreviewRecord {
  const value = input as Record<string, unknown>;
  const rootBaseVersion = Number(value.rootBaseVersion ?? value.root_base_version ?? 0);
  const diagnostics = Array.isArray(value.diagnostics) ? value.diagnostics.map((item) => {
    const diagnostic = item as Record<string, unknown>;
    const severity = String(diagnostic.severity ?? "info");
    return {
      severity: severity === "error" || severity === "warning" ? severity : "info",
      code: String(diagnostic.code ?? "DIAGNOSTIC"),
      message: String(diagnostic.message ?? "Preview diagnostic"),
      ...(diagnostic.nodeId || diagnostic.node_id ? { nodeId: String(diagnostic.nodeId ?? diagnostic.node_id) } : {}),
      ...(diagnostic.path ? { path: String(diagnostic.path) } : {}),
    } satisfies DesignPreviewDiagnostic;
  }) : [];
  const versions = value.versions && typeof value.versions === "object"
    ? value.versions as Record<string, unknown>
    : {};
  return {
    previewId: String(value.previewId ?? value.id),
    designId: String(value.designId ?? value.design_id ?? ""),
    rootBaseVersion,
    proposedVersion: rootBaseVersion + 1,
    baseRevisionId: String(value.baseRevisionId ?? value.base_revision_id ?? ""),
    baseSnapshotHash: String(value.baseSnapshotHash ?? value.base_snapshot_hash ?? ""),
    operationHash: String(value.operationHash ?? value.operation_hash ?? ""),
    resultSnapshotHash: String(value.resultSnapshotHash ?? value.result_snapshot_hash ?? ""),
    expiresAt: String(value.expiresAt ?? value.expires_at ?? ""),
    canCommit: Boolean(value.canCommit ?? value.can_commit),
    destructive: Boolean(value.destructive),
    kind: value.kind === "archive" ? "archive" : "ordinary",
    status: String(value.status ?? "blocked") as DesignPreviewRecord["status"],
    committedRevisionId: value.committedRevisionId === null || value.committed_revision_id === null
      ? null
      : String(value.committedRevisionId ?? value.committed_revision_id ?? "") || null,
    changedNodeIds: (() => {
      const changed = value.changedNodeIds ?? value.changed_node_ids;
      return Array.isArray(changed) ? changed.map(String) : [];
    })(),
    versions: {
      commandEngine: String(versions.commandEngine ?? versions.command_engine ?? ""),
      renderer: String(versions.renderer ?? ""),
      fontBundle: String(versions.fontBundle ?? versions.font_bundle ?? ""),
    },
    diagnostics,
    document: normalizeDocument(value.document),
  };
}

export interface ComponentLibraryBlocker {
  code: "NO_VERIFIED_SOURCE" | "ASSET_COPY_UNAVAILABLE";
  message: string;
}

export interface ComponentLibraryItem {
  definition: ComponentDefinition;
  sourceHash: string | null;
  sourceNodeCount: number;
  prototypeLinkCount: number;
  tokenDependencyIds: string[];
  assetDependencyIds: string[];
  insertable: boolean;
  blockers: ComponentLibraryBlocker[];
}

export interface ComponentLibraryRecord {
  designId: string;
  baseVersion: number;
  designSystemId: string;
  releaseId: string;
  releaseVersion: number;
  releaseName: string;
  components: ComponentLibraryItem[];
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ApiError(`${label} is invalid.`, { code: "INVALID_RESPONSE" });
  }
  return value.map(String);
}

function asComponentLibraryRecord(input: unknown, expectedDesignId: string): ComponentLibraryRecord {
  const envelope = requiredExactRecord(input, ["library"], "Component library response");
  const library = requiredExactRecord(
    envelope.library,
    ["designId", "baseVersion", "designSystemId", "releaseId", "releaseVersion", "releaseName", "components"],
    "Component library",
  );
  const designId = requiredOpaqueId(library.designId, "Component library project ID");
  if (designId !== expectedDesignId) {
    throw new ApiError("Component library does not belong to the requested project.", { code: "INVALID_RESPONSE" });
  }
  if (!Array.isArray(library.components)) {
    throw new ApiError("Component library entries are invalid.", { code: "INVALID_RESPONSE" });
  }
  const components = library.components.map((candidate, index) => {
    const item = requiredExactRecord(
      candidate,
      ["definition", "sourceHash", "sourceNodeCount", "prototypeLinkCount", "tokenDependencyIds", "assetDependencyIds", "insertable", "blockers"],
      `Component library entry ${index + 1}`,
    );
    const sourceHash = item.sourceHash === null
      ? null
      : requiredHash(item.sourceHash, `Component library entry ${index + 1} source hash`);
    if (typeof item.insertable !== "boolean" || !Array.isArray(item.blockers)) {
      throw new ApiError(`Component library entry ${index + 1} availability is invalid.`, { code: "INVALID_RESPONSE" });
    }
    const blockers = item.blockers.map((candidateBlocker, blockerIndex) => {
      const blocker = requiredExactRecord(
        candidateBlocker,
        ["code", "message"],
        `Component library entry ${index + 1} blocker ${blockerIndex + 1}`,
      );
      const code = requiredString(blocker.code, "Component library blocker code");
      if (code !== "NO_VERIFIED_SOURCE" && code !== "ASSET_COPY_UNAVAILABLE") {
        throw new ApiError("Component library blocker code is invalid.", { code: "INVALID_RESPONSE" });
      }
      return {
        code: code as ComponentLibraryBlocker["code"],
        message: requiredString(blocker.message, "Component library blocker message"),
      };
    });
    if (item.insertable === (blockers.length > 0)) {
      throw new ApiError(`Component library entry ${index + 1} availability is inconsistent.`, { code: "INVALID_RESPONSE" });
    }
    return {
      definition: ComponentDefinitionSchema.parse(item.definition),
      sourceHash,
      sourceNodeCount: requiredNonnegativeInteger(item.sourceNodeCount, "Component source node count"),
      prototypeLinkCount: requiredNonnegativeInteger(item.prototypeLinkCount, "Component prototype-link count"),
      tokenDependencyIds: stringArray(item.tokenDependencyIds, "Component token dependencies"),
      assetDependencyIds: stringArray(item.assetDependencyIds, "Component asset dependencies"),
      insertable: item.insertable,
      blockers,
    } satisfies ComponentLibraryItem;
  });
  return {
    designId,
    baseVersion: requiredPositiveInteger(library.baseVersion, "Component library base version"),
    designSystemId: requiredOpaqueId(library.designSystemId, "Component library design-system ID"),
    releaseId: requiredOpaqueId(library.releaseId, "Component library release ID"),
    releaseVersion: requiredPositiveInteger(library.releaseVersion, "Component library release version"),
    releaseName: requiredString(library.releaseName, "Component library release name"),
    components,
  };
}

export async function readComponentLibrary(designId: string): Promise<ComponentLibraryRecord> {
  return asComponentLibraryRecord(
    await request<unknown>(`/designs/${encodeURIComponent(designId)}/component-library`),
    designId,
  );
}

export interface ComponentInsertionPreviewRecord extends DesignPreviewRecord {
  component: {
    designSystemId: string;
    releaseId: string;
    releaseVersion: number;
    componentDefinitionId: string;
    componentVersion: number;
    sourceHash: string;
    activeState: ComponentDefinition["states"][number]["key"];
    instanceId: string;
    nodeIdMapping: Record<string, string>;
  };
}

export async function createComponentInsertionPreview(input: {
  designId: string;
  baseVersion: number;
  componentDefinitionId: string;
  parent: ParentReference;
  activeState?: ComponentDefinition["states"][number]["key"];
  index?: number;
  position?: { x: number; y: number };
  name?: string;
}): Promise<ComponentInsertionPreviewRecord> {
  const response = await request<unknown>(
    `/designs/${encodeURIComponent(input.designId)}/component-insertion-previews`,
    {
      method: "POST",
      body: JSON.stringify({
        baseVersion: input.baseVersion,
        componentDefinitionId: input.componentDefinitionId,
        parent: input.parent,
        ...(input.activeState === undefined ? {} : { activeState: input.activeState }),
        ...(input.index === undefined ? {} : { index: input.index }),
        ...(input.position === undefined ? {} : { position: input.position }),
        ...(input.name === undefined ? {} : { name: input.name }),
      }),
    },
  );
  const value = requiredRecord(response, "Component insertion preview response");
  const component = requiredExactRecord(
    value.component,
    ["designSystemId", "releaseId", "releaseVersion", "componentDefinitionId", "componentVersion", "sourceHash", "activeState", "instanceId", "nodeIdMapping"],
    "Component insertion preview metadata",
  );
  const nodeIdMapping = requiredRecord(component.nodeIdMapping, "Component insertion node-ID mapping");
  const activeState = requiredString(component.activeState, "Component insertion active state");
  if (!["default", "hover", "pressed", "focused", "disabled", "loading", "error", "selected"].includes(activeState)) {
    throw new ApiError("Component insertion active state is invalid.", { code: "INVALID_RESPONSE" });
  }
  return {
    ...asDesignPreviewRecord(value),
    component: {
      designSystemId: requiredOpaqueId(component.designSystemId, "Component insertion design-system ID"),
      releaseId: requiredOpaqueId(component.releaseId, "Component insertion release ID"),
      releaseVersion: requiredPositiveInteger(component.releaseVersion, "Component insertion release version"),
      componentDefinitionId: requiredOpaqueId(component.componentDefinitionId, "Component insertion definition ID"),
      componentVersion: requiredPositiveInteger(component.componentVersion, "Component insertion component version"),
      sourceHash: requiredHash(component.sourceHash, "Component insertion source hash"),
      activeState: activeState as ComponentInsertionPreviewRecord["component"]["activeState"],
      instanceId: requiredOpaqueId(component.instanceId, "Component insertion instance ID"),
      nodeIdMapping: Object.fromEntries(Object.entries(nodeIdMapping).map(([sourceId, targetId]) => [
        sourceId,
        requiredOpaqueId(targetId, `Component insertion node mapping for ${sourceId}`),
      ])),
    },
  };
}

export async function commitComponentInsertionPreview(input: {
  designId: string;
  previewId: string;
  expectedBaseVersion: number;
  idempotencyKey: string;
  message?: string;
}): Promise<CommitResult> {
  const result = await request<Record<string, unknown>>(
    `/designs/${encodeURIComponent(input.designId)}/previews/${encodeURIComponent(input.previewId)}/commit`,
    {
      method: "POST",
      body: JSON.stringify({
        expectedBaseVersion: input.expectedBaseVersion,
        idempotencyKey: input.idempotencyKey,
        message: input.message ?? "Insert verified design-system component",
      }),
    },
  );
  return {
    version: Number(result.version ?? result.revision ?? input.expectedBaseVersion + 1),
    ...(result.revisionId || result.revision_id ? { revisionId: String(result.revisionId ?? result.revision_id) } : {}),
    ...(result.document ? { document: normalizeDocument(result.document) } : {}),
  };
}

export async function readDesignPreview(
  designId: string,
  previewId: string,
  taskId: string,
): Promise<DesignPreviewRecord> {
  const query = new URLSearchParams({ taskId });
  return asDesignPreviewRecord(await request<unknown>(
    `/designs/${encodeURIComponent(designId)}/previews/${encodeURIComponent(previewId)}?${query}`,
  ));
}

export async function commitDesignPreview(input: {
  designId: string;
  previewId: string;
  taskId: string;
  expectedBaseVersion: number;
  idempotencyKey: string;
  message: string;
  kind: "ordinary" | "archive";
}): Promise<CommitResult> {
  const previewPath = input.kind === "archive" ? "archive-previews" : "previews";
  const result = await request<Record<string, unknown>>(
    `/designs/${encodeURIComponent(input.designId)}/${previewPath}/${encodeURIComponent(input.previewId)}/commit`,
    {
      method: "POST",
      body: JSON.stringify({
        expectedBaseVersion: input.expectedBaseVersion,
        idempotencyKey: input.idempotencyKey,
        message: input.message,
        taskId: input.taskId,
      }),
    },
  );
  return {
    version: Number(result.version ?? result.revision ?? input.expectedBaseVersion + 1),
    ...(result.revisionId || result.revision_id ? { revisionId: String(result.revisionId ?? result.revision_id) } : {}),
    ...(result.document ? { document: normalizeDocument(result.document) } : {}),
  };
}

export interface RevisionInspectNode {
  id: string;
  name: string;
  type: string;
  archived: boolean;
  visible: boolean;
  locked: boolean;
  boundingBox: { x: number; y: number; width: number; height: number; rotation: number };
  layout: Record<string, unknown>;
  style: Record<string, unknown>;
  resolvedValues: { layout: unknown; style: unknown };
  tokenReferences: Array<{
    tokenId: string;
    tokenPath: string | null;
    jsonPath: string;
    status: "resolved" | "missing" | "archived" | "cycle";
    value: unknown;
    path: string[];
  }>;
  semantics: Record<string, unknown> | null;
  properties: Record<string, unknown>;
  metadata: Record<string, unknown>;
  jsonPath: string;
}

export interface RevisionInspectEvidence {
  tokens: Array<{
    id: string;
    name: string;
    path: string;
    family: string;
    layer: string;
    rawValue: unknown;
    resolvedValue: unknown;
    resolutionStatus: string;
    resolutionPath: string[];
    modes: Record<string, unknown>;
    archived: boolean;
    deprecated: boolean;
    jsonPath: string;
  }>;
  assets: Array<{
    id: string;
    name: string;
    kind: string;
    mimeType: string;
    sizeBytes: number;
    width: number | null;
    height: number | null;
    sha256: string | null;
    status: string;
    displayFilename: string;
    jsonPath: string;
  }>;
  components: Array<{
    id: string;
    key: string;
    name: string;
    version: number;
    status: string;
    rootNodeId: string | null;
    instanceCount: number;
    platformMappings: unknown[];
    jsonPath: string;
  }>;
  businessRules: Array<Record<string, unknown> & { jsonPath: string }>;
  acceptanceCriteria: Array<Record<string, unknown> & { jsonPath: string }>;
  implementationMappings: Array<{
    id: string;
    source: "document" | "revision";
    targetType: string;
    sourceId: string;
    platform: string;
    symbol: string;
    connectionId: string | null;
    inventoryId: string | null;
    mappingVersion: number | null;
    notes: string | null;
    details: unknown;
    jsonPath: string;
    createdBy?: string;
    createdAt?: string;
  }>;
}

export interface RevisionInspectResult {
  project: DesignProjectSummary;
  head: { version: number; revisionId: string };
  revision: {
    id: string;
    version: number;
    parentRevisionId: string | null;
    revisionHash: string;
    snapshotHash: string;
    operationHash: string;
    message: string | null;
    createdAt: string;
  };
  integrity: {
    revisionId: string;
    parentRevisionId: string | null;
    revisionHash: string;
    snapshotHash: string;
    operationHash: string;
    schemaVersion: number;
    documentRevision: number;
    createdAt: string;
  };
  document: AnyDesignDocument;
  nodes: RevisionInspectNode[];
  tokens: Record<string, unknown>;
  assets: Record<string, unknown>;
  prototypeLinks: Record<string, unknown>;
  productSpecification: {
    source: "document" | "revision_link";
    version: number;
    specificationHash: string;
    specification: Record<string, unknown>;
    jsonPath: string;
  } | null;
  evidence: RevisionInspectEvidence;
  limitations: string[];
}

export async function readRevisionInspect(projectId: string, revisionId: string): Promise<RevisionInspectResult> {
  const result = await request<RevisionInspectResult>(
    `/projects/${encodeURIComponent(projectId)}/revisions/${encodeURIComponent(revisionId)}/inspect`,
  );
  return {
    ...result,
    project: asProjectSummary(result.project),
  };
}

export interface PlanningAnswerRecord {
  id: string;
  section: string;
  version: number;
  answer: string;
  actor_id: string;
  created_at: string;
}

export interface PlanningSessionRecord {
  session: {
    id: string;
    project_id: string;
    version: number;
    status: "draft" | "in_progress" | "ready_for_review" | "completed" | "cancelled";
    current_section: string;
    answers: PlanningAnswerRecord[];
    created_at: string;
    updated_at: string;
  };
  versions: Array<Record<string, unknown>>;
  answeredSections: string[];
  sectionCount: 22;
}

export async function listPlanningSessions(designId: string): Promise<PlanningSessionRecord[]> {
  const result = await request<{ sessions?: PlanningSessionRecord[] }>(
    `/designs/${encodeURIComponent(designId)}/planning-sessions`,
  );
  return result.sessions ?? [];
}

export async function createPlanningSession(designId: string): Promise<PlanningSessionRecord> {
  return request<PlanningSessionRecord>(`/designs/${encodeURIComponent(designId)}/planning-sessions`, {
    method: "POST",
    body: JSON.stringify({ idempotencyKey: createClientKey("planning") }),
  });
}

export async function savePlanningAnswer(input: {
  sessionId: string;
  expectedVersion: number;
  section: string;
  answer: string;
  nextSection?: string;
  status?: "in_progress" | "ready_for_review";
}): Promise<PlanningSessionRecord> {
  return request<PlanningSessionRecord>(`/planning-sessions/${encodeURIComponent(input.sessionId)}/answers`, {
    method: "POST",
    body: JSON.stringify({
      expectedVersion: input.expectedVersion,
      section: input.section,
      answer: input.answer,
      ...(input.nextSection ? { nextSection: input.nextSection } : {}),
      ...(input.status ? { status: input.status } : {}),
    }),
  });
}

export async function transitionPlanningSession(input: {
  sessionId: string;
  expectedVersion: number;
  status: "in_progress" | "ready_for_review" | "completed" | "cancelled";
  currentSection?: string;
}): Promise<PlanningSessionRecord> {
  return request<PlanningSessionRecord>(`/planning-sessions/${encodeURIComponent(input.sessionId)}/transition`, {
    method: "POST",
    body: JSON.stringify({
      expectedVersion: input.expectedVersion,
      status: input.status,
      ...(input.currentSection ? { currentSection: input.currentSection } : {}),
    }),
  });
}

export interface ServerEvent {
  type: "design.updated" | "context.updated" | "asset.created" | string;
  designId?: string;
  version?: number;
  data?: unknown;
}

export function subscribeToEvents(onEvent: (event: ServerEvent) => void): () => void {
  const source = new EventSource("/api/events");
  const forward = (event: MessageEvent<string>) => {
    try {
      const data = JSON.parse(event.data) as Record<string, unknown>;
      onEvent({
        type: String(data.type ?? event.type),
        ...(data.designId || data.design_id ? { designId: String(data.designId ?? data.design_id) } : {}),
        ...(data.version || data.revision ? { version: Number(data.version ?? data.revision) } : {}),
        data,
      });
    } catch {
      onEvent({ type: event.type, data: event.data });
    }
  };
  source.onmessage = forward;
  for (const type of [
    "design.updated",
    "context.updated",
    "asset.created",
    "product_spec.preview.updated",
    "product_spec.committed",
    "planning_session.updated",
    "agent_task.transitioned",
    "agent_connection.changed",
    "design_system.changed",
    "repository_inventory.changed",
    "implementation_mapping.changed",
    "handoff.transitioned",
    "redesign.transitioned",
    "backup.operation",
    "audit.retention",
    "events.gap",
  ]) {
    source.addEventListener(type, forward as EventListener);
  }
  return () => source.close();
}

export interface DesignSystemRecord {
  id: string;
  name: string;
  description: string;
  status: "active" | "archived";
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export async function listDesignSystems(includeArchived = false): Promise<DesignSystemRecord[]> {
  const result = await request<{ designSystems?: DesignSystemRecord[] }>(
    `/design-systems?includeArchived=${includeArchived ? "true" : "false"}`,
  );
  return result.designSystems ?? [];
}

export async function createOrganizationDesignSystem(input: {
  name: string;
  description?: string;
}): Promise<DesignSystemRecord> {
  const result = await request<{ designSystem: DesignSystemRecord }>("/design-systems", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return result.designSystem;
}

export interface DesignSystemDiagnosticRecord {
  code: string;
  severity: "info" | "warning" | "error";
  safety: "safe" | "review_required" | "blocked";
  message: string;
  entityKind?: "release" | "token" | "component" | "project";
  entityId?: string;
  path?: string;
}

export interface ComponentDefinitionVersionRecord {
  designSystemId: string;
  componentId: string;
  version: number;
  status: "draft" | "published" | "deprecated";
  definition: ComponentDefinition;
  source: {
    kind: "verified";
    hash: string;
    nodeCount: number;
    prototypeLinkCount: number;
    publishable: true;
  } | {
    kind: "legacy_null";
    hash: null;
    nodeCount: 0;
    prototypeLinkCount: 0;
    publishable: false;
  };
  createdBy: string;
  createdAt: string;
}

export interface ComponentDefinitionCatalogRecord extends ComponentDefinitionVersionRecord {
  isLatest: boolean;
  versionCount: number;
  replacement: {
    componentId: string;
    version: number;
    status: "draft" | "published" | "deprecated";
    name: string;
  } | null;
  diagnostics: DesignSystemDiagnosticRecord[];
}

export interface ComponentAuthoringPermissions {
  designSystemId: string;
  canAuthorComponents: boolean;
}

export interface DesignSystemComponentCatalog {
  components: ComponentDefinitionCatalogRecord[];
  permissions: ComponentAuthoringPermissions;
}

export interface ComponentSourceReference {
  designId: string;
  revisionId: string;
}

export type ComponentDefinitionSubmission = Omit<ComponentDefinition, "id"> & { id?: string };

export async function readDesignSystemComponentCatalog(
  designSystemId: string,
  includeHistory = false,
): Promise<DesignSystemComponentCatalog> {
  const result = await request<{
    components?: ComponentDefinitionCatalogRecord[];
    permissions?: ComponentAuthoringPermissions;
  }>(
    `/design-systems/${encodeURIComponent(designSystemId)}/components?includeHistory=${includeHistory ? "true" : "false"}`,
  );
  return {
    components: result.components ?? [],
    permissions: {
      designSystemId,
      canAuthorComponents: result.permissions?.canAuthorComponents === true,
    },
  };
}

export async function listDesignSystemComponents(
  designSystemId: string,
  includeHistory = false,
): Promise<ComponentDefinitionCatalogRecord[]> {
  return (await readDesignSystemComponentCatalog(designSystemId, includeHistory)).components;
}

export async function createDesignSystemComponentDraft(input: {
  designSystemId: string;
  expectedLatestVersion: number;
  definition: ComponentDefinitionSubmission;
  source: ComponentSourceReference;
}): Promise<ComponentDefinitionVersionRecord> {
  if (input.definition.status !== "draft") {
    throw new ApiError("A component authoring submission must create a draft version.", {
      code: "VALIDATION_FAILED",
      status: 422,
    });
  }
  const result = await request<{ componentVersion: ComponentDefinitionVersionRecord }>(
    `/design-systems/${encodeURIComponent(input.designSystemId)}/components`,
    {
      method: "POST",
      body: JSON.stringify({
        expectedLatestVersion: input.expectedLatestVersion,
        definition: input.definition,
        source: input.source,
      }),
    },
  );
  return result.componentVersion;
}

export async function transitionDesignSystemComponent(input: {
  designSystemId: string;
  componentId: string;
  expectedLatestVersion: number;
  targetStatus: "published" | "deprecated";
  replacementComponentId?: string | null;
  source: ComponentSourceReference;
}): Promise<ComponentDefinitionVersionRecord> {
  const result = await request<{ componentVersion: ComponentDefinitionVersionRecord }>(
    `/design-systems/${encodeURIComponent(input.designSystemId)}/components/${encodeURIComponent(input.componentId)}/lifecycle`,
    {
      method: "POST",
      body: JSON.stringify({
        expectedLatestVersion: input.expectedLatestVersion,
        targetStatus: input.targetStatus,
        source: input.source,
        ...(input.replacementComponentId !== undefined
          ? { replacementComponentId: input.replacementComponentId }
          : {}),
      }),
    },
  );
  return result.componentVersion;
}

export interface DesignSystemReleaseRecord {
  id: string;
  designSystemId: string;
  version: number;
  name: string;
  status: "draft" | "published" | "deprecated";
  tokenVersions: Array<{ tokenId: string; version: number }>;
  componentVersions: Array<{ componentDefinitionId: string; version: number }>;
  diagnostics: DesignSystemDiagnosticRecord[];
  createdBy: string;
  createdAt: string;
  publishedAt: string | null;
}

export interface ProjectDesignSystemPinRecord {
  designId: string;
  designSystemId: string;
  releaseId: string;
  releaseVersion: number;
  pinnedBy: string;
  pinnedAt: string;
}

export interface DesignSystemUpgradePreviewRecord {
  id: string;
  designId: string;
  currentReleaseId: string;
  targetReleaseId: string;
  designVersion: number;
  designRevisionId: string;
  baseRevisionId: string | null;
  baseSnapshotHash: string | null;
  resultSnapshotHash: string | null;
  diagnostics: DesignSystemDiagnosticRecord[];
  previewHash: string;
  status: "ready" | "blocked" | "committed" | "expired";
  canCommit: boolean;
  createdAt: string;
  expiresAt: string;
  committedAt: string | null;
}

export async function listDesignSystemReleases(designSystemId: string): Promise<DesignSystemReleaseRecord[]> {
  const result = await request<{ releases?: DesignSystemReleaseRecord[] }>(
    `/design-systems/${encodeURIComponent(designSystemId)}/releases`,
  );
  return result.releases ?? [];
}

export async function readProjectDesignSystemPin(designId: string): Promise<ProjectDesignSystemPinRecord> {
  const result = await request<{ pin: ProjectDesignSystemPinRecord }>(
    `/designs/${encodeURIComponent(designId)}/design-system-pin`,
  );
  return result.pin;
}

export async function pinProjectDesignSystem(input: {
  designId: string;
  releaseId: string;
  expectedCurrentReleaseId: string | null;
}): Promise<ProjectDesignSystemPinRecord> {
  const result = await request<{ pin: ProjectDesignSystemPinRecord }>(
    `/designs/${encodeURIComponent(input.designId)}/design-system-pin`,
    {
      method: "PUT",
      body: JSON.stringify({
        releaseId: input.releaseId,
        expectedCurrentReleaseId: input.expectedCurrentReleaseId,
      }),
    },
  );
  return result.pin;
}

export async function previewProjectDesignSystemUpgrade(input: {
  designId: string;
  targetReleaseId: string;
}): Promise<DesignSystemUpgradePreviewRecord> {
  const result = await request<{ preview: DesignSystemUpgradePreviewRecord }>(
    `/designs/${encodeURIComponent(input.designId)}/design-system-upgrade-previews`,
    { method: "POST", body: JSON.stringify({ targetReleaseId: input.targetReleaseId }) },
  );
  return result.preview;
}

export async function commitProjectDesignSystemUpgrade(input: {
  previewId: string;
  expectedPreviewHash: string;
}): Promise<{ preview: DesignSystemUpgradePreviewRecord; pin: ProjectDesignSystemPinRecord }> {
  return request<{ preview: DesignSystemUpgradePreviewRecord; pin: ProjectDesignSystemPinRecord }>(
    `/design-system-upgrade-previews/${encodeURIComponent(input.previewId)}/commit`,
    {
      method: "POST",
      body: JSON.stringify({ expectedPreviewHash: input.expectedPreviewHash }),
    },
  );
}

export interface RepositoryInventorySummary {
  id: string;
  repositoryFingerprint: string;
  inventoryHash: string;
  status: "active" | "superseded" | "revoked";
  platforms: string[];
  entityCount: number;
  scannedFileCount: number;
  skippedFileCount: number;
  truncated: boolean;
  createdBy: string;
  createdAt: string;
  revokedAt: string | null;
}

export interface RepositoryInventoryRecord extends Omit<RepositoryInventorySummary, "platforms" | "entityCount" | "scannedFileCount" | "skippedFileCount" | "truncated"> {
  inventory: {
    schemaVersion: 1;
    repositoryFingerprint: string;
    platforms: string[];
    scannedFileCount: number;
    skippedFileCount: number;
    truncated: boolean;
    entities: Array<{ id: string; kind: string; name: string; symbol: string | null; locationId: string; line: number | null }>;
  };
}

export async function listRepositoryInventories(): Promise<RepositoryInventorySummary[]> {
  const result = await request<{ inventories?: RepositoryInventorySummary[] }>("/repository-inventories?limit=50");
  return result.inventories ?? [];
}

export async function readRepositoryInventory(inventoryId: string): Promise<RepositoryInventoryRecord> {
  const result = await request<{ inventory: RepositoryInventoryRecord }>(
    `/repository-inventories/${encodeURIComponent(inventoryId)}`,
  );
  return result.inventory;
}

export type ImplementationMappingEntityKind = "component" | "token" | "screen" | "asset" | "flow" | "business_rule";

export interface ImplementationMappingRecord {
  id: string;
  designId: string;
  revisionId: string;
  designVersion: number;
  snapshotHash: string;
  revisionHash: string;
  productSpecificationVersion: number;
  productSpecificationHash: string;
  productSpecificationSource: "document" | "revision_link";
  inventoryId: string;
  inventoryHash: string;
  entityKind: ImplementationMappingEntityKind;
  entityId: string;
  platform: "web" | "android" | "ios" | "flutter" | "react_native" | "other";
  symbol: string;
  inventoryEntityId: string;
  inventoryEntityKind: string;
  locationId: string;
  line: number | null;
  createdBy: string;
  createdAt: string;
}

export async function listImplementationMappings(input: {
  designId: string;
  revisionId?: string;
  entityKind?: ImplementationMappingEntityKind;
  entityId?: string;
  inventoryId?: string;
  limit?: number;
}): Promise<ImplementationMappingRecord[]> {
  const query = new URLSearchParams();
  if (input.revisionId) query.set("revisionId", input.revisionId);
  if (input.entityKind) query.set("entityKind", input.entityKind);
  if (input.entityId) query.set("entityId", input.entityId);
  if (input.inventoryId) query.set("inventoryId", input.inventoryId);
  query.set("limit", String(input.limit ?? 200));
  const result = await request<{ mappings?: ImplementationMappingRecord[] }>(
    `/designs/${encodeURIComponent(input.designId)}/implementation-mappings?${query}`,
  );
  return result.mappings ?? [];
}

export async function createImplementationMappings(input: {
  designId: string;
  revisionId: string;
  expectedDesignVersion: number;
  inventoryId: string;
  idempotencyKey?: string;
  mappings: Array<{
    entityKind: ImplementationMappingEntityKind;
    entityId: string;
    inventoryEntityId: string;
  }>;
}): Promise<{ mappings: ImplementationMappingRecord[] }> {
  const result = await request<{ result: { mappings: ImplementationMappingRecord[] } }>(
    `/designs/${encodeURIComponent(input.designId)}/implementation-mappings`,
    {
      method: "POST",
      body: JSON.stringify({
        revisionId: input.revisionId,
        expectedDesignVersion: input.expectedDesignVersion,
        inventoryId: input.inventoryId,
        idempotencyKey: input.idempotencyKey ?? createClientKey("implementation-mapping"),
        mappings: input.mappings,
      }),
    },
  );
  return result.result;
}

export interface EngineeringHandoffRecord {
  id: string;
  designId: string;
  revisionId: string;
  designVersion: number;
  inventoryId: string;
  status: "draft" | "in_review" | "approved" | "implementing" | "completed" | "cancelled";
  currentVersion: number;
  specification: Record<string, unknown>;
  versions: Array<Record<string, unknown>>;
  transitions: Array<Record<string, unknown>>;
  executionDecisions: HandoffExecutionDecisionRecord[];
  executionDecisionState: HandoffExecutionDecisionState;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export const HANDOFF_EXECUTION_DECISION_KINDS = [
  "plan_approval",
  "isolation_choice",
  "diff_review",
  "validation_approval",
  "commit_approval",
  "push_authorization",
  "pull_request_request",
] as const;

export type HandoffExecutionDecisionKind = (typeof HANDOFF_EXECUTION_DECISION_KINDS)[number];
export type HandoffExecutionDecisionOutcome =
  | "approved"
  | "branch"
  | "worktree"
  | "authorized"
  | "requested"
  | "not_requested"
  | "denied"
  | "revoked";

export type HandoffValidationCheck =
  | "typecheck"
  | "unit_tests"
  | "integration_tests"
  | "build"
  | "lint"
  | "visual_regression"
  | "accessibility";

export interface HandoffExecutionDecisionRecord {
  id: string;
  handoffId: string;
  handoffVersion: number;
  sequence: number;
  kind: HandoffExecutionDecisionKind;
  outcome: HandoffExecutionDecisionOutcome;
  supersedesDecisionId: string | null;
  evidence: Record<string, unknown>;
  evidenceHash: string;
  actorId: string;
  createdAt: string;
}

export type HandoffExecutionDecisionState = Record<
  HandoffExecutionDecisionKind,
  HandoffExecutionDecisionRecord | null
>;

interface HandoffExecutionDecisionBase {
  expectedVersion: number;
  expectedPriorDecisionId: string | null;
  idempotencyKey: string;
}

type HandoffDeniedOrRevokedDecision = HandoffExecutionDecisionBase & {
  kind: HandoffExecutionDecisionKind;
  outcome: "denied" | "revoked";
  evidence: { reason: string };
};

export type HandoffExecutionDecisionRequest =
  | (HandoffExecutionDecisionBase & {
    kind: "plan_approval";
    outcome: "approved";
    evidence: { summary: string; acceptanceCriteriaConfirmed: true; implementationPlanConfirmed: true };
  })
  | (HandoffExecutionDecisionBase & {
    kind: "isolation_choice";
    outcome: "branch" | "worktree";
    evidence: { summary: string };
  })
  | (HandoffExecutionDecisionBase & {
    kind: "diff_review";
    outcome: "approved";
    evidence: { summary: string; diffHash: string; changedFileCount: number };
  })
  | (HandoffExecutionDecisionBase & {
    kind: "validation_approval";
    outcome: "approved";
    evidence: {
      summary: string;
      checks: Array<{ name: HandoffValidationCheck; status: "passed"; evidenceHash?: string }>;
    };
  })
  | (HandoffExecutionDecisionBase & {
    kind: "commit_approval";
    outcome: "approved";
    evidence: { summary: string; diffHash: string; commitMessage: string };
  })
  | (HandoffExecutionDecisionBase & {
    kind: "push_authorization";
    outcome: "authorized";
    evidence: { summary: string; commitHash: string; targetRef: string };
  })
  | (HandoffExecutionDecisionBase & {
    kind: "pull_request_request";
    outcome: "requested";
    evidence: { summary: string; title: string; baseRef: string; headRef: string };
  })
  | (HandoffExecutionDecisionBase & {
    kind: "pull_request_request";
    outcome: "not_requested";
    evidence: { reason: string };
  })
  | HandoffDeniedOrRevokedDecision;

export interface HandoffExecutionDecisionReadResult {
  decisions: HandoffExecutionDecisionRecord[];
  current: HandoffExecutionDecisionState;
}

export async function listEngineeringHandoffs(designId: string): Promise<EngineeringHandoffRecord[]> {
  const result = await request<{ handoffs?: EngineeringHandoffRecord[] }>(
    `/designs/${encodeURIComponent(designId)}/handoffs`,
  );
  return result.handoffs ?? [];
}

export async function readEngineeringHandoff(handoffId: string): Promise<EngineeringHandoffRecord> {
  const result = await request<{ handoff: EngineeringHandoffRecord }>(
    `/handoffs/${encodeURIComponent(handoffId)}`,
  );
  return result.handoff;
}

export async function createEngineeringHandoff(input: {
  designId: string;
  revisionId: string;
  expectedDesignVersion: number;
  inventoryId: string;
  specification: Record<string, unknown>;
}): Promise<EngineeringHandoffRecord> {
  const result = await request<{ handoff: EngineeringHandoffRecord }>(
    `/designs/${encodeURIComponent(input.designId)}/handoffs`,
    {
      method: "POST",
      body: JSON.stringify({
        revisionId: input.revisionId,
        expectedDesignVersion: input.expectedDesignVersion,
        inventoryId: input.inventoryId,
        specification: input.specification,
      }),
    },
  );
  return result.handoff;
}

export async function submitEngineeringHandoff(handoffId: string, expectedVersion: number): Promise<EngineeringHandoffRecord> {
  const result = await request<{ handoff: EngineeringHandoffRecord }>(
    `/handoffs/${encodeURIComponent(handoffId)}/submit-review`,
    {
      method: "POST",
      body: JSON.stringify({
        expectedVersion,
        summary: "Submit the exact revision-pinned handoff for human review.",
      }),
    },
  );
  return result.handoff;
}

export async function approveEngineeringHandoff(
  handoffId: string,
  expectedVersion: number,
  expectedPriorDecisionId: string | null,
  summary: string,
): Promise<EngineeringHandoffRecord> {
  const result = await request<{ handoff: EngineeringHandoffRecord }>(
    `/handoffs/${encodeURIComponent(handoffId)}/approve`,
    {
      method: "POST",
      body: JSON.stringify({
        expectedVersion,
        expectedPriorDecisionId,
        decision: "approved",
        summary,
        acceptanceCriteriaConfirmed: true,
        implementationPlanConfirmed: true,
      }),
    },
  );
  return result.handoff;
}

export async function readHandoffExecutionDecisions(
  handoffId: string,
): Promise<HandoffExecutionDecisionReadResult> {
  return request<HandoffExecutionDecisionReadResult>(
    `/handoffs/${encodeURIComponent(handoffId)}/execution-decisions`,
  );
}

export async function recordHandoffExecutionDecision(
  handoffId: string,
  decision: HandoffExecutionDecisionRequest,
): Promise<HandoffExecutionDecisionRecord> {
  const result = await request<{ decision: HandoffExecutionDecisionRecord }>(
    `/handoffs/${encodeURIComponent(handoffId)}/execution-decisions`,
    { method: "POST", body: JSON.stringify(decision) },
  );
  return result.decision;
}

export async function startEngineeringHandoffImplementation(
  handoffId: string,
  expectedVersion: number,
): Promise<EngineeringHandoffRecord> {
  const result = await request<{ handoff: EngineeringHandoffRecord }>(
    `/handoffs/${encodeURIComponent(handoffId)}/start-implementation`,
    {
      method: "POST",
      body: JSON.stringify({
        expectedVersion,
        approvedVersion: expectedVersion,
        authorization: "start_implementation",
      }),
    },
  );
  return result.handoff;
}

export async function completeEngineeringHandoff(
  handoffId: string,
  expectedVersion: number,
  summary: string,
): Promise<EngineeringHandoffRecord> {
  const result = await request<{ handoff: EngineeringHandoffRecord }>(
    `/handoffs/${encodeURIComponent(handoffId)}/complete`,
    {
      method: "POST",
      body: JSON.stringify({ expectedVersion, summary }),
    },
  );
  return result.handoff;
}

export const REDESIGN_STAGE_ORDER = [
  "connect_inspect",
  "document_current_state",
  "pm_interview",
  "future_state_proposal",
  "design",
  "handoff",
  "approved_implementation",
] as const;

export type RedesignStage = (typeof REDESIGN_STAGE_ORDER)[number];

export interface RedesignAssessmentRecord {
  id: string;
  organizationId: string;
  designId: string | null;
  inventoryId: string | null;
  status: "active" | "completed" | "cancelled";
  currentStage: RedesignStage;
  currentVersion: number;
  sourceMutation: "none";
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  current: {
    version: number;
    stage: RedesignStage;
    sourceMutation: "none";
    brief: string;
    base: { designVersion: number | null; revisionId: string | null; inventoryId: string | null };
    content: Record<string, unknown>;
    artifact: RedesignStageArtifact;
    actorId: string;
    createdAt: string;
  };
  stageArtifacts: RedesignStageArtifactMap;
  versions: Array<{
    version: number;
    stage: RedesignStage;
    content: Record<string, unknown>;
    artifact: RedesignStageArtifact;
    actorId: string;
    createdAt: string;
  }>;
  transitions: Array<{
    id: string;
    fromStage: RedesignStage | null;
    toStage: RedesignStage;
    decision: string;
    createdAt: string;
  }>;
}

export interface RedesignStageArtifactRecord {
  assessmentId: string;
  stage: RedesignStage;
  headVersion: number;
  sourceMutation: "none";
  current: {
    assessmentVersion: number;
    stage: RedesignStage;
    artifact: RedesignStageArtifact;
    actorId: string;
    createdAt: string;
  } | null;
  versions: Array<{
    assessmentVersion: number;
    stage: RedesignStage;
    artifact: RedesignStageArtifact;
    actorId: string;
    createdAt: string;
  }>;
}

export async function createRedesignAssessment(input: {
  designId: string;
  inventoryId: string;
  expectedDesignVersion: number;
  brief: string;
}): Promise<RedesignAssessmentRecord> {
  const result = await request<{ assessment: RedesignAssessmentRecord }>("/redesign-assessments", {
    method: "POST",
    body: JSON.stringify({
      designId: input.designId,
      inventoryId: input.inventoryId,
      expectedDesignVersion: input.expectedDesignVersion,
      brief: input.brief,
      content: { assessmentRequested: true },
    }),
  });
  return result.assessment;
}

export async function readRedesignAssessment(assessmentId: string): Promise<RedesignAssessmentRecord> {
  const result = await request<{ assessment: RedesignAssessmentRecord }>(
    `/redesign-assessments/${encodeURIComponent(assessmentId)}`,
  );
  return result.assessment;
}

export async function readRedesignStageArtifact(
  assessmentId: string,
  stage: RedesignStage,
): Promise<RedesignStageArtifactRecord> {
  const result = await request<{ stageArtifact: RedesignStageArtifactRecord }>(
    `/redesign-assessments/${encodeURIComponent(assessmentId)}/stages/${encodeURIComponent(stage)}/artifact`,
  );
  return result.stageArtifact;
}

export async function reviseRedesignStageArtifact(input: {
  assessmentId: string;
  expectedVersion: number;
  expectedDesignVersion?: number;
  stage: RedesignStage;
  artifact: RedesignStageArtifact;
}): Promise<RedesignAssessmentRecord> {
  const result = await request<{ assessment: RedesignAssessmentRecord }>(
    `/redesign-assessments/${encodeURIComponent(input.assessmentId)}/stages/${encodeURIComponent(input.stage)}/artifact`,
    {
      method: "PUT",
      body: JSON.stringify({
        expectedVersion: input.expectedVersion,
        ...(input.expectedDesignVersion ? { expectedDesignVersion: input.expectedDesignVersion } : {}),
        artifact: input.artifact,
      }),
    },
  );
  return result.assessment;
}

export async function reviseRedesignStage(input: {
  assessmentId: string;
  expectedVersion: number;
  expectedDesignVersion?: number;
  content: Record<string, unknown>;
}): Promise<RedesignAssessmentRecord> {
  const result = await request<{ assessment: RedesignAssessmentRecord }>(
    `/redesign-assessments/${encodeURIComponent(input.assessmentId)}/current-stage`,
    {
      method: "PATCH",
      body: JSON.stringify({
        expectedVersion: input.expectedVersion,
        ...(input.expectedDesignVersion ? { expectedDesignVersion: input.expectedDesignVersion } : {}),
        content: input.content,
      }),
    },
  );
  return result.assessment;
}

export async function transitionRedesignStage(input: {
  assessmentId: string;
  expectedVersion: number;
  expectedDesignVersion?: number;
  toStage: RedesignStage;
  decision: "advanced" | "returned" | "approved" | "cancelled" | "completed";
  content?: Record<string, unknown>;
  details?: Record<string, unknown>;
}): Promise<RedesignAssessmentRecord> {
  const result = await request<{ assessment: RedesignAssessmentRecord }>(
    `/redesign-assessments/${encodeURIComponent(input.assessmentId)}/transition`,
    {
      method: "POST",
      body: JSON.stringify({
        expectedVersion: input.expectedVersion,
        ...(input.expectedDesignVersion ? { expectedDesignVersion: input.expectedDesignVersion } : {}),
        toStage: input.toStage,
        decision: input.decision,
        ...(input.content ? { content: input.content } : {}),
        ...(input.details ? { details: input.details } : {}),
      }),
    },
  );
  return result.assessment;
}
