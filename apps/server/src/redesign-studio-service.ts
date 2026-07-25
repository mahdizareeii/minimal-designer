import { randomUUID } from "node:crypto";

import {
  DesignDocumentV2Schema,
  MetadataSchema,
  REDESIGN_STAGES as CORE_REDESIGN_STAGES,
  RedesignStageArtifactMapSchema,
  RedesignStageArtifactSchema,
  createEmptyRedesignStageArtifact,
  evaluateRedesignStageReadiness,
  type DesignDocumentV2,
  type JsonValue,
  type ProductSpecification,
  type RedesignStage as CoreRedesignStage,
  type RedesignStageArtifact,
  type RedesignStageArtifactMap,
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
import { activeDesignSqlPredicate, requireActiveDesign } from "./active-design.js";
import type { DesignerDatabase } from "./db/database.js";
import { BoundedJsonObjectSchema } from "./bounded-json-schema.js";
import { DomainError } from "./errors.js";
import { canonicalJson, hashPayload } from "./ids.js";
import { canonicalProductSpecification } from "./product-spec-persistence.js";

export const REDESIGN_STAGES = CORE_REDESIGN_STAGES;
export type RedesignStage = CoreRedesignStage;
export type RedesignStatus = "active" | "completed" | "cancelled";
export type RedesignDecision = "created" | "advanced" | "returned" | "approved" | "cancelled" | "completed";

export const REDESIGN_SCOPES = [
  "redesign:read",
  "redesign:assessment",
  "redesign:review",
  "redesign:interview",
  "redesign:proposal",
  "redesign:design",
  "redesign:handoff",
  "redesign:approve",
  "redesign:implement",
  "redesign:cancel",
] as const;

export type RedesignScope = (typeof REDESIGN_SCOPES)[number];

const MAX_BRIEF_CHARACTERS = 10_000;
const MAX_CONTENT_BYTES = 512 * 1024;
const MAX_ARTIFACT_BYTES = 512 * 1024;
const MAX_DETAILS_BYTES = 64 * 1024;

const stageSchema = z.enum(REDESIGN_STAGES);
const decisionSchema = z.enum(["advanced", "returned", "approved", "cancelled", "completed"]);
const integrityHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const mappingPlatformSchema = z.enum(["web", "android", "ios", "flutter", "react_native", "other"]);
const repositoryPlatformSchema = z.enum(["web", "android", "ios", "flutter", "react-native", "generic-git"]);
const inventoryEntityKindSchema = z.enum(["component", "screen", "route", "token", "asset", "flow", "business-rule"]);
const implementationMappingEvidenceSchema = z.object({
  schemaVersion: z.literal(1),
  designPin: z.object({
    designId: z.string().min(1),
    revisionId: z.string().min(1),
    designVersion: z.number().int().positive(),
    snapshotHash: integrityHashSchema,
    revisionHash: integrityHashSchema,
  }).strict(),
  productSpecificationPin: z.object({
    source: z.enum(["document", "revision_link"]),
    version: z.number().int().positive(),
    hash: integrityHashSchema,
  }).strict(),
  inventoryPin: z.object({
    inventoryId: z.string().min(1),
    inventoryHash: integrityHashSchema,
    repositoryFingerprint: integrityHashSchema,
    platform: mappingPlatformSchema,
  }).strict(),
  designEntity: z.object({
    kind: z.enum(["component", "token", "screen", "asset", "flow", "business_rule"]),
    id: z.string().min(1),
  }).strict(),
  sourceEntity: z.object({
    id: z.string().regex(/^inv_[a-f0-9]{40}$/),
    kind: inventoryEntityKindSchema,
    symbol: z.string().min(1),
    locationId: z.string().regex(/^loc_[a-f0-9]{40}$/),
    line: z.number().int().positive().nullable(),
  }).strict(),
}).strict();
const repositoryInventoryEvidenceSchema = z.object({
  schemaVersion: z.literal(1),
  repositoryFingerprint: integrityHashSchema,
  platforms: z.array(repositoryPlatformSchema).min(1),
  entities: z.array(z.object({
    id: z.string().regex(/^inv_[a-f0-9]{40}$/),
    kind: inventoryEntityKindSchema,
    symbol: z.string().min(1).max(240).nullable(),
    locationId: z.string().regex(/^loc_[a-f0-9]{40}$/),
    line: z.number().int().positive().nullable(),
  }).passthrough()),
}).passthrough();

const stageScope: Record<RedesignStage, RedesignScope> = {
  connect_inspect: "redesign:review",
  document_current_state: "redesign:review",
  pm_interview: "redesign:interview",
  future_state_proposal: "redesign:proposal",
  design: "redesign:design",
  handoff: "redesign:handoff",
  approved_implementation: "redesign:implement",
};

const actionRoles: Record<RedesignScope, readonly OrganizationRole[]> = {
  "redesign:read": ["organization_admin", "product_manager", "design_editor", "engineer", "viewer", "agent"],
  "redesign:assessment": ["organization_admin", "product_manager", "design_editor", "engineer", "agent"],
  "redesign:review": ["organization_admin", "product_manager", "design_editor", "engineer", "agent"],
  "redesign:interview": ["organization_admin", "product_manager", "agent"],
  "redesign:proposal": ["organization_admin", "product_manager", "design_editor", "agent"],
  "redesign:design": ["organization_admin", "design_editor", "agent"],
  "redesign:handoff": ["organization_admin", "design_editor", "engineer", "agent"],
  "redesign:approve": ["organization_admin", "product_manager", "agent"],
  "redesign:implement": ["organization_admin", "engineer", "agent"],
  "redesign:cancel": ["organization_admin", "product_manager", "design_editor", "agent"],
};

interface DesignRow {
  id: string;
  organization_id: string;
  current_version: number;
  current_revision_id: string;
}

interface InventoryRow {
  id: string;
  organization_id: string;
  repository_fingerprint: string;
  inventory_hash: string;
  inventory_json: string;
  status: "active" | "superseded" | "revoked";
}

interface RevisionEvidenceRow {
  id: string;
  design_id: string;
  version: number;
  document_json: string;
  snapshot_hash: string | null;
  revision_hash: string | null;
}

interface ProductSpecificationEvidenceRow {
  version: number;
  specification_json: string;
  specification_hash: string;
}

interface ImplementationMappingEvidenceRow {
  id: string;
  design_id: string;
  revision_id: string;
  inventory_id: string | null;
  entity_kind: "component" | "token" | "screen" | "asset" | "flow" | "business_rule";
  entity_id: string;
  platform: "web" | "android" | "ios" | "flutter" | "react_native" | "other";
  symbol: string;
  mapping_json: string;
}

interface AssessmentRow {
  id: string;
  organization_id: string;
  design_id: string | null;
  inventory_id: string | null;
  status: RedesignStatus;
  current_stage: RedesignStage;
  current_version: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface VersionRow {
  assessment_id: string;
  version: number;
  stage: RedesignStage;
  content_json: string;
  actor_id: string;
  created_at: string;
}

interface TransitionRow {
  id: string;
  assessment_id: string;
  from_stage: RedesignStage | null;
  to_stage: RedesignStage;
  decision: RedesignDecision;
  actor_id: string;
  details_json: string;
  created_at: string;
}

interface StoredContent {
  schemaVersion: 1;
  stage: RedesignStage;
  sourceMutation: "none";
  brief: string;
  base: {
    designVersion: number | null;
    revisionId: string | null;
    inventoryId: string | null;
  };
  payload: Record<string, JsonValue>;
  stageArtifacts: RedesignStageArtifactMap;
}

export interface RedesignVersion {
  version: number;
  stage: RedesignStage;
  sourceMutation: "none";
  brief: string;
  base: StoredContent["base"];
  content: Record<string, JsonValue>;
  artifact: RedesignStageArtifact;
  actorId: string;
  createdAt: string;
}

export interface RedesignStageArtifactVersion {
  assessmentVersion: number;
  stage: RedesignStage;
  artifact: RedesignStageArtifact;
  actorId: string;
  createdAt: string;
}

export interface RedesignStageArtifactResult {
  assessmentId: string;
  stage: RedesignStage;
  headVersion: number;
  sourceMutation: "none";
  current: RedesignStageArtifactVersion | null;
  versions: RedesignStageArtifactVersion[];
}

export interface RedesignTransition {
  id: string;
  fromStage: RedesignStage | null;
  toStage: RedesignStage;
  decision: RedesignDecision;
  details: Record<string, JsonValue>;
  actorId: string;
  createdAt: string;
}

export interface RedesignAssessmentResult {
  id: string;
  organizationId: string;
  designId: string | null;
  inventoryId: string | null;
  status: RedesignStatus;
  currentStage: RedesignStage;
  currentVersion: number;
  sourceMutation: "none";
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  current: RedesignVersion;
  stageArtifacts: RedesignStageArtifactMap;
  versions: RedesignVersion[];
  transitions: RedesignTransition[];
}

export interface RedesignStudioServiceOptions {
  now?: () => Date;
}

function redesignId(prefix: "redesign" | "redesign_transition"): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function boundedBrief(value: unknown): string {
  if (typeof value !== "string") throw new DomainError("VALIDATION_FAILED", "Redesign brief must be text.", 422);
  const brief = value.trim();
  if (brief.length === 0 || brief.length > MAX_BRIEF_CHARACTERS) {
    throw new DomainError("VALIDATION_FAILED", `Redesign brief must be between 1 and ${MAX_BRIEF_CHARACTERS} characters.`, 422);
  }
  return brief;
}

function boundedObject(value: unknown, label: string, maximumBytes: number): Record<string, JsonValue> {
  const parsed = BoundedJsonObjectSchema.safeParse(value ?? {});
  if (!parsed.success) {
    throw new DomainError("VALIDATION_FAILED", `${label} must be a JSON object.`, 422, {
      details: {
        issues: parsed.error.issues.slice(0, 100).map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
          code: issue.code,
        })),
      },
    });
  }
  const bytes = Buffer.byteLength(canonicalJson(parsed.data), "utf8");
  if (bytes > maximumBytes) {
    throw new DomainError("PAYLOAD_TOO_LARGE", `${label} exceeds the ${maximumBytes} byte limit.`, 413, {
      details: { bytes, maximumBytes },
    });
  }
  return parsed.data;
}

