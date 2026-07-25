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
  ApiError,
  readAgentTask,
  readDesign,
  readDesignPreview,
  subscribeToEvents,
  taskPreviewId,
  transitionAgentTask,
  type AgentTaskRecord,
  type DesignReadinessCheckStatus,
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

const readinessCheckLabels: Record<string, string> = {
  hierarchy: "Hierarchy",
  visualConsistency: "Visual consistency",
  interactionStates: "Interaction states",
  accessibility: "Accessibility",
  touchTargets: "Touch targets",
  rtlLocalization: "RTL / localization",
  responsiveVariants: "Responsive variants",
  prototypeCoverage: "Prototype coverage",
  engineeringFeasibility: "Engineering feasibility",
  lint: "Lint",
};

function readinessStatusLabel(status: DesignReadinessCheckStatus): string {
  return status === "not_applicable" ? "N/A" : status;
}

export function DesignReadinessReportCard({
  task,
  designName,
}: {
  task: AgentTaskRecord;
  designName: string;
}) {
  const report = task.readiness ?? null;
  const productName = task.product?.name ?? task.resolvedContext?.product.name ?? "Unknown Product";
  if (!report) {
    return (
      <section className="preview-readiness is-missing" data-testid="preview-readiness-report" aria-labelledby="preview-readiness-title">
        <header>
          <div><span>Senior workflow</span><h2 id="preview-readiness-title">Readiness evidence unavailable</h2></div>
          <ShieldAlert size={18} />
        </header>
        <p>This proposal predates the Product-aware FormaSpec 0.3.0 workflow. Regenerate it before approval so Product, specification, design-system, repository, accessibility, RTL, and responsive evidence are immutable.</p>
      </section>
    );
  }

  const componentGroups = [
    ["Reused", report.components.reused.map((component) => ({
      id: component.componentDefinitionId,
      label: `${component.componentDefinitionId} · v${component.version}`,
      reason: component.reason,
    }))],
    ["Extended", report.components.extended.map((component) => ({
      id: component.componentDefinitionId,
      label: `${component.componentDefinitionId} · v${component.version}`,
      reason: component.reason,
    }))],
    ["Proposed drafts", report.components.proposed.map((component) => ({
      id: component.key,
      label: component.name,
      reason: component.reason,
    }))],
  ] as const;

  return (
    <section className="preview-readiness" data-testid="preview-readiness-report" aria-labelledby="preview-readiness-title">
      <header>
        <div>
          <span>Senior designer · product manager · engineer</span>
          <h2 id="preview-readiness-title">FormaSpec readiness report</h2>
          <p>{report.requestClassification.replaceAll("_", " ")} · immutable task context captured before design</p>
        </div>
        <div className="preview-readiness-context">
          <strong title={productName} dir="auto">{productName}</strong>
          <span aria-hidden="true">→</span>
          <strong title={designName} dir="auto">{designName}</strong>
          <small>Base version {report.selected.baseVersion}</small>
        </div>
      </header>

      <div className="preview-readiness-summary">
        <article>
          <h3>Product context</h3>
          <dl>
            <div><dt>Product</dt><dd title={report.selected.productId}>{productName}</dd></div>
            <div><dt>Design</dt><dd title={report.selected.designId}>{designName}</dd></div>
            <div><dt>Specification</dt><dd>{report.productSpecification ? `v${report.productSpecification.version}` : "Not defined"}</dd></div>
            {report.productSpecification && <div><dt>Spec hash</dt><dd><code>{report.productSpecification.specificationHash.slice(0, 12)}…</code></dd></div>}
          </dl>
        </article>
        <article>
          <h3>Effective design system</h3>
          <dl>
            <div><dt>Source</dt><dd>{report.designSystem.source.replaceAll("_", " ")}</dd></div>
            <div><dt>Release</dt><dd title={report.designSystem.releaseId}><code>{report.designSystem.releaseId}</code></dd></div>
            <div><dt>Version</dt><dd>v{report.designSystem.releaseVersion}</dd></div>
            <div><dt>Platforms</dt><dd>{report.platforms.join(", ")}</dd></div>
          </dl>
        </article>
        <article>
          <h3>Engineering context</h3>
          <dl>
            <div><dt>Inventories</dt><dd>{report.repositoryMappingsConsidered.length}</dd></div>
            <div><dt>Mappings</dt><dd>{report.repositoryMappingsConsidered.length > 0 ? "Considered" : "None connected"}</dd></div>
            <div><dt>Locale</dt><dd>{task.resolvedContext?.locale ?? "Not recorded"}</dd></div>
            <div><dt>Direction</dt><dd>{task.resolvedContext?.direction ?? "Not recorded"}</dd></div>
          </dl>
        </article>
      </div>

      <div className="preview-readiness-components">
        {componentGroups.map(([label, components]) => (
          <article key={label}>
            <h3>{label}<span>{components.length}</span></h3>
            {components.length === 0
              ? <p>None</p>
              : <ul>{components.map((component) => <li key={component.id}><strong title={component.label}>{component.label}</strong><span>{component.reason}</span></li>)}</ul>}
          </article>
        ))}
      </div>

      <div className="preview-readiness-checks" aria-label="Design validation checks">
        {Object.entries(report.checks).map(([key, status]) => (
          <span className={`is-${status}`} key={key} title={`${readinessCheckLabels[key] ?? key}: ${readinessStatusLabel(status)}`}>
            {status === "pass" ? <CheckCircle2 size={11} /> : status === "blocked" ? <ShieldAlert size={11} /> : <AlertTriangle size={11} />}
            <strong>{readinessCheckLabels[key] ?? key}</strong>
            <small>{readinessStatusLabel(status)}</small>
          </span>
        ))}
      </div>

      {(report.assumptions.length > 0 || report.blockers.length > 0) && (
        <div className="preview-readiness-notes">
          <article><h3>Assumptions</h3>{report.assumptions.length === 0 ? <p>None</p> : <ul>{report.assumptions.map((item) => <li key={item}>{item}</li>)}</ul>}</article>
          <article className={report.blockers.length > 0 ? "has-blockers" : ""}><h3>Blockers</h3>{report.blockers.length === 0 ? <p>None</p> : <ul>{report.blockers.map((item) => <li key={item}>{item}</li>)}</ul>}</article>
        </div>
      )}
    </section>
  );
}

