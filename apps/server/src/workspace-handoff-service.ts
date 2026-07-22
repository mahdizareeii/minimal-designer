import { randomUUID } from "node:crypto";

import {
  DesignDocumentV2Schema,
  type DesignDocumentV2,
  type ProductSpecification,
} from "@designer/core";
import { z } from "zod";

import {
  appendAuditEvent,
  assertScope,
  resolveAccess,
  type AccessContext,
  type OrganizationRole,
} from "./authorization.js";
import { activeDesignSqlPredicate, requireActiveDesign } from "./active-design.js";
import type { DesignerDatabase } from "./db/database.js";
import { DomainError } from "./errors.js";
import { canonicalJson, hashPayload } from "./ids.js";
import { loadOrganizationPolicy } from "./organization-policy-model.js";
import { canonicalProductSpecification } from "./product-spec-persistence.js";
import { readSnapshotJson, revisionHash } from "./persistence.js";

export const WORKSPACE_INVENTORY_MAX_BYTES = 1_048_576;
export const WORKSPACE_INVENTORY_MAX_ENTITIES = 10_000;
export const HANDOFF_SPECIFICATION_MAX_BYTES = 524_288;
export const IMPLEMENTATION_MAPPING_MAX_BATCH_BYTES = 262_144;
export const IMPLEMENTATION_MAPPING_MAX_BATCH_ITEMS = 100;
export const HANDOFF_EXECUTION_DECISION_MAX_BYTES = 32_768;

export const REPOSITORY_INVENTORY_STATUSES = ["active", "superseded", "revoked"] as const;
export type RepositoryInventoryStatus = (typeof REPOSITORY_INVENTORY_STATUSES)[number];

export const HANDOFF_STATUSES = ["draft", "in_review", "approved", "implementing", "completed", "cancelled"] as const;
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number];

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

export const HANDOFF_EXECUTION_DECISION_OUTCOMES = [
  "approved",
  "branch",
  "worktree",
  "authorized",
  "requested",
  "not_requested",
  "denied",
  "revoked",
] as const;
export type HandoffExecutionDecisionOutcome = (typeof HANDOFF_EXECUTION_DECISION_OUTCOMES)[number];

export const HANDOFF_EXECUTION_DECISION_SCOPES: Readonly<Record<HandoffExecutionDecisionKind, string>> = {
  plan_approval: "handoff:execution:plan",
  isolation_choice: "handoff:execution:isolation",
  diff_review: "handoff:execution:diff_review",
  validation_approval: "handoff:execution:validation",
  commit_approval: "handoff:execution:commit",
  push_authorization: "handoff:execution:push",
  pull_request_request: "handoff:execution:pull_request",
};

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
const inventoryIdSchema = z.string().regex(/^inventory_[a-f0-9]{32}$/);
const implementationMappingIdSchema = z.string().regex(/^mapping_[a-f0-9]{32}$/);
const idempotencyKeySchema = z.string().trim().min(8).max(240);

export const ImplementationMappingEntityKindSchema = z.enum([
  "component",
  "token",
  "screen",
  "asset",
  "flow",
  "business_rule",
]);

export const ImplementationMappingRequestItemSchema = z.object({
  entityKind: ImplementationMappingEntityKindSchema,
  entityId: stableReferenceSchema,
  inventoryEntityId: inventoryEntityIdSchema,
}).strict();

export const CreateImplementationMappingsRequestSchema = z.object({
  designId: opaqueDatabaseIdSchema,
  revisionId: opaqueDatabaseIdSchema,
  expectedDesignVersion: positiveVersionSchema,
  inventoryId: inventoryIdSchema,
  idempotencyKey: idempotencyKeySchema,
  mappings: z.array(ImplementationMappingRequestItemSchema)
    .min(1)
    .max(IMPLEMENTATION_MAPPING_MAX_BATCH_ITEMS),
}).strict().superRefine((request, context) => {
  const designEntities = new Set<string>();
  const pairs = new Set<string>();
  for (const [index, mapping] of request.mappings.entries()) {
    const designEntity = `${mapping.entityKind}\0${mapping.entityId}`;
    if (designEntities.has(designEntity)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mappings", index],
        message: "A design entity may appear only once in an implementation-mapping batch.",
      });
    }
    designEntities.add(designEntity);
    const pair = `${designEntity}\0${mapping.inventoryEntityId}`;
    if (pairs.has(pair)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mappings", index],
        message: "Implementation-mapping pairs must be unique.",
      });
    }
    pairs.add(pair);
  }
});

export const ListImplementationMappingsRequestSchema = z.object({
  designId: opaqueDatabaseIdSchema,
  revisionId: opaqueDatabaseIdSchema.optional(),
  entityKind: ImplementationMappingEntityKindSchema.optional(),
  entityId: stableReferenceSchema.optional(),
  inventoryId: inventoryIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
}).strict();

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

const handoffExecutionDecisionIdSchema = z.string().regex(/^handoff_decision_[a-f0-9]{32}$/);

const approveHandoffRequestSchema = z.object({
  expectedVersion: positiveVersionSchema,
  expectedPriorDecisionId: handoffExecutionDecisionIdSchema.nullable(),
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
}).strict();

const handoffExecutionDecisionKindSchema = z.enum(HANDOFF_EXECUTION_DECISION_KINDS);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const handoffListCursorCoreSchema = z.object({
  schemaVersion: z.literal(1),
  designId: opaqueDatabaseIdSchema.nullable(),
  accessHash: sha256Schema,
  updatedAt: z.string().datetime({ offset: true }),
  id: z.string().regex(/^handoff_[a-f0-9]{32}$/),
  anchorHash: sha256Schema,
}).strict();
const handoffListCursorPayloadSchema = handoffListCursorCoreSchema.extend({
  checksum: sha256Schema,
}).strict();
export const HandoffListCursorSchema = z.string()
  .min(1)
  .max(1_400)
  .regex(/^handoff_cursor_[A-Za-z0-9_-]+$/);
export const ListHandoffSummariesRequestSchema = z.object({
  designId: opaqueDatabaseIdSchema.optional(),
  limit: z.number().int().min(1).max(100).default(25),
  cursor: HandoffListCursorSchema.optional(),
}).strict();
const executionEvidenceSummarySchema = z.string().trim().min(1).max(2_000);
const safeGitReferenceSchema = z.string().trim().min(1).max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
  .refine((value) => !value.includes("..") && !value.includes("@{") && !value.endsWith("/") && !value.endsWith(".lock"), {
    message: "Git references must be normalized branch or tag names.",
  });

const deniedOrRevokedEvidenceSchema = z.object({
  reason: z.string().trim().min(1).max(2_000),
}).strict();
const planApprovalEvidenceSchema = z.object({
  summary: executionEvidenceSummarySchema,
  acceptanceCriteriaConfirmed: z.literal(true),
  implementationPlanConfirmed: z.literal(true),
}).strict();
const isolationChoiceEvidenceSchema = z.object({
  summary: z.string().trim().min(1).max(1_000),
}).strict();
const diffReviewEvidenceSchema = z.object({
  summary: executionEvidenceSummarySchema,
  diffHash: sha256Schema,
  changedFileCount: z.number().int().nonnegative().max(100_000),
}).strict();
const validationEvidenceSchema = z.object({
  summary: executionEvidenceSummarySchema,
  checks: z.array(z.object({
    name: validationCheckSchema,
    status: z.literal("passed"),
    evidenceHash: sha256Schema.optional(),
  }).strict()).min(1).max(32),
}).strict().superRefine((evidence, context) => {
  const names = new Set<string>();
  for (const [index, check] of evidence.checks.entries()) {
    if (names.has(check.name)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["checks", index, "name"],
        message: "Validation check evidence must be unique.",
      });
    }
    names.add(check.name);
  }
});
const commitApprovalEvidenceSchema = z.object({
  summary: executionEvidenceSummarySchema,
  diffHash: sha256Schema,
  commitMessage: z.string().trim().min(1).max(240),
}).strict();
const pushAuthorizationEvidenceSchema = z.object({
  summary: executionEvidenceSummarySchema,
  commitHash: z.string().regex(/^[a-f0-9]{40,64}$/),
  targetRef: safeGitReferenceSchema,
}).strict();
const pullRequestEvidenceSchema = z.object({
  summary: executionEvidenceSummarySchema,
  title: z.string().trim().min(1).max(240),
  baseRef: safeGitReferenceSchema,
  headRef: safeGitReferenceSchema,
}).strict().refine((evidence) => evidence.baseRef !== evidence.headRef, {
  message: "Pull-request base and head references must differ.",
  path: ["headRef"],
});
const pullRequestNotRequestedEvidenceSchema = z.object({
  reason: z.string().trim().min(1).max(2_000),
}).strict();

export const HandoffExecutionDecisionRequestSchema = z.object({
  expectedVersion: positiveVersionSchema,
  expectedPriorDecisionId: handoffExecutionDecisionIdSchema.nullable(),
  idempotencyKey: idempotencyKeySchema,
  kind: handoffExecutionDecisionKindSchema,
  outcome: z.enum(HANDOFF_EXECUTION_DECISION_OUTCOMES),
  evidence: z.unknown(),
}).strict().superRefine((request, context) => {
  const schema = evidenceSchemaForExecutionDecision(request.kind, request.outcome);
  if (!schema) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["outcome"],
      message: `Outcome ${request.outcome} is invalid for ${request.kind}.`,
    });
    return;
  }
  const evidence = schema.safeParse(request.evidence);
  if (!evidence.success) {
    for (const issue of evidence.error.issues.slice(0, 50)) {
      context.addIssue({ ...issue, path: ["evidence", ...issue.path] });
    }
  }
});

