import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  AnyDesignDocumentSchema,
  FORMASPEC_FOUNDATION_RELEASE_ID,
  FORMASPEC_FOUNDATION_SYSTEM_ID,
  FORMASPEC_FOUNDATION_VERSION,
  ProductSpecificationSchema,
  exportDesignTokens,
  type AnyDesignDocument,
  type DesignSystemToken,
  type IdFactory,
  type IdKind,
  type ProductSpecification,
  type TokenExportResult,
  type TokenExportTarget,
} from "@designer/core";
import { z } from "zod";

import {
  appendAuditEvent,
  assertDesignWrite,
  resolveAccess,
  type AccessContext,
} from "./authorization.js";
import {
  openPinnedBackupStream,
  verifyPinnedBackupBundle,
  type BackupManager,
  type BackupManifest,
  type BackupVerificationResult,
} from "./backup.js";
import type { BackupUploadFile } from "./backup-upload.js";
import { normalizeImageAsset, safeFilename, type RasterMimeType } from "./assets.js";
import {
  backupScheduleWindow,
  buildBackupRetentionPlan,
  calendarRetentionBounds,
  evaluateBackupScheduleSupervision,
  parseDailyBackupCron,
  type BackupScheduleAttempt,
  type BackupScheduleSupervision,
  type BackupRetentionPolicy,
  type BackupRetentionClass,
  type BackupRetentionPlan,
  type RetentionPlanRecord,
  type RetentionRecord,
} from "./backup-retention.js";
import type { EnterpriseService } from "./enterprise-service.js";
import {
  applyOperations,
  normalizeTemporaryReferences,
  parseOperations,
  type Diagnostic,
} from "./core-adapter.js";
import { asDomainError, DomainError } from "./errors.js";
import { flushPersistedEventOutbox } from "./events.js";
import { canonicalJson, hashPayload } from "./ids.js";
import {
  createPortableProjectBundle,
  readPortableProjectBundleFile,
  readPortableProjectBundle,
  readStreamedPortableEntry,
  type ImportedPortableProject,
  type PortableAsset,
  type StreamedImportedPortableProject,
} from "./portable-export.js";
import type { PortableUploadFile } from "./portable-upload.js";
import { operationHash, revisionHash, storeSnapshot } from "./persistence.js";
import { canonicalProductSpecification } from "./product-spec-persistence.js";
import { loadOrganizationPolicy } from "./organization-policy-model.js";
import type { PngRenderer } from "./render.js";
import type { DesignerService } from "./service.js";

interface BackupRecordRow {
  id: string;
  organization_id: string;
  filename: string;
  bundle_sha256: string | null;
  status: "creating" | "valid" | "invalid" | "restored";
  manifest_json: string | null;
  created_by: string;
  created_at: string;
  verified_at: string | null;
  size_bytes: number | null;
  verification_json: string | null;
  retention_class: "manual" | "daily" | "weekly" | "monthly";
  completed_at: string | null;
}

interface BackupScheduleRow {
  organization_id: string;
  enabled: 0 | 1;
  cron_expression: string;
  daily_retention: number;
  weekly_retention: number;
  monthly_retention: number;
  updated_at: string;
}

interface BackupPrunePreviewMetadata {
  format: "formaspec-backup-prune-preview";
  formatVersion: 1;
  planHash: string;
  backupIds: string[];
  generatedAt: string;
  expiresAt: string;
}

export interface PublicBackupRecord {
  id: string;
  filename: string;
  status: BackupRecordRow["status"];
  bundleSha256: string | null;
  createdAt: string;
  verifiedAt: string | null;
  sizeBytes: number | null;
  retentionClass: BackupRecordRow["retention_class"];
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

export interface BackupImportValidationResult {
  valid: true;
  validationOnly: true;
  mutationsApplied: false;
  bundleSha256: string;
  sizeBytes: number;
  destructiveRestoreRequired: true;
  manifest: NonNullable<PublicBackupRecord["manifest"]>;
  verification: {
    sqliteIntegrity: "ok";
    foreignKeyViolations: number;
    extractedBytes: number;
    entryCount: number;
  };
}

export interface BackupImportResult {
  registered: true;
  alreadyRegistered: boolean;
  destructiveRestoreRequired: true;
  backup: PublicBackupRecord;
}

export interface PortableExportResult {
  exportId: string;
  filename: string;
  data: Buffer;
  sha256: string;
  revisionId: string;
  revisionHash: string;
  version: number;
}

export interface PortableValidationResult {
  valid: true;
  validationOnly: true;
  mutationsApplied: false;
  manifest: ImportedPortableProject["manifest"];
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

export type PortableImportMode = "conflict_fail" | "clone";

export interface PortableImportDiagnostic {
  code: "SOURCE_REVISION_HASH_IS_CLAIMED" | "ASSETS_RENORMALIZED" | "LEGACY_ASSETS_QUARANTINED" | "PRODUCT_SPECIFICATION_ABSENT";
  severity: "info" | "warning";
  message: string;
  details?: Record<string, unknown>;
}

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
  designSystemPin: PortableDesignSystemPinResolution | null;
  diagnostics: PortableImportDiagnostic[];
  deepLink: string;
}

export interface ConflictRecoveryDuplicateResult {
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
    version: 1;
    revisionId: string;
    snapshotHash: string;
    operationHash: string;
    revisionHash: string;
    schemaVersion: 1 | 2;
    assetCount: number;
    productSpecificationVersion: 1 | null;
    implementationMappingCount: number;
  };
  idMapping: Record<string, string>;
  diagnostics: Diagnostic[];
  deepLink: string;
}

export interface BackupDownload {
  record: PublicBackupRecord;
  stream: fs.ReadStream;
  sizeBytes: number;
}

export interface PublicBackupSchedule {
  enabled: boolean;
  cronExpression: string;
  timezone: "UTC";
  retention: Readonly<BackupRetentionPolicy>;
  updatedAt: string | null;
  lastScheduledBackupAt: string | null;
  nextDueAt: string | null;
  supervision: BackupScheduleSupervision;
}

export interface BackupSupervisionHealth {
  status: "ok" | "warning" | "critical";
  checkedAt: string;
  trackedOrganizations: number;
  enabledSchedules: number;
  warningSchedules: number;
  criticalSchedules: number;
  retentionBacklogs: number;
}

export interface ScheduledBackupRunResult {
  status: "disabled" | "already_completed" | "created";
  dueAt: string | null;
  nextDueAt: string | null;
  retentionClass: Exclude<BackupRetentionClass, "manual"> | null;
  backup: PublicBackupRecord | null;
}

export interface PublicBackupPruneCandidate {
  id: string;
  filename: string;
  bundleSha256: string;
  sizeBytes: number;
  retentionClass: Exclude<BackupRetentionClass, "manual">;
  completedAt: string;
}

export interface BackupPrunePreview {
  previewId: string;
  planHash: string;
  generatedAt: string;
  expiresAt: string;
  retention: Readonly<BackupRetentionPolicy>;
  candidates: PublicBackupPruneCandidate[];
  retainedCount: number;
  manualExemptCount: number;
  protectedCount: number;
  totalCandidateBytes: number;
}

export interface BackupPruneResult {
  previewId: string;
  planHash: string;
  prunedBackupIds: string[];
  prunedBytes: number;
  cleanupPending: boolean;
}

const BACKUP_PRUNE_PREVIEW_TTL_MS = 15 * 60 * 1_000;
const BACKUP_PRUNE_PREVIEW_PREFIX = "backup-prune-preview:";
const MAX_BACKUP_PRUNE_CANDIDATES = 10_000;
const PORTABLE_IMPORT_IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const CONFLICT_RECOVERY_IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const CONFLICT_RECOVERY_MAX_OPERATION_COUNT = 500;
const CONFLICT_RECOVERY_MAX_OPERATION_BYTES = 1_048_576;
const PORTABLE_PROJECT_ID_PREFIXES = [
  "non_goal",
  "requirement",
  "validation",
  "integration",
  "permission",
  "assumption",
  "criterion",
  "component",
  "document",
  "audience",
  "question",
  "target",
  "asset",
  "entity",
  "event",
  "flow",
  "goal",
  "link",
  "node",
  "page",
  "role",
  "route",
  "rule",
  "spec",
  "state",
  "step",
  "token",
] as const;
const PORTABLE_ID_COLLECTION_KEYS = new Set([
  "nodes",
  "tokens",
  "assets",
  "prototype_links",
  "component_definitions",
  "implementation_mappings",
]);
const PORTABLE_ID_KEYED_MAPS = new Set([
  ...PORTABLE_ID_COLLECTION_KEYS,
  "legacy_component_overrides",
  "node_types",
  "text_directions",
  "component_descriptions",
  "frame_roles",
  "token_metadata",
  "asset_storage_keys",
]);
const PORTABLE_EXTERNAL_ID_FIELDS = new Set([
  "design_system_id",
  "release_id",
  "connection_id",
  "inventory_id",
  "source_revision_id",
  "verified_backup_id",
  "inserted_from_template_id",
]);

interface PreparedPortableAsset {
  id: string;
  filename: string;
  mimeType: "image/png";
  width: number;
  height: number;
  sha256: string;
  sizeBytes: number;
  data?: Buffer;
  stagedFilename?: string;
}

interface ConflictRecoveryAsset {
  targetId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  width: number;
  height: number;
  sha256: string;
  data: Buffer;
}

interface ConflictRecoveryMappingRow {
  id: string;
  inventory_id: string | null;
  entity_kind: string;
  entity_id: string;
  platform: string;
  symbol: string;
  mapping_json: string;
}

const conflictRecoveryMappingDetailsSchema = z.object({
  schemaVersion: z.literal(1),
  designPin: z.object({
    designId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{2,200}$/),
    revisionId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{2,200}$/),
    designVersion: z.number().int().positive().max(1_000_000_000),
    snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
    revisionHash: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  productSpecificationPin: z.object({
    source: z.enum(["document", "revision_link"]),
    version: z.number().int().positive().max(1_000_000_000),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  inventoryPin: z.object({
    inventoryId: z.string().regex(/^inventory_[a-f0-9]{32}$/),
    inventoryHash: z.string().regex(/^[a-f0-9]{64}$/),
    repositoryFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    platform: z.enum(["web", "android", "ios", "flutter", "react_native", "other"]),
  }).strict(),
  designEntity: z.object({
    kind: z.enum(["component", "token", "screen", "route", "asset", "flow", "business_rule"]),
    id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{2,159}$/),
  }).strict(),
  sourceEntity: z.object({
    id: z.string().regex(/^inv_[a-f0-9]{40}$/),
    kind: z.enum(["component", "screen", "route", "token", "asset", "flow", "business-rule"]),
    symbol: z.string().min(1).max(240).regex(/^[A-Za-z_][A-Za-z0-9_.:#<>,?()[\]-]{0,239}$/),
    locationId: z.string().regex(/^loc_[a-f0-9]{40}$/),
    line: z.number().int().positive().max(10_000_000).nullable(),
  }).strict(),
}).strict();

interface CanonicalImportedProductSpecification {
  specification: ProductSpecification;
  json: string;
  hash: string;
  sourceVersion: number;
}

export interface PortableDesignSystemPinResolution {
  designSystemId: string;
  releaseId: string;
  releaseVersion: number;
  source: "formaspec_foundation_default" | "project_design_system_pins";
}

function isFoundationDesignSystemPin(pin: {
  design_system_id: string;
  release_id: string;
  release_version: number;
}): boolean {
  return pin.design_system_id === FORMASPEC_FOUNDATION_SYSTEM_ID
    && pin.release_id === FORMASPEC_FOUNDATION_RELEASE_ID
    && pin.release_version === FORMASPEC_FOUNDATION_VERSION;
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

async function sha256File(filename: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function stagePreparedPortableAsset(directory: string, data: Buffer): Promise<string> {
  const filename = path.join(directory, `normalized-${randomUUID()}.png`);
  const handle = await fs.promises.open(
    filename,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return filename;
}

function preparedPortableAssetBytes(asset: PreparedPortableAsset): Buffer {
  if (asset.data) return asset.data;
  if (!asset.stagedFilename) throw new Error("Prepared portable asset has no bytes.");
  const descriptor = fs.openSync(asset.stagedFilename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size !== asset.sizeBytes) {
      throw new DomainError("VALIDATION_FAILED", "A staged normalized asset changed during import.", 422);
    }
    const data = fs.readFileSync(descriptor);
    if (sha256(data) !== asset.sha256) {
      throw new DomainError("VALIDATION_FAILED", "A staged normalized asset changed during import.", 422);
    }
    return data;
  } finally {
    fs.closeSync(descriptor);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function portableProjectIdPrefix(value: string): string | null {
  for (const prefix of PORTABLE_PROJECT_ID_PREFIXES) {
    if (new RegExp(`^${prefix}_[A-Za-z0-9][A-Za-z0-9_-]{7,}$`).test(value)) return prefix;
  }
  return null;
}

function collectPortableProjectIds(...values: unknown[]): string[] {
  const ids = new Set<string>();
  const pending = values.map((value) => ({ value, parentKey: null as string | null }));
  while (pending.length > 0) {
    const current = pending.pop()!;
    const { value, parentKey } = current;
    if (typeof value === "string") {
      const identifierField = parentKey === "id"
        || parentKey === "children"
        || parentKey === "source_id"
        || parentKey?.endsWith("_id")
        || parentKey?.endsWith("_ids");
      if (identifierField && portableProjectIdPrefix(value)) ids.add(value);
      continue;
    }
    if (Array.isArray(value)) {
      pending.push(...value.map((item) => ({ value: item, parentKey })));
      continue;
    }
    if (isRecord(value)) {
      if (parentKey && PORTABLE_ID_COLLECTION_KEYS.has(parentKey)) {
        for (const key of Object.keys(value)) if (portableProjectIdPrefix(key)) ids.add(key);
      }
      pending.push(...Object.entries(value).map(([key, item]) => ({ value: item, parentKey: key })));
    }
  }
  return [...ids].sort();
}

function deterministicPortableId(seed: string, sourceId: string): string {
  const prefix = portableProjectIdPrefix(sourceId);
  if (!prefix) throw new DomainError("VALIDATION_FAILED", `Unsupported project-scoped ID: ${sourceId}`, 422);
  return `${prefix}_${createHash("sha256").update(`${seed}\0${sourceId}`).digest("hex").slice(0, 32)}`;
}

function deterministicImportRevisionId(seed: string, sourceRevisionId: string): string {
  return `revision_${createHash("sha256").update(`${seed}\0revision\0${sourceRevisionId}`).digest("hex").slice(0, 32)}`;
}

function deterministicPortableImportId(seed: string, sourceRevisionId: string): string {
  return `import_${createHash("sha256").update(`${seed}\0import\0${sourceRevisionId}`).digest("hex").slice(0, 40)}`;
}

function buildPortableIdMapping(
  mode: PortableImportMode,
  seed: string,
  document: AnyDesignDocument,
  productSpecification: ProductSpecification | null,
  ...additionalValues: unknown[]
): Record<string, string> {
  const mapping = Object.fromEntries(collectPortableProjectIds(
    document,
    productSpecification,
    ...additionalValues,
  ).map((sourceId) => [
    sourceId,
    mode === "clone" ? deterministicPortableId(seed, sourceId) : sourceId,
  ]));
  if (!(document.id in mapping)) {
    throw new DomainError("VALIDATION_FAILED", "Portable project ID could not be included in the import mapping.", 422);
  }
  if (new Set(Object.values(mapping)).size !== Object.keys(mapping).length) {
    throw new DomainError("VALIDATION_FAILED", "Portable project ID remapping produced a collision.", 422);
  }
  return mapping;
}

function replacePortableProjectIds<T>(value: T, mapping: Record<string, string>): T {
  const rewrite = (current: unknown, parentKey: string | null, inMetadata: boolean): unknown => {
    if (typeof current === "string") {
      if (inMetadata || (parentKey && PORTABLE_EXTERNAL_ID_FIELDS.has(parentKey))) return current;
      if (parentKey === "storage_key" && current.startsWith("asset:")) {
        const sourceAssetId = current.slice("asset:".length);
        return mapping[sourceAssetId] ? `asset:${mapping[sourceAssetId]}` : current;
      }
      const identifierField = parentKey === "id"
        || parentKey === "children"
        || parentKey === "root_ids"
        || parentKey === "source_id"
        || parentKey === "slots"
        || parentKey?.endsWith("_id")
        || parentKey?.endsWith("_ids");
      return identifierField && mapping[current] ? mapping[current] : current;
    }
    if (Array.isArray(current)) return current.map((item) => rewrite(item, parentKey, inMetadata));
    if (!isRecord(current)) return current;
    const remapKeys = parentKey !== null && PORTABLE_ID_KEYED_MAPS.has(parentKey);
    return Object.fromEntries(Object.entries(current).map(([key, item]) => {
      const remappedKey = remapKeys && mapping[key] ? mapping[key] : key;
      const childMetadata = inMetadata || key === "metadata" || parentKey === "legacy_component_overrides";
      const childParentKey = parentKey === "slots" ? "slots" : key;
      return [remappedKey, rewrite(item, childParentKey, childMetadata)];
    }));
  };
  return rewrite(value, null, false) as T;
}

type AnyImportedPortableProject = ImportedPortableProject | StreamedImportedPortableProject;

async function portableAssetBytes(imported: AnyImportedPortableProject, assetId: string): Promise<Buffer> {
  const matches = Object.entries(imported.assets).filter(([entryName]) => {
    const base = entryName.slice("assets/".length);
    return base.slice(0, base.lastIndexOf(".")) === assetId;
  });
  if (matches.length !== 1) {
    throw new DomainError("VALIDATION_FAILED", `Portable normalized asset bytes are ambiguous or missing: ${assetId}`, 422);
  }
  const value = matches[0]![1];
  return Buffer.isBuffer(value) ? value : readStreamedPortableEntry(value);
}

function portableProductSpecification(imported: AnyImportedPortableProject): ProductSpecification | null {
  if (imported.document.schema_version === 2) {
    const sidecar = ProductSpecificationSchema.safeParse(imported.productSpecification);
    if (!sidecar.success || canonicalJson(sidecar.data) !== canonicalJson(imported.document.product_specification)) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "The V2 portable product-specification sidecar must exactly match the embedded specification.",
        422,
      );
    }
    return imported.document.product_specification;
  }
  const parsed = ProductSpecificationSchema.safeParse(imported.productSpecification);
  if (parsed.success) return parsed.data;
  const placeholder = isRecord(imported.productSpecification)
    && Object.keys(imported.productSpecification).every((key) => key === "natural_language_brief")
    && typeof imported.productSpecification.natural_language_brief === "string";
  if (placeholder) return null;
  throw new DomainError("VALIDATION_FAILED", "The V1 portable product specification is invalid.", 422, {
    details: { issues: parsed.error.issues.slice(0, 100) },
  });
}

function canonicalImportedProductSpecification(
  source: ProductSpecification | null,
  mapping: Record<string, string>,
): CanonicalImportedProductSpecification | null {
  if (!source) return null;
  const sourceVersion = source.version;
  const remapped = replacePortableProjectIds(source, mapping) as ProductSpecification;
  const canonical = canonicalProductSpecification({ ...remapped, version: 1 });
  return {
    specification: canonical.specification,
    json: canonical.json,
    hash: canonical.hash,
    sourceVersion,
  };
}

function assertConflictRecoveryOperationLimit(operations: unknown): asserts operations is unknown[] {
  let sizeBytes = Number.POSITIVE_INFINITY;
  try {
    sizeBytes = Buffer.byteLength(canonicalJson(operations), "utf8");
  } catch {
    // The strict operation parser below reports ordinary schema failures. A
    // non-serializable payload is conservatively treated as oversized here.
  }
  if (!Array.isArray(operations)
    || operations.length > CONFLICT_RECOVERY_MAX_OPERATION_COUNT
    || sizeBytes > CONFLICT_RECOVERY_MAX_OPERATION_BYTES) {
    throw new DomainError(
      "PAYLOAD_TOO_LARGE",
      "Conflict recovery accepts at most 500 operations or 1 MiB of operation JSON.",
      413,
    );
  }
}

function deterministicConflictRecoveryEntityId(seed: string, kind: IdKind, discriminator: string): string {
  return `${kind}_${createHash("sha256").update(`${seed}\0${kind}\0${discriminator}`).digest("hex").slice(0, 32)}`;
}

function deterministicConflictRecoveryIdFactory(seed: string): IdFactory {
  let sequence = 0;
  return ((kind: IdKind) => {
    sequence += 1;
    return deterministicConflictRecoveryEntityId(seed, kind, `generated:${sequence}`);
  }) as IdFactory;
}

function deterministicConflictRecoveryMappingId(seed: string, sourceMappingId: string): string {
  return `mapping_${createHash("sha256").update(`${seed}\0mapping\0${sourceMappingId}`).digest("hex").slice(0, 32)}`;
}

function sortedMapping(mapping: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(mapping).sort(([left], [right]) => left.localeCompare(right)));
}

function defaultConflictRecoveryName(sourceName: string): string {
  const suffix = " (Recovered draft)";
  if (sourceName.length + suffix.length <= 160) return `${sourceName}${suffix}`;
  return `${sourceName.slice(0, 160 - suffix.length).trimEnd()}${suffix}`;
}

function parseConflictRecoveryMappingDetails(
  row: ConflictRecoveryMappingRow,
): z.infer<typeof conflictRecoveryMappingDetailsSchema> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.mapping_json) as unknown;
  } catch {
    throw new DomainError("INTERNAL_ERROR", `Implementation mapping ${row.id} contains invalid JSON.`, 500);
  }
  const validated = conflictRecoveryMappingDetailsSchema.safeParse(parsed);
  if (!validated.success) {
    throw new DomainError(
      "INTERNAL_ERROR",
      `Implementation mapping ${row.id} has invalid persisted details.`,
      500,
      { details: { issues: validated.error.issues.slice(0, 100) } },
    );
  }
  return validated.data;
}

function conflictRecoveryDiagnosticMapping(
  diagnostics: Diagnostic[],
  mapping: Record<string, string>,
): Diagnostic[] {
  const rewrite = (value: unknown): unknown => {
    if (typeof value === "string") return mapping[value] ?? value;
    if (Array.isArray(value)) return value.map(rewrite);
    if (!isRecord(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item)]));
  };
  return rewrite(diagnostics) as Diagnostic[];
}

