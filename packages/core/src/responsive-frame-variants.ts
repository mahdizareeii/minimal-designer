import type { NodeId } from "./ids.js";
import type { ResponsiveFrameVariant } from "./model.js";

export type ResponsiveFrameVariantIssueCode =
  | "responsive_frame_page_required"
  | "responsive_frame_owner_missing"
  | "responsive_frame_target_unavailable"
  | "responsive_frame_page_mismatch"
  | "responsive_frame_reciprocity_mismatch"
  | "responsive_frame_membership_mismatch"
  | "responsive_breakpoint_open_ended"
  | "responsive_breakpoint_overlap";

export interface ResponsiveFrameVariantIssue {
  code: ResponsiveFrameVariantIssueCode;
  message: string;
  path: Array<string | number>;
  entity_id?: NodeId;
}

interface ResponsiveVariantNode {
  id: NodeId;
  type: string;
  archived: boolean;
  children?: NodeId[] | undefined;
  responsive_variant?: ResponsiveFrameVariant | undefined;
}

interface ResponsiveVariantPage {
  id: string;
  archived: boolean;
  children: NodeId[];
}

export interface ResponsiveFrameVariantDocument {
  pages: ResponsiveVariantPage[];
  nodes: Record<string, ResponsiveVariantNode>;
}

type ResponsiveFrame = ResponsiveVariantNode & {
  type: "frame";
  responsive_variant: ResponsiveFrameVariant;
};

function isResponsiveFrame(node: ResponsiveVariantNode | undefined): node is ResponsiveFrame {
  return node?.type === "frame" && !node.archived && node.responsive_variant !== undefined;
}

