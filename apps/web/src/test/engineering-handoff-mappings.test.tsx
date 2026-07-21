import { describe, expect, it } from "vitest";

import {
  compatibleImplementationInventoryEntities,
  engineeringHandoffSpecificationFromMappings,
  implementationInventoryEntityLabel,
  implementationMappingBatchInput,
  implementationMappingDesignEntities,
} from "../components/EngineeringHandoffPanel";
import type { RepositoryInventoryRecord, RevisionInspectResult } from "../lib/api";

type InventoryEntity = RepositoryInventoryRecord["inventory"]["entities"][number];

function inventoryEntity(kind: string, suffix: string, overrides: Partial<InventoryEntity> = {}): InventoryEntity {
  return {
    id: `inv_${suffix.padEnd(40, "0").slice(0, 40)}`,
    kind,
    name: `${kind} source`,
    symbol: `${kind.replaceAll("-", "_")}Source`,
    locationId: `loc_${suffix.padEnd(40, "1").slice(0, 40)}`,
    line: 10,
    ...overrides,
  };
}

function exactInspect(): RevisionInspectResult {
  return {
    document: {
      schema_version: 2,
      product_specification: {
        flows: [{ id: "flow_document_only_0001", title: "Stale document flow" }],
        business_rules: [],
      },
    },
    nodes: [
      { id: "node_checkout_screen_001", name: "Checkout", type: "frame", archived: false },
      { id: "node_archived_screen_01", name: "Archived checkout", type: "frame", archived: true },
      { id: "node_checkout_label_001", name: "Checkout label", type: "text", archived: false },
    ],
    productSpecification: {
      source: "revision_link",
      version: 4,
      specificationHash: "a".repeat(64),
      specification: {
        flows: [{ id: "flow_checkout_review_001", title: "Checkout review" }],
        business_rules: [{ id: "rule_confirm_total_001", title: "Confirm total" }],
      },
      jsonPath: '$["@revision_product_specification"]',
    },
    evidence: {
      components: [{ id: "component_checkout_button_001", name: "Checkout button", key: "checkout.button", version: 2 }],
      tokens: [{ id: "token_action_color_0001", name: "Action color", path: "color.action", family: "color", layer: "semantic" }],
      assets: [{ id: "asset_checkout_logo_0001", name: "Checkout logo", kind: "image", status: "ready" }],
      businessRules: [{ id: "rule_confirm_total_001", title: "Confirm total", jsonPath: '$["@revision_product_specification"].business_rules[0]' }],
      acceptanceCriteria: [],
      implementationMappings: [],
    },
  } as unknown as RevisionInspectResult;
}