export class OperationsService {
  constructor(
    readonly service: DesignerService,
    readonly enterprise: EnterpriseService,
    readonly renderer: PngRenderer,
    readonly backups: BackupManager,
    readonly backupDirectory: string,
  ) {}

  authorizeConflictRecoveryDuplicate(actorId: string, sourceDesignId: unknown): void {
    this.requireConflictRecoveryDuplicateAccess(actorId, sourceDesignId);
  }

  private requirePortableDesignSystemPin(
    access: AccessContext,
    document: AnyDesignDocument,
  ): PortableDesignSystemPinResolution | null {
    if (document.schema_version !== 2) return null;
    const pin = document.design_system;
    if (isFoundationDesignSystemPin(pin)) {
      return {
        designSystemId: pin.design_system_id,
        releaseId: pin.release_id,
        releaseVersion: pin.release_version,
        source: "formaspec_foundation_default",
      };
    }
    const row = this.service.database.sqlite.prepare(
      `SELECT release.id, release.design_system_id, release.version, release.status,
              system.organization_id, system.status AS system_status
       FROM design_system_releases release
       JOIN design_systems system ON system.id = release.design_system_id
       WHERE release.id = ? AND system.organization_id = ?`,
    ).get(pin.release_id, access.organizationId) as {
      id: string;
      design_system_id: string;
      version: number;
      status: "draft" | "published" | "deprecated";
      organization_id: string;
      system_status: "active" | "archived";
    } | undefined;
    if (!row
      || row.design_system_id !== pin.design_system_id
      || row.version !== pin.release_version
      || row.status !== "published"
      || row.system_status !== "active") {
      throw new DomainError(
        "VALIDATION_FAILED",
        "A portable V2 project must reference the exact published release of an active design system in this organization.",
        422,
      );
    }
    return {
      designSystemId: row.design_system_id,
      releaseId: row.id,
      releaseVersion: row.version,
      source: "project_design_system_pins",
    };
  }

  private requireHistoricalConflictRecoveryDesignSystemPin(
    access: AccessContext,
    document: AnyDesignDocument,
  ): PortableDesignSystemPinResolution | null {
    if (document.schema_version !== 2) return null;
    const pin = document.design_system;
    if (isFoundationDesignSystemPin(pin)) {
      return {
        designSystemId: pin.design_system_id,
        releaseId: pin.release_id,
        releaseVersion: pin.release_version,
        source: "formaspec_foundation_default",
      };
    }
    const row = this.service.database.sqlite.prepare(
      `SELECT release.id, release.design_system_id, release.version, release.status,
              system.organization_id
       FROM design_system_releases release
       JOIN design_systems system ON system.id = release.design_system_id
       WHERE release.id = ? AND system.organization_id = ?`,
    ).get(pin.release_id, access.organizationId) as {
      id: string;
      design_system_id: string;
      version: number;
      status: "draft" | "published" | "deprecated";
      organization_id: string;
    } | undefined;
    if (!row
      || row.design_system_id !== pin.design_system_id
      || row.version !== pin.release_version
      || row.status === "draft") {
      throw new DomainError(
        "VALIDATION_FAILED",
        "A historical recovered V2 project must reference the exact published or deprecated design-system release in this organization.",
        422,
      );
    }
    return {
      designSystemId: row.design_system_id,
      releaseId: row.id,
      releaseVersion: row.version,
      source: "project_design_system_pins",
    };
  }