export function previewReviewFailureMessage(cause: unknown): string {
  if (!(cause instanceof ApiError)) {
    return cause instanceof Error ? cause.message : "The exact FormaSpec preview could not be loaded.";
  }
  switch (cause.code) {
    case "NETWORK_ERROR":
      return "FormaSpec is offline or unreachable. Start the runtime that created this preview, then retry.";
    case "DATA_STORE_MISMATCH":
      return "This link belongs to another FormaSpec data store. Start the recorded runtime instead of switching between native and Docker data.";
    case "PREVIEW_EXPIRED":
      return "This preview expired without changing project history. Ask FormaSpec to regenerate it from the current project version.";
    case "PREVIEW_ALREADY_COMMITTED":
      return "This exact preview was already committed. Open the saved project or its immutable revision instead of approving it again.";
    case "PREVIEW_NOT_COMMITTABLE":
      return "This preview was discarded or is no longer awaiting approval. It did not create another project revision.";
    case "PREVIEW_ENGINE_MISMATCH":
      return "The exact persisted PNG is missing or incompatible. Regenerate the preview before approving it.";
    case "VERSION_CONFLICT":
      return "The project changed after this preview was created. FormaSpec never auto-merges it; regenerate from the current version.";
    case "AUTH_REQUIRED":
      return "Sign in to the FormaSpec workspace that owns this private review, then reopen the link.";
    case "TASK_EXPIRED":
      return "The review task expired without changing the project. Create a new task-backed preview from the current version.";
    case "TASK_STATE_CONFLICT":
      return "This task is no longer awaiting approval. Refresh its current state before taking another action.";
    case "NOT_FOUND":
      return "This project, task, or preview is unavailable. It may have been archived, discarded, or opened in the wrong runtime.";
    default:
      return cause.message;
  }
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
  expectedDataStoreId,
}: {
  designId: string;
  previewId: string;
  taskId: string | null;
  expectedDataStoreId: string | null;
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
      const preview = await readDesignPreview(designId, previewId, taskId, expectedDataStoreId ?? undefined);
      if (expectedDataStoreId && preview.dataStoreId && preview.dataStoreId !== expectedDataStoreId) {
        throw new ApiError("The review link and active FormaSpec data store do not match.", {
          code: "DATA_STORE_MISMATCH",
          status: 409,
        });
      }
      const task = await readAgentTask(taskId);
      validatePreviewReviewTarget(designId, previewId, task);
      const [baseDocument, headDocument] = await Promise.all([
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
      setError(previewReviewFailureMessage(cause));
    }
  }, [designId, expectedDataStoreId, previewId, taskId]);

  useEffect(() => {
    void load();
    const unsubscribe = subscribeToEvents((event) => {
      if (event.type === "design.updated" && event.designId === designId && event.archived === true) {
        loadSequence.current += 1;
        setState(null);
        stateAvailable.current = false;
        setLoading(false);
        setError("This Design was archived while the preview was open. No preview was committed.");
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
        && Boolean(task.readiness)
        && state.headDocument.revision === preview.rootBaseVersion,
      renderStatus,
      Boolean(preview.renderMetadata),
    )) {
      setError("The exact PNG, immutable readiness report, and matching project base are required before commit.");
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
    canDiscard
      && preview.status === "ready"
      && preview.canCommit
      && Boolean(task.readiness)
      && headVersion === preview.rootBaseVersion,
    renderStatus,
    Boolean(preview.renderMetadata),
  );
  const exactPath = designPreviewReviewPath(
    designId,
    previewId,
    task.id,
    preview.dataStoreId ?? expectedDataStoreId ?? undefined,
  );

  return (
    <main className="preview-review-page">
      <header className="preview-review-page-header">
        <button className="button button-secondary" onClick={() => navigate(`/design/${encodeURIComponent(designId)}?task=${encodeURIComponent(task.id)}`)}><ArrowLeft size={14} /> Project</button>
        <div>
          <span>Exact human approval</span>
          <h1 title={baseDocument.name} dir="auto">{baseDocument.name}</h1>
          <p>{task.product?.name ?? task.resolvedContext?.product.name ?? "Product"} · Task <code>{task.id}</code> · Preview <code>{preview.previewId}</code></p>
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
            {preview.dataStoreId && <div><dt>Data store</dt><dd><code>{preview.dataStoreId.slice(0, 18)}…</code></dd></div>}
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

      <DesignReadinessReportCard task={task} designName={baseDocument.name} />

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
