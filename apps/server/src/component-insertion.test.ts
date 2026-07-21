import { createHash } from "node:crypto";

import {
  ComponentDefinitionSchema,
  DesignNodeV2Schema,
  DesignOperationSchema,
  DesignSystemTokenSchema,
  canonicalComponentSourceBundleBytes,
  createSequentialIdFactory,
  createStarterDocument,
  migrateDesignDocumentV1ToV2,
  parseComponentSourceBundle,
  type ComponentSourceBundle,
  type DesignDocumentV2,
} from "@designer/core";
import { describe, expect, it } from "vitest";

import { prepareComponentInstanceInsertion } from "./component-insertion.js";

const componentId = "component_insertable_button_01";
const rootId = "node_insertable_button_root_01";
const labelId = "node_insertable_button_label_01";
const primaryTokenId = "token_insertable_primary_01";
const baseTokenId = "token_insertable_base_0001";

function project(): DesignDocumentV2 {
  return migrateDesignDocumentV1ToV2(createStarterDocument({
    now: "2026-07-21T08:00:00.000Z",
    idFactory: createSequentialIdFactory("componentinsertion"),
  }), { migratedAt: "2026-07-21T08:01:00.000Z" });
}

function source(options: { token?: boolean; asset?: boolean } = {}): ComponentSourceBundle {
  const child = options.asset
    ? DesignNodeV2Schema.parse({
        id: labelId,
        name: "Button image",
        type: "image",
        asset_id: "asset_insertable_image_001",
        alt: "Button artwork",
        object_fit: "cover",
        layout: { x: 0, y: 0, width: 160, height: 44, mode: "absolute", width_sizing: "fixed", height_sizing: "fixed" },
        style: {},
        visible: true,
        locked: false,
        archived: false,
        semantics: { role: "image", business_rule_ids: [], acceptance_criterion_ids: [] },
        metadata: {},
      })
    : DesignNodeV2Schema.parse({
        id: labelId,
        name: "Button label",
        type: "text",
        content: "Continue",
        direction: "auto",
        layout: { x: 16, y: 10, width: 128, height: 24, mode: "absolute", width_sizing: "fixed", height_sizing: "fixed" },
        style: { color: "#ffffff" },
        visible: true,
        locked: false,
        archived: false,
        semantics: { role: "generic", business_rule_ids: [], acceptance_criterion_ids: [] },
        metadata: {},
      });
  return parseComponentSourceBundle({
    format: "formaspec-component-source",
    format_version: 1,
    schema_version: 2,
    component_definition_id: componentId,
    component_version: 1,
    root_node_id: rootId,
    states: [{ key: "default", name: "Default", root_node_id: rootId }],
    nodes: [
      DesignNodeV2Schema.parse({
        id: rootId,
        name: "Primary button",
        type: "container",
        children: [labelId],
        clip_content: true,
        layout: { x: 80, y: 120, width: 160, height: 44, mode: "horizontal", width_sizing: "fixed", height_sizing: "fixed", align_items: "center", justify_content: "center" },
        style: { fill: options.token ? { token_id: primaryTokenId } : "#2457ff", radius: 10 },
        visible: true,
        locked: false,
        archived: false,
        semantics: { role: "button", business_rule_ids: [], acceptance_criterion_ids: [] },
        metadata: {},
      }),
      child,
    ],
    prototype_links: [],
    dependencies: {
      token_ids: options.token ? [primaryTokenId] : [],
      asset_ids: options.asset ? ["asset_insertable_image_001"] : [],
    },
  });
}

function definition(bundle: ComponentSourceBundle) {
  return ComponentDefinitionSchema.parse({
    id: componentId,
    key: "button.insertable",
    name: "Insertable button",
    version: 1,
    status: "published",
    root_node_id: bundle.root_node_id,
    properties_schema: [],
    slots: [],
    states: bundle.states.map((state) => ({ key: state.key, name: state.name, node_id: state.root_node_id })),
    allowed_overrides: { allow_text: false, allow_assets: false, allow_icons: false, allowed_token_families: [], allowed_style_paths: [] },
    platform_mappings: [],
    documentation: { summary: "Insertion fixture", usage: [], accessibility: [], do_list: [], dont_list: [] },
  });
}

