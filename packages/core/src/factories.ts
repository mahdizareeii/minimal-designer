import type { IdFactory, NodeId, PageId } from "./ids.js";
import { createId } from "./ids.js";
import {
  ComponentNodeSchema,
  DesignDocumentSchema,
  DesignPageSchema,
  EllipseNodeSchema,
  FrameNodeSchema,
  GroupNodeSchema,
  IconNodeSchema,
  ImageNodeSchema,
  InstanceNodeSchema,
  NodeLayoutSchema,
  NodeStyleSchema,
  RectangleNodeSchema,
  TextNodeSchema,
  type ComponentNode,
  type DesignDocument,
  type DesignPage,
  type EllipseNode,
  type FrameNode,
  type GroupNode,
  type IconNode,
  type ImageNode,
  type InstanceNode,
  type Metadata,
  type NodeLayout,
  type NodeStyle,
  type RectangleNode,
  type TextNode,
} from "./model.js";

export interface BaseFactoryOptions {
  id?: NodeId;
  name?: string;
  layout?: Partial<NodeLayout>;
  style?: NodeStyle;
  visible?: boolean;
  locked?: boolean;
  archived?: boolean;
  metadata?: Metadata;
  tags?: string[];
}

export function createNodeLayout(overrides: Partial<NodeLayout> = {}): NodeLayout {
  return NodeLayoutSchema.parse({
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    mode: "absolute",
    width_sizing: "fixed",
    height_sizing: "fixed",
    ...overrides,
  });
}

export function createNodeStyle(overrides: NodeStyle = {}): NodeStyle {
  return NodeStyleSchema.parse(overrides);
}

function baseNode(options: BaseFactoryOptions, fallbackName: string, idFactory: IdFactory) {
  return {
    id: options.id ?? idFactory("node"),
    name: options.name ?? fallbackName,
    layout: createNodeLayout(options.layout),
    style: createNodeStyle(options.style),
    visible: options.visible ?? true,
    locked: options.locked ?? false,
    archived: options.archived ?? false,
    metadata: options.metadata ?? {},
    ...(options.tags === undefined ? {} : { tags: options.tags }),
  };
}

export interface FrameFactoryOptions extends BaseFactoryOptions {
  children?: NodeId[];
  clip_content?: boolean;
  role?: FrameNode["role"];
}

export function createFrameNode(options: FrameFactoryOptions = {}, idFactory: IdFactory = createId): FrameNode {
  return FrameNodeSchema.parse({
    ...baseNode(options, "Frame", idFactory),
    type: "frame",
    children: options.children ?? [],
    clip_content: options.clip_content ?? false,
    ...(options.role === undefined ? {} : { role: options.role }),
  });
}

export interface GroupFactoryOptions extends BaseFactoryOptions {
  children?: NodeId[];
}

export function createGroupNode(options: GroupFactoryOptions = {}, idFactory: IdFactory = createId): GroupNode {
  return GroupNodeSchema.parse({
    ...baseNode(options, "Group", idFactory),
    type: "group",
    children: options.children ?? [],
  });
}

export interface ComponentFactoryOptions extends BaseFactoryOptions {
  children?: NodeId[];
  component_key?: string;
  description?: string;
}

export function createComponentNode(
  options: ComponentFactoryOptions = {},
  idFactory: IdFactory = createId,
): ComponentNode {
  return ComponentNodeSchema.parse({
    ...baseNode(options, "Component", idFactory),
    type: "component",
    children: options.children ?? [],
    component_key: options.component_key ?? "component.default",
    ...(options.description === undefined ? {} : { description: options.description }),
  });
}

export function createRectangleNode(
  options: BaseFactoryOptions = {},
  idFactory: IdFactory = createId,
): RectangleNode {
  return RectangleNodeSchema.parse({ ...baseNode(options, "Rectangle", idFactory), type: "rectangle" });
}

export function createEllipseNode(options: BaseFactoryOptions = {}, idFactory: IdFactory = createId): EllipseNode {
  return EllipseNodeSchema.parse({ ...baseNode(options, "Ellipse", idFactory), type: "ellipse" });
}

export interface TextFactoryOptions extends BaseFactoryOptions {
  content?: string;
  direction?: TextNode["direction"];
}

export function createTextNode(options: TextFactoryOptions = {}, idFactory: IdFactory = createId): TextNode {
  return TextNodeSchema.parse({
    ...baseNode(options, "Text", idFactory),
    type: "text",
    content: options.content ?? "Text",
    ...(options.direction === undefined ? {} : { direction: options.direction }),
  });
}

