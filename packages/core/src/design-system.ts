import { z } from "zod";

import { AssetIdSchema, NodeIdSchema, TokenIdSchema } from "./ids.js";
import { ComponentDefinitionIdSchema } from "./product-spec.js";

const opaqueId = (prefix: string) => z.string().regex(
  new RegExp(`^${prefix}_[A-Za-z0-9][A-Za-z0-9_-]{7,}$`),
  `Invalid ${prefix} id`,
);

export const DesignSystemIdSchema = opaqueId("system");
export const DesignSystemReleaseIdSchema = opaqueId("release");

export const DesignTokenFamilySchema = z.enum([
  "color",
  "spacing",
  "dimension",
  "radius",
  "border_width",
  "opacity",
  "font_family",
  "font_weight",
  "font_size",
  "line_height",
  "letter_spacing",
  "typography",
  "shadow",
  "string",
  "number",
  "duration",
]);
export const DesignTokenLayerSchema = z.enum(["primitive", "semantic", "component"]);

export const DesignTokenAliasSchema = z.object({ token_id: TokenIdSchema }).strict();
export const DesignSystemTokenValueSchema = z.union([
  z.string().max(4_000),
  z.number().finite(),
  z.object({
    font_family: z.string().max(1_000).optional(),
    font_weight: z.union([z.string().max(100), z.number().int().min(1).max(1_000)]).optional(),
    font_size: z.number().finite().positive().optional(),
    line_height: z.union([z.number().finite().positive(), z.literal("normal")]).optional(),
    letter_spacing: z.number().finite().optional(),
  }).strict(),
  z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    blur: z.number().finite().nonnegative(),
    spread: z.number().finite().optional(),
    color: z.string().max(200),
    inset: z.boolean().optional(),
  }).strict(),
]);

export const DesignSystemTokenSchema = z.object({
  id: TokenIdSchema,
  path: z.string().trim().min(1).max(240).regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/),
  name: z.string().trim().min(1).max(240),
  family: DesignTokenFamilySchema,
  layer: DesignTokenLayerSchema,
  value: z.union([DesignSystemTokenValueSchema, DesignTokenAliasSchema]),
  modes: z.record(z.union([DesignSystemTokenValueSchema, DesignTokenAliasSchema])).optional(),
  description: z.string().max(4_000).optional(),
  deprecated: z.boolean().default(false),
  replacement_token_id: TokenIdSchema.optional(),
}).strict().superRefine((token, context) => {
  if (token.replacement_token_id === token.id) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["replacement_token_id"], message: "A token cannot replace itself" });
  }
});
export type DesignSystemToken = z.infer<typeof DesignSystemTokenSchema>;

const propertyBase = {
  key: z.string().trim().min(1).max(160).regex(/^[A-Za-z][A-Za-z0-9_]*$/),
  label: z.string().trim().min(1).max(240),
  required: z.boolean().default(false),
  description: z.string().max(2_000).optional(),
};

export const ComponentPropertySchema = z.discriminatedUnion("type", [
  z.object({ ...propertyBase, type: z.literal("text"), default: z.string().max(20_000).optional(), max_length: z.number().int().positive().max(100_000).optional() }).strict(),
  z.object({ ...propertyBase, type: z.literal("boolean"), default: z.boolean().optional() }).strict(),
  z.object({ ...propertyBase, type: z.literal("enum"), values: z.array(z.string().trim().min(1).max(160)).min(1).max(100), default: z.string().max(160).optional() }).strict(),
  z.object({ ...propertyBase, type: z.literal("icon"), default: z.string().max(160).optional() }).strict(),
  z.object({ ...propertyBase, type: z.literal("asset"), accepted_mime_types: z.array(z.enum(["image/png", "image/jpeg", "image/webp"])).min(1).max(3).default(["image/png", "image/jpeg", "image/webp"]), default_asset_id: AssetIdSchema.optional() }).strict(),
  z.object({ ...propertyBase, type: z.literal("node_slot"), min_items: z.number().int().nonnegative().max(100).default(0), max_items: z.number().int().positive().max(100).default(1) }).strict(),
]);
export type ComponentProperty = z.infer<typeof ComponentPropertySchema>;

export const ComponentSlotSchema = z.object({
  key: z.string().trim().min(1).max(160).regex(/^[A-Za-z][A-Za-z0-9_]*$/),
  name: z.string().trim().min(1).max(240),
  required: z.boolean().default(false),
  min_items: z.number().int().nonnegative().max(100).default(0),
  max_items: z.number().int().positive().max(100).default(1),
  allowed_node_types: z.array(z.enum(["frame", "container", "text", "rectangle", "ellipse", "image", "icon", "component_instance"])).max(8).optional(),
}).strict().superRefine((slot, context) => {
  if (slot.min_items > slot.max_items) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["min_items"], message: "min_items must not exceed max_items" });
  }
});
export type ComponentSlot = z.infer<typeof ComponentSlotSchema>;

export const ComponentStateSchema = z.object({
  key: z.enum(["default", "hover", "pressed", "focused", "disabled", "loading", "error", "selected"]),
  name: z.string().trim().min(1).max(240),
  node_id: NodeIdSchema,
}).strict();

