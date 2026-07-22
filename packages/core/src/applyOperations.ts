import { z } from "zod";

import {
  createDesignPage,
  createFrameNode,
  createTextNode,
} from "./factories.js";
import type {
  AssetId,
  IdFactory,
  NodeId,
  PageId,
  PrototypeLinkId,
  TokenId,
} from "./ids.js";
import { createId } from "./ids.js";
import {
  DesignNodeSchema,
  NodeLayoutSchema,
  NodeStyleSchema,
  isContainerNode,
  type DesignDocument,
  type DesignNode,
  type Metadata,
  type NodeLayout,
} from "./model.js";
import {
  DesignOperationListSchema,
  type CreateTreeOperation,
  type DesignOperation,
  type InsertTemplateOperation,
  type ParentReference,
  type UpdateNodeOperation,
} from "./operations.js";
import { findNodeParent, getAncestors, getDescendantIds, isDescendant } from "./tree.js";
import {
  type Diagnostic,
  lintDesignDocument,
  validateDesignDocument,
} from "./validation.js";

export type OperationErrorCode =
  | "invalid_document"
  | "invalid_operations"
  | "revision_conflict"
  | "duplicate_id"
  | "not_found"
  | "invalid_parent"
  | "invalid_tree"
  | "invalid_patch"
  | "invalid_move"
  | "invalid_index"
  | "operation_failed"
  | "result_invalid";

export class OperationApplicationError extends Error {
  readonly code: OperationErrorCode;
  readonly operation_index: number;
  readonly diagnostics: Diagnostic[];
  readonly cause_value: unknown;

  constructor(
    code: OperationErrorCode,
    message: string,
    operationIndex: number,
    options: { diagnostics?: Diagnostic[]; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "OperationApplicationError";
    this.code = code;
    this.operation_index = operationIndex;
    this.diagnostics = options.diagnostics ?? [];
    this.cause_value = options.cause;
  }
}

export interface ApplyOperationsOptions {
  expectedRevision?: number;
  now?: string | Date;
  idFactory?: IdFactory;
}

export interface CreatedIds {
  pages: PageId[];
  nodes: NodeId[];
  tokens: TokenId[];
  assets: AssetId[];
  prototype_links: PrototypeLinkId[];
}

export interface ApplyOperationsResult {
  document: DesignDocument;
  created_ids: CreatedIds;
  diagnostics: Diagnostic[];
  applied_operations: number;
}

interface ApplyContext {
  operationIndex: number;
  idFactory: IdFactory;
  created: CreatedIds;
}

function fail(code: OperationErrorCode, message: string, context: ApplyContext, cause?: unknown): never {
  throw new OperationApplicationError(code, message, context.operationIndex, { cause });
}

function isoNow(value?: string | Date): string {
  if (value instanceof Date) return value.toISOString();
  if (value !== undefined) return new Date(value).toISOString();
  return new Date().toISOString();
}

function withoutUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined));
}

function insertAt<T>(values: T[], value: T, index: number | undefined, context: ApplyContext): void {
  const insertionIndex = index ?? values.length;
  if (insertionIndex > values.length) {
    fail("invalid_index", `Index ${insertionIndex} exceeds child count ${values.length}`, context);
  }
  values.splice(insertionIndex, 0, value);
}

function parentChildren(document: DesignDocument, parent: ParentReference, context: ApplyContext): NodeId[] {
  if ("page_id" in parent) {
    const page = document.pages.find((candidate) => candidate.id === parent.page_id);
    if (page === undefined || page.archived) fail("invalid_parent", `Active page not found: ${parent.page_id}`, context);
    return page.children;
  }

  const parentNode = document.nodes[parent.node_id];
  if (parentNode === undefined || parentNode.archived) {
    fail("invalid_parent", `Active parent node not found: ${parent.node_id}`, context);
  }
  if (!isContainerNode(parentNode)) fail("invalid_parent", `Node cannot contain children: ${parent.node_id}`, context);
  return parentNode.children;
}

function assertUniqueId(document: DesignDocument, id: string, context: ApplyContext): void {
  if (
    document.nodes[id] !== undefined ||
    document.pages.some((page) => page.id === id) ||
    document.tokens[id] !== undefined ||
    document.assets[id] !== undefined ||
    document.prototype_links[id] !== undefined
  ) {
    fail("duplicate_id", `Entity id already exists: ${id}`, context);
  }
}