function sameOrderedIds(left: readonly NodeId[], right: readonly NodeId[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/**
 * Resolve each reachable node to exactly one active page. A null value means
 * corrupt graph references place the same node on multiple active pages.
 */
function activePageByNode(document: ResponsiveFrameVariantDocument): Map<NodeId, string | null> {
  const result = new Map<NodeId, string | null>();
  const assign = (nodeId: NodeId, pageId: string, path: ReadonlySet<NodeId>): void => {
    if (path.has(nodeId)) return;
    const node = document.nodes[nodeId];
    if (!node) return;
    const existing = result.get(nodeId);
    if (existing !== undefined && existing !== pageId) result.set(nodeId, null);
    else if (existing === undefined) result.set(nodeId, pageId);
    if (!node.children) return;
    const nextPath = new Set(path).add(nodeId);
    for (const childId of node.children) assign(childId, pageId, nextPath);
  };

  for (const page of document.pages) {
    if (page.archived) continue;
    for (const rootId of page.children) assign(rootId, page.id, new Set());
  }
  return result;
}

/**
 * Validate the document-level contract for linked responsive frames. Breakpoint
 * ranges are half-open (`min_width <= width < max_width`), so adjacent ranges
 * may share a boundary while overlaps are rejected. Gaps are allowed.
 */
export function validateResponsiveFrameVariants(
  document: ResponsiveFrameVariantDocument,
): ResponsiveFrameVariantIssue[] {
  const issues: ResponsiveFrameVariantIssue[] = [];
  const pageByNode = activePageByNode(document);
  const frames = Object.values(document.nodes)
    .filter(isResponsiveFrame)
    .sort((left, right) => left.id.localeCompare(right.id));
  const groups = new Map<string, ResponsiveFrame[]>();

  for (const frame of frames) {
    const relationship = frame.responsive_variant;
    const members = groups.get(relationship.group_id) ?? [];
    members.push(frame);
    groups.set(relationship.group_id, members);

    const ownerPageId = pageByNode.get(frame.id);
    if (ownerPageId === undefined || ownerPageId === null) {
      issues.push({
        code: "responsive_frame_page_required",
        message: "Responsive frame variants must belong to exactly one active page",
        path: ["nodes", frame.id, "responsive_variant"],
        entity_id: frame.id,
      });
    }
    if (!relationship.frame_ids.includes(frame.id)) {
      issues.push({
        code: "responsive_frame_owner_missing",
        message: "Responsive frame group must include the owning frame",
        path: ["nodes", frame.id, "responsive_variant", "frame_ids"],
        entity_id: frame.id,
      });
    }

    for (const linkedFrameId of relationship.frame_ids) {
      const linkedFrame = document.nodes[linkedFrameId];
      if (!linkedFrame || linkedFrame.type !== "frame" || linkedFrame.archived) {
        issues.push({
          code: "responsive_frame_target_unavailable",
          message: `Responsive frame ${linkedFrameId} is missing, archived, or not a frame`,
          path: ["nodes", frame.id, "responsive_variant", "frame_ids"],
          entity_id: frame.id,
        });
        continue;
      }
      const linkedPageId = pageByNode.get(linkedFrameId);
      if (ownerPageId !== undefined && ownerPageId !== null && linkedPageId !== ownerPageId) {
        issues.push({
          code: "responsive_frame_page_mismatch",
          message: "Responsive frame variants must belong to the same active page",
          path: ["nodes", frame.id, "responsive_variant", "frame_ids"],
          entity_id: frame.id,
        });
      }
      const linkedRelationship = linkedFrame.responsive_variant;
      if (
        linkedRelationship?.group_id !== relationship.group_id
        || linkedRelationship === undefined
        || !sameOrderedIds(linkedRelationship.frame_ids, relationship.frame_ids)
      ) {
        issues.push({
          code: "responsive_frame_reciprocity_mismatch",
          message: "Every responsive frame must declare the same group and ordered frame list",
          path: ["nodes", frame.id, "responsive_variant", "frame_ids"],
          entity_id: frame.id,
        });
      }
    }
  }

  for (const [groupId, groupFrames] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const canonical = groupFrames[0];
    if (!canonical) continue;
    const orderedIds = canonical.responsive_variant.frame_ids;
    const actualIds = new Set(groupFrames.map((frame) => frame.id));
    if (orderedIds.length !== actualIds.size || orderedIds.some((id) => !actualIds.has(id))) {
      issues.push({
        code: "responsive_frame_membership_mismatch",
        message: `Responsive group ${groupId} must link every active group member exactly once`,
        path: ["nodes", canonical.id, "responsive_variant", "frame_ids"],
        entity_id: canonical.id,
      });
    }

    let previous: ResponsiveFrame | undefined;
    for (const frameId of orderedIds) {
      const frame = document.nodes[frameId];
      if (!isResponsiveFrame(frame) || frame.responsive_variant.group_id !== groupId) continue;
      if (previous) {
        const previousMaximum = previous.responsive_variant.breakpoint.max_width;
        const currentMinimum = frame.responsive_variant.breakpoint.min_width;
        if (previousMaximum === undefined) {
          issues.push({
            code: "responsive_breakpoint_open_ended",
            message: "Only the final responsive frame may have an open-ended breakpoint",
            path: ["nodes", previous.id, "responsive_variant", "breakpoint", "max_width"],
            entity_id: previous.id,
          });
        } else if (previousMaximum > currentMinimum) {
          issues.push({
            code: "responsive_breakpoint_overlap",
            message: "Responsive breakpoints must follow frame order without overlap",
            path: ["nodes", frame.id, "responsive_variant", "breakpoint", "min_width"],
            entity_id: frame.id,
          });
        }
      }
      previous = frame;
    }
  }

  return issues;
}

/**
 * Keep surviving active groups valid after a soft archive while leaving the
 * archived frame records intact for history and export. The original group
 * order is preserved exactly; node record insertion order is irrelevant.
 */
export function reconcileResponsiveFrameVariantsAfterArchive(
  document: ResponsiveFrameVariantDocument,
  archivedNodeIds: ReadonlySet<NodeId>,
): void {
  const affectedGroupIds = new Set<string>();
  for (const node of Object.values(document.nodes)) {
    if (node.type !== "frame" || node.responsive_variant === undefined) continue;
    if (archivedNodeIds.has(node.id) || node.responsive_variant.frame_ids.some((id) => archivedNodeIds.has(id))) {
      affectedGroupIds.add(node.responsive_variant.group_id);
    }
  }

  for (const groupId of [...affectedGroupIds].sort()) {
    const allGroupFrames = Object.values(document.nodes)
      .filter((node): node is ResponsiveFrame => (
        node.type === "frame" && node.responsive_variant?.group_id === groupId
      ))
      .sort((left, right) => left.id.localeCompare(right.id));
    const activeFrames = allGroupFrames.filter((frame) => !frame.archived);
    if (activeFrames.length < 2) {
      for (const frame of activeFrames) {
        const mutableFrame: ResponsiveVariantNode = frame;
        delete mutableFrame.responsive_variant;
      }
      continue;
    }

    const activeIds = new Set(activeFrames.map((frame) => frame.id));
    const orderedIds = (activeFrames[0]?.responsive_variant.frame_ids ?? [])
      .filter((id) => activeIds.has(id));
    for (const frame of activeFrames) {
      if (!orderedIds.includes(frame.id)) orderedIds.push(frame.id);
    }
    for (const frame of activeFrames) frame.responsive_variant.frame_ids = [...orderedIds];
  }
}
