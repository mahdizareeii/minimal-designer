import { z } from "zod";

import { hashPayload } from "./ids.js";
import {
  HANDOFF_EXECUTION_DECISION_KINDS,
  HandoffListCursorSchema,
  HANDOFF_SPECIFICATION_MAX_BYTES,
  HANDOFF_STATUSES,
  HandoffSpecificationSchema,
  IMPLEMENTATION_MAPPING_MAX_BATCH_ITEMS,
  ImplementationMappingEntityKindSchema,
  REPOSITORY_INVENTORY_STATUSES,
  UploadRepositoryInventorySchema,
  WORKSPACE_INVENTORY_MAX_BYTES,
  WORKSPACE_INVENTORY_MAX_ENTITIES,
} from "./workspace-handoff-service.js";

const identifier = z.string().trim().min(1).max(240);
const opaqueDatabaseId = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{2,200}$/);
const timestamp = z.string().datetime({ offset: true });
const positiveVersion = z.number().int().positive().max(1_000_000_000);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const inventoryId = z.string().regex(/^inventory_[a-f0-9]{32}$/);
const inventoryEntityId = z.string().regex(/^inv_[a-f0-9]{40}$/);
const inventoryLocationId = z.string().regex(/^loc_[a-f0-9]{40}$/);
const inventoryEntityKind = z.enum(["component", "screen", "route", "token", "asset", "flow", "business-rule"]);
const inventoryPlatform = z.enum(["web", "android", "ios", "flutter", "react-native", "generic-git"]);
const mappingPlatform = z.enum(["web", "android", "ios", "flutter", "react_native", "other"]);
const stableReference = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{2,159}$/);
const mappingId = z.string().regex(/^mapping_[a-f0-9]{32}$/);
const handoffId = z.string().regex(/^handoff_[a-f0-9]{32}$/);
const handoffTransitionId = z.string().regex(/^handoff_transition_[a-f0-9]{32}$/);
const handoffDecisionId = z.string().regex(/^handoff_decision_[a-f0-9]{32}$/);
const handoffStatus = z.enum(HANDOFF_STATUSES);
const validationCheck = z.enum([
  "typecheck",
  "unit_tests",
  "integration_tests",
  "build",
  "lint",
  "visual_regression",
  "accessibility",
]);

