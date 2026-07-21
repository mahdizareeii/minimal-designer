import type { ComponentProperty, ComponentSlot } from "./design-system.js";
import { isTokenReference } from "./model.js";
import type { DesignDocumentV2, DesignNodeV2 } from "./model-v2.js";
import type { Diagnostic } from "./validation.js";

const MAX_V2_DIAGNOSTICS = 2_000;
const INTERACTIVE_ROLES = new Set<DesignNodeV2["semantics"]["role"]>(["button", "link", "input"]);
const RTL_LOCALE = /^(?:ar|fa|he|ur|ps|sd)(?:-|$)/i;

function children(node: DesignNodeV2): string[] {
  return node.type === "frame" || node.type === "container" ? node.children : [];
}

function diagnostic(
  severity: Diagnostic["severity"],
  code: string,
  message: string,
  path: Array<string | number>,
  entityId?: string,
): Diagnostic {
  return {
    severity,
    code,
    message,
    path,
    ...(entityId === undefined ? {} : { entity_id: entityId }),
  };
}

function propertyValueMatches(property: ComponentProperty, value: unknown): boolean {
  switch (property.type) {
    case "text": return typeof value === "string" && (property.max_length === undefined || value.length <= property.max_length);
    case "boolean": return typeof value === "boolean";
    case "enum": return typeof value === "string" && property.values.includes(value);
    case "icon": return typeof value === "string"
      || Boolean(value && typeof value === "object" && "icon_name" in value && typeof value.icon_name === "string");
    case "asset": return Boolean(value && typeof value === "object" && "asset_id" in value && typeof value.asset_id === "string");
    case "node_slot": return false;
  }
}

function rawDesignValuePaths(node: DesignNodeV2): string[][] {
  const paths: string[][] = [];
  const raw = (value: unknown, path: string[]) => {
    if (value !== undefined && !isTokenReference(value)) paths.push(path);
  };
  raw(node.layout.gap, ["layout", "gap"]);
  raw(node.layout.row_gap, ["layout", "row_gap"]);
  raw(node.layout.column_gap, ["layout", "column_gap"]);
  if (node.layout.padding !== undefined) {
    if (isTokenReference(node.layout.padding)) {
      // Token-backed compound spacing is already canonical.
    } else if (typeof node.layout.padding === "number") {
      paths.push(["layout", "padding"]);
    } else {
      for (const side of ["top", "right", "bottom", "left"] as const) {
        raw(node.layout.padding[side], ["layout", "padding", side]);
      }
    }
  }
  raw(node.style.fill, ["style", "fill"]);
  raw(node.style.color, ["style", "color"]);
  raw(node.style.opacity, ["style", "opacity"]);
  if (node.style.border) {
    raw(node.style.border.color, ["style", "border", "color"]);
    raw(node.style.border.width, ["style", "border", "width"]);
  }
  if (node.style.radius !== undefined) {
    if (isTokenReference(node.style.radius)) {
      // Token-backed radius is already canonical.
    } else if (typeof node.style.radius === "number") {
      paths.push(["style", "radius"]);
    } else {
      for (const corner of ["top_left", "top_right", "bottom_right", "bottom_left"] as const) {
        raw(node.style.radius[corner], ["style", "radius", corner]);
      }
    }
  }
  node.style.shadows?.forEach((shadow, index) => {
    raw(shadow.x, ["style", "shadows", String(index), "x"]);
    raw(shadow.y, ["style", "shadows", String(index), "y"]);
    raw(shadow.blur, ["style", "shadows", String(index), "blur"]);
    raw(shadow.spread, ["style", "shadows", String(index), "spread"]);
    raw(shadow.color, ["style", "shadows", String(index), "color"]);
  });
  const typography = node.style.typography;
  if (typography) {
    raw(typography.font_family, ["style", "typography", "font_family"]);
    raw(typography.font_size, ["style", "typography", "font_size"]);
    raw(typography.font_weight, ["style", "typography", "font_weight"]);
    if (typography.line_height !== "normal") raw(typography.line_height, ["style", "typography", "line_height"]);
    raw(typography.letter_spacing, ["style", "typography", "letter_spacing"]);
  }
  return paths;
}

function slotAllowsNode(slot: ComponentSlot, node: DesignNodeV2 | undefined): boolean {
  if (!node) return false;
  return !slot.allowed_node_types || slot.allowed_node_types.includes(node.type);
}

