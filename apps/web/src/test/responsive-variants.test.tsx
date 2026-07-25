import {
  applyOperations,
  createFrameNode,
  createStarterDocument,
  validateDesignDocument,
} from "@designer/core";
import { beforeEach, describe, expect, it } from "vitest";

import {
  createResponsiveVariantPlan,
  recalculateResponsiveVariantPlan,
  unlinkResponsiveVariantUpdates,
} from "../lib/responsive-variants";
import { useDesignerStore } from "../store/designer-store";

function responsiveFixture() {
  const document = createStarterDocument({ preset: "web", name: "Responsive checkout" });
  const page = document.pages[0]!;
  const desktop = document.nodes[page.children[0]!]!;
  if (desktop.type !== "frame") throw new Error("Expected starter desktop frame");
  desktop.name = "Checkout desktop";
  const phone = createFrameNode({ name: "Checkout phone", layout: { ...desktop.layout, width: 390, height: 844, x: 0, y: 0 } });
  const tablet = createFrameNode({ name: "Checkout tablet", layout: { ...desktop.layout, width: 834, height: 1194, x: 430, y: 0 } });
  desktop.layout.x = 1300;
  page.children.push(phone.id, tablet.id);
  document.nodes[phone.id] = phone;
  document.nodes[tablet.id] = tablet;
  return { document, page, desktop, phone, tablet };
}

describe("responsive frame variants", () => {
  beforeEach(() => {
    const { document, page, desktop, phone, tablet } = responsiveFixture();
    useDesignerStore.setState({
      document,
      baseVersion: document.revision,
      activePageId: page.id,
      selectedIds: [desktop.id, phone.id, tablet.id],
      inspectorTab: "design",
      pendingOperations: [],
      undoStack: [],
      redoStack: [],
      saveState: "saved",
      saving: false,
      notice: null,
    });
  });

  it("orders selected frames by width and assigns reciprocal non-overlapping ranges", () => {
    const state = useDesignerStore.getState();
    const plan = createResponsiveVariantPlan(state.document!, state.selectedIds, "responsive_checkout_0001");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.orderedFrameIds.map((id) => state.document!.nodes[id]!.name)).toEqual([
      "Checkout phone",
      "Checkout tablet",
      "Checkout desktop",
    ]);
    expect(plan.updates.map((update) => update.patch.responsive_variant?.breakpoint)).toEqual([
      { min_width: 0, max_width: 612 },
      { min_width: 612, max_width: 1137 },
      { min_width: 1137 },
    ]);
    const result = applyOperations(state.document!, plan.updates.map((update) => ({
      type: "update_node" as const,
      node_id: update.nodeId,
      patch: update.patch,
    }))).document;
    expect(validateDesignDocument(result).success).toBe(true);
    for (const frameId of plan.orderedFrameIds) {
      const frame = result.nodes[frameId];
      expect(frame?.type === "frame" ? frame.responsive_variant?.frame_ids : undefined).toEqual(plan.orderedFrameIds);
    }
  });

  it("queues one reciprocal editor transaction for every selected frame", () => {
    const state = useDesignerStore.getState();
    const plan = createResponsiveVariantPlan(state.document!, state.selectedIds, "responsive_checkout_0002");
    if (!plan.ok) throw new Error(plan.message);
    state.updateNodes(plan.updates);
    const updated = useDesignerStore.getState();
    expect(updated.pendingOperations).toHaveLength(3);
    expect(updated.pendingOperations.every((operation) => (
      operation.type === "update_node" && operation.patch.responsive_variant?.group_id === plan.groupId
    ))).toBe(true);
    expect(plan.orderedFrameIds.every((id) => {
      const node = updated.document?.nodes[id];
      return node?.type === "frame" && node.responsive_variant?.frame_ids.join(",") === plan.orderedFrameIds.join(",");
    })).toBe(true);
    updated.undo();
    expect(plan.orderedFrameIds.every((id) => {
      const node = useDesignerStore.getState().document?.nodes[id];
      return node?.type === "frame" && node.responsive_variant === undefined;
    })).toBe(true);
    useDesignerStore.getState().redo();
    expect(plan.orderedFrameIds.every((id) => {
      const node = useDesignerStore.getState().document?.nodes[id];
      return node?.type === "frame" && node.responsive_variant?.group_id === plan.groupId;
    })).toBe(true);
  });

  it("recalculates after resizing and unlinks every reciprocal member", () => {
    const state = useDesignerStore.getState();
    const created = createResponsiveVariantPlan(state.document!, state.selectedIds, "responsive_checkout_0003");
    if (!created.ok) throw new Error(created.message);
    let document = applyOperations(state.document!, created.updates.map((update) => ({ type: "update_node" as const, node_id: update.nodeId, patch: update.patch }))).document;
    const tabletId = created.orderedFrameIds[1]!;
    document = applyOperations(document, [{ type: "update_node", node_id: tabletId, patch: { layout: { width: 900 } } }]).document;
    const recalculated = recalculateResponsiveVariantPlan(document, created.orderedFrameIds, created.groupId);
    expect(recalculated.ok).toBe(true);
    if (!recalculated.ok) return;
    expect(recalculated.updates[0]!.patch.responsive_variant?.breakpoint.max_width).toBe(645);
    const unlinked = applyOperations(document, unlinkResponsiveVariantUpdates(document, created.groupId).map((update) => ({
      type: "update_node" as const,
      node_id: update.nodeId,
      patch: update.patch,
    }))).document;
    expect(created.orderedFrameIds.every((id) => {
      const node = unlinked.nodes[id];
      return node?.type === "frame" && node.responsive_variant === undefined;
    })).toBe(true);
  });
});
