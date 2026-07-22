import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clock3,
  Columns2,
  Copy,
  Eye,
  ExternalLink,
  GitCompareArrows,
  LoaderCircle,
  Maximize2,
  Play,
  RefreshCcw,
  ShieldAlert,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import { useMemo, useState, type CSSProperties } from "react";

import { nodeChildren, type DesignDocument, type DesignNode, type NodeId, type PageId } from "../domain";
import { persistedPreviewRenderUrl, type AgentTaskRecord, type DesignPreviewRecord } from "../lib/api";
import { NodeView } from "./Canvas";

export interface ChangedNodeSummary {
  id: string;
  name: string;
  type: string;
  change: "added" | "removed" | "modified";
}

export function changedNodeSummaries(
  baseDocument: DesignDocument,
  proposedDocument: DesignDocument,
  changedNodeIds: readonly string[],
): ChangedNodeSummary[] {
  return changedNodeIds.map((id) => {
    const base = baseDocument.nodes[id];
    const proposed = proposedDocument.nodes[id];
    const basePresent = Boolean(base && !base.archived);
    const proposedPresent = Boolean(proposed && !proposed.archived);
    return {
      id,
      name: proposed?.name ?? base?.name ?? id,
      type: proposed?.type ?? base?.type ?? "node",
      change: !basePresent && proposedPresent ? "added" : basePresent && !proposedPresent ? "removed" : "modified",
    };
  });
}

export function reviewPage(document: DesignDocument, requestedPageId: PageId | null): DesignDocument["pages"][number] | null {
  if (requestedPageId !== null) {
    return document.pages.find((page) => page.id === requestedPageId && !page.archived) ?? null;
  }
  return document.pages.find((page) => !page.archived) ?? null;
}

function visiblePageRoots(document: DesignDocument, pageId: PageId | null): DesignNode[] {
  const page = reviewPage(document, pageId);
  if (!page) return [];
  return page.children.flatMap((id) => {
    const node = document.nodes[id];
    return node && !node.archived && node.visible ? [node] : [];
  });
}

