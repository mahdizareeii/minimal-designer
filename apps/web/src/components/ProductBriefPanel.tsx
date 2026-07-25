import {
  Braces,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clipboard,
  Clock3,
  FileCheck2,
  LoaderCircle,
  MessageSquareText,
  Sparkles,
  WandSparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { navigate } from "../App";
import {
  ApiError,
  commitDesignPreview,
  commitProductSpecification,
  designPreviewReviewPath,
  listAgentConnections,
  listAgentTasks,
  previewProductSpecification,
  previewTypedProductSpecification,
  readDesignPreview,
  readAgentTask,
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
import { ProductSpecificationHistory } from "./ProductSpecificationHistory";
import {
  AgentTaskWorkflowCard,
  PreviewDiagnosticsSummary,
  PreviewRevisionSummary,
  FORMASPEC_AGENT_MENTION,
  type AgentConnectionViewState,
  type PreviewRenderStatus,
} from "./AgentPreviewReview";

type SpecView = "brief" | "structured" | "history";

export interface CodexConnectionSummary {
  state: AgentConnectionViewState;
  message: string;
}

export function productSpecificationRequiresCommit(
  specification: ProductSpecificationRecord | null,
  briefChanged: boolean,
): boolean {
  return briefChanged || specification === null || !Number.isInteger(specification.version) || specification.version <= 0;
}

export interface InlineAgentPreviewEditorState {
  baseVersion: number;
  pendingOperations: readonly unknown[];
  saving: boolean;
  archiveReview: unknown | null;
  conflictRecovery: unknown | null;
  saveState: string;
  productBriefGuard?: { dirty: boolean; saving: boolean } | null;
}

export type InlineAgentPreviewCommitOutcome<T> =
  | { status: "blocked"; message: string }
  | { status: "committed"; value: T };

export async function commitInlineAgentPreviewWhenAllowed<T>(input: {
  editor: InlineAgentPreviewEditorState;
  previewRenderStatus: PreviewRenderStatus;
  previewBaseVersion: number;
  commit: () => Promise<T>;
  openDesign: () => Promise<void>;
}): Promise<InlineAgentPreviewCommitOutcome<T>> {
  if (input.previewRenderStatus !== "available") {
    return {
      status: "blocked",
      message: "The rendered PNG must load successfully before the exact preview can be committed. Retry the PNG first.",
    };
  }
  if (input.editor.pendingOperations.length > 0
    || input.editor.saving
    || input.editor.archiveReview
    || input.editor.conflictRecovery
    || input.editor.saveState !== "saved"
    || input.editor.productBriefGuard?.dirty
    || input.editor.productBriefGuard?.saving) {
    return {
      status: "blocked",
      message: "Save / Commit the design and product brief before committing an agent preview.",
    };
  }
  if (input.editor.baseVersion !== input.previewBaseVersion) {
    return {
      status: "blocked",
      message: "The project head changed. Ask FormaSpec for a new preview; FormaSpec does not auto-merge.",
    };
  }
  const value = await input.commit();
  await input.openDesign();
  return { status: "committed", value };
}

const CODEX_DESIGN_TASK_SCOPES = [
  "design:read",
  "design:preview",
  "task:read",
  "task:claim",
  "task:update",
] as const;

export interface AgentPreviewReadFailureDisposition {
  clearReview: true;
  closeDialog: true;
  message: string;
}

export function agentPreviewReadFailureDisposition(cause: unknown): AgentPreviewReadFailureDisposition {
  if (cause instanceof ApiError && cause.code === "PREVIEW_EXPIRED") {
    return {
      clearReview: true,
      closeDialog: true,
      message: "This preview expired. The durable task can be reopened in Codex to generate a new preview with an exact persisted render.",
    };
  }
  if (cause instanceof ApiError && cause.code === "TASK_EXPIRED") {
    return {
      clearReview: true,
      closeDialog: true,
      message: "This FormaSpec task expired before approval. Start a new Codex task from the current project version.",
    };
  }
  if (cause instanceof ApiError && cause.code === "NOT_FOUND") {
    return {
      clearReview: true,
      closeDialog: true,
      message: "The persisted FormaSpec preview is no longer available. Refresh agent activity or start a new Codex task.",
    };
  }
  const detail = cause instanceof Error && cause.message.trim() ? ` ${cause.message.trim()}` : "";
  return {
    clearReview: true,
    closeDialog: true,
    message: `Could not safely refresh the agent preview.${detail} The stale approval controls were cleared; retry agent activity before approving anything.`,
  };
}

export function summarizeCodexConnection(
  connections: readonly AgentConnectionRecord[],
  error: unknown,
  loading: boolean,
  designId: string | null,
  now = Date.now(),
): CodexConnectionSummary {
  if (loading) return { state: "loading", message: "Checking the Codex connection…" };
  if (error instanceof ApiError && error.status === 403) {
    return { state: "restricted", message: "Connection details require an organization administrator. Task claim status remains visible here." };
  }
  if (error) return { state: "error", message: error instanceof Error ? error.message : "Codex connection status could not be read." };
  const codex = connections.filter((connection) => connection.adapter === "codex");
  const active = codex.filter((connection) => connection.status === "active"
    && (connection.expiresAt === null || new Date(connection.expiresAt).getTime() > now));
  const usable = active.find((connection) => connection.principalId !== null
    && CODEX_DESIGN_TASK_SCOPES.every((scope) => connection.scopes.includes(scope))
    && (designId === null || connection.projectIds.length === 0 || connection.projectIds.includes(designId)));
  if (usable) {
    return {
      state: "active",
      message: usable.lastUsedAt ? `MCP connected · last used ${new Date(usable.lastUsedAt).toLocaleString()}` : "MCP connected. Start FormaSpec work from Codex or the CLI.",
    };
  }
  if (active.length > 0) {
    const projectBlocked = designId !== null
      && active.every((connection) => connection.projectIds.length > 0 && !connection.projectIds.includes(designId));
    const incomplete = active.every((connection) => connection.principalId === null);
    return {
      state: "restricted",
      message: incomplete
        ? "Codex pairing is not complete. Finish or reconnect the managed FormaSpec connection."
        : projectBlocked
          ? "The active Codex connection cannot access this project. Reconnect FormaSpec to refresh its project grant."
          : "The active Codex connection is missing required design-preview or task scopes. Reconnect it before running work from Codex or the CLI.",
    };
  }
  if (codex.some((connection) => connection.status === "pending")) {
    return { state: "pending", message: "Pairing is waiting for Codex. Finish the one-time authorization or reconnect." };
  }
  if (codex.some((connection) => connection.status === "error")) {
    return { state: "error", message: "The Codex connection is in an error state. Reconnect it before expecting task claims." };
  }
  if (codex.length > 0) {
    return { state: "unavailable", message: "The previous FormaSpec MCP connection expired or was revoked. Reconnect it once to continue from Codex or the CLI." };
  }
  return { state: "unavailable", message: "FormaSpec MCP is not connected. Install or connect it once, then start tasks from Codex or the CLI." };
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

function openExistingCodexTask(link: string): void {
  const url = new URL(link);
  if (url.protocol !== "codex:" || url.hostname !== "new" || url.pathname || url.username || url.password || url.port || url.hash
    || [...url.searchParams.keys()].some((key) => key !== "prompt")
    || url.searchParams.getAll("prompt").length !== 1
    || !url.searchParams.get("prompt")?.trim()) {
    throw new Error("The server returned an invalid Codex task link.");
  }
  const anchor = document.createElement("a");
  anchor.href = url.toString();
  anchor.rel = "noopener noreferrer";
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

async function withSubmissionTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 30_000): Promise<T> {
  let timeout = 0;
  const timedOut = new Promise<never>((_, reject) => {
    timeout = window.setTimeout(() => reject(new Error(`${label} timed out. Retry safely; FormaSpec will reuse the same idempotency key.`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timedOut]);
  } finally {
    window.clearTimeout(timeout);
  }
}

export function ProductBriefPanel() {
  const document = useDesignerStore((state) => state.document);
  const baseVersion = useDesignerStore((state) => state.baseVersion);
  const pendingCount = useDesignerStore((state) => state.pendingOperations.length);
  const savingDesign = useDesignerStore((state) => state.saving);
  const archiveReview = useDesignerStore((state) => state.archiveReview);
  const openDesign = useDesignerStore((state) => state.openDesign);
  const setNotice = useDesignerStore((state) => state.setNotice);
  const setProductBriefDraftGuard = useDesignerStore((state) => state.setProductBriefDraftGuard);
  const [collapsed, setCollapsed] = useState(false);
  const [panelTab, setPanelTab] = useState<ActivityPanelTab>("activity");
  const [specView, setSpecView] = useState<SpecView>("brief");
  const [brief, setBrief] = useState("");
  const [loadedBrief, setLoadedBrief] = useState("");
  const [specification, setSpecification] = useState<ProductSpecificationRecord | null>(null);
  const [structuredDraft, setStructuredDraft] = useState<Record<string, unknown> | null>(null);
  const [structuredDraftSourceVersion, setStructuredDraftSourceVersion] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [savingSpec, setSavingSpec] = useState(false);
  const [agentConnections, setAgentConnections] = useState<AgentConnectionRecord[]>([]);
  const [connectionLoading, setConnectionLoading] = useState(true);
  const [connectionError, setConnectionError] = useState<unknown>(null);
  const [latestTask, setLatestTask] = useState<AgentTaskRecord | null>(null);
  const [reviewTask, setReviewTask] = useState<AgentTaskRecord | null>(null);
  const [reviewPreview, setReviewPreview] = useState<DesignPreviewRecord | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [previewRenderStatus, setPreviewRenderStatus] = useState<PreviewRenderStatus>("loading");
  const [previewRenderRetryKey, setPreviewRenderRetryKey] = useState(0);
  const [planningOpen, setPlanningOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshSequence = useRef(0);
  const displayedPreviewId = useRef<string | null>(null);
  const previewCommitKeys = useRef(new Map<string, string>());
  const specificationCommitAttempt = useRef<{
    fingerprint: string;
    previewId: string | null;
    idempotencyKey: string;
  } | null>(null);

  const clearAgentReview = useCallback(() => {
    setReviewTask(null);
    setReviewPreview(null);
    setPreviewRenderStatus("loading");
    setPreviewRenderRetryKey((value) => value + 1);
    displayedPreviewId.current = null;
  }, []);

  const retryPreviewRender = useCallback(() => {
    setPreviewRenderStatus("loading");
    setPreviewRenderRetryKey((value) => value + 1);
  }, []);

  const designId = document?.id;
  const fallbackBrief = typeof document?.metadata.product_brief === "string" ? document.metadata.product_brief : "";

  useEffect(() => {
    setLatestTask(null);
    setStructuredDraft(null);
    setStructuredDraftSourceVersion(null);
    setReviewError(null);
    setConnectionLoading(true);
    setConnectionError(null);
    clearAgentReview();
  }, [clearAgentReview, designId]);

  useEffect(() => {
    const openHistory = () => {
      setCollapsed(false);
      setPanelTab("activity");
      setSpecView("history");
      window.requestAnimationFrame(() => window.document.getElementById("product-specification-workspace")?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
    };
    window.addEventListener("formaspec:open-product-logic-history", openHistory);
    return () => window.removeEventListener("formaspec:open-product-logic-history", openHistory);
  }, []);

  useEffect(() => {
    if (!designId) return;
    let active = true;
    setSpecification(null);
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
        setSpecification(null);
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
      const requestedTaskId = new URLSearchParams(window.location.search).get("task")?.trim() ?? "";
      let requestedTask = requestedTaskId ? tasks.find((task) => task.id === requestedTaskId) ?? null : null;
      if (requestedTaskId && !requestedTask) requestedTask = await readAgentTask(requestedTaskId);
      if (requestedTask && requestedTask.designId !== designId) {
        throw new Error("The requested task belongs to another project and was not opened here.");
      }
      if (requestedTask && requestedTask.expectedOutput !== "design_preview") {
        throw new Error("The requested task does not produce a design preview for this review surface.");
      }
      const designTasks = tasks.filter((task) => task.expectedOutput === "design_preview");
      const newestDesignTask = requestedTask
        ?? designTasks.find((task) => task.status === "awaiting_approval")
        ?? designTasks[0]
        ?? null;
      setLatestTask(newestDesignTask ?? tasks[0] ?? null);
      const previewId = taskPreviewId(newestDesignTask);
      if (!newestDesignTask
        || !previewId
        || (newestDesignTask.status !== "awaiting_approval" && newestDesignTask.status !== "completed")) {
        clearAgentReview();
        setReviewError(null);
        return;
      }
      const preview = await readDesignPreview(designId, previewId, newestDesignTask.id);
      if (sequence !== refreshSequence.current) return;
      setReviewTask(newestDesignTask);
      setReviewPreview(preview);
      setReviewError(null);
      if (displayedPreviewId.current !== preview.previewId) {
        displayedPreviewId.current = preview.previewId;
        setPreviewRenderStatus("loading");
        setPreviewRenderRetryKey((value) => value + 1);
        setCollapsed(false);
        setPanelTab("activity");
        setNotice(`FormaSpec returned preview ${preview.previewId}. Review it below, then commit or discard it.`);
      }
    } catch (cause) {
      if (sequence !== refreshSequence.current) return;
      const failure = agentPreviewReadFailureDisposition(cause);
      setLatestTask((current) => current?.designId === designId ? current : null);
      if (failure.clearReview) clearAgentReview();
      setReviewError(failure.message);
    }
  }, [clearAgentReview, designId]);

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

  const effectiveSpecification = structuredDraft ?? specification?.specification ?? null;
  const counts = useMemo(() => specificationCounts(effectiveSpecification), [effectiveSpecification]);
  const briefChanged = brief !== loadedBrief || structuredDraft !== null;
  const connectionSummary = useMemo(
    () => summarizeCodexConnection(agentConnections, connectionError, connectionLoading, designId ?? null),
    [agentConnections, connectionError, connectionLoading, designId],
  );

  const persistBrief = useCallback(async (): Promise<ProductSpecificationRecord> => {
    if (!designId) throw new Error("Open a project before saving its product specification.");
    const normalizedBrief = brief.trim();
    if (!normalizedBrief) throw new Error("Describe the product before saving a specification.");
    if (!productSpecificationRequiresCommit(specification, briefChanged)) return specification!;

    setSavingSpec(true);
    setError(null);
    try {
      const currentVersion = specification?.version ?? 0;
      const nextStructuredSpecification = structuredDraft === null ? null : {
        ...structuredDraft,
        version: currentVersion + 1,
        natural_language_brief: normalizedBrief,
      };
      const fingerprint = `${designId}\u0000${currentVersion}\u0000${normalizedBrief}\u0000${nextStructuredSpecification === null ? "brief" : JSON.stringify(nextStructuredSpecification)}`;
      let attempt = specificationCommitAttempt.current;
      if (!attempt || attempt.fingerprint !== fingerprint) {
        attempt = { fingerprint, previewId: null, idempotencyKey: createClientKey("product_spec") };
        specificationCommitAttempt.current = attempt;
      }
      if (!attempt.previewId) {
        const preview = await withSubmissionTimeout(
          nextStructuredSpecification === null
            ? previewProductSpecification(designId, currentVersion, normalizedBrief)
            : previewTypedProductSpecification(designId, currentVersion, nextStructuredSpecification),
          "Product specification preview",
        );
        if (!preview.canCommit) throw new Error("The product specification preview contains validation errors.");
        attempt.previewId = preview.previewId;
      }
      const committed = await withSubmissionTimeout(commitProductSpecification(
        designId,
        attempt.previewId,
        currentVersion,
        attempt.idempotencyKey,
        structuredDraftSourceVersion === null
          ? "Update product brief"
          : `Edit product specification version ${structuredDraftSourceVersion} as a new immutable version`,
      ), "Product specification commit");
      specificationCommitAttempt.current = null;
      setSpecification(committed);
      setBrief(committed.naturalLanguageBrief);
      setLoadedBrief(committed.naturalLanguageBrief);
      setStructuredDraft(null);
      setStructuredDraftSourceVersion(null);
      setNotice(`Product specification version ${committed.version} saved.`);
      return committed;
    } catch (cause) {
      if (cause instanceof ApiError && ["PREVIEW_EXPIRED", "NOT_FOUND", "VERSION_CONFLICT"].includes(cause.code)) {
        specificationCommitAttempt.current = null;
      }
      if (cause instanceof ApiError && cause.code === "VERSION_CONFLICT") {
        try {
          const latest = await readProductSpecification(designId);
          setSpecification(latest);
          setLoadedBrief(latest.naturalLanguageBrief);
          throw new Error(`Product logic advanced to version ${latest.version} while you were editing. Your draft is preserved. Review it against the refreshed current version, then press Save specification again to explicitly create version ${latest.version + 1}.`);
        } catch (refreshCause) {
          if (!(refreshCause instanceof ApiError)) throw refreshCause;
          throw new Error("Product logic changed concurrently. Your draft is preserved; reload the current version and reconcile it explicitly before saving again.");
        }
      }
      throw cause;
    } finally {
      setSavingSpec(false);
    }
  }, [brief, briefChanged, designId, setNotice, specification, structuredDraft, structuredDraftSourceVersion]);

  useEffect(() => {
    if (!designId) return;
    const discard = () => {
      setBrief(loadedBrief);
      setStructuredDraft(null);
      setStructuredDraftSourceVersion(null);
      setError(null);
      specificationCommitAttempt.current = null;
    };
    setProductBriefDraftGuard({
      designId,
      draft: brief,
      persisted: loadedBrief,
      dirty: briefChanged,
      saving: savingSpec,
      save: async () => { await persistBrief(); },
      discard,
    });
    return () => {
      const current = useDesignerStore.getState().productBriefGuard;
      if (current?.designId === designId) setProductBriefDraftGuard(null);
    };
  }, [brief, briefChanged, designId, loadedBrief, persistBrief, savingSpec, setProductBriefDraftGuard]);

  const saveBrief = async () => {
    try {
      await persistBrief();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the product specification.");
    }
  };

  const appendAction = (action: string) => {
    setBrief((current) => `${current.trim()}${current.trim() ? "\n\n" : ""}${action}`);
    setSpecView("brief");
  };

  const editHistoricalSpecification = (record: ProductSpecificationRecord, sourceVersion: number) => {
    if (!record.specification) {
      setError(`Version ${sourceVersion} has no structured Product specification to copy.`);
      return;
    }
    const copy = JSON.parse(JSON.stringify(record.specification)) as Record<string, unknown>;
    copy.version = (specification?.version ?? 0) + 1;
    copy.natural_language_brief = record.naturalLanguageBrief;
    setStructuredDraft(copy);
    setStructuredDraftSourceVersion(sourceVersion);
    setBrief(record.naturalLanguageBrief);
    setSpecView("structured");
    setError(null);
    setNotice(`Copied Product logic version ${sourceVersion} into a new draft. Saving will create version ${(specification?.version ?? 0) + 1}; version ${sourceVersion} remains unchanged.`);
  };

  const openAgentConnection = () => {
    navigate("/administration/agents");
  };

  const openTaskInCodex = () => {
    if (!latestTask || !["queued", "claimed", "in_progress"].includes(latestTask.status)) return;
    try {
      openExistingCodexTask(latestTask.launchUrl);
      setNotice(`Opened existing task ${latestTask.id} in Codex. No new website task was created.`);
    } catch (cause) {
      setReviewError(cause instanceof Error ? cause.message : "The existing task could not be opened in Codex.");
    }
  };

  const openExactReview = () => {
    if (!designId || !reviewTask || !reviewPreview) {
      setReviewError("No exact persisted preview is ready for review yet.");
      return;
    }
    if (reviewTask.reviewDeepLink) {
      try {
        const link = new URL(reviewTask.reviewDeepLink, window.location.origin);
        if (link.origin === window.location.origin) {
          navigate(`${link.pathname}${link.search}${link.hash}`);
          return;
        }
      } catch {
        // Fall back to the validated local route below.
      }
    }
    navigate(designPreviewReviewPath(designId, reviewPreview.previewId, reviewTask.id));
  };

  const commitAgentPreview = async () => {
    if (!designId || !reviewTask || !reviewPreview) return;
    if (!reviewTask.readiness) {
      setReviewError("This proposal has no immutable FormaSpec readiness report. Regenerate it before approval.");
      return;
    }
    const current = useDesignerStore.getState();
    setReviewBusy(true);
    setReviewError(null);
    try {
      const outcome = await commitInlineAgentPreviewWhenAllowed({
        editor: current,
        previewRenderStatus,
        previewBaseVersion: reviewPreview.rootBaseVersion,
        commit: async () => {
          const idempotencyKey = previewCommitKeys.current.get(reviewPreview.previewId)
            ?? createClientKey("agent_preview_commit");
          previewCommitKeys.current.set(reviewPreview.previewId, idempotencyKey);
          return commitDesignPreview({
            designId,
            previewId: reviewPreview.previewId,
            taskId: reviewTask.id,
            expectedBaseVersion: reviewPreview.rootBaseVersion,
            idempotencyKey,
            message: `Approve FormaSpec proposal from task ${reviewTask.id}`,
            kind: reviewPreview.kind,
          });
        },
        openDesign: async () => { await openDesign(designId); },
      });
      if (outcome.status === "blocked") {
        setReviewError(outcome.message);
        return;
      }
      const approved = outcome.value;
      if (approved.task) setLatestTask(approved.task);
      await refreshAgentActivity();
      setNotice(`Committed FormaSpec preview as immutable version ${approved.version}.`);
    } catch (cause) {
      setReviewError(cause instanceof Error ? cause.message : "The agent preview could not be committed.");
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
      clearAgentReview();
      setNotice("Discarded the FormaSpec proposal. No design revision was created.");
    } catch (cause) {
      setReviewError(cause instanceof Error ? cause.message : "The proposed preview could not be discarded.");
    } finally {
      setReviewBusy(false);
    }
  };

  if (!document) return null;

  return (
    <section id="product-specification-workspace" className={`product-workspace-panel ${collapsed ? "is-collapsed" : ""} ${latestTask ? "has-agent-task" : ""} ${reviewPreview ? "has-agent-preview" : ""}`} aria-label="Product specification and agent activity">
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
              <div><WandSparkles size={16} /><span><strong>Describe the product, business logic, and constraints</strong><small>Save immutable Product logic here, then start agent work from Codex or the CLI.</small></span></div>
              <div className="spec-view-toggle">
                <button className={specView === "brief" ? "is-active" : ""} onClick={() => setSpecView("brief")}><MessageSquareText size={10} /> Brief</button>
                <button className={specView === "structured" ? "is-active" : ""} onClick={() => setSpecView("structured")}><Braces size={10} /> Structured</button>
                <button className={specView === "history" ? "is-active" : ""} onClick={() => setSpecView("history")}><Clock3 size={10} /> History</button>
              </div>
            </div>

            {specView === "brief" ? (
              <textarea
                value={brief}
                onChange={(event) => setBrief(event.target.value)}
                disabled={loading || savingSpec || Boolean(archiveReview)}
                placeholder="Example: Build an internal courier operations dashboard. Dispatchers assign orders, couriers update delivery states, finance can view but not edit payouts, Persian and English are required, and sensitive actions need confirmation…"
                aria-label="Describe the product, business logic, and constraints"
              />
            ) : specView === "structured" ? (
              <div className="structured-spec-summary">
                {structuredDraftSourceVersion !== null && <p className="structured-spec-draft-note">Editing immutable version {structuredDraftSourceVersion} as new version {(specification?.version ?? 0) + 1}. The historical version will not change.</p>}
                {counts.length > 0 ? counts.map(([label, count]) => <span key={label}><strong>{count}</strong>{label}</span>) : <p>Save the brief to create the first typed specification proposal. Agents refine this through preview and commit, never through executable business-rule text.</p>}
              </div>
            ) : designId ? (
              <ProductSpecificationHistory designId={designId} current={specification} onEditAsNew={editHistoricalSpecification} />
            ) : null}

            {specView !== "history" && <div className="contextual-agent-actions">
              {contextualActions.map((action) => <button key={action} onClick={() => appendAction(action)}>{action}</button>)}
            </div>}

            <div className="product-brief-actions">
              <div>
                {error ? <span className="product-panel-error">{error}</span> : latestTask ? <span className="product-panel-success"><CheckCircle2 size={11} /> Codex/CLI task {latestTask.id} · {latestTask.status}</span> : <span>In Codex or CLI, mention <code>{FORMASPEC_AGENT_MENTION}</code></span>}
              </div>
              <button className="button button-primary" disabled={!productSpecificationRequiresCommit(specification, briefChanged) || savingSpec || loading} onClick={() => void saveBrief()}>{savingSpec ? <LoaderCircle size={13} className="spin" /> : <FileCheck2 size={13} />} Save specification</button>
            </div>
          </div>

          <AgentTaskWorkflowCard
            connectionState={connectionSummary.state}
            connectionMessage={connectionSummary.message}
            task={latestTask}
            preview={reviewPreview}
            busy={reviewBusy}
            actionError={reviewError}
            previewRenderStatus={previewRenderStatus}
            previewRenderRetryKey={previewRenderRetryKey}
            canCommit={Boolean(reviewTask && reviewPreview
              && reviewTask.status === "awaiting_approval"
              && reviewTask.readiness
              && reviewPreview.canCommit
              && reviewPreview.status === "ready"
              && baseVersion === reviewPreview.rootBaseVersion
              && pendingCount === 0
              && !savingDesign
              && !archiveReview
              && previewRenderStatus === "available")}
            canDiscard={Boolean(reviewTask && reviewPreview && reviewTask.status === "awaiting_approval")}
            onOpenCodex={openTaskInCodex}
            onConnect={openAgentConnection}
            onRetry={() => {
              retryPreviewRender();
              void refreshAgentActivity();
            }}
            onOpenReview={openExactReview}
            onCommit={() => void commitAgentPreview()}
            onDiscard={() => void discardAgentPreview()}
            onPreviewRenderStatusChange={setPreviewRenderStatus}
            onRetryPreviewRender={retryPreviewRender}
            onOpenPlanning={() => setPlanningOpen(true)}
          />
        </div>
      )}

      {!collapsed && panelTab === "handoff" && (
        <EngineeringHandoffPanel designId={document.id} baseVersion={baseVersion} brief={brief} />
      )}

      {!collapsed && panelTab === "diagnostics" && <PreviewDiagnosticsSummary preview={reviewPreview} />}

      {!collapsed && panelTab === "revision" && (
        <PreviewRevisionSummary
          task={reviewTask}
          preview={reviewPreview}
          previewRenderStatus={previewRenderStatus}
          previewRenderRetryKey={previewRenderRetryKey}
          onOpen={openExactReview}
          onPreviewRenderStatusChange={setPreviewRenderStatus}
          onRetryPreviewRender={retryPreviewRender}
        />
      )}
      <PlanningInterview designId={document.id} open={planningOpen} onClose={() => setPlanningOpen(false)} />
    </section>
  );
}
