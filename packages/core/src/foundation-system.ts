import {
  ComponentDefinitionSchema,
  DesignSystemReleaseSchema,
  DesignSystemTokenSchema,
  type ComponentDefinition,
  type DesignSystemToken,
} from "./design-system.js";
import type { NodeId, TokenId } from "./ids.js";
import { DesignNodeV2Schema, type DesignNodeV2 } from "./model-v2.js";

export const FORMASPEC_FOUNDATION_SYSTEM_ID = "system_formaspec_foundation" as const;
export const FORMASPEC_FOUNDATION_RELEASE_ID = "release_formaspec_foundation_1" as const;
export const FORMASPEC_FOUNDATION_VERSION = 1 as const;

function tokenId(path: string): TokenId {
  return `token_foundation_${path.replace(/[^A-Za-z0-9]+/g, "_")}` as TokenId;
}

function token(
  path: string,
  family: DesignSystemToken["family"],
  layer: DesignSystemToken["layer"],
  value: DesignSystemToken["value"],
  modes?: DesignSystemToken["modes"],
): DesignSystemToken {
  return DesignSystemTokenSchema.parse({
    id: tokenId(path),
    path,
    name: path.split(".").map((part) => part.replace(/(^|[-_])\w/g, (match) => match.toUpperCase())).join(" "),
    family,
    layer,
    value,
    ...(modes === undefined ? {} : { modes }),
    deprecated: false,
  });
}

const foundationTokens = [
  token("color.blue.600", "color", "primitive", "#2457e6"),
  token("color.blue.700", "color", "primitive", "#1d45b8"),
  token("color.neutral.0", "color", "primitive", "#ffffff"),
  token("color.neutral.50", "color", "primitive", "#f8fafc"),
  token("color.neutral.100", "color", "primitive", "#f1f5f9"),
  token("color.neutral.300", "color", "primitive", "#cbd5e1"),
  token("color.neutral.600", "color", "primitive", "#475569"),
  token("color.neutral.900", "color", "primitive", "#0f172a"),
  token("color.red.600", "color", "primitive", "#dc2626"),
  token("color.green.600", "color", "primitive", "#16a34a"),
  token("spacing.1", "spacing", "primitive", 4),
  token("spacing.2", "spacing", "primitive", 8),
  token("spacing.3", "spacing", "primitive", 12),
  token("spacing.4", "spacing", "primitive", 16),
  token("spacing.5", "spacing", "primitive", 20),
  token("spacing.6", "spacing", "primitive", 24),
  token("spacing.8", "spacing", "primitive", 32),
  token("spacing.10", "spacing", "primitive", 40),
  token("radius.1", "radius", "primitive", 4),
  token("radius.2", "radius", "primitive", 8),
  token("radius.3", "radius", "primitive", 12),
  token("radius.full", "radius", "primitive", 999),
  token("border.width.1", "border_width", "primitive", 1),
  token("opacity.disabled", "opacity", "primitive", 0.48),
  token("font.family.sans", "font_family", "primitive", "Inter"),
  token("font.family.rtl", "font_family", "primitive", "Vazirmatn"),
  token("font.weight.regular", "font_weight", "primitive", 400),
  token("font.weight.medium", "font_weight", "primitive", 500),
  token("font.weight.semibold", "font_weight", "primitive", 600),
  token("font.size.sm", "font_size", "primitive", 14),
  token("font.size.md", "font_size", "primitive", 16),
  token("font.size.lg", "font_size", "primitive", 20),
  token("line.height.sm", "line_height", "primitive", 20),
  token("line.height.md", "line_height", "primitive", 24),
  token("letter.spacing.normal", "letter_spacing", "primitive", 0),
  token("shadow.elevated", "shadow", "primitive", { x: 0, y: 8, blur: 24, spread: -8, color: "#0f172a2e" }),
  token("action.primary.background", "color", "semantic", { token_id: tokenId("color.blue.600") }, {
    dark: "#5b7cfa",
    high_contrast: "#0037ff",
  }),
  token("action.primary.background.hover", "color", "semantic", { token_id: tokenId("color.blue.700") }),
  token("action.primary.text", "color", "semantic", { token_id: tokenId("color.neutral.0") }),
  token("text.default", "color", "semantic", { token_id: tokenId("color.neutral.900") }, {
    dark: "#f8fafc",
    high_contrast: "#000000",
  }),
  token("text.muted", "color", "semantic", { token_id: tokenId("color.neutral.600") }, { dark: "#cbd5e1" }),
  token("text.critical", "color", "semantic", { token_id: tokenId("color.red.600") }),
  token("surface.canvas", "color", "semantic", { token_id: tokenId("color.neutral.50") }, { dark: "#0f172a", high_contrast: "#ffffff" }),
  token("surface.elevated", "color", "semantic", { token_id: tokenId("color.neutral.0") }, { dark: "#1e293b" }),
  token("surface.subtle", "color", "semantic", { token_id: tokenId("color.neutral.100") }, { dark: "#334155" }),
  token("border.default", "color", "semantic", { token_id: tokenId("color.neutral.300") }, { dark: "#475569" }),
  token("border.critical", "color", "semantic", { token_id: tokenId("color.red.600") }),
  token("focus.ring", "color", "semantic", { token_id: tokenId("color.blue.600") }, { high_contrast: "#000000" }),
  token("status.success", "color", "semantic", { token_id: tokenId("color.green.600") }),
  token("button.primary.background", "color", "component", { token_id: tokenId("action.primary.background") }),
  token("button.primary.text", "color", "component", { token_id: tokenId("action.primary.text") }),
  token("input.background", "color", "component", { token_id: tokenId("surface.elevated") }),
  token("input.border", "color", "component", { token_id: tokenId("border.default") }),
  token("input.error.border", "color", "component", { token_id: tokenId("border.critical") }),
  token("table.header.background", "color", "component", { token_id: tokenId("surface.subtle") }),
  token("table.header.text", "color", "component", { token_id: tokenId("text.default") }),
];