function boundedStageArtifact(value: unknown, expectedStage: RedesignStage): RedesignStageArtifact {
  const parsed = RedesignStageArtifactSchema.safeParse(value);
  if (!parsed.success) {
    throw new DomainError("VALIDATION_FAILED", "Redesign stage artifact is invalid.", 422, {
      details: {
        stage: expectedStage,
        issues: parsed.error.issues.slice(0, 100).map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
          code: issue.code,
        })),
      },
    });
  }
  if (parsed.data.stage !== expectedStage) {
    throw new DomainError(
      "VALIDATION_FAILED",
      `Artifact stage ${parsed.data.stage} does not match current stage ${expectedStage}.`,
      422,
      { details: { artifactStage: parsed.data.stage, currentStage: expectedStage } },
    );
  }
  return parsed.data;
}

function boundedStageArtifactMap(value: unknown): RedesignStageArtifactMap {
  const parsed = RedesignStageArtifactMapSchema.safeParse(value);
  if (!parsed.success) {
    throw new DomainError("VALIDATION_FAILED", "Redesign stage artifact history is invalid.", 422, {
      details: {
        issues: parsed.error.issues.slice(0, 100).map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
          code: issue.code,
        })),
      },
    });
  }
  const bytes = Buffer.byteLength(canonicalJson(parsed.data), "utf8");
  if (bytes > MAX_ARTIFACT_BYTES) {
    throw new DomainError("PAYLOAD_TOO_LARGE", `Redesign stage artifacts exceed the ${MAX_ARTIFACT_BYTES} byte limit.`, 413, {
      details: { bytes, maximumBytes: MAX_ARTIFACT_BYTES },
    });
  }
  return parsed.data;
}

function parseStoredObject(value: string, label: string): Record<string, JsonValue> {
  try {
    return MetadataSchema.parse(JSON.parse(value) as unknown);
  } catch (error) {
    throw new DomainError("INTERNAL_ERROR", `Persisted ${label} is invalid.`, 500, { cause: error });
  }
}

function parseStage(value: unknown): RedesignStage {
  const parsed = stageSchema.safeParse(value);
  if (!parsed.success) throw new DomainError("VALIDATION_FAILED", "Redesign stage is invalid.", 422);
  return parsed.data;
}

function parseDecision(value: unknown): Exclude<RedesignDecision, "created"> {
  const parsed = decisionSchema.safeParse(value);
  if (!parsed.success) throw new DomainError("VALIDATION_FAILED", "Redesign transition decision is invalid.", 422);
  return parsed.data;
}

