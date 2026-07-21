import {
  buildParentIndex,
  isContainerNode,
  type DesignDocument,
  type DesignNode,
  type LayoutMode,
  type NodeId,
  type NodeLayoutPatch,
  type PageId,
  type UpdateNodePatch,
} from "@designer/core";

const GEOMETRY_PRECISION = 10_000;

/** Keep useful sub-pixel precision while removing event noise and negative zero. */
export function normalizeGeometryNumber(value: number): number {
  if (!Number.isFinite(value)) throw new Error("Geometry values must be finite.");
  const normalized = Math.round(value * GEOMETRY_PRECISION) / GEOMETRY_PRECISION;
  return Object.is(normalized, -0) ? 0 : normalized;
}

export function composeDraftTransform(
  rotation = 0,
  translation: readonly [number, number] = [0, 0],
): string {
  const x = normalizeGeometryNumber(translation[0]);
  const y = normalizeGeometryNumber(translation[1]);
  const angle = normalizeGeometryNumber(rotation);
  const parts: string[] = [];
  if (x !== 0 || y !== 0) parts.push(`translate3d(${x}px, ${y}px, 0)`);
  if (angle !== 0) parts.push(`rotate(${angle}deg)`);
  return parts.join(" ");
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Returns effective, editable selection roots in stable input order.
 * Hidden/locked ancestry makes a node non-interactive, and selecting an
 * ancestor removes its descendants from a multi-selection.
 */
export function canonicalizeNodeSelection(
  document: DesignDocument,
  requestedIds: readonly NodeId[],
  pageId?: PageId | null,
): NodeId[] {
  const parentIndex = buildParentIndex(document);
  const unique = [...new Set(requestedIds)];
  const eligible = new Set<NodeId>();

  for (const nodeId of unique) {
    let currentId: NodeId | undefined = nodeId;
    let currentPageId: PageId | undefined;
    const seen = new Set<NodeId>();
    let selectable = true;

    while (currentId !== undefined) {
      if (seen.has(currentId)) {
        selectable = false;
        break;
      }
      seen.add(currentId);
      const node = document.nodes[currentId];
      if (!node || node.archived || !node.visible || node.locked) {
        selectable = false;
        break;
      }
      const entry = parentIndex.get(currentId);
      if (!entry) {
        selectable = false;
        break;
      }
      if ("page_id" in entry.parent) {
        currentPageId = entry.parent.page_id;
        break;
      }
      currentId = entry.parent.node_id;
    }

    const page = currentPageId === undefined
      ? undefined
      : document.pages.find((candidate) => candidate.id === currentPageId);
    if (selectable && page && !page.archived && (pageId == null || currentPageId === pageId)) {
      eligible.add(nodeId);
    }
  }

  const roots = unique.filter((nodeId) => {
    if (!eligible.has(nodeId)) return false;
    let entry = parentIndex.get(nodeId);
    const seen = new Set<NodeId>([nodeId]);
    while (entry && "node_id" in entry.parent) {
      const parentId = entry.parent.node_id;
      if (eligible.has(parentId)) return false;
      if (seen.has(parentId)) return false;
      seen.add(parentId);
      entry = parentIndex.get(parentId);
    }
    return true;
  });

  return arraysEqual(roots, requestedIds) ? [...requestedIds] : roots;
}

export function sameNodeSelection(left: readonly NodeId[], right: readonly NodeId[]): boolean {
  return arraysEqual(left, right);
}

/** Moveable writes x/y only when every selection root belongs to absolute flow. */
export function selectionUsesAbsoluteLayout(document: DesignDocument, nodeIds: readonly NodeId[]): boolean {
  if (nodeIds.length === 0) return false;
  const parentIndex = buildParentIndex(document);
  return nodeIds.every((nodeId) => {
    const entry = parentIndex.get(nodeId);
    if (!entry) return false;
    if ("page_id" in entry.parent) return true;
    return document.nodes[entry.parent.node_id]?.layout.mode === "absolute";
  });
}

export type AutoLayoutMode = Exclude<LayoutMode, "absolute">;

export interface CanvasPoint {
  x: number;
  y: number;
}

export interface CanvasClientRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface CanvasSelectionBounds extends CanvasClientRect {
  width: number;
  height: number;
}

/**
 * Return the exact client-space union used by the multi-selection overlay.
 * React Moveable rounds target offsets while calculating a group rectangle;
 * retaining the browser's fractional client geometry here prevents that
 * upstream rounding from growing beyond the CSS-pixel alignment budget when
 * the canvas is zoomed.
 */
export function unionClientRects(
  rects: readonly CanvasClientRect[],
): CanvasSelectionBounds | null {
  if (rects.length === 0) return null;
  const values = rects.flatMap((rect) => [rect.left, rect.top, rect.right, rect.bottom]);
  if (!values.every(Number.isFinite)) throw new Error("Selection bounds must be finite.");
  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  const right = Math.max(...rects.map((rect) => rect.right));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

export interface AutoLayoutContainerDescriptor {
  nodeId: NodeId;
  mode: AutoLayoutMode;
  wrap: boolean;
  depth: number;
}

export interface AutoLayoutContainerGeometry extends AutoLayoutContainerDescriptor {
  rect: CanvasClientRect;
}

export interface AutoLayoutSiblingGeometry {
  /** Index after removing the node currently being dragged. */
  index: number;
  rect: CanvasClientRect;
}

export interface SelectionGestureCapabilities {
  draggable: boolean;
  resizable: boolean;
  flow: "absolute" | "auto" | "none";
}

function autoLayoutMode(mode: LayoutMode | undefined): mode is AutoLayoutMode {
  return mode === "horizontal" || mode === "vertical" || mode === "grid";
}

function effectiveNodeIsInteractive(
  document: DesignDocument,
  nodeId: NodeId,
  parentIndex: ReturnType<typeof buildParentIndex>,
): boolean {
  const seen = new Set<NodeId>();
  let currentId: NodeId | undefined = nodeId;
  while (currentId !== undefined) {
    if (seen.has(currentId)) return false;
    seen.add(currentId);
    const node = document.nodes[currentId];
    if (!node || node.archived || !node.visible || node.locked) return false;
    const entry = parentIndex.get(currentId);
    if (!entry) return false;
    if ("page_id" in entry.parent) {
      const pageId = entry.parent.page_id;
      const page = document.pages.find((candidate) => candidate.id === pageId);
      return Boolean(page && !page.archived);
    }
    currentId = entry.parent.node_id;
  }
  return false;
}

/**
 * Moveable supports multi-selection only in absolute flow. A single child in
 * auto-layout can be dragged for reorder/reparent and resized by changing its
 * sizing constraints, never by writing x/y.
 */
export function selectionGestureCapabilities(
  document: DesignDocument,
  nodeIds: readonly NodeId[],
): SelectionGestureCapabilities {
  if (nodeIds.length === 0) return { draggable: false, resizable: false, flow: "none" };
  const parentIndex = buildParentIndex(document);
  if (!nodeIds.every((nodeId) => effectiveNodeIsInteractive(document, nodeId, parentIndex))) {
    return { draggable: false, resizable: false, flow: "none" };
  }

  const absolute = nodeIds.every((nodeId) => {
    const entry = parentIndex.get(nodeId);
    return Boolean(entry && ("page_id" in entry.parent
      || document.nodes[entry.parent.node_id]?.layout.mode === "absolute"));
  });
  if (absolute) {
    const node = nodeIds.length === 1 ? document.nodes[nodeIds[0]!] : undefined;
    return {
      draggable: true,
      resizable: Boolean(node
        && node.layout.width_sizing === "fixed"
        && node.layout.height_sizing === "fixed"),
      flow: "absolute",
    };
  }

  if (nodeIds.length === 1) {
    const entry = parentIndex.get(nodeIds[0]!);
    const mode = entry && "node_id" in entry.parent
      ? document.nodes[entry.parent.node_id]?.layout.mode
      : undefined;
    if (autoLayoutMode(mode)) return { draggable: true, resizable: true, flow: "auto" };
  }
  return { draggable: false, resizable: false, flow: "none" };
}

/**
 * Find visible, unlocked auto-layout containers in the source page in one tree
 * traversal. Descendants of the dragged node are excluded to prevent cycles.
 */
export function autoLayoutDropContainers(
  document: DesignDocument,
  sourceNodeId: NodeId,
): AutoLayoutContainerDescriptor[] {
  const parentIndex = buildParentIndex(document);
  let sourcePageId: PageId | undefined;
  let sourceEntry = parentIndex.get(sourceNodeId);
  const sourceSeen = new Set<NodeId>([sourceNodeId]);
  while (sourceEntry) {
    if ("page_id" in sourceEntry.parent) {
      sourcePageId = sourceEntry.parent.page_id;
      break;
    }
    if (sourceSeen.has(sourceEntry.parent.node_id)) break;
    sourceSeen.add(sourceEntry.parent.node_id);
    sourceEntry = parentIndex.get(sourceEntry.parent.node_id);
  }
  if (!sourcePageId) return [];

  const result: AutoLayoutContainerDescriptor[] = [];
  const visited = new Set<NodeId>();
  const sourcePage = document.pages.find((page) => page.id === sourcePageId && !page.archived);
  const stack = (sourcePage?.children ?? []).map((nodeId) => ({
    nodeId,
    depth: 0,
    interactiveAncestors: true,
    insideSource: false,
  }));

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || visited.has(current.nodeId)) continue;
    visited.add(current.nodeId);
    const node = document.nodes[current.nodeId];
    if (!node) continue;
    const interactive = current.interactiveAncestors
      && !node.archived
      && node.visible
      && !node.locked;
    const insideSource = current.insideSource || node.id === sourceNodeId;
    if (interactive && !insideSource && isContainerNode(node) && autoLayoutMode(node.layout.mode)) {
      result.push({
        nodeId: node.id,
        mode: node.layout.mode,
        wrap: node.layout.wrap === true,
        depth: current.depth,
      });
    }
    if (!isContainerNode(node)) continue;
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const childId = node.children[index];
      if (!childId) continue;
      stack.push({
        nodeId: childId,
        depth: current.depth + 1,
        interactiveAncestors: interactive,
        insideSource,
      });
    }
  }

  return result;
}

