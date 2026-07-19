import {
  DesignDocumentSchema,
  DesignOperationSchema,
  createFrameNode,
  createGroupNode,
  createIconNode,
  createImageNode,
  createRectangleNode,
  createEllipseNode,
  createTextNode,
  createNodeId,
  createPageId,
  createPrototypeLinkId,
  createTokenId,
  findNodeParent,
  getNodeChildren,
  isContainerNode,
  isTokenReference,
  nodeToCss,
  resolveTokenValue,
  type DesignDocument,
  type DesignNode,
  type ContainerNode,
  type DesignOperation,
  type DesignPage,
  type DesignToken,
  type NodeId,
  type NodeParent,
  type PageId,
  type ParentReference,
  type PrototypeLink,
  type TokenId,
} from "@designer/core";
import type { CSSProperties } from "react";

export type {
  DesignDocument,
  DesignNode,
  DesignOperation,
  DesignPage,
  DesignToken,
  NodeId,
  PageId,
  ParentReference,
  PrototypeLink,
  TokenId,
};

export { createNodeId, createPageId, createPrototypeLinkId, createTokenId };

export type DevicePreset = "web" | "phone" | "tablet";
export type NodeType = "frame" | "group" | "text" | "rectangle" | "ellipse" | "image" | "icon";

export interface DesignProjectSummary {
  id: string;
  name: string;
  version: number;
  revisionId?: string;
  preset?: DevicePreset;
  updatedAt: string;
  thumbnailUrl?: string;
}

export interface RevisionSummary {
  id: string;
  version: number;
  message: string;
  actor?: string;
  createdAt: string;
}

export const DEVICE_PRESETS: Record<DevicePreset, { label: string; width: number; height: number }> = {
  web: { label: "Desktop", width: 1440, height: 900 },
  phone: { label: "Phone", width: 390, height: 844 },
  tablet: { label: "Tablet", width: 834, height: 1194 },
};

export function createClientKey(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
}

/** Parse the exact canonical shared document schema at the REST boundary. */
export function normalizeDocument(input: unknown): DesignDocument {
  const envelope = input as { design?: unknown; document?: unknown; data?: unknown } | null;
  return DesignDocumentSchema.parse((envelope && (envelope.design ?? envelope.document ?? envelope.data)) ?? input);
}

/** Serialize only values accepted by the exact canonical shared schema. */
export function serializeDocument(document: DesignDocument): DesignDocument {
  return DesignDocumentSchema.parse(structuredClone(document));
}

export function normalizeOperations(operations: DesignOperation[]): DesignOperation[] {
  return operations.map((operation) => DesignOperationSchema.parse(operation));
}

export function cloneDocument(document: DesignDocument): DesignDocument {
  return structuredClone(document);
}

export function nodeChildren(node: DesignNode): readonly NodeId[] {
  return getNodeChildren(node);
}

export function parentOf(document: DesignDocument, nodeId: NodeId): NodeParent | undefined {
  return findNodeParent(document, nodeId)?.parent;
}

export function pageIdForNode(document: DesignDocument, nodeId: NodeId): PageId | undefined {
  let current: NodeId | undefined = nodeId;
  const seen = new Set<NodeId>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const parent: NodeParent | undefined = findNodeParent(document, current)?.parent;
    if (!parent) return undefined;
    if ("page_id" in parent) return parent.page_id;
    current = parent.node_id;
  }
  return undefined;
}

export function parentLayoutMode(document: DesignDocument, nodeId: NodeId) {
  const parent = parentOf(document, nodeId);
  return parent && "node_id" in parent ? document.nodes[parent.node_id]?.layout.mode : undefined;
}

export function styleForNode(document: DesignDocument, node: DesignNode, includePosition = true): CSSProperties {
  return nodeToCss(node, document, {
    parentLayoutMode: parentLayoutMode(document, node.id),
    includePosition,
  }) as CSSProperties;
}

export function resolvedString(
  document: DesignDocument,
  value: string | { token_id: TokenId } | undefined,
  fallback = "",
): string {
  if (value === undefined) return fallback;
  const resolved = resolveTokenValue(value, document);
  return resolved === undefined ? fallback : String(resolved);
}

