import {
  ResponsiveFrameGroupIdSchema,
  findNodeParent,
  type DesignDocument,
  type FrameNode,
  type NodeId,
  type PageId,
  type UpdateNodePatch,
} from "@designer/core";

export interface ResponsiveVariantUpdate {
  nodeId: NodeId;
  patch: UpdateNodePatch;
}

export type ResponsiveVariantPlan = {
  ok: true;
  groupId: string;
  orderedFrameIds: NodeId[];
  updates: ResponsiveVariantUpdate[];
} | {
  ok: false;
  message: string;
};

function pageIdForNode(document: DesignDocument, nodeId: NodeId): PageId | undefined {
  let currentId = nodeId;
  const seen = new Set<NodeId>();
  while (!seen.has(currentId)) {
    seen.add(currentId);
    const entry = findNodeParent(document, currentId);
    if (!entry) return undefined;
    if ("page_id" in entry.parent) return entry.parent.page_id;
    currentId = entry.parent.node_id;
  }
  return undefined;
}

function selectedFrames(document: DesignDocument, frameIds: readonly NodeId[]): FrameNode[] {
  const unique = [...new Set(frameIds)];
  return unique.flatMap((id) => {
    const node = document.nodes[id];
    return node?.type === "frame" && !node.archived ? [node] : [];
  });
}

function calculatedBreakpoints(frames: readonly FrameNode[]): Array<{ min_width: number; max_width?: number }> | null {
  const minimums = [0];
  for (let index = 1; index < frames.length; index += 1) {
    const previousMinimum = minimums[index - 1]!;
    const midpoint = Math.round((frames[index - 1]!.layout.width + frames[index]!.layout.width) / 2);
    const minimum = Math.min(100_000, Math.max(previousMinimum + 1, midpoint));
    if (minimum <= previousMinimum) return null;
    minimums.push(minimum);
  }
  return minimums.map((min_width, index) => (
    index + 1 < minimums.length ? { min_width, max_width: minimums[index + 1]! } : { min_width }
  ));
}

function buildPlan(
  document: DesignDocument,
  frameIds: readonly NodeId[],
  groupId: string,
  mode: "create" | "recalculate",
): ResponsiveVariantPlan {
  if (!ResponsiveFrameGroupIdSchema.safeParse(groupId).success) {
    return { ok: false, message: "The responsive group identity is invalid." };
  }
  const frames = selectedFrames(document, frameIds);
  if (frames.length !== new Set(frameIds).size || frames.length < 2) {
    return { ok: false, message: "Select at least two active frames to create responsive variants." };
  }
  const pages = new Set(frames.map((frame) => pageIdForNode(document, frame.id)));
  if (pages.size !== 1 || pages.has(undefined)) {
    return { ok: false, message: "Responsive variants must belong to the same active page." };
  }
  if (mode === "create" && frames.some((frame) => frame.responsive_variant !== undefined)) {
    return { ok: false, message: "Unlink existing responsive groups before creating a new relationship." };
  }
  if (mode === "recalculate" && frames.some((frame) => frame.responsive_variant?.group_id !== groupId)) {
    return { ok: false, message: "The responsive group changed; select its current variants and try again." };
  }
  const orderedFrames = [...frames].sort((left, right) => (
    left.layout.width - right.layout.width
      || left.name.localeCompare(right.name)
      || left.id.localeCompare(right.id)
  ));
  const breakpoints = calculatedBreakpoints(orderedFrames);
  if (!breakpoints) {
    return { ok: false, message: "Frame widths cannot produce bounded responsive breakpoints." };
  }
  const orderedFrameIds = orderedFrames.map((frame) => frame.id);
  return {
    ok: true,
    groupId,
    orderedFrameIds,
    updates: orderedFrames.map((frame, index) => ({
      nodeId: frame.id,
      patch: {
        responsive_variant: {
          group_id: groupId,
          frame_ids: [...orderedFrameIds],
          breakpoint: breakpoints[index]!,
        },
      },
    })),
  };
}

export function createResponsiveVariantPlan(
  document: DesignDocument,
  frameIds: readonly NodeId[],
  groupId: string,
): ResponsiveVariantPlan {
  return buildPlan(document, frameIds, groupId, "create");
}

export function recalculateResponsiveVariantPlan(
  document: DesignDocument,
  frameIds: readonly NodeId[],
  groupId: string,
): ResponsiveVariantPlan {
  return buildPlan(document, frameIds, groupId, "recalculate");
}

export function unlinkResponsiveVariantUpdates(
  document: DesignDocument,
  groupId: string,
): ResponsiveVariantUpdate[] {
  return Object.values(document.nodes).flatMap((node) => (
    node.type === "frame" && !node.archived && node.responsive_variant?.group_id === groupId
      ? [{ nodeId: node.id, patch: { responsive_variant: null } }]
      : []
  ));
}
