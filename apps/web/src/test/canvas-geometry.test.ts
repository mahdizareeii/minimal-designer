import {
  createFrameNode,
  createGroupNode,
  createRectangleNode,
  createStarterDocument,
} from "@designer/core";
import { describe, expect, it } from "vitest";

import {
  autoLayoutDropContainers,
  autoLayoutInsertionIndex,
  canonicalizeNodeSelection,
  chooseAutoLayoutDropContainer,
  composeDraftTransform,
  normalizeGeometryNumber,
  resizePatchForGesture,
  selectionGestureCapabilities,
  selectionUsesAbsoluteLayout,
  unionClientRects,
} from "../lib/canvas-geometry";
import {
  clientPointInViewport,
  MAX_CANVAS_ZOOM,
  MIN_CANVAS_ZOOM,
  ViewportTransform,
} from "../lib/viewport-transform";

describe("ViewportTransform", () => {
  it("round-trips world and viewport coordinates at fractional zoom", () => {
    const transform = new ViewportTransform({ pan: { x: -110.25, y: 3.875 }, zoom: 1.49 });
    const world = { x: 317.125, y: 204.75 };
    const viewport = transform.worldToViewport(world);

    expect(viewport).toEqual({
      x: world.x * 1.49 - 110.25,
      y: world.y * 1.49 + 3.875,
    });
    expect(transform.viewportToWorld(viewport).x).toBeCloseTo(world.x, 10);
    expect(transform.viewportToWorld(viewport).y).toBeCloseTo(world.y, 10);
    expect(transform.viewportDeltaToWorld(transform.worldDeltaToViewport({ x: 7.25, y: -3.5 }))).toEqual({
      x: 7.25,
      y: -3.5,
    });
  });

  it("keeps the world point under the cursor fixed while zooming", () => {
    const transform = new ViewportTransform({ pan: { x: 70, y: 143.875 }, zoom: 1.49 });
    const cursor = { x: 684.5, y: 421.25 };
    const worldBefore = transform.viewportToWorld(cursor);
    const zoomed = transform.withZoomAt(cursor, 2.125);

    expect(zoomed.worldToViewport(worldBefore).x).toBeCloseTo(cursor.x, 10);
    expect(zoomed.worldToViewport(worldBefore).y).toBeCloseTo(cursor.y, 10);
    expect(transform.withZoomAt(cursor, 100).zoom).toBe(MAX_CANVAS_ZOOM);
    expect(transform.withZoomAt(cursor, 0.001).zoom).toBe(MIN_CANVAS_ZOOM);
  });

  it("uses an explicit translate3d + scale layer transform", () => {
    const transform = new ViewportTransform({ pan: { x: 12.5, y: -8.25 }, zoom: 0.875 });
    expect(transform.toCssTransform()).toBe("translate3d(12.5px, -8.25px, 0) scale(0.875)");
    expect(clientPointInViewport({ x: 250, y: 180 }, { left: 40, top: 25 })).toEqual({ x: 210, y: 155 });
  });
});

describe("canvas gesture geometry", () => {
  it("keeps fractional geometry and composes draft translation before rotation", () => {
    expect(normalizeGeometryNumber(12.345678)).toBe(12.3457);
    expect(normalizeGeometryNumber(-0)).toBe(0);
    expect(composeDraftTransform(27.5, [4.12556, -8.87554])).toBe(
      "translate3d(4.1256px, -8.8755px, 0) rotate(27.5deg)",
    );
    expect(composeDraftTransform(27.5)).toBe("rotate(27.5deg)");
  });

  it("retains exact fractional client bounds for multi-selection overlays", () => {
    expect(unionClientRects([
      { left: 410.3747253417969, top: 659.625, right: 651.8747253417969, bottom: 780.625 },
      { left: 831.124755859375, top: 780.375, right: 1111.499755859375, bottom: 901.25 },
    ])).toEqual({
      left: 410.3747253417969,
      top: 659.625,
      right: 1111.499755859375,
      bottom: 901.25,
      width: 701.1250305175781,
      height: 241.625,
    });
    expect(unionClientRects([])).toBeNull();
    expect(() => unionClientRects([{ left: 0, top: 0, right: Number.NaN, bottom: 1 }])).toThrow(
      "Selection bounds must be finite.",
    );
  });
});

