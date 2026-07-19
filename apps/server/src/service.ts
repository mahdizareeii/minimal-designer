import { createHash } from "node:crypto";

import type { DesignDocument, DesignOperation } from "@designer/core";

import {
  applyOperations,
  collectDiagnostics,
  createDocument,
  normalizeTemporaryReferences,
  parseDocument,
  parseOperations,
  type Diagnostic,
} from "./core-adapter.js";
import type { DesignerDatabase } from "./db/database.js";
import { DomainError } from "./errors.js";
import type { EventHub } from "./events.js";
import { createId, hashPayload } from "./ids.js";

interface DesignRow {
  id: string;
  actor_id: string;
  name: string;
  current_version: number;
  current_revision_id: string;
  created_at: string;
  updated_at: string;
}

interface RevisionRow {
  id: string;
  design_id: string;
  version: number;
  parent_revision_id: string | null;
  actor_id: string;
  message: string | null;
  document_json: string;
  operations_json: string;
  created_at: string;
}

interface PreviewRow {
  id: string;
  design_id: string;
  actor_id: string;
  root_base_version: number;
  base_preview_id: string | null;
  operation_hash: string;
  operations_json: string;
  document_json: string;
  diagnostics_json: string;
  committable: number;
  created_at: string;
  expires_at: string;
}

interface IdempotencyRow {
  request_hash: string;
  response_json: string;
}

const MAX_OPERATION_COUNT = 500;
const MAX_OPERATION_JSON_BYTES = 1_048_576;
const ACTIVE_CONTEXT_WINDOW_MS = 5 * 60 * 1000;

interface ContextRow {
  actor_id: string;
  design_id: string | null;
  page_id: string | null;
  selection_json: string;
  updated_at: string;
}

function contextRefForActor(actorId: string): string {
  return `context_${createHash("sha256").update(actorId).digest("hex").slice(0, 24)}`;
}

export interface DesignSummary {
  id: string;
  name: string;
  version: number;
  revisionId: string;
  createdAt: string;
  updatedAt: string;
}

export interface RevisionResult {
  design: DesignSummary;
  document: DesignDocument;
  revision: {
    id: string;
    version: number;
    parentRevisionId: string | null;
    message: string | null;
    createdAt: string;
  };
  diagnostics: Diagnostic[];
  createdIds: unknown;
}

export interface PreviewResult {
  id: string;
  designId: string;
  rootBaseVersion: number;
  basePreviewId: string | null;
  operationHash: string;
  expiresAt: string;
  canCommit: boolean;
  destructive: boolean;
  diagnostics: Diagnostic[];
  createdIds: unknown;
  document: DesignDocument;
}

export interface AssetRecord {
  id: string;
  designId: string | null;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  width: number;
  height: number;
  sha256: string;
  data: Buffer;
  createdAt: string;
}