function documentBounds(document: DesignDocument, pageId: PageId | null) {
  const roots = visiblePageRoots(document, pageId);
  if (roots.length === 0) return null;
  const left = Math.min(...roots.map((node) => node.layout.x));
  const top = Math.min(...roots.map((node) => node.layout.y));
  const right = Math.max(...roots.map((node) => node.layout.x + node.layout.width));
  const bottom = Math.max(...roots.map((node) => node.layout.y + node.layout.height));
  return {
    roots,
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

function ReviewDocumentCanvas({
  document,
  pageId,
  highlightedIds,
  tone,
}: {
  document: DesignDocument;
  pageId: PageId | null;
  highlightedIds: ReadonlySet<NodeId>;
  tone: "before" | "after";
}) {
  const bounds = useMemo(() => documentBounds(document, pageId), [document, pageId]);
  if (!bounds) return <div className="agent-review-empty">This version has no visible frame on the selected page.</div>;
  const scale = Math.min(1, 680 / bounds.width, 470 / bounds.height);
  return (
    <div className="agent-review-document" data-review-tone={tone}>
      <div
        className="agent-review-document-scale"
        style={{ width: bounds.width * scale, height: bounds.height * scale }}
      >
        <div
          className="agent-review-document-world"
          style={{
            width: bounds.width,
            height: bounds.height,
            transform: `scale(${scale})`,
          }}
        >
          <div style={{ position: "absolute", left: -bounds.left, top: -bounds.top } as CSSProperties}>
            {bounds.roots.map((node) => (
              <NodeView
                key={node.id}
                document={document}
                nodeId={node.id}
                parentMode={null}
                interactive={false}
                highlightedIds={highlightedIds}
                reviewTone={tone}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function diagnosticIcon(severity: string) {
  if (severity === "error") return <XCircle size={12} />;
  if (severity === "warning") return <AlertTriangle size={12} />;
  return <CheckCircle2 size={12} />;
}

export type AgentConnectionViewState = "loading" | "active" | "pending" | "unavailable" | "restricted" | "error";
export type PreviewRenderStatus = "loading" | "available" | "unavailable";

export const FORMASPEC_AGENT_MENTION = "[@FormaSpec](plugin://formaspec@formaspec)";

export function exactPreviewCommitAllowed(
  canCommit: boolean,
  renderStatus: PreviewRenderStatus,
  hasPersistedRenderMetadata: boolean,
): boolean {
  return canCommit && hasPersistedRenderMetadata && renderStatus === "available";
}

export function AgentPreviewPng({
  preview,
  taskId,
  maxSize,
  alt,
  status,
  retryKey,
  busy = false,
  testId,
  onStatusChange,
  onRetry,
}: {
  preview: DesignPreviewRecord;
  taskId: string;
  maxSize: number;
  alt: string;
  status: PreviewRenderStatus;
  retryKey: number;
  busy?: boolean;
  testId?: string;
  onStatusChange: (status: PreviewRenderStatus) => void;
  onRetry: () => void;
}) {
  if (!preview.renderMetadata) {
    return (
      <div className="agent-preview-image-fallback" role="alert" data-testid={testId ? `${testId}-fallback` : undefined}>
        <AlertTriangle size={18} />
        <strong>Exact render evidence unavailable</strong>
        <span>This preview cannot be approved because it has no persisted PNG dimensions and SHA-256. Discard it and ask Codex to regenerate the proposal.</span>
      </div>
    );
  }
  if (status === "unavailable") {
    return (
      <div className="agent-preview-image-fallback" role="alert" data-testid={testId ? `${testId}-fallback` : undefined}>
        <AlertTriangle size={18} />
        <strong>Rendered PNG unavailable</strong>
        <span>Exact commit is disabled until the persisted PNG loads successfully. An awaiting-approval proposal can still be discarded safely.</span>
        <button type="button" className="button button-secondary" disabled={busy} onClick={onRetry}><RefreshCcw size={12} /> Retry PNG</button>
      </div>
    );
  }
  return (
    <img
      key={`${preview.previewId}:${retryKey}`}
      src={persistedPreviewRenderUrl(preview, maxSize, taskId, retryKey)}
      alt={alt}
      data-testid={testId}
      aria-busy={status === "loading"}
      onLoad={() => onStatusChange("available")}
      onError={() => onStatusChange("unavailable")}
    />
  );
}

export function agentTaskInstruction(task: AgentTaskRecord): string {
  return `${FORMASPEC_AGENT_MENTION}\n\nUse FormaSpec. Claim task ${task.id} with task_claim, call task_transition to move it to in_progress, and read its project context and selection. Call design_preview_changes, inspect its returned PNG in Codex, and call design_lint for that preview. Then call task_transition to awaiting_approval with data {"previewId":"<preview id>"}. Do not commit it; the website must show the exact PNG and human Commit button.`;
}

export function codexTaskLaunchUrl(task: AgentTaskRecord): string {
  const url = new URL("codex://new");
  url.searchParams.set("prompt", agentTaskInstruction(task));
  if (url.protocol !== "codex:" || url.hostname !== "new" || url.username || url.password || url.port || url.hash
    || [...url.searchParams.keys()].some((key) => key !== "prompt") || url.searchParams.getAll("prompt").length !== 1) {
    throw new Error("Could not create a strict Codex task link.");
  }
  return url.toString();
}

export function agentTaskStatusMessage(task: AgentTaskRecord | null): string {
  if (!task) return "Submit a design command to create an immutable agent task.";
  const latestMessage = task.transitions.at(-1)?.message?.trim();
  switch (task.status) {
    case "queued": return "Task created. Click Open task in Codex below so @FormaSpec can claim it.";
    case "claimed": return `Claimed${task.claimedBy ? ` by ${task.claimedBy}` : " by Codex"}; waiting for design work to start.`;
    case "in_progress": return latestMessage || "Codex is reading the brief and preparing an exact design preview.";
    case "awaiting_approval": return "Codex returned a persisted preview. Review it below, then commit or discard it.";
    case "completed": return "The exact preview was approved and the task is complete.";
    case "failed": return latestMessage || "The agent reported that it could not complete this task.";
    case "cancelled": return latestMessage || "This task was cancelled without changing design history.";
    case "expired": return latestMessage || "This task expired before it was completed.";
  }
}

export function agentTaskBriefSummary(brief: string, maxLength = 320): string {
  const normalized = brief.trim().replace(/\s+/g, " ");
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function taskStageState(task: AgentTaskRecord | null, stage: "queued" | "claimed" | "preview"): "idle" | "current" | "complete" | "error" {
  if (!task) return "idle";
  if (["failed", "cancelled", "expired"].includes(task.status)) return stage === "queued" ? "complete" : "error";
  if (stage === "queued") return task.status === "queued" ? "current" : "complete";
  if (stage === "claimed") {
    if (task.status === "claimed" || task.status === "in_progress") return "current";
    return ["awaiting_approval", "completed"].includes(task.status) ? "complete" : "idle";
  }
  if (task.status === "awaiting_approval") return "current";
  return task.status === "completed" ? "complete" : "idle";
}

export function AgentTaskWorkflowCard({
  connectionState,
  connectionMessage,
  task,
  preview,
  busy,
  actionError,
  canCommit,
  canDiscard,
  previewRenderStatus,
  previewRenderRetryKey,
  onCopyInstruction,
  onOpenCodex,
  onConnect,
  onRetry,
  onOpenReview,
  onCommit,
  onDiscard,
  onPreviewRenderStatusChange,
  onRetryPreviewRender,
  onOpenPlanning,
}: {
  connectionState: AgentConnectionViewState;
  connectionMessage: string;
  task: AgentTaskRecord | null;
  preview: DesignPreviewRecord | null;
  busy: boolean;
  actionError: string | null;
  canCommit: boolean;
  canDiscard: boolean;
  previewRenderStatus: PreviewRenderStatus;
  previewRenderRetryKey: number;
  onCopyInstruction: () => void;
  onOpenCodex: () => void;
  onConnect: () => void;
  onRetry: () => void;
  onOpenReview: () => void;
  onCommit: () => void;
  onDiscard: () => void;
  onPreviewRenderStatusChange: (status: PreviewRenderStatus) => void;
  onRetryPreviewRender: () => void;
  onOpenPlanning: () => void;
}) {
  const waiting = task && ["queued", "claimed", "in_progress"].includes(task.status);
  const terminalError = task && ["failed", "cancelled", "expired"].includes(task.status);
  const canLaunchInCodex = task && ["queued", "claimed", "in_progress"].includes(task.status);
  const canCommitExactPreview = exactPreviewCommitAllowed(
    canCommit,
    previewRenderStatus,
    Boolean(preview?.renderMetadata),
  );
  return (
    <aside className={`agent-task-workflow is-${task?.status ?? "idle"}`} aria-label="Agent task workflow">
      <header>
        <div><Bot size={15} /><span><strong>FormaSpec agent</strong><small>{connectionMessage}</small></span></div>
        <span className={`agent-connection-state is-${connectionState}`}>{connectionState.replaceAll("_", " ")}</span>
      </header>

      <div className="agent-task-stage-track" aria-label="Agent task progress">
        <span className={connectionState === "active" ? "is-complete" : connectionState === "loading" ? "is-current" : "is-error"}><i>1</i>Connected</span>
        <span className={`is-${taskStageState(task, "queued")}`}><i>2</i>Queued</span>
        <span className={`is-${taskStageState(task, "claimed")}`}><i>3</i>Claimed</span>
        <span className={`is-${taskStageState(task, "preview")}`}><i>4</i>Preview</span>
      </div>

      {!task ? (
        <div className="agent-task-empty">
          <Play size={18} />
          <strong>Ready for a design command</strong>
          <span>Submitting creates a durable task. FormaSpec never calls an AI API itself; an authorized Codex connection claims the task through MCP.</span>
          <div>
            {connectionState !== "active" && <button className="button button-secondary" onClick={onConnect}><ExternalLink size={12} /> Connect Codex to @FormaSpec</button>}
            <button className="button button-secondary" onClick={onOpenPlanning}>Open PM interview</button>
          </div>
        </div>
      ) : (
        <div className="agent-task-current">
          <div className="agent-task-current-heading">
            <span className={`is-${task.status}`}><Clock3 size={12} /> {task.status.replaceAll("_", " ")}</span>
            <code>{task.id}</code>
          </div>
          <p className={terminalError ? "is-error" : ""}>{agentTaskStatusMessage(task)}</p>
          <div className="agent-task-submitted-command" data-testid="agent-submitted-command">
            <strong>Submitted to @FormaSpec</strong>
            <span>{agentTaskBriefSummary(task.brief)}</span>
          </div>

          {preview ? (
            <div className="agent-task-inline-preview">
              <figure>
                <AgentPreviewPng
                  preview={preview}
                  taskId={task.id}
                  maxSize={720}
                  alt="FormaSpec rendered preview"
                  status={previewRenderStatus}
                  retryKey={previewRenderRetryKey}
                  busy={busy}
                  testId="agent-rendered-preview"
                  onStatusChange={onPreviewRenderStatusChange}
                  onRetry={onRetryPreviewRender}
                />
                <figcaption>
                  Version {preview.rootBaseVersion} → {preview.proposedVersion} · {preview.changedNodeIds.length} changed layer{preview.changedNodeIds.length === 1 ? "" : "s"}
                  {preview.renderMetadata ? ` · PNG ${preview.renderMetadata.width}×${preview.renderMetadata.height} · ${preview.renderMetadata.sha256.slice(0, 12)}` : ""}
                </figcaption>
              </figure>
              <div className="agent-task-preview-actions" role="group" aria-label="Agent preview approval actions">
                <button className="button button-secondary" disabled={busy || !canDiscard} onClick={onDiscard}><Trash2 size={12} /> Discard</button>
                <button className={`button ${preview.destructive ? "button-danger" : "button-primary"}`} disabled={busy || !canCommitExactPreview} onClick={onCommit}>
                  {busy ? <LoaderCircle size={13} className="spin" /> : <CheckCircle2 size={13} />} Commit exact preview
                </button>
              </div>
              <button className="agent-task-review-link" disabled={busy} onClick={onOpenReview}><GitCompareArrows size={12} /> Review before / after and diagnostics</button>
            </div>
          ) : waiting ? (
            <div className="agent-task-waiting"><LoaderCircle size={15} className="spin" /><span>The website will show the rendered preview here as soon as the agent requests approval.</span></div>
          ) : null}

          {actionError && <div className="agent-task-action-error"><AlertTriangle size={12} /><span>{actionError}</span><button onClick={onRetry}><RefreshCcw size={11} /> Retry</button></div>}

          {!preview && (
            <div className="agent-task-current-actions">
              {canLaunchInCodex && <button className="button button-primary" onClick={onOpenCodex}><ExternalLink size={12} /> Open task in Codex</button>}
              {connectionState !== "active" && <button className="button button-secondary" onClick={onConnect}><ExternalLink size={12} /> Connect or repair @FormaSpec</button>}
              {canLaunchInCodex && <button className="button button-secondary" onClick={onCopyInstruction}><Copy size={12} /> Copy Codex instruction</button>}
              <button className="button button-secondary" onClick={onRetry}><RefreshCcw size={12} /> Refresh status</button>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}

export function AgentPreviewReviewDialog({
  open,
  task,
  preview,
  baseDocument,
  activePageId,
  activePageIds,
  busy,
  actionError,
  baseMatchesHead,
  previewRenderStatus,
  onClose,
  onCommit,
  onDiscard,
  onRetryPreviewRender,
  presentation = "dialog",
  showActions = true,
}: {
  open: boolean;
  task: AgentTaskRecord;
  preview: DesignPreviewRecord;
  baseDocument: DesignDocument;
  activePageId: PageId | null;
  activePageIds?: readonly PageId[];
  busy: boolean;
  actionError: string | null;
  baseMatchesHead: boolean;
  previewRenderStatus: PreviewRenderStatus;
  onClose?: () => void;
  onCommit: () => void;
  onDiscard: () => void;
  onRetryPreviewRender: () => void;
  presentation?: "dialog" | "inline";
  showActions?: boolean;
}) {
  const [mode, setMode] = useState<"side-by-side" | "toggle">("side-by-side");
  const [visibleVersion, setVisibleVersion] = useState<"before" | "after">("after");
  const [highlightChanges, setHighlightChanges] = useState(true);
  const highlightedIds = useMemo(
    () => new Set<NodeId>(highlightChanges ? preview.changedNodeIds as NodeId[] : []),
    [highlightChanges, preview.changedNodeIds],
  );
  const changes = useMemo(
    () => changedNodeSummaries(baseDocument, preview.document, preview.changedNodeIds),
    [baseDocument, preview.changedNodeIds, preview.document],
  );
  const comparisonPageIds = useMemo<readonly (PageId | null)[]>(
    () => activePageIds && activePageIds.length > 0 ? activePageIds : [activePageId],
    [activePageId, activePageIds],
  );
  if (!open) return null;

  const canCommit = exactPreviewCommitAllowed(preview.canCommit
    && preview.status === "ready"
    && task.status === "awaiting_approval"
    && baseMatchesHead, previewRenderStatus, Boolean(preview.renderMetadata));
  const renderPane = (version: "before" | "after") => {
    const before = version === "before";
    return (
      <figure className={`agent-review-pane is-${version}`}>
        <figcaption>
          <span><strong>{before ? "Before" : "Proposed"}</strong><small>{before ? `Immutable version ${preview.rootBaseVersion}` : `Preview version ${preview.proposedVersion}`}</small></span>
          <span className="agent-review-hash">{(before ? preview.baseSnapshotHash : preview.resultSnapshotHash).slice(0, 12)}</span>
        </figcaption>
        <div className="agent-review-page-stack">
          {comparisonPageIds.map((pageId, index) => {
            const document = before ? baseDocument : preview.document;
            const page = pageId === null ? reviewPage(document, null) : document.pages.find((candidate) => candidate.id === pageId);
            return (
              <section key={pageId ?? `default-${index}`} className="agent-review-page-item">
                {comparisonPageIds.length > 1 && (
                  <div className="agent-review-page-label" title={page?.name ?? String(pageId ?? "Page")} dir="auto">
                    {page?.name ?? (before ? "Page not present in base" : "Page not present in proposal")}
                  </div>
                )}
                <ReviewDocumentCanvas
                  document={document}
                  pageId={pageId}
                  highlightedIds={highlightedIds}
                  tone={version}
                />
              </section>
            );
          })}
        </div>
      </figure>
    );
  };

  return (
    <div className={presentation === "dialog" ? "agent-review-backdrop" : "agent-review-inline"} role={presentation === "dialog" ? "presentation" : undefined}>
      <section
        className={`agent-review-dialog ${presentation === "inline" ? "is-inline" : ""}`}
        role={presentation === "dialog" ? "dialog" : "region"}
        aria-modal={presentation === "dialog" ? "true" : undefined}
        aria-labelledby="agent-review-title"
      >
        <header className="agent-review-header">
          <div className="agent-review-heading">
            <span><GitCompareArrows size={19} /></span>
            <div>
              <h2 id="agent-review-title">Review FormaSpec proposal</h2>
              <p>Task {task.id} produced an exact persisted preview. History remains unchanged until you commit it.</p>
            </div>
          </div>
          <div className="agent-review-header-actions">
            {preview.renderMetadata ? (
              <a
                className="button button-secondary"
                href={persistedPreviewRenderUrl(preview, 2048, task.id)}
                target="_blank"
                rel="noreferrer"
              ><Maximize2 size={12} /> Exact PNG</a>
            ) : (
              <button className="button button-secondary" disabled><Maximize2 size={12} /> Exact PNG unavailable</button>
            )}
            {presentation === "dialog" && <button className="icon-button" disabled={busy} onClick={onClose} aria-label="Close proposal review"><X size={16} /></button>}
          </div>
        </header>

        <div className="agent-review-toolbar">
          <div className="agent-review-version-pills">
            <span>Base v{preview.rootBaseVersion}</span>
            <span>Proposed v{preview.proposedVersion}</span>
            <span>{preview.changedNodeIds.length} changed layer{preview.changedNodeIds.length === 1 ? "" : "s"}</span>
            {preview.renderMetadata && <span>PNG {preview.renderMetadata.width}×{preview.renderMetadata.height} · {preview.renderMetadata.sha256.slice(0, 12)}</span>}
            <span className={`is-${preview.status}`}>{preview.status}</span>
          </div>
          <div className="agent-review-view-controls">
            <div className="spec-view-toggle" aria-label="Comparison layout">
              <button className={mode === "side-by-side" ? "is-active" : ""} onClick={() => setMode("side-by-side")}><Columns2 size={10} /> Side by side</button>
              <button className={mode === "toggle" ? "is-active" : ""} onClick={() => setMode("toggle")}><Eye size={10} /> Toggle</button>
            </div>
            {mode === "toggle" && (
              <div className="spec-view-toggle" aria-label="Visible proposal version">
                <button className={visibleVersion === "before" ? "is-active" : ""} onClick={() => setVisibleVersion("before")}>Before</button>
                <button className={visibleVersion === "after" ? "is-active" : ""} onClick={() => setVisibleVersion("after")}>Proposed</button>
              </div>
            )}
            <button className={`agent-review-highlight-toggle ${highlightChanges ? "is-active" : ""}`} onClick={() => setHighlightChanges((value) => !value)}>
              <i /> Highlight changes
            </button>
          </div>
        </div>

        <div className={`agent-review-comparison is-${mode}`}>
          {mode === "side-by-side" ? <>{renderPane("before")}{renderPane("after")}</> : renderPane(visibleVersion)}
        </div>

        <div className="agent-review-details">
          <section>
            <h3>Changed layers <span>{changes.length}</span></h3>
            <div className="agent-review-changes">
              {changes.length === 0 ? <p>No node-level changes were reported.</p> : changes.map((change) => (
                <div key={change.id} className={`is-${change.change}`}>
                  <i />
                  <span><strong>{change.name}</strong><small>{change.type} · {change.change}</small></span>
                  <code>{change.id}</code>
                </div>
              ))}
            </div>
          </section>
          <section>
            <h3>Diagnostics <span>{preview.diagnostics.length}</span></h3>
            <div className="agent-review-diagnostics">
              {preview.diagnostics.length === 0 ? (
                <p><CheckCircle2 size={12} /> No preview diagnostics.</p>
              ) : preview.diagnostics.map((diagnostic, index) => (
                <div key={`${diagnostic.code}-${diagnostic.nodeId ?? index}`} className={`is-${diagnostic.severity}`}>
                  {diagnosticIcon(diagnostic.severity)}
                  <span><strong>{diagnostic.code}</strong><small>{diagnostic.message}</small></span>
                  {diagnostic.nodeId && <code>{diagnostic.nodeId}</code>}
                </div>
              ))}
            </div>
          </section>
        </div>

        <footer className="agent-review-footer">
          <div>
            {actionError ? <span className="agent-review-action-error"><AlertTriangle size={12} /> {actionError}</span>
              : previewRenderStatus === "unavailable" ? <span className="agent-review-action-error"><AlertTriangle size={12} /> The rendered PNG is unavailable. Retry it before exact commit.</span>
                : previewRenderStatus === "loading" ? <span><LoaderCircle size={12} className="spin" /> Verifying the rendered PNG before exact commit…</span>
                  : !baseMatchesHead ? <span className="agent-review-action-error"><AlertTriangle size={12} /> The project head changed. Create a new preview; FormaSpec never auto-merges.</span>
                    : <span><CheckCircle2 size={12} /> Preview snapshot and hashes are persisted for exact commit.</span>}
          </div>
          {showActions && <div>
            <button className="button button-secondary" disabled={busy || task.status !== "awaiting_approval"} onClick={onDiscard}><Trash2 size={13} /> Discard proposal</button>
            {previewRenderStatus === "unavailable" && <button className="button button-secondary" disabled={busy} onClick={onRetryPreviewRender}><RefreshCcw size={13} /> Retry PNG</button>}
            <button
              className={`button ${preview.destructive ? "button-danger" : "button-primary"}`}
              disabled={busy || !canCommit}
              onClick={onCommit}
            >
              {busy ? <LoaderCircle size={14} className="spin" /> : preview.destructive ? <ShieldAlert size={14} /> : <CheckCircle2 size={14} />}
              {preview.destructive ? "Commit archive" : "Commit exact preview"}
            </button>
          </div>}
        </footer>
      </section>
    </div>
  );
}

export function PreviewDiagnosticsSummary({ preview }: { preview: DesignPreviewRecord | null }) {
  if (!preview) return <div className="product-panel-placeholder"><AlertTriangle size={18} /><strong>No agent preview yet</strong><span>Diagnostics appear after FormaSpec returns a persisted design preview for approval.</span></div>;
  const errors = preview.diagnostics.filter((item) => item.severity === "error").length;
  const warnings = preview.diagnostics.filter((item) => item.severity === "warning").length;
  return (
    <div className="preview-diagnostics-summary">
      <header><span><CheckCircle2 size={14} /><strong>Preview diagnostics</strong></span><small>{preview.status} · engine {preview.versions.commandEngine}</small></header>
      <div className="preview-diagnostic-counts"><span className="is-error"><strong>{errors}</strong>Errors</span><span className="is-warning"><strong>{warnings}</strong>Warnings</span><span><strong>{preview.diagnostics.length - errors - warnings}</strong>Info</span></div>
      <div className="preview-diagnostic-list">
        {preview.diagnostics.length === 0 ? <p>No structural or lint diagnostics were returned.</p> : preview.diagnostics.map((diagnostic, index) => <div key={`${diagnostic.code}-${index}`} className={`is-${diagnostic.severity}`}>{diagnosticIcon(diagnostic.severity)}<span><strong>{diagnostic.code}</strong><small>{diagnostic.message}</small></span></div>)}
      </div>
    </div>
  );
}

export function PreviewRevisionSummary({
  task,
  preview,
  previewRenderStatus,
  previewRenderRetryKey,
  onOpen,
  onPreviewRenderStatusChange,
  onRetryPreviewRender,
}: {
  task: AgentTaskRecord | null;
  preview: DesignPreviewRecord | null;
  previewRenderStatus: PreviewRenderStatus;
  previewRenderRetryKey: number;
  onOpen: () => void;
  onPreviewRenderStatusChange: (status: PreviewRenderStatus) => void;
  onRetryPreviewRender: () => void;
}) {
  if (!task || !preview) return <div className="product-panel-placeholder"><GitCompareArrows size={18} /><strong>No revision proposal ready</strong><span>When FormaSpec requests approval, the exact base/proposed versions and changed layers appear here.</span></div>;
  return (
    <div className="preview-revision-summary">
      <div className="preview-revision-thumbnail">
        <AgentPreviewPng
          preview={preview}
          taskId={task.id}
          maxSize={720}
          alt="FormaSpec proposed revision"
          status={previewRenderStatus}
          retryKey={previewRenderRetryKey}
          onStatusChange={onPreviewRenderStatusChange}
          onRetry={onRetryPreviewRender}
        />
      </div>
      <div className="preview-revision-copy">
        <span className="preview-revision-state"><i /> {task.status.replaceAll("_", " ")}</span>
        <h3>Version {preview.rootBaseVersion} → {preview.proposedVersion}</h3>
        <p>
          {preview.changedNodeIds.length} changed layer{preview.changedNodeIds.length === 1 ? "" : "s"} · {preview.diagnostics.length} diagnostic{preview.diagnostics.length === 1 ? "" : "s"}
          {preview.renderMetadata ? ` · PNG ${preview.renderMetadata.width}×${preview.renderMetadata.height} · ${preview.renderMetadata.sha256.slice(0, 12)}` : ""}
        </p>
        <dl><div><dt>Base hash</dt><dd>{preview.baseSnapshotHash.slice(0, 12)}</dd></div><div><dt>Preview hash</dt><dd>{preview.resultSnapshotHash.slice(0, 12)}</dd></div></dl>
        <button className="button button-primary" onClick={onOpen}><GitCompareArrows size={13} /> Review before / after</button>
      </div>
    </div>
  );
}

export function documentContainsChangedNode(document: DesignDocument, rootId: NodeId, changedIds: ReadonlySet<NodeId>): boolean {
  if (changedIds.has(rootId)) return true;
  const root = document.nodes[rootId];
  return Boolean(root && nodeChildren(root).some((childId) => documentContainsChangedNode(document, childId, changedIds)));
}
