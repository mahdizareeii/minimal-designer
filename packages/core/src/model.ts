import { z } from "zod";

import {
  AssetIdSchema,
  DocumentIdSchema,
  NodeIdSchema,
  PageIdSchema,
  PrototypeLinkIdSchema,
  TokenIdSchema,
} from "./ids.js";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number().finite(), z.boolean(), z.null(), z.array(JsonValueSchema), z.record(JsonValueSchema)]),
);

export const MetadataSchema = z.record(JsonValueSchema);
export type Metadata = z.infer<typeof MetadataSchema>;

export const TokenReferenceSchema = z.object({ token_id: TokenIdSchema }).strict();
export type TokenReference = z.infer<typeof TokenReferenceSchema>;

export const StringValueSchema = z.union([z.string(), TokenReferenceSchema]);
export const NumberValueSchema = z.union([z.number().finite(), TokenReferenceSchema]);
export type StringValue = z.infer<typeof StringValueSchema>;
export type NumberValue = z.infer<typeof NumberValueSchema>;

export const PaddingSchema = z
  .object({
    top: NumberValueSchema,
    right: NumberValueSchema,
    bottom: NumberValueSchema,
    left: NumberValueSchema,
  })
  .strict();

export const LayoutModeSchema = z.enum(["absolute", "horizontal", "vertical", "grid"]);
export const SizingModeSchema = z.enum(["fixed", "hug", "fill"]);
export type LayoutMode = z.infer<typeof LayoutModeSchema>;
export type SizingMode = z.infer<typeof SizingModeSchema>;

export const NodeLayoutObjectSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().positive().max(100_000),
    height: z.number().finite().positive().max(100_000),
    rotation: z.number().finite().min(-360_000).max(360_000).optional(),
    mode: LayoutModeSchema,
    width_sizing: SizingModeSchema,
    height_sizing: SizingModeSchema,
    min_width: z.number().finite().nonnegative().optional(),
    max_width: z.number().finite().positive().optional(),
    min_height: z.number().finite().nonnegative().optional(),
    max_height: z.number().finite().positive().optional(),
    gap: NumberValueSchema.optional(),
    row_gap: NumberValueSchema.optional(),
    column_gap: NumberValueSchema.optional(),
    padding: z.union([NumberValueSchema, PaddingSchema]).optional(),
    align_items: z.enum(["start", "center", "end", "stretch", "baseline"]).optional(),
    justify_content: z
      .enum(["start", "center", "end", "space-between", "space-around", "space-evenly"])
      .optional(),
    wrap: z.boolean().optional(),
    columns: z.number().int().positive().max(24).optional(),
    horizontal_constraint: z.enum(["left", "right", "left-right", "center", "scale"]).optional(),
    vertical_constraint: z.enum(["top", "bottom", "top-bottom", "center", "scale"]).optional(),
  })
  .strict();

export const NodeLayoutPatchSchema = NodeLayoutObjectSchema.partial().strict();

export const NodeLayoutSchema = NodeLayoutObjectSchema.superRefine((layout, context) => {
    if (layout.min_width !== undefined && layout.max_width !== undefined && layout.min_width > layout.max_width) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["min_width"], message: "min_width must not exceed max_width" });
    }
    if (
      layout.min_height !== undefined &&
      layout.max_height !== undefined &&
      layout.min_height > layout.max_height
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["min_height"], message: "min_height must not exceed max_height" });
    }
    if (layout.mode === "grid" && layout.columns === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["columns"], message: "Grid layouts require columns" });
    }
  });
export type NodeLayout = z.infer<typeof NodeLayoutSchema>;
export type NodeLayoutPatch = z.infer<typeof NodeLayoutPatchSchema>;

export const BorderSchema = z
  .object({
    color: StringValueSchema,
    width: NumberValueSchema,
    style: z.enum(["solid", "dashed", "dotted", "double"]),
  })
  .strict();

