import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  AgentTaskResolvedContextSchema,
  AnyDesignDocumentSchema,
  FORMASPEC_FOUNDATION_SYSTEM,
  FORMASPEC_FOUNDATION_RELEASE_ID,
  FORMASPEC_FOUNDATION_SYSTEM_ID,
  FORMASPEC_FOUNDATION_VERSION,
  PLANNING_SECTIONS,
  PlanningSectionSchema,
  PlanningSessionSchema,
  ProductSpecificationSchema,
  ProductLocaleSchema,
  ProductPlatformSchema,
  toV1CompatibleDesignDocument,
  type PlanningSession,
  type AgentTaskResolvedContext,
  type ProductPlatform,
  type ProductSpecification,
} from "@designer/core";
import { z } from "zod";

import {
  AGENT_TASK_EXPECTED_OUTPUTS,
  AGENT_TASK_STATUSES,
  AgentTaskCompletionSchemas,
  AgentTaskExpectedOutputSchema,
  AgentTaskSelectionSchema,
  AgentTaskTransitionDataSchema,
  type AgentTaskExpectedOutput,
  type AgentTaskStatus,
} from "./agent-task-schema.js";
import {
  appendAuditEvent,
  assertScope,
  resolveAccess,
  type AccessContext,
  type OrganizationRole,
} from "./authorization.js";
import { activeDesignSqlPredicate, requireActiveDesign } from "./active-design.js";
import {
  clearAgentConnectionReplacement,
  consumeAgentConnectionReplacement,
  persistAgentConnectionReplacement,
  readAgentConnectionReplacement,
  type AgentConnectionReplacementIntent,
} from "./agent-connection-replacement.js";
import type { DesignerDatabase } from "./db/database.js";
import { DomainError } from "./errors.js";
import type { DesignerEventType, EventHub } from "./events.js";
import { canonicalJson, hashPayload } from "./ids.js";
import {
  loadOrganizationPolicy,
  ORGANIZATION_AGENT_SCOPES,
  type OrganizationPolicy,
} from "./organization-policy-model.js";
import { canonicalProductSpecification } from "./product-spec-persistence.js";
import { previewTaskId } from "./preview-task-binding.js";
import {
  DesignReadinessReportSchema,
  type DesignReadinessReport,
} from "./design-readiness.js";
import type { DesignerService, PreviewKind, RevisionResult } from "./service.js";

const MAX_TRANSITION_DATA_BYTES = 65_536;
const IDEMPOTENCY_TTL_MS = 86_400_000;

const persistedReleaseReadinessSchema = z.object({
  release: z.object({
    id: z.string().trim().min(1).max(240),
    design_system_id: z.string().trim().min(1).max(240),
    version: z.number().int().positive().max(1_000_000_000),
  }).passthrough(),
  component_versions: z.array(z.object({
    component_definition_id: z.string().trim().min(1).max(240),
    version: z.number().int().positive().max(1_000_000_000),
  }).strict()).max(5_000),
}).passthrough();

export { AGENT_TASK_EXPECTED_OUTPUTS, AGENT_TASK_STATUSES };
export type { AgentTaskExpectedOutput, AgentTaskStatus };

export type PlanningSection = (typeof PLANNING_SECTIONS)[number];
export type PlanningStatus = "draft" | "in_progress" | "ready_for_review" | "completed" | "cancelled";
export type AgentConnectionStatus = "pending" | "active" | "expired" | "revoked" | "error";

export const AGENT_CONNECTION_SCOPES = ORGANIZATION_AGENT_SCOPES;
const FORMASPEC_INSTALLER_MANAGED_CODEX_CONNECTION_NAME = "Codex — FormaSpec" as const;
// Upgrade-only reconciliation marker for installer-owned 0.2.x connection rows.
// It is never returned as a current identity or offered for new connections.
const LEGACY_INSTALLER_MANAGED_CODEX_CONNECTION_NAME = "Codex — Minimal UI" as const;
const INSTALLER_MANAGED_CODEX_RECONCILIATION_NAMES = [
  FORMASPEC_INSTALLER_MANAGED_CODEX_CONNECTION_NAME,
  LEGACY_INSTALLER_MANAGED_CODEX_CONNECTION_NAME,
] as const;

const taskTransitionGraph: Record<AgentTaskStatus, readonly AgentTaskStatus[]> = {
  queued: ["claimed", "cancelled", "expired"],
  claimed: ["in_progress", "failed", "cancelled", "expired"],
  in_progress: ["awaiting_approval", "completed", "failed", "cancelled", "expired"],
  awaiting_approval: ["in_progress", "completed", "failed", "cancelled", "expired"],
  completed: [],
  failed: [],
  cancelled: [],
  expired: [],
};

const planningTransitionGraph: Record<PlanningStatus, readonly PlanningStatus[]> = {
  draft: ["draft", "in_progress", "cancelled"],
  in_progress: ["in_progress", "ready_for_review", "cancelled"],
  ready_for_review: ["in_progress", "ready_for_review", "completed", "cancelled"],
  completed: [],
  cancelled: [],
};

interface DesignAccessRow {
  id: string;
  product_id: string;
  organization_id: string;
  current_version: number;
  current_revision_id: string;
}

interface ProductSpecificationRow {
  design_id: string;
  version: number;
  specification_json: string;
  organization_id: string;
  specification_hash: string;
  message: string | null;
  revision_id: string | null;
  actor_id: string;
  created_at: string;
}

interface ProductSpecificationPreviewRow {
  id: string;
  organization_id: string;
  design_id: string;
  actor_id: string;
  base_version: number;
  specification_json: string;
  specification_hash: string;
  diagnostics_json: string;
  status: "ready" | "blocked" | "expired" | "committed";
  created_at: string;
  expires_at: string;
  committed_version: number | null;
  committed_at: string | null;
  commit_actor_id: string | null;
}

interface PlanningSessionRow {
  id: string;
  organization_id: string;
  design_id: string;
  version: number;
  status: PlanningStatus;
  current_section: PlanningSection;
  created_at: string;
  updated_at: string;
}

interface PlanningAnswerRow {
  id: string;
  session_id: string;
  section: PlanningSection;
  version: number;
  answer: string;
  actor_id: string;
  created_at: string;
}

interface PlanningVersionRow {
  session_id: string;
  version: number;
  status: PlanningStatus;
  current_section: PlanningSection;
  actor_id: string;
  created_at: string;
}

interface AgentTaskRow {
  id: string;
  organization_id: string;
  product_id: string | null;
  design_id: string;
  actor_id: string;
  brief: string;
  selection_json: string;
  base_version: number;
  expected_output: AgentTaskExpectedOutput;
  created_at: string;
  expires_at: string;
  resolved_context_json: string | null;
}

interface AgentTaskTransitionRow {
  id: string;
  task_id: string;
  from_status: AgentTaskStatus | null;
  to_status: AgentTaskStatus;
  actor_id: string;
  message: string | null;
  data_json: string;
  created_at: string;
}

interface ActiveAgentTaskRow extends AgentTaskRow {
  current_status: AgentTaskStatus;
}

interface AgentConnectionRow {
  id: string;
  organization_id: string;
  principal_id: string | null;
  adapter: "codex" | "generic_mcp";
  display_name: string;
  status: AgentConnectionStatus;
  scopes_json: string;
  project_ids_json: string;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

interface IdempotencyRow {
  request_hash: string;
  response_json: string;
}

export interface EnterpriseDiagnostic {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  path?: string;
}

export interface ProductSpecificationResult {
  designId: string;
  version: number;
  specification: ProductSpecification;
  specificationHash: string;
  message: string | null;
  revisionId: string | null;
  actorId: string;
  createdAt: string;
}

export interface ProductSpecificationHistoryItem {
  version: number;
  specificationHash: string;
  message: string;
  actorId: string;
  createdAt: string;
  naturalLanguageBrief: string;
  summary: string;
  counts: Record<string, number>;
}

export interface ProductSpecificationHistoryPage {
  versions: ProductSpecificationHistoryItem[];
  nextBeforeVersion: number | null;
}

export interface ProductSpecificationPreviewResult {
  id: string;
  designId: string;
  baseVersion: number;
  resultVersion: number;
  specification: ProductSpecification;
  specificationHash: string;
  diagnostics: EnterpriseDiagnostic[];
  status: ProductSpecificationPreviewRow["status"];
  canCommit: boolean;
  expiresAt: string;
  committedVersion: number | null;
  committedAt: string | null;
}

export interface PlanningSessionVersion {
  version: number;
  status: PlanningStatus;
  currentSection: PlanningSection;
  actorId: string;
  createdAt: string;
}

export interface PlanningSessionResult {
  session: PlanningSession;
  versions: PlanningSessionVersion[];
  answeredSections: PlanningSection[];
  sectionCount: 22;
}

export interface AgentTaskTransition {
  id: string;
  fromStatus: AgentTaskStatus | null;
  toStatus: AgentTaskStatus;
  actorId: string;
  message: string | null;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface AgentTaskResult {
  id: string;
  product: {
    id: string;
    name: string;
    status: "active" | "archived";
  };
  designId: string;
  brief: string;
  selection: string[];
  baseVersion: number;
  expectedOutput: AgentTaskExpectedOutput;
  status: AgentTaskStatus;
  claimedBy: string | null;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  resolvedContext: AgentTaskResolvedContext | null;
  readiness: DesignReadinessReport | null;
  transitions: AgentTaskTransition[];
}

export interface AgentTaskPreviewApprovalResult {
  revision: RevisionResult;
  task: AgentTaskResult;
}

export interface AgentConnectionResult {
  id: string;
  adapter: "codex" | "generic_mcp";
  displayName: string;
  status: AgentConnectionStatus;
  scopes: string[];
  projectIds: string[];
  principalId: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OwnAuthorizationContextResult {
  role: OrganizationRole;
  scopes: string[];
  projectIds: string[];
}

export interface PairingChallenge {
  connection: AgentConnectionResult;
  nonce: string;
  expiresAt: string;
}

export interface PairedAgentConnection {
  connection: AgentConnectionResult;
  grant: {
    id: string;
    actorId: string;
    token: string;
    expiresAt: string;
    scopes: string[];
    projectIds: string[];
  };
}

export interface EnterpriseServiceOptions {
  productSpecPreviewTtlSeconds?: number;
  pairingTtlSeconds?: number;
  now?: () => Date;
  designerService?: DesignerService;
}

function workflowId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function jsonObject(value: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new DomainError("INTERNAL_ERROR", `Persisted ${label} data is invalid.`, 500, { cause: error });
  }
}

function jsonStringArray(value: string, label: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) throw new Error("not a string array");
    return parsed;
  } catch (error) {
    throw new DomainError("INTERNAL_ERROR", `Persisted ${label} data is invalid.`, 500, { cause: error });
  }
}

function boundedText(value: string, label: string, maximum: number, allowEmpty = false): string {
  const normalized = value.trim();
  if ((!allowEmpty && normalized.length === 0) || normalized.length > maximum) {
    throw new DomainError("VALIDATION_FAILED", `${label} must be ${allowEmpty ? `at most ${maximum}` : `between 1 and ${maximum}`} characters.`, 422);
  }
  return normalized;
}

function assertSeconds(value: number, label: string, minimum: number, maximum: number): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new DomainError("VALIDATION_FAILED", `${label} must be an integer from ${minimum} to ${maximum}.`, 422);
  }
}

function parseInput<Schema extends z.ZodTypeAny>(
  schema: Schema,
  value: unknown,
  label: string,
): z.output<Schema> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new DomainError("VALIDATION_FAILED", `${label} is invalid.`, 422, {
      details: {
        issues: parsed.error.issues.slice(0, 100).map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
          code: issue.code,
        })),
      },
    });
  }
  return parsed.data;
}

export class EnterpriseService {
  readonly productSpecPreviewTtlSeconds: number;
  readonly pairingTtlSeconds: number;
  readonly #now: () => Date;
  readonly #designerService: DesignerService | undefined;

  constructor(
    readonly database: DesignerDatabase,
    readonly events?: EventHub,
    options: EnterpriseServiceOptions = {},
  ) {
    this.productSpecPreviewTtlSeconds = options.productSpecPreviewTtlSeconds ?? 900;
    this.pairingTtlSeconds = options.pairingTtlSeconds ?? 300;
    assertSeconds(this.productSpecPreviewTtlSeconds, "Product specification preview TTL", 60, 3_600);
    assertSeconds(this.pairingTtlSeconds, "Pairing TTL", 60, 900);
    this.#now = options.now ?? (() => new Date());
    this.#designerService = options.designerService;
    this.flushPendingEventsSafely();
  }