function parseStoredContent(row: VersionRow): StoredContent {
  try {
    const value = JSON.parse(row.content_json) as Partial<StoredContent>;
    const stage = stageSchema.parse(value.stage);
    const payload = MetadataSchema.parse(value.payload);
    const parsedArtifacts = RedesignStageArtifactMapSchema.parse(value.stageArtifacts ?? {});
    const stageArtifacts = parsedArtifacts[stage]
      ? parsedArtifacts
      : RedesignStageArtifactMapSchema.parse({
        ...parsedArtifacts,
        [stage]: createEmptyRedesignStageArtifact(stage),
      });
    const base = value.base;
    if (value.schemaVersion !== 1
      || value.sourceMutation !== "none"
      || typeof value.brief !== "string"
      || !base
      || (base.designVersion !== null && (!Number.isInteger(base.designVersion) || Number(base.designVersion) < 1))
      || (base.revisionId !== null && typeof base.revisionId !== "string")
      || (base.inventoryId !== null && typeof base.inventoryId !== "string")) {
      throw new Error("stored content contract mismatch");
    }
    if (stage !== row.stage) throw new Error("stored stage mismatch");
    return {
      schemaVersion: 1,
      stage,
      sourceMutation: "none",
      brief: value.brief,
      base: {
        designVersion: base.designVersion as number | null,
        revisionId: base.revisionId as string | null,
        inventoryId: base.inventoryId as string | null,
      },
      payload,
      stageArtifacts,
    };
  } catch (error) {
    throw new DomainError("INTERNAL_ERROR", "Persisted redesign assessment content is invalid.", 500, { cause: error });
  }
}

export class RedesignStudioService {
  readonly #now: () => Date;

