import {
  applyOperations,
  getAncestors,
  type DesignOperation,
  type ParentReference,
  type UpdateNodePatch,
} from "@designer/core";
import { create } from "zustand";

import {
  cloneDocument,
  cloneNodeWithId,
  createClientKey,
  createNodeForEditor,
  createNodeId,
  createPageId,
  createPrototypeLinkId,
  createTokenId,
  DEVICE_PRESETS,
  isNodeContainer,
  linksForNode,
  nodeChildren,
  pageIdForNode,
  parentOf,
  type DesignDocument,
  type DesignNode,
  type DesignProjectSummary,
  type DesignToken,
  type DevicePreset,
  type NodeId,
  type NodeType,
  type PageId,
  type RevisionSummary,
  type TokenId,
} from "../domain";
import { canonicalizeNodeSelection } from "../lib/canvas-geometry";
import { clampCanvasZoom, type ViewportState } from "../lib/viewport-transform";
import {
  ApiError,
  commitArchivePreview,
  commitRevision,
  createArchivePreview,
  createDesign as createRemoteDesign,
  listDesigns,
  listHistory,
  readDesign,
  restoreRevision as restoreRemoteRevision,
  subscribeToEvents,
  updateContext,
  uploadAsset,
} from "../lib/api";

type EditorTool = "select" | "hand" | "text" | "shape";
type InspectorTab = "design" | "tokens" | "history";

interface CommandBatch {
  operations: DesignOperation[];
  inverse: DesignOperation[];
  redoable: boolean;
}

interface ArchiveReview {
  previewId: string;
  baseVersion: number;
  changedNodeIds: string[];
  operations: DesignOperation[];
  baseDocument: DesignDocument;
  previewDocument: DesignDocument;
}

interface DesignerState {
  projects: DesignProjectSummary[];
  document: DesignDocument | null;
  baseVersion: number;
  activePageId: PageId | null;
  selectedIds: NodeId[];
  zoom: number;
  pan: { x: number; y: number };
  tool: EditorTool;
  inspectorTab: InspectorTab;
  dashboardLoading: boolean;
  editorLoading: boolean;
  creating: boolean;
  saving: boolean;
  saveState: "idle" | "dirty" | "saving" | "saved" | "review" | "error" | "conflict";
  offline: boolean;
  error: string | null;
  notice: string | null;
  pendingOperations: DesignOperation[];
  undoStack: CommandBatch[];
  redoStack: CommandBatch[];
  revisions: RevisionSummary[];
  historyLoading: boolean;
  prototypeOpen: boolean;
  prototypePageId: PageId | null;
  sidebarsHidden: boolean;
  archiveReview: ArchiveReview | null;
  loadProjects: () => Promise<void>;
  createProject: (name: string, preset: DevicePreset) => Promise<string>;
  openDesign: (id: string) => Promise<void>;
  closeDesign: () => void;
  setActivePage: (pageId: PageId) => void;
  select: (ids: NodeId[], additive?: boolean) => void;
  setZoom: (zoom: number) => void;
  setPan: (pan: { x: number; y: number }) => void;
  setViewport: (viewport: ViewportState) => void;
  setTool: (tool: EditorTool) => void;
  setInspectorTab: (tab: InspectorTab) => void;
  setNotice: (notice: string | null) => void;
  setSidebarsHidden: (hidden: boolean) => void;
  setProductBrief: (brief: string) => void;
  updateNode: (nodeId: NodeId, patch: UpdateNodePatch) => void;
  updateNodes: (updates: Array<{ nodeId: NodeId; patch: UpdateNodePatch }>) => void;
  addNode: (type: NodeType) => void;
  insertTemplate: (template: "button" | "card" | "stack") => void;
  addPage: () => void;
  addFrame: (preset: DevicePreset) => void;
  duplicateSelection: () => void;
  deleteSelection: () => void;
  approveArchiveReview: () => Promise<void>;
  discardArchiveReview: () => void;
  moveNodeByGesture: (nodeId: NodeId, parent: ParentReference, index: number) => void;
  moveSelection: (direction: -1 | 1) => void;
  reparentSelection: (parent: ParentReference) => void;
  setNodePrototype: (nodeId: NodeId, targetPageId: PageId, targetNodeId?: NodeId) => void;
  upsertToken: (token: DesignToken) => void;
  deleteToken: (tokenId: TokenId) => void;
  uploadImage: (nodeId: NodeId, file: File) => Promise<void>;
  undo: () => void;
  redo: () => void;
  save: () => Promise<void>;
  reloadConflict: () => Promise<void>;
  loadHistory: () => Promise<void>;
  restoreRevision: (version: number) => Promise<void>;
  openPrototype: () => void;
  closePrototype: () => void;
  goToPrototypePage: (pageId: PageId) => void;
  connectEvents: () => () => void;
}

