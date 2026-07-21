import {
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ClipboardCheck,
  Code2,
  Database,
  GitBranch,
  History,
  Link2,
  ListChecks,
  LoaderCircle,
  Play,
  RefreshCcw,
  Send,
  ShieldCheck,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  ApiError,
  approveEngineeringHandoff,
  completeEngineeringHandoff,
  createEngineeringHandoff,
  createImplementationMappings,
  HANDOFF_EXECUTION_DECISION_KINDS,
  listEngineeringHandoffs,
  listHistory,
  listImplementationMappings,
  listRepositoryInventories,
  readEngineeringHandoff,
  readHandoffExecutionDecisions,
  readRepositoryInventory,
  readRevisionInspect,
  recordHandoffExecutionDecision,
  startEngineeringHandoffImplementation,
  submitEngineeringHandoff,
  type EngineeringHandoffRecord,
  type HandoffExecutionDecisionKind,
  type HandoffExecutionDecisionOutcome,
  type HandoffExecutionDecisionReadResult,
  type HandoffExecutionDecisionRecord,
  type HandoffExecutionDecisionRequest,
  type HandoffExecutionDecisionState,
  type HandoffValidationCheck,
  type ImplementationMappingEntityKind,
  type ImplementationMappingRecord,
  type RepositoryInventoryRecord,
  type RepositoryInventorySummary,
  type RevisionInspectResult,
} from "../lib/api";

export interface ImplementationMappingDesignEntity {
  kind: ImplementationMappingEntityKind;
  id: string;
  label: string;
  detail: string;
}

type InventoryEntity = RepositoryInventoryRecord["inventory"]["entities"][number];

const MAPPING_KIND_ORDER: readonly ImplementationMappingEntityKind[] = [
  "screen",
  "component",
  "token",
  "asset",
  "flow",
  "business_rule",
];

const MAPPING_KIND_LABELS: Record<ImplementationMappingEntityKind, string> = {
  component: "Components",
  token: "Tokens",
  screen: "Screens",
  asset: "Assets",
  flow: "Flows",
  business_rule: "Business rules",
};

