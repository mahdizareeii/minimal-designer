import type { FastifyInstance } from "fastify";
import { PLANNING_SECTIONS } from "@designer/core";
import { z } from "zod";

import { AgentTaskTransitionRequestSchema } from "./agent-task-schema.js";
import { agentTaskCodexLaunchUrl } from "./agent-task-launch.js";
import {
  AGENT_CONNECTION_SCOPES,
  AGENT_TASK_EXPECTED_OUTPUTS,
  AGENT_TASK_STATUSES,
  type EnterpriseService,
  type ProductSpecificationPreviewResult,
  type ProductSpecificationResult,
} from "./enterprise-service.js";

const identifier = z.string().trim().min(1).max(240);
const idempotencyKey = z.string().trim().min(8).max(240);
const designParams = z.object({ id: identifier }).strict();
const taskParams = z.object({ taskId: identifier }).strict();
const sessionParams = z.object({ sessionId: identifier }).strict();
const connectionParams = z.object({ connectionId: identifier }).strict();
const planningSection = z.enum(PLANNING_SECTIONS);

function specificationResponse(result: ProductSpecificationResult): Record<string, unknown> {
  return {
    ...result,
    naturalLanguageBrief: result.specification.natural_language_brief,
  };
}

function specificationPreviewResponse(result: ProductSpecificationPreviewResult): Record<string, unknown> {
  return {
    ...result,
    previewId: result.id,
    version: result.resultVersion,
    naturalLanguageBrief: result.specification.natural_language_brief,
  };
}

