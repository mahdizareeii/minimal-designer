import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { resolveAccess } from "./authorization.js";
import { DesignerDatabase } from "./db/database.js";
import { DomainError } from "./errors.js";
import { EventHub } from "./events.js";
import {
  REDESIGN_STAGES,
  RedesignStudioService,
  type RedesignAssessmentResult,
  type RedesignScope,
  type RedesignStage,
} from "./redesign-studio-service.js";
import { DesignerService } from "./service.js";

const openedDatabases: DesignerDatabase[] = [];

function setup() {
  const database = new DesignerDatabase(":memory:");
  openedDatabases.push(database);
  const designer = new DesignerService(database, new EventHub(), 900);
  const created = designer.createDesign("local", {
    name: "Redesign Studio fixture",
    preset: "web",
    idempotencyKey: `redesign-create-${Math.random()}`,
  });
  const studio = new RedesignStudioService(database, {
    now: () => new Date("2026-07-19T12:00:00.000Z"),
  });
  return { database, designer, created, studio };
}

function captureThrown(callback: () => unknown): unknown {
  try {
    callback();
  } catch (error) {
    return error;
  }
  throw new Error("Expected callback to throw.");
}

function createGrant(
  database: DesignerDatabase,
  id: string,
  scopes: readonly RedesignScope[],
  projectIds: readonly string[],
): string {
  const access = resolveAccess(database.sqlite, "local");
  const principalId = `principal_${id}`;
  const now = "2026-07-19T12:00:00.000Z";
  database.sqlite.prepare(
    `INSERT INTO principals (id, organization_id, kind, display_name, external_id, created_at)
     VALUES (?, ?, 'agent', ?, ?, ?)`,
  ).run(principalId, access.organizationId, id, id, now);
  database.sqlite.prepare(
    `INSERT INTO memberships (organization_id, principal_id, role, created_at)
     VALUES (?, ?, 'agent', ?)`,
  ).run(access.organizationId, principalId, now);
  database.sqlite.prepare(
    `INSERT INTO agent_connections
     (id, organization_id, principal_id, adapter, display_name, status, scopes_json, project_ids_json,
      expires_at, created_at, updated_at)
     VALUES (?, ?, ?, 'generic_mcp', ?, 'active', ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`,
  ).run(
    `connection_${id}`,
    access.organizationId,
    principalId,
    id,
    JSON.stringify(scopes),
    JSON.stringify(projectIds),
    now,
    now,
  );
  database.sqlite.prepare(
    `INSERT INTO agent_grants
     (id, organization_id, principal_id, token_hash, scopes_json, project_ids_json, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    access.organizationId,
    principalId,
    createHash("sha256").update(id).digest("hex"),
    JSON.stringify(scopes),
    JSON.stringify(projectIds),
    now,
    "2099-01-01T00:00:00.000Z",
  );
  return `grant_${id}`;
}

function advance(
  studio: RedesignStudioService,
  current: RedesignAssessmentResult,
  toStage: RedesignStage,
): RedesignAssessmentResult {
  return studio.transition("local", current.id, {
    expectedVersion: current.currentVersion,
    expectedDesignVersion: current.current.base.designVersion ?? undefined,
    toStage,
    decision: "advanced",
    content: { summary: `Started ${toStage}` },
  });
}

afterEach(() => {
  for (const database of openedDatabases.splice(0)) database.close();
});

describe("RedesignStudioService", () => {
  it("creates an assessment-only workflow without rewriting project source or design history", () => {
    const opened = setup();
    const before = {
      design: opened.database.sqlite.prepare(
        "SELECT current_version, current_revision_id FROM designs WHERE id = ?",
      ).get(opened.created.document.id),
      revisions: opened.database.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM revisions WHERE design_id = ?",
      ).get(opened.created.document.id),
    };

    const assessment = opened.studio.createOneClickAssessment("local", {
      designId: opened.created.document.id,
      expectedDesignVersion: opened.created.revision.version,
      brief: "Assess the current operations product and prepare a reviewed redesign plan.",
      content: { objective: "Document before proposing", oneClick: true },
    });

    expect(assessment).toMatchObject({
      designId: opened.created.document.id,
      status: "active",
      currentStage: "connect_inspect",
      currentVersion: 1,
      sourceMutation: "none",
      current: {
        stage: "connect_inspect",
        sourceMutation: "none",
        base: { designVersion: opened.created.revision.version, revisionId: opened.created.revision.id },
        content: { objective: "Document before proposing", oneClick: true },
      },
    });
    expect(assessment.versions).toHaveLength(1);
    expect(assessment.transitions).toMatchObject([{
      fromStage: null,
      toStage: "connect_inspect",
      decision: "created",
      details: { version: 1, oneClick: true, sourceMutation: "none" },
    }]);
    expect(opened.database.sqlite.prepare(
      "SELECT current_version, current_revision_id FROM designs WHERE id = ?",
    ).get(opened.created.document.id)).toEqual(before.design);
    expect(opened.database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM revisions WHERE design_id = ?",
    ).get(opened.created.document.id)).toEqual(before.revisions);
    expect(opened.database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM implementation_mappings WHERE design_id = ?",
    ).get(opened.created.document.id)).toEqual({ count: 0 });

    expect(() => opened.database.sqlite.prepare(
      "UPDATE redesign_assessment_versions SET stage = 'design' WHERE assessment_id = ? AND version = 1",
    ).run(assessment.id)).toThrow(/immutable/);
    expect(() => opened.database.sqlite.prepare(
      "DELETE FROM redesign_transitions WHERE assessment_id = ?",
    ).run(assessment.id)).toThrow(/immutable/);
  });

  it("persists the exact seven-stage flow with append-only versions and transitions", () => {
    const opened = setup();
    let result = opened.studio.createOneClickAssessment("local", {
      designId: opened.created.document.id,
      expectedDesignVersion: 1,
      brief: "Redesign the product through independently reviewed stages.",
    });
    result = advance(opened.studio, result, "document_current_state");
    result = advance(opened.studio, result, "pm_interview");
    result = advance(opened.studio, result, "future_state_proposal");
    result = advance(opened.studio, result, "design");
    result = advance(opened.studio, result, "handoff");
    result = opened.studio.transition("local", result.id, {
      expectedVersion: result.currentVersion,
      expectedDesignVersion: 1,
      toStage: "approved_implementation",
      decision: "approved",
      content: { approval: "Product manager approved the reviewed handoff." },
    });
    result = opened.studio.transition("local", result.id, {
      expectedVersion: result.currentVersion,
      expectedDesignVersion: 1,
      toStage: "approved_implementation",
      decision: "completed",
      details: { outcome: "Implementation task may now close." },
    });

    expect(result.status).toBe("completed");
    expect(result.currentStage).toBe("approved_implementation");
    expect(result.currentVersion).toBe(8);
    expect(result.versions.map((version) => version.stage)).toEqual([
      ...REDESIGN_STAGES,
      "approved_implementation",
    ]);
    expect(result.transitions.map((transition) => transition.decision)).toEqual([
      "created",
      "advanced",
      "advanced",
      "advanced",
      "advanced",
      "advanced",
      "approved",
      "completed",
    ]);
    expect(result.versions.every((version) => version.sourceMutation === "none")).toBe(true);
    expect(opened.database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM redesign_assessment_versions WHERE assessment_id = ?",
    ).get(result.id)).toEqual({ count: 8 });
    expect(opened.database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM redesign_transitions WHERE assessment_id = ?",
    ).get(result.id)).toEqual({ count: 8 });
    expect(captureThrown(() => opened.studio.reviseCurrentStage("local", result.id, {
      expectedVersion: result.currentVersion,
      content: { forbidden: "terminal edit" },
    }))).toMatchObject({ code: "VERSION_CONFLICT", statusCode: 409 });
  });

  it("supports append-only revision/return history and rejects stale assessment or design bases", () => {
    const opened = setup();
    expect(captureThrown(() => opened.studio.createOneClickAssessment("local", {
      designId: opened.created.document.id,
      expectedDesignVersion: 2,
      brief: "Stale assessment",
    }))).toMatchObject({
      code: "VERSION_CONFLICT",
      details: { expectedVersion: 2, currentVersion: 1, subject: "design" },
    });

    let result = opened.studio.createOneClickAssessment("local", {
      designId: opened.created.document.id,
      expectedDesignVersion: 1,
      brief: "Editable redesign assessment",
      content: { finding: "Initial observation" },
    });
    const originalVersion = result.currentVersion;
    result = opened.studio.reviseCurrentStage("local", result.id, {
      expectedVersion: originalVersion,
      expectedDesignVersion: 1,
      content: { finding: "Evidence-backed observation" },
    });
    expect(result.currentVersion).toBe(2);
    expect(result.versions).toHaveLength(2);
    expect(result.transitions).toHaveLength(1);
    expect(result.current.content).toEqual({ finding: "Evidence-backed observation" });
    expect(captureThrown(() => opened.studio.reviseCurrentStage("local", result.id, {
      expectedVersion: originalVersion,
      content: { finding: "Lost update" },
    }))).toMatchObject({
      code: "VERSION_CONFLICT",
      details: { expectedVersion: 1, currentVersion: 2, subject: "redesign assessment" },
    });

    result = advance(opened.studio, result, "document_current_state");
    result = opened.studio.transition("local", result.id, {
      expectedVersion: result.currentVersion,
      expectedDesignVersion: 1,
      toStage: "connect_inspect",
      decision: "returned",
      content: { reason: "Inspect one more workflow before documenting." },
    });
    expect(result.currentStage).toBe("connect_inspect");
    expect(result.currentVersion).toBe(4);
    expect(result.transitions.at(-1)).toMatchObject({
      fromStage: "document_current_state",
      toStage: "connect_inspect",
      decision: "returned",
    });
    expect(captureThrown(() => opened.studio.transition("local", result.id, {
      expectedVersion: result.currentVersion,
      expectedDesignVersion: 1,
      toStage: "future_state_proposal",
      decision: "advanced",
    }))).toMatchObject({ code: "VALIDATION_FAILED", statusCode: 422 });
  });

  it("enforces assessment, read, approval, and implementation scopes independently", () => {
    const opened = setup();
    const designId = opened.created.document.id;
    const other = opened.designer.createDesign("local", {
      name: "Restricted project",
      preset: "phone",
      idempotencyKey: `redesign-other-${Math.random()}`,
    });
    const assessmentActor = createGrant(opened.database, "redesign_assessment_only", ["redesign:assessment"], [designId]);
    const readActor = createGrant(opened.database, "redesign_read_only", ["redesign:read"], [designId]);
    const reviewActor = createGrant(opened.database, "redesign_review_only", ["redesign:review"], [designId]);
    const proposalActor = createGrant(opened.database, "redesign_proposal_only", ["redesign:proposal"], [designId]);
    const approveActor = createGrant(opened.database, "redesign_approve_only", ["redesign:approve"], [designId]);
    const implementActor = createGrant(opened.database, "redesign_implement_only", ["redesign:implement"], [designId]);
    const wrongProjectActor = createGrant(opened.database, "redesign_wrong_project", ["redesign:read"], [other.document.id]);

    let result = opened.studio.createOneClickAssessment(assessmentActor, {
      designId,
      expectedDesignVersion: 1,
      brief: "Scoped redesign assessment",
    });
    expect(captureThrown(() => opened.studio.getAssessment(assessmentActor, result.id))).toMatchObject({
      code: "FORBIDDEN",
      statusCode: 403,
    });
    expect(opened.studio.getAssessment(readActor, result.id).id).toBe(result.id);
    expect(captureThrown(() => opened.studio.getAssessment(wrongProjectActor, result.id))).toMatchObject({
      code: "NOT_FOUND",
      statusCode: 404,
    });

    expect(captureThrown(() => opened.studio.transition(proposalActor, result.id, {
      expectedVersion: result.currentVersion,
      expectedDesignVersion: 1,
      toStage: "document_current_state",
      decision: "advanced",
    }))).toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
    result = opened.studio.transition(reviewActor, result.id, {
      expectedVersion: result.currentVersion,
      expectedDesignVersion: 1,
      toStage: "document_current_state",
      decision: "advanced",
    });
    result = advance(opened.studio, result, "pm_interview");
    result = advance(opened.studio, result, "future_state_proposal");
    result = advance(opened.studio, result, "design");
    result = advance(opened.studio, result, "handoff");
    expect(captureThrown(() => opened.studio.transition(implementActor, result.id, {
      expectedVersion: result.currentVersion,
      expectedDesignVersion: 1,
      toStage: "approved_implementation",
      decision: "approved",
    }))).toMatchObject({ code: "FORBIDDEN", statusCode: 403 });

    result = opened.studio.transition(approveActor, result.id, {
      expectedVersion: result.currentVersion,
      expectedDesignVersion: 1,
      toStage: "approved_implementation",
      decision: "approved",
    });
    expect(captureThrown(() => opened.studio.transition(approveActor, result.id, {
      expectedVersion: result.currentVersion,
      expectedDesignVersion: 1,
      toStage: "approved_implementation",
      decision: "completed",
    }))).toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
    result = opened.studio.transition(implementActor, result.id, {
      expectedVersion: result.currentVersion,
      expectedDesignVersion: 1,
      toStage: "approved_implementation",
      decision: "completed",
    });
    expect(result.status).toBe("completed");
  });
});
