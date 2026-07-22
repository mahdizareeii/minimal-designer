import {
  FORMASPEC_FOUNDATION_SYSTEM,
  createGroupNode,
  createStarterDocument,
} from "@designer/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  componentInsertionParentOptions,
} from "../components/ComponentLibraryPanel";
import {
  commitComponentInsertionPreview,
  createComponentInsertionPreview,
  exactPreviewRenderUrl,
  readComponentLibrary,
} from "../lib/api";
import { useDesignerStore } from "../store/designer-store";

afterEach(() => vi.restoreAllMocks());

describe("manual pinned component insertion", () => {
  beforeEach(() => {
    const document = createStarterDocument({ preset: "web", name: "Component insertion" });
    useDesignerStore.setState({
      document,
      baseVersion: document.revision,
      activePageId: document.pages[0]!.id,
      selectedIds: [document.pages[0]!.children[0]!],
      pendingOperations: [],
      saving: false,
      saveState: "saved",
      conflictRecovery: null,
    });
  });

  it("offers the active page and only unlocked active-page containers as insertion parents", () => {
    const document = createStarterDocument({ preset: "web" });
    const page = document.pages[0]!;
    const frame = document.nodes[page.children[0]!]!;
    if (frame.type !== "frame") throw new Error("starter frame missing");
    const locked = createGroupNode({ name: "Locked target", locked: true });
    document.nodes[locked.id] = locked;
    frame.children.push(locked.id);

    const options = componentInsertionParentOptions(document, page.id, [frame.id]);
    expect(options.map((option) => option.key)).toEqual([
      `page:${page.id}`,
      `node:${frame.id}`,
    ]);
    expect(options[0]).toMatchObject({ parent: { page_id: page.id }, acceptsPosition: true });
    expect(options[1]).toMatchObject({ parent: { node_id: frame.id }, acceptsPosition: true });
  });

  it("uses the bounded library, exact preview, and ordinary CAS commit endpoints", async () => {
    const document = createStarterDocument({ preset: "web" });
    const definition = Object.values(FORMASPEC_FOUNDATION_SYSTEM.components)[0]!;
    const sourceHash = "a".repeat(64);
    const previewId = "preview_componentinsert0001";
    const instanceId = "node_componentinsertinstance01";
    const targetNodeId = "node_componentinserttarget0001";
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        library: {
          designId: document.id,
          baseVersion: 2,
          designSystemId: FORMASPEC_FOUNDATION_SYSTEM.id,
          releaseId: FORMASPEC_FOUNDATION_SYSTEM.release.id,
          releaseVersion: FORMASPEC_FOUNDATION_SYSTEM.release.version,
          releaseName: FORMASPEC_FOUNDATION_SYSTEM.release.name,
          components: [{
            definition,
            sourceHash,
            sourceNodeCount: 4,
            prototypeLinkCount: 0,
            tokenDependencyIds: [],
            assetDependencyIds: [],
            insertable: true,
            blockers: [],
          }],
        },
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        previewId,
        designId: document.id,
        rootBaseVersion: 2,
        baseRevisionId: "revision_componentinsertbase01",
        baseSnapshotHash: "b".repeat(64),
        operationHash: "c".repeat(64),
        resultSnapshotHash: "d".repeat(64),
        expiresAt: "2026-07-21T12:15:00.000Z",
        canCommit: true,
        destructive: false,
        kind: "ordinary",
        status: "ready",
        committedRevisionId: null,
        changedNodeIds: [instanceId],
        versions: { commandEngine: "2", renderer: "3", fontBundle: "1" },
        diagnostics: [],
        document,
        component: {
          designSystemId: FORMASPEC_FOUNDATION_SYSTEM.id,
          releaseId: FORMASPEC_FOUNDATION_SYSTEM.release.id,
          releaseVersion: FORMASPEC_FOUNDATION_SYSTEM.release.version,
          componentDefinitionId: definition.id,
          componentVersion: definition.version,
          sourceHash,
          activeState: "default",
          instanceId,
          nodeIdMapping: { [definition.root_node_id]: targetNodeId },
        },
      }), { status: 201, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        version: 3,
        revisionId: "revision_componentinsertcommit01",
      }), { status: 200, headers: { "content-type": "application/json" } }));

    const library = await readComponentLibrary(document.id);
    const preview = await createComponentInsertionPreview({
      designId: document.id,
      baseVersion: library.baseVersion,
      componentDefinitionId: definition.id,
      parent: { node_id: document.pages[0]!.children[0]! },
      activeState: "default",
      position: { x: 24.5, y: 36.25 },
    });
    const committed = await commitComponentInsertionPreview({
      designId: document.id,
      previewId: preview.previewId,
      expectedBaseVersion: preview.rootBaseVersion,
      idempotencyKey: "component_insert_retry0001",
    });

    expect(library.components[0]).toMatchObject({ sourceHash, insertable: true });
    expect(preview).toMatchObject({
      previewId,
      resultSnapshotHash: "d".repeat(64),
      component: { instanceId, componentDefinitionId: definition.id },
    });
    expect(committed).toMatchObject({ version: 3, revisionId: "revision_componentinsertcommit01" });
    expect(exactPreviewRenderUrl(document.id, previewId)).toBe(
      `/api/designs/${document.id}/previews/${previewId}/render.png`,
    );
    expect(fetch.mock.calls[0]?.[0]).toBe(`/api/designs/${document.id}/component-library`);
    expect(fetch.mock.calls[1]?.[0]).toBe(`/api/designs/${document.id}/component-insertion-previews`);
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      baseVersion: 2,
      componentDefinitionId: definition.id,
      parent: { node_id: document.pages[0]!.children[0]! },
      activeState: "default",
      position: { x: 24.5, y: 36.25 },
    });
    expect(fetch.mock.calls[2]?.[0]).toBe(`/api/designs/${document.id}/previews/${previewId}/commit`);
    expect(JSON.parse(String(fetch.mock.calls[2]?.[1]?.body))).toEqual({
      expectedBaseVersion: 2,
      idempotencyKey: "component_insert_retry0001",
      message: "Insert verified design-system component",
    });
  });
});
