import { z } from "zod";

export const REDESIGN_STAGES = [
  "connect_inspect",
  "document_current_state",
  "pm_interview",
  "future_state_proposal",
  "design",
  "handoff",
  "approved_implementation",
] as const;

export type RedesignStage = (typeof REDESIGN_STAGES)[number];

export const REDESIGN_ARTIFACT_COLLECTIONS = {
  connect_inspect: ["inventory", "source_connections", "constraints"],
  document_current_state: [
    "inventory",
    "navigation",
    "roles",
    "accessibility_findings",
    "localization_findings",
  ],
  pm_interview: ["business_goals", "business_rules", "constraints", "decisions", "open_questions"],
  future_state_proposal: [
    "principles",
    "target_system",
    "token_proposals",
    "component_consolidation",
    "screen_plans",
    "migration_phases",
    "engineering_epics",
    "risks",
    "open_questions",
  ],
  design: [
    "screen_plans",
    "token_proposals",
    "component_consolidation",
    "accessibility_findings",
    "localization_findings",
    "review_findings",
  ],
  handoff: ["migration_phases", "engineering_epics", "acceptance_criteria", "risks", "open_questions"],
  approved_implementation: [
    "approved_scope",
    "implementation_conditions",
    "validation_evidence",
    "risks",
    "open_questions",
  ],
} as const satisfies Record<RedesignStage, readonly string[]>;

export type RedesignArtifactCollectionKey =
  (typeof REDESIGN_ARTIFACT_COLLECTIONS)[RedesignStage][number];

export const RedesignArtifactItemIdSchema = z.string().regex(
  /^redesign_item_[A-Za-z0-9][A-Za-z0-9_-]{7,}$/,
  "Invalid redesign artifact item id",
);

export const RedesignArtifactItemSchema = z.object({
  id: RedesignArtifactItemIdSchema,
  title: z.string().trim().min(1).max(240),
  description: z.string().max(8_000).default(""),
  status: z.enum(["draft", "ready", "reviewed", "approved", "blocked", "resolved"]).default("draft"),
  priority: z.enum(["low", "normal", "high", "critical"]).default("normal"),
  owner: z.string().trim().min(1).max(240).optional(),
  evidence: z.array(z.string().trim().min(1).max(2_000)).max(100).default([]),
  linked_ids: z.array(z.string().trim().min(1).max(240)).max(200).default([]),
}).strict();

export type RedesignArtifactItem = z.infer<typeof RedesignArtifactItemSchema>;

const artifactList = z.array(RedesignArtifactItemSchema).max(500).default([]);
const artifactBase = {
  schema_version: z.literal(1),
  summary: z.string().max(20_000).default(""),
  review_status: z.enum(["draft", "ready_for_review", "reviewed", "approved"]).default("draft"),
};

const ConnectInspectArtifactSchema = z.object({
  ...artifactBase,
  stage: z.literal("connect_inspect"),
  inventory: artifactList,
  source_connections: artifactList,
  constraints: artifactList,
}).strict();

const DocumentCurrentStateArtifactSchema = z.object({
  ...artifactBase,
  stage: z.literal("document_current_state"),
  inventory: artifactList,
  navigation: artifactList,
  roles: artifactList,
  accessibility_findings: artifactList,
  localization_findings: artifactList,
}).strict();

const PmInterviewArtifactSchema = z.object({
  ...artifactBase,
  stage: z.literal("pm_interview"),
  business_goals: artifactList,
  business_rules: artifactList,
  constraints: artifactList,
  decisions: artifactList,
  open_questions: artifactList,
}).strict();

const FutureStateProposalArtifactSchema = z.object({
  ...artifactBase,
  stage: z.literal("future_state_proposal"),
  principles: artifactList,
  target_system: artifactList,
  token_proposals: artifactList,
  component_consolidation: artifactList,
  screen_plans: artifactList,
  migration_phases: artifactList,
  engineering_epics: artifactList,
  risks: artifactList,
  open_questions: artifactList,
}).strict();

const DesignArtifactSchema = z.object({
  ...artifactBase,
  stage: z.literal("design"),
  screen_plans: artifactList,
  token_proposals: artifactList,
  component_consolidation: artifactList,
  accessibility_findings: artifactList,
  localization_findings: artifactList,
  review_findings: artifactList,
}).strict();

