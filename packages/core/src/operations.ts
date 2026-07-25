import { z } from "zod";

import {
  AssetIdSchema,
  NodeIdSchema,
  OperationIdSchema,
  PageIdSchema,
  PrototypeLinkIdSchema,
  TokenIdSchema,
} from "./ids.js";
import {
  DesignAssetSchema,
  DesignNodeSchema,
  DesignTokenSchema,
  MetadataSchema,
  NodeLayoutPatchSchema,
  NodeStyleSchema,
  PrototypeLinkSchema,
  ResponsiveFrameVariantSchema,
  StringValueSchema,
  ViewportSchema,
} from "./model.js";
import { ComponentSourceStateKeySchema } from "./component-source.js";
import { ComponentPropertyValueSchema } from "./model-v2.js";
import { ComponentDefinitionIdSchema } from "./product-spec.js";

const operationIdShape = { operation_id: OperationIdSchema.optional() };

export const ParentReferenceSchema = z.union([
  z.object({ page_id: PageIdSchema }).strict(),
  z.object({ node_id: NodeIdSchema }).strict(),
]);
export type ParentReference = z.infer<typeof ParentReferenceSchema>;

export const CreatePageOperationSchema = z
  .object({
    ...operationIdShape,
    type: z.literal("create_page"),
    page: z
      .object({
        id: PageIdSchema.optional(),
        name: z.string().trim().min(1).max(160),
        background: StringValueSchema.optional(),
        viewport: ViewportSchema.optional(),
        metadata: MetadataSchema.optional(),
      })
      .strict(),
    index: z.number().int().nonnegative().optional(),
  })
  .strict();

export const CreateTreeOperationSchema = z
  .object({
    ...operationIdShape,
    type: z.literal("create_tree"),
    parent: ParentReferenceSchema,
    root_ids: z.array(NodeIdSchema).min(1),
    nodes: z.array(DesignNodeSchema).min(1).max(5_000),
    index: z.number().int().nonnegative().optional(),
  })
  .strict();

export const StyleKeySchema = z.enum([
  "fill",
  "color",
  "opacity",
  "border",
  "radius",
  "shadows",
  "typography",
  "overflow",
  "object_position",
  "cursor",
  "pointer_events",
]);
export type StyleKey = z.infer<typeof StyleKeySchema>;

export const UpdateNodePatchSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    layout: NodeLayoutPatchSchema.optional(),
    style: NodeStyleSchema.optional(),
    clear_style: z.array(StyleKeySchema).optional(),
    visible: z.boolean().optional(),
    locked: z.boolean().optional(),
    tags: z.array(z.string().trim().min(1).max(64)).max(32).nullable().optional(),
    metadata: MetadataSchema.optional(),
    metadata_mode: z.enum(["merge", "replace"]).optional(),
    accessibility_label: z.string().max(2_000).nullable().optional(),
    content: z.string().max(100_000).optional(),
    direction: z.enum(["auto", "ltr", "rtl"]).nullable().optional(),
    asset_id: AssetIdSchema.nullable().optional(),
    alt: z.string().max(1_000).optional(),
    object_fit: z.enum(["fill", "contain", "cover", "none", "scale-down"]).optional(),
    icon_name: z.string().trim().min(1).max(160).optional(),
    label: z.string().max(1_000).nullable().optional(),
    component_id: NodeIdSchema.optional(),
    overrides: MetadataSchema.optional(),
    clip_content: z.boolean().optional(),
    role: z
      .enum([
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
      ])
      .nullable()
      .optional(),
    component_key: z.string().trim().min(1).max(160).optional(),
    description: z.string().max(2_000).nullable().optional(),
    responsive_variant: ResponsiveFrameVariantSchema.nullable().optional(),
  })
  .strict();
export type UpdateNodePatch = z.infer<typeof UpdateNodePatchSchema>;

export const UpdateNodeOperationSchema = z
  .object({
    ...operationIdShape,
    type: z.literal("update_node"),
    node_id: NodeIdSchema,
    patch: UpdateNodePatchSchema,
  })
  .strict();

export const MoveNodeOperationSchema = z
  .object({
    ...operationIdShape,
    type: z.literal("move_node"),
    node_id: NodeIdSchema,
    parent: ParentReferenceSchema,
    index: z.number().int().nonnegative().optional(),
    position: z.object({ x: z.number().finite(), y: z.number().finite() }).strict().optional(),
  })
  .strict();

export const ArchiveNodesOperationSchema = z
  .object({
    ...operationIdShape,
    type: z.literal("archive_nodes"),
    node_ids: z.array(NodeIdSchema).min(1).max(5_000),
  })
  .strict();

export const ArchivePageOperationSchema = z
  .object({
    ...operationIdShape,
    type: z.literal("archive_page"),
    page_id: PageIdSchema,
  })
  .strict();