function rectCenter(rect: CanvasClientRect): CanvasPoint {
  return { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
}

function rectDistanceOnAxis(value: number, start: number, end: number): number {
  if (value < start) return start - value;
  if (value > end) return value - end;
  return 0;
}

function clampIndex(index: number, destinationLength: number): number {
  return Math.max(0, Math.min(destinationLength, index));
}

function linearInsertionIndex(
  axis: "x" | "y",
  siblings: readonly AutoLayoutSiblingGeometry[],
  point: CanvasPoint,
  destinationLength: number,
): number {
  const ordered = [...siblings].sort((left, right) => left.index - right.index);
  if (ordered.length === 0) return 0;
  const centers = ordered.map((entry) => rectCenter(entry.rect)[axis]);
  const direction = centers.length > 1 && centers.at(-1)! < centers[0]! ? -1 : 1;
  const coordinate = point[axis];
  for (let index = 0; index < ordered.length; index += 1) {
    if ((coordinate - centers[index]!) * direction < 0) {
      return clampIndex(ordered[index]!.index, destinationLength);
    }
  }
  return clampIndex(ordered.at(-1)!.index + 1, destinationLength);
}

function wrappedInsertionIndex(
  primaryAxis: "x" | "y",
  siblings: readonly AutoLayoutSiblingGeometry[],
  point: CanvasPoint,
  destinationLength: number,
): number {
  const crossAxis = primaryAxis === "x" ? "y" : "x";
  const crossStart = crossAxis === "x" ? "left" : "top";
  const crossEnd = crossAxis === "x" ? "right" : "bottom";
  const ordered = [...siblings].sort((left, right) => left.index - right.index);
  if (ordered.length === 0) return 0;

  const groups: AutoLayoutSiblingGeometry[][] = [];
  for (const sibling of ordered) {
    const center = rectCenter(sibling.rect)[crossAxis];
    const lastGroup = groups.at(-1);
    if (!lastGroup) {
      groups.push([sibling]);
      continue;
    }
    const groupStart = Math.min(...lastGroup.map((entry) => entry.rect[crossStart]));
    const groupEnd = Math.max(...lastGroup.map((entry) => entry.rect[crossEnd]));
    if (center >= groupStart && center <= groupEnd) lastGroup.push(sibling);
    else groups.push([sibling]);
  }

  const coordinate = point[crossAxis];
  const group = groups.reduce((closest, candidate) => {
    const candidateStart = Math.min(...candidate.map((entry) => entry.rect[crossStart]));
    const candidateEnd = Math.max(...candidate.map((entry) => entry.rect[crossEnd]));
    const closestStart = Math.min(...closest.map((entry) => entry.rect[crossStart]));
    const closestEnd = Math.max(...closest.map((entry) => entry.rect[crossEnd]));
    return rectDistanceOnAxis(coordinate, candidateStart, candidateEnd)
      < rectDistanceOnAxis(coordinate, closestStart, closestEnd)
      ? candidate
      : closest;
  });
  return linearInsertionIndex(primaryAxis, group, point, destinationLength);
}

/** Return the final child index after the dragged node has been removed. */
export function autoLayoutInsertionIndex(
  mode: AutoLayoutMode,
  wrap: boolean,
  siblings: readonly AutoLayoutSiblingGeometry[],
  point: CanvasPoint,
  destinationLength: number,
): number {
  if (mode === "grid" || wrap) {
    return wrappedInsertionIndex(mode === "vertical" ? "y" : "x", siblings, point, destinationLength);
  }
  return linearInsertionIndex(mode === "horizontal" ? "x" : "y", siblings, point, destinationLength);
}

export function pointInsideRect(point: CanvasPoint, rect: CanvasClientRect): boolean {
  return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
}

/** Prefer the deepest/smallest container under the pointer, then the current parent as a safe fallback. */
export function chooseAutoLayoutDropContainer(
  candidates: readonly AutoLayoutContainerGeometry[],
  point: CanvasPoint,
  currentParentId: NodeId,
): AutoLayoutContainerGeometry | undefined {
  const containing = candidates
    .filter((candidate) => pointInsideRect(point, candidate.rect))
    .sort((left, right) => {
      if (left.depth !== right.depth) return right.depth - left.depth;
      const leftArea = Math.max(0, left.rect.right - left.rect.left) * Math.max(0, left.rect.bottom - left.rect.top);
      const rightArea = Math.max(0, right.rect.right - right.rect.left) * Math.max(0, right.rect.bottom - right.rect.top);
      return leftArea - rightArea;
    });
  return containing[0] ?? candidates.find((candidate) => candidate.nodeId === currentParentId);
}

function constrainedDimension(value: number, minimum: number | undefined, maximum: number | undefined): number {
  let constrained = Math.max(1, normalizeGeometryNumber(value));
  if (minimum !== undefined) constrained = Math.max(constrained, minimum);
  if (maximum !== undefined) constrained = Math.min(constrained, maximum);
  return normalizeGeometryNumber(constrained);
}

/**
 * Translate a Moveable resize result into canonical layout semantics. Absolute
 * children retain x/y behavior; auto-layout children change only the active
 * fixed/fill/hug axes and never receive absolute coordinates.
 */
export function resizePatchForGesture(
  node: DesignNode,
  parentMode: LayoutMode | undefined,
  gesture: {
    width: number;
    height: number;
    direction: readonly number[];
    translation?: readonly number[];
  },
): UpdateNodePatch | null {
  const width = constrainedDimension(gesture.width, node.layout.min_width, node.layout.max_width);
  const height = constrainedDimension(gesture.height, node.layout.min_height, node.layout.max_height);
  const automatic = autoLayoutMode(parentMode);
  const layout: NodeLayoutPatch = {};

  if (!automatic) {
    if (node.layout.width_sizing !== "fixed" || node.layout.height_sizing !== "fixed") return null;
    const dx = normalizeGeometryNumber(gesture.translation?.[0] ?? 0);
    const dy = normalizeGeometryNumber(gesture.translation?.[1] ?? 0);
    const x = normalizeGeometryNumber(node.layout.x + dx);
    const y = normalizeGeometryNumber(node.layout.y + dy);
    if (x === node.layout.x && y === node.layout.y && width === node.layout.width && height === node.layout.height) {
      return null;
    }
    Object.assign(layout, { x, y, width, height });
    return { layout };
  }

  if ((gesture.direction[0] ?? 0) !== 0
    && (width !== node.layout.width || node.layout.width_sizing !== "fixed")) {
    layout.width = width;
    layout.width_sizing = "fixed";
  }
  if ((gesture.direction[1] ?? 0) !== 0
    && (height !== node.layout.height || node.layout.height_sizing !== "fixed")) {
    layout.height = height;
    layout.height_sizing = "fixed";
  }
  return Object.keys(layout).length > 0 ? { layout } : null;
}