export const OverridePolicySchema = z.object({
  allow_text: z.boolean().default(false),
  allow_assets: z.boolean().default(false),
  allow_icons: z.boolean().default(false),
  allowed_token_families: z.array(DesignTokenFamilySchema).max(20).default([]),
  allowed_style_paths: z.array(z.enum([
    "fill",
    "color",
    "opacity",
    "border",
    "radius",
    "shadows",
    "typography",
  ])).max(20).default([]),
}).strict();

export const PlatformMappingSchema = z.object({
  platform: z.enum(["web", "android", "ios", "flutter", "react_native", "other"]),
  framework: z.string().trim().min(1).max(160).optional(),
  symbol: z.string().trim().min(1).max(500),
  notes: z.string().max(4_000).optional(),
}).strict();

export const ComponentDocumentationSchema = z.object({
  summary: z.string().max(10_000).default(""),
  usage: z.array(z.string().trim().min(1).max(4_000)).max(100).default([]),
  accessibility: z.array(z.string().trim().min(1).max(4_000)).max(100).default([]),
  do_list: z.array(z.string().trim().min(1).max(4_000)).max(100).default([]),
  dont_list: z.array(z.string().trim().min(1).max(4_000)).max(100).default([]),
}).strict();

export const ComponentDefinitionSchema = z.object({
  id: ComponentDefinitionIdSchema,
  key: z.string().trim().min(1).max(200).regex(/^[A-Za-z][A-Za-z0-9_.-]*$/),
  name: z.string().trim().min(1).max(240),
  version: z.number().int().positive(),
  status: z.enum(["draft", "published", "deprecated"]),
  root_node_id: NodeIdSchema,
  properties_schema: z.array(ComponentPropertySchema).max(100).default([]),
  slots: z.array(ComponentSlotSchema).max(50).default([]),
  states: z.array(ComponentStateSchema).min(1).max(8),
  allowed_overrides: OverridePolicySchema,
  platform_mappings: z.array(PlatformMappingSchema).max(100).default([]),
  documentation: ComponentDocumentationSchema,
  replacement_component_id: ComponentDefinitionIdSchema.optional(),
}).strict().superRefine((definition, context) => {
  if (!definition.states.some((state) => state.key === "default")) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["states"], message: "A component requires a default state" });
  }
  const propertyKeys = new Set<string>();
  for (const property of definition.properties_schema) {
    if (propertyKeys.has(property.key)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["properties_schema"], message: `Duplicate property key: ${property.key}` });
    propertyKeys.add(property.key);
    if (property.type === "enum" && property.default !== undefined && !property.values.includes(property.default)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["properties_schema"], message: `Invalid enum default for ${property.key}` });
    }
  }
  if (definition.replacement_component_id === definition.id) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["replacement_component_id"], message: "A component cannot replace itself" });
  }
});
export type ComponentDefinition = z.infer<typeof ComponentDefinitionSchema>;

export const DesignSystemReleaseSchema = z.object({
  id: DesignSystemReleaseIdSchema,
  design_system_id: DesignSystemIdSchema,
  version: z.number().int().positive(),
  name: z.string().trim().min(1).max(240),
  status: z.enum(["draft", "published", "deprecated"]),
  token_ids: z.array(TokenIdSchema).max(20_000),
  component_versions: z.array(z.object({
    component_definition_id: ComponentDefinitionIdSchema,
    version: z.number().int().positive(),
  }).strict()).max(5_000),
  created_at: z.string().datetime({ offset: true }),
  published_at: z.string().datetime({ offset: true }).optional(),
}).strict();

export const DesignSystemPinSchema = z.object({
  design_system_id: DesignSystemIdSchema,
  release_id: DesignSystemReleaseIdSchema,
  release_version: z.number().int().positive(),
}).strict();
export type DesignSystemPin = z.infer<typeof DesignSystemPinSchema>;

export interface TokenResolutionResult {
  token: DesignSystemToken;
  value: z.infer<typeof DesignSystemTokenValueSchema>;
  path: string[];
}

export function resolveDesignToken(
  tokens: Record<string, DesignSystemToken>,
  tokenId: string,
  mode?: string,
  maxDepth = 64,
): TokenResolutionResult {
  const path: string[] = [];
  const seen = new Set<string>();
  const initial = tokens[tokenId];
  if (!initial) throw new Error(`Unknown token: ${tokenId}`);
  let current: DesignSystemToken = initial;
  const requested = current;

  for (let depth = 0; depth <= maxDepth; depth += 1) {
    if (seen.has(current.id)) throw new Error(`Token cycle: ${[...path, current.id].join(" -> ")}`);
    seen.add(current.id);
    path.push(current.id);
    const candidate: DesignSystemToken["value"] = mode && current.modes?.[mode] !== undefined
      ? current.modes[mode]!
      : current.value;
    if (!(typeof candidate === "object" && candidate !== null && "token_id" in candidate)) {
      return { token: requested, value: candidate, path };
    }
    const next: DesignSystemToken | undefined = tokens[candidate.token_id];
    if (!next) throw new Error(`Unknown token alias target: ${candidate.token_id}`);
    if (next.family !== current.family) throw new Error(`Token family mismatch: ${current.id} -> ${next.id}`);
    current = next;
  }
  throw new Error(`Token reference depth exceeds ${maxDepth}`);
}
