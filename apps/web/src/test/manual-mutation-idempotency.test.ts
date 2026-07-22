import { createStarterDocument } from "@designer/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DesignDocument, DesignOperation, DesignProjectSummary } from "../domain";
import { manualMutationIdempotency } from "../lib/mutation-idempotency";
import { useDesignerStore } from "../store/designer-store";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestBody(call: readonly [unknown, RequestInit?]): Record<string, unknown> {
  return JSON.parse(String(call[1]?.body)) as Record<string, unknown>;
}

function resetEditor(document: DesignDocument): void {
  useDesignerStore.setState({
    projects: [{
      id: document.id,
      name: document.name,
      version: document.revision,
      updatedAt: document.updated_at,
    }],
    document,
    baseVersion: document.revision,
    activePageId: document.pages[0]!.id,
    selectedIds: [],
    pendingOperations: [],
    undoStack: [],
    redoStack: [],
    saving: false,
    saveState: "saved",
    archiveReview: null,
    conflictRecovery: null,
    productBriefGuard: null,
    error: null,
    notice: null,
    offline: false,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useDesignerStore.getState().closeDesign();
  useDesignerStore.setState({
    projects: [],
    archivingProjectId: null,
    error: null,
    notice: null,
    offline: false,
  });
});

describe("manual mutation retry idempotency", () => {
  it("reuses the project archive key after a lost response and clears it after success", async () => {
    const project: DesignProjectSummary = {
      id: "design_archive_retry_0001",
      name: "Retry-safe archive",
      version: 8,
      revisionId: "revision_archive_retry_0001",
      updatedAt: "2026-07-22T10:00:00.000Z",
    };
    const archived = {
      id: project.id,
      name: project.name,
      version: project.version,
      revisionId: project.revisionId,
      createdAt: "2026-07-20T10:00:00.000Z",
      updatedAt: project.updatedAt,
      archivedAt: "2026-07-22T10:05:00.000Z",
    };
    manualMutationIdempotency.clear(`project-archive:${project.id}`);
    useDesignerStore.setState({ projects: [project], archivingProjectId: null });
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("response connection closed"))
      .mockResolvedValueOnce(jsonResponse(archived))
      .mockResolvedValueOnce(jsonResponse(archived));

    await expect(useDesignerStore.getState().archiveProject(project.id, project.name))
      .rejects.toMatchObject({ code: "NETWORK_ERROR" });
    await useDesignerStore.getState().archiveProject(project.id, project.name);

    const firstKey = requestBody(fetch.mock.calls[0]!).idempotencyKey;
    const retryKey = requestBody(fetch.mock.calls[1]!).idempotencyKey;
    expect(retryKey).toBe(firstKey);

    useDesignerStore.setState({ projects: [project], archivingProjectId: null });
    await useDesignerStore.getState().archiveProject(project.id, project.name);
    expect(requestBody(fetch.mock.calls[2]!).idempotencyKey).not.toBe(firstKey);
  });

  it("clears a project archive key after a definitive server rejection", async () => {
    const project: DesignProjectSummary = {
      id: "design_archive_rejected_0001",
      name: "Definitive archive failure",
      version: 3,
      revisionId: "revision_archive_rejected_0001",
      updatedAt: "2026-07-22T10:00:00.000Z",
    };
    const archived = {
      id: project.id,
      name: project.name,
      version: project.version,
      revisionId: project.revisionId,
      createdAt: "2026-07-20T10:00:00.000Z",
      updatedAt: project.updatedAt,
      archivedAt: "2026-07-22T10:05:00.000Z",
    };
    manualMutationIdempotency.clear(`project-archive:${project.id}`);
    useDesignerStore.setState({ projects: [project], archivingProjectId: null });
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({
        error: { code: "VERSION_CONFLICT", message: "The project changed.", retryable: true },
      }, 409))
      .mockResolvedValueOnce(jsonResponse(archived));

    await expect(useDesignerStore.getState().archiveProject(project.id, project.name))
      .rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    await useDesignerStore.getState().archiveProject(project.id, project.name);

    expect(requestBody(fetch.mock.calls[1]!).idempotencyKey)
      .not.toBe(requestBody(fetch.mock.calls[0]!).idempotencyKey);
  });

  it("reuses the project archive key when a success response is malformed and therefore unknown", async () => {
    const project: DesignProjectSummary = {
      id: "design_archive_unknown_0001",
      name: "Unknown archive outcome",
      version: 5,
      revisionId: "revision_archive_unknown_0001",
      updatedAt: "2026-07-22T10:00:00.000Z",
    };
    const archived = {
      id: project.id,
      name: project.name,
      version: project.version,
      revisionId: project.revisionId,
      createdAt: "2026-07-20T10:00:00.000Z",
      updatedAt: project.updatedAt,
      archivedAt: "2026-07-22T10:05:00.000Z",
    };
    manualMutationIdempotency.clear(`project-archive:${project.id}`);
    useDesignerStore.setState({ projects: [project], archivingProjectId: null });
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ ...archived, unexpected: true }))
      .mockResolvedValueOnce(jsonResponse(archived));

    await expect(useDesignerStore.getState().archiveProject(project.id, project.name))
      .rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await useDesignerStore.getState().archiveProject(project.id, project.name);

    expect(requestBody(fetch.mock.calls[1]!).idempotencyKey)
      .toBe(requestBody(fetch.mock.calls[0]!).idempotencyKey);
  });

  it("reuses the exact archive-preview commit key after a lost response", async () => {
    const base = createStarterDocument({ preset: "phone", name: "Archive preview retry" });
    const frameId = base.pages[0]!.children[0]!;
    const operation: DesignOperation = { type: "archive_nodes", node_ids: [frameId] };
    const proposed = structuredClone(base);
    proposed.nodes[frameId]!.archived = true;
    const committed = structuredClone(proposed);
    committed.revision = base.revision + 1;
    committed.updated_at = "2026-07-22T10:06:00.000Z";
    resetEditor(proposed);
    useDesignerStore.setState({
      baseVersion: base.revision,
      saveState: "review",
      archiveReview: {
        previewId: "preview_archive_retry_0001",
        baseVersion: base.revision,
        changedNodeIds: [frameId],
        operations: [operation],
        baseDocument: base,
        previewDocument: proposed,
      },
    });
    manualMutationIdempotency.clear(`archive-preview:${base.id}:preview_archive_retry_0001`);
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("response connection closed"))
      .mockResolvedValueOnce(jsonResponse({ version: committed.revision, document: committed }));

    await useDesignerStore.getState().approveArchiveReview();
    expect(useDesignerStore.getState()).toMatchObject({
      saveState: "review",
      archiveReview: { previewId: "preview_archive_retry_0001" },
      offline: true,
    });
    await useDesignerStore.getState().approveArchiveReview();

    expect(requestBody(fetch.mock.calls[1]!).idempotencyKey)
      .toBe(requestBody(fetch.mock.calls[0]!).idempotencyKey);
    expect(useDesignerStore.getState()).toMatchObject({
      baseVersion: committed.revision,
      saveState: "saved",
      archiveReview: null,
      offline: false,
    });
  });

  it("reuses the ordinary revision key after a lost response and clears it after success", async () => {
    const base = createStarterDocument({ preset: "phone", name: "Revision retry" });
    const frameId = base.pages[0]!.children[0]!;
    resetEditor(structuredClone(base));
    useDesignerStore.getState().updateNode(frameId, { name: "Retry-safe frame" });
    const committed = structuredClone(useDesignerStore.getState().document!);
    committed.revision = base.revision + 1;
    committed.updated_at = "2026-07-22T10:07:00.000Z";
    manualMutationIdempotency.clear(`revision:${base.id}`);
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("response connection closed"))
      .mockResolvedValueOnce(jsonResponse({ version: committed.revision, document: committed }))
      .mockResolvedValueOnce(jsonResponse({ version: committed.revision, document: committed }));

    await useDesignerStore.getState().save();
    expect(useDesignerStore.getState()).toMatchObject({
      pendingOperations: [{ type: "update_node", node_id: frameId }],
      saveState: "error",
      offline: true,
    });
    await useDesignerStore.getState().save();

    const firstKey = requestBody(fetch.mock.calls[0]!).idempotencyKey;
    expect(requestBody(fetch.mock.calls[1]!).idempotencyKey).toBe(firstKey);
    expect(useDesignerStore.getState()).toMatchObject({
      baseVersion: committed.revision,
      pendingOperations: [],
      saveState: "saved",
      offline: false,
    });

    resetEditor(structuredClone(base));
    useDesignerStore.getState().updateNode(frameId, { name: "Retry-safe frame" });
    await useDesignerStore.getState().save();
    expect(requestBody(fetch.mock.calls[2]!).idempotencyKey).not.toBe(firstKey);
  });
});