describe("canonical canvas selection", () => {
  it("keeps only effective visible, unlocked selection roots", () => {
    const document = createStarterDocument({ preset: "phone" });
    const page = document.pages[0]!;
    const frame = document.nodes[page.children[0]!]!;
    if (frame.type !== "frame") throw new Error("Expected starter frame");
    const rectangle = createRectangleNode({ name: "Child" });
    const group = createGroupNode({ name: "Parent", children: [rectangle.id] });
    frame.children.push(group.id);
    document.nodes[group.id] = group;
    document.nodes[rectangle.id] = rectangle;

    expect(canonicalizeNodeSelection(document, [rectangle.id, group.id], page.id)).toEqual([group.id]);
    expect(canonicalizeNodeSelection(document, [rectangle.id, rectangle.id], page.id)).toEqual([rectangle.id]);
    expect(selectionUsesAbsoluteLayout(document, [rectangle.id])).toBe(true);

    group.layout.mode = "vertical";
    expect(selectionUsesAbsoluteLayout(document, [rectangle.id])).toBe(false);
    group.layout.mode = "absolute";

    group.locked = true;
    expect(canonicalizeNodeSelection(document, [rectangle.id], page.id)).toEqual([]);
    group.locked = false;
    group.visible = false;
    expect(canonicalizeNodeSelection(document, [rectangle.id], page.id)).toEqual([]);
    group.visible = true;
    rectangle.archived = true;
    expect(canonicalizeNodeSelection(document, [rectangle.id], page.id)).toEqual([]);
  });
});