function hash(bundle: ComponentSourceBundle): string {
  return createHash("sha256").update(canonicalComponentSourceBundleBytes(bundle)).digest("hex");
}

describe("prepared component insertion", () => {
  it("hydrates release tokens, materializes immutable masters, and inserts one exact instance", () => {
    const document = project();
    const frameId = document.pages[0]!.children[0]!;
    const bundle = source({ token: true });
    const primary = DesignSystemTokenSchema.parse({
      id: primaryTokenId,
      path: "component.button.background",
      name: "Button background",
      family: "color",
      layer: "component",
      value: { token_id: baseTokenId },
      deprecated: false,
    });
    const base = DesignSystemTokenSchema.parse({
      id: baseTokenId,
      path: "primitive.blue.600",
      name: "Blue 600",
      family: "color",
      layer: "primitive",
      value: "#2457ff",
      deprecated: false,
    });
    const prepared = prepareComponentInstanceInsertion({
      document,
      designSystemId: "system_insertable_fixture_01",
      definition: definition(bundle),
      source: bundle,
      sourceHash: hash(bundle),
      releaseTokens: { [primary.id]: primary, [base.id]: base },
      parent: { node_id: frameId },
      instanceId: "node_insertable_instance_01",
      position: { x: 24.5, y: 36.25 },
    });

    expect(DesignOperationSchema.parse(prepared.operation)).toEqual(prepared.operation);
    expect(prepared.operation).toMatchObject({
      type: "insert_component_instance",
      component_definition_id: componentId,
      component_version: 1,
      instance_id: "node_insertable_instance_01",
      position: { x: 24.5, y: 36.25 },
    });
    expect(prepared.hydratedTokenIds).toEqual([baseTokenId, primaryTokenId].sort());
    const frame = prepared.document.nodes[frameId];
    expect(frame?.type).toBe("frame");
    if (!frame || frame.type !== "frame") throw new Error("frame missing");
    expect(frame.children).toContain("node_insertable_instance_01");
    const instance = prepared.document.nodes.node_insertable_instance_01;
    expect(instance).toMatchObject({
      type: "component_instance",
      component_definition_id: componentId,
      component_version: 1,
      active_state: "default",
      layout: { x: 24.5, y: 36.25, width: 160, height: 44 },
    });
    expect(Object.values(prepared.nodeIdMapping).every((nodeId) => prepared.document.nodes[nodeId]?.archived)).toBe(true);
    expect(prepared.document.component_definitions[componentId]?.root_node_id).toBe(prepared.nodeIdMapping[rootId]);
  });

  it("rejects missing release token dependencies and normalized asset dependencies", () => {
    const document = project();
    const frameId = document.pages[0]!.children[0]!;
    const tokenBundle = source({ token: true });
    expect(() => prepareComponentInstanceInsertion({
      document,
      designSystemId: "system_insertable_fixture_01",
      definition: definition(tokenBundle),
      source: tokenBundle,
      sourceHash: hash(tokenBundle),
      releaseTokens: {},
      parent: { node_id: frameId },
      instanceId: "node_insertable_instance_02",
    })).toThrow(/does not provide component token dependency/);

    const assetBundle = source({ asset: true });
    expect(() => prepareComponentInstanceInsertion({
      document,
      designSystemId: "system_insertable_fixture_01",
      definition: definition(assetBundle),
      source: assetBundle,
      sourceHash: hash(assetBundle),
      releaseTokens: {},
      parent: { node_id: frameId },
      instanceId: "node_insertable_instance_03",
    })).toThrow(/asset dependency can be copied by content hash/);
  });
});
