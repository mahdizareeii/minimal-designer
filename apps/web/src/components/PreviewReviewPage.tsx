import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Clock3,
  ExternalLink,
  LoaderCircle,
  RefreshCcw,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { navigate } from "../App";
import { createClientKey, type DesignDocument, type NodeId, type PageId } from "../domain";
import {
  commitDesignPreview,
  designPreviewReviewPath,
  readAgentTask,
  readDesign,
  readDesignPreview,
  subscribeToEvents,
  taskPreviewId,
  transitionAgentTask,
  type AgentTaskRecord,
  type DesignPreviewRecord,
} from "../lib/api";
import { canonicalizeNodeSelection } from "../lib/canvas-geometry";
import {
  useProjectContextPresence,
  type ProjectContextPresenceInput,
} from "../lib/project-context-presence";
import {
  AgentPreviewPng,
  AgentPreviewReviewDialog,
  exactPreviewCommitAllowed,
  type PreviewRenderStatus,
} from "./AgentPreviewReview";

interface PreviewReviewState {
  task: AgentTaskRecord;
  preview: DesignPreviewRecord;
  baseDocument: DesignDocument;
  headDocument: DesignDocument;
}

export function validatePreviewReviewTarget(
  designId: string,
  previewId: string,
  task: AgentTaskRecord,
): void {
  if (task.designId !== designId || task.expectedOutput !== "design_preview") {
    throw new Error("This task does not belong to the requested FormaSpec project.");
  }
  const linkedPreviewId = taskPreviewId(task);
  if (!linkedPreviewId || linkedPreviewId !== previewId) {
    throw new Error("This task does not reference the requested persisted preview.");
  }
}

export function committedReviewProjectContext(
  headDocument: DesignDocument,
  preferredPageIds: readonly PageId[],
  requestedSelection: readonly string[],
): ProjectContextPresenceInput {
  const activePages = headDocument.pages.filter((page) => !page.archived);
  const pageId = preferredPageIds.find((candidate) => activePages.some((page) => page.id === candidate))
    ?? activePages[0]?.id
    ?? null;
  const requestedNodeIds = requestedSelection.filter((nodeId): nodeId is NodeId => nodeId in headDocument.nodes);
  const selectedNodeIds = pageId
    ? canonicalizeNodeSelection(headDocument, requestedNodeIds, pageId)
    : [];
  return {
    designId: headDocument.id,
    ...(pageId ? { pageId } : {}),
    selectedNodeIds,
  };
}

