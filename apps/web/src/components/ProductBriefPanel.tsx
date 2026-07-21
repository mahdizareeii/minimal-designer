import {
  Braces,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clipboard,
  FileCheck2,
  LoaderCircle,
  MessageSquareText,
  Send,
  Sparkles,
  WandSparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  ApiError,
  commitDesignPreview,
  commitProductSpecification,
  createAgentTask,
  listAgentConnections,
  listAgentTasks,
  previewProductSpecification,
  readDesign,
  readDesignPreview,
  readProductSpecification,
  subscribeToEvents,
  taskPreviewId,
  transitionAgentTask,
  type AgentTaskRecord,
  type AgentConnectionRecord,
  type DesignPreviewRecord,
  type ProductSpecificationRecord,
} from "../lib/api";
import { useDesignerStore } from "../store/designer-store";
import { createClientKey } from "../domain";
import type { ActivityPanelTab } from "../lib/editor-information-architecture";
import { PlanningInterview } from "./PlanningInterview";
import { EngineeringHandoffPanel } from "./EngineeringHandoffPanel";
import {
  AgentTaskWorkflowCard,
  AgentPreviewReviewDialog,
  PreviewDiagnosticsSummary,
  PreviewRevisionSummary,
  agentTaskInstruction,
  codexTaskLaunchUrl,
  type AgentConnectionViewState,
} from "./AgentPreviewReview";
import type { DesignDocument } from "../domain";

type SpecView = "brief" | "structured";

export interface CodexConnectionSummary {
  state: AgentConnectionViewState;
  message: string;
}

export function summarizeCodexConnection(
  connections: readonly AgentConnectionRecord[],
  error: unknown,
  loading: boolean,
  now = Date.now(),
): CodexConnectionSummary {
  if (loading) return { state: "loading", message: "Checking the Codex connection…" };
  if (error instanceof ApiError && error.status === 403) {
    return { state: "restricted", message: "Connection details require an organization administrator. Task claim status remains visible here." };
  }
  if (error) return { state: "error", message: error instanceof Error ? error.message : "Codex connection status could not be read." };
  const codex = connections.filter((connection) => connection.adapter === "codex");
  const usable = codex.find((connection) => connection.status === "active"
    && (connection.expiresAt === null || new Date(connection.expiresAt).getTime() > now));
  if (usable) {
    return {
      state: "active",
      message: usable.lastUsedAt ? `Connected · last used ${new Date(usable.lastUsedAt).toLocaleString()}` : "Connected and ready to claim tasks.",
    };
  }
  if (codex.some((connection) => connection.status === "pending")) {
    return { state: "pending", message: "Pairing is waiting for Codex. Finish the one-time authorization or reconnect." };
  }
  if (codex.some((connection) => connection.status === "error")) {
    return { state: "error", message: "The Codex connection is in an error state. Reconnect it before expecting task claims." };
  }
  if (codex.length > 0) {
    return { state: "unavailable", message: "The previous Codex connection is expired or revoked. Reconnect to process queued tasks." };
  }
  return { state: "unavailable", message: "No Codex connection is active. The task can be queued, but it will wait until Codex is connected." };
}

const contextualActions = [
  "Improve the current selection while preserving its intent.",
  "Create the missing loading, empty, error, and permission-denied states.",
  "Apply the FormaSpec Foundation System and replace avoidable raw values.",
  "Check this flow for RTL and mixed-direction issues.",
  "Document the selected flow and link its business rules.",
  "Prepare a bounded engineering handoff with acceptance criteria.",
] as const;

function specificationCounts(specification: Record<string, unknown> | null): Array<[string, number]> {
  if (!specification) return [];
  const labels: Array<[string, string]> = [
    ["goals", "Goals"],
    ["audiences", "Audiences"],
    ["roles", "Roles"],
    ["entities", "Entities"],
    ["flows", "Flows"],
    ["business_rules", "Business rules"],
    ["permissions", "Permissions"],
    ["validations", "Validations"],
    ["screen_states", "Screen states"],
    ["acceptance_criteria", "Acceptance criteria"],
    ["open_questions", "Open questions"],
  ];
  return labels.map(([key, label]) => [label, Array.isArray(specification[key]) ? specification[key].length : 0]);
}