const COMPATIBLE_INVENTORY_KINDS: Record<ImplementationMappingEntityKind, readonly string[]> = {
  component: ["component"],
  token: ["token"],
  screen: ["screen", "route"],
  asset: ["asset"],
  flow: ["flow", "route"],
  business_rule: ["business-rule"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordText(value: Record<string, unknown>, key: string, fallback: string): string {
  const candidate = value[key];
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate : fallback;
}

function productSpecification(inspect: RevisionInspectResult): Record<string, unknown> | null {
  if (inspect.productSpecification && isRecord(inspect.productSpecification.specification)) {
    return inspect.productSpecification.specification;
  }
  if (inspect.document.schema_version === 2 && isRecord(inspect.document.product_specification)) {
    return inspect.document.product_specification as unknown as Record<string, unknown>;
  }
  return null;
}

function productSpecificationItems(inspect: RevisionInspectResult, key: "flows" | "business_rules"): Record<string, unknown>[] {
  const specification = productSpecification(inspect);
  const value = specification?.[key];
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function implementationMappingDesignEntities(inspect: RevisionInspectResult): ImplementationMappingDesignEntity[] {
  if (inspect.document.schema_version !== 2) return [];
  const entities: ImplementationMappingDesignEntity[] = [];

  for (const node of inspect.nodes) {
    if (node.type !== "frame" || node.archived) continue;
    entities.push({ kind: "screen", id: node.id, label: node.name, detail: "Active frame in this revision" });
  }
  for (const component of inspect.evidence.components) {
    entities.push({ kind: "component", id: component.id, label: component.name, detail: `${component.key} · v${component.version}` });
  }
  for (const token of inspect.evidence.tokens) {
    entities.push({ kind: "token", id: token.id, label: token.path || token.name, detail: `${token.family} · ${token.layer}` });
  }
  for (const asset of inspect.evidence.assets) {
    entities.push({ kind: "asset", id: asset.id, label: asset.name, detail: `${asset.kind} · ${asset.status}` });
  }
  for (const flow of productSpecificationItems(inspect, "flows")) {
    const id = recordText(flow, "id", "");
    if (id) entities.push({ kind: "flow", id, label: recordText(flow, "title", id), detail: "Product specification flow" });
  }
  const businessRules = inspect.evidence.businessRules.length > 0
    ? inspect.evidence.businessRules
    : productSpecificationItems(inspect, "business_rules");
  for (const rule of businessRules) {
    const id = recordText(rule, "id", "");
    if (id) entities.push({ kind: "business_rule", id, label: recordText(rule, "title", id), detail: "Product specification rule" });
  }

  const kindRank = new Map(MAPPING_KIND_ORDER.map((kind, index) => [kind, index]));
  return entities.sort((left, right) => {
    const rank = (kindRank.get(left.kind) ?? 99) - (kindRank.get(right.kind) ?? 99);
    return rank || left.label.localeCompare(right.label) || left.id.localeCompare(right.id);
  });
}

export function compatibleImplementationInventoryEntities(
  kind: ImplementationMappingEntityKind | null,
  entities: readonly InventoryEntity[],
): InventoryEntity[] {
  if (!kind) return [];
  const compatibleKinds = new Set(COMPATIBLE_INVENTORY_KINDS[kind]);
  return entities.filter((entity) => compatibleKinds.has(entity.kind));
}

export function implementationInventoryEntityLabel(entity: InventoryEntity): string {
  return `${entity.symbol ?? "Opaque source entity"} · ${entity.kind} · ${entity.id}`;
}

export function implementationMappingBatchInput(input: {
  designId: string;
  revisionId: string;
  expectedDesignVersion: number;
  inventoryId: string;
  idempotencyKey: string;
  designEntity: Pick<ImplementationMappingDesignEntity, "kind" | "id">;
  inventoryEntityId: string;
}) {
  return {
    designId: input.designId,
    revisionId: input.revisionId,
    expectedDesignVersion: input.expectedDesignVersion,
    inventoryId: input.inventoryId,
    idempotencyKey: input.idempotencyKey,
    mappings: [{
      entityKind: input.designEntity.kind,
      entityId: input.designEntity.id,
      inventoryEntityId: input.inventoryEntityId,
    }],
  };
}

export function engineeringHandoffSpecificationFromMappings(
  brief: string,
  mappings: readonly Pick<ImplementationMappingRecord, "entityId" | "inventoryEntityId" | "symbol">[],
) {
  if (mappings.length === 0) throw new Error("A handoff requires at least one reviewed implementation mapping.");
  const designEntityIds = [...new Set(mappings.map((mapping) => mapping.entityId))];
  const inventoryEntityIds = [...new Set(mappings.map((mapping) => mapping.inventoryEntityId))];
  const normalizedBrief = brief.trim() || "Implement the approved FormaSpec revision.";
  return {
    schemaVersion: 1,
    title: "Implement approved FormaSpec revision",
    summary: normalizedBrief.slice(0, 4_000),
    acceptanceCriteria: [{
      id: "approved_revision_matches",
      statement: "The implementation matches the exact approved FormaSpec revision through only the reviewed design-to-source mappings.",
      designEntityIds: designEntityIds.slice(0, 100),
    }],
    implementationSlices: [{
      id: "mapped_implementation",
      title: "Implement mapped product slice",
      objective: `Implement ${designEntityIds.length} reviewed FormaSpec ${designEntityIds.length === 1 ? "entity" : "entities"} through only the pinned opaque inventory mappings, without unrelated source changes.`,
      inventoryEntityIds,
      designEntityIds,
      dependsOn: [],
      validationChecks: ["typecheck", "unit_tests", "build"],
    }],
    risks: ["Implementation must remain within the reviewed mapping set pinned to this revision and inventory."],
    openQuestions: [],
    implementationPolicy: {
      preferredIsolation: "worktree",
      commitRequiresExplicitApproval: true,
      pullRequestRequiresExplicitRequest: true,
    },
  };
}

function designEntityKey(entity: Pick<ImplementationMappingDesignEntity, "kind" | "id">): string {
  return `${entity.kind}:${entity.id}`;
}

function shortHash(value: string): string {
  return value.length > 18 ? `${value.slice(0, 9)}…${value.slice(-7)}` : value;
}

function newMappingIdempotencyKey(): string {
  const randomPart = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `mapping-ui-${randomPart}`;
}

const VALIDATION_CHECKS: readonly HandoffValidationCheck[] = [
  "typecheck",
  "unit_tests",
  "integration_tests",
  "build",
  "lint",
  "visual_regression",
  "accessibility",
];

const EXECUTION_GATE_COPY: Record<HandoffExecutionDecisionKind, {
  title: string;
  owner: string;
  description: string;
}> = {
  plan_approval: {
    title: "Plan approval",
    owner: "Product manager or organization admin",
    description: "Confirms the immutable acceptance criteria and implementation slices.",
  },
  isolation_choice: {
    title: "Isolation",
    owner: "Engineer or organization admin",
    description: "Chooses a branch or worktree without sending a repository path to FormaSpec.",
  },
  diff_review: {
    title: "Diff review",
    owner: "Engineer or organization admin",
    description: "Pins review to a SHA-256 digest and a bounded changed-file count.",
  },
  validation_approval: {
    title: "Validation",
    owner: "Engineer or organization admin",
    description: "Records passed checks required by the immutable handoff plan.",
  },
  commit_approval: {
    title: "Commit approval",
    owner: "Product manager or organization admin",
    description: "Approves a commit only for the exact reviewed diff digest.",
  },
  push_authorization: {
    title: "Push disposition",
    owner: "Product manager or organization admin",
    description: "Explicitly authorizes a push or records that pushing is denied.",
  },
  pull_request_request: {
    title: "Pull request disposition",
    owner: "Product manager or organization admin",
    description: "Explicitly requests a pull request or records that none is requested.",
  },
};

function emptyExecutionDecisionState(): HandoffExecutionDecisionState {
  return Object.fromEntries(HANDOFF_EXECUTION_DECISION_KINDS.map((kind) => [kind, null])) as HandoffExecutionDecisionState;
}

function handoffDecisionSnapshot(handoff: EngineeringHandoffRecord): HandoffExecutionDecisionReadResult {
  const decisions = Array.isArray(handoff.executionDecisions) ? handoff.executionDecisions : [];
  const current = emptyExecutionDecisionState();
  const supplied = handoff.executionDecisionState as Partial<HandoffExecutionDecisionState> | undefined;
  for (const kind of HANDOFF_EXECUTION_DECISION_KINDS) current[kind] = supplied?.[kind] ?? null;
  if (!supplied) {
    for (const decision of decisions) {
      if (decision.handoffVersion === handoff.currentVersion) current[decision.kind] = decision;
    }
  }
  return { decisions, current };
}

function evidenceString(decision: HandoffExecutionDecisionRecord | null, key: string): string | null {
  const value = decision?.evidence[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function requiredHandoffValidationChecks(specification: Record<string, unknown>): HandoffValidationCheck[] {
  const slices = Array.isArray(specification.implementationSlices) ? specification.implementationSlices : [];
  const allowed = new Set<string>(VALIDATION_CHECKS);
  const checks = new Set<HandoffValidationCheck>();
  for (const slice of slices) {
    if (!isRecord(slice) || !Array.isArray(slice.validationChecks)) continue;
    for (const check of slice.validationChecks) {
      if (typeof check === "string" && allowed.has(check)) checks.add(check as HandoffValidationCheck);
    }
  }
  return VALIDATION_CHECKS.filter((check) => checks.has(check));
}

export interface HandoffGateReadiness {
  ready: boolean;
  missingOrBlocked: HandoffExecutionDecisionKind[];
  integrityIssues: string[];
}

export function handoffStartReadiness(current: HandoffExecutionDecisionState): HandoffGateReadiness {
  const missingOrBlocked: HandoffExecutionDecisionKind[] = [];
  if (current.plan_approval?.outcome !== "approved") missingOrBlocked.push("plan_approval");
  if (!current.isolation_choice || !["branch", "worktree"].includes(current.isolation_choice.outcome)) {
    missingOrBlocked.push("isolation_choice");
  }
  return { ready: missingOrBlocked.length === 0, missingOrBlocked, integrityIssues: [] };
}

export function handoffCompletionReadiness(
  current: HandoffExecutionDecisionState,
  requiredChecks: readonly HandoffValidationCheck[] = [],
): HandoffGateReadiness {
  const missingOrBlocked: HandoffExecutionDecisionKind[] = [];
  const accepted: Record<HandoffExecutionDecisionKind, readonly HandoffExecutionDecisionOutcome[]> = {
    plan_approval: ["approved"],
    isolation_choice: ["branch", "worktree"],
    diff_review: ["approved"],
    validation_approval: ["approved"],
    commit_approval: ["approved"],
    push_authorization: ["authorized", "denied", "revoked"],
    pull_request_request: ["requested", "not_requested", "denied", "revoked"],
  };
  for (const kind of HANDOFF_EXECUTION_DECISION_KINDS) {
    const decision = current[kind];
    if (!decision || !accepted[kind].includes(decision.outcome)) missingOrBlocked.push(kind);
  }

  const integrityIssues: string[] = [];
  const reviewedDiffHash = evidenceString(current.diff_review, "diffHash");
  const approvedCommitDiffHash = evidenceString(current.commit_approval, "diffHash");
  if (current.diff_review?.outcome === "approved" && current.commit_approval?.outcome === "approved"
    && reviewedDiffHash !== approvedCommitDiffHash) {
    integrityIssues.push("Commit approval does not reference the current reviewed diff.");
  }
  if (current.validation_approval?.outcome === "approved") {
    const rawChecks = current.validation_approval.evidence.checks;
    const supplied = new Set(Array.isArray(rawChecks)
      ? rawChecks.flatMap((check) => isRecord(check) && typeof check.name === "string" ? [check.name] : [])
      : []);
    const missingChecks = requiredChecks.filter((check) => !supplied.has(check));
    if (missingChecks.length > 0) integrityIssues.push(`Validation evidence is missing: ${missingChecks.join(", ")}.`);
  }
  if (current.pull_request_request?.outcome === "requested" && current.push_authorization?.outcome !== "authorized") {
    integrityIssues.push("A pull-request request requires current push authorization.");
  }

  return {
    ready: missingOrBlocked.length === 0 && integrityIssues.length === 0,
    missingOrBlocked,
    integrityIssues,
  };
}

export function handoffMutationErrorMessage(cause: unknown): string {
  if (!(cause instanceof ApiError)) return cause instanceof Error ? cause.message : "The handoff action could not be recorded.";
  if (cause.code === "FORBIDDEN") {
    return "This organization role is not authorized for that execution gate. No decision was recorded. [FORBIDDEN]";
  }
  if (cause.code === "VERSION_CONFLICT") {
    const details = isRecord(cause.details) ? cause.details : null;
    const currentDecisionId = details && typeof details.currentDecisionId === "string" ? details.currentDecisionId : null;
    const missing = details && Array.isArray(details.missingOrBlocked)
      ? details.missingOrBlocked.filter((item): item is string => typeof item === "string")
      : [];
    if (currentDecisionId) return `This gate changed concurrently. Latest decision ${currentDecisionId} was loaded; review it before retrying. [VERSION_CONFLICT]`;
    if (missing.length > 0) return `Required execution gates are missing or blocked: ${missing.join(", ")}. [VERSION_CONFLICT]`;
    return `${cause.message} Refresh and review the current immutable decisions before retrying. [VERSION_CONFLICT]`;
  }
  if (cause.code === "IDEMPOTENCY_CONFLICT") {
    return "This retry key was already used with different decision evidence. Review the current state before submitting again. [IDEMPOTENCY_CONFLICT]";
  }
  return `${cause.message} [${cause.code}]`;
}

function newExecutionIdempotencyKey(kind: HandoffExecutionDecisionKind): string {
  const randomPart = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `handoff-ui-${kind}-${randomPart}`;
}

function gateIsAffirmative(kind: HandoffExecutionDecisionKind, outcome: HandoffExecutionDecisionOutcome): boolean {
  if (kind === "isolation_choice") return outcome === "branch" || outcome === "worktree";
  if (kind === "push_authorization") return outcome === "authorized";
  if (kind === "pull_request_request") return outcome === "requested";
  return outcome === "approved";
}

function gateOutcomeOptions(
  kind: HandoffExecutionDecisionKind,
  current: HandoffExecutionDecisionRecord | null,
): Array<{ value: HandoffExecutionDecisionOutcome; label: string }> {
  const affirmative = kind === "isolation_choice"
    ? [{ value: "worktree" as const, label: "Use worktree" }, { value: "branch" as const, label: "Use branch" }]
    : kind === "push_authorization"
      ? [{ value: "authorized" as const, label: "Authorize push" }]
      : kind === "pull_request_request"
        ? [{ value: "requested" as const, label: "Request pull request" }, { value: "not_requested" as const, label: "No pull request" }]
        : [{ value: "approved" as const, label: "Approve" }];
  const options: Array<{ value: HandoffExecutionDecisionOutcome; label: string }> = [
    ...affirmative,
    { value: "denied", label: kind === "push_authorization" ? "Deny push" : "Deny" },
  ];
  if (current && gateIsAffirmative(kind, current.outcome)) options.push({ value: "revoked", label: "Revoke current decision" });
  return options;
}

function gateDefaultOutcome(
  kind: HandoffExecutionDecisionKind,
  current: HandoffExecutionDecisionRecord | null,
): HandoffExecutionDecisionOutcome {
  return gateOutcomeOptions(kind, current)[0]?.value ?? "denied";
}

function gateLifecycleAvailable(kind: HandoffExecutionDecisionKind, status: EngineeringHandoffRecord["status"]): boolean {
  if (kind === "plan_approval") return status === "in_review" || status === "approved" || status === "implementing";
  if (kind === "isolation_choice") return status === "approved" || status === "implementing";
  return status === "implementing";
}

function decisionEvidencePreview(decision: HandoffExecutionDecisionRecord): string[] {
  const lines: string[] = [];
  const summary = evidenceString(decision, "summary") ?? evidenceString(decision, "reason");
  if (summary) lines.push(summary);
  const diffHash = evidenceString(decision, "diffHash");
  if (diffHash) lines.push(`Diff ${shortHash(diffHash)}`);
  const changedFileCount = decision.evidence.changedFileCount;
  if (typeof changedFileCount === "number") lines.push(`${changedFileCount} changed ${changedFileCount === 1 ? "file" : "files"}`);
  const commitHash = evidenceString(decision, "commitHash");
  if (commitHash) lines.push(`Commit ${shortHash(commitHash)}`);
  const targetRef = evidenceString(decision, "targetRef");
  if (targetRef) lines.push(`Target ${targetRef}`);
  const title = evidenceString(decision, "title");
  if (title) lines.push(`PR: ${title}`);
  const baseRef = evidenceString(decision, "baseRef");
  const headRef = evidenceString(decision, "headRef");
  if (baseRef && headRef) lines.push(`${headRef} → ${baseRef}`);
  const checks = decision.evidence.checks;
  if (Array.isArray(checks)) {
    const names = checks.flatMap((check) => isRecord(check) && typeof check.name === "string" ? [check.name] : []);
    if (names.length > 0) lines.push(`Passed: ${names.join(", ")}`);
  }
  return lines.slice(0, 4);
}

interface DecisionMutation {
  kind: HandoffExecutionDecisionKind;
  outcome: HandoffExecutionDecisionOutcome;
  evidence: Record<string, unknown>;
}

interface ExecutionDecisionDraft {
  outcome: HandoffExecutionDecisionOutcome;
  summary: string;
  reason: string;
  diffHash: string;
  changedFileCount: string;
  validationEvidenceHash: string;
  commitMessage: string;
  commitHash: string;
  targetRef: string;
  pullRequestTitle: string;
  baseRef: string;
  headRef: string;
  acceptanceCriteriaConfirmed: boolean;
  implementationPlanConfirmed: boolean;
}

function initialExecutionDecisionDraft(
  kind: HandoffExecutionDecisionKind,
  current: HandoffExecutionDecisionRecord | null,
  reviewedDiffHash: string,
): ExecutionDecisionDraft {
  return {
    outcome: gateDefaultOutcome(kind, current),
    summary: "",
    reason: "",
    diffHash: reviewedDiffHash,
    changedFileCount: "0",
    validationEvidenceHash: "",
    commitMessage: "",
    commitHash: "",
    targetRef: "",
    pullRequestTitle: "",
    baseRef: "main",
    headRef: "",
    acceptanceCriteriaConfirmed: false,
    implementationPlanConfirmed: false,
  };
}

function buildDecisionMutation(
  kind: HandoffExecutionDecisionKind,
  draft: ExecutionDecisionDraft,
  selectedChecks: readonly HandoffValidationCheck[],
): DecisionMutation {
  if (draft.outcome === "denied" || draft.outcome === "revoked") {
    return { kind, outcome: draft.outcome, evidence: { reason: draft.reason.trim() } };
  }
  if (kind === "plan_approval") {
    return {
      kind,
      outcome: "approved",
      evidence: {
        summary: draft.summary.trim(),
        acceptanceCriteriaConfirmed: true,
        implementationPlanConfirmed: true,
      },
    };
  }
  if (kind === "isolation_choice") {
    return { kind, outcome: draft.outcome, evidence: { summary: draft.summary.trim() } };
  }
  if (kind === "diff_review") {
    return {
      kind,
      outcome: "approved",
      evidence: {
        summary: draft.summary.trim(),
        diffHash: draft.diffHash.trim().toLowerCase(),
        changedFileCount: Number(draft.changedFileCount),
      },
    };
  }
  if (kind === "validation_approval") {
    const evidenceHash = draft.validationEvidenceHash.trim().toLowerCase();
    return {
      kind,
      outcome: "approved",
      evidence: {
        summary: draft.summary.trim(),
        checks: selectedChecks.map((name) => ({
          name,
          status: "passed",
          ...(evidenceHash ? { evidenceHash } : {}),
        })),
      },
    };
  }
  if (kind === "commit_approval") {
    return {
      kind,
      outcome: "approved",
      evidence: {
        summary: draft.summary.trim(),
        diffHash: draft.diffHash.trim().toLowerCase(),
        commitMessage: draft.commitMessage.trim(),
      },
    };
  }
  if (kind === "push_authorization") {
    return {
      kind,
      outcome: "authorized",
      evidence: {
        summary: draft.summary.trim(),
        commitHash: draft.commitHash.trim().toLowerCase(),
        targetRef: draft.targetRef.trim(),
      },
    };
  }
  if (draft.outcome === "not_requested") {
    return { kind, outcome: "not_requested", evidence: { reason: draft.reason.trim() } };
  }
  return {
    kind,
    outcome: "requested",
    evidence: {
      summary: draft.summary.trim(),
      title: draft.pullRequestTitle.trim(),
      baseRef: draft.baseRef.trim(),
      headRef: draft.headRef.trim(),
    },
  };
}

function isSafeGitReference(value: string): boolean {
  const reference = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(reference)
    && !reference.includes("..")
    && !reference.includes("@{")
    && !reference.endsWith("/")
    && !reference.endsWith(".lock");
}

function decisionDraftCanSubmit(
  kind: HandoffExecutionDecisionKind,
  draft: ExecutionDecisionDraft,
  selectedChecks: readonly HandoffValidationCheck[],
): boolean {
  if (draft.outcome === "denied" || draft.outcome === "revoked" || draft.outcome === "not_requested") {
    return draft.reason.trim().length > 0;
  }
  if (!draft.summary.trim()) return false;
  if (kind === "plan_approval") {
    return draft.acceptanceCriteriaConfirmed && draft.implementationPlanConfirmed;
  }
  if (kind === "diff_review") {
    const changedFileCount = Number(draft.changedFileCount);
    return /^[a-f0-9]{64}$/i.test(draft.diffHash.trim())
      && Number.isSafeInteger(changedFileCount)
      && changedFileCount >= 0
      && changedFileCount <= 100_000;
  }
  if (kind === "validation_approval") {
    return selectedChecks.length > 0
      && (!draft.validationEvidenceHash.trim() || /^[a-f0-9]{64}$/i.test(draft.validationEvidenceHash.trim()));
  }
  if (kind === "commit_approval") {
    return /^[a-f0-9]{64}$/i.test(draft.diffHash.trim()) && draft.commitMessage.trim().length > 0;
  }
  if (kind === "push_authorization") {
    return /^[a-f0-9]{40,64}$/i.test(draft.commitHash.trim())
      && isSafeGitReference(draft.targetRef);
  }
  if (kind === "pull_request_request") {
    return draft.pullRequestTitle.trim().length > 0
      && isSafeGitReference(draft.baseRef)
      && isSafeGitReference(draft.headRef)
      && draft.baseRef.trim() !== draft.headRef.trim();
  }
  return true;
}

function HandoffExecutionDecisionForm({
  kind,
  current,
  status,
  requiredChecks,
  reviewedDiffHash,
  busy,
  onRecord,
  onApprovePlan,
}: {
  kind: HandoffExecutionDecisionKind;
  current: HandoffExecutionDecisionRecord | null;
  status: EngineeringHandoffRecord["status"];
  requiredChecks: readonly HandoffValidationCheck[];
  reviewedDiffHash: string;
  busy: boolean;
  onRecord: (mutation: DecisionMutation) => Promise<void>;
  onApprovePlan: (summary: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(() => initialExecutionDecisionDraft(kind, current, reviewedDiffHash));
  const [selectedChecks, setSelectedChecks] = useState<HandoffValidationCheck[]>(() => [...requiredChecks]);
  const currentId = current?.id ?? null;

  useEffect(() => {
    setDraft(initialExecutionDecisionDraft(kind, current, reviewedDiffHash));
    setSelectedChecks([...requiredChecks]);
  }, [currentId, kind, requiredChecks.join("\0"), reviewedDiffHash]);

  const available = gateLifecycleAvailable(kind, status);
  const initialPlanApproval = kind === "plan_approval" && status === "in_review" && draft.outcome === "approved";
  const canSubmit = available && decisionDraftCanSubmit(kind, draft, selectedChecks);
  const isReasonOutcome = draft.outcome === "denied" || draft.outcome === "revoked" || draft.outcome === "not_requested";
  const update = <TKey extends keyof ExecutionDecisionDraft>(key: TKey, value: ExecutionDecisionDraft[TKey]) => {
    setDraft((existing) => ({ ...existing, [key]: value }));
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    if (initialPlanApproval) {
      await onApprovePlan(draft.summary.trim());
      return;
    }
    await onRecord(buildDecisionMutation(kind, draft, selectedChecks));
  };

  if (!available) {
    return <div className="execution-gate-locked">{status === "draft"
      ? "Submit this handoff for review before recording execution decisions."
      : status === "in_review"
        ? "Available after the reviewed plan is approved."
        : status === "approved"
          ? "Available after implementation is explicitly started."
          : "This immutable handoff lifecycle no longer accepts new decisions."}</div>;
  }

  return (
    <form className="execution-decision-form" onSubmit={(event) => void submit(event)}>
      <div className="execution-form-row">
        <label>
          <span>Decision</span>
          <select aria-label={`${EXECUTION_GATE_COPY[kind].title} decision`} value={draft.outcome} disabled={busy} onChange={(event) => update("outcome", event.target.value as HandoffExecutionDecisionOutcome)}>
            {gateOutcomeOptions(kind, current).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <small>{EXECUTION_GATE_COPY[kind].owner}</small>
      </div>

      {isReasonOutcome ? <label className="execution-field-wide">
        <span>{draft.outcome === "not_requested" ? "Reason no pull request is requested" : `${draft.outcome === "revoked" ? "Revocation" : "Denial"} reason`}</span>
        <textarea value={draft.reason} maxLength={2_000} required disabled={busy} onChange={(event) => update("reason", event.target.value)} />
      </label> : <>
        <label className="execution-field-wide">
          <span>Evidence summary</span>
          <textarea value={draft.summary} maxLength={2_000} required disabled={busy} onChange={(event) => update("summary", event.target.value)} />
        </label>

        {kind === "plan_approval" && <div className="execution-confirmations">
          <label><input type="checkbox" checked={draft.acceptanceCriteriaConfirmed} disabled={busy} onChange={(event) => update("acceptanceCriteriaConfirmed", event.target.checked)} /> I reviewed the acceptance criteria.</label>
          <label><input type="checkbox" checked={draft.implementationPlanConfirmed} disabled={busy} onChange={(event) => update("implementationPlanConfirmed", event.target.checked)} /> I reviewed the implementation slices.</label>
        </div>}

        {kind === "diff_review" && <div className="execution-field-grid">
          <label><span>Diff SHA-256</span><input value={draft.diffHash} minLength={64} maxLength={64} pattern="[A-Fa-f0-9]{64}" required disabled={busy} onChange={(event) => update("diffHash", event.target.value)} /></label>
          <label><span>Changed file count</span><input type="number" min="0" max="100000" step="1" value={draft.changedFileCount} required disabled={busy} onChange={(event) => update("changedFileCount", event.target.value)} /></label>
        </div>}

        {kind === "validation_approval" && <>
          <div className="execution-validation-checks" role="group" aria-label="Passed validation checks">
            {VALIDATION_CHECKS.map((check) => {
              const required = requiredChecks.includes(check);
              const checked = selectedChecks.includes(check);
              return <label key={check} className={required ? "is-required" : ""}><input type="checkbox" checked={checked} disabled={busy || required} onChange={(event) => setSelectedChecks((existing) => event.target.checked ? [...existing, check] : existing.filter((item) => item !== check))} /> {check.replaceAll("_", " ")}{required ? " · required" : ""}</label>;
            })}
          </div>
          <label className="execution-field-wide"><span>Shared evidence SHA-256 (optional)</span><input value={draft.validationEvidenceHash} minLength={64} maxLength={64} pattern="[A-Fa-f0-9]{64}" disabled={busy} onChange={(event) => update("validationEvidenceHash", event.target.value)} /></label>
        </>}

        {kind === "commit_approval" && <div className="execution-field-grid">
          <label><span>Reviewed diff SHA-256</span><input value={draft.diffHash} minLength={64} maxLength={64} pattern="[A-Fa-f0-9]{64}" required disabled={busy} onChange={(event) => update("diffHash", event.target.value)} /></label>
          <label><span>Approved commit message</span><input value={draft.commitMessage} maxLength={240} required disabled={busy} onChange={(event) => update("commitMessage", event.target.value)} /></label>
        </div>}

        {kind === "push_authorization" && <div className="execution-field-grid">
          <label><span>Commit hash</span><input value={draft.commitHash} minLength={40} maxLength={64} pattern="[A-Fa-f0-9]{40,64}" required disabled={busy} onChange={(event) => update("commitHash", event.target.value)} /></label>
          <label><span>Target Git ref</span><input value={draft.targetRef} maxLength={200} placeholder="feature/approved-change" required disabled={busy} onChange={(event) => update("targetRef", event.target.value)} /></label>
        </div>}

        {kind === "pull_request_request" && <div className="execution-field-grid execution-field-grid-pr">
          <label className="wide"><span>Pull request title</span><input value={draft.pullRequestTitle} maxLength={240} required disabled={busy} onChange={(event) => update("pullRequestTitle", event.target.value)} /></label>
          <label><span>Base Git ref</span><input value={draft.baseRef} maxLength={200} required disabled={busy} onChange={(event) => update("baseRef", event.target.value)} /></label>
          <label><span>Head Git ref</span><input value={draft.headRef} maxLength={200} required disabled={busy} onChange={(event) => update("headRef", event.target.value)} /></label>
        </div>}
      </>}

      <footer>
        <span>Append-only · current decision CAS · no source command is executed here</span>
        <button className={`button ${isReasonOutcome ? "button-secondary" : "button-primary"}`} type="submit" disabled={busy || !canSubmit}>
          {busy ? <LoaderCircle size={12} className="spin" /> : isReasonOutcome ? <Ban size={12} /> : <CheckCircle2 size={12} />}
          {initialPlanApproval ? "Approve reviewed plan" : draft.outcome === "revoked" ? "Record revocation" : draft.outcome === "denied" ? "Record denial" : draft.outcome === "not_requested" ? "Record no pull request" : "Record decision"}
        </button>
      </footer>
    </form>
  );
}

export function HandoffExecutionReview({
  handoff,
  onHandoffChanged,
}: {
  handoff: EngineeringHandoffRecord;
  onHandoffChanged: (handoff: EngineeringHandoffRecord) => void;
}) {
  const [snapshot, setSnapshot] = useState<HandoffExecutionDecisionReadResult>(() => handoffDecisionSnapshot(handoff));
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [completionSummary, setCompletionSummary] = useState("");
  const retryKeys = useRef(new Map<HandoffExecutionDecisionKind, { signature: string; key: string }>());

  const refreshDecisions = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      const next = await readHandoffExecutionDecisions(handoff.id);
      setSnapshot(next);
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [handoff.id]);

  useEffect(() => {
    setSnapshot(handoffDecisionSnapshot(handoff));
    setCompletionSummary("");
    setError(null);
    retryKeys.current.clear();
    void refreshDecisions(true).catch((cause) => setError(handoffMutationErrorMessage(cause)));
  }, [handoff.id, handoff.currentVersion, refreshDecisions]);

  const requiredChecks = useMemo(
    () => requiredHandoffValidationChecks(handoff.specification),
    [handoff.specification],
  );
  const startReadiness = handoffStartReadiness(snapshot.current);
  const completionReadiness = handoffCompletionReadiness(snapshot.current, requiredChecks);
  const reviewedDiffHash = evidenceString(snapshot.current.diff_review, "diffHash") ?? "";

  const refreshAfterConflict = async (cause: unknown) => {
    if (cause instanceof ApiError && cause.code === "VERSION_CONFLICT") {
      try {
        const [latestHandoff, latestDecisions] = await Promise.all([
          readEngineeringHandoff(handoff.id),
          readHandoffExecutionDecisions(handoff.id),
        ]);
        onHandoffChanged(latestHandoff);
        setSnapshot(latestDecisions);
      } catch { /* Preserve the mutation conflict as the actionable error. */ }
    }
  };

  const recordDecision = async (mutation: DecisionMutation) => {
    const priorDecisionId = snapshot.current[mutation.kind]?.id ?? null;
    const signature = JSON.stringify({
      expectedVersion: handoff.currentVersion,
      expectedPriorDecisionId: priorDecisionId,
      ...mutation,
    });
    const retry = retryKeys.current.get(mutation.kind);
    const idempotencyKey = retry?.signature === signature ? retry.key : newExecutionIdempotencyKey(mutation.kind);
    retryKeys.current.set(mutation.kind, { signature, key: idempotencyKey });
    setBusy(mutation.kind);
    setError(null);
    try {
      await recordHandoffExecutionDecision(handoff.id, {
        expectedVersion: handoff.currentVersion,
        expectedPriorDecisionId: priorDecisionId,
        idempotencyKey,
        ...mutation,
      } as HandoffExecutionDecisionRequest);
      retryKeys.current.delete(mutation.kind);
      await refreshDecisions();
    } catch (cause) {
      if (!(cause instanceof ApiError) || !cause.retryable) retryKeys.current.delete(mutation.kind);
      setError(handoffMutationErrorMessage(cause));
      await refreshAfterConflict(cause);
    } finally {
      setBusy(null);
    }
  };

  const updateFromTransition = async (action: string, transition: () => Promise<EngineeringHandoffRecord>) => {
    setBusy(action);
    setError(null);
    try {
      const next = await transition();
      onHandoffChanged(next);
      setSnapshot(handoffDecisionSnapshot(next));
      await refreshDecisions();
    } catch (cause) {
      setError(handoffMutationErrorMessage(cause));
      await refreshAfterConflict(cause);
    } finally {
      setBusy(null);
    }
  };

  const approvePlan = async (summary: string) => updateFromTransition(
    "approve-plan",
    () => approveEngineeringHandoff(
      handoff.id,
      handoff.currentVersion,
      snapshot.current.plan_approval?.id ?? null,
      summary,
    ),
  );
  const startImplementation = async () => updateFromTransition(
    "start-implementation",
    () => startEngineeringHandoffImplementation(handoff.id, handoff.currentVersion),
  );
  const completeImplementation = async () => updateFromTransition(
    "complete-implementation",
    () => completeEngineeringHandoff(handoff.id, handoff.currentVersion, completionSummary.trim()),
  );

  return (
    <section className="handoff-execution-review" aria-label={`Execution decisions for ${handoff.id}`}>
      <header>
        <div><ListChecks size={14} /><span><strong>Immutable execution controls</strong><small>Each role records only its authorized gate. Decisions replace state by append-only CAS.</small></span></div>
        <button className="icon-button" type="button" aria-label="Refresh execution decisions" disabled={loading || busy !== null} onClick={() => void refreshDecisions(true).catch((cause) => setError(handoffMutationErrorMessage(cause)))}><RefreshCcw size={12} /></button>
      </header>
      {error && <div className="execution-review-error" role="alert">{error}</div>}
      {loading ? <div className="execution-review-loading"><LoaderCircle className="spin" size={14} /> Loading immutable gate history…</div> : <>
        <div className="execution-readiness-strip">
          <span className={startReadiness.ready ? "is-ready" : "is-blocked"}><GitBranch size={11} /> Start {startReadiness.ready ? "ready" : `${startReadiness.missingOrBlocked.length} blocked`}</span>
          <span className={completionReadiness.ready ? "is-ready" : "is-blocked"}><CheckCircle2 size={11} /> Complete {completionReadiness.ready ? "ready" : `${completionReadiness.missingOrBlocked.length + completionReadiness.integrityIssues.length} blocked`}</span>
          <span><History size={11} /> {snapshot.decisions.length} immutable {snapshot.decisions.length === 1 ? "decision" : "decisions"}</span>
        </div>
        <div className="execution-gate-grid">
          {HANDOFF_EXECUTION_DECISION_KINDS.map((kind, index) => {
            const current = snapshot.current[kind];
            return <article key={kind} className={`execution-gate-card${current ? ` is-${current.outcome}` : " is-missing"}`}>
              <header>
                <span className="execution-gate-number">{index + 1}</span>
                <div><strong>{EXECUTION_GATE_COPY[kind].title}</strong><small>{EXECUTION_GATE_COPY[kind].description}</small></div>
                <span className="execution-gate-outcome">{current ? current.outcome.replaceAll("_", " ") : "missing"}</span>
              </header>
              {current && <div className="execution-current-decision">
                {decisionEvidencePreview(current).map((line, lineIndex) => <span key={`${current.id}-${lineIndex}`}>{line}</span>)}
                <small>{current.actorId} · {new Date(current.createdAt).toLocaleString()} · evidence {shortHash(current.evidenceHash)}</small>
              </div>}
              <HandoffExecutionDecisionForm
                kind={kind}
                current={current}
                status={handoff.status}
                requiredChecks={requiredChecks}
                reviewedDiffHash={reviewedDiffHash}
                busy={busy !== null}
                onRecord={recordDecision}
                onApprovePlan={approvePlan}
              />
            </article>;
          })}
        </div>

        <div className="execution-lifecycle-actions">
          <div>
            <strong>Implementation lifecycle</strong>
            <span>{handoff.status === "approved"
              ? startReadiness.ready ? "The approved plan and isolation choice are current." : `Start is blocked by: ${startReadiness.missingOrBlocked.join(", ")}.`
              : handoff.status === "implementing"
                ? completionReadiness.ready ? "All seven current dispositions satisfy completion rules." : `Completion is blocked by: ${[...completionReadiness.missingOrBlocked, ...completionReadiness.integrityIssues].join(", ")}.`
                : `Current handoff status: ${handoff.status.replaceAll("_", " ")}.`}</span>
          </div>
          {handoff.status === "approved" && <button className="button button-primary" type="button" disabled={busy !== null || !startReadiness.ready} onClick={() => void startImplementation()}>{busy === "start-implementation" ? <LoaderCircle size={12} className="spin" /> : <Play size={12} />} Authorize implementation stage</button>}
          {handoff.status === "implementing" && <div className="execution-complete-control">
            <input aria-label="Implementation completion summary" value={completionSummary} maxLength={4_000} placeholder="Summarize the completed approved implementation" disabled={busy !== null} onChange={(event) => setCompletionSummary(event.target.value)} />
            <button className="button button-primary" type="button" disabled={busy !== null || !completionReadiness.ready || !completionSummary.trim()} onClick={() => void completeImplementation()}>{busy === "complete-implementation" ? <LoaderCircle size={12} className="spin" /> : <CheckCircle2 size={12} />} Complete from decisions</button>
          </div>}
        </div>

        <details className="execution-decision-history">
          <summary><History size={12} /> Immutable decision history</summary>
          <div>{snapshot.decisions.length === 0 ? <span>No decision has been recorded.</span> : [...snapshot.decisions].reverse().map((decision) => <article key={decision.id}>
            <span>#{decision.sequence}</span>
            <div><strong>{EXECUTION_GATE_COPY[decision.kind].title} · {decision.outcome.replaceAll("_", " ")}</strong><small>Handoff v{decision.handoffVersion} · {decision.actorId} · {new Date(decision.createdAt).toLocaleString()}</small><code>{decision.id} · evidence {decision.evidenceHash}</code></div>
          </article>)}</div>
        </details>
      </>}
    </section>
  );
}

export function EngineeringHandoffPanel({
  designId,
  baseVersion,
  brief,
}: {
  designId: string;
  baseVersion: number;
  brief: string;
}) {
  const [handoffs, setHandoffs] = useState<EngineeringHandoffRecord[]>([]);
  const [inventories, setInventories] = useState<RepositoryInventorySummary[]>([]);
  const [pinnedRevision, setPinnedRevision] = useState<{ id: string; version: number } | null>(null);
  const [inspect, setInspect] = useState<RevisionInspectResult | null>(null);
  const [mappings, setMappings] = useState<ImplementationMappingRecord[]>([]);
  const [selectedInventoryId, setSelectedInventoryId] = useState("");
  const [inventory, setInventory] = useState<RepositoryInventoryRecord | null>(null);
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [inventoryError, setInventoryError] = useState<string | null>(null);
  const [selectedDesignKey, setSelectedDesignKey] = useState("");
  const [selectedInventoryEntityId, setSelectedInventoryEntityId] = useState("");
  const [mappingSuccess, setMappingSuccess] = useState<string | null>(null);
  const [reviewingHandoffId, setReviewingHandoffId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mappingIdempotencyKey = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    setMappingSuccess(null);
    setSelectedInventoryId("");
    setSelectedDesignKey("");
    setSelectedInventoryEntityId("");
    setInventory(null);
    setPinnedRevision(null);
    setInspect(null);
    setMappings([]);
    mappingIdempotencyKey.current = null;
    try {
      const [nextHandoffs, nextInventories, history] = await Promise.all([
        listEngineeringHandoffs(designId),
        listRepositoryInventories(),
        listHistory(designId),
      ]);
      setHandoffs(nextHandoffs);
      setInventories(nextInventories);
      const revision = history.find((item) => item.version === baseVersion);
      if (!revision) {
        setPinnedRevision(null);
        setInspect(null);
        setMappings([]);
        setError(`Design version ${baseVersion} is not available in immutable history.`);
        return;
      }
      const [nextInspect, nextMappings] = await Promise.all([
        readRevisionInspect(designId, revision.id),
        listImplementationMappings({ designId, revisionId: revision.id, limit: 200 }),
      ]);
      if (nextInspect.revision.id !== revision.id || nextInspect.revision.version !== baseVersion) {
        throw new Error("Revision inspection did not return the exact requested design version.");
      }
      if (nextMappings.some((mapping) => mapping.revisionId !== revision.id || mapping.designVersion !== baseVersion)) {
        throw new Error("Implementation mappings were not pinned to the exact requested revision.");
      }
      setPinnedRevision({ id: revision.id, version: revision.version });
      setInspect(nextInspect);
      setMappings(nextMappings);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Engineering handoff context could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [baseVersion, designId]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    let active = true;
    setInventory(null);
    setInventoryError(null);
    setSelectedInventoryEntityId("");
    mappingIdempotencyKey.current = null;
    if (!selectedInventoryId) {
      setInventoryLoading(false);
      return () => { active = false; };
    }
    const summary = inventories.find((item) => item.id === selectedInventoryId && item.status === "active");
    if (!summary) {
      setInventoryError("Select an active repository inventory.");
      setInventoryLoading(false);
      return () => { active = false; };
    }
    setInventoryLoading(true);
    void readRepositoryInventory(selectedInventoryId).then((nextInventory) => {
      if (!active) return;
      if (nextInventory.status !== "active" || nextInventory.inventoryHash !== summary.inventoryHash) {
        throw new Error("The selected repository inventory is no longer the active immutable inventory.");
      }
      setInventory(nextInventory);
    }).catch((cause) => {
      if (active) setInventoryError(cause instanceof Error ? cause.message : "Repository inventory could not be loaded.");
    }).finally(() => {
      if (active) setInventoryLoading(false);
    });
    return () => { active = false; };
  }, [inventories, selectedInventoryId]);

  const activeInventories = useMemo(
    () => inventories.filter((item) => item.status === "active"),
    [inventories],
  );
  const designEntities = useMemo(
    () => inspect ? implementationMappingDesignEntities(inspect) : [],
    [inspect],
  );
  const selectedDesignEntity = useMemo(
    () => designEntities.find((entity) => designEntityKey(entity) === selectedDesignKey) ?? null,
    [designEntities, selectedDesignKey],
  );
  const compatibleInventoryEntities = useMemo(
    () => compatibleImplementationInventoryEntities(selectedDesignEntity?.kind ?? null, inventory?.inventory.entities ?? []),
    [inventory, selectedDesignEntity?.kind],
  );
  const selectedInventoryEntity = compatibleInventoryEntities.find((entity) => entity.id === selectedInventoryEntityId) ?? null;
  const inventoryHasOnePlatform = inventory?.inventory.platforms.length === 1;
  const designEntityLabels = useMemo(
    () => new Map(designEntities.map((entity) => [designEntityKey(entity), entity.label])),
    [designEntities],
  );
  const selectedInventoryMappings = useMemo(
    () => pinnedRevision && selectedInventoryId
      ? mappings.filter((mapping) => (
        mapping.revisionId === pinnedRevision.id
        && mapping.designVersion === baseVersion
        && mapping.inventoryId === selectedInventoryId
      ))
      : [],
    [baseVersion, mappings, pinnedRevision, selectedInventoryId],
  );
  const handoffReady = Boolean(
    pinnedRevision
    && inventory
    && inventory.status === "active"
    && inventory.id === selectedInventoryId
    && selectedInventoryMappings.length > 0
    && selectedInventoryMappings.every((mapping) => mapping.inventoryHash === inventory.inventoryHash),
  );

  const createMapping = async () => {
    if (!pinnedRevision || !inspect || inspect.document.schema_version !== 2) {
      setError("Implementation mappings require an exact immutable V2 revision.");
      return;
    }
    if (!inventory || inventory.status !== "active") {
      setInventoryError("Select and load one active repository inventory.");
      return;
    }
    if (!inventoryHasOnePlatform) {
      setInventoryError("Implementation mappings require a per-platform inventory. Rescan this repository for one platform.");
      return;
    }
    if (!selectedDesignEntity || !selectedInventoryEntity) {
      setError("Explicitly select one design entity and one compatible opaque inventory entity.");
      return;
    }
    setBusy("create-mapping");
    setError(null);
    setInventoryError(null);
    setMappingSuccess(null);
    try {
      mappingIdempotencyKey.current ??= newMappingIdempotencyKey();
      const result = await createImplementationMappings(implementationMappingBatchInput({
        designId,
        revisionId: pinnedRevision.id,
        expectedDesignVersion: baseVersion,
        inventoryId: inventory.id,
        idempotencyKey: mappingIdempotencyKey.current,
        designEntity: selectedDesignEntity,
        inventoryEntityId: selectedInventoryEntity.id,
      }));
      if (result.mappings.length !== 1 || result.mappings.some((mapping) => (
        mapping.designId !== designId
        || mapping.revisionId !== pinnedRevision.id
        || mapping.designVersion !== baseVersion
        || mapping.inventoryId !== inventory.id
        || mapping.inventoryHash !== inventory.inventoryHash
      ))) {
        throw new Error("Created implementation mapping did not preserve the exact revision and inventory pins.");
      }
      setMappings((current) => [
        ...result.mappings,
        ...current.filter((item) => !result.mappings.some((created) => created.id === item.id)),
      ]);
      setMappingSuccess(`Pinned ${selectedDesignEntity.label} to ${selectedInventoryEntity.symbol ?? selectedInventoryEntity.id}.`);
      setSelectedInventoryEntityId("");
      mappingIdempotencyKey.current = null;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The reviewed implementation mapping could not be created.");
    } finally {
      setBusy(null);
    }
  };

  const createDraft = async () => {
    if (!pinnedRevision) {
      setError(`Design version ${baseVersion} is not available in immutable history.`);
      return;
    }
    if (!selectedInventoryId || !inventory || inventory.id !== selectedInventoryId || inventory.status !== "active") {
      setError("Explicitly select and load the active repository inventory for this handoff.");
      return;
    }
    if (selectedInventoryMappings.length === 0) {
      setError("Create at least one reviewed implementation mapping for the selected inventory and exact revision before creating a handoff.");
      return;
    }
    if (selectedInventoryMappings.some((mapping) => mapping.inventoryHash !== inventory.inventoryHash)) {
      setError("Reviewed mapping inventory metadata no longer matches the selected immutable inventory. Refresh before creating a handoff.");
      return;
    }
    setBusy("create-handoff");
    setError(null);
    try {
      const created = await createEngineeringHandoff({
        designId,
        revisionId: pinnedRevision.id,
        expectedDesignVersion: baseVersion,
        inventoryId: inventory.id,
        specification: engineeringHandoffSpecificationFromMappings(brief, selectedInventoryMappings),
      });
      setHandoffs((current) => [created, ...current]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The handoff draft could not be created.");
    } finally {
      setBusy(null);
    }
  };

  const submit = async (handoff: EngineeringHandoffRecord) => {
    setBusy(handoff.id);
    setError(null);
    try {
      const next = await submitEngineeringHandoff(handoff.id, handoff.currentVersion);
      setHandoffs((current) => current.map((item) => item.id === next.id ? next : item));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The handoff could not be submitted.");
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <div className="product-panel-placeholder"><LoaderCircle className="spin" size={18} /><strong>Loading engineering handoffs</strong><span>Resolving the exact design revision and bounded repository inventory.</span></div>;

  return (
    <div className="engineering-handoff-panel">
      <header>
        <div><ClipboardCheck size={17} /><span><strong>Engineering handoff</strong><small>Review exact design-to-source mappings before creating a revision-pinned implementation plan.</small></span></div>
        <div><button className="icon-button" onClick={() => void refresh()} aria-label="Refresh handoffs"><RefreshCcw size={13} /></button><button className="button button-primary" disabled={busy !== null || !handoffReady} title={handoffReady ? "Create a handoff from the reviewed mapping set" : "Select an inventory and create at least one reviewed mapping first"} onClick={() => void createDraft()}>{busy === "create-handoff" ? <LoaderCircle size={13} className="spin" /> : <Code2 size={13} />} Create draft</button></div>
      </header>
      {error && <div className="product-panel-error" role="alert">{error}</div>}
      <div className="handoff-context-strip"><ShieldCheck size={13} /><span>Design v{baseVersion}</span><span>{activeInventories.length} active repository {activeInventories.length === 1 ? "inventory" : "inventories"}</span><span>No repository path or credential is stored centrally</span></div>

      <div className="handoff-workspace">
        <section className="implementation-mapping-review" data-testid="implementation-mapping-review">
          <header>
            <div><Link2 size={14} /><span><strong>Reviewed implementation mapping</strong><small>Nothing is saved until you explicitly select both entities and create the mapping.</small></span></div>
            <span>{mappings.length} pinned</span>
          </header>

          {pinnedRevision && inspect ? <div className="mapping-pin-grid">
            <div><span>Exact revision</span><strong>Design v{pinnedRevision.version}</strong><code title={pinnedRevision.id}>{pinnedRevision.id}</code></div>
            <div><span>Revision integrity</span><strong title={inspect.integrity.revisionHash}>{shortHash(inspect.integrity.revisionHash)}</strong><code title={inspect.integrity.snapshotHash}>{inspect.integrity.snapshotHash}</code></div>
            <div><span>Repository inventory</span><strong>{inventory ? `${inventory.inventory.platforms.join(", ")} · ${new Date(inventory.createdAt).toLocaleDateString()}` : "Select one active inventory"}</strong><code title={inventory?.inventoryHash}>{inventory?.inventoryHash ?? "No inventory selected"}</code></div>
          </div> : <div className="mapping-inline-state is-error">The exact immutable revision is unavailable, so mapping is disabled.</div>}

          {inspect?.document.schema_version === 1 && <div className="mapping-inline-state is-error">Implementation mappings require a verified V2 revision. This V1 revision remains readable and exportable.</div>}
          {inspect?.document.schema_version === 2 && designEntities.length === 0 && <div className="mapping-inline-state">This exact revision has no components, tokens, screens, assets, flows, or business rules available to map.</div>}
          {activeInventories.length === 0 && <div className="mapping-inline-state"><Database size={12} /> Connect the Workspace Bridge and upload a bounded per-platform inventory before mapping.</div>}

          <div className="mapping-selector-grid">
            <label>
              <span>1. Active inventory</span>
              <select aria-label="Active repository inventory" value={selectedInventoryId} onChange={(event) => {
                setSelectedInventoryId(event.target.value);
                setError(null);
                setMappingSuccess(null);
              }} disabled={busy !== null || activeInventories.length === 0}>
                <option value="">Select an active inventory…</option>
                {activeInventories.map((item) => <option key={item.id} value={item.id}>{item.platforms.join(", ")} · {item.entityCount} entities · {item.id}</option>)}
              </select>
            </label>
            <label>
              <span>2. Exact design entity</span>
              <select aria-label="Exact revision design entity" value={selectedDesignKey} onChange={(event) => {
                setSelectedDesignKey(event.target.value);
                setSelectedInventoryEntityId("");
                setError(null);
                setMappingSuccess(null);
                mappingIdempotencyKey.current = null;
              }} disabled={busy !== null || !pinnedRevision || inspect?.document.schema_version !== 2 || designEntities.length === 0}>
                <option value="">Select one design entity…</option>
                {MAPPING_KIND_ORDER.map((kind) => {
                  const options = designEntities.filter((entity) => entity.kind === kind);
                  return options.length > 0 ? <optgroup key={kind} label={MAPPING_KIND_LABELS[kind]}>{options.map((entity) => <option key={designEntityKey(entity)} value={designEntityKey(entity)}>{entity.label} · {entity.detail} · {entity.id}</option>)}</optgroup> : null;
                })}
              </select>
            </label>
            <label>
              <span>3. Compatible opaque source entity</span>
              <select aria-label="Compatible opaque inventory entity" value={selectedInventoryEntityId} onChange={(event) => {
                setSelectedInventoryEntityId(event.target.value);
                setError(null);
                setMappingSuccess(null);
                mappingIdempotencyKey.current = null;
              }} disabled={busy !== null || inventoryLoading || !inventory || !inventoryHasOnePlatform || !selectedDesignEntity || compatibleInventoryEntities.length === 0}>
                <option value="">Select one compatible entity…</option>
                {compatibleInventoryEntities.map((entity) => <option key={entity.id} value={entity.id}>{implementationInventoryEntityLabel(entity)}</option>)}
              </select>
            </label>
            <button className="button button-secondary" disabled={busy !== null || !pinnedRevision || inspect?.document.schema_version !== 2 || !inventory || !inventoryHasOnePlatform || !selectedDesignEntity || !selectedInventoryEntity} onClick={() => void createMapping()}>{busy === "create-mapping" ? <LoaderCircle size={12} className="spin" /> : <Link2 size={12} />} Create reviewed mapping</button>
          </div>

          {inventoryLoading && <div className="mapping-inline-state"><LoaderCircle size={12} className="spin" /> Loading immutable inventory metadata…</div>}
          {inventoryError && <div className="mapping-inline-state is-error" role="alert">{inventoryError}</div>}
          {inventory && !inventoryHasOnePlatform && <div className="mapping-inline-state is-error">This inventory contains {inventory.inventory.platforms.length} platforms. Create a per-platform inventory so the derived implementation platform is unambiguous.</div>}
          {inventory && selectedDesignEntity && inventoryHasOnePlatform && compatibleInventoryEntities.length === 0 && <div className="mapping-inline-state">No compatible {selectedDesignEntity.kind.replaceAll("_", " ")} source entity exists in this inventory.</div>}
          {mappingSuccess && <div className="mapping-inline-state is-success" role="status">{mappingSuccess}</div>}

          <div className="implementation-mapping-list">
            {mappings.length === 0 ? <div className="mapping-empty"><Link2 size={18} /><strong>No reviewed mapping pinned to design v{baseVersion}</strong><span>Select both sides explicitly. FormaSpec derives the symbol, platform, and opaque location metadata from the immutable inventory.</span></div> : mappings.map((mapping) => (
              <article key={mapping.id}>
                <span className="mapping-kind">{mapping.entityKind.replaceAll("_", " ")}</span>
                <div><strong>{designEntityLabels.get(`${mapping.entityKind}:${mapping.entityId}`) ?? mapping.entityId}<span>→ {mapping.symbol}</span></strong><small>{mapping.inventoryEntityKind} · {mapping.platform} · design v{mapping.designVersion}</small><code>{mapping.entityId} → {mapping.inventoryEntityId}</code></div>
                <div><small>{new Date(mapping.createdAt).toLocaleString()}</small><code title={mapping.inventoryHash}>{shortHash(mapping.inventoryHash)}</code></div>
              </article>
            ))}
          </div>
        </section>

        <section className="engineering-handoff-list-section">
          <header><div><ClipboardCheck size={13} /><span><strong>Handoff plans</strong><small>Human-reviewed plans stay separate from source execution.</small></span></div><span>{handoffs.length}</span></header>
          <div className={`handoff-mapping-gate${handoffReady ? " is-ready" : ""}`}>
            <ShieldCheck size={13} />
            <div><strong>{handoffReady ? `${selectedInventoryMappings.length} reviewed ${selectedInventoryMappings.length === 1 ? "mapping" : "mappings"} ready` : "Reviewed mapping required"}</strong><span>{handoffReady ? `The draft will reference only the selected inventory and exact design v${baseVersion} mapping set.` : !selectedInventoryId ? "Select one active inventory, then explicitly map at least one exact design entity." : inventoryLoading ? "Loading the selected inventory before the handoff gate can be evaluated." : "Create at least one reviewed mapping for this selected inventory and exact revision."}</span></div>
          </div>
          <div className="handoff-list">
            {handoffs.length === 0 ? <div className="handoff-empty"><ClipboardCheck size={21} /><strong>No handoff for this project</strong><span>Create a draft only after the Workspace Bridge inventory is available. Source changes remain disabled.</span></div> : handoffs.map((handoff) => {
              const reviewing = reviewingHandoffId === handoff.id;
              return <Fragment key={handoff.id}>
                <article>
                  <span className={`handoff-status is-${handoff.status}`}>{handoff.status.replaceAll("_", " ")}</span>
                  <div><strong>{String(handoff.specification.title ?? "Engineering handoff")}</strong><small>Design v{handoff.designVersion} · Handoff v{handoff.currentVersion} · {handoff.executionDecisions?.length ?? 0} execution decisions</small><code>{handoff.id}</code></div>
                  <div className="handoff-card-actions">
                    {handoff.status === "draft" && <button className="button button-secondary" disabled={busy !== null} onClick={() => void submit(handoff)}>{busy === handoff.id ? <LoaderCircle size={12} className="spin" /> : <Send size={12} />} Submit review</button>}
                    {handoff.status !== "draft" && <button className="button button-secondary" type="button" onClick={() => setReviewingHandoffId(reviewing ? null : handoff.id)}>{reviewing ? <ChevronUp size={12} /> : <ChevronDown size={12} />} {reviewing ? "Close controls" : handoff.status === "completed" || handoff.status === "cancelled" ? "View decisions" : "Review gates"}</button>}
                  </div>
                </article>
                {reviewing && <HandoffExecutionReview handoff={handoff} onHandoffChanged={(next) => setHandoffs((current) => current.map((item) => item.id === next.id ? next : item))} />}
              </Fragment>;
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
