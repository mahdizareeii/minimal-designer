import {
  ProductSpecificationSchema,
  createComponentNode,
  createInstanceNode,
  createSequentialIdFactory,
  createStarterDocument,
  createTextNode,
  migrateDesignDocumentV1ToV2,
  toV1CompatibleDesignDocument,
} from "@designer/core";
import { describe, expect, it } from "vitest";

import { buildRevisionInspectSnapshot } from "./revision-inspect.js";

describe("revision inspect snapshot", () => {
  it("derives immutable V2 engineering evidence and resolved token values", () => {
    const ids = createSequentialIdFactory("inspect");
    const document = createStarterDocument({ idFactory: ids, name: "Pinned checkout" });
    const page = document.pages[0]!;
    const frame = document.nodes[page.children[0]!]!;
    if (frame.type !== "frame") throw new Error("Expected starter frame");

    const tokenId = ids("token");
    document.tokens[tokenId] = {
      id: tokenId,
      name: "Action foreground",
      path: "color.action.foreground",
      kind: "color",
      value: "#2457f5",
      archived: false,
      metadata: {},
    };
    const assetId = ids("asset");
    document.assets[assetId] = {
      id: assetId,
      name: "Checkout illustration.png",
      kind: "image",
      mime_type: "image/png",
      size_bytes: 68,
      storage_key: `asset:${assetId}`,
      sha256: "a".repeat(64),
      width: 1,
      height: 1,
      metadata: {},
    };
    const label = createTextNode({
      name: "Pay label",
      content: "Pay now",
      style: { color: { token_id: tokenId } },
    }, ids);
    const component = createComponentNode({
      name: "Payment button",
      component_key: "payment.button",
      description: "Primary checkout action",
      children: [label.id],
    }, ids);
    const instance = createInstanceNode({
      name: "Payment button instance",
      component_id: component.id,
    }, ids);
    document.nodes[label.id] = label;
    document.nodes[component.id] = component;
    document.nodes[instance.id] = instance;
    frame.children.push(component.id, instance.id);

    const canonical = migrateDesignDocumentV1ToV2(document, {
      sourceRevisionId: "revision_inspect00000001",
      sourceSnapshotHash: "b".repeat(64),
      verifiedBackupId: "backup_inspect00000001",
    });
    const specification = ProductSpecificationSchema.parse({
      id: "spec_inspect00000001",
      version: 7,
      natural_language_brief: "Checkout must remain safe and reviewable.",
      summary: "Pinned checkout rules",
      business_rules: [{
        id: "rule_inspect00000001",
        title: "Require confirmation",
        description: "Sensitive payments require explicit confirmation.",
        links: { node_ids: [instance.id] },
        conditions: [],
        outcomes: ["Show confirmation"],
        priority: "critical",
      }],
      acceptance_criteria: [{
        id: "criterion_inspect00000001",
        title: "Confirmation is visible",
        description: "The user reviews the total before payment.",
        links: { node_ids: [instance.id] },
        given: ["A cart has items"],
        when: ["The user presses Pay now"],
        then: ["A confirmation screen is shown"],
      }],
    });

    const inspect = buildRevisionInspectSnapshot({
      canonicalDocument: canonical,
      editorDocument: toV1CompatibleDesignDocument(canonical),
      linkedSpecification: {
        version: specification.version,
        specificationHash: "c".repeat(64),
        specification,
      },
      implementationMappings: [{
        id: "mapping_inspect00000001",
        entity_kind: "component",
        entity_id: component.id,
        platform: "web",
        symbol: "CheckoutButton",
        inventory_id: null,
        mapping_json: JSON.stringify({ module: "checkout/CheckoutButton.tsx" }),
        created_by: "principal_local",
        created_at: "2026-07-20T10:00:00.000Z",
      }],
    });

    expect(inspect.productSpecification).toMatchObject({ source: "revision_link", version: 7 });
    expect(inspect.evidence.tokens).toEqual([
      expect.objectContaining({
        id: tokenId,
        path: "color.action.foreground",
        rawValue: "#2457f5",
        resolvedValue: "#2457f5",
        resolutionStatus: "resolved",
      }),
    ]);
    expect(inspect.evidence.assets).toEqual([
      expect.objectContaining({ id: assetId, sha256: "a".repeat(64), status: "ready" }),
    ]);
    expect(inspect.evidence.components).toEqual([
      expect.objectContaining({ name: "Payment button", version: 1, instanceCount: 1 }),
    ]);
    expect(inspect.evidence.businessRules[0]).toMatchObject({
      id: "rule_inspect00000001",
      title: "Require confirmation",
      jsonPath: '$["@revision_product_specification"].business_rules[0]',
    });
    expect(inspect.evidence.acceptanceCriteria[0]).toMatchObject({ id: "criterion_inspect00000001" });
    expect(inspect.evidence.implementationMappings[0]).toMatchObject({
      id: "mapping_inspect00000001",
      source: "revision",
      symbol: "CheckoutButton",
    });
    expect(inspect.nodes.find((node) => node.id === label.id)).toMatchObject({
      jsonPath: `$.nodes["${label.id}"]`,
      resolvedValues: { style: { color: "#2457f5" } },
      tokenReferences: [expect.objectContaining({ tokenId, value: "#2457f5", status: "resolved" })],
    });
    expect(inspect.limitations).toEqual([]);
  });

  it("reports absent revision-linked specification evidence for V1 without borrowing a later version", () => {
    const document = createStarterDocument({ name: "Historical V1" });
    const inspect = buildRevisionInspectSnapshot({
      canonicalDocument: document,
      editorDocument: document,
      linkedSpecification: null,
      implementationMappings: [],
    });

    expect(inspect.productSpecification).toBeNull();
    expect(inspect.evidence.businessRules).toEqual([]);
    expect(inspect.evidence.acceptanceCriteria).toEqual([]);
    expect(inspect.limitations).toEqual([
      "No product specification version is explicitly pinned to this historical design revision.",
    ]);
  });
});