export function PreviewReviewPage({
  designId,
  previewId,
  taskId,
}: {
  designId: string;
  previewId: string;
  taskId: string | null;
}) {
  const [state, setState] = useState<PreviewReviewState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [renderStatus, setRenderStatus] = useState<PreviewRenderStatus>("loading");
  const [renderRetryKey, setRenderRetryKey] = useState(0);
  const loadSequence = useRef(0);
  const commitKey = useRef<string | null>(null);
  const discardKey = useRef<string | null>(null);
  const stateAvailable = useRef(false);
  const renderIdentity = useRef("");

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    if (!taskId) {
      setState(null);
      stateAvailable.current = false;
      setLoading(false);
      setError("This review link is missing its task identifier. Open the exact review link returned by @FormaSpec.");
      return;
    }
    if (!stateAvailable.current) setLoading(true);
    setError(null);
    try {
      const task = await readAgentTask(taskId);
      validatePreviewReviewTarget(designId, previewId, task);
      const [preview, baseDocument, headDocument] = await Promise.all([
        readDesignPreview(designId, previewId, taskId),
        readDesign(designId, task.baseVersion),
        readDesign(designId),
      ]);
      if (sequence !== loadSequence.current) return;
      if (preview.designId !== designId || preview.previewId !== previewId || preview.rootBaseVersion !== task.baseVersion) {
        throw new Error("The persisted preview does not match this task and immutable base version.");
      }
      setState({ task, preview, baseDocument, headDocument });
      stateAvailable.current = true;
      const nextRenderIdentity = `${preview.previewId}:${preview.renderMetadata?.sha256 ?? "missing"}`;
      if (renderIdentity.current !== nextRenderIdentity) {
        renderIdentity.current = nextRenderIdentity;
        setRenderStatus("loading");
        setRenderRetryKey((value) => value + 1);
      }
      setLoading(false);
    } catch (cause) {
      if (sequence !== loadSequence.current) return;
      setState(null);
      stateAvailable.current = false;
      setLoading(false);
      setError(cause instanceof Error ? cause.message : "The exact FormaSpec preview could not be loaded.");
    }
  }, [designId, previewId, taskId]);

  useEffect(() => {
    void load();
    const unsubscribe = subscribeToEvents((event) => {
      if (event.type === "design.updated" && event.designId === designId && event.archived === true) {
        loadSequence.current += 1;
        setState(null);
        stateAvailable.current = false;
        setLoading(false);
        setError("This project was deleted from the active workspace while the preview was open. No preview was committed.");
        return;
      }
      if (event.designId === designId && (event.type === "agent_task.transitioned" || event.type === "design.updated")) {
        void load();
      }
    });
    const timer = window.setInterval(() => void load(), 15_000);
    return () => {
      loadSequence.current += 1;
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [designId, load]);

  const activePageIds = useMemo<PageId[]>(() => {
    if (!state) return [];
    const requestedPages = state.preview.renderMetadata?.options.pageIds ?? [];
    const exactPages = requestedPages.filter((pageId) => (
      state.preview.document.pages.some((page) => page.id === pageId)
      || state.baseDocument.pages.some((page) => page.id === pageId)
    )) as PageId[];
    if (exactPages.length > 0) return exactPages;
    const requested = state.preview.renderMetadata?.options.pageId as PageId | undefined;
    if (requested && (
      state.preview.document.pages.some((page) => page.id === requested)
      || state.baseDocument.pages.some((page) => page.id === requested)
    )) return [requested];
    const fallback = state.preview.document.pages.find((page) => !page.archived)?.id
      ?? state.baseDocument.pages.find((page) => !page.archived)?.id
      ?? null;
    return fallback === null ? [] : [fallback];
  }, [state]);
  const activePageId = activePageIds[0] ?? null;
  const committedHeadContext = useMemo(() => state
    ? committedReviewProjectContext(state.headDocument, activePageIds, state.task.selection)
    : null, [activePageIds, state]);
  const headContextSelection = committedHeadContext?.selectedNodeIds ?? [];
  const projectContextPresence = useProjectContextPresence(committedHeadContext);

  const retryRender = () => {
    setRenderStatus("loading");
    setRenderRetryKey((value) => value + 1);
  };

  const commit = async () => {
    if (!state || !taskId || busy) return;
    const { task, preview } = state;
    if (!exactPreviewCommitAllowed(
      task.status === "awaiting_approval"
        && preview.status === "ready"
        && preview.canCommit
        && state.headDocument.revision === preview.rootBaseVersion,
      renderStatus,
      Boolean(preview.renderMetadata),
    )) {
      setError("The exact PNG must load and the project must still match the preview base before it can be committed.");
      return;
    }
    setBusy(true);
    setError(null);
    commitKey.current ??= createClientKey("preview_review_commit");
    try {
      const committed = await commitDesignPreview({
        designId,
        previewId,
        taskId,
        expectedBaseVersion: preview.rootBaseVersion,
        idempotencyKey: commitKey.current,
        message: `Approve exact FormaSpec preview from task ${taskId}`,
        kind: preview.kind,
      });
      setState((current) => current ? {
        ...current,
        task: committed.task ?? current.task,
        headDocument: committed.document ?? current.headDocument,
        preview: {
          ...current.preview,
          status: "committed",
          canCommit: false,
          committedRevisionId: committed.revisionId ?? current.preview.committedRevisionId,
        },
      } : current);
      setNotice(`Committed the exact preview as immutable version ${committed.version}.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The exact FormaSpec preview could not be committed.");
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    if (!state || !taskId || state.task.status !== "awaiting_approval" || busy) return;
    setBusy(true);
    setError(null);
    discardKey.current ??= createClientKey("preview_review_discard");
    try {
      const task = await transitionAgentTask({
        taskId,
        expectedStatus: "awaiting_approval",
        toStatus: "cancelled",
        message: "The product manager discarded the exact preview without changing project history.",
        data: { previewId, discarded: true },
        idempotencyKey: discardKey.current,
      });
      setState((current) => current ? { ...current, task } : current);
      setNotice("Discarded the proposal. No design revision was created.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The exact FormaSpec preview could not be discarded.");
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <main className="preview-review-page is-loading"><LoaderCircle size={28} className="spin" /><strong>Loading the exact persisted FormaSpec preview…</strong></main>;
  }

  if (!state) {
    return (
      <main className="preview-review-page is-error">
        <AlertTriangle size={30} />
        <h1>Preview review unavailable</h1>
        <p>{error}</p>
        <div><button className="button button-secondary" onClick={() => navigate("/")}><ArrowLeft size={14} /> Projects</button><button className="button button-primary" onClick={() => void load()}><RefreshCcw size={14} /> Retry</button></div>
      </main>
    );
  }

  const { task, preview, baseDocument, headDocument } = state;
  const headVersion = headDocument.revision;
  const canDiscard = task.status === "awaiting_approval";
  const canCommit = exactPreviewCommitAllowed(
    canDiscard && preview.status === "ready" && preview.canCommit && headVersion === preview.rootBaseVersion,
    renderStatus,
    Boolean(preview.renderMetadata),
  );
  const exactPath = designPreviewReviewPath(designId, previewId, task.id);

  return (
    <main className="preview-review-page">
      <header className="preview-review-page-header">
        <button className="button button-secondary" onClick={() => navigate(`/design/${encodeURIComponent(designId)}?task=${encodeURIComponent(task.id)}`)}><ArrowLeft size={14} /> Project</button>
        <div>
          <span>Exact human approval</span>
          <h1 title={baseDocument.name} dir="auto">{baseDocument.name}</h1>
          <p>Task <code>{task.id}</code> · Preview <code>{preview.previewId}</code></p>
        </div>
        <a className="button button-secondary" href={exactPath} aria-current="page"><ExternalLink size={13} /> Permalink</a>
      </header>

      <section className="preview-review-exact" aria-labelledby="exact-preview-title">
        <figure>
          <figcaption id="exact-preview-title"><strong>Persisted PNG</strong><span>The image, hashes, diagnostics, and proposed document below all reference the same immutable preview.</span></figcaption>
          <div className="preview-review-exact-image">
            <AgentPreviewPng
              preview={preview}
              taskId={task.id}
              maxSize={2_048}
              alt={`Exact FormaSpec preview for ${baseDocument.name}`}
              status={renderStatus}
              retryKey={renderRetryKey}
              busy={busy}
              testId="exact-preview-review-png"
              onStatusChange={setRenderStatus}
              onRetry={retryRender}
            />
          </div>
        </figure>
        <aside>
          <div className={`preview-review-status is-${task.status}`}><Clock3 size={14} /><span><strong>{task.status.replaceAll("_", " ")}</strong><small>Expires {new Date(preview.expiresAt).toLocaleString()}</small></span></div>
          <button
            type="button"
            className={`project-context-presence preview-context-presence is-${projectContextPresence.status}`}
            disabled={projectContextPresence.status === "syncing"}
            onClick={projectContextPresence.retry}
            title={projectContextPresence.error
              ?? (projectContextPresence.status === "standby"
                ? "Another FormaSpec tab owns agent context. Click to make this review the active project."
                : "This exact committed-head project context is available to @FormaSpec while you review the proposal. Click to refresh.")}
            aria-live="polite"
            data-testid="preview-project-context-presence"
          >
            {projectContextPresence.status === "syncing"
              ? <LoaderCircle size={13} className="spin" />
              : projectContextPresence.status === "error"
                ? <AlertTriangle size={13} />
                : <CheckCircle2 size={13} />}
            <span>
              <strong>{projectContextPresence.status === "error"
                ? "Agent context failed"
                : projectContextPresence.status === "standby"
                  ? "Another FormaSpec tab is active"
                  : "Active for @FormaSpec"}</strong>
              <small>{projectContextPresence.status === "error"
                ? "Retry project context sync"
                : projectContextPresence.status === "standby"
                  ? "Click to use this review as agent context"
                  : projectContextPresence.status === "syncing" || projectContextPresence.status === "idle"
                    ? "Publishing committed project context…"
                    : headContextSelection.length > 0
                      ? `${headContextSelection.length} saved ${headContextSelection.length === 1 ? "layer" : "layers"} available`
                      : "Committed project and page available"}</small>
            </span>
          </button>
          <dl>
            <div><dt>Base</dt><dd>Version {preview.rootBaseVersion}</dd></div>
            <div><dt>Proposed</dt><dd>Version {preview.proposedVersion}</dd></div>
            <div><dt>Base hash</dt><dd><code>{preview.baseSnapshotHash.slice(0, 16)}</code></dd></div>
            <div><dt>Preview hash</dt><dd><code>{preview.resultSnapshotHash.slice(0, 16)}</code></dd></div>
            <div><dt>Changed layers</dt><dd>{preview.changedNodeIds.length}</dd></div>
            <div><dt>Diagnostics</dt><dd>{preview.diagnostics.length}</dd></div>
          </dl>
          {headVersion !== preview.rootBaseVersion && <div className="preview-review-blocker" role="alert"><ShieldAlert size={14} /> The project is now version {headVersion}. FormaSpec never auto-merges a stale preview.</div>}
          {error && <div className="preview-review-blocker" role="alert"><AlertTriangle size={14} /> {error}</div>}
          {notice && <div className="preview-review-notice" role="status"><CheckCircle2 size={14} /> {notice}</div>}
          <div className="preview-review-primary-actions" role="group" aria-label="Exact preview approval actions">
            <button className="button button-secondary" disabled={busy || !canDiscard} onClick={() => void discard()}><Trash2 size={14} /> Discard</button>
            <button className={`button ${preview.destructive ? "button-danger" : "button-primary"}`} disabled={busy || !canCommit} onClick={() => void commit()}>{busy ? <LoaderCircle size={14} className="spin" /> : <CheckCircle2 size={14} />} Commit preview</button>
          </div>
        </aside>
      </section>

      <AgentPreviewReviewDialog
        open
        presentation="inline"
        showActions={false}
        task={task}
        preview={preview}
        baseDocument={baseDocument}
        activePageId={activePageId}
        activePageIds={activePageIds}
        busy={busy}
        actionError={error}
        baseMatchesHead={headVersion === preview.rootBaseVersion}
        previewRenderStatus={renderStatus}
        onCommit={() => void commit()}
        onDiscard={() => void discard()}
        onRetryPreviewRender={retryRender}
      />
    </main>
  );
}