export function registerEnterpriseHttpRoutes(
  app: FastifyInstance,
  enterprise: EnterpriseService,
): void {
  app.get("/api/designs/:id/product-specification", async (request) => {
    const { id } = designParams.parse(request.params);
    const query = z.object({ version: z.coerce.number().int().positive().optional() }).strict().parse(request.query);
    return specificationResponse(enterprise.readProductSpecification(request.actorId, id, query.version));
  });

  app.post("/api/designs/:id/product-specification/previews", async (request, reply) => {
    const { id } = designParams.parse(request.params);
    const input = z.object({
      baseVersion: z.number().int().nonnegative(),
      specification: z.unknown().optional(),
      naturalLanguageBrief: z.string().trim().min(1).max(100_000).optional(),
    }).strict().refine(
      (value) => (value.specification === undefined) !== (value.naturalLanguageBrief === undefined),
      { message: "Provide exactly one of specification or naturalLanguageBrief." },
    ).parse(request.body);
    const preview = enterprise.previewProductSpecification(request.actorId, {
      designId: id,
      baseVersion: input.baseVersion,
      ...(input.specification === undefined ? {} : { specification: input.specification }),
      ...(input.naturalLanguageBrief === undefined ? {} : { naturalLanguageBrief: input.naturalLanguageBrief }),
    });
    return reply.code(201).send(specificationPreviewResponse(preview));
  });

  app.get("/api/designs/:id/product-specification/previews/:previewId", async (request) => {
    const params = z.object({ id: identifier, previewId: identifier }).strict().parse(request.params);
    return specificationPreviewResponse(
      enterprise.readProductSpecificationPreview(request.actorId, params.id, params.previewId),
    );
  });

  app.post("/api/designs/:id/product-specification/previews/:previewId/commit", async (request) => {
    const params = z.object({ id: identifier, previewId: identifier }).strict().parse(request.params);
    const input = z.object({
      expectedBaseVersion: z.number().int().nonnegative(),
      idempotencyKey,
      message: z.string().trim().max(4_000).optional(),
    }).strict().parse(request.body);
    return specificationResponse(enterprise.commitProductSpecificationPreview(request.actorId, {
      designId: params.id,
      previewId: params.previewId,
      expectedBaseVersion: input.expectedBaseVersion,
      idempotencyKey: input.idempotencyKey,
      ...(input.message === undefined ? {} : { message: input.message }),
    }));
  });

  app.get("/api/designs/:id/planning-sessions", async (request) => {
    const rawId = (request.params as { id?: string }).id ?? "";
    enterprise.authorizePlanningSessionList(request.actorId, rawId);
    const { id } = designParams.parse(request.params);
    const query = z.object({ limit: z.coerce.number().int().min(1).max(100).optional() }).strict().parse(request.query);
    return { sessions: enterprise.listPlanningSessions(request.actorId, id, query.limit) };
  });

  app.post("/api/designs/:id/planning-sessions", async (request, reply) => {
    const rawId = (request.params as { id?: string }).id ?? "";
    enterprise.authorizePlanningSessionCreate(request.actorId, rawId);
    const { id } = designParams.parse(request.params);
    const input = z.object({ idempotencyKey }).strict().parse(request.body);
    return reply.code(201).send(enterprise.createPlanningSession(request.actorId, {
      designId: id,
      idempotencyKey: input.idempotencyKey,
    }));
  });

  app.get("/api/planning-sessions/:sessionId", async (request) => {
    const { sessionId } = sessionParams.parse(request.params);
    return enterprise.readPlanningSession(request.actorId, sessionId);
  });

  app.post("/api/planning-sessions/:sessionId/answers", async (request) => {
    const { sessionId } = sessionParams.parse(request.params);
    const input = z.object({
      expectedVersion: z.number().int().positive(),
      section: planningSection,
      answer: z.string().max(100_000),
      nextSection: planningSection.optional(),
      status: z.enum(["in_progress", "ready_for_review"]).optional(),
    }).strict().parse(request.body);
    return enterprise.savePlanningAnswer(request.actorId, sessionId, input);
  });

  app.post("/api/planning-sessions/:sessionId/transition", async (request) => {
    const { sessionId } = sessionParams.parse(request.params);
    const input = z.object({
      expectedVersion: z.number().int().positive(),
      status: z.enum(["draft", "in_progress", "ready_for_review", "completed", "cancelled"]),
      currentSection: planningSection.optional(),
    }).strict().parse(request.body);
    return enterprise.transitionPlanningSession(request.actorId, sessionId, input);
  });

  app.get("/api/designs/:id/agent-tasks", async (request) => {
    const rawId = (request.params as { id?: string }).id ?? "";
    enterprise.authorizeAgentTaskList(request.actorId, rawId);
    const { id } = designParams.parse(request.params);
    const query = z.object({
      status: z.enum(AGENT_TASK_STATUSES).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }).strict().parse(request.query);
    return { tasks: enterprise.listAgentTasks(request.actorId, { designId: id, ...query }) };
  });

  app.post("/api/designs/:id/agent-tasks", async (request, reply) => {
    const rawId = (request.params as { id?: string }).id ?? "";
    enterprise.authorizeAgentTaskCreate(request.actorId, rawId);
    const { id } = designParams.parse(request.params);
    const input = z.object({
      brief: z.string().trim().min(1).max(100_000),
      selection: z.array(identifier).max(500).default([]),
      baseVersion: z.number().int().positive(),
      expectedOutput: z.enum(AGENT_TASK_EXPECTED_OUTPUTS),
      idempotencyKey,
      expiresInSeconds: z.number().int().min(60).max(604_800).optional(),
    }).strict().parse(request.body);
    const task = enterprise.createAgentTask(request.actorId, {
      designId: id,
      ...input,
    });
    return reply.code(201).send({ task, launchUrl: agentTaskCodexLaunchUrl(task.id) });
  });

  app.get("/api/agent-tasks/:taskId", async (request) => {
    const { taskId } = taskParams.parse(request.params);
    const task = enterprise.readAgentTask(request.actorId, taskId);
    return { task, launchUrl: agentTaskCodexLaunchUrl(task.id) };
  });

  app.post("/api/agent-tasks/:taskId/claim", async (request) => {
    const { taskId } = taskParams.parse(request.params);
    return { task: enterprise.claimAgentTask(request.actorId, taskId) };
  });

  app.post("/api/agent-tasks/:taskId/transition", async (request) => {
    const { taskId } = taskParams.parse(request.params);
    const input = AgentTaskTransitionRequestSchema.parse(request.body);
    return { task: enterprise.transitionAgentTask(request.actorId, taskId, input) };
  });

  app.get("/api/agent-authorization-context", async (request, reply) => {
    reply.header("cache-control", "no-store");
    return enterprise.readOwnAuthorizationContext(request.actorId);
  });

  app.get("/api/agent-connections", async (request) => ({
    connections: enterprise.listAgentConnections(request.actorId),
  }));

  app.post("/api/agent-connections", async (request, reply) => {
    enterprise.authorizeAgentConnectionAdministration(request.actorId);
    const input = z.object({
      adapter: z.enum(["codex", "generic_mcp"]),
      displayName: z.string().trim().min(1).max(240),
      scopes: z.array(z.enum(AGENT_CONNECTION_SCOPES)).min(1).max(AGENT_CONNECTION_SCOPES.length),
      projectIds: z.array(identifier).max(100).optional(),
      expiresInSeconds: z.number().int().min(300).max(2_592_000).optional(),
      replaceExisting: z.boolean().optional(),
    }).strict().parse(request.body);
    return reply.code(201).send(enterprise.createAgentConnection(request.actorId, input));
  });

  app.post("/api/agent-connections/pair", async (request) => {
    const input = z.object({ nonce: z.string().min(1).max(200) }).strict().parse(request.body);
    return enterprise.pairAgentConnection(input.nonce);
  });

  app.post("/api/agent-connections/:connectionId/reconnect", async (request) => {
    enterprise.authorizeAgentConnectionAdministration(request.actorId);
    const { connectionId } = connectionParams.parse(request.params);
    return enterprise.renewAgentConnectionPairing(request.actorId, connectionId);
  });

  app.post("/api/agent-connections/:connectionId/revoke", async (request) => {
    enterprise.authorizeAgentConnectionAdministration(request.actorId);
    const { connectionId } = connectionParams.parse(request.params);
    return enterprise.revokeAgentConnection(request.actorId, connectionId);
  });
}
