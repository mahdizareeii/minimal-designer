import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  appendAuditEvent,
  assertProjectAccess,
  assertScope,
  resolveAccess,
  type AccessContext,
  type OrganizationRole,
} from "./authorization.js";
import type { DesignerDatabase } from "./db/database.js";
import { DomainError } from "./errors.js";
import { canonicalJson, hashPayload } from "./ids.js";
import { loadOrganizationPolicy } from "./organization-policy-model.js";

export const WORKSPACE_INVENTORY_MAX_BYTES = 1_048_576;
export const WORKSPACE_INVENTORY_MAX_ENTITIES = 10_000;
export const HANDOFF_SPECIFICATION_MAX_BYTES = 524_288;

export const REPOSITORY_INVENTORY_STATUSES = ["active", "superseded", "revoked"] as const;
export type RepositoryInventoryStatus = (typeof REPOSITORY_INVENTORY_STATUSES)[number];

export const HANDOFF_STATUSES = ["draft", "in_review", "approved", "implementing", "completed", "cancelled"] as const;
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number];

const repositoryPlatformSchema = z.enum(["web", "android", "ios", "flutter", "react-native", "generic-git"]);
const inventoryEntityKindSchema = z.enum(["component", "screen", "route", "token", "asset", "flow", "business-rule"]);
const inventoryEntityIdSchema = z.string().regex(/^inv_[a-f0-9]{40}$/);
const inventoryLocationIdSchema = z.string().regex(/^loc_[a-f0-9]{40}$/);
const stableReferenceSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{2,159}$/);
const handoffItemIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{2,79}$/);
const safeSymbolSchema = z.string().min(1).max(240).regex(/^[A-Za-z_][A-Za-z0-9_.:#<>,?()[\]-]{0,239}$/);

const uploadInventoryEntitySchema = z.object({
  id: inventoryEntityIdSchema,
  kind: inventoryEntityKindSchema,
  name: z.string().trim().min(1).max(240),
  symbol: safeSymbolSchema.nullable(),
  locationId: inventoryLocationIdSchema,
  line: z.number().int().positive().max(10_000_000).nullable(),
}).strict();

const excludedInventoryCategorySchema = z.object({
  category: z.enum(["secret", "generated", "policy", "symlink", "limit"]),
  count: z.number().int().nonnegative().max(10_000_000),
}).strict();

const repositoryExcludedPatternsSchema = z.array(z.string().trim().min(1).max(240)).max(100).superRefine((patterns, context) => {
  const seen = new Set<string>();
  for (const [index, pattern] of patterns.entries()) {
    if (seen.has(pattern)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [index], message: "Repository exclusion patterns must be unique." });
    }
    seen.add(pattern);
  }
});

export const UploadRepositoryInventorySchema = z.object({
  schemaVersion: z.literal(1),
  repositoryFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  generatedAt: z.string().datetime({ offset: true }),
  platforms: z.array(repositoryPlatformSchema).min(1).max(6),
  gitHead: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(),
  excludedPatterns: repositoryExcludedPatternsSchema.optional(),
  scannedFileCount: z.number().int().nonnegative().max(1_000_000),
  skippedFileCount: z.number().int().nonnegative().max(1_000_000),
  bytesRead: z.number().int().nonnegative().max(32 * 1024 * 1024),
  truncated: z.boolean(),
  entities: z.array(uploadInventoryEntitySchema).max(WORKSPACE_INVENTORY_MAX_ENTITIES),
  excluded: z.array(excludedInventoryCategorySchema).max(5),
}).strict().superRefine((inventory, context) => {
  const platforms = new Set<string>();
  for (const [index, platform] of inventory.platforms.entries()) {
    if (platforms.has(platform)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["platforms", index], message: "Platform entries must be unique." });
    platforms.add(platform);
  }
  const entityIds = new Set<string>();
  const locationRows = new Set<string>();
  for (const [index, entity] of inventory.entities.entries()) {
    if (entityIds.has(entity.id)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["entities", index, "id"], message: "Inventory entity IDs must be unique." });
    entityIds.add(entity.id);
    const row = `${entity.locationId}\0${entity.line ?? 0}\0${entity.kind}`;
    if (locationRows.has(row)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["entities", index], message: "Inventory entity locations must be unique." });
    locationRows.add(row);
  }
  const excluded = new Set<string>();
  for (const [index, entry] of inventory.excluded.entries()) {
    if (excluded.has(entry.category)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["excluded", index, "category"], message: "Exclusion categories must be unique." });
    excluded.add(entry.category);
  }
});

const validationCheckSchema = z.enum([
  "typecheck",
  "unit_tests",
  "integration_tests",
  "build",
  "lint",
  "visual_regression",
  "accessibility",
]);

const acceptanceCriterionSchema = z.object({
  id: handoffItemIdSchema,
  statement: z.string().trim().min(1).max(1_000),
  designEntityIds: z.array(stableReferenceSchema).max(100).default([]),
}).strict();

const implementationSliceSchema = z.object({
  id: handoffItemIdSchema,
  title: z.string().trim().min(1).max(200),
  objective: z.string().trim().min(1).max(2_000),
  inventoryEntityIds: z.array(inventoryEntityIdSchema).min(1).max(200),
  designEntityIds: z.array(stableReferenceSchema).max(200).default([]),
  dependsOn: z.array(handoffItemIdSchema).max(50).default([]),
  validationChecks: z.array(validationCheckSchema).min(1).max(7),
}).strict();

