import { z } from "zod";

import type { NodeId, TokenId } from "./ids.js";
import {
  DesignDocumentSchema,
  isContainerNode,
  isTokenReference,
  type DesignDocument,
  type DesignNode,
  type JsonValue,
} from "./model.js";

export const DiagnosticSeveritySchema = z.enum(["error", "warning", "info"]);
export const DiagnosticSchema = z
  .object({
    severity: DiagnosticSeveritySchema,
    code: z.string().min(1),
    message: z.string().min(1),
    path: z.array(z.union([z.string(), z.number()])),
    entity_id: z.string().optional(),
  })
  .strict();

export type Diagnostic = z.infer<typeof DiagnosticSchema>;

export interface DesignDocumentValidationResult {
  success: boolean;
  diagnostics: Diagnostic[];
  document?: DesignDocument;
}

function diagnostic(
  severity: Diagnostic["severity"],
  code: string,
  message: string,
  path: Diagnostic["path"],
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

function collectTokenReferences(value: unknown, target: Set<TokenId>): void {
  if (isTokenReference(value)) {
    target.add(value.token_id);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTokenReferences(item, target);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) collectTokenReferences(child, target);
  }
}

function actionNodeId(node: DesignDocument["prototype_links"][string]["action"]): NodeId | undefined {
  return node.type === "navigate" || node.type === "open_overlay" ? node.node_id : undefined;
}

function parseHexColor(value: unknown): [number, number, number] | undefined {
  if (typeof value !== "string") return undefined;
  const short = /^#([a-f\d])([a-f\d])([a-f\d])$/i.exec(value);
  const full = /^#([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(value);
  if (short !== null) {
    return [Number.parseInt(`${short[1]}${short[1]}`, 16), Number.parseInt(`${short[2]}${short[2]}`, 16), Number.parseInt(`${short[3]}${short[3]}`, 16)];
  }
  if (full !== null) return [Number.parseInt(full[1] ?? "0", 16), Number.parseInt(full[2] ?? "0", 16), Number.parseInt(full[3] ?? "0", 16)];
  return undefined;
}

function luminance(color: [number, number, number]): number {
  const channels = color.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return (channels[0] ?? 0) * 0.2126 + (channels[1] ?? 0) * 0.7152 + (channels[2] ?? 0) * 0.0722;
}

