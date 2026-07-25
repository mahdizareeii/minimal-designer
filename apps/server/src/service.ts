import { createHash } from "node:crypto";

import {
  DocumentIdSchema,
  DesignDocumentV2Schema,
  FORMASPEC_FOUNDATION_RELEASE_ID,
  FORMASPEC_FOUNDATION_SYSTEM_ID,
  FORMASPEC_FOUNDATION_VERSION,
  migrateDesignDocumentV1ToV2,
  type AnyDesignDocument,
  type DesignDocument,
  type DesignOperation,
} from "@designer/core";

import {
  applyOperations,
  collectDiagnostics,
  createDocument,
  editorDocument,
  normalizeTemporaryReferences,
  parseDocument,
  parseOperations,
  type Diagnostic,
} from "./core-adapter.js";
import type { ContentAddressedRasterStore } from "./assets.js";
import {
  appendAuditEvent,
  assertDesignWrite,
  assertProjectAccess,
  assertScope,
  resolveAccess,
  type AccessContext,
} from "./authorization.js";
import type { DesignerDatabase } from "./db/database.js";
import {
  assessDesignSystemReleaseCompatibility,
  type DesignSystemDiagnostic,
} from "./design-system-service.js";
import { DomainError } from "./errors.js";
import {
  canReadDesignerEvent,
  designerEventSqlVisibility,
  hasDesignerEventReadAccess,
} from "./event-authorization.js";
import type { DesignerEvent, DesignerEventType, EventHub } from "./events.js";
import { canonicalJson, createId, hashPayload } from "./ids.js";
import { loadOrganizationPolicy } from "./organization-policy-model.js";
import {
  DEFAULT_RUNTIME_VERSIONS,
  canonicalSnapshot,
  changedNodeIds,
  operationHash,
  readSnapshotJson,
  revisionHash,
  storeSnapshot,
  type RuntimeVersions,
} from "./persistence.js";
import {
  buildPreviewRenderMetadata,
  parsePreviewRenderMetadata,
  type PreviewRenderCapture,
  type PreviewRenderMetadata,
} from "./preview-render-metadata.js";
import type { ContentAddressedPreviewRenderStore } from "./preview-render-store.js";
import { bindPreviewToTask, requirePreviewTaskBinding } from "./preview-task-binding.js";

interface DesignRow {
  id: string;
  product_id: string;
  actor_id: string;
  name: string;
  current_version: number;
  current_revision_id: string;
  created_at: string;
  updated_at: string;
  organization_id: string;
  archived_at?: string | null;
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
  snapshot_hash: string | null;
  operation_hash: string | null;
  parent_revision_hash: string | null;
  revision_hash: string | null;
  created_at: string;
}

export type PreviewKind = "ordinary" | "archive";
export type PreviewStatus = "ready" | "blocked" | "expired" | "committed";

interface PreviewRow {
  id: string;
  organization_id: string;
  design_id: string;
  actor_id: string;
  root_base_version: number;
  base_revision_id: string | null;
  base_snapshot_hash: string | null;
  base_preview_id: string | null;
  operation_hash: string;
  operations_json: string;
  document_json: string;
  result_snapshot_hash: string | null;
  diagnostics_json: string;
  temporary_id_map_json: string;
  created_ids_json: string;
  changed_node_ids_json: string;
  command_engine_version: string;
  renderer_version: string;
  font_bundle_version: string;
  status: PreviewStatus;
  kind: PreviewKind;
  committed_revision_id: string | null;
  committed_at: string | null;
  render_metadata_json: string | null;
  committable: number;
  created_at: string;
  expires_at: string;
}

interface AgentTaskPreviewAccessRow {
  id: string;
  organization_id: string;
  design_id: string;
  base_version: number;
  expected_output: string;
  expires_at: string;
}

interface AgentTaskPreviewTransitionRow {
  to_status: string;
  data_json: string;
}

interface IdempotencyRow {
  request_hash: string;
  response_json: string;
}

const MAX_OPERATION_COUNT = 500;
const MAX_OPERATION_JSON_BYTES = 1_048_576;
const DESIGN_LIST_CURSOR_PREFIX = "design_cursor_";
const ACTIVE_CONTEXT_WINDOW_MS = 5 * 60 * 1000;
const CLIENT_CONTEXT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const CLIENT_CONTEXT_ROW_PREFIX = "__client_context__";
const V2_MIGRATION_ACTOR_ID = "system_formaspec_v2_migration";
const RESTORE_DESIGN_SYSTEM_PIN_PRESERVED = "RESTORE_DESIGN_SYSTEM_PIN_PRESERVED";

interface DesignListCursorCore {
  schemaVersion: 1;
  accessHash: string;
  updatedAt: string;
  id: string;
}

interface DesignListCursorPayload extends DesignListCursorCore {
  checksum: string;
}

type ParsedDesignListCursor =
  | ({ kind: "opaque" } & DesignListCursorCore)
  | { kind: "legacy"; updatedAt: string };

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function designListAccessHash(access: AccessContext, includeArchived: boolean): string {
  return hashPayload({
    organizationId: access.organizationId,
    principalId: access.principalId,
    role: access.role,
    scopes: [...new Set(access.scopes)].sort(),
    projectIds: [...new Set(access.projectIds)].sort(),
    includeArchived,
  });
}

function createDesignListCursor(row: DesignRow, accessHash: string): string {
  const core: DesignListCursorCore = {
    schemaVersion: 1,
    accessHash,
    updatedAt: row.updated_at,
    id: row.id,
  };
  const payload: DesignListCursorPayload = {
    ...core,
    checksum: hashPayload(core),
  };
  return `${DESIGN_LIST_CURSOR_PREFIX}${Buffer.from(canonicalJson(payload), "utf8").toString("base64url")}`;
}

function parseDesignListCursor(cursor: string, accessHash: string): ParsedDesignListCursor {
  if (!cursor.startsWith(DESIGN_LIST_CURSOR_PREFIX)) {
    if (canonicalTimestamp(cursor)) return { kind: "legacy", updatedAt: cursor };
    throw new DomainError("VALIDATION_FAILED", "Design list cursor is malformed.", 422);
  }
  const encoded = cursor.slice(DESIGN_LIST_CURSOR_PREFIX.length);
  let raw: unknown;
  try {
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.length === 0 || bytes.length > 2_048 || bytes.toString("base64url") !== encoded) {
      throw new Error("non-canonical cursor encoding");
    }
    raw = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new DomainError("VALIDATION_FAILED", "Design list cursor is malformed.", 422, { cause: error });
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new DomainError("VALIDATION_FAILED", "Design list cursor payload is invalid.", 422);
  }
  const payload = raw as Partial<DesignListCursorPayload>;
  const keys = Object.keys(payload).sort();
  const expectedKeys = ["accessHash", "checksum", "id", "schemaVersion", "updatedAt"];
  if (keys.length !== expectedKeys.length
    || !keys.every((key, index) => key === expectedKeys[index])
    || payload.schemaVersion !== 1
    || typeof payload.accessHash !== "string"
    || !/^[a-f0-9]{64}$/.test(payload.accessHash)
    || !canonicalTimestamp(payload.updatedAt)
    || !DocumentIdSchema.safeParse(payload.id).success
    || typeof payload.checksum !== "string"
    || !/^[a-f0-9]{64}$/.test(payload.checksum)) {
    throw new DomainError("VALIDATION_FAILED", "Design list cursor payload is invalid.", 422);
  }
  const core: DesignListCursorCore = {
    schemaVersion: 1,
    accessHash: payload.accessHash,
    updatedAt: payload.updatedAt,
    id: payload.id!,
  };
  const canonicalCursor = `${DESIGN_LIST_CURSOR_PREFIX}${Buffer.from(canonicalJson({
    ...core,
    checksum: payload.checksum,
  }), "utf8").toString("base64url")}`;
  if (payload.checksum !== hashPayload(core) || canonicalCursor !== cursor) {
    throw new DomainError("VALIDATION_FAILED", "Design list cursor integrity check failed.", 422);
  }
  if (core.accessHash !== accessHash) {
    throw new DomainError("VERSION_CONFLICT", "Design list authorization changed; restart pagination.", 409, {
      details: { reason: "cursor_authorization_changed" },
    });
  }
  return { kind: "opaque", ...core };
}

interface ContextRow {
  actor_id: string;
  design_id: string | null;
  page_id: string | null;
  selection_json: string;
  updated_at: string;
  organization_id: string;
}

function contextRefForActor(actorId: string): string {
  return `context_${createHash("sha256").update(actorId).digest("hex").slice(0, 24)}`;
}

function clientContextOwnerPrefix(actorId: string): string {
  const actorHash = createHash("sha256").update(actorId).digest("hex").slice(0, 32);
  return `${CLIENT_CONTEXT_ROW_PREFIX}${actorHash}_`;
}

function clientContextRowKey(actorId: string, clientContextId: string): string {
  const clientHash = createHash("sha256").update(clientContextId).digest("hex").slice(0, 32);
  return `${clientContextOwnerPrefix(actorId)}${clientHash}`;
}

function contextRowBelongsToActor(rowActorId: string, actorId: string): boolean {
  return rowActorId === actorId || rowActorId.startsWith(clientContextOwnerPrefix(actorId));
}

function inactiveContextResult(): Record<string, unknown> {
  return { designId: null, pageId: null, selection: [], updatedAt: null };
}

function designArchiveMetadataKey(designId: string): string {
  return `design_archive:${designId}`;
}

