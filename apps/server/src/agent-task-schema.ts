import {
  AgentTaskResolvedContextSchema,
  NodeIdSchema,
  ProductIdSchema,
  ProductIdentitySchema,
} from "@designer/core";
import { z } from "zod";

import { BoundedJsonObjectSchema } from "./bounded-json-schema.js";
import { DesignReadinessReportSchema } from "./design-readiness.js";

export const AGENT_TASK_EXPECTED_OUTPUTS = [
  "design_preview",
  "design_commit",
  "product_spec_preview",
  "product_spec_commit",
] as const;
export type AgentTaskExpectedOutput = (typeof AGENT_TASK_EXPECTED_OUTPUTS)[number];

export const AGENT_TASK_STATUSES = [
  "queued",
  "claimed",
  "in_progress",
  "awaiting_approval",
  "completed",
  "failed",
  "cancelled",
  "expired",
] as const;
export type AgentTaskStatus = (typeof AGENT_TASK_STATUSES)[number];

export const AgentTaskExpectedOutputSchema = z.enum(AGENT_TASK_EXPECTED_OUTPUTS);
export const AgentTaskStatusSchema = z.enum(AGENT_TASK_STATUSES);
export const AgentTaskSelectionSchema = z.array(NodeIdSchema).max(500);
export const McpAgentTaskSelectionConfirmationSchema = z.object({
  source: z.enum(["user_confirmed", "exact_project_link"]),
  product_id: ProductIdSchema,
  product_name: z.string().trim().min(1).max(255),
  design_id: z.string().trim().min(1).max(240),
  design_name: z.string().trim().min(1).max(255),
  base_version: z.number().int().positive().max(1_000_000_000),
}).strict();

const taskArtifactIdentifier = z.string().trim().min(1).max(240);
const transitionMessage = z.string().trim().max(4_000).optional();

export const AgentTaskCompletionSchemas = {
  design_preview: z.object({
    previewId: taskArtifactIdentifier,
    readiness: DesignReadinessReportSchema,
  }).strict(),
  design_commit: z.object({ revisionId: taskArtifactIdentifier }).strict(),
  product_spec_preview: z.object({ previewId: taskArtifactIdentifier }).strict(),
  product_spec_commit: z.object({ version: z.number().int().positive().max(1_000_000_000) }).strict(),
} satisfies Record<AgentTaskExpectedOutput, z.ZodTypeAny>;

export const AgentTaskCompletionDataSchema = z.union([
  AgentTaskCompletionSchemas.design_preview,
  AgentTaskCompletionSchemas.design_commit,
  AgentTaskCompletionSchemas.product_spec_preview,
  AgentTaskCompletionSchemas.product_spec_commit,
]);

export const AgentTaskTransitionDataSchema = BoundedJsonObjectSchema;

function taskTransitionVariant<Status extends Exclude<AgentTaskStatus, "queued" | "claimed">>(
  status: Status,
  data: z.ZodTypeAny,
  extraShape: z.ZodRawShape = {},
) {
  return z.object({
    expectedStatus: AgentTaskStatusSchema,
    toStatus: z.literal(status),
    message: transitionMessage,
    data,
    ...extraShape,
  }).strict();
}

export const AgentTaskTransitionRequestSchema = z.discriminatedUnion("toStatus", [
  taskTransitionVariant("in_progress", AgentTaskTransitionDataSchema.optional()),
  taskTransitionVariant("awaiting_approval", AgentTaskCompletionDataSchema),
  taskTransitionVariant("completed", AgentTaskCompletionDataSchema),
  taskTransitionVariant("failed", AgentTaskTransitionDataSchema.optional()),
  taskTransitionVariant("cancelled", AgentTaskTransitionDataSchema.optional(), {
    idempotencyKey: z.string().trim().min(8).max(240).optional(),
  }),
  taskTransitionVariant("expired", AgentTaskTransitionDataSchema.optional()),
]);

export const McpAgentTaskTransitionRequestSchema = z.discriminatedUnion("to_status", [
  z.object({
    task_id: taskArtifactIdentifier,
    expected_status: AgentTaskStatusSchema,
    to_status: z.literal("in_progress"),
    message: transitionMessage,
    data: AgentTaskTransitionDataSchema.optional(),
  }).strict(),
  z.object({
    task_id: taskArtifactIdentifier,
    expected_status: AgentTaskStatusSchema,
    to_status: z.literal("awaiting_approval"),
    message: transitionMessage,
    data: AgentTaskCompletionDataSchema,
  }).strict(),
  z.object({
    task_id: taskArtifactIdentifier,
    expected_status: AgentTaskStatusSchema,
    to_status: z.literal("completed"),
    message: transitionMessage,
    data: AgentTaskCompletionDataSchema,
  }).strict(),
  z.object({
    task_id: taskArtifactIdentifier,
    expected_status: AgentTaskStatusSchema,
    to_status: z.literal("failed"),
    message: transitionMessage,
    data: AgentTaskTransitionDataSchema.optional(),
  }).strict(),
  z.object({
    task_id: taskArtifactIdentifier,
    expected_status: AgentTaskStatusSchema,
    to_status: z.literal("cancelled"),
    message: transitionMessage,
    data: AgentTaskTransitionDataSchema.optional(),
  }).strict(),
  z.object({
    task_id: taskArtifactIdentifier,
    expected_status: AgentTaskStatusSchema,
    to_status: z.literal("expired"),
    message: transitionMessage,
    data: AgentTaskTransitionDataSchema.optional(),
  }).strict(),
]);

// MCP SDK 1.29 validates the discriminated union at runtime but needs a
// representative object shape to advertise its fields in tools/list.
Object.defineProperty(McpAgentTaskTransitionRequestSchema, "shape", {
  value: {
    task_id: taskArtifactIdentifier,
    expected_status: AgentTaskStatusSchema,
    to_status: z.enum(["in_progress", "awaiting_approval", "completed", "failed", "cancelled", "expired"]),
    message: transitionMessage,
    data: AgentTaskTransitionDataSchema.optional(),
  },
  enumerable: false,
});

export type AgentTaskTransitionRequest = z.infer<typeof AgentTaskTransitionRequestSchema>;

export const AgentTaskTransitionResultSchema = z.object({
  id: taskArtifactIdentifier,
  fromStatus: AgentTaskStatusSchema.nullable(),
  toStatus: AgentTaskStatusSchema,
  actorId: taskArtifactIdentifier,
  message: z.string().max(4_000).nullable(),
  data: AgentTaskTransitionDataSchema,
  createdAt: z.string().datetime({ offset: true }),
}).strict();

export const AgentTaskResultSchema = z.object({
  id: taskArtifactIdentifier,
  product: ProductIdentitySchema,
  designId: taskArtifactIdentifier,
  brief: z.string().trim().min(1).max(100_000),
  selection: AgentTaskSelectionSchema,
  baseVersion: z.number().int().positive().max(1_000_000_000),
  expectedOutput: AgentTaskExpectedOutputSchema,
  status: AgentTaskStatusSchema,
  claimedBy: taskArtifactIdentifier.nullable(),
  createdBy: taskArtifactIdentifier,
  createdAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  resolvedContext: AgentTaskResolvedContextSchema.nullable(),
  readiness: DesignReadinessReportSchema.nullable(),
  transitions: z.array(AgentTaskTransitionResultSchema).max(10_000),
}).strict();