export const CornerRadiusSchema = z
  .object({
    top_left: NumberValueSchema,
    top_right: NumberValueSchema,
    bottom_right: NumberValueSchema,
    bottom_left: NumberValueSchema,
  })
  .strict();

export const ShadowSchema = z
  .object({
    x: NumberValueSchema,
    y: NumberValueSchema,
    blur: NumberValueSchema,
    spread: NumberValueSchema.optional(),
    color: StringValueSchema,
    inset: z.boolean().optional(),
  })
  .strict();

export const TypographySchema = z
  .object({
    font_family: StringValueSchema.optional(),
    font_size: NumberValueSchema.optional(),
    font_weight: z.union([z.number().int().min(1).max(1000), z.string(), TokenReferenceSchema]).optional(),
    line_height: z.union([NumberValueSchema, z.literal("normal")]).optional(),
    letter_spacing: NumberValueSchema.optional(),
    text_align: z.enum(["left", "center", "right", "justify", "start", "end"]).optional(),
    text_decoration: z.enum(["none", "underline", "line-through", "overline"]).optional(),
    text_transform: z.enum(["none", "uppercase", "lowercase", "capitalize"]).optional(),
    font_style: z.enum(["normal", "italic", "oblique"]).optional(),
  })
  .strict();

export const NodeStyleSchema = z
  .object({
    fill: StringValueSchema.optional(),
    color: StringValueSchema.optional(),
    opacity: NumberValueSchema.optional(),
    border: BorderSchema.optional(),
    radius: z.union([NumberValueSchema, CornerRadiusSchema]).optional(),
    shadows: z.array(ShadowSchema).max(8).optional(),
    typography: TypographySchema.optional(),
    overflow: z.enum(["visible", "hidden", "clip", "auto", "scroll"]).optional(),
    object_position: z.string().max(100).optional(),
    cursor: z.string().max(64).optional(),
    pointer_events: z.enum(["auto", "none"]).optional(),
  })
  .strict();
export type NodeStyle = z.infer<typeof NodeStyleSchema>;

const commonNodeShape = {
  id: NodeIdSchema,
  name: z.string().trim().min(1).max(160),
  layout: NodeLayoutSchema,
  style: NodeStyleSchema,
  visible: z.boolean(),
  locked: z.boolean(),
  archived: z.boolean(),
  metadata: MetadataSchema,
  tags: z.array(z.string().trim().min(1).max(64)).max(32).optional(),
};

const containerRoleSchema = z.enum([
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
]);

export const ResponsiveFrameGroupIdSchema = z.string().regex(
  /^responsive_[A-Za-z0-9][A-Za-z0-9_-]{7,}$/,
  "Invalid responsive frame group id",
);

export const ResponsiveBreakpointSchema = z.object({
  min_width: z.number().int().nonnegative().max(100_000).default(0),
  max_width: z.number().int().positive().max(100_000).optional(),
}).strict().superRefine((breakpoint, context) => {
  if (breakpoint.max_width !== undefined && breakpoint.max_width <= breakpoint.min_width) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["max_width"],
      message: "Responsive breakpoint max width must be greater than min width",
    });
  }
});

export const ResponsiveFrameVariantSchema = z.object({
  group_id: ResponsiveFrameGroupIdSchema,
  frame_ids: z.array(NodeIdSchema).min(2).max(32).superRefine((frameIds, context) => {
    if (new Set(frameIds).size !== frameIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: "Responsive frame IDs must be unique and ordered",
      });
    }
  }),
  breakpoint: ResponsiveBreakpointSchema.default({ min_width: 0 }),
}).strict();
export type ResponsiveFrameGroupId = z.infer<typeof ResponsiveFrameGroupIdSchema>;
export type ResponsiveBreakpoint = z.infer<typeof ResponsiveBreakpointSchema>;
export type ResponsiveFrameVariant = z.infer<typeof ResponsiveFrameVariantSchema>;

