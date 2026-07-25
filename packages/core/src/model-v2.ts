import { z } from "zod";

import {
  AssetIdSchema,
  DocumentIdSchema,
  NodeIdSchema,
  PageIdSchema,
  PrototypeLinkIdSchema,
  TokenIdSchema,
} from "./ids.js";
import {
  DesignDocumentSchema,
  MetadataSchema,
  NodeLayoutSchema,
  NodeStyleSchema,
  PrototypeActionSchema,
  PrototypeTransitionSchema,
  PrototypeTriggerSchema,
  ResponsiveFrameVariantSchema,
  StringValueSchema,
} from "./model.js";
import {
  ComponentDefinitionIdSchema,
  ImplementationTargetIdSchema,
  ProductSpecificationSchema,
} from "./product-spec.js";
import {
  ComponentDefinitionSchema,
  DesignSystemPinSchema,
  DesignSystemTokenSchema,
} from "./design-system.js";
import { validateResponsiveFrameVariants } from "./responsive-frame-variants.js";

export const SemanticRoleSchema = z.enum([
  "button",
  "link",
  "heading",
  "input",
  "image",
  "navigation",
  "list",
  "list_item",
  "dialog",
  "status",
  "generic",
]);

export const NodeSemanticsSchema = z.object({
  role: SemanticRoleSchema.default("generic"),
  accessibility_label: z.string().max(2_000).optional(),
  description: z.string().max(4_000).optional(),
  interaction_intent: z.string().max(4_000).optional(),
  data_placeholder: z.string().max(4_000).optional(),
  state_name: z.string().trim().min(1).max(160).optional(),
  business_rule_ids: z.array(z.string().regex(/^rule_[A-Za-z0-9][A-Za-z0-9_-]{7,}$/)).max(100).default([]),
  acceptance_criterion_ids: z.array(z.string().regex(/^criterion_[A-Za-z0-9][A-Za-z0-9_-]{7,}$/)).max(100).default([]),
}).strict();

const commonNodeShapeV2 = {
  id: NodeIdSchema,
  name: z.string().trim().min(1).max(160),
  layout: NodeLayoutSchema,
  style: NodeStyleSchema,
  visible: z.boolean(),
  locked: z.boolean(),
  archived: z.boolean(),
  semantics: NodeSemanticsSchema,
  metadata: MetadataSchema,
  tags: z.array(z.string().trim().min(1).max(64)).max(32).optional(),
  inserted_from_template_id: z.string().trim().min(1).max(240).optional(),
  inserted_from_template_version: z.number().int().positive().optional(),
};

export const FrameNodeV2Schema = z.object({
  ...commonNodeShapeV2,
  type: z.literal("frame"),
  children: z.array(NodeIdSchema),
  clip_content: z.boolean(),
  user_story: z.string().max(10_000).optional(),
  screen_purpose: z.string().max(10_000).optional(),
  screen_state: z.string().trim().min(1).max(160).optional(),
  primary_action: z.string().max(2_000).optional(),
  locale: z.string().trim().min(2).max(64).default("en"),
  text_direction: z.enum(["auto", "ltr", "rtl"]).default("auto"),
  responsive_variant: ResponsiveFrameVariantSchema.optional(),
}).strict();

export const ContainerNodeV2Schema = z.object({
  ...commonNodeShapeV2,
  type: z.literal("container"),
  children: z.array(NodeIdSchema),
  clip_content: z.boolean().default(false),
}).strict();

export const TextNodeV2Schema = z.object({
  ...commonNodeShapeV2,
  type: z.literal("text"),
  content: z.string().max(100_000),
  direction: z.enum(["auto", "ltr", "rtl"]).default("auto"),
}).strict();

export const RectangleNodeV2Schema = z.object({ ...commonNodeShapeV2, type: z.literal("rectangle") }).strict();
export const EllipseNodeV2Schema = z.object({ ...commonNodeShapeV2, type: z.literal("ellipse") }).strict();

