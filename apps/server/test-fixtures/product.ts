import {
  AgentTaskResolvedContextSchema,
  FORMASPEC_FOUNDATION_RELEASE_ID,
  FORMASPEC_FOUNDATION_SYSTEM_ID,
  FORMASPEC_FOUNDATION_VERSION,
} from "@designer/core";
import type Database from "better-sqlite3";

import type { DesignReadinessReport } from "../src/design-readiness.js";
import { createId } from "../src/ids.js";

interface DesignFixtureRow {
  id: string;
  product_id: string | null;
  actor_id: string;
  name: string;
  current_version: number;
  current_revision_id: string;
  created_at: string;
  updated_at: string;
}

interface ProductFixtureRow {
  id: string;
  name: string;
  status: "active" | "archived";
  updated_at: string;
  default_locale: string;
  default_direction: "ltr" | "rtl" | "auto";
}

/**
 * Moves a test-only design into another organization while preserving the
 * migration-17 Product integrity invariant. Production code must use the
 * audited Product move preview/commit workflow instead.
 */
export function moveDesignFixtureToOrganization(
  sqlite: Database.Database,
  input: {
    designId: string;
    organizationId: string;
    ownerPrincipalId?: string;
    name?: string;
  },
): string {
  const design = sqlite.prepare(
    `SELECT id, product_id, actor_id, name, current_version, current_revision_id, created_at, updated_at
     FROM designs WHERE id = ?`,
  ).get(input.designId) as DesignFixtureRow | undefined;
  if (!design) throw new Error(`Design fixture ${input.designId} was not found.`);
  if (design.product_id) {
    sqlite.prepare(
      `UPDATE products
       SET canonical_specification_design_id = NULL
       WHERE id = ? AND canonical_specification_design_id = ?`,
    ).run(design.product_id, design.id);
  }
  const productId = createId("product");
  const ownerPrincipalId = input.ownerPrincipalId ?? `principal_${productId.slice("product_".length)}`;
  const existingOwner = sqlite.prepare(
    "SELECT id, organization_id FROM principals WHERE id = ?",
  ).get(ownerPrincipalId) as { id: string; organization_id: string } | undefined;
  if (existingOwner && existingOwner.organization_id !== input.organizationId) {
    throw new Error(`Fixture principal ${ownerPrincipalId} belongs to another organization.`);
  }
  if (!existingOwner) {
    sqlite.prepare(
      `INSERT INTO principals
       (id, organization_id, kind, display_name, external_id, created_at, disabled_at)
       VALUES (?, ?, 'human', 'Product fixture owner', ?, ?, NULL)`,
    ).run(ownerPrincipalId, input.organizationId, `product-fixture:${productId}`, design.created_at);
    sqlite.prepare(
      `INSERT INTO memberships (organization_id, principal_id, role, created_at)
       VALUES (?, ?, 'organization_admin', ?)`,
    ).run(input.organizationId, ownerPrincipalId, design.created_at);
  }
  const name = input.name ?? design.name;
  sqlite.prepare(
    `INSERT INTO products
     (id, organization_id, name, description, status, owner_principal_id,
      canonical_specification_design_id, default_design_system_release_id,
      default_locale, default_direction, locales_json, metadata_json,
      created_by, created_at, updated_at, archived_at)
     VALUES (?, ?, ?, '', 'active', ?, NULL, NULL, 'en', 'ltr', '["en"]', '{}', ?, ?, ?, NULL)`,
  ).run(
    productId,
    input.organizationId,
    name,
    ownerPrincipalId,
    ownerPrincipalId,
    design.created_at,
    design.updated_at,
  );
  sqlite.prepare(
    `UPDATE designs SET product_id = ?, organization_id = ?, name = ? WHERE id = ?`,
  ).run(productId, input.organizationId, name, design.id);
  sqlite.prepare(
    `UPDATE products SET canonical_specification_design_id = ? WHERE id = ?`,
  ).run(design.id, productId);
  return productId;
}

/** Creates the strict immutable task context required for direct SQL fixtures. */
export function agentTaskResolvedContextFixture(
  sqlite: Database.Database,
  input: {
    designId: string;
    capturedAt: string;
    locale?: string;
    platform?: "web" | "phone" | "tablet" | "mixed" | "unspecified";
  },
): { productId: string; json: string } {
  const design = sqlite.prepare(
    `SELECT id, product_id, current_version, current_revision_id
     FROM designs WHERE id = ?`,
  ).get(input.designId) as Pick<
    DesignFixtureRow,
    "id" | "product_id" | "current_version" | "current_revision_id"
  > | undefined;
  if (!design?.product_id) throw new Error(`Design fixture ${input.designId} has no Product.`);
  const product = sqlite.prepare(
    `SELECT id, name, status, updated_at, default_locale, default_direction
     FROM products WHERE id = ?`,
  ).get(design.product_id) as ProductFixtureRow | undefined;
  if (!product || product.status !== "active") throw new Error(`Product fixture ${design.product_id} is unavailable.`);
  const locale = input.locale ?? product.default_locale;
  return {
    productId: product.id,
    json: JSON.stringify({
      schemaVersion: 1,
      product: {
        id: product.id,
        name: product.name,
        status: product.status,
        updatedAt: product.updated_at,
      },
      design: {
        id: design.id,
        version: design.current_version,
        revisionId: design.current_revision_id,
      },
      productSpecification: null,
      designSystem: {
        source: "formaspec_foundation",
        designSystemId: FORMASPEC_FOUNDATION_SYSTEM_ID,
        releaseId: FORMASPEC_FOUNDATION_RELEASE_ID,
        releaseVersion: FORMASPEC_FOUNDATION_VERSION,
      },
      repositoryInventories: [],
      locale,
      direction: product.default_direction,
      platform: input.platform ?? "unspecified",
      capturedAt: input.capturedAt,
    }),
  };
}

export function designReadinessFixture(
  rawContext: unknown,
  overrides: Partial<Pick<DesignReadinessReport, "requestClassification" | "components" | "assumptions" | "blockers" | "checks">> = {},
): DesignReadinessReport {
  const context = AgentTaskResolvedContextSchema.parse(rawContext);
  return {
    schemaVersion: 1,
    requestClassification: overrides.requestClassification ?? "refine",
    selected: {
      productId: context.product.id,
      designId: context.design.id,
      baseVersion: context.design.version,
    },
    productSpecification: context.productSpecification === null ? null : {
      version: context.productSpecification.version,
      specificationHash: context.productSpecification.specificationHash,
    },
    designSystem: {
      source: context.designSystem.source,
      releaseId: context.designSystem.releaseId,
      releaseVersion: context.designSystem.releaseVersion,
    },
    components: overrides.components ?? { reused: [], extended: [], proposed: [] },
    platforms: [context.platform],
    repositoryMappingsConsidered: context.repositoryInventories.map((inventory) => ({
      inventoryId: inventory.id,
      inventoryHash: inventory.inventoryHash,
    })),
    assumptions: overrides.assumptions ?? [],
    blockers: overrides.blockers ?? [],
    checks: overrides.checks ?? {
      hierarchy: "pass",
      visualConsistency: "pass",
      interactionStates: "pass",
      accessibility: "pass",
      touchTargets: "pass",
      rtlLocalization: "pass",
      responsiveVariants: "pass",
      prototypeCoverage: "pass",
      engineeringFeasibility: "pass",
      lint: "pass",
    },
  };
}