export const FrameNodeSchema = z
  .object({
    ...commonNodeShape,
    type: z.literal("frame"),
    children: z.array(NodeIdSchema),
    clip_content: z.boolean(),
    role: containerRoleSchema.optional(),
    responsive_variant: ResponsiveFrameVariantSchema.optional(),
  })
  .strict();

export const GroupNodeSchema = z
  .object({
    ...commonNodeShape,
    type: z.literal("group"),
    children: z.array(NodeIdSchema),
  })
  .strict();

export const ComponentNodeSchema = z
  .object({
    ...commonNodeShape,
    type: z.literal("component"),
    children: z.array(NodeIdSchema),
    component_key: z.string().trim().min(1).max(160),
    description: z.string().max(2_000).optional(),
  })
  .strict();

export const RectangleNodeSchema = z
  .object({
    ...commonNodeShape,
    type: z.literal("rectangle"),
  })
  .strict();

export const EllipseNodeSchema = z
  .object({
    ...commonNodeShape,
    type: z.literal("ellipse"),
  })
  .strict();

export const TextNodeSchema = z
  .object({
    ...commonNodeShape,
    type: z.literal("text"),
    content: z.string().max(100_000),
    direction: z.enum(["auto", "ltr", "rtl"]).optional(),
  })
  .strict();

export const ImageNodeSchema = z
  .object({
    ...commonNodeShape,
    type: z.literal("image"),
    asset_id: AssetIdSchema.optional(),
    alt: z.string().max(1_000),
    object_fit: z.enum(["fill", "contain", "cover", "none", "scale-down"]),
  })
  .strict();

export const IconNodeSchema = z
  .object({
    ...commonNodeShape,
    type: z.literal("icon"),
    icon_name: z.string().trim().min(1).max(160),
    label: z.string().max(1_000).optional(),
  })
  .strict();

export const InstanceNodeSchema = z
  .object({
    ...commonNodeShape,
    type: z.literal("instance"),
    component_id: NodeIdSchema,
    overrides: MetadataSchema,
  })
  .strict();

export const DesignNodeSchema = z.discriminatedUnion("type", [
  FrameNodeSchema,
  GroupNodeSchema,
  ComponentNodeSchema,
  RectangleNodeSchema,
  EllipseNodeSchema,
  TextNodeSchema,
  ImageNodeSchema,
  IconNodeSchema,
  InstanceNodeSchema,
]);

export type FrameNode = z.infer<typeof FrameNodeSchema>;
export type GroupNode = z.infer<typeof GroupNodeSchema>;
export type ComponentNode = z.infer<typeof ComponentNodeSchema>;
export type RectangleNode = z.infer<typeof RectangleNodeSchema>;
export type EllipseNode = z.infer<typeof EllipseNodeSchema>;
export type TextNode = z.infer<typeof TextNodeSchema>;
export type ImageNode = z.infer<typeof ImageNodeSchema>;
export type IconNode = z.infer<typeof IconNodeSchema>;
export type InstanceNode = z.infer<typeof InstanceNodeSchema>;
export type DesignNode = z.infer<typeof DesignNodeSchema>;
export type ContainerNode = FrameNode | GroupNode | ComponentNode;

export const ViewportSchema = z
  .object({
    width: z.number().finite().positive().max(100_000),
    height: z.number().finite().positive().max(100_000),
  })
  .strict();

export const DesignPageSchema = z
  .object({
    id: PageIdSchema,
    name: z.string().trim().min(1).max(160),
    children: z.array(NodeIdSchema),
    background: StringValueSchema,
    viewport: ViewportSchema.optional(),
    archived: z.boolean(),
    metadata: MetadataSchema,
  })
  .strict();
export type DesignPage = z.infer<typeof DesignPageSchema>;

export const TokenKindSchema = z.enum([
  "color",
  "dimension",
  "number",
  "string",
  "font_family",
  "font_weight",
  "duration",
]);

