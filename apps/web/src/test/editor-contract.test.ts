import { createGroupNode, createRectangleNode, createStarterDocument, validateDesignDocument } from "@designer/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { normalizeDocument, resolvedDirection, serializeDocument } from "../domain";
import { useDesignerStore } from "../store/designer-store";

describe("canonical web editor contract", () => {
  beforeEach(() => {
    const document = createStarterDocument({ preset: "phone", name: "Test design" });
    document.revision = 1;
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
      conflictRecovery: null,
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

  it("batches fractional multi-node gesture geometry into one undo command", () => {
    const document = useDesignerStore.getState().document!;
    const frameId = document.pages[0]!.children[0]!;
    const frame = document.nodes[frameId]!;
    if (frame.type !== "frame") throw new Error("Expected starter frame");
    const child = createRectangleNode({ layout: { x: 8.25, y: 9.5, rotation: 17.5 } });
    frame.children.push(child.id);
    document.nodes[child.id] = child;

    useDesignerStore.getState().updateNodes([
      { nodeId: frame.id, patch: { layout: { x: 12.125, y: 14.375 } } },
      { nodeId: child.id, patch: { layout: { x: 21.625, y: 32.875, width: 140.25 } } },
    ]);

    const updated = useDesignerStore.getState();
    expect(updated.pendingOperations).toHaveLength(2);
    expect(updated.undoStack).toHaveLength(1);
    expect(updated.undoStack[0]?.operations).toHaveLength(2);
    expect(updated.document!.nodes[child.id]!.layout).toMatchObject({
      x: 21.625,
      y: 32.875,
      width: 140.25,
      rotation: 17.5,
    });
    expect(validateDesignDocument(updated.document!).success).toBe(true);
  });

  it("commits one normalized move_node command for an auto-layout drag and restores it with undo", () => {
    const document = useDesignerStore.getState().document!;
    const frame = document.nodes[document.pages[0]!.children[0]!]!;
    if (frame.type !== "frame") throw new Error("Expected starter frame");
    const child = createRectangleNode({
      name: "Dragged child",
      layout: { x: 7.125, y: 9.875, rotation: 14.25, width_sizing: "fill", height_sizing: "hug" },
    });
    const source = createGroupNode({ name: "Source stack", children: [child.id], layout: { mode: "vertical" } });
    const destination = createGroupNode({ name: "Destination stack", layout: { mode: "horizontal" } });
    frame.children.push(source.id, destination.id);
    Object.assign(document.nodes, {
      [source.id]: source,
      [destination.id]: destination,
      [child.id]: child,
    });

    useDesignerStore.getState().moveNodeByGesture(child.id, { node_id: destination.id }, 0);
    const moved = useDesignerStore.getState();
    expect(moved.pendingOperations).toEqual([{
      type: "move_node",
      node_id: child.id,
      parent: { node_id: destination.id },
      index: 0,
    }]);
    expect(moved.undoStack).toHaveLength(1);
    expect(moved.undoStack[0]?.operations).toHaveLength(1);
    const movedSource = moved.document!.nodes[source.id]!;
    const movedDestination = moved.document!.nodes[destination.id]!;
    if (movedSource.type !== "group" || movedDestination.type !== "group") throw new Error("Expected gesture stacks");
    expect(movedSource.children).toEqual([]);
    expect(movedDestination.children).toEqual([child.id]);
    expect(moved.document!.nodes[child.id]!.layout).toMatchObject({
      x: 7.125,
      y: 9.875,
      rotation: 14.25,
      width_sizing: "fill",
      height_sizing: "hug",
    });

    moved.undo();
    const restored = useDesignerStore.getState().document!;
    const restoredSource = restored.nodes[source.id]!;
    const restoredDestination = restored.nodes[destination.id]!;
    if (restoredSource.type !== "group" || restoredDestination.type !== "group") throw new Error("Expected gesture stacks");
    expect(restoredSource.children).toEqual([child.id]);
    expect(restoredDestination.children).toEqual([]);
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
    const baseRevisionId = "revision_fixture_000001";
    useDesignerStore.setState({
      projects: [{
        id: state.document!.id,
        name: state.document!.name,
        version: state.baseVersion,
        revisionId: baseRevisionId,
        updatedAt: state.document!.updated_at,
      }],
    });
    state.updateNode(frameId, { name: "Local unsaved title" });
    const originalVersion = useDesignerStore.getState().baseVersion;
    const latest = structuredClone(state.document!);
    latest.revision = originalVersion + 1;
    latest.nodes[frameId]!.name = "Server title";

    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          code: "VERSION_CONFLICT",
          message: "The design changed.",
          retryable: true,
          details: {
            currentVersion: originalVersion + 1,
            currentRevisionId: "revision_fixture_000002",
            currentActor: "usr_codex_fixture",
            currentRevisionCreatedAt: "2026-07-21T10:00:00.000Z",
          },
        },
      }), { status: 409, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(latest), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        duplicated: true,
        source: {
          projectId: state.document!.id,
          baseVersion: originalVersion,
          baseRevisionId,
          baseSnapshotHash: "a".repeat(64),
          baseRevisionHash: "b".repeat(64),
          currentVersion: originalVersion + 1,
          currentRevisionId: "revision_fixture_000002",
        },
        project: {
          id: "document_duplicate_fixture_000001",
          name: "Recovered copy",
          version: 1,
          revisionId: "revision_duplicate_fixture_000001",
          snapshotHash: "c".repeat(64),
          operationHash: "d".repeat(64),
          revisionHash: "e".repeat(64),
          schemaVersion: 1,
          assetCount: 0,
          productSpecificationVersion: null,
          implementationMappingCount: 0,
        },
        idMapping: { [state.document!.id]: "document_duplicate_fixture_000001" },
        diagnostics: [],
        deepLink: "/design/document_duplicate_fixture_000001",
      }), { status: 201, headers: { "content-type": "application/json" } }));

    await useDesignerStore.getState().save();
    const conflicted = useDesignerStore.getState();
    expect(conflicted.saveState).toBe("conflict");
    expect(conflicted.baseVersion).toBe(originalVersion);
    expect(conflicted.pendingOperations).toHaveLength(1);
    expect(conflicted.document!.nodes[frameId]!.name).toBe("Local unsaved title");
    expect(conflicted.notice).toContain("no automatic merge");
    expect(conflicted.conflictRecovery).toMatchObject({
      design: { id: state.document!.id },
      baseRevision: { version: originalVersion, id: baseRevisionId },
      latestRevision: {
        version: originalVersion + 1,
        id: "revision_fixture_000002",
        actor: "usr_codex_fixture",
        createdAt: "2026-07-21T10:00:00.000Z",
      },
      operations: conflicted.pendingOperations,
    });
    expect(conflicted.conflictRecovery?.operationHash).toMatch(/^[a-f0-9]{64}$/);

    const recovery = conflicted.conflictRecovery;
    await conflicted.loadLatestForConflict();
    const reloaded = useDesignerStore.getState();
    expect(reloaded.document!.nodes[frameId]!.name).toBe("Server title");
    expect(reloaded.baseVersion).toBe(originalVersion + 1);
    expect(reloaded.pendingOperations).toEqual([]);
    expect(reloaded.saveState).toBe("saved");
    expect(reloaded.conflictRecovery).toEqual(recovery);
    reloaded.updateNode(frameId, { name: "Must remain blocked" });
    expect(useDesignerStore.getState().document!.nodes[frameId]!.name).toBe("Server title");
    expect(useDesignerStore.getState().notice).toContain("explicitly discard");

    const duplicated = await reloaded.duplicateConflictDraft("Recovered copy");
    expect(duplicated?.project.id, useDesignerStore.getState().error ?? undefined).toBe("document_duplicate_fixture_000001");
    expect(useDesignerStore.getState().conflictRecovery).toEqual(recovery);
    const duplicateRequest = fetch.mock.calls[2]!;
    expect(duplicateRequest[0]).toBe(`/api/designs/${encodeURIComponent(state.document!.id)}/conflict-recovery/duplicate`);
    const body = JSON.parse(String((duplicateRequest[1] as RequestInit).body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      baseVersion: originalVersion,
      operations: recovery?.operations,
      name: "Recovered copy",
    });
    expect(String(body.idempotencyKey)).toMatch(/^conflict-duplicate_/);

    await useDesignerStore.getState().discardConflictRecovery();
    expect(useDesignerStore.getState().conflictRecovery).toBeNull();
    expect(useDesignerStore.getState().document!.nodes[frameId]!.name).toBe("Server title");
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });
});