export interface DesignSummary {
  id: string;
  productId: string;
  name: string;
  version: number;
  revisionId: string;
  status: "active" | "archived";
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ArchivedDesignResult extends DesignSummary {
  status: "archived";
  archivedAt: string;
}

export interface RevisionResult {
  design: DesignSummary;
  document: DesignDocument;
  canonicalDocument: AnyDesignDocument;
  schemaVersion: 1 | 2;
  revision: {
    id: string;
    version: number;
    parentRevisionId: string | null;
    snapshotHash: string;
    operationHash: string;
    revisionHash: string;
    message: string | null;
    createdAt: string;
  };
  diagnostics: Diagnostic[];
  createdIds: unknown;
}

export type RestoreDesignSystemStatus =
  | "not_applicable_v1"
  | "active_pin_unchanged"
  | "active_pin_preserved";

export interface RestoreDesignSystemReference {
  designSystemId: string;
  releaseId: string;
  releaseVersion: number;
}

export interface RestoreDisposition {
  targetVersion: number;
  targetRevisionId: string;
  targetSnapshotHash: string;
  targetRevisionHash: string;
  targetSchemaVersion: 1 | 2;
  designSystem: {
    status: RestoreDesignSystemStatus;
    pinSource: "project_design_system_pins" | "formaspec_foundation_default" | null;
    active: RestoreDesignSystemReference | null;
    historical: RestoreDesignSystemReference | null;
    compatibilityDiagnostics: DesignSystemDiagnostic[];
  };
}

export interface RestoreRevisionResult extends RevisionResult {
  restore: RestoreDisposition;
}

export interface PreviewResult {
  id: string;
  designId: string;
  rootBaseVersion: number;
  baseRevisionId: string;
  baseSnapshotHash: string;
  basePreviewId: string | null;
  operationHash: string;
  resultSnapshotHash: string;
  expiresAt: string;
  canCommit: boolean;
  destructive: boolean;
  kind: PreviewKind;
  status: PreviewStatus;
  changedNodeIds: string[];
  versions: Pick<RuntimeVersions, "commandEngine" | "renderer" | "fontBundle">;
  committedRevisionId: string | null;
  renderMetadata: PreviewRenderMetadata | null;
  diagnostics: Diagnostic[];
  createdIds: unknown;
  document: DesignDocument;
  canonicalDocument: AnyDesignDocument;
  schemaVersion: 1 | 2;
}

export interface ExactPreviewRenderResult {
  preview: PreviewResult;
  renderMetadata: PreviewRenderMetadata;
}

export interface StoredExactPreviewRenderResult extends ExactPreviewRenderResult {
  png: Buffer;
}

export interface HeadMigrationResult {
  migrated: boolean;
  backupId: string | null;
  result: RevisionResult;
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

export interface EventReplayResult {
  events: DesignerEvent[];
  earliestId: number | null;
  latestId: number;
  gap: boolean;
  hasMore: boolean;
}

function designSummary(row: DesignRow, archivedAt = row.archived_at ?? null): DesignSummary {
  return {
    id: row.id,
    productId: row.product_id,
    name: row.name,
    version: row.current_version,
    revisionId: row.current_revision_id,
    status: archivedAt === null ? "active" : "archived",
    archivedAt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function forceDocumentRevision(document: AnyDesignDocument, version: number, now: string): AnyDesignDocument {
  return parseDocument({ ...document, revision: version, updated_at: now });
}

function hasArchiveOperations(operations: DesignOperation[]): boolean {
  return operations.some((operation) => ["archive_nodes", "archive_page"].includes(operation.type));
}

function mergeCreatedIds(left: unknown, right: unknown): unknown {
  if (!left || typeof left !== "object" || Array.isArray(left)) return right;
  if (!right || typeof right !== "object" || Array.isArray(right)) return left;
  const result: Record<string, unknown> = { ...(left as Record<string, unknown>) };
  for (const [key, value] of Object.entries(right as Record<string, unknown>)) {
    const prior = result[key];
    result[key] = Array.isArray(prior) && Array.isArray(value)
      ? [...new Set([...prior, ...value])]
      : value;
  }
  return result;
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
  readonly versions: RuntimeVersions;

  constructor(
    readonly database: DesignerDatabase,
    readonly events: EventHub,
    readonly previewTtlSeconds: number,
    versions: Partial<RuntimeVersions> = {},
    readonly assetStore?: ContentAddressedRasterStore,
    readonly previewRenderStore?: ContentAddressedPreviewRenderStore,
  ) {
    this.versions = { ...DEFAULT_RUNTIME_VERSIONS, ...versions };
    this.database.cleanupPreviews();
    this.cleanupPreviewRenderArtifacts();
    this.flushPendingEvents();
  }

  listDesigns(
    actorId: string,
    limit = 50,
    cursor?: string,
    includeArchived = false,
  ): { designs: DesignSummary[]; nextCursor: string | null } {
    const access = resolveAccess(this.database.sqlite, actorId);
    if (access.role === "agent") assertScope(access, "design:read");
    const allowArchived = includeArchived && access.role !== "agent";
    const boundedLimit = Math.max(1, Math.min(limit, 100));
    const accessHash = designListAccessHash(access, allowArchived);
    const parsedCursor = cursor === undefined ? null : parseDesignListCursor(cursor, accessHash);
    if (parsedCursor?.kind === "opaque") this.assertDesignListCursorAnchor(access, parsedCursor, allowArchived);
    const conditions = ["designs.organization_id = ?"];
    if (!allowArchived) {
      conditions.push(`NOT EXISTS (
        SELECT 1 FROM system_metadata archive
        WHERE archive.key = 'design_archive:' || designs.id
      )`);
    }
    const parameters: Array<string | number> = [access.organizationId];
    if (access.projectIds.length > 0) {
      conditions.push(`designs.id IN (${access.projectIds.map(() => "?").join(", ")})`);
      parameters.push(...access.projectIds);
    }
    if (parsedCursor?.kind === "opaque") {
      conditions.push("(designs.updated_at < ? OR (designs.updated_at = ? AND designs.id < ?))");
      parameters.push(parsedCursor.updatedAt, parsedCursor.updatedAt, parsedCursor.id);
    } else if (parsedCursor?.kind === "legacy") {
      conditions.push("designs.updated_at < ?");
      parameters.push(parsedCursor.updatedAt);
    }
    parameters.push(boundedLimit + 1);
    const rows = this.database.sqlite.prepare(
      `SELECT designs.*,
              (SELECT archive.updated_at FROM system_metadata archive
               WHERE archive.key = 'design_archive:' || designs.id) AS archived_at
       FROM designs
       WHERE ${conditions.join(" AND ")}
       ORDER BY designs.updated_at DESC, designs.id DESC LIMIT ?`,
    ).all(...parameters) as DesignRow[];
    const hasMore = rows.length > boundedLimit;
    const selected = rows.slice(0, boundedLimit);
    return {
      designs: selected.map((row) => designSummary(row)),
      nextCursor: hasMore && selected.length > 0
        ? createDesignListCursor(selected.at(-1)!, accessHash)
        : null,
    };
  }

  private assertDesignListCursorAnchor(
    access: AccessContext,
    cursor: Extract<ParsedDesignListCursor, { kind: "opaque" }>,
    includeArchived: boolean,
  ): void {
    const conditions = ["designs.id = ?", "designs.organization_id = ?"];
    if (!includeArchived) {
      conditions.push(`NOT EXISTS (
        SELECT 1 FROM system_metadata archive
        WHERE archive.key = 'design_archive:' || designs.id
      )`);
    }
    const parameters: string[] = [cursor.id, access.organizationId];
    if (access.projectIds.length > 0) {
      conditions.push(`designs.id IN (${access.projectIds.map(() => "?").join(", ")})`);
      parameters.push(...access.projectIds);
    }
    const anchor = this.database.sqlite.prepare(
      `SELECT designs.id, designs.updated_at FROM designs WHERE ${conditions.join(" AND ")}`,
    ).get(...parameters) as Pick<DesignRow, "id" | "updated_at"> | undefined;
    if (!anchor || anchor.updated_at !== cursor.updatedAt) {
      throw new DomainError("VERSION_CONFLICT", "Design list cursor is stale; restart pagination.", 409, {
        details: { reason: "cursor_anchor_changed" },
      });
    }
  }

  authorizeDesignList(actorId: string): void {
    const access = resolveAccess(this.database.sqlite, actorId);
    if (access.role === "agent") assertScope(access, "design:read");
  }

  authorizeDesignCreation(actorId: string): void {
    const access = resolveAccess(this.database.sqlite, actorId);
    assertDesignWrite(access);
    if (access.projectIds.length > 0) {
      throw new DomainError("FORBIDDEN", "A project-restricted agent grant cannot create projects.", 403);
    }
  }

  authorizeDesignArchive(actorId: string, designId: string): void {
    const access = resolveAccess(this.database.sqlite, actorId);
    if (access.role !== "organization_admin" && access.role !== "product_manager") {
      throw new DomainError(
        "FORBIDDEN",
        "Organization Administrator or Product Manager permission is required to archive or restore a Design.",
        403,
      );
    }
    this.requireDesignIncludingArchived(access, designId);
  }

  authorizeDesignRead(actorId: string, designId: string): void {
    this.requireDesign(actorId, designId);
  }

  authorizeDesignRevision(actorId: string, designId: string): void {
    const access = resolveAccess(this.database.sqlite, actorId);
    if (access.role === "agent") {
      throw new DomainError(
        "FORBIDDEN",
        "Agent connections cannot write design revisions directly; publish an exact task preview for website approval.",
        403,
        { details: { requiredAction: "website_human_approval" } },
      );
    }
    assertDesignWrite(access);
    this.requireDesign(actorId, designId);
  }

  authorizeDesignMigration(actorId: string, designId: string): void {
    const access = resolveAccess(this.database.sqlite, actorId);
    if (access.role !== "organization_admin") {
      throw new DomainError("FORBIDDEN", "Organization Administrator permission is required for document migration.", 403);
    }
    this.requireDesign(actorId, designId);
  }

  authorizeDesignRestore(actorId: string, designId: string): void {
    this.authorizeDesignRevision(actorId, designId);
  }

  authorizeContextRead(actorId: string): void {
    const access = resolveAccess(this.database.sqlite, actorId);
    if (access.role === "agent") assertScope(access, "design:read");
  }

  archiveDesign(actorId: string, designId: string, input: {
    expectedVersion: number;
    idempotencyKey: string;
    confirmationName: string;
  }): ArchivedDesignResult {
    this.authorizeDesignArchive(actorId, designId);
    const scope = `design:${designId}:archive`;
    return this.withIdempotency(actorId, scope, input.idempotencyKey, input, () => {
      const access = resolveAccess(this.database.sqlite, actorId);
      const design = this.requireDesignIncludingArchived(access, designId);
      if (this.isDesignArchived(design.id)) {
        throw new DomainError("RESOURCE_STATE_CONFLICT", "The Design is already archived.", 409, {
          details: { expectedStatus: "active", currentStatus: "archived" },
        });
      }
      if (input.confirmationName !== design.name) {
        throw new DomainError(
          "VALIDATION_FAILED",
          "Type the exact Design name to confirm archival.",
          422,
          { details: { field: "confirmationName" } },
        );
      }
      if (design.current_version !== input.expectedVersion) {
        throw this.versionConflict(input.expectedVersion, design.current_version, design.current_revision_id);
      }

      const archivedAt = new Date().toISOString();
      const replacement = this.database.sqlite.prepare(
        `SELECT candidate.id FROM designs candidate
         WHERE candidate.product_id = ? AND candidate.id <> ?
           AND NOT EXISTS (
             SELECT 1 FROM system_metadata archive
             WHERE archive.key = 'design_archive:' || candidate.id
           )
         ORDER BY candidate.updated_at DESC, candidate.id DESC LIMIT 1`,
      ).get(design.product_id, design.id) as { id: string } | undefined;
      this.database.sqlite.prepare(
        `UPDATE products
         SET canonical_specification_design_id = ?, updated_at = ?
         WHERE id = ? AND organization_id = ? AND canonical_specification_design_id = ?`,
      ).run(
        replacement?.id ?? null,
        archivedAt,
        design.product_id,
        design.organization_id,
        design.id,
      );
      const tombstone = {
        schema_version: 1,
        design_id: design.id,
        organization_id: design.organization_id,
        archived_by: access.principalId,
        archived_at: archivedAt,
        version: design.current_version,
        revision_id: design.current_revision_id,
      };
      this.database.sqlite.prepare(
        "INSERT INTO system_metadata (key, value, updated_at) VALUES (?, ?, ?)",
      ).run(designArchiveMetadataKey(design.id), canonicalJson(tombstone), archivedAt);
      this.database.sqlite.prepare(
        `UPDATE contexts
         SET design_id = NULL, page_id = NULL, selection_json = '[]', updated_at = ?
         WHERE organization_id = ? AND design_id = ?`,
      ).run(archivedAt, design.organization_id, design.id);
      appendAuditEvent(this.database.sqlite, access, "design.archive", "design", design.id, {
        version: design.current_version,
        revisionId: design.current_revision_id,
        archivedAt,
      });
      this.enqueueEvent(actorId, "design.updated", {
        designId: design.id,
        version: design.current_version,
        revisionId: design.current_revision_id,
        archived: true,
      }, true, archivedAt);
      return {
        ...designSummary(design, archivedAt),
        status: "archived" as const,
        archivedAt,
      };
    });
  }

  restoreArchivedDesign(actorId: string, designId: string, input: {
    expectedVersion: number;
    expectedArchivedAt: string;
    idempotencyKey: string;
  }): DesignSummary {
    this.authorizeDesignArchive(actorId, designId);
    const scope = `design:${designId}:restore-archive`;
    return this.withIdempotency(actorId, scope, input.idempotencyKey, input, () => {
      const access = resolveAccess(this.database.sqlite, actorId);
      const design = this.requireDesignIncludingArchived(access, designId);
      const archive = this.requireDesignArchive(design);
      if (design.current_version !== input.expectedVersion || archive.version !== input.expectedVersion) {
        throw new DomainError("RESOURCE_STATE_CONFLICT", "The archived Design version changed before restoration.", 409, {
          retryable: true,
          details: {
            expectedVersion: input.expectedVersion,
            currentVersion: design.current_version,
            archivedVersion: archive.version,
          },
        });
      }
      if (archive.archivedAt !== input.expectedArchivedAt) {
        throw new DomainError("RESOURCE_STATE_CONFLICT", "The Design archive state changed before restoration.", 409, {
          retryable: true,
          details: {
            expectedArchivedAt: input.expectedArchivedAt,
            currentArchivedAt: archive.archivedAt,
          },
        });
      }
      const product = this.database.sqlite.prepare(
        `SELECT id, name, status, archived_at
         FROM products WHERE id = ? AND organization_id = ?`,
      ).get(design.product_id, design.organization_id) as {
        id: string;
        name: string;
        status: "active" | "archived";
        archived_at: string | null;
      } | undefined;
      if (!product) throw new DomainError("NOT_FOUND", "Product not found.", 404);
      if (product.status === "archived") {
        throw new DomainError(
          "PRODUCT_ARCHIVED",
          "Restore the Product before restoring its Designs.",
          409,
          {
            details: {
              productId: product.id,
              productName: product.name,
              archivedAt: product.archived_at,
              recovery: "Restore the Product, then retry this Design restoration.",
            },
          },
        );
      }

      const restoredAt = new Date().toISOString();
      const removed = this.database.sqlite.prepare(
        "DELETE FROM system_metadata WHERE key = ? AND updated_at = ?",
      ).run(designArchiveMetadataKey(design.id), archive.archivedAt);
      if (removed.changes !== 1) {
        throw new DomainError("RESOURCE_STATE_CONFLICT", "The Design archive state changed before restoration.", 409, {
          retryable: true,
          details: { expectedArchivedAt: input.expectedArchivedAt },
        });
      }
      const canonical = this.database.sqlite.prepare(
        `UPDATE products
         SET canonical_specification_design_id = ?, updated_at = ?
         WHERE id = ? AND organization_id = ? AND status = 'active'
           AND canonical_specification_design_id IS NULL`,
      ).run(design.id, restoredAt, design.product_id, design.organization_id);
      appendAuditEvent(this.database.sqlite, access, "design.restore_archive", "design", design.id, {
        productId: design.product_id,
        version: design.current_version,
        revisionId: design.current_revision_id,
        archivedAt: archive.archivedAt,
        restoredAt,
        selectedAsCanonical: canonical.changes === 1,
      });
      this.enqueueEvent(actorId, "design.updated", {
        designId: design.id,
        version: design.current_version,
        revisionId: design.current_revision_id,
        archived: false,
        restoredFromArchive: true,
      }, true, restoredAt);
      return designSummary(design, null);
    });
  }

  createDesign(actorId: string, input: {
    name: string;
    preset: "web" | "phone" | "tablet";
    productId?: string;
    idempotencyKey: string;
  }): RevisionResult {
    const access = resolveAccess(this.database.sqlite, actorId);
    assertDesignWrite(access);
    if (access.projectIds.length > 0) throw new DomainError("FORBIDDEN", "A project-restricted agent grant cannot create projects.", 403);
    const scope = "design:create";
    return this.withIdempotency(actorId, scope, input.idempotencyKey, input, () => {
      const now = new Date().toISOString();
      const designId = createId("document");
      const revisionId = createId("revision");
      const document = createDocument(designId, input.name, now, input.preset);
      const snapshot = storeSnapshot(this.database.sqlite, document, now);
      const operationsHash = operationHash([]);
      const integrityHash = revisionHash({
        parentRevisionHash: null,
        snapshotHash: snapshot.hash,
        operationHash: operationsHash,
        metadata: {
          id: revisionId,
          designId,
          version: 1,
          parentRevisionId: null,
          actorId,
          message: "Create design",
          createdAt: now,
        },
      });
      if (input.productId !== undefined) {
        const product = this.database.sqlite.prepare(
          `SELECT id FROM products
           WHERE id = ? AND organization_id = ? AND status = 'active'`,
        ).get(input.productId, access.organizationId);
        if (!product) throw new DomainError("NOT_FOUND", "Product not found.", 404);
      }
      this.database.sqlite.prepare(
        `INSERT INTO designs
         (id, product_id, actor_id, name, current_version, current_revision_id, created_at, updated_at, organization_id)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      ).run(
        designId,
        input.productId ?? null,
        actorId,
        input.name,
        revisionId,
        now,
        now,
        access.organizationId,
      );
      if (input.productId !== undefined) {
        this.database.sqlite.prepare(
          `UPDATE products
           SET canonical_specification_design_id = COALESCE(canonical_specification_design_id, ?),
               updated_at = ?
           WHERE id = ? AND organization_id = ? AND status = 'active'`,
        ).run(designId, now, input.productId, access.organizationId);
      }
      this.database.sqlite.prepare(
        `INSERT INTO revisions
         (id, design_id, version, parent_revision_id, actor_id, message, document_json, operations_json,
          snapshot_hash, operation_hash, parent_revision_hash, revision_hash, created_at)
         VALUES (?, ?, 1, NULL, ?, ?, ?, '[]', ?, ?, NULL, ?, ?)`,
      ).run(
        revisionId,
        designId,
        actorId,
        "Create design",
        snapshot.canonicalJson,
        snapshot.hash,
        operationsHash,
        integrityHash,
        now,
      );
      const createdDesign = this.database.sqlite.prepare(
        "SELECT * FROM designs WHERE id = ?",
      ).get(designId) as DesignRow | undefined;
      if (!createdDesign?.product_id) {
        throw new DomainError("INTERNAL_ERROR", "The new design has no Product association.", 500);
      }
      const result: RevisionResult = {
        design: designSummary(createdDesign),
        document,
        canonicalDocument: document,
        schemaVersion: 1,
        revision: {
          id: revisionId,
          version: 1,
          parentRevisionId: null,
          snapshotHash: snapshot.hash,
          operationHash: operationsHash,
          revisionHash: integrityHash,
          message: "Create design",
          createdAt: now,
        },
        diagnostics: collectDiagnostics(document),
        createdIds: [],
      };
      this.enqueueEvent(actorId, "design.updated", {
        designId,
        productId: createdDesign.product_id,
        version: 1,
        revisionId,
        created: true,
      }, true, now);
      appendAuditEvent(this.database.sqlite, access, "design.create", "design", designId, {
        productId: createdDesign.product_id,
        version: 1,
        revisionId,
      });
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
    const canonicalDocument = this.documentForRevision(revision);
    const document = editorDocument(canonicalDocument);
    if (!revision.snapshot_hash || !revision.operation_hash || !revision.revision_hash) {
      throw new DomainError("INTERNAL_ERROR", "Revision integrity metadata is missing.", 500);
    }
    return {
      design: designSummary(design),
      document,
      canonicalDocument,
      schemaVersion: canonicalDocument.schema_version,
      revision: {
        id: revision.id,
        version: revision.version,
        parentRevisionId: revision.parent_revision_id,
        snapshotHash: revision.snapshot_hash,
        operationHash: revision.operation_hash,
        revisionHash: revision.revision_hash,
        message: revision.message,
        createdAt: revision.created_at,
      },
      diagnostics: collectDiagnostics(canonicalDocument),
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

  authorizePreviewCreation(actorId: string, designId: string, taskId?: string, expectedBaseVersion?: number): void {
    const access = resolveAccess(this.database.sqlite, actorId);
    if (access.role === "agent") {
      assertScope(access, "design:preview");
      if (!taskId) {
        throw new DomainError(
          "VALIDATION_FAILED",
          "Agent design previews must be attached to an immutable claimed task.",
          422,
          { details: { requiredField: "task_id" } },
        );
      }
      this.assertAgentPreviewTask(access, designId, taskId, expectedBaseVersion);
    }
    this.requireDesign(actorId, designId);
  }

  authorizePreviewRead(actorId: string, designId: string, previewId: string, taskId?: string): void {
    this.loadPreview(actorId, designId, previewId, taskId, "read");
  }

  authorizePreviewCommit(actorId: string, designId: string, previewId: string, taskId?: string): void {
    const access = resolveAccess(this.database.sqlite, actorId);
    if (access.role === "agent") {
      throw new DomainError(
        "FORBIDDEN",
        "Agent connections cannot commit design previews; publish the task preview for human approval.",
        403,
        { details: { requiredAction: "human_approval" } },
      );
    }
    assertDesignWrite(access);
    this.loadPreview(actorId, designId, previewId, taskId, "commit");
  }

  createPreview(actorId: string, designId: string, input: {
    baseVersion?: number;
    basePreviewId?: string;
    operations: unknown;
    kind?: PreviewKind;
    taskId?: string;
  }): PreviewResult {
    this.authorizePreviewCreation(actorId, designId, input.taskId, input.baseVersion);
    if (!this.database.sqlite.inTransaction) {
      const transaction = this.database.sqlite.transaction(() => this.createPreview(actorId, designId, input));
      return transaction.immediate();
    }
    assertOperationPayloadLimit(input.operations, "preview");
    this.database.cleanupIdempotency();
    this.database.cleanupPreviews();
    if ((input.baseVersion === undefined) === (input.basePreviewId === undefined)) {
      throw new DomainError("VALIDATION_FAILED", "Provide exactly one of baseVersion or basePreviewId.", 422);
    }
    const currentDesign = this.requireDesign(actorId, designId);
    let baseDocument: AnyDesignDocument;
    let rootBaseVersion: number;
    let baseRevisionId: string;
    let baseSnapshotHash: string;
    let priorOperations: DesignOperation[] = [];
    let basePreviewId: string | null = null;
    let temporaryIdMap: Record<string, string> = {};
    let priorCreatedIds: unknown = {};
    const requestedKind = input.kind ?? "ordinary";

    if (input.basePreviewId) {
      const preview = this.requirePreviewForRead(actorId, designId, input.basePreviewId);
      if (input.taskId !== undefined) {
        requirePreviewTaskBinding(this.database.sqlite, preview.id, input.taskId);
      }
      if (preview.status === "committed") {
        throw new DomainError("PREVIEW_ALREADY_COMMITTED", "A committed preview cannot be refined; use the new design head.", 409, {
          details: { committedRevisionId: preview.committed_revision_id },
        });
      }
      if (preview.kind !== requestedKind) {
        throw new DomainError("VALIDATION_FAILED", "A preview refinement must keep the same ordinary or archive kind.", 422, {
          details: { basePreviewKind: preview.kind, requestedKind },
        });
      }
      if (!preview.result_snapshot_hash || !preview.base_revision_id || !preview.base_snapshot_hash) {
        throw new DomainError("INTERNAL_ERROR", "Preview snapshot metadata is missing.", 500);
      }
      baseDocument = parseDocument(JSON.parse(readSnapshotJson(this.database.sqlite, preview.result_snapshot_hash)));
      rootBaseVersion = preview.root_base_version;
      baseRevisionId = preview.base_revision_id;
      baseSnapshotHash = preview.base_snapshot_hash;
      priorOperations = parseOperations(JSON.parse(preview.operations_json));
      basePreviewId = preview.id;
      temporaryIdMap = JSON.parse(preview.temporary_id_map_json) as Record<string, string>;
      priorCreatedIds = JSON.parse(preview.created_ids_json) as unknown;
    } else {
      rootBaseVersion = input.baseVersion as number;
      if (rootBaseVersion !== currentDesign.current_version) {
        throw this.versionConflict(rootBaseVersion, currentDesign.current_version, currentDesign.current_revision_id);
      }
      const baseRevision = this.requireRevision(designId, rootBaseVersion);
      if (!baseRevision.snapshot_hash) throw new DomainError("INTERNAL_ERROR", "Base revision snapshot is missing.", 500);
      baseRevisionId = baseRevision.id;
      baseSnapshotHash = baseRevision.snapshot_hash;
      baseDocument = this.documentForRevision(baseRevision);
    }
    const previewAccess = resolveAccess(this.database.sqlite, actorId);
    if (previewAccess.role === "agent") {
      this.assertAgentPreviewTask(previewAccess, designId, input.taskId as string, rootBaseVersion);
    }

    assertOperationPayloadLimit([...priorOperations, ...input.operations], "preview");
    const normalized = normalizeTemporaryReferences(input.operations);
    const operations = parseOperations(normalized.operations);
    const cumulativeOperations = [...priorOperations, ...operations];
    assertOperationPayloadLimit(cumulativeOperations, "preview");
    const archiveOperations = hasArchiveOperations(cumulativeOperations);
    if (requestedKind === "ordinary" && archiveOperations) {
      throw new DomainError("VALIDATION_FAILED", "Archive operations require an archive preview.", 422, {
        details: {
          requiredPreviewKind: "archive",
          requiredPreviewEndpoint: `/api/designs/${designId}/archive-previews`,
          requiredTool: "design_preview_archive_nodes",
        },
      });
    }
    if (requestedKind === "archive" && !archiveOperations) {
      throw new DomainError("VALIDATION_FAILED", "An archive preview must contain an archive operation.", 422);
    }
    const now = new Date().toISOString();
    const applied = applyOperations(baseDocument, operations, {
      expectedRevision: baseDocument.revision,
      now,
    });
    const canonicalDocument = forceDocumentRevision(applied.document, rootBaseVersion + 1, now);
    const document = editorDocument(canonicalDocument);
    const operationsHash = operationHash(cumulativeOperations);
    const previewId = createId("preview");
    const expiresAt = new Date(Date.now() + this.previewTtlSeconds * 1000).toISOString();
    const diagnostics = applied.diagnostics;
    const canCommit = !diagnostics.some((item) => item.severity === "error");
    const status: PreviewStatus = canCommit ? "ready" : "blocked";
    temporaryIdMap = { ...temporaryIdMap, ...normalized.idMap };
    const createdIds = mergeCreatedIds(priorCreatedIds, applied.createdIds);
    const resultSnapshot = storeSnapshot(this.database.sqlite, canonicalDocument, now);
    const rootBaseDocument = parseDocument(JSON.parse(readSnapshotJson(this.database.sqlite, baseSnapshotHash)));
    const changedIds = changedNodeIds(rootBaseDocument, canonicalDocument);

    this.database.sqlite.prepare(
      `INSERT INTO previews
       (id, organization_id, design_id, actor_id, root_base_version, base_revision_id, base_snapshot_hash, base_preview_id,
        operation_hash, operations_json, document_json, result_snapshot_hash, diagnostics_json,
        temporary_id_map_json, created_ids_json, changed_node_ids_json, command_engine_version,
        renderer_version, font_bundle_version, status, kind, committable, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      previewId,
      currentDesign.organization_id,
      designId,
      actorId,
      rootBaseVersion,
      baseRevisionId,
      baseSnapshotHash,
      basePreviewId,
      operationsHash,
      JSON.stringify(cumulativeOperations),
      resultSnapshot.canonicalJson,
      resultSnapshot.hash,
      JSON.stringify(diagnostics),
      JSON.stringify(temporaryIdMap),
      JSON.stringify(createdIds),
      JSON.stringify(changedIds),
      this.versions.commandEngine,
      this.versions.renderer,
      this.versions.fontBundle,
      status,
      requestedKind,
      canCommit ? 1 : 0,
      now,
      expiresAt,
    );
    if (input.taskId !== undefined) {
      bindPreviewToTask(this.database.sqlite, previewId, input.taskId, now);
    }

    return {
      id: previewId,
      designId,
      rootBaseVersion,
      baseRevisionId,
      baseSnapshotHash,
      basePreviewId,
      operationHash: operationsHash,
      resultSnapshotHash: resultSnapshot.hash,
      expiresAt,
      canCommit,
      destructive: requestedKind === "archive",
      kind: requestedKind,
      status,
      changedNodeIds: changedIds,
      versions: {
        commandEngine: this.versions.commandEngine,
        renderer: this.versions.renderer,
        fontBundle: this.versions.fontBundle,
      },
      committedRevisionId: null,
      renderMetadata: null,
      diagnostics,
      createdIds: {
        temporary: temporaryIdMap,
        created: createdIds,
      },
      document,
      canonicalDocument,
      schemaVersion: canonicalDocument.schema_version,
    };
  }

  /**
   * Persist an exact server-resolved ordinary preview. This is used for
   * operations whose immutable inputs live behind an authorized service
   * boundary (for example a component source in a pinned design-system
   * release) and therefore cannot be accepted as caller-supplied trees.
   */
  createPreparedPreview(actorId: string, designId: string, input: {
    baseVersion: number;
    operations: unknown;
    document: AnyDesignDocument;
    diagnostics?: Diagnostic[];
    createdIds?: unknown;
    taskId?: string;
  }): PreviewResult {
    this.authorizePreviewCreation(actorId, designId, input.taskId, input.baseVersion);
    if (!this.database.sqlite.inTransaction) {
      const transaction = this.database.sqlite.transaction(() => this.createPreparedPreview(actorId, designId, input));
      return transaction.immediate();
    }
    assertOperationPayloadLimit(input.operations, "preview");
    const operations = parseOperations(input.operations);
    if (hasArchiveOperations(operations)) {
      throw new DomainError("VALIDATION_FAILED", "A prepared ordinary preview cannot contain archive operations.", 422);
    }
    const currentDesign = this.requireDesign(actorId, designId);
    if (currentDesign.current_version !== input.baseVersion) {
      throw this.versionConflict(input.baseVersion, currentDesign.current_version, currentDesign.current_revision_id);
    }
    const baseRevision = this.requireRevision(designId, input.baseVersion);
    if (!baseRevision.snapshot_hash) throw new DomainError("INTERNAL_ERROR", "Base revision snapshot is missing.", 500);
    const prepared = parseDocument(input.document);
    if (prepared.id !== designId) {
      throw new DomainError("VALIDATION_FAILED", "Prepared preview document identity does not match the project.", 422);
    }

    const now = new Date().toISOString();
    const canonicalDocument = forceDocumentRevision(prepared, input.baseVersion + 1, now);
    const diagnostics = input.diagnostics ?? collectDiagnostics(canonicalDocument);
    const canCommit = !diagnostics.some((item) => item.severity === "error");
    const status: PreviewStatus = canCommit ? "ready" : "blocked";
    const operationsHash = operationHash(operations);
    const previewId = createId("preview");
    const expiresAt = new Date(Date.now() + this.previewTtlSeconds * 1000).toISOString();
    const resultSnapshot = storeSnapshot(this.database.sqlite, canonicalDocument, now);
    const baseDocument = parseDocument(JSON.parse(readSnapshotJson(this.database.sqlite, baseRevision.snapshot_hash)));
    const changedIds = changedNodeIds(baseDocument, canonicalDocument);
    const createdIds = input.createdIds ?? {
      pages: [],
      nodes: [],
      tokens: [],
      assets: [],
      prototype_links: [],
    };

    this.database.sqlite.prepare(
      `INSERT INTO previews
       (id, organization_id, design_id, actor_id, root_base_version, base_revision_id, base_snapshot_hash, base_preview_id,
        operation_hash, operations_json, document_json, result_snapshot_hash, diagnostics_json,
        temporary_id_map_json, created_ids_json, changed_node_ids_json, command_engine_version,
        renderer_version, font_bundle_version, status, kind, committable, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?, 'ordinary', ?, ?, ?)`,
    ).run(
      previewId,
      currentDesign.organization_id,
      designId,
      actorId,
      input.baseVersion,
      baseRevision.id,
      baseRevision.snapshot_hash,
      operationsHash,
      JSON.stringify(operations),
      resultSnapshot.canonicalJson,
      resultSnapshot.hash,
      JSON.stringify(diagnostics),
      JSON.stringify(createdIds),
      JSON.stringify(changedIds),
      this.versions.commandEngine,
      this.versions.renderer,
      this.versions.fontBundle,
      status,
      canCommit ? 1 : 0,
      now,
      expiresAt,
    );
    if (input.taskId !== undefined) {
      bindPreviewToTask(this.database.sqlite, previewId, input.taskId, now);
    }

    return {
      id: previewId,
      designId,
      rootBaseVersion: input.baseVersion,
      baseRevisionId: baseRevision.id,
      baseSnapshotHash: baseRevision.snapshot_hash,
      basePreviewId: null,
      operationHash: operationsHash,
      resultSnapshotHash: resultSnapshot.hash,
      expiresAt,
      canCommit,
      destructive: false,
      kind: "ordinary",
      status,
      changedNodeIds: changedIds,
      versions: {
        commandEngine: this.versions.commandEngine,
        renderer: this.versions.renderer,
        fontBundle: this.versions.fontBundle,
      },
      committedRevisionId: null,
      renderMetadata: null,
      diagnostics,
      createdIds: { temporary: {}, created: createdIds },
      document: editorDocument(canonicalDocument),
      canonicalDocument,
      schemaVersion: canonicalDocument.schema_version,
    };
  }

  getPreview(
    actorId: string,
    designId: string,
    previewId: string,
    options: { taskId?: string } = {},
  ): PreviewResult {
    const row = this.requirePreviewForRead(actorId, designId, previewId, options.taskId);
    if (!row.base_revision_id || !row.base_snapshot_hash || !row.result_snapshot_hash) {
      throw new DomainError("INTERNAL_ERROR", "Preview snapshot metadata is missing.", 500);
    }
    const canonicalDocument = parseDocument(JSON.parse(readSnapshotJson(this.database.sqlite, row.result_snapshot_hash)));
    const renderMetadata = row.render_metadata_json === null
      ? null
      : parsePreviewRenderMetadata(row.render_metadata_json);
    if (renderMetadata?.options.pageId !== undefined
      && !canonicalDocument.pages.some((page) => page.id === renderMetadata.options.pageId)) {
      throw new DomainError("INTERNAL_ERROR", "Stored preview render metadata references a missing page.", 500);
    }
    if (renderMetadata?.options.pageIds !== undefined
      && renderMetadata.options.pageIds.some(
        (pageId) => !canonicalDocument.pages.some((page) => page.id === pageId),
      )) {
      throw new DomainError("INTERNAL_ERROR", "Stored preview contact-sheet metadata references a missing page.", 500);
    }
    if (renderMetadata?.options.nodeId !== undefined
      && canonicalDocument.nodes[renderMetadata.options.nodeId] === undefined) {
      throw new DomainError("INTERNAL_ERROR", "Stored preview render metadata references a missing node.", 500);
    }
    return {
      id: row.id,
      designId: row.design_id,
      rootBaseVersion: row.root_base_version,
      baseRevisionId: row.base_revision_id,
      baseSnapshotHash: row.base_snapshot_hash,
      basePreviewId: row.base_preview_id,
      operationHash: row.operation_hash,
      resultSnapshotHash: row.result_snapshot_hash,
      expiresAt: row.expires_at,
      canCommit: row.status === "ready" && row.committable === 1,
      destructive: row.kind === "archive",
      kind: row.kind,
      status: row.status,
      changedNodeIds: JSON.parse(row.changed_node_ids_json) as string[],
      versions: {
        commandEngine: row.command_engine_version,
        renderer: row.renderer_version,
        fontBundle: row.font_bundle_version,
      },
      committedRevisionId: row.committed_revision_id,
      renderMetadata,
      diagnostics: JSON.parse(row.diagnostics_json) as Diagnostic[],
      createdIds: {
        temporary: JSON.parse(row.temporary_id_map_json) as unknown,
        created: JSON.parse(row.created_ids_json) as unknown,
      },
      document: editorDocument(canonicalDocument),
      canonicalDocument,
      schemaVersion: canonicalDocument.schema_version,
    };
  }

  recordPreviewRenderMetadata(
    actorId: string,
    designId: string,
    previewId: string,
    capture: PreviewRenderCapture,
    options: { taskId?: string } = {},
  ): PreviewRenderMetadata {
    if (!this.database.sqlite.inTransaction) {
      const transaction = this.database.sqlite.transaction(() => this.recordPreviewRenderMetadata(
        actorId,
        designId,
        previewId,
        capture,
        options,
      ));
      return transaction.immediate();
    }

    this.authorizePreviewCreation(actorId, designId, options.taskId);
    const row = this.loadPreview(actorId, designId, previewId, options.taskId, "read");
    const previewAccess = resolveAccess(this.database.sqlite, actorId);
    if (previewAccess.role === "agent") {
      this.assertAgentPreviewTask(previewAccess, designId, options.taskId as string, row.root_base_version);
    }
    if (row.actor_id !== actorId) throw new DomainError("NOT_FOUND", "Preview not found.", 404);
    const now = new Date().toISOString();
    if (row.status === "committed") {
      throw new DomainError("PREVIEW_ALREADY_COMMITTED", "The preview was already committed.", 409);
    }
    if (row.status === "expired" || row.expires_at <= now) {
      throw new DomainError("PREVIEW_EXPIRED", "The preview expired; create a new preview.", 410, { retryable: true });
    }
    if (row.status !== "ready" && row.status !== "blocked") {
      throw new DomainError("PREVIEW_NOT_COMMITTABLE", "The preview is not available for render capture.", 409);
    }
    const preview = this.getPreview(actorId, designId, previewId, options);
    const metadata = buildPreviewRenderMetadata(preview.canonicalDocument, capture);
    const serialized = canonicalJson(metadata);
    this.previewRenderStore?.write(capture.png, metadata.sha256);
    if (preview.renderMetadata !== null) {
      if (canonicalJson(preview.renderMetadata) === serialized) return preview.renderMetadata;
      throw new DomainError(
        "IDEMPOTENCY_CONFLICT",
        "This preview already has different immutable render metadata.",
        409,
        { details: { previewId, existingSha256: preview.renderMetadata.sha256 } },
      );
    }

    const updated = this.database.sqlite.prepare(
      `UPDATE previews SET render_metadata_json = ?
       WHERE id = ? AND design_id = ? AND organization_id = ? AND actor_id = ?
         AND status IN ('ready', 'blocked') AND expires_at > ? AND render_metadata_json IS NULL`,
    ).run(serialized, previewId, designId, row.organization_id, actorId, now);
    if (updated.changes === 1) return metadata;

    const concurrent = this.database.sqlite.prepare(
      `SELECT render_metadata_json, status, expires_at, actor_id, organization_id
       FROM previews WHERE id = ? AND design_id = ?`,
    ).get(previewId, designId) as {
      render_metadata_json: string | null;
      status: PreviewStatus;
      expires_at: string;
      actor_id: string;
      organization_id: string;
    } | undefined;
    if (!concurrent
      || concurrent.actor_id !== actorId
      || concurrent.organization_id !== row.organization_id) {
      throw new DomainError("NOT_FOUND", "Preview not found.", 404);
    }
    if (concurrent.status === "expired" || concurrent.expires_at <= now) {
      throw new DomainError("PREVIEW_EXPIRED", "The preview expired; create a new preview.", 410, { retryable: true });
    }
    if (concurrent.status === "committed") {
      throw new DomainError("PREVIEW_ALREADY_COMMITTED", "The preview was already committed.", 409);
    }
    if (!concurrent.render_metadata_json) {
      throw new DomainError("INTERNAL_ERROR", "Preview render metadata could not be persisted.", 500, {
        retryable: true,
      });
    }
    const existing = parsePreviewRenderMetadata(concurrent.render_metadata_json);
    if (canonicalJson(existing) === serialized) return existing;
    throw new DomainError(
      "IDEMPOTENCY_CONFLICT",
      "This preview already has different immutable render metadata.",
      409,
      { details: { previewId, existingSha256: existing.sha256 } },
    );
  }

  getExactPreviewForRender(
    actorId: string,
    designId: string,
    previewId: string,
    options: { taskId?: string } = {},
  ): ExactPreviewRenderResult {
    const preview = this.getPreview(actorId, designId, previewId, options);
    const renderMetadata = this.requireCompatiblePreviewRenderMetadata(preview);
    return { preview, renderMetadata };
  }

  readStoredExactPreviewRender(
    actorId: string,
    designId: string,
    previewId: string,
    options: { taskId?: string } = {},
  ): StoredExactPreviewRenderResult | null {
    const exact = this.getExactPreviewForRender(actorId, designId, previewId, options);
    if (!this.previewRenderStore) return null;
    const png = this.previewRenderStore.read(exact.renderMetadata.sha256);
    return png === null ? null : { ...exact, png };
  }

  requireStoredExactPreviewRender(
    actorId: string,
    designId: string,
    previewId: string,
    options: { taskId?: string } = {},
  ): StoredExactPreviewRenderResult {
    const stored = this.readStoredExactPreviewRender(actorId, designId, previewId, options);
    if (stored !== null) return stored;
    const exact = this.getExactPreviewForRender(actorId, designId, previewId, options);
    if (!this.previewRenderStore) {
      return { ...exact, png: Buffer.alloc(0) };
    }
    throw new DomainError(
      "PREVIEW_ENGINE_MISMATCH",
      "The exact preview PNG artifact is missing from durable storage.",
      409,
      {
        retryable: true,
        details: {
          previewId,
          expectedSha256: exact.renderMetadata.sha256,
          recovery: "Open the exact review image once to hydrate a matching legacy preview, or regenerate it.",
        },
      },
    );
  }

  verifyExactPreviewRender(
    actorId: string,
    designId: string,
    previewId: string,
    capture: Omit<PreviewRenderCapture, "options">,
    options: { taskId?: string } = {},
  ): PreviewRenderMetadata {
    const { preview, renderMetadata } = this.getExactPreviewForRender(actorId, designId, previewId, options);
    const observed = buildPreviewRenderMetadata(preview.canonicalDocument, {
      ...capture,
      options: renderMetadata.options,
    });
    if (observed.sha256 !== renderMetadata.sha256
      || observed.width !== renderMetadata.width
      || observed.height !== renderMetadata.height
      || observed.renderer !== renderMetadata.renderer) {
      throw new DomainError(
        "PREVIEW_ENGINE_MISMATCH",
        "The exact preview render no longer matches the persisted renderer output.",
        409,
        {
          retryable: true,
          details: {
            previewId,
            expectedSha256: renderMetadata.sha256,
            actualSha256: observed.sha256,
            expectedRenderer: renderMetadata.renderer,
            actualRenderer: observed.renderer,
            recovery: "Create a new preview with the current renderer before review or commit.",
          },
        },
      );
    }
    this.previewRenderStore?.write(capture.png, observed.sha256);
    return renderMetadata;
  }

  commitPreview(actorId: string, designId: string, input: {
    previewId: string;
    expectedBaseVersion: number;
    idempotencyKey: string;
    message?: string;
    kind?: PreviewKind;
    taskId?: string;
    requireRenderEvidence?: boolean;
  }): RevisionResult {
    if (input.taskId !== undefined) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "Task-bound design previews must be approved through the atomic task approval workflow.",
        422,
        { details: { taskId: input.taskId, requiredAction: "approve_task_preview" } },
      );
    }
    this.authorizePreviewCommit(actorId, designId, input.previewId, input.taskId);
    const scope = `design:${designId}:commit-preview`;
    this.database.cleanupPreviews();
    // Keep enforcement policy out of the request hash so a successful commit
    // recorded by an older server remains retryable through the MCP path.
    const normalizedInput = {
      previewId: input.previewId,
      expectedBaseVersion: input.expectedBaseVersion,
      idempotencyKey: input.idempotencyKey,
      kind: input.kind ?? "ordinary",
      message: input.message ?? "Commit preview",
      taskId: input.taskId ?? null,
    };
    return this.withIdempotency(actorId, scope, input.idempotencyKey, normalizedInput, () => {
      if (input.requireRenderEvidence === true) {
        this.requireStoredExactPreviewRender(
          actorId,
          designId,
          normalizedInput.previewId,
          normalizedInput.taskId === null ? {} : { taskId: normalizedInput.taskId },
        );
      }
      return this.commitPreviewInTransaction(actorId, designId, {
        previewId: normalizedInput.previewId,
        expectedBaseVersion: normalizedInput.expectedBaseVersion,
        kind: normalizedInput.kind,
        message: normalizedInput.message,
        ...(normalizedInput.taskId === null ? {} : { taskId: normalizedInput.taskId }),
      });
    });
  }

  commitExactTaskPreviewInCurrentTransaction(actorId: string, designId: string, input: {
    previewId: string;
    expectedBaseVersion: number;
    taskId: string;
    kind?: PreviewKind;
    message: string;
  }): RevisionResult {
    if (!this.database.sqlite.inTransaction) {
      throw new DomainError("INTERNAL_ERROR", "Task preview approval requires an active immediate transaction.", 500);
    }
    this.authorizePreviewCommit(actorId, designId, input.previewId, input.taskId);
    this.requireStoredExactPreviewRender(actorId, designId, input.previewId, { taskId: input.taskId });
    return this.commitPreviewInTransaction(actorId, designId, {
      previewId: input.previewId,
      expectedBaseVersion: input.expectedBaseVersion,
      kind: input.kind ?? "ordinary",
      message: input.message,
      taskId: input.taskId,
    });
  }

  applyRevision(actorId: string, designId: string, input: {
    baseVersion: number;
    operations: unknown;
    idempotencyKey: string;
    message?: string;
  }): RevisionResult {
    this.authorizeDesignRevision(actorId, designId);
    assertOperationPayloadLimit(input.operations, "revision");
    const operations = parseOperations(input.operations);
    if (hasArchiveOperations(operations)) {
      throw new DomainError("VALIDATION_FAILED", "Archive operations are not allowed in an ordinary revision.", 422, {
        details: {
          requiredPreviewEndpoint: `/api/designs/${designId}/archive-previews`,
          requiredCommitEndpoint: `/api/designs/${designId}/archive-previews/:previewId/commit`,
          requiredPreviewKind: "archive",
        },
      });
    }
    const scope = `design:${designId}:revision`;
    return this.withIdempotency(actorId, scope, input.idempotencyKey, input, () => {
      const design = this.requireDesign(actorId, designId);
      if (design.current_version !== input.baseVersion) {
        throw this.versionConflict(input.baseVersion, design.current_version, design.current_revision_id);
      }
      const current = this.getDesign(actorId, designId, input.baseVersion).canonicalDocument;
      const now = new Date().toISOString();
      const applied = applyOperations(current, operations, { expectedRevision: current.revision, now });
      const document = forceDocumentRevision(applied.document, input.baseVersion + 1, now);
      return this.commitDocumentInTransaction(actorId, designId, {
        baseVersion: input.baseVersion,
        document,
        operations,
        diagnostics: applied.diagnostics,
        createdIds: applied.createdIds,
        message: input.message ?? "Update design",
      });
    });
  }

  commitDesignSystemPinRevisionInTransaction(actorId: string, designId: string, input: {
    expectedBaseVersion: number;
    expectedBaseRevisionId: string;
    designSystemId: string;
    releaseId: string;
    releaseVersion: number;
    message: string;
    now?: string;
  }): RevisionResult | null {
    if (!this.database.sqlite.inTransaction) {
      throw new DomainError("INTERNAL_ERROR", "Design-system pin revisions require an active transaction.", 500);
    }
    const design = this.requireDesign(actorId, designId);
    if (design.current_version !== input.expectedBaseVersion || design.current_revision_id !== input.expectedBaseRevisionId) {
      throw this.versionConflict(input.expectedBaseVersion, design.current_version, design.current_revision_id);
    }
    const current = this.getDesign(actorId, designId, input.expectedBaseVersion).canonicalDocument;
    if (current.schema_version !== 2) return null;
    const now = input.now ?? new Date().toISOString();
    const document = DesignDocumentV2Schema.parse({
      ...current,
      revision: input.expectedBaseVersion + 1,
      design_system: {
        design_system_id: input.designSystemId,
        release_id: input.releaseId,
        release_version: input.releaseVersion,
      },
      updated_at: now,
    });
    return this.commitDocumentInTransaction(actorId, designId, {
      baseVersion: input.expectedBaseVersion,
      document,
      operations: [],
      diagnostics: collectDiagnostics(document),
      createdIds: [],
      message: input.message,
    });
  }

  commitExactSnapshotInTransaction(actorId: string, designId: string, input: {
    expectedBaseVersion: number;
    expectedBaseRevisionId: string;
    expectedBaseSnapshotHash: string;
    resultSnapshotHash: string;
    message: string;
    diagnostics?: Diagnostic[];
    createdIds?: unknown;
  }): RevisionResult {
    if (!this.database.sqlite.inTransaction) {
      throw new DomainError("INTERNAL_ERROR", "Exact snapshot commits require an active transaction.", 500);
    }
    const design = this.requireDesign(actorId, designId);
    if (design.current_version !== input.expectedBaseVersion
      || design.current_revision_id !== input.expectedBaseRevisionId) {
      throw this.versionConflict(input.expectedBaseVersion, design.current_version, design.current_revision_id);
    }
    const baseRevision = this.requireRevision(designId, input.expectedBaseVersion);
    if (baseRevision.id !== input.expectedBaseRevisionId
      || baseRevision.snapshot_hash !== input.expectedBaseSnapshotHash) {
      throw new DomainError("VERSION_CONFLICT", "The exact commit base snapshot changed after preview.", 409, {
        retryable: true,
        details: {
          expectedRevisionId: input.expectedBaseRevisionId,
          currentRevisionId: baseRevision.id,
          expectedSnapshotHash: input.expectedBaseSnapshotHash,
          currentSnapshotHash: baseRevision.snapshot_hash,
        },
      });
    }
    const document = parseDocument(JSON.parse(readSnapshotJson(this.database.sqlite, input.resultSnapshotHash)));
    if (document.id !== designId || document.revision !== input.expectedBaseVersion + 1) {
      throw new DomainError("VALIDATION_FAILED", "The exact commit snapshot identity or revision is invalid.", 422);
    }
    if (canonicalSnapshot(document).hash !== input.resultSnapshotHash) {
      throw new DomainError("VALIDATION_FAILED", "The exact commit snapshot hash is invalid.", 422);
    }
    return this.commitDocumentInTransaction(actorId, designId, {
      baseVersion: input.expectedBaseVersion,
      document,
      operations: [],
      expectedSnapshotHash: input.resultSnapshotHash,
      diagnostics: input.diagnostics ?? collectDiagnostics(document),
      createdIds: input.createdIds ?? [],
      message: input.message,
    });
  }

  migrateDesignHeadToV2(actorId: string, designId: string, input: {
    expectedBaseVersion: number;
    backupId: string;
    idempotencyKey: string;
  }): HeadMigrationResult {
    this.authorizeDesignMigration(actorId, designId);
    const access = resolveAccess(this.database.sqlite, actorId);
    const scope = `design:${designId}:migrate-v2`;
    return this.withIdempotency(actorId, scope, input.idempotencyKey, input, () => {
      const design = this.requireDesign(actorId, designId);
      if (design.current_version !== input.expectedBaseVersion) {
        throw this.versionConflict(input.expectedBaseVersion, design.current_version, design.current_revision_id);
      }
      const current = this.getDesign(actorId, designId, input.expectedBaseVersion);
      if (current.canonicalDocument.schema_version === 2) {
        return {
          migrated: false,
          backupId: current.canonicalDocument.migration?.verified_backup_id ?? null,
          result: current,
        };
      }
      const existingPin = this.database.sqlite.prepare(
        `SELECT design_system_id, release_id, release_version, pinned_at
         FROM project_design_system_pins
         WHERE design_id = ? AND organization_id = ?`,
      ).get(designId, access.organizationId) as {
        design_system_id: string;
        release_id: string;
        release_version: number;
        pinned_at: string;
      } | undefined;
      this.requireVerifiedMigrationBackup(access.organizationId, input.backupId, {
        designUpdatedAt: design.updated_at,
        projectPinUpdatedAt: existingPin?.pinned_at ?? null,
      });
      const parent = this.requireRevision(designId, input.expectedBaseVersion);
      if (!parent.snapshot_hash) throw new DomainError("INTERNAL_ERROR", "Migration source snapshot metadata is missing.", 500);
      const now = new Date().toISOString();
      const source = {
        ...current.canonicalDocument,
        revision: input.expectedBaseVersion + 1,
        updated_at: now,
      };
      const migratedBase = migrateDesignDocumentV1ToV2(source, {
        migratedAt: now,
        sourceRevisionId: parent.id,
        sourceSnapshotHash: parent.snapshot_hash,
        verifiedBackupId: input.backupId,
      });
      const migrated = existingPin ? DesignDocumentV2Schema.parse({
        ...migratedBase,
        design_system: {
          design_system_id: existingPin.design_system_id,
          release_id: existingPin.release_id,
          release_version: existingPin.release_version,
        },
      }) : migratedBase;
      const result = this.commitDocumentInTransaction(actorId, designId, {
        baseVersion: input.expectedBaseVersion,
        document: migrated,
        operations: [],
        diagnostics: collectDiagnostics(migrated),
        createdIds: [],
        message: "System migration from document schema V1 to V2",
        revisionActorId: V2_MIGRATION_ACTOR_ID,
      });
      appendAuditEvent(this.database.sqlite, access, "design.schema_migrate_v2", "design", designId, {
        designId,
        sourceVersion: input.expectedBaseVersion,
        sourceRevisionId: parent.id,
        sourceSnapshotHash: parent.snapshot_hash,
        targetVersion: result.revision.version,
        targetRevisionId: result.revision.id,
        targetSnapshotHash: result.revision.snapshotHash,
        verifiedBackupId: input.backupId,
        ...(existingPin ? {
          preservedDesignSystemId: existingPin.design_system_id,
          preservedReleaseId: existingPin.release_id,
          preservedReleaseVersion: existingPin.release_version,
        } : {}),
      });
      return { migrated: true, backupId: input.backupId, result };
    });
  }

  restoreRevision(actorId: string, designId: string, input: {
    targetVersion: number;
    expectedBaseVersion: number;
    idempotencyKey: string;
  }): RestoreRevisionResult {
    this.authorizeDesignRestore(actorId, designId);
    const scope = `design:${designId}:restore`;
    return this.withIdempotency(actorId, scope, input.idempotencyKey, input, () => {
      const access = resolveAccess(this.database.sqlite, actorId);
      const design = this.requireDesign(actorId, designId);
      if (design.current_version !== input.expectedBaseVersion) {
        throw this.versionConflict(input.expectedBaseVersion, design.current_version, design.current_revision_id);
      }
      const targetResult = this.getDesign(actorId, designId, input.targetVersion);
      const target = targetResult.canonicalDocument;
      const now = new Date().toISOString();
      const restored = this.restoreTargetWithActiveDesignSystemPin(design, target, input.targetVersion);
      const restore: RestoreDisposition = {
        targetVersion: input.targetVersion,
        targetRevisionId: targetResult.revision.id,
        targetSnapshotHash: targetResult.revision.snapshotHash,
        targetRevisionHash: targetResult.revision.revisionHash,
        targetSchemaVersion: target.schema_version,
        designSystem: restored.designSystem,
      };
      const provenance = {
        kind: "formaspec-revision-restore",
        formatVersion: 1,
        targetVersion: restore.targetVersion,
        targetRevisionId: restore.targetRevisionId,
        targetSnapshotHash: restore.targetSnapshotHash,
        targetRevisionHash: restore.targetRevisionHash,
        targetSchemaVersion: restore.targetSchemaVersion,
        designSystem: {
          status: restore.designSystem.status,
          pinSource: restore.designSystem.pinSource,
          active: restore.designSystem.active,
          historical: restore.designSystem.historical,
        },
      };
      const document = forceDocumentRevision(restored.document, input.expectedBaseVersion + 1, now);
      const result = this.commitDocumentInTransaction(actorId, designId, {
        baseVersion: input.expectedBaseVersion,
        document,
        operations: [],
        diagnostics: [...collectDiagnostics(document), ...restored.diagnostics],
        createdIds: [],
        message: `Restore version ${input.targetVersion}; provenance=${canonicalJson(provenance)}`,
      });
      appendAuditEvent(this.database.sqlite, access, "design.revision.restore", "revision", result.revision.id, {
        designId,
        revisionId: result.revision.id,
        revisionVersion: result.revision.version,
        revisionHash: result.revision.revisionHash,
        ...provenance,
        compatibilityDiagnostics: restore.designSystem.compatibilityDiagnostics,
      });
      return { ...result, restore };
    });
  }

  private restoreTargetWithActiveDesignSystemPin(
    design: DesignRow,
    target: AnyDesignDocument,
    targetVersion: number,
  ): {
    document: AnyDesignDocument;
    diagnostics: Diagnostic[];
    designSystem: RestoreDisposition["designSystem"];
  } {
    if (target.schema_version !== 2) return {
      document: target,
      diagnostics: [],
      designSystem: {
        status: "not_applicable_v1",
        pinSource: null,
        active: null,
        historical: null,
        compatibilityDiagnostics: [],
      },
    };
    const persistedPin = this.database.sqlite.prepare(
      `SELECT design_system_id, release_id, release_version
       FROM project_design_system_pins
       WHERE design_id = ? AND organization_id = ?`,
    ).get(design.id, design.organization_id) as {
      design_system_id: string;
      release_id: string;
      release_version: number;
    } | undefined;
    const currentPin = persistedPin ?? {
      design_system_id: FORMASPEC_FOUNDATION_SYSTEM_ID,
      release_id: FORMASPEC_FOUNDATION_RELEASE_ID,
      release_version: FORMASPEC_FOUNDATION_VERSION,
    };
    const historicalPin = target.design_system;
    const compatibility = assessDesignSystemReleaseCompatibility(this.database, {
      organizationId: design.organization_id,
      sourceReleaseId: historicalPin.release_id,
      targetReleaseId: currentPin.release_id,
      document: target,
    });
    if (compatibility.source.designSystemId !== historicalPin.design_system_id
      || compatibility.source.version !== historicalPin.release_version
      || compatibility.target.designSystemId !== currentPin.design_system_id
      || compatibility.target.version !== currentPin.release_version) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "Design-system release metadata is inconsistent with the restore source or active project pin.",
        422,
        {
          details: {
            targetVersion,
            historicalPin,
            activePin: currentPin,
            resolvedHistoricalRelease: compatibility.source,
            resolvedActiveRelease: compatibility.target,
          },
        },
      );
    }
    const blockingDiagnostics = compatibility.diagnostics.filter((diagnostic) => diagnostic.safety === "blocked");
    if (blockingDiagnostics.length > 0) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "The restored V2 content is incompatible with the active project design-system release.",
        422,
        {
          details: {
            reasonCode: "RESTORE_DESIGN_SYSTEM_INCOMPATIBLE",
            targetVersion,
            historicalPin,
            activePin: currentPin,
            diagnostics: blockingDiagnostics,
          },
        },
      );
    }
    const pinSource = persistedPin ? "project_design_system_pins" as const : "formaspec_foundation_default" as const;
    const samePin = historicalPin.design_system_id === currentPin.design_system_id
      && historicalPin.release_id === currentPin.release_id
      && historicalPin.release_version === currentPin.release_version;
    const active = {
      designSystemId: currentPin.design_system_id,
      releaseId: currentPin.release_id,
      releaseVersion: currentPin.release_version,
    };
    const historical = {
      designSystemId: historicalPin.design_system_id,
      releaseId: historicalPin.release_id,
      releaseVersion: historicalPin.release_version,
    };
    const document = samePin ? target : DesignDocumentV2Schema.parse({ ...target, design_system: currentPin });
    const compatibilityDiagnostics = compatibility.diagnostics;
    const normalizedCompatibilityDiagnostics: Diagnostic[] = compatibilityDiagnostics.map((diagnostic) => ({
      ...diagnostic,
    }));
    if (samePin) return {
      document,
      diagnostics: normalizedCompatibilityDiagnostics,
      designSystem: {
        status: "active_pin_unchanged",
        pinSource,
        active,
        historical,
        compatibilityDiagnostics,
      },
    };
    return {
      document,
      diagnostics: [
        ...normalizedCompatibilityDiagnostics,
        {
          severity: "warning",
          code: RESTORE_DESIGN_SYSTEM_PIN_PRESERVED,
          message: `Restored content from version ${targetVersion} while preserving active design-system release ${currentPin.release_id}; historical release ${historicalPin.release_id} was not restored.`,
          path: "design_system",
          target_version: targetVersion,
          pin_source: pinSource,
          active_design_system_id: currentPin.design_system_id,
          active_release_id: currentPin.release_id,
          active_release_version: currentPin.release_version,
          historical_design_system_id: historicalPin.design_system_id,
          historical_release_id: historicalPin.release_id,
          historical_release_version: historicalPin.release_version,
        },
      ],
      designSystem: {
        status: "active_pin_preserved",
        pinSource,
        active,
        historical,
        compatibilityDiagnostics,
      },
    };
  }

