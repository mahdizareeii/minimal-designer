import { createHash } from "node:crypto";

import {
  ComponentDefinitionSchema,
  DesignDocumentV2Schema,
  DesignNodeV2Schema,
  canonicalComponentSourceBundleBytes,
  createSequentialIdFactory,
  createStarterDocument,
  migrateDesignDocumentV1ToV2,
  parseComponentSourceBundle,
  type ComponentDefinition,
  type ComponentSourceBundle,
  type DesignDocumentV2,
} from "@designer/core";
import { describe, expect, it } from "vitest";

import {
  COMPONENT_SOURCE_METADATA_KEY,
  materializeComponentSource,
  materializedComponentSourceNodeIds,
} from "./component-materialization.js";

const componentId = "component_materialized_button_01";

function node(id: string, name: string, content?: string) {
  return DesignNodeV2Schema.parse(content === undefined ? {
    id,
    name,
    type: "container",
    children: [`${id}_label`],
    clip_content: true,
    layout: {
      x: 0,
      y: 0,
      width: 220,
      height: 48,
      mode: "horizontal",
      width_sizing: "fixed",
      height_sizing: "fixed",
      align_items: "center",
      justify_content: "center",
    },
    style: { fill: name.includes("Hover") ? "#173fca" : "#2457ff", radius: 12 },
    visible: true,
    locked: false,
    archived: false,
    semantics: {
      role: "button",
      business_rule_ids: [],
      acceptance_criterion_ids: [],
    },
    metadata: {},
  } : {
    id,
    name,
    type: "text",
    content,
    direction: "auto",
    layout: {
      x: 0,
      y: 0,
      width: 180,
      height: 24,
      mode: "absolute",
      width_sizing: "fixed",
      height_sizing: "fixed",
    },
    style: { color: "#ffffff" },
    visible: true,
    locked: false,
    archived: false,
    semantics: {
      role: "generic",
      business_rule_ids: [],
      acceptance_criterion_ids: [],
    },
    metadata: {},
  });
}

function componentVersion(version: number, states: Array<"default" | "hover"> = ["default", "hover"]): {
  definition: ComponentDefinition;
  source: ComponentSourceBundle;
  sourceHash: string;
} {
  const prefix = `node_materialized_v${version}`;
  const stateRecords = states.map((state) => ({
    key: state,
    name: state === "default" ? "Default" : "Hover",
    root: `${prefix}_${state}_root`,
    label: `${prefix}_${state}_root_label`,
  }));
  const source = parseComponentSourceBundle({
    format: "formaspec-component-source",
    format_version: 1,
    schema_version: 2,
    component_definition_id: componentId,
    component_version: version,
    root_node_id: stateRecords.find((state) => state.key === "default")!.root,
    states: stateRecords.map((state) => ({
      key: state.key,
      name: state.name,
      root_node_id: state.root,
    })),
    nodes: stateRecords.flatMap((state) => [
      node(state.root, `Button / ${state.name}`),
      node(state.label, "Button label", `${state.name} v${version}`),
    ]),
    prototype_links: [],
    dependencies: { token_ids: [], asset_ids: [] },
  });
  const definition = ComponentDefinitionSchema.parse({
    id: componentId,
    key: "button.materialized",
    name: "Materialized button",
    version,
    status: "published",
    root_node_id: source.root_node_id,
    properties_schema: [],
    slots: [],
    states: source.states.map((state) => ({
      key: state.key,
      name: state.name,
      node_id: state.root_node_id,
    })),
    allowed_overrides: {
      allow_text: false,
      allow_assets: false,
      allow_icons: false,
      allowed_token_families: [],
      allowed_style_paths: [],
    },
    platform_mappings: [],
    documentation: {
      summary: "Source-backed component fixture.",
      usage: [],
      accessibility: [],
      do_list: [],
      dont_list: [],
    },
  });
  return {
    definition,
    source,
    sourceHash: createHash("sha256").update(canonicalComponentSourceBundleBytes(source)).digest("hex"),
  };
}

function project(): DesignDocumentV2 {
  const source = createStarterDocument({
    now: "2026-07-21T00:00:00.000Z",
    idFactory: createSequentialIdFactory("materializedproject"),
  });
  return migrateDesignDocumentV1ToV2(source, { migratedAt: "2026-07-21T00:01:00.000Z" });
}

