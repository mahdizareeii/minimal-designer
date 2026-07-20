import { describe, expect, it } from "vitest";

import {
  DesignDocumentV2Schema,
  createComponentNode,
  createInstanceNode,
  createRectangleNode,
  createSequentialIdFactory,
  createStarterDocument,
  createTextNode,
  lintDesignDocumentV2,
  migrateDesignDocumentV1ToV2,
} from "./index.js";

describe("FormaSpec V2 lint", () => {
  it("reports token, state, hierarchy, accessibility, prototype, RTL, component, and rule-link issues", () => {
    const ids = createSequentialIdFactory("v2lint");
    const source = createStarterDocument({
      name: "V2 lint fixture",
      now: "2026-07-20T00:00:00.000Z",
      idFactory: ids,
    });
    const frameId = source.pages[0]!.children[0]!;
    const frame = source.nodes[frameId];
    if (!frame || frame.type !== "frame") throw new Error("Expected starter frame.");
    source.pages[0]!.metadata = { locale: "fa-IR", text_direction: "rtl" };
    frame.metadata = { locale: "fa-IR", text_direction: "rtl" };

    const component = createComponentNode({
      name: "Legacy action",
      component_key: "action.legacy",
      layout: { width: 120, height: 40 },
      style: { fill: "#2457ff" },
    }, ids);
    const instance = createInstanceNode({
      name: "Legacy action instance",
      component_id: component.id,
      layout: { x: 160, y: 20, width: 120, height: 40 },
    }, ids);
    const smallButton = createRectangleNode({
      name: "Icon-only action",
      layout: { x: 20, y: 20, width: 32, height: 32 },
      style: { fill: "#ef4444", radius: 8 },
    }, ids);
    const rtlText = createTextNode({
      name: "RTL title",
      content: "بررسی سفارش",
      direction: "rtl",
      layout: { x: 20, y: 80, width: 240, height: 44 },
      style: {
        color: "#111827",
        typography: { font_family: "Vazirmatn", font_size: 24, text_align: "left" },
      },
    }, ids);
    frame.children.push(component.id, instance.id, smallButton.id, rtlText.id);
    source.nodes[component.id] = component;
    source.nodes[instance.id] = instance;
    source.nodes[smallButton.id] = smallButton;
    source.nodes[rtlText.id] = rtlText;

    const migrated = migrateDesignDocumentV1ToV2(source, {
      migratedAt: "2026-07-20T01:00:00.000Z",
    });
    const migratedFrame = migrated.nodes[frameId];
    const migratedButton = migrated.nodes[smallButton.id];
    const migratedText = migrated.nodes[rtlText.id];
    const migratedInstance = migrated.nodes[instance.id];
    const definition = Object.values(migrated.component_definitions)[0];
    if (!migratedFrame || migratedFrame.type !== "frame"
      || !migratedButton
      || !migratedText || migratedText.type !== "text"
      || !migratedInstance || migratedInstance.type !== "component_instance"
      || !definition) {
      throw new Error("Expected migrated V2 lint entities.");
    }

    migratedFrame.screen_purpose = "Review the order before payment.";
    migratedFrame.primary_action = "Submit order";
    migratedFrame.semantics.business_rule_ids = ["rule_missingv2lint0001"];
    migratedButton.semantics.role = "button";
    migratedButton.semantics.interaction_intent = "Open order actions";
    migratedText.style.typography = { ...migratedText.style.typography, text_align: "left" };
    definition.status = "deprecated";
    definition.properties_schema = [{
      key: "label",
      label: "Label",
      type: "text",
      required: true,
      max_length: 30,
    }];
    definition.slots = [{
      key: "content",
      name: "Content",
      required: true,
      min_items: 1,
      max_items: 1,
      allowed_node_types: ["text"],
    }];
    const componentRoot = migrated.nodes[definition.root_node_id];
    if (!componentRoot) throw new Error("Expected component root.");
    componentRoot.semantics.role = "button";
    migratedInstance.properties = { unknown: "value" };
    migratedInstance.slots = { unknown: [smallButton.id] };
    migratedInstance.active_state = "hover";
    migrated.product_specification.goals = [{
      id: "goal_v2lintmissing0001",
      title: "Linked goal",
      description: "Exercise strict design-entity links.",
      links: {
        page_ids: [],
        frame_ids: [],
        node_ids: ["node_v2lintmissing0001"],
        component_definition_ids: [],
        prototype_link_ids: [],
        implementation_target_ids: [],
      },
    }];

    const document = DesignDocumentV2Schema.parse(migrated);
    const first = lintDesignDocumentV2(document);
    const second = lintDesignDocumentV2(document);
    const codes = new Set(first.map((item) => item.code));

    expect(first).toEqual(second);
    for (const code of [
      "raw_design_value",
      "component_missing_state",
      "interactive_accessible_name_missing",
      "touch_target_too_small",
      "prototype_interaction_missing",
      "prototype_primary_action_missing",
      "rtl_physical_text_alignment",
      "deprecated_component_instance",
      "deprecated_component_replacement_missing",
      "component_required_property_missing",
      "component_property_unknown",
      "component_slot_cardinality_invalid",
      "component_slot_unknown",
      "component_active_state_missing",
      "business_rule_link_missing",
      "screen_rule_links_missing",
      "product_spec_link_missing",
    ]) expect(codes).toContain(code);
  });
});
