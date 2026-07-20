import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  AnyDesignDocumentSchema,
  NodeIdSchema,
  PLANNING_SECTIONS,
  PlanningSectionSchema,
  PlanningSessionSchema,
  ProductSpecificationSchema,
  toV1CompatibleDesignDocument,
  type PlanningSession,
  type ProductSpecification,
} from "@designer/core";
import { z } from "zod";

import {
  appendAuditEvent,
  assertProjectAccess,
  assertScope,
  resolveAccess,
  type AccessContext,
  type OrganizationRole,
} from "./authorization.js";
import type { DesignerDatabase } from "./db/database.js";
import { DomainError } from "./errors.js";
import type { DesignerEventType, EventHub } from "./events.js";
import { hashPayload } from "./ids.js";
import {
  loadOrganizationPolicy,
  ORGANIZATION_AGENT_SCOPES,
  type OrganizationPolicy,
} from "./organization-policy-model.js";
import { canonicalProductSpecification } from "./product-spec-persistence.js";

const MAX_TRANSITION_DATA_BYTES = 65_536;
const IDEMPOTENCY_TTL_MS = 86_400_000;

export const AGENT_TASK_EXPECTED_OUTPUTS = [
  "design_preview",
  "design_commit",
  "product_spec_preview",
  "product_spec_commit",
] as const;
export type AgentTaskExpectedOutput = (typeof AGENT_TASK_EXPECTED_OUTPUTS)[number];

export const AGENT_TASK_STATUSES = [
  "queued",
  "claimed",
  "in_progress",
  "awaiting_approval",
  "completed",
  "failed",
  "cancelled",
  "expired",
] as const;
export type AgentTaskStatus = (typeof AGENT_TASK_STATUSES)[number];

export type PlanningSection = (typeof PLANNING_SECTIONS)[number];
export type PlanningStatus = "draft" | "in_progress" | "ready_for_review" | "completed" | "cancelled";
export type AgentConnectionStatus = "pending" | "active" | "expired" | "revoked" | "error";

export const AGENT_CONNECTION_SCOPES = ORGANIZATION_AGENT_SCOPES;

const taskExpectedOutputSchema = z.enum(AGENT_TASK_EXPECTED_OUTPUTS);
const taskSelectionSchema = z.array(NodeIdSchema).max(500);
const taskCompletionSchemas = {
  design_preview: z.object({ previewId: z.string().min(1).max(240) }).strict(),
  design_commit: z.object({ revisionId: z.string().min(1).max(240) }).strict(),
  product_spec_preview: z.object({ previewId: z.string().min(1).max(240) }).strict(),
  product_spec_commit: z.object({ version: z.number().int().positive() }).strict(),
} satisfies Record<AgentTaskExpectedOutput, z.ZodTypeAny>;

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
  design_id: string;
  actor_id: string;
  brief: string;
  selection_json: string;
  base_version: number;
  expected_output: AgentTaskExpectedOutput;
  created_at: string;
  expires_at: string;
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
  transitions: AgentTaskTransition[];
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