describe("engineering handoff implementation mapping review", () => {
  it("derives choices only from exact immutable V2 revision entities", () => {
    const entities = implementationMappingDesignEntities(exactInspect());

    expect(entities.map(({ kind, id }) => `${kind}:${id}`)).toEqual([
      "screen:node_checkout_screen_001",
      "component:component_checkout_button_001",
      "token:token_action_color_0001",
      "asset:asset_checkout_logo_0001",
      "flow:flow_checkout_review_001",
      "business_rule:rule_confirm_total_001",
    ]);
    expect(entities.some((entity) => entity.id === "node_archived_screen_01")).toBe(false);
    expect(entities.some((entity) => entity.id === "flow_document_only_0001")).toBe(false);

    const v1 = { ...exactInspect(), document: { schema_version: 1 } } as unknown as RevisionInspectResult;
    expect(implementationMappingDesignEntities(v1)).toEqual([]);
  });

  it("offers only server-compatible opaque inventory entity kinds", () => {
    const entities = [
      inventoryEntity("component", "1"),
      inventoryEntity("token", "2"),
      inventoryEntity("screen", "3"),
      inventoryEntity("route", "4"),
      inventoryEntity("asset", "5"),
      inventoryEntity("flow", "6"),
      inventoryEntity("business-rule", "7"),
    ];

    expect(compatibleImplementationInventoryEntities("component", entities).map((entity) => entity.kind)).toEqual(["component"]);
    expect(compatibleImplementationInventoryEntities("token", entities).map((entity) => entity.kind)).toEqual(["token"]);
    expect(compatibleImplementationInventoryEntities("screen", entities).map((entity) => entity.kind)).toEqual(["screen", "route"]);
    expect(compatibleImplementationInventoryEntities("asset", entities).map((entity) => entity.kind)).toEqual(["asset"]);
    expect(compatibleImplementationInventoryEntities("flow", entities).map((entity) => entity.kind)).toEqual(["route", "flow"]);
    expect(compatibleImplementationInventoryEntities("business_rule", entities).map((entity) => entity.kind)).toEqual(["business-rule"]);
  });

  it("never renders inventory locations, repository paths, or credential-like names", () => {
    const entity = inventoryEntity("screen", "8", {
      name: "/Users/company/private/passwords.txt",
      symbol: null,
      locationId: "/Users/company/private/source.tsx",
    });
    const label = implementationInventoryEntityLabel(entity);

    expect(label).toContain("Opaque source entity");
    expect(label).toContain(entity.id);
    expect(label).not.toContain(entity.name);
    expect(label).not.toContain(entity.locationId);
    expect(label.toLocaleLowerCase()).not.toContain("password");
  });

  it("builds one explicit idempotent batch without client-provided source metadata", () => {
    const input = implementationMappingBatchInput({
      designId: "design_checkout_0001",
      revisionId: "revision_checkout_0001",
      expectedDesignVersion: 7,
      inventoryId: "inventory_11111111111111111111111111111111",
      idempotencyKey: "mapping-ui-fixed-retry-key",
      designEntity: { kind: "screen", id: "node_checkout_screen_001" },
      inventoryEntityId: `inv_${"2".repeat(40)}`,
    });

    expect(input).toEqual({
      designId: "design_checkout_0001",
      revisionId: "revision_checkout_0001",
      expectedDesignVersion: 7,
      inventoryId: "inventory_11111111111111111111111111111111",
      idempotencyKey: "mapping-ui-fixed-retry-key",
      mappings: [{
        entityKind: "screen",
        entityId: "node_checkout_screen_001",
        inventoryEntityId: `inv_${"2".repeat(40)}`,
      }],
    });
    expect(JSON.stringify(input)).not.toMatch(/symbol|location|repository|credential|path/i);
  });

  it("builds handoff references only from reviewed mappings", () => {
    expect(() => engineeringHandoffSpecificationFromMappings("Unsafe empty handoff", [])).toThrow(/at least one reviewed/i);
    const specification = engineeringHandoffSpecificationFromMappings("Implement checkout safely", [
      { entityId: "node_checkout_screen_001", inventoryEntityId: `inv_${"3".repeat(40)}`, symbol: "CheckoutScreen" },
      { entityId: "component_checkout_button_001", inventoryEntityId: `inv_${"4".repeat(40)}`, symbol: "CheckoutButton" },
      { entityId: "node_checkout_screen_001", inventoryEntityId: `inv_${"3".repeat(40)}`, symbol: "CheckoutScreen" },
    ]);

    expect(specification.acceptanceCriteria[0]?.designEntityIds).toEqual([
      "node_checkout_screen_001",
      "component_checkout_button_001",
    ]);
    expect(specification.implementationSlices[0]).toMatchObject({
      inventoryEntityIds: [`inv_${"3".repeat(40)}`, `inv_${"4".repeat(40)}`],
      designEntityIds: ["node_checkout_screen_001", "component_checkout_button_001"],
    });
    expect(JSON.stringify(specification)).not.toContain(`inv_${"9".repeat(40)}`);
    expect(specification.implementationSlices[0]?.objective).toContain("pinned opaque inventory mappings");
    expect(specification.implementationSlices[0]?.objective).not.toContain("CheckoutScreen");
  });
});