function contrastRatio(foreground: [number, number, number], background: [number, number, number]): number {
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

export function lintDesignDocument(document: DesignDocument): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const pageIds = new Set<string>();
  const referencedTokens = new Set<TokenId>();
  const referencedAssets = new Set<string>();

  document.pages.forEach((page, pageIndex) => {
    if (pageIds.has(page.id)) {
      diagnostics.push(
        diagnostic("error", "duplicate_page_id", `Page id is duplicated: ${page.id}`, ["pages", pageIndex, "id"], page.id),
      );
    }
    pageIds.add(page.id);
    collectTokenReferences(page.background, referencedTokens);
    if (!page.archived && page.children.length === 0) {
      diagnostics.push(
        diagnostic("warning", "empty_page", `Page has no root nodes: ${page.name}`, ["pages", pageIndex, "children"], page.id),
      );
    }
  });

  for (const [recordId, node] of Object.entries(document.nodes)) {
    if (recordId !== node.id) {
      diagnostics.push(
        diagnostic("error", "node_key_mismatch", `Node record key ${recordId} does not match ${node.id}`, ["nodes", recordId], node.id),
      );
    }
    collectTokenReferences(node.layout, referencedTokens);
    collectTokenReferences(node.style, referencedTokens);
    if (node.type === "image" && node.asset_id !== undefined) referencedAssets.add(node.asset_id);
  }

  for (const [recordId, token] of Object.entries(document.tokens)) {
    if (recordId !== token.id) {
      diagnostics.push(
        diagnostic("error", "token_key_mismatch", `Token record key ${recordId} does not match ${token.id}`, ["tokens", recordId], token.id),
      );
    }
  }
  for (const [recordId, asset] of Object.entries(document.assets)) {
    if (recordId !== asset.id) {
      diagnostics.push(
        diagnostic("error", "asset_key_mismatch", `Asset record key ${recordId} does not match ${asset.id}`, ["assets", recordId], asset.id),
      );
    }
  }
  for (const [recordId, link] of Object.entries(document.prototype_links)) {
    if (recordId !== link.id) {
      diagnostics.push(
        diagnostic(
          "error",
          "prototype_link_key_mismatch",
          `Prototype link record key ${recordId} does not match ${link.id}`,
          ["prototype_links", recordId],
          link.id,
        ),
      );
    }
  }

  const tokenPaths = new Map<string, string>();
  for (const token of Object.values(document.tokens)) {
    const existing = tokenPaths.get(token.path);
    if (!token.archived && existing !== undefined && existing !== token.id) {
      diagnostics.push(
        diagnostic("error", "duplicate_token_path", `Active tokens share path ${token.path}`, ["tokens", token.id, "path"], token.id),
      );
    }
    if (!token.archived) tokenPaths.set(token.path, token.id);
  }

  const parentCounts = new Map<NodeId, number>();
  const parentNodes = new Map<NodeId, NodeId>();
  const parentPages = new Map<NodeId, number>();
  const missingReferences = new Set<string>();
  const countReference = (nodeId: NodeId, path: Diagnostic["path"], activeParent: boolean): void => {
    parentCounts.set(nodeId, (parentCounts.get(nodeId) ?? 0) + 1);
    const child = document.nodes[nodeId];
    if (child === undefined) {
      const key = `${path.join(".")}:${nodeId}`;
      if (!missingReferences.has(key)) {
        missingReferences.add(key);
        diagnostics.push(diagnostic("error", "missing_node", `Referenced node does not exist: ${nodeId}`, path, nodeId));
      }
    } else if (activeParent && child.archived) {
      diagnostics.push(
        diagnostic("error", "archived_node_referenced", `Active tree references archived node: ${nodeId}`, path, nodeId),
      );
    }
  };

  document.pages.forEach((page, pageIndex) => {
    page.children.forEach((nodeId, childIndex) => {
      countReference(nodeId, ["pages", pageIndex, "children", childIndex], !page.archived);
      if (!parentPages.has(nodeId)) parentPages.set(nodeId, pageIndex);
    });
  });
  for (const node of Object.values(document.nodes)) {
    if (!isContainerNode(node)) continue;
    node.children.forEach((childId, childIndex) => {
      countReference(childId, ["nodes", node.id, "children", childIndex], !node.archived);
      if (!parentNodes.has(childId)) parentNodes.set(childId, node.id);
    });
  }

  for (const [nodeId, count] of parentCounts) {
    if (count > 1) {
      diagnostics.push(
        diagnostic("error", "multiple_parents", `Node is referenced by ${count} parents: ${nodeId}`, ["nodes", nodeId], nodeId),
      );
    }
  }

  const visitState = new Map<NodeId, "visiting" | "visited">();
  const cycleNodes = new Set<NodeId>();
  const visitForCycles = (nodeId: NodeId): void => {
    if (visitState.get(nodeId) === "visited") return;
    if (visitState.get(nodeId) === "visiting") {
      if (!cycleNodes.has(nodeId)) {
        cycleNodes.add(nodeId);
        diagnostics.push(diagnostic("error", "tree_cycle", `Cycle detected at node ${nodeId}`, ["nodes", nodeId], nodeId));
      }
      return;
    }
    visitState.set(nodeId, "visiting");
    const node = document.nodes[nodeId];
    if (node !== undefined && isContainerNode(node)) {
      for (const childId of node.children) visitForCycles(childId);
    }
    visitState.set(nodeId, "visited");
  };
  for (const node of Object.values(document.nodes)) visitForCycles(node.id);

  const reachable = new Set<NodeId>();
  const walkReachable = (nodeId: NodeId): void => {
    if (reachable.has(nodeId)) return;
    reachable.add(nodeId);
    const node = document.nodes[nodeId];
    if (node !== undefined && isContainerNode(node)) {
      for (const childId of node.children) walkReachable(childId);
    }
  };
  for (const page of document.pages) {
    if (!page.archived) for (const rootId of page.children) walkReachable(rootId);
  }

  for (const node of Object.values(document.nodes)) {
    if (!node.archived && !reachable.has(node.id)) {
      diagnostics.push(
        diagnostic("error", "orphan_active_node", `Active node is not reachable from an active page: ${node.id}`, ["nodes", node.id], node.id),
      );
    }
    if (node.archived && reachable.has(node.id)) {
      diagnostics.push(
        diagnostic("error", "archived_node_reachable", `Archived node is reachable from an active page: ${node.id}`, ["nodes", node.id], node.id),
      );
    }
    if (node.type === "image" && node.asset_id !== undefined && document.assets[node.asset_id] === undefined) {
      diagnostics.push(
        diagnostic("error", "missing_asset", `Image references missing asset: ${node.asset_id}`, ["nodes", node.id, "asset_id"], node.id),
      );
    }
    if (
      node.type === "image" &&
      node.asset_id !== undefined &&
      document.assets[node.asset_id] !== undefined &&
      document.assets[node.asset_id]?.kind !== "image"
    ) {
      diagnostics.push(
        diagnostic(
          "error",
          "invalid_image_asset_kind",
          `Image node references a non-image asset: ${node.asset_id}`,
          ["nodes", node.id, "asset_id"],
          node.id,
        ),
      );
    }
    if (node.type === "image" && node.alt.trim().length === 0) {
      diagnostics.push(
        diagnostic("warning", "image_missing_alt", `Image has no alternative text: ${node.name}`, ["nodes", node.id, "alt"], node.id),
      );
    }
    if (node.type === "text" && node.content.trim().length === 0) {
      diagnostics.push(
        diagnostic("warning", "empty_text", `Text node has empty content: ${node.name}`, ["nodes", node.id, "content"], node.id),
      );
    }
    if (typeof node.style.opacity === "number" && (node.style.opacity < 0 || node.style.opacity > 1)) {
      diagnostics.push(
        diagnostic("warning", "opacity_out_of_range", "Opacity should be between 0 and 1", ["nodes", node.id, "style", "opacity"], node.id),
      );
    }
    if (node.style.border !== undefined && typeof node.style.border.width === "number" && node.style.border.width < 0) {
      diagnostics.push(
        diagnostic("warning", "negative_border_width", "Border width should not be negative", ["nodes", node.id, "style", "border", "width"], node.id),
      );
    }
    const isInteractive =
      (node.type === "frame" && node.role === "button") ||
      Object.values(document.prototype_links).some((link) => link.source_node_id === node.id);
    if (isInteractive && (node.layout.width < 44 || node.layout.height < 44)) {
      diagnostics.push(
        diagnostic(
          "warning",
          "small_interactive_target",
          `Interactive target is smaller than 44×44: ${node.name}`,
          ["nodes", node.id, "layout"],
          node.id,
        ),
      );
    }
    if (isContainerNode(node) && node.layout.mode === "absolute" && (node.style.overflow === "hidden" || node.style.overflow === "clip" || (node.type === "frame" && node.clip_content))) {
      for (const childId of node.children) {
        const child = document.nodes[childId];
        if (
          child !== undefined &&
          !child.archived &&
          (child.layout.x < 0 ||
            child.layout.y < 0 ||
            child.layout.x + child.layout.width > node.layout.width ||
            child.layout.y + child.layout.height > node.layout.height)
        ) {
          diagnostics.push(
            diagnostic(
              "warning",
              "child_clipped",
              `Child may be clipped by ${node.name}: ${child.name}`,
              ["nodes", node.id, "children"],
              child.id,
            ),
          );
        }
      }
    }
    if (node.type === "text") {
      const foreground = parseHexColor(node.style.color);
      let background: [number, number, number] | undefined;
      let parentId = parentNodes.get(node.id);
      while (parentId !== undefined && background === undefined) {
        background = parseHexColor(document.nodes[parentId]?.style.fill);
        parentId = parentNodes.get(parentId);
      }
      if (background === undefined) {
        let rootId = node.id;
        let ancestorId = parentNodes.get(rootId);
        while (ancestorId !== undefined) {
          rootId = ancestorId;
          ancestorId = parentNodes.get(rootId);
        }
        const pageIndex = parentPages.get(rootId);
        background = pageIndex === undefined ? undefined : parseHexColor(document.pages[pageIndex]?.background);
      }
      if (foreground !== undefined && background !== undefined) {
        const fontSize = typeof node.style.typography?.font_size === "number" ? node.style.typography.font_size : 16;
        const fontWeight = node.style.typography?.font_weight;
        const bold = typeof fontWeight === "number" ? fontWeight >= 700 : fontWeight === "bold";
        const threshold = fontSize >= 24 || (fontSize >= 18.66 && bold) ? 3 : 4.5;
        const ratio = contrastRatio(foreground, background);
        if (ratio < threshold) {
          diagnostics.push(
            diagnostic(
              "warning",
              "low_text_contrast",
              `Text contrast ${ratio.toFixed(2)}:1 is below ${threshold}:1`,
              ["nodes", node.id, "style", "color"],
              node.id,
            ),
          );
        }
      }
    }
    if (node.type === "instance") {
      const component = document.nodes[node.component_id];
      if (component === undefined || component.type !== "component" || component.archived) {
        diagnostics.push(
          diagnostic(
            "error",
            "invalid_component_reference",
            `Instance references an unavailable component: ${node.component_id}`,
            ["nodes", node.id, "component_id"],
            node.id,
          ),
        );
      }
    }
  }

  for (const tokenId of referencedTokens) {
    const token = document.tokens[tokenId];
    if (token === undefined || token.archived) {
      diagnostics.push(
        diagnostic("error", "missing_token", `Style references unavailable token: ${tokenId}`, ["tokens", tokenId], tokenId),
      );
    }
  }

  for (const link of Object.values(document.prototype_links)) {
    const source = document.nodes[link.source_node_id];
    if (source === undefined || source.archived) {
      diagnostics.push(
        diagnostic(
          "error",
          "invalid_prototype_source",
          `Prototype source node is unavailable: ${link.source_node_id}`,
          ["prototype_links", link.id, "source_node_id"],
          link.id,
        ),
      );
    }
    if (link.action.type === "navigate" || link.action.type === "open_overlay") {
      const action = link.action;
      const page = document.pages.find((candidate) => candidate.id === action.page_id);
      if (page === undefined || page.archived) {
        diagnostics.push(
          diagnostic(
            "error",
            "invalid_prototype_page",
            `Prototype target page is unavailable: ${action.page_id}`,
            ["prototype_links", link.id, "action", "page_id"],
            link.id,
          ),
        );
      }
      const targetNodeId = actionNodeId(action);
      if (targetNodeId !== undefined) {
        const targetNode = document.nodes[targetNodeId];
        if (targetNode === undefined || targetNode.archived) {
          diagnostics.push(
            diagnostic(
              "error",
              "invalid_prototype_node",
              `Prototype target node is unavailable: ${targetNodeId}`,
              ["prototype_links", link.id, "action", "node_id"],
              link.id,
            ),
          );
        }
      }
    }
  }

  for (const token of Object.values(document.tokens)) {
    if (!token.archived && !referencedTokens.has(token.id)) {
      diagnostics.push(
        diagnostic("info", "unused_token", `Token is currently unused: ${token.path}`, ["tokens", token.id], token.id),
      );
    }
  }
  for (const asset of Object.values(document.assets)) {
    if (!referencedAssets.has(asset.id)) {
      diagnostics.push(
        diagnostic("info", "unused_asset", `Asset is currently unused: ${asset.name}`, ["assets", asset.id], asset.id),
      );
    }
  }

  return diagnostics;
}

export const lintDocument = lintDesignDocument;

export function validateDesignDocument(input: unknown): DesignDocumentValidationResult {
  const parsed = DesignDocumentSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      diagnostics: parsed.error.issues.map((issue) =>
        diagnostic("error", "schema_error", issue.message, issue.path.map((segment) => segment as string | number)),
      ),
    };
  }

  const diagnostics = lintDesignDocument(parsed.data);
  return {
    success: !diagnostics.some((item) => item.severity === "error"),
    diagnostics,
    document: parsed.data,
  };
}

export const validateDocument = validateDesignDocument;

export class DesignDocumentValidationError extends Error {
  readonly diagnostics: Diagnostic[];

  constructor(diagnostics: Diagnostic[]) {
    super(diagnostics.find((item) => item.severity === "error")?.message ?? "Design document validation failed");
    this.name = "DesignDocumentValidationError";
    this.diagnostics = diagnostics;
  }
}

export function assertValidDesignDocument(input: unknown): DesignDocument {
  const result = validateDesignDocument(input);
  if (!result.success || result.document === undefined) throw new DesignDocumentValidationError(result.diagnostics);
  return result.document;
}

export function metadataValue(value: JsonValue): JsonValue {
  return value;
}