export const ImageNodeV2Schema = z.object({
  ...commonNodeShapeV2,
  type: z.literal("image"),
  asset_id: AssetIdSchema.optional(),
  alt: z.string().max(1_000),
  object_fit: z.enum(["fill", "contain", "cover", "none", "scale-down"]),
}).strict();

export const IconNodeV2Schema = z.object({
  ...commonNodeShapeV2,
  type: z.literal("icon"),
  icon_name: z.string().trim().min(1).max(160),
  label: z.string().max(1_000).optional(),
}).strict();

export const ComponentPropertyValueSchema = z.union([
  z.string().max(100_000),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.object({ icon_name: z.string().trim().min(1).max(160) }).strict(),
  z.object({ asset_id: AssetIdSchema }).strict(),
]);
export type ComponentPropertyValue = z.infer<typeof ComponentPropertyValueSchema>;

export const ComponentInstanceNodeV2Schema = z.object({
  ...commonNodeShapeV2,
  type: z.literal("component_instance"),
  component_definition_id: ComponentDefinitionIdSchema,
  component_version: z.number().int().positive(),
  properties: z.record(ComponentPropertyValueSchema),
  slots: z.record(z.array(NodeIdSchema).max(100)),
  visual_overrides: z.record(NodeIdSchema, NodeStyleSchema).default({}),
  active_state: z.enum(["default", "hover", "pressed", "focused", "disabled", "loading", "error", "selected"]).default("default"),
}).strict();

export const DesignNodeV2Schema = z.discriminatedUnion("type", [
  FrameNodeV2Schema,
  ContainerNodeV2Schema,
  TextNodeV2Schema,
  RectangleNodeV2Schema,
  EllipseNodeV2Schema,
  ImageNodeV2Schema,
  IconNodeV2Schema,
  ComponentInstanceNodeV2Schema,
]);
export type DesignNodeV2 = z.infer<typeof DesignNodeV2Schema>;
export type ContainerNodeV2 = z.infer<typeof FrameNodeV2Schema> | z.infer<typeof ContainerNodeV2Schema>;

export const DesignPageV2Schema = z.object({
  id: PageIdSchema,
  name: z.string().trim().min(1).max(160),
  children: z.array(NodeIdSchema),
  background: StringValueSchema,
  viewport: z.object({
    width: z.number().finite().positive().max(100_000),
    height: z.number().finite().positive().max(100_000),
  }).strict().optional(),
  locale: z.string().trim().min(2).max(64).default("en"),
  text_direction: z.enum(["auto", "ltr", "rtl"]).default("auto"),
  archived: z.boolean(),
  metadata: MetadataSchema,
}).strict();

export const DesignAssetV2Schema = z.object({
  id: AssetIdSchema,
  name: z.string().trim().min(1).max(255),
  kind: z.enum(["image", "font", "video", "binary"]),
  mime_type: z.string().trim().min(1).max(255),
  size_bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  status: z.enum(["ready", "legacy_quarantined"]),
  display_filename: z.string().trim().min(1).max(255),
  metadata: MetadataSchema,
}).strict().superRefine((asset, context) => {
  if (asset.status === "ready") {
    if (asset.kind !== "image") {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["kind"], message: "Ready assets must be normalized images" });
    }
    if (!["image/png", "image/jpeg", "image/webp"].includes(asset.mime_type)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["mime_type"], message: "Ready assets require a supported normalized image MIME type" });
    }
    if (!asset.sha256) context.addIssue({ code: z.ZodIssueCode.custom, path: ["sha256"], message: "Ready assets require a hash" });
    if (!asset.width || !asset.height) context.addIssue({ code: z.ZodIssueCode.custom, path: ["width"], message: "Ready assets require dimensions" });
  }
});

