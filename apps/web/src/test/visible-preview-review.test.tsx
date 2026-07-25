import { createStarterDocument } from "@designer/core";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { applicationRoute } from "../App";
import { AgentPreviewReviewDialog, reviewPage } from "../components/AgentPreviewReview";
import {
  DesignReadinessReportCard,
  previewReviewFailureMessage,
  validatePreviewReviewTarget,
} from "../components/PreviewReviewPage";
import type { PageId } from "../domain";
import {
  designPreviewReviewPath,
  ApiError,
  readDesignPreview,
  readAgentTask,
  subscribeToEvents,
  type AgentTaskRecord,
  type DesignPreviewRecord,
} from "../lib/api";
import { canApplyDesignRefresh, hasUnsavedDesignerChanges } from "../store/designer-store";

function reviewTask(documentId: string, previewId: string): AgentTaskRecord {
  return {
    id: "task_exact_review_0001",
    status: "awaiting_approval",
    designId: documentId,
    baseVersion: 1,
    brief: "Create a professional checkout",
    expectedOutput: "design_preview",
    selection: [],
    claimedBy: "agent_codex",
    createdBy: "local",
    createdAt: "2026-07-22T08:00:00.000Z",
    expiresAt: "2030-07-22T09:00:00.000Z",
    transitions: [{
      id: "transition_preview_0001",
      fromStatus: "in_progress",
      toStatus: "awaiting_approval",
      actorId: "agent_codex",
      message: "Ready for human review",
      data: { previewId },
      createdAt: "2026-07-22T08:05:00.000Z",
    }],
    launchUrl: "codex://new?prompt=Use%20FormaSpec",
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("visible exact preview review", () => {
  it("routes an exact preview separately from the committed project head", () => {
    expect(applicationRoute(
      "/design/document_review_0001/previews/preview_review_0001/review",
      `?task=task_review_0001&store=store_${"a".repeat(32)}`,
    )).toEqual({
      kind: "preview-review",
      designId: "document_review_0001",
      previewId: "preview_review_0001",
      taskId: "task_review_0001",
      storeId: `store_${"a".repeat(32)}`,
    });
    expect(designPreviewReviewPath("document a", "preview/b", "task c", `store_${"b".repeat(32)}`)).toBe(
      `/design/document%20a/previews/preview%2Fb/review?task=task+c&store=store_${"b".repeat(32)}`,
    );
    expect(applicationRoute("/design/document_review_0001", "?task=task_review_0001")).toEqual({
      kind: "design",
      designId: "document_review_0001",
    });
  });

  it("keeps the exact review route available as safe committed-head agent context", () => {
    const reviewSource = readFileSync(new URL("../components/PreviewReviewPage.tsx", import.meta.url), "utf8");

    expect(reviewSource).toContain("committedReviewProjectContext");
    expect(reviewSource).toContain("useProjectContextPresence(committedHeadContext)");
    expect(reviewSource).toContain('data-testid="preview-project-context-presence"');
    expect(reviewSource).toContain("state.headDocument");
  });

  it("rejects a task that silently switches projects or previews", () => {
    const task = reviewTask("document_review_0001", "preview_review_0001");
    expect(() => validatePreviewReviewTarget("document_review_0001", "preview_review_0001", task)).not.toThrow();
    expect(() => validatePreviewReviewTarget("document_other_0001", "preview_review_0001", task)).toThrow(/does not belong/i);
    expect(() => validatePreviewReviewTarget("document_review_0001", "preview_other_0001", task)).toThrow(/does not reference/i);
  });

  it("explains offline and wrong-data-store review failures instead of leaving a blank page", () => {
    expect(previewReviewFailureMessage(new ApiError("network", { code: "NETWORK_ERROR" }))).toMatch(/offline/i);
    expect(previewReviewFailureMessage(new ApiError("store", { code: "DATA_STORE_MISMATCH", status: 409 })))
      .toMatch(/another FormaSpec data store/i);
    expect(previewReviewFailureMessage(new ApiError("expired", { code: "PREVIEW_EXPIRED", status: 410 })))
      .toMatch(/expired/i);
    expect(previewReviewFailureMessage(new ApiError("missing", { code: "PREVIEW_ENGINE_MISMATCH", status: 409 })))
      .toMatch(/persisted PNG is missing/i);
    expect(previewReviewFailureMessage(new ApiError("stale", { code: "VERSION_CONFLICT", status: 409 })))
      .toMatch(/project changed/i);
    expect(previewReviewFailureMessage(new ApiError("auth", { code: "AUTH_REQUIRED", status: 401 })))
      .toMatch(/Sign in/i);
    expect(previewReviewFailureMessage(new ApiError("missing task", { code: "NOT_FOUND", status: 404 })))
      .toMatch(/project, task, or preview is unavailable/i);
    expect(previewReviewFailureMessage(new ApiError("committed", { code: "PREVIEW_ALREADY_COMMITTED", status: 409 })))
      .toMatch(/already committed/i);
    expect(previewReviewFailureMessage(new ApiError("discarded", { code: "PREVIEW_NOT_COMMITTABLE", status: 409 })))
      .toMatch(/discarded/i);
  });

  it("renders before/after review inline without an automatic approval modal", () => {
    const document = createStarterDocument({ preset: "phone", name: "Exact review" });
    const previewId = "preview_exact_review_0001";
    const task = reviewTask(document.id, previewId);
    const preview: DesignPreviewRecord = {
      previewId,
      designId: document.id,
      rootBaseVersion: 1,
      proposedVersion: 2,
      baseRevisionId: "revision_base_0001",
      baseSnapshotHash: "a".repeat(64),
      operationHash: "b".repeat(64),
      resultSnapshotHash: "c".repeat(64),
      expiresAt: "2030-07-22T09:00:00.000Z",
      canCommit: true,
      destructive: false,
      kind: "ordinary",
      status: "ready",
      committedRevisionId: null,
      changedNodeIds: [document.pages[0]!.children[0]!],
      versions: { commandEngine: "3", renderer: "3", fontBundle: "1" },
      renderMetadata: {
        options: { maxSize: 2_048 },
        width: 390,
        height: 844,
        renderer: "playwright",
        warnings: [],
        sha256: "d".repeat(64),
      },
      diagnostics: [],
      document,
    };
    const markup = renderToStaticMarkup(
      <AgentPreviewReviewDialog
        open
        presentation="inline"
        showActions={false}
        task={task}
        preview={preview}
        baseDocument={document}
        activePageId={document.pages[0]!.id}
        busy={false}
        actionError={null}
        baseMatchesHead
        previewRenderStatus="available"
        onCommit={() => undefined}
        onDiscard={() => undefined}
        onRetryPreviewRender={() => undefined}
      />,
    );
    expect(markup).toContain('class="agent-review-inline"');
    expect(markup).toContain('role="region"');
    expect(markup).not.toContain('aria-modal="true"');
    expect(markup).toContain("Before");
    expect(markup).toContain("Proposed");
    expect(markup).not.toContain("Discard proposal");
  });

  it("shows the immutable senior readiness report on the exact approval surface", () => {
    const task = reviewTask("document_review_0001", "preview_review_0001");
    task.product = { id: "product_review_0001", name: "Checkout Product", status: "active" };
    task.resolvedContext = {
      schemaVersion: 1,
      product: { ...task.product, updatedAt: "2026-07-22T08:00:00.000Z" },
      design: { id: task.designId, version: 1, revisionId: "revision_review_0001" },
      productSpecification: {
        designId: task.designId,
        version: 4,
        specificationHash: "a".repeat(64),
      },
      designSystem: {
        source: "product_default",
        designSystemId: "design_system_review_0001",
        releaseId: "release_review_0001",
        releaseVersion: 3,
      },
      repositoryInventories: [{ id: "inventory_review_0001", inventoryHash: "b".repeat(64) }],
      locale: "fa-IR",
      direction: "rtl",
      platform: "phone",
      capturedAt: "2026-07-22T08:00:00.000Z",
    };
    task.readiness = {
      schemaVersion: 1,
      requestClassification: "refine",
      selected: { productId: task.product.id, designId: task.designId, baseVersion: 1 },
      productSpecification: { version: 4, specificationHash: "a".repeat(64) },
      designSystem: { source: "product_default", releaseId: "release_review_0001", releaseVersion: 3 },
      components: {
        reused: [{ componentDefinitionId: "component_button_review_0001", version: 2, reason: "Uses the approved primary action." }],
        extended: [],
        proposed: [{ key: "checkout.summary", name: "Checkout summary", reason: "No released component satisfies the business rules." }],
      },
      platforms: ["phone"],
      repositoryMappingsConsidered: [{ inventoryId: "inventory_review_0001", inventoryHash: "b".repeat(64) }],
      assumptions: ["Guest checkout remains supported."],
      blockers: [],
      checks: {
        hierarchy: "pass",
        visualConsistency: "pass",
        interactionStates: "warning",
        accessibility: "pass",
        touchTargets: "pass",
        rtlLocalization: "pass",
        responsiveVariants: "warning",
        prototypeCoverage: "pass",
        engineeringFeasibility: "pass",
        lint: "pass",
      },
    };

    const markup = renderToStaticMarkup(<DesignReadinessReportCard task={task} designName="Checkout mobile" />);
    expect(markup).toContain("FormaSpec readiness report");
    expect(markup).toContain("Checkout Product");
    expect(markup).toContain("Checkout mobile");
    expect(markup).toContain("Specification");
    expect(markup).toContain("release_review_0001");
    expect(markup).toContain("Checkout summary");
    expect(markup).toContain("RTL / localization");
    expect(markup).toContain("Responsive variants");
    expect(markup).toContain("Guest checkout remains supported.");
  });

  it("keeps Before empty when the proposal creates a newly selected page", () => {
    const base = createStarterDocument({ preset: "phone", name: "New page review" });
    const proposed = structuredClone(base);
    const newPageId = "page_new_preview_review_0001" as PageId;
    proposed.pages.push({
      id: newPageId,
      name: "New proposal page",
      children: [],
      background: "#ffffff",
      archived: false,
      metadata: {},
    });
    expect(reviewPage(base, newPageId)).toBeNull();
    expect(reviewPage(proposed, newPageId)).toMatchObject({ id: newPageId });
  });

  it("parses and displays every page from an exact contact-sheet review", async () => {
    const base = createStarterDocument({ preset: "phone", name: "Contact sheet review" });
    const secondPageId = "page_contact_sheet_review_0001" as PageId;
    const proposed = structuredClone(base);
    proposed.pages.push({
      id: secondPageId,
      name: "Second changed page",
      children: [],
      background: "#f8fafc",
      archived: false,
      metadata: {},
    });
    const firstPageId = proposed.pages[0]!.id;
    const previewId = "preview_contact_sheet_review_0001";
    const response = {
      previewId,
      designId: proposed.id,
      rootBaseVersion: 1,
      baseRevisionId: "revision_contact_sheet_base",
      baseSnapshotHash: "a".repeat(64),
      operationHash: "b".repeat(64),
      resultSnapshotHash: "c".repeat(64),
      expiresAt: "2030-07-22T09:00:00.000Z",
      canCommit: true,
      destructive: false,
      kind: "ordinary",
      status: "ready",
      committedRevisionId: null,
      changedNodeIds: [proposed.pages[0]!.children[0]!],
      versions: { commandEngine: "3", renderer: "3", fontBundle: "1" },
      renderMetadata: {
        options: { pageIds: [firstPageId, secondPageId], maxSize: 512 },
        width: 390,
        height: 512,
        renderer: "playwright",
        warnings: ["Rendered 2 changed pages as one exact contact sheet."],
        sha256: "d".repeat(64),
      },
      diagnostics: [],
      document: proposed,
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const preview = await readDesignPreview(proposed.id, previewId, "task_contact_sheet_review_0001");
    expect(preview.renderMetadata?.options.pageIds).toEqual([firstPageId, secondPageId]);

    const markup = renderToStaticMarkup(
      <AgentPreviewReviewDialog
        open
        presentation="inline"
        showActions={false}
        task={reviewTask(proposed.id, previewId)}
        preview={preview}
        baseDocument={base}
        activePageId={firstPageId}
        activePageIds={[firstPageId, secondPageId]}
        busy={false}
        actionError={null}
        baseMatchesHead
        previewRenderStatus="available"
        onCommit={() => undefined}
        onDiscard={() => undefined}
        onRetryPreviewRender={() => undefined}
      />,
    );
    expect(markup).toContain("Second changed page");
    expect(markup).toContain("Page not present in base");
    expect(markup.match(/agent-review-page-item/g)).toHaveLength(4);
  });

  it("reads task launch and website focus links without exposing a token", async () => {
    const response = {
      task: reviewTask("document_review_0001", "preview_review_0001"),
      launchUrl: "codex://new?prompt=Use%20FormaSpec",
      websiteTaskLink: "http://127.0.0.1:4310/design/document_review_0001?task=task_exact_review_0001",
      reviewDeepLink: "http://127.0.0.1:4310/design/document_review_0001/previews/preview_review_0001/review?task=task_exact_review_0001",
    };
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const task = await readAgentTask("task_exact_review_0001");
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/agent-tasks/task_exact_review_0001");
    expect(task.websiteTaskLink).toContain("?task=task_exact_review_0001");
    expect(task.reviewDeepLink).toContain("/previews/preview_review_0001/review");
    expect(JSON.stringify(task)).not.toMatch(/bearer|token/i);
  });

  it("treats an unsaved product brief as workspace dirtiness and parses same-version archive events", () => {
    expect(hasUnsavedDesignerChanges({
      saving: false,
      pendingOperations: [],
      saveState: "saved",
      archiveReview: null,
      conflictRecovery: null,
      productBriefGuard: {
        designId: "document_review_0001",
        draft: "Changed brief",
        persisted: "Saved brief",
        dirty: true,
        saving: false,
        save: async () => undefined,
        discard: () => undefined,
      },
    })).toBe(true);

    const listeners = new Map<string, EventListener>();
    class TestEventSource {
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      addEventListener(type: string, listener: EventListener): void { listeners.set(type, listener); }
      close(): void {}
    }
    vi.stubGlobal("EventSource", TestEventSource);
    const events: Array<{ archived?: boolean; version?: number }> = [];
    const unsubscribe = subscribeToEvents((event) => events.push(event));
    listeners.get("design.updated")?.({
      type: "design.updated",
      data: JSON.stringify({ type: "design.updated", designId: "document_review_0001", version: 4, archived: true }),
    } as MessageEvent<string>);
    expect(events).toEqual([expect.objectContaining({ archived: true, version: 4 })]);
    unsubscribe();

    expect(canApplyDesignRefresh({
      document: { id: "document_review_0001" },
      archivedDesignState: null,
    }, "document_review_0001")).toBe(true);
    expect(canApplyDesignRefresh({
      document: null,
      archivedDesignState: { designId: "document_review_0001" },
    }, "document_review_0001")).toBe(false);
    expect(canApplyDesignRefresh({
      document: { id: "document_review_0001" },
      archivedDesignState: { designId: "document_review_0001" },
    }, "document_review_0001")).toBe(false);
  });

  it("does not create agent tasks from the website or open archive approval automatically", () => {
    const briefSource = readFileSync(new URL("../components/ProductBriefPanel.tsx", import.meta.url), "utf8");
    const apiSource = readFileSync(new URL("../lib/api.ts", import.meta.url), "utf8");
    const editorSource = readFileSync(new URL("../components/Editor.tsx", import.meta.url), "utf8");
    expect(briefSource).not.toContain("Submit to @FormaSpec");
    expect(briefSource).not.toContain("createAgentTask");
    expect(briefSource).not.toContain("await saveDesign()");
    expect(apiSource).not.toContain("export async function createAgentTask");
    expect(briefSource).toContain("start agent work from Codex or the CLI");
    expect(editorSource).not.toContain("setArchiveDialogOpen(true)");
    expect(editorSource).toContain("Archive preview approval actions");
    expect(editorSource).toContain("Commit archive");
    expect(editorSource).toContain("Discard preview");
  });
});
