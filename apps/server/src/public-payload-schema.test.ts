import { afterEach, describe, expect, it } from "vitest";

import {
  AgentTaskResultSchema,
  AgentTaskTransitionRequestSchema,
  McpAgentTaskTransitionRequestSchema,
} from "./agent-task-schema.js";
import {
  BoundedJsonObjectSchema,
  PUBLIC_INPUT_JSON_LIMITS,
} from "./bounded-json-schema.js";
import { DesignerDatabase } from "./db/database.js";
import { EventHub } from "./events.js";
import {
  McpRedesignStageTransitionRequestSchema,
  RedesignAssessmentResultSchema,
  RedesignStageTransitionRequestSchema,
} from "./redesign-public-schema.js";
import { RedesignStudioService } from "./redesign-studio-service.js";
import { DesignerService } from "./service.js";

const databases: DesignerDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function nestedObject(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = { leaf: true };
  for (let index = 0; index < depth; index += 1) value = { child: value };
  return value;
}

describe("bounded public JSON payloads", () => {
  it("preserves JSON-object compatibility while rejecting non-JSON and structurally excessive values", () => {
    expect(BoundedJsonObjectSchema.safeParse({
      objective: "Document before proposing",
      oneClick: true,
      findings: [{ id: "finding_1", severity: 2 }],
      nullable: null,
    }).success).toBe(true);

    expect(BoundedJsonObjectSchema.safeParse({ invalid: undefined }).success).toBe(false);
    expect(BoundedJsonObjectSchema.safeParse({ invalid: new Date() }).success).toBe(false);
    expect(BoundedJsonObjectSchema.safeParse(nestedObject(PUBLIC_INPUT_JSON_LIMITS.maximumDepth + 1)).success).toBe(false);
    expect(BoundedJsonObjectSchema.safeParse({
      items: Array.from({ length: PUBLIC_INPUT_JSON_LIMITS.maximumArrayItems + 1 }, () => null),
    }).success).toBe(false);
  });

  it("uses discriminated task transitions and exact completion references", () => {
    expect(AgentTaskTransitionRequestSchema.safeParse({
      expectedStatus: "claimed",
      toStatus: "in_progress",
      data: { checkpoint: "context_read", progress: 25 },
    }).success).toBe(true);
    expect(McpAgentTaskTransitionRequestSchema.safeParse({
      task_id: "task_payloadschema0001",
      expected_status: "in_progress",
      to_status: "awaiting_approval",
      data: { previewId: "preview_payloadschema0001" },
    }).success).toBe(true);

    expect(AgentTaskTransitionRequestSchema.safeParse({
      expectedStatus: "in_progress",
      toStatus: "completed",
    }).success).toBe(false);
    expect(McpAgentTaskTransitionRequestSchema.safeParse({
      task_id: "task_payloadschema0001",
      expected_status: "in_progress",
      to_status: "completed",
      data: { previewId: "preview_payloadschema0001", unexpected: true },
    }).success).toBe(false);
  });

  it("uses discriminated redesign transitions with bounded legacy content bags", () => {
    expect(RedesignStageTransitionRequestSchema.safeParse({
      expectedVersion: 2,
      expectedDesignVersion: 1,
      toStage: "document_current_state",
      decision: "advanced",
      content: { summary: "Started current-state documentation" },
      details: { reviewedBy: "product_manager" },
    }).success).toBe(true);
    expect(McpRedesignStageTransitionRequestSchema.safeParse({
      assessment_id: "redesign_payloadschema0001",
      expected_version: 2,
      expected_design_version: 1,
      to_stage: "connect_inspect",
      decision: "cancelled",
      details: { reason: "Scope changed" },
    }).success).toBe(true);

    expect(RedesignStageTransitionRequestSchema.safeParse({
      expectedVersion: 2,
      toStage: "document_current_state",
      decision: "advanced",
      content: nestedObject(PUBLIC_INPUT_JSON_LIMITS.maximumDepth + 1),
    }).success).toBe(false);
    expect(McpRedesignStageTransitionRequestSchema.safeParse({
      assessment_id: "redesign_payloadschema0001",
      expected_version: 2,
      to_stage: "document_current_state",
      decision: "advanced",
      unexpected: true,
    }).success).toBe(false);
  });
});

describe("exact task and redesign MCP result payloads", () => {
  it("rejects undeclared task fields at nested DTO boundaries", () => {
    const task = {
      id: "task_payloadschema0001",
      designId: "document_payloadschema0001",
      brief: "Create a bounded preview",
      selection: [],
      baseVersion: 1,
      expectedOutput: "design_preview",
      status: "queued",
      claimedBy: null,
      createdBy: "principal_local",
      createdAt: "2026-07-21T00:00:00.000Z",
      expiresAt: "2026-07-22T00:00:00.000Z",
      transitions: [{
        id: "transition_payloadschema0001",
        fromStatus: null,
        toStatus: "queued",
        actorId: "principal_local",
        message: "Task created",
        data: {},
        createdAt: "2026-07-21T00:00:00.000Z",
      }],
    };
    expect(AgentTaskResultSchema.safeParse(task).success).toBe(true);
    expect(AgentTaskResultSchema.safeParse({ ...task, unexpected: true }).success).toBe(false);
    expect(AgentTaskResultSchema.safeParse({
      ...task,
      transitions: [{ ...task.transitions[0], unexpected: true }],
    }).success).toBe(false);
  });

  it("accepts a real assessment result and rejects undeclared assessment fields", () => {
    const database = new DesignerDatabase(":memory:");
    databases.push(database);
    const designer = new DesignerService(database, new EventHub(), 900);
    const design = designer.createDesign("local", {
      name: "Redesign result schema",
      preset: "web",
      idempotencyKey: "redesign-result-schema-create",
    });
    const redesign = new RedesignStudioService(database, {
      now: () => new Date("2026-07-21T00:00:00.000Z"),
    });
    const assessment = redesign.createOneClickAssessment("local", {
      designId: design.document.id,
      expectedDesignVersion: 1,
      brief: "Verify the exact Redesign Studio result DTO.",
      content: { objective: "Keep the source immutable" },
    });

    expect(RedesignAssessmentResultSchema.safeParse(assessment).success).toBe(true);
    expect(RedesignAssessmentResultSchema.safeParse({ ...assessment, unexpected: true }).success).toBe(false);
  });
});