export const PrototypeLinkV2Schema = z.object({
  id: PrototypeLinkIdSchema,
  source_node_id: NodeIdSchema,
  trigger: PrototypeTriggerSchema,
  action: PrototypeActionSchema,
  transition: PrototypeTransitionSchema.optional(),
  metadata: MetadataSchema,
}).strict();

export const ImplementationMappingSchema = z.object({
  id: ImplementationTargetIdSchema,
  target_type: z.enum(["component", "token", "screen", "asset", "flow", "business_rule"]),
  source_id: z.string().trim().min(1).max(240),
  platform: z.enum(["web", "android", "ios", "flutter", "react_native", "other"]),
  symbol: z.string().trim().min(1).max(500),
  connection_id: z.string().trim().min(1).max(240),
  mapping_version: z.number().int().positive(),
  notes: z.string().max(4_000).optional(),
}).strict();

export const LegacyMigrationDataSchema = z.object({
  source_schema_version: z.literal(1),
  migrated_at: z.string().datetime({ offset: true }),
  source_revision_id: z.string().regex(/^revision_[A-Za-z0-9][A-Za-z0-9_-]{7,}$/).optional(),
  source_snapshot_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  verified_backup_id: z.string().regex(/^backup_[A-Za-z0-9][A-Za-z0-9_-]{7,}$/).optional(),
  legacy_component_overrides: z.record(MetadataSchema).default({}),
  quarantined_asset_ids: z.array(AssetIdSchema).default([]),
  compatibility: z.object({
    node_types: z.record(z.enum(["group", "component", "instance"])).default({}),
    text_directions: z.record(z.union([z.enum(["auto", "ltr", "rtl"]), z.null()])).default({}),
    component_descriptions: z.record(z.union([z.string().max(2_000), z.null()])).default({}),
    frame_roles: z.record(z.enum([
      "none",
      "screen",
      "section",
      "navigation",
      "main",
      "aside",
      "header",
      "footer",
      "button",
      "form",
      "list",
      "dialog",
    ])).default({}),
    token_metadata: z.record(MetadataSchema).default({}),
    asset_storage_keys: z.record(z.string().trim().min(1).max(2_000)).default({}),
  }).strict().optional(),
  diagnostics: z.array(z.object({
    code: z.string().trim().min(1).max(160),
    severity: z.enum(["info", "warning", "error"]),
    message: z.string().max(4_000),
    node_id: NodeIdSchema.optional(),
    token_id: TokenIdSchema.optional(),
    asset_id: AssetIdSchema.optional(),
  }).strict()).max(10_000).default([]),
}).strict();

export const DesignDocumentV2ObjectSchema = z.object({
  schema_version: z.literal(2),
  id: DocumentIdSchema,
  name: z.string().trim().min(1).max(255),
  revision: z.number().int().nonnegative(),
  pages: z.array(DesignPageV2Schema).max(1_000),
  nodes: z.record(DesignNodeV2Schema),
  tokens: z.record(DesignSystemTokenSchema),
  assets: z.record(DesignAssetV2Schema),
  prototype_links: z.record(PrototypeLinkV2Schema),
  component_definitions: z.record(ComponentDefinitionSchema),
  design_system: DesignSystemPinSchema,
  product_specification: ProductSpecificationSchema,
  implementation_mappings: z.record(ImplementationMappingSchema),
  migration: LegacyMigrationDataSchema.optional(),
  metadata: MetadataSchema,
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }),
}).strict();

function isContainer(node: DesignNodeV2): node is ContainerNodeV2 {
  return node.type === "frame" || node.type === "container";
}