function withSerializedByteLimit<Schema extends z.ZodTypeAny>(
  schema: Schema,
  maximumBytes: number,
  label: string,
) {
  return schema.superRefine((value, context) => {
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > maximumBytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${label} exceeds ${maximumBytes} serialized bytes.`,
      });
    }
  });
}

const repositoryInventoryPayload = withSerializedByteLimit(
  UploadRepositoryInventorySchema,
  WORKSPACE_INVENTORY_MAX_BYTES,
  "Repository inventory",
);
const handoffSpecificationResult = withSerializedByteLimit(
  HandoffSpecificationSchema,
  HANDOFF_SPECIFICATION_MAX_BYTES,
  "Handoff specification",
);

export const RepositoryInventoryResultSchema = z.object({
  id: inventoryId,
  repositoryFingerprint: sha256,
  inventoryHash: sha256,
  inventory: repositoryInventoryPayload,
  status: z.enum(REPOSITORY_INVENTORY_STATUSES),
  createdBy: identifier,
  createdAt: timestamp,
  revokedAt: timestamp.nullable(),
  deduplicated: z.boolean(),
}).strict().superRefine((result, context) => {
  if (result.repositoryFingerprint !== result.inventory.repositoryFingerprint) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["repositoryFingerprint"],
      message: "Repository fingerprint must match the immutable inventory payload.",
    });
  }
  if (result.inventoryHash !== hashPayload(result.inventory)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["inventoryHash"],
      message: "Repository inventory hash must match its canonical payload.",
    });
  }
  if ((result.status === "revoked") !== (result.revokedAt !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["revokedAt"],
      message: "Only revoked repository inventories may carry a revocation timestamp.",
    });
  }
});

export const RepositoryInventorySummaryResultSchema = z.object({
  id: inventoryId,
  repositoryFingerprint: sha256,
  inventoryHash: sha256,
  status: z.enum(REPOSITORY_INVENTORY_STATUSES),
  platforms: z.array(inventoryPlatform).min(1).max(6),
  entityCount: z.number().int().nonnegative().max(WORKSPACE_INVENTORY_MAX_ENTITIES),
  scannedFileCount: z.number().int().nonnegative().max(1_000_000),
  skippedFileCount: z.number().int().nonnegative().max(1_000_000),
  truncated: z.boolean(),
  createdAt: timestamp,
  revokedAt: timestamp.nullable(),
}).strict().superRefine((result, context) => {
  if (new Set(result.platforms).size !== result.platforms.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["platforms"],
      message: "Repository inventory summary platforms must be unique.",
    });
  }
  if ((result.status === "revoked") !== (result.revokedAt !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["revokedAt"],
      message: "Only revoked repository inventory summaries may carry a revocation timestamp.",
    });
  }
});

export const ImplementationMappingResultSchema = z.object({
  id: mappingId,
  designId: opaqueDatabaseId,
  revisionId: opaqueDatabaseId,
  designVersion: positiveVersion,
  snapshotHash: sha256,
  revisionHash: sha256,
  productSpecificationSource: z.enum(["document", "revision_link"]),
  productSpecificationVersion: positiveVersion,
  productSpecificationHash: sha256,
  inventoryId,
  inventoryHash: sha256,
  entityKind: ImplementationMappingEntityKindSchema,
  entityId: stableReference,
  platform: mappingPlatform,
  symbol: z.string().trim().min(1).max(240),
  inventoryEntityId,
  inventoryEntityKind,
  locationId: inventoryLocationId,
  line: z.number().int().positive().max(10_000_000).nullable(),
  createdBy: identifier,
  createdAt: timestamp,
}).strict();

export const ImplementationMappingBatchResultSchema = z.object({
  designId: opaqueDatabaseId,
  revisionId: opaqueDatabaseId,
  designVersion: positiveVersion,
  snapshotHash: sha256,
  revisionHash: sha256,
  productSpecificationSource: z.enum(["document", "revision_link"]),
  productSpecificationVersion: positiveVersion,
  productSpecificationHash: sha256,
  inventoryId,
  inventoryHash: sha256,
  mappings: z.array(ImplementationMappingResultSchema).min(1).max(IMPLEMENTATION_MAPPING_MAX_BATCH_ITEMS),
}).strict().superRefine((batch, context) => {
  for (const [index, mapping] of batch.mappings.entries()) {
    const pinnedFields = [
      ["designId", batch.designId, mapping.designId],
      ["revisionId", batch.revisionId, mapping.revisionId],
      ["designVersion", batch.designVersion, mapping.designVersion],
      ["snapshotHash", batch.snapshotHash, mapping.snapshotHash],
      ["revisionHash", batch.revisionHash, mapping.revisionHash],
      ["productSpecificationSource", batch.productSpecificationSource, mapping.productSpecificationSource],
      ["productSpecificationVersion", batch.productSpecificationVersion, mapping.productSpecificationVersion],
      ["productSpecificationHash", batch.productSpecificationHash, mapping.productSpecificationHash],
      ["inventoryId", batch.inventoryId, mapping.inventoryId],
      ["inventoryHash", batch.inventoryHash, mapping.inventoryHash],
    ] as const;
    for (const [field, expected, actual] of pinnedFields) {
      if (actual !== expected) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["mappings", index, field],
          message: `Implementation mapping ${field} must match the batch pin.`,
        });
      }
    }
  }
});

const evidenceSummary = z.string().trim().min(1).max(2_000);
const deniedOrRevokedEvidence = z.object({ reason: evidenceSummary }).strict();
const planApprovalEvidence = z.object({
  summary: evidenceSummary,
  acceptanceCriteriaConfirmed: z.literal(true),
  implementationPlanConfirmed: z.literal(true),
}).strict();
const isolationChoiceEvidence = z.object({ summary: z.string().trim().min(1).max(1_000) }).strict();
const diffReviewEvidence = z.object({
  summary: evidenceSummary,
  diffHash: sha256,
  changedFileCount: z.number().int().nonnegative().max(100_000),
}).strict();
const validationEvidence = z.object({
  summary: evidenceSummary,
  checks: z.array(z.object({
    name: validationCheck,
    status: z.literal("passed"),
    evidenceHash: sha256.optional(),
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
const commitApprovalEvidence = z.object({
  summary: evidenceSummary,
  diffHash: sha256,
  commitMessage: z.string().trim().min(1).max(240),
}).strict();
const safeGitReference = z.string().trim().min(1).max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
  .refine((value) => !value.includes("..") && !value.includes("@{") && !value.endsWith("/") && !value.endsWith(".lock"));
const pushAuthorizationEvidence = z.object({
  summary: evidenceSummary,
  commitHash: z.string().regex(/^[a-f0-9]{40,64}$/),
  targetRef: safeGitReference,
}).strict();
const pullRequestEvidence = z.object({
  summary: evidenceSummary,
  title: z.string().trim().min(1).max(240),
  baseRef: safeGitReference,
  headRef: safeGitReference,
}).strict().refine((evidence) => evidence.baseRef !== evidence.headRef, { path: ["headRef"] });
const pullRequestNotRequestedEvidence = z.object({ reason: evidenceSummary }).strict();

const decisionCommon = {
  id: handoffDecisionId,
  handoffId,
  handoffVersion: positiveVersion,
  sequence: positiveVersion,
  supersedesDecisionId: handoffDecisionId.nullable(),
  evidenceHash: sha256,
  actorId: identifier,
  createdAt: timestamp,
} as const;

function decisionVariant<Kind extends string, Outcome extends string, Evidence extends z.ZodTypeAny>(
  kind: Kind,
  outcome: Outcome,
  evidence: Evidence,
) {
  return z.object({
    ...decisionCommon,
    kind: z.literal(kind),
    outcome: z.literal(outcome),
    evidence,
  }).strict();
}

const deniedDecisionVariants = HANDOFF_EXECUTION_DECISION_KINDS.flatMap((kind) => [
  decisionVariant(kind, "denied", deniedOrRevokedEvidence),
  decisionVariant(kind, "revoked", deniedOrRevokedEvidence),
]);

export const HandoffExecutionDecisionResultSchema: z.ZodTypeAny = z.union([
  decisionVariant("plan_approval", "approved", planApprovalEvidence),
  decisionVariant("isolation_choice", "branch", isolationChoiceEvidence),
  decisionVariant("isolation_choice", "worktree", isolationChoiceEvidence),
  decisionVariant("diff_review", "approved", diffReviewEvidence),
  decisionVariant("validation_approval", "approved", validationEvidence),
  decisionVariant("commit_approval", "approved", commitApprovalEvidence),
  decisionVariant("push_authorization", "authorized", pushAuthorizationEvidence),
  decisionVariant("pull_request_request", "requested", pullRequestEvidence),
  decisionVariant("pull_request_request", "not_requested", pullRequestNotRequestedEvidence),
  ...deniedDecisionVariants,
] as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]).superRefine((decision, context) => {
  if (hashPayload(decision.evidence) !== decision.evidenceHash) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidenceHash"],
      message: "Execution-decision evidence hash must match its canonical evidence.",
    });
  }
});

export const HandoffExecutionDecisionStateResultSchema = z.object({
  plan_approval: HandoffExecutionDecisionResultSchema.nullable(),
  isolation_choice: HandoffExecutionDecisionResultSchema.nullable(),
  diff_review: HandoffExecutionDecisionResultSchema.nullable(),
  validation_approval: HandoffExecutionDecisionResultSchema.nullable(),
  commit_approval: HandoffExecutionDecisionResultSchema.nullable(),
  push_authorization: HandoffExecutionDecisionResultSchema.nullable(),
  pull_request_request: HandoffExecutionDecisionResultSchema.nullable(),
}).strict().superRefine((state, context) => {
  for (const kind of HANDOFF_EXECUTION_DECISION_KINDS) {
    const decision = state[kind];
    if (decision && decision.kind !== kind) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [kind, "kind"],
        message: `The current ${kind} state must contain the same decision kind.`,
      });
    }
  }
});

const executionDecisionIds = z.object({
  plan_approval: handoffDecisionId,
  isolation_choice: handoffDecisionId,
  diff_review: handoffDecisionId,
  validation_approval: handoffDecisionId,
  commit_approval: handoffDecisionId,
  push_authorization: handoffDecisionId,
  pull_request_request: handoffDecisionId,
}).strict();

const handoffCreatedTransitionDetails = z.object({
  decision: z.literal("created"),
  version: positiveVersion,
}).strict();
const handoffSubmittedTransitionDetails = z.object({
    decision: z.literal("submitted"),
    summary: z.string().trim().min(1).max(2_000),
    submittedVersion: positiveVersion,
  }).strict();
const handoffChangesRequestedTransitionDetails = z.object({
    decision: z.literal("changes_requested"),
    reason: z.string().trim().min(1).max(2_000),
    reviewedVersion: positiveVersion,
  }).strict();
const handoffApprovedTransitionDetails = z.object({
    decision: z.literal("approved"),
    summary: z.string().trim().min(1).max(2_000),
    approvedVersion: positiveVersion,
    acceptanceCriteriaConfirmed: z.literal(true),
    implementationPlanConfirmed: z.literal(true),
  }).strict();
const handoffImplementationAuthorizedTransitionDetails = z.object({
    decision: z.literal("implementation_authorized"),
    approvedVersion: positiveVersion,
    authorization: z.literal("start_implementation"),
  }).strict();
const handoffCompletedTransitionDetails = z.object({
    decision: z.literal("completed"),
    summary: z.string().trim().min(1).max(4_000),
    completedVersion: positiveVersion,
    executionDecisionIds,
    isolationMode: z.enum(["branch", "worktree"]),
    diffHash: sha256,
    validationChecks: z.array(validationCheck).min(1).max(7),
    pushDecision: z.enum(["authorized", "denied", "revoked"]),
    pullRequestDecision: z.enum(["requested", "not_requested", "denied", "revoked"]),
    pushAuthorized: z.boolean(),
    pullRequestRequested: z.boolean(),
  }).strict().superRefine((details, context) => {
    if (new Set(details.validationChecks).size !== details.validationChecks.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["validationChecks"],
        message: "Completed handoff validation checks must be unique.",
      });
    }
    if (details.pushAuthorized !== (details.pushDecision === "authorized")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pushAuthorized"],
        message: "pushAuthorized must match the persisted push decision.",
      });
    }
    if (details.pullRequestRequested !== (details.pullRequestDecision === "requested")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pullRequestRequested"],
        message: "pullRequestRequested must match the persisted pull-request decision.",
      });
    }
    if (details.pullRequestRequested && !details.pushAuthorized) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pullRequestRequested"],
        message: "A requested pull request requires an authorized push decision.",
      });
    }
  });
const handoffCancelledTransitionDetails = z.object({
    decision: z.literal("cancelled"),
    reason: z.string().trim().min(1).max(2_000),
    cancelledVersion: positiveVersion,
  }).strict();

export const HandoffTransitionDetailsResultSchema = z.union([
  handoffCreatedTransitionDetails,
  handoffSubmittedTransitionDetails,
  handoffChangesRequestedTransitionDetails,
  handoffApprovedTransitionDetails,
  handoffImplementationAuthorizedTransitionDetails,
  handoffCompletedTransitionDetails,
  handoffCancelledTransitionDetails,
]);

export const HandoffVersionResultSchema = z.object({
  version: positiveVersion,
  specification: handoffSpecificationResult,
  actorId: identifier,
  createdAt: timestamp,
}).strict();

export const HandoffSummaryResultSchema = z.object({
  id: handoffId,
  designId: opaqueDatabaseId,
  revisionId: opaqueDatabaseId,
  designVersion: positiveVersion,
  inventoryId,
  status: handoffStatus,
  currentVersion: positiveVersion,
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(4_000),
  acceptanceCriterionCount: z.number().int().positive().max(200),
  implementationSliceCount: z.number().int().positive().max(100),
  validationChecks: z.array(validationCheck).min(1).max(7),
  createdBy: identifier,
  createdAt: timestamp,
  updatedAt: timestamp,
  resourceUri: z.string().regex(/^formaspec:\/\/handoffs\/handoff_[a-f0-9]{32}$/),
}).strict().superRefine((summary, context) => {
  if (new Set(summary.validationChecks).size !== summary.validationChecks.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["validationChecks"],
      message: "Handoff summary validation checks must be unique.",
    });
  }
  if (summary.resourceUri !== `formaspec://handoffs/${summary.id}`) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["resourceUri"],
      message: "Handoff summary resource URI must identify the returned handoff.",
    });
  }
});