export interface ImageFactoryOptions extends BaseFactoryOptions {
  asset_id?: ImageNode["asset_id"];
  alt?: string;
  object_fit?: ImageNode["object_fit"];
}

export function createImageNode(options: ImageFactoryOptions = {}, idFactory: IdFactory = createId): ImageNode {
  return ImageNodeSchema.parse({
    ...baseNode(options, "Image", idFactory),
    type: "image",
    ...(options.asset_id === undefined ? {} : { asset_id: options.asset_id }),
    alt: options.alt ?? "",
    object_fit: options.object_fit ?? "cover",
  });
}

export interface IconFactoryOptions extends BaseFactoryOptions {
  icon_name?: string;
  label?: string;
}

export function createIconNode(options: IconFactoryOptions = {}, idFactory: IdFactory = createId): IconNode {
  return IconNodeSchema.parse({
    ...baseNode(options, "Icon", idFactory),
    type: "icon",
    icon_name: options.icon_name ?? "square",
    ...(options.label === undefined ? {} : { label: options.label }),
  });
}

export interface InstanceFactoryOptions extends BaseFactoryOptions {
  component_id: NodeId;
  overrides?: Metadata;
}

export function createInstanceNode(options: InstanceFactoryOptions, idFactory: IdFactory = createId): InstanceNode {
  return InstanceNodeSchema.parse({
    ...baseNode(options, "Instance", idFactory),
    type: "instance",
    component_id: options.component_id,
    overrides: options.overrides ?? {},
  });
}

export interface PageFactoryOptions {
  id?: PageId;
  name?: string;
  children?: NodeId[];
  background?: DesignPage["background"];
  viewport?: DesignPage["viewport"];
  archived?: boolean;
  metadata?: Metadata;
}

export function createDesignPage(options: PageFactoryOptions = {}, idFactory: IdFactory = createId): DesignPage {
  return DesignPageSchema.parse({
    id: options.id ?? idFactory("page"),
    name: options.name ?? "Page 1",
    children: options.children ?? [],
    background: options.background ?? "#f3f4f6",
    ...(options.viewport === undefined ? {} : { viewport: options.viewport }),
    archived: options.archived ?? false,
    metadata: options.metadata ?? {},
  });
}

export interface DesignDocumentFactoryOptions {
  id?: DesignDocument["id"];
  name?: string;
  now?: string | Date;
  idFactory?: IdFactory;
  withPage?: boolean;
}

function isoNow(value?: string | Date): string {
  if (value instanceof Date) return value.toISOString();
  if (value !== undefined) return new Date(value).toISOString();
  return new Date().toISOString();
}

export function createDesignDocument(options: DesignDocumentFactoryOptions = {}): DesignDocument {
  const idFactory = options.idFactory ?? createId;
  const timestamp = isoNow(options.now);
  const pages = options.withPage === true ? [createDesignPage({}, idFactory)] : [];

  return DesignDocumentSchema.parse({
    schema_version: 1,
    id: options.id ?? idFactory("document"),
    name: options.name ?? "Untitled design",
    revision: 0,
    pages,
    nodes: {},
    tokens: {},
    assets: {},
    prototype_links: {},
    metadata: {},
    created_at: timestamp,
    updated_at: timestamp,
  });
}

export function createEmptyDocument(options: Omit<DesignDocumentFactoryOptions, "withPage"> = {}): DesignDocument {
  return createDesignDocument({ ...options, withPage: false });
}

export const StarterPresetSchema = {
  web: { width: 1440, height: 900 },
  phone: { width: 390, height: 844 },
  tablet: { width: 834, height: 1194 },
} as const;

export type StarterPreset = keyof typeof StarterPresetSchema;

export interface StarterDocumentFactoryOptions extends Omit<DesignDocumentFactoryOptions, "withPage"> {
  preset?: StarterPreset;
  width?: number;
  height?: number;
}