export const DesignDocumentV2Schema = DesignDocumentV2ObjectSchema.superRefine((document, context) => {
  const parentCounts = new Map<string, number>();
  const activeRoots: string[] = [];

  for (const [key, node] of Object.entries(document.nodes)) {
    if (node.id !== key) context.addIssue({ code: z.ZodIssueCode.custom, path: ["nodes", key, "id"], message: "Node record key must equal node id" });
    if (isContainer(node)) {
      for (const childId of node.children) parentCounts.set(childId, (parentCounts.get(childId) ?? 0) + 1);
    }
    if (node.type === "component_instance") {
      const definition = document.component_definitions[node.component_definition_id];
      if (!definition || definition.version !== node.component_version) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["nodes", key, "component_definition_id"], message: "Component instance must reference an available exact component version" });
      }
    }
  }
  for (const [key, token] of Object.entries(document.tokens)) {
    if (token.id !== key) context.addIssue({ code: z.ZodIssueCode.custom, path: ["tokens", key, "id"], message: "Token record key must equal token id" });
  }
  for (const [key, asset] of Object.entries(document.assets)) {
    if (asset.id !== key) context.addIssue({ code: z.ZodIssueCode.custom, path: ["assets", key, "id"], message: "Asset record key must equal asset id" });
  }
  for (const [key, definition] of Object.entries(document.component_definitions)) {
    if (definition.id !== key) context.addIssue({ code: z.ZodIssueCode.custom, path: ["component_definitions", key, "id"], message: "Component record key must equal component id" });
    if (!document.nodes[definition.root_node_id]) context.addIssue({ code: z.ZodIssueCode.custom, path: ["component_definitions", key, "root_node_id"], message: "Component root is missing" });
  }
  for (const page of document.pages) {
    for (const rootId of page.children) {
      parentCounts.set(rootId, (parentCounts.get(rootId) ?? 0) + 1);
      if (!page.archived) activeRoots.push(rootId);
    }
  }
  for (const node of Object.values(document.nodes)) {
    const count = parentCounts.get(node.id) ?? 0;
    if (!node.archived && count !== 1) context.addIssue({ code: z.ZodIssueCode.custom, path: ["nodes", node.id], message: `Active node must have exactly one parent; found ${count}` });
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const walk = (nodeId: string) => {
    if (visiting.has(nodeId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["nodes", nodeId], message: "Node tree contains a cycle" });
      return;
    }
    if (visited.has(nodeId)) return;
    const node = document.nodes[nodeId];
    if (!node) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["nodes", nodeId], message: "Referenced node is missing" });
      return;
    }
    visiting.add(nodeId);
    if (isContainer(node)) for (const childId of node.children) walk(childId);
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  for (const rootId of activeRoots) walk(rootId);
  for (const node of Object.values(document.nodes)) {
    if (!node.archived && !visited.has(node.id)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["nodes", node.id], message: "Active node is unreachable from an active page" });
  }

  for (const issue of validateResponsiveFrameVariants(document)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: issue.path,
      message: issue.message,
    });
  }

  for (const [key, link] of Object.entries(document.prototype_links)) {
    if (link.id !== key) context.addIssue({ code: z.ZodIssueCode.custom, path: ["prototype_links", key, "id"], message: "Prototype link record key must equal link id" });
    const source = document.nodes[link.source_node_id];
    if (!source || source.archived) context.addIssue({ code: z.ZodIssueCode.custom, path: ["prototype_links", key, "source_node_id"], message: "Prototype source is missing or archived" });
    const action = link.action;
    if ("page_id" in action) {
      const page = document.pages.find((candidate) => candidate.id === action.page_id && !candidate.archived);
      const target = action.node_id ? document.nodes[action.node_id] : undefined;
      if (!page || (action.node_id && (!target || target.archived || target.type !== "frame"))) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["prototype_links", key, "action"], message: "Prototype target must be an active page or frame" });
      }
    }
  }
});
export type DesignDocumentV2 = z.infer<typeof DesignDocumentV2Schema>;

export const AnyDesignDocumentSchema = z.union([DesignDocumentSchema, DesignDocumentV2Schema]);
export type AnyDesignDocument = z.infer<typeof AnyDesignDocumentSchema>;

export function isDesignDocumentV2(document: AnyDesignDocument): document is DesignDocumentV2 {
  return document.schema_version === 2;
}