function mergeProjects(remote: DesignProjectSummary[]): DesignProjectSummary[] {
  return [...remote].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function syncDeepLink(pageId: PageId | null, nodeId?: NodeId): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (pageId) url.searchParams.set("page", pageId); else url.searchParams.delete("page");
  if (nodeId) url.searchParams.set("node", nodeId); else url.searchParams.delete("node");
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

let activeSavePromise: Promise<void> | null = null;

function applyOptimistic(
  document: DesignDocument,
  operations: DesignOperation[],
  advanceRevision: boolean,
): DesignDocument {
  const result = applyOperations(document, operations, { expectedRevision: document.revision }).document;
  if (!advanceRevision) result.revision = document.revision;
  return result;
}

function inversePatch(node: DesignNode, patch: UpdateNodePatch): UpdateNodePatch {
  const inverse: Record<string, unknown> = {};
  if (patch.name !== undefined) inverse.name = node.name;
  if (patch.visible !== undefined) inverse.visible = node.visible;
  if (patch.locked !== undefined) inverse.locked = node.locked;
  if (patch.layout !== undefined) {
    const layout: Record<string, unknown> = {};
    for (const key of Object.keys(patch.layout)) {
      layout[key] = node.layout[key as keyof typeof node.layout];
    }
    inverse.layout = layout;
  }
  if (patch.style !== undefined || patch.clear_style !== undefined) {
    inverse.style = structuredClone(node.style);
    const introducedStyleKeys = Object.keys(patch.style ?? {}).filter((key) =>
      !Object.prototype.hasOwnProperty.call(node.style, key));
    if (introducedStyleKeys.length > 0) inverse.clear_style = introducedStyleKeys;
  }
  if (patch.tags !== undefined) inverse.tags = node.tags ?? null;
  if (patch.metadata !== undefined) {
    inverse.metadata = structuredClone(node.metadata);
    inverse.metadata_mode = "replace";
  }
  for (const key of [
    "content", "direction", "asset_id", "alt", "object_fit", "icon_name", "label",
    "component_id", "overrides", "clip_content", "role", "component_key", "description",
  ]) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      inverse[key] = (node as unknown as Record<string, unknown>)[key] ?? null;
    }
  }
  return inverse as UpdateNodePatch;
}

function executeBatch(
  state: DesignerState,
  operations: DesignOperation[],
  inverse: DesignOperation[],
  options: { trackUndo?: boolean; redoable?: boolean } = {},
): Partial<DesignerState> {
  if (!state.document) return {};
  try {
    const shouldAdvance = state.pendingOperations.length === 0 && !state.saving && state.document.revision === state.baseVersion;
    const next: Partial<DesignerState> = {
      document: applyOptimistic(state.document, operations, shouldAdvance),
      pendingOperations: [...state.pendingOperations, ...operations],
      redoStack: [],
      saveState: "dirty",
      error: null,
    };
    if (options.trackUndo !== false && inverse.length > 0) {
      next.undoStack = [
        ...state.undoStack.slice(-79),
        { operations, inverse, redoable: options.redoable ?? true },
      ];
    }
    return next;
  } catch (error) {
    return { error: error instanceof Error ? error.message : "This edit is not valid for the selected node." };
  }
}

function defaultParent(document: DesignDocument, pageId: PageId, selectedIds: NodeId[]): ParentReference | null {
  if (selectedIds.length === 1) {
    const selected = document.nodes[selectedIds[0]!];
    if (selected && isNodeContainer(selected) && !selected.archived) return { node_id: selected.id };
  }
  const page = document.pages.find((candidate) => candidate.id === pageId);
  const firstFrame = page?.children
    .map((id) => document.nodes[id])
    .find((node) => node?.type === "frame" && !node.archived);
  return firstFrame ? { node_id: firstFrame.id } : page ? { page_id: page.id } : null;
}

function cloneSubtree(document: DesignDocument, rootId: NodeId): { nodes: DesignNode[]; rootId: NodeId } {
  const ids = new Map<NodeId, NodeId>();
  const collect = (id: NodeId) => {
    const node = document.nodes[id];
    if (!node) return;
    ids.set(id, createNodeId());
    for (const childId of nodeChildren(node)) collect(childId);
  };
  collect(rootId);
  const nodes: DesignNode[] = [];
  for (const [sourceId, targetId] of ids) {
    const source = document.nodes[sourceId];
    if (!source) continue;
    const clone = cloneNodeWithId(source, targetId);
    if (sourceId !== rootId) {
      clone.name = source.name;
      clone.layout = structuredClone(source.layout);
    }
    if (isNodeContainer(clone)) clone.children = clone.children.map((childId) => ids.get(childId) ?? childId);
    nodes.push(clone);
  }
  return { nodes, rootId: ids.get(rootId)! };
}

