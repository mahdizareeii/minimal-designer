import {
  applyOperations,
  createSequentialIdFactory,
  createStarterDocument,
  lintDesignDocumentV2,
  mergeV1CompatibilityDocument,
  migrateV1ToV2,
  toV1CompatibleDesignDocument,
} from "@designer/core";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AccessibilityIdentityEditor } from "../components/InspectorPanel";
import { useDesignerStore } from "../store/designer-store";

describe("V2 accessibility inspector compatibility", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows an existing semantic label and commits a typed edit without losing V2 data", async () => {
    const source = createStarterDocument({
      now: "2026-01-01T00:00:00.000Z",
      idFactory: createSequentialIdFactory("weba11ylabel"),
    });
    source.revision = 1;
    const frameId = source.pages[0]!.children[0]!;
    const sourceFrame = source.nodes[frameId]!;
    if (sourceFrame.type !== "frame") throw new Error("Expected starter frame");
    sourceFrame.role = "button";

    const canonical = migrateV1ToV2(source, { migratedAt: "2026-02-01T00:00:00.000Z" });
    const canonicalFrame = canonical.nodes[frameId]!;
    canonicalFrame.semantics.accessibility_label = "Existing checkout label";
    canonicalFrame.semantics.description = "Preserve the V2 handoff description.";
    canonicalFrame.metadata.audit_note = "Preserve canonical metadata.";
    const projection = toV1CompatibleDesignDocument(canonical);

    useDesignerStore.setState({
      document: projection,
      baseVersion: projection.revision,
      activePageId: projection.pages[0]!.id,
      selectedIds: [frameId],
      inspectorTab: "accessibility",
      pendingOperations: [],
      undoStack: [],
      redoStack: [],
      saveState: "saved",
      saving: false,
      offline: false,
      error: null,
    });

    expect(renderToStaticMarkup(
      <AccessibilityIdentityEditor node={projection.nodes[frameId]!} updateNode={() => undefined} />,
    )).toContain('value="Existing checkout label"');

    useDesignerStore.getState().updateNode(frameId, { accessibility_label: "Review and pay" });
    const pending = useDesignerStore.getState().pendingOperations;
    expect(pending).toEqual([{
      type: "update_node",
      node_id: frameId,
      patch: { accessibility_label: "Review and pay" },
    }]);
    expect(useDesignerStore.getState().document?.nodes[frameId]?.metadata.accessible_label).toBe("Review and pay");

    const editedProjection = applyOperations(projection, pending, {
      expectedRevision: projection.revision,
      now: "2026-03-01T00:00:00.000Z",
    }).document;
    const committedCanonical = mergeV1CompatibilityDocument(canonical, editedProjection, {
      accessibilityLabelEdits: new Map([[frameId, "Review and pay"]]),
    });
    const committedProjection = toV1CompatibleDesignDocument(committedCanonical);
    expect(committedCanonical.nodes[frameId]?.semantics).toMatchObject({
      role: "button",
      accessibility_label: "Review and pay",
      description: "Preserve the V2 handoff description.",
    });
    expect(committedCanonical.nodes[frameId]?.metadata).toEqual({
      preset: "web",
      audit_note: "Preserve canonical metadata.",
    });
    expect(lintDesignDocumentV2(committedCanonical).some((item) => item.code === "interactive_accessible_name_missing")).toBe(false);

    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { operations: unknown[] };
      expect(body.operations).toEqual(pending);
      return new Response(JSON.stringify({
        version: committedProjection.revision,
        revisionId: "revision_weba11ylabel_00000001",
        document: committedProjection,
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    await useDesignerStore.getState().save();
    const saved = useDesignerStore.getState();
    expect(saved.saveState).toBe("saved");
    expect(saved.pendingOperations).toEqual([]);
    expect(saved.document?.nodes[frameId]?.metadata.accessible_label).toBe("Review and pay");
  });
});