  constructor(readonly database: DesignerDatabase, options: RedesignStudioServiceOptions = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  listAssessments(actorId: string, input: {
    status?: RedesignStatus;
    limit?: number;
  } = {}): RedesignAssessmentResult[] {
    const access = resolveAccess(this.database.sqlite, actorId);
    this.assertAction(access, "redesign:read");
    const limit = Math.max(1, Math.min(input.limit ?? 50, 100));
    const filters = [
      "assessment.organization_id = ?",
      `(assessment.design_id IS NULL OR EXISTS (
        SELECT 1 FROM designs visible_design
        WHERE visible_design.id = assessment.design_id
          AND visible_design.organization_id = assessment.organization_id
          AND ${activeDesignSqlPredicate("visible_design")}
      ))`,
    ];
    const parameters: Array<string | number> = [access.organizationId];
    if (access.projectIds.length > 0) {
      filters.push(`assessment.design_id IN (${access.projectIds.map(() => "?").join(", ")})`);
      parameters.push(...access.projectIds);
    }
    if (input.status !== undefined) {
      filters.push("assessment.status = ?");
      parameters.push(input.status);
    }
    const rows = this.database.sqlite.prepare(
      `SELECT assessment.* FROM redesign_assessments assessment
       WHERE ${filters.join(" AND ")}
       ORDER BY assessment.updated_at DESC, assessment.id DESC LIMIT ?`,
    ).all(...parameters, limit) as AssessmentRow[];
    return rows.map((row) => this.result(access, row));
  }

  createOneClickAssessment(actorId: string, input: {
    designId?: string;
    inventoryId?: string;
    expectedDesignVersion?: number;
    brief: string;
    content?: unknown;
  }): RedesignAssessmentResult {
    const access = resolveAccess(this.database.sqlite, actorId);
    this.assertAction(access, "redesign:assessment");
    const brief = boundedBrief(input.brief);
    const payload = boundedObject(input.content, "Redesign assessment content", MAX_CONTENT_BYTES);
    if (!input.designId && !input.inventoryId) {
      throw new DomainError("VALIDATION_FAILED", "A redesign assessment requires a designId, an inventoryId, or both.", 422);
    }
    if (input.designId && (!Number.isInteger(input.expectedDesignVersion) || Number(input.expectedDesignVersion) < 1)) {
      throw new DomainError("VALIDATION_FAILED", "expectedDesignVersion is required for a design-backed assessment.", 422);
    }

    const transaction = this.database.sqlite.transaction(() => {
      const design = input.designId
        ? this.requireDesign(access, input.designId, input.expectedDesignVersion)
        : null;
      const inventory = input.inventoryId ? this.requireInventory(access, input.inventoryId) : null;
      const now = this.nowIso();
      const id = redesignId("redesign");
      const stored: StoredContent = {
        schemaVersion: 1,
        stage: "connect_inspect",
        sourceMutation: "none",
        brief,
        base: {
          designVersion: design?.current_version ?? null,
          revisionId: design?.current_revision_id ?? null,
          inventoryId: inventory?.id ?? null,
        },
        payload,
        stageArtifacts: {
          connect_inspect: createEmptyRedesignStageArtifact("connect_inspect"),
        },
      };
      this.database.sqlite.prepare(
        `INSERT INTO redesign_assessments
         (id, organization_id, design_id, inventory_id, status, current_stage, current_version,
          created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', 'connect_inspect', 1, ?, ?, ?)`,
      ).run(id, access.organizationId, design?.id ?? null, inventory?.id ?? null, access.principalId, now, now);
      this.insertVersion(id, 1, "connect_inspect", stored, access, now);
      this.insertTransition(id, null, "connect_inspect", "created", access, now, {
        version: 1,
        oneClick: true,
        sourceMutation: "none",
      });
      appendAuditEvent(this.database.sqlite, access, "redesign.assessment.create", "redesign_assessment", id, {
        designId: design?.id ?? null,
        inventoryId: inventory?.id ?? null,
        baseDesignVersion: design?.current_version ?? null,
        sourceMutation: "none",
      });
      return this.result(access, this.requireAssessment(access, id));
    });
    return transaction.immediate();
  }

  getAssessment(actorId: string, assessmentId: string): RedesignAssessmentResult {
    const access = resolveAccess(this.database.sqlite, actorId);
    this.assertAction(access, "redesign:read");
    const row = this.requireAssessment(access, assessmentId);
    return this.result(access, row);
  }

  getStageArtifact(
    actorId: string,
    assessmentId: string,
    requestedStage: RedesignStage,
  ): RedesignStageArtifactResult {
    const access = resolveAccess(this.database.sqlite, actorId);
    this.assertAction(access, "redesign:read");
    const row = this.requireAssessment(access, assessmentId);
    const stage = parseStage(requestedStage);
    const versions = (this.database.sqlite.prepare(
      "SELECT * FROM redesign_assessment_versions WHERE assessment_id = ? AND stage = ? ORDER BY version",
    ).all(row.id, stage) as VersionRow[]).map((versionRow): RedesignStageArtifactVersion => {
      const content = parseStoredContent(versionRow);
      return {
        assessmentVersion: versionRow.version,
        stage,
        artifact: content.stageArtifacts[stage] ?? createEmptyRedesignStageArtifact(stage),
        actorId: versionRow.actor_id,
        createdAt: versionRow.created_at,
      };
    });
    return {
      assessmentId: row.id,
      stage,
      headVersion: row.current_version,
      sourceMutation: "none",
      current: versions.at(-1) ?? null,
      versions,
    };
  }

  reviseCurrentStage(actorId: string, assessmentId: string, input: {
    expectedVersion: number;
    expectedDesignVersion?: number;
    content: unknown;
  }): RedesignAssessmentResult {
    const access = resolveAccess(this.database.sqlite, actorId);
    const transaction = this.database.sqlite.transaction(() => {
      const row = this.requireAssessment(access, assessmentId);
      this.assertAction(access, stageScope[row.current_stage]);
      const payload = boundedObject(input.content, "Redesign stage content", MAX_CONTENT_BYTES);
      this.assertActive(row);
      this.assertAssessmentVersion(row, input.expectedVersion);
      this.assertDesignBaseVersion(access, row, input.expectedDesignVersion);
      const current = this.currentStoredContent(row);
      const now = this.nowIso();
      const nextVersion = row.current_version + 1;
      const stored: StoredContent = { ...current, payload };
      this.insertVersion(row.id, nextVersion, row.current_stage, stored, access, now);
      this.casUpdateAssessment(row, nextVersion, row.current_stage, row.status, now);
      appendAuditEvent(this.database.sqlite, access, "redesign.stage.revise", "redesign_assessment", row.id, {
        stage: row.current_stage,
        version: nextVersion,
      });
      return this.result(access, this.requireAssessment(access, row.id));
    });
    return transaction.immediate();
  }

  reviseStageArtifact(actorId: string, assessmentId: string, input: {
    expectedVersion: number;
    expectedDesignVersion?: number;
    stage: RedesignStage;
    artifact: unknown;
  }): RedesignAssessmentResult {
    const access = resolveAccess(this.database.sqlite, actorId);
    const requestedStage = parseStage(input.stage);
    const transaction = this.database.sqlite.transaction(() => {
      const row = this.requireAssessment(access, assessmentId);
      this.assertAction(access, stageScope[row.current_stage]);
      this.assertActive(row);
      this.assertAssessmentVersion(row, input.expectedVersion);
      if (row.current_stage !== requestedStage) {
        throw new DomainError(
          "VERSION_CONFLICT",
          `Cannot revise ${requestedStage}; the assessment is currently at ${row.current_stage}.`,
          409,
          { retryable: true, details: { requestedStage, currentStage: row.current_stage, currentVersion: row.current_version } },
        );
      }
      this.assertDesignBaseVersion(access, row, input.expectedDesignVersion);
      const artifact = boundedStageArtifact(input.artifact, requestedStage);
      const current = this.currentStoredContent(row);
      const stageArtifacts = boundedStageArtifactMap({
        ...current.stageArtifacts,
        [row.current_stage]: artifact,
      });
      const now = this.nowIso();
      const nextVersion = row.current_version + 1;
      this.insertVersion(row.id, nextVersion, row.current_stage, {
        ...current,
        stageArtifacts,
      }, access, now);
      this.casUpdateAssessment(row, nextVersion, row.current_stage, row.status, now);
      appendAuditEvent(this.database.sqlite, access, "redesign.stage.artifact.revise", "redesign_assessment", row.id, {
        stage: row.current_stage,
        version: nextVersion,
        reviewStatus: artifact.review_status,
        artifactSchemaVersion: artifact.schema_version,
        sourceMutation: "none",
      });
      return this.result(access, this.requireAssessment(access, row.id));
    });
    return transaction.immediate();
  }

  transition(actorId: string, assessmentId: string, input: {
    expectedVersion: number;
    expectedDesignVersion?: number;
    toStage: RedesignStage;
    decision: Exclude<RedesignDecision, "created">;
    content?: unknown;
    details?: unknown;
  }): RedesignAssessmentResult {
    const access = resolveAccess(this.database.sqlite, actorId);
    const toStage = parseStage(input.toStage);
    const decision = parseDecision(input.decision);
    const transaction = this.database.sqlite.transaction(() => {
      const row = this.requireAssessment(access, assessmentId);
      this.assertTransitionAction(access, toStage, decision);
      const suppliedPayload = input.content === undefined
        ? undefined
        : boundedObject(input.content, "Redesign stage content", MAX_CONTENT_BYTES);
      const details = boundedObject(input.details, "Redesign transition details", MAX_DETAILS_BYTES);
      this.assertActive(row);
      this.assertAssessmentVersion(row, input.expectedVersion);
      const nextStatus = this.validateTransition(row, toStage, decision);
      const current = this.currentStoredContent(row);
      if (decision === "advanced" || decision === "approved" || decision === "completed") {
        this.assertCurrentStageReady(row, current, decision);
        this.assertForwardSourceBindingsCurrent(access, row, current, input.expectedDesignVersion);
        if (decision === "advanced" && toStage === "future_state_proposal") {
          this.assertFutureStateEvidence(access, row, current);
        }
      }
      const payload = suppliedPayload ?? (toStage === row.current_stage ? current.payload : {});
      const stageArtifacts = current.stageArtifacts[toStage]
        ? current.stageArtifacts
        : boundedStageArtifactMap({
          ...current.stageArtifacts,
          [toStage]: createEmptyRedesignStageArtifact(toStage),
        });
      const now = this.nowIso();
      const nextVersion = row.current_version + 1;
      const stored: StoredContent = { ...current, stage: toStage, payload, stageArtifacts };
      this.insertVersion(row.id, nextVersion, toStage, stored, access, now);
      this.insertTransition(row.id, row.current_stage, toStage, decision, access, now, {
        ...details,
        version: nextVersion,
      });
      this.casUpdateAssessment(row, nextVersion, toStage, nextStatus, now);
      appendAuditEvent(this.database.sqlite, access, `redesign.stage.${decision}`, "redesign_assessment", row.id, {
        fromStage: row.current_stage,
        toStage,
        status: nextStatus,
        version: nextVersion,
      });
      return this.result(access, this.requireAssessment(access, row.id));
    });
    return transaction.immediate();
  }

  private validateTransition(
    row: AssessmentRow,
    toStage: RedesignStage,
    decision: Exclude<RedesignDecision, "created">,
  ): RedesignStatus {
    const fromIndex = REDESIGN_STAGES.indexOf(row.current_stage);
    const toIndex = REDESIGN_STAGES.indexOf(toStage);
    if (decision === "advanced" && toIndex === fromIndex + 1 && row.current_stage !== "handoff") return "active";
    if (decision === "returned" && toIndex < fromIndex) return "active";
    if (decision === "approved" && row.current_stage === "handoff" && toStage === "approved_implementation") return "active";
    if (decision === "cancelled" && toStage === row.current_stage) return "cancelled";
    if (decision === "completed" && row.current_stage === "approved_implementation" && toStage === row.current_stage) return "completed";
    throw new DomainError("VALIDATION_FAILED", `Cannot apply ${decision} from ${row.current_stage} to ${toStage}.`, 422, {
      details: { fromStage: row.current_stage, toStage, decision },
    });
  }

  private assertTransitionAction(
    access: AccessContext,
    toStage: RedesignStage,
    decision: Exclude<RedesignDecision, "created">,
  ): void {
    if (decision === "approved") return this.assertAction(access, "redesign:approve");
    if (decision === "completed") return this.assertAction(access, "redesign:implement");
    if (decision === "cancelled") return this.assertAction(access, "redesign:cancel");
    this.assertAction(access, stageScope[toStage]);
  }

  private assertCurrentStageReady(
    row: AssessmentRow,
    current: StoredContent,
    decision: "advanced" | "approved" | "completed",
  ): void {
    const requirement = decision === "advanced" ? "reviewed" : "approved";
    const artifact = current.stageArtifacts[row.current_stage]
      ?? createEmptyRedesignStageArtifact(row.current_stage);
    const readiness = evaluateRedesignStageReadiness(artifact, requirement);
    if (readiness.ready) return;
    throw new DomainError(
      "VALIDATION_FAILED",
      `The ${row.current_stage} artifact is not ready for the ${decision} transition.`,
      422,
      {
        details: {
          stage: row.current_stage,
          decision,
          requiredReviewStatus: requirement,
          currentReviewStatus: artifact.review_status,
          diagnostics: readiness.diagnostics,
        },
      },
    );
  }

  private assertForwardSourceBindingsCurrent(
    access: AccessContext,
    row: AssessmentRow,
    current: StoredContent,
    expectedDesignVersion?: number,
  ): void {
    const diagnostics: Array<Record<string, unknown>> = [];
    if (row.design_id) {
      if (!Number.isInteger(expectedDesignVersion) || Number(expectedDesignVersion) < 1) {
        throw new DomainError("VALIDATION_FAILED", "expectedDesignVersion is required for a design-backed redesign transition.", 422, {
          details: {
            diagnostics: [{
              code: "REDESIGN_EXPECTED_DESIGN_VERSION_REQUIRED",
              severity: "error",
              message: "Supply the assessment's bound design version before a forward transition.",
              designId: row.design_id,
              boundDesignVersion: current.base.designVersion,
            }],
          },
        });
      }
      const design = this.requireDesign(access, row.design_id);
      if (current.base.designVersion !== design.current_version
        || current.base.revisionId !== design.current_revision_id) {
        diagnostics.push({
          code: "REDESIGN_BOUND_DESIGN_NOT_CURRENT",
          severity: "error",
          message: "The bound design revision is no longer the current project head.",
          designId: row.design_id,
          boundDesignVersion: current.base.designVersion,
          currentDesignVersion: design.current_version,
          boundRevisionId: current.base.revisionId,
          currentRevisionId: design.current_revision_id,
        });
      }
      if (expectedDesignVersion !== design.current_version) {
        diagnostics.push({
          code: "REDESIGN_EXPECTED_DESIGN_VERSION_MISMATCH",
          severity: "error",
          message: `Expected design version ${expectedDesignVersion}, but the current version is ${design.current_version}.`,
          designId: row.design_id,
          suppliedExpectedDesignVersion: expectedDesignVersion,
          currentDesignVersion: design.current_version,
        });
      }
    } else if (expectedDesignVersion !== undefined) {
      throw new DomainError("VALIDATION_FAILED", "expectedDesignVersion cannot be used for an inventory-only assessment.", 422);
    }

    if (row.inventory_id) {
      const inventory = this.readBoundInventory(access, row.inventory_id);
      if (current.base.inventoryId !== row.inventory_id) {
        diagnostics.push({
          code: "REDESIGN_BOUND_INVENTORY_MISMATCH",
          severity: "error",
          message: "The assessment head does not match its bound repository inventory.",
          assessmentInventoryId: row.inventory_id,
          boundInventoryId: current.base.inventoryId,
        });
      }
      const activeRows = this.database.sqlite.prepare(
        `SELECT id FROM repository_inventories
         WHERE organization_id = ? AND repository_fingerprint = ? AND status = 'active'
         ORDER BY created_at DESC, id DESC`,
      ).all(access.organizationId, inventory.repository_fingerprint) as Array<{ id: string }>;
      if (inventory.status !== "active" || activeRows.length !== 1 || activeRows[0]?.id !== inventory.id) {
        diagnostics.push({
          code: "REDESIGN_BOUND_INVENTORY_NOT_CURRENT",
          severity: "error",
          message: "The bound repository inventory is not the single active current inventory for its repository.",
          inventoryId: inventory.id,
          status: inventory.status,
          currentInventoryIds: activeRows.map((candidate) => candidate.id),
        });
      }
    } else if (current.base.inventoryId !== null) {
      diagnostics.push({
        code: "REDESIGN_BOUND_INVENTORY_MISMATCH",
        severity: "error",
        message: "The assessment unexpectedly contains an unbound repository inventory reference.",
        assessmentInventoryId: null,
        boundInventoryId: current.base.inventoryId,
      });
    }

    if (diagnostics.length > 0) {
      throw new DomainError(
        "VERSION_CONFLICT",
        "The redesign assessment source bindings are no longer current.",
        409,
        { retryable: true, details: { diagnostics } },
      );
    }
  }

  private assertFutureStateEvidence(
    access: AccessContext,
    row: AssessmentRow,
    current: StoredContent,
  ): void {
    const diagnostics: Array<Record<string, unknown>> = [];
    if (!row.design_id || current.base.designVersion === null || current.base.revisionId === null) {
      diagnostics.push({
        code: "REDESIGN_FUTURE_STATE_DESIGN_PIN_REQUIRED",
        severity: "error",
        message: "A future-state proposal requires an exact design revision and version pin.",
      });
    }
    if (!row.inventory_id || current.base.inventoryId === null) {
      diagnostics.push({
        code: "REDESIGN_FUTURE_STATE_INVENTORY_PIN_REQUIRED",
        severity: "error",
        message: "A future-state proposal requires an explicitly selected repository inventory.",
      });
    }
    if (diagnostics.length > 0) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "Future-state proposal evidence is incomplete.",
        422,
        { details: { diagnostics } },
      );
    }

