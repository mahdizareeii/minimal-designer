import { createRectangleNode, createStarterDocument } from "@designer/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgentPreviewPng,
  AgentTaskWorkflowCard,
  agentTaskBriefSummary,
  agentTaskInstruction,
  agentTaskStatusMessage,
  changedNodeSummaries,
  codexTaskLaunchUrl,
  exactPreviewCommitAllowed,
} from "../components/AgentPreviewReview";
import { agentPreviewReadFailureDisposition, summarizeCodexConnection } from "../components/ProductBriefPanel";
import {
  ApiError,
  commitDesignPreview,
  persistedPreviewRenderUrl,
  previewRenderUrl,
  previewRenderContractOptions,
  readDesignPreview,
  taskPreviewId,
  type AgentTaskRecord,
} from "../lib/api";

function task(overrides: Partial<AgentTaskRecord> = {}): AgentTaskRecord {
  return {
    id: "task_review_0001",
    status: "awaiting_approval",
    designId: "document_review_0001",
    baseVersion: 4,
    brief: "Refine checkout",
    expectedOutput: "design_preview",
    selection: [],
    claimedBy: "agent_codex",
    createdBy: "local",
    createdAt: "2026-07-20T09:00:00.000Z",
    expiresAt: "2026-07-20T10:00:00.000Z",
    transitions: [
      {
        id: "transition_1",
        fromStatus: null,
        toStatus: "queued",
        actorId: "local",
        message: null,
        data: {},
        createdAt: "2026-07-20T09:00:00.000Z",
      },
      {
        id: "transition_2",
        fromStatus: "in_progress",
        toStatus: "awaiting_approval",
        actorId: "agent_codex",
        message: "Ready for review",
        data: { previewId: "preview_review_0001" },
        createdAt: "2026-07-20T09:05:00.000Z",
      },
    ],
    launchUrl: "codex://new?prompt=Use%20FormaSpec.%20Claim%20FormaSpec%20task%20task_review_0001.",
    ...overrides,
  };
}

