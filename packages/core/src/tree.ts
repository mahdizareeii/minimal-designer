import type { NodeId, PageId } from "./ids.js";
import {
  isContainerNode,
  type ContainerNode,
  type DesignDocument,
  type DesignNode,
  type DesignPage,
} from "./model.js";

export type NodeParent = { page_id: PageId } | { node_id: NodeId };

export interface ParentIndexEntry {
  parent: NodeParent;
  index: number;
}

export function getNode(document: DesignDocument, nodeId: NodeId): DesignNode | undefined {
  return document.nodes[nodeId];
}

export function requireNode(document: DesignDocument, nodeId: NodeId): DesignNode {
  const node = getNode(document, nodeId);
  if (node === undefined) throw new Error(`Node not found: ${nodeId}`);
  return node;
}

export function getPage(document: DesignDocument, pageId: PageId): DesignPage | undefined {
  return document.pages.find((page) => page.id === pageId);
}

export function requirePage(document: DesignDocument, pageId: PageId): DesignPage {
  const page = getPage(document, pageId);
  if (page === undefined) throw new Error(`Page not found: ${pageId}`);
  return page;
}

export function getNodeChildren(node: DesignNode): readonly NodeId[] {
  return isContainerNode(node) ? node.children : [];
}

export function requireContainerNode(document: DesignDocument, nodeId: NodeId): ContainerNode {
  const node = requireNode(document, nodeId);
  if (!isContainerNode(node)) throw new Error(`Node cannot contain children: ${nodeId}`);
  return node;
}

export function buildParentIndex(document: DesignDocument): Map<NodeId, ParentIndexEntry> {
  const index = new Map<NodeId, ParentIndexEntry>();

  for (const page of document.pages) {
    page.children.forEach((nodeId, childIndex) => {
      if (!index.has(nodeId)) index.set(nodeId, { parent: { page_id: page.id }, index: childIndex });
    });
  }

  for (const node of Object.values(document.nodes)) {
    if (!isContainerNode(node)) continue;
    node.children.forEach((childId, childIndex) => {
      if (!index.has(childId)) index.set(childId, { parent: { node_id: node.id }, index: childIndex });
    });
  }

  return index;
}

export function findNodeParent(document: DesignDocument, nodeId: NodeId): ParentIndexEntry | undefined {
  return buildParentIndex(document).get(nodeId);
}

export function getAncestors(document: DesignDocument, nodeId: NodeId): DesignNode[] {
  const parentIndex = buildParentIndex(document);
  const ancestors: DesignNode[] = [];
  const seen = new Set<NodeId>([nodeId]);
  let current = parentIndex.get(nodeId);

  while (current !== undefined && "node_id" in current.parent) {
    if (seen.has(current.parent.node_id)) break;
    seen.add(current.parent.node_id);
    const parentNode = document.nodes[current.parent.node_id];
    if (parentNode === undefined) break;
    ancestors.push(parentNode);
    current = parentIndex.get(parentNode.id);
  }

  return ancestors;
}

export function getDescendantIds(
  document: DesignDocument,
  nodeId: NodeId,
  options: { includeSelf?: boolean; includeArchived?: boolean } = {},
): NodeId[] {
  const result: NodeId[] = [];
  const seen = new Set<NodeId>();
  const stack: NodeId[] = [nodeId];

  while (stack.length > 0) {
    const currentId = stack.pop();
    if (currentId === undefined || seen.has(currentId)) continue;
    seen.add(currentId);
    const node = document.nodes[currentId];
    if (node === undefined) continue;
    if ((options.includeSelf === true || currentId !== nodeId) && (options.includeArchived === true || !node.archived)) {
      result.push(currentId);
    }
    if (isContainerNode(node)) {
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        const childId = node.children[index];
        if (childId !== undefined) stack.push(childId);
      }
    }
  }

  return result;
}

export function isDescendant(document: DesignDocument, ancestorId: NodeId, candidateId: NodeId): boolean {
  return getDescendantIds(document, ancestorId, { includeArchived: true }).includes(candidateId);
}

export interface WalkEntry {
  node: DesignNode;
  depth: number;
  parent: NodeParent;
  index: number;
}

export function walkPage(document: DesignDocument, pageId: PageId, includeArchived = false): WalkEntry[] {
  const page = getPage(document, pageId);
  if (page === undefined) return [];
  const result: WalkEntry[] = [];
  const visited = new Set<NodeId>();
  const stack = page.children
    .map((nodeId, index) => ({ nodeId, depth: 0, parent: { page_id: page.id } as NodeParent, index }))
    .reverse();

  while (stack.length > 0) {
    const entry = stack.pop();
    if (entry === undefined || visited.has(entry.nodeId)) continue;
    visited.add(entry.nodeId);
    const node = document.nodes[entry.nodeId];
    if (node === undefined) continue;
    if (includeArchived || !node.archived) result.push({ node, depth: entry.depth, parent: entry.parent, index: entry.index });

    if (isContainerNode(node)) {
      for (let childIndex = node.children.length - 1; childIndex >= 0; childIndex -= 1) {
        const childId = node.children[childIndex];
        if (childId !== undefined) {
          stack.push({ nodeId: childId, depth: entry.depth + 1, parent: { node_id: node.id }, index: childIndex });
        }
      }
    }
  }

  return result;
}

export interface SearchNodesOptions {
  page_id?: PageId;
  types?: DesignNode["type"][];
  include_archived?: boolean;
  limit?: number;
}

export function searchNodes(
  document: DesignDocument,
  query: string,
  options: SearchNodesOptions = {},
): DesignNode[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const candidates =
    options.page_id === undefined
      ? Object.values(document.nodes)
      : walkPage(document, options.page_id, options.include_archived).map((entry) => entry.node);
  const limit = Math.max(0, options.limit ?? Number.POSITIVE_INFINITY);
  const allowedTypes = options.types === undefined ? undefined : new Set(options.types);

  return candidates
    .filter((node) => options.include_archived === true || !node.archived)
    .filter((node) => allowedTypes === undefined || allowedTypes.has(node.type))
    .filter((node) => {
      if (normalizedQuery.length === 0) return true;
      const text = [
        node.name,
        node.type,
        ...(node.tags ?? []),
        node.type === "text" ? node.content : "",
        node.type === "icon" ? node.icon_name : "",
      ]
        .join(" ")
        .toLocaleLowerCase();
      return text.includes(normalizedQuery);
    })
    .slice(0, limit);
}

export function getNodePath(document: DesignDocument, nodeId: NodeId): Array<DesignPage | DesignNode> {
  const node = document.nodes[nodeId];
  if (node === undefined) return [];
  const ancestors = getAncestors(document, nodeId).reverse();
  const parent = findNodeParent(document, ancestors[0]?.id ?? nodeId);
  const page = parent !== undefined && "page_id" in parent.parent ? getPage(document, parent.parent.page_id) : undefined;
  return [...(page === undefined ? [] : [page]), ...ancestors, node];
}