    const designId = row.design_id!;
    const revisionId = current.base.revisionId!;
    const designVersion = current.base.designVersion!;
    const inventoryId = row.inventory_id!;
    if (current.base.inventoryId !== inventoryId) {
      throw new DomainError(
        "VERSION_CONFLICT",
        "The redesign assessment inventory pin no longer matches its immutable source binding.",
        409,
        {
          retryable: true,
          details: {
            diagnostics: [{
              code: "REDESIGN_FUTURE_STATE_INVENTORY_PIN_MISMATCH",
              severity: "error",
              assessmentInventoryId: inventoryId,
              boundInventoryId: current.base.inventoryId,
            }],
          },
        },
      );
    }

    const revision = this.database.sqlite.prepare(
      `SELECT id, design_id, version, document_json, snapshot_hash, revision_hash
       FROM revisions WHERE id = ? AND design_id = ?`,
    ).get(revisionId, designId) as RevisionEvidenceRow | undefined;
    if (!revision
      || revision.version !== designVersion
      || !integrityHashSchema.safeParse(revision.snapshot_hash).success
      || !integrityHashSchema.safeParse(revision.revision_hash).success) {
      throw new DomainError(
        "INTERNAL_ERROR",
        "The redesign assessment's exact design revision is missing valid integrity metadata.",
        500,
        {
          details: {
            designId,
            revisionId,
            designVersion,
            persistedRevisionVersion: revision?.version ?? null,
          },
        },
      );
    }