export const HandoffSpecificationSchema = z.object({
  schemaVersion: z.literal(1),
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(4_000),
  acceptanceCriteria: z.array(acceptanceCriterionSchema).min(1).max(200),
  implementationSlices: z.array(implementationSliceSchema).min(1).max(100),
  risks: z.array(z.string().trim().min(1).max(1_000)).max(100).default([]),
  openQuestions: z.array(z.string().trim().min(1).max(1_000)).max(100).default([]),
  implementationPolicy: z.object({
    preferredIsolation: z.enum(["worktree", "branch"]),
    commitRequiresExplicitApproval: z.literal(true),
    pullRequestRequiresExplicitRequest: z.literal(true),
  }).strict(),
}).strict().superRefine((specification, context) => {
  const criterionIds = new Set<string>();
  for (const [index, criterion] of specification.acceptanceCriteria.entries()) {
    if (criterionIds.has(criterion.id)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["acceptanceCriteria", index, "id"], message: "Acceptance-criterion IDs must be unique." });
    criterionIds.add(criterion.id);
  }
  const slices = new Map<string, number>();
  for (const [index, slice] of specification.implementationSlices.entries()) {
    if (slices.has(slice.id)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["implementationSlices", index, "id"], message: "Implementation-slice IDs must be unique." });
    slices.set(slice.id, index);
    if (new Set(slice.inventoryEntityIds).size !== slice.inventoryEntityIds.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["implementationSlices", index, "inventoryEntityIds"], message: "Inventory references must be unique within a slice." });
    }
    if (new Set(slice.validationChecks).size !== slice.validationChecks.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["implementationSlices", index, "validationChecks"], message: "Validation checks must be unique within a slice." });
    }
  }
  for (const [index, slice] of specification.implementationSlices.entries()) {
    for (const [dependencyIndex, dependency] of slice.dependsOn.entries()) {
      if (!slices.has(dependency) || dependency === slice.id) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["implementationSlices", index, "dependsOn", dependencyIndex], message: "Slice dependencies must reference a different known slice." });
      }
    }
  }
});

const opaqueDatabaseIdSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{2,200}$/);
const positiveVersionSchema = z.number().int().positive().max(1_000_000_000);

export const CreateHandoffRequestSchema = z.object({
  designId: opaqueDatabaseIdSchema,
  revisionId: opaqueDatabaseIdSchema,
  expectedDesignVersion: positiveVersionSchema,
  inventoryId: z.string().regex(/^inventory_[a-f0-9]{32}$/),
  specification: z.unknown(),
}).strict();

export const UpdateHandoffRequestSchema = z.object({
  expectedVersion: positiveVersionSchema,
  specification: z.unknown(),
}).strict();

const submitHandoffRequestSchema = z.object({
  expectedVersion: positiveVersionSchema,
  summary: z.string(),
}).strict();

const returnHandoffRequestSchema = z.object({
  expectedVersion: positiveVersionSchema,
  reason: z.string(),
}).strict();

const approveHandoffRequestSchema = z.object({
  expectedVersion: positiveVersionSchema,
  decision: z.literal("approved"),
  summary: z.string(),
  acceptanceCriteriaConfirmed: z.literal(true),
  implementationPlanConfirmed: z.literal(true),
}).strict();

const startImplementationRequestSchema = z.object({
  expectedVersion: positiveVersionSchema,
  approvedVersion: positiveVersionSchema,
  authorization: z.literal("start_implementation"),
}).strict();

const completeImplementationRequestSchema = z.object({
  expectedVersion: positiveVersionSchema,
  summary: z.string(),
  diffReviewed: z.literal(true),
  validationApproved: z.literal(true),
  commitApproved: z.literal(true),
  pullRequestRequested: z.boolean(),
}).strict();

const cancelHandoffRequestSchema = z.object({
  expectedVersion: positiveVersionSchema,
  reason: z.string(),
}).strict();

export type UploadRepositoryInventory = z.infer<typeof UploadRepositoryInventorySchema>;
export type HandoffSpecification = z.infer<typeof HandoffSpecificationSchema>;
export type CreateHandoffRequest = z.infer<typeof CreateHandoffRequestSchema>;
export type UpdateHandoffRequest = z.infer<typeof UpdateHandoffRequestSchema>;

export interface RepositoryInventoryResult {
  id: string;
  repositoryFingerprint: string;
  inventoryHash: string;
  inventory: UploadRepositoryInventory;
  status: RepositoryInventoryStatus;
  createdBy: string;
  createdAt: string;
  revokedAt: string | null;
  deduplicated: boolean;
}

export interface HandoffVersionResult {
  version: number;
  specification: HandoffSpecification;
  actorId: string;
  createdAt: string;
}

export interface HandoffTransitionResult {
  id: string;
  fromStatus: HandoffStatus | null;
  toStatus: HandoffStatus;
  actorId: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface HandoffResult {
  id: string;
  designId: string;
  revisionId: string;
  designVersion: number;
  inventoryId: string;
  status: HandoffStatus;
  currentVersion: number;
  specification: HandoffSpecification;
  versions: HandoffVersionResult[];
  transitions: HandoffTransitionResult[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceHandoffServiceOptions {
  now?: () => Date;
}

interface RepositoryInventoryRow {
  id: string;
  organization_id: string;
  repository_fingerprint: string;
  inventory_hash: string;
  inventory_json: string;
  status: RepositoryInventoryStatus;
  created_by: string;
  created_at: string;
  revoked_at: string | null;
}

interface DesignRow {
  id: string;
  organization_id: string;
  current_version: number;
  current_revision_id: string;
}

interface HandoffRow {
  id: string;
  organization_id: string;
  design_id: string;
  revision_id: string;
  inventory_id: string | null;
  status: HandoffStatus;
  current_version: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface HandoffVersionRow {
  handoff_id: string;
  version: number;
  specification_json: string;
  actor_id: string;
  created_at: string;
}

interface HandoffTransitionRow {
  id: string;
  handoff_id: string;
  from_status: HandoffStatus | null;
  to_status: HandoffStatus;
  actor_id: string;
  details_json: string;
  created_at: string;
}

const handoffTransitionGraph: Record<HandoffStatus, readonly HandoffStatus[]> = {
  draft: ["in_review", "cancelled"],
  in_review: ["draft", "approved", "cancelled"],
  approved: ["implementing", "cancelled"],
  implementing: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

function workflowId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function parseInput<TSchema extends z.ZodTypeAny>(schema: TSchema, value: unknown, label: string): z.output<TSchema> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new DomainError("VALIDATION_FAILED", `${label} is invalid.`, 422, {
      details: {
        issues: parsed.error.issues.slice(0, 50).map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
          message: issue.message,
        })),
      },
    });
  }
  return parsed.data;
}

