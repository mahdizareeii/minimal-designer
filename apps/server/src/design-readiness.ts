import {
  ComponentDefinitionIdSchema,
  DesignSystemReleaseIdSchema,
  DocumentIdSchema,
  ProductIdSchema,
  ProductPlatformSchema,
} from "@designer/core";
import { z } from "zod";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().trim().min(1).max(240);
const boundedLine = z.string().trim().min(1).max(2_000);
const checkStatus = z.enum(["pass", "warning", "blocked", "not_applicable"]);

const componentUse = z.object({
  componentDefinitionId: ComponentDefinitionIdSchema,
  version: z.number().int().positive().max(1_000_000_000),
  reason: boundedLine,
}).strict();

export const DesignReadinessReportSchema = z.object({
  schemaVersion: z.literal(1),
  requestClassification: z.enum(["create", "refine", "redesign", "product_spec_clarification"]),
  selected: z.object({
    productId: ProductIdSchema,
    designId: DocumentIdSchema,
    baseVersion: z.number().int().positive().max(1_000_000_000),
  }).strict(),
  productSpecification: z.object({
    version: z.number().int().positive().max(1_000_000_000),
    specificationHash: sha256,
  }).strict().nullable(),
  designSystem: z.object({
    source: z.enum(["project_pin", "product_default", "formaspec_foundation"]),
    releaseId: DesignSystemReleaseIdSchema,
    releaseVersion: z.number().int().positive().max(1_000_000_000),
  }).strict(),
  components: z.object({
    reused: z.array(componentUse).max(200),
    extended: z.array(componentUse).max(100),
    proposed: z.array(z.object({
      key: z.string().trim().min(1).max(200).regex(/^[A-Za-z][A-Za-z0-9_.-]*$/),
      name: z.string().trim().min(1).max(240),
      reason: boundedLine,
    }).strict()).max(100),
  }).strict(),
  platforms: z.array(ProductPlatformSchema).min(1).max(5),
  repositoryMappingsConsidered: z.array(z.object({
    inventoryId: identifier,
    inventoryHash: sha256,
  }).strict()).max(100),
  assumptions: z.array(boundedLine).max(100),
  blockers: z.array(boundedLine).max(100),
  checks: z.object({
    hierarchy: checkStatus,
    visualConsistency: checkStatus,
    interactionStates: checkStatus,
    accessibility: checkStatus,
    touchTargets: checkStatus,
    rtlLocalization: checkStatus,
    responsiveVariants: checkStatus,
    prototypeCoverage: checkStatus,
    engineeringFeasibility: checkStatus,
    lint: checkStatus,
  }).strict(),
}).strict().superRefine((report, context) => {
  const componentIds = new Set<string>();
  for (const [kind, entries] of [
    ["reused", report.components.reused],
    ["extended", report.components.extended],
  ] as const) {
    for (const [index, component] of entries.entries()) {
      if (componentIds.has(component.componentDefinitionId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["components", kind, index, "componentDefinitionId"],
          message: "A component may be classified only once as reused or extended.",
        });
      }
      componentIds.add(component.componentDefinitionId);
    }
  }
  if (report.requestClassification === "product_spec_clarification"
    && report.components.reused.length + report.components.extended.length + report.components.proposed.length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["components"],
      message: "A product-specification clarification cannot claim component design work.",
    });
  }
  const platforms = new Set<string>();
  for (const [index, platform] of report.platforms.entries()) {
    if (platforms.has(platform)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["platforms", index],
        message: "A readiness platform may be listed only once.",
      });
    }
    platforms.add(platform);
  }
  const inventories = new Set<string>();
  for (const [index, inventory] of report.repositoryMappingsConsidered.entries()) {
    if (inventories.has(inventory.inventoryId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["repositoryMappingsConsidered", index, "inventoryId"],
        message: "A repository inventory may be listed only once.",
      });
    }
    inventories.add(inventory.inventoryId);
  }
});

export type DesignReadinessReport = z.infer<typeof DesignReadinessReportSchema>;
