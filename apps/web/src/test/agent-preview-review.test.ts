import { createRectangleNode, createStarterDocument } from "@designer/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgentTaskWorkflowCard,
  agentTaskInstruction,
  agentTaskStatusMessage,
  changedNodeSummaries,
  codexTaskLaunchUrl,
} from "../components/AgentPreviewReview";
import { summarizeCodexConnection } from "../components/ProductBriefPanel";
import {
  ApiError,
  commitDesignPreview,
  previewRenderUrl,
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
    launchUrl: "formaspec://connect-agent?task=task_review_0001",
    ...overrides,
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
      displayName: "Codex — Minimal UI",
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
    expect(agentTaskStatusMessage(task({ status: "queued" }))).toContain("not claimed");
    expect(agentTaskInstruction(task())).toContain("[@Minimal UI](plugin://minimal-ui@formaspec)");
    expect(agentTaskInstruction(task())).toContain("Claim FormaSpec task task_review_0001");
    const launchUrl = new URL(codexTaskLaunchUrl(task()));
    expect(launchUrl.protocol).toBe("codex:");
    expect(launchUrl.hostname).toBe("new");
    expect([...launchUrl.searchParams.keys()]).toEqual(["prompt"]);
    expect(launchUrl.searchParams.get("prompt")).toContain("[@Minimal UI](plugin://minimal-ui@formaspec)");
    expect(launchUrl.searchParams.get("prompt")).toContain("task_review_0001");
    expect(codexTaskLaunchUrl(task())).toContain("%40Minimal+UI");
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
      onCopyInstruction: () => undefined,
      onOpenCodex: () => undefined,
      onConnect: () => undefined,
      onRetry: () => undefined,
      onOpenReview: () => undefined,
      onCommit: () => undefined,
      onDiscard: () => undefined,
      onOpenPlanning: () => undefined,
    }));
    expect(markup).toContain("Minimal UI rendered preview");
    expect(markup).toContain("Agent preview approval actions");
    expect(markup).toContain("Commit exact preview");
    expect(markup).toContain("Discard");
    expect(markup.indexOf("Minimal UI rendered preview")).toBeLessThan(markup.indexOf("Commit exact preview"));
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
      onCopyInstruction: () => undefined,
      onOpenCodex: () => undefined,
      onConnect: () => undefined,
      onRetry: () => undefined,
      onOpenReview: () => undefined,
      onCommit: () => undefined,
      onDiscard: () => undefined,
      onOpenPlanning: () => undefined,
    }));
    expect(markup).toContain("Open in Codex");
    expect(markup).toContain("Connect or repair Codex");
    expect(markup).toContain("Copy Codex instruction");
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
    expect(String(fetch.mock.calls[0]?.[0])).toContain("taskId=task_review_0001");

    expect(previewRenderUrl(document.id, preview.previewId, 720, "task_review_0001")).toContain("taskId=task_review_0001");
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
});