function serializedBytes(value: unknown, label: string): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch (error) {
    throw new DomainError("VALIDATION_FAILED", `${label} must be JSON-serializable.`, 422, { cause: error });
  }
}

function assertPayloadLimit(value: unknown, maximumBytes: number, label: string): void {
  if (serializedBytes(value, label) > maximumBytes) {
    throw new DomainError("PAYLOAD_TOO_LARGE", `${label} exceeds the ${maximumBytes}-byte limit.`, 413);
  }
}

function parsePersisted<TSchema extends z.ZodTypeAny>(schema: TSchema, value: string, label: string): z.output<TSchema> {
  try {
    const parsed = schema.safeParse(JSON.parse(value) as unknown);
    if (!parsed.success) throw parsed.error;
    return parsed.data;
  } catch (error) {
    throw new DomainError("INTERNAL_ERROR", `Persisted ${label} is invalid.`, 500, { cause: error });
  }
}

function parseDetails(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new DomainError("INTERNAL_ERROR", "Persisted handoff transition details are invalid.", 500, { cause: error });
  }
}

function roleAllowed(access: AccessContext, allowed: readonly OrganizationRole[], agentScope?: string): void {
  if (access.role === "agent") {
    if (agentScope === undefined) throw new DomainError("FORBIDDEN", "Agent connections cannot perform this handoff operation.", 403);
    assertScope(access, agentScope);
    return;
  }
  if (!allowed.includes(access.role)) throw new DomainError("FORBIDDEN", "The current role cannot perform this handoff operation.", 403);
}

function versionConflict(expected: number, actual: number, subject: string): DomainError {
  return new DomainError("VERSION_CONFLICT", `Expected ${subject} version ${expected}, but the current version is ${actual}.`, 409, {
    details: { expectedVersion: expected, currentVersion: actual, subject },
  });
}

function stateConflict(expected: HandoffStatus, actual: HandoffStatus): DomainError {
  return new DomainError("VERSION_CONFLICT", `Expected handoff state ${expected}, but the current state is ${actual}.`, 409, {
    details: { expectedStatus: expected, currentStatus: actual, subject: "handoff" },
  });
}

export class WorkspaceHandoffService {
  readonly #now: () => Date;

  constructor(readonly database: DesignerDatabase, options: WorkspaceHandoffServiceOptions = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  persistRepositoryInventory(actorId: string, input: unknown): RepositoryInventoryResult {
    const access = resolveAccess(this.database.sqlite, actorId);
    roleAllowed(access, ["organization_admin", "engineer"], "workspace:inventory:write");
    if (access.projectIds.length > 0) {
      throw new DomainError("FORBIDDEN", "Project-restricted grants cannot persist organization-wide repository inventories.", 403);
    }
    const repositoryPolicy = loadOrganizationPolicy(this.database.sqlite, access.organizationId).policy.repositories;
    if (!repositoryPolicy.enabled) {
      throw new DomainError("FORBIDDEN", "Repository inventory is disabled by organization policy.", 403);
    }
    assertPayloadLimit(input, repositoryPolicy.maximumInventoryBytes, "Repository inventory");
    const inventory = parseInput(UploadRepositoryInventorySchema, input, "Repository inventory");
    const excludedPatterns = inventory.excludedPatterns;
    if (excludedPatterns === undefined
      || excludedPatterns.length !== repositoryPolicy.excludedPatterns.length
      || excludedPatterns.some((pattern, index) => pattern !== repositoryPolicy.excludedPatterns[index])) {
      throw new DomainError("FORBIDDEN", "Repository inventory was not generated with the current organization exclusion policy.", 403);
    }
    const inventoryJson = canonicalJson(inventory);
    if (Buffer.byteLength(inventoryJson, "utf8") > repositoryPolicy.maximumInventoryBytes) {
      throw new DomainError("PAYLOAD_TOO_LARGE", "Repository inventory exceeds the organization-policy byte limit.", 413);
    }
    if (inventory.entities.length > repositoryPolicy.maximumInventoryEntities) {
      throw new DomainError("PAYLOAD_TOO_LARGE", "Repository inventory exceeds the organization-policy entity limit.", 413, {
        details: { maximumInventoryEntities: repositoryPolicy.maximumInventoryEntities },
      });
    }
    const disallowedPlatforms = inventory.platforms.filter((platform) => !repositoryPolicy.allowedPlatforms.includes(platform));
    if (disallowedPlatforms.length > 0) {
      throw new DomainError("FORBIDDEN", "Repository inventory contains platforms disallowed by organization policy.", 403, {
        details: { disallowedPlatforms },
      });
    }
    const inventoryHash = hashPayload(inventory);
    const transaction = this.database.sqlite.transaction(() => {
      const existing = this.database.sqlite.prepare(
        `SELECT * FROM repository_inventories
         WHERE organization_id = ? AND repository_fingerprint = ? AND inventory_hash = ?`,
      ).get(access.organizationId, inventory.repositoryFingerprint, inventoryHash) as RepositoryInventoryRow | undefined;
      if (existing) {
        if (existing.status !== "active") {
          throw new DomainError("VERSION_CONFLICT", `The identical repository inventory is already ${existing.status} and cannot be reactivated.`, 409, {
            details: { inventoryId: existing.id, status: existing.status },
          });
        }
        return this.inventoryResult(existing, true);
      }
      const now = this.nowIso();
      this.database.sqlite.prepare(
        `UPDATE repository_inventories SET status = 'superseded'
         WHERE organization_id = ? AND repository_fingerprint = ? AND status = 'active'`,
      ).run(access.organizationId, inventory.repositoryFingerprint);
      const id = workflowId("inventory");
      this.database.sqlite.prepare(
        `INSERT INTO repository_inventories
         (id, organization_id, repository_fingerprint, inventory_hash, inventory_json,
          status, created_by, created_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, NULL)`,
      ).run(id, access.organizationId, inventory.repositoryFingerprint, inventoryHash, inventoryJson, access.principalId, now);
      appendAuditEvent(this.database.sqlite, access, "repository_inventory.persist", "repository_inventory", id, {
        repositoryFingerprint: inventory.repositoryFingerprint,
        inventoryHash,
        entityCount: inventory.entities.length,
        excludedPatternCount: excludedPatterns.length,
        truncated: inventory.truncated,
      });
      return this.inventoryResult(this.requireInventoryRow(access, id), false);
    });
    return transaction.immediate();
  }

  readRepositoryInventory(actorId: string, inventoryId: string): RepositoryInventoryResult {
    const access = resolveAccess(this.database.sqlite, actorId);
    roleAllowed(access, ["organization_admin", "product_manager", "design_editor", "engineer"], "workspace:inventory:read");
    if (access.projectIds.length > 0) {
      throw new DomainError("FORBIDDEN", "Project-restricted grants cannot read organization-wide repository inventories.", 403);
    }
    return this.inventoryResult(this.requireInventoryRow(access, inventoryId), false);
  }

  listRepositoryInventories(actorId: string, input: { repositoryFingerprint?: string; limit?: number } = {}): RepositoryInventoryResult[] {
    const access = resolveAccess(this.database.sqlite, actorId);
    roleAllowed(access, ["organization_admin", "product_manager", "design_editor", "engineer"], "workspace:inventory:read");
    if (access.projectIds.length > 0) {
      throw new DomainError("FORBIDDEN", "Project-restricted grants cannot list organization-wide repository inventories.", 403);
    }
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new DomainError("VALIDATION_FAILED", "Inventory list limit must be an integer from 1 to 100.", 422);
    }
    if (input.repositoryFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(input.repositoryFingerprint)) {
      throw new DomainError("VALIDATION_FAILED", "Repository fingerprint is invalid.", 422);
    }
    const rows = input.repositoryFingerprint === undefined
      ? this.database.sqlite.prepare(
        `SELECT * FROM repository_inventories WHERE organization_id = ?
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      ).all(access.organizationId, limit) as RepositoryInventoryRow[]
      : this.database.sqlite.prepare(
        `SELECT * FROM repository_inventories WHERE organization_id = ? AND repository_fingerprint = ?
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      ).all(access.organizationId, input.repositoryFingerprint, limit) as RepositoryInventoryRow[];
    return rows.map((row) => this.inventoryResult(row, false));
  }