export const UpsertTokenOperationSchema = z
  .object({
    ...operationIdShape,
    type: z.literal("upsert_token"),
    token: DesignTokenSchema,
  })
  .strict();

export const UpsertAssetOperationSchema = z
  .object({
    ...operationIdShape,
    type: z.literal("upsert_asset"),
    asset: DesignAssetSchema,
  })
  .strict();

export const TemplateKindSchema = z.enum(["mobile_screen", "desktop_screen", "stack", "card", "button", "text"]);
export type TemplateKind = z.infer<typeof TemplateKindSchema>;

export const InsertTemplateOperationSchema = z
  .object({
    ...operationIdShape,
    type: z.literal("insert_template"),
    template: TemplateKindSchema,
    parent: ParentReferenceSchema,
    index: z.number().int().nonnegative().optional(),
    overrides: z
      .object({
        id: NodeIdSchema.optional(),
        name: z.string().trim().min(1).max(160).optional(),
        text: z.string().max(100_000).optional(),
        layout: NodeLayoutPatchSchema.optional(),
        style: NodeStyleSchema.optional(),
        metadata: MetadataSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * Persisted normalized evidence for a server-resolved component insertion.
 * The immutable source tree is resolved from the project's pinned release and
 * is deliberately not accepted as caller-supplied operation payload.
 */
export const InsertComponentInstanceOperationSchema = z.object({
  ...operationIdShape,
  type: z.literal("insert_component_instance"),
  parent: ParentReferenceSchema,
  component_definition_id: ComponentDefinitionIdSchema,
  component_version: z.number().int().positive(),
  source_hash: z.string().regex(/^[a-f0-9]{64}$/),
  instance_id: NodeIdSchema,
  active_state: ComponentSourceStateKeySchema,
  properties: z.record(ComponentPropertyValueSchema).default({}),
  slots: z.record(z.array(NodeIdSchema).max(100)).default({}),
  visual_overrides: z.record(NodeIdSchema, NodeStyleSchema).default({}),
  index: z.number().int().nonnegative().optional(),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }).strict().optional(),
}).strict();

export const SetPrototypeLinkOperationSchema = z
  .object({
    ...operationIdShape,
    type: z.literal("set_prototype_link"),
    link: PrototypeLinkSchema,
  })
  .strict();

export const MetadataTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("document") }).strict(),
  z.object({ kind: z.literal("page"), id: PageIdSchema }).strict(),
  z.object({ kind: z.literal("node"), id: NodeIdSchema }).strict(),
  z.object({ kind: z.literal("token"), id: TokenIdSchema }).strict(),
  z.object({ kind: z.literal("asset"), id: AssetIdSchema }).strict(),
  z.object({ kind: z.literal("prototype_link"), id: PrototypeLinkIdSchema }).strict(),
]);
export type MetadataTarget = z.infer<typeof MetadataTargetSchema>;

export const SetMetadataOperationSchema = z
  .object({
    ...operationIdShape,
    type: z.literal("set_metadata"),
    target: MetadataTargetSchema,
    metadata: MetadataSchema,
    mode: z.enum(["merge", "replace"]).optional(),
  })
  .strict();

export const DesignOperationSchema = z.discriminatedUnion("type", [
  CreatePageOperationSchema,
  CreateTreeOperationSchema,
  UpdateNodeOperationSchema,
  MoveNodeOperationSchema,
  ArchiveNodesOperationSchema,
  ArchivePageOperationSchema,
  UpsertTokenOperationSchema,
  UpsertAssetOperationSchema,
  InsertTemplateOperationSchema,
  InsertComponentInstanceOperationSchema,
  SetPrototypeLinkOperationSchema,
  SetMetadataOperationSchema,
]);

export const DesignOperationListSchema = z.array(DesignOperationSchema).max(1_000);

export type CreatePageOperation = z.infer<typeof CreatePageOperationSchema>;
export type CreateTreeOperation = z.infer<typeof CreateTreeOperationSchema>;
export type UpdateNodeOperation = z.infer<typeof UpdateNodeOperationSchema>;
export type MoveNodeOperation = z.infer<typeof MoveNodeOperationSchema>;
export type ArchiveNodesOperation = z.infer<typeof ArchiveNodesOperationSchema>;
export type ArchivePageOperation = z.infer<typeof ArchivePageOperationSchema>;
export type UpsertTokenOperation = z.infer<typeof UpsertTokenOperationSchema>;
export type UpsertAssetOperation = z.infer<typeof UpsertAssetOperationSchema>;
export type InsertTemplateOperation = z.infer<typeof InsertTemplateOperationSchema>;
export type InsertComponentInstanceOperation = z.infer<typeof InsertComponentInstanceOperationSchema>;
export type SetPrototypeLinkOperation = z.infer<typeof SetPrototypeLinkOperationSchema>;
export type SetMetadataOperation = z.infer<typeof SetMetadataOperationSchema>;
export type DesignOperation = z.infer<typeof DesignOperationSchema>;
