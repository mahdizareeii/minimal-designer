import { describe, expect, it } from "vitest";

import { DesignReadinessReportSchema } from "./design-readiness.js";

function report() {
  return {
    schemaVersion: 1 as const,
    requestClassification: "refine" as const,
    selected: {
      productId: "product_readiness0001",
      designId: "document_readiness0001",
      baseVersion: 4,
    },
    productSpecification: {
      version: 3,
      specificationHash: "a".repeat(64),
    },
    designSystem: {
      source: "product_default" as const,
      releaseId: "release_readiness0001",
      releaseVersion: 8,
    },
    components: {
      reused: [{
        componentDefinitionId: "component_readiness0001",
        version: 2,
        reason: "The pinned release already defines the requested control.",
      }],
      extended: [],
      proposed: [],
    },
    platforms: ["web" as const],
    repositoryMappingsConsidered: [{ inventoryId: "inventory_readiness0001", inventoryHash: "b".repeat(64) }],
    assumptions: [],
    blockers: [],
    checks: {
      hierarchy: "pass" as const,
      visualConsistency: "pass" as const,
      interactionStates: "pass" as const,
      accessibility: "pass" as const,
      touchTargets: "not_applicable" as const,
      rtlLocalization: "pass" as const,
      responsiveVariants: "warning" as const,
      prototypeCoverage: "pass" as const,
      engineeringFeasibility: "pass" as const,
      lint: "pass" as const,
    },
  };
}

describe("DesignReadinessReportSchema", () => {
  it("accepts bounded Product, design-system, repository, and validation evidence", () => {
    expect(DesignReadinessReportSchema.parse(report())).toMatchObject({
      selected: { productId: "product_readiness0001", designId: "document_readiness0001" },
      checks: { accessibility: "pass", responsiveVariants: "warning" },
    });
  });

  it("rejects classifying one component as both reused and extended", () => {
    const duplicate = report();
    duplicate.components.extended.push({ ...duplicate.components.reused[0]! });
    expect(DesignReadinessReportSchema.safeParse(duplicate).success).toBe(false);
  });

  it("keeps product-specification clarification separate from design mutation", () => {
    const clarification = report();
    clarification.requestClassification = "product_spec_clarification";
    expect(DesignReadinessReportSchema.safeParse(clarification).success).toBe(false);
  });

  it("rejects duplicate platform and repository evidence", () => {
    const duplicate = report();
    duplicate.platforms.push("web");
    duplicate.repositoryMappingsConsidered.push({ ...duplicate.repositoryMappingsConsidered[0]! });
    expect(DesignReadinessReportSchema.safeParse(duplicate).success).toBe(false);
  });
});