  revokeRepositoryInventory(actorId: string, inventoryId: string): RepositoryInventoryResult {
    const access = resolveAccess(this.database.sqlite, actorId);
    roleAllowed(access, ["organization_admin", "engineer"], "workspace:inventory:write");
    if (access.projectIds.length > 0) {
      throw new DomainError("FORBIDDEN", "Project-restricted grants cannot revoke organization-wide repository inventories.", 403);
    }
    const transaction = this.database.sqlite.transaction(() => {
      const row = this.requireInventoryRow(access, inventoryId);
      if (row.status === "revoked") return this.inventoryResult(row, false);
      const now = this.nowIso();
      const changed = this.database.sqlite.prepare(
        `UPDATE repository_inventories SET status = 'revoked', revoked_at = ?
         WHERE id = ? AND organization_id = ? AND status = ?`,
      ).run(now, row.id, access.organizationId, row.status);
      if (changed.changes !== 1) throw new DomainError("VERSION_CONFLICT", "Repository inventory state changed concurrently.", 409);
      appendAuditEvent(this.database.sqlite, access, "repository_inventory.revoke", "repository_inventory", row.id, {
        previousStatus: row.status,
      });
      return this.inventoryResult(this.requireInventoryRow(access, row.id), false);
    });
    return transaction.immediate();
  }

  createHandoff(actorId: string, input: CreateHandoffRequest): HandoffResult {
    const access = resolveAccess(this.database.sqlite, actorId);
    roleAllowed(access, ["organization_admin", "product_manager", "design_editor", "engineer"]);
    const request = parseInput(CreateHandoffRequestSchema, input, "Create handoff request");
    assertPayloadLimit(request.specification, HANDOFF_SPECIFICATION_MAX_BYTES, "Handoff specification");
    const specification = parseInput(HandoffSpecificationSchema, request.specification, "Handoff specification");
    const specificationJson = canonicalJson(specification);
    if (Buffer.byteLength(specificationJson, "utf8") > HANDOFF_SPECIFICATION_MAX_BYTES) {
      throw new DomainError("PAYLOAD_TOO_LARGE", "Handoff specification exceeds the canonical byte limit.", 413);
    }
    const transaction = this.database.sqlite.transaction(() => {
      const design = this.requireDesign(access, request.designId);
      if (design.current_version !== request.expectedDesignVersion) {
        throw versionConflict(request.expectedDesignVersion, design.current_version, "design");
      }
      if (design.current_revision_id !== request.revisionId) {
        throw new DomainError("VERSION_CONFLICT", "The requested design revision is no longer the project head.", 409, {
          details: { expectedRevisionId: request.revisionId, currentRevisionId: design.current_revision_id },
        });
      }
      const inventory = this.requireActiveInventory(access, request.inventoryId);
      this.assertSpecificationInventoryReferences(specification, inventory);
      const now = this.nowIso();
      const id = workflowId("handoff");
      this.database.sqlite.prepare(
        `INSERT INTO handoffs
         (id, organization_id, design_id, revision_id, inventory_id, status,
          current_version, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'draft', 1, ?, ?, ?)`,
      ).run(id, access.organizationId, design.id, request.revisionId, inventory.id, access.principalId, now, now);
      this.database.sqlite.prepare(
        `INSERT INTO handoff_versions
         (handoff_id, version, specification_json, actor_id, created_at)
         VALUES (?, 1, ?, ?, ?)`,
      ).run(id, specificationJson, access.principalId, now);
      this.appendTransition(access, id, null, "draft", { decision: "created", version: 1 }, now);
      appendAuditEvent(this.database.sqlite, access, "handoff.create", "handoff", id, {
        designId: design.id,
        revisionId: request.revisionId,
        designVersion: design.current_version,
        inventoryId: inventory.id,
        handoffVersion: 1,
      });
      return this.handoffResult(this.requireHandoffRow(access, id));
    });
    return transaction.immediate();
  }