  previewProductSpecification(actorId: string, input: {
    designId: string;
    baseVersion: number;
    specification?: unknown;
    naturalLanguageBrief?: string;
  }): ProductSpecificationPreviewResult {
    const { access, design } = this.requireDesign(actorId, input.designId, "product_spec:preview");
    this.assertProductSpecificationWrite(access, "product_spec:preview");
    if ((input.specification === undefined) === (input.naturalLanguageBrief === undefined)) {
      throw new DomainError("VALIDATION_FAILED", "Provide exactly one of specification or naturalLanguageBrief.", 422);
    }
    const specificationInput = input.specification === undefined
      ? this.specificationWithNaturalLanguageBrief(design.id, input.baseVersion, input.naturalLanguageBrief as string)
      : input.specification;
    const canonical = canonicalProductSpecification(specificationInput);
    if (canonical.specification.version !== input.baseVersion + 1) {
      throw new DomainError("VALIDATION_FAILED", "The specification version must equal baseVersion + 1.", 422);
    }
    const diagnostics = this.productSpecificationDiagnostics(canonical.specification);
    const transaction = this.database.sqlite.transaction(() => {
      this.expireProductSpecificationPreviews(access, design.id, this.nowIso());
      const currentVersion = this.currentProductSpecificationVersion(design.id);
      if (currentVersion !== input.baseVersion) throw this.versionConflict(input.baseVersion, currentVersion, "product specification");
      const now = this.nowIso();
      const previewId = workflowId("specpreview");
      const expiresAt = new Date(this.#now().getTime() + this.productSpecPreviewTtlSeconds * 1_000).toISOString();
      this.database.sqlite.prepare(
        `INSERT INTO product_spec_previews
         (id, organization_id, design_id, actor_id, base_version, specification_json, specification_hash,
          diagnostics_json, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)`,
      ).run(
        previewId,
        access.organizationId,
        design.id,
        access.principalId,
        input.baseVersion,
        canonical.json,
        canonical.hash,
        JSON.stringify(diagnostics),
        now,
        expiresAt,
      );
      appendAuditEvent(this.database.sqlite, access, "product_spec.preview.create", "product_spec_preview", previewId, {
        designId: design.id,
        baseVersion: input.baseVersion,
        specificationHash: canonical.hash,
      });
      this.enqueueEvent(access, "product_spec.preview.updated", {
        previewId,
        designId: design.id,
        baseVersion: input.baseVersion,
        resultVersion: canonical.specification.version,
        status: "ready",
      }, now);
      return this.productSpecificationPreviewResult(this.requireProductSpecificationPreviewRow(access, design.id, previewId));
    });
    const result = transaction.immediate();
    this.flushPendingEventsSafely();
    return result;
  }

  readProductSpecificationPreview(actorId: string, designId: string, previewId: string): ProductSpecificationPreviewResult {
    const { access, design } = this.requireDesign(actorId, designId, "product_spec:read");
    this.requireProductSpecificationPreviewRow(access, design.id, previewId);
    this.expireProductSpecificationPreviews(access, design.id, this.nowIso(), previewId);
    const row = this.requireProductSpecificationPreviewRow(access, design.id, previewId);
    if (row.status === "expired") throw new DomainError("PREVIEW_EXPIRED", "The product specification preview expired.", 410, { retryable: true });
    return this.productSpecificationPreviewResult(row);
  }

  commitProductSpecificationPreview(actorId: string, input: {
    designId: string;
    previewId: string;
    expectedBaseVersion: number;
    idempotencyKey: string;
    message?: string;
  }): ProductSpecificationResult {
    const { access, design } = this.requireDesign(actorId, input.designId, "product_spec:write");
    this.assertProductSpecificationWrite(access, "product_spec:write");
    const idempotencyKey = boundedText(input.idempotencyKey, "Idempotency key", 240);
    const message = input.message === undefined ? "Commit product specification" : boundedText(input.message, "Commit message", 4_000, true);
    this.requireProductSpecificationPreviewRow(access, design.id, input.previewId);
    this.expireProductSpecificationPreviews(access, design.id, this.nowIso(), input.previewId);
    return this.withIdempotency(access, `product_spec:${design.id}:commit`, idempotencyKey, {
      previewId: input.previewId,
      expectedBaseVersion: input.expectedBaseVersion,
      message,
    }, () => {
      const preview = this.requireProductSpecificationPreviewRow(access, design.id, input.previewId);
      if (preview.status === "committed") {
        throw new DomainError("PREVIEW_ALREADY_COMMITTED", "The product specification preview was already committed.", 409, {
          details: { committedVersion: preview.committed_version },
        });
      }
      if (preview.status === "expired" || preview.expires_at <= this.nowIso()) {
        throw new DomainError("PREVIEW_EXPIRED", "The product specification preview expired.", 410, { retryable: true });
      }
      if (preview.status !== "ready") {
        throw new DomainError("PREVIEW_NOT_COMMITTABLE", "The product specification preview cannot be committed.", 422, {
          details: { diagnostics: JSON.parse(preview.diagnostics_json) as unknown },
        });
      }
      if (preview.base_version !== input.expectedBaseVersion) {
        throw new DomainError("VALIDATION_FAILED", "expectedBaseVersion does not match the preview base.", 422);
      }
      const currentVersion = this.currentProductSpecificationVersion(design.id);
      if (currentVersion !== input.expectedBaseVersion) {
        throw this.versionConflict(input.expectedBaseVersion, currentVersion, "product specification");
      }
      if (sha256(preview.specification_json) !== preview.specification_hash) {
        throw new DomainError("VALIDATION_FAILED", "The persisted product specification preview hash is invalid.", 422);
      }
      const canonical = canonicalProductSpecification(JSON.parse(preview.specification_json) as unknown);
      if (canonical.json !== preview.specification_json || canonical.hash !== preview.specification_hash) {
        throw new DomainError("VALIDATION_FAILED", "The product specification preview is not canonical.", 422);
      }
      const now = this.nowIso();
      const nextVersion = input.expectedBaseVersion + 1;
      this.database.sqlite.prepare(
        `INSERT INTO product_specifications
         (design_id, version, specification_json, organization_id, specification_hash, message,
          revision_id, actor_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      ).run(
        design.id,
        nextVersion,
        preview.specification_json,
        access.organizationId,
        preview.specification_hash,
        message,
        access.principalId,
        now,
      );
      const committed = this.database.sqlite.prepare(
        `UPDATE product_spec_previews
         SET status = 'committed', committed_version = ?, committed_at = ?, commit_actor_id = ?
         WHERE id = ? AND status = 'ready'`,
      ).run(nextVersion, now, access.principalId, preview.id);
      if (committed.changes !== 1) throw new DomainError("PREVIEW_ALREADY_COMMITTED", "The preview was already committed.", 409);
      appendAuditEvent(this.database.sqlite, access, "product_spec.commit", "product_specification", design.id, {
        previewId: preview.id,
        version: nextVersion,
        specificationHash: preview.specification_hash,
      });
      this.enqueueEvent(access, "product_spec.committed", {
        designId: design.id,
        previewId: preview.id,
        version: nextVersion,
        specificationHash: preview.specification_hash,
      }, now);
      return this.productSpecificationResult(this.requireProductSpecificationRow(design.id, nextVersion));
    });
  }

  readProductSpecification(actorId: string, designId: string, version?: number): ProductSpecificationResult {
    const { design } = this.requireDesign(actorId, designId, "product_spec:read");
    const requestedVersion = version ?? this.currentProductSpecificationVersion(design.id);
    if (requestedVersion === 0) throw new DomainError("NOT_FOUND", "No product specification has been committed.", 404);
    return this.productSpecificationResult(this.requireProductSpecificationRow(design.id, requestedVersion));
  }

  listProductSpecificationHistory(
    actorId: string,
    designId: string,
    limit = 50,
    beforeVersion?: number,
  ): ProductSpecificationHistoryPage {
    const { design } = this.requireDesign(actorId, designId, "product_spec:read");
    const boundedLimit = Math.max(1, Math.min(limit, 100));
    const rows = this.database.sqlite.prepare(
      `SELECT * FROM product_specifications
       WHERE design_id = ? AND (? IS NULL OR version < ?)
       ORDER BY version DESC LIMIT ?`,
    ).all(design.id, beforeVersion ?? null, beforeVersion ?? null, boundedLimit + 1) as ProductSpecificationRow[];
    const hasMore = rows.length > boundedLimit;
    const visibleRows = rows.slice(0, boundedLimit);
    const collectionKeys = [
      "goals",
      "non_goals",
      "audiences",
      "roles",
      "entities",
      "flows",
      "business_rules",
      "permissions",
      "validations",
      "screen_states",
      "integrations",
      "analytics_events",
      "accessibility_requirements",
      "non_functional_requirements",
      "acceptance_criteria",
      "assumptions",
      "open_questions",
    ] as const;
    const versions = visibleRows.map((row): ProductSpecificationHistoryItem => {
      const persisted = this.productSpecificationResult(row);
      return {
        version: persisted.version,
        specificationHash: persisted.specificationHash,
        message: persisted.message ?? "Update product specification",
        actorId: persisted.actorId,
        createdAt: persisted.createdAt,
        naturalLanguageBrief: persisted.specification.natural_language_brief,
        summary: persisted.specification.summary,
        counts: Object.fromEntries(collectionKeys.map((key) => [key, persisted.specification[key].length])),
      };
    });
    return {
      versions,
      nextBeforeVersion: hasMore ? versions.at(-1)?.version ?? null : null,
    };
  }

  authorizePlanningSessionList(actorId: string, designId: string): void {
    this.requireDesign(actorId, designId, "planning:read");
  }

  authorizePlanningSessionCreate(actorId: string, designId: string): void {
    this.requirePlanningWriteDesign(actorId, designId);
  }

  createPlanningSession(actorId: string, input: {
    designId: string;
    idempotencyKey: string;
  }): PlanningSessionResult {
    const { access, design } = this.requirePlanningWriteDesign(actorId, input.designId);
    const key = boundedText(input.idempotencyKey, "Idempotency key", 240);
    return this.withIdempotency(access, `planning:${design.id}:create`, key, input, () => {
      const now = this.nowIso();
      const sessionId = workflowId("planning");
      const firstSection = PLANNING_SECTIONS[0];
      this.database.sqlite.prepare(
        `INSERT INTO planning_sessions
         (id, organization_id, design_id, version, status, current_section, created_at, updated_at)
         VALUES (?, ?, ?, 1, 'draft', ?, ?, ?)`,
      ).run(sessionId, access.organizationId, design.id, firstSection, now, now);
      this.database.sqlite.prepare(
        `INSERT INTO planning_session_versions
         (session_id, version, status, current_section, actor_id, created_at)
         VALUES (?, 1, 'draft', ?, ?, ?)`,
      ).run(sessionId, firstSection, access.principalId, now);
      appendAuditEvent(this.database.sqlite, access, "planning_session.create", "planning_session", sessionId, { designId: design.id });
      this.enqueueEvent(access, "planning_session.updated", {
        sessionId,
        designId: design.id,
        version: 1,
        status: "draft",
        currentSection: firstSection,
      }, now);
      return this.planningSessionResult(this.requirePlanningSessionRow(access, sessionId));
    });
  }

  readPlanningSession(actorId: string, sessionId: string): PlanningSessionResult {
    const access = resolveAccess(this.database.sqlite, actorId);
    if (access.role === "agent") assertScope(access, "planning:read");
    return this.planningSessionResult(this.requirePlanningSessionRow(access, sessionId));
  }

  listPlanningSessions(actorId: string, designId: string, limit = 50): PlanningSessionResult[] {
    const { access, design } = this.requireDesign(actorId, designId, "planning:read");
    const boundedLimit = Math.max(1, Math.min(limit, 100));
    const rows = this.database.sqlite.prepare(
      `SELECT * FROM planning_sessions
       WHERE organization_id = ? AND design_id = ? ORDER BY updated_at DESC LIMIT ?`,
    ).all(access.organizationId, design.id, boundedLimit) as PlanningSessionRow[];
    return rows.map((row) => this.planningSessionResult(row));
  }

  savePlanningAnswer(actorId: string, sessionId: string, input: {
    expectedVersion: number;
    section: PlanningSection;
    answer: string;
    nextSection?: PlanningSection;
    status?: "in_progress" | "ready_for_review";
  }): PlanningSessionResult {
    const section = parseInput(PlanningSectionSchema, input.section, "Planning section");
    const answer = boundedText(input.answer, "Planning answer", 100_000, true);
    const nextSection = input.nextSection === undefined
      ? this.nextPlanningSection(section)
      : parseInput(PlanningSectionSchema, input.nextSection, "Next planning section");
    const access = resolveAccess(this.database.sqlite, actorId);
    this.assertPlanningWrite(access);
    const transaction = this.database.sqlite.transaction(() => {
      const row = this.requirePlanningSessionRow(access, sessionId);
      if (row.version !== input.expectedVersion) throw this.versionConflict(input.expectedVersion, row.version, "planning session");
      if (row.status === "completed" || row.status === "cancelled") {
        throw new DomainError("VERSION_CONFLICT", `A ${row.status} planning session cannot be edited.`, 409);
      }
      const status = input.status ?? "in_progress";
      if (!planningTransitionGraph[row.status].includes(status)) {
        throw new DomainError("VALIDATION_FAILED", `Cannot move a planning session from ${row.status} to ${status}.`, 422);
      }
      if (status === "ready_for_review") this.assertPlanningComplete(row.id, section);
      const answerVersionRow = this.database.sqlite.prepare(
        "SELECT COALESCE(MAX(version), 0) AS version FROM planning_answers WHERE session_id = ? AND section = ?",
      ).get(row.id, section) as { version: number };
      const now = this.nowIso();
      const nextVersion = row.version + 1;
      this.database.sqlite.prepare(
        `INSERT INTO planning_answers (id, session_id, section, version, answer, actor_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(workflowId("answer"), row.id, section, answerVersionRow.version + 1, answer, access.principalId, now);
      this.database.sqlite.prepare(
        `INSERT INTO planning_session_versions
         (session_id, version, status, current_section, actor_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(row.id, nextVersion, status, nextSection, access.principalId, now);
      const updated = this.database.sqlite.prepare(
        `UPDATE planning_sessions SET version = ?, status = ?, current_section = ?, updated_at = ?
         WHERE id = ? AND version = ?`,
      ).run(nextVersion, status, nextSection, now, row.id, row.version);
      if (updated.changes !== 1) throw this.versionConflict(input.expectedVersion, this.requirePlanningSessionRow(access, row.id).version, "planning session");
      appendAuditEvent(this.database.sqlite, access, "planning_session.answer", "planning_session", row.id, {
        section,
        answerVersion: answerVersionRow.version + 1,
        sessionVersion: nextVersion,
      });
      this.enqueueEvent(access, "planning_session.updated", {
        sessionId: row.id,
        designId: row.design_id,
        version: nextVersion,
        status,
        currentSection: nextSection,
        answeredSection: section,
      }, now);
      return this.planningSessionResult(this.requirePlanningSessionRow(access, row.id));
    });
    const result = transaction.immediate();
    this.flushPendingEventsSafely();
    return result;
  }

  transitionPlanningSession(actorId: string, sessionId: string, input: {
    expectedVersion: number;
    status: PlanningStatus;
    currentSection?: PlanningSection;
  }): PlanningSessionResult {
    const access = resolveAccess(this.database.sqlite, actorId);
    this.assertPlanningWrite(access);
    const status = input.status;
    const transaction = this.database.sqlite.transaction(() => {
      const row = this.requirePlanningSessionRow(access, sessionId);
      if (row.version !== input.expectedVersion) throw this.versionConflict(input.expectedVersion, row.version, "planning session");
      if (!planningTransitionGraph[row.status].includes(status)) {
        throw new DomainError("VALIDATION_FAILED", `Cannot move a planning session from ${row.status} to ${status}.`, 422);
      }
      if (status === "ready_for_review" || status === "completed") this.assertPlanningComplete(row.id);
      const currentSection = input.currentSection === undefined
        ? row.current_section
        : parseInput(PlanningSectionSchema, input.currentSection, "Planning section");
      const now = this.nowIso();
      const nextVersion = row.version + 1;
      this.database.sqlite.prepare(
        `INSERT INTO planning_session_versions
         (session_id, version, status, current_section, actor_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(row.id, nextVersion, status, currentSection, access.principalId, now);
      const updated = this.database.sqlite.prepare(
        `UPDATE planning_sessions SET version = ?, status = ?, current_section = ?, updated_at = ?
         WHERE id = ? AND version = ?`,
      ).run(nextVersion, status, currentSection, now, row.id, row.version);
      if (updated.changes !== 1) throw this.versionConflict(input.expectedVersion, this.requirePlanningSessionRow(access, row.id).version, "planning session");
      appendAuditEvent(this.database.sqlite, access, "planning_session.transition", "planning_session", row.id, {
        fromStatus: row.status,
        toStatus: status,
        version: nextVersion,
      });
      this.enqueueEvent(access, "planning_session.updated", {
        sessionId: row.id,
        designId: row.design_id,
        version: nextVersion,
        status,
        currentSection,
      }, now);
      return this.planningSessionResult(this.requirePlanningSessionRow(access, row.id));
    });
    const result = transaction.immediate();
    this.flushPendingEventsSafely();
    return result;
  }

  authorizeAgentTaskList(actorId: string, designId: string): void {
    this.requireDesign(actorId, designId, "task:read");
  }

  authorizeAgentTaskCreate(actorId: string, designId: string): void {
    this.requireTaskCreateDesign(actorId, designId);
  }

  authorizeAgentTaskPreviewApproval(
    actorId: string,
    taskId?: string,
    designId?: string,
    previewId?: string,
  ): void {
    const access = resolveAccess(this.database.sqlite, actorId);
    this.assertTaskApproval(access);
    if (taskId === undefined || designId === undefined || previewId === undefined) return;
    const task = this.requireAgentTaskRow(access, taskId);
    if (task.design_id !== designId || task.expected_output !== "design_preview") {
      throw new DomainError("NOT_FOUND", "Agent task not found.", 404);
    }
    const current = this.currentTaskTransition(task.id);
    const data = jsonObject(current.data_json, "task transition");
    if (!["awaiting_approval", "completed", "expired"].includes(current.to_status) || data.previewId !== previewId) {
      throw new DomainError("NOT_FOUND", "Agent task not found.", 404);
    }
  }

  authorizeAgentTaskDesignPreviewWork(
    actorId: string,
    input: {
      taskId?: string;
      designId: string;
      baseVersion: number;
    },
  ): void {
    const access = resolveAccess(this.database.sqlite, actorId);
    if (access.role !== "agent") {
      throw new DomainError("FORBIDDEN", "MCP design preview work requires a scoped agent connection.", 403);
    }
    assertScope(access, "design:preview");
    assertScope(access, "design:read");
    if (input.taskId === undefined) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "Agent design previews must be attached to an immutable claimed task.",
        422,
        {
          details: {
            requiredField: "task_id",
            requiredSequence: ["task_create", "task_claim", "task_transition:in_progress", "design_preview_changes"],
          },
        },
      );
    }

    let expired = false;
    let staleCurrentVersion: number | null = null;
    const transaction = this.database.sqlite.transaction(() => {
      const task = this.requireAgentTaskRow(access, input.taskId as string);
      if (task.design_id !== input.designId
        || task.base_version !== input.baseVersion
        || task.expected_output !== "design_preview") {
        throw new DomainError("NOT_FOUND", "Agent task not found.", 404);
      }
      const current = this.currentTaskTransition(task.id);
      if (this.claimedBy(task.id) !== access.principalId) {
        throw new DomainError("FORBIDDEN", "Only the agent that claimed this task may create its design preview.", 403);
      }
      const now = this.nowIso();
      if (!AGENT_TASK_STATUSES.slice(4).includes(current.to_status) && task.expires_at <= now) {
        this.materializeTaskTerminalState(access, task, current, "expired", "Task expired before preview creation.", now, {
          reason: "expired_before_preview",
        });
        expired = true;
        return;
      }
      if (current.to_status !== "in_progress") {
        throw this.taskStateConflict("in_progress", current.to_status);
      }
      const design = this.requireDesignForAccess(access, task.design_id);
      if (design.current_version !== task.base_version) {
        this.materializeTaskTerminalState(
          access,
          task,
          current,
          "cancelled",
          "Task was cancelled because its pinned design version is stale.",
          now,
          { reason: "stale_base", expectedBaseVersion: task.base_version, currentVersion: design.current_version },
        );
        staleCurrentVersion = design.current_version;
      }
    });
    transaction.immediate();
    this.flushPendingEventsSafely();
    if (expired) throw new DomainError("TASK_EXPIRED", "The agent task expired before preview creation.", 410);
    if (staleCurrentVersion !== null) {
      throw this.versionConflict(input.baseVersion, staleCurrentVersion, "design");
    }
  }

  alignAgentTaskPreviewExpiry(
    actorId: string,
    input: {
      taskId: string;
      designId: string;
      previewId: string;
      baseVersion: number;
    },
  ): string {
    this.authorizeAgentTaskDesignPreviewWork(actorId, {
      taskId: input.taskId,
      designId: input.designId,
      baseVersion: input.baseVersion,
    });
    const access = resolveAccess(this.database.sqlite, actorId);
    const task = this.requireAgentTaskRow(access, input.taskId);
    const preview = this.database.sqlite.prepare(
      `SELECT id, actor_id FROM previews
       WHERE id = ? AND design_id = ? AND root_base_version = ? AND status IN ('ready', 'blocked')`,
    ).get(input.previewId, input.designId, input.baseVersion) as {
      id: string;
      actor_id: string;
    } | undefined;
    if (!preview
      || previewTaskId(this.database.sqlite, input.previewId) !== task.id
      || !this.taskArtifactBelongsToClaimedAgent(task.id, preview.actor_id)) {
      throw new DomainError("NOT_FOUND", "Agent task preview not found.", 404);
    }
    this.database.sqlite.prepare(
      "UPDATE previews SET expires_at = ? WHERE id = ? AND status IN ('ready', 'blocked')",
    ).run(task.expires_at, preview.id);
    return task.expires_at;
  }

  createAgentTask(actorId: string, input: {
    designId: string;
    brief: string;
    selection?: unknown;
    baseVersion: number;
    expectedOutput: AgentTaskExpectedOutput;
    idempotencyKey: string;
    expiresInSeconds?: number;
    locale?: string;
    platform?: ProductPlatform;
  }): AgentTaskResult {
    const { access, design } = this.requireTaskCreateDesign(actorId, input.designId);
    const brief = boundedText(input.brief, "Task brief", 100_000);
    const selection = parseInput(AgentTaskSelectionSchema, input.selection ?? [], "Task selection");
    const expectedOutput = parseInput(AgentTaskExpectedOutputSchema, input.expectedOutput, "Expected task output");
    const expiresInSeconds = input.expiresInSeconds ?? 86_400;
    const requestedLocale = input.locale === undefined ? undefined : ProductLocaleSchema.parse(input.locale);
    const requestedPlatform = ProductPlatformSchema.parse(input.platform ?? "unspecified");
    assertSeconds(expiresInSeconds, "Task expiry", 60, 604_800);
    if (design.current_version !== input.baseVersion) {
      throw this.versionConflict(input.baseVersion, design.current_version, "design");
    }
    this.assertTaskSelection(design.id, input.baseVersion, selection);
    const key = boundedText(input.idempotencyKey, "Idempotency key", 240);
    if (expectedOutput === "design_preview") {
      this.materializeDesignPreviewTaskStates(access, design.id, design.current_version, this.nowIso());
    }
    return this.withIdempotency(access, `task:${design.id}:create`, key, {
      ...input,
      brief,
      selection,
      expectedOutput,
      expiresInSeconds,
    }, () => {
      const current = this.requireDesignForAccess(access, design.id);
      if (current.current_version !== input.baseVersion) throw this.versionConflict(input.baseVersion, current.current_version, "design");
      const nowDate = this.#now();
      const now = nowDate.toISOString();
      if (expectedOutput === "design_preview") {
        const active = this.activeDesignPreviewTasks(design.id);
        if (active.length > 0) {
          const primary = active[0] as ActiveAgentTaskRow;
          throw new DomainError(
            "TASK_STATE_CONFLICT",
            `Project ${design.id} already has a nonterminal design-preview task.`,
            409,
            {
              retryable: false,
              details: {
                designId: design.id,
                expectedOutput: "design_preview",
                activeTaskId: primary.id,
                activeStatus: primary.current_status,
                activeBaseVersion: primary.base_version,
                activeExpiresAt: primary.expires_at,
                activeTaskIds: active.map((task) => task.id),
              },
            },
          );
        }
      }
      const taskId = workflowId("task");
      const expiresAt = new Date(nowDate.getTime() + expiresInSeconds * 1_000).toISOString();
      const resolvedContext = this.resolveAgentTaskContext(
        access,
        current,
        now,
        requestedLocale,
        requestedPlatform,
      );
      this.database.sqlite.prepare(
        `INSERT INTO agent_tasks
         (id, organization_id, product_id, design_id, actor_id, brief, selection_json, base_version,
          expected_output, created_at, expires_at, resolved_context_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        taskId,
        access.organizationId,
        current.product_id,
        design.id,
        access.principalId,
        brief,
        JSON.stringify(selection),
        input.baseVersion,
        expectedOutput,
        now,
        expiresAt,
        canonicalJson(resolvedContext),
      );
      this.appendTaskTransition(access, taskId, null, "queued", "Task created", {}, now);
      appendAuditEvent(this.database.sqlite, access, "agent_task.create", "agent_task", taskId, {
        designId: design.id,
        baseVersion: input.baseVersion,
        expectedOutput,
      });
      return this.agentTaskResult(this.requireAgentTaskRow(access, taskId));
    });
  }

  readAgentTask(actorId: string, taskId: string): AgentTaskResult {
    const access = resolveAccess(this.database.sqlite, actorId);
    if (access.role === "agent") assertScope(access, "task:read");
    const row = this.requireAgentTaskRow(access, taskId);
    if (row.expected_output === "design_preview") {
      const design = this.requireDesignForAccess(access, row.design_id);
      this.materializeDesignPreviewTaskStates(access, design.id, design.current_version, this.nowIso());
    }
    return this.agentTaskResult(this.requireAgentTaskRow(access, taskId));
  }

  listAgentTasks(actorId: string, input: {
    designId?: string;
    status?: AgentTaskStatus;
    expectedOutput?: AgentTaskExpectedOutput;
    limit?: number;
  } = {}): AgentTaskResult[] {
    const access = resolveAccess(this.database.sqlite, actorId);
    if (access.role === "agent") assertScope(access, "task:read");
    const design = input.designId === undefined
      ? undefined
      : this.requireDesignForAccess(access, input.designId);
    if (design !== undefined) {
      this.materializeDesignPreviewTaskStates(access, design.id, design.current_version, this.nowIso());
    } else {
      this.materializeVisibleDesignPreviewTaskStates(access, this.nowIso());
    }
    const designId = design?.id;
    const limit = Math.max(1, Math.min(input.limit ?? 50, 100));
    const filters = [
      "task.organization_id = ?",
      `EXISTS (
        SELECT 1 FROM designs visible_design
        WHERE visible_design.id = task.design_id
          AND visible_design.organization_id = task.organization_id
          AND ${activeDesignSqlPredicate("visible_design")}
      )`,
    ];
    const parameters: Array<string | number> = [access.organizationId];
    if (designId) {
      filters.push("task.design_id = ?");
      parameters.push(designId);
    } else if (access.projectIds.length > 0) {
      filters.push(`task.design_id IN (${access.projectIds.map(() => "?").join(", ")})`);
      parameters.push(...access.projectIds);
    }
    if (input.status !== undefined) {
      filters.push(`(
        SELECT transition.to_status FROM agent_task_transitions transition
        WHERE transition.task_id = task.id
        ORDER BY transition.rowid DESC LIMIT 1
      ) = ?`);
      parameters.push(input.status);
    }
    if (input.expectedOutput !== undefined) {
      filters.push("task.expected_output = ?");
      parameters.push(input.expectedOutput);
    }
    const rows = this.database.sqlite.prepare(
      `SELECT task.* FROM agent_tasks task
       WHERE ${filters.join(" AND ")}
       ORDER BY task.created_at DESC, task.id DESC LIMIT ?`,
    ).all(...parameters, limit) as AgentTaskRow[];
    return rows.map((row) => this.agentTaskResult(row));
  }

  claimAgentTask(actorId: string, taskId: string): AgentTaskResult {
    const access = resolveAccess(this.database.sqlite, actorId);
    if (access.role !== "agent") throw new DomainError("FORBIDDEN", "Only an agent connection can claim an agent task.", 403);
    assertScope(access, "task:claim");
    let expired = false;
    let staleCurrentVersion: number | null = null;
    const transaction = this.database.sqlite.transaction(() => {
      const row = this.requireAgentTaskRow(access, taskId);
      const current = this.currentTaskTransition(row.id);
      if (current.to_status === "claimed" && current.actor_id === access.principalId) return this.agentTaskResult(row);
      if (current.to_status !== "queued") throw this.taskStateConflict("queued", current.to_status);
      const now = this.nowIso();
      if (row.expires_at <= now) {
        this.appendTaskTransition(access, row.id, "queued", "expired", "Task expired before it was claimed", {}, now);
        appendAuditEvent(this.database.sqlite, access, "agent_task.expire", "agent_task", row.id, { fromStatus: "queued" });
        expired = true;
        return this.agentTaskResult(row);
      }
      const design = this.requireDesignForAccess(access, row.design_id);
      if (design.current_version !== row.base_version) {
        this.materializeTaskTerminalState(
          access,
          row,
          current,
          "cancelled",
          "Task was cancelled because its pinned design version is stale.",
          now,
          { reason: "stale_base", expectedBaseVersion: row.base_version, currentVersion: design.current_version },
        );
        staleCurrentVersion = design.current_version;
        return this.agentTaskResult(row);
      }
      this.appendTaskTransition(access, row.id, "queued", "claimed", "Task claimed", {}, now);
      appendAuditEvent(this.database.sqlite, access, "agent_task.claim", "agent_task", row.id, { designId: row.design_id });
      return this.agentTaskResult(row);
    });
    const result = transaction.immediate();
    this.flushPendingEventsSafely();
    if (expired) throw new DomainError("TASK_EXPIRED", "The agent task expired before it could be claimed.", 410);
    if (staleCurrentVersion !== null) throw this.versionConflict(result.baseVersion, staleCurrentVersion, "design");
    return result;
  }

  transitionAgentTask(actorId: string, taskId: string, input: {
    expectedStatus: AgentTaskStatus;
    toStatus: Exclude<AgentTaskStatus, "queued" | "claimed">;
    message?: string;
    data?: Record<string, unknown>;
    idempotencyKey?: string;
  }): AgentTaskResult {
    const access = resolveAccess(this.database.sqlite, actorId);
    if (access.role === "agent") assertScope(access, "task:update");
    const message = input.message === undefined ? null : boundedText(input.message, "Transition message", 4_000, true);
    const data = parseInput(AgentTaskTransitionDataSchema, input.data ?? {}, "Task transition data");
    let normalizedData = data;
    if (Buffer.byteLength(JSON.stringify(data), "utf8") > MAX_TRANSITION_DATA_BYTES) {
      throw new DomainError("PAYLOAD_TOO_LARGE", "Task transition data may not exceed 64 KiB.", 413);
    }
    const idempotencyKey = input.idempotencyKey === undefined
      ? null
      : boundedText(input.idempotencyKey, "Idempotency key", 240);
    if (idempotencyKey !== null && input.toStatus !== "cancelled") {
      throw new DomainError("VALIDATION_FAILED", "Task-transition idempotency is supported only for cancellation/discard.", 422);
    }
    const idempotencyScope = `agent_task:${taskId}:cancel`;
    const idempotencyRequest = {
      expectedStatus: input.expectedStatus,
      toStatus: input.toStatus,
      message,
      data,
    };
    const idempotencyRequestHash = hashPayload(idempotencyRequest);
    let expired = false;
    let previewNeedsRegeneration = false;
    let staleCurrentVersion: number | null = null;
    const transaction = this.database.sqlite.transaction(() => {
      if (idempotencyKey !== null) {
        const now = this.nowIso();
        this.database.sqlite.prepare("DELETE FROM idempotency WHERE expires_at <= ?").run(now);
        const existing = this.database.sqlite.prepare(
          `SELECT request_hash, response_json FROM idempotency
           WHERE actor_id = ? AND scope = ? AND key = ? AND expires_at > ?`,
        ).get(access.principalId, idempotencyScope, idempotencyKey, now) as IdempotencyRow | undefined;
        if (existing) {
          if (existing.request_hash !== idempotencyRequestHash) {
            throw new DomainError("IDEMPOTENCY_CONFLICT", "The idempotency key was already used with different input.", 409);
          }
          return JSON.parse(existing.response_json) as AgentTaskResult;
        }
      }
      const row = this.requireAgentTaskRow(access, taskId);
      const current = this.currentTaskTransition(row.id);
      const now = this.nowIso();
      if (!AGENT_TASK_STATUSES.slice(4).includes(current.to_status) && row.expires_at <= now) {
        this.appendTaskTransition(access, row.id, current.to_status, "expired", "Task expired", {}, now);
        appendAuditEvent(this.database.sqlite, access, "agent_task.expire", "agent_task", row.id, { fromStatus: current.to_status });
        expired = true;
        return this.agentTaskResult(row);
      }
      if (row.expected_output === "design_preview" && current.to_status === "awaiting_approval") {
        const currentData = jsonObject(current.data_json, "task transition");
        const previewId = typeof currentData.previewId === "string" ? currentData.previewId : null;
        const preview = previewId === null ? undefined : this.database.sqlite.prepare(
          `SELECT status, expires_at, render_metadata_json FROM previews
           WHERE id = ? AND design_id = ? AND root_base_version = ?`,
        ).get(previewId, row.design_id, row.base_version) as {
          status: string;
          expires_at: string;
          render_metadata_json: string | null;
        } | undefined;
        if (!preview
          || previewId === null
          || previewTaskId(this.database.sqlite, previewId) !== row.id
          || preview.status !== "ready"
          || preview.expires_at <= now
          || preview.render_metadata_json === null) {
          this.returnTaskToInProgressForPreviewRegeneration(
            access,
            row,
            current,
            now,
            { reason: "preview_unavailable", ...(previewId === null ? {} : { previewId }) },
          );
          previewNeedsRegeneration = true;
          return this.agentTaskResult(row);
        }
      }
      const currentData = jsonObject(current.data_json, "task transition");
      if (current.to_status === input.toStatus
        && current.from_status === input.expectedStatus
        && current.actor_id === access.principalId
        && current.message === message
        && canonicalJson(currentData) === canonicalJson(data)) {
        return this.agentTaskResult(row);
      }
      if (current.to_status !== input.expectedStatus) throw this.taskStateConflict(input.expectedStatus, current.to_status);
      if (input.toStatus === "expired" && row.expires_at > now) {
        throw new DomainError("VALIDATION_FAILED", "An agent task cannot expire before its configured expiry time.", 422, {
          details: { expiresAt: row.expires_at },
        });
      }
      if (!taskTransitionGraph[current.to_status].includes(input.toStatus)) {
        throw new DomainError("VALIDATION_FAILED", `Cannot move an agent task from ${current.to_status} to ${input.toStatus}.`, 422);
      }
      if (row.expected_output === "design_preview" && input.toStatus === "completed") {
        throw new DomainError(
          "VALIDATION_FAILED",
          "Design-preview tasks must be completed by atomically approving their exact persisted preview.",
          422,
          { details: { requiredAction: "approve_task_preview" } },
        );
      }
      const claimedBy = this.claimedBy(row.id);
      if (access.role === "agent") {
        if (claimedBy !== access.principalId) throw new DomainError("FORBIDDEN", "Only the agent that claimed this task may update it.", 403);
      } else {
        const canCancel = ["organization_admin", "product_manager", "design_editor"].includes(access.role) && input.toStatus === "cancelled";
        const canApprove = this.canApproveAgentTask(access)
          && current.to_status === "awaiting_approval" && input.toStatus === "completed";
        if (!canCancel && !canApprove) throw new DomainError("FORBIDDEN", "The current role cannot make this task transition.", 403);
      }
      if (input.toStatus === "in_progress"
        || (row.expected_output === "design_preview" && input.toStatus === "awaiting_approval")) {
        const design = this.requireDesignForAccess(access, row.design_id);
        if (design.current_version !== row.base_version) {
          this.materializeTaskTerminalState(
            access,
            row,
            current,
            "cancelled",
            "Task was cancelled because its pinned design version is stale.",
            now,
            {
              reason: "stale_base",
              expectedBaseVersion: row.base_version,
              currentVersion: design.current_version,
              ...(typeof data.previewId === "string" ? { previewId: data.previewId } : {}),
            },
          );
          staleCurrentVersion = design.current_version;
          return this.agentTaskResult(row);
        }
      }
      if (input.toStatus === "awaiting_approval" || input.toStatus === "completed") {
        try {
          normalizedData = this.validateTaskCompletion(row, data);
        } catch (error) {
          if (error instanceof DomainError
            && error.code === "PREVIEW_EXPIRED"
            && row.expected_output === "design_preview"
            && input.toStatus === "awaiting_approval"
            && typeof data.previewId === "string") {
            previewNeedsRegeneration = true;
            return this.agentTaskResult(row);
          }
          throw error;
        }
      }
      const discardedPreviewId = input.toStatus === "cancelled"
        ? this.expireDiscardedTaskPreview(row, current, data, now)
        : null;
      this.appendTaskTransition(access, row.id, current.to_status, input.toStatus, message, normalizedData, now);
      appendAuditEvent(this.database.sqlite, access, "agent_task.transition", "agent_task", row.id, {
        fromStatus: current.to_status,
        toStatus: input.toStatus,
        expectedOutput: row.expected_output,
        discardedPreview: discardedPreviewId !== null,
      });
      const result = this.agentTaskResult(row);
      if (idempotencyKey !== null) {
        const createdAt = this.nowIso();
        const expiresAt = new Date(this.#now().getTime() + IDEMPOTENCY_TTL_MS).toISOString();
        this.database.sqlite.prepare(
          `INSERT INTO idempotency
           (actor_id, scope, key, request_hash, response_json, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          access.principalId,
          idempotencyScope,
          idempotencyKey,
          idempotencyRequestHash,
          JSON.stringify(result),
          createdAt,
          expiresAt,
        );
      }
      return result;
    });
    const result = transaction.immediate();
    this.flushPendingEventsSafely();
    if (expired) throw new DomainError("TASK_EXPIRED", "The agent task expired.", 410);
    if (previewNeedsRegeneration) {
      throw new DomainError("PREVIEW_EXPIRED", "The exact task preview is no longer reviewable; regenerate it with the same task.", 410, {
        retryable: true,
        details: { taskId, requiredStatus: "in_progress", requiredAction: "regenerate_preview" },
      });
    }
    if (staleCurrentVersion !== null) throw this.versionConflict(result.baseVersion, staleCurrentVersion, "design");
    return result;
  }

  approveAgentTaskDesignPreview(actorId: string, taskId: string, input: {
    designId: string;
    previewId: string;
    expectedBaseVersion: number;
    idempotencyKey: string;
    message?: string;
    kind?: PreviewKind;
  }): AgentTaskPreviewApprovalResult {
    const access = resolveAccess(this.database.sqlite, actorId);
    this.assertTaskApproval(access);
    const task = this.requireAgentTaskRow(access, taskId);
    const designer = this.#designerService;
    if (!designer) {
      throw new DomainError("INTERNAL_ERROR", "The atomic task preview approval service is unavailable.", 500);
    }
    const previewId = boundedText(input.previewId, "Preview ID", 240);
    const key = boundedText(input.idempotencyKey, "Idempotency key", 240);
    const message = input.message === undefined
      ? `Approve FormaSpec proposal from task ${task.id}`
      : boundedText(input.message, "Commit message", 500);
    const kind = input.kind ?? "ordinary";
    if (task.design_id !== input.designId || task.base_version !== input.expectedBaseVersion) {
      throw new DomainError("VALIDATION_FAILED", "The task design or base version does not match the preview approval request.", 422);
    }
    if (task.expected_output !== "design_preview") {
      throw new DomainError("VALIDATION_FAILED", "Only a design-preview task can use exact preview approval.", 422);
    }
    const approvalNow = this.nowIso();
    const expiryDisposition = this.expireAwaitingTaskPreviewApproval(access, task, previewId, approvalNow);
    if (expiryDisposition === "task_expired") {
      throw new DomainError("TASK_EXPIRED", "The agent task expired before its preview could be approved.", 410, {
        retryable: true,
      });
    }
    if (expiryDisposition === "preview_regeneration") {
      throw new DomainError(
        "PREVIEW_EXPIRED",
        "The exact preview is no longer reviewable; the task was returned to in_progress for regeneration.",
        410,
        { retryable: true, details: { taskId: task.id, requiredAction: "regenerate_preview" } },
      );
    }

    return this.withIdempotency(access, `task:${task.id}:approve-design-preview`, key, {
      designId: input.designId,
      previewId,
      expectedBaseVersion: input.expectedBaseVersion,
      message,
      kind,
    }, () => {
      const currentTask = this.requireAgentTaskRow(access, task.id);
      const current = this.currentTaskTransition(currentTask.id);
      if (current.to_status !== "awaiting_approval") {
        throw this.taskStateConflict("awaiting_approval", current.to_status);
      }
      const proposal = jsonObject(current.data_json, "task transition");
      if (proposal.previewId !== previewId) {
        throw new DomainError("VALIDATION_FAILED", "The preview does not match the task proposal awaiting approval.", 422);
      }
      const completion = this.validateTaskCompletion(currentTask, proposal);
      const revision = designer.commitExactTaskPreviewInCurrentTransaction(actorId, input.designId, {
        previewId,
        expectedBaseVersion: input.expectedBaseVersion,
        taskId: currentTask.id,
        kind,
        message,
      });
      this.appendTaskTransition(
        access,
        currentTask.id,
        "awaiting_approval",
        "completed",
        "The product manager approved and committed the exact design preview.",
        completion,
        approvalNow,
      );
      appendAuditEvent(this.database.sqlite, access, "agent_task.transition", "agent_task", currentTask.id, {
        fromStatus: "awaiting_approval",
        toStatus: "completed",
        expectedOutput: currentTask.expected_output,
        revisionId: revision.revision.id,
      });
      return {
        revision,
        task: this.agentTaskResult(currentTask),
      };
    });
  }

  readOwnAuthorizationContext(actorId: string): OwnAuthorizationContextResult {
    const access = resolveAccess(this.database.sqlite, actorId);
    return {
      role: access.role,
      scopes: [...access.scopes],
      projectIds: [...access.projectIds],
    };
  }

  authorizeAgentConnectionAdministration(actorId: string): void {
    const access = resolveAccess(this.database.sqlite, actorId);
    this.assertOrganizationAdmin(access);
  }

  createAgentConnection(actorId: string, input: {
    adapter: "codex" | "generic_mcp";
    displayName: string;
    scopes: string[];
    projectIds?: string[];
    expiresInSeconds?: number;
    replaceExisting?: boolean;
  }): PairingChallenge {
    const access = resolveAccess(this.database.sqlite, actorId);
    this.assertOrganizationAdmin(access);
    if (input.adapter !== "codex" && input.adapter !== "generic_mcp") {
      throw new DomainError("VALIDATION_FAILED", "Unsupported agent adapter.", 422);
    }
    const displayName = boundedText(input.displayName, "Connection display name", 240);
    const scopes = [...new Set(input.scopes)];
    if (scopes.length === 0 || scopes.length > AGENT_CONNECTION_SCOPES.length
      || scopes.some((scope) => !AGENT_CONNECTION_SCOPES.includes(scope as (typeof AGENT_CONNECTION_SCOPES)[number]))) {
      throw new DomainError("VALIDATION_FAILED", "The connection contains an unsupported or empty scope set.", 422);
    }
    const projectIds = [...new Set(input.projectIds ?? [])];
    if (projectIds.length > 100) throw new DomainError("PAYLOAD_TOO_LARGE", "A connection may be restricted to at most 100 projects.", 413);
    for (const projectId of projectIds) this.requireDesignForAccess(access, projectId);
    const expiresInSeconds = input.expiresInSeconds ?? 86_400;
    assertSeconds(expiresInSeconds, "Connection expiry", 300, 2_592_000);
    const policy = loadOrganizationPolicy(this.database.sqlite, access.organizationId).policy;
    this.assertAgentConnectionPolicy(policy, {
      adapter: input.adapter,
      scopes,
      projectIds,
      expiresInSeconds,
    });
    const transaction = this.database.sqlite.transaction(() => {
      const nowDate = this.#now();
      const now = nowDate.toISOString();
      let replacedConnectionIds: string[] = [];
      if (input.replaceExisting === true) {
        const replacementNames = input.adapter === "codex"
          && INSTALLER_MANAGED_CODEX_RECONCILIATION_NAMES.includes(
            displayName as (typeof INSTALLER_MANAGED_CODEX_RECONCILIATION_NAMES)[number],
          )
          ? INSTALLER_MANAGED_CODEX_RECONCILIATION_NAMES
          : [displayName];
        const existingRows = this.database.sqlite.prepare(
          `SELECT * FROM agent_connections
           WHERE organization_id = ? AND adapter = ?
             AND display_name IN (${replacementNames.map(() => "?").join(", ")})
             AND status IN ('active', 'pending')
             AND (expires_at IS NULL OR expires_at > ?)
           ORDER BY created_at, id`,
        ).all(access.organizationId, input.adapter, ...replacementNames, now) as AgentConnectionRow[];
        replacedConnectionIds = existingRows.map((row) => row.id);
      }
      const connectionExpiresAt = new Date(nowDate.getTime() + expiresInSeconds * 1_000).toISOString();
      this.assertAgentConnectionCapacity(policy, access.organizationId, now, replacedConnectionIds, true);
      return this.createPendingAgentConnectionRow(access, {
        adapter: input.adapter,
        displayName,
        scopes,
        projectIds,
        connectionExpiresAt,
        replacedConnectionIds,
        auditAction: "agent_connection.create",
        auditDetails: {
          replaceExisting: input.replaceExisting === true,
          replacedConnectionIds,
        },
      }, nowDate);
    });
    const result = transaction.immediate();
    this.flushPendingEventsSafely();
    return result;
  }

  pairAgentConnection(nonce: string): PairedAgentConnection {
    if (!nonce.startsWith("fspair_") || nonce.length > 200) throw new DomainError("NOT_FOUND", "Pairing challenge not found.", 404);
    const nonceHash = sha256(nonce);
    const transaction = this.database.sqlite.transaction(() => {
      const row = this.database.sqlite.prepare(
        `SELECT n.connection_id, n.created_by, n.expires_at AS nonce_expires_at, n.consumed_at, n.revoked_at,
                c.*
         FROM pairing_nonces n JOIN agent_connections c ON c.id = n.connection_id
         WHERE n.nonce_hash = ?`,
      ).get(nonceHash) as (AgentConnectionRow & {
        connection_id: string;
        created_by: string;
        nonce_expires_at: string;
        consumed_at: string | null;
        revoked_at: string | null;
      }) | undefined;
      if (!row) throw new DomainError("NOT_FOUND", "Pairing challenge not found.", 404);
      const now = this.nowIso();
      if (row.revoked_at || row.status === "revoked") throw new DomainError("CONNECTION_REVOKED", "The agent connection was revoked.", 410);
      if (row.consumed_at) throw new DomainError("VERSION_CONFLICT", "The pairing challenge was already consumed.", 409);
      if (row.nonce_expires_at <= now || (row.expires_at && row.expires_at <= now)) {
        this.database.sqlite.prepare("UPDATE agent_connections SET status = 'expired', updated_at = ? WHERE id = ?").run(now, row.id);
        this.database.sqlite.prepare(
          "UPDATE pairing_nonces SET revoked_at = ? WHERE nonce_hash = ? AND consumed_at IS NULL AND revoked_at IS NULL",
        ).run(now, nonceHash);
        clearAgentConnectionReplacement(this.database.sqlite, row.id);
        const expiryAccess: AccessContext = {
          actorId: "system",
          principalId: row.created_by,
          organizationId: row.organization_id,
          role: "organization_admin",
          scopes: ["*"],
          projectIds: [],
        };
        appendAuditEvent(this.database.sqlite, expiryAccess, "agent_connection.expire", "agent_connection", row.id);
        this.enqueueEvent(expiryAccess, "agent_connection.changed", { connectionId: row.id, status: "expired" }, now);
        return null;
      }
      if (row.status !== "pending") throw new DomainError("VERSION_CONFLICT", `The connection is ${row.status}, not pending.`, 409);
      const replacementIntent = readAgentConnectionReplacement(
        this.database.sqlite,
        row.id,
        row.organization_id,
      );
      const replacedRows = replacementIntent
        ? this.requireAgentConnectionReplacementRows(row, replacementIntent)
        : [];
      const createPrincipal = replacementIntent !== null || !row.principal_id;
      const principalId = createPrincipal ? workflowId("principal") : row.principal_id as string;
      const grantId = randomUUID().replaceAll("-", "");
      const grantToken = `fsg_${randomBytes(32).toString("base64url")}`;
      const scopes = jsonStringArray(row.scopes_json, "connection scopes");
      const projectIds = jsonStringArray(row.project_ids_json, "connection projects");
      this.assertAgentConnectionProjectsActive(row.organization_id, projectIds);
      const expiresAt = row.expires_at as string;
      const policy = loadOrganizationPolicy(this.database.sqlite, row.organization_id).policy;
      this.assertAgentConnectionPolicy(policy, {
        adapter: row.adapter,
        scopes,
        projectIds,
        expiresInSeconds: Math.max(0, Math.ceil((new Date(expiresAt).getTime() - new Date(now).getTime()) / 1_000)),
      });
      this.assertAgentConnectionCapacity(policy, row.organization_id, now, [], false);
      if (createPrincipal) {
        this.database.sqlite.prepare(
          `INSERT INTO principals
           (id, organization_id, kind, display_name, external_id, created_at)
           VALUES (?, ?, 'agent', ?, ?, ?)`,
        ).run(principalId, row.organization_id, row.display_name, `connection:${row.id}`, now);
        this.database.sqlite.prepare(
          `INSERT INTO memberships (organization_id, principal_id, role, created_at)
           VALUES (?, ?, 'agent', ?)`,
        ).run(row.organization_id, principalId, now);
      } else {
        const reusable = this.database.sqlite.prepare(
          `SELECT p.id FROM principals p
           JOIN memberships m ON m.principal_id = p.id AND m.organization_id = p.organization_id
           WHERE p.id = ? AND p.organization_id = ? AND p.kind = 'agent'
             AND p.disabled_at IS NULL AND m.role = 'agent'`,
        ).get(principalId, row.organization_id);
        if (!reusable) throw new DomainError("AUTH_REQUIRED", "The paired agent principal is unavailable.", 401);
      }
      this.database.sqlite.prepare(
        `INSERT INTO agent_grants
         (id, organization_id, principal_id, token_hash, scopes_json, project_ids_json, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(grantId, row.organization_id, principalId, sha256(grantToken), row.scopes_json, row.project_ids_json, now, expiresAt);
      const activated = this.database.sqlite.prepare(
        `UPDATE agent_connections SET principal_id = ?, status = 'active', updated_at = ?
         WHERE id = ? AND status = 'pending'`,
      ).run(principalId, now, row.id);
      if (activated.changes !== 1) {
        throw new DomainError("VERSION_CONFLICT", "The pending agent connection changed before activation.", 409);
      }
      const consumed = this.database.sqlite.prepare(
        "UPDATE pairing_nonces SET consumed_at = ? WHERE nonce_hash = ? AND consumed_at IS NULL AND revoked_at IS NULL",
      ).run(now, nonceHash);
      if (consumed.changes !== 1) {
        throw new DomainError("VERSION_CONFLICT", "The pairing challenge changed before activation.", 409);
      }
      const pairedAccess: AccessContext = {
        actorId: `grant_${grantId}`,
        principalId,
        organizationId: row.organization_id,
        role: "agent",
        scopes,
        projectIds,
        grantId,
      };
      for (const replacedRow of replacedRows) {
        this.revokeAgentConnectionRow(pairedAccess, replacedRow, now, {
          reason: "replaced",
          replacementConnectionId: row.id,
        });
      }
      if (replacementIntent) consumeAgentConnectionReplacement(this.database.sqlite, replacementIntent);
      appendAuditEvent(this.database.sqlite, pairedAccess, "agent_connection.pair", "agent_connection", row.id, {
        adapter: row.adapter,
        grantId,
        expiresAt,
        replacedConnectionIds: replacementIntent?.replaced_connection_ids ?? [],
      });
      this.enqueueEvent(pairedAccess, "agent_connection.changed", {
        connectionId: row.id,
        adapter: row.adapter,
        status: "active",
      }, now);
      return {
        connection: this.agentConnectionResult(this.requireAgentConnectionRow(pairedAccess, row.id)),
        grant: {
          id: grantId,
          actorId: `grant_${grantId}`,
          token: grantToken,
          expiresAt,
          scopes,
          projectIds,
        },
      };
    });
    const result = transaction.immediate();
    this.flushPendingEventsSafely();
    if (!result) throw new DomainError("PAIRING_EXPIRED", "The pairing challenge expired.", 410);
    return result;
  }

  renewAgentConnectionPairing(actorId: string, connectionId: string): PairingChallenge {
    const access = resolveAccess(this.database.sqlite, actorId);
    this.assertOrganizationAdmin(access);
    const transaction = this.database.sqlite.transaction(() => {
      const row = this.requireAgentConnectionRow(access, connectionId);
      if (row.status === "revoked") throw new DomainError("CONNECTION_REVOKED", "The agent connection was revoked.", 410);
      const nowDate = this.#now();
      const now = nowDate.toISOString();
      const policy = loadOrganizationPolicy(this.database.sqlite, access.organizationId).policy;
      const scopes = jsonStringArray(row.scopes_json, "connection scopes");
      const projectIds = jsonStringArray(row.project_ids_json, "connection projects");
      this.assertAgentConnectionProjectsActive(row.organization_id, projectIds);
      const remainingSeconds = row.expires_at
        ? Math.max(0, Math.ceil((new Date(row.expires_at).getTime() - nowDate.getTime()) / 1_000))
        : policy.agents.maximumExpirySeconds;
      if (row.status === "expired" || remainingSeconds === 0) {
        throw new DomainError("PAIRING_EXPIRED", "The agent connection expired and must be created again.", 410);
      }
      this.assertAgentConnectionPolicy(policy, {
        adapter: row.adapter,
        scopes,
        projectIds,
        expiresInSeconds: remainingSeconds,
      });
      const inheritedIntent = readAgentConnectionReplacement(
        this.database.sqlite,
        row.id,
        row.organization_id,
      );
      const replacedConnectionIds = [...new Set([
        row.id,
        ...(inheritedIntent?.replaced_connection_ids ?? []),
      ])];
      this.assertAgentConnectionCapacity(policy, access.organizationId, now, replacedConnectionIds, true);
      const connectionExpiresAt = row.expires_at
        ?? new Date(nowDate.getTime() + remainingSeconds * 1_000).toISOString();
      return this.createPendingAgentConnectionRow(access, {
        adapter: row.adapter,
        displayName: row.display_name,
        scopes,
        projectIds,
        connectionExpiresAt,
        replacedConnectionIds,
        auditAction: "agent_connection.reconnect",
        auditDetails: {
          sourceConnectionId: row.id,
          replacedConnectionIds,
        },
      }, nowDate);
    });
    const result = transaction.immediate();
    this.flushPendingEventsSafely();
    return result;
  }

  revokeAgentConnection(actorId: string, connectionId: string): AgentConnectionResult {
    const access = resolveAccess(this.database.sqlite, actorId);
    this.assertOrganizationAdmin(access);
    const transaction = this.database.sqlite.transaction(() => {
      const row = this.requireAgentConnectionRow(access, connectionId);
      const now = this.nowIso();
      return this.revokeAgentConnectionRow(access, row, now);
    });
    const result = transaction.immediate();
    this.flushPendingEventsSafely();
    return result;
  }

  listAgentConnections(actorId: string): AgentConnectionResult[] {
    const access = resolveAccess(this.database.sqlite, actorId);
    this.assertOrganizationAdmin(access);
    const rows = this.database.sqlite.prepare(
      "SELECT * FROM agent_connections WHERE organization_id = ? ORDER BY updated_at DESC",
    ).all(access.organizationId) as AgentConnectionRow[];
    return rows.map((row) => this.agentConnectionResult(row));
  }

  resolveGrantActorId(token: string): string {
    if (!token.startsWith("fsg_") || token.length > 200) throw new DomainError("AUTH_REQUIRED", "The agent grant is unavailable.", 401);
    const now = this.nowIso();
    const row = this.database.sqlite.prepare(
      `SELECT g.id, g.principal_id, g.expires_at, g.revoked_at, p.disabled_at,
              c.id AS connection_id, c.status AS connection_status, c.expires_at AS connection_expires_at
       FROM agent_grants g
       JOIN principals p ON p.id = g.principal_id
       JOIN agent_connections c ON c.principal_id = g.principal_id
       WHERE g.token_hash = ?`,
    ).get(sha256(token)) as {
      id: string;
      principal_id: string;
      expires_at: string;
      revoked_at: string | null;
      disabled_at: string | null;
      connection_id: string;
      connection_status: AgentConnectionStatus;
      connection_expires_at: string | null;
    } | undefined;
    if (!row || row.revoked_at || row.disabled_at || row.expires_at <= now
      || row.connection_status !== "active" || (row.connection_expires_at && row.connection_expires_at <= now)) {
      throw new DomainError("AUTH_REQUIRED", "The agent grant is expired, revoked, or unavailable.", 401);
    }
    const transaction = this.database.sqlite.transaction(() => {
      this.database.sqlite.prepare("UPDATE agent_grants SET last_used_at = ? WHERE id = ?").run(now, row.id);
      this.database.sqlite.prepare("UPDATE agent_connections SET last_used_at = ?, updated_at = ? WHERE id = ?").run(now, now, row.connection_id);
    });
    transaction.immediate();
    return `grant_${row.id}`;
  }

  private specificationWithNaturalLanguageBrief(designId: string, baseVersion: number, brief: string): ProductSpecification {
    const naturalLanguageBrief = boundedText(brief, "Natural-language product brief", 100_000, true);
    if (baseVersion === 0) {
      return ProductSpecificationSchema.parse({
        id: workflowId("spec"),
        version: 1,
        natural_language_brief: naturalLanguageBrief,
      });
    }
    const current = this.productSpecificationResult(this.requireProductSpecificationRow(designId, baseVersion)).specification;
    return ProductSpecificationSchema.parse({
      ...current,
      version: baseVersion + 1,
      natural_language_brief: naturalLanguageBrief,
    });
  }

  private productSpecificationDiagnostics(specification: ProductSpecification): EnterpriseDiagnostic[] {
    const diagnostics: EnterpriseDiagnostic[] = [];
    if (specification.goals.length === 0) diagnostics.push({ code: "SPEC_GOALS_MISSING", severity: "warning", message: "Define at least one measurable product goal.", path: "goals" });
    if (specification.flows.length === 0) diagnostics.push({ code: "SPEC_FLOWS_MISSING", severity: "warning", message: "Define at least one important product flow.", path: "flows" });
    if (specification.acceptance_criteria.length === 0) diagnostics.push({ code: "SPEC_ACCEPTANCE_MISSING", severity: "warning", message: "Add acceptance criteria before engineering handoff.", path: "acceptance_criteria" });
    const openQuestions = specification.open_questions.filter((question) => question.status === "open").length;
    if (openQuestions > 0) diagnostics.push({ code: "SPEC_OPEN_QUESTIONS", severity: "info", message: `${openQuestions} open product question${openQuestions === 1 ? " remains" : "s remain"}.`, path: "open_questions" });
    return diagnostics;
  }

  private productSpecificationPreviewResult(row: ProductSpecificationPreviewRow): ProductSpecificationPreviewResult {
    const canonical = canonicalProductSpecification(JSON.parse(row.specification_json) as unknown);
    if (canonical.json !== row.specification_json || canonical.hash !== row.specification_hash) {
      throw new DomainError("INTERNAL_ERROR", "Persisted product specification preview integrity check failed.", 500);
    }
    const diagnostics = JSON.parse(row.diagnostics_json) as EnterpriseDiagnostic[];
    return {
      id: row.id,
      designId: row.design_id,
      baseVersion: row.base_version,
      resultVersion: canonical.specification.version,
      specification: canonical.specification,
      specificationHash: row.specification_hash,
      diagnostics,
      status: row.status,
      canCommit: row.status === "ready" && !diagnostics.some((item) => item.severity === "error"),
      expiresAt: row.expires_at,
      committedVersion: row.committed_version,
      committedAt: row.committed_at,
    };
  }

  private productSpecificationResult(row: ProductSpecificationRow): ProductSpecificationResult {
    const canonical = canonicalProductSpecification(JSON.parse(row.specification_json) as unknown);
    if (canonical.json !== row.specification_json || canonical.hash !== row.specification_hash) {
      throw new DomainError("INTERNAL_ERROR", "Persisted product specification integrity check failed.", 500);
    }
    return {
      designId: row.design_id,
      version: row.version,
      specification: canonical.specification,
      specificationHash: row.specification_hash,
      message: row.message,
      revisionId: row.revision_id,
      actorId: row.actor_id,
      createdAt: row.created_at,
    };
  }

  private currentProductSpecificationVersion(designId: string): number {
    const row = this.database.sqlite.prepare(
      "SELECT COALESCE(MAX(version), 0) AS version FROM product_specifications WHERE design_id = ?",
    ).get(designId) as { version: number };
    return row.version;
  }

  private requireProductSpecificationRow(designId: string, version: number): ProductSpecificationRow {
    const row = this.database.sqlite.prepare(
      "SELECT * FROM product_specifications WHERE design_id = ? AND version = ?",
    ).get(designId, version) as ProductSpecificationRow | undefined;
    if (!row) throw new DomainError("NOT_FOUND", `Product specification version ${version} was not found.`, 404);
    return row;
  }

  private requireProductSpecificationPreviewRow(access: AccessContext, designId: string, previewId: string): ProductSpecificationPreviewRow {
    const row = this.database.sqlite.prepare(
      `SELECT * FROM product_spec_previews
       WHERE id = ? AND design_id = ? AND organization_id = ? AND actor_id = ?`,
    ).get(previewId, designId, access.organizationId, access.principalId) as ProductSpecificationPreviewRow | undefined;
    if (!row) throw new DomainError("NOT_FOUND", "Product specification preview not found.", 404);
    return row;
  }

  private expireProductSpecificationPreviews(
    access: AccessContext,
    designId: string,
    now: string,
    previewId?: string,
  ): void {
    const previewClause = previewId === undefined ? "" : " AND id = ?";
    this.database.sqlite.prepare(
      `UPDATE product_spec_previews SET status = 'expired'
       WHERE organization_id = ? AND design_id = ? AND actor_id = ?
         AND expires_at <= ? AND status IN ('ready', 'blocked')${previewClause}`,
    ).run(access.organizationId, designId, access.principalId, now, ...(previewId === undefined ? [] : [previewId]));
  }

  private planningSessionResult(row: PlanningSessionRow): PlanningSessionResult {
    const answerRows = this.database.sqlite.prepare(
      `SELECT answer.* FROM planning_answers answer
       JOIN (
         SELECT section, MAX(version) AS version FROM planning_answers
         WHERE session_id = ? GROUP BY section
       ) latest ON latest.section = answer.section AND latest.version = answer.version
       WHERE answer.session_id = ?`,
    ).all(row.id, row.id) as PlanningAnswerRow[];
    const answerBySection = new Map(answerRows.map((answer) => [answer.section, answer]));
    const orderedAnswers = PLANNING_SECTIONS.flatMap((section) => {
      const answer = answerBySection.get(section);
      return answer ? [{
        id: answer.id,
        section: answer.section,
        version: answer.version,
        answer: answer.answer,
        actor_id: answer.actor_id,
        created_at: answer.created_at,
      }] : [];
    });
    const session = PlanningSessionSchema.parse({
      id: row.id,
      project_id: row.design_id,
      version: row.version,
      status: row.status,
      current_section: row.current_section,
      answers: orderedAnswers,
      created_at: row.created_at,
      updated_at: row.updated_at,
    });
    const versionRows = this.database.sqlite.prepare(
      "SELECT * FROM planning_session_versions WHERE session_id = ? ORDER BY version",
    ).all(row.id) as PlanningVersionRow[];
    return {
      session,
      versions: versionRows.map((version) => ({
        version: version.version,
        status: version.status,
        currentSection: version.current_section,
        actorId: version.actor_id,
        createdAt: version.created_at,
      })),
      answeredSections: PLANNING_SECTIONS.filter((section) => answerBySection.has(section)),
      sectionCount: 22,
    };
  }

  private requirePlanningSessionRow(access: AccessContext, sessionId: string): PlanningSessionRow {
    const row = this.database.sqlite.prepare("SELECT * FROM planning_sessions WHERE id = ?").get(sessionId) as PlanningSessionRow | undefined;
    if (!row) throw new DomainError("NOT_FOUND", "Planning session not found.", 404);
    requireActiveDesign(this.database.sqlite, access, row.design_id);
    return row;
  }

  private nextPlanningSection(section: PlanningSection): PlanningSection {
    const index = PLANNING_SECTIONS.indexOf(section);
    return PLANNING_SECTIONS[Math.min(index + 1, PLANNING_SECTIONS.length - 1)] as PlanningSection;
  }

  private assertPlanningComplete(sessionId: string, additionallyAnswered?: PlanningSection): void {
    const rows = this.database.sqlite.prepare(
      "SELECT DISTINCT section FROM planning_answers WHERE session_id = ?",
    ).all(sessionId) as Array<{ section: PlanningSection }>;
    const answered = new Set(rows.map((row) => row.section));
    if (additionallyAnswered) answered.add(additionallyAnswered);
    const missing = PLANNING_SECTIONS.filter((section) => !answered.has(section));
    if (missing.length > 0) {
      throw new DomainError("VALIDATION_FAILED", "All 22 planning sections must be answered before review or completion.", 422, {
        details: { missingSections: missing },
      });
    }
  }

  private activeDesignPreviewTasks(designId: string): ActiveAgentTaskRow[] {
    return this.database.sqlite.prepare(
      `SELECT task.*, current.to_status AS current_status
       FROM agent_tasks task
       JOIN agent_task_transitions current ON current.rowid = (
         SELECT latest.rowid FROM agent_task_transitions latest
         WHERE latest.task_id = task.id ORDER BY latest.rowid DESC LIMIT 1
       )
       WHERE task.design_id = ?
         AND task.expected_output = 'design_preview'
         AND current.to_status IN ('queued', 'claimed', 'in_progress', 'awaiting_approval')
       ORDER BY CASE current.to_status WHEN 'awaiting_approval' THEN 0 ELSE 1 END,
                task.created_at DESC, task.id DESC`,
    ).all(designId) as ActiveAgentTaskRow[];
  }

  private materializeVisibleDesignPreviewTaskStates(access: AccessContext, now: string): void {
    const filters = [
      "design.organization_id = ?",
      "task.expected_output = 'design_preview'",
      "current.to_status IN ('queued', 'claimed', 'in_progress', 'awaiting_approval')",
    ];
    const parameters: string[] = [access.organizationId];
    if (access.projectIds.length > 0) {
      filters.push(`design.id IN (${access.projectIds.map(() => "?").join(", ")})`);
      parameters.push(...access.projectIds);
    }
    const rows = this.database.sqlite.prepare(
      `SELECT design.id, design.current_version
       FROM designs design
       JOIN agent_tasks task ON task.design_id = design.id
       JOIN agent_task_transitions current ON current.rowid = (
         SELECT latest.rowid FROM agent_task_transitions latest
         WHERE latest.task_id = task.id ORDER BY latest.rowid DESC LIMIT 1
       )
       WHERE ${filters.join(" AND ")}
       GROUP BY design.id, design.current_version
       ORDER BY MAX(task.created_at) DESC, design.id DESC LIMIT 100`,
    ).all(...parameters) as Array<{ id: string; current_version: number }>;
    for (const row of rows) {
      this.materializeDesignPreviewTaskStates(access, row.id, row.current_version, now);
    }
  }

  private materializeDesignPreviewTaskStates(
    access: AccessContext,
    designId: string,
    currentVersion: number,
    now: string,
  ): void {
    const execute = () => {
      for (const task of this.activeDesignPreviewTasks(designId)) {
        const current = this.currentTaskTransition(task.id);
        if (task.expires_at <= now) {
          this.materializeTaskTerminalState(access, task, current, "expired", "Task expired.", now, {
            reason: "expired",
          });
          continue;
        }
        if (current.to_status === "awaiting_approval") {
          const currentData = jsonObject(current.data_json, "task transition");
          const previewId = typeof currentData.previewId === "string" ? currentData.previewId : null;
          const preview = previewId === null ? undefined : this.database.sqlite.prepare(
            `SELECT status, expires_at, render_metadata_json FROM previews
             WHERE id = ? AND design_id = ? AND root_base_version = ?`,
          ).get(previewId, task.design_id, task.base_version) as {
            status: string;
            expires_at: string;
            render_metadata_json: string | null;
          } | undefined;
          if (!preview
            || previewId === null
            || previewTaskId(this.database.sqlite, previewId) !== task.id
            || preview.status !== "ready"
            || preview.expires_at <= now
            || preview.render_metadata_json === null) {
            this.returnTaskToInProgressForPreviewRegeneration(
              access,
              task,
              current,
              now,
              { reason: "preview_unavailable", ...(previewId === null ? {} : { previewId }) },
            );
            continue;
          }
        }
        if (task.base_version !== currentVersion) {
          this.materializeTaskTerminalState(
            access,
            task,
            current,
            "cancelled",
            "Task was cancelled because its pinned design version is stale.",
            now,
            { reason: "stale_base", expectedBaseVersion: task.base_version, currentVersion },
          );
        }
      }
    };
    if (this.database.sqlite.inTransaction) {
      execute();
      return;
    }
    const transaction = this.database.sqlite.transaction(execute);
    transaction.immediate();
    this.flushPendingEventsSafely();
  }

  private materializeTaskTerminalState(
    access: AccessContext,
    task: AgentTaskRow,
    current: AgentTaskTransitionRow,
    status: "cancelled" | "expired",
    message: string,
    now: string,
    details: Record<string, unknown>,
  ): void {
    if (!taskTransitionGraph[current.to_status].includes(status)) return;
    const currentData = jsonObject(current.data_json, "task transition");
    const previewId = typeof currentData.previewId === "string"
      ? currentData.previewId
      : typeof details.previewId === "string"
        ? details.previewId
        : null;
    if (previewId !== null && task.expected_output === "design_preview") {
      this.database.sqlite.prepare(
        `UPDATE previews SET status = 'expired', expires_at = ?
         WHERE id = ? AND design_id = ? AND root_base_version = ? AND status IN ('ready', 'blocked')`,
      ).run(now, previewId, task.design_id, task.base_version);
    }
    const transitionData = { ...details, ...(previewId === null ? {} : { previewId }) };
    this.appendTaskTransition(access, task.id, current.to_status, status, message, transitionData, now);
    appendAuditEvent(
      this.database.sqlite,
      access,
      status === "expired" ? "agent_task.expire" : "agent_task.cancel_stale",
      "agent_task",
      task.id,
      { fromStatus: current.to_status, expectedOutput: task.expected_output, ...transitionData },
    );
  }

  private returnTaskToInProgressForPreviewRegeneration(
    access: AccessContext,
    task: AgentTaskRow,
    current: AgentTaskTransitionRow,
    now: string,
    details: Record<string, unknown>,
  ): void {
    if (current.to_status !== "awaiting_approval"
      || !taskTransitionGraph[current.to_status].includes("in_progress")) return;
    const currentData = jsonObject(current.data_json, "task transition");
    const previewId = typeof currentData.previewId === "string"
      ? currentData.previewId
      : typeof details.previewId === "string"
        ? details.previewId
        : null;
    if (previewId !== null) {
      this.database.sqlite.prepare(
        `UPDATE previews SET status = 'expired', expires_at = ?
         WHERE id = ? AND design_id = ? AND root_base_version = ? AND status IN ('ready', 'blocked')`,
      ).run(now, previewId, task.design_id, task.base_version);
    }
    const transitionData = {
      ...details,
      ...(previewId === null ? {} : { previousPreviewId: previewId }),
    };
    this.appendTaskTransition(
      access,
      task.id,
      "awaiting_approval",
      "in_progress",
      "The exact preview is no longer reviewable; regenerate it with this task.",
      transitionData,
      now,
    );
    appendAuditEvent(
      this.database.sqlite,
      access,
      "agent_task.preview_regenerate",
      "agent_task",
      task.id,
      { fromStatus: "awaiting_approval", expectedOutput: task.expected_output, ...transitionData },
    );
  }

  private agentTaskResult(row: AgentTaskRow): AgentTaskResult {
    const transitions = this.taskTransitions(row.id);
    const current = transitions.at(-1);
    if (!current) throw new DomainError("INTERNAL_ERROR", "The agent task has no initial transition.", 500);
    const productId = row.product_id ?? (this.database.sqlite.prepare(
      "SELECT product_id FROM designs WHERE id = ? AND organization_id = ?",
    ).get(row.design_id, row.organization_id) as { product_id: string } | undefined)?.product_id;
    const product = productId === undefined ? undefined : this.database.sqlite.prepare(
      "SELECT id, name, status FROM products WHERE id = ? AND organization_id = ?",
    ).get(productId, row.organization_id) as {
      id: string;
      name: string;
      status: "active" | "archived";
    } | undefined;
    if (!product) throw new DomainError("INTERNAL_ERROR", "The agent task Product context is unavailable.", 500);
    let resolvedContext: AgentTaskResolvedContext | null = null;
    if (row.resolved_context_json !== null) {
      try {
        resolvedContext = AgentTaskResolvedContextSchema.parse(JSON.parse(row.resolved_context_json) as unknown);
      } catch (error) {
        throw new DomainError("INTERNAL_ERROR", "The persisted agent task Product context is invalid.", 500, { cause: error });
      }
    }
    let readiness: DesignReadinessReport | null = null;
    for (let index = transitions.length - 1; index >= 0; index -= 1) {
      const candidate = transitions[index]?.data.readiness;
      if (candidate === undefined) continue;
      try {
        readiness = DesignReadinessReportSchema.parse(candidate);
      } catch (error) {
        throw new DomainError("INTERNAL_ERROR", "The persisted task readiness report is invalid.", 500, { cause: error });
      }
      break;
    }
    return {
      id: row.id,
      product,
      designId: row.design_id,
      brief: row.brief,
      selection: AgentTaskSelectionSchema.parse(JSON.parse(row.selection_json) as unknown),
      baseVersion: row.base_version,
      expectedOutput: AgentTaskExpectedOutputSchema.parse(row.expected_output),
      status: current.toStatus,
      claimedBy: transitions.find((transition) => transition.toStatus === "claimed")?.actorId ?? null,
      createdBy: row.actor_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      resolvedContext,
      readiness,
      transitions,
    };
  }

  private resolveAgentTaskContext(
    access: AccessContext,
    design: DesignAccessRow,
    capturedAt: string,
    requestedLocale: string | undefined,
    platform: ProductPlatform,
  ): AgentTaskResolvedContext {
    const product = this.database.sqlite.prepare(
      `SELECT id, name, status, updated_at, canonical_specification_design_id,
              default_design_system_release_id, default_locale, default_direction, locales_json
       FROM products WHERE id = ? AND organization_id = ? AND status = 'active'`,
    ).get(design.product_id, access.organizationId) as {
      id: string;
      name: string;
      status: "active";
      updated_at: string;
      canonical_specification_design_id: string | null;
      default_design_system_release_id: string | null;
      default_locale: string;
      default_direction: "ltr" | "rtl" | "auto";
      locales_json: string;
    } | undefined;
    if (!product) throw new DomainError("PRODUCT_CONTEXT_REQUIRED", "The design has no active Product context.", 409);
    let locales: string[];
    try {
      const parsed = JSON.parse(product.locales_json) as unknown;
      if (!Array.isArray(parsed)) throw new Error("not an array");
      locales = parsed.map((locale) => ProductLocaleSchema.parse(locale));
    } catch (error) {
      throw new DomainError("INTERNAL_ERROR", "The Product locale configuration is invalid.", 500, { cause: error });
    }
    const locale = requestedLocale ?? ProductLocaleSchema.parse(product.default_locale);
    if (!locales.includes(locale)) {
      throw new DomainError("VALIDATION_FAILED", "The requested task locale is not enabled for this Product.", 422, {
        details: { locale, productId: product.id, supportedLocales: locales },
      });
    }
    const specification = product.canonical_specification_design_id === null
      ? undefined
      : this.database.sqlite.prepare(
        `SELECT design_id, version, specification_hash
         FROM product_specifications WHERE design_id = ? ORDER BY version DESC LIMIT 1`,
      ).get(product.canonical_specification_design_id) as {
        design_id: string;
        version: number;
        specification_hash: string;
      } | undefined;
    const projectPin = this.database.sqlite.prepare(
      `SELECT design_system_id, release_id, release_version
       FROM project_design_system_pins WHERE design_id = ? AND organization_id = ?`,
    ).get(design.id, access.organizationId) as {
      design_system_id: string;
      release_id: string;
      release_version: number;
    } | undefined;
    let designSystem: AgentTaskResolvedContext["designSystem"];
    if (projectPin) {
      designSystem = {
        source: "project_pin",
        designSystemId: projectPin.design_system_id,
        releaseId: projectPin.release_id,
        releaseVersion: projectPin.release_version,
      };
    } else if (product.default_design_system_release_id
      && product.default_design_system_release_id !== FORMASPEC_FOUNDATION_RELEASE_ID) {
      const productRelease = this.database.sqlite.prepare(
        `SELECT release.design_system_id, release.id, release.version
         FROM design_system_releases release
         JOIN design_systems system ON system.id = release.design_system_id
         WHERE release.id = ? AND release.status = 'published'
           AND system.organization_id = ? AND system.status = 'active'`,
      ).get(product.default_design_system_release_id, access.organizationId) as {
        design_system_id: string;
        id: string;
        version: number;
      } | undefined;
      if (!productRelease) {
        throw new DomainError("INTERNAL_ERROR", "The Product default design-system release is unavailable.", 500);
      }
      designSystem = {
        source: "product_default",
        designSystemId: productRelease.design_system_id,
        releaseId: productRelease.id,
        releaseVersion: productRelease.version,
      };
    } else {
      designSystem = {
        source: "formaspec_foundation",
        designSystemId: FORMASPEC_FOUNDATION_SYSTEM_ID,
        releaseId: FORMASPEC_FOUNDATION_RELEASE_ID,
        releaseVersion: FORMASPEC_FOUNDATION_VERSION,
      };
    }
    const inventories = this.database.sqlite.prepare(
      `SELECT DISTINCT inventory.id, inventory.inventory_hash
       FROM implementation_mappings mapping
       JOIN designs mapped_design ON mapped_design.id = mapping.design_id
       JOIN repository_inventories inventory ON inventory.id = mapping.inventory_id
       WHERE mapped_design.product_id = ? AND mapped_design.organization_id = ?
         AND inventory.status = 'active'
       ORDER BY inventory.created_at DESC, inventory.id DESC LIMIT 100`,
    ).all(product.id, access.organizationId) as Array<{ id: string; inventory_hash: string }>;
    return AgentTaskResolvedContextSchema.parse({
      schemaVersion: 1,
      product: {
        id: product.id,
        name: product.name,
        status: product.status,
        updatedAt: product.updated_at,
      },
      design: {
        id: design.id,
        version: design.current_version,
        revisionId: design.current_revision_id,
      },
      productSpecification: specification === undefined ? null : {
        designId: specification.design_id,
        version: specification.version,
        specificationHash: specification.specification_hash,
      },
      designSystem,
      repositoryInventories: inventories.map((inventory) => ({
        id: inventory.id,
        inventoryHash: inventory.inventory_hash,
      })),
      locale,
      direction: product.default_direction,
      platform,
      capturedAt,
    });
  }

  private taskTransitions(taskId: string): AgentTaskTransition[] {
    const rows = this.database.sqlite.prepare(
      "SELECT * FROM agent_task_transitions WHERE task_id = ? ORDER BY rowid",
    ).all(taskId) as AgentTaskTransitionRow[];
    return rows.map((row) => ({
      id: row.id,
      fromStatus: row.from_status,
      toStatus: row.to_status,
      actorId: row.actor_id,
      message: row.message,
      data: jsonObject(row.data_json, "task transition"),
      createdAt: row.created_at,
    }));
  }

  private currentTaskTransition(taskId: string): AgentTaskTransitionRow {
    const row = this.database.sqlite.prepare(
      "SELECT * FROM agent_task_transitions WHERE task_id = ? ORDER BY rowid DESC LIMIT 1",
    ).get(taskId) as AgentTaskTransitionRow | undefined;
    if (!row) throw new DomainError("INTERNAL_ERROR", "The agent task has no transition state.", 500);
    return row;
  }

  private claimedBy(taskId: string): string | null {
    const row = this.database.sqlite.prepare(
      "SELECT actor_id FROM agent_task_transitions WHERE task_id = ? AND to_status = 'claimed' ORDER BY rowid LIMIT 1",
    ).get(taskId) as { actor_id: string } | undefined;
    return row?.actor_id ?? null;
  }

  private requireAgentTaskRow(access: AccessContext, taskId: string): AgentTaskRow {
    const row = this.database.sqlite.prepare("SELECT * FROM agent_tasks WHERE id = ?").get(taskId) as AgentTaskRow | undefined;
    if (!row) throw new DomainError("NOT_FOUND", "Agent task not found.", 404);
    requireActiveDesign(this.database.sqlite, access, row.design_id);
    return row;
  }

  private appendTaskTransition(
    access: AccessContext,
    taskId: string,
    fromStatus: AgentTaskStatus | null,
    toStatus: AgentTaskStatus,
    message: string | null,
    data: Record<string, unknown>,
    now: string,
  ): void {
    this.database.sqlite.prepare(
      `INSERT INTO agent_task_transitions
       (id, task_id, from_status, to_status, actor_id, message, data_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(workflowId("transition"), taskId, fromStatus, toStatus, access.principalId, message, JSON.stringify(data), now);
    const task = this.database.sqlite.prepare("SELECT design_id FROM agent_tasks WHERE id = ?").get(taskId) as { design_id: string };
    this.enqueueEvent(access, "agent_task.transitioned", {
      taskId,
      designId: task.design_id,
      fromStatus,
      toStatus,
    }, now);
  }

  private validateDesignReadiness(
    task: AgentTaskRow,
    input: unknown,
  ): DesignReadinessReport {
    if (task.resolved_context_json === null) {
      throw new DomainError(
        "PRODUCT_CONTEXT_REQUIRED",
        "The design-preview task has no immutable Product readiness context; create a new task.",
        409,
      );
    }
    let context: AgentTaskResolvedContext;
    try {
      context = AgentTaskResolvedContextSchema.parse(JSON.parse(task.resolved_context_json) as unknown);
    } catch (error) {
      throw new DomainError("INTERNAL_ERROR", "The persisted agent task Product context is invalid.", 500, { cause: error });
    }
    if (task.product_id === null
      || context.product.id !== task.product_id
      || context.design.id !== task.design_id
      || context.design.version !== task.base_version) {
      throw new DomainError("INTERNAL_ERROR", "The persisted agent task context does not match its immutable task input.", 500);
    }
    const report = parseInput(DesignReadinessReportSchema, input, "Design readiness report");
    const issues: Array<{ path: string; message: string }> = [];
    const mismatch = (path: string, message: string): void => {
      issues.push({ path, message });
    };
    if (report.selected.productId !== context.product.id) {
      mismatch("selected.productId", "Product does not match the immutable task context.");
    }
    if (report.selected.designId !== context.design.id) {
      mismatch("selected.designId", "Design does not match the immutable task context.");
    }
    if (report.selected.baseVersion !== context.design.version) {
      mismatch("selected.baseVersion", "Base version does not match the immutable task context.");
    }
    if (context.productSpecification === null) {
      if (report.productSpecification !== null) {
        mismatch("productSpecification", "The task captured no canonical Product specification.");
      }
    } else if (report.productSpecification === null
      || report.productSpecification.version !== context.productSpecification.version
      || report.productSpecification.specificationHash !== context.productSpecification.specificationHash) {
      mismatch("productSpecification", "Product-specification version or hash does not match the immutable task context.");
    }
    if (report.designSystem.source !== context.designSystem.source) {
      mismatch("designSystem.source", "Design-system source does not match the immutable task context.");
    }
    if (report.designSystem.releaseId !== context.designSystem.releaseId) {
      mismatch("designSystem.releaseId", "Design-system release does not match the immutable task context.");
    }
    if (report.designSystem.releaseVersion !== context.designSystem.releaseVersion) {
      mismatch("designSystem.releaseVersion", "Design-system release version does not match the immutable task context.");
    }
    if (!report.platforms.includes(context.platform)) {
      mismatch("platforms", `Readiness must include the task platform ${context.platform}.`);
    }
    const expectedInventories = new Map(context.repositoryInventories.map((inventory) => [
      inventory.id,
      inventory.inventoryHash,
    ]));
    const reportedInventories = new Map(report.repositoryMappingsConsidered.map((inventory) => [
      inventory.inventoryId,
      inventory.inventoryHash,
    ]));
    if (expectedInventories.size !== reportedInventories.size
      || [...expectedInventories].some(([inventoryId, inventoryHash]) => (
        reportedInventories.get(inventoryId) !== inventoryHash
      ))) {
      mismatch(
        "repositoryMappingsConsidered",
        "Repository inventory IDs and hashes must exactly match the immutable task context.",
      );
    }
    const releaseComponents = this.resolvedReadinessComponentVersions(context);
    for (const [classification, components] of [
      ["reused", report.components.reused],
      ["extended", report.components.extended],
    ] as const) {
      for (const [index, component] of components.entries()) {
        if (!releaseComponents.has(`${component.componentDefinitionId}\u0000${component.version}`)) {
          mismatch(
            `components.${classification}.${index}`,
            "Component/version is not present in the immutable effective design-system release.",
          );
        }
      }
    }
    if (issues.length > 0) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "Design readiness does not match the immutable task context.",
        422,
        { details: { issues } },
      );
    }
    return report;
  }

  private resolvedReadinessComponentVersions(context: AgentTaskResolvedContext): Set<string> {
    if (context.designSystem.source === "formaspec_foundation") {
      if (context.designSystem.designSystemId !== FORMASPEC_FOUNDATION_SYSTEM.id
        || context.designSystem.releaseId !== FORMASPEC_FOUNDATION_SYSTEM.release.id
        || context.designSystem.releaseVersion !== FORMASPEC_FOUNDATION_SYSTEM.release.version) {
        throw new DomainError("INTERNAL_ERROR", "The frozen FormaSpec Foundation release context is inconsistent.", 500);
      }
      return new Set(FORMASPEC_FOUNDATION_SYSTEM.release.component_versions.map((component) => (
        `${component.component_definition_id}\u0000${component.version}`
      )));
    }
    const row = this.database.sqlite.prepare(
      `SELECT release_json FROM design_system_releases
       WHERE id = ? AND design_system_id = ? AND version = ?`,
    ).get(
      context.designSystem.releaseId,
      context.designSystem.designSystemId,
      context.designSystem.releaseVersion,
    ) as { release_json: string } | undefined;
    if (!row) {
      throw new DomainError("INTERNAL_ERROR", "The frozen design-system release is unavailable.", 500);
    }
    let envelope: z.infer<typeof persistedReleaseReadinessSchema>;
    try {
      envelope = persistedReleaseReadinessSchema.parse(JSON.parse(row.release_json) as unknown);
    } catch (error) {
      throw new DomainError("INTERNAL_ERROR", "The frozen design-system release is invalid.", 500, { cause: error });
    }
    if (envelope.release.id !== context.designSystem.releaseId
      || envelope.release.design_system_id !== context.designSystem.designSystemId
      || envelope.release.version !== context.designSystem.releaseVersion) {
      throw new DomainError("INTERNAL_ERROR", "The frozen design-system release identity is inconsistent.", 500);
    }
    return new Set(envelope.component_versions.map((component) => (
      `${component.component_definition_id}\u0000${component.version}`
    )));
  }

  private validateTaskCompletion(
    task: AgentTaskRow,
    data: Record<string, unknown>,
  ): z.infer<typeof AgentTaskTransitionDataSchema> {
    const schema = AgentTaskCompletionSchemas[task.expected_output];
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      throw new DomainError("VALIDATION_FAILED", `Completion data does not match expected output ${task.expected_output}.`, 422, {
        details: { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) },
      });
    }
    switch (task.expected_output) {
      case "design_preview": {
        const { previewId, readiness: rawReadiness } = parsed.data as {
          previewId: string;
          readiness: DesignReadinessReport;
        };
        const readiness = this.validateDesignReadiness(task, rawReadiness);
        const row = this.database.sqlite.prepare(
          `SELECT id, actor_id, expires_at, render_metadata_json FROM previews
           WHERE id = ? AND design_id = ? AND root_base_version = ? AND status IN ('ready', 'committed')`,
        ).get(previewId, task.design_id, task.base_version) as {
          id: string;
          actor_id: string;
          expires_at: string;
          render_metadata_json: string | null;
        } | undefined;
        if (!row
          || previewTaskId(this.database.sqlite, previewId) !== task.id
          || !this.taskArtifactBelongsToClaimedAgent(task.id, row.actor_id)) {
          throw new DomainError("VALIDATION_FAILED", "The completed design preview does not match the task base or claimed agent.", 422);
        }
        if (row.expires_at <= this.nowIso()) {
          throw new DomainError("PREVIEW_EXPIRED", "The exact task preview expired before approval.", 410, { retryable: true });
        }
        if (row.render_metadata_json === null) {
          throw new DomainError("PREVIEW_ENGINE_MISMATCH", "The exact task preview has no persisted render evidence.", 409, {
            retryable: true,
          });
        }
        this.#designerService?.requireStoredExactPreviewRender(
          row.actor_id,
          task.design_id,
          previewId,
          { taskId: task.id },
        );
        return AgentTaskTransitionDataSchema.parse({ previewId, readiness });
      }
      case "design_commit": {
        const { revisionId } = parsed.data as { revisionId: string };
        const row = this.database.sqlite.prepare(
          "SELECT id, actor_id FROM revisions WHERE id = ? AND design_id = ? AND version = ?",
        ).get(revisionId, task.design_id, task.base_version + 1) as { id: string; actor_id: string } | undefined;
        if (!row || !this.taskArtifactBelongsToClaimedAgent(task.id, row.actor_id)) {
          throw new DomainError("VALIDATION_FAILED", "The completed design revision does not match the task base or claimed agent.", 422);
        }
        return AgentTaskTransitionDataSchema.parse(parsed.data);
      }
      case "product_spec_preview": {
        const { previewId } = parsed.data as { previewId: string };
        const row = this.database.sqlite.prepare(
          `SELECT id, actor_id FROM product_spec_previews
           WHERE id = ? AND design_id = ? AND status IN ('ready', 'committed')`,
        ).get(previewId, task.design_id) as { id: string; actor_id: string } | undefined;
        if (!row || !this.taskArtifactBelongsToClaimedAgent(task.id, row.actor_id)) {
          throw new DomainError("VALIDATION_FAILED", "The completed product specification preview does not match the task or claimed agent.", 422);
        }
        return AgentTaskTransitionDataSchema.parse(parsed.data);
      }
      case "product_spec_commit": {
        const { version } = parsed.data as { version: number };
        const row = this.database.sqlite.prepare(
          "SELECT design_id, actor_id FROM product_specifications WHERE design_id = ? AND version = ?",
        ).get(task.design_id, version) as { design_id: string; actor_id: string } | undefined;
        if (!row || !this.taskArtifactBelongsToClaimedAgent(task.id, row.actor_id)) {
          throw new DomainError("VALIDATION_FAILED", "The completed product specification version does not match the claimed agent.", 422);
        }
        return AgentTaskTransitionDataSchema.parse(parsed.data);
      }
    }
  }

  private taskArtifactBelongsToClaimedAgent(taskId: string, artifactActorId: string): boolean {
    const claimedBy = this.claimedBy(taskId);
    if (!claimedBy) return false;
    if (artifactActorId === claimedBy) return true;
    const directPrincipal = this.database.sqlite.prepare(
      "SELECT id FROM principals WHERE external_id = ?",
    ).get(artifactActorId) as { id: string } | undefined;
    if (directPrincipal?.id === claimedBy) return true;
    if (!artifactActorId.startsWith("grant_")) return false;
    const grant = this.database.sqlite.prepare(
      "SELECT principal_id FROM agent_grants WHERE id = ?",
    ).get(artifactActorId.slice("grant_".length)) as { principal_id: string } | undefined;
    return grant?.principal_id === claimedBy;
  }

  private expireDiscardedTaskPreview(
    task: AgentTaskRow,
    current: AgentTaskTransitionRow,
    data: Record<string, unknown>,
    now: string,
  ): string | null {
    if (data.discarded !== true) return null;
    if (task.expected_output !== "design_preview" || current.to_status !== "awaiting_approval") {
      throw new DomainError("VALIDATION_FAILED", "Only an awaiting design-preview task can discard a preview.", 422);
    }
    const currentData = jsonObject(current.data_json, "task transition");
    const previewId = typeof data.previewId === "string" ? data.previewId : null;
    if (!previewId || currentData.previewId !== previewId) {
      throw new DomainError("VALIDATION_FAILED", "The discarded preview does not match the task proposal.", 422);
    }
    const preview = this.database.sqlite.prepare(
      `SELECT id, actor_id FROM previews
       WHERE id = ? AND design_id = ? AND root_base_version = ? AND status = 'ready'`,
    ).get(previewId, task.design_id, task.base_version) as { id: string; actor_id: string } | undefined;
    if (!preview
      || previewTaskId(this.database.sqlite, previewId) !== task.id
      || !this.taskArtifactBelongsToClaimedAgent(task.id, preview.actor_id)) {
      throw new DomainError("VALIDATION_FAILED", "The discarded preview does not match the task base or claimed agent.", 422);
    }
    const updated = this.database.sqlite.prepare(
      "UPDATE previews SET status = 'expired', expires_at = ? WHERE id = ? AND status = 'ready'",
    ).run(now, preview.id);
    if (updated.changes !== 1) {
      throw new DomainError("VERSION_CONFLICT", "The proposed preview changed before it could be discarded.", 409);
    }
    return preview.id;
  }

  private expireAwaitingTaskPreviewApproval(
    access: AccessContext,
    task: AgentTaskRow,
    previewId: string,
    now: string,
  ): "task_expired" | "preview_regeneration" | null {
    const transaction = this.database.sqlite.transaction(() => {
      const current = this.currentTaskTransition(task.id);
      const currentData = jsonObject(current.data_json, "task transition");
      if (current.to_status === "expired") {
        return currentData.previewId === previewId ? "task_expired" as const : null;
      }
      if (current.to_status === "in_progress" && currentData.previousPreviewId === previewId) {
        return "preview_regeneration" as const;
      }
      if (current.to_status !== "awaiting_approval") return null;
      if (currentData.previewId !== previewId) {
        throw new DomainError("VALIDATION_FAILED", "The preview does not match the expired task proposal.", 422);
      }
      const preview = this.database.sqlite.prepare(
        `SELECT status, expires_at FROM previews
         WHERE id = ? AND design_id = ? AND root_base_version = ?`,
      ).get(previewId, task.design_id, task.base_version) as {
        status: string;
        expires_at: string;
      } | undefined;
      const taskExpired = task.expires_at <= now;
      const previewExpired = !preview
        || previewTaskId(this.database.sqlite, previewId) !== task.id
        || preview.status !== "ready"
        || preview.expires_at <= now;
      if (!taskExpired && !previewExpired) return null;
      if (taskExpired) {
        this.materializeTaskTerminalState(
          access,
          task,
          current,
          "expired",
          "Task expired before its exact preview was approved.",
          now,
          { previewId, reason: "task_expired" },
        );
        return "task_expired" as const;
      }
      this.returnTaskToInProgressForPreviewRegeneration(
        access,
        task,
        current,
        now,
        { previewId, reason: "preview_expired" },
      );
      return "preview_regeneration" as const;
    });
    const disposition = transaction.immediate();
    if (disposition !== null) this.flushPendingEventsSafely();
    return disposition;
  }

  private assertTaskSelection(designId: string, version: number, selection: string[]): void {
    if (selection.length === 0) return;
    const row = this.database.sqlite.prepare(
      "SELECT document_json, snapshot_hash FROM revisions WHERE design_id = ? AND version = ?",
    ).get(designId, version) as { document_json: string; snapshot_hash: string | null } | undefined;
    if (!row) throw new DomainError("NOT_FOUND", `Design version ${version} was not found.`, 404);
    const json = row.snapshot_hash ? this.database.readSnapshot(row.snapshot_hash) : row.document_json;
    let document: ReturnType<typeof toV1CompatibleDesignDocument>;
    try {
      document = toV1CompatibleDesignDocument(AnyDesignDocumentSchema.parse(JSON.parse(json) as unknown));
    } catch (error) {
      throw new DomainError("INTERNAL_ERROR", "The task base revision is invalid.", 500, { cause: error });
    }
    const missing = selection.filter((nodeId) => !document.nodes[nodeId] || document.nodes[nodeId]?.archived);
    if (missing.length > 0) {
      throw new DomainError("VALIDATION_FAILED", "Task selection contains missing or archived nodes.", 422, {
        details: { nodeIds: missing },
      });
    }
  }

  private requireAgentConnectionRow(access: AccessContext, connectionId: string): AgentConnectionRow {
    const row = this.database.sqlite.prepare("SELECT * FROM agent_connections WHERE id = ?").get(connectionId) as AgentConnectionRow | undefined;
    if (!row || row.organization_id !== access.organizationId) throw new DomainError("NOT_FOUND", "Agent connection not found.", 404);
    return row;
  }

  private agentConnectionResult(row: AgentConnectionRow): AgentConnectionResult {
    return {
      id: row.id,
      adapter: row.adapter,
      displayName: row.display_name,
      status: row.status,
      scopes: jsonStringArray(row.scopes_json, "connection scopes"),
      projectIds: jsonStringArray(row.project_ids_json, "connection projects"),
      principalId: row.principal_id,
      expiresAt: row.expires_at,
      lastUsedAt: row.last_used_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private createPendingAgentConnectionRow(
    access: AccessContext,
    input: {
      adapter: "codex" | "generic_mcp";
      displayName: string;
      scopes: string[];
      projectIds: string[];
      connectionExpiresAt: string;
      replacedConnectionIds: string[];
      auditAction: "agent_connection.create" | "agent_connection.reconnect";
      auditDetails: Record<string, unknown>;
    },
    nowDate: Date,
  ): PairingChallenge {
    const now = nowDate.toISOString();
    const connectionId = workflowId("connection");
    const nonce = `fspair_${randomBytes(32).toString("base64url")}`;
    const nonceExpiresAt = new Date(nowDate.getTime() + this.pairingTtlSeconds * 1_000).toISOString();
    this.database.sqlite.prepare(
      `INSERT INTO agent_connections
       (id, organization_id, principal_id, adapter, display_name, status, scopes_json, project_ids_json,
        expires_at, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
    ).run(
      connectionId,
      access.organizationId,
      input.adapter,
      input.displayName,
      JSON.stringify(input.scopes),
      JSON.stringify(input.projectIds),
      input.connectionExpiresAt,
      now,
      now,
    );
    this.database.sqlite.prepare(
      `INSERT INTO pairing_nonces
       (nonce_hash, connection_id, created_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(sha256(nonce), connectionId, access.principalId, now, nonceExpiresAt);
    persistAgentConnectionReplacement(this.database.sqlite, {
      pending_connection_id: connectionId,
      organization_id: access.organizationId,
      replaced_connection_ids: input.replacedConnectionIds,
      created_by: access.principalId,
      created_at: now,
    });
    appendAuditEvent(this.database.sqlite, access, input.auditAction, "agent_connection", connectionId, {
      adapter: input.adapter,
      scopes: input.scopes,
      projectIds: input.projectIds,
      expiresAt: input.connectionExpiresAt,
      ...input.auditDetails,
    });
    this.enqueueEvent(access, "agent_connection.changed", {
      connectionId,
      adapter: input.adapter,
      status: "pending",
    }, now);
    return {
      connection: this.agentConnectionResult(this.requireAgentConnectionRow(access, connectionId)),
      nonce,
      expiresAt: nonceExpiresAt,
    };
  }

  private assertAgentConnectionCapacity(
    policy: OrganizationPolicy,
    organizationId: string,
    now: string,
    additionalReplacedConnectionIds: string[],
    addingConnection: boolean,
  ): void {
    const liveRows = this.database.sqlite.prepare(
      `SELECT id, status FROM agent_connections
       WHERE organization_id = ? AND status IN ('pending', 'active')
         AND (expires_at IS NULL OR expires_at > ?)`,
    ).all(organizationId, now) as Array<{ id: string; status: "pending" | "active" }>;
    const replacedConnectionIds = new Set(additionalReplacedConnectionIds);
    for (const row of liveRows) {
      if (row.status !== "pending") continue;
      const intent = readAgentConnectionReplacement(this.database.sqlite, row.id, organizationId);
      for (const replacedConnectionId of intent?.replaced_connection_ids ?? []) {
        replacedConnectionIds.add(replacedConnectionId);
      }
    }
    const logicalConnectionCount = liveRows.reduce(
      (count, row) => count + (replacedConnectionIds.has(row.id) ? 0 : 1),
      0,
    );
    const requestedLogicalConnectionCount = logicalConnectionCount + (addingConnection ? 1 : 0);
    if (requestedLogicalConnectionCount > policy.agents.maximumActiveConnections) {
      throw new DomainError("FORBIDDEN", "The organization agent-connection limit has been reached.", 403, {
        details: {
          maximumActiveConnections: policy.agents.maximumActiveConnections,
          logicalConnectionCount,
        },
      });
    }
  }

  private requireAgentConnectionReplacementRows(
    pendingRow: AgentConnectionRow,
    intent: AgentConnectionReplacementIntent,
  ): AgentConnectionRow[] {
    const placeholders = intent.replaced_connection_ids.map(() => "?").join(", ");
    const rows = this.database.sqlite.prepare(
      `SELECT * FROM agent_connections
       WHERE organization_id = ? AND id IN (${placeholders})`,
    ).all(pendingRow.organization_id, ...intent.replaced_connection_ids) as AgentConnectionRow[];
    if (rows.length !== intent.replaced_connection_ids.length) {
      throw new DomainError("INTERNAL_ERROR", "Persisted agent connection replacement predecessors are invalid.", 500);
    }
    const rowsById = new Map(rows.map((row) => [row.id, row]));
    return intent.replaced_connection_ids.map((connectionId) => rowsById.get(connectionId) as AgentConnectionRow);
  }

  private revokeAgentConnectionRow(
    access: AccessContext,
    row: AgentConnectionRow,
    now: string,
    details: Record<string, unknown> = {},
  ): AgentConnectionResult {
    const alreadyRevoked = row.status === "revoked";
    if (!alreadyRevoked) {
      this.database.sqlite.prepare(
        "UPDATE agent_connections SET status = 'revoked', updated_at = ? WHERE id = ?",
      ).run(now, row.id);
    }
    if (row.principal_id) {
      this.database.sqlite.prepare(
        `UPDATE agent_grants SET revoked_at = ?
         WHERE organization_id = ? AND principal_id = ? AND revoked_at IS NULL`,
      ).run(now, row.organization_id, row.principal_id);
    }
    this.database.sqlite.prepare(
      "UPDATE pairing_nonces SET revoked_at = ? WHERE connection_id = ? AND revoked_at IS NULL",
    ).run(now, row.id);
    clearAgentConnectionReplacement(this.database.sqlite, row.id);
    if (!alreadyRevoked) {
      appendAuditEvent(this.database.sqlite, access, "agent_connection.revoke", "agent_connection", row.id, details);
      this.enqueueEvent(access, "agent_connection.changed", {
        connectionId: row.id,
        status: "revoked",
        ...details,
      }, now);
    }
    return this.agentConnectionResult(this.requireAgentConnectionRow(access, row.id));
  }

  private requireDesign(actorId: string, designId: string, agentScope: string): { access: AccessContext; design: DesignAccessRow } {
    const access = resolveAccess(this.database.sqlite, actorId);
    if (access.role === "agent") assertScope(access, agentScope);
    return { access, design: this.requireDesignForAccess(access, designId) };
  }

  private requirePlanningWriteDesign(actorId: string, designId: string): {
    access: AccessContext;
    design: DesignAccessRow;
  } {
    const access = resolveAccess(this.database.sqlite, actorId);
    this.assertPlanningWrite(access);
    return { access, design: this.requireDesignForAccess(access, designId) };
  }

  private requireTaskCreateDesign(actorId: string, designId: string): {
    access: AccessContext;
    design: DesignAccessRow;
  } {
    const access = resolveAccess(this.database.sqlite, actorId);
    this.assertTaskCreate(access);
    return { access, design: this.requireDesignForAccess(access, designId) };
  }

  private requireDesignForAccess(access: AccessContext, designId: string): DesignAccessRow {
    return requireActiveDesign(this.database.sqlite, access, designId);
  }

  private assertAgentConnectionProjectsActive(organizationId: string, projectIds: readonly string[]): void {
    const lookup = this.database.sqlite.prepare(
      `SELECT id FROM designs
       WHERE id = ? AND organization_id = ? AND ${activeDesignSqlPredicate("designs")}`,
    );
    for (const projectId of projectIds) {
      if (!lookup.get(projectId, organizationId)) {
        throw new DomainError("NOT_FOUND", "Design not found.", 404);
      }
    }
  }

  private assertProductSpecificationWrite(access: AccessContext, scope: "product_spec:preview" | "product_spec:write"): void {
    if (access.role === "agent") {
      assertScope(access, scope);
      return;
    }
    this.assertRole(access, ["organization_admin", "product_manager"], "The current role cannot modify product specifications.");
  }

  private assertPlanningWrite(access: AccessContext): void {
    if (access.role === "agent") {
      assertScope(access, "planning:write");
      return;
    }
    this.assertRole(access, ["organization_admin", "product_manager"], "The current role cannot modify planning sessions.");
  }

  private assertTaskCreate(access: AccessContext): void {
    if (access.role === "agent") {
      assertScope(access, "task:create");
      return;
    }
    this.assertRole(access, ["organization_admin", "product_manager", "design_editor"], "The current role cannot create agent tasks.");
  }

  private assertAgentConnectionPolicy(policy: OrganizationPolicy, input: {
    adapter: "codex" | "generic_mcp";
    scopes: string[];
    projectIds: string[];
    expiresInSeconds: number;
  }): void {
    if (!policy.agents.enabled) {
      throw new DomainError("FORBIDDEN", "Agent connections are disabled by organization policy.", 403);
    }
    if (!policy.agents.allowedAdapters.includes(input.adapter)) {
      throw new DomainError("FORBIDDEN", `The ${input.adapter} adapter is not allowed by organization policy.`, 403);
    }
    const disallowedScopes = input.scopes.filter((scope) => !policy.agents.allowedScopes.includes(
      scope as (typeof policy.agents.allowedScopes)[number],
    ));
    if (disallowedScopes.length > 0) {
      throw new DomainError("FORBIDDEN", "The requested agent scopes are not allowed by organization policy.", 403, {
        details: { disallowedScopes },
      });
    }
    if (input.expiresInSeconds > policy.agents.maximumExpirySeconds) {
      throw new DomainError("FORBIDDEN", "The requested agent expiry exceeds organization policy.", 403, {
        details: { maximumExpirySeconds: policy.agents.maximumExpirySeconds },
      });
    }
    if (policy.agents.requireProjectRestriction && input.projectIds.length === 0) {
      throw new DomainError("FORBIDDEN", "Organization policy requires agent connections to be restricted to explicit projects.", 403);
    }
  }

  private assertOrganizationAdmin(access: AccessContext): void {
    this.assertRole(access, ["organization_admin"], "Organization Administrator permission is required.");
  }

  private canApproveAgentTask(access: AccessContext): boolean {
    return access.role === "organization_admin" || access.role === "product_manager";
  }

  private assertTaskApproval(access: AccessContext): void {
    if (!this.canApproveAgentTask(access)) {
      throw new DomainError("FORBIDDEN", "Organization Administrator or Product Manager permission is required to approve an agent task.", 403);
    }
  }

  private assertRole(access: AccessContext, roles: OrganizationRole[], message: string): void {
    if (!roles.includes(access.role)) throw new DomainError("FORBIDDEN", message, 403);
  }

  private withIdempotency<T>(
    access: AccessContext,
    scope: string,
    key: string,
    request: unknown,
    execute: () => T,
  ): T {
    const transaction = this.database.sqlite.transaction(() => {
      const now = this.nowIso();
      this.database.sqlite.prepare("DELETE FROM idempotency WHERE expires_at <= ?").run(now);
      const requestHash = hashPayload(request);
      const existing = this.database.sqlite.prepare(
        `SELECT request_hash, response_json FROM idempotency
         WHERE actor_id = ? AND scope = ? AND key = ? AND expires_at > ?`,
      ).get(access.principalId, scope, key, now) as IdempotencyRow | undefined;
      if (existing) {
        if (existing.request_hash !== requestHash) {
          throw new DomainError("IDEMPOTENCY_CONFLICT", "The idempotency key was already used with different input.", 409);
        }
        return JSON.parse(existing.response_json) as T;
      }
      const result = execute();
      const expiresAt = new Date(this.#now().getTime() + IDEMPOTENCY_TTL_MS).toISOString();
      this.database.sqlite.prepare(
        `INSERT INTO idempotency
         (actor_id, scope, key, request_hash, response_json, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(access.principalId, scope, key, requestHash, JSON.stringify(result), now, expiresAt);
      return result;
    });
    const result = transaction.immediate();
    this.flushPendingEventsSafely();
    return result;
  }

  private enqueueEvent(access: AccessContext, type: DesignerEventType, data: Record<string, unknown>, now: string): number {
    const inserted = this.database.sqlite.prepare(
      `INSERT INTO event_outbox
       (organization_id, actor_id, event_type, payload_json, workspace, created_at)
       VALUES (?, ?, ?, ?, 1, ?)`,
    ).run(access.organizationId, access.actorId, type, JSON.stringify(data), now);
    return Number(inserted.lastInsertRowid);
  }

  private flushPendingEvents(): void {
    if (!this.events) return;
    while (true) {
      const rows = this.database.sqlite.prepare(
        `SELECT id, organization_id, actor_id, event_type, payload_json, workspace, created_at
         FROM event_outbox WHERE published_at IS NULL ORDER BY id LIMIT 100`,
      ).all() as Array<{
        id: number;
        organization_id: string;
        actor_id: string;
        event_type: DesignerEventType;
        payload_json: string;
        workspace: number;
        created_at: string;
      }>;
      if (rows.length === 0) return;
      for (const row of rows) {
        this.events.publishPersisted({
          id: row.id,
          type: row.event_type,
          actorId: row.actor_id,
          organizationId: row.organization_id,
          timestamp: row.created_at,
          data: jsonObject(row.payload_json, "event outbox"),
        }, row.workspace === 1);
        this.database.sqlite.prepare(
          "UPDATE event_outbox SET published_at = ? WHERE id = ? AND published_at IS NULL",
        ).run(this.nowIso(), row.id);
      }
    }
  }

  private flushPendingEventsSafely(): void {
    try {
      this.flushPendingEvents();
    } catch {
      // Persisted outbox delivery can safely resume after reconnect or restart.
    }
  }

  private nowIso(): string {
    return this.#now().toISOString();
  }

  private versionConflict(expected: number, current: number, subject: string): DomainError {
    return new DomainError("VERSION_CONFLICT", `Expected ${subject} version ${expected}, but the current version is ${current}.`, 409, {
      retryable: true,
      details: { expectedVersion: expected, currentVersion: current, subject },
    });
  }

  private taskStateConflict(expected: AgentTaskStatus, current: AgentTaskStatus): DomainError {
    return new DomainError("TASK_STATE_CONFLICT", `Expected task status ${expected}, but the current status is ${current}.`, 409, {
      retryable: true,
      details: { expectedStatus: expected, currentStatus: current },
    });
  }
}