function specificationItems(document: DesignDocumentV2) {
  const specification = document.product_specification;
  return [
    ...specification.goals,
    ...specification.non_goals,
    ...specification.audiences,
    ...specification.roles,
    ...specification.entities,
    ...specification.flows,
    ...specification.business_rules,
    ...specification.permissions,
    ...specification.validations,
    ...specification.screen_states,
    ...specification.integrations,
    ...specification.analytics_events,
    ...specification.accessibility_requirements,
    ...specification.non_functional_requirements,
    ...specification.acceptance_criteria,
    ...specification.assumptions,
    ...specification.open_questions,
  ];
}

export function lintDesignDocumentV2(document: DesignDocumentV2): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  let truncated = false;
  const add = (item: Diagnostic) => {
    if (diagnostics.length < MAX_V2_DIAGNOSTICS) diagnostics.push(item);
    else truncated = true;
  };
  const parentByNode = new Map<string, string>();
  const reachable = new Set<string>();
  const directionByNode = new Map<string, "auto" | "ltr" | "rtl">();
  const outgoingLinks = new Set(Object.values(document.prototype_links).map((link) => link.source_node_id));

  const walk = (nodeId: string, inheritedDirection: "auto" | "ltr" | "rtl") => {
    if (reachable.has(nodeId)) return;
    const node = document.nodes[nodeId];
    if (!node) return;
    reachable.add(nodeId);
    const direction = node.type === "frame" && node.text_direction !== "auto"
      ? node.text_direction
      : inheritedDirection;
    directionByNode.set(nodeId, direction);
    for (const childId of children(node)) {
      parentByNode.set(childId, node.id);
      walk(childId, direction);
    }
  };
  for (const page of document.pages) {
    if (RTL_LOCALE.test(page.locale) && page.text_direction !== "rtl") {
      add(diagnostic(
        "warning",
        "rtl_locale_direction_mismatch",
        `Page ${page.name} uses RTL locale ${page.locale} without an explicit RTL direction.`,
        ["pages", page.id, "text_direction"],
        page.id,
      ));
    }
    if (!page.archived) for (const rootId of page.children) walk(rootId, page.text_direction);
  }

  const textDescendantCache = new Map<string, boolean>();
  const hasTextDescendant = (nodeId: string, seen = new Set<string>()): boolean => {
    const cached = textDescendantCache.get(nodeId);
    if (cached !== undefined) return cached;
    if (seen.has(nodeId)) return false;
    seen.add(nodeId);
    const node = document.nodes[nodeId];
    if (!node || node.archived || !node.visible) {
      textDescendantCache.set(nodeId, false);
      return false;
    }
    const result = node.type === "text" && node.content.trim().length > 0
      || children(node).some((childId) => hasTextDescendant(childId, seen));
    textDescendantCache.set(nodeId, result);
    return result;
  };

  const businessRuleIds = new Set(document.product_specification.business_rules.map((item) => item.id));
  const acceptanceCriterionIds = new Set(document.product_specification.acceptance_criteria.map((item) => item.id));
  for (const node of Object.values(document.nodes)) {
    if (node.archived) continue;
    const rawPaths = rawDesignValuePaths(node);
    for (const rawPath of rawPaths) {
      add(diagnostic(
        "info",
        "raw_design_value",
        `Node ${node.name} uses a raw design value instead of a typed token reference.`,
        ["nodes", node.id, ...rawPath],
        node.id,
      ));
    }

    for (const ruleId of node.semantics.business_rule_ids) {
      if (!businessRuleIds.has(ruleId)) add(diagnostic(
        "error",
        "business_rule_link_missing",
        `Node ${node.name} references missing business rule ${ruleId}.`,
        ["nodes", node.id, "semantics", "business_rule_ids"],
        node.id,
      ));
    }
    for (const criterionId of node.semantics.acceptance_criterion_ids) {
      if (!acceptanceCriterionIds.has(criterionId)) add(diagnostic(
        "error",
        "acceptance_criterion_link_missing",
        `Node ${node.name} references missing acceptance criterion ${criterionId}.`,
        ["nodes", node.id, "semantics", "acceptance_criterion_ids"],
        node.id,
      ));
    }

    const interactive = INTERACTIVE_ROLES.has(node.semantics.role) || outgoingLinks.has(node.id);
    if (interactive && (node.layout.width < 44 || node.layout.height < 44)) {
      add(diagnostic(
        "warning",
        "touch_target_too_small",
        `Interactive node ${node.name} is smaller than 44×44.`,
        ["nodes", node.id, "layout"],
        node.id,
      ));
    }
    if (INTERACTIVE_ROLES.has(node.semantics.role)
      && !node.semantics.accessibility_label?.trim()
      && !hasTextDescendant(node.id)) {
      add(diagnostic(
        "warning",
        "interactive_accessible_name_missing",
        `Interactive node ${node.name} has no accessible label or visible text.`,
        ["nodes", node.id, "semantics", "accessibility_label"],
        node.id,
      ));
    }
    if (node.type === "image" && !node.alt.trim() && !node.semantics.accessibility_label?.trim()) {
      add(diagnostic(
        "warning",
        "image_accessible_name_missing",
        `Image ${node.name} has no alternative text.`,
        ["nodes", node.id, "alt"],
        node.id,
      ));
    }
    if (node.semantics.role === "heading" && node.type !== "text") {
      add(diagnostic(
        "warning",
        "semantic_hierarchy_mismatch",
        `Heading role on ${node.name} should be applied to a text node.`,
        ["nodes", node.id, "semantics", "role"],
        node.id,
      ));
    }
    if (node.semantics.role === "list_item") {
      const parent = parentByNode.get(node.id);
      if (!parent || document.nodes[parent]?.semantics.role !== "list") add(diagnostic(
        "warning",
        "semantic_hierarchy_mismatch",
        `List item ${node.name} is not directly contained by a semantic list.`,
        ["nodes", node.id, "semantics", "role"],
        node.id,
      ));
    }
    if (node.semantics.interaction_intent && !outgoingLinks.has(node.id)) {
      add(diagnostic(
        "warning",
        "prototype_interaction_missing",
        `Node ${node.name} describes an interaction but has no prototype link.`,
        ["nodes", node.id, "semantics", "interaction_intent"],
        node.id,
      ));
    }
    if (node.type === "frame") {
      if (RTL_LOCALE.test(node.locale) && node.text_direction !== "rtl") {
        add(diagnostic(
          "warning",
          "rtl_locale_direction_mismatch",
          `Frame ${node.name} uses RTL locale ${node.locale} without an explicit RTL direction.`,
          ["nodes", node.id, "text_direction"],
          node.id,
        ));
      }
      if (node.primary_action && !outgoingLinks.has(node.id)) {
        add(diagnostic(
          "warning",
          "prototype_primary_action_missing",
          `Frame ${node.name} declares a primary action but has no prototype link.`,
          ["nodes", node.id, "primary_action"],
          node.id,
        ));
      }
      if ((node.user_story || node.screen_purpose)
        && !node.semantics.business_rule_ids.some((id) => businessRuleIds.has(id))
        && !node.semantics.acceptance_criterion_ids.some((id) => acceptanceCriterionIds.has(id))) {
        add(diagnostic(
          "warning",
          "screen_rule_links_missing",
          `Frame ${node.name} has product context but no business-rule or acceptance-criterion links.`,
          ["nodes", node.id, "semantics"],
          node.id,
        ));
      }
    }
    if (node.type === "text"
      && directionByNode.get(node.id) === "rtl"
      && (node.style.typography?.text_align === "left" || node.style.typography?.text_align === "right")) {
      add(diagnostic(
        "warning",
        "rtl_physical_text_alignment",
        `RTL text ${node.name} uses physical alignment; prefer start/end.`,
        ["nodes", node.id, "style", "typography", "text_align"],
        node.id,
      ));
    }
  }

  for (const definition of Object.values(document.component_definitions)) {
    const root = document.nodes[definition.root_node_id];
    if (!root || (!root.archived && !reachable.has(root.id))) {
      add(diagnostic(
        "warning",
        "component_definition_detached",
        `Component ${definition.name} is detached from the active document tree.`,
        ["component_definitions", definition.id, "root_node_id"],
        definition.id,
      ));
    }
    for (const state of definition.states) {
      const stateNode = document.nodes[state.node_id];
      if (!stateNode) add(diagnostic(
        "error",
        "component_state_node_missing",
        `Component ${definition.name} state ${state.key} references a missing or archived node.`,
        ["component_definitions", definition.id, "states", state.key, "node_id"],
        definition.id,
      ));
    }
    if (root && INTERACTIVE_ROLES.has(root.semantics.role)) {
      const stateKeys = new Set(definition.states.map((state) => state.key));
      const requiredStates = root.semantics.role === "input"
        ? ["focused", "disabled", "error"] as const
        : ["hover", "pressed", "focused", "disabled"] as const;
      for (const state of requiredStates) {
        if (!stateKeys.has(state)) add(diagnostic(
          "warning",
          "component_missing_state",
          `Interactive component ${definition.name} is missing its ${state} state.`,
          ["component_definitions", definition.id, "states"],
          definition.id,
        ));
      }
    }
    if (definition.status === "deprecated" && !definition.replacement_component_id) {
      add(diagnostic(
        "warning",
        "deprecated_component_replacement_missing",
        `Deprecated component ${definition.name} has no replacement component.`,
        ["component_definitions", definition.id, "replacement_component_id"],
        definition.id,
      ));
    }
  }

  for (const node of Object.values(document.nodes)) {
    if (node.type !== "component_instance" || node.archived) continue;
    const definition = document.component_definitions[node.component_definition_id];
    if (!definition) continue;
    if (definition.status === "draft") add(diagnostic(
      "warning",
      "draft_component_instance",
      `Instance ${node.name} is pinned to draft component ${definition.name}.`,
      ["nodes", node.id, "component_definition_id"],
      node.id,
    ));
    if (definition.status === "deprecated") add(diagnostic(
      "warning",
      "deprecated_component_instance",
      `Instance ${node.name} is pinned to deprecated component ${definition.name}.`,
      ["nodes", node.id, "component_definition_id"],
      node.id,
    ));
    const properties = new Map(definition.properties_schema.map((property) => [property.key, property]));
    for (const property of definition.properties_schema) {
      if (property.type === "node_slot") continue;
      const value = node.properties[property.key];
      if (property.required && value === undefined) add(diagnostic(
        "error",
        "component_required_property_missing",
        `Instance ${node.name} is missing required property ${property.key}.`,
        ["nodes", node.id, "properties", property.key],
        node.id,
      ));
      else if (value !== undefined && !propertyValueMatches(property, value)) add(diagnostic(
        "error",
        "component_property_invalid",
        `Instance ${node.name} has an invalid value for property ${property.key}.`,
        ["nodes", node.id, "properties", property.key],
        node.id,
      ));
    }
    for (const propertyKey of Object.keys(node.properties)) {
      if (!properties.has(propertyKey)) add(diagnostic(
        "error",
        "component_property_unknown",
        `Instance ${node.name} uses unknown property ${propertyKey}.`,
        ["nodes", node.id, "properties", propertyKey],
        node.id,
      ));
    }
    const slots = new Map<string, ComponentSlot>(definition.slots.map((slot) => [slot.key, slot]));
    for (const property of definition.properties_schema) {
      if (property.type === "node_slot" && !slots.has(property.key)) {
        slots.set(property.key, {
          key: property.key,
          name: property.label,
          required: property.required,
          min_items: property.min_items,
          max_items: property.max_items,
        });
      }
    }
    for (const slot of slots.values()) {
      const values = node.slots[slot.key] ?? [];
      if ((slot.required && values.length === 0) || values.length < slot.min_items || values.length > slot.max_items) {
        add(diagnostic(
          "error",
          "component_slot_cardinality_invalid",
          `Instance ${node.name} slot ${slot.key} violates its item-count contract.`,
          ["nodes", node.id, "slots", slot.key],
          node.id,
        ));
      }
      for (const childId of values) {
        if (!slotAllowsNode(slot, document.nodes[childId])) add(diagnostic(
          "error",
          "component_slot_node_invalid",
          `Instance ${node.name} slot ${slot.key} contains an unavailable or disallowed node.`,
          ["nodes", node.id, "slots", slot.key],
          node.id,
        ));
      }
    }
    for (const slotKey of Object.keys(node.slots)) {
      if (!slots.has(slotKey)) add(diagnostic(
        "error",
        "component_slot_unknown",
        `Instance ${node.name} uses unknown slot ${slotKey}.`,
        ["nodes", node.id, "slots", slotKey],
        node.id,
      ));
    }
    if (!definition.states.some((state) => state.key === node.active_state)) add(diagnostic(
      "warning",
      "component_active_state_missing",
      `Instance ${node.name} selects unavailable state ${node.active_state}.`,
      ["nodes", node.id, "active_state"],
      node.id,
    ));
  }

  const pages = new Set(document.pages.map((page) => page.id));
  const frames = new Set(Object.values(document.nodes).filter((node) => node.type === "frame").map((node) => node.id));
  for (const item of specificationItems(document)) {
    const missing = [
      ...item.links.page_ids.filter((id) => !pages.has(id)),
      ...item.links.frame_ids.filter((id) => !frames.has(id)),
      ...item.links.node_ids.filter((id) => !document.nodes[id]),
      ...item.links.component_definition_ids.filter((id) => !document.component_definitions[id]),
      ...item.links.prototype_link_ids.filter((id) => !document.prototype_links[id]),
      ...item.links.implementation_target_ids.filter((id) => !document.implementation_mappings[id]),
    ];
    for (const missingId of missing) add(diagnostic(
      "error",
      "product_spec_link_missing",
      `Product specification item ${item.title} references missing design entity ${missingId}.`,
      ["product_specification", item.id, "links"],
      item.id,
    ));
  }

  if (truncated) diagnostics.push(diagnostic(
    "warning",
    "v2_lint_diagnostics_truncated",
    `V2 lint diagnostics were truncated at ${MAX_V2_DIAGNOSTICS} entries.`,
    [],
  ));
  return diagnostics;
}