export function resolvedNumber(
  document: DesignDocument,
  value: number | { token_id: TokenId } | undefined,
  fallback = 0,
): number {
  if (value === undefined) return fallback;
  const resolved = resolveTokenValue(value, document);
  if (typeof resolved === "number") return resolved;
  const parsed = Number.parseFloat(String(resolved));
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function rawString(value: string | { token_id: TokenId } | undefined, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function rawNumber(value: number | { token_id: TokenId } | undefined, fallback = 0): number {
  return typeof value === "number" ? value : fallback;
}

export function tokenIdOf(value: unknown): TokenId | undefined {
  return isTokenReference(value) ? value.token_id : undefined;
}

export function isRtlText(value: string): boolean {
  for (const character of value) {
    if (/[\u0590-\u08ff\ufb1d-\ufefc]/u.test(character)) return true;
    if (/\p{L}/u.test(character)) return false;
  }
  return false;
}

export function resolvedDirection(node: DesignNode): "ltr" | "rtl" {
  if (node.type === "text" && (node.direction === "ltr" || node.direction === "rtl")) return node.direction;
  return node.type === "text" && isRtlText(node.content) ? "rtl" : "ltr";
}

export function isNodeContainer(node: DesignNode): node is ContainerNode {
  return isContainerNode(node);
}

export function createNodeForEditor(type: NodeType, index = 0): DesignNode {
  const layout = {
    x: 64 + (index % 4) * 24,
    y: 64 + (index % 5) * 24,
    width: type === "text" ? 220 : type === "group" ? 260 : type === "icon" ? 48 : 160,
    height: type === "text" ? 48 : type === "group" ? 120 : type === "icon" ? 48 : 160,
    mode: type === "group" ? "vertical" as const : "absolute" as const,
    width_sizing: "fixed" as const,
    height_sizing: "fixed" as const,
    ...(type === "group" ? { gap: 12, align_items: "start" as const } : {}),
  };
  switch (type) {
    case "frame":
      return createFrameNode({ name: "Frame", clip_content: true, layout, style: { fill: "#ffffff" } });
    case "group":
      return createGroupNode({ name: "Stack", layout, style: { fill: "#f1f0ff", radius: 12 } });
    case "text":
      return createTextNode({
        name: "Text",
        content: "New text",
        direction: "auto",
        layout,
        style: { color: "#101828", typography: { font_family: "Inter", font_size: 24, font_weight: 650, line_height: 29 } },
      });
    case "rectangle":
      return createRectangleNode({ name: "Rectangle", layout, style: { fill: "#e9e7ff", radius: 12 } });
    case "ellipse":
      return createEllipseNode({ name: "Ellipse", layout, style: { fill: "#e9e7ff" } });
    case "image":
      return createImageNode({ name: "Image", alt: "Image placeholder", object_fit: "cover", layout, style: { fill: "#dce4f8", radius: 14 } });
    case "icon":
      return createIconNode({ name: "Icon", icon_name: "sparkles", layout, style: { fill: "#f0eeff", color: "#6d5ef7", radius: 12 } });
  }
}

export function cloneNodeWithId(node: DesignNode, id: NodeId): DesignNode {
  const clone = structuredClone(node);
  clone.id = id;
  clone.archived = false;
  clone.name = `${node.name} copy`;
  clone.layout = { ...clone.layout, x: clone.layout.x + 24, y: clone.layout.y + 24 };
  return clone;
}

export function linksForNode(document: DesignDocument, nodeId: NodeId): PrototypeLink[] {
  return Object.values(document.prototype_links).filter((link) => link.source_node_id === nodeId);
}

export function tokenCategory(token: DesignToken): "colors" | "spacing" | "typography" | "other" {
  if (token.kind === "color") return "colors";
  if (token.kind === "dimension" || token.kind === "number") return "spacing";
  if (token.kind === "font_family" || token.kind === "font_weight") return "typography";
  return "other";
}