export const useDesignerStore = create<DesignerState>((set, get) => ({
  projects: [],
  document: null,
  baseVersion: 0,
  activePageId: null,
  selectedIds: [],
  zoom: 0.72,
  pan: { x: 120, y: 92 },
  tool: "select",
  inspectorTab: "design",
  dashboardLoading: false,
  editorLoading: false,
  creating: false,
  saving: false,
  saveState: "idle",
  offline: false,
  error: null,
  notice: null,
  pendingOperations: [],
  undoStack: [],
  redoStack: [],
  revisions: [],
  historyLoading: false,
  prototypeOpen: false,
  prototypePageId: null,
  sidebarsHidden: false,
  archiveReview: null,

  loadProjects: async () => {
    set({ dashboardLoading: true, error: null });
    try {
      set({ projects: mergeProjects(await listDesigns()), dashboardLoading: false, offline: false });
    } catch (error) {
      set({
        projects: [],
        dashboardLoading: false,
        offline: true,
        error: error instanceof Error ? error.message : "Could not reach the design server.",
      });
    }
  },

  createProject: async (name, preset) => {
    set({ creating: true, error: null });
    try {
      const document = await createRemoteDesign(name, preset, createClientKey("create"));
      set((state) => ({
        creating: false,
        offline: false,
        projects: mergeProjects([
          { id: document.id, name: document.name, version: document.revision, updatedAt: document.updated_at, preset },
          ...state.projects,
        ]),
      }));
      return document.id;
    } catch (error) {
      set({
        creating: false,
        offline: true,
        error: error instanceof Error ? error.message : "Could not create the design.",
      });
      throw error;
    }
  },

  openDesign: async (id) => {
    set({ editorLoading: true, error: null, selectedIds: [], pendingOperations: [], undoStack: [], redoStack: [], archiveReview: null });
    try {
      const document = await readDesign(id);
      const requestedPage = new URLSearchParams(window.location.search).get("page") as PageId | null;
      const requestedNode = new URLSearchParams(window.location.search).get("node") as NodeId | null;
      const activePageId = requestedPage && document.pages.some((page) => page.id === requestedPage)
        ? requestedPage
        : document.pages.find((page) => !page.archived)?.id ?? null;
      const selectedIds = requestedNode
        ? canonicalizeNodeSelection(document, [requestedNode], activePageId)
        : [];
      set({
        document,
        baseVersion: document.revision,
        activePageId,
        selectedIds,
        editorLoading: false,
        offline: false,
        saveState: "saved",
      });
      void updateContext({
        designId: document.id,
        ...(activePageId ? { pageId: activePageId } : {}),
        selectedNodeIds: selectedIds,
      }).catch(() => undefined);
    } catch (error) {
      set({
        document: null,
        activePageId: null,
        editorLoading: false,
        offline: true,
        saveState: "error",
        error: error instanceof Error ? error.message : "Could not open the design.",
      });
    }
  },

  closeDesign: () => set({
    document: null,
    baseVersion: 0,
    activePageId: null,
    selectedIds: [],
    pendingOperations: [],
    revisions: [],
    prototypeOpen: false,
    archiveReview: null,
    saving: false,
    saveState: "idle",
    error: null,
  }),

  setActivePage: (activePageId) => {
    set({ activePageId, selectedIds: [] });
    syncDeepLink(activePageId);
    const document = get().document;
    if (document) void updateContext({ designId: document.id, pageId: activePageId, selectedNodeIds: [] }).catch(() => undefined);
  },

  select: (ids, additive = false) => {
    const document = get().document;
    if (!document) return;
    const requested = additive ? [...get().selectedIds, ...ids] : ids;
    const activePageId = get().activePageId
      ?? document.pages.find((page) => !page.archived)?.id
      ?? null;
    const selectedIds = canonicalizeNodeSelection(document, requested, activePageId);
    set({ selectedIds });
    syncDeepLink(activePageId, selectedIds[0]);
    void updateContext({
      designId: document.id,
      ...(activePageId ? { pageId: activePageId } : {}),
      selectedNodeIds: selectedIds,
    }).catch(() => undefined);
  },

  setZoom: (zoom) => set({ zoom: clampCanvasZoom(zoom) }),
  setPan: (pan) => set({ pan }),
  setViewport: ({ pan, zoom }) => set({ pan, zoom: clampCanvasZoom(zoom) }),
  setTool: (tool) => set({ tool }),
  setInspectorTab: (inspectorTab) => set({ inspectorTab }),
  setNotice: (notice) => set({ notice }),
  setSidebarsHidden: (sidebarsHidden) => set({ sidebarsHidden }),

  setProductBrief: (brief) => set((state) => {
    if (!state.document) return state;
    const previous = structuredClone(state.document.metadata);
    return executeBatch(
      state,
      [{ type: "set_metadata", target: { kind: "document" }, metadata: { product_brief: brief }, mode: "merge" }],
      [{ type: "set_metadata", target: { kind: "document" }, metadata: previous, mode: "replace" }],
    );
  }),

  updateNode: (nodeId, patch) => get().updateNodes([{ nodeId, patch }]),

  updateNodes: (updates) => set((state) => {
    if (!state.document) return state;
    const applicable = updates.flatMap(({ nodeId, patch }) => {
      const node = state.document?.nodes[nodeId];
      return node ? [{ node, patch }] : [];
    });
    if (applicable.length === 0) return state;
    return executeBatch(
      state,
      applicable.map(({ node, patch }) => ({ type: "update_node", node_id: node.id, patch })),
      applicable.map(({ node, patch }) => ({ type: "update_node", node_id: node.id, patch: inversePatch(node, patch) })),
    );
  }),

  addNode: (type) => set((state) => {
    const document = state.document;
    const pageId = state.activePageId;
    if (!document || !pageId) return state;
    const parent = defaultParent(document, pageId, state.selectedIds);
    if (!parent) return { error: "Add a page or frame before inserting a layer." };
    const parentCount = "node_id" in parent ? nodeChildren(document.nodes[parent.node_id]!).length : document.pages.find((page) => page.id === parent.page_id)?.children.length ?? 0;
    const node = createNodeForEditor(type, parentCount);
    const operation: DesignOperation = { type: "create_tree", parent, root_ids: [node.id], nodes: [node] };
    return {
      ...executeBatch(state, [operation], [{ type: "archive_nodes", node_ids: [node.id] }], { redoable: false }),
      selectedIds: [node.id],
    };
  }),

  insertTemplate: (template) => set((state) => {
    const document = state.document;
    const pageId = state.activePageId;
    if (!document || !pageId) return state;
    const parent = defaultParent(document, pageId, state.selectedIds);
    if (!parent) return { error: "Add a page or frame before inserting a template." };
    const rootId = createNodeId();
    const operation: DesignOperation = {
      type: "insert_template",
      template,
      parent,
      overrides: {
        id: rootId,
        layout: { x: 72, y: 72 },
      },
    };
    return {
      ...executeBatch(state, [operation], [{ type: "archive_nodes", node_ids: [rootId] }], { redoable: false }),
      selectedIds: [rootId],
    };
  }),

  addPage: () => set((state) => {
    if (!state.document) return state;
    const pageId = createPageId();
    return {
      ...executeBatch(state, [{
        type: "create_page",
        page: {
          id: pageId,
          name: `Page ${state.document.pages.length + 1}`,
          background: "#e5e7eb",
          viewport: { width: 1600, height: 1000 },
          metadata: {},
        },
      }], [], { trackUndo: false }),
      activePageId: pageId,
      selectedIds: [],
    };
  }),

  addFrame: (preset) => set((state) => {
    const document = state.document;
    const page = document?.pages.find((candidate) => candidate.id === state.activePageId);
    if (!document || !page) return state;
    const size = DEVICE_PRESETS[preset];
    const rightEdge = page.children.reduce((max, id) => {
      const node = document.nodes[id];
      return node ? Math.max(max, node.layout.x + node.layout.width) : max;
    }, 0);
    const node = createNodeForEditor("frame");
    node.name = `${size.label} ${page.children.length + 1}`;
    node.layout = { ...node.layout, x: rightEdge + 120, y: 80, width: size.width, height: size.height };
    node.metadata = { ...node.metadata, preset };
    const operation: DesignOperation = {
      type: "create_tree",
      parent: { page_id: page.id },
      root_ids: [node.id],
      nodes: [node],
    };
    return {
      ...executeBatch(state, [operation], [{ type: "archive_nodes", node_ids: [node.id] }], { redoable: false }),
      selectedIds: [node.id],
    };
  }),

  duplicateSelection: () => set((state) => {
    const document = state.document;
    if (!document || state.selectedIds.length === 0) return state;
    const operations: DesignOperation[] = [];
    const inverseIds: NodeId[] = [];
    const selection: NodeId[] = [];
    const selected = new Set(state.selectedIds);
    const roots = state.selectedIds.filter((nodeId) => !getAncestors(document, nodeId).some((ancestor) => selected.has(ancestor.id)));
    for (const nodeId of roots) {
      const parent = parentOf(document, nodeId);
      if (!parent) continue;
      const clone = cloneSubtree(document, nodeId);
      operations.push({ type: "create_tree", parent, root_ids: [clone.rootId], nodes: clone.nodes });
      inverseIds.push(clone.rootId);
      selection.push(clone.rootId);
    }
    if (operations.length === 0) return state;
    return {
      ...executeBatch(state, operations, [{ type: "archive_nodes", node_ids: inverseIds }], { redoable: false }),
      selectedIds: selection,
    };
  }),

  deleteSelection: () => set((state) => {
    const document = state.document;
    if (!document || state.selectedIds.length === 0) return state;
    const selected = new Set(state.selectedIds);
    const roots = state.selectedIds.filter((id) => {
      const parent = parentOf(document, id);
      return !(parent && "node_id" in parent && selected.has(parent.node_id));
    });
    return {
      ...executeBatch(state, [{ type: "archive_nodes", node_ids: roots }], [], { trackUndo: false }),
      selectedIds: [],
      notice: "Deleted layers can be recovered from immutable history.",
    };
  }),

  approveArchiveReview: async () => {
    const current = get();
    const review = current.archiveReview;
    const designId = current.document?.id;
    if (!review || !designId || current.saving) return;
    set({ saving: true, saveState: "saving", error: null });
    try {
      const result = await commitArchivePreview(
        designId,
        review.previewId,
        review.baseVersion,
        createClientKey("archive"),
      );
      const committed = result.document ?? await readDesign(designId);
      set((latest) => {
        if (latest.document?.id !== designId) return { saving: false, archiveReview: null };
        let document = committed;
        if (latest.pendingOperations.length > 0) {
          document = applyOperations(committed, latest.pendingOperations, { expectedRevision: committed.revision }).document;
        }
        return {
          document,
          baseVersion: result.version,
          archiveReview: null,
          selectedIds: [],
          saving: false,
          saveState: latest.pendingOperations.length > 0 ? "dirty" : "saved",
          offline: false,
          error: null,
          notice: `Committed destructive preview for ${review.changedNodeIds.length} changed layer${review.changedNodeIds.length === 1 ? "" : "s"}.`,
        };
      });
    } catch (error) {
      if (error instanceof ApiError && error.code === "VERSION_CONFLICT") {
        set((latest) => ({
          archiveReview: null,
          pendingOperations: [...review.operations, ...latest.pendingOperations],
          saving: false,
          saveState: "conflict",
          offline: false,
          error: "The project changed before the destructive preview was committed. Reload the latest revision to review the deletion again.",
          notice: "Archive preview conflict: no automatic merge was performed.",
        }));
        return;
      }
      set({
        saving: false,
        saveState: "review",
        offline: error instanceof ApiError && error.code === "NETWORK_ERROR",
        error: error instanceof Error ? error.message : "The archive preview could not be committed.",
      });
    }
  },

  discardArchiveReview: () => set((state) => {
    const review = state.archiveReview;
    if (!review) return state;
    try {
      const document = state.pendingOperations.length > 0
        ? applyOperations(review.baseDocument, state.pendingOperations, { expectedRevision: review.baseDocument.revision }).document
        : review.baseDocument;
      return {
        document,
        archiveReview: null,
        selectedIds: [],
        saveState: state.pendingOperations.length > 0 ? "dirty" : "saved",
        notice: "Discarded the destructive preview. No revision was created.",
        error: null,
      };
    } catch {
      return {
        document: review.baseDocument,
        archiveReview: null,
        selectedIds: [],
        pendingOperations: [],
        saveState: "saved",
        notice: "Discarded the destructive preview and reloaded its base revision.",
        error: null,
      };
    }
  }),

  moveNodeByGesture: (nodeId, parent, index) => set((state) => {
    const document = state.document;
    const currentParent = document ? parentOf(document, nodeId) : undefined;
    if (!document || !currentParent) return state;
    const sameParent = "node_id" in currentParent && "node_id" in parent
      ? currentParent.node_id === parent.node_id
      : "page_id" in currentParent && "page_id" in parent && currentParent.page_id === parent.page_id;
    const currentSiblings = "node_id" in currentParent
      ? nodeChildren(document.nodes[currentParent.node_id]!)
      : document.pages.find((page) => page.id === currentParent.page_id)?.children ?? [];
    const destination = "node_id" in parent
      ? document.nodes[parent.node_id]
      : document.pages.find((page) => page.id === parent.page_id);
    const destinationChildren = destination && "children" in destination ? destination.children : undefined;
    const currentIndex = currentSiblings.indexOf(nodeId);
    const destinationLength = (destinationChildren?.length ?? 0) - (sameParent ? 1 : 0);
    if (currentIndex < 0 || !destinationChildren || index < 0 || index > destinationLength) {
      return { error: "The layer cannot be moved to that auto-layout position." };
    }
    if (sameParent && currentIndex === index) return state;
    return executeBatch(
      state,
      [{ type: "move_node", node_id: nodeId, parent, index }],
      [{ type: "move_node", node_id: nodeId, parent: currentParent, index: currentIndex }],
    );
  }),

  moveSelection: (direction) => set((state) => {
    const document = state.document;
    const nodeId = state.selectedIds.length === 1 ? state.selectedIds[0] : undefined;
    if (!document || !nodeId) return state;
    const entry = parentOf(document, nodeId);
    if (!entry) return state;
    const siblings = "node_id" in entry
      ? nodeChildren(document.nodes[entry.node_id]!)
      : document.pages.find((page) => page.id === entry.page_id)?.children ?? [];
    const from = siblings.indexOf(nodeId);
    const to = Math.max(0, Math.min(siblings.length - 1, from + direction));
    if (from === to) return state;
    return executeBatch(
      state,
      [{ type: "move_node", node_id: nodeId, parent: entry, index: to }],
      [{ type: "move_node", node_id: nodeId, parent: entry, index: from }],
    );
  }),

  reparentSelection: (parent) => set((state) => {
    const document = state.document;
    const nodeId = state.selectedIds.length === 1 ? state.selectedIds[0] : undefined;
    if (!document || !nodeId) return state;
    const currentParent = parentOf(document, nodeId);
    if (!currentParent || JSON.stringify(currentParent) === JSON.stringify(parent)) return state;
    const currentSiblings = "node_id" in currentParent
      ? nodeChildren(document.nodes[currentParent.node_id]!)
      : document.pages.find((page) => page.id === currentParent.page_id)?.children ?? [];
    const destination = "node_id" in parent
      ? document.nodes[parent.node_id]
      : document.pages.find((page) => page.id === parent.page_id);
    const destinationChildren = destination && "children" in destination ? destination.children : [];
    const currentIndex = currentSiblings.indexOf(nodeId);
    try {
      return executeBatch(
        state,
        [{ type: "move_node", node_id: nodeId, parent, index: destinationChildren.length }],
        [{ type: "move_node", node_id: nodeId, parent: currentParent, index: currentIndex }],
      );
    } catch (error) {
      return { error: error instanceof Error ? error.message : "The layer cannot be moved to that parent." };
    }
  }),

  setNodePrototype: (nodeId, targetPageId, targetNodeId) => set((state) => {
    if (!state.document?.nodes[nodeId]) return state;
    const previous = linksForNode(state.document, nodeId).find((link) => link.trigger.type === "click");
    const link = {
      id: previous?.id ?? createPrototypeLinkId(),
      source_node_id: nodeId,
      trigger: { type: "click" as const },
      action: { type: "navigate" as const, page_id: targetPageId, ...(targetNodeId ? { node_id: targetNodeId } : {}) },
      transition: { type: "dissolve" as const, duration_ms: 180, easing: "ease-out" as const },
      metadata: previous?.metadata ?? {},
    };
    return executeBatch(
      state,
      [{ type: "set_prototype_link", link }],
      previous ? [{ type: "set_prototype_link", link: previous }] : [],
      { trackUndo: Boolean(previous) },
    );
  }),

  upsertToken: (token) => set((state) => {
    const previous = state.document?.tokens[token.id];
    if (!state.document) return state;
    const inverseToken = previous ?? { ...token, archived: true };
    return executeBatch(
      state,
      [{ type: "upsert_token", token }],
      [{ type: "upsert_token", token: inverseToken }],
    );
  }),

  deleteToken: (tokenId) => set((state) => {
    const token = state.document?.tokens[tokenId];
    if (!state.document || !token) return state;
    return executeBatch(
      state,
      [{ type: "upsert_token", token: { ...token, archived: true } }],
      [{ type: "upsert_token", token }],
    );
  }),

  uploadImage: async (nodeId, file) => {
    const document = get().document;
    const node = document?.nodes[nodeId];
    if (!document || !node || node.type !== "image") return;
    set({ notice: "Uploading image asset…", error: null });
    try {
      const uploaded = await uploadAsset(file, document.id);
      if (uploaded.operation.type !== "upsert_asset") throw new Error("The server returned an invalid asset operation.");
      const update: DesignOperation = {
        type: "update_node",
        node_id: node.id,
        patch: { asset_id: uploaded.operation.asset.id, alt: file.name },
      };
      set((state) => ({
        ...executeBatch(state, [uploaded.operation, update], [], { trackUndo: false }),
        notice: "Image uploaded. The asset will be included in the next revision.",
      }));
    } catch (error) {
      set({ error: error instanceof Error ? error.message : "Image upload failed.", notice: "Image upload failed." });
    }
  },

  undo: () => set((state) => {
    const batch = state.undoStack.at(-1);
    if (!batch || !state.document) return state;
    try {
      return {
        document: applyOptimistic(state.document, batch.inverse, false),
        pendingOperations: [...state.pendingOperations, ...batch.inverse],
        undoStack: state.undoStack.slice(0, -1),
        redoStack: batch.redoable ? [...state.redoStack, batch] : state.redoStack,
        saveState: "dirty",
        selectedIds: state.selectedIds.filter((id) => !batch.operations.some((operation) => operation.type === "create_tree" && operation.root_ids.includes(id))),
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "This change cannot be undone." };
    }
  }),

  redo: () => set((state) => {
    const batch = state.redoStack.at(-1);
    if (!batch || !state.document) return state;
    try {
      return {
        document: applyOptimistic(state.document, batch.operations, false),
        pendingOperations: [...state.pendingOperations, ...batch.operations],
        undoStack: [...state.undoStack, batch],
        redoStack: state.redoStack.slice(0, -1),
        saveState: "dirty",
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "This change cannot be redone." };
    }
  }),

  save: () => {
    if (activeSavePromise) return activeSavePromise;
    const state = get();
    if (state.archiveReview) {
      set({ notice: "Commit or discard the destructive preview before saving more changes." });
      return Promise.resolve();
    }
    if (!state.document || state.saveState === "conflict" || state.pendingOperations.length === 0) return Promise.resolve();
    const designId = state.document.id;
    const baseVersion = state.baseVersion;
    const operations = state.pendingOperations;
    const destructive = operations.some((operation) => operation.type === "archive_nodes");
    set({ saving: true, saveState: "saving", pendingOperations: [] });

    const run = async () => {
      try {
        if (destructive) {
          const [preview, baseDocument] = await Promise.all([
            createArchivePreview(designId, baseVersion, operations),
            readDesign(designId, baseVersion),
          ]);
          if (!preview.canCommit) throw new ApiError("The destructive preview contains validation errors.", { code: "PREVIEW_NOT_COMMITTABLE", status: 422 });
          set((latest) => latest.document?.id !== designId ? { saving: false } : {
            archiveReview: {
              previewId: preview.previewId,
              baseVersion,
              changedNodeIds: preview.changedNodeIds,
              operations,
              baseDocument,
              previewDocument: preview.document,
            },
            saving: false,
            saveState: "review",
            offline: false,
            error: null,
            notice: "Destructive changes are ready for before/after review.",
          });
          return;
        }
        const result = await commitRevision(designId, baseVersion, operations, createClientKey("revision"));
        const serverDocument = result.document ?? await readDesign(designId);
        set((latest) => {
          if (latest.document?.id !== designId) return { saving: false };
          let document = serverDocument;
          if (latest.pendingOperations.length > 0) {
            document = applyOperations(serverDocument, latest.pendingOperations, { expectedRevision: serverDocument.revision }).document;
          }
          return {
            document,
            baseVersion: result.version,
            saving: false,
            saveState: latest.pendingOperations.length ? "dirty" : "saved",
            offline: false,
            error: null,
          };
        });
      } catch (error) {
        if (error instanceof ApiError && error.code === "VERSION_CONFLICT") {
          set((latest) => latest.document?.id !== designId ? { saving: false } : {
              pendingOperations: [...operations, ...latest.pendingOperations],
              saving: false,
              saveState: "conflict",
              offline: false,
              error: "The design changed on the server. Reload the latest revision to review it; your local draft has not been committed.",
              notice: "Version conflict: no automatic merge was performed.",
            });
          return;
        }
        set((latest) => latest.document?.id !== designId ? { saving: false } : {
            pendingOperations: [...operations, ...latest.pendingOperations],
            saving: false,
            saveState: "error",
            offline: true,
            error: error instanceof Error ? error.message : "Saving failed.",
          });
      }
    };

    activeSavePromise = run().finally(() => {
      activeSavePromise = null;
    });
    return activeSavePromise;
  },

  reloadConflict: async () => {
    const current = get();
    if (!current.document || current.saveState !== "conflict") return;
    set({ editorLoading: true });
    try {
      const fresh = await readDesign(current.document.id);
      const activePageId = fresh.pages.some((page) => page.id === current.activePageId && !page.archived)
        ? current.activePageId
        : fresh.pages.find((page) => !page.archived)?.id ?? null;
      const selectedIds = canonicalizeNodeSelection(fresh, current.selectedIds, activePageId);
      set({
        document: fresh,
        baseVersion: fresh.revision,
        activePageId,
        selectedIds,
        pendingOperations: [],
        undoStack: [],
        redoStack: [],
        saving: false,
        editorLoading: false,
        saveState: "saved",
        offline: false,
        error: null,
        notice: "Loaded the latest server revision. The conflicting local draft was discarded.",
      });
      syncDeepLink(activePageId, selectedIds[0]);
    } catch (error) {
      set({
        editorLoading: false,
        saveState: "conflict",
        error: error instanceof Error ? error.message : "Could not load the latest revision.",
      });
    }
  },

  loadHistory: async () => {
    const id = get().document?.id;
    if (!id) return;
    set({ historyLoading: true });
    try {
      set({ revisions: await listHistory(id), historyLoading: false });
    } catch (error) {
      set({ historyLoading: false, error: error instanceof Error ? error.message : "Could not load history." });
    }
  },

  restoreRevision: async (version) => {
    const document = get().document;
    if (!document || get().pendingOperations.length > 0) {
      set({ notice: "Save or undo current edits before restoring history." });
      return;
    }
    set({ saving: true, saveState: "saving" });
    try {
      const result = await restoreRemoteRevision(document.id, version, get().baseVersion, createClientKey("restore"));
      const restored = result.document ?? await readDesign(document.id);
      set({
        document: restored,
        baseVersion: result.version,
        activePageId: restored.pages.find((page) => !page.archived)?.id ?? null,
        selectedIds: [],
        pendingOperations: [],
        undoStack: [],
        redoStack: [],
        saving: false,
        saveState: "saved",
        notice: `Restored version ${version} as a new immutable revision.`,
      });
      void get().loadHistory();
    } catch (error) {
      set({ saving: false, saveState: "error", error: error instanceof Error ? error.message : "Restore failed." });
    }
  },

  openPrototype: () => set((state) => ({
    prototypeOpen: true,
    prototypePageId: state.activePageId ?? state.document?.pages.find((page) => !page.archived)?.id ?? null,
  })),
  closePrototype: () => set({ prototypeOpen: false }),
  goToPrototypePage: (prototypePageId) => set({ prototypePageId }),

  connectEvents: () => subscribeToEvents((event) => {
    const state = get();
    if (event.type !== "design.updated" || !event.designId || event.designId !== state.document?.id || !event.version) return;
    if (event.version <= state.baseVersion || state.pendingOperations.length > 0 || state.saving) return;
    const updatedDesignId: string = event.designId;
    void readDesign(updatedDesignId).then((document) => {
      const latest = get();
      const activePageId = document.pages.some((page) => page.id === latest.activePageId && !page.archived)
        ? latest.activePageId
        : document.pages.find((page) => !page.archived)?.id ?? null;
      const selectedIds = canonicalizeNodeSelection(document, latest.selectedIds, activePageId);
      set({
        document,
        baseVersion: document.revision,
        activePageId,
        selectedIds,
        undoStack: [],
        redoStack: [],
        notice: "The canvas was refreshed with a new Codex revision.",
      });
      syncDeepLink(activePageId, selectedIds[0]);
      void updateContext({
        designId: document.id,
        ...(activePageId ? { pageId: activePageId } : {}),
        selectedNodeIds: selectedIds,
      }).catch(() => undefined);
    }).catch(() => undefined);
  }),
}));

export function activePage(document: DesignDocument | null, pageId: PageId | null) {
  return document?.pages.find((page) => page.id === pageId) ?? document?.pages.find((page) => !page.archived) ?? null;
}

export function createTokenDraft(kind: DesignToken["kind"] = "color"): DesignToken {
  const id = createTokenId();
  const isTypography = kind === "font_family" || kind === "font_weight";
  return {
    id,
    name: kind === "color" ? "New color" : isTypography ? "New type token" : "New token",
    path: kind === "color"
      ? `color.custom_${id.slice(-5)}`
      : isTypography
        ? `type.custom_${id.slice(-5)}`
        : `space.custom_${id.slice(-5)}`,
    kind,
    value: kind === "color" ? "#8172ff" : kind === "font_family" ? "Vazirmatn" : kind === "font_weight" ? 600 : 16,
    archived: false,
    metadata: {},
  };
}

export function pageForSelectedNode(document: DesignDocument, nodeId: NodeId): PageId | undefined {
  return pageIdForNode(document, nodeId);
}