  history(actorId: string, designId: string, limit = 50): Array<Record<string, unknown>> {
    this.requireDesign(actorId, designId);
    const rows = this.database.sqlite.prepare(
      `SELECT id, version, parent_revision_id, actor_id, message, snapshot_hash,
              operation_hash, revision_hash, created_at
       FROM revisions WHERE design_id = ? ORDER BY version DESC LIMIT ?`,
    ).all(designId, Math.max(1, Math.min(limit, 200))) as Array<{
      id: string;
      version: number;
      parent_revision_id: string | null;
      actor_id: string;
      message: string | null;
      snapshot_hash: string;
      operation_hash: string;
      revision_hash: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      version: row.version,
      parentRevisionId: row.parent_revision_id,
      actorId: row.actor_id,
      message: row.message,
      snapshotHash: row.snapshot_hash,
      operationHash: row.operation_hash,
      revisionHash: row.revision_hash,
      createdAt: row.created_at,
    }));
  }

  latestEventId(actorId: string): number {
    const access = resolveAccess(this.database.sqlite, actorId);
    this.assertEventReadAccess(access);
    const visibility = designerEventSqlVisibility(access);
    const row = this.database.sqlite.prepare(
      `SELECT MAX(id) AS id FROM event_outbox
       WHERE organization_id = ? AND (workspace = 1 OR actor_id = ?) AND ${visibility.sql}`,
    ).get(access.organizationId, actorId, ...visibility.parameters) as { id: number | null };
    return row.id ?? 0;
  }

  authorizeEventRead(actorId: string): void {
    const access = resolveAccess(this.database.sqlite, actorId);
    this.assertEventReadAccess(access);
  }

  eventOrganizationId(actorId: string): string {
    return resolveAccess(this.database.sqlite, actorId).organizationId;
  }

  authorizeAssetUpload(actorId: string, designId?: string): string {
    const access = resolveAccess(this.database.sqlite, actorId);
    assertDesignWrite(access);
    if (access.projectIds.length > 0 && !designId) {
      throw new DomainError("FORBIDDEN", "A project-restricted grant must associate every asset with an allowed project.", 403);
    }
    if (designId) this.requireDesign(actorId, designId);
    const assetPolicy = loadOrganizationPolicy(this.database.sqlite, access.organizationId).policy.assets;
    if (!assetPolicy.enabled) {
      throw new DomainError("FORBIDDEN", "Asset uploads are disabled by organization policy.", 403);
    }
    return access.organizationId;
  }

  assetNormalizationOrganizationId(actorId: string, designId?: string): string {
    return this.authorizeAssetUpload(actorId, designId);
  }

  eventProjectIds(actorId: string): string[] {
    return resolveAccess(this.database.sqlite, actorId).projectIds;
  }

  eventsSince(actorId: string, afterId: number, limit = 500): EventReplayResult {
    const access = resolveAccess(this.database.sqlite, actorId);
    this.assertEventReadAccess(access);
    const boundedLimit = Math.max(1, Math.min(limit, 1000));
    const visibility = designerEventSqlVisibility(access);
    const bounds = this.database.sqlite.prepare(
      `SELECT MIN(id) AS earliest_id, MAX(id) AS latest_id
       FROM event_outbox
       WHERE organization_id = ? AND (workspace = 1 OR actor_id = ?) AND ${visibility.sql}`,
    ).get(access.organizationId, actorId, ...visibility.parameters) as { earliest_id: number | null; latest_id: number | null };
    const rows = this.database.sqlite.prepare(
      `SELECT id, organization_id, actor_id, event_type, payload_json, created_at
       FROM event_outbox
       WHERE id > ? AND organization_id = ? AND (workspace = 1 OR actor_id = ?) AND ${visibility.sql}
       ORDER BY id LIMIT ?`,
    ).all(afterId, access.organizationId, actorId, ...visibility.parameters, boundedLimit + 1) as Array<{
      id: number;
      organization_id: string;
      actor_id: string;
      event_type: DesignerEventType;
      payload_json: string;
      created_at: string;
    }>;
    const hasMore = rows.length > boundedLimit;
    return {
      events: rows.slice(0, boundedLimit).map((row) => {
        const data = JSON.parse(row.payload_json) as Record<string, unknown>;
        const event: DesignerEvent = {
          id: row.id,
          type: row.event_type,
          actorId: row.actor_id,
          organizationId: row.organization_id,
          ...(typeof data.designId === "string" ? { designId: data.designId } : {}),
          timestamp: row.created_at,
          data,
        };
        if (!canReadDesignerEvent(access, event)) {
          throw new DomainError("INTERNAL_ERROR", "Persisted event visibility does not match the authorization policy.", 500);
        }
        return event;
      }),
      earliestId: bounds.earliest_id,
      latestId: bounds.latest_id ?? 0,
      gap: afterId > 0 && bounds.earliest_id !== null && afterId < bounds.earliest_id - 1,
      hasMore,
    };
  }

  getContext(actorId: string, options: { workspaceFallback?: boolean; contextRef?: string } = {}): Record<string, unknown> {
    const access = resolveAccess(this.database.sqlite, actorId);
    if (access.role === "agent") assertScope(access, "design:read");
    const activeSince = new Date(Date.now() - ACTIVE_CONTEXT_WINDOW_MS).toISOString();
    this.database.sqlite.prepare(
      "DELETE FROM contexts WHERE organization_id = ? AND updated_at < ? AND actor_id GLOB ?",
    ).run(access.organizationId, activeSince, `${CLIENT_CONTEXT_ROW_PREFIX}*`);
    const ownedRows = this.database.sqlite.prepare(
      `SELECT * FROM contexts
       WHERE organization_id = ? AND design_id IS NOT NULL AND updated_at >= ?
         AND (actor_id = ? OR actor_id GLOB ?)
       ORDER BY updated_at DESC, actor_id ASC`,
    ).all(
      access.organizationId,
      activeSince,
      actorId,
      `${clientContextOwnerPrefix(actorId)}*`,
    ) as ContextRow[];
    for (const row of ownedRows) {
      this.requireDesign(actorId, row.design_id!);
    }
    const projectClause = access.projectIds.length > 0
      ? ` AND design_id IN (${access.projectIds.map(() => "?").join(", ")})`
      : "";
    const activeRows = this.database.sqlite.prepare(
      `SELECT * FROM contexts
       WHERE organization_id = ? AND design_id IS NOT NULL AND updated_at >= ? AND actor_id <> '__workspace_context__'
         ${projectClause}
         AND NOT EXISTS (
           SELECT 1 FROM system_metadata archive
           WHERE archive.key = 'design_archive:' || contexts.design_id
         )
       ORDER BY updated_at DESC, actor_id ASC`,
    ).all(access.organizationId, activeSince, ...access.projectIds) as ContextRow[];
    const rows = options.workspaceFallback
      ? activeRows
      : ownedRows;

    if (options.contextRef) {
      const selected = rows.find((row) => contextRefForActor(row.actor_id) === options.contextRef);
      if (!selected) {
        throw new DomainError("NOT_FOUND", "The requested active editor context was not found.", 404, {
          details: { contextRef: options.contextRef },
        });
      }
      return this.contextResult(
        actorId,
        selected,
        contextRowBelongsToActor(selected.actor_id, actorId) ? "actor" : "workspace",
      );
    }

    const distinct = new Map<string, ContextRow>();
    for (const row of rows) {
      const signature = `${row.design_id ?? ""}\u0000${row.page_id ?? ""}\u0000${row.selection_json}`;
      if (!distinct.has(signature)) distinct.set(signature, row);
    }
    const candidates = [...distinct.values()];
    if (candidates.length === 0) return inactiveContextResult();
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
    const selected = candidates[0]!;
    return this.contextResult(
      actorId,
      selected,
      contextRowBelongsToActor(selected.actor_id, actorId) ? "actor" : "workspace",
    );
  }

  private contextResult(
    actorId: string,
    row: ContextRow,
    contextSource: "actor" | "workspace",
  ): Record<string, unknown> {
    const head = row.design_id ? this.requireDesign(actorId, row.design_id) : null;
    const product = head ? this.database.sqlite.prepare(
      "SELECT id, name, status FROM products WHERE id = ? AND organization_id = ?",
    ).get(head.product_id, head.organization_id) as {
      id: string;
      name: string;
      status: "active" | "archived";
    } | undefined : undefined;
    if (head && !product) {
      throw new DomainError("INTERNAL_ERROR", "The active design Product association is unavailable.", 500);
    }
    return {
      designId: row.design_id,
      pageId: row.page_id,
      selection: JSON.parse(row.selection_json) as unknown,
      updatedAt: row.updated_at,
      contextRef: contextRefForActor(row.actor_id),
      contextSource,
      ...(head ? {
        product: product!,
        version: head.current_version,
        revisionId: head.current_revision_id,
      } : {}),
    };
  }

  authorizeContextWrite(actorId: string, designId?: string): void {
    const access = resolveAccess(this.database.sqlite, actorId);
    if (access.role === "agent") assertScope(access, "context:write");
    if (designId) this.requireDesign(actorId, designId);
  }

  setContext(actorId: string, input: {
    designId?: string | null;
    pageId?: string | null;
    selection?: string[];
    clientContextId?: string;
  }): Record<string, unknown> {
    this.authorizeContextWrite(actorId, input.designId ?? undefined);
    const access = resolveAccess(this.database.sqlite, actorId);
    if (input.clientContextId !== undefined && !CLIENT_CONTEXT_ID_PATTERN.test(input.clientContextId)) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "clientContextId must be an opaque 8 to 128 character identifier.",
        422,
        { details: { field: "clientContextId" } },
      );
    }
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
    const rowActorId = input.clientContextId === undefined
      ? actorId
      : clientContextRowKey(actorId, input.clientContextId);
    const transaction = this.database.sqlite.transaction(() => {
      if (input.clientContextId !== undefined && !input.designId) {
        this.database.sqlite.prepare(
          "DELETE FROM contexts WHERE actor_id = ? AND organization_id = ?",
        ).run(rowActorId, access.organizationId);
      } else {
        this.database.sqlite.prepare(
          `INSERT INTO contexts (actor_id, design_id, page_id, selection_json, updated_at, organization_id)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(actor_id) DO UPDATE SET
             design_id = excluded.design_id,
             page_id = excluded.page_id,
             selection_json = excluded.selection_json,
             updated_at = excluded.updated_at,
             organization_id = excluded.organization_id`,
        ).run(
          rowActorId,
          input.designId ?? null,
          input.pageId ?? null,
          JSON.stringify(input.selection ?? []),
          now,
          access.organizationId,
        );
      }
      const value = input.designId
        ? this.contextResult(actorId, {
          actor_id: rowActorId,
          design_id: input.designId,
          page_id: input.pageId ?? null,
          selection_json: JSON.stringify(input.selection ?? []),
          updated_at: now,
          organization_id: access.organizationId,
        }, "actor")
        : inactiveContextResult();
      this.enqueueEvent(actorId, "context.updated", value, false, now);
      return value;
    });
    const context = transaction.immediate();
    this.flushPendingEventsSafely();
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
    const access = resolveAccess(this.database.sqlite, actorId);
    assertDesignWrite(access);
    if (access.projectIds.length > 0 && !input.designId) {
      throw new DomainError("FORBIDDEN", "A project-restricted grant must associate every asset with an allowed project.", 403);
    }
    if (input.designId) this.requireDesign(actorId, input.designId);
    const assetPolicy = loadOrganizationPolicy(this.database.sqlite, access.organizationId).policy.assets;
    if (!assetPolicy.enabled) {
      throw new DomainError("FORBIDDEN", "Asset uploads are disabled by organization policy.", 403);
    }
    if (!assetPolicy.allowedMimeTypes.includes(input.mimeType as (typeof assetPolicy.allowedMimeTypes)[number])) {
      throw new DomainError("FORBIDDEN", "The normalized asset MIME type is not allowed by organization policy.", 403);
    }
    if (input.data.length > assetPolicy.maximumBytes) {
      throw new DomainError("PAYLOAD_TOO_LARGE", "The normalized asset exceeds the organization-policy byte limit.", 413, {
        details: { maximumBytes: assetPolicy.maximumBytes },
      });
    }
    if (input.width * input.height > assetPolicy.maximumPixels) {
      throw new DomainError("PAYLOAD_TOO_LARGE", "The normalized asset exceeds the organization-policy pixel limit.", 413, {
        details: { maximumPixels: assetPolicy.maximumPixels },
      });
    }
    const id = createId("asset");
    const now = new Date().toISOString();
    const sha256 = createHash("sha256").update(input.data).digest("hex");
    this.assetStore?.writeNormalized(
      input.data,
      input.mimeType as "image/png" | "image/jpeg" | "image/webp",
      sha256,
    );
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
    const transaction = this.database.sqlite.transaction(() => {
      this.database.sqlite.prepare(
        `INSERT INTO assets
         (id, actor_id, design_id, filename, mime_type, size_bytes, width, height, sha256, data, created_at, organization_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, actorId, input.designId ?? null, input.filename, input.mimeType, input.data.length, input.width, input.height, sha256, input.data, now, access.organizationId);
      this.enqueueEvent(actorId, "asset.created", { assetId: id, designId: asset.designId }, true, now);
      appendAuditEvent(this.database.sqlite, access, "asset.create", "asset", id, { designId: asset.designId, sha256 });
    });
    transaction.immediate();
    this.flushPendingEventsSafely();
    return asset;
  }

  getAsset(actorId: string, assetId: string): AssetRecord {
    this.authorizeAssetRead(actorId, assetId);
    const access = resolveAccess(this.database.sqlite, actorId);
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
      organization_id: string;
    } | undefined;
    if (!row) throw new DomainError("NOT_FOUND", "Asset not found.", 404);
    if (row.organization_id !== access.organizationId
      || (access.projectIds.length > 0 && (!row.design_id || !access.projectIds.includes(row.design_id)))) {
      throw new DomainError("NOT_FOUND", "Asset not found.", 404);
    }
    const stored = this.assetStore?.readNormalized(
      row.sha256,
      row.mime_type as "image/png" | "image/jpeg" | "image/webp",
      row.size_bytes,
    ) ?? null;
    const quarantinedBlob = Buffer.from(row.data);
    if (!stored && (quarantinedBlob.length !== row.size_bytes
      || createHash("sha256").update(quarantinedBlob).digest("hex") !== row.sha256)) {
      throw new DomainError("INTERNAL_ERROR", "The legacy asset BLOB failed its size or SHA-256 integrity check.", 500);
    }
    return {
      id: row.id,
      designId: row.design_id,
      filename: row.filename,
      mimeType: row.mime_type,
      sizeBytes: row.size_bytes,
      width: row.width,
      height: row.height,
      sha256: row.sha256,
      data: stored ?? quarantinedBlob,
      createdAt: row.created_at,
    };
  }

  authorizeAssetRead(actorId: string, assetId: string): void {
    const access = resolveAccess(this.database.sqlite, actorId);
    if (access.role === "agent") assertScope(access, "design:read");
    const projectClause = access.projectIds.length > 0
      ? ` AND design_id IN (${access.projectIds.map(() => "?").join(", ")})`
      : "";
    const row = this.database.sqlite.prepare(
      `SELECT id FROM assets
       WHERE id = ? AND organization_id = ?${projectClause}
         AND (
           design_id IS NULL
           OR NOT EXISTS (
             SELECT 1 FROM system_metadata archive
             WHERE archive.key = 'design_archive:' || assets.design_id
           )
         )`,
    ).get(assetId, access.organizationId, ...access.projectIds) as { id: string } | undefined;
    if (!row) throw new DomainError("NOT_FOUND", "Asset not found.", 404);
  }

  private commitPreviewInTransaction(actorId: string, designId: string, input: {
    previewId: string;
    expectedBaseVersion: number;
    kind: PreviewKind;
    message: string;
    taskId?: string;
  }): RevisionResult {
    const preview = this.loadPreview(actorId, designId, input.previewId, input.taskId, "commit");
    if (preview.status === "committed") {
      throw new DomainError("PREVIEW_ALREADY_COMMITTED", "The preview was already committed.", 409, {
        details: { committedRevisionId: preview.committed_revision_id },
      });
    }
    const now = new Date().toISOString();
    if (preview.status === "expired" || preview.expires_at <= now) {
      this.database.sqlite.prepare(
        "UPDATE previews SET status = 'expired' WHERE id = ? AND status IN ('ready', 'blocked')",
      ).run(preview.id);
      throw new DomainError("PREVIEW_EXPIRED", "The preview expired; create a new preview.", 410, { retryable: true });
    }
    if (preview.kind !== input.kind) {
      throw new DomainError("VALIDATION_FAILED", "The preview must be committed through its matching commit path.", 422, {
        details: {
          previewKind: preview.kind,
          requiredTool: preview.kind === "archive" ? "design_commit_archive_preview" : "design_commit_preview",
        },
      });
    }
    if (preview.status !== "ready" || !preview.committable) {
      throw new DomainError("PREVIEW_NOT_COMMITTABLE", "The preview has validation errors and cannot be committed.", 422, {
        details: { diagnostics: JSON.parse(preview.diagnostics_json) as unknown },
      });
    }
    const versionMismatch = preview.command_engine_version !== this.versions.commandEngine
      || preview.renderer_version !== this.versions.renderer
      || preview.font_bundle_version !== this.versions.fontBundle;
    if (versionMismatch) {
      throw new DomainError("PREVIEW_ENGINE_MISMATCH", "The preview was created by a different rendering or command-engine version.", 409, {
        retryable: true,
        details: {
          preview: {
            commandEngine: preview.command_engine_version,
            renderer: preview.renderer_version,
            fontBundle: preview.font_bundle_version,
          },
          current: {
            commandEngine: this.versions.commandEngine,
            renderer: this.versions.renderer,
            fontBundle: this.versions.fontBundle,
          },
          recovery: "Create a new preview with the current server version.",
        },
      });
    }
    if (preview.root_base_version !== input.expectedBaseVersion) {
      throw new DomainError("VALIDATION_FAILED", "expectedBaseVersion does not match the preview base.", 422);
    }
    if (!preview.base_revision_id || !preview.base_snapshot_hash || !preview.result_snapshot_hash) {
      throw new DomainError("INTERNAL_ERROR", "Preview snapshot metadata is missing.", 500);
    }

    const design = this.requireDesign(actorId, designId);
    if (design.current_version !== input.expectedBaseVersion) {
      throw this.versionConflict(input.expectedBaseVersion, design.current_version, design.current_revision_id);
    }
    const baseRevision = this.requireRevision(designId, input.expectedBaseVersion);
    if (baseRevision.id !== preview.base_revision_id || baseRevision.snapshot_hash !== preview.base_snapshot_hash) {
      throw new DomainError("VERSION_CONFLICT", "The preview base revision no longer matches the authoritative revision.", 409, {
        retryable: true,
        details: {
          expectedRevisionId: preview.base_revision_id,
          currentRevisionId: baseRevision.id,
          expectedSnapshotHash: preview.base_snapshot_hash,
          currentSnapshotHash: baseRevision.snapshot_hash,
        },
      });
    }
    const operations = parseOperations(JSON.parse(preview.operations_json));
    assertOperationPayloadLimit(operations, "preview");
    if (operationHash(operations) !== preview.operation_hash) {
      throw new DomainError("VALIDATION_FAILED", "The persisted preview operation hash is invalid.", 422);
    }
    if (hasArchiveOperations(operations) !== (preview.kind === "archive")) {
      throw new DomainError("VALIDATION_FAILED", "The persisted preview kind does not match its operations.", 422);
    }
    const document = parseDocument(JSON.parse(readSnapshotJson(this.database.sqlite, preview.result_snapshot_hash)));
    if (canonicalSnapshot(document).hash !== preview.result_snapshot_hash) {
      throw new DomainError("VALIDATION_FAILED", "The persisted preview snapshot hash is invalid.", 422);
    }
    const createdIds = {
      temporary: JSON.parse(preview.temporary_id_map_json) as unknown,
      created: JSON.parse(preview.created_ids_json) as unknown,
    };
    const result = this.commitDocumentInTransaction(actorId, designId, {
      baseVersion: input.expectedBaseVersion,
      document,
      operations,
      operationHash: preview.operation_hash,
      expectedSnapshotHash: preview.result_snapshot_hash,
      diagnostics: JSON.parse(preview.diagnostics_json) as Diagnostic[],
      createdIds,
      message: input.message,
    });
    const updated = this.database.sqlite.prepare(
      `UPDATE previews SET status = 'committed', committed_revision_id = ?, committed_at = ?
       WHERE id = ? AND status = 'ready'`,
    ).run(result.revision.id, now, preview.id);
    if (updated.changes !== 1) {
      throw new DomainError("PREVIEW_ALREADY_COMMITTED", "The preview was already committed.", 409);
    }
    return result;
  }

  private commitDocumentInTransaction(actorId: string, designId: string, input: {
    baseVersion: number;
    document: AnyDesignDocument;
    operations: DesignOperation[];
    operationHash?: string;
    expectedSnapshotHash?: string;
    diagnostics: Diagnostic[];
    createdIds: unknown;
    message: string;
    revisionActorId?: string;
  }): RevisionResult {
    const now = new Date().toISOString();
    const revisionId = createId("revision");
    const nextVersion = input.baseVersion + 1;
    const document = input.document;
    const revisionActorId = input.revisionActorId ?? actorId;
    if (document.revision !== nextVersion) {
      throw new DomainError("VALIDATION_FAILED", "The committed document revision does not match the next version.", 422);
    }
    const design = this.requireDesign(actorId, designId);
    if (design.current_version !== input.baseVersion) {
      throw this.versionConflict(input.baseVersion, design.current_version, design.current_revision_id);
    }
    const parent = this.requireRevision(designId, input.baseVersion);
    if (!parent.revision_hash) throw new DomainError("INTERNAL_ERROR", "Parent revision hash is missing.", 500);
    const snapshot = storeSnapshot(this.database.sqlite, document, now);
    if (input.expectedSnapshotHash && input.expectedSnapshotHash !== snapshot.hash) {
      throw new DomainError("VALIDATION_FAILED", "The commit snapshot does not match the stored preview snapshot.", 422, {
        details: { expectedSnapshotHash: input.expectedSnapshotHash, actualSnapshotHash: snapshot.hash },
      });
    }
    const operationsHash = input.operationHash ?? operationHash(input.operations);
    const integrityHash = revisionHash({
      parentRevisionHash: parent.revision_hash,
      snapshotHash: snapshot.hash,
      operationHash: operationsHash,
      metadata: {
        id: revisionId,
        designId,
        version: nextVersion,
        parentRevisionId: parent.id,
        actorId: revisionActorId,
        message: input.message,
        createdAt: now,
      },
    });
    this.database.sqlite.prepare(
      `INSERT INTO revisions
       (id, design_id, version, parent_revision_id, actor_id, message, document_json, operations_json,
        snapshot_hash, operation_hash, parent_revision_hash, revision_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      revisionId,
      designId,
      nextVersion,
      parent.id,
      revisionActorId,
      input.message,
      snapshot.canonicalJson,
      JSON.stringify(input.operations),
      snapshot.hash,
      operationsHash,
      parent.revision_hash,
      integrityHash,
      now,
    );
    const update = this.database.sqlite.prepare(
      `UPDATE designs SET name = ?, current_version = ?, current_revision_id = ?, updated_at = ?
       WHERE id = ? AND current_version = ? AND current_revision_id = ?`,
    ).run(document.name, nextVersion, revisionId, now, designId, input.baseVersion, parent.id);
    if (update.changes !== 1) {
      const current = this.requireDesign(actorId, designId);
      throw this.versionConflict(input.baseVersion, current.current_version, current.current_revision_id);
    }
    const committedDesign = this.requireDesign(actorId, designId);
    const result: RevisionResult = {
      design: designSummary(committedDesign),
      document: editorDocument(document),
      canonicalDocument: document,
      schemaVersion: document.schema_version,
      revision: {
        id: revisionId,
        version: nextVersion,
        parentRevisionId: parent.id,
        snapshotHash: snapshot.hash,
        operationHash: operationsHash,
        revisionHash: integrityHash,
        message: input.message,
        createdAt: now,
      },
      diagnostics: input.diagnostics,
      createdIds: input.createdIds,
    };
    this.enqueueEvent(actorId, "design.updated", {
      designId,
      version: nextVersion,
      revisionId,
      schemaVersion: document.schema_version,
    }, true, now);
    return result;
  }

  private requireVerifiedMigrationBackup(
    organizationId: string,
    backupId: string,
    source: { designUpdatedAt: string; projectPinUpdatedAt: string | null },
  ): void {
    const row = this.database.sqlite.prepare(
      `SELECT status, bundle_sha256, manifest_json, verification_json, created_at, verified_at, completed_at, size_bytes
       FROM backup_records WHERE id = ? AND organization_id = ?`,
    ).get(backupId, organizationId) as {
      status: string;
      bundle_sha256: string | null;
      manifest_json: string | null;
      verification_json: string | null;
      created_at: string;
      verified_at: string | null;
      completed_at: string | null;
      size_bytes: number | null;
    } | undefined;
    if (!row) throw new DomainError("NOT_FOUND", "Verified migration backup not found.", 404);
    let manifest: Record<string, unknown> | null = null;
    let verification: Record<string, unknown> | null = null;
    try {
      manifest = row.manifest_json ? JSON.parse(row.manifest_json) as Record<string, unknown> : null;
      verification = row.verification_json ? JSON.parse(row.verification_json) as Record<string, unknown> : null;
    } catch {
      // The bounded validation below reports one stable domain error.
    }
    const manifestCreatedAt = typeof manifest?.createdAt === "string" ? manifest.createdAt : null;
    const verifiedManifest = verification?.manifest && typeof verification.manifest === "object"
      ? verification.manifest
      : null;
    const designUpdatedAtMs = Date.parse(source.designUpdatedAt);
    const projectPinUpdatedAtMs = source.projectPinUpdatedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(source.projectPinUpdatedAt);
    const sourceWatermarkMs = Number.isFinite(designUpdatedAtMs) && Number.isFinite(projectPinUpdatedAtMs)
      ? Math.max(designUpdatedAtMs, projectPinUpdatedAtMs)
      : source.projectPinUpdatedAt === null && Number.isFinite(designUpdatedAtMs)
        ? designUpdatedAtMs
        : Number.NaN;
    const sourceWatermark = Number.isFinite(sourceWatermarkMs)
      ? new Date(sourceWatermarkMs).toISOString()
      : null;
    const coversCurrentHead = manifestCreatedAt !== null
      && Number.isFinite(Date.parse(manifestCreatedAt))
      && sourceWatermark !== null
      && Date.parse(manifestCreatedAt) >= sourceWatermarkMs;
    const valid = row.status === "valid"
      && typeof row.bundle_sha256 === "string"
      && /^[a-f0-9]{64}$/.test(row.bundle_sha256)
      && row.verified_at !== null
      && row.completed_at !== null
      && row.size_bytes !== null
      && Number.isSafeInteger(row.size_bytes)
      && row.size_bytes > 0
      && manifest?.format === "formaspec-backup"
      && (manifest.formatVersion === 1 || manifest.formatVersion === 2)
      && manifest.databaseSchemaVersion === this.database.schemaVersion()
      && row.created_at === manifestCreatedAt
      && verification?.valid === true
      && verifiedManifest !== null
      && hashPayload(verifiedManifest) === hashPayload(manifest)
      && verification.sqliteIntegrity === "ok"
      && verification.foreignKeyViolations === 0
      && coversCurrentHead;
    if (!valid) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "V1 to V2 migration requires a verified backup that conservatively covers the current project head and pin state.",
        409,
        {
          details: {
            backupId,
            backupStatus: row.status,
            backupCreatedAt: manifestCreatedAt,
            designUpdatedAt: source.designUpdatedAt,
            projectPinUpdatedAt: source.projectPinUpdatedAt,
            sourceWatermark,
            recovery: "Create and verify a new backup after the latest design or project-pin change, then retry the migration.",
          },
        },
      );
    }
  }

  private requireCompatiblePreviewRenderMetadata(preview: PreviewResult): PreviewRenderMetadata {
    if (preview.renderMetadata === null) {
      throw new DomainError(
        "PREVIEW_ENGINE_MISMATCH",
        "This preview has no persisted exact render output.",
        409,
        {
          retryable: true,
          details: {
            previewId: preview.id,
            recovery: "Create a new MCP preview before requesting its exact render.",
          },
        },
      );
    }
    if (preview.versions.renderer !== this.versions.renderer
      || preview.versions.fontBundle !== this.versions.fontBundle) {
      throw new DomainError(
        "PREVIEW_ENGINE_MISMATCH",
        "The preview render was produced by an incompatible renderer or font bundle version.",
        409,
        {
          retryable: true,
          details: {
            previewId: preview.id,
            previewRendererVersion: preview.versions.renderer,
            currentRendererVersion: this.versions.renderer,
            previewFontBundleVersion: preview.versions.fontBundle,
            currentFontBundleVersion: this.versions.fontBundle,
            recovery: "Create a new preview with the current renderer before review or commit.",
          },
        },
      );
    }
    return preview.renderMetadata;
  }

  private cleanupPreviewRenderArtifacts(now = Date.now()): void {
    if (!this.previewRenderStore) return;
    const referenced = new Set<string>();
    const rows = this.database.sqlite.prepare(
      "SELECT render_metadata_json FROM previews WHERE render_metadata_json IS NOT NULL",
    ).all() as Array<{ render_metadata_json: string }>;
    for (const row of rows) {
      try {
        referenced.add(parsePreviewRenderMetadata(row.render_metadata_json).sha256);
      } catch {
        // Invalid rows are surfaced by normal preview reads. Do not let one
        // legacy row disable startup cleanup for all valid preview artifacts.
      }
    }
    this.previewRenderStore.cleanupUnreferenced(referenced, now - 86_400_000);
  }

  private isDesignArchived(designId: string): boolean {
    return this.database.sqlite.prepare(
      "SELECT 1 FROM system_metadata WHERE key = ?",
    ).get(designArchiveMetadataKey(designId)) !== undefined;
  }

  private requireDesignArchive(design: DesignRow): {
    archivedAt: string;
    version: number;
    revisionId: string;
  } {
    const row = this.database.sqlite.prepare(
      "SELECT value, updated_at FROM system_metadata WHERE key = ?",
    ).get(designArchiveMetadataKey(design.id)) as { value: string; updated_at: string } | undefined;
    if (!row) {
      throw new DomainError("RESOURCE_STATE_CONFLICT", "The Design is active and cannot be restored.", 409, {
        details: { expectedStatus: "archived", currentStatus: "active" },
      });
    }
    let value: unknown;
    try {
      value = JSON.parse(row.value) as unknown;
    } catch (error) {
      throw new DomainError("INTERNAL_ERROR", "Persisted Design archive metadata is invalid.", 500, { cause: error });
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new DomainError("INTERNAL_ERROR", "Persisted Design archive metadata is invalid.", 500);
    }
    const archive = value as Record<string, unknown>;
    if (archive.schema_version !== 1
      || archive.design_id !== design.id
      || archive.organization_id !== design.organization_id
      || !Number.isSafeInteger(archive.version)
      || typeof archive.revision_id !== "string"
      || archive.revision_id !== design.current_revision_id
      || !canonicalTimestamp(archive.archived_at)
      || archive.archived_at !== row.updated_at) {
      throw new DomainError("INTERNAL_ERROR", "Persisted Design archive metadata is invalid.", 500);
    }
    return {
      archivedAt: archive.archived_at,
      version: archive.version as number,
      revisionId: archive.revision_id,
    };
  }

  private requireDesignIncludingArchived(
    access: ReturnType<typeof resolveAccess>,
    designId: string,
  ): DesignRow {
    const design = this.database.sqlite.prepare(
      "SELECT * FROM designs WHERE id = ?",
    ).get(designId) as DesignRow | undefined;
    if (!design) throw new DomainError("NOT_FOUND", "Design not found.", 404);
    assertProjectAccess(access, design.organization_id, design.id);
    return design;
  }

  private requireDesign(actorId: string, designId: string): DesignRow {
    const access = resolveAccess(this.database.sqlite, actorId);
    if (access.role === "agent") assertScope(access, "design:read");
    const design = this.requireDesignIncludingArchived(access, designId);
    if (this.isDesignArchived(design.id)) throw new DomainError("NOT_FOUND", "Design not found.", 404);
    return design;
  }

  private loadPreview(
    actorId: string,
    designId: string,
    previewId: string,
    taskId?: string,
    accessMode: "read" | "commit" = "read",
  ): PreviewRow {
    const design = this.requireDesign(actorId, designId);
    const preview = this.database.sqlite.prepare(
      "SELECT * FROM previews WHERE id = ? AND design_id = ? AND organization_id = ?",
    ).get(previewId, designId, design.organization_id) as PreviewRow | undefined;
    if (!preview) throw new DomainError("NOT_FOUND", "Preview not found.", 404);
    if (taskId !== undefined) {
      requirePreviewTaskBinding(this.database.sqlite, preview.id, taskId);
    }
    if (preview.actor_id !== actorId) {
      this.assertAgentTaskPreviewAccess(actorId, designId, preview, taskId, accessMode);
    }
    const access = resolveAccess(this.database.sqlite, actorId);
    if (accessMode === "commit" && access.role === "agent") {
      this.assertAgentDesignMutationNotReserved(access, preview.design_id, preview.id);
    }
    return preview;
  }

  private assertAgentDesignMutationNotReserved(
    access: ReturnType<typeof resolveAccess>,
    designId: string,
    previewId?: string,
  ): void {
    const explicitPreviewClause = previewId === undefined
      ? ""
      : ` OR EXISTS (
          SELECT 1 FROM agent_task_transitions artifact
          WHERE artifact.task_id = task.id
            AND json_valid(artifact.data_json)
            AND json_extract(artifact.data_json, '$.previewId') = ?
        )`;
    const task = this.database.sqlite.prepare(
      `SELECT task.id
       FROM agent_tasks task
       JOIN agent_task_transitions claimed
         ON claimed.rowid = (
           SELECT first_claim.rowid FROM agent_task_transitions first_claim
           WHERE first_claim.task_id = task.id AND first_claim.to_status = 'claimed'
           ORDER BY first_claim.rowid LIMIT 1
         )
       WHERE task.organization_id = ?
         AND task.design_id = ?
         AND task.expected_output = 'design_preview'
         AND claimed.actor_id = ?
         AND (task.expires_at > ?${explicitPreviewClause})
       LIMIT 1`,
    ).get(
      access.organizationId,
      designId,
      access.principalId,
      new Date().toISOString(),
      ...(previewId === undefined ? [] : [previewId]),
    ) as { id: string } | undefined;
    if (!task) return;
    throw new DomainError(
      "FORBIDDEN",
      "An agent cannot mutate a design reserved by a human-approved design task.",
      403,
      { details: { taskId: task.id, requiredAction: "human_approval" } },
    );
  }

  private assertAgentPreviewTask(
    access: ReturnType<typeof resolveAccess>,
    designId: string,
    taskId: string,
    expectedBaseVersion?: number,
  ): void {
    const task = this.database.sqlite.prepare(
      `SELECT task.base_version, task.expires_at, current.to_status,
              (
                SELECT claimed.actor_id FROM agent_task_transitions claimed
                WHERE claimed.task_id = task.id AND claimed.to_status = 'claimed'
                ORDER BY claimed.rowid LIMIT 1
              ) AS claimed_by
       FROM agent_tasks task
       JOIN agent_task_transitions current ON current.rowid = (
         SELECT latest.rowid FROM agent_task_transitions latest
         WHERE latest.task_id = task.id ORDER BY latest.rowid DESC LIMIT 1
       )
       WHERE task.id = ? AND task.organization_id = ? AND task.design_id = ?
         AND task.expected_output = 'design_preview'`,
    ).get(taskId, access.organizationId, designId) as {
      base_version: number;
      expires_at: string;
      to_status: string;
      claimed_by: string | null;
    } | undefined;
    if (!task || (expectedBaseVersion !== undefined && task.base_version !== expectedBaseVersion)) {
      throw new DomainError("NOT_FOUND", "Agent task not found.", 404);
    }
    if (task.claimed_by !== access.principalId) {
      throw new DomainError("FORBIDDEN", "Only the agent that claimed this task may create its design preview.", 403);
    }
    if (task.expires_at <= new Date().toISOString()) {
      throw new DomainError("TASK_EXPIRED", "The agent task expired before preview creation.", 410);
    }
    if (task.to_status !== "in_progress") {
      throw new DomainError("TASK_STATE_CONFLICT", "The agent task must be in progress before preview creation.", 409, {
        details: { expectedStatus: "in_progress", currentStatus: task.to_status },
      });
    }
  }

  private requirePreviewForRead(actorId: string, designId: string, previewId: string, taskId?: string): PreviewRow {
    const preview = this.loadPreview(actorId, designId, previewId, taskId, "read");
    if (preview.status !== "committed" && (preview.status === "expired" || preview.expires_at <= new Date().toISOString())) {
      this.database.sqlite.prepare(
        "UPDATE previews SET status = 'expired' WHERE id = ? AND status IN ('ready', 'blocked')",
      ).run(preview.id);
      throw new DomainError("PREVIEW_EXPIRED", "The preview expired; create a new preview.", 410, { retryable: true });
    }
    return preview;
  }

  private assertAgentTaskPreviewAccess(
    actorId: string,
    designId: string,
    preview: PreviewRow,
    taskId: string | undefined,
    accessMode: "read" | "commit",
  ): void {
    if (!taskId) throw new DomainError("NOT_FOUND", "Preview not found.", 404);
    const access = resolveAccess(this.database.sqlite, actorId);
    if (access.role === "agent") throw new DomainError("NOT_FOUND", "Preview not found.", 404);
    if (accessMode === "commit") assertDesignWrite(access);
    const task = this.database.sqlite.prepare(
      `SELECT id, organization_id, design_id, base_version, expected_output, expires_at
       FROM agent_tasks WHERE id = ?`,
    ).get(taskId) as AgentTaskPreviewAccessRow | undefined;
    if (!task
      || task.organization_id !== access.organizationId
      || task.design_id !== designId
      || task.base_version !== preview.root_base_version
      || task.expected_output !== "design_preview") {
      throw new DomainError("NOT_FOUND", "Preview not found.", 404);
    }
    const claimed = this.database.sqlite.prepare(
      `SELECT actor_id FROM agent_task_transitions
       WHERE task_id = ? AND to_status = 'claimed' ORDER BY rowid LIMIT 1`,
    ).get(task.id) as { actor_id: string } | undefined;
    const owner = preview.actor_id.startsWith("grant_")
      ? this.database.sqlite.prepare(
        "SELECT principal_id FROM agent_grants WHERE id = ?",
      ).get(preview.actor_id.slice("grant_".length)) as { principal_id: string } | undefined
      : this.database.sqlite.prepare(
        "SELECT id AS principal_id FROM principals WHERE external_id = ?",
      ).get(preview.actor_id) as { principal_id: string } | undefined;
    if (!claimed || owner?.principal_id !== claimed.actor_id) {
      throw new DomainError("NOT_FOUND", "Preview not found.", 404);
    }
    assertProjectAccess(access, task.organization_id, task.design_id);
    const transition = this.database.sqlite.prepare(
      `SELECT to_status, data_json FROM agent_task_transitions
       WHERE task_id = ? ORDER BY rowid DESC LIMIT 1`,
    ).get(task.id) as AgentTaskPreviewTransitionRow | undefined;
    let transitionData: Record<string, unknown> | null = null;
    try {
      const parsed = transition ? JSON.parse(transition.data_json) as unknown : null;
      transitionData = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      transitionData = null;
    }
    const statusAllowed = transition?.to_status === "awaiting_approval"
      || (accessMode === "read" && transition?.to_status === "completed");
    if (!statusAllowed || transitionData?.previewId !== preview.id) {
      throw new DomainError("NOT_FOUND", "Preview not found.", 404);
    }
    if (transition.to_status === "awaiting_approval" && task.expires_at <= new Date().toISOString()) {
      throw new DomainError("TASK_EXPIRED", "The agent task expired before the preview was reviewed.", 410, {
        retryable: true,
      });
    }
  }

  private requireRevision(designId: string, version: number): RevisionRow {
    const row = this.database.sqlite.prepare(
      "SELECT * FROM revisions WHERE design_id = ? AND version = ?",
    ).get(designId, version) as RevisionRow | undefined;
    if (!row) throw new DomainError("NOT_FOUND", `Version ${version} was not found.`, 404);
    return row;
  }

  private assertEventReadAccess(access: ReturnType<typeof resolveAccess>): void {
    if (!hasDesignerEventReadAccess(access)) {
      throw new DomainError("FORBIDDEN", "The principal cannot read any event family within its authorization boundary.", 403);
    }
  }

  private documentForRevision(revision: RevisionRow): AnyDesignDocument {
    const json = revision.snapshot_hash
      ? readSnapshotJson(this.database.sqlite, revision.snapshot_hash)
      : revision.document_json;
    return parseDocument(JSON.parse(json));
  }

  private versionConflict(expected: number, current: number, currentRevisionId: string): DomainError {
    const latestRevision = this.database.sqlite.prepare(
      `SELECT id, version, actor_id, created_at, message
       FROM revisions WHERE id = ?`,
    ).get(currentRevisionId) as {
      id: string;
      version: number;
      actor_id: string;
      created_at: string;
      message: string | null;
    } | undefined;
    return new DomainError("VERSION_CONFLICT", `Expected version ${expected}, but the current version is ${current}.`, 409, {
      retryable: true,
      details: {
        expectedVersion: expected,
        currentVersion: current,
        currentRevisionId,
        latestRevision: latestRevision ? {
          id: latestRevision.id,
          version: latestRevision.version,
          actorId: latestRevision.actor_id,
          createdAt: latestRevision.created_at,
          ...(latestRevision.message === null ? {} : { message: latestRevision.message.slice(0, 1_000) }),
        } : null,
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
    assertDesignWrite(resolveAccess(this.database.sqlite, actorId));
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
    const response = transaction.immediate();
    this.flushPendingEventsSafely();
    return response;
  }

  private enqueueEvent(
    actorId: string,
    type: DesignerEventType,
    data: Record<string, unknown>,
    workspace: boolean,
    now = new Date().toISOString(),
  ): number {
    const organizationId = resolveAccess(this.database.sqlite, actorId).organizationId;
    const inserted = this.database.sqlite.prepare(
      `INSERT INTO event_outbox (organization_id, actor_id, event_type, payload_json, workspace, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(organizationId, actorId, type, JSON.stringify(data), workspace ? 1 : 0, now);
    return Number(inserted.lastInsertRowid);
  }

  private flushPendingEvents(): void {
    while (true) {
      const rows = this.database.sqlite.prepare(
        `SELECT id, organization_id, actor_id, event_type, payload_json, workspace, created_at
         FROM event_outbox WHERE published_at IS NULL ORDER BY id LIMIT 100`,
      ).all() as Array<{
        id: number;
        organization_id: string;
        actor_id: string;
        event_type: DesignerEventType;
        payload_json: string;
        workspace: number;
        created_at: string;
      }>;
      if (rows.length === 0) return;
      for (const row of rows) {
        const data = JSON.parse(row.payload_json) as Record<string, unknown>;
        this.events.publishPersisted({
          id: row.id,
          type: row.event_type,
          actorId: row.actor_id,
          organizationId: row.organization_id,
          ...(typeof data.designId === "string" ? { designId: data.designId } : {}),
          timestamp: row.created_at,
          data,
        }, row.workspace === 1);
        this.database.sqlite.prepare(
          "UPDATE event_outbox SET published_at = ? WHERE id = ? AND published_at IS NULL",
        ).run(new Date().toISOString(), row.id);
      }
    }
  }

  private flushPendingEventsSafely(): void {
    try {
      this.flushPendingEvents();
    } catch {
      // A committed write remains successful even if a listener reconnect is required.
    }
  }
}