function openExternalAppLink(url: string, protocol: "formaspec:" | "codex:", hostname: "connect-agent" | "new"): void {
  const parsed = new URL(url);
  if (parsed.protocol !== protocol || parsed.hostname !== hostname || parsed.username || parsed.password || parsed.port || parsed.hash) {
    throw new Error(`The ${protocol.slice(0, -1)} application link is invalid.`);
  }
  const anchor = document.createElement("a");
  anchor.href = parsed.href;
  anchor.rel = "noopener noreferrer";
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

export function ProductBriefPanel() {
  const document = useDesignerStore((state) => state.document);
  const baseVersion = useDesignerStore((state) => state.baseVersion);
  const activePageId = useDesignerStore((state) => state.activePageId);
  const selectedIds = useDesignerStore((state) => state.selectedIds);
  const pendingCount = useDesignerStore((state) => state.pendingOperations.length);
  const savingDesign = useDesignerStore((state) => state.saving);
  const archiveReview = useDesignerStore((state) => state.archiveReview);
  const saveDesign = useDesignerStore((state) => state.save);
  const openDesign = useDesignerStore((state) => state.openDesign);
  const setNotice = useDesignerStore((state) => state.setNotice);
  const [collapsed, setCollapsed] = useState(false);
  const [panelTab, setPanelTab] = useState<ActivityPanelTab>("activity");
  const [specView, setSpecView] = useState<SpecView>("brief");
  const [brief, setBrief] = useState("");
  const [loadedBrief, setLoadedBrief] = useState("");
  const [specification, setSpecification] = useState<ProductSpecificationRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [savingSpec, setSavingSpec] = useState(false);
  const [startingAgent, setStartingAgent] = useState(false);
  const [agentConnections, setAgentConnections] = useState<AgentConnectionRecord[]>([]);
  const [connectionLoading, setConnectionLoading] = useState(true);
  const [connectionError, setConnectionError] = useState<unknown>(null);
  const [latestTask, setLatestTask] = useState<AgentTaskRecord | null>(null);
  const [reviewTask, setReviewTask] = useState<AgentTaskRecord | null>(null);
  const [reviewPreview, setReviewPreview] = useState<DesignPreviewRecord | null>(null);
  const [reviewBaseDocument, setReviewBaseDocument] = useState<DesignDocument | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [planningOpen, setPlanningOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshSequence = useRef(0);
  const displayedPreviewId = useRef<string | null>(null);
  const previewCommitKeys = useRef(new Map<string, string>());

  const designId = document?.id;
  const fallbackBrief = typeof document?.metadata.product_brief === "string" ? document.metadata.product_brief : "";

  useEffect(() => {
    if (!designId) return;
    let active = true;
    setLoading(true);
    setError(null);
    void readProductSpecification(designId).then((record) => {
      if (!active) return;
      const nextBrief = record.naturalLanguageBrief || fallbackBrief;
      setSpecification(record);
      setBrief(nextBrief);
      setLoadedBrief(nextBrief);
      setLoading(false);
    }).catch((cause) => {
      if (!active) return;
      if (cause instanceof ApiError && cause.code === "NOT_FOUND") {
        setSpecification({ version: 0, naturalLanguageBrief: fallbackBrief, specification: null });
        setBrief(fallbackBrief);
        setLoadedBrief(fallbackBrief);
        setLoading(false);
        return;
      }
      setBrief(fallbackBrief);
      setLoadedBrief(fallbackBrief);
      setLoading(false);
      setError(cause instanceof Error ? cause.message : "Could not load the product specification.");
    });
    return () => { active = false; };
  }, [designId, fallbackBrief]);

  const refreshAgentActivity = useCallback(async () => {
    if (!designId) return;
    const sequence = ++refreshSequence.current;
    try {
      const [tasksResult, connectionsResult] = await Promise.allSettled([
        listAgentTasks(designId),
        listAgentConnections(),
      ]);
      if (sequence !== refreshSequence.current) return;
      setConnectionLoading(false);
      if (connectionsResult.status === "fulfilled") {
        setAgentConnections(connectionsResult.value);
        setConnectionError(null);
      } else {
        setAgentConnections([]);
        setConnectionError(connectionsResult.reason);
      }
      if (tasksResult.status === "rejected") throw tasksResult.reason;
      const tasks = tasksResult.value;
      const newestDesignTask = tasks.find((task) => task.expectedOutput === "design_preview") ?? null;
      setLatestTask(newestDesignTask ?? tasks[0] ?? null);
      const previewId = taskPreviewId(newestDesignTask);
      if (!newestDesignTask
        || !previewId
        || (newestDesignTask.status !== "awaiting_approval" && newestDesignTask.status !== "completed")) {
        setReviewTask(null);
        setReviewPreview(null);
        setReviewBaseDocument(null);
        return;
      }
      const [preview, baseDocument] = await Promise.all([
        readDesignPreview(designId, previewId, newestDesignTask.id),
        readDesign(designId, newestDesignTask.baseVersion),
      ]);
      if (sequence !== refreshSequence.current) return;
      setReviewTask(newestDesignTask);
      setReviewPreview(preview);
      setReviewBaseDocument(baseDocument);
      setReviewError(null);
      if (displayedPreviewId.current !== preview.previewId) {
        displayedPreviewId.current = preview.previewId;
        setCollapsed(false);
        setPanelTab("activity");
        setNotice(`Minimal UI returned preview ${preview.previewId}. Review it below, then commit or discard it.`);
      }
    } catch (cause) {
      if (sequence !== refreshSequence.current) return;
      setReviewError(cause instanceof Error ? cause.message : "Could not load the agent preview.");
    }
  }, [designId]);

  useEffect(() => {
    if (!designId) return;
    void refreshAgentActivity();
    const unsubscribe = subscribeToEvents((event) => {
      if (event.type === "agent_connection.changed") {
        void refreshAgentActivity();
        return;
      }
      if (event.designId === designId && (event.type === "agent_task.transitioned" || event.type === "design.updated")) {
        void refreshAgentActivity();
      }
    });
    const timer = window.setInterval(() => void refreshAgentActivity(), 15_000);
    return () => {
      refreshSequence.current += 1;
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [designId, refreshAgentActivity]);

  const counts = useMemo(() => specificationCounts(specification?.specification ?? null), [specification]);
  const briefChanged = brief !== loadedBrief;
  const connectionSummary = useMemo(
    () => summarizeCodexConnection(agentConnections, connectionError, connectionLoading),
    [agentConnections, connectionError, connectionLoading],
  );

  const persistBrief = async (): Promise<ProductSpecificationRecord> => {
    if (!designId) throw new Error("Open a project before saving its product specification.");
    const normalizedBrief = brief.trim();
    if (!normalizedBrief) throw new Error("Describe the product before creating a specification or agent task.");
    if (!briefChanged && specification) return specification;

    setSavingSpec(true);
    setError(null);
    try {
      const currentVersion = specification?.version ?? 0;
      const preview = await previewProductSpecification(designId, currentVersion, normalizedBrief);
      if (!preview.canCommit) throw new Error("The product specification preview contains validation errors.");
      const committed = await commitProductSpecification(
        designId,
        preview.previewId,
        currentVersion,
        createClientKey("product_spec"),
      );
      setSpecification(committed);
      setBrief(committed.naturalLanguageBrief);
      setLoadedBrief(committed.naturalLanguageBrief);
      setNotice(`Product specification version ${committed.version} saved.`);
      return committed;
    } finally {
      setSavingSpec(false);
    }
  };

  const saveBrief = async () => {
    try {
      await persistBrief();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the product specification.");
    }
  };

  const startWithCodex = async () => {
    if (!designId) return;
    setStartingAgent(true);
    setError(null);
    try {
      if (pendingCount > 0 || savingDesign) await saveDesign();
      const current = useDesignerStore.getState();
      if (current.archiveReview) throw new Error("Commit or discard the destructive preview before starting an agent task.");
      if (current.saveState !== "saved") throw new Error("Save the current design revision before starting an agent task.");
      const committedSpec = await persistBrief();
      const task = await createAgentTask({
        designId,
        baseVersion: current.baseVersion,
        brief: committedSpec.naturalLanguageBrief,
        selection: current.selectedIds,
        expectedOutput: "design_preview",
      });
      setLatestTask(task);
      setReviewTask(null);
      setReviewPreview(null);
      setReviewBaseDocument(null);
      setReviewOpen(false);
      setPanelTab("activity");
      setNotice(`Agent task ${task.id} queued. Codex opened with the Minimal UI instruction prefilled; review it and press Send.${connectionSummary.state === "active" ? "" : " Codex may ask you to finish the connection first."}`);
      openExternalAppLink(codexTaskLaunchUrl(task), "codex:", "new");
      await refreshAgentActivity();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the Codex task.");
    } finally {
      setStartingAgent(false);
    }
  };

  const appendAction = (action: string) => {
    setBrief((current) => `${current.trim()}${current.trim() ? "\n\n" : ""}${action}`);
    setSpecView("brief");
  };

  const copyAgentInstruction = async () => {
    if (!latestTask) return;
    try {
      await navigator.clipboard.writeText(agentTaskInstruction(latestTask));
      setNotice(`Copied the Codex instruction for task ${latestTask.id}.`);
    } catch {
      setReviewError("The browser could not copy the instruction. In Codex, say “Use Minimal UI” and include the task ID shown here.");
    }
  };

  const openAgentConnection = () => {
    window.location.assign("/administration/agents");
  };

  const openTaskInCodex = () => {
    if (!latestTask) return;
    try {
      openExternalAppLink(codexTaskLaunchUrl(latestTask), "codex:", "new");
      setNotice(`Opened Codex with task ${latestTask.id} prefilled. Review the instruction, then press Send.`);
    } catch (cause) {
      setReviewError(cause instanceof Error ? cause.message : "Codex could not be opened for this task.");
    }
  };

  const commitAgentPreview = async () => {
    if (!designId || !reviewTask || !reviewPreview) return;
    const current = useDesignerStore.getState();
    if (current.pendingOperations.length > 0 || current.saving || current.archiveReview) {
      setReviewError("Save or discard local editor changes before committing an agent preview.");
      return;
    }
    if (current.baseVersion !== reviewPreview.rootBaseVersion) {
      setReviewError("The project head changed. Ask Minimal UI for a new preview; FormaSpec does not auto-merge.");
      return;
    }
    setReviewBusy(true);
    setReviewError(null);
    const idempotencyKey = previewCommitKeys.current.get(reviewPreview.previewId)
      ?? createClientKey("agent_preview_commit");
    previewCommitKeys.current.set(reviewPreview.previewId, idempotencyKey);
    let committed = false;
    try {
      try {
        await commitDesignPreview({
          designId,
          previewId: reviewPreview.previewId,
          taskId: reviewTask.id,
          expectedBaseVersion: reviewPreview.rootBaseVersion,
          idempotencyKey,
          message: `Approve Minimal UI proposal from task ${reviewTask.id}`,
          kind: reviewPreview.kind,
        });
        committed = true;
      } catch (cause) {
        if (!(cause instanceof ApiError && cause.code === "PREVIEW_ALREADY_COMMITTED")) throw cause;
        committed = true;
      }

      let transitionWarning: string | null = null;
      if (reviewTask.status === "awaiting_approval") {
        try {
          const completed = await transitionAgentTask({
            taskId: reviewTask.id,
            expectedStatus: "awaiting_approval",
            toStatus: "completed",
            message: "The product manager approved and committed the exact design preview.",
            data: { previewId: reviewPreview.previewId },
          });
          setLatestTask(completed);
        } catch (cause) {
          transitionWarning = cause instanceof Error ? cause.message : "The revision committed, but the task status could not be updated.";
        }
      }
      await openDesign(designId);
      await refreshAgentActivity();
      setReviewOpen(false);
      setNotice(transitionWarning
        ? `Committed version ${reviewPreview.proposedVersion}. Refresh the task status if needed.`
        : `Committed Minimal UI preview as immutable version ${reviewPreview.proposedVersion}.`);
      if (transitionWarning) setReviewError(transitionWarning);
    } catch (cause) {
      setReviewError(cause instanceof Error ? cause.message : "The agent preview could not be committed.");
      if (committed) await openDesign(designId);
    } finally {
      setReviewBusy(false);
    }
  };

  const discardAgentPreview = async () => {
    if (!reviewTask || !reviewPreview || reviewTask.status !== "awaiting_approval") return;
    setReviewBusy(true);
    setReviewError(null);
    try {
      const cancelled = await transitionAgentTask({
        taskId: reviewTask.id,
        expectedStatus: "awaiting_approval",
        toStatus: "cancelled",
        message: "The product manager discarded the proposed preview without changing design history.",
        data: { previewId: reviewPreview.previewId, discarded: true },
      });
      setLatestTask(cancelled);
      setReviewTask(null);
      setReviewPreview(null);
      setReviewBaseDocument(null);
      setReviewOpen(false);
      setNotice("Discarded the Minimal UI proposal. No design revision was created.");
    } catch (cause) {
      setReviewError(cause instanceof Error ? cause.message : "The proposed preview could not be discarded.");
    } finally {
      setReviewBusy(false);
    }
  };

  if (!document) return null;

  return (
    <section className={`product-workspace-panel ${collapsed ? "is-collapsed" : ""} ${latestTask ? "has-agent-task" : ""} ${reviewPreview ? "has-agent-preview" : ""}`} aria-label="Product specification and agent activity">
      <header className="product-panel-header">
        <nav aria-label="Workspace activity panels">
          <button className={panelTab === "activity" ? "is-active" : ""} aria-pressed={panelTab === "activity"} onClick={() => setPanelTab("activity")}><Sparkles size={11} /> Agent activity</button>
          <button className={panelTab === "diagnostics" ? "is-active" : ""} aria-pressed={panelTab === "diagnostics"} onClick={() => setPanelTab("diagnostics")}><FileCheck2 size={11} /> Diagnostics</button>
          <button className={panelTab === "revision" ? "is-active" : ""} aria-pressed={panelTab === "revision"} onClick={() => setPanelTab("revision")}><Braces size={11} /> Revision preview</button>
          <button className={panelTab === "handoff" ? "is-active" : ""} aria-pressed={panelTab === "handoff"} onClick={() => setPanelTab("handoff")}><Clipboard size={11} /> Engineering handoff</button>
        </nav>
        <button className="icon-button" onClick={() => setCollapsed((value) => !value)} aria-label={collapsed ? "Expand product workspace" : "Collapse product workspace"}>{collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</button>
      </header>

      {!collapsed && panelTab === "activity" && (
        <div className="product-panel-content">
          <div className="product-brief-editor">
            <div className="product-brief-title">
              <div><WandSparkles size={16} /><span><strong>Describe the product, business logic, and constraints</strong><small>Website state is canonical. FormaSpec creates a versioned structured proposal before an agent can act.</small></span></div>
              <div className="spec-view-toggle">
                <button className={specView === "brief" ? "is-active" : ""} onClick={() => setSpecView("brief")}><MessageSquareText size={10} /> Brief</button>
                <button className={specView === "structured" ? "is-active" : ""} onClick={() => setSpecView("structured")}><Braces size={10} /> Structured</button>
              </div>
            </div>

            {specView === "brief" ? (
              <textarea
                value={brief}
                onChange={(event) => setBrief(event.target.value)}
                disabled={loading || savingSpec || startingAgent || Boolean(archiveReview)}
                placeholder="Example: Build an internal courier operations dashboard. Dispatchers assign orders, couriers update delivery states, finance can view but not edit payouts, Persian and English are required, and sensitive actions need confirmation…"
                aria-label="Describe the product, business logic, and constraints"
              />
            ) : (
              <div className="structured-spec-summary">
                {counts.length > 0 ? counts.map(([label, count]) => <span key={label}><strong>{count}</strong>{label}</span>) : <p>Save the brief to create the first typed specification proposal. Agents refine this through preview and commit, never through executable business-rule text.</p>}
              </div>
            )}

            <div className="contextual-agent-actions">
              {contextualActions.map((action) => <button key={action} onClick={() => appendAction(action)}>{action}</button>)}
            </div>

            <div className="product-brief-actions">
              <div>
                {error ? <span className="product-panel-error">{error}</span> : latestTask ? <span className="product-panel-success"><CheckCircle2 size={11} /> Task {latestTask.id} · {latestTask.status}</span> : <span>Agent mention: <code>[@Minimal UI](plugin://minimal-ui@formaspec)</code></span>}
              </div>
              <button className="button button-secondary" disabled={!briefChanged || savingSpec || startingAgent || loading} onClick={() => void saveBrief()}>{savingSpec ? <LoaderCircle size={13} className="spin" /> : <FileCheck2 size={13} />} Save specification</button>
              <button className="button button-primary" disabled={!brief.trim() || savingSpec || startingAgent || loading || Boolean(archiveReview)} onClick={() => void startWithCodex()}>{startingAgent ? <LoaderCircle size={13} className="spin" /> : <Send size={13} />} Start with Codex</button>
            </div>
          </div>

          <AgentTaskWorkflowCard
            connectionState={connectionSummary.state}
            connectionMessage={connectionSummary.message}
            task={latestTask}
            preview={reviewPreview}
            busy={reviewBusy}
            actionError={reviewError}
            canCommit={Boolean(reviewTask && reviewPreview
              && reviewTask.status === "awaiting_approval"
              && reviewPreview.canCommit
              && reviewPreview.status === "ready"
              && baseVersion === reviewPreview.rootBaseVersion
              && pendingCount === 0
              && !savingDesign
              && !archiveReview)}
            canDiscard={Boolean(reviewTask && reviewPreview && reviewTask.status === "awaiting_approval")}
            onCopyInstruction={() => void copyAgentInstruction()}
            onOpenCodex={openTaskInCodex}
            onConnect={openAgentConnection}
            onRetry={() => void refreshAgentActivity()}
            onOpenReview={() => setReviewOpen(true)}
            onCommit={() => void commitAgentPreview()}
            onDiscard={() => void discardAgentPreview()}
            onOpenPlanning={() => setPlanningOpen(true)}
          />
        </div>
      )}

      {!collapsed && panelTab === "handoff" && (
        <EngineeringHandoffPanel designId={document.id} baseVersion={baseVersion} brief={brief} />
      )}

      {!collapsed && panelTab === "diagnostics" && <PreviewDiagnosticsSummary preview={reviewPreview} />}

      {!collapsed && panelTab === "revision" && (
        <PreviewRevisionSummary task={reviewTask} preview={reviewPreview} onOpen={() => setReviewOpen(true)} />
      )}
      <PlanningInterview designId={document.id} open={planningOpen} onClose={() => setPlanningOpen(false)} />
      {reviewTask && reviewPreview && reviewBaseDocument && (
        <AgentPreviewReviewDialog
          open={reviewOpen}
          task={reviewTask}
          preview={reviewPreview}
          baseDocument={reviewBaseDocument}
          activePageId={activePageId}
          busy={reviewBusy}
          actionError={reviewError}
          baseMatchesHead={baseVersion === reviewPreview.rootBaseVersion && pendingCount === 0 && !savingDesign && !archiveReview}
          onClose={() => setReviewOpen(false)}
          onCommit={() => void commitAgentPreview()}
          onDiscard={() => void discardAgentPreview()}
        />
      )}
    </section>
  );
}
