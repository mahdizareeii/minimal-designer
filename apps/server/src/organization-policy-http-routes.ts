import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { OrganizationPolicyService } from "./organization-policy-service.js";

const updatePolicySchema = z.object({
  expectedConfigurationHash: z.string().regex(/^[a-f0-9]{64}$/),
  policy: z.record(z.unknown()),
}).strict();

const auditRetentionPreviewParams = z.object({
  previewId: z.string().regex(/^audit_retention_preview_[a-f0-9]{32}$/),
}).strict();

const auditRetentionCommitSchema = z.object({
  expectedPlanHash: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/),
}).strict();

export function registerOrganizationPolicyHttpRoutes(
  app: FastifyInstance,
  policies: OrganizationPolicyService,
): void {
  app.get("/api/organization/policy", async (request) => {
    policies.assertOrganizationReadAllowed(request.actorId);
    return { organizationPolicy: policies.read(request.actorId) };
  });

  app.put("/api/organization/policy", async (request) => {
    policies.assertOrganizationAdministrationAllowed(request.actorId);
    return { organizationPolicy: policies.update(request.actorId, updatePolicySchema.parse(request.body)) };
  });

  app.get("/api/organization/configuration", async (request, reply) => {
    policies.assertOrganizationReadAllowed(request.actorId);
    const exported = policies.exportYaml(request.actorId);
    return reply
      .type("application/yaml; charset=utf-8")
      .header("content-disposition", `attachment; filename="${exported.filename}"`)
      .header("etag", `"${exported.policyHash}"`)
      .header("cache-control", "private, no-store")
      .send(exported.yaml);
  });

  app.post("/api/organization/audit-retention/previews", async (request, reply) => {
    policies.assertOrganizationAdministrationAllowed(request.actorId);
    z.object({}).strict().parse(request.body ?? {});
    return reply.code(201).send({ preview: policies.previewAuditRetention(request.actorId) });
  });

  app.post("/api/organization/audit-retention/previews/:previewId/commit", async (request) => {
    policies.assertOrganizationAdministrationAllowed(request.actorId);
    const { previewId } = auditRetentionPreviewParams.parse(request.params);
    const input = auditRetentionCommitSchema.parse(request.body);
    return { result: policies.executeAuditRetention(request.actorId, previewId, input) };
  });

  app.get("/api/organization/audit-retention/runs", async (request) => {
    policies.assertOrganizationAdministrationAllowed(request.actorId);
    const { limit } = z.object({
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }).strict().parse(request.query);
    return { runs: policies.listAuditRetentionRuns(request.actorId, limit) };
  });
}