export const HandoffSummaryPageResultSchema = z.object({
  handoffs: z.array(HandoffSummaryResultSchema).max(100),
  nextCursor: HandoffListCursorSchema.nullable(),
}).strict();

const handoffTransitionCommon = {
  id: handoffTransitionId,
  actorId: identifier,
  createdAt: timestamp,
} as const;

export const HandoffTransitionResultSchema = z.union([
  z.object({
    ...handoffTransitionCommon,
    fromStatus: z.null(),
    toStatus: z.literal("draft"),
    details: handoffCreatedTransitionDetails,
  }).strict(),
  z.object({
    ...handoffTransitionCommon,
    fromStatus: z.literal("in_review"),
    toStatus: z.literal("draft"),
    details: handoffChangesRequestedTransitionDetails,
  }).strict(),
  z.object({
    ...handoffTransitionCommon,
    fromStatus: z.literal("draft"),
    toStatus: z.literal("in_review"),
    details: handoffSubmittedTransitionDetails,
  }).strict(),
  z.object({
    ...handoffTransitionCommon,
    fromStatus: z.literal("in_review"),
    toStatus: z.literal("approved"),
    details: handoffApprovedTransitionDetails,
  }).strict(),
  z.object({
    ...handoffTransitionCommon,
    fromStatus: z.literal("approved"),
    toStatus: z.literal("implementing"),
    details: handoffImplementationAuthorizedTransitionDetails,
  }).strict(),
  z.object({
    ...handoffTransitionCommon,
    fromStatus: z.literal("implementing"),
    toStatus: z.literal("completed"),
    details: handoffCompletedTransitionDetails,
  }).strict(),
  z.object({
    ...handoffTransitionCommon,
    fromStatus: z.enum(["draft", "in_review", "approved", "implementing"]),
    toStatus: z.literal("cancelled"),
    details: handoffCancelledTransitionDetails,
  }).strict(),
]);

