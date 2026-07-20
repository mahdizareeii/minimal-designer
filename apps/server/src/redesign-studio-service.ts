import { randomUUID } from "node:crypto";

import { MetadataSchema, type JsonValue } from "@designer/core";
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
import { canonicalJson } from "./ids.js";

export const REDESIGN_STAGES = [
  "connect_inspect",
  "document_current_state",
  "pm_interview",
  "future_state_proposal",
  "design",
  "handoff",
  "approved_implementation",
] as const;

export type RedesignStage = (typeof REDESIGN_STAGES)[number];
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
const MAX_DETAILS_BYTES = 64 * 1024;

const stageSchema = z.enum(REDESIGN_STAGES);
const decisionSchema = z.enum(["advanced", "returned", "approved", "cancelled", "completed"]);

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
  status: "active" | "superseded" | "revoked";
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
}

export interface RedesignVersion {
  version: number;
  stage: RedesignStage;
  sourceMutation: "none";
  brief: string;
  base: StoredContent["base"];
  content: Record<string, JsonValue>;
  actorId: string;
  createdAt: string;
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
  const parsed = MetadataSchema.safeParse(value ?? {});
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
    const row = this.requireAssessment(access, assessmentId);
    this.assertAction(access, "redesign:read");
    return this.result(access, row);
  }

  reviseCurrentStage(actorId: string, assessmentId: string, input: {
    expectedVersion: number;
    expectedDesignVersion?: number;
    content: unknown;
  }): RedesignAssessmentResult {
    const access = resolveAccess(this.database.sqlite, actorId);
    const payload = boundedObject(input.content, "Redesign stage content", MAX_CONTENT_BYTES);
    const transaction = this.database.sqlite.transaction(() => {
      const row = this.requireAssessment(access, assessmentId);
      this.assertActive(row);
      this.assertAssessmentVersion(row, input.expectedVersion);
      this.assertAction(access, stageScope[row.current_stage]);
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
    const suppliedPayload = input.content === undefined
      ? undefined
      : boundedObject(input.content, "Redesign stage content", MAX_CONTENT_BYTES);
    const details = boundedObject(input.details, "Redesign transition details", MAX_DETAILS_BYTES);
    const transaction = this.database.sqlite.transaction(() => {
      const row = this.requireAssessment(access, assessmentId);
      this.assertActive(row);
      this.assertAssessmentVersion(row, input.expectedVersion);
      this.assertDesignBaseVersion(access, row, input.expectedDesignVersion);
      const nextStatus = this.validateTransition(row, toStage, decision);
      this.assertTransitionAction(access, toStage, decision);
      const current = this.currentStoredContent(row);
      const payload = suppliedPayload ?? (toStage === row.current_stage ? current.payload : {});
      const now = this.nowIso();
      const nextVersion = row.current_version + 1;
      const stored: StoredContent = { ...current, stage: toStage, payload };
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

  private assertAction(access: AccessContext, scope: RedesignScope): void {
    if (!actionRoles[scope].includes(access.role)) {
      throw new DomainError("FORBIDDEN", `The current role cannot perform ${scope}.`, 403);
    }
    if (access.role === "agent") assertScope(access, scope);
  }

  private requireDesign(access: AccessContext, designId: string, expectedVersion?: number): DesignRow {
    const row = this.database.sqlite.prepare(
      "SELECT id, organization_id, current_version, current_revision_id FROM designs WHERE id = ?",
    ).get(designId) as DesignRow | undefined;
    if (!row) throw new DomainError("NOT_FOUND", "Design not found.", 404);
    assertProjectAccess(access, row.organization_id, row.id);
    if (expectedVersion !== undefined && row.current_version !== expectedVersion) {
      throw this.versionConflict(expectedVersion, row.current_version, "design");
    }
    return row;
  }

  private requireInventory(access: AccessContext, inventoryId: string): InventoryRow {
    if (access.projectIds.length > 0) {
      throw new DomainError("NOT_FOUND", "Repository inventory not found.", 404);
    }
    const row = this.database.sqlite.prepare(
      "SELECT id, organization_id, status FROM repository_inventories WHERE id = ?",
    ).get(inventoryId) as InventoryRow | undefined;
    if (!row || row.organization_id !== access.organizationId) {
      throw new DomainError("NOT_FOUND", "Repository inventory not found.", 404);
    }
    if (row.status !== "active") {
      throw new DomainError("VERSION_CONFLICT", `Repository inventory ${inventoryId} is ${row.status}.`, 409, {
        details: { inventoryId, status: row.status },
      });
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
    if (row.design_id) assertProjectAccess(access, row.organization_id, row.design_id);
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
    if (row.design_id) assertProjectAccess(access, row.organization_id, row.design_id);
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