const REQUIRED_COMPONENTS = [
  "Button",
  "Icon button",
  "Link",
  "Text field",
  "Textarea",
  "Select",
  "Checkbox",
  "Radio",
  "Switch",
  "Search field",
  "Badge",
  "Avatar",
  "Card",
  "Alert",
  "Tabs",
  "Table",
  "Pagination",
  "Empty state",
  "Loading state",
  "Error state",
  "Dialog",
  "Toast",
  "Application shell",
  "Top navigation",
  "Side navigation",
  "Mobile navigation",
] as const;

export const FORMASPEC_FOUNDATION_PATTERNS = [
  "Authentication",
  "Dashboard",
  "List and detail",
  "Search and filters",
  "Data table",
  "Settings",
  "Create/edit form",
  "Confirmation",
  "Destructive action",
  "Loading",
  "Empty",
  "Error",
  "Permission denied",
  "Mobile onboarding",
  "RTL application shell",
] as const;

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function nodeId(componentName: string, state: string, part: "root" | "label"): NodeId {
  return `node_foundation_${slug(componentName)}_${slug(state)}_${part}` as NodeId;
}

function componentStates(name: string): Array<"default" | "hover" | "pressed" | "focused" | "disabled" | "loading" | "error" | "selected"> {
  if (["Button", "Icon button"].includes(name)) return ["default", "hover", "pressed", "focused", "disabled", "loading"];
  if (["Text field", "Textarea", "Select", "Search field"].includes(name)) return ["default", "focused", "disabled", "loading", "error"];
  if (["Checkbox", "Radio", "Switch", "Tabs"].includes(name)) return ["default", "focused", "disabled", "selected"];
  return ["default"];
}

function componentSize(name: string): { width: number; height: number } {
  if (name.includes("navigation") || name === "Application shell") return { width: 960, height: name === "Side navigation" ? 720 : 72 };
  if (["Dialog", "Table", "Card", "Empty state", "Error state"].includes(name)) return { width: 480, height: 280 };
  if (["Textarea", "Alert", "Tabs", "Pagination"].includes(name)) return { width: 360, height: 112 };
  if (["Checkbox", "Radio", "Switch", "Badge", "Avatar", "Icon button", "Link"].includes(name)) return { width: 160, height: 44 };
  return { width: 320, height: 48 };
}

