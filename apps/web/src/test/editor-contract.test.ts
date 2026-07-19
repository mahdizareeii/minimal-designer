import { createStarterDocument, validateDesignDocument } from "@designer/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { normalizeDocument, resolvedDirection, serializeDocument } from "../domain";
import { useDesignerStore } from "../store/designer-store";

describe("canonical web editor contract", () => {
  beforeEach(() => {
    const document = createStarterDocument({ preset: "phone", name: "Test design" });
    useDesignerStore.setState({
      document,
      baseVersion: document.revision,
      activePageId: document.pages[0]!.id,
      selectedIds: [],
      pendingOperations: [],
      undoStack: [],
      redoStack: [],
      error: null,
      saveState: "saved",
      saving: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses and serializes only the shared core document shape", () => {
    const document = createStarterDocument({ preset: "tablet", name: "Canonical" });
    const parsed = normalizeDocument({ document });
    expect(parsed.schema_version).toBe(1);
    expect(parsed.pages[0]?.children).toHaveLength(1);
    expect(serializeDocument(parsed)).toEqual(document);
    expect(() => normalizeDocument({ id: "legacy", schemaVersion: 1, pages: [] })).toThrow();
  });

  it("generates canonical update operations for optimistic inspector edits", () => {
    const state = useDesignerStore.getState();
    const frameId = state.document!.pages[0]!.children[0]!;
    state.updateNode(frameId, { layout: { x: 42, y: 64 } });

    const updated = useDesignerStore.getState();
    expect(updated.document!.nodes[frameId]!.layout).toMatchObject({ x: 42, y: 64 });
    expect(updated.pendingOperations[0]).toEqual({
      type: "update_node",
      node_id: frameId,
      patch: { layout: { x: 42, y: 64 } },
    });
    expect(validateDesignDocument(updated.document!).success).toBe(true);
  });

  it("adds a typed node through the canonical create_tree operation", () => {
    const state = useDesignerStore.getState();
    const frameId = state.document!.pages[0]!.children[0]!;
    state.select([frameId]);
    state.addNode("text");

    const updated = useDesignerStore.getState();
    const operation = updated.pendingOperations[0];
    expect(operation?.type).toBe("create_tree");
    if (operation?.type !== "create_tree") throw new Error("Expected create_tree");
    expect(operation.parent).toEqual({ node_id: frameId });
    expect(operation.root_ids).toHaveLength(1);
    expect(updated.document!.nodes[operation.root_ids[0]!]!.type).toBe("text");
    expect(validateDesignDocument(updated.document!).success).toBe(true);
  });

  it("uses automatic RTL direction for Persian and keeps mixed content deterministic", () => {
    const document = createStarterDocument({ preset: "phone" });
    useDesignerStore.setState({ document, baseVersion: document.revision, activePageId: document.pages[0]!.id });
    useDesignerStore.getState().select([document.pages[0]!.children[0]!]);
    useDesignerStore.getState().addNode("text");
    const textId = useDesignerStore.getState().selectedIds[0]!;
    useDesignerStore.getState().updateNode(textId, { content: "سلام Product team", direction: "auto" });
    const node = useDesignerStore.getState().document!.nodes[textId]!;
    expect(resolvedDirection(node)).toBe("rtl");
    useDesignerStore.getState().updateNode(textId, { content: "Product سلام" });
    expect(resolvedDirection(useDesignerStore.getState().document!.nodes[textId]!)).toBe("ltr");
  });

  it("stops on version conflicts instead of automatically rebasing local edits", async () => {
    const state = useDesignerStore.getState();
    const frameId = state.document!.pages[0]!.children[0]!;
    state.updateNode(frameId, { name: "Local unsaved title" });
    const originalVersion = useDesignerStore.getState().baseVersion;

    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      error: {
        code: "VERSION_CONFLICT",
        message: "The design changed.",
        retryable: true,
        details: { currentVersion: originalVersion + 1 },
      },
    }), { status: 409, headers: { "content-type": "application/json" } }));

    await useDesignerStore.getState().save();
    const conflicted = useDesignerStore.getState();
    expect(conflicted.saveState).toBe("conflict");
    expect(conflicted.baseVersion).toBe(originalVersion);
    expect(conflicted.pendingOperations).toHaveLength(1);
    expect(conflicted.document!.nodes[frameId]!.name).toBe("Local unsaved title");
    expect(conflicted.notice).toContain("no automatic merge");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});