    const inventory = this.readBoundInventory(access, inventoryId);
    const inventoryEvidence = this.verifiedInventoryEvidence(inventory);
    const revisionEvidence = this.exactProductSpecificationEvidence(revision);
    const mappings = this.database.sqlite.prepare(
      `SELECT id, design_id, revision_id, inventory_id, entity_kind, entity_id,
              platform, symbol, mapping_json
       FROM implementation_mappings
       WHERE organization_id = ? AND design_id = ? AND revision_id = ? AND inventory_id = ?
       ORDER BY created_at, id`,
    ).all(access.organizationId, designId, revisionId, inventoryId) as ImplementationMappingEvidenceRow[];
    if (mappings.length === 0) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "At least one verified implementation mapping is required before proposing a future state.",
        422,
        {
          details: {
            diagnostics: [{
              code: "REDESIGN_IMPLEMENTATION_MAPPING_REQUIRED",
              severity: "error",
              designId,
              revisionId,
              designVersion,
              inventoryId,
            }],
          },
        },
      );
    }

    const invalidMappings: Array<Record<string, unknown>> = [];
    for (const mapping of mappings) {
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(mapping.mapping_json) as unknown;
      } catch {
        invalidMappings.push({ mappingId: mapping.id, reason: "invalid_json" });
        continue;
      }
      const parsed = implementationMappingEvidenceSchema.safeParse(parsedJson);
      if (!parsed.success) {
        invalidMappings.push({
          mappingId: mapping.id,
          reason: "invalid_schema",
          issues: parsed.error.issues.slice(0, 20).map((issue) => ({
            path: issue.path.join("."),
            code: issue.code,
            message: issue.message,
          })),
        });
        continue;
      }
      const details = parsed.data;
      const matches = details.designPin.designId === designId
        && details.designPin.revisionId === revisionId
        && details.designPin.designVersion === designVersion
        && details.designPin.snapshotHash === revision.snapshot_hash
        && details.designPin.revisionHash === revision.revision_hash
        && details.productSpecificationPin.source === revisionEvidence.source
        && details.productSpecificationPin.version === revisionEvidence.version
        && details.productSpecificationPin.hash === revisionEvidence.hash
        && details.inventoryPin.inventoryId === inventoryId
        && details.inventoryPin.inventoryHash === inventory.inventory_hash
        && details.inventoryPin.repositoryFingerprint === inventory.repository_fingerprint
        && details.inventoryPin.platform === inventoryEvidence.platform
        && details.designEntity.kind === mapping.entity_kind
        && details.designEntity.id === mapping.entity_id
        && details.inventoryPin.platform === mapping.platform
        && details.sourceEntity.symbol === mapping.symbol
        && mapping.design_id === designId
        && mapping.revision_id === revisionId
        && mapping.inventory_id === inventoryId;
      const source = inventoryEvidence.entities.find((entity) => entity.id === details.sourceEntity.id);
      const exactSource = source !== undefined
        && source.kind === details.sourceEntity.kind
        && (source.symbol ?? source.id) === details.sourceEntity.symbol
        && source.locationId === details.sourceEntity.locationId
        && source.line === details.sourceEntity.line
        && this.mappingKindsCompatible(details.designEntity.kind, source.kind);
      const exactDesignEntity = this.designEntityExists(
        revisionEvidence.document,
        revisionEvidence.specification,
        details.designEntity.kind,
        details.designEntity.id,
      );
      if (matches && exactSource && exactDesignEntity) return;
      invalidMappings.push({ mappingId: mapping.id, reason: "pin_mismatch" });
    }

    throw new DomainError(
      "INTERNAL_ERROR",
      "Persisted implementation-mapping evidence failed integrity verification.",
      500,
      {
        details: {
          diagnostics: [{
            code: "REDESIGN_IMPLEMENTATION_MAPPING_INTEGRITY_FAILED",
            severity: "error",
            designId,
            revisionId,
            designVersion,
            inventoryId,
            invalidMappings: invalidMappings.slice(0, 20),
          }],
        },
      },
    );
  }

  private exactProductSpecificationEvidence(revision: RevisionEvidenceRow): {
    source: "document" | "revision_link";
    version: number;
    hash: string;
    document: DesignDocumentV2;
    specification: ProductSpecification;
  } {
    let document: DesignDocumentV2;
    try {
      document = DesignDocumentV2Schema.parse(JSON.parse(revision.document_json) as unknown);
    } catch (error) {
      throw new DomainError(
        "INTERNAL_ERROR",
        "The exact redesign revision is not a valid V2 design document.",
        500,
        { cause: error },
      );
    }
    const linked = this.database.sqlite.prepare(
      `SELECT version, specification_json, specification_hash
       FROM product_specifications
       WHERE design_id = ? AND revision_id = ?
       ORDER BY version DESC`,
    ).all(revision.design_id, revision.id) as ProductSpecificationEvidenceRow[];
    if (linked.length > 1) {
      throw new DomainError(
        "AMBIGUOUS_CONTEXT",
        "More than one product specification is pinned to the redesign assessment revision.",
        409,
        { details: { designId: revision.design_id, revisionId: revision.id } },
      );
    }
    if (linked.length === 1) {
      const row = linked[0]!;
      try {
        const canonical = canonicalProductSpecification(JSON.parse(row.specification_json) as unknown);
        if (canonical.json !== row.specification_json
          || canonical.hash !== row.specification_hash
          || canonical.specification.version !== row.version) {
          throw new Error("product specification integrity mismatch");
        }
        return {
          source: "revision_link",
          version: row.version,
          hash: row.specification_hash,
          document,
          specification: canonical.specification,
        };
      } catch (error) {
        throw new DomainError(
          "INTERNAL_ERROR",
          "The revision-linked product specification failed integrity verification.",
          500,
          { cause: error },
        );
      }
    }

    try {
      const canonical = canonicalProductSpecification(document.product_specification);
      return {
        source: "document",
        version: canonical.specification.version,
        hash: canonical.hash,
        document,
        specification: canonical.specification,
      };
    } catch (error) {
      throw new DomainError(
        "INTERNAL_ERROR",
        "The exact redesign revision does not contain a valid embedded V2 product specification.",
        500,
        { cause: error },
      );
    }
  }

  private verifiedInventoryEvidence(inventory: InventoryRow): {
    platform: ImplementationMappingEvidenceRow["platform"];
    entities: z.infer<typeof repositoryInventoryEvidenceSchema>["entities"];
  } {
    try {
      const raw = JSON.parse(inventory.inventory_json) as unknown;
      const parsed = repositoryInventoryEvidenceSchema.parse(raw);
      if (parsed.repositoryFingerprint !== inventory.repository_fingerprint
        || hashPayload(raw) !== inventory.inventory_hash
        || parsed.platforms.length !== 1) {
        throw new Error("repository inventory integrity mismatch");
      }
      const platform = parsed.platforms[0];
      if (!platform) throw new Error("repository inventory platform is missing");
      switch (platform) {
        case "web":
        case "android":
        case "ios":
        case "flutter":
          return { platform, entities: parsed.entities };
        case "react-native":
          return { platform: "react_native", entities: parsed.entities };
        case "generic-git":
          return { platform: "other", entities: parsed.entities };
      }
    } catch (error) {
      throw new DomainError(
        "INTERNAL_ERROR",
        "The selected repository inventory failed integrity verification.",
        500,
        { cause: error, details: { inventoryId: inventory.id } },
      );
    }
  }

  private designEntityExists(
    document: DesignDocumentV2,
    specification: ProductSpecification,
    kind: z.infer<typeof implementationMappingEvidenceSchema>["designEntity"]["kind"],
    entityId: string,
  ): boolean {
    switch (kind) {
      case "component":
        return document.component_definitions[entityId] !== undefined;
      case "token":
        return document.tokens[entityId] !== undefined;
      case "screen": {
        const node = document.nodes[entityId];
        return node?.type === "frame" && node.archived === false;
      }
      case "asset":
        return document.assets[entityId] !== undefined;
      case "flow":
        return specification.flows.some((flow) => flow.id === entityId);
      case "business_rule":
        return specification.business_rules.some((rule) => rule.id === entityId);
    }
  }

  private mappingKindsCompatible(
    designKind: z.infer<typeof implementationMappingEvidenceSchema>["designEntity"]["kind"],
    inventoryKind: z.infer<typeof inventoryEntityKindSchema>,
  ): boolean {
    const compatible: Record<
      z.infer<typeof implementationMappingEvidenceSchema>["designEntity"]["kind"],
      readonly z.infer<typeof inventoryEntityKindSchema>[]
    > = {
      component: ["component"],
      token: ["token"],
      screen: ["screen", "route"],
      asset: ["asset"],
      flow: ["flow", "route"],
      business_rule: ["business-rule"],
    };
    return compatible[designKind].includes(inventoryKind);
  }

  private assertAction(access: AccessContext, scope: RedesignScope): void {
    if (!actionRoles[scope].includes(access.role)) {
      throw new DomainError("FORBIDDEN", `The current role cannot perform ${scope}.`, 403);
    }
    if (access.role === "agent") assertScope(access, scope);
  }

  private requireDesign(access: AccessContext, designId: string, expectedVersion?: number): DesignRow {
    const row = requireActiveDesign(this.database.sqlite, access, designId);
    if (expectedVersion !== undefined && row.current_version !== expectedVersion) {
      throw this.versionConflict(expectedVersion, row.current_version, "design");
    }
    return row;
  }

  private requireInventory(access: AccessContext, inventoryId: string): InventoryRow {
    const row = this.readInventory(access, inventoryId);
    if (row.status !== "active") {
      throw new DomainError("VERSION_CONFLICT", `Repository inventory ${inventoryId} is ${row.status}.`, 409, {
        details: { inventoryId, status: row.status },
      });
    }
    return row;
  }

  private readInventory(access: AccessContext, inventoryId: string): InventoryRow {
    if (access.projectIds.length > 0) {
      throw new DomainError("NOT_FOUND", "Repository inventory not found.", 404);
    }
    return this.readBoundInventory(access, inventoryId);
  }

  private readBoundInventory(access: AccessContext, inventoryId: string): InventoryRow {
    const row = this.database.sqlite.prepare(
      `SELECT id, organization_id, repository_fingerprint, inventory_hash, inventory_json, status
       FROM repository_inventories WHERE id = ?`,
    ).get(inventoryId) as InventoryRow | undefined;
    if (!row || row.organization_id !== access.organizationId) {
      throw new DomainError("NOT_FOUND", "Repository inventory not found.", 404);
    }
    return row;
  }

  private requireAssessment(access: AccessContext, assessmentId: string): AssessmentRow {
    const row = this.database.sqlite.prepare(
      "SELECT * FROM redesign_assessments WHERE id = ?",
    ).get(assessmentId) as AssessmentRow | undefined;
    if (!row || row.organization_id !== access.organizationId) {
      throw new DomainError("NOT_FOUND", "Redesign assessment not found.", 404);
    }
    if (row.design_id) {
      requireActiveDesign(this.database.sqlite, access, row.design_id);
    } else if (access.projectIds.length > 0) {
      throw new DomainError("NOT_FOUND", "Redesign assessment not found.", 404);
    }
    return row;
  }

  private assertDesignBaseVersion(access: AccessContext, row: AssessmentRow, expectedVersion?: number): void {
    if (row.design_id) {
      if (!Number.isInteger(expectedVersion) || Number(expectedVersion) < 1) {
        throw new DomainError("VALIDATION_FAILED", "expectedDesignVersion is required for a design-backed redesign mutation.", 422);
      }
      this.requireDesign(access, row.design_id, expectedVersion);
      return;
    }
    if (expectedVersion !== undefined) {
      throw new DomainError("VALIDATION_FAILED", "expectedDesignVersion cannot be used for an inventory-only assessment.", 422);
    }
  }

  private assertAssessmentVersion(row: AssessmentRow, expectedVersion: number): void {
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      throw new DomainError("VALIDATION_FAILED", "expectedVersion must be a positive integer.", 422);
    }
    if (row.current_version !== expectedVersion) {
      throw this.versionConflict(expectedVersion, row.current_version, "redesign assessment");
    }
  }

  private assertActive(row: AssessmentRow): void {
    if (row.status !== "active") {
      throw new DomainError("VERSION_CONFLICT", `The redesign assessment is ${row.status}.`, 409, {
        details: { status: row.status, currentVersion: row.current_version },
      });
    }
  }

  private currentStoredContent(row: AssessmentRow): StoredContent {
    const version = this.database.sqlite.prepare(
      "SELECT * FROM redesign_assessment_versions WHERE assessment_id = ? AND version = ?",
    ).get(row.id, row.current_version) as VersionRow | undefined;
    if (!version) throw new DomainError("INTERNAL_ERROR", "The current redesign version is missing.", 500);
    return parseStoredContent(version);
  }

  private insertVersion(
    assessmentId: string,
    version: number,
    stage: RedesignStage,
    content: StoredContent,
    access: AccessContext,
    now: string,
  ): void {
    this.database.sqlite.prepare(
      `INSERT INTO redesign_assessment_versions
       (assessment_id, version, stage, content_json, actor_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(assessmentId, version, stage, canonicalJson(content), access.principalId, now);
  }

  private insertTransition(
    assessmentId: string,
    fromStage: RedesignStage | null,
    toStage: RedesignStage,
    decision: RedesignDecision,
    access: AccessContext,
    now: string,
    details: Record<string, JsonValue>,
  ): void {
    this.database.sqlite.prepare(
      `INSERT INTO redesign_transitions
       (id, assessment_id, from_stage, to_stage, decision, actor_id, details_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      redesignId("redesign_transition"),
      assessmentId,
      fromStage,
      toStage,
      decision,
      access.principalId,
      canonicalJson(details),
      now,
    );
  }

  private casUpdateAssessment(
    row: AssessmentRow,
    nextVersion: number,
    nextStage: RedesignStage,
    nextStatus: RedesignStatus,
    now: string,
  ): void {
    const updated = this.database.sqlite.prepare(
      `UPDATE redesign_assessments
       SET current_version = ?, current_stage = ?, status = ?, updated_at = ?
       WHERE id = ? AND current_version = ? AND status = 'active'`,
    ).run(nextVersion, nextStage, nextStatus, now, row.id, row.current_version);
    if (updated.changes !== 1) {
      const current = this.database.sqlite.prepare(
        "SELECT current_version FROM redesign_assessments WHERE id = ?",
      ).get(row.id) as { current_version: number } | undefined;
      throw this.versionConflict(row.current_version, current?.current_version ?? row.current_version, "redesign assessment");
    }
  }

  private result(access: AccessContext, row: AssessmentRow): RedesignAssessmentResult {
    if (row.design_id) {
      requireActiveDesign(this.database.sqlite, access, row.design_id);
    }
    const versionRows = this.database.sqlite.prepare(
      "SELECT * FROM redesign_assessment_versions WHERE assessment_id = ? ORDER BY version",
    ).all(row.id) as VersionRow[];
    const versions = versionRows.map((versionRow): RedesignVersion => {
      const content = parseStoredContent(versionRow);
      return {
        version: versionRow.version,
        stage: versionRow.stage,
        sourceMutation: "none",
        brief: content.brief,
        base: content.base,
        content: content.payload,
        artifact: content.stageArtifacts[versionRow.stage] ?? createEmptyRedesignStageArtifact(versionRow.stage),
        actorId: versionRow.actor_id,
        createdAt: versionRow.created_at,
      };
    });
    const transitions = (this.database.sqlite.prepare(
      "SELECT * FROM redesign_transitions WHERE assessment_id = ? ORDER BY rowid",
    ).all(row.id) as TransitionRow[]).map((transition): RedesignTransition => ({
      id: transition.id,
      fromStage: transition.from_stage,
      toStage: transition.to_stage,
      decision: transition.decision,
      details: parseStoredObject(transition.details_json, "redesign transition details"),
      actorId: transition.actor_id,
      createdAt: transition.created_at,
    }));
    const current = versions.find((version) => version.version === row.current_version);
    if (!current || current.stage !== row.current_stage) {
      throw new DomainError("INTERNAL_ERROR", "The redesign assessment head does not match its version history.", 500);
    }
    const stageArtifacts = this.currentStoredContent(row).stageArtifacts;
    return {
      id: row.id,
      organizationId: row.organization_id,
      designId: row.design_id,
      inventoryId: row.inventory_id,
      status: row.status,
      currentStage: row.current_stage,
      currentVersion: row.current_version,
      sourceMutation: "none",
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      current,
      stageArtifacts,
      versions,
      transitions,
    };
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
}
