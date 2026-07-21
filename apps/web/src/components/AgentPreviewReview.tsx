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
import { previewRenderUrl, type AgentTaskRecord, type DesignPreviewRecord } from "../lib/api";
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

function reviewPage(document: DesignDocument, requestedPageId: PageId | null): DesignDocument["pages"][number] | null {
  return document.pages.find((page) => page.id === requestedPageId && !page.archived)
    ?? document.pages.find((page) => !page.archived)
    ?? null;
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

export function agentTaskInstruction(task: AgentTaskRecord): string {
  return `[@Minimal UI](plugin://minimal-ui@formaspec)\n\nUse Minimal UI. Claim FormaSpec task ${task.id}, read its project context and selection, preview the requested design, inspect the rendered result, run linting, and return the exact persisted preview for website approval.`;
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
    case "queued": return "Task created. Codex has not claimed it yet.";
    case "claimed": return `Claimed${task.claimedBy ? ` by ${task.claimedBy}` : " by Codex"}; waiting for design work to start.`;
    case "in_progress": return latestMessage || "Codex is reading the brief and preparing an exact design preview.";
    case "awaiting_approval": return "Codex returned a persisted preview. Review it below, then commit or discard it.";
    case "completed": return "The exact preview was approved and the task is complete.";
    case "failed": return latestMessage || "The agent reported that it could not complete this task.";
    case "cancelled": return latestMessage || "This task was cancelled without changing design history.";
    case "expired": return latestMessage || "This task expired before it was completed.";
  }
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
  onCopyInstruction,
  onOpenCodex,
  onConnect,
  onRetry,
  onOpenReview,
  onCommit,
  onDiscard,
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
  onCopyInstruction: () => void;
  onOpenCodex: () => void;
  onConnect: () => void;
  onRetry: () => void;
  onOpenReview: () => void;
  onCommit: () => void;
  onDiscard: () => void;
  onOpenPlanning: () => void;
}) {
  const waiting = task && ["queued", "claimed", "in_progress"].includes(task.status);
  const terminalError = task && ["failed", "cancelled", "expired"].includes(task.status);
  return (
    <aside className={`agent-task-workflow is-${task?.status ?? "idle"}`} aria-label="Agent task workflow">
      <header>
        <div><Bot size={15} /><span><strong>Minimal UI agent</strong><small>{connectionMessage}</small></span></div>
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
            {connectionState !== "active" && <button className="button button-secondary" onClick={onConnect}><ExternalLink size={12} /> Connect Codex</button>}
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

          {preview ? (
            <div className="agent-task-inline-preview">
              <figure>
                <img
                  src={previewRenderUrl(preview.designId, preview.previewId, 720, task.id)}
                  alt="Minimal UI rendered preview"
                  data-testid="agent-rendered-preview"
                />
                <figcaption>Version {preview.rootBaseVersion} → {preview.proposedVersion} · {preview.changedNodeIds.length} changed layer{preview.changedNodeIds.length === 1 ? "" : "s"}</figcaption>
              </figure>
              <div className="agent-task-preview-actions" role="group" aria-label="Agent preview approval actions">
                <button className="button button-secondary" disabled={busy || !canDiscard} onClick={onDiscard}><Trash2 size={12} /> Discard</button>
                <button className={`button ${preview.destructive ? "button-danger" : "button-primary"}`} disabled={busy || !canCommit} onClick={onCommit}>
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
              <button className="button button-primary" onClick={onOpenCodex}><ExternalLink size={12} /> Open in Codex</button>
              {connectionState !== "active" && <button className="button button-secondary" onClick={onConnect}><ExternalLink size={12} /> Connect or repair Codex</button>}
              <button className="button button-secondary" onClick={onCopyInstruction}><Copy size={12} /> Copy Codex instruction</button>
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
  busy,
  actionError,
  baseMatchesHead,
  onClose,
  onCommit,
  onDiscard,
}: {
  open: boolean;
  task: AgentTaskRecord;
  preview: DesignPreviewRecord;
  baseDocument: DesignDocument;
  activePageId: PageId | null;
  busy: boolean;
  actionError: string | null;
  baseMatchesHead: boolean;
  onClose: () => void;
  onCommit: () => void;
  onDiscard: () => void;
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
  if (!open) return null;

  const canCommit = preview.canCommit
    && preview.status === "ready"
    && task.status === "awaiting_approval"
    && baseMatchesHead;
  const renderPane = (version: "before" | "after") => {
    const before = version === "before";
    return (
      <figure className={`agent-review-pane is-${version}`}>
        <figcaption>
          <span><strong>{before ? "Before" : "Proposed"}</strong><small>{before ? `Immutable version ${preview.rootBaseVersion}` : `Preview version ${preview.proposedVersion}`}</small></span>
          <span className="agent-review-hash">{(before ? preview.baseSnapshotHash : preview.resultSnapshotHash).slice(0, 12)}</span>
        </figcaption>
        <ReviewDocumentCanvas
          document={before ? baseDocument : preview.document}
          pageId={activePageId}
          highlightedIds={highlightedIds}
          tone={version}
        />
      </figure>
    );
  };

  return (
    <div className="agent-review-backdrop" role="presentation">
      <section className="agent-review-dialog" role="dialog" aria-modal="true" aria-labelledby="agent-review-title">
        <header className="agent-review-header">
          <div className="agent-review-heading">
            <span><GitCompareArrows size={19} /></span>
            <div>
              <h2 id="agent-review-title">Review Minimal UI proposal</h2>
              <p>Task {task.id} produced an exact persisted preview. History remains unchanged until you commit it.</p>
            </div>
          </div>
          <div className="agent-review-header-actions">
            <a
              className="button button-secondary"
              href={previewRenderUrl(preview.designId, preview.previewId, 2048, task.id)}
              target="_blank"
              rel="noreferrer"
            ><Maximize2 size={12} /> Exact PNG</a>
            <button className="icon-button" disabled={busy} onClick={onClose} aria-label="Close proposal review"><X size={16} /></button>
          </div>
        </header>

        <div className="agent-review-toolbar">
          <div className="agent-review-version-pills">
            <span>Base v{preview.rootBaseVersion}</span>
            <span>Proposed v{preview.proposedVersion}</span>
            <span>{preview.changedNodeIds.length} changed layer{preview.changedNodeIds.length === 1 ? "" : "s"}</span>
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
            {actionError ? <span className="agent-review-action-error"><AlertTriangle size={12} /> {actionError}</span> : !baseMatchesHead ? <span className="agent-review-action-error"><AlertTriangle size={12} /> The project head changed. Create a new preview; FormaSpec never auto-merges.</span> : <span><CheckCircle2 size={12} /> Preview snapshot and hashes are persisted for exact commit.</span>}
          </div>
          <div>
            <button className="button button-secondary" disabled={busy || task.status !== "awaiting_approval"} onClick={onDiscard}><Trash2 size={13} /> Discard proposal</button>
            <button
              className={`button ${preview.destructive ? "button-danger" : "button-primary"}`}
              disabled={busy || !canCommit}
              onClick={onCommit}
            >
              {busy ? <LoaderCircle size={14} className="spin" /> : preview.destructive ? <ShieldAlert size={14} /> : <CheckCircle2 size={14} />}
              {preview.destructive ? "Commit archive" : "Commit exact preview"}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

export function PreviewDiagnosticsSummary({ preview }: { preview: DesignPreviewRecord | null }) {
  if (!preview) return <div className="product-panel-placeholder"><AlertTriangle size={18} /><strong>No agent preview yet</strong><span>Diagnostics appear after Minimal UI returns a persisted design preview for approval.</span></div>;
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
  onOpen,
}: {
  task: AgentTaskRecord | null;
  preview: DesignPreviewRecord | null;
  onOpen: () => void;
}) {
  if (!task || !preview) return <div className="product-panel-placeholder"><GitCompareArrows size={18} /><strong>No revision proposal ready</strong><span>When Minimal UI requests approval, the exact base/proposed versions and changed layers appear here.</span></div>;
  return (
    <div className="preview-revision-summary">
      <div className="preview-revision-thumbnail"><img src={previewRenderUrl(preview.designId, preview.previewId, 720, task.id)} alt="Minimal UI proposed revision" /></div>
      <div className="preview-revision-copy">
        <span className="preview-revision-state"><i /> {task.status.replaceAll("_", " ")}</span>
        <h3>Version {preview.rootBaseVersion} → {preview.proposedVersion}</h3>
        <p>{preview.changedNodeIds.length} changed layer{preview.changedNodeIds.length === 1 ? "" : "s"} · {preview.diagnostics.length} diagnostic{preview.diagnostics.length === 1 ? "" : "s"}</p>
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
