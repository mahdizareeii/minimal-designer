import type {
  DesignDocument,
  DesignOperation,
  DesignProjectSummary,
  DevicePreset,
  RevisionSummary,
} from "../domain";
import { normalizeDocument, normalizeOperations } from "../domain";

const API_ROOT = "/api";

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
      headers: {
        ...(init?.body instanceof FormData ? {} : { "content-type": "application/json" }),
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

export async function archiveNodes(
  id: string,
  nodeIds: string[],
  expectedBaseVersion: number,
  idempotencyKey: string,
): Promise<CommitResult> {
  const result = await request<Record<string, unknown>>(`/designs/${encodeURIComponent(id)}/archive`, {
    method: "POST",
    body: JSON.stringify({ nodeIds, expectedBaseVersion, idempotencyKey }),
  });
  return {
    version: Number(result.version ?? result.revision ?? expectedBaseVersion + 1),
    ...(result.revisionId || result.revision_id ? { revisionId: String(result.revisionId ?? result.revision_id) } : {}),
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

export function exportUrl(id: string, version?: number): string {
  const query = version === undefined ? "" : `?version=${encodeURIComponent(version)}`;
  return `${API_ROOT}/designs/${encodeURIComponent(id)}/export${query}`;
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

export interface ServerEvent {
  type: "design.updated" | "context.updated" | "asset.created" | string;
  designId?: string;
  version?: number;
  data?: unknown;
}

export function subscribeToEvents(onEvent: (event: ServerEvent) => void): () => void {
  const source = new EventSource(`${API_ROOT}/events`);
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
  for (const type of ["design.updated", "context.updated", "asset.created"]) {
    source.addEventListener(type, forward as EventListener);
  }
  return () => source.close();
}
