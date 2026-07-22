import { describe, expect, it } from "vitest";

import {
  applyOperations,
  buildParentIndex,
  createFrameNode,
  createImageNode,
  createRectangleNode,
  createSampleDocument,
  createSequentialIdFactory,
  createStarterDocument,
  createTextNode,
  findNodeParent,
  getAncestors,
  getDescendantIds,
  getNodeChildren,
  lintDesignDocument,
  nodeToCss,
  resolveTokenValue,
  searchNodes,
  textFontFamilyStack,
  tokensToCssVariables,
  validateDesignDocument,
} from "./index.js";

describe("tree and search helpers", () => {
  it("indexes parents and walks ancestor/descendant relationships", () => {
    const document = createSampleDocument({ idFactory: createSequentialIdFactory("treehelp") });
    const screen = Object.values(document.nodes).find((node) => node.type === "frame" && node.role === "screen")!;
    const button = Object.values(document.nodes).find((node) => node.type === "frame" && node.role === "button")!;
    const labelId = getNodeChildren(button)[0]!;
    const parentIndex = buildParentIndex(document);

    expect(parentIndex.size).toBe(Object.keys(document.nodes).length);
    expect(findNodeParent(document, screen.id)?.parent).toEqual({ page_id: document.pages[0]!.id });
    expect(getAncestors(document, labelId).map((node) => node.name)).toEqual([
      "Primary button",
      "Intro card",
      "Mobile screen",
    ]);
    expect(getDescendantIds(document, screen.id)).toContain(labelId);
  });

  it("searches names, types, tags, and text content", () => {
    const document = createSampleDocument({ idFactory: createSequentialIdFactory("searchhelp") });
    expect(searchNodes(document, "product ideas")).toHaveLength(1);
    expect(searchNodes(document, "frame", { types: ["frame"] }).every((node) => node.type === "frame")).toBe(true);
    expect(searchNodes(document, "", { limit: 2 })).toHaveLength(2);
  });
});

describe("style conversion", () => {
  it("uses bundled deterministic fallbacks for Persian and mixed-direction text", () => {
    expect(textFontFamilyStack("Inter", "Hello world")).toBe("Inter, Vazirmatn, system-ui, sans-serif");
    expect(textFontFamilyStack("Inter", "Hello فارسی")).toBe("Vazirmatn, Inter, system-ui, sans-serif");
    expect(textFontFamilyStack("Vazirmatn", "فارسی")).toBe("Vazirmatn, Inter, system-ui, sans-serif");
    expect(textFontFamilyStack("Company Sans", "نسخه ۲")).toBe("Company Sans, Vazirmatn, Inter, system-ui, sans-serif");
  });

  it("resolves tokens and converts layout/style into React-compatible CSS", () => {
    const document = createSampleDocument({ idFactory: createSequentialIdFactory("csshelp") });
    const button = Object.values(document.nodes).find((node) => node.type === "frame" && node.role === "button")!;
    const css = nodeToCss(button, document, { parentLayoutMode: "vertical" });
    const fill = button.style.fill;

    expect(fill).toBeDefined();
    expect(resolveTokenValue(fill, document)).toBe("#111827");
    expect(css).toMatchObject({
      position: "relative",
      display: "flex",
      flexDirection: "row",
      backgroundColor: "#111827",
      borderRadius: "12px",
    });
    expect(tokensToCssVariables(document)).toMatchObject({
      "--designer-color-primary": "#111827",
      "--designer-color-surface": "#ffffff",
    });
  });
});

describe("lint diagnostics", () => {
  it("reports practical accessibility and clipping heuristics without invalidating the document", () => {
    const ids = createSequentialIdFactory("linthelp");
    const document = createStarterDocument({ idFactory: ids });
    const frame = document.nodes[document.pages[0]!.children[0]!]!;
    expect(frame.type).toBe("frame");
    const emptyText = createTextNode(
      {
        name: "Empty low contrast",
        content: " ",
        layout: { x: -4, y: 0, width: 80, height: 20 },
        style: { color: "#ffffff", opacity: 2, typography: { font_size: 14 } },
      },
      ids,
    );
    const image = createImageNode({ name: "Decorative", alt: "", layout: { x: 1400, y: 880, width: 100, height: 100 } }, ids);
    const tinyButton = createFrameNode(
      { name: "Tiny button", role: "button", layout: { width: 20, height: 20 }, style: { fill: "#000000" } },
      ids,
    );
    const translucent = createRectangleNode({ name: "Odd opacity", style: { opacity: -1 } }, ids);
    const result = applyOperations(document, [
      {
        type: "create_tree",
        parent: { node_id: frame.id },
        root_ids: [emptyText.id, image.id, tinyButton.id, translucent.id],
        nodes: [emptyText, image, tinyButton, translucent],
      },
    ]);
    const codes = new Set(lintDesignDocument(result.document).map((item) => item.code));

    expect(validateDesignDocument(result.document).success).toBe(true);
    expect(codes).toEqual(
      expect.objectContaining(
        new Set(["empty_text", "image_missing_alt", "small_interactive_target", "opacity_out_of_range", "child_clipped"]),
      ),
    );
  });
});