function parseInput<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
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
      this.expireProductSpecificationPreviews(this.nowIso());
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
    this.expireProductSpecificationPreviews(this.nowIso());
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
    this.expireProductSpecificationPreviews(this.nowIso());
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

  createPlanningSession(actorId: string, input: {
    designId: string;
    idempotencyKey: string;
  }): PlanningSessionResult {
    const { access, design } = this.requireDesign(actorId, input.designId, "planning:write");
    this.assertPlanningWrite(access);
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

  createAgentTask(actorId: string, input: {
    designId: string;
    brief: string;
    selection?: unknown;
    baseVersion: number;
    expectedOutput: AgentTaskExpectedOutput;
    idempotencyKey: string;
    expiresInSeconds?: number;
  }): AgentTaskResult {
    const { access, design } = this.requireDesign(actorId, input.designId, "task:create");
    this.assertTaskCreate(access);
    const brief = boundedText(input.brief, "Task brief", 100_000);
    const selection = parseInput(taskSelectionSchema, input.selection ?? [], "Task selection");
    const expectedOutput = parseInput(taskExpectedOutputSchema, input.expectedOutput, "Expected task output");
    const expiresInSeconds = input.expiresInSeconds ?? 86_400;
    assertSeconds(expiresInSeconds, "Task expiry", 60, 604_800);
    if (design.current_version !== input.baseVersion) {
      throw this.versionConflict(input.baseVersion, design.current_version, "design");
    }
    this.assertTaskSelection(design.id, input.baseVersion, selection);
    const key = boundedText(input.idempotencyKey, "Idempotency key", 240);
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
      const taskId = workflowId("task");
      const expiresAt = new Date(nowDate.getTime() + expiresInSeconds * 1_000).toISOString();
      this.database.sqlite.prepare(
        `INSERT INTO agent_tasks
         (id, organization_id, design_id, actor_id, brief, selection_json, base_version,
          expected_output, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(taskId, access.organizationId, design.id, access.principalId, brief, JSON.stringify(selection), input.baseVersion, expectedOutput, now, expiresAt);
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
    return this.agentTaskResult(this.requireAgentTaskRow(access, taskId));
  }

  listAgentTasks(actorId: string, input: {
    designId?: string;
    status?: AgentTaskStatus;
    limit?: number;
  } = {}): AgentTaskResult[] {
    const access = resolveAccess(this.database.sqlite, actorId);
    if (access.role === "agent") assertScope(access, "task:read");
    const limit = Math.max(1, Math.min(input.limit ?? 50, 100));
    const rows = input.designId
      ? this.database.sqlite.prepare(
        `SELECT * FROM agent_tasks WHERE organization_id = ? AND design_id = ? ORDER BY created_at DESC LIMIT ?`,
      ).all(access.organizationId, input.designId, limit) as AgentTaskRow[]
      : this.database.sqlite.prepare(
        `SELECT * FROM agent_tasks WHERE organization_id = ? ORDER BY created_at DESC LIMIT ?`,
      ).all(access.organizationId, limit) as AgentTaskRow[];
    return rows
      .filter((row) => access.projectIds.length === 0 || access.projectIds.includes(row.design_id))
      .map((row) => this.agentTaskResult(row))
      .filter((task) => input.status === undefined || task.status === input.status);
  }

  claimAgentTask(actorId: string, taskId: string): AgentTaskResult {
    const access = resolveAccess(this.database.sqlite, actorId);
    if (access.role !== "agent") throw new DomainError("FORBIDDEN", "Only an agent connection can claim an agent task.", 403);
    assertScope(access, "task:claim");
    let expired = false;
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
      if (design.current_version !== row.base_version) throw this.versionConflict(row.base_version, design.current_version, "design");
      this.appendTaskTransition(access, row.id, "queued", "claimed", "Task claimed", {}, now);
      appendAuditEvent(this.database.sqlite, access, "agent_task.claim", "agent_task", row.id, { designId: row.design_id });
      return this.agentTaskResult(row);
    });
    const result = transaction.immediate();
    this.flushPendingEventsSafely();
    if (expired) throw new DomainError("TASK_EXPIRED", "The agent task expired before it could be claimed.", 410);
    return result;
  }

  transitionAgentTask(actorId: string, taskId: string, input: {
    expectedStatus: AgentTaskStatus;
    toStatus: Exclude<AgentTaskStatus, "queued" | "claimed">;
    message?: string;
    data?: Record<string, unknown>;
  }): AgentTaskResult {
    const access = resolveAccess(this.database.sqlite, actorId);
    if (access.role === "agent") assertScope(access, "task:update");
    const message = input.message === undefined ? null : boundedText(input.message, "Transition message", 4_000, true);
    const data = input.data ?? {};
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new DomainError("VALIDATION_FAILED", "Task transition data must be an object.", 422);
    }
    if (Buffer.byteLength(JSON.stringify(data), "utf8") > MAX_TRANSITION_DATA_BYTES) {
      throw new DomainError("PAYLOAD_TOO_LARGE", "Task transition data may not exceed 64 KiB.", 413);
    }
    let expired = false;
    const transaction = this.database.sqlite.transaction(() => {
      const row = this.requireAgentTaskRow(access, taskId);
      const current = this.currentTaskTransition(row.id);
      if (current.to_status !== input.expectedStatus) throw this.taskStateConflict(input.expectedStatus, current.to_status);
      const now = this.nowIso();
      if (!AGENT_TASK_STATUSES.slice(4).includes(current.to_status) && row.expires_at <= now) {
        this.appendTaskTransition(access, row.id, current.to_status, "expired", "Task expired", {}, now);
        appendAuditEvent(this.database.sqlite, access, "agent_task.expire", "agent_task", row.id, { fromStatus: current.to_status });
        expired = true;
        return this.agentTaskResult(row);
      }
      if (!taskTransitionGraph[current.to_status].includes(input.toStatus)) {
        throw new DomainError("VALIDATION_FAILED", `Cannot move an agent task from ${current.to_status} to ${input.toStatus}.`, 422);
      }
      const claimedBy = this.claimedBy(row.id);
      if (access.role === "agent") {
        if (claimedBy !== access.principalId) throw new DomainError("FORBIDDEN", "Only the agent that claimed this task may update it.", 403);
      } else {
        const canCancel = ["organization_admin", "product_manager", "design_editor"].includes(access.role) && input.toStatus === "cancelled";
        const canApprove = ["organization_admin", "product_manager"].includes(access.role)
          && current.to_status === "awaiting_approval" && input.toStatus === "completed";
        if (!canCancel && !canApprove) throw new DomainError("FORBIDDEN", "The current role cannot make this task transition.", 403);
      }
      if (input.toStatus === "in_progress") {
        const design = this.requireDesignForAccess(access, row.design_id);
        if (design.current_version !== row.base_version) throw this.versionConflict(row.base_version, design.current_version, "design");
      }
      if (input.toStatus === "awaiting_approval" || input.toStatus === "completed") {
        this.validateTaskCompletion(row, data);
      }
      const discardedPreviewId = input.toStatus === "cancelled"
        ? this.expireDiscardedTaskPreview(row, current, data, now)
        : null;
      this.appendTaskTransition(access, row.id, current.to_status, input.toStatus, message, data, now);
      appendAuditEvent(this.database.sqlite, access, "agent_task.transition", "agent_task", row.id, {
        fromStatus: current.to_status,
        toStatus: input.toStatus,
        expectedOutput: row.expected_output,
        discardedPreview: discardedPreviewId !== null,
      });
      return this.agentTaskResult(row);
    });
    const result = transaction.immediate();
    this.flushPendingEventsSafely();
    if (expired) throw new DomainError("TASK_EXPIRED", "The agent task expired.", 410);
    return result;
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
      const connectionId = workflowId("connection");
      const replacedConnectionIds: string[] = [];
      if (input.replaceExisting === true) {
        const existingRows = this.database.sqlite.prepare(
          `SELECT * FROM agent_connections
           WHERE organization_id = ? AND adapter = ? AND display_name = ?
             AND status IN ('active', 'pending', 'revoked')
           ORDER BY created_at, id`,
        ).all(access.organizationId, input.adapter, displayName) as AgentConnectionRow[];
        for (const existingRow of existingRows) {
          this.revokeAgentConnectionRow(access, existingRow, now, {
            reason: "replaced",
            replacementConnectionId: connectionId,
          });
          if (existingRow.status === "active" || existingRow.status === "pending") {
            replacedConnectionIds.push(existingRow.id);
          }
        }
      }
      const activeConnections = this.database.sqlite.prepare(
        `SELECT COUNT(*) AS count FROM agent_connections
         WHERE organization_id = ? AND status IN ('pending', 'active')
           AND (expires_at IS NULL OR expires_at > ?)`,
      ).get(access.organizationId, now) as { count: number };
      if (activeConnections.count >= policy.agents.maximumActiveConnections) {
        throw new DomainError("FORBIDDEN", "The organization agent-connection limit has been reached.", 403, {
          details: { maximumActiveConnections: policy.agents.maximumActiveConnections },
        });
      }
      const connectionExpiresAt = new Date(nowDate.getTime() + expiresInSeconds * 1_000).toISOString();
      const nonce = `fspair_${randomBytes(32).toString("base64url")}`;
      const nonceExpiresAt = new Date(nowDate.getTime() + this.pairingTtlSeconds * 1_000).toISOString();
      this.database.sqlite.prepare(
        `INSERT INTO agent_connections
         (id, organization_id, principal_id, adapter, display_name, status, scopes_json, project_ids_json,
          expires_at, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      ).run(connectionId, access.organizationId, input.adapter, displayName, JSON.stringify(scopes), JSON.stringify(projectIds), connectionExpiresAt, now, now);
      this.database.sqlite.prepare(
        `INSERT INTO pairing_nonces
         (nonce_hash, connection_id, created_by, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(sha256(nonce), connectionId, access.principalId, now, nonceExpiresAt);
      appendAuditEvent(this.database.sqlite, access, "agent_connection.create", "agent_connection", connectionId, {
        adapter: input.adapter,
        scopes,
        projectIds,
        expiresAt: connectionExpiresAt,
        replaceExisting: input.replaceExisting === true,
        replacedConnectionIds,
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
      const principalId = row.principal_id ?? workflowId("principal");
      const grantId = randomUUID().replaceAll("-", "");
      const grantToken = `fsg_${randomBytes(32).toString("base64url")}`;
      const scopes = jsonStringArray(row.scopes_json, "connection scopes");
      const projectIds = jsonStringArray(row.project_ids_json, "connection projects");
      const expiresAt = row.expires_at as string;
      const policy = loadOrganizationPolicy(this.database.sqlite, row.organization_id).policy;
      this.assertAgentConnectionPolicy(policy, {
        adapter: row.adapter,
        scopes,
        projectIds,
        expiresInSeconds: Math.max(0, Math.ceil((new Date(expiresAt).getTime() - new Date(now).getTime()) / 1_000)),
      });
      if (!row.principal_id) {
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
      this.database.sqlite.prepare(
        `UPDATE agent_connections SET principal_id = ?, status = 'active', updated_at = ?
         WHERE id = ? AND status = 'pending'`,
      ).run(principalId, now, row.id);
      this.database.sqlite.prepare(
        "UPDATE pairing_nonces SET consumed_at = ? WHERE nonce_hash = ? AND consumed_at IS NULL AND revoked_at IS NULL",
      ).run(now, nonceHash);
      const pairedAccess: AccessContext = {
        actorId: `grant_${grantId}`,
        principalId,
        organizationId: row.organization_id,
        role: "agent",
        scopes,
        projectIds,
        grantId,
      };
      appendAuditEvent(this.database.sqlite, pairedAccess, "agent_connection.pair", "agent_connection", row.id, {
        adapter: row.adapter,
        grantId,
        expiresAt,
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
      const remainingSeconds = row.expires_at
        ? Math.max(0, Math.ceil((new Date(row.expires_at).getTime() - nowDate.getTime()) / 1_000))
        : policy.agents.maximumExpirySeconds;
      this.assertAgentConnectionPolicy(policy, {
        adapter: row.adapter,
        scopes,
        projectIds,
        expiresInSeconds: remainingSeconds,
      });
      const nonce = `fspair_${randomBytes(32).toString("base64url")}`;
      const expiresAt = new Date(nowDate.getTime() + this.pairingTtlSeconds * 1_000).toISOString();
      this.database.sqlite.prepare(
        "UPDATE agent_grants SET revoked_at = ? WHERE principal_id = ? AND revoked_at IS NULL",
      ).run(now, row.principal_id);
      this.database.sqlite.prepare(
        "UPDATE pairing_nonces SET revoked_at = ? WHERE connection_id = ? AND consumed_at IS NULL AND revoked_at IS NULL",
      ).run(now, row.id);
      this.database.sqlite.prepare(
        "UPDATE agent_connections SET status = 'pending', updated_at = ? WHERE id = ?",
      ).run(now, row.id);
      this.database.sqlite.prepare(
        `INSERT INTO pairing_nonces
         (nonce_hash, connection_id, created_by, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(sha256(nonce), row.id, access.principalId, now, expiresAt);
      appendAuditEvent(this.database.sqlite, access, "agent_connection.reconnect", "agent_connection", row.id);
      this.enqueueEvent(access, "agent_connection.changed", { connectionId: row.id, status: "pending" }, now);
      return {
        connection: this.agentConnectionResult(this.requireAgentConnectionRow(access, row.id)),
        nonce,
        expiresAt,
      };
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

  private expireProductSpecificationPreviews(now: string): void {
    this.database.sqlite.prepare(
      `UPDATE product_spec_previews SET status = 'expired'
       WHERE expires_at <= ? AND status IN ('ready', 'blocked')`,
    ).run(now);
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
    assertProjectAccess(access, row.organization_id, row.design_id);
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

  private agentTaskResult(row: AgentTaskRow): AgentTaskResult {
    const transitions = this.taskTransitions(row.id);
    const current = transitions.at(-1);
    if (!current) throw new DomainError("INTERNAL_ERROR", "The agent task has no initial transition.", 500);
    return {
      id: row.id,
      designId: row.design_id,
      brief: row.brief,
      selection: taskSelectionSchema.parse(JSON.parse(row.selection_json) as unknown),
      baseVersion: row.base_version,
      expectedOutput: taskExpectedOutputSchema.parse(row.expected_output),
      status: current.toStatus,
      claimedBy: transitions.find((transition) => transition.toStatus === "claimed")?.actorId ?? null,
      createdBy: row.actor_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      transitions,
    };
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
    assertProjectAccess(access, row.organization_id, row.design_id);
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

  private validateTaskCompletion(task: AgentTaskRow, data: Record<string, unknown>): void {
    const schema = taskCompletionSchemas[task.expected_output];
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      throw new DomainError("VALIDATION_FAILED", `Completion data does not match expected output ${task.expected_output}.`, 422, {
        details: { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) },
      });
    }
    switch (task.expected_output) {
      case "design_preview": {
        const { previewId } = parsed.data as { previewId: string };
        const row = this.database.sqlite.prepare(
          `SELECT id, actor_id FROM previews
           WHERE id = ? AND design_id = ? AND root_base_version = ? AND status IN ('ready', 'committed')`,
        ).get(previewId, task.design_id, task.base_version) as { id: string; actor_id: string } | undefined;
        if (!row || !this.taskArtifactBelongsToClaimedAgent(task.id, row.actor_id)) {
          throw new DomainError("VALIDATION_FAILED", "The completed design preview does not match the task base or claimed agent.", 422);
        }
        return;
      }
      case "design_commit": {
        const { revisionId } = parsed.data as { revisionId: string };
        const row = this.database.sqlite.prepare(
          "SELECT id, actor_id FROM revisions WHERE id = ? AND design_id = ? AND version = ?",
        ).get(revisionId, task.design_id, task.base_version + 1) as { id: string; actor_id: string } | undefined;
        if (!row || !this.taskArtifactBelongsToClaimedAgent(task.id, row.actor_id)) {
          throw new DomainError("VALIDATION_FAILED", "The completed design revision does not match the task base or claimed agent.", 422);
        }
        return;
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
        return;
      }
      case "product_spec_commit": {
        const { version } = parsed.data as { version: number };
        const row = this.database.sqlite.prepare(
          "SELECT design_id, actor_id FROM product_specifications WHERE design_id = ? AND version = ?",
        ).get(task.design_id, version) as { design_id: string; actor_id: string } | undefined;
        if (!row || !this.taskArtifactBelongsToClaimedAgent(task.id, row.actor_id)) {
          throw new DomainError("VALIDATION_FAILED", "The completed product specification version does not match the claimed agent.", 422);
        }
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
    if (!preview || !this.taskArtifactBelongsToClaimedAgent(task.id, preview.actor_id)) {
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

  private requireDesignForAccess(access: AccessContext, designId: string): DesignAccessRow {
    const row = this.database.sqlite.prepare(
      "SELECT id, organization_id, current_version, current_revision_id FROM designs WHERE id = ?",
    ).get(designId) as DesignAccessRow | undefined;
    if (!row) throw new DomainError("NOT_FOUND", "Design not found.", 404);
    assertProjectAccess(access, row.organization_id, row.id);
    return row;
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