function evidenceSchemaForExecutionDecision(
  kind: HandoffExecutionDecisionKind,
  outcome: string,
): z.ZodTypeAny | null {
  if (outcome === "denied" || outcome === "revoked") return deniedOrRevokedEvidenceSchema;
  switch (kind) {
    case "plan_approval":
      return outcome === "approved" ? planApprovalEvidenceSchema : null;
    case "isolation_choice":
      return outcome === "branch" || outcome === "worktree" ? isolationChoiceEvidenceSchema : null;
    case "diff_review":
      return outcome === "approved" ? diffReviewEvidenceSchema : null;
    case "validation_approval":
      return outcome === "approved" ? validationEvidenceSchema : null;
    case "commit_approval":
      return outcome === "approved" ? commitApprovalEvidenceSchema : null;
    case "push_authorization":
      return outcome === "authorized" ? pushAuthorizationEvidenceSchema : null;
    case "pull_request_request":
      if (outcome === "requested") return pullRequestEvidenceSchema;
      return outcome === "not_requested" ? pullRequestNotRequestedEvidenceSchema : null;
  }
  return null;
}

const cancelHandoffRequestSchema = z.object({
  expectedVersion: positiveVersionSchema,
  reason: z.string(),
}).strict();

export type UploadRepositoryInventory = z.infer<typeof UploadRepositoryInventorySchema>;
export type ImplementationMappingEntityKind = z.infer<typeof ImplementationMappingEntityKindSchema>;
export type ImplementationMappingRequestItem = z.infer<typeof ImplementationMappingRequestItemSchema>;
export type CreateImplementationMappingsRequest = z.infer<typeof CreateImplementationMappingsRequestSchema>;
export type ListImplementationMappingsRequest = z.input<typeof ListImplementationMappingsRequestSchema>;
export type HandoffSpecification = z.infer<typeof HandoffSpecificationSchema>;
export type CreateHandoffRequest = z.infer<typeof CreateHandoffRequestSchema>;
export type UpdateHandoffRequest = z.infer<typeof UpdateHandoffRequestSchema>;
export type HandoffExecutionDecisionRequest = z.infer<typeof HandoffExecutionDecisionRequestSchema>;
export type ListHandoffSummariesRequest = z.input<typeof ListHandoffSummariesRequestSchema>;

export type ImplementationMappingPlatform = "web" | "android" | "ios" | "flutter" | "react_native" | "other";

export interface ImplementationMappingResult {
  id: string;
  designId: string;
  revisionId: string;
  designVersion: number;
  snapshotHash: string;
  revisionHash: string;
  productSpecificationSource: "document" | "revision_link";
  productSpecificationVersion: number;
  productSpecificationHash: string;
  inventoryId: string;
  inventoryHash: string;
  entityKind: ImplementationMappingEntityKind;
  entityId: string;
  platform: ImplementationMappingPlatform;
  symbol: string;
  inventoryEntityId: string;
  inventoryEntityKind: z.infer<typeof inventoryEntityKindSchema>;
  locationId: string;
  line: number | null;
  createdBy: string;
  createdAt: string;
}

export interface ImplementationMappingBatchResult {
  designId: string;
  revisionId: string;
  designVersion: number;
  snapshotHash: string;
  revisionHash: string;
  productSpecificationSource: "document" | "revision_link";
  productSpecificationVersion: number;
  productSpecificationHash: string;
  inventoryId: string;
  inventoryHash: string;
  mappings: ImplementationMappingResult[];
}

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