  updateHandoff(actorId: string, handoffId: string, input: UpdateHandoffRequest): HandoffResult {
    const access = resolveAccess(this.database.sqlite, actorId);
    roleAllowed(access, ["organization_admin", "product_manager", "design_editor", "engineer"]);
    const request = parseInput(UpdateHandoffRequestSchema, input, "Update handoff request");
    assertPayloadLimit(request.specification, HANDOFF_SPECIFICATION_MAX_BYTES, "Handoff specification");
    const specification = parseInput(HandoffSpecificationSchema, request.specification, "Handoff specification");
    const specificationJson = canonicalJson(specification);
    if (Buffer.byteLength(specificationJson, "utf8") > HANDOFF_SPECIFICATION_MAX_BYTES) {
      throw new DomainError("PAYLOAD_TOO_LARGE", "Handoff specification exceeds the canonical byte limit.", 413);
    }
    const transaction = this.database.sqlite.transaction(() => {
      const row = this.requireHandoffRow(access, handoffId);
      this.assertTransitionHistory(row);
      if (row.status !== "draft" && row.status !== "in_review") {
        throw new DomainError("VERSION_CONFLICT", "Approved, implementing, completed, or cancelled handoffs are immutable. Return an in-review handoff to draft before editing.", 409);
      }
      if (row.current_version !== request.expectedVersion) throw versionConflict(request.expectedVersion, row.current_version, "handoff");
      this.assertPinnedDesignCurrent(access, row);
      const inventory = this.requireActiveInventory(access, row.inventory_id!);
      this.assertSpecificationInventoryReferences(specification, inventory);
      const nextVersion = row.current_version + 1;
      const now = this.nowIso();
      this.database.sqlite.prepare(
        `INSERT INTO handoff_versions
         (handoff_id, version, specification_json, actor_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(row.id, nextVersion, specificationJson, access.principalId, now);
      const changed = this.database.sqlite.prepare(
        `UPDATE handoffs SET current_version = ?, updated_at = ?
         WHERE id = ? AND organization_id = ? AND current_version = ? AND status = ?`,
      ).run(nextVersion, now, row.id, access.organizationId, request.expectedVersion, row.status);
      if (changed.changes !== 1) throw versionConflict(request.expectedVersion, row.current_version, "handoff");
      appendAuditEvent(this.database.sqlite, access, "handoff.version.create", "handoff", row.id, {
        previousVersion: row.current_version,
        version: nextVersion,
        status: row.status,
      });
      return this.handoffResult(this.requireHandoffRow(access, row.id));
    });
    return transaction.immediate();
  }

  submitHandoffForReview(actorId: string, handoffId: string, input: { expectedVersion: number; summary: string }): HandoffResult {
    const access = resolveAccess(this.database.sqlite, actorId);
    roleAllowed(access, ["organization_admin", "product_manager", "design_editor", "engineer"]);
    const request = parseInput(submitHandoffRequestSchema, input, "Submit handoff request");
    const summary = this.boundedText(request.summary, "Review summary", 2_000);
    return this.transitionHandoff(access, handoffId, {
      expectedVersion: request.expectedVersion,
      expectedStatus: "draft",
      toStatus: "in_review",
      requireCurrentInputs: true,
      details: { decision: "submitted", summary, submittedVersion: request.expectedVersion },
      auditAction: "handoff.submit_review",
    });
  }

  returnHandoffToDraft(actorId: string, handoffId: string, input: { expectedVersion: number; reason: string }): HandoffResult {
    const access = resolveAccess(this.database.sqlite, actorId);
    roleAllowed(access, ["organization_admin", "product_manager", "design_editor", "engineer"]);
    const request = parseInput(returnHandoffRequestSchema, input, "Return handoff request");
    const reason = this.boundedText(request.reason, "Return reason", 2_000);
    return this.transitionHandoff(access, handoffId, {
      expectedVersion: request.expectedVersion,
      expectedStatus: "in_review",
      toStatus: "draft",
      requireCurrentInputs: false,
      details: { decision: "changes_requested", reason, reviewedVersion: request.expectedVersion },
      auditAction: "handoff.return_draft",
    });
  }

  approveHandoff(actorId: string, handoffId: string, input: {
    expectedVersion: number;
    decision: "approved";
    summary: string;
    acceptanceCriteriaConfirmed: true;
    implementationPlanConfirmed: true;
  }): HandoffResult {
    const access = resolveAccess(this.database.sqlite, actorId);
    roleAllowed(access, ["organization_admin", "product_manager"]);
    const request = parseInput(approveHandoffRequestSchema, input, "Approve handoff request");
    const summary = this.boundedText(request.summary, "Approval summary", 2_000);
    return this.transitionHandoff(access, handoffId, {
      expectedVersion: request.expectedVersion,
      expectedStatus: "in_review",
      toStatus: "approved",
      requireCurrentInputs: true,
      details: {
        decision: "approved",
        summary,
        approvedVersion: request.expectedVersion,
        acceptanceCriteriaConfirmed: true,
        implementationPlanConfirmed: true,
      },
      auditAction: "handoff.approve",
    });
  }

  startHandoffImplementation(actorId: string, handoffId: string, input: {
    expectedVersion: number;
    approvedVersion: number;
    authorization: "start_implementation";
  }): HandoffResult {
    const access = resolveAccess(this.database.sqlite, actorId);
    roleAllowed(access, ["organization_admin", "engineer"]);
    const request = parseInput(startImplementationRequestSchema, input, "Start implementation request");
    if (request.approvedVersion !== request.expectedVersion) {
      throw new DomainError("VALIDATION_FAILED", "Implementation start requires the exact approved handoff version and explicit authorization.", 422);
    }
    return this.transitionHandoff(access, handoffId, {
      expectedVersion: request.expectedVersion,
      expectedStatus: "approved",
      toStatus: "implementing",
      requireCurrentInputs: true,
      approvedVersionRequired: request.approvedVersion,
      details: {
        decision: "implementation_authorized",
        approvedVersion: request.approvedVersion,
        authorization: "start_implementation",
      },
      auditAction: "handoff.start_implementation",
    });
  }

  completeHandoffImplementation(actorId: string, handoffId: string, input: {
    expectedVersion: number;
    summary: string;
    diffReviewed: true;
    validationApproved: true;
    commitApproved: true;
    pullRequestRequested: boolean;
  }): HandoffResult {
    const access = resolveAccess(this.database.sqlite, actorId);
    roleAllowed(access, ["organization_admin", "engineer"]);
    const request = parseInput(completeImplementationRequestSchema, input, "Complete implementation request");
    const summary = this.boundedText(request.summary, "Implementation summary", 4_000);
    return this.transitionHandoff(access, handoffId, {
      expectedVersion: request.expectedVersion,
      expectedStatus: "implementing",
      toStatus: "completed",
      requireCurrentInputs: false,
      details: {
        decision: "completed",
        summary,
        completedVersion: request.expectedVersion,
        diffReviewed: true,
        validationApproved: true,
        commitApproved: true,
        pullRequestRequested: request.pullRequestRequested,
      },
      auditAction: "handoff.complete",
    });
  }

  cancelHandoff(actorId: string, handoffId: string, input: { expectedVersion: number; reason: string }): HandoffResult {
    const access = resolveAccess(this.database.sqlite, actorId);
    roleAllowed(access, ["organization_admin", "product_manager", "engineer"]);
    const request = parseInput(cancelHandoffRequestSchema, input, "Cancel handoff request");
    const reason = this.boundedText(request.reason, "Cancellation reason", 2_000);
    const row = this.requireHandoffRow(access, handoffId);
    this.assertTransitionHistory(row);
    if (row.status === "completed" || row.status === "cancelled") {
      throw new DomainError("VERSION_CONFLICT", `A ${row.status} handoff cannot be cancelled.`, 409);
    }
    return this.transitionHandoff(access, handoffId, {
      expectedVersion: request.expectedVersion,
      expectedStatus: row.status,
      toStatus: "cancelled",
      requireCurrentInputs: false,
      details: { decision: "cancelled", reason, cancelledVersion: request.expectedVersion },
      auditAction: "handoff.cancel",
    });
  }

  readHandoff(actorId: string, handoffId: string): HandoffResult {
    const access = resolveAccess(this.database.sqlite, actorId);
    roleAllowed(access, ["organization_admin", "product_manager", "design_editor", "engineer", "viewer"], "handoff:read");
    const row = this.requireHandoffRow(access, handoffId);
    this.assertTransitionHistory(row);
    return this.handoffResult(row);
  }

  listHandoffs(actorId: string, input: { designId?: string; limit?: number } = {}): HandoffResult[] {
    const access = resolveAccess(this.database.sqlite, actorId);
    roleAllowed(access, ["organization_admin", "product_manager", "design_editor", "engineer", "viewer"], "handoff:read");
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new DomainError("VALIDATION_FAILED", "Handoff list limit must be an integer from 1 to 100.", 422);
    }
    if (input.designId !== undefined) this.requireDesign(access, input.designId);
    const rows = input.designId === undefined
      ? this.database.sqlite.prepare(
        `SELECT * FROM handoffs WHERE organization_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?`,
      ).all(access.organizationId, limit) as HandoffRow[]
      : this.database.sqlite.prepare(
        `SELECT * FROM handoffs WHERE organization_id = ? AND design_id = ?
         ORDER BY updated_at DESC, id DESC LIMIT ?`,
      ).all(access.organizationId, input.designId, limit) as HandoffRow[];
    return rows
      .filter((row) => access.projectIds.length === 0 || access.projectIds.includes(row.design_id))
      .map((row) => {
        this.assertTransitionHistory(row);
        return this.handoffResult(row);
      });
  }

  private transitionHandoff(access: AccessContext, handoffId: string, input: {
    expectedVersion: number;
    expectedStatus: HandoffStatus;
    toStatus: HandoffStatus;
    requireCurrentInputs: boolean;
    approvedVersionRequired?: number;
    details: Record<string, unknown>;
    auditAction: string;
  }): HandoffResult {
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new DomainError("VALIDATION_FAILED", "Expected handoff version must be a positive integer.", 422);
    }
    const transaction = this.database.sqlite.transaction(() => {
      const row = this.requireHandoffRow(access, handoffId);
      this.assertTransitionHistory(row);
      if (row.current_version !== input.expectedVersion) throw versionConflict(input.expectedVersion, row.current_version, "handoff");
      if (row.status !== input.expectedStatus) throw stateConflict(input.expectedStatus, row.status);
      if (input.approvedVersionRequired !== undefined) this.assertApprovedVersion(row, input.approvedVersionRequired);
      if (!handoffTransitionGraph[row.status].includes(input.toStatus)) {
        throw new DomainError("VALIDATION_FAILED", `Cannot move a handoff from ${row.status} to ${input.toStatus}.`, 422);
      }
      if (input.requireCurrentInputs) {
        this.assertPinnedDesignCurrent(access, row);
        this.requireActiveInventory(access, row.inventory_id!);
      }
      const now = this.nowIso();
      const changed = this.database.sqlite.prepare(
        `UPDATE handoffs SET status = ?, updated_at = ?
         WHERE id = ? AND organization_id = ? AND current_version = ? AND status = ?`,
      ).run(input.toStatus, now, row.id, access.organizationId, input.expectedVersion, input.expectedStatus);
      if (changed.changes !== 1) throw new DomainError("VERSION_CONFLICT", "Handoff state changed concurrently.", 409);
      this.appendTransition(access, row.id, row.status, input.toStatus, input.details, now);
      appendAuditEvent(this.database.sqlite, access, input.auditAction, "handoff", row.id, {
        fromStatus: row.status,
        toStatus: input.toStatus,
        handoffVersion: row.current_version,
      });
      return this.handoffResult(this.requireHandoffRow(access, row.id));
    });
    return transaction.immediate();
  }

  private requireDesign(access: AccessContext, designId: string): DesignRow {
    const row = this.database.sqlite.prepare(
      `SELECT id, organization_id, current_version, current_revision_id FROM designs WHERE id = ?`,
    ).get(designId) as DesignRow | undefined;
    if (!row || !row.organization_id) throw new DomainError("NOT_FOUND", "Design not found.", 404);
    assertProjectAccess(access, row.organization_id, row.id);
    return row;
  }

  private requireInventoryRow(access: AccessContext, inventoryId: string): RepositoryInventoryRow {
    if (!/^inventory_[a-f0-9]{32}$/.test(inventoryId)) throw new DomainError("NOT_FOUND", "Repository inventory not found.", 404);
    const row = this.database.sqlite.prepare(
      `SELECT * FROM repository_inventories WHERE id = ? AND organization_id = ?`,
    ).get(inventoryId, access.organizationId) as RepositoryInventoryRow | undefined;
    if (!row) throw new DomainError("NOT_FOUND", "Repository inventory not found.", 404);
    return row;
  }

  private requireActiveInventory(access: AccessContext, inventoryId: string): RepositoryInventoryRow {
    const row = this.requireInventoryRow(access, inventoryId);
    if (row.status !== "active") {
      throw new DomainError("VERSION_CONFLICT", `Repository inventory ${row.id} is ${row.status}; a new active inventory is required.`, 409, {
        details: { inventoryId: row.id, status: row.status },
      });
    }
    const inventory = parsePersisted(UploadRepositoryInventorySchema, row.inventory_json, "repository inventory");
    const requiredPatterns = loadOrganizationPolicy(this.database.sqlite, access.organizationId).policy.repositories.excludedPatterns;
    if (inventory.excludedPatterns === undefined
      || inventory.excludedPatterns.length !== requiredPatterns.length
      || inventory.excludedPatterns.some((pattern, index) => pattern !== requiredPatterns[index])) {
      throw new DomainError("VERSION_CONFLICT", "The organization repository exclusion policy changed after this inventory was created. Create a new explicit grant and rescan the repository.", 409, {
        details: { inventoryId: row.id, reason: "repository_exclusion_policy_changed" },
      });
    }
    return row;
  }

  private requireHandoffRow(access: AccessContext, handoffId: string): HandoffRow {
    if (!/^handoff_[a-f0-9]{32}$/.test(handoffId)) throw new DomainError("NOT_FOUND", "Handoff not found.", 404);
    const row = this.database.sqlite.prepare(
      `SELECT * FROM handoffs WHERE id = ? AND organization_id = ?`,
    ).get(handoffId, access.organizationId) as HandoffRow | undefined;
    if (!row) throw new DomainError("NOT_FOUND", "Handoff not found.", 404);
    assertProjectAccess(access, row.organization_id, row.design_id);
    if (row.inventory_id === null) throw new DomainError("INTERNAL_ERROR", "Persisted engineering handoff is missing its repository inventory.", 500);
    return row;
  }

  private assertPinnedDesignCurrent(access: AccessContext, row: HandoffRow): void {
    const design = this.requireDesign(access, row.design_id);
    const revision = this.database.sqlite.prepare(
      `SELECT version FROM revisions WHERE id = ? AND design_id = ?`,
    ).get(row.revision_id, row.design_id) as { version: number } | undefined;
    if (!revision) throw new DomainError("INTERNAL_ERROR", "Persisted handoff revision is unavailable.", 500);
    if (design.current_revision_id !== row.revision_id || design.current_version !== revision.version) {
      throw new DomainError("VERSION_CONFLICT", "The design changed after this handoff was pinned. Create or update a handoff from the current revision.", 409, {
        details: {
          pinnedRevisionId: row.revision_id,
          pinnedDesignVersion: revision.version,
          currentRevisionId: design.current_revision_id,
          currentDesignVersion: design.current_version,
        },
      });
    }
  }

  private assertSpecificationInventoryReferences(specification: HandoffSpecification, inventoryRow: RepositoryInventoryRow): void {
    const inventory = parsePersisted(UploadRepositoryInventorySchema, inventoryRow.inventory_json, "repository inventory");
    const entityIds = new Set(inventory.entities.map((entity) => entity.id));
    const missing = new Set<string>();
    for (const slice of specification.implementationSlices) {
      for (const entityId of slice.inventoryEntityIds) if (!entityIds.has(entityId)) missing.add(entityId);
    }
    if (missing.size > 0) {
      throw new DomainError("VALIDATION_FAILED", "Handoff specification references entities outside the selected repository inventory.", 422, {
        details: { missingInventoryEntityIds: [...missing].slice(0, 100) },
      });
    }
  }

  private assertApprovedVersion(row: HandoffRow, expectedVersion: number): void {
    this.assertTransitionHistory(row);
    if (row.status !== "approved") throw stateConflict("approved", row.status);
    const approval = this.database.sqlite.prepare(
      `SELECT details_json FROM handoff_transitions
       WHERE handoff_id = ? AND to_status = 'approved' ORDER BY rowid DESC LIMIT 1`,
    ).get(row.id) as { details_json: string } | undefined;
    const details = approval ? parseDetails(approval.details_json) : null;
    if (!details || details.approvedVersion !== expectedVersion || row.current_version !== expectedVersion) {
      throw new DomainError("VERSION_CONFLICT", "Implementation authorization does not match the approved immutable handoff version.", 409, {
        details: { approvedVersion: details?.approvedVersion ?? null, expectedVersion, currentVersion: row.current_version },
      });
    }
  }

  private assertTransitionHistory(row: HandoffRow): void {
    const transitions = this.database.sqlite.prepare(
      `SELECT * FROM handoff_transitions WHERE handoff_id = ? ORDER BY rowid`,
    ).all(row.id) as HandoffTransitionRow[];
    if (transitions.length === 0 || transitions[0]!.from_status !== null || transitions[0]!.to_status !== "draft") {
      throw new DomainError("INTERNAL_ERROR", "Persisted handoff transition history is incomplete.", 500);
    }
    let current: HandoffStatus = "draft";
    for (const transition of transitions.slice(1)) {
      if (transition.from_status !== current || !handoffTransitionGraph[current].includes(transition.to_status)) {
        throw new DomainError("INTERNAL_ERROR", "Persisted handoff transition history is invalid.", 500);
      }
      current = transition.to_status;
    }
    if (current !== row.status) throw new DomainError("INTERNAL_ERROR", "Persisted handoff state does not match its immutable transition history.", 500);
  }

  private appendTransition(
    access: AccessContext,
    handoffId: string,
    fromStatus: HandoffStatus | null,
    toStatus: HandoffStatus,
    details: Record<string, unknown>,
    now: string,
  ): void {
    const detailsJson = canonicalJson(details);
    if (Buffer.byteLength(detailsJson, "utf8") > 65_536) throw new DomainError("PAYLOAD_TOO_LARGE", "Handoff transition details exceed 64 KiB.", 413);
    this.database.sqlite.prepare(
      `INSERT INTO handoff_transitions
       (id, handoff_id, from_status, to_status, actor_id, details_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(workflowId("handoff_transition"), handoffId, fromStatus, toStatus, access.principalId, detailsJson, now);
  }

  private inventoryResult(row: RepositoryInventoryRow, deduplicated: boolean): RepositoryInventoryResult {
    const inventory = parsePersisted(UploadRepositoryInventorySchema, row.inventory_json, "repository inventory");
    if (inventory.repositoryFingerprint !== row.repository_fingerprint || hashPayload(inventory) !== row.inventory_hash) {
      throw new DomainError("INTERNAL_ERROR", "Persisted repository inventory integrity metadata does not match its immutable content.", 500);
    }
    return {
      id: row.id,
      repositoryFingerprint: row.repository_fingerprint,
      inventoryHash: row.inventory_hash,
      inventory,
      status: row.status,
      createdBy: row.created_by,
      createdAt: row.created_at,
      revokedAt: row.revoked_at,
      deduplicated,
    };
  }

  private handoffResult(row: HandoffRow): HandoffResult {
    const revision = this.database.sqlite.prepare(
      `SELECT version FROM revisions WHERE id = ? AND design_id = ?`,
    ).get(row.revision_id, row.design_id) as { version: number } | undefined;
    if (!revision) throw new DomainError("INTERNAL_ERROR", "Persisted handoff revision is unavailable.", 500);
    const versionRows = this.database.sqlite.prepare(
      `SELECT * FROM handoff_versions WHERE handoff_id = ? ORDER BY version`,
    ).all(row.id) as HandoffVersionRow[];
    if (versionRows.length !== row.current_version || versionRows.some((version, index) => version.version !== index + 1)) {
      throw new DomainError("INTERNAL_ERROR", "Persisted handoff version history is incomplete.", 500);
    }
    const versions = versionRows.map((version): HandoffVersionResult => ({
      version: version.version,
      specification: parsePersisted(HandoffSpecificationSchema, version.specification_json, "handoff specification"),
      actorId: version.actor_id,
      createdAt: version.created_at,
    }));
    const transitionRows = this.database.sqlite.prepare(
      `SELECT * FROM handoff_transitions WHERE handoff_id = ? ORDER BY rowid`,
    ).all(row.id) as HandoffTransitionRow[];
    const transitions = transitionRows.map((transition): HandoffTransitionResult => ({
      id: transition.id,
      fromStatus: transition.from_status,
      toStatus: transition.to_status,
      actorId: transition.actor_id,
      details: parseDetails(transition.details_json),
      createdAt: transition.created_at,
    }));
    return {
      id: row.id,
      designId: row.design_id,
      revisionId: row.revision_id,
      designVersion: revision.version,
      inventoryId: row.inventory_id!,
      status: row.status,
      currentVersion: row.current_version,
      specification: versions.at(-1)!.specification,
      versions,
      transitions,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private boundedText(value: string, label: string, maximum: number): string {
    if (typeof value !== "string") throw new DomainError("VALIDATION_FAILED", `${label} must be text.`, 422);
    const normalized = value.trim();
    if (normalized.length === 0 || normalized.length > maximum) {
      throw new DomainError("VALIDATION_FAILED", `${label} must be between 1 and ${maximum} characters.`, 422);
    }
    return normalized;
  }

  private nowIso(): string {
    const now = this.#now();
    if (!Number.isFinite(now.getTime())) throw new DomainError("INTERNAL_ERROR", "Workspace handoff clock returned an invalid time.", 500);
    return now.toISOString();
  }
}