describe("component source materialization", () => {
  it("remaps source IDs deterministically, archives masters, and upgrades exact instances", () => {
    const first = componentVersion(1);
    const firstMaterialized = materializeComponentSource(project(), {
      designSystemId: "system_materialized_fixture_01",
      ...first,
    });
    const firstIds = materializedComponentSourceNodeIds(firstMaterialized.document, componentId);
    expect(firstIds).toHaveLength(first.source.nodes.length);
    expect(firstIds.every((id) => firstMaterialized.document.nodes[id]?.archived)).toBe(true);
    expect(firstIds.every((id) => firstMaterialized.document.nodes[id]?.locked)).toBe(true);
    expect(firstIds.every((id) => firstMaterialized.document.nodes[id]?.metadata[COMPONENT_SOURCE_METADATA_KEY])).toBe(true);

    const withInstance = structuredClone(firstMaterialized.document);
    const frameId = withInstance.pages[0]!.children[0]!;
    const frame = withInstance.nodes[frameId];
    if (!frame || frame.type !== "frame") throw new Error("fixture frame missing");
    const instanceId = "node_materialized_instance_01";
    withInstance.nodes[instanceId] = DesignNodeV2Schema.parse({
      id: instanceId,
      name: "Materialized instance",
      type: "component_instance",
      component_definition_id: componentId,
      component_version: 1,
      properties: {},
      slots: {},
      active_state: "hover",
      layout: {
        x: 40,
        y: 40,
        width: 220,
        height: 48,
        mode: "absolute",
        width_sizing: "fixed",
        height_sizing: "fixed",
      },
      style: {},
      visible: true,
      locked: false,
      archived: false,
      semantics: {
        role: "button",
        business_rule_ids: [],
        acceptance_criterion_ids: [],
      },
      metadata: {},
    });
    frame.children.push(instanceId);
    const strictWithInstance = DesignDocumentV2Schema.parse(withInstance);

    const second = componentVersion(2);
    const upgraded = materializeComponentSource(strictWithInstance, {
      designSystemId: "system_materialized_fixture_01",
      ...second,
      updateInstances: true,
    });
    expect(upgraded.changedInstanceIds).toEqual([instanceId]);
    expect(upgraded.removedNodeIds).toEqual(firstIds);
    expect(upgraded.document.nodes[instanceId]?.type).toBe("component_instance");
    const instance = upgraded.document.nodes[instanceId];
    if (!instance || instance.type !== "component_instance") throw new Error("upgraded instance missing");
    expect(instance.component_version).toBe(2);
    expect(instance.active_state).toBe("hover");
    expect(upgraded.document.component_definitions[componentId]?.version).toBe(2);
    expect(Object.values(upgraded.nodeIdMapping).every((id) => id.startsWith("node_library_"))).toBe(true);

    const repeated = materializeComponentSource(upgraded.document, {
      designSystemId: "system_materialized_fixture_01",
      ...second,
      updateInstances: true,
    });
    expect(repeated.document).toEqual(upgraded.document);
    expect(repeated.nodeIdMapping).toEqual(upgraded.nodeIdMapping);
  });

  it("blocks an upgrade that removes an active instance state", () => {
    const first = componentVersion(1);
    const materialized = materializeComponentSource(project(), {
      designSystemId: "system_materialized_fixture_01",
      ...first,
    }).document;
    const frameId = materialized.pages[0]!.children[0]!;
    const frame = materialized.nodes[frameId];
    if (!frame || frame.type !== "frame") throw new Error("fixture frame missing");
    const instanceId = "node_materialized_instance_02";
    materialized.nodes[instanceId] = DesignNodeV2Schema.parse({
      id: instanceId,
      name: "Hover instance",
      type: "component_instance",
      component_definition_id: componentId,
      component_version: 1,
      properties: {},
      slots: {},
      active_state: "hover",
      layout: {
        x: 0,
        y: 0,
        width: 220,
        height: 48,
        mode: "absolute",
        width_sizing: "fixed",
        height_sizing: "fixed",
      },
      style: {},
      visible: true,
      locked: false,
      archived: false,
      semantics: { role: "button", business_rule_ids: [], acceptance_criterion_ids: [] },
      metadata: {},
    });
    frame.children.push(instanceId);
    const withoutHover = componentVersion(2, ["default"]);
    expect(() => materializeComponentSource(DesignDocumentV2Schema.parse(materialized), {
      designSystemId: "system_materialized_fixture_01",
      ...withoutHover,
      updateInstances: true,
    })).toThrow(/does not provide active state hover/);
  });
});