function makeComponent(name: string): { nodes: DesignNodeV2[]; definition: ComponentDefinition } {
  const key = slug(name).replaceAll("_", ".");
  const states = componentStates(name);
  const size = componentSize(name);
  const nodes: DesignNodeV2[] = [];

  for (const state of states) {
    const rootId = nodeId(name, state, "root");
    const labelId = nodeId(name, state, "label");
    const error = state === "error";
    const disabled = state === "disabled";
    const primary = name === "Button" || name === "Icon button";
    nodes.push(DesignNodeV2Schema.parse({
      id: rootId,
      name: `${name} / ${state}`,
      type: "container",
      children: [labelId],
      clip_content: true,
      layout: {
        x: 0,
        y: 0,
        width: size.width,
        height: size.height,
        mode: "horizontal",
        width_sizing: "fixed",
        height_sizing: "fixed",
        gap: { token_id: tokenId("spacing.2") },
        padding: { token_id: tokenId("spacing.3") },
        align_items: "center",
        justify_content: name.includes("navigation") ? "space-between" : "center",
      },
      style: {
        fill: { token_id: primary ? tokenId("button.primary.background") : tokenId("surface.elevated") },
        color: { token_id: primary ? tokenId("button.primary.text") : error ? tokenId("text.critical") : tokenId("text.default") },
        opacity: disabled ? { token_id: tokenId("opacity.disabled") } : 1,
        border: {
          color: { token_id: error ? tokenId("input.error.border") : tokenId("border.default") },
          width: { token_id: tokenId("border.width.1") },
          style: "solid",
        },
        radius: { token_id: name === "Badge" || name === "Avatar" ? tokenId("radius.full") : tokenId("radius.2") },
        ...(state === "focused" ? { shadows: [{ x: 0, y: 0, blur: 0, spread: 3, color: { token_id: tokenId("focus.ring") } }] } : {}),
      },
      visible: true,
      locked: false,
      archived: false,
      semantics: {
        role: name === "Link" ? "link" : primary ? "button" : name.includes("navigation") ? "navigation" : "generic",
        accessibility_label: name,
        state_name: state,
        business_rule_ids: [],
        acceptance_criterion_ids: [],
      },
      metadata: { foundation_component: key, foundation_state: state },
    }));
    nodes.push(DesignNodeV2Schema.parse({
      id: labelId,
      name: `${name} label`,
      type: "text",
      content: state === "loading" ? "Loading…" : name,
      direction: "auto",
      layout: {
        x: 0,
        y: 0,
        width: Math.max(80, size.width - 32),
        height: 24,
        mode: "absolute",
        width_sizing: "fill",
        height_sizing: "hug",
      },
      style: {
        color: { token_id: primary ? tokenId("button.primary.text") : error ? tokenId("text.critical") : tokenId("text.default") },
        typography: {
          font_family: { token_id: tokenId("font.family.sans") },
          font_size: { token_id: tokenId("font.size.md") },
          font_weight: { token_id: tokenId("font.weight.medium") },
          line_height: { token_id: tokenId("line.height.md") },
          text_align: "center",
        },
      },
      visible: true,
      locked: false,
      archived: false,
      semantics: {
        role: "generic",
        business_rule_ids: [],
        acceptance_criterion_ids: [],
      },
      metadata: { foundation_component_label: key },
    }));
  }

  const definitionId = `component_foundation_${slug(name)}`;
  const definition = ComponentDefinitionSchema.parse({
    id: definitionId,
    key,
    name,
    version: 1,
    status: "published",
    root_node_id: nodeId(name, "default", "root"),
    properties_schema: [
      { key: "label", label: "Label", type: "text", required: false, default: name, max_length: 1_000 },
      { key: "disabled", label: "Disabled", type: "boolean", required: false, default: false },
    ],
    slots: [],
    states: states.map((state) => ({ key: state, name: state[0]!.toUpperCase() + state.slice(1), node_id: nodeId(name, state, "root") })),
    allowed_overrides: {
      allow_text: true,
      allow_assets: name === "Avatar" || name === "Card",
      allow_icons: name === "Button" || name === "Icon button" || name.includes("navigation"),
      allowed_token_families: ["color", "spacing", "radius", "typography"],
      allowed_style_paths: ["fill", "color", "border", "radius", "typography"],
    },
    platform_mappings: [],
    documentation: {
      summary: `${name} from the FormaSpec Foundation System. Uses semantic and component tokens and supports deterministic LTR/RTL rendering.`,
      usage: [`Use ${name} consistently instead of detached look-alike layers.`],
      accessibility: ["Provide a meaningful accessible label and preserve visible focus indication."],
      do_list: ["Use the documented properties and states."],
      dont_list: ["Do not bypass the component contract with raw CSS or arbitrary overrides."],
    },
  });
  return { nodes, definition };
}

const components = REQUIRED_COMPONENTS.map(makeComponent);

export const FORMASPEC_FOUNDATION_SYSTEM = Object.freeze({
  id: FORMASPEC_FOUNDATION_SYSTEM_ID,
  name: "FormaSpec Foundation System",
  version: FORMASPEC_FOUNDATION_VERSION,
  fonts: Object.freeze([
    { family: "Inter", license: "OFL-1.1" },
    { family: "Vazirmatn", license: "OFL-1.1" },
  ]),
  iconSet: Object.freeze({ name: "Lucide", license: "ISC" }),
  tokens: Object.freeze(Object.fromEntries(foundationTokens.map((item) => [item.id, item]))),
  nodes: Object.freeze(Object.fromEntries(components.flatMap((item) => item.nodes.map((node) => [node.id, node])))),
  components: Object.freeze(Object.fromEntries(components.map((item) => [item.definition.id, item.definition]))),
  patterns: FORMASPEC_FOUNDATION_PATTERNS,
  release: DesignSystemReleaseSchema.parse({
    id: FORMASPEC_FOUNDATION_RELEASE_ID,
    design_system_id: FORMASPEC_FOUNDATION_SYSTEM_ID,
    version: FORMASPEC_FOUNDATION_VERSION,
    name: "FormaSpec Foundation System 1",
    status: "published",
    token_ids: foundationTokens.map((item) => item.id),
    component_versions: components.map((item) => ({ component_definition_id: item.definition.id, version: item.definition.version })),
    created_at: "2026-01-01T00:00:00.000Z",
    published_at: "2026-01-01T00:00:00.000Z",
  }),
});

export type FormaSpecFoundationSystem = typeof FORMASPEC_FOUNDATION_SYSTEM;