export interface HandoffExecutionDecisionResult {
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
  HandoffExecutionDecisionResult | null
>;

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
  executionDecisions: HandoffExecutionDecisionResult[];
  executionDecisionState: HandoffExecutionDecisionState;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface HandoffSummaryResult {
  id: string;
  designId: string;
  revisionId: string;
  designVersion: number;
  inventoryId: string;
  status: HandoffStatus;
  currentVersion: number;
  title: string;
  summary: string;
  acceptanceCriterionCount: number;
  implementationSliceCount: number;
  validationChecks: Array<z.infer<typeof validationCheckSchema>>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface HandoffSummaryPage {
  handoffs: HandoffSummaryResult[];
  nextCursor: string | null;
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

interface RevisionPinRow {
  id: string;
  design_id: string;
  version: number;
  parent_revision_id: string | null;
  actor_id: string;
  message: string | null;
  document_json: string;
  snapshot_hash: string | null;
  operation_hash: string | null;
  parent_revision_hash: string | null;
  revision_hash: string | null;
  created_at: string;
}

interface ImplementationMappingRow {
  id: string;
  organization_id: string;
  design_id: string;
  revision_id: string;
  inventory_id: string | null;
  entity_kind: ImplementationMappingEntityKind;
  entity_id: string;
  platform: ImplementationMappingPlatform;
  symbol: string;
  mapping_json: string;
  created_by: string;
  created_at: string;
}

interface ProductSpecificationLinkRow {
  version: number;
  specification_json: string;
  specification_hash: string;
  organization_id: string;
}

interface IdempotencyRow {
  request_hash: string;
  response_json: string;
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

interface HandoffSummaryRow extends HandoffRow {
  design_version: number | null;
  specification_json: string | null;
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

interface HandoffExecutionDecisionRow {
  id: string;
  handoff_id: string;
  handoff_version: number;
  sequence: number;
  kind: HandoffExecutionDecisionKind;
  outcome: HandoffExecutionDecisionOutcome;
  supersedes_decision_id: string | null;
  evidence_json: string;
  evidence_hash: string;
  actor_id: string;
  created_at: string;
}

const implementationMappingPlatformSchema = z.enum(["web", "android", "ios", "flutter", "react_native", "other"]);
const implementationMappingDetailsSchema = z.object({
  schemaVersion: z.literal(1),
  designPin: z.object({
    designId: opaqueDatabaseIdSchema,
    revisionId: opaqueDatabaseIdSchema,
    designVersion: positiveVersionSchema,
    snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
    revisionHash: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  productSpecificationPin: z.object({
    source: z.enum(["document", "revision_link"]),
    version: positiveVersionSchema,
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  inventoryPin: z.object({
    inventoryId: inventoryIdSchema,
    inventoryHash: z.string().regex(/^[a-f0-9]{64}$/),
    repositoryFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    platform: implementationMappingPlatformSchema,
  }).strict(),
  designEntity: z.object({
    kind: ImplementationMappingEntityKindSchema,
    id: stableReferenceSchema,
  }).strict(),
  sourceEntity: z.object({
    id: inventoryEntityIdSchema,
    kind: inventoryEntityKindSchema,
    symbol: z.string().trim().min(1).max(240),
    locationId: inventoryLocationIdSchema,
    line: z.number().int().positive().max(10_000_000).nullable(),
  }).strict(),
}).strict();

const implementationMappingResultSchema = z.object({
  id: implementationMappingIdSchema,
  designId: opaqueDatabaseIdSchema,
  revisionId: opaqueDatabaseIdSchema,
  designVersion: positiveVersionSchema,
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  revisionHash: z.string().regex(/^[a-f0-9]{64}$/),
  productSpecificationSource: z.enum(["document", "revision_link"]),
  productSpecificationVersion: positiveVersionSchema,
  productSpecificationHash: z.string().regex(/^[a-f0-9]{64}$/),
  inventoryId: inventoryIdSchema,
  inventoryHash: z.string().regex(/^[a-f0-9]{64}$/),
  entityKind: ImplementationMappingEntityKindSchema,
  entityId: stableReferenceSchema,
  platform: implementationMappingPlatformSchema,
  symbol: z.string().trim().min(1).max(240),
  inventoryEntityId: inventoryEntityIdSchema,
  inventoryEntityKind: inventoryEntityKindSchema,
  locationId: inventoryLocationIdSchema,
  line: z.number().int().positive().max(10_000_000).nullable(),
  createdBy: z.string().trim().min(1).max(240),
  createdAt: z.string().datetime({ offset: true }),
}).strict();

const implementationMappingBatchResultSchema = z.object({
  designId: opaqueDatabaseIdSchema,
  revisionId: opaqueDatabaseIdSchema,
  designVersion: positiveVersionSchema,
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  revisionHash: z.string().regex(/^[a-f0-9]{64}$/),
  productSpecificationSource: z.enum(["document", "revision_link"]),
  productSpecificationVersion: positiveVersionSchema,
  productSpecificationHash: z.string().regex(/^[a-f0-9]{64}$/),
  inventoryId: inventoryIdSchema,
  inventoryHash: z.string().regex(/^[a-f0-9]{64}$/),
  mappings: z.array(implementationMappingResultSchema).min(1).max(IMPLEMENTATION_MAPPING_MAX_BATCH_ITEMS),
}).strict();

const handoffExecutionDecisionResultSchema = z.object({
  id: handoffExecutionDecisionIdSchema,
  handoffId: z.string().regex(/^handoff_[a-f0-9]{32}$/),
  handoffVersion: positiveVersionSchema,
  sequence: positiveVersionSchema,
  kind: handoffExecutionDecisionKindSchema,
  outcome: z.enum(HANDOFF_EXECUTION_DECISION_OUTCOMES),
  supersedesDecisionId: handoffExecutionDecisionIdSchema.nullable(),
  evidence: z.record(z.unknown()),
  evidenceHash: sha256Schema,
  actorId: z.string().trim().min(1).max(240),
  createdAt: z.string().datetime({ offset: true }),
}).strict().superRefine((decision, context) => {
  const schema = evidenceSchemaForExecutionDecision(decision.kind, decision.outcome);
  if (!schema || !schema.safeParse(decision.evidence).success) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidence"],
      message: "Execution-decision evidence does not match its kind and outcome.",
    });
  }
  if (hashPayload(decision.evidence) !== decision.evidenceHash) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidenceHash"],
      message: "Execution-decision evidence hash does not match its canonical evidence.",
    });
  }
});

interface RevisionValidation {
  row: RevisionPinRow;
  document: DesignDocumentV2;
  productSpecification: ProductSpecification;
  productSpecificationSource: "document" | "revision_link";
  productSpecificationVersion: number;
  productSpecificationHash: string;
}

interface MappingReadCache {
  revisions: Map<string, RevisionValidation>;
  inventories: Map<string, { row: RepositoryInventoryRow; inventory: UploadRepositoryInventory }>;
}

const IMPLEMENTATION_MAPPING_IDEMPOTENCY_TTL_MS = 86_400_000;
const IMPLEMENTATION_MAPPING_REVISION_MAX_BYTES = 16 * 1_024 * 1_024;
const HANDOFF_EXECUTION_DECISION_IDEMPOTENCY_TTL_MS = 86_400_000;
const HANDOFF_LIST_CURSOR_PREFIX = "handoff_cursor_";

const handoffTransitionGraph: Record<HandoffStatus, readonly HandoffStatus[]> = {
  draft: ["in_review", "cancelled"],
  in_review: ["draft", "approved", "cancelled"],
  approved: ["implementing", "cancelled"],
  implementing: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

const handoffExecutionDecisionRoles: Readonly<Record<
  HandoffExecutionDecisionKind,
  readonly OrganizationRole[]
>> = {
  plan_approval: ["organization_admin", "product_manager"],
  isolation_choice: ["organization_admin", "engineer"],
  diff_review: ["organization_admin", "engineer"],
  validation_approval: ["organization_admin", "engineer"],
  commit_approval: ["organization_admin", "product_manager"],
  push_authorization: ["organization_admin", "product_manager"],
  pull_request_request: ["organization_admin", "product_manager"],
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

  authorizeRepositoryInventoryRead(actorId: string): void {
    const access = resolveAccess(this.database.sqlite, actorId);
    roleAllowed(access, ["organization_admin", "product_manager", "design_editor", "engineer"], "workspace:inventory:read");
    if (access.projectIds.length > 0) {
      throw new DomainError("FORBIDDEN", "Project-restricted grants cannot access organization-wide repository inventories.", 403);
    }
  }

  authorizeRepositoryInventoryWrite(actorId: string): void {
    const access = resolveAccess(this.database.sqlite, actorId);
    roleAllowed(access, ["organization_admin", "engineer"], "workspace:inventory:write");
    if (access.projectIds.length > 0) {
      throw new DomainError("FORBIDDEN", "Project-restricted grants cannot modify organization-wide repository inventories.", 403);
    }
  }

  authorizeImplementationMappingList(actorId: string, designId: unknown): void {
    const access = resolveAccess(this.database.sqlite, actorId);
    roleAllowed(
      access,
      ["organization_admin", "product_manager", "design_editor", "engineer", "viewer"],
      "implementation_mapping:read",
    );
    this.requireRawDesign(access, designId);
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

  createImplementationMappings(
    actorId: string,
    input: CreateImplementationMappingsRequest,
  ): ImplementationMappingBatchResult {
    const access = resolveAccess(this.database.sqlite, actorId);
    roleAllowed(access, ["organization_admin", "design_editor", "engineer"], "implementation_mapping:write");
    assertPayloadLimit(input, IMPLEMENTATION_MAPPING_MAX_BATCH_BYTES, "Implementation-mapping batch");
    const request = parseInput(
      CreateImplementationMappingsRequestSchema,
      input,
      "Create implementation mappings request",
    );
    const { idempotencyKey, ...requestBody } = request;
    const transaction = this.database.sqlite.transaction(() => {
      const now = this.nowIso();
      const scope = `implementation_mapping:${request.designId}:${request.revisionId}:create`;
      this.database.sqlite.prepare(
        "DELETE FROM idempotency WHERE actor_id = ? AND scope = ? AND expires_at <= ?",
      ).run(access.principalId, scope, now);
      const requestHash = hashPayload(requestBody);
      this.requireDesign(access, request.designId);
      const existing = this.database.sqlite.prepare(
        `SELECT request_hash, response_json FROM idempotency
         WHERE actor_id = ? AND scope = ? AND key = ? AND expires_at > ?`,
      ).get(access.principalId, scope, idempotencyKey, now) as IdempotencyRow | undefined;
      if (existing) {
        if (existing.request_hash !== requestHash) {
          throw new DomainError(
            "IDEMPOTENCY_CONFLICT",
            "The implementation-mapping idempotency key was already used with different input.",
            409,
          );
        }
        try {
          const parsed = implementationMappingBatchResultSchema.safeParse(JSON.parse(existing.response_json) as unknown);
          if (!parsed.success) throw parsed.error;
          return parsed.data;
        } catch (error) {
          throw new DomainError("INTERNAL_ERROR", "Persisted implementation-mapping idempotency state is invalid.", 500, {
            cause: error,
          });
        }
      }

      const revision = this.requireRevisionValidation(
        access,
        request.designId,
        request.revisionId,
        request.expectedDesignVersion,
      );
      const inventoryRow = this.requireActiveInventory(access, request.inventoryId);
      const inventory = this.verifiedInventory(inventoryRow);
      this.assertSoleActiveInventory(access, inventoryRow);
      const platform = this.inventoryPlatform(inventory);
      const sourceEntities = new Map(inventory.entities.map((entity) => [entity.id, entity]));

      const prepared = request.mappings.map((mapping) => {
        this.assertDesignEntity(
          revision.document,
          revision.productSpecification,
          mapping.entityKind,
          mapping.entityId,
        );
        const sourceEntity = sourceEntities.get(mapping.inventoryEntityId);
        if (!sourceEntity) {
          throw new DomainError(
            "VALIDATION_FAILED",
            "An implementation mapping references an entity outside the selected repository inventory.",
            422,
            { details: { missingInventoryEntityId: mapping.inventoryEntityId } },
          );
        }
        this.assertCompatibleInventoryEntity(mapping.entityKind, sourceEntity.kind, mapping.inventoryEntityId);
        const symbol = sourceEntity.symbol ?? sourceEntity.id;
        return {
          mapping,
          details: implementationMappingDetailsSchema.parse({
            schemaVersion: 1,
            designPin: {
              designId: request.designId,
              revisionId: revision.row.id,
              designVersion: revision.row.version,
              snapshotHash: revision.row.snapshot_hash,
              revisionHash: revision.row.revision_hash,
            },
            productSpecificationPin: {
              source: revision.productSpecificationSource,
              version: revision.productSpecificationVersion,
              hash: revision.productSpecificationHash,
            },
            inventoryPin: {
              inventoryId: inventoryRow.id,
              inventoryHash: inventoryRow.inventory_hash,
              repositoryFingerprint: inventoryRow.repository_fingerprint,
              platform,
            },
            designEntity: { kind: mapping.entityKind, id: mapping.entityId },
            sourceEntity: {
              id: sourceEntity.id,
              kind: sourceEntity.kind,
              symbol,
              locationId: sourceEntity.locationId,
              line: sourceEntity.line,
            },
          }),
        };
      });

      const mappings = prepared.map(({ mapping, details }) => {
        const id = workflowId("mapping");
        const mappingJson = canonicalJson(details);
        this.database.sqlite.prepare(
          `INSERT INTO implementation_mappings
           (id, organization_id, design_id, revision_id, inventory_id, entity_kind,
            entity_id, platform, symbol, mapping_json, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          access.organizationId,
          request.designId,
          revision.row.id,
          inventoryRow.id,
          mapping.entityKind,
          mapping.entityId,
          platform,
          details.sourceEntity.symbol,
          mappingJson,
          access.principalId,
          now,
        );
        return this.mappingResultFromDetails({
          id,
          organization_id: access.organizationId,
          design_id: request.designId,
          revision_id: revision.row.id,
          inventory_id: inventoryRow.id,
          entity_kind: mapping.entityKind,
          entity_id: mapping.entityId,
          platform,
          symbol: details.sourceEntity.symbol,
          mapping_json: mappingJson,
          created_by: access.principalId,
          created_at: now,
        }, details);
      });
      const result: ImplementationMappingBatchResult = {
        designId: request.designId,
        revisionId: revision.row.id,
        designVersion: revision.row.version,
        snapshotHash: revision.row.snapshot_hash!,
        revisionHash: revision.row.revision_hash!,
        productSpecificationSource: revision.productSpecificationSource,
        productSpecificationVersion: revision.productSpecificationVersion,
        productSpecificationHash: revision.productSpecificationHash,
        inventoryId: inventoryRow.id,
        inventoryHash: inventoryRow.inventory_hash,
        mappings,
      };
      appendAuditEvent(
        this.database.sqlite,
        access,
        "implementation_mapping.create_batch",
        "implementation_mapping",
        null,
        {
          designId: request.designId,
          revisionId: revision.row.id,
          designVersion: revision.row.version,
          snapshotHash: revision.row.snapshot_hash,
          inventoryId: inventoryRow.id,
          inventoryHash: inventoryRow.inventory_hash,
          mappingCount: mappings.length,
          mappingIds: mappings.map((mapping) => mapping.id),
          entityKinds: [...new Set(mappings.map((mapping) => mapping.entityKind))].sort(),
        },
      );
      const expiresAt = new Date(Date.parse(now) + IMPLEMENTATION_MAPPING_IDEMPOTENCY_TTL_MS).toISOString();
      this.database.sqlite.prepare(
        `INSERT INTO idempotency
         (actor_id, scope, key, request_hash, response_json, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        access.principalId,
        scope,
        idempotencyKey,
        requestHash,
        canonicalJson(result),
        now,
        expiresAt,
      );
      return result;
    });
    return transaction.immediate();
  }

  readImplementationMapping(actorId: string, mappingId: string): ImplementationMappingResult {
    const access = resolveAccess(this.database.sqlite, actorId);
    roleAllowed(
      access,
      ["organization_admin", "product_manager", "design_editor", "engineer", "viewer"],
      "implementation_mapping:read",
    );
    const row = this.requireImplementationMappingRow(access, mappingId);
    return this.implementationMappingResult(access, row, {
      revisions: new Map(),
      inventories: new Map(),
    });
  }

  listImplementationMappings(
    actorId: string,
    input: ListImplementationMappingsRequest,
  ): ImplementationMappingResult[] {
    const access = resolveAccess(this.database.sqlite, actorId);
    roleAllowed(
      access,
      ["organization_admin", "product_manager", "design_editor", "engineer", "viewer"],
      "implementation_mapping:read",
    );
    const request = parseInput(
      ListImplementationMappingsRequestSchema,
      input,
      "List implementation mappings request",
    );
    this.requireDesign(access, request.designId);
    if (request.revisionId !== undefined) {
      this.requireRevisionRow(access, request.designId, request.revisionId);
    }
    const conditions = ["organization_id = ?", "design_id = ?"];
    const parameters: Array<string | number> = [access.organizationId, request.designId];
    if (request.revisionId !== undefined) {
      conditions.push("revision_id = ?");
      parameters.push(request.revisionId);
    }
    if (request.entityKind !== undefined) {
      conditions.push("entity_kind = ?");
      parameters.push(request.entityKind);
    }
    if (request.entityId !== undefined) {
      conditions.push("entity_id = ?");
      parameters.push(request.entityId);
    }
    if (request.inventoryId !== undefined) {
      conditions.push("inventory_id = ?");
      parameters.push(request.inventoryId);
    }
    parameters.push(request.limit);
    const rows = this.database.sqlite.prepare(
      `SELECT * FROM implementation_mappings
       WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).all(...parameters) as ImplementationMappingRow[];
    const cache: MappingReadCache = { revisions: new Map(), inventories: new Map() };
    return rows.map((row) => this.implementationMappingResult(access, row, cache));
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
      if (row.status !== "draft") {
        throw new DomainError("VERSION_CONFLICT", "Only draft handoffs can be edited. Return an in-review handoff to draft before editing; approved, implementing, completed, and cancelled handoffs are immutable.", 409);
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
    expectedPriorDecisionId: string | null;
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
      appendExecutionDecision: {
        kind: "plan_approval",
        outcome: "approved",
        expectedPriorDecisionId: request.expectedPriorDecisionId,
        evidence: {
          summary,
          acceptanceCriteriaConfirmed: true,
          implementationPlanConfirmed: true,
        },
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
      requireExecutionReadyForStart: true,
      details: {
        decision: "implementation_authorized",
        approvedVersion: request.approvedVersion,
        authorization: "start_implementation",
      },
      auditAction: "handoff.start_implementation",
    });
  }

  recordHandoffExecutionDecision(
    actorId: string,
    handoffId: string,
    input: HandoffExecutionDecisionRequest,
  ): HandoffExecutionDecisionResult {
    assertPayloadLimit(input, HANDOFF_EXECUTION_DECISION_MAX_BYTES, "Handoff execution decision");
    const request = parseInput(
      HandoffExecutionDecisionRequestSchema,
      input,
      "Handoff execution decision request",
    );
    const evidenceSchema = evidenceSchemaForExecutionDecision(request.kind, request.outcome);
    if (!evidenceSchema) {
      throw new DomainError("VALIDATION_FAILED", "Handoff execution decision outcome is invalid.", 422);
    }
    const evidence = parseInput(
      evidenceSchema,
      request.evidence,
      "Handoff execution decision evidence",
    ) as Record<string, unknown>;
    const canonicalEvidence = canonicalJson(evidence);
    if (Buffer.byteLength(canonicalEvidence, "utf8") > HANDOFF_EXECUTION_DECISION_MAX_BYTES) {
      throw new DomainError("PAYLOAD_TOO_LARGE", "Handoff execution decision evidence exceeds 32 KiB.", 413);
    }
    const access = resolveAccess(this.database.sqlite, actorId);
    roleAllowed(
      access,
      handoffExecutionDecisionRoles[request.kind],
      HANDOFF_EXECUTION_DECISION_SCOPES[request.kind],
    );
    const transaction = this.database.sqlite.transaction(() => {
      const row = this.requireHandoffRow(access, handoffId);
      this.assertTransitionHistory(row);
      if (row.current_version !== request.expectedVersion) {
        throw versionConflict(request.expectedVersion, row.current_version, "handoff");
      }
      const now = this.nowIso();
      this.database.sqlite.prepare(
        "DELETE FROM idempotency WHERE actor_id = ? AND expires_at <= ?",
      ).run(access.principalId, now);
      const scope = `handoff:${row.id}:execution_decision:${request.kind}`;
      const requestHash = hashPayload({
        expectedVersion: request.expectedVersion,
        expectedPriorDecisionId: request.expectedPriorDecisionId,
        kind: request.kind,
        outcome: request.outcome,
        evidence,
      });
      const existing = this.database.sqlite.prepare(
        `SELECT request_hash, response_json FROM idempotency
         WHERE actor_id = ? AND scope = ? AND key = ? AND expires_at > ?`,
      ).get(access.principalId, scope, request.idempotencyKey, now) as IdempotencyRow | undefined;
      if (existing) {
        if (existing.request_hash !== requestHash) {
          throw new DomainError(
            "IDEMPOTENCY_CONFLICT",
            "The handoff execution-decision idempotency key was already used with different input.",
            409,
          );
        }
        try {
          const parsed = handoffExecutionDecisionResultSchema.safeParse(JSON.parse(existing.response_json) as unknown);
          if (!parsed.success || parsed.data.handoffId !== row.id || parsed.data.kind !== request.kind) {
            throw parsed.success ? new Error("decision identity mismatch") : parsed.error;
          }
          return parsed.data;
        } catch (error) {
          throw new DomainError("INTERNAL_ERROR", "Persisted handoff execution-decision idempotency state is invalid.", 500, {
            cause: error,
          });
        }
      }

      const prior = this.latestExecutionDecisionRow(row.id, request.kind);
      if ((prior?.id ?? null) !== request.expectedPriorDecisionId) {
        throw new DomainError(
          "VERSION_CONFLICT",
          "The handoff execution decision changed concurrently.",
          409,
          {
            details: {
              handoffId: row.id,
              handoffVersion: row.current_version,
              kind: request.kind,
              expectedPriorDecisionId: request.expectedPriorDecisionId,
              currentDecisionId: prior?.id ?? null,
            },
          },
        );
      }
      this.assertExecutionDecisionLifecycle(row, request.kind, request.outcome, prior);
      this.assertExecutionDecisionEvidence(row, request.kind, request.outcome, evidence);
      const decision = this.appendExecutionDecision(
        access,
        row,
        request.kind,
        request.outcome,
        evidence,
        prior,
        now,
      );
      appendAuditEvent(
        this.database.sqlite,
        access,
        `handoff.execution_decision.${request.kind}`,
        "handoff",
        row.id,
        {
          designId: row.design_id,
          handoffVersion: row.current_version,
          decisionId: decision.id,
          decisionKind: decision.kind,
          outcome: decision.outcome,
          sequence: decision.sequence,
          evidenceHash: decision.evidenceHash,
          supersedesDecisionId: decision.supersedesDecisionId,
        },
      );
      const expiresAt = new Date(Date.parse(now) + HANDOFF_EXECUTION_DECISION_IDEMPOTENCY_TTL_MS).toISOString();
      this.database.sqlite.prepare(
        `INSERT INTO idempotency
         (actor_id, scope, key, request_hash, response_json, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        access.principalId,
        scope,
        request.idempotencyKey,
        requestHash,
        canonicalJson(decision),
        now,
        expiresAt,
      );
      return decision;
    });
    return transaction.immediate();
  }

  readHandoffExecutionDecisions(actorId: string, handoffId: string): {
    decisions: HandoffExecutionDecisionResult[];
    current: HandoffExecutionDecisionState;
  } {
    const access = resolveAccess(this.database.sqlite, actorId);
    roleAllowed(
      access,
      ["organization_admin", "product_manager", "design_editor", "engineer", "viewer"],
      "handoff:read",
    );
    const row = this.requireHandoffRow(access, handoffId);
    const decisions = this.executionDecisionResults(row);
    return { decisions, current: this.executionDecisionState(decisions, row.current_version) };
  }

  completeHandoffImplementation(actorId: string, handoffId: string, input: {
    expectedVersion: number;
    summary: string;
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
      requireExecutionReadyForCompletion: true,
      details: {
        decision: "completed",
        summary,
        completedVersion: request.expectedVersion,
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

  listHandoffSummaries(
    actorId: string,
    input: ListHandoffSummariesRequest = {},
  ): HandoffSummaryPage {
    const access = resolveAccess(this.database.sqlite, actorId);
    roleAllowed(
      access,
      ["organization_admin", "product_manager", "design_editor", "engineer", "viewer"],
      "handoff:read",
    );
    const request = parseInput(
      ListHandoffSummariesRequestSchema,
      input,
      "List handoff summaries request",
    );
    if (request.designId !== undefined) this.requireDesign(access, request.designId);
    const accessHash = this.handoffListAccessHash(access, request.designId);
    const cursor = request.cursor === undefined
      ? null
      : this.parseHandoffListCursor(request.cursor, request.designId, accessHash);
    if (cursor) this.assertHandoffListCursorAnchor(access, request.designId, cursor);

    const conditions = [
      "h.organization_id = ?",
      `EXISTS (
        SELECT 1 FROM designs active_design
        WHERE active_design.id = h.design_id
          AND ${activeDesignSqlPredicate("active_design")}
      )`,
    ];
    const parameters: Array<string | number> = [access.organizationId];
    if (request.designId !== undefined) {
      conditions.push("h.design_id = ?");
      parameters.push(request.designId);
    } else if (access.projectIds.length > 0) {
      conditions.push(`h.design_id IN (${access.projectIds.map(() => "?").join(", ")})`);
      parameters.push(...access.projectIds);
    }
    if (cursor) {
      conditions.push("(h.updated_at < ? OR (h.updated_at = ? AND h.id < ?))");
      parameters.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
    }
    parameters.push(request.limit + 1);
    const rows = this.database.sqlite.prepare(
      `SELECT h.*, r.version AS design_version, hv.specification_json
       FROM handoffs h
       LEFT JOIN revisions r ON r.id = h.revision_id AND r.design_id = h.design_id
       LEFT JOIN handoff_versions hv ON hv.handoff_id = h.id AND hv.version = h.current_version
       WHERE ${conditions.join(" AND ")}
       ORDER BY h.updated_at DESC, h.id DESC
       LIMIT ?`,
    ).all(...parameters) as HandoffSummaryRow[];
    const hasMore = rows.length > request.limit;
    const selected = rows.slice(0, request.limit);
    return {
      handoffs: selected.map((row) => this.handoffSummaryResult(row)),
      nextCursor: hasMore && selected.length > 0
        ? this.createHandoffListCursor(selected.at(-1)!, request.designId, accessHash)
        : null,
    };
  }

  listHandoffs(actorId: string, input: { designId?: string; limit?: number } = {}): HandoffResult[] {
    const access = resolveAccess(this.database.sqlite, actorId);
    roleAllowed(access, ["organization_admin", "product_manager", "design_editor", "engineer", "viewer"], "handoff:read");
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new DomainError("VALIDATION_FAILED", "Handoff list limit must be an integer from 1 to 100.", 422);
    }
    if (input.designId !== undefined) this.requireDesign(access, input.designId);
    const projectClause = access.projectIds.length > 0
      ? ` AND design_id IN (${access.projectIds.map(() => "?").join(", ")})`
      : "";
    const activeDesignClause = ` AND EXISTS (
      SELECT 1 FROM designs active_design
      WHERE active_design.id = handoffs.design_id
        AND ${activeDesignSqlPredicate("active_design")}
    )`;
    const rows = input.designId === undefined
      ? this.database.sqlite.prepare(
        `SELECT * FROM handoffs WHERE organization_id = ?${projectClause}${activeDesignClause}
         ORDER BY updated_at DESC, id DESC LIMIT ?`,
      ).all(access.organizationId, ...access.projectIds, limit) as HandoffRow[]
      : this.database.sqlite.prepare(
        `SELECT * FROM handoffs WHERE organization_id = ? AND design_id = ?${activeDesignClause}
         ORDER BY updated_at DESC, id DESC LIMIT ?`,
      ).all(access.organizationId, input.designId, limit) as HandoffRow[];
    return rows
      .filter((row) => access.projectIds.length === 0 || access.projectIds.includes(row.design_id))
      .map((row) => {
        this.assertTransitionHistory(row);
        return this.handoffResult(row);
      });
  }

  private handoffListAccessHash(access: AccessContext, designId: string | undefined): string {
    return hashPayload({
      organizationId: access.organizationId,
      principalId: access.principalId,
      role: access.role,
      scopes: [...new Set(access.scopes)].sort(),
      projectIds: [...new Set(access.projectIds)].sort(),
      designId: designId ?? null,
    });
  }

  private createHandoffListCursor(
    row: HandoffSummaryRow,
    designId: string | undefined,
    accessHash: string,
  ): string {
    const core = handoffListCursorCoreSchema.parse({
      schemaVersion: 1,
      designId: designId ?? null,
      accessHash,
      updatedAt: row.updated_at,
      id: row.id,
      anchorHash: this.handoffListAnchorHash(row),
    });
    const payload = handoffListCursorPayloadSchema.parse({
      ...core,
      checksum: hashPayload(core),
    });
    const cursor = `${HANDOFF_LIST_CURSOR_PREFIX}${Buffer.from(canonicalJson(payload), "utf8").toString("base64url")}`;
    if (!HandoffListCursorSchema.safeParse(cursor).success) {
      throw new DomainError("INTERNAL_ERROR", "Generated handoff list cursor is invalid.", 500);
    }
    return cursor;
  }

  private parseHandoffListCursor(
    cursor: string,
    designId: string | undefined,
    accessHash: string,
  ): z.infer<typeof handoffListCursorCoreSchema> {
    const encoded = cursor.slice(HANDOFF_LIST_CURSOR_PREFIX.length);
    let raw: unknown;
    try {
      const bytes = Buffer.from(encoded, "base64url");
      if (bytes.length === 0
        || bytes.length > 2_048
        || bytes.toString("base64url") !== encoded) {
        throw new Error("non-canonical cursor encoding");
      }
      raw = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch (error) {
      throw new DomainError("VALIDATION_FAILED", "Handoff list cursor is malformed.", 422, { cause: error });
    }
    const parsed = handoffListCursorPayloadSchema.safeParse(raw);
    if (!parsed.success) {
      throw new DomainError("VALIDATION_FAILED", "Handoff list cursor payload is invalid.", 422, {
        cause: parsed.error,
      });
    }
    const { checksum, ...core } = parsed.data;
    if (checksum !== hashPayload(core)
      || `${HANDOFF_LIST_CURSOR_PREFIX}${Buffer.from(canonicalJson(parsed.data), "utf8").toString("base64url")}` !== cursor) {
      throw new DomainError("VALIDATION_FAILED", "Handoff list cursor integrity check failed.", 422);
    }
    if (core.designId !== (designId ?? null)) {
      throw new DomainError("VALIDATION_FAILED", "Handoff list cursor does not match the current design filter.", 422, {
        details: { reason: "cursor_filter_mismatch" },
      });
    }
    if (core.accessHash !== accessHash) {
      throw new DomainError("VERSION_CONFLICT", "Handoff list authorization changed; restart pagination.", 409, {
        details: { reason: "cursor_authorization_changed" },
      });
    }
    return handoffListCursorCoreSchema.parse(core);
  }

  private assertHandoffListCursorAnchor(
    access: AccessContext,
    designId: string | undefined,
    cursor: z.infer<typeof handoffListCursorCoreSchema>,
  ): void {
    const conditions = [
      "id = ?",
      "organization_id = ?",
      `EXISTS (
        SELECT 1 FROM designs active_design
        WHERE active_design.id = handoffs.design_id
          AND ${activeDesignSqlPredicate("active_design")}
      )`,
    ];
    const parameters: string[] = [cursor.id, access.organizationId];
    if (designId !== undefined) {
      conditions.push("design_id = ?");
      parameters.push(designId);
    } else if (access.projectIds.length > 0) {
      conditions.push(`design_id IN (${access.projectIds.map(() => "?").join(", ")})`);
      parameters.push(...access.projectIds);
    }
    const anchor = this.database.sqlite.prepare(
      `SELECT id, design_id, revision_id, inventory_id, status, current_version, updated_at
       FROM handoffs WHERE ${conditions.join(" AND ")}`,
    ).get(...parameters) as Pick<
      HandoffRow,
      "id" | "design_id" | "revision_id" | "inventory_id" | "status" | "current_version" | "updated_at"
    > | undefined;
    if (!anchor
      || anchor.updated_at !== cursor.updatedAt
      || this.handoffListAnchorHash(anchor) !== cursor.anchorHash) {
      throw new DomainError("VERSION_CONFLICT", "Handoff list cursor is stale; restart pagination.", 409, {
        details: { reason: "cursor_anchor_changed" },
      });
    }
  }

  private handoffListAnchorHash(row: Pick<
    HandoffRow,
    "id" | "design_id" | "revision_id" | "inventory_id" | "status" | "current_version" | "updated_at"
  >): string {
    return hashPayload({
      id: row.id,
      designId: row.design_id,
      revisionId: row.revision_id,
      inventoryId: row.inventory_id,
      status: row.status,
      currentVersion: row.current_version,
      updatedAt: row.updated_at,
    });
  }

  private handoffSummaryResult(row: HandoffSummaryRow): HandoffSummaryResult {
    if (row.inventory_id === null || row.design_version === null || row.specification_json === null) {
      throw new DomainError("INTERNAL_ERROR", "Persisted handoff summary pins are incomplete.", 500);
    }
    const specification = parsePersisted(
      HandoffSpecificationSchema,
      row.specification_json,
      "handoff specification",
    );
    return {
      id: row.id,
      designId: row.design_id,
      revisionId: row.revision_id,
      designVersion: row.design_version,
      inventoryId: row.inventory_id,
      status: row.status,
      currentVersion: row.current_version,
      title: specification.title,
      summary: specification.summary,
      acceptanceCriterionCount: specification.acceptanceCriteria.length,
      implementationSliceCount: specification.implementationSlices.length,
      validationChecks: [...new Set(
        specification.implementationSlices.flatMap((slice) => slice.validationChecks),
      )].sort(),
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private transitionHandoff(access: AccessContext, handoffId: string, input: {
    expectedVersion: number;
    expectedStatus: HandoffStatus;
    toStatus: HandoffStatus;
    requireCurrentInputs: boolean;
    approvedVersionRequired?: number;
    requireExecutionReadyForStart?: boolean;
    requireExecutionReadyForCompletion?: boolean;
    appendExecutionDecision?: {
      kind: HandoffExecutionDecisionKind;
      outcome: string;
      expectedPriorDecisionId: string | null;
      evidence: Record<string, unknown>;
    };
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
      if (input.requireExecutionReadyForStart) this.assertExecutionReadyForStart(row);
      const completionDetails = input.requireExecutionReadyForCompletion
        ? this.executionCompletionDetails(row)
        : {};
      if (!handoffTransitionGraph[row.status].includes(input.toStatus)) {
        throw new DomainError("VALIDATION_FAILED", `Cannot move a handoff from ${row.status} to ${input.toStatus}.`, 422);
      }
      if (input.requireCurrentInputs) {
        this.assertPinnedDesignCurrent(access, row);
        this.requireActiveInventory(access, row.inventory_id!);
      }
      const appendDecisionPrior = input.appendExecutionDecision
        ? this.latestExecutionDecisionRow(row.id, input.appendExecutionDecision.kind)
        : undefined;
      if (input.appendExecutionDecision
        && (appendDecisionPrior?.id ?? null) !== input.appendExecutionDecision.expectedPriorDecisionId) {
        throw new DomainError(
          "VERSION_CONFLICT",
          "The handoff execution decision changed concurrently.",
          409,
          {
            details: {
              handoffId: row.id,
              handoffVersion: row.current_version,
              kind: input.appendExecutionDecision.kind,
              expectedPriorDecisionId: input.appendExecutionDecision.expectedPriorDecisionId,
              currentDecisionId: appendDecisionPrior?.id ?? null,
            },
          },
        );
      }
      const now = this.nowIso();
      const changed = this.database.sqlite.prepare(
        `UPDATE handoffs SET status = ?, updated_at = ?
         WHERE id = ? AND organization_id = ? AND current_version = ? AND status = ?`,
      ).run(input.toStatus, now, row.id, access.organizationId, input.expectedVersion, input.expectedStatus);
      if (changed.changes !== 1) throw new DomainError("VERSION_CONFLICT", "Handoff state changed concurrently.", 409);
      if (input.appendExecutionDecision) {
        const decision = this.appendExecutionDecision(
          access,
          { ...row, status: input.toStatus },
          input.appendExecutionDecision.kind,
          input.appendExecutionDecision.outcome,
          input.appendExecutionDecision.evidence,
          appendDecisionPrior,
          now,
        );
        appendAuditEvent(
          this.database.sqlite,
          access,
          `handoff.execution_decision.${decision.kind}`,
          "handoff",
          row.id,
          {
            designId: row.design_id,
            handoffVersion: row.current_version,
            decisionId: decision.id,
            decisionKind: decision.kind,
            outcome: decision.outcome,
            sequence: decision.sequence,
            evidenceHash: decision.evidenceHash,
            supersedesDecisionId: decision.supersedesDecisionId,
          },
        );
      }
      this.appendTransition(
        access,
        row.id,
        row.status,
        input.toStatus,
        { ...input.details, ...completionDetails },
        now,
      );
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
    return requireActiveDesign(this.database.sqlite, access, designId);
  }

  private requireRawDesign(access: AccessContext, designId: unknown): DesignRow {
    if (typeof designId !== "string") throw new DomainError("NOT_FOUND", "Design not found.", 404);
    return this.requireDesign(access, designId);
  }

  private requireRevisionRow(access: AccessContext, designId: string, revisionId: string): RevisionPinRow {
    this.requireDesign(access, designId);
    const row = this.database.sqlite.prepare(
      `SELECT id, design_id, version, parent_revision_id, actor_id, message, document_json,
              snapshot_hash, operation_hash, parent_revision_hash, revision_hash, created_at
       FROM revisions WHERE id = ? AND design_id = ?`,
    ).get(revisionId, designId) as RevisionPinRow | undefined;
    if (!row) throw new DomainError("NOT_FOUND", "Design revision not found.", 404);
    return row;
  }

  private requireRevisionValidation(
    access: AccessContext,
    designId: string,
    revisionId: string,
    expectedDesignVersion: number,
    expectedProductSpecificationPin?: {
      source: "document" | "revision_link";
      version: number;
      hash: string;
    },
  ): RevisionValidation {
    const row = this.requireRevisionRow(access, designId, revisionId);
    if (row.version !== expectedDesignVersion) {
      throw versionConflict(expectedDesignVersion, row.version, "design revision");
    }
    if (!row.snapshot_hash || !row.operation_hash || !row.revision_hash) {
      throw new DomainError("INTERNAL_ERROR", "The exact design revision is missing integrity metadata.", 500);
    }
    let snapshotJson: string;
    let rawDocument: unknown;
    try {
      snapshotJson = readSnapshotJson(this.database.sqlite, row.snapshot_hash, {
        maxUncompressedBytes: IMPLEMENTATION_MAPPING_REVISION_MAX_BYTES,
      });
      rawDocument = JSON.parse(snapshotJson) as unknown;
    } catch (error) {
      throw new DomainError("INTERNAL_ERROR", "The exact design revision snapshot failed integrity verification.", 500, {
        cause: error,
      });
    }
    if (row.document_json !== snapshotJson) {
      throw new DomainError("INTERNAL_ERROR", "The exact design revision bytes do not match its snapshot.", 500);
    }
    if (!rawDocument || typeof rawDocument !== "object" || Array.isArray(rawDocument)
      || (rawDocument as { schema_version?: unknown }).schema_version !== 2) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "Implementation mappings require an exact V2 design revision; V1 revisions remain immutable and unmapped.",
        422,
        { details: { requiredSchemaVersion: 2, actualSchemaVersion: (rawDocument as { schema_version?: unknown } | null)?.schema_version ?? null } },
      );
    }
    const parsedDocument = DesignDocumentV2Schema.safeParse(rawDocument);
    if (!parsedDocument.success) {
      throw new DomainError("INTERNAL_ERROR", "The persisted V2 design revision is invalid.", 500, {
        cause: parsedDocument.error,
      });
    }
    const document = parsedDocument.data;
    if (canonicalJson(document) !== snapshotJson || document.id !== designId || document.revision !== row.version) {
      throw new DomainError("INTERNAL_ERROR", "The persisted V2 design revision identity or canonical bytes are invalid.", 500);
    }
    if (row.parent_revision_id === null) {
      if (row.parent_revision_hash !== null) {
        throw new DomainError("INTERNAL_ERROR", "The design revision has an invalid parent hash.", 500);
      }
    } else {
      const parent = this.database.sqlite.prepare(
        "SELECT revision_hash FROM revisions WHERE id = ? AND design_id = ?",
      ).get(row.parent_revision_id, designId) as { revision_hash: string | null } | undefined;
      if (!parent?.revision_hash || parent.revision_hash !== row.parent_revision_hash) {
        throw new DomainError("INTERNAL_ERROR", "The design revision parent hash chain is invalid.", 500);
      }
    }
    const expectedRevisionHash = revisionHash({
      parentRevisionHash: row.parent_revision_hash,
      snapshotHash: row.snapshot_hash,
      operationHash: row.operation_hash,
      metadata: {
        id: row.id,
        designId: row.design_id,
        version: row.version,
        parentRevisionId: row.parent_revision_id,
        actorId: row.actor_id,
        message: row.message,
        createdAt: row.created_at,
      },
    });
    if (expectedRevisionHash !== row.revision_hash) {
      throw new DomainError("INTERNAL_ERROR", "The design revision hash chain failed verification.", 500);
    }

    const linkedRows = this.database.sqlite.prepare(
      `SELECT version, specification_json, specification_hash, organization_id
       FROM product_specifications WHERE design_id = ? AND revision_id = ?
       ORDER BY version DESC`,
    ).all(designId, revisionId) as ProductSpecificationLinkRow[];
    if (expectedProductSpecificationPin?.source === "document") {
      const embedded = canonicalProductSpecification(document.product_specification);
      if (embedded.specification.version !== expectedProductSpecificationPin.version
        || embedded.hash !== expectedProductSpecificationPin.hash) {
        throw new DomainError("INTERNAL_ERROR", "The persisted implementation-mapping product specification pin is unavailable.", 500);
      }
      return {
        row,
        document,
        productSpecification: embedded.specification,
        productSpecificationSource: "document",
        productSpecificationVersion: embedded.specification.version,
        productSpecificationHash: embedded.hash,
      };
    }
    if (expectedProductSpecificationPin?.source === "revision_link") {
      const linked = linkedRows.find((candidate) =>
        candidate.version === expectedProductSpecificationPin.version
        && candidate.specification_hash === expectedProductSpecificationPin.hash);
      if (!linked) {
        throw new DomainError("INTERNAL_ERROR", "The persisted implementation-mapping product specification pin is unavailable.", 500);
      }
      if (linked.organization_id !== access.organizationId) {
        throw new DomainError("INTERNAL_ERROR", "The revision-linked product specification has invalid ownership.", 500);
      }
      const canonical = canonicalProductSpecification(JSON.parse(linked.specification_json) as unknown);
      if (canonical.json !== linked.specification_json
        || canonical.hash !== linked.specification_hash
        || canonical.specification.version !== linked.version) {
        throw new DomainError("INTERNAL_ERROR", "The revision-linked product specification failed integrity verification.", 500);
      }
      return {
        row,
        document,
        productSpecification: canonical.specification,
        productSpecificationSource: "revision_link",
        productSpecificationVersion: linked.version,
        productSpecificationHash: linked.specification_hash,
      };
    }
    if (linkedRows.length > 1) {
      throw new DomainError(
        "AMBIGUOUS_CONTEXT",
        "More than one product specification is pinned to the exact design revision.",
        409,
        { details: { designId, revisionId, productSpecificationVersions: linkedRows.map((linked) => linked.version) } },
      );
    }
    if (linkedRows.length === 1) {
      const linked = linkedRows[0]!;
      if (linked.organization_id !== access.organizationId) {
        throw new DomainError("INTERNAL_ERROR", "The revision-linked product specification has invalid ownership.", 500);
      }
      const canonical = canonicalProductSpecification(JSON.parse(linked.specification_json) as unknown);
      if (canonical.json !== linked.specification_json
        || canonical.hash !== linked.specification_hash
        || canonical.specification.version !== linked.version) {
        throw new DomainError("INTERNAL_ERROR", "The revision-linked product specification failed integrity verification.", 500);
      }
      return {
        row,
        document,
        productSpecification: canonical.specification,
        productSpecificationSource: "revision_link",
        productSpecificationVersion: linked.version,
        productSpecificationHash: linked.specification_hash,
      };
    }
    const embedded = canonicalProductSpecification(document.product_specification);
    return {
      row,
      document,
      productSpecification: embedded.specification,
      productSpecificationSource: "document",
      productSpecificationVersion: embedded.specification.version,
      productSpecificationHash: embedded.hash,
    };
  }

  private verifiedInventory(row: RepositoryInventoryRow): UploadRepositoryInventory {
    const inventory = parsePersisted(UploadRepositoryInventorySchema, row.inventory_json, "repository inventory");
    if (inventory.repositoryFingerprint !== row.repository_fingerprint || hashPayload(inventory) !== row.inventory_hash) {
      throw new DomainError("INTERNAL_ERROR", "Persisted repository inventory integrity metadata does not match its immutable content.", 500);
    }
    return inventory;
  }

  private assertSoleActiveInventory(access: AccessContext, row: RepositoryInventoryRow): void {
    const active = this.database.sqlite.prepare(
      `SELECT id FROM repository_inventories
       WHERE organization_id = ? AND repository_fingerprint = ? AND status = 'active'
       ORDER BY id`,
    ).all(access.organizationId, row.repository_fingerprint) as Array<{ id: string }>;
    if (active.length !== 1 || active[0]?.id !== row.id) {
      throw new DomainError(
        "VERSION_CONFLICT",
        "The selected repository inventory is not the single active inventory for its repository.",
        409,
        { details: { inventoryId: row.id, activeInventoryIds: active.map((entry) => entry.id).slice(0, 10) } },
      );
    }
  }

  private inventoryPlatform(inventory: UploadRepositoryInventory): ImplementationMappingPlatform {
    if (inventory.platforms.length !== 1) {
      throw new DomainError(
        "AMBIGUOUS_CONTEXT",
        "Implementation mappings require a repository inventory with one unambiguous platform.",
        409,
        { details: { platforms: inventory.platforms, requiredAction: "upload_per_platform_inventory" } },
      );
    }
    switch (inventory.platforms[0]) {
      case "web":
      case "android":
      case "ios":
      case "flutter":
        return inventory.platforms[0];
      case "react-native":
        return "react_native";
      case "generic-git":
        return "other";
      default:
        throw new DomainError("INTERNAL_ERROR", "The repository inventory has an unsupported platform.", 500);
    }
  }

  private assertDesignEntity(
    document: DesignDocumentV2,
    productSpecification: ProductSpecification,
    kind: ImplementationMappingEntityKind,
    entityId: string,
  ): void {
    const exists = kind === "component"
      ? document.component_definitions[entityId] !== undefined
      : kind === "token"
        ? document.tokens[entityId] !== undefined
        : kind === "screen"
          ? document.nodes[entityId]?.type === "frame" && document.nodes[entityId]?.archived === false
          : kind === "asset"
            ? document.assets[entityId] !== undefined
            : kind === "flow"
              ? productSpecification.flows.some((flow) => flow.id === entityId)
              : productSpecification.business_rules.some((rule) => rule.id === entityId);
    if (!exists) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "An implementation mapping references an entity outside the exact V2 design revision and product specification.",
        422,
        { details: { entityKind: kind, entityId } },
      );
    }
  }

  private assertCompatibleInventoryEntity(
    designKind: ImplementationMappingEntityKind,
    inventoryKind: z.infer<typeof inventoryEntityKindSchema>,
    inventoryEntityId: string,
  ): void {
    const compatible: Record<ImplementationMappingEntityKind, readonly z.infer<typeof inventoryEntityKindSchema>[]> = {
      component: ["component"],
      token: ["token"],
      screen: ["screen", "route"],
      asset: ["asset"],
      flow: ["flow", "route"],
      business_rule: ["business-rule"],
    };
    if (!compatible[designKind].includes(inventoryKind)) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "The repository inventory entity kind is incompatible with the mapped design entity.",
        422,
        { details: { designEntityKind: designKind, inventoryEntityId, inventoryEntityKind: inventoryKind } },
      );
    }
  }

  private requireImplementationMappingRow(access: AccessContext, mappingId: string): ImplementationMappingRow {
    if (!implementationMappingIdSchema.safeParse(mappingId).success) {
      throw new DomainError("NOT_FOUND", "Implementation mapping not found.", 404);
    }
    const row = this.database.sqlite.prepare(
      "SELECT * FROM implementation_mappings WHERE id = ? AND organization_id = ?",
    ).get(mappingId, access.organizationId) as ImplementationMappingRow | undefined;
    if (!row) throw new DomainError("NOT_FOUND", "Implementation mapping not found.", 404);
    requireActiveDesign(this.database.sqlite, access, row.design_id);
    return row;
  }

  private implementationMappingResult(
    access: AccessContext,
    row: ImplementationMappingRow,
    cache: MappingReadCache,
  ): ImplementationMappingResult {
    requireActiveDesign(this.database.sqlite, access, row.design_id);
    if (row.inventory_id === null) {
      throw new DomainError("INTERNAL_ERROR", "Persisted implementation mapping is missing its repository inventory pin.", 500);
    }
    const details = parsePersisted(implementationMappingDetailsSchema, row.mapping_json, "implementation mapping");
    if (details.designPin.designId !== row.design_id
      || details.designPin.revisionId !== row.revision_id
      || details.designEntity.kind !== row.entity_kind
      || details.designEntity.id !== row.entity_id
      || details.inventoryPin.inventoryId !== row.inventory_id
      || details.inventoryPin.platform !== row.platform
      || details.sourceEntity.symbol !== row.symbol) {
      throw new DomainError("INTERNAL_ERROR", "Persisted implementation-mapping columns do not match their immutable details.", 500);
    }

    const revisionKey = [
      row.design_id,
      row.revision_id,
      String(details.designPin.designVersion),
      details.productSpecificationPin.source,
      String(details.productSpecificationPin.version),
      details.productSpecificationPin.hash,
    ].join("\0");
    let revision = cache.revisions.get(revisionKey);
    if (!revision) {
      revision = this.requireRevisionValidation(
        access,
        row.design_id,
        row.revision_id,
        details.designPin.designVersion,
        details.productSpecificationPin,
      );
      cache.revisions.set(revisionKey, revision);
    }
    if (revision.row.snapshot_hash !== details.designPin.snapshotHash
      || revision.row.revision_hash !== details.designPin.revisionHash
      || revision.productSpecificationSource !== details.productSpecificationPin.source
      || revision.productSpecificationVersion !== details.productSpecificationPin.version
      || revision.productSpecificationHash !== details.productSpecificationPin.hash) {
      throw new DomainError("INTERNAL_ERROR", "Persisted implementation-mapping revision pins failed verification.", 500);
    }
    this.assertDesignEntity(
      revision.document,
      revision.productSpecification,
      row.entity_kind,
      row.entity_id,
    );

    let inventoryEntry = cache.inventories.get(row.inventory_id);
    if (!inventoryEntry) {
      const inventoryRow = this.requireInventoryRow(access, row.inventory_id);
      inventoryEntry = { row: inventoryRow, inventory: this.verifiedInventory(inventoryRow) };
      cache.inventories.set(row.inventory_id, inventoryEntry);
    }
    if (inventoryEntry.row.inventory_hash !== details.inventoryPin.inventoryHash
      || inventoryEntry.row.repository_fingerprint !== details.inventoryPin.repositoryFingerprint
      || this.inventoryPlatform(inventoryEntry.inventory) !== details.inventoryPin.platform) {
      throw new DomainError("INTERNAL_ERROR", "Persisted implementation-mapping inventory pins failed verification.", 500);
    }
    const source = inventoryEntry.inventory.entities.find((entity) => entity.id === details.sourceEntity.id);
    if (!source
      || source.kind !== details.sourceEntity.kind
      || (source.symbol ?? source.id) !== details.sourceEntity.symbol
      || source.locationId !== details.sourceEntity.locationId
      || source.line !== details.sourceEntity.line) {
      throw new DomainError("INTERNAL_ERROR", "Persisted implementation-mapping source metadata failed verification.", 500);
    }
    this.assertCompatibleInventoryEntity(row.entity_kind, source.kind, source.id);
    return this.mappingResultFromDetails(row, details);
  }

  private mappingResultFromDetails(
    row: ImplementationMappingRow,
    details: z.infer<typeof implementationMappingDetailsSchema>,
  ): ImplementationMappingResult {
    const candidate = {
      id: row.id,
      designId: row.design_id,
      revisionId: row.revision_id,
      designVersion: details.designPin.designVersion,
      snapshotHash: details.designPin.snapshotHash,
      revisionHash: details.designPin.revisionHash,
      productSpecificationSource: details.productSpecificationPin.source,
      productSpecificationVersion: details.productSpecificationPin.version,
      productSpecificationHash: details.productSpecificationPin.hash,
      inventoryId: details.inventoryPin.inventoryId,
      inventoryHash: details.inventoryPin.inventoryHash,
      entityKind: row.entity_kind,
      entityId: row.entity_id,
      platform: row.platform,
      symbol: row.symbol,
      inventoryEntityId: details.sourceEntity.id,
      inventoryEntityKind: details.sourceEntity.kind,
      locationId: details.sourceEntity.locationId,
      line: details.sourceEntity.line,
      createdBy: row.created_by,
      createdAt: row.created_at,
    };
    const parsed = implementationMappingResultSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new DomainError("INTERNAL_ERROR", "Persisted implementation-mapping result is invalid.", 500, {
        cause: parsed.error,
      });
    }
    return parsed.data;
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
    requireActiveDesign(this.database.sqlite, access, row.design_id);
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

  private latestExecutionDecisionRow(
    handoffId: string,
    kind: HandoffExecutionDecisionKind,
  ): HandoffExecutionDecisionRow | undefined {
    return this.database.sqlite.prepare(
      `SELECT * FROM handoff_execution_decisions
       WHERE handoff_id = ? AND kind = ?
       ORDER BY sequence DESC LIMIT 1`,
    ).get(handoffId, kind) as HandoffExecutionDecisionRow | undefined;
  }

  private executionDecisionRows(handoffId: string): HandoffExecutionDecisionRow[] {
    return this.database.sqlite.prepare(
      `SELECT * FROM handoff_execution_decisions
       WHERE handoff_id = ? ORDER BY sequence`,
    ).all(handoffId) as HandoffExecutionDecisionRow[];
  }

  private executionDecisionResult(row: HandoffExecutionDecisionRow): HandoffExecutionDecisionResult {
    let rawEvidence: unknown;
    try {
      rawEvidence = JSON.parse(row.evidence_json) as unknown;
    } catch (error) {
      throw new DomainError("INTERNAL_ERROR", "Persisted handoff execution-decision evidence is invalid.", 500, {
        cause: error,
      });
    }
    const schema = evidenceSchemaForExecutionDecision(row.kind, row.outcome);
    const parsedEvidence = schema?.safeParse(rawEvidence);
    if (!schema || !parsedEvidence?.success) {
      throw new DomainError("INTERNAL_ERROR", "Persisted handoff execution-decision evidence is invalid.", 500, {
        ...(!parsedEvidence?.success && parsedEvidence ? { cause: parsedEvidence.error } : {}),
      });
    }
    const evidence = parsedEvidence.data as Record<string, unknown>;
    if (canonicalJson(evidence) !== row.evidence_json || hashPayload(evidence) !== row.evidence_hash) {
      throw new DomainError("INTERNAL_ERROR", "Persisted handoff execution-decision evidence failed integrity verification.", 500);
    }
    const candidate = {
      id: row.id,
      handoffId: row.handoff_id,
      handoffVersion: row.handoff_version,
      sequence: row.sequence,
      kind: row.kind,
      outcome: row.outcome,
      supersedesDecisionId: row.supersedes_decision_id,
      evidence,
      evidenceHash: row.evidence_hash,
      actorId: row.actor_id,
      createdAt: row.created_at,
    };
    const parsed = handoffExecutionDecisionResultSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new DomainError("INTERNAL_ERROR", "Persisted handoff execution decision is invalid.", 500, {
        cause: parsed.error,
      });
    }
    return parsed.data;
  }

  private executionDecisionResults(row: HandoffRow): HandoffExecutionDecisionResult[] {
    const rows = this.executionDecisionRows(row.id);
    const previousByKind = new Map<HandoffExecutionDecisionKind, string>();
    return rows.map((decision, index) => {
      if (decision.sequence !== index + 1 || decision.handoff_version > row.current_version) {
        throw new DomainError("INTERNAL_ERROR", "Persisted handoff execution-decision sequence is invalid.", 500);
      }
      const expectedSupersedes = previousByKind.get(decision.kind) ?? null;
      if (decision.supersedes_decision_id !== expectedSupersedes) {
        throw new DomainError("INTERNAL_ERROR", "Persisted handoff execution-decision chain is invalid.", 500);
      }
      previousByKind.set(decision.kind, decision.id);
      return this.executionDecisionResult(decision);
    });
  }

  private executionDecisionState(
    decisions: readonly HandoffExecutionDecisionResult[],
    handoffVersion?: number,
  ): HandoffExecutionDecisionState {
    const state = Object.fromEntries(
      HANDOFF_EXECUTION_DECISION_KINDS.map((kind) => [kind, null]),
    ) as HandoffExecutionDecisionState;
    for (const decision of decisions) {
      if (handoffVersion !== undefined && decision.handoffVersion !== handoffVersion) continue;
      state[decision.kind] = decision;
    }
    return state;
  }

  private appendExecutionDecision(
    access: AccessContext,
    row: HandoffRow,
    kind: HandoffExecutionDecisionKind,
    outcome: string,
    evidence: Record<string, unknown>,
    prior: HandoffExecutionDecisionRow | undefined,
    now: string,
  ): HandoffExecutionDecisionResult {
    const evidenceJson = canonicalJson(evidence);
    const evidenceHash = hashPayload(evidence);
    const sequenceRow = this.database.sqlite.prepare(
      "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM handoff_execution_decisions WHERE handoff_id = ?",
    ).get(row.id) as { sequence: number };
    const id = workflowId("handoff_decision");
    this.database.sqlite.prepare(
      `INSERT INTO handoff_execution_decisions
       (id, handoff_id, handoff_version, sequence, kind, outcome, supersedes_decision_id,
        evidence_json, evidence_hash, actor_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      row.id,
      row.current_version,
      sequenceRow.sequence + 1,
      kind,
      outcome,
      prior?.id ?? null,
      evidenceJson,
      evidenceHash,
      access.principalId,
      now,
    );
    const inserted = this.database.sqlite.prepare(
      "SELECT * FROM handoff_execution_decisions WHERE id = ? AND handoff_id = ?",
    ).get(id, row.id) as HandoffExecutionDecisionRow | undefined;
    if (!inserted) throw new DomainError("INTERNAL_ERROR", "Handoff execution decision was not persisted.", 500);
    return this.executionDecisionResult(inserted);
  }

  private assertExecutionDecisionLifecycle(
    row: HandoffRow,
    kind: HandoffExecutionDecisionKind,
    outcome: string,
    prior: HandoffExecutionDecisionRow | undefined,
  ): void {
    const allowedStatuses: readonly HandoffStatus[] = kind === "plan_approval"
      ? outcome === "denied"
        ? ["in_review", "approved", "implementing"]
        : ["approved", "implementing"]
      : kind === "isolation_choice"
        ? ["approved", "implementing"]
        : ["implementing"];
    if (!allowedStatuses.includes(row.status)) {
      throw new DomainError(
        "VERSION_CONFLICT",
        `The ${kind} decision cannot be recorded while the handoff is ${row.status}.`,
        409,
        { details: { handoffId: row.id, handoffVersion: row.current_version, kind, currentStatus: row.status } },
      );
    }
    if (outcome === "revoked" && (!prior || prior.outcome === "denied" || prior.outcome === "revoked")) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "A handoff execution decision can revoke only a current affirmative decision.",
        422,
        { details: { kind, currentOutcome: prior?.outcome ?? null } },
      );
    }
  }

  private currentHandoffSpecification(row: HandoffRow): HandoffSpecification {
    const version = this.database.sqlite.prepare(
      `SELECT specification_json FROM handoff_versions
       WHERE handoff_id = ? AND version = ?`,
    ).get(row.id, row.current_version) as { specification_json: string } | undefined;
    if (!version) throw new DomainError("INTERNAL_ERROR", "The current handoff specification is unavailable.", 500);
    return parsePersisted(HandoffSpecificationSchema, version.specification_json, "handoff specification");
  }

  private assertExecutionDecisionEvidence(
    row: HandoffRow,
    kind: HandoffExecutionDecisionKind,
    outcome: string,
    evidence: Record<string, unknown>,
  ): void {
    if (outcome === "denied" || outcome === "revoked") return;
    const decisions = this.executionDecisionResults(row);
    const current = this.executionDecisionState(decisions, row.current_version);
    if (kind === "validation_approval" && outcome === "approved") {
      const parsed = validationEvidenceSchema.parse(evidence);
      const supplied = new Set(parsed.checks.map((check) => check.name));
      const required = new Set(
        this.currentHandoffSpecification(row).implementationSlices.flatMap((slice) => slice.validationChecks),
      );
      const missing = [...required].filter((check) => !supplied.has(check)).sort();
      if (missing.length > 0) {
        throw new DomainError("VALIDATION_FAILED", "Validation approval is missing checks required by the immutable handoff plan.", 422, {
          details: { missingValidationChecks: missing },
        });
      }
    }
    if (kind === "commit_approval" && outcome === "approved") {
      const diff = current.diff_review;
      const commit = commitApprovalEvidenceSchema.parse(evidence);
      if (!diff || diff.outcome !== "approved") {
        throw new DomainError("VERSION_CONFLICT", "Commit approval requires a current approved diff review.", 409);
      }
      const reviewed = diffReviewEvidenceSchema.parse(diff.evidence);
      if (commit.diffHash !== reviewed.diffHash) {
        throw new DomainError("VALIDATION_FAILED", "Commit approval must reference the exact reviewed diff hash.", 422, {
          details: { reviewedDiffHash: reviewed.diffHash, commitDiffHash: commit.diffHash },
        });
      }
    }
    if (kind === "push_authorization" && outcome === "authorized") {
      const commit = current.commit_approval;
      if (!commit || commit.outcome !== "approved") {
        throw new DomainError("VERSION_CONFLICT", "Push authorization requires a current explicit commit approval.", 409);
      }
    }
    if (kind === "pull_request_request" && outcome === "requested") {
      const push = current.push_authorization;
      if (!push || push.outcome !== "authorized") {
        throw new DomainError("VERSION_CONFLICT", "A pull-request request requires current push authorization.", 409);
      }
    }
  }

  private assertExecutionReadyForStart(row: HandoffRow): void {
    const decisions = this.executionDecisionResults(row);
    const current = this.executionDecisionState(decisions, row.current_version);
    const missingOrBlocked: HandoffExecutionDecisionKind[] = [];
    if (current.plan_approval?.outcome !== "approved") missingOrBlocked.push("plan_approval");
    if (!current.isolation_choice || !["branch", "worktree"].includes(current.isolation_choice.outcome)) {
      missingOrBlocked.push("isolation_choice");
    }
    if (missingOrBlocked.length > 0) {
      throw new DomainError("VERSION_CONFLICT", "Implementation start requires current plan approval and an explicit branch/worktree choice.", 409, {
        details: { handoffId: row.id, handoffVersion: row.current_version, missingOrBlocked },
      });
    }
  }

  private executionCompletionDetails(row: HandoffRow): Record<string, unknown> {
    const decisions = this.executionDecisionResults(row);
    const current = this.executionDecisionState(decisions, row.current_version);
    const required: Array<[HandoffExecutionDecisionKind, readonly string[]]> = [
      ["plan_approval", ["approved"]],
      ["isolation_choice", ["branch", "worktree"]],
      ["diff_review", ["approved"]],
      ["validation_approval", ["approved"]],
      ["commit_approval", ["approved"]],
      ["push_authorization", ["authorized", "denied", "revoked"]],
      ["pull_request_request", ["requested", "not_requested", "denied", "revoked"]],
    ];
    const missingOrBlocked = required
      .filter(([kind, outcomes]) => !current[kind] || !outcomes.includes(current[kind]!.outcome))
      .map(([kind]) => kind);
    if (missingOrBlocked.length > 0) {
      throw new DomainError("VERSION_CONFLICT", "Implementation completion requires current persisted execution approvals.", 409, {
        details: { handoffId: row.id, handoffVersion: row.current_version, missingOrBlocked },
      });
    }
    const diff = diffReviewEvidenceSchema.parse(current.diff_review!.evidence);
    const commit = commitApprovalEvidenceSchema.parse(current.commit_approval!.evidence);
    if (diff.diffHash !== commit.diffHash) {
      throw new DomainError("VERSION_CONFLICT", "The current commit approval no longer matches the reviewed diff.", 409, {
        details: { reviewedDiffHash: diff.diffHash, commitDiffHash: commit.diffHash },
      });
    }
    this.assertExecutionDecisionEvidence(
      row,
      "validation_approval",
      "approved",
      current.validation_approval!.evidence,
    );
    const pullRequestRequested = current.pull_request_request?.outcome === "requested";
    const pushAuthorized = current.push_authorization?.outcome === "authorized";
    if (pullRequestRequested && !pushAuthorized) {
      throw new DomainError("VERSION_CONFLICT", "The current pull-request request no longer has push authorization.", 409);
    }
    return {
      executionDecisionIds: Object.fromEntries(
        HANDOFF_EXECUTION_DECISION_KINDS.flatMap((kind) => current[kind] ? [[kind, current[kind]!.id]] : []),
      ),
      isolationMode: current.isolation_choice!.outcome,
      diffHash: diff.diffHash,
      validationChecks: validationEvidenceSchema.parse(current.validation_approval!.evidence)
        .checks.map((check) => check.name).sort(),
      pushDecision: current.push_authorization!.outcome,
      pullRequestDecision: current.pull_request_request!.outcome,
      pushAuthorized,
      pullRequestRequested,
    };
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
    const executionDecisions = this.executionDecisionResults(row);
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
      executionDecisions,
      executionDecisionState: this.executionDecisionState(executionDecisions, row.current_version),
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