export function createStarterDocument(options: StarterDocumentFactoryOptions = {}): DesignDocument {
  const idFactory = options.idFactory ?? createId;
  const preset = options.preset ?? "web";
  const presetSize = StarterPresetSchema[preset];
  const width = options.width ?? presetSize.width;
  const height = options.height ?? presetSize.height;
  const frame = createFrameNode(
    {
      name: `${preset[0]?.toUpperCase() ?? "W"}${preset.slice(1)} frame`,
      role: "screen",
      clip_content: true,
      layout: { width, height },
      style: { fill: "#ffffff" },
      metadata: { preset },
    },
    idFactory,
  );
  const page = createDesignPage(
    {
      name: "Page 1",
      children: [frame.id],
      viewport: { width: Math.max(width + 160, 800), height: Math.max(height + 160, 600) },
    },
    idFactory,
  );
  const document = createDesignDocument({ ...options, idFactory, withPage: false });

  return DesignDocumentSchema.parse({
    ...document,
    pages: [page],
    nodes: { [frame.id]: frame },
  });
}

export interface SampleDocumentFactoryOptions extends Omit<DesignDocumentFactoryOptions, "withPage"> {}

export function createSampleDocument(options: SampleDocumentFactoryOptions = {}): DesignDocument {
  const idFactory = options.idFactory ?? createId;
  const timestamp = isoNow(options.now);
  const backgroundToken = {
    id: idFactory("token"),
    name: "Surface",
    path: "color.surface",
    kind: "color" as const,
    value: "#ffffff",
    archived: false,
    metadata: {},
  };
  const primaryToken = {
    id: idFactory("token"),
    name: "Primary",
    path: "color.primary",
    kind: "color" as const,
    value: "#111827",
    archived: false,
    metadata: {},
  };
  const body = createTextNode(
    {
      name: "Body",
      content: "A focused workspace for turning product ideas into clear interfaces.",
      layout: { width: 342, height: 56, width_sizing: "fill" },
      style: {
        color: "#4b5563",
        typography: { font_family: "Inter", font_size: 16, line_height: 24 },
      },
    },
    idFactory,
  );
  const title = createTextNode(
    {
      name: "Title",
      content: "FormaSpec",
      layout: { width: 342, height: 48, width_sizing: "fill" },
      style: {
        color: { token_id: primaryToken.id },
        typography: { font_family: "Inter", font_size: 32, font_weight: 700, line_height: 40 },
      },
    },
    idFactory,
  );
  const buttonLabel = createTextNode(
    {
      name: "Button label",
      content: "Create design",
      layout: { width: 120, height: 24, width_sizing: "hug", height_sizing: "hug" },
      style: { color: "#ffffff", typography: { font_family: "Inter", font_size: 16, font_weight: 600 } },
    },
    idFactory,
  );
  const button = createFrameNode(
    {
      name: "Primary button",
      children: [buttonLabel.id],
      role: "button",
      layout: {
        width: 342,
        height: 48,
        width_sizing: "fill",
        mode: "horizontal",
        align_items: "center",
        justify_content: "center",
        padding: 12,
      },
      style: { fill: { token_id: primaryToken.id }, radius: 12 },
    },
    idFactory,
  );
  const card = createFrameNode(
    {
      name: "Intro card",
      children: [title.id, body.id, button.id],
      layout: {
        width: 342,
        height: 264,
        width_sizing: "fill",
        height_sizing: "hug",
        mode: "vertical",
        gap: 20,
        padding: 24,
      },
      style: {
        fill: { token_id: backgroundToken.id },
        radius: 20,
        shadows: [{ x: 0, y: 12, blur: 36, spread: 0, color: "rgba(17, 24, 39, 0.12)" }],
      },
    },
    idFactory,
  );
  const screen = createFrameNode(
    {
      name: "Mobile screen",
      children: [card.id],
      role: "screen",
      clip_content: true,
      layout: {
        width: 390,
        height: 844,
        mode: "vertical",
        gap: 24,
        padding: { top: 96, right: 24, bottom: 24, left: 24 },
        align_items: "stretch",
      },
      style: { fill: "#f3f4f6", radius: 28 },
    },
    idFactory,
  );
  const page = createDesignPage(
    { name: "Main", children: [screen.id], background: "#e5e7eb", viewport: { width: 1200, height: 900 } },
    idFactory,
  );

  return DesignDocumentSchema.parse({
    schema_version: 1,
    id: options.id ?? idFactory("document"),
    name: options.name ?? "Sample mobile design",
    revision: 0,
    pages: [page],
    nodes: {
      [screen.id]: screen,
      [card.id]: card,
      [title.id]: title,
      [body.id]: body,
      [button.id]: button,
      [buttonLabel.id]: buttonLabel,
    },
    tokens: { [backgroundToken.id]: backgroundToken, [primaryToken.id]: primaryToken },
    assets: {},
    prototype_links: {},
    metadata: { sample: true },
    created_at: timestamp,
    updated_at: timestamp,
  });
}
