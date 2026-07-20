import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { DesignSystemService } from "./design-system-service.js";
import {
  REDESIGN_STAGES,
  type RedesignStudioService,
} from "./redesign-studio-service.js";
import {
  CreateHandoffRequestSchema,
  HANDOFF_STATUSES,
  UpdateHandoffRequestSchema,
  type WorkspaceHandoffService,
} from "./workspace-handoff-service.js";

const identifier = z.string().trim().min(1).max(240);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const designSystemParams = z.object({ designSystemId: identifier }).strict();
const componentParams = z.object({ designSystemId: identifier, componentId: identifier }).strict();
const releaseParams = z.object({ releaseId: identifier }).strict();
const designParams = z.object({ id: identifier }).strict();
const upgradePreviewParams = z.object({ previewId: identifier }).strict();
const inventoryParams = z.object({ inventoryId: identifier }).strict();
const handoffParams = z.object({ handoffId: identifier }).strict();
const assessmentParams = z.object({ assessmentId: identifier }).strict();

export interface EnterpriseDomainHttpDependencies {
  designSystems: DesignSystemService;
  handoffs: WorkspaceHandoffService;
  redesign: RedesignStudioService;
}

export function registerEnterpriseDomainHttpRoutes(
  app: FastifyInstance,
  dependencies: EnterpriseDomainHttpDependencies,
): void {
  const { designSystems, handoffs, redesign } = dependencies;

  app.get("/api/design-systems", async (request) => {
    const query = z.object({ includeArchived: z.coerce.boolean().optional() }).strict().parse(request.query);
    return { designSystems: designSystems.listDesignSystems(request.actorId, query.includeArchived ?? false) };
  });

  app.post("/api/design-systems", async (request, reply) => {
    const body = z.object({
      name: z.string().trim().min(1).max(240),
      description: z.string().trim().max(10_000).optional(),
    }).strict().parse(request.body);
    return reply.code(201).send({ designSystem: designSystems.createDesignSystem(request.actorId, body) });
  });

  app.get("/api/design-systems/:designSystemId", async (request) => {
    const { designSystemId } = designSystemParams.parse(request.params);
    return { designSystem: designSystems.readDesignSystem(request.actorId, designSystemId) };
  });

  app.patch("/api/design-systems/:designSystemId", async (request) => {
    const { designSystemId } = designSystemParams.parse(request.params);
    const body = z.object({
      expectedUpdatedAt: z.string().datetime({ offset: true }),
      name: z.string().trim().min(1).max(240).optional(),
      description: z.string().trim().max(10_000).optional(),
      status: z.enum(["active", "archived"]).optional(),
    }).strict().parse(request.body);
    return { designSystem: designSystems.updateDesignSystem(request.actorId, designSystemId, body) };
  });

  app.post("/api/design-systems/:designSystemId/tokens", async (request, reply) => {
    const { designSystemId } = designSystemParams.parse(request.params);
    const body = z.object({
      expectedLatestVersion: z.number().int().nonnegative(),
      status: z.enum(["draft", "published", "deprecated"]),
      token: z.unknown(),
    }).strict().parse(request.body);
    return reply.code(201).send({ tokenVersion: designSystems.createTokenVersion(request.actorId, designSystemId, body) });
  });

  app.post("/api/design-systems/:designSystemId/components", async (request, reply) => {
    const { designSystemId } = designSystemParams.parse(request.params);
    const body = z.object({
      expectedLatestVersion: z.number().int().nonnegative(),
      definition: z.unknown(),
    }).strict().parse(request.body);
    return reply.code(201).send({ componentVersion: designSystems.createComponentVersion(request.actorId, designSystemId, body) });
  });

  app.get("/api/design-systems/:designSystemId/components", async (request) => {
    const { designSystemId } = designSystemParams.parse(request.params);
    const query = z.object({ includeHistory: z.enum(["true", "false"]).optional() }).strict().parse(request.query);
    return {
      components: designSystems.listComponentDefinitions(
        request.actorId,
        designSystemId,
        query.includeHistory === "true",
      ),
      permissions: designSystems.readComponentAuthoringPermission(request.actorId, designSystemId),
    };
  });

  app.post("/api/design-systems/:designSystemId/components/:componentId/lifecycle", async (request, reply) => {
    const { designSystemId, componentId } = componentParams.parse(request.params);
    const body = z.object({
      expectedLatestVersion: z.number().int().positive(),
      targetStatus: z.enum(["published", "deprecated"]),
      replacementComponentId: identifier.nullable().optional(),
    }).strict().parse(request.body);
    return reply.code(201).send({
      componentVersion: designSystems.transitionComponentLifecycle(
        request.actorId,
        designSystemId,
        componentId,
        body,
      ),
    });
  });

  app.get("/api/design-systems/:designSystemId/releases", async (request) => {
    const { designSystemId } = designSystemParams.parse(request.params);
    return { releases: designSystems.listReleases(request.actorId, designSystemId) };
  });

  app.post("/api/design-systems/:designSystemId/releases", async (request, reply) => {
    const { designSystemId } = designSystemParams.parse(request.params);
    const body = z.object({
      expectedLatestVersion: z.number().int().nonnegative(),
      name: z.string().trim().min(1).max(240),
      status: z.enum(["draft", "published", "deprecated"]),
      tokenVersions: z.array(z.object({ tokenId: identifier, version: z.number().int().positive() }).strict()).max(20_000),
      componentVersions: z.array(z.object({
        componentDefinitionId: identifier,
        version: z.number().int().positive(),
      }).strict()).max(5_000),
    }).strict().parse(request.body);
    return reply.code(201).send({ release: designSystems.createRelease(request.actorId, designSystemId, body) });
  });

  app.get("/api/design-system-releases/:releaseId", async (request) => {
    const { releaseId } = releaseParams.parse(request.params);
    return { release: designSystems.readRelease(request.actorId, releaseId) };
  });

  app.get("/api/designs/:id/design-system-pin", async (request) => {
    const { id } = designParams.parse(request.params);
    return { pin: designSystems.readProjectPin(request.actorId, id) };
  });

  app.put("/api/designs/:id/design-system-pin", async (request) => {
    const { id } = designParams.parse(request.params);
    const body = z.object({
      releaseId: identifier,
      expectedCurrentReleaseId: identifier.nullable(),
    }).strict().parse(request.body);
    return { pin: designSystems.pinProject(request.actorId, {
      designId: id,
      releaseId: body.releaseId,
      expectedCurrentReleaseId: body.expectedCurrentReleaseId,
    }) };
  });

  app.post("/api/designs/:id/design-system-upgrade-previews", async (request, reply) => {
    const { id } = designParams.parse(request.params);
    const body = z.object({ targetReleaseId: identifier }).strict().parse(request.body);
    return reply.code(201).send({ preview: designSystems.previewProjectUpgrade(request.actorId, {
      designId: id,
      targetReleaseId: body.targetReleaseId,
    }) });
  });

  app.get("/api/design-system-upgrade-previews/:previewId", async (request) => {
    const { previewId } = upgradePreviewParams.parse(request.params);
    return { preview: designSystems.readUpgradePreview(request.actorId, previewId) };
  });

  app.post("/api/design-system-upgrade-previews/:previewId/commit", async (request) => {
    const { previewId } = upgradePreviewParams.parse(request.params);
    const body = z.object({ expectedPreviewHash: sha256 }).strict().parse(request.body);
    return designSystems.commitProjectUpgrade(request.actorId, { previewId, expectedPreviewHash: body.expectedPreviewHash });
  });

  app.get("/api/repository-inventories", async (request) => {
    const query = z.object({
      repositoryFingerprint: sha256.optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }).strict().parse(request.query);
    return {
      inventories: handoffs.listRepositoryInventories(request.actorId, query).map((inventory) => ({
        id: inventory.id,
        repositoryFingerprint: inventory.repositoryFingerprint,
        inventoryHash: inventory.inventoryHash,
        status: inventory.status,
        platforms: inventory.inventory.platforms,
        entityCount: inventory.inventory.entities.length,
        scannedFileCount: inventory.inventory.scannedFileCount,
        skippedFileCount: inventory.inventory.skippedFileCount,
        truncated: inventory.inventory.truncated,
        createdBy: inventory.createdBy,
        createdAt: inventory.createdAt,
        revokedAt: inventory.revokedAt,
      })),
    };
  });

  app.post("/api/repository-inventories", async (request, reply) => (
    reply.code(201).send({ inventory: handoffs.persistRepositoryInventory(request.actorId, request.body) })
  ));

  app.get("/api/repository-inventories/:inventoryId", async (request) => {
    const { inventoryId } = inventoryParams.parse(request.params);
    return { inventory: handoffs.readRepositoryInventory(request.actorId, inventoryId) };
  });

  app.post("/api/repository-inventories/:inventoryId/revoke", async (request) => {
    const { inventoryId } = inventoryParams.parse(request.params);
    z.object({}).strict().parse(request.body ?? {});
    return { inventory: handoffs.revokeRepositoryInventory(request.actorId, inventoryId) };
  });

  app.get("/api/designs/:id/handoffs", async (request) => {
    const { id } = designParams.parse(request.params);
    const query = z.object({ limit: z.coerce.number().int().min(1).max(100).optional() }).strict().parse(request.query);
    return { handoffs: handoffs.listHandoffs(request.actorId, { designId: id, ...query }) };
  });

  app.post("/api/designs/:id/handoffs", async (request, reply) => {
    const { id } = designParams.parse(request.params);
    const body = CreateHandoffRequestSchema.omit({ designId: true }).parse(request.body);
    return reply.code(201).send({ handoff: handoffs.createHandoff(request.actorId, { designId: id, ...body }) });
  });

  app.get("/api/handoffs/:handoffId", async (request) => {
    const { handoffId } = handoffParams.parse(request.params);
    return { handoff: handoffs.readHandoff(request.actorId, handoffId) };
  });

  app.put("/api/handoffs/:handoffId", async (request) => {
    const { handoffId } = handoffParams.parse(request.params);
    const body = UpdateHandoffRequestSchema.parse(request.body);
    return { handoff: handoffs.updateHandoff(request.actorId, handoffId, body) };
  });

  app.post("/api/handoffs/:handoffId/submit-review", async (request) => {
    const { handoffId } = handoffParams.parse(request.params);
    const body = z.object({ expectedVersion: z.number().int().positive(), summary: z.string().trim().min(1).max(2_000) }).strict().parse(request.body);
    return { handoff: handoffs.submitHandoffForReview(request.actorId, handoffId, body) };
  });

  app.post("/api/handoffs/:handoffId/return-draft", async (request) => {
    const { handoffId } = handoffParams.parse(request.params);
    const body = z.object({ expectedVersion: z.number().int().positive(), reason: z.string().trim().min(1).max(2_000) }).strict().parse(request.body);
    return { handoff: handoffs.returnHandoffToDraft(request.actorId, handoffId, body) };
  });

  app.post("/api/handoffs/:handoffId/approve", async (request) => {
    const { handoffId } = handoffParams.parse(request.params);
    const body = z.object({
      expectedVersion: z.number().int().positive(),
      decision: z.literal("approved"),
      summary: z.string().trim().min(1).max(2_000),
      acceptanceCriteriaConfirmed: z.literal(true),
      implementationPlanConfirmed: z.literal(true),
    }).strict().parse(request.body);
    return { handoff: handoffs.approveHandoff(request.actorId, handoffId, body) };
  });

  app.post("/api/handoffs/:handoffId/start-implementation", async (request) => {
    const { handoffId } = handoffParams.parse(request.params);
    const body = z.object({
      expectedVersion: z.number().int().positive(),
      approvedVersion: z.number().int().positive(),
      authorization: z.literal("start_implementation"),
    }).strict().parse(request.body);
    return { handoff: handoffs.startHandoffImplementation(request.actorId, handoffId, body) };
  });

  app.post("/api/handoffs/:handoffId/complete", async (request) => {
    const { handoffId } = handoffParams.parse(request.params);
    const body = z.object({
      expectedVersion: z.number().int().positive(),
      summary: z.string().trim().min(1).max(4_000),
      diffReviewed: z.literal(true),
      validationApproved: z.literal(true),
      commitApproved: z.literal(true),
      pullRequestRequested: z.boolean(),
    }).strict().parse(request.body);
    return { handoff: handoffs.completeHandoffImplementation(request.actorId, handoffId, body) };
  });

  app.post("/api/handoffs/:handoffId/cancel", async (request) => {
    const { handoffId } = handoffParams.parse(request.params);
    const body = z.object({ expectedVersion: z.number().int().positive(), reason: z.string().trim().min(1).max(2_000) }).strict().parse(request.body);
    return { handoff: handoffs.cancelHandoff(request.actorId, handoffId, body) };
  });

  app.post("/api/redesign-assessments", async (request, reply) => {
    const body = z.object({
      designId: identifier.optional(),
      inventoryId: identifier.optional(),
      expectedDesignVersion: z.number().int().positive().optional(),
      brief: z.string().trim().min(1).max(10_000),
      content: z.record(z.unknown()).optional(),
    }).strict().parse(request.body);
    return reply.code(201).send({ assessment: redesign.createOneClickAssessment(request.actorId, body) });
  });

  app.get("/api/redesign-assessments/:assessmentId", async (request) => {
    const { assessmentId } = assessmentParams.parse(request.params);
    return { assessment: redesign.getAssessment(request.actorId, assessmentId) };
  });

  app.patch("/api/redesign-assessments/:assessmentId/current-stage", async (request) => {
    const { assessmentId } = assessmentParams.parse(request.params);
    const body = z.object({
      expectedVersion: z.number().int().positive(),
      expectedDesignVersion: z.number().int().positive().optional(),
      content: z.record(z.unknown()),
    }).strict().parse(request.body);
    return { assessment: redesign.reviseCurrentStage(request.actorId, assessmentId, body) };
  });

  app.post("/api/redesign-assessments/:assessmentId/transition", async (request) => {
    const { assessmentId } = assessmentParams.parse(request.params);
    const body = z.object({
      expectedVersion: z.number().int().positive(),
      expectedDesignVersion: z.number().int().positive().optional(),
      toStage: z.enum(REDESIGN_STAGES),
      decision: z.enum(["advanced", "returned", "approved", "cancelled", "completed"]),
      content: z.record(z.unknown()).optional(),
      details: z.record(z.unknown()).optional(),
    }).strict().parse(request.body);
    return { assessment: redesign.transition(request.actorId, assessmentId, body) };
  });

  app.get("/api/enterprise-domain-capabilities", async () => ({
    handoffStatuses: HANDOFF_STATUSES,
    redesignStages: REDESIGN_STAGES,
  }));
}