  async createPortableExport(
    actorId: string,
    designId: string,
    version?: number,
    includePreviews?: boolean,
  ): Promise<PortableExportResult> {
    const access = this.requireOrganizationAdmin(actorId);
    const exportPolicy = loadOrganizationPolicy(this.service.database.sqlite, access.organizationId).policy.exports;
    if (!exportPolicy.allowPortableBundles) {
      throw new DomainError("FORBIDDEN", "Portable project bundles are disabled by organization policy.", 403);
    }
    const shouldIncludePreviews = includePreviews ?? exportPolicy.includePreviewsByDefault;
    const revision = this.service.getDesign(actorId, designId, version);
    const document = revision.canonicalDocument;
    let productSpecification: unknown;
    if (document.schema_version === 1) {
      try {
        productSpecification = this.enterprise.readProductSpecification(actorId, designId).specification;
      } catch (error) {
        if (!(error instanceof DomainError) || error.code !== "NOT_FOUND") throw error;
      }
    }
    const assets: PortableAsset[] = [];
    for (const [assetId, documentAsset] of Object.entries(document.assets)) {
      const quarantined = document.schema_version === 2
        ? documentAsset.status === "legacy_quarantined"
        : documentAsset.kind !== "image"
          || !["image/png", "image/jpeg", "image/webp"].includes(documentAsset.mime_type)
          || documentAsset.storage_key !== `asset:${documentAsset.id}`
          || !documentAsset.sha256
          || !documentAsset.width
          || !documentAsset.height;
      if (quarantined) continue;
      const asset = this.service.getAsset(actorId, assetId);
      if (!(["image/png", "image/jpeg", "image/webp"] as const).includes(asset.mimeType as PortableAsset["mimeType"])) {
        throw new DomainError("VALIDATION_FAILED", `Asset ${asset.id} has an unsupported portable MIME type.`, 422);
      }
      assets.push({
        id: asset.id,
        mimeType: asset.mimeType as PortableAsset["mimeType"],
        sha256: asset.sha256,
        data: asset.data,
      });
    }
    const rendered = shouldIncludePreviews
      ? await this.renderer.render(document, { maxSize: 2_048 }, (assetId) => {
        try {
          const asset = this.service.getAsset(actorId, assetId);
          return `data:${asset.mimeType};base64,${asset.data.toString("base64")}`;
        } catch {
          return null;
        }
      })
      : null;
    const designSystemVersion = document.schema_version === 2
      ? document.design_system.release_version
      : 1;
    const data = createPortableProjectBundle({
      document,
      revisionId: revision.revision.id,
      revisionHash: revision.revision.revisionHash,
      designSystemVersion: Number.isInteger(designSystemVersion) && designSystemVersion > 0 ? designSystemVersion : 1,
      assets,
      previews: rendered ? [{ name: "project-preview", png: rendered.png }] : [],
      ...(productSpecification === undefined ? {} : { productSpecification }),
    });
    const bundleSha256 = sha256(data);
    const filename = `${designId}-v${revision.revision.version}.formaspec.zip`;
    const exportId = `export_${bundleSha256.slice(0, 40)}`;
    const manifest = readPortableProjectBundle(data).manifest;
    const createdAt = new Date().toISOString();
    const transaction = this.service.database.sqlite.transaction(() => {
      this.service.database.sqlite.prepare(
        `INSERT OR IGNORE INTO portable_exports
         (id, organization_id, design_id, revision_id, filename, bundle_sha256, size_bytes, manifest_json, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        exportId,
        access.organizationId,
        designId,
        revision.revision.id,
        filename,
        bundleSha256,
        data.length,
        JSON.stringify(manifest),
        access.principalId,
        createdAt,
      );
      appendAuditEvent(this.service.database.sqlite, access, "portable_export.create", "portable_export", exportId, {
        designId,
        version: revision.revision.version,
        revisionId: revision.revision.id,
        revisionHash: revision.revision.revisionHash,
        bundleSha256,
        assetCount: assets.length,
        includePreviews: shouldIncludePreviews,
      });
    });
    transaction.immediate();
    return {
      exportId,
      filename,
      data,
      sha256: bundleSha256,
      revisionId: revision.revision.id,
      revisionHash: revision.revision.revisionHash,
      version: revision.revision.version,
    };
  }

  assertPortableBundleExportAllowed(actorId: string, designId: string): void {
    const access = this.requireOrganizationAdmin(actorId);
    const exportPolicy = loadOrganizationPolicy(this.service.database.sqlite, access.organizationId).policy.exports;
    if (!exportPolicy.allowPortableBundles) {
      throw new DomainError("FORBIDDEN", "Portable project bundles are disabled by organization policy.", 403);
    }
    this.service.getDesign(actorId, designId);
  }

  assertTokenExportAllowed(actorId: string, designId: string): void {
    this.requireOrganizationAdmin(actorId);
    this.service.getDesign(actorId, designId);
  }

  exportTokens(actorId: string, designId: string, target: TokenExportTarget, version?: number, mode?: string): TokenExportResult {
    const access = this.requireOrganizationAdmin(actorId);
    const exportPolicy = loadOrganizationPolicy(this.service.database.sqlite, access.organizationId).policy.exports;
    const policyTarget = target === "android_xml" ? "android" : target;
    if (!exportPolicy.allowedTokenFormats.includes(policyTarget)) {
      throw new DomainError("FORBIDDEN", `The ${target} token export is disabled by organization policy.`, 403);
    }
    const revision = this.service.getDesign(actorId, designId, version);
    const tokens = Object.fromEntries(Object.values(revision.document.tokens).map((token) => {
      const metadata = token.metadata as Record<string, unknown>;
      const layer = metadata.layer;
      const converted: DesignSystemToken = {
        id: token.id,
        path: token.path,
        name: token.name,
        family: token.kind,
        layer: layer === "semantic" || layer === "component" ? layer : "primitive",
        value: token.value,
        ...(token.description === undefined ? {} : { description: token.description }),
        deprecated: token.archived,
      };
      return [converted.id, converted];
    }));
    const exported = exportDesignTokens(tokens, target, {
      ...(mode === undefined ? {} : { mode }),
      maximumTokens: 20_000,
      maximumOutputBytes: 5 * 1024 * 1024,
    });
    appendAuditEvent(this.service.database.sqlite, access, "token_export.create", "design", designId, {
      version: revision.revision.version,
      target,
      mode: mode ?? null,
      exportedTokenCount: exported.exportedTokenIds.length,
      diagnosticCount: exported.diagnostics.length,
    });
    return exported;
  }

  validatePortableImport(actorId: string, data: Buffer): PortableValidationResult {
    const access = this.requireOrganizationAdmin(actorId);
    const exportPolicy = loadOrganizationPolicy(this.service.database.sqlite, access.organizationId).policy.exports;
    if (!exportPolicy.allowPortableBundles) {
      throw new DomainError("FORBIDDEN", "Portable project bundles are disabled by organization policy.", 403);
    }
    const imported = readPortableProjectBundle(data);
    return this.portableValidationResult(access, imported);
  }

  assertPortableImportAllowed(actorId: string): void {
    const access = this.requireOrganizationAdmin(actorId);
    const exportPolicy = loadOrganizationPolicy(this.service.database.sqlite, access.organizationId).policy.exports;
    if (!exportPolicy.allowPortableBundles) {
      throw new DomainError("FORBIDDEN", "Portable project bundles are disabled by organization policy.", 403);
    }
  }

  async validatePortableImportFile(actorId: string, upload: PortableUploadFile): Promise<PortableValidationResult> {
    const access = this.requireOrganizationAdmin(actorId);
    const exportPolicy = loadOrganizationPolicy(this.service.database.sqlite, access.organizationId).policy.exports;
    if (!exportPolicy.allowPortableBundles) {
      throw new DomainError("FORBIDDEN", "Portable project bundles are disabled by organization policy.", 403);
    }
    const imported = await readPortableProjectBundleFile(upload.filename, upload.directory);
    return this.portableValidationResult(access, imported);
  }

  private portableValidationResult(
    access: AccessContext,
    imported: AnyImportedPortableProject,
  ): PortableValidationResult {
    const document = imported.document;
    const result: PortableValidationResult = {
      valid: true,
      validationOnly: true,
      mutationsApplied: false,
      manifest: imported.manifest,
      project: {
        id: typeof document.id === "string" ? document.id : null,
        name: typeof document.name === "string" ? document.name : null,
        schemaVersion: Number(document.schema_version),
        pageCount: Array.isArray(document.pages) ? document.pages.length : 0,
        nodeCount: isRecord(document.nodes) ? Object.keys(document.nodes).length : 0,
        tokenCount: isRecord(document.tokens) ? Object.keys(document.tokens).length : 0,
        assetCount: Object.keys(imported.assets).length,
        previewCount: Object.keys(imported.previews).length,
      },
    };
    appendAuditEvent(this.service.database.sqlite, access, "portable_import.validate", "portable_bundle", null, {
      revisionId: imported.manifest.revisionId,
      revisionHash: imported.manifest.revisionHash,
      documentSchemaVersion: imported.manifest.documentSchemaVersion,
      assetCount: result.project.assetCount,
      previewCount: result.project.previewCount,
    });
    return result;
  }

  duplicateConflictingDraft(
    actorId: string,
    sourceDesignId: string,
    input: {
      baseVersion: number;
      operations: unknown;
      idempotencyKey: string;
      name?: string;
    },
  ): ConflictRecoveryDuplicateResult {
    const access = this.requireConflictRecoveryDuplicateAccess(actorId, sourceDesignId);
    if (!Number.isSafeInteger(input.baseVersion) || input.baseVersion < 1) {
      throw new DomainError("VALIDATION_FAILED", "Conflict recovery requires a positive base version.", 422);
    }
    assertConflictRecoveryOperationLimit(input.operations);
    if (typeof input.idempotencyKey !== "string") {
      throw new DomainError(
        "VALIDATION_FAILED",
        "Conflict-recovery idempotency keys must contain 8 to 240 characters.",
        422,
      );
    }
    const idempotencyKey = input.idempotencyKey.trim();
    if (idempotencyKey.length < 8 || idempotencyKey.length > 240) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "Conflict-recovery idempotency keys must contain 8 to 240 characters.",
        422,
      );
    }
    const requestedName = typeof input.name === "string" ? input.name.trim() : undefined;
    if (input.name !== undefined && (typeof input.name !== "string" || !requestedName || requestedName.length > 160)) {
      throw new DomainError("VALIDATION_FAILED", "Conflict-recovery project names must contain 1 to 160 characters.", 422);
    }

    const request = {
      baseVersion: input.baseVersion,
      operations: input.operations,
      idempotencyKey,
      name: requestedName ?? null,
      semanticsVersion: 1,
    };
    const requestHash = hashPayload(request);
    const idempotencyScope = `design:${sourceDesignId}:conflict-recovery-duplicate`;
    const readIdempotentResponse = (): ConflictRecoveryDuplicateResult | null => {
      const row = this.service.database.sqlite.prepare(
        `SELECT request_hash, response_json FROM idempotency
         WHERE actor_id = ? AND scope = ? AND key = ? AND expires_at > ?`,
      ).get(access.principalId, idempotencyScope, idempotencyKey, new Date().toISOString()) as {
        request_hash: string;
        response_json: string;
      } | undefined;
      if (!row) return null;
      if (row.request_hash !== requestHash) {
        throw new DomainError(
          "IDEMPOTENCY_CONFLICT",
          "The idempotency key was already used with a different conflict-recovery request.",
          409,
        );
      }
      return JSON.parse(row.response_json) as ConflictRecoveryDuplicateResult;
    };

    const transaction = this.service.database.sqlite.transaction(() => {
      this.service.database.cleanupIdempotency();
      const replay = readIdempotentResponse();
      if (replay) return replay;

      // getDesign intentionally permits an immutable historical version. The
      // current head is returned separately in the summary and is never used
      // as the operation base or mutated by this recovery transaction.
      const base = this.service.getDesign(actorId, sourceDesignId, input.baseVersion);
      const sourceDocument = base.canonicalDocument;
      const sourceHead = base.design;
      const now = new Date().toISOString();
      const deterministicSeed = hashPayload({
        format: "formaspec-conflict-recovery-duplicate-v1",
        organizationId: access.organizationId,
        principalId: access.principalId,
        sourceDesignId,
        baseVersion: input.baseVersion,
        baseRevisionId: base.revision.id,
        requestHash,
        idempotencyKey,
      });
      const normalized = normalizeTemporaryReferences(
        input.operations,
        (temporaryId, kind) => deterministicConflictRecoveryEntityId(
          deterministicSeed,
          kind,
          `temporary:${temporaryId}`,
        ),
      );
      const operations = parseOperations(normalized.operations);
      const applied = applyOperations(sourceDocument, operations, {
        expectedRevision: sourceDocument.revision,
        now,
        idFactory: deterministicConflictRecoveryIdFactory(deterministicSeed),
      });

      const sourceMappingRows = this.service.database.sqlite.prepare(
        `SELECT id, inventory_id, entity_kind, entity_id, platform, symbol, mapping_json
         FROM implementation_mappings
         WHERE organization_id = ? AND design_id = ? AND revision_id = ?
         ORDER BY id`,
      ).all(access.organizationId, sourceDesignId, base.revision.id) as ConflictRecoveryMappingRow[];
      const parsedSourceMappingDetails = sourceMappingRows.map(parseConflictRecoveryMappingDetails);
      let sourceProductSpecification: ProductSpecification | null = null;
      let linkedSourceSpecificationRevisionId: string | null = null;
      if (sourceDocument.schema_version === 2) {
        sourceProductSpecification = sourceDocument.product_specification;
      } else {
        const pinnedSpecificationVersions = new Set(parsedSourceMappingDetails.map(
          (details) => details.productSpecificationPin.version,
        ));
        if (pinnedSpecificationVersions.size > 1) {
          throw new DomainError(
            "VALIDATION_FAILED",
            "The exact source revision has implementation mappings pinned to different product specifications.",
            422,
            { details: { reasonCode: "SOURCE_MAPPING_SPECIFICATION_CONFLICT" } },
          );
        }
        const pinnedVersion = [...pinnedSpecificationVersions][0];
        const asOfSpecification = pinnedVersion === undefined
          ? this.service.database.sqlite.prepare(
            `SELECT specification.version
             FROM product_specifications specification
             LEFT JOIN revisions linked_revision
               ON linked_revision.id = specification.revision_id
              AND linked_revision.design_id = specification.design_id
             WHERE specification.design_id = ? AND specification.organization_id = ?
               AND (
                 (specification.revision_id IS NOT NULL AND linked_revision.version <= ?)
                 OR (specification.revision_id IS NULL AND specification.created_at <= ?)
               )
             ORDER BY specification.version DESC
             LIMIT 1`,
          ).get(
            sourceDesignId,
            access.organizationId,
            input.baseVersion,
            base.revision.createdAt,
          ) as { version: number } | undefined
          : undefined;
        const specificationVersion = pinnedVersion ?? asOfSpecification?.version;
        if (specificationVersion !== undefined) {
          try {
            const specificationResult = this.enterprise.readProductSpecification(
              actorId,
              sourceDesignId,
              specificationVersion,
            );
            sourceProductSpecification = specificationResult.specification;
            linkedSourceSpecificationRevisionId = specificationResult.revisionId;
          } catch (error) {
            if (!(error instanceof DomainError) || error.code !== "NOT_FOUND") throw error;
            if (sourceMappingRows.length === 0) {
              throw new DomainError(
                "INTERNAL_ERROR",
                "The historical product specification selected for conflict recovery is unavailable.",
                500,
              );
            }
            throw new DomainError(
              "VALIDATION_FAILED",
              "The exact source revision's implementation mappings reference a missing product specification.",
              422,
              { details: { reasonCode: "SOURCE_MAPPING_SPECIFICATION_MISSING" } },
            );
          }
        }
      }
      const sourceSpecificationIntegrity = sourceProductSpecification
        ? canonicalProductSpecification(sourceProductSpecification)
        : null;
      const sourceMappingDetails = sourceMappingRows.map((row, index) => {
        const details = parsedSourceMappingDetails[index]!;
        const inventory = row.inventory_id ? this.service.database.sqlite.prepare(
          `SELECT organization_id, repository_fingerprint, inventory_hash
           FROM repository_inventories WHERE id = ?`,
        ).get(row.inventory_id) as {
          organization_id: string;
          repository_fingerprint: string;
          inventory_hash: string;
        } | undefined : undefined;
        const expectedSpecificationSource = sourceDocument.schema_version === 2 ? "document" : "revision_link";
        const valid = row.inventory_id !== null
          && inventory?.organization_id === access.organizationId
          && inventory.repository_fingerprint === details.inventoryPin.repositoryFingerprint
          && inventory.inventory_hash === details.inventoryPin.inventoryHash
          && row.inventory_id === details.inventoryPin.inventoryId
          && row.platform === details.inventoryPin.platform
          && row.entity_kind === details.designEntity.kind
          && row.entity_id === details.designEntity.id
          && row.symbol === details.sourceEntity.symbol
          && details.designPin.designId === sourceDesignId
          && details.designPin.revisionId === base.revision.id
          && details.designPin.designVersion === input.baseVersion
          && details.designPin.snapshotHash === base.revision.snapshotHash
          && details.designPin.revisionHash === base.revision.revisionHash
          && sourceSpecificationIntegrity !== null
          && (sourceDocument.schema_version === 2 || linkedSourceSpecificationRevisionId === base.revision.id)
          && details.productSpecificationPin.source === expectedSpecificationSource
          && details.productSpecificationPin.version === sourceProductSpecification?.version
          && details.productSpecificationPin.hash === sourceSpecificationIntegrity.hash;
        if (!valid) {
          throw new DomainError(
            "VALIDATION_FAILED",
            `Implementation mapping ${row.id} does not match the exact source revision, specification, or inventory.`,
            422,
            { details: { reasonCode: "SOURCE_MAPPING_INTEGRITY_FAILED", mappingId: row.id } },
          );
        }
        return { entity_id: row.entity_id, details };
      });
      const permanentIdMapping = buildPortableIdMapping(
        "clone",
        deterministicSeed,
        applied.document,
        sourceProductSpecification,
        sourceMappingDetails,
      );
      const targetProjectId = permanentIdMapping[sourceDocument.id];
      if (!targetProjectId) {
        throw new DomainError("VALIDATION_FAILED", "Conflict recovery did not produce a project ID.", 422);
      }
      const idMapping: Record<string, string> = { ...permanentIdMapping };
      for (const [temporaryId, normalizedId] of Object.entries(normalized.idMap)) {
        const targetId = permanentIdMapping[normalizedId];
        if (!targetId) {
          throw new DomainError(
            "VALIDATION_FAILED",
            `Conflict recovery could not remap temporary entity ${temporaryId}.`,
            422,
          );
        }
        idMapping[temporaryId] = targetId;
      }
      const targetMappingIds = sourceMappingRows.map((row) => deterministicConflictRecoveryMappingId(
        deterministicSeed,
        row.id,
      ));
      for (const [index, sourceMapping] of sourceMappingRows.entries()) {
        idMapping[sourceMapping.id] = targetMappingIds[index]!;
      }
      const sourceOperationsHash = operationHash(operations);
      const targetOperations = parseOperations(replacePortableProjectIds(
        operations,
        permanentIdMapping,
      ));
      assertConflictRecoveryOperationLimit(targetOperations);

      const preparedSpecification = canonicalImportedProductSpecification(
        sourceProductSpecification,
        permanentIdMapping,
      );
      if (sourceMappingRows.length > 0 && !preparedSpecification) {
        throw new DomainError(
          "VALIDATION_FAILED",
          "Revision-pinned implementation mappings require a product specification in the recovered project.",
          422,
        );
      }

      const remapped = replacePortableProjectIds(
        applied.document,
        permanentIdMapping,
      ) as unknown as Record<string, unknown>;
      remapped.name = requestedName ?? defaultConflictRecoveryName(sourceDocument.name);
      remapped.revision = 1;
      remapped.created_at = now;
      remapped.updated_at = now;
      remapped.metadata = {
        ...(isRecord(remapped.metadata) ? remapped.metadata : {}),
        formaspec_conflict_recovery: {
          format_version: 1,
          source_project_id: sourceDesignId,
          source_base_version: input.baseVersion,
          source_base_revision_id: base.revision.id,
          source_base_snapshot_hash: base.revision.snapshotHash,
          source_base_revision_hash: base.revision.revisionHash,
          source_head_version_at_duplicate: sourceHead.version,
          source_head_revision_id_at_duplicate: sourceHead.revisionId,
          source_operation_hash: sourceOperationsHash,
          duplicated_at: now,
        },
      };
      if (remapped.schema_version === 2) {
        if (!preparedSpecification) {
          throw new DomainError("VALIDATION_FAILED", "A recovered V2 project requires its embedded product specification.", 422);
        }
        remapped.product_specification = preparedSpecification.specification;
      }
      const parsedDocument = AnyDesignDocumentSchema.safeParse(remapped);
      if (!parsedDocument.success) {
        throw new DomainError(
          "VALIDATION_FAILED",
          "The recovered project does not satisfy its strict document schema.",
          422,
          { details: { issues: parsedDocument.error.issues.slice(0, 100) } },
        );
      }
      const document = parsedDocument.data;
      const designSystemPin = this.requireHistoricalConflictRecoveryDesignSystemPin(access, document);

      const preparedAssets: ConflictRecoveryAsset[] = [];
      for (const [sourceAssetId, documentAsset] of Object.entries(applied.document.assets)) {
        const ready = applied.document.schema_version === 2
          ? documentAsset.status === "ready"
          : documentAsset.kind === "image"
            && ["image/png", "image/jpeg", "image/webp"].includes(documentAsset.mime_type)
            && documentAsset.storage_key === `asset:${documentAsset.id}`
            && Boolean(documentAsset.sha256 && documentAsset.width && documentAsset.height);
        if (!ready) continue;
        const targetAssetId = permanentIdMapping[sourceAssetId];
        if (!targetAssetId) {
          throw new DomainError("VALIDATION_FAILED", `Conflict recovery did not remap asset ${sourceAssetId}.`, 422);
        }
        const asset = this.service.getAsset(actorId, sourceAssetId);
        if (asset.designId !== sourceDesignId
          || asset.mimeType !== documentAsset.mime_type
          || asset.sizeBytes !== documentAsset.size_bytes
          || asset.sha256 !== documentAsset.sha256
          || asset.width !== documentAsset.width
          || asset.height !== documentAsset.height
          || asset.data.length !== asset.sizeBytes
          || sha256(asset.data) !== asset.sha256) {
          throw new DomainError(
            "VALIDATION_FAILED",
            `Asset ${sourceAssetId} does not match the immutable recovered document metadata.`,
            422,
          );
        }
        preparedAssets.push({
          targetId: targetAssetId,
          filename: asset.filename,
          mimeType: asset.mimeType,
          sizeBytes: asset.sizeBytes,
          width: asset.width,
          height: asset.height,
          sha256: asset.sha256,
          data: asset.data,
        });
      }

      const revisionId = deterministicImportRevisionId(deterministicSeed, base.revision.id);
      const operationsHash = operationHash(targetOperations);
      const snapshot = storeSnapshot(this.service.database.sqlite, document, now);
      const integrityHash = revisionHash({
        parentRevisionHash: null,
        snapshotHash: snapshot.hash,
        operationHash: operationsHash,
        metadata: {
          id: revisionId,
          designId: targetProjectId,
          version: 1,
          parentRevisionId: null,
          actorId: access.principalId,
          message: "Duplicate conflicting local draft",
          createdAt: now,
        },
      });

      const existingProject = this.service.database.sqlite.prepare(
        "SELECT id FROM designs WHERE id = ?",
      ).get(targetProjectId);
      const conflictingAssets = preparedAssets.filter((asset) => this.service.database.sqlite.prepare(
        "SELECT id FROM assets WHERE id = ?",
      ).get(asset.targetId));
      const conflictingMappings = targetMappingIds.filter((mappingId) => this.service.database.sqlite.prepare(
        "SELECT id FROM implementation_mappings WHERE id = ?",
      ).get(mappingId));
      if (existingProject || conflictingAssets.length > 0 || conflictingMappings.length > 0) {
        throw new DomainError(
          "VERSION_CONFLICT",
          "The deterministic conflict-recovery target already exists without matching idempotency evidence.",
          409,
          {
            details: {
              targetProjectId,
              projectConflict: Boolean(existingProject),
              conflictingAssetIds: conflictingAssets.slice(0, 100).map((asset) => asset.targetId),
              conflictingMappingIds: conflictingMappings.slice(0, 100),
              recovery: "Retry with a new idempotency key to create a distinct deterministic recovery project.",
            },
          },
        );
      }

      this.service.database.sqlite.prepare(
        `INSERT INTO designs
         (id, actor_id, name, current_version, current_revision_id, created_at, updated_at, organization_id)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
      ).run(
        targetProjectId,
        access.principalId,
        document.name,
        revisionId,
        now,
        now,
        access.organizationId,
      );
      if (designSystemPin?.source === "project_design_system_pins") {
        this.service.database.sqlite.prepare(
          `INSERT INTO project_design_system_pins
           (design_id, organization_id, design_system_id, release_id, release_version, pinned_by, pinned_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          targetProjectId,
          access.organizationId,
          designSystemPin.designSystemId,
          designSystemPin.releaseId,
          designSystemPin.releaseVersion,
          access.principalId,
          now,
        );
      }
      this.service.database.sqlite.prepare(
        `INSERT INTO revisions
         (id, design_id, version, parent_revision_id, actor_id, message, document_json, operations_json,
          snapshot_hash, operation_hash, parent_revision_hash, revision_hash, created_at)
         VALUES (?, ?, 1, NULL, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      ).run(
        revisionId,
        targetProjectId,
        access.principalId,
        "Duplicate conflicting local draft",
        snapshot.canonicalJson,
        canonicalJson(targetOperations),
        snapshot.hash,
        operationsHash,
        integrityHash,
        now,
      );
      const insertAsset = this.service.database.sqlite.prepare(
        `INSERT INTO assets
         (id, actor_id, design_id, filename, mime_type, size_bytes, width, height, sha256, data, created_at, organization_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const asset of preparedAssets) {
        insertAsset.run(
          asset.targetId,
          access.principalId,
          targetProjectId,
          asset.filename,
          asset.mimeType,
          asset.sizeBytes,
          asset.width,
          asset.height,
          asset.sha256,
          asset.data,
          now,
          access.organizationId,
        );
      }
      if (preparedSpecification) {
        this.service.database.sqlite.prepare(
          `INSERT INTO product_specifications
           (design_id, version, specification_json, organization_id, specification_hash, message,
            revision_id, actor_id, created_at)
           VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          targetProjectId,
          preparedSpecification.json,
          access.organizationId,
          preparedSpecification.hash,
          "Duplicate conflict-recovery product specification",
          revisionId,
          access.principalId,
          now,
        );
      }

      for (const [index, sourceMapping] of sourceMappingRows.entries()) {
        const sourceDetails = parseConflictRecoveryMappingDetails(sourceMapping);
        const details = replacePortableProjectIds(
          sourceDetails,
          permanentIdMapping,
        ) as Record<string, unknown>;
        const entityId = permanentIdMapping[sourceMapping.entity_id];
        if (!entityId) {
          throw new DomainError(
            "VALIDATION_FAILED",
            `Implementation mapping ${sourceMapping.id} references an unsupported project entity ID.`,
            422,
          );
        }
        if (!isRecord(details.designPin)
          || !isRecord(details.productSpecificationPin)
          || !isRecord(details.designEntity)) {
          throw new DomainError(
            "INTERNAL_ERROR",
            `Implementation mapping ${sourceMapping.id} has invalid persisted pin metadata.`,
            500,
          );
        }
        details.designPin = {
          ...details.designPin,
          designId: targetProjectId,
          revisionId,
          designVersion: 1,
          snapshotHash: snapshot.hash,
          revisionHash: integrityHash,
        };
        details.productSpecificationPin = {
          ...details.productSpecificationPin,
          source: document.schema_version === 2 ? "document" : "revision_link",
          version: 1,
          hash: preparedSpecification!.hash,
        };
        details.designEntity = {
          ...details.designEntity,
          kind: sourceMapping.entity_kind,
          id: entityId,
        };
        this.service.database.sqlite.prepare(
          `INSERT INTO implementation_mappings
           (id, organization_id, design_id, revision_id, inventory_id, entity_kind,
            entity_id, platform, symbol, mapping_json, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          targetMappingIds[index],
          access.organizationId,
          targetProjectId,
          revisionId,
          sourceMapping.inventory_id,
          sourceMapping.entity_kind,
          entityId,
          sourceMapping.platform,
          sourceMapping.symbol,
          canonicalJson(details),
          access.principalId,
          now,
        );
      }

      const diagnostics = conflictRecoveryDiagnosticMapping(applied.diagnostics, permanentIdMapping);
      diagnostics.unshift({
        severity: "info",
        code: "CONFLICT_RECOVERY_DUPLICATED",
        message: sourceHead.version === input.baseVersion
          ? "The local draft was duplicated into a new project without changing its source project."
          : `The local draft based on stale version ${input.baseVersion} was duplicated while source version ${sourceHead.version} remained unchanged.`,
      });
      const auditEventId = appendAuditEvent(
        this.service.database.sqlite,
        access,
        "design.conflict_recovery_duplicate",
        "design",
        targetProjectId,
        {
          designId: targetProjectId,
          sourceDesignId,
          sourceBaseVersion: input.baseVersion,
          sourceBaseRevisionId: base.revision.id,
          sourceBaseSnapshotHash: base.revision.snapshotHash,
          sourceBaseRevisionHash: base.revision.revisionHash,
          sourceHeadVersion: sourceHead.version,
          sourceHeadRevisionId: sourceHead.revisionId,
          revisionId,
          snapshotHash: snapshot.hash,
          sourceOperationHash: sourceOperationsHash,
          operationHash: operationsHash,
          revisionHash: integrityHash,
          assetCount: preparedAssets.length,
          implementationMappingCount: sourceMappingRows.length,
        },
      );
      this.service.database.sqlite.prepare(
        `INSERT INTO event_outbox
         (organization_id, actor_id, event_type, payload_json, workspace, created_at)
         VALUES (?, ?, 'design.created', ?, 1, ?)`,
      ).run(access.organizationId, actorId, JSON.stringify({
        auditEventId,
        designId: targetProjectId,
        version: 1,
        revisionId,
        schemaVersion: document.schema_version,
        conflictRecovery: true,
        sourceDesignId,
        sourceBaseVersion: input.baseVersion,
      }), now);

      const response: ConflictRecoveryDuplicateResult = {
        duplicated: true,
        source: {
          projectId: sourceDesignId,
          baseVersion: input.baseVersion,
          baseRevisionId: base.revision.id,
          baseSnapshotHash: base.revision.snapshotHash,
          baseRevisionHash: base.revision.revisionHash,
          currentVersion: sourceHead.version,
          currentRevisionId: sourceHead.revisionId,
        },
        project: {
          id: targetProjectId,
          name: document.name,
          version: 1,
          revisionId,
          snapshotHash: snapshot.hash,
          operationHash: operationsHash,
          revisionHash: integrityHash,
          schemaVersion: document.schema_version,
          assetCount: preparedAssets.length,
          productSpecificationVersion: preparedSpecification ? 1 : null,
          implementationMappingCount: sourceMappingRows.length,
        },
        idMapping: sortedMapping(idMapping),
        diagnostics,
        deepLink: `/design/${encodeURIComponent(targetProjectId)}`,
      };
      const idempotencyNow = new Date();
      this.service.database.sqlite.prepare(
        `INSERT INTO idempotency
         (actor_id, scope, key, request_hash, response_json, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        access.principalId,
        idempotencyScope,
        idempotencyKey,
        requestHash,
        JSON.stringify(response),
        idempotencyNow.toISOString(),
        new Date(idempotencyNow.getTime() + CONFLICT_RECOVERY_IDEMPOTENCY_TTL_MS).toISOString(),
      );
      return response;
    });
    const result = transaction.immediate();
    try {
      flushPersistedEventOutbox(this.service.database.sqlite, this.service.events);
    } catch {
      // The committed outbox row remains replayable if live delivery fails.
    }
    return result;
  }

  async importPortableProject(
    actorId: string,
    data: Buffer,
    input: { mode?: PortableImportMode; idempotencyKey: string },
  ): Promise<PortableImportResult> {
    return this.importPortableProjectSource(actorId, sha256(data), async () => readPortableProjectBundle(data), input);
  }

  async importPortableProjectFile(
    actorId: string,
    upload: PortableUploadFile,
    input: { mode?: PortableImportMode; idempotencyKey: string },
  ): Promise<PortableImportResult> {
    return this.importPortableProjectSource(
      actorId,
      upload.sha256,
      async () => readPortableProjectBundleFile(upload.filename, upload.directory),
      input,
      upload.directory,
    );
  }

  private async importPortableProjectSource(
    actorId: string,
    bundleSha256: string,
    readBundle: () => Promise<AnyImportedPortableProject>,
    input: { mode?: PortableImportMode; idempotencyKey: string },
    stagingDirectory?: string,
  ): Promise<PortableImportResult> {
    const access = this.requireOrganizationAdmin(actorId);
    const exportPolicy = loadOrganizationPolicy(this.service.database.sqlite, access.organizationId).policy.exports;
    if (!exportPolicy.allowPortableBundles) {
      throw new DomainError("FORBIDDEN", "Portable project bundles are disabled by organization policy.", 403);
    }
    const mode = input.mode ?? "conflict_fail";
    if (mode !== "conflict_fail" && mode !== "clone") {
      throw new DomainError("VALIDATION_FAILED", "Portable import mode must be conflict_fail or clone.", 422);
    }
    const idempotencyKey = input.idempotencyKey.trim();
    if (idempotencyKey.length < 8 || idempotencyKey.length > 240) {
      throw new DomainError("VALIDATION_FAILED", "Portable import idempotency key must contain 8 to 240 characters.", 422);
    }
    const idempotencyScope = `portable_import:${access.organizationId}`;
    const requestHash = hashPayload({ bundleSha256, mode, importSemanticsVersion: 2 });
    const readIdempotentResponse = (): PortableImportResult | null => {
      const row = this.service.database.sqlite.prepare(
        `SELECT request_hash, response_json FROM idempotency
         WHERE actor_id = ? AND scope = ? AND key = ? AND expires_at > ?`,
      ).get(access.principalId, idempotencyScope, idempotencyKey, new Date().toISOString()) as {
        request_hash: string;
        response_json: string;
      } | undefined;
      if (!row) return null;
      if (row.request_hash !== requestHash) {
        throw new DomainError("IDEMPOTENCY_CONFLICT", "The idempotency key was already used with a different portable import.", 409);
      }
      return JSON.parse(row.response_json) as PortableImportResult;
    };
    this.service.database.cleanupIdempotency();
    const replay = readIdempotentResponse();
    if (replay) return replay;

    const imported = await readBundle();
    const sourceDocument = imported.document;
    const sourceProductSpecification = portableProductSpecification(imported);
    this.requirePortableDesignSystemPin(access, sourceDocument);
    const deterministicSeed = hashPayload({
      format: "formaspec-portable-clone-v1",
      organizationId: access.organizationId,
      bundleSha256,
      idempotencyKey,
    });
    const idMapping = buildPortableIdMapping(mode, deterministicSeed, sourceDocument, sourceProductSpecification);
    const targetProjectId = idMapping[sourceDocument.id];
    if (!targetProjectId) throw new DomainError("VALIDATION_FAILED", "Portable import did not produce a project ID.", 422);
    const revisionId = deterministicImportRevisionId(deterministicSeed, imported.manifest.revisionId);
    const importId = deterministicPortableImportId(deterministicSeed, imported.manifest.revisionId);
    const preparedSpecification = canonicalImportedProductSpecification(sourceProductSpecification, idMapping);
    const diagnostics: PortableImportDiagnostic[] = [{
      code: "SOURCE_REVISION_HASH_IS_CLAIMED",
      severity: "info",
      message: "The bundle revision hash is retained as source provenance; the local version-1 revision has a newly verified hash chain.",
      details: {
        sourceRevisionId: imported.manifest.revisionId,
        sourceRevisionHashClaim: imported.manifest.revisionHash,
      },
    }];
    if (!preparedSpecification) {
      diagnostics.push({
        code: "PRODUCT_SPECIFICATION_ABSENT",
        severity: "info",
        message: "The portable V1 bundle contained no committed product specification.",
      });
    }
    if (imported.manifest.quarantinedAssetIds.length > 0) {
      diagnostics.push({
        code: "LEGACY_ASSETS_QUARANTINED",
        severity: "warning",
        message: "Legacy unsupported assets were imported as non-rendered metadata without bytes.",
        details: {
          count: imported.manifest.quarantinedAssetIds.length,
          assetIds: imported.manifest.quarantinedAssetIds.slice(0, 100).map((assetId) => idMapping[assetId] ?? assetId),
          truncated: imported.manifest.quarantinedAssetIds.length > 100,
        },
      });
    }
    const now = new Date().toISOString();
    const remapped = replacePortableProjectIds(sourceDocument, idMapping) as unknown as Record<string, unknown>;
    remapped.revision = 1;
    remapped.updated_at = now;
    remapped.metadata = {
      ...(isRecord(remapped.metadata) ? remapped.metadata : {}),
      formaspec_import: {
        format_version: 1,
        mode,
        bundle_sha256: bundleSha256,
        source_project_id: sourceDocument.id,
        source_document_revision: sourceDocument.revision,
        source_revision_id: imported.manifest.revisionId,
        source_revision_hash_claim: imported.manifest.revisionHash,
        imported_at: now,
      },
    };
    if (remapped.schema_version === 2) {
      if (!preparedSpecification) {
        throw new DomainError("VALIDATION_FAILED", "A V2 portable project requires an embedded product specification.", 422);
      }
      remapped.product_specification = preparedSpecification.specification;
    }

    const normalizedSourceAssetIds = Object.keys(imported.manifest.assetHashes).sort();
    const assetPolicy = loadOrganizationPolicy(this.service.database.sqlite, access.organizationId).policy.assets;
    if (normalizedSourceAssetIds.length > 0 && !assetPolicy.enabled) {
      throw new DomainError("FORBIDDEN", "Portable assets cannot be imported because organization asset storage is disabled.", 403);
    }
    if (normalizedSourceAssetIds.length > 0 && !assetPolicy.allowedMimeTypes.includes("image/png")) {
      throw new DomainError("FORBIDDEN", "Portable assets require canonical PNG storage, which organization policy disallows.", 403);
    }
    const rasterVerifier = this.backups.rasterVerifier;
    if (normalizedSourceAssetIds.length > 0 && !rasterVerifier) {
      throw new DomainError("TEMPORARILY_UNAVAILABLE", "The isolated raster normalizer is required for portable asset import.", 503, {
        retryable: true,
      });
    }
    if (normalizedSourceAssetIds.length > 0 && !this.service.assetStore) {
      throw new DomainError("TEMPORARILY_UNAVAILABLE", "The content-addressed asset store is required for portable asset import.", 503, {
        retryable: true,
      });
    }

    const assertNoConflicts = (): void => {
      const existingProject = this.service.database.sqlite.prepare(
        "SELECT organization_id FROM designs WHERE id = ?",
      ).get(targetProjectId) as { organization_id: string } | undefined;
      const conflictingAssetIds: string[] = [];
      const findAsset = this.service.database.sqlite.prepare("SELECT id FROM assets WHERE id = ?");
      for (const sourceAssetId of normalizedSourceAssetIds) {
        const targetAssetId = idMapping[sourceAssetId];
        if (!targetAssetId) throw new DomainError("VALIDATION_FAILED", `Portable asset ID was not remapped: ${sourceAssetId}`, 422);
        if (findAsset.get(targetAssetId)) conflictingAssetIds.push(targetAssetId);
      }
      if (existingProject || conflictingAssetIds.length > 0) {
        throw new DomainError("VERSION_CONFLICT", "Portable import conflicts with existing project or asset IDs.", 409, {
          retryable: false,
          details: {
            mode,
            projectId: targetProjectId,
            projectConflict: Boolean(existingProject),
            conflictingAssetIds: conflictingAssetIds.slice(0, 100),
            recovery: mode === "conflict_fail"
              ? "Retry with explicit clone mode to deterministically remap project-scoped IDs."
              : "Use a new idempotency key to create a distinct deterministic clone.",
          },
        });
      }
    };
    assertNoConflicts();

    const preparedAssets: PreparedPortableAsset[] = [];
    const renormalizedAssetIds: string[] = [];
    for (const sourceAssetId of normalizedSourceAssetIds) {
      const sourceAsset = sourceDocument.assets[sourceAssetId];
      const targetAssetId = idMapping[sourceAssetId];
      if (!sourceAsset || !targetAssetId) {
        throw new DomainError("VALIDATION_FAILED", `Portable asset metadata is missing: ${sourceAssetId}`, 422);
      }
      const normalized = await normalizeImageAsset(
        await portableAssetBytes(imported, sourceAssetId),
        sourceAsset.mime_type,
        {
          maxBytes: Math.min(assetPolicy.maximumBytes, rasterVerifier!.limits.maxBytes),
          maxPixels: Math.min(assetPolicy.maximumPixels, rasterVerifier!.limits.maxPixels),
        },
        rasterVerifier!.engine,
        {
          scope: "organization",
          organizationId: access.organizationId,
          operation: "portable_import",
        },
      );
      const normalizedSha256 = sha256(normalized.data);
      if (sourceAsset.mime_type !== normalized.mimeType
        || sourceAsset.sha256 !== normalizedSha256
        || sourceAsset.size_bytes !== normalized.data.length
        || sourceAsset.width !== normalized.width
        || sourceAsset.height !== normalized.height) {
        renormalizedAssetIds.push(targetAssetId);
      }
      const sourceFilename = "display_filename" in sourceAsset
        ? sourceAsset.display_filename
        : sourceAsset.name;
      const filename = safeFilename(sourceFilename, normalized.mimeType);
      const assets = remapped.assets;
      if (!isRecord(assets) || !isRecord(assets[targetAssetId])) {
        throw new DomainError("VALIDATION_FAILED", `Remapped portable asset metadata is missing: ${targetAssetId}`, 422);
      }
      const targetAsset = assets[targetAssetId] as Record<string, unknown>;
      targetAsset.id = targetAssetId;
      targetAsset.kind = "image";
      targetAsset.mime_type = "image/png";
      targetAsset.size_bytes = normalized.data.length;
      targetAsset.sha256 = normalizedSha256;
      targetAsset.width = normalized.width;
      targetAsset.height = normalized.height;
      if (remapped.schema_version === 1) targetAsset.storage_key = `asset:${targetAssetId}`;
      else {
        targetAsset.status = "ready";
        targetAsset.display_filename = filename;
      }
      preparedAssets.push({
        id: targetAssetId,
        filename,
        mimeType: "image/png",
        width: normalized.width,
        height: normalized.height,
        sha256: normalizedSha256,
        sizeBytes: normalized.data.length,
        ...(stagingDirectory
          ? { stagedFilename: await stagePreparedPortableAsset(stagingDirectory, normalized.data) }
          : { data: normalized.data }),
      });
    }
    if (renormalizedAssetIds.length > 0) {
      diagnostics.push({
        code: "ASSETS_RENORMALIZED",
        severity: "info",
        message: "Portable raster bytes were fully decoded and deterministically normalized to canonical PNG metadata.",
        details: {
          count: renormalizedAssetIds.length,
          assetIds: renormalizedAssetIds.slice(0, 100),
          truncated: renormalizedAssetIds.length > 100,
        },
      });
    }

    const parsedDocument = AnyDesignDocumentSchema.safeParse(remapped);
    if (!parsedDocument.success) {
      throw new DomainError("VALIDATION_FAILED", "The rebased portable project does not satisfy its strict schema.", 422, {
        details: { issues: parsedDocument.error.issues.slice(0, 100) },
      });
    }
    const document = parsedDocument.data;
    if (document.id !== targetProjectId || document.revision !== 1) {
      throw new DomainError("VALIDATION_FAILED", "The portable project was not rebased to local revision 1.", 422);
    }
    for (const asset of preparedAssets) {
      this.service.assetStore!.writeNormalized(preparedPortableAssetBytes(asset), asset.mimeType, asset.sha256);
    }

    const message = `Import portable bundle ${bundleSha256.slice(0, 12)} (${mode})`;
    const operationsHash = operationHash([]);
    const transaction = this.service.database.sqlite.transaction(() => {
      this.service.database.cleanupIdempotency();
      const existing = readIdempotentResponse();
      if (existing) return existing;
      assertNoConflicts();
      const transactionDesignSystemPin = this.requirePortableDesignSystemPin(access, document);
      const snapshot = storeSnapshot(this.service.database.sqlite, document, now);
      const integrityHash = revisionHash({
        parentRevisionHash: null,
        snapshotHash: snapshot.hash,
        operationHash: operationsHash,
        metadata: {
          id: revisionId,
          designId: targetProjectId,
          version: 1,
          parentRevisionId: null,
          actorId,
          message,
          createdAt: now,
        },
      });
      this.service.database.sqlite.prepare(
        `INSERT INTO designs
         (id, actor_id, name, current_version, current_revision_id, created_at, updated_at, organization_id)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
      ).run(targetProjectId, actorId, document.name, revisionId, now, now, access.organizationId);
      if (transactionDesignSystemPin?.source === "project_design_system_pins") {
        this.service.database.sqlite.prepare(
          `INSERT INTO project_design_system_pins
           (design_id, organization_id, design_system_id, release_id, release_version, pinned_by, pinned_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          targetProjectId,
          access.organizationId,
          transactionDesignSystemPin.designSystemId,
          transactionDesignSystemPin.releaseId,
          transactionDesignSystemPin.releaseVersion,
          access.principalId,
          now,
        );
      }
      this.service.database.sqlite.prepare(
        `INSERT INTO revisions
         (id, design_id, version, parent_revision_id, actor_id, message, document_json, operations_json,
          snapshot_hash, operation_hash, parent_revision_hash, revision_hash, created_at)
         VALUES (?, ?, 1, NULL, ?, ?, ?, '[]', ?, ?, NULL, ?, ?)`,
      ).run(
        revisionId,
        targetProjectId,
        access.principalId,
        message,
        snapshot.canonicalJson,
        snapshot.hash,
        operationsHash,
        integrityHash,
        now,
      );
      const insertAsset = this.service.database.sqlite.prepare(
        `INSERT INTO assets
         (id, actor_id, design_id, filename, mime_type, size_bytes, width, height, sha256, data, created_at, organization_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const asset of preparedAssets) {
        const assetData = preparedPortableAssetBytes(asset);
        insertAsset.run(
          asset.id,
          actorId,
          targetProjectId,
          asset.filename,
          asset.mimeType,
          asset.sizeBytes,
          asset.width,
          asset.height,
          asset.sha256,
          assetData,
          now,
          access.organizationId,
        );
      }
      if (preparedSpecification) {
        this.service.database.sqlite.prepare(
          `INSERT INTO product_specifications
           (design_id, version, specification_json, organization_id, specification_hash, message,
            revision_id, actor_id, created_at)
           VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          targetProjectId,
          preparedSpecification.json,
          access.organizationId,
          preparedSpecification.hash,
          "Import portable product specification",
          revisionId,
          access.principalId,
          now,
        );
      }
      this.service.database.sqlite.prepare(
        `INSERT INTO portable_imports
         (id, organization_id, mode, bundle_sha256, source_document_id, source_document_revision,
          source_revision_id, source_revision_hash_claim, target_design_id, target_revision_id,
          id_map_json, manifest_json, diagnostics_json, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        importId,
        access.organizationId,
        mode,
        bundleSha256,
        sourceDocument.id,
        sourceDocument.revision,
        imported.manifest.revisionId,
        imported.manifest.revisionHash,
        targetProjectId,
        revisionId,
        canonicalJson(idMapping),
        canonicalJson(imported.manifest),
        canonicalJson(diagnostics),
        access.principalId,
        now,
      );
      const auditEventId = appendAuditEvent(
        this.service.database.sqlite,
        access,
        "portable_import.commit",
        "portable_import",
        importId,
        {
          importId,
          designId: targetProjectId,
          mode,
          bundleSha256,
          sourceProjectId: sourceDocument.id,
          sourceDocumentRevision: sourceDocument.revision,
          sourceRevisionId: imported.manifest.revisionId,
          sourceRevisionHashClaim: imported.manifest.revisionHash,
          sourceProductSpecificationVersion: preparedSpecification?.sourceVersion ?? null,
          designSystemPin: transactionDesignSystemPin,
          localRevisionId: revisionId,
          localSnapshotHash: snapshot.hash,
          localRevisionHash: integrityHash,
          normalizedAssetCount: preparedAssets.length,
          quarantinedAssetCount: imported.manifest.quarantinedAssetIds.length,
        },
      );
      this.service.database.sqlite.prepare(
        `INSERT INTO event_outbox
         (organization_id, actor_id, event_type, payload_json, workspace, created_at)
         VALUES (?, ?, 'design.created', ?, 1, ?)`,
      ).run(access.organizationId, actorId, JSON.stringify({
        auditEventId,
        designId: targetProjectId,
        version: 1,
        revisionId,
        schemaVersion: document.schema_version,
        imported: true,
        mode,
      }), now);
      if (preparedSpecification) {
        this.service.database.sqlite.prepare(
          `INSERT INTO event_outbox
           (organization_id, actor_id, event_type, payload_json, workspace, created_at)
           VALUES (?, ?, 'product_spec.committed', ?, 1, ?)`,
        ).run(access.organizationId, actorId, JSON.stringify({
          importId,
          designId: targetProjectId,
          revisionId,
          version: 1,
          specificationHash: preparedSpecification.hash,
          imported: true,
        }), now);
      }
      const response: PortableImportResult = {
        importId,
        imported: true,
        mutationsApplied: true,
        mode,
        bundleSha256,
        source: {
          projectId: sourceDocument.id,
          revisionId: imported.manifest.revisionId,
          revisionHashClaim: imported.manifest.revisionHash,
          documentRevision: sourceDocument.revision,
          productSpecificationVersion: preparedSpecification?.sourceVersion ?? null,
        },
        project: {
          id: targetProjectId,
          name: document.name,
          version: 1,
          revisionId,
          snapshotHash: snapshot.hash,
          revisionHash: integrityHash,
          schemaVersion: document.schema_version,
          assetCount: preparedAssets.length,
          quarantinedAssetCount: imported.manifest.quarantinedAssetIds.length,
          productSpecificationVersion: preparedSpecification ? 1 : null,
        },
        idMapping,
        designSystemPin: transactionDesignSystemPin,
        diagnostics,
        deepLink: `/design/${encodeURIComponent(targetProjectId)}`,
      };
      const idempotencyNow = new Date();
      this.service.database.sqlite.prepare(
        `INSERT INTO idempotency
         (actor_id, scope, key, request_hash, response_json, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        access.principalId,
        idempotencyScope,
        idempotencyKey,
        requestHash,
        JSON.stringify(response),
        idempotencyNow.toISOString(),
        new Date(idempotencyNow.getTime() + PORTABLE_IMPORT_IDEMPOTENCY_TTL_MS).toISOString(),
      );
      return response;
    });
    const result = transaction.immediate();
    try {
      flushPersistedEventOutbox(this.service.database.sqlite, this.service.events);
    } catch {
      // The committed outbox row remains replayable if live delivery fails.
    }
    return result;
  }

  listBackups(actorId: string): PublicBackupRecord[] {
    const access = this.requireOrganizationAdmin(actorId);
    const rows = this.service.database.sqlite.prepare(
      "SELECT * FROM backup_records WHERE organization_id = ? ORDER BY created_at DESC, id DESC",
    ).all(access.organizationId) as BackupRecordRow[];
    return rows.map((row) => this.publicBackupRecord(row));
  }

  async validateBackupImportFile(actorId: string, upload: BackupUploadFile): Promise<BackupImportValidationResult> {
    const access = this.requireOrganizationAdmin(actorId);
    this.requireBackupsEnabled(access);
    const pinned = await verifyPinnedBackupBundle(upload.filename, {
      expectedSource: { sha256: upload.sha256, sizeBytes: upload.sizeBytes },
      sourcePinDirectory: upload.directory,
      ...(this.backups.rasterVerifier
        ? { rasterVerifier: this.backups.rasterVerifier, requireRasterVerifier: true }
        : {}),
    });
    const result = this.backupImportValidationResult(pinned.verification, pinned.bundleSha256, pinned.sizeBytes);
    appendAuditEvent(this.service.database.sqlite, access, "backup.import_validate", "backup_bundle", null, {
      bundleSha256: pinned.bundleSha256,
      sizeBytes: pinned.sizeBytes,
      databaseSchemaVersion: pinned.verification.manifest.databaseSchemaVersion,
      entryCount: pinned.verification.entryCount,
      mutationsApplied: false,
    });
    return result;
  }

  async registerBackupImportFile(
    actorId: string,
    upload: BackupUploadFile,
    expectedSha256: string,
  ): Promise<BackupImportResult> {
    const access = this.requireOrganizationAdmin(actorId);
    this.requireBackupsEnabled(access);
    if (upload.sha256 !== expectedSha256) {
      throw new DomainError("VERSION_CONFLICT", "The selected backup does not match the validated SHA-256.", 409, {
        details: { expectedSha256, actualSha256: upload.sha256 },
      });
    }
    const lockHolder = this.acquireOperationalLock(access, "backup", "Register one verified uploaded backup", 15 * 60);
    try {
      const pinned = await verifyPinnedBackupBundle(upload.filename, {
        expectedSource: { sha256: expectedSha256, sizeBytes: upload.sizeBytes },
        sourcePinDirectory: upload.directory,
        ...(this.backups.rasterVerifier
          ? { rasterVerifier: this.backups.rasterVerifier, requireRasterVerifier: true }
          : {}),
      });
      const existing = this.service.database.sqlite.prepare(
        "SELECT * FROM backup_records WHERE organization_id = ? AND bundle_sha256 = ? ORDER BY created_at DESC LIMIT 1",
      ).get(access.organizationId, pinned.bundleSha256) as BackupRecordRow | undefined;
      if (existing) {
        appendAuditEvent(this.service.database.sqlite, access, "backup.import_reuse", "backup", existing.id, {
          bundleSha256: pinned.bundleSha256,
          sizeBytes: pinned.sizeBytes,
        });
        return {
          registered: true,
          alreadyRegistered: true,
          destructiveRestoreRequired: true,
          backup: this.publicBackupRecord(existing),
        };
      }

      await fs.promises.mkdir(this.backupDirectory, { recursive: true, mode: 0o700 });
      const root = path.resolve(this.backupDirectory);
      const rootStat = await fs.promises.lstat(root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        throw new DomainError("TEMPORARILY_UNAVAILABLE", "The managed backup directory is unsafe.", 503);
      }
      const decimalDigest = BigInt(`0x${pinned.bundleSha256.slice(0, 24)}`).toString(10).padStart(29, "0");
      const filename = `formaspec-backup-1970-01-01T00-00-00-000Z-${decimalDigest}.tar`;
      const destination = path.join(root, filename);
      let createdFile = false;
      try {
        try {
          await fs.promises.copyFile(upload.filename, destination, fs.constants.COPYFILE_EXCL);
          createdFile = true;
          await fs.promises.chmod(destination, 0o400);
          const handle = await fs.promises.open(destination, "r");
          try { await handle.sync(); } finally { await handle.close(); }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const stat = await fs.promises.lstat(destination);
          if (!stat.isFile() || stat.isSymbolicLink()
            || stat.size !== pinned.sizeBytes
            || await sha256File(destination) !== pinned.bundleSha256) {
            throw new DomainError("IDEMPOTENCY_CONFLICT", "A different file already occupies the managed backup destination.", 409);
          }
        }
        await this.assertManagedBundle(destination, filename);
        const id = `backup_${createHash("sha256")
          .update(`import\0${access.organizationId}\0${pinned.bundleSha256}`)
          .digest("hex").slice(0, 40)}`;
        const now = new Date().toISOString();
        const transaction = this.service.database.sqlite.transaction(() => {
          this.service.database.sqlite.prepare(
            `INSERT INTO backup_records
             (id, organization_id, filename, bundle_sha256, status, manifest_json, created_by, created_at, verified_at,
              size_bytes, verification_json, retention_class, completed_at)
             VALUES (?, ?, ?, ?, 'valid', ?, ?, ?, ?, ?, ?, 'manual', ?)`,
          ).run(
            id,
            access.organizationId,
            filename,
            pinned.bundleSha256,
            JSON.stringify(pinned.verification.manifest),
            access.principalId,
            pinned.verification.manifest.createdAt,
            now,
            pinned.sizeBytes,
            JSON.stringify(pinned.verification),
            now,
          );
          appendAuditEvent(this.service.database.sqlite, access, "backup.import", "backup", id, {
            filename,
            bundleSha256: pinned.bundleSha256,
            sizeBytes: pinned.sizeBytes,
            databaseSchemaVersion: pinned.verification.manifest.databaseSchemaVersion,
            entryCount: pinned.verification.entryCount,
            restoreRequiresDowntime: true,
          });
          return this.requireBackupRow(access, id);
        });
        return {
          registered: true,
          alreadyRegistered: false,
          destructiveRestoreRequired: true,
          backup: this.publicBackupRecord(transaction.immediate()),
        };
      } catch (error) {
        if (createdFile) {
          const references = this.service.database.sqlite.prepare(
            "SELECT COUNT(*) AS count FROM backup_records WHERE filename = ?",
          ).get(filename) as { count: number };
          if (references.count === 0) await fs.promises.rm(destination, { force: true }).catch(() => undefined);
        }
        throw error;
      }
    } finally {
      this.releaseOperationalLock(access, "backup", lockHolder);
    }
  }

  assertBackupAdministrationAllowed(actorId: string): void {
    this.requireOrganizationAdmin(actorId);
  }

  assertBackupImportAllowed(actorId: string): void {
    const access = this.requireOrganizationAdmin(actorId);
    this.requireBackupsEnabled(access);
  }

  async createBackup(actorId: string): Promise<PublicBackupRecord> {
    const access = this.requireOrganizationAdmin(actorId);
    this.requireBackupsEnabled(access);
    const lockHolder = this.acquireOperationalLock(access, "backup", "Create a consistent verified backup", 15 * 60);
    try {
      return await this.createManagedBackup(access, "manual");
    } finally {
      this.releaseOperationalLock(access, "backup", lockHolder);
    }
  }

  getBackupSchedule(actorId: string, at = new Date()): PublicBackupSchedule {
    const access = this.requireOrganizationAdmin(actorId);
    return this.publicBackupSchedule(access, at);
  }

  backupSupervisionHealth(at = new Date()): BackupSupervisionHealth {
    const organizations = this.service.database.sqlite.prepare(
      `SELECT organization.id
       FROM organizations organization
       WHERE EXISTS (
         SELECT 1 FROM backup_schedules schedule WHERE schedule.organization_id = organization.id
       ) OR EXISTS (
         SELECT 1 FROM backup_records backup WHERE backup.organization_id = organization.id
       )
       ORDER BY organization.id`,
    ).all() as Array<{ id: string }>;
    const snapshots = organizations.map(({ id }) => this.backupScheduleSnapshot(id, at).supervision);
    const criticalSchedules = snapshots.filter((snapshot) => snapshot.status === "critical").length;
    const warningSchedules = snapshots.filter((snapshot) => snapshot.status === "warning").length;
    return {
      status: criticalSchedules > 0 ? "critical" : warningSchedules > 0 ? "warning" : "ok",
      checkedAt: at.toISOString(),
      trackedOrganizations: snapshots.length,
      enabledSchedules: snapshots.filter((snapshot) => snapshot.dueAt !== null).length,
      warningSchedules,
      criticalSchedules,
      retentionBacklogs: snapshots.filter((snapshot) => snapshot.retention.candidateCount > 0).length,
    };
  }

  updateBackupSchedule(
    actorId: string,
    input: { enabled: boolean; cronExpression: string },
    at = new Date(),
  ): PublicBackupSchedule {
    const access = this.requireOrganizationAdmin(actorId);
    const backupPolicy = this.backupPolicy(access);
    if (input.enabled && !backupPolicy.enabled) {
      throw new DomainError("FORBIDDEN", "Scheduled backups are disabled by organization policy.", 403);
    }
    const cronExpression = this.validatedDailyCron(input.cronExpression);
    const updatedAt = at.toISOString();
    const previous = this.backupScheduleRow(access);
    const transaction = this.service.database.sqlite.transaction(() => {
      this.service.database.sqlite.prepare(
        `INSERT INTO backup_schedules
         (organization_id, enabled, cron_expression, daily_retention, weekly_retention, monthly_retention, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(organization_id) DO UPDATE SET
           enabled = excluded.enabled,
           cron_expression = excluded.cron_expression,
           daily_retention = excluded.daily_retention,
           weekly_retention = excluded.weekly_retention,
           monthly_retention = excluded.monthly_retention,
           updated_at = excluded.updated_at`,
      ).run(
        access.organizationId,
        input.enabled ? 1 : 0,
        cronExpression,
        backupPolicy.retention.daily,
        backupPolicy.retention.weekly,
        backupPolicy.retention.monthly,
        updatedAt,
      );
      appendAuditEvent(this.service.database.sqlite, access, "backup.schedule_update", "backup_schedule", access.organizationId, {
        previous: previous ? { enabled: previous.enabled === 1, cronExpression: previous.cron_expression } : null,
        enabled: input.enabled,
        cronExpression,
        timezone: "UTC",
        retention: backupPolicy.retention,
      });
    });
    transaction.immediate();
    return this.publicBackupSchedule(access, at);
  }

  async runScheduledBackup(actorId: string, at = new Date()): Promise<ScheduledBackupRunResult> {
    const access = this.requireOrganizationAdmin(actorId);
    const backupPolicy = this.backupPolicy(access);
    if (!backupPolicy.enabled) {
      return { status: "disabled", dueAt: null, nextDueAt: null, retentionClass: null, backup: null };
    }
    const initialSchedule = this.backupScheduleRow(access);
    if (!initialSchedule || initialSchedule.enabled !== 1) {
      return { status: "disabled", dueAt: null, nextDueAt: null, retentionClass: null, backup: null };
    }
    const lockHolder = this.acquireOperationalLock(access, "backup", "Run one idempotent scheduled backup window", 15 * 60);
    let runId: string | null = null;
    let activeWindow: ReturnType<typeof backupScheduleWindow> | null = null;
    let startedAt: string | null = null;
    try {
      const schedule = this.backupScheduleRow(access);
      const currentPolicy = this.backupPolicy(access);
      if (!currentPolicy.enabled || !schedule || schedule.enabled !== 1) {
        return { status: "disabled", dueAt: null, nextDueAt: null, retentionClass: null, backup: null };
      }
      const window = backupScheduleWindow(
        this.validatedDailyCron(schedule?.cron_expression ?? currentPolicy.scheduleUtc),
        at,
      );
      activeWindow = window;
      runId = `backup_schedule_run_${randomUUID().replaceAll("-", "")}`;
      startedAt = new Date().toISOString();
      appendAuditEvent(
        this.service.database.sqlite,
        access,
        "backup.schedule_run_started",
        "backup_schedule_run",
        runId,
        {
          runId,
          dueAt: window.dueAt,
          nextDueAt: window.nextDueAt,
          startedAt,
        },
      );
      const existing = this.scheduledBackupInWindow(access, window.dueAt, window.nextDueAt);
      if (existing) {
        appendAuditEvent(
          this.service.database.sqlite,
          access,
          "backup.schedule_run",
          "backup_schedule_run",
          runId,
          {
            runId,
            status: "already_completed",
            dueAt: window.dueAt,
            nextDueAt: window.nextDueAt,
            retentionClass: existing.retention_class,
            startedAt,
            completedAt: new Date().toISOString(),
          },
        );
        return {
          status: "already_completed",
          dueAt: window.dueAt,
          nextDueAt: window.nextDueAt,
          retentionClass: existing.retention_class === "manual" ? null : existing.retention_class,
          backup: this.publicBackupRecord(existing),
        };
      }
      const retentionClass = this.retentionClassForWindow(access, new Date(window.dueAt));
      const backup = await this.createManagedBackup(access, retentionClass, window.dueAt);
      appendAuditEvent(
        this.service.database.sqlite,
        access,
        "backup.schedule_run",
        "backup_schedule_run",
        runId,
        {
          runId,
          status: "created",
          dueAt: window.dueAt,
          nextDueAt: window.nextDueAt,
          retentionClass,
          startedAt,
          completedAt: new Date().toISOString(),
        },
      );
      return {
        status: "created",
        dueAt: window.dueAt,
        nextDueAt: window.nextDueAt,
        retentionClass,
        backup,
      };
    } catch (error) {
      if (runId !== null && activeWindow !== null && startedAt !== null) {
        const failure = asDomainError(error);
        try {
          appendAuditEvent(
            this.service.database.sqlite,
            access,
            "backup.schedule_run_failed",
            "backup_schedule_run",
            runId,
            {
              runId,
              dueAt: activeWindow.dueAt,
              nextDueAt: activeWindow.nextDueAt,
              startedAt,
              completedAt: new Date().toISOString(),
              errorCode: failure.code,
              retryable: failure.retryable,
            },
          );
        } catch {
          // Preserve the scheduled-backup failure if its diagnostic write also fails.
        }
      }
      throw error;
    } finally {
      this.releaseOperationalLock(access, "backup", lockHolder);
    }
  }

  async previewBackupPrune(actorId: string, at = new Date()): Promise<BackupPrunePreview> {
    const access = this.requireOrganizationAdmin(actorId);
    this.service.database.sqlite.prepare(
      `DELETE FROM operational_locks
       WHERE organization_id = ? AND name LIKE ? AND expires_at <= ?`,
    ).run(access.organizationId, `${BACKUP_PRUNE_PREVIEW_PREFIX}%`, at.toISOString());
    const plan = this.backupRetentionPlan(access);
    await this.revalidatePruneCandidates(access, plan);

    const previewId = `backup_prune_preview_${randomUUID().replaceAll("-", "")}`;
    const generatedAt = at.toISOString();
    const expiresAt = new Date(at.getTime() + BACKUP_PRUNE_PREVIEW_TTL_MS).toISOString();
    const metadata: BackupPrunePreviewMetadata = {
      format: "formaspec-backup-prune-preview",
      formatVersion: 1,
      planHash: plan.planHash,
      backupIds: plan.candidates.map((candidate) => candidate.id),
      generatedAt,
      expiresAt,
    };
    const transaction = this.service.database.sqlite.transaction(() => {
      this.service.database.sqlite.prepare(
        `INSERT INTO operational_locks
         (name, organization_id, holder_id, purpose, metadata_json, acquired_at, expires_at)
         VALUES (?, ?, ?, 'Preview exact managed-backup retention pruning', ?, ?, ?)`,
      ).run(
        this.prunePreviewLockName(previewId),
        access.organizationId,
        access.principalId,
        JSON.stringify(metadata),
        generatedAt,
        expiresAt,
      );
      appendAuditEvent(this.service.database.sqlite, access, "backup.prune_preview", "backup_prune_preview", previewId, {
        planHash: plan.planHash,
        backupIds: metadata.backupIds,
        totalCandidateBytes: plan.totalCandidateBytes,
        expiresAt,
        retention: plan.policy,
      });
    });
    transaction.immediate();
    return this.publicPrunePreview(previewId, generatedAt, expiresAt, plan);
  }

  async executeBackupPrune(
    actorId: string,
    previewId: string,
    expectedPlanHash: string,
    at = new Date(),
  ): Promise<BackupPruneResult> {
    const access = this.requireOrganizationAdmin(actorId);
    const lockHolder = this.acquireOperationalLock(access, "backup", "Commit an exact previewed backup prune", 15 * 60);
    try {
      const preview = this.requirePrunePreview(access, previewId, at);
      if (preview.planHash !== expectedPlanHash) {
        throw new DomainError("VERSION_CONFLICT", "The backup-prune plan hash does not match the preview.", 409, {
          details: { expectedPlanHash, previewPlanHash: preview.planHash },
        });
      }
      const plan = this.backupRetentionPlan(access);
      this.assertCurrentPrunePlan(preview, plan);
      const verified = await this.revalidatePruneCandidates(access, plan);
      await fs.promises.mkdir(this.backupDirectory, { recursive: true, mode: 0o700 });
      const stagingDirectory = path.resolve(
        this.backupDirectory,
        `.prune-${previewId}-${randomUUID().replaceAll("-", "")}`,
      );
      if (path.dirname(stagingDirectory) !== path.resolve(this.backupDirectory)) {
        throw new DomainError("INTERNAL_ERROR", "Backup prune staging escaped the managed directory.", 500);
      }
      await fs.promises.mkdir(stagingDirectory, { mode: 0o700 });
      const moved: Array<{ original: string; staged: string; stat: fs.Stats; id: string }> = [];
      let committed = false;
      try {
        const transaction = this.service.database.sqlite.transaction(() => {
          const current = this.backupRetentionPlan(access);
          this.assertCurrentPrunePlan(preview, current);
          for (const item of verified) {
            const currentStat = fs.lstatSync(item.path);
            if (!currentStat.isFile() || currentStat.isSymbolicLink()
              || currentStat.dev !== item.stat.dev || currentStat.ino !== item.stat.ino || currentStat.size !== item.stat.size) {
              throw new DomainError("VERSION_CONFLICT", `Backup ${item.row.id} changed after prune validation.`, 409);
            }
            const staged = path.join(stagingDirectory, `${item.row.id}.tar`);
            fs.renameSync(item.path, staged);
            const stagedStat = fs.lstatSync(staged);
            if (stagedStat.dev !== item.stat.dev || stagedStat.ino !== item.stat.ino || stagedStat.size !== item.stat.size) {
              throw new DomainError("VALIDATION_FAILED", `Backup ${item.row.id} could not be staged safely.`, 422);
            }
            moved.push({ original: item.path, staged, stat: item.stat, id: item.row.id });
          }
          for (const candidate of current.candidates) {
            const result = this.service.database.sqlite.prepare(
              `DELETE FROM backup_records
               WHERE id = ? AND organization_id = ? AND retention_class <> 'manual'`,
            ).run(candidate.id, access.organizationId);
            if (result.changes !== 1) {
              throw new DomainError("VERSION_CONFLICT", `Backup ${candidate.id} changed before prune commit.`, 409);
            }
          }
          const previewDeleted = this.service.database.sqlite.prepare(
            "DELETE FROM operational_locks WHERE organization_id = ? AND name = ? AND holder_id = ?",
          ).run(access.organizationId, this.prunePreviewLockName(previewId), access.principalId);
          if (previewDeleted.changes !== 1) throw new DomainError("VERSION_CONFLICT", "The backup-prune preview changed before commit.", 409);
          appendAuditEvent(this.service.database.sqlite, access, "backup.prune_commit", "backup_prune_preview", previewId, {
            planHash: current.planHash,
            backupIds: current.candidates.map((candidate) => candidate.id),
            prunedBytes: current.totalCandidateBytes,
            retention: current.policy,
          });
        });
        transaction.immediate();
        committed = true;
      } catch (error) {
        let restoreFailed = false;
        for (const item of moved.reverse()) {
          try {
            if (!fs.existsSync(item.original) && fs.existsSync(item.staged)) fs.renameSync(item.staged, item.original);
          } catch {
            restoreFailed = true;
          }
        }
        if (!restoreFailed) {
          try {
            fs.rmdirSync(stagingDirectory);
          } catch {
            // Preserve the original failure; an empty generated staging directory is safe to inspect later.
          }
        }
        throw error;
      }

      let cleanupPending = false;
      if (committed) {
        for (const item of moved) {
          try {
            const stagedStat = await fs.promises.lstat(item.staged);
            if (!stagedStat.isFile() || stagedStat.isSymbolicLink()
              || stagedStat.dev !== item.stat.dev || stagedStat.ino !== item.stat.ino || stagedStat.size !== item.stat.size) {
              cleanupPending = true;
              continue;
            }
            await fs.promises.unlink(item.staged);
          } catch {
            cleanupPending = true;
          }
        }
        try {
          await fs.promises.rmdir(stagingDirectory);
        } catch {
          cleanupPending = true;
        }
      }
      if (cleanupPending) {
        appendAuditEvent(this.service.database.sqlite, access, "backup.prune_cleanup_pending", "backup_prune_preview", previewId, {
          stagingDirectoryName: path.basename(stagingDirectory),
          backupIds: moved.map((item) => item.id),
        });
      }
      return {
        previewId,
        planHash: plan.planHash,
        prunedBackupIds: plan.candidates.map((candidate) => candidate.id),
        prunedBytes: plan.totalCandidateBytes,
        cleanupPending,
      };
    } finally {
      this.releaseOperationalLock(access, "backup", lockHolder);
    }
  }

  async verifyBackup(actorId: string, backupId: string): Promise<PublicBackupRecord> {
    const access = this.requireOrganizationAdmin(actorId);
    const row = this.requireBackupRow(access, backupId);
    let verification: BackupVerificationResult;
    let sizeBytes = 0;
    try {
      const bundlePath = await this.managedBundlePath(row.filename);
      if (!row.bundle_sha256) {
        throw new DomainError("VALIDATION_FAILED", "Backup bundle has no immutable hash record.", 422);
      }
      const pinned = await verifyPinnedBackupBundle(bundlePath, {
        expectedSource: {
          sha256: row.bundle_sha256,
          ...(row.size_bytes === null ? {} : { sizeBytes: row.size_bytes }),
        },
        sourcePinDirectory: this.backupDirectory,
        ...(this.backups.rasterVerifier
          ? { rasterVerifier: this.backups.rasterVerifier, requireRasterVerifier: true }
          : {}),
      });
      verification = pinned.verification;
      sizeBytes = pinned.sizeBytes;
    } catch (error) {
      const transaction = this.service.database.sqlite.transaction(() => {
        this.service.database.sqlite.prepare("UPDATE backup_records SET status = 'invalid' WHERE id = ?").run(row.id);
        appendAuditEvent(this.service.database.sqlite, access, "backup.verify_failed", "backup", row.id, {
          code: error instanceof DomainError ? error.code : "INTERNAL_ERROR",
        });
      });
      transaction.immediate();
      throw error;
    }
    const verifiedAt = new Date().toISOString();
    const transaction = this.service.database.sqlite.transaction(() => {
      this.service.database.sqlite.prepare(
        `UPDATE backup_records
         SET status = 'valid', manifest_json = ?, verified_at = ?, size_bytes = ?, verification_json = ?, completed_at = ?
         WHERE id = ?`,
      ).run(
        JSON.stringify(verification.manifest),
        verifiedAt,
        sizeBytes,
        JSON.stringify(verification),
        verifiedAt,
        row.id,
      );
      appendAuditEvent(this.service.database.sqlite, access, "backup.verify", "backup", row.id, {
        bundleSha256: row.bundle_sha256,
        entryCount: verification.entryCount,
      });
      return this.requireBackupRow(access, row.id);
    });
    return this.publicBackupRecord(transaction.immediate());
  }

  async openBackupDownload(actorId: string, backupId: string): Promise<BackupDownload> {
    const access = this.requireOrganizationAdmin(actorId);
    const row = this.requireBackupRow(access, backupId);
    if (row.status !== "valid" || !row.bundle_sha256) {
      throw new DomainError("VALIDATION_FAILED", "Only a valid, verified backup can be downloaded.", 409);
    }
    const bundlePath = await this.managedBundlePath(row.filename);
    let pinned: Awaited<ReturnType<typeof openPinnedBackupStream>>;
    try {
      pinned = await openPinnedBackupStream(bundlePath, {
        expectedSource: {
          sha256: row.bundle_sha256,
          ...(row.size_bytes === null ? {} : { sizeBytes: row.size_bytes }),
        },
        sourcePinDirectory: this.backupDirectory,
      });
    } catch (error) {
      this.service.database.sqlite.prepare("UPDATE backup_records SET status = 'invalid' WHERE id = ?").run(row.id);
      appendAuditEvent(this.service.database.sqlite, access, "backup.download_rejected", "backup", row.id, {
        reason: error instanceof DomainError ? error.code : "bundle_verification_failed",
      });
      throw error;
    }
    appendAuditEvent(this.service.database.sqlite, access, "backup.download", "backup", row.id, {
      bundleSha256: pinned.bundleSha256,
      sizeBytes: pinned.sizeBytes,
    });
    return {
      record: this.publicBackupRecord(row),
      stream: pinned.stream,
      sizeBytes: pinned.sizeBytes,
    };
  }

  private async createManagedBackup(
    access: AccessContext,
    retentionClass: BackupRetentionClass,
    scheduleWindow?: string,
  ): Promise<PublicBackupRecord> {
    const created = await this.backups.create();
    const filename = path.basename(created.path);
    await this.assertManagedBundle(created.path, filename);
    const pinned = await verifyPinnedBackupBundle(created.path, {
      sourcePinDirectory: this.backupDirectory,
      ...(this.backups.rasterVerifier
        ? { rasterVerifier: this.backups.rasterVerifier, requireRasterVerifier: true }
        : {}),
    });
    const bundleSha256 = pinned.bundleSha256;
    const sizeBytes = pinned.sizeBytes;
    const id = `backup_${createHash("sha256").update(`${filename}\0${bundleSha256}`).digest("hex").slice(0, 40)}`;
    const now = new Date().toISOString();
    const transaction = this.service.database.sqlite.transaction(() => {
      this.service.database.sqlite.prepare(
        `INSERT INTO backup_records
         (id, organization_id, filename, bundle_sha256, status, manifest_json, created_by, created_at, verified_at,
          size_bytes, verification_json, retention_class, completed_at)
         VALUES (?, ?, ?, ?, 'valid', ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        access.organizationId,
        filename,
        bundleSha256,
        JSON.stringify(pinned.verification.manifest),
        access.principalId,
        created.verification.manifest.createdAt,
        now,
        sizeBytes,
        JSON.stringify(pinned.verification),
        retentionClass,
        now,
      );
      appendAuditEvent(this.service.database.sqlite, access, "backup.create", "backup", id, {
        filename,
        bundleSha256,
        entryCount: pinned.verification.entryCount,
        retentionClass,
        scheduleWindow: scheduleWindow ?? null,
      });
      return this.requireBackupRow(access, id);
    });
    return this.publicBackupRecord(transaction.immediate());
  }

  private validatedDailyCron(expression: string): string {
    try {
      const { minute, hour } = parseDailyBackupCron(expression);
      return `${minute} ${hour} * * *`;
    } catch (error) {
      throw new DomainError("VALIDATION_FAILED", error instanceof Error ? error.message : "The backup schedule is invalid.", 422);
    }
  }

  private backupScheduleRow(access: AccessContext): BackupScheduleRow | undefined {
    return this.service.database.sqlite.prepare(
      "SELECT * FROM backup_schedules WHERE organization_id = ?",
    ).get(access.organizationId) as BackupScheduleRow | undefined;
  }

  private publicBackupSchedule(access: AccessContext, at: Date): PublicBackupSchedule {
    return this.backupScheduleSnapshot(access.organizationId, at);
  }

  private backupScheduleSnapshot(organizationId: string, at: Date): PublicBackupSchedule {
    const row = this.service.database.sqlite.prepare(
      "SELECT * FROM backup_schedules WHERE organization_id = ?",
    ).get(organizationId) as BackupScheduleRow | undefined;
    const policy = loadOrganizationPolicy(this.service.database.sqlite, organizationId).policy.backups;
    const cronExpression = this.validatedDailyCron(row?.cron_expression ?? policy.scheduleUtc);
    const enabled = policy.enabled && row?.enabled === 1;
    const latest = this.service.database.sqlite.prepare(
      `SELECT completed_at FROM backup_records
       WHERE organization_id = ? AND retention_class <> 'manual' AND completed_at IS NOT NULL
       ORDER BY completed_at DESC, id DESC LIMIT 1`,
    ).get(organizationId) as { completed_at: string } | undefined;
    const plan = this.backupRetentionPlanForOrganization(organizationId, policy.retention);
    const window = enabled ? backupScheduleWindow(cronExpression, at) : null;
    const currentWindowCovered = window === null
      ? false
      : this.scheduledBackupInWindowForOrganization(organizationId, window.dueAt, window.nextDueAt) !== undefined;
    const supervision = evaluateBackupScheduleSupervision({
      enabled,
      cronExpression,
      at,
      currentWindowCovered,
      latestAttempt: this.latestBackupScheduleAttempt(organizationId),
      retentionCandidateCount: plan.candidates.length,
      retentionCandidateBytes: plan.totalCandidateBytes,
      retentionProtectedCount: plan.protectedCount,
      retentionPlanHash: plan.planHash,
    });
    return {
      enabled,
      cronExpression,
      timezone: "UTC",
      retention: policy.retention,
      updatedAt: row?.updated_at ?? null,
      lastScheduledBackupAt: latest?.completed_at ?? null,
      nextDueAt: supervision.nextDueAt,
      supervision,
    };
  }

  private scheduledBackupInWindow(access: AccessContext, dueAt: string, nextDueAt: string): BackupRecordRow | undefined {
    return this.scheduledBackupInWindowForOrganization(access.organizationId, dueAt, nextDueAt);
  }

  private scheduledBackupInWindowForOrganization(
    organizationId: string,
    dueAt: string,
    nextDueAt: string,
  ): BackupRecordRow | undefined {
    return this.service.database.sqlite.prepare(
      `SELECT * FROM backup_records
       WHERE organization_id = ? AND retention_class <> 'manual'
         AND status IN ('valid', 'restored') AND bundle_sha256 IS NOT NULL AND completed_at IS NOT NULL
         AND created_at >= ? AND created_at < ?
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    ).get(organizationId, dueAt, nextDueAt) as BackupRecordRow | undefined;
  }

  private latestBackupScheduleAttempt(organizationId: string): BackupScheduleAttempt | null {
    const started = this.service.database.sqlite.prepare(
      `SELECT target_id, details_json, created_at
       FROM audit_events
       WHERE organization_id = ? AND action = 'backup.schedule_run_started'
         AND target_type = 'backup_schedule_run'
       ORDER BY id DESC LIMIT 1`,
    ).get(organizationId) as { target_id: string | null; details_json: string; created_at: string } | undefined;
    if (!started?.target_id || !/^backup_schedule_run_[a-f0-9]{32}$/.test(started.target_id)) return null;
    let startDetails: Record<string, unknown>;
    try {
      const parsed = JSON.parse(started.details_json) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      startDetails = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
    const dueAt = this.validScheduleAuditTimestamp(startDetails.dueAt);
    const nextDueAt = this.validScheduleAuditTimestamp(startDetails.nextDueAt);
    const startedAt = this.validScheduleAuditTimestamp(startDetails.startedAt) ?? this.validScheduleAuditTimestamp(started.created_at);
    if (!dueAt || !nextDueAt || !startedAt) return null;

    const terminal = this.service.database.sqlite.prepare(
      `SELECT action, details_json, created_at
       FROM audit_events
       WHERE organization_id = ? AND target_type = 'backup_schedule_run' AND target_id = ?
         AND action IN ('backup.schedule_run', 'backup.schedule_run_failed')
       ORDER BY id DESC LIMIT 1`,
    ).get(organizationId, started.target_id) as {
      action: "backup.schedule_run" | "backup.schedule_run_failed";
      details_json: string;
      created_at: string;
    } | undefined;
    if (!terminal) {
      return {
        runId: started.target_id,
        status: "running",
        dueAt,
        nextDueAt,
        startedAt,
        completedAt: null,
        errorCode: null,
        retryable: null,
      };
    }
    let terminalDetails: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(terminal.details_json) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) terminalDetails = parsed as Record<string, unknown>;
    } catch {
      // The terminal action remains authoritative even if optional details are unavailable.
    }
    const completedAt = this.validScheduleAuditTimestamp(terminalDetails.completedAt)
      ?? this.validScheduleAuditTimestamp(terminal.created_at);
    if (terminal.action === "backup.schedule_run_failed") {
      const errorCode = typeof terminalDetails.errorCode === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(terminalDetails.errorCode)
        ? terminalDetails.errorCode
        : "INTERNAL_ERROR";
      return {
        runId: started.target_id,
        status: "failed",
        dueAt,
        nextDueAt,
        startedAt,
        completedAt,
        errorCode,
        retryable: typeof terminalDetails.retryable === "boolean" ? terminalDetails.retryable : null,
      };
    }
    return {
      runId: started.target_id,
      status: terminalDetails.status === "already_completed" ? "already_completed" : "created",
      dueAt,
      nextDueAt,
      startedAt,
      completedAt,
      errorCode: null,
      retryable: null,
    };
  }

  private validScheduleAuditTimestamp(value: unknown): string | null {
    if (typeof value !== "string" || value.length > 40) return null;
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value ? value : null;
  }

  private retentionClassForWindow(
    access: AccessContext,
    dueAt: Date,
  ): Exclude<BackupRetentionClass, "manual"> {
    const bounds = calendarRetentionBounds(dueAt);
    const hasMonthly = this.service.database.sqlite.prepare(
      `SELECT 1 FROM backup_records b
       WHERE b.organization_id = ? AND b.retention_class = 'monthly' AND b.status IN ('valid', 'restored')
         AND COALESCE(
           (SELECT json_extract(a.details_json, '$.scheduleWindow') FROM audit_events a
            WHERE a.action = 'backup.create' AND a.target_type = 'backup' AND a.target_id = b.id
            ORDER BY a.id DESC LIMIT 1),
           b.completed_at
         ) >= ?
         AND COALESCE(
           (SELECT json_extract(a.details_json, '$.scheduleWindow') FROM audit_events a
            WHERE a.action = 'backup.create' AND a.target_type = 'backup' AND a.target_id = b.id
            ORDER BY a.id DESC LIMIT 1),
           b.completed_at
         ) < ? LIMIT 1`,
    ).get(access.organizationId, bounds.monthStart, bounds.monthEnd);
    if (!hasMonthly) return "monthly";
    const hasWeekly = this.service.database.sqlite.prepare(
      `SELECT 1 FROM backup_records b
       WHERE b.organization_id = ? AND b.retention_class = 'weekly' AND b.status IN ('valid', 'restored')
         AND COALESCE(
           (SELECT json_extract(a.details_json, '$.scheduleWindow') FROM audit_events a
            WHERE a.action = 'backup.create' AND a.target_type = 'backup' AND a.target_id = b.id
            ORDER BY a.id DESC LIMIT 1),
           b.completed_at
         ) >= ?
         AND COALESCE(
           (SELECT json_extract(a.details_json, '$.scheduleWindow') FROM audit_events a
            WHERE a.action = 'backup.create' AND a.target_type = 'backup' AND a.target_id = b.id
            ORDER BY a.id DESC LIMIT 1),
           b.completed_at
         ) < ? LIMIT 1`,
    ).get(access.organizationId, bounds.weekStart, bounds.weekEnd);
    return hasWeekly ? "daily" : "weekly";
  }

  private backupRetentionPlan(access: AccessContext): BackupRetentionPlan {
    return this.backupRetentionPlanForOrganization(access.organizationId, this.backupPolicy(access).retention);
  }

  private backupRetentionPlanForOrganization(
    organizationId: string,
    retention: Readonly<BackupRetentionPolicy>,
  ): BackupRetentionPlan {
    const rows = this.service.database.sqlite.prepare(
      "SELECT * FROM backup_records WHERE organization_id = ? ORDER BY created_at DESC, id DESC",
    ).all(organizationId) as BackupRecordRow[];
    const records: RetentionRecord[] = rows.map((row) => ({
      id: row.id,
      filename: row.filename,
      bundleSha256: row.bundle_sha256,
      status: row.status,
      createdAt: row.created_at,
      verifiedAt: row.verified_at,
      completedAt: row.completed_at,
      sizeBytes: row.size_bytes,
      retentionClass: row.retention_class,
    }));
    return buildBackupRetentionPlan(records, retention);
  }

  private publicPruneCandidate(candidate: RetentionPlanRecord): PublicBackupPruneCandidate {
    if (candidate.retentionClass === "manual" || candidate.bundleSha256 === null || candidate.sizeBytes === null) {
      throw new DomainError("INTERNAL_ERROR", "The persisted backup prune plan is invalid.", 500);
    }
    return {
      id: candidate.id,
      filename: candidate.filename,
      bundleSha256: candidate.bundleSha256,
      sizeBytes: candidate.sizeBytes,
      retentionClass: candidate.retentionClass,
      completedAt: candidate.effectiveCompletedAt,
    };
  }

  private publicPrunePreview(
    previewId: string,
    generatedAt: string,
    expiresAt: string,
    plan: BackupRetentionPlan,
  ): BackupPrunePreview {
    return {
      previewId,
      planHash: plan.planHash,
      generatedAt,
      expiresAt,
      retention: plan.policy,
      candidates: plan.candidates.map((candidate) => this.publicPruneCandidate(candidate)),
      retainedCount: plan.retained.length,
      manualExemptCount: plan.manualExemptCount,
      protectedCount: plan.protectedCount,
      totalCandidateBytes: plan.totalCandidateBytes,
    };
  }

  private prunePreviewLockName(previewId: string): string {
    if (!/^backup_prune_preview_[a-f0-9]{32}$/.test(previewId)) {
      throw new DomainError("NOT_FOUND", "Backup-prune preview not found.", 404);
    }
    return `${BACKUP_PRUNE_PREVIEW_PREFIX}${previewId}`;
  }

  private requirePrunePreview(access: AccessContext, previewId: string, at: Date): BackupPrunePreviewMetadata {
    const name = this.prunePreviewLockName(previewId);
    const row = this.service.database.sqlite.prepare(
      `SELECT holder_id, metadata_json, expires_at FROM operational_locks
       WHERE organization_id = ? AND name = ?`,
    ).get(access.organizationId, name) as { holder_id: string; metadata_json: string; expires_at: string } | undefined;
    if (!row) throw new DomainError("NOT_FOUND", "Backup-prune preview not found.", 404);
    if (row.expires_at <= at.toISOString()) {
      this.service.database.sqlite.prepare(
        "DELETE FROM operational_locks WHERE organization_id = ? AND name = ?",
      ).run(access.organizationId, name);
      appendAuditEvent(this.service.database.sqlite, access, "backup.prune_preview_expired", "backup_prune_preview", previewId);
      throw new DomainError("PREVIEW_EXPIRED", "The backup-prune preview expired.", 410);
    }
    if (row.holder_id !== access.principalId) {
      throw new DomainError("FORBIDDEN", "The backup-prune preview belongs to another administrator.", 403);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.metadata_json);
    } catch (error) {
      throw new DomainError("INTERNAL_ERROR", "The persisted backup-prune preview is invalid.", 500, { cause: error });
    }
    if (!isRecord(parsed)
      || parsed.format !== "formaspec-backup-prune-preview"
      || parsed.formatVersion !== 1
      || typeof parsed.planHash !== "string"
      || !/^[a-f0-9]{64}$/.test(parsed.planHash)
      || !Array.isArray(parsed.backupIds)
      || !parsed.backupIds.every((id) => typeof id === "string" && /^backup_[a-f0-9]{40}$/.test(id))
      || typeof parsed.generatedAt !== "string"
      || typeof parsed.expiresAt !== "string"
      || parsed.expiresAt !== row.expires_at) {
      throw new DomainError("INTERNAL_ERROR", "The persisted backup-prune preview is invalid.", 500);
    }
    return parsed as unknown as BackupPrunePreviewMetadata;
  }

  private assertCurrentPrunePlan(preview: BackupPrunePreviewMetadata, current: BackupRetentionPlan): void {
    const currentIds = current.candidates.map((candidate) => candidate.id);
    if (preview.planHash !== current.planHash
      || preview.backupIds.length !== currentIds.length
      || preview.backupIds.some((id, index) => id !== currentIds[index])) {
      throw new DomainError("VERSION_CONFLICT", "Managed backups changed after the prune preview; create a new preview.", 409, {
        details: {
          previewPlanHash: preview.planHash,
          currentPlanHash: current.planHash,
          previewBackupIds: preview.backupIds,
          currentBackupIds: currentIds,
        },
      });
    }
  }

  private async revalidatePruneCandidate(
    access: AccessContext,
    candidate: RetentionPlanRecord,
  ): Promise<{ row: BackupRecordRow; path: string; stat: fs.Stats }> {
    const row = this.requireBackupRow(access, candidate.id);
    if (row.retention_class === "manual"
      || (row.status !== "valid" && row.status !== "restored")
      || row.filename !== candidate.filename
      || row.bundle_sha256 !== candidate.bundleSha256
      || row.size_bytes !== candidate.sizeBytes
      || (row.completed_at ?? row.verified_at) !== candidate.effectiveCompletedAt) {
      throw new DomainError("VERSION_CONFLICT", `Backup ${candidate.id} changed after retention planning.`, 409);
    }
    const bundlePath = await this.managedBundlePath(row.filename);
    const stat = await fs.promises.lstat(bundlePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== row.size_bytes) {
      throw new DomainError("VALIDATION_FAILED", `Backup ${candidate.id} no longer matches its managed record.`, 422);
    }
    const actualHash = await sha256File(bundlePath);
    if (actualHash !== row.bundle_sha256) {
      throw new DomainError("VALIDATION_FAILED", `Backup ${candidate.id} failed immutable hash revalidation.`, 422);
    }
    return { row, path: bundlePath, stat };
  }

  private async revalidatePruneCandidates(
    access: AccessContext,
    plan: BackupRetentionPlan,
  ): Promise<Array<{ row: BackupRecordRow; path: string; stat: fs.Stats }>> {
    if (plan.candidates.length > MAX_BACKUP_PRUNE_CANDIDATES) {
      throw new DomainError("PAYLOAD_TOO_LARGE", `A single prune is limited to ${MAX_BACKUP_PRUNE_CANDIDATES} backups.`, 413, {
        details: { candidateCount: plan.candidates.length, maximumCandidateCount: MAX_BACKUP_PRUNE_CANDIDATES },
      });
    }
    const verified: Array<{ row: BackupRecordRow; path: string; stat: fs.Stats }> = [];
    for (const candidate of plan.candidates) verified.push(await this.revalidatePruneCandidate(access, candidate));
    return verified;
  }

  private requireOrganizationAdmin(actorId: string): AccessContext {
    const access = resolveAccess(this.service.database.sqlite, actorId);
    if (access.role !== "organization_admin") {
      throw new DomainError("FORBIDDEN", "Organization Administrator permission is required.", 403);
    }
    return access;
  }

  private requireConflictRecoveryDuplicateAccess(actorId: string, sourceDesignId: unknown): AccessContext {
    const access = resolveAccess(this.service.database.sqlite, actorId);
    assertDesignWrite(access);
    if (access.projectIds.length > 0) {
      throw new DomainError(
        "FORBIDDEN",
        "A project-restricted agent grant cannot create a conflict-recovery project.",
        403,
      );
    }
    if (typeof sourceDesignId !== "string") throw new DomainError("NOT_FOUND", "Design not found.", 404);
    this.service.getDesign(actorId, sourceDesignId);
    return access;
  }

  private backupPolicy(access: AccessContext) {
    return loadOrganizationPolicy(this.service.database.sqlite, access.organizationId).policy.backups;
  }

  private requireBackupsEnabled(access: AccessContext): void {
    if (!this.backupPolicy(access).enabled) {
      throw new DomainError("FORBIDDEN", "Backups are disabled by organization policy.", 403);
    }
  }

  private acquireOperationalLock(access: AccessContext, name: string, purpose: string, ttlSeconds: number): string {
    const holder = `${access.principalId}:${randomUUID()}`;
    const nowDate = new Date();
    const now = nowDate.toISOString();
    const expiresAt = new Date(nowDate.getTime() + ttlSeconds * 1_000).toISOString();
    const transaction = this.service.database.sqlite.transaction(() => {
      this.service.database.sqlite.prepare(
        "DELETE FROM operational_locks WHERE organization_id = ? AND name = ? AND expires_at <= ?",
      ).run(access.organizationId, name, now);
      const existing = this.service.database.sqlite.prepare(
        "SELECT holder_id, expires_at FROM operational_locks WHERE organization_id = ? AND name = ?",
      ).get(access.organizationId, name) as { holder_id: string; expires_at: string } | undefined;
      if (existing) {
        throw new DomainError("TEMPORARILY_UNAVAILABLE", `The ${name} operation is already running.`, 503, {
          retryable: true,
          details: { expiresAt: existing.expires_at },
        });
      }
      this.service.database.sqlite.prepare(
        `INSERT INTO operational_locks
         (name, organization_id, holder_id, purpose, metadata_json, acquired_at, expires_at)
         VALUES (?, ?, ?, ?, '{}', ?, ?)`,
      ).run(name, access.organizationId, holder, purpose, now, expiresAt);
      appendAuditEvent(this.service.database.sqlite, access, "operational_lock.acquire", "operational_lock", name, {
        purpose,
        expiresAt,
      });
    });
    transaction.immediate();
    return holder;
  }

  private releaseOperationalLock(access: AccessContext, name: string, holder: string): void {
    const transaction = this.service.database.sqlite.transaction(() => {
      const result = this.service.database.sqlite.prepare(
        "DELETE FROM operational_locks WHERE organization_id = ? AND name = ? AND holder_id = ?",
      ).run(access.organizationId, name, holder);
      if (result.changes > 0) {
        appendAuditEvent(this.service.database.sqlite, access, "operational_lock.release", "operational_lock", name);
      }
    });
    transaction.immediate();
  }

  private requireBackupRow(access: AccessContext, backupId: string): BackupRecordRow {
    if (!/^backup_[a-f0-9]{40}$/.test(backupId)) throw new DomainError("NOT_FOUND", "Backup not found.", 404);
    const row = this.service.database.sqlite.prepare(
      "SELECT * FROM backup_records WHERE id = ? AND organization_id = ?",
    ).get(backupId, access.organizationId) as BackupRecordRow | undefined;
    if (!row) throw new DomainError("NOT_FOUND", "Backup not found.", 404);
    return row;
  }

  private publicBackupRecord(row: BackupRecordRow): PublicBackupRecord {
    let manifest: BackupManifest | null = null;
    if (row.manifest_json) {
      try {
        const parsed = JSON.parse(row.manifest_json) as BackupManifest;
        if (parsed.format !== "formaspec-backup"
          || (parsed.formatVersion !== 1 && parsed.formatVersion !== 2)
          || !Array.isArray(parsed.files)) throw new Error("invalid manifest");
        manifest = parsed;
      } catch (error) {
        throw new DomainError("INTERNAL_ERROR", "Persisted backup manifest is invalid.", 500, { cause: error });
      }
    }
    return {
      id: row.id,
      filename: row.filename,
      status: row.status,
      bundleSha256: row.bundle_sha256,
      createdAt: row.created_at,
      verifiedAt: row.verified_at,
      sizeBytes: row.size_bytes,
      retentionClass: row.retention_class,
      completedAt: row.completed_at,
      downloadUrl: `/api/backups/${encodeURIComponent(row.id)}/download`,
      manifest: manifest ? {
        format: manifest.format,
        formatVersion: manifest.formatVersion,
        createdAt: manifest.createdAt,
        databaseSchemaVersion: manifest.databaseSchemaVersion,
        documentSchemaVersion: manifest.documentSchemaVersion,
        fileCount: manifest.files.length,
      } : null,
    };
  }

  private backupImportValidationResult(
    verification: BackupVerificationResult,
    bundleSha256: string,
    sizeBytes: number,
  ): BackupImportValidationResult {
    return {
      valid: true,
      validationOnly: true,
      mutationsApplied: false,
      bundleSha256,
      sizeBytes,
      destructiveRestoreRequired: true,
      manifest: {
        format: verification.manifest.format,
        formatVersion: verification.manifest.formatVersion,
        createdAt: verification.manifest.createdAt,
        databaseSchemaVersion: verification.manifest.databaseSchemaVersion,
        documentSchemaVersion: verification.manifest.documentSchemaVersion,
        fileCount: verification.manifest.files.length,
      },
      verification: {
        sqliteIntegrity: verification.sqliteIntegrity,
        foreignKeyViolations: verification.foreignKeyViolations,
        extractedBytes: verification.extractedBytes,
        entryCount: verification.entryCount,
      },
    };
  }

  private async assertManagedBundle(bundlePath: string, filename: string): Promise<void> {
    if (!/^formaspec-backup-[0-9TZ-]+\.tar$/.test(filename)) {
      throw new DomainError("INTERNAL_ERROR", "Backup manager returned an invalid bundle filename.", 500);
    }
    const configuredRoot = path.resolve(this.backupDirectory);
    if (path.dirname(path.resolve(bundlePath)) !== configuredRoot || path.basename(bundlePath) !== filename) {
      throw new DomainError("INTERNAL_ERROR", "Backup manager returned a bundle outside the managed backup directory.", 500);
    }
    await this.managedBundlePath(filename);
  }

  private async managedBundlePath(filename: string): Promise<string> {
    if (path.basename(filename) !== filename || !/^formaspec-backup-[0-9TZ-]+\.tar$/.test(filename)) {
      throw new DomainError("INTERNAL_ERROR", "Persisted backup filename is invalid.", 500);
    }
    const configuredRoot = path.resolve(this.backupDirectory);
    const candidate = path.resolve(configuredRoot, filename);
    if (path.dirname(candidate) !== configuredRoot) throw new DomainError("INTERNAL_ERROR", "Backup path escaped its managed directory.", 500);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new DomainError("NOT_FOUND", "Backup bundle is unavailable.", 404);
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new DomainError("VALIDATION_FAILED", "Backup bundle is not a regular managed file.", 422);
    const [realRoot, realCandidate] = await Promise.all([
      fs.promises.realpath(configuredRoot),
      fs.promises.realpath(candidate),
    ]);
    if (path.dirname(realCandidate) !== realRoot) throw new DomainError("VALIDATION_FAILED", "Backup bundle escapes the managed directory.", 422);
    return candidate;
  }
}
