import {
  REDESIGN_STAGES,
  RedesignStageArtifactMapSchema,
  RedesignStageArtifactSchema,
} from "@designer/core";
import { z } from "zod";

import {
  BoundedJsonObjectSchema,
  McpJsonObjectOutputSchema,
} from "./bounded-json-schema.js";

const identifier = z.string().trim().min(1).max(240);
const positiveVersion = z.number().int().positive().max(1_000_000_000);
const redesignStage = z.enum(REDESIGN_STAGES);
const redesignMutationDecision = z.enum(["advanced", "returned", "approved", "cancelled", "completed"]);
const redesignDecision = z.enum(["created", "advanced", "returned", "approved", "cancelled", "completed"]);

export const RedesignContentSchema = BoundedJsonObjectSchema;
export const RedesignTransitionDetailsSchema = BoundedJsonObjectSchema;

export const RedesignAssessmentCreateRequestSchema = z.object({
  designId: identifier.optional(),
  inventoryId: identifier.optional(),
  expectedDesignVersion: positiveVersion.optional(),
  brief: z.string().trim().min(1).max(10_000),
  content: RedesignContentSchema.optional(),
}).strict();

export const McpRedesignAssessmentCreateRequestSchema = z.object({
  design_id: identifier.optional(),
  inventory_id: identifier.optional(),
  expected_design_version: positiveVersion.optional(),
  brief: z.string().trim().min(1).max(10_000),
  content: RedesignContentSchema.optional(),
}).strict();

export const RedesignStageRevisionRequestSchema = z.object({
  expectedVersion: positiveVersion,
  expectedDesignVersion: positiveVersion.optional(),
  content: RedesignContentSchema,
}).strict();

export const McpRedesignStageRevisionRequestSchema = z.object({
  assessment_id: identifier,
  expected_version: positiveVersion,
  expected_design_version: positiveVersion.optional(),
  content: RedesignContentSchema,
}).strict();

function redesignTransitionVariant<Decision extends z.infer<typeof redesignMutationDecision>>(
  decision: Decision,
) {
  return z.object({
    expectedVersion: positiveVersion,
    expectedDesignVersion: positiveVersion.optional(),
    toStage: redesignStage,
    decision: z.literal(decision),
    content: RedesignContentSchema.optional(),
    details: RedesignTransitionDetailsSchema.optional(),
  }).strict();
}

export const RedesignStageTransitionRequestSchema = z.discriminatedUnion("decision", [
  redesignTransitionVariant("advanced"),
  redesignTransitionVariant("returned"),
  redesignTransitionVariant("approved"),
  redesignTransitionVariant("cancelled"),
  redesignTransitionVariant("completed"),
]);

function mcpRedesignTransitionVariant<Decision extends z.infer<typeof redesignMutationDecision>>(
  decision: Decision,
) {
  return z.object({
    assessment_id: identifier,
    expected_version: positiveVersion,
    expected_design_version: positiveVersion.optional(),
    to_stage: redesignStage,
    decision: z.literal(decision),
    content: RedesignContentSchema.optional(),
    details: RedesignTransitionDetailsSchema.optional(),
  }).strict();
}

export const McpRedesignStageTransitionRequestSchema = z.discriminatedUnion("decision", [
  mcpRedesignTransitionVariant("advanced"),
  mcpRedesignTransitionVariant("returned"),
  mcpRedesignTransitionVariant("approved"),
  mcpRedesignTransitionVariant("cancelled"),
  mcpRedesignTransitionVariant("completed"),
]);

// MCP SDK 1.29 uses this representative shape for tools/list while retaining
// the exact discriminated-union parser for tools/call.
Object.defineProperty(McpRedesignStageTransitionRequestSchema, "shape", {
  value: {
    assessment_id: identifier,
    expected_version: positiveVersion,
    expected_design_version: positiveVersion.optional(),
    to_stage: redesignStage,
    decision: redesignMutationDecision,
    content: RedesignContentSchema.optional(),
    details: RedesignTransitionDetailsSchema.optional(),
  },
  enumerable: false,
});

const redesignBaseSchema = z.object({
  designVersion: positiveVersion.nullable(),
  revisionId: identifier.nullable(),
  inventoryId: identifier.nullable(),
}).strict();

export const RedesignVersionResultSchema = z.object({
  version: positiveVersion,
  stage: redesignStage,
  sourceMutation: z.literal("none"),
  brief: z.string().trim().min(1).max(10_000),
  base: redesignBaseSchema,
  content: McpJsonObjectOutputSchema,
  artifact: RedesignStageArtifactSchema,
  actorId: identifier,
  createdAt: z.string().datetime({ offset: true }),
}).strict();

export const RedesignTransitionResultSchema = z.object({
  id: identifier,
  fromStage: redesignStage.nullable(),
  toStage: redesignStage,
  decision: redesignDecision,
  details: McpJsonObjectOutputSchema,
  actorId: identifier,
  createdAt: z.string().datetime({ offset: true }),
}).strict();

export const RedesignAssessmentResultSchema: z.ZodTypeAny = z.object({
  id: identifier,
  organizationId: identifier,
  designId: identifier.nullable(),
  inventoryId: identifier.nullable(),
  status: z.enum(["active", "completed", "cancelled"]),
  currentStage: redesignStage,
  currentVersion: positiveVersion,
  sourceMutation: z.literal("none"),
  createdBy: identifier,
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  current: RedesignVersionResultSchema,
  stageArtifacts: RedesignStageArtifactMapSchema,
  versions: z.array(RedesignVersionResultSchema).max(25_000),
  transitions: z.array(RedesignTransitionResultSchema).max(25_000),
}).strict();

export const RedesignStageArtifactVersionResultSchema = z.object({
  assessmentVersion: positiveVersion,
  stage: redesignStage,
  artifact: RedesignStageArtifactSchema,
  actorId: identifier,
  createdAt: z.string().datetime({ offset: true }),
}).strict();

export const RedesignStageArtifactResultSchema = z.object({
  assessmentId: identifier,
  stage: redesignStage,
  headVersion: positiveVersion,
  sourceMutation: z.literal("none"),
  current: RedesignStageArtifactVersionResultSchema.nullable(),
  versions: z.array(RedesignStageArtifactVersionResultSchema).max(25_000),
}).strict();