function validateNewTree(document: DesignDocument, operation: CreateTreeOperation, context: ApplyContext): void {
  const nodeMap = new Map<NodeId, DesignNode>();
  for (const node of operation.nodes) {
    if (nodeMap.has(node.id)) fail("invalid_tree", `Tree contains duplicate node id: ${node.id}`, context);
    assertUniqueId(document, node.id, context);
    if (node.archived) fail("invalid_tree", `New tree cannot contain archived node: ${node.id}`, context);
    nodeMap.set(node.id, node);
  }

  const roots = new Set(operation.root_ids);
  if (roots.size !== operation.root_ids.length) fail("invalid_tree", "Tree root ids must be unique", context);
  for (const rootId of roots) {
    if (!nodeMap.has(rootId)) fail("invalid_tree", `Tree root is not present in nodes: ${rootId}`, context);
  }

  const parentCount = new Map<NodeId, number>();
  for (const node of nodeMap.values()) {
    if (!isContainerNode(node)) continue;
    for (const childId of node.children) {
      if (!nodeMap.has(childId)) fail("invalid_tree", `New tree references external child: ${childId}`, context);
      parentCount.set(childId, (parentCount.get(childId) ?? 0) + 1);
    }
  }

  for (const node of nodeMap.values()) {
    const count = parentCount.get(node.id) ?? 0;
    if (roots.has(node.id) && count !== 0) fail("invalid_tree", `Root node has an internal parent: ${node.id}`, context);
    if (!roots.has(node.id) && count !== 1) {
      fail("invalid_tree", `Non-root node must have exactly one parent: ${node.id}`, context);
    }
  }

  const visiting = new Set<NodeId>();
  const visited = new Set<NodeId>();
  const visit = (nodeId: NodeId): void => {
    if (visiting.has(nodeId)) fail("invalid_tree", `New tree contains a cycle at ${nodeId}`, context);
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    const node = nodeMap.get(nodeId);
    if (node !== undefined && isContainerNode(node)) for (const childId of node.children) visit(childId);
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  for (const rootId of roots) visit(rootId);
  if (visited.size !== nodeMap.size) fail("invalid_tree", "New tree contains unreachable nodes", context);

  parentChildren(document, operation.parent, context);
}

function applyCreateTree(document: DesignDocument, operation: CreateTreeOperation, context: ApplyContext): void {
  validateNewTree(document, operation, context);
  for (const node of operation.nodes) {
    document.nodes[node.id] = structuredClone(node);
    context.created.nodes.push(node.id);
  }
  const children = parentChildren(document, operation.parent, context);
  const startIndex = operation.index ?? children.length;
  if (startIndex > children.length) fail("invalid_index", `Index ${startIndex} exceeds child count ${children.length}`, context);
  children.splice(startIndex, 0, ...operation.root_ids);
}

const fieldCompatibility: Record<string, ReadonlySet<DesignNode["type"]>> = {
  content: new Set(["text"]),
  direction: new Set(["text"]),
  asset_id: new Set(["image"]),
  alt: new Set(["image"]),
  object_fit: new Set(["image"]),
  icon_name: new Set(["icon"]),
  label: new Set(["icon"]),
  component_id: new Set(["instance"]),
  overrides: new Set(["instance"]),
  clip_content: new Set(["frame"]),
  role: new Set(["frame"]),
  component_key: new Set(["component"]),
  description: new Set(["component"]),
};

function updateNode(document: DesignDocument, operation: UpdateNodeOperation, context: ApplyContext): void {
  const node = document.nodes[operation.node_id];
  if (node === undefined || node.archived) fail("not_found", `Active node not found: ${operation.node_id}`, context);
  const patch = operation.patch;
  const candidate = structuredClone(node) as unknown as Record<string, unknown>;

  for (const field of Object.keys(fieldCompatibility)) {
    if (Object.prototype.hasOwnProperty.call(patch, field) && !fieldCompatibility[field]?.has(node.type)) {
      fail("invalid_patch", `Field ${field} cannot be applied to a ${node.type} node`, context);
    }
  }

  if (patch.name !== undefined) candidate.name = patch.name;
  if (patch.visible !== undefined) candidate.visible = patch.visible;
  if (patch.locked !== undefined) candidate.locked = patch.locked;
  if (patch.tags !== undefined) {
    if (patch.tags === null) delete candidate.tags;
    else candidate.tags = patch.tags;
  }
  if (patch.layout !== undefined) candidate.layout = NodeLayoutSchema.parse({ ...node.layout, ...patch.layout });
  if (patch.style !== undefined || patch.clear_style !== undefined) {
    const style = { ...node.style } as Record<string, unknown>;
    for (const key of patch.clear_style ?? []) delete style[key];
    Object.assign(style, patch.style ?? {});
    candidate.style = NodeStyleSchema.parse(style);
  }
  if (patch.metadata !== undefined) {
    candidate.metadata = patch.metadata_mode === "replace" ? patch.metadata : { ...node.metadata, ...patch.metadata };
  }
  if (patch.accessibility_label !== undefined) {
    const metadata = { ...(candidate.metadata as Metadata) };
    if (patch.accessibility_label === null) delete metadata.accessible_label;
    else metadata.accessible_label = patch.accessibility_label;
    candidate.metadata = metadata;
  }

  for (const field of Object.keys(fieldCompatibility)) {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
    const value = (patch as unknown as Record<string, unknown>)[field];
    if (value === null) delete candidate[field];
    else candidate[field] = value;
  }

  try {
    document.nodes[node.id] = DesignNodeSchema.parse(candidate);
  } catch (error) {
    fail("invalid_patch", `Patch produces an invalid ${node.type} node`, context, error);
  }
}

function removeFromCurrentParent(document: DesignDocument, nodeId: NodeId, context: ApplyContext): void {
  const current = findNodeParent(document, nodeId);
  if (current === undefined) fail("invalid_move", `Node has no current parent: ${nodeId}`, context);
  const children = parentChildren(document, current.parent, context);
  const index = children.indexOf(nodeId);
  if (index === -1) fail("invalid_move", `Current parent does not contain node: ${nodeId}`, context);
  children.splice(index, 1);
}

function instantiateTemplate(
  operation: InsertTemplateOperation,
  context: ApplyContext,
): { rootIds: NodeId[]; nodes: DesignNode[] } {
  const overrides = operation.overrides;
  const rootId = overrides?.id ?? context.idFactory("node");
  const rootLayout = withoutUndefined((overrides?.layout ?? {}) as Record<string, unknown>) as Partial<NodeLayout>;
  const rootStyle = overrides?.style ?? {};
  const metadata = overrides?.metadata ?? {};
  const common = { id: rootId, name: overrides?.name, style: rootStyle, metadata };

  if (operation.template === "text") {
    const text = createTextNode(
      {
        ...common,
        name: overrides?.name ?? "Text",
        content: overrides?.text ?? "Text",
        layout: { width: 160, height: 24, width_sizing: "hug", height_sizing: "hug", ...rootLayout },
      },
      context.idFactory,
    );
    return { rootIds: [text.id], nodes: [text] };
  }

  if (operation.template === "button") {
    const label = createTextNode(
      {
        name: "Button label",
        content: overrides?.text ?? "Button",
        layout: { width: 80, height: 20, width_sizing: "hug", height_sizing: "hug" },
        style: { color: "#ffffff", typography: { font_family: "Inter", font_size: 14, font_weight: 600 } },
      },
      context.idFactory,
    );
    const button = createFrameNode(
      {
        ...common,
        name: overrides?.name ?? "Button",
        children: [label.id],
        role: "button",
        layout: {
          width: 160,
          height: 44,
          mode: "horizontal",
          align_items: "center",
          justify_content: "center",
          padding: 12,
          ...rootLayout,
        },
        style: { fill: "#111827", radius: 10, ...rootStyle },
      },
      context.idFactory,
    );
    return { rootIds: [button.id], nodes: [button, label] };
  }

  const defaults = {
    mobile_screen: { name: "Mobile screen", width: 390, height: 844, role: "screen" as const, clip: true },
    desktop_screen: { name: "Desktop screen", width: 1440, height: 900, role: "screen" as const, clip: true },
    stack: { name: "Stack", width: 320, height: 200, role: "none" as const, clip: false },
    card: { name: "Card", width: 320, height: 200, role: "section" as const, clip: false },
  }[operation.template];
  const frame = createFrameNode(
    {
      ...common,
      name: overrides?.name ?? defaults.name,
      role: defaults.role,
      clip_content: defaults.clip,
      layout: {
        width: defaults.width,
        height: defaults.height,
        mode: operation.template === "stack" || operation.template === "card" ? "vertical" : "absolute",
        ...(operation.template === "stack" || operation.template === "card" ? { gap: 16 } : {}),
        ...(operation.template === "card" ? { padding: 24 } : {}),
        ...rootLayout,
      },
      style: {
        fill: "#ffffff",
        ...(operation.template === "card" ? { radius: 16 } : {}),
        ...rootStyle,
      },
    },
    context.idFactory,
  );
  return { rootIds: [frame.id], nodes: [frame] };
}

function applyMetadata(document: DesignDocument, operation: Extract<DesignOperation, { type: "set_metadata" }>, context: ApplyContext) {
  const merge = (current: Metadata): Metadata =>
    operation.mode === "replace" ? operation.metadata : { ...current, ...operation.metadata };
  const target = operation.target;

  if (target.kind === "document") {
    document.metadata = merge(document.metadata);
    return;
  }
  if (target.kind === "page") {
    const page = document.pages.find((candidate) => candidate.id === target.id);
    if (page === undefined) fail("not_found", `Page not found: ${target.id}`, context);
    page.metadata = merge(page.metadata);
    return;
  }
  if (target.kind === "node") {
    const node = document.nodes[target.id];
    if (node === undefined) fail("not_found", `Node not found: ${target.id}`, context);
    node.metadata = merge(node.metadata);
    return;
  }
  if (target.kind === "token") {
    const token = document.tokens[target.id];
    if (token === undefined) fail("not_found", `Token not found: ${target.id}`, context);
    token.metadata = merge(token.metadata);
    return;
  }
  if (target.kind === "asset") {
    const asset = document.assets[target.id];
    if (asset === undefined) fail("not_found", `Asset not found: ${target.id}`, context);
    asset.metadata = merge(asset.metadata);
    return;
  }
  const link = document.prototype_links[target.id];
  if (link === undefined) fail("not_found", `Prototype link not found: ${target.id}`, context);
  link.metadata = merge(link.metadata);
}

function applyOperation(document: DesignDocument, operation: DesignOperation, context: ApplyContext): void {
  switch (operation.type) {
    case "create_page": {
      const pageId = operation.page.id ?? context.idFactory("page");
      assertUniqueId(document, pageId, context);
      const page = createDesignPage(
        {
          id: pageId,
          name: operation.page.name,
          ...(operation.page.background === undefined ? {} : { background: operation.page.background }),
          ...(operation.page.viewport === undefined ? {} : { viewport: operation.page.viewport }),
          ...(operation.page.metadata === undefined ? {} : { metadata: operation.page.metadata }),
        },
        context.idFactory,
      );
      insertAt(document.pages, page, operation.index, context);
      context.created.pages.push(page.id);
      return;
    }
    case "create_tree":
      applyCreateTree(document, operation, context);
      return;
    case "update_node":
      updateNode(document, operation, context);
      return;
    case "move_node": {
      const node = document.nodes[operation.node_id];
      if (node === undefined || node.archived) fail("not_found", `Active node not found: ${operation.node_id}`, context);
      if ("node_id" in operation.parent) {
        if (operation.parent.node_id === operation.node_id || isDescendant(document, operation.node_id, operation.parent.node_id)) {
          fail("invalid_move", "A node cannot be moved into itself or one of its descendants", context);
        }
      }
      parentChildren(document, operation.parent, context);
      removeFromCurrentParent(document, operation.node_id, context);
      const destination = parentChildren(document, operation.parent, context);
      insertAt(destination, operation.node_id, operation.index, context);
      if (operation.position !== undefined) {
        node.layout = NodeLayoutSchema.parse({ ...node.layout, ...operation.position });
      }
      return;
    }
    case "archive_nodes": {
      const selected = new Set(operation.node_ids);
      for (const nodeId of selected) {
        const node = document.nodes[nodeId];
        if (node === undefined || node.archived) fail("not_found", `Active node not found: ${nodeId}`, context);
      }
      const roots = [...selected].filter(
        (nodeId) => !getAncestors(document, nodeId).some((ancestor) => selected.has(ancestor.id)),
      );
      const archived = new Set<NodeId>();
      for (const rootId of roots) {
        archived.add(rootId);
        for (const descendantId of getDescendantIds(document, rootId, { includeArchived: true })) archived.add(descendantId);
        removeFromCurrentParent(document, rootId, context);
      }
      for (const nodeId of archived) {
        const node = document.nodes[nodeId];
        if (node !== undefined) node.archived = true;
      }
      for (const [linkId, link] of Object.entries(document.prototype_links)) {
        const targetNodeId =
          link.action.type === "navigate" || link.action.type === "open_overlay" ? link.action.node_id : undefined;
        if (archived.has(link.source_node_id) || (targetNodeId !== undefined && archived.has(targetNodeId))) {
          delete document.prototype_links[linkId];
        }
      }
      return;
    }
    case "archive_page": {
      const page = document.pages.find((candidate) => candidate.id === operation.page_id);
      if (page === undefined || page.archived) {
        fail("not_found", `Active page not found: ${operation.page_id}`, context);
      }
      if (document.pages.filter((candidate) => !candidate.archived).length <= 1) {
        fail("operation_failed", "A design must keep at least one active page", context);
      }

      const archived = new Set<NodeId>();
      for (const rootId of page.children) {
        const root = document.nodes[rootId];
        if (root === undefined) continue;
        archived.add(rootId);
        for (const descendantId of getDescendantIds(document, rootId, { includeArchived: true })) {
          archived.add(descendantId);
        }
      }
      page.archived = true;
      for (const nodeId of archived) {
        const node = document.nodes[nodeId];
        if (node !== undefined) node.archived = true;
      }
      for (const [linkId, link] of Object.entries(document.prototype_links)) {
        const targetsArchivedPage =
          (link.action.type === "navigate" || link.action.type === "open_overlay")
          && link.action.page_id === page.id;
        const targetNodeId =
          link.action.type === "navigate" || link.action.type === "open_overlay"
            ? link.action.node_id
            : undefined;
        if (
          archived.has(link.source_node_id)
          || targetsArchivedPage
          || (targetNodeId !== undefined && archived.has(targetNodeId))
        ) {
          delete document.prototype_links[linkId];
        }
      }
      return;
    }
    case "upsert_token": {
      if (document.tokens[operation.token.id] === undefined) context.created.tokens.push(operation.token.id);
      document.tokens[operation.token.id] = structuredClone(operation.token);
      return;
    }
    case "upsert_asset": {
      if (document.assets[operation.asset.id] === undefined) context.created.assets.push(operation.asset.id);
      document.assets[operation.asset.id] = structuredClone(operation.asset);
      return;
    }
    case "insert_template": {
      const template = instantiateTemplate(operation, context);
      applyCreateTree(
        document,
        {
          type: "create_tree",
          parent: operation.parent,
          root_ids: template.rootIds,
          nodes: template.nodes,
          ...(operation.index === undefined ? {} : { index: operation.index }),
        },
        context,
      );
      return;
    }
    case "insert_component_instance":
      fail(
        "operation_failed",
        "insert_component_instance requires a server-resolved prepared preview.",
        context,
      );
      return;
    case "set_prototype_link": {
      if (document.prototype_links[operation.link.id] === undefined) {
        context.created.prototype_links.push(operation.link.id);
      }
      document.prototype_links[operation.link.id] = structuredClone(operation.link);
      return;
    }
    case "set_metadata":
      applyMetadata(document, operation, context);
      return;
  }
}

export function applyOperations(
  inputDocument: DesignDocument,
  inputOperations: readonly DesignOperation[],
  options: ApplyOperationsOptions = {},
): ApplyOperationsResult {
  const sourceValidation = validateDesignDocument(inputDocument);
  if (!sourceValidation.success || sourceValidation.document === undefined) {
    throw new OperationApplicationError("invalid_document", "Source design document is invalid", -1, {
      diagnostics: sourceValidation.diagnostics,
    });
  }
  if (options.expectedRevision !== undefined && sourceValidation.document.revision !== options.expectedRevision) {
    throw new OperationApplicationError(
      "revision_conflict",
      `Expected revision ${options.expectedRevision}, received ${sourceValidation.document.revision}`,
      -1,
    );
  }

  const parsedOperations = DesignOperationListSchema.safeParse(inputOperations);
  if (!parsedOperations.success) {
    throw new OperationApplicationError("invalid_operations", "Operation list is invalid", -1, {
      cause: parsedOperations.error,
    });
  }

  const document = structuredClone(sourceValidation.document);
  const created: CreatedIds = { pages: [], nodes: [], tokens: [], assets: [], prototype_links: [] };
  const context: ApplyContext = { operationIndex: -1, idFactory: options.idFactory ?? createId, created };

  for (let index = 0; index < parsedOperations.data.length; index += 1) {
    const operation = parsedOperations.data[index];
    if (operation === undefined) continue;
    context.operationIndex = index;
    try {
      applyOperation(document, operation, context);
    } catch (error) {
      if (error instanceof OperationApplicationError) throw error;
      const message = error instanceof z.ZodError ? error.issues[0]?.message ?? "Schema validation failed" : "Operation failed";
      throw new OperationApplicationError("operation_failed", message, index, { cause: error });
    }
  }

  if (parsedOperations.data.length > 0) {
    document.revision += 1;
    document.updated_at = isoNow(options.now);
  }

  const resultValidation = validateDesignDocument(document);
  if (!resultValidation.success || resultValidation.document === undefined) {
    throw new OperationApplicationError("result_invalid", "Operations would produce an invalid document", context.operationIndex, {
      diagnostics: resultValidation.diagnostics,
    });
  }

  return {
    document: resultValidation.document,
    created_ids: created,
    diagnostics: lintDesignDocument(resultValidation.document),
    applied_operations: parsedOperations.data.length,
  };
}

export const applyDesignOperations = applyOperations;