function designSummary(row: DesignRow): DesignSummary {
  return {
    id: row.id,
    name: row.name,
    version: row.current_version,
    revisionId: row.current_revision_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function forceDocumentRevision(document: DesignDocument, version: number, now: string): DesignDocument {
  return parseDocument({ ...document, revision: version, updated_at: now });
}

function assertOperationPayloadLimit(operations: unknown, subject: "preview" | "revision"): asserts operations is unknown[] {
  if (!Array.isArray(operations)
    || operations.length > MAX_OPERATION_COUNT
    || Buffer.byteLength(JSON.stringify(operations), "utf8") > MAX_OPERATION_JSON_BYTES) {
    throw new DomainError(
      "PAYLOAD_TOO_LARGE",
      `A ${subject} may contain at most 500 operations or 1 MiB of operation JSON.`,
      413,
    );
  }
}

export class DesignerService {
  constructor(
    readonly database: DesignerDatabase,
    readonly events: EventHub,
    readonly previewTtlSeconds: number,
  ) {}

  listDesigns(actorId: string, limit = 50, cursor?: string): { designs: DesignSummary[]; nextCursor: string | null } {
    void actorId;
    const boundedLimit = Math.max(1, Math.min(limit, 100));
    const rows = cursor
      ? this.database.sqlite.prepare(
        "SELECT * FROM designs WHERE updated_at < ? ORDER BY updated_at DESC LIMIT ?",
      ).all(cursor, boundedLimit + 1) as DesignRow[]
      : this.database.sqlite.prepare(
        "SELECT * FROM designs ORDER BY updated_at DESC LIMIT ?",
      ).all(boundedLimit + 1) as DesignRow[];
    const hasMore = rows.length > boundedLimit;
    const selected = rows.slice(0, boundedLimit);
    return {
      designs: selected.map(designSummary),
      nextCursor: hasMore ? selected.at(-1)?.updated_at ?? null : null,
    };
  }

  createDesign(actorId: string, input: {
    name: string;
    preset: "web" | "phone" | "tablet";
    idempotencyKey: string;
  }): RevisionResult {
    const scope = "design:create";
    return this.withIdempotency(actorId, scope, input.idempotencyKey, input, () => {
      const now = new Date().toISOString();
      const designId = createId("document");
      const revisionId = createId("revision");
      const document = createDocument(designId, input.name, now, input.preset);
      const transaction = this.database.sqlite.transaction(() => {
        this.database.sqlite.prepare(
          `INSERT INTO designs (id, actor_id, name, current_version, current_revision_id, created_at, updated_at)
           VALUES (?, ?, ?, 1, ?, ?, ?)`,
        ).run(designId, actorId, input.name, revisionId, now, now);
        this.database.sqlite.prepare(
          `INSERT INTO revisions
           (id, design_id, version, parent_revision_id, actor_id, message, document_json, operations_json, created_at)
           VALUES (?, ?, 1, NULL, ?, ?, ?, '[]', ?)`,
        ).run(revisionId, designId, actorId, "Create design", JSON.stringify(document), now);
      });
      transaction();
      const result: RevisionResult = {
        design: {
          id: designId,
          name: input.name,
          version: 1,
          revisionId,
          createdAt: now,
          updatedAt: now,
        },
        document,
        revision: { id: revisionId, version: 1, parentRevisionId: null, message: "Create design", createdAt: now },
        diagnostics: collectDiagnostics(document),
        createdIds: [],
      };
      this.events.publishWorkspace(actorId, "design.updated", { designId, version: 1, revisionId, created: true });
      return result;
    });
  }

  getDesign(actorId: string, designId: string, version?: number): RevisionResult {
    const design = this.requireDesign(actorId, designId);
    const requestedVersion = version ?? design.current_version;
    const revision = this.database.sqlite.prepare(
      "SELECT * FROM revisions WHERE design_id = ? AND version = ?",
    ).get(designId, requestedVersion) as RevisionRow | undefined;
    if (!revision) throw new DomainError("NOT_FOUND", `Version ${requestedVersion} was not found.`, 404);
    const document = parseDocument(JSON.parse(revision.document_json));
    return {
      design: designSummary(design),
      document,
      revision: {
        id: revision.id,
        version: revision.version,
        parentRevisionId: revision.parent_revision_id,
        message: revision.message,
        createdAt: revision.created_at,
      },
      diagnostics: collectDiagnostics(document),
      createdIds: [],
    };
  }

  searchNodes(actorId: string, designId: string, input: {
    version?: number;
    query?: string;
    types?: string[];
    limit?: number;
  }): Array<Record<string, unknown>> {
    const { document } = this.getDesign(actorId, designId, input.version);
    const query = input.query?.trim().toLocaleLowerCase();
    const types = input.types ? new Set(input.types) : null;
    const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
    const nodes = Object.values(document.nodes as Record<string, Record<string, unknown>>);
    return nodes.filter((node) => {
      if (types && typeof node.type === "string" && !types.has(node.type)) return false;
      if (!query) return true;
      const haystack = [node.id, node.name, node.type, node.content]
        .filter((value): value is string => typeof value === "string")
        .join(" ")
        .toLocaleLowerCase();
      return haystack.includes(query);
    }).slice(0, limit).map((node) => ({
      id: node.id,
      type: node.type,
      name: node.name,
      visible: node.visible,
      archived: node.archived,
    }));
  }

  createPreview(actorId: string, designId: string, input: {
    baseVersion?: number;
    basePreviewId?: string;
    operations: unknown;
  }): PreviewResult {
    assertOperationPayloadLimit(input.operations, "preview");
    this.database.cleanupIdempotency();
    this.database.cleanupPreviews(new Date(Date.now() - 86_400_000).toISOString());
    if ((input.baseVersion === undefined) === (input.basePreviewId === undefined)) {
      throw new DomainError("VALIDATION_FAILED", "Provide exactly one of baseVersion or basePreviewId.", 422);
    }
    const currentDesign = this.requireDesign(actorId, designId);
    let baseDocument: DesignDocument;
    let rootBaseVersion: number;
    let priorOperations: DesignOperation[] = [];
    let basePreviewId: string | null = null;

    if (input.basePreviewId) {
      const preview = this.requirePreview(actorId, designId, input.basePreviewId);
      baseDocument = parseDocument(JSON.parse(preview.document_json));
      rootBaseVersion = preview.root_base_version;
      priorOperations = parseOperations(JSON.parse(preview.operations_json));
      basePreviewId = preview.id;
    } else {
      rootBaseVersion = input.baseVersion as number;
      if (rootBaseVersion !== currentDesign.current_version) {
        throw this.versionConflict(rootBaseVersion, currentDesign.current_version, currentDesign.current_revision_id);
      }
      baseDocument = this.getDesign(actorId, designId, rootBaseVersion).document;
    }

    assertOperationPayloadLimit([...priorOperations, ...input.operations], "preview");
    const normalized = normalizeTemporaryReferences(input.operations);
    const operations = parseOperations(normalized.operations);
    const cumulativeOperations = [...priorOperations, ...operations];
    assertOperationPayloadLimit(cumulativeOperations, "preview");
    const now = new Date().toISOString();
    const applied = applyOperations(baseDocument, operations, {
      expectedRevision: baseDocument.revision,
      now,
    });
    const document = forceDocumentRevision(applied.document, rootBaseVersion + 1, now);
    const operationHash = hashPayload({ rootBaseVersion, operations: cumulativeOperations });
    const previewId = createId("preview");
    const expiresAt = new Date(Date.now() + this.previewTtlSeconds * 1000).toISOString();
    const diagnostics = applied.diagnostics;
    const canCommit = !diagnostics.some((item) => item.severity === "error");

    this.database.sqlite.prepare(
      `INSERT INTO previews
       (id, design_id, actor_id, root_base_version, base_preview_id, operation_hash, operations_json,
        document_json, diagnostics_json, committable, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      previewId,
      designId,
      actorId,
      rootBaseVersion,
      basePreviewId,
      operationHash,
      JSON.stringify(cumulativeOperations),
      JSON.stringify(document),
      JSON.stringify(diagnostics),
      canCommit ? 1 : 0,
      now,
      expiresAt,
    );

    return {
      id: previewId,
      designId,
      rootBaseVersion,
      basePreviewId,
      operationHash,
      expiresAt,
      canCommit,
      destructive: cumulativeOperations.some((operation) => operation.type === "archive_nodes"),
      diagnostics,
      createdIds: {
        temporary: normalized.idMap,
        created: applied.createdIds,
      },
      document,
    };
  }

  getPreview(actorId: string, designId: string, previewId: string): PreviewResult {
    const row = this.requirePreview(actorId, designId, previewId);
    const operations = parseOperations(JSON.parse(row.operations_json));
    return {
      id: row.id,
      designId: row.design_id,
      rootBaseVersion: row.root_base_version,
      basePreviewId: row.base_preview_id,
      operationHash: row.operation_hash,
      expiresAt: row.expires_at,
      canCommit: row.committable === 1,
      destructive: operations.some((operation) => operation.type === "archive_nodes"),
      diagnostics: JSON.parse(row.diagnostics_json) as Diagnostic[],
      createdIds: [],
      document: parseDocument(JSON.parse(row.document_json)),
    };
  }

  commitPreview(actorId: string, designId: string, input: {
    previewId: string;
    expectedBaseVersion: number;
    idempotencyKey: string;
    message?: string;
    allowDestructive?: boolean;
  }): RevisionResult {
    const scope = `design:${designId}:commit-preview`;
    return this.withIdempotency(actorId, scope, input.idempotencyKey, input, () => {
      const preview = this.requirePreview(actorId, designId, input.previewId);
      if (!preview.committable) {
        throw new DomainError("PREVIEW_NOT_COMMITTABLE", "The preview has validation errors and cannot be committed.", 422, {
          details: { diagnostics: JSON.parse(preview.diagnostics_json) as unknown },
        });
      }
      if (preview.root_base_version !== input.expectedBaseVersion) {
        throw new DomainError("VALIDATION_FAILED", "expectedBaseVersion does not match the preview base.", 422);
      }
      const operations = parseOperations(JSON.parse(preview.operations_json));
      if (!input.allowDestructive && operations.some((operation) => operation.type === "archive_nodes")) {
        throw new DomainError("VALIDATION_FAILED", "This preview archives nodes and requires the destructive preview commit tool.", 422, {
          details: { requiredTool: "design_commit_destructive_preview" },
        });
      }
      return this.commitDocument(actorId, designId, {
        baseVersion: input.expectedBaseVersion,
        document: parseDocument(JSON.parse(preview.document_json)),
        operations,
        diagnostics: JSON.parse(preview.diagnostics_json) as Diagnostic[],
        createdIds: [],
        message: input.message ?? "Commit preview",
      });
    });
  }

  applyRevision(actorId: string, designId: string, input: {
    baseVersion: number;
    operations: unknown;
    idempotencyKey: string;
    message?: string;
  }): RevisionResult {
    assertOperationPayloadLimit(input.operations, "revision");
    const scope = `design:${designId}:revision`;
    return this.withIdempotency(actorId, scope, input.idempotencyKey, input, () => {
      const design = this.requireDesign(actorId, designId);
      if (design.current_version !== input.baseVersion) {
        throw this.versionConflict(input.baseVersion, design.current_version, design.current_revision_id);
      }
      const current = this.getDesign(actorId, designId, input.baseVersion).document;
      const now = new Date().toISOString();
      const applied = applyOperations(current, input.operations, { expectedRevision: current.revision, now });
      const document = forceDocumentRevision(applied.document, input.baseVersion + 1, now);
      return this.commitDocument(actorId, designId, {
        baseVersion: input.baseVersion,
        document,
        operations: parseOperations(input.operations),
        diagnostics: applied.diagnostics,
        createdIds: applied.createdIds,
        message: input.message ?? "Update design",
      });
    });
  }

  archiveNodes(actorId: string, designId: string, input: {
    expectedBaseVersion: number;
    nodeIds: string[];
    idempotencyKey: string;
  }): RevisionResult {
    return this.applyRevision(actorId, designId, {
      baseVersion: input.expectedBaseVersion,
      operations: [{ type: "archive_nodes", node_ids: input.nodeIds }],
      idempotencyKey: input.idempotencyKey,
      message: `Archive ${input.nodeIds.length} node(s)`,
    });
  }

  restoreRevision(actorId: string, designId: string, input: {
    targetVersion: number;
    expectedBaseVersion: number;
    idempotencyKey: string;
  }): RevisionResult {
    const scope = `design:${designId}:restore`;
    return this.withIdempotency(actorId, scope, input.idempotencyKey, input, () => {
      const design = this.requireDesign(actorId, designId);
      if (design.current_version !== input.expectedBaseVersion) {
        throw this.versionConflict(input.expectedBaseVersion, design.current_version, design.current_revision_id);
      }
      const target = this.getDesign(actorId, designId, input.targetVersion).document;
      const now = new Date().toISOString();
      return this.commitDocument(actorId, designId, {
        baseVersion: input.expectedBaseVersion,
        document: forceDocumentRevision(target, input.expectedBaseVersion + 1, now),
        operations: [],
        diagnostics: collectDiagnostics(target),
        createdIds: [],
        message: `Restore version ${input.targetVersion}`,
      });
    });
  }

  history(actorId: string, designId: string, limit = 50): Array<Record<string, unknown>> {
    this.requireDesign(actorId, designId);
    const rows = this.database.sqlite.prepare(
      `SELECT id, version, parent_revision_id, actor_id, message, created_at
       FROM revisions WHERE design_id = ? ORDER BY version DESC LIMIT ?`,
    ).all(designId, Math.max(1, Math.min(limit, 200))) as Array<{
      id: string;
      version: number;
      parent_revision_id: string | null;
      actor_id: string;
      message: string | null;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      version: row.version,
      parentRevisionId: row.parent_revision_id,
      actorId: row.actor_id,
      message: row.message,
      createdAt: row.created_at,
    }));
  }

  getContext(actorId: string, options: { workspaceFallback?: boolean; contextRef?: string } = {}): Record<string, unknown> {
    const toResult = (row: ContextRow, contextSource: "actor" | "workspace") => {
      const head = row.design_id ? this.requireDesign(actorId, row.design_id) : null;
      return {
        designId: row.design_id,
        pageId: row.page_id,
        selection: JSON.parse(row.selection_json) as unknown,
        updatedAt: row.updated_at,
        contextRef: contextRefForActor(row.actor_id),
        contextSource,
        ...(head ? { version: head.current_version, revisionId: head.current_revision_id } : {}),
      };
    };

    const exact = this.database.sqlite.prepare("SELECT * FROM contexts WHERE actor_id = ?").get(actorId) as ContextRow | undefined;
    if (exact && (!options.contextRef || contextRefForActor(exact.actor_id) === options.contextRef)) {
      return toResult(exact, "actor");
    }
    if (!options.workspaceFallback) return { designId: null, pageId: null, selection: [], updatedAt: null };

    const activeSince = new Date(Date.now() - ACTIVE_CONTEXT_WINDOW_MS).toISOString();
    const rows = this.database.sqlite.prepare(
      `SELECT * FROM contexts
       WHERE design_id IS NOT NULL AND updated_at >= ? AND actor_id <> '__workspace_context__'
       ORDER BY updated_at DESC LIMIT 50`,
    ).all(activeSince) as ContextRow[];

    if (options.contextRef) {
      const selected = rows.find((row) => contextRefForActor(row.actor_id) === options.contextRef);
      if (!selected) {
        throw new DomainError("NOT_FOUND", "The requested active editor context was not found.", 404, {
          details: { contextRef: options.contextRef },
        });
      }
      return toResult(selected, "workspace");
    }

    const distinct = new Map<string, ContextRow>();
    for (const row of rows) {
      const signature = `${row.design_id ?? ""}\u0000${row.page_id ?? ""}\u0000${row.selection_json}`;
      if (!distinct.has(signature)) distinct.set(signature, row);
    }
    const candidates = [...distinct.values()];
    if (candidates.length === 0) return { designId: null, pageId: null, selection: [], updatedAt: null };
    if (candidates.length > 1) {
      throw new DomainError("AMBIGUOUS_CONTEXT", "More than one editor context is active; retry with context_ref.", 409, {
        details: {
          candidates: candidates.slice(0, 10).map((row) => {
            const selection = JSON.parse(row.selection_json) as string[];
            return {
              contextRef: contextRefForActor(row.actor_id),
              designId: row.design_id,
              pageId: row.page_id,
              selection: selection.slice(0, 20),
              selectionCount: selection.length,
              updatedAt: row.updated_at,
            };
          }),
        },
      });
    }
    return toResult(candidates[0]!, "workspace");
  }

  setContext(actorId: string, input: { designId?: string | null; pageId?: string | null; selection?: string[] }): Record<string, unknown> {
    if (!input.designId && (input.pageId || (input.selection?.length ?? 0) > 0)) {
      throw new DomainError("VALIDATION_FAILED", "pageId and selection require a designId.", 422);
    }
    if (input.designId) {
      const document = this.getDesign(actorId, input.designId).document;
      if (input.pageId && !document.pages.some((page) => page.id === input.pageId && !page.archived)) {
        throw new DomainError("VALIDATION_FAILED", "The active page does not belong to the selected design.", 422);
      }
      const missingNodes = (input.selection ?? []).filter((nodeId) => !document.nodes[nodeId] || document.nodes[nodeId]?.archived);
      if (missingNodes.length > 0) {
        throw new DomainError("VALIDATION_FAILED", "The selection contains missing or archived nodes.", 422, {
          details: { missingNodeIds: missingNodes },
        });
      }
    }
    const now = new Date().toISOString();
    this.database.sqlite.prepare(
      `INSERT INTO contexts (actor_id, design_id, page_id, selection_json, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(actor_id) DO UPDATE SET
         design_id = excluded.design_id,
         page_id = excluded.page_id,
         selection_json = excluded.selection_json,
         updated_at = excluded.updated_at`,
    ).run(actorId, input.designId ?? null, input.pageId ?? null, JSON.stringify(input.selection ?? []), now);
    const context = this.getContext(actorId);
    this.events.publishActor(actorId, "context.updated", context);
    return context;
  }

  saveAsset(actorId: string, input: {
    designId?: string;
    filename: string;
    mimeType: string;
    width: number;
    height: number;
    data: Buffer;
  }): Omit<AssetRecord, "data"> {
    if (input.designId) this.requireDesign(actorId, input.designId);
    const id = createId("asset");
    const now = new Date().toISOString();
    const sha256 = createHash("sha256").update(input.data).digest("hex");
    this.database.sqlite.prepare(
      `INSERT INTO assets
       (id, actor_id, design_id, filename, mime_type, size_bytes, width, height, sha256, data, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, actorId, input.designId ?? null, input.filename, input.mimeType, input.data.length, input.width, input.height, sha256, input.data, now);
    const asset = {
      id,
      designId: input.designId ?? null,
      filename: input.filename,
      mimeType: input.mimeType,
      sizeBytes: input.data.length,
      width: input.width,
      height: input.height,
      sha256,
      createdAt: now,
    };
    this.events.publishWorkspace(actorId, "asset.created", { assetId: id, designId: asset.designId });
    return asset;
  }

  getAsset(actorId: string, assetId: string): AssetRecord {
    void actorId;
    const row = this.database.sqlite.prepare("SELECT * FROM assets WHERE id = ?").get(assetId) as {
      id: string;
      design_id: string | null;
      filename: string;
      mime_type: string;
      size_bytes: number;
      width: number;
      height: number;
      sha256: string;
      data: Buffer;
      created_at: string;
    } | undefined;
    if (!row) throw new DomainError("NOT_FOUND", "Asset not found.", 404);
    return {
      id: row.id,
      designId: row.design_id,
      filename: row.filename,
      mimeType: row.mime_type,
      sizeBytes: row.size_bytes,
      width: row.width,
      height: row.height,
      sha256: row.sha256,
      data: row.data,
      createdAt: row.created_at,
    };
  }

  private commitDocument(actorId: string, designId: string, input: {
    baseVersion: number;
    document: DesignDocument;
    operations: DesignOperation[];
    diagnostics: Diagnostic[];
    createdIds: unknown;
    message: string;
  }): RevisionResult {
    const now = new Date().toISOString();
    const revisionId = createId("revision");
    const nextVersion = input.baseVersion + 1;
    const document = forceDocumentRevision(input.document, nextVersion, now);

    const transaction = this.database.sqlite.transaction(() => {
      const design = this.requireDesign(actorId, designId);
      if (design.current_version !== input.baseVersion) {
        throw this.versionConflict(input.baseVersion, design.current_version, design.current_revision_id);
      }
      this.database.sqlite.prepare(
        `INSERT INTO revisions
         (id, design_id, version, parent_revision_id, actor_id, message, document_json, operations_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        revisionId,
        designId,
        nextVersion,
        design.current_revision_id,
        actorId,
        input.message,
        JSON.stringify(document),
        JSON.stringify(input.operations),
        now,
      );
      const update = this.database.sqlite.prepare(
        `UPDATE designs SET name = ?, current_version = ?, current_revision_id = ?, updated_at = ?
         WHERE id = ? AND current_version = ?`,
      ).run(document.name, nextVersion, revisionId, now, designId, input.baseVersion);
      if (update.changes !== 1) throw this.versionConflict(input.baseVersion, design.current_version, design.current_revision_id);
    });
    transaction();

    const design = this.requireDesign(actorId, designId);
    const result: RevisionResult = {
      design: designSummary(design),
      document,
      revision: {
        id: revisionId,
        version: nextVersion,
        parentRevisionId: nextVersion === 1 ? null : this.getRevisionId(designId, input.baseVersion),
        message: input.message,
        createdAt: now,
      },
      diagnostics: input.diagnostics,
      createdIds: input.createdIds,
    };
    this.events.publishWorkspace(actorId, "design.updated", { designId, version: nextVersion, revisionId });
    return result;
  }

  private requireDesign(actorId: string, designId: string): DesignRow {
    const design = this.database.sqlite.prepare(
      "SELECT * FROM designs WHERE id = ?",
    ).get(designId) as DesignRow | undefined;
    if (!design) throw new DomainError("NOT_FOUND", "Design not found.", 404);
    return design;
  }

  private requirePreview(actorId: string, designId: string, previewId: string): PreviewRow {
    const preview = this.database.sqlite.prepare(
      "SELECT * FROM previews WHERE id = ? AND design_id = ? AND actor_id = ?",
    ).get(previewId, designId, actorId) as PreviewRow | undefined;
    if (!preview) throw new DomainError("NOT_FOUND", "Preview not found.", 404);
    if (preview.expires_at <= new Date().toISOString()) {
      throw new DomainError("PREVIEW_EXPIRED", "The preview expired; create a new preview.", 410, { retryable: true });
    }
    return preview;
  }

  private getRevisionId(designId: string, version: number): string | null {
    const row = this.database.sqlite.prepare(
      "SELECT id FROM revisions WHERE design_id = ? AND version = ?",
    ).get(designId, version) as { id: string } | undefined;
    return row?.id ?? null;
  }

  private versionConflict(expected: number, current: number, currentRevisionId: string): DomainError {
    return new DomainError("VERSION_CONFLICT", `Expected version ${expected}, but the current version is ${current}.`, 409, {
      retryable: true,
      details: {
        expectedVersion: expected,
        currentVersion: current,
        currentRevisionId,
        recovery: "Read the current design and create a new preview or revision.",
      },
    });
  }

  private withIdempotency<T>(
    actorId: string,
    scope: string,
    key: string,
    request: unknown,
    execute: () => T,
  ): T {
    const transaction = this.database.sqlite.transaction(() => {
      this.database.cleanupIdempotency();
      const requestHash = hashPayload(request);
      const existing = this.database.sqlite.prepare(
        "SELECT request_hash, response_json FROM idempotency WHERE actor_id = ? AND scope = ? AND key = ? AND expires_at > ?",
      ).get(actorId, scope, key, new Date().toISOString()) as IdempotencyRow | undefined;
      if (existing) {
        if (existing.request_hash !== requestHash) {
          throw new DomainError("IDEMPOTENCY_CONFLICT", "The idempotency key was already used with different input.", 409);
        }
        return JSON.parse(existing.response_json) as T;
      }
      const response = execute();
      const now = new Date();
      this.database.sqlite.prepare(
        `INSERT INTO idempotency (actor_id, scope, key, request_hash, response_json, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(actorId, scope, key, requestHash, JSON.stringify(response), now.toISOString(), new Date(now.getTime() + 86_400_000).toISOString());
      return response;
    });
    return transaction();
  }
}
