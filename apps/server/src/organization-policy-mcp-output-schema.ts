import { z } from "zod";

import { OrganizationPolicySchema } from "./organization-policy-model.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const OrganizationPolicyDiagnosticResultSchema = z.object({
  code: z.string().trim().min(1).max(160),
  severity: z.enum(["warning", "error"]),
  message: z.string().min(1).max(4_000),
}).strict();

export const LoadedOrganizationPolicyResultSchema: z.AnyZodObject = z.object({
  organizationId: z.string().trim().min(1).max(240),
  organizationName: z.string().trim().min(1).max(500),
  policy: OrganizationPolicySchema,
  policyHash: sha256,
  configurationHash: sha256,
  source: z.enum(["default", "stored", "legacy_quarantined", "corrupt_fail_closed"]),
  diagnostics: z.array(OrganizationPolicyDiagnosticResultSchema).max(100),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();

export const OrganizationPolicyYamlFilenameSchema = z.string()
  .trim()
  .min(1)
  .max(240)
  .regex(/^[A-Za-z0-9._-]+\.formaspec\.ya?ml$/);

export const OrganizationPolicyYamlSchema = z.string().min(1).max(524_288);