const HandoffArtifactSchema = z.object({
  ...artifactBase,
  stage: z.literal("handoff"),
  migration_phases: artifactList,
  engineering_epics: artifactList,
  acceptance_criteria: artifactList,
  risks: artifactList,
  open_questions: artifactList,
}).strict();

const ApprovedImplementationArtifactSchema = z.object({
  ...artifactBase,
  stage: z.literal("approved_implementation"),
  approved_scope: artifactList,
  implementation_conditions: artifactList,
  validation_evidence: artifactList,
  risks: artifactList,
  open_questions: artifactList,
}).strict();

export const RedesignStageArtifactSchema = z.discriminatedUnion("stage", [
  ConnectInspectArtifactSchema,
  DocumentCurrentStateArtifactSchema,
  PmInterviewArtifactSchema,
  FutureStateProposalArtifactSchema,
  DesignArtifactSchema,
  HandoffArtifactSchema,
  ApprovedImplementationArtifactSchema,
]).superRefine((artifact, context) => {
  const collections = REDESIGN_ARTIFACT_COLLECTIONS[artifact.stage];
  const record = artifact as unknown as Record<string, unknown>;
  const ids = new Set<string>();
  for (const collection of collections) {
    const items = record[collection] as RedesignArtifactItem[];
    if (artifact.review_status !== "draft" && items.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [collection],
        message: `${collection} must explicitly record an outcome before review`,
      });
    }
    for (const item of items) {
      if (ids.has(item.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [collection],
          message: `Duplicate redesign artifact item id: ${item.id}`,
        });
      }
      ids.add(item.id);
    }
  }
});

export type RedesignStageArtifact = z.infer<typeof RedesignStageArtifactSchema>;

export type RedesignStageReviewRequirement = "reviewed" | "approved";

export interface RedesignStageReadinessDiagnostic {
  code:
    | "REDESIGN_STAGE_ARTIFACT_INVALID"
    | "REDESIGN_STAGE_OUTCOME_REQUIRED"
    | "REDESIGN_STAGE_ITEM_BLOCKED"
    | "REDESIGN_STAGE_ITEM_REVIEW_REQUIRED"
    | "REDESIGN_STAGE_ITEM_APPROVAL_REQUIRED"
    | "REDESIGN_STAGE_REVIEW_REQUIRED"
    | "REDESIGN_STAGE_APPROVAL_REQUIRED";
  severity: "error";
  message: string;
  stage: RedesignStage | null;
  path: string;
  collection?: RedesignArtifactCollectionKey;
  itemId?: string;
  itemStatus?: string;
  itemPriority?: string;
  reviewStatus?: string;
  requiredReviewStatus?: RedesignStageReviewRequirement;
}

export interface RedesignStageReadiness {
  ready: boolean;
  stage: RedesignStage | null;
  requirement: RedesignStageReviewRequirement;
  diagnostics: RedesignStageReadinessDiagnostic[];
}