export const DesignTokenObjectSchema = z
  .object({
    id: TokenIdSchema,
    name: z.string().trim().min(1).max(160),
    path: z.string().trim().min(1).max(240).regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/),
    kind: TokenKindSchema,
    value: z.union([z.string(), z.number().finite()]),
    description: z.string().max(2_000).optional(),
    archived: z.boolean(),
    metadata: MetadataSchema,
  })
  .strict();
export const DesignTokenSchema = DesignTokenObjectSchema.superRefine((token, context) => {
  const numericKind =
    token.kind === "dimension" || token.kind === "number" || token.kind === "font_weight" || token.kind === "duration";
  if (numericKind && typeof token.value !== "number") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: `${token.kind} tokens require a numeric value` });
  }
  if (!numericKind && typeof token.value !== "string") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: `${token.kind} tokens require a string value` });
  }
});
export type DesignToken = z.infer<typeof DesignTokenSchema>;

export const DesignAssetSchema = z
  .object({
    id: AssetIdSchema,
    name: z.string().trim().min(1).max(255),
    kind: z.enum(["image", "font", "video", "binary"]),
    mime_type: z.string().trim().min(1).max(255),
    size_bytes: z.number().int().nonnegative(),
    storage_key: z.string().trim().min(1).max(2_000),
    sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    metadata: MetadataSchema,
  })
  .strict();
export type DesignAsset = z.infer<typeof DesignAssetSchema>;

export const PrototypeTriggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("click") }).strict(),
  z.object({ type: z.literal("hover") }).strict(),
  z.object({ type: z.literal("press") }).strict(),
  z.object({ type: z.literal("drag") }).strict(),
  z.object({ type: z.literal("after_delay"), delay_ms: z.number().int().nonnegative().max(3_600_000) }).strict(),
]);

export const PrototypeActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("navigate"), page_id: PageIdSchema, node_id: NodeIdSchema.optional() }).strict(),
  z.object({ type: z.literal("open_overlay"), page_id: PageIdSchema, node_id: NodeIdSchema.optional() }).strict(),
  z.object({ type: z.literal("back") }).strict(),
  z.object({ type: z.literal("url"), url: z.string().url().max(2_000) }).strict(),
]);

export const PrototypeTransitionSchema = z
  .object({
    type: z.enum(["instant", "dissolve", "slide", "push"]),
    duration_ms: z.number().int().nonnegative().max(60_000),
    easing: z.enum(["linear", "ease", "ease-in", "ease-out", "ease-in-out"]),
    direction: z.enum(["left", "right", "up", "down"]).optional(),
  })
  .strict();

export const PrototypeLinkSchema = z
  .object({
    id: PrototypeLinkIdSchema,
    source_node_id: NodeIdSchema,
    trigger: PrototypeTriggerSchema,
    action: PrototypeActionSchema,
    transition: PrototypeTransitionSchema.optional(),
    metadata: MetadataSchema,
  })
  .strict();
export type PrototypeLink = z.infer<typeof PrototypeLinkSchema>;

export const DesignDocumentSchema = z
  .object({
    schema_version: z.literal(1),
    id: DocumentIdSchema,
    name: z.string().trim().min(1).max(255),
    revision: z.number().int().nonnegative(),
    pages: z.array(DesignPageSchema),
    nodes: z.record(DesignNodeSchema),
    tokens: z.record(DesignTokenSchema),
    assets: z.record(DesignAssetSchema),
    prototype_links: z.record(PrototypeLinkSchema),
    metadata: MetadataSchema,
    created_at: z.string().datetime({ offset: true }),
    updated_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type DesignDocument = z.infer<typeof DesignDocumentSchema>;

export const SCHEMA_VERSION = 1 as const;
export const DocumentSchema = DesignDocumentSchema;
export const NodeSchema = DesignNodeSchema;
export const PageSchema = DesignPageSchema;

export function isContainerNode(node: DesignNode): node is ContainerNode {
  return node.type === "frame" || node.type === "group" || node.type === "component";
}

export function isTokenReference(value: unknown): value is TokenReference {
  return TokenReferenceSchema.safeParse(value).success;
}