export const HandoffResultSchema = z.object({
  id: handoffId,
  designId: opaqueDatabaseId,
  revisionId: opaqueDatabaseId,
  designVersion: positiveVersion,
  inventoryId,
  status: handoffStatus,
  currentVersion: positiveVersion,
  specification: handoffSpecificationResult,
  versions: z.array(HandoffVersionResultSchema).min(1).max(10_000),
  transitions: z.array(HandoffTransitionResultSchema).min(1).max(10_000),
  executionDecisions: z.array(HandoffExecutionDecisionResultSchema).max(10_000),
  executionDecisionState: HandoffExecutionDecisionStateResultSchema,
  createdBy: identifier,
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict().superRefine((handoff, context) => {
  if (handoff.versions.length !== handoff.currentVersion) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["versions"],
      message: "Handoff version history must be complete through currentVersion.",
    });
  }
  for (const [index, version] of handoff.versions.entries()) {
    if (version.version !== index + 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["versions", index, "version"],
        message: "Handoff versions must be contiguous and one-based.",
      });
    }
  }
  const latestVersion = handoff.versions.at(-1);
  if (latestVersion && hashPayload(latestVersion.specification) !== hashPayload(handoff.specification)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["specification"],
      message: "Handoff specification must match the latest immutable version.",
    });
  }

  const firstTransition = handoff.transitions[0];
  if (!firstTransition
    || firstTransition.fromStatus !== null
    || firstTransition.toStatus !== "draft"
    || firstTransition.details.decision !== "created") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["transitions", 0],
      message: "Handoff transition history must begin with the immutable creation transition.",
    });
  } else if (firstTransition.details.version !== 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["transitions", 0, "details", "version"],
      message: "Handoff creation transition must record version 1.",
    });
  }
  for (const [index, transition] of handoff.transitions.entries()) {
    if (index > 0 && transition.fromStatus !== handoff.transitions[index - 1]!.toStatus) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["transitions", index, "fromStatus"],
        message: "Handoff transition history must form one contiguous state chain.",
      });
    }
  }
  if (handoff.transitions.at(-1)?.toStatus !== handoff.status) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["status"],
      message: "Handoff status must match its latest immutable transition.",
    });
  }

  const latestDecisionByKind = new Map<string, string>();
  for (const [index, decision] of handoff.executionDecisions.entries()) {
    if (decision.handoffId !== handoff.id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["executionDecisions", index, "handoffId"],
        message: "Execution decision must belong to the returned handoff.",
      });
    }
    if (decision.handoffVersion > handoff.currentVersion) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["executionDecisions", index, "handoffVersion"],
        message: "Execution decision cannot target a future handoff version.",
      });
    }
    if (decision.sequence !== index + 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["executionDecisions", index, "sequence"],
        message: "Execution-decision sequence must be contiguous and one-based.",
      });
    }
    if (index > 0 && decision.handoffVersion < handoff.executionDecisions[index - 1]!.handoffVersion) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["executionDecisions", index, "handoffVersion"],
        message: "Execution-decision handoff versions must be nondecreasing.",
      });
    }
    const prior = latestDecisionByKind.get(decision.kind);
    if (decision.supersedesDecisionId !== (prior ?? null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["executionDecisions", index, "supersedesDecisionId"],
        message: "Execution-decision supersession chain is invalid.",
      });
    }
    latestDecisionByKind.set(decision.kind, decision.id);
  }
  for (const kind of HANDOFF_EXECUTION_DECISION_KINDS) {
    const expected = [...handoff.executionDecisions]
      .reverse()
      .find((decision) => decision.kind === kind && decision.handoffVersion === handoff.currentVersion) ?? null;
    const current = handoff.executionDecisionState[kind];
    if (current === null || expected === null
      ? current !== expected
      : hashPayload(current) !== hashPayload(expected)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["executionDecisionState", kind],
        message: "Current execution-decision state must match the latest decision for the current handoff version.",
      });
    }
  }

  const current = handoff.executionDecisionState;
  if (["approved", "implementing", "completed"].includes(handoff.status)
    && current.plan_approval?.outcome !== "approved") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["executionDecisionState", "plan_approval"],
      message: "Approved and implementation-stage handoffs require current explicit plan approval.",
    });
  }
  if (["implementing", "completed"].includes(handoff.status)
    && !["branch", "worktree"].includes(current.isolation_choice?.outcome ?? "")) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["executionDecisionState", "isolation_choice"],
      message: "Implementation-stage handoffs require a current explicit isolation choice.",
    });
  }

  const finalTransition = handoff.transitions.at(-1);
  if (handoff.status === "completed"
    && finalTransition?.toStatus === "completed"
    && finalTransition.details.decision === "completed") {
    const details = finalTransition.details;
    const finalTransitionIndex = handoff.transitions.length - 1;
    if (details.completedVersion !== handoff.currentVersion) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["transitions", finalTransitionIndex, "details", "completedVersion"],
        message: "Completed transition must identify the current immutable handoff version.",
      });
    }
    const requiredOutcomes = {
      plan_approval: ["approved"],
      isolation_choice: ["branch", "worktree"],
      diff_review: ["approved"],
      validation_approval: ["approved"],
      commit_approval: ["approved"],
      push_authorization: ["authorized", "denied", "revoked"],
      pull_request_request: ["requested", "not_requested", "denied", "revoked"],
    } as const;
    for (const kind of HANDOFF_EXECUTION_DECISION_KINDS) {
      const decision = current[kind];
      if (!decision || !(requiredOutcomes[kind] as readonly string[]).includes(decision.outcome)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["executionDecisionState", kind],
          message: `Completed handoff requires a current affirmative or explicit terminal ${kind} decision.`,
        });
      } else if (details.executionDecisionIds[kind] !== decision.id) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["transitions", finalTransitionIndex, "details", "executionDecisionIds", kind],
          message: `Completed transition must reference the current ${kind} decision.`,
        });
      }
    }

    if (current.isolation_choice
      && details.isolationMode !== current.isolation_choice.outcome) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["transitions", finalTransitionIndex, "details", "isolationMode"],
        message: "Completed transition isolation mode must match the current isolation decision.",
      });
    }
    const diffHash = current.diff_review?.outcome === "approved"
      ? current.diff_review.evidence.diffHash
      : null;
    const commitDiffHash = current.commit_approval?.outcome === "approved"
      ? current.commit_approval.evidence.diffHash
      : null;
    if (!diffHash || details.diffHash !== diffHash || commitDiffHash !== diffHash) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["transitions", finalTransitionIndex, "details", "diffHash"],
        message: "Completed transition diff hash must match both review and commit approval evidence.",
      });
    }
    const validationChecks = current.validation_approval?.outcome === "approved"
      ? current.validation_approval.evidence.checks.map((check: { name: string }) => check.name).sort()
      : [];
    if (hashPayload(details.validationChecks) !== hashPayload(validationChecks)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["transitions", finalTransitionIndex, "details", "validationChecks"],
        message: "Completed transition validation checks must match current validation evidence.",
      });
    }
    if (current.push_authorization
      && details.pushDecision !== current.push_authorization.outcome) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["transitions", finalTransitionIndex, "details", "pushDecision"],
        message: "Completed transition push disposition must match the current authorization decision.",
      });
    }
    if (current.pull_request_request
      && details.pullRequestDecision !== current.pull_request_request.outcome) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["transitions", finalTransitionIndex, "details", "pullRequestDecision"],
        message: "Completed transition pull-request disposition must match the current request decision.",
      });
    }
  }
});