export function evaluateRedesignStageReadiness(
  value: unknown,
  requirement: RedesignStageReviewRequirement,
): RedesignStageReadiness {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const stageResult = z.enum(REDESIGN_STAGES).safeParse(record.stage);
  const stage = stageResult.success ? stageResult.data : null;
  const diagnostics: RedesignStageReadinessDiagnostic[] = [];

  if (stage) {
    for (const collection of REDESIGN_ARTIFACT_COLLECTIONS[stage]) {
      const items = record[collection];
      if (!Array.isArray(items) || items.length === 0) {
        diagnostics.push({
          code: "REDESIGN_STAGE_OUTCOME_REQUIRED",
          severity: "error",
          message: `${collection} must explicitly record an outcome before this transition.`,
          stage,
          path: collection,
          collection,
        });
        continue;
      }
      items.forEach((candidate, index) => {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return;
        const item = candidate as Record<string, unknown>;
        const itemId = typeof item.id === "string" ? item.id : undefined;
        const itemStatus = typeof item.status === "string" ? item.status : undefined;
        const itemPriority = typeof item.priority === "string" ? item.priority : undefined;
        const path = `${collection}.${index}.status`;
        if (itemStatus === "blocked") {
          diagnostics.push({
            code: "REDESIGN_STAGE_ITEM_BLOCKED",
            severity: "error",
            message: `${collection} contains a blocked outcome that must be resolved before this transition.`,
            stage,
            path,
            collection,
            ...(itemId === undefined ? {} : { itemId }),
            itemStatus,
            ...(itemPriority === undefined ? {} : { itemPriority }),
            requiredReviewStatus: requirement,
          });
          return;
        }
        const itemReady = requirement === "approved"
          ? itemStatus === "approved" || itemStatus === "resolved"
          : itemStatus === "reviewed" || itemStatus === "approved" || itemStatus === "resolved";
        if (itemReady) return;
        diagnostics.push({
          code: requirement === "approved"
            ? "REDESIGN_STAGE_ITEM_APPROVAL_REQUIRED"
            : "REDESIGN_STAGE_ITEM_REVIEW_REQUIRED",
          severity: "error",
          message: requirement === "approved"
            ? `${collection} contains an outcome that must be approved or resolved before this transition.`
            : `${collection} contains an outcome that must be reviewed, approved, or resolved before this transition.`,
          stage,
          path,
          collection,
          ...(itemId === undefined ? {} : { itemId }),
          ...(itemStatus === undefined ? {} : { itemStatus }),
          ...(itemPriority === undefined ? {} : { itemPriority }),
          requiredReviewStatus: requirement,
        });
      });
    }
  }

  const parsed = RedesignStageArtifactSchema.safeParse(value);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path.join(".");
      if (diagnostics.some((diagnostic) => diagnostic.path === path)) continue;
      diagnostics.push({
        code: "REDESIGN_STAGE_ARTIFACT_INVALID",
        severity: "error",
        message: issue.message,
        stage,
        path,
      });
    }
  }

  const reviewStatus = typeof record.review_status === "string" ? record.review_status : undefined;
  const reviewReady = requirement === "approved"
    ? reviewStatus === "approved"
    : reviewStatus === "reviewed" || reviewStatus === "approved";
  if (!reviewReady) {
    diagnostics.push({
      code: requirement === "approved"
        ? "REDESIGN_STAGE_APPROVAL_REQUIRED"
        : "REDESIGN_STAGE_REVIEW_REQUIRED",
      severity: "error",
      message: requirement === "approved"
        ? "The current stage artifact must be approved before this transition."
        : "The current stage artifact must be reviewed or approved before advancing.",
      stage,
      path: "review_status",
      ...(reviewStatus === undefined ? {} : { reviewStatus }),
      requiredReviewStatus: requirement,
    });
  }

  return {
    ready: parsed.success && diagnostics.length === 0,
    stage,
    requirement,
    diagnostics,
  };
}

export const RedesignStageArtifactMapSchema = z.object({
  connect_inspect: RedesignStageArtifactSchema.optional(),
  document_current_state: RedesignStageArtifactSchema.optional(),
  pm_interview: RedesignStageArtifactSchema.optional(),
  future_state_proposal: RedesignStageArtifactSchema.optional(),
  design: RedesignStageArtifactSchema.optional(),
  handoff: RedesignStageArtifactSchema.optional(),
  approved_implementation: RedesignStageArtifactSchema.optional(),
}).strict().superRefine((artifacts, context) => {
  for (const stage of REDESIGN_STAGES) {
    const artifact = artifacts[stage];
    if (artifact && artifact.stage !== stage) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [stage, "stage"],
        message: `Artifact stored under ${stage} must use the same stage discriminator`,
      });
    }
  }
});

export type RedesignStageArtifactMap = z.infer<typeof RedesignStageArtifactMapSchema>;

export function createEmptyRedesignStageArtifact(stage: RedesignStage): RedesignStageArtifact {
  return RedesignStageArtifactSchema.parse({ schema_version: 1, stage });
}

export function redesignArtifactItems(
  artifact: RedesignStageArtifact,
  collection: RedesignArtifactCollectionKey,
): RedesignArtifactItem[] {
  const value = (artifact as unknown as Record<string, unknown>)[collection];
  return Array.isArray(value) ? value as RedesignArtifactItem[] : [];
}