describe("auto-layout gestures", () => {
  it("enables one auto-layout child while retaining absolute multi-selection behavior", () => {
    const document = createStarterDocument({ preset: "web" });
    const frame = document.nodes[document.pages[0]!.children[0]!]!;
    if (frame.type !== "frame") throw new Error("Expected starter frame");
    const autoChild = createRectangleNode({
      layout: { width_sizing: "fill", height_sizing: "hug", rotation: 12.5 },
    });
    const stack = createGroupNode({
      name: "Auto stack",
      children: [autoChild.id],
      layout: { mode: "vertical" },
    });
    const absoluteA = createRectangleNode();
    const absoluteB = createRectangleNode();
    frame.children.push(stack.id, absoluteA.id, absoluteB.id);
    Object.assign(document.nodes, {
      [stack.id]: stack,
      [autoChild.id]: autoChild,
      [absoluteA.id]: absoluteA,
      [absoluteB.id]: absoluteB,
    });

    expect(selectionGestureCapabilities(document, [autoChild.id])).toEqual({
      draggable: true,
      resizable: true,
      flow: "auto",
    });
    expect(selectionGestureCapabilities(document, [absoluteA.id, absoluteB.id])).toEqual({
      draggable: true,
      resizable: false,
      flow: "absolute",
    });
    autoChild.locked = true;
    expect(selectionGestureCapabilities(document, [autoChild.id])).toEqual({
      draggable: false,
      resizable: false,
      flow: "none",
    });
  });

  it("finds only eligible same-page auto-layout reparent targets", () => {
    const document = createStarterDocument({ preset: "web" });
    const frame = document.nodes[document.pages[0]!.children[0]!]!;
    if (frame.type !== "frame") throw new Error("Expected starter frame");
    const nested = createGroupNode({ name: "Nested", layout: { mode: "horizontal" } });
    const source = createGroupNode({
      name: "Source",
      children: [nested.id],
      layout: { mode: "vertical" },
    });
    const destination = createGroupNode({ name: "Destination", layout: { mode: "grid", columns: 2 } });
    const locked = createGroupNode({ name: "Locked", locked: true, layout: { mode: "vertical" } });
    const absolute = createFrameNode({ name: "Absolute", layout: { mode: "absolute" } });
    frame.children.push(source.id, destination.id, locked.id, absolute.id);
    Object.assign(document.nodes, {
      [source.id]: source,
      [nested.id]: nested,
      [destination.id]: destination,
      [locked.id]: locked,
      [absolute.id]: absolute,
    });

    const candidates = autoLayoutDropContainers(document, source.id);
    expect(candidates.map((candidate) => candidate.nodeId)).toEqual([destination.id]);
    expect(candidates[0]).toMatchObject({ mode: "grid", wrap: false });
  });

  it("computes deterministic horizontal, vertical, and wrapped/grid insertion indices", () => {
    const horizontal = [
      { index: 0, rect: { left: 0, top: 0, right: 40, bottom: 40 } },
      { index: 1, rect: { left: 60, top: 0, right: 100, bottom: 40 } },
      { index: 2, rect: { left: 120, top: 0, right: 160, bottom: 40 } },
    ];
    expect(autoLayoutInsertionIndex("horizontal", false, horizontal, { x: 85, y: 20 }, 3)).toBe(2);
    expect(autoLayoutInsertionIndex("horizontal", false, horizontal, { x: -10, y: 20 }, 3)).toBe(0);
    expect(autoLayoutInsertionIndex("vertical", false, [
      { index: 0, rect: { left: 0, top: 0, right: 40, bottom: 40 } },
      { index: 1, rect: { left: 0, top: 60, right: 40, bottom: 100 } },
    ], { x: 20, y: 90 }, 2)).toBe(2);

    const grid = [
      { index: 0, rect: { left: 0, top: 0, right: 40, bottom: 40 } },
      { index: 1, rect: { left: 60, top: 0, right: 100, bottom: 40 } },
      { index: 2, rect: { left: 0, top: 60, right: 40, bottom: 100 } },
      { index: 3, rect: { left: 60, top: 60, right: 100, bottom: 100 } },
    ];
    expect(autoLayoutInsertionIndex("grid", false, grid, { x: 10, y: 80 }, 4)).toBe(2);
    expect(autoLayoutInsertionIndex("horizontal", true, grid, { x: 90, y: 80 }, 4)).toBe(4);
  });

  it("chooses the deepest drop container and falls back to the current parent", () => {
    const currentId = "node_current" as never;
    const nestedId = "node_nested" as never;
    const candidates = [
      {
        nodeId: currentId,
        mode: "vertical" as const,
        wrap: false,
        depth: 1,
        rect: { left: 0, top: 0, right: 300, bottom: 300 },
      },
      {
        nodeId: nestedId,
        mode: "horizontal" as const,
        wrap: false,
        depth: 2,
        rect: { left: 80, top: 80, right: 180, bottom: 180 },
      },
    ];
    expect(chooseAutoLayoutDropContainer(candidates, { x: 100, y: 100 }, currentId)?.nodeId).toBe(nestedId);
    expect(chooseAutoLayoutDropContainer(candidates, { x: 500, y: 500 }, currentId)?.nodeId).toBe(currentId);
  });

  it("turns resized auto-layout axes into fixed constraints without touching x/y or rotation", () => {
    const node = createRectangleNode({
      layout: {
        x: 17.125,
        y: 23.75,
        width: 120,
        height: 48,
        rotation: 18.5,
        width_sizing: "fill",
        height_sizing: "hug",
        min_width: 80,
        max_width: 240,
      },
    });
    expect(resizePatchForGesture(node, "vertical", {
      width: 187.45678,
      height: 71.23456,
      direction: [1, 0],
      translation: [-12.5, 0],
    })).toEqual({
      layout: { width: 187.4568, width_sizing: "fixed" },
    });
    expect(node.layout).toMatchObject({ x: 17.125, y: 23.75, rotation: 18.5, width_sizing: "fill" });
  });

  it("preserves normalized absolute resize behavior and min/max bounds", () => {
    const node = createRectangleNode({
      layout: {
        x: 10.25,
        y: 20.5,
        width: 100,
        height: 80,
        min_width: 90,
        max_width: 150,
      },
    });
    expect(resizePatchForGesture(node, "absolute", {
      width: 170.22222,
      height: 60.55555,
      direction: [1, 1],
      translation: [-4.12555, 7.87555],
    })).toEqual({
      layout: {
        x: 6.1245,
        y: 28.3756,
        width: 150,
        height: 60.5556,
      },
    });
  });
});