function exactRenderMetadata() {
  return {
    options: { maxSize: 2_048 },
    width: 390,
    height: 844,
    renderer: "playwright" as const,
    warnings: [],
    sha256: "d".repeat(64),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("agent before/after review", () => {
  it("turns connection and task lifecycle state into actionable website guidance", () => {
    const activeConnection = {
      id: "connection_codex_0001",
      adapter: "codex" as const,
      displayName: "Codex — FormaSpec",
      status: "active" as const,
      scopes: ["task:claim"],
      projectIds: [],
      principalId: "principal_codex_0001",
      expiresAt: "2030-01-01T00:00:00.000Z",
      lastUsedAt: null,
      createdAt: "2026-07-20T09:00:00.000Z",
      updatedAt: "2026-07-20T09:00:00.000Z",
    };
    expect(summarizeCodexConnection([activeConnection], null, false, Date.parse("2026-07-20T09:00:00.000Z"))).toEqual({
      state: "active",
      message: "Connected and ready to claim tasks.",
    });
    expect(summarizeCodexConnection([], new ApiError("Forbidden", { status: 403, code: "FORBIDDEN" }), false).state).toBe("restricted");
    expect(agentTaskStatusMessage(task({ status: "queued" }))).toContain("Click Open task in Codex");
    expect(agentTaskInstruction(task())).toContain("[@FormaSpec](plugin://formaspec@formaspec)");
    expect(agentTaskInstruction(task())).toContain("Use FormaSpec.");
    expect(agentTaskInstruction(task())).toContain("Claim task task_review_0001 with task_claim");
    expect(agentTaskInstruction(task())).toContain('task_transition to awaiting_approval with data {"previewId":"<preview id>"}');
    expect(agentTaskInstruction(task())).toContain("Do not commit it");
    const launchUrl = new URL(codexTaskLaunchUrl(task()));
    expect(launchUrl.protocol).toBe("codex:");
    expect(launchUrl.hostname).toBe("new");
    expect([...launchUrl.searchParams.keys()]).toEqual(["prompt"]);
    expect(launchUrl.searchParams.get("prompt")).toContain("[@FormaSpec](plugin://formaspec@formaspec)");
    expect(launchUrl.searchParams.get("prompt")).toContain("task_review_0001");
    expect(codexTaskLaunchUrl(task())).toContain("%40FormaSpec");
    expect(agentTaskBriefSummary("  Build   a checkout\nflow  ")).toBe("Build a checkout flow");
    expect(agentTaskBriefSummary("x".repeat(400))).toHaveLength(320);
  });

  it("renders the returned PNG with Commit and Discard directly beneath it", () => {
    const document = createStarterDocument({ preset: "phone", name: "Inline review" });
    const preview = {
      previewId: "preview_review_0001",
      designId: document.id,
      rootBaseVersion: document.revision,
      proposedVersion: document.revision + 1,
      baseRevisionId: "revision_base",
      baseSnapshotHash: "a".repeat(64),
      operationHash: "b".repeat(64),
      resultSnapshotHash: "c".repeat(64),
      expiresAt: "2030-01-01T00:00:00.000Z",
      canCommit: true,
      destructive: false,
      kind: "ordinary" as const,
      status: "ready" as const,
      committedRevisionId: null,
      changedNodeIds: [document.pages[0]!.children[0]!],
      versions: { commandEngine: "2", renderer: "3", fontBundle: "1" },
      renderMetadata: exactRenderMetadata(),
      diagnostics: [],
      document,
    };
    const markup = renderToStaticMarkup(createElement(AgentTaskWorkflowCard, {
      connectionState: "active",
      connectionMessage: "Connected",
      task: task(),
      preview,
      busy: false,
      actionError: null,
      canCommit: true,
      canDiscard: true,
      previewRenderStatus: "available",
      previewRenderRetryKey: 0,
      onCopyInstruction: () => undefined,
      onOpenCodex: () => undefined,
      onConnect: () => undefined,
      onRetry: () => undefined,
      onOpenReview: () => undefined,
      onCommit: () => undefined,
      onDiscard: () => undefined,
      onPreviewRenderStatusChange: () => undefined,
      onRetryPreviewRender: () => undefined,
      onOpenPlanning: () => undefined,
    }));
    expect(markup).toContain("FormaSpec rendered preview");
    expect(markup).toContain("Submitted to @FormaSpec");
    expect(markup).toContain("Refine checkout");
    expect(markup).toContain("Agent preview approval actions");
    expect(markup).toContain("Commit exact preview");
    expect(markup).toContain("Discard");
    expect(markup.indexOf("FormaSpec rendered preview")).toBeLessThan(markup.indexOf("Commit exact preview"));
  });

  it("keeps task launch available when connection visibility is restricted", () => {
    const markup = renderToStaticMarkup(createElement(AgentTaskWorkflowCard, {
      connectionState: "restricted",
      connectionMessage: "Connection details require an administrator.",
      task: task({ status: "queued" }),
      preview: null,
      busy: false,
      actionError: null,
      canCommit: false,
      canDiscard: false,
      previewRenderStatus: "loading",
      previewRenderRetryKey: 0,
      onCopyInstruction: () => undefined,
      onOpenCodex: () => undefined,
      onConnect: () => undefined,
      onRetry: () => undefined,
      onOpenReview: () => undefined,
      onCommit: () => undefined,
      onDiscard: () => undefined,
      onPreviewRenderStatusChange: () => undefined,
      onRetryPreviewRender: () => undefined,
      onOpenPlanning: () => undefined,
    }));
    expect(markup).toContain("Open task in Codex");
    expect(markup).toContain("Click Open task in Codex below");
    expect(markup).toContain("Connect or repair @FormaSpec");
    expect(markup).toContain("Copy Codex instruction");
  });

  it("fails closed when the persisted preview PNG is unavailable while preserving safe discard", () => {
    const document = createStarterDocument({ preset: "phone", name: "Unavailable render" });
    const preview = {
      previewId: "preview_review_unavailable",
      designId: document.id,
      rootBaseVersion: document.revision,
      proposedVersion: document.revision + 1,
      baseRevisionId: "revision_base",
      baseSnapshotHash: "a".repeat(64),
      operationHash: "b".repeat(64),
      resultSnapshotHash: "c".repeat(64),
      expiresAt: "2030-01-01T00:00:00.000Z",
      canCommit: true,
      destructive: false,
      kind: "ordinary" as const,
      status: "ready" as const,
      committedRevisionId: null,
      changedNodeIds: [document.pages[0]!.children[0]!],
      versions: { commandEngine: "2", renderer: "3", fontBundle: "1" },
      renderMetadata: exactRenderMetadata(),
      diagnostics: [],
      document,
    };
    const markup = renderToStaticMarkup(createElement(AgentTaskWorkflowCard, {
      connectionState: "active",
      connectionMessage: "Connected",
      task: task(),
      preview,
      busy: false,
      actionError: null,
      canCommit: true,
      canDiscard: true,
      previewRenderStatus: "unavailable",
      previewRenderRetryKey: 2,
      onCopyInstruction: () => undefined,
      onOpenCodex: () => undefined,
      onConnect: () => undefined,
      onRetry: () => undefined,
      onOpenReview: () => undefined,
      onCommit: () => undefined,
      onDiscard: () => undefined,
      onPreviewRenderStatusChange: () => undefined,
      onRetryPreviewRender: () => undefined,
      onOpenPlanning: () => undefined,
    }));
    const discardButton = markup.match(/<button class="button button-secondary"[^>]*>[^<]*(?:<[^>]+>)*[^<]*Discard<\/button>/)?.[0] ?? "";
    const commitButton = markup.match(/<button class="button button-primary"[^>]*>[^<]*(?:<[^>]+>)*[^<]*Commit exact preview<\/button>/)?.[0] ?? "";
    expect(markup).toContain("Rendered PNG unavailable");
    expect(markup).toContain("Retry PNG");
    expect(markup).not.toContain("data-testid=\"agent-rendered-preview\"");
    expect(discardButton).not.toContain("disabled");
    expect(commitButton).toContain("disabled");
    expect(exactPreviewCommitAllowed(true, "unavailable", true)).toBe(false);
    expect(exactPreviewCommitAllowed(true, "loading", true)).toBe(false);
    expect(exactPreviewCommitAllowed(true, "available", false)).toBe(false);
    expect(exactPreviewCommitAllowed(true, "available", true)).toBe(true);
  });

  it("fails closed when a legacy preview has no persisted PNG evidence", () => {
    const document = createStarterDocument({ preset: "phone", name: "Legacy preview" });
    const preview = {
      previewId: "preview_review_legacy",
      designId: document.id,
      rootBaseVersion: document.revision,
      proposedVersion: document.revision + 1,
      baseRevisionId: "revision_base",
      baseSnapshotHash: "a".repeat(64),
      operationHash: "b".repeat(64),
      resultSnapshotHash: "c".repeat(64),
      expiresAt: "2099-01-01T00:00:00.000Z",
      canCommit: true,
      destructive: false,
      kind: "ordinary" as const,
      status: "ready" as const,
      committedRevisionId: null,
      changedNodeIds: [],
      versions: { commandEngine: "1", renderer: "1", fontBundle: "1" },
      diagnostics: [],
      document,
    };
    const markup = renderToStaticMarkup(createElement(AgentPreviewPng, {
      preview,
      taskId: "task_review_legacy",
      maxSize: 720,
      alt: "Legacy preview",
      status: "available",
      retryKey: 0,
      onStatusChange: () => undefined,
      onRetry: () => undefined,
    }));
    expect(markup).toContain("Exact render evidence unavailable");
    expect(markup).not.toContain("<img");
    expect(exactPreviewCommitAllowed(true, "available", false)).toBe(false);
  });

  it("restores the PNG element with a fresh URL when a failed render is retried", () => {
    const document = createStarterDocument({ preset: "phone", name: "Render retry" });
    const preview = {
      previewId: "preview_review_retry",
      designId: document.id,
      rootBaseVersion: document.revision,
      proposedVersion: document.revision + 1,
      baseRevisionId: "revision_base",
      baseSnapshotHash: "a".repeat(64),
      operationHash: "b".repeat(64),
      resultSnapshotHash: "c".repeat(64),
      expiresAt: "2030-01-01T00:00:00.000Z",
      canCommit: true,
      destructive: false,
      kind: "ordinary" as const,
      status: "ready" as const,
      committedRevisionId: null,
      changedNodeIds: [],
      versions: { commandEngine: "2", renderer: "3", fontBundle: "1" },
      renderMetadata: exactRenderMetadata(),
      diagnostics: [],
      document,
    };
    const failed = renderToStaticMarkup(createElement(AgentPreviewPng, {
      preview,
      taskId: "task_review_0001",
      maxSize: 720,
      alt: "FormaSpec rendered preview",
      status: "unavailable",
      retryKey: 4,
      onStatusChange: () => undefined,
      onRetry: () => undefined,
    }));
    const retrying = renderToStaticMarkup(createElement(AgentPreviewPng, {
      preview,
      taskId: "task_review_0001",
      maxSize: 720,
      alt: "FormaSpec rendered preview",
      status: "loading",
      retryKey: 5,
      onStatusChange: () => undefined,
      onRetry: () => undefined,
    }));
    expect(failed).toContain("Rendered PNG unavailable");
    expect(failed).not.toContain("<img");
    expect(retrying).toContain("<img");
    expect(retrying).toContain("_retry=5");
    expect(retrying).toContain("aria-busy=\"true\"");
  });

  it("clears stale approval state and gives actionable expiry recovery", () => {
    expect(agentPreviewReadFailureDisposition(new ApiError("Expired", { code: "PREVIEW_EXPIRED", status: 410 }))).toEqual({
      clearReview: true,
      closeDialog: true,
      message: expect.stringMatching(/expired.*new preview/i),
    });
    expect(agentPreviewReadFailureDisposition(new ApiError("Expired", { code: "TASK_EXPIRED", status: 410 }))).toEqual({
      clearReview: true,
      closeDialog: true,
      message: expect.stringMatching(/expired.*new Codex task/i),
    });
    expect(agentPreviewReadFailureDisposition(new Error("Renderer disconnected"))).toEqual({
      clearReview: true,
      closeDialog: true,
      message: expect.stringMatching(/stale approval controls were cleared.*retry/i),
    });
  });

  it("resolves only the newest persisted design preview reference from task transitions", () => {
    const record = task({
      transitions: [
        ...task().transitions,
        {
          id: "transition_3",
          fromStatus: "awaiting_approval",
          toStatus: "in_progress",
          actorId: "agent_codex",
          message: "Refining",
          data: { previewId: "preview_review_0002" },
          createdAt: "2026-07-20T09:06:00.000Z",
        },
      ],
    });
    expect(taskPreviewId(record)).toBe("preview_review_0002");
    expect(taskPreviewId({ ...record, expectedOutput: "design_commit" })).toBeNull();
  });

  it("classifies changed nodes for review highlighting", () => {
    const base = createStarterDocument({ preset: "phone", name: "Review" });
    const proposed = structuredClone(base);
    const frameId = base.pages[0]!.children[0]!;
    proposed.nodes[frameId]!.name = "Refined checkout";

    const removed = createRectangleNode({ name: "Legacy badge" });
    const added = createRectangleNode({ name: "New summary" });
    base.nodes[removed.id] = removed;
    const baseFrame = base.nodes[frameId];
    if (!baseFrame || baseFrame.type !== "frame") throw new Error("Expected starter frame");
    baseFrame.children.push(removed.id);
    proposed.nodes[removed.id] = { ...removed, archived: true };
    proposed.nodes[added.id] = added;
    const proposedFrame = proposed.nodes[frameId];
    if (!proposedFrame || proposedFrame.type !== "frame") throw new Error("Expected proposed frame");
    proposedFrame.children.push(added.id);

    expect(changedNodeSummaries(base, proposed, [frameId, removed.id, added.id])).toEqual([
      expect.objectContaining({ id: frameId, name: "Refined checkout", change: "modified" }),
      expect.objectContaining({ id: removed.id, name: "Legacy badge", change: "removed" }),
      expect.objectContaining({ id: added.id, name: "New summary", change: "added" }),
    ]);
  });

  it("uses the task-scoped preview read, render, and exact commit contracts", async () => {
    const document = createStarterDocument({ preset: "phone", name: "Review API" });
    const pageId = document.pages[0]!.id;
    const frameId = document.pages[0]!.children[0]!;
    const renderMetadata = {
      options: { pageId, nodeId: frameId, maxSize: 512 },
      width: 360,
      height: 512,
      renderer: "playwright",
      warnings: [],
      sha256: "d".repeat(64),
    };
    const previewResponse = {
      previewId: "preview_review_0001",
      designId: document.id,
      rootBaseVersion: document.revision,
      baseRevisionId: "revision_base",
      baseSnapshotHash: "a".repeat(64),
      operationHash: "b".repeat(64),
      resultSnapshotHash: "c".repeat(64),
      expiresAt: "2026-07-20T10:00:00.000Z",
      canCommit: true,
      destructive: false,
      kind: "ordinary",
      status: "ready",
      committedRevisionId: null,
      changedNodeIds: [document.pages[0]!.children[0]!],
      versions: { commandEngine: "1", renderer: "1", fontBundle: "1" },
      renderMetadata,
      diagnostics: [{ severity: "warning", code: "RAW_VALUE", message: "Use a token", node_id: document.pages[0]!.children[0]! }],
      document,
    };
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify(previewResponse), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        version: document.revision + 1,
        revisionId: "revision_committed",
        document: { ...document, revision: document.revision + 1 },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));

    const preview = await readDesignPreview(document.id, "preview_review_0001", "task_review_0001");
    expect(preview.proposedVersion).toBe(document.revision + 1);
    expect(preview.diagnostics[0]).toMatchObject({ code: "RAW_VALUE", nodeId: document.pages[0]!.children[0] });
    expect(preview.renderMetadata).toEqual(renderMetadata);
    expect(String(fetch.mock.calls[0]?.[0])).toContain("taskId=task_review_0001");

    const adHocRenderUrl = new URL(
      previewRenderUrl(document.id, preview.previewId, 720, "task_review_0001"),
      "http://formaspec.local",
    );
    expect(Object.fromEntries(adHocRenderUrl.searchParams)).toEqual({
      mode: "adhoc",
      maxSize: "720",
      taskId: "task_review_0001",
    });
    expect(previewRenderContractOptions(preview, 720)).toEqual(renderMetadata.options);
    const exactRenderUrl = new URL(persistedPreviewRenderUrl(preview, 720, "task_review_0001", 7), "http://formaspec.local");
    expect(Object.fromEntries(exactRenderUrl.searchParams)).toEqual({
      taskId: "task_review_0001",
      _retry: "7",
    });
    const legacyRenderUrl = new URL(persistedPreviewRenderUrl({
      designId: preview.designId,
      previewId: preview.previewId,
    }, 720, "task_review_0001", 8), "http://formaspec.local");
    expect(Object.fromEntries(legacyRenderUrl.searchParams)).toEqual({
      mode: "adhoc",
      maxSize: "720",
      taskId: "task_review_0001",
      _retry: "8",
    });
    const committed = await commitDesignPreview({
      designId: document.id,
      previewId: preview.previewId,
      taskId: "task_review_0001",
      expectedBaseVersion: document.revision,
      idempotencyKey: "agent-preview-commit-0001",
      message: "Approve exact preview",
      kind: "ordinary",
    });
    expect(committed.version).toBe(document.revision + 1);
    const commitInit = fetch.mock.calls[1]?.[1];
    expect(JSON.parse(String(commitInit?.body))).toMatchObject({
      expectedBaseVersion: document.revision,
      taskId: "task_review_0001",
      idempotencyKey: "agent-preview-commit-0001",
    });
  });

  it("rejects malformed persisted render evidence instead of showing a non-exact fallback", async () => {
    const document = createStarterDocument({ preset: "phone", name: "Invalid render evidence" });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      previewId: "preview_review_invalid_render",
      designId: document.id,
      rootBaseVersion: document.revision,
      baseRevisionId: "revision_base",
      baseSnapshotHash: "a".repeat(64),
      operationHash: "b".repeat(64),
      resultSnapshotHash: "c".repeat(64),
      expiresAt: "2030-01-01T00:00:00.000Z",
      canCommit: true,
      destructive: false,
      kind: "ordinary",
      status: "ready",
      committedRevisionId: null,
      changedNodeIds: [],
      versions: { commandEngine: "1", renderer: "1", fontBundle: "1" },
      renderMetadata: {
        options: { maxSize: 512 },
        width: 360,
        height: 512,
        renderer: "playwright",
        warnings: [],
        sha256: "not-a-png-hash",
      },
      diagnostics: [],
      document,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    await expect(readDesignPreview(document.id, "preview_review_invalid_render", "task_review_0001")).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: expect.stringContaining("exact PNG review is unavailable"),
    });
  });
});
