import { createHash } from "node:crypto";

import {
  migrateDesignDocumentV1ToV2,
  REDESIGN_ARTIFACT_COLLECTIONS,
  RedesignStageArtifactSchema,
  createEmptyRedesignStageArtifact,
  type RedesignArtifactItem,
  type RedesignStageArtifact,
} from "@designer/core";
import { afterEach, describe, expect, it } from "vitest";

import { resolveAccess } from "./authorization.js";
import { DesignerDatabase } from "./db/database.js";
import { DomainError } from "./errors.js";
import { EventHub } from "./events.js";
import { operationHash, revisionHash, storeSnapshot } from "./persistence.js";
import { canonicalProductSpecification } from "./product-spec-persistence.js";
import {
  RedesignStudioService,
  type RedesignAssessmentResult,
  type RedesignScope,
  type RedesignStage,
} from "./redesign-studio-service.js";
import { DesignerService } from "./service.js";
import {
  WorkspaceHandoffService,
  type UploadRepositoryInventory,
} from "./workspace-handoff-service.js";

const openedDatabases: DesignerDatabase[] = [];

function artifactItem(
  id: string,
  title: string,
  status: RedesignArtifactItem["status"] = "reviewed",
): RedesignArtifactItem {
  return {
    id,
    title,
    description: `${title} evidence`,
    status,
    priority: "normal",
    evidence: [],
    linked_ids: [],
  };
}

function completeStageArtifact(
  stage: RedesignStage,
  reviewStatus: "reviewed" | "approved" = "reviewed",
): RedesignStageArtifact {
  const artifact = {
    ...createEmptyRedesignStageArtifact(stage),
    summary: `${stage} has an explicit reviewed outcome in every required collection.`,
    review_status: reviewStatus,
  } as unknown as Record<string, unknown>;
  REDESIGN_ARTIFACT_COLLECTIONS[stage].forEach((collection, index) => {
    artifact[collection] = [artifactItem(
      `redesign_item_${stage}_${String(index).padStart(2, "0")}`,
      `${collection} outcome`,
      reviewStatus === "approved" ? "approved" : "reviewed",
    )];
  });
  return RedesignStageArtifactSchema.parse(artifact);
}

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

const REDESIGN_MAPPING_SOURCE_ID = `inv_${"9".repeat(40)}`;
const REDESIGN_MAPPING_LOCATION_ID = `loc_${"8".repeat(40)}`;

function redesignMappingInventory(): UploadRepositoryInventory {
  return {
    schemaVersion: 1,
    repositoryFingerprint: "c".repeat(64),
    generatedAt: "2026-07-19T12:10:00.000Z",
    platforms: ["web"],
    gitHead: "d".repeat(40),
    scannedFileCount: 4,
    skippedFileCount: 2,
    bytesRead: 4096,
    truncated: false,
    excludedPatterns: [".env", ".env.*", "*.pem", "*.key", "**/secrets/**", "**/.git/**"],
    entities: [{
      id: REDESIGN_MAPPING_SOURCE_ID,
      kind: "route",
      name: "Current product route",
      symbol: null,
      locationId: REDESIGN_MAPPING_LOCATION_ID,
      line: 12,
    }],
    excluded: [
      { category: "secret", count: 1 },
      { category: "generated", count: 1 },
      { category: "symlink", count: 0 },
      { category: "limit", count: 0 },
    ],
  };
}

function prepareMappingSource(opened: ReturnType<typeof setup>) {
  const current = opened.designer.getDesign("local", opened.created.document.id, 1);
  const frameId = current.canonicalDocument.pages[0]?.children[0];
  if (!frameId) throw new Error("Expected a starter frame for redesign mapping evidence.");
  const now = "2026-07-19T12:10:01.000Z";
  const document = migrateDesignDocumentV1ToV2({
    ...current.canonicalDocument,
    revision: 2,
    updated_at: now,
  }, {
    migratedAt: now,
    sourceRevisionId: current.revision.id,
    sourceSnapshotHash: current.revision.snapshotHash,
  });
  const parent = opened.database.sqlite.prepare(
    "SELECT revision_hash FROM revisions WHERE id = ?",
  ).get(current.revision.id) as { revision_hash: string | null } | undefined;
  if (!parent?.revision_hash) throw new Error("Expected the source revision integrity hash.");
  const revisionId = "revision_redesignmappingv2_0001";
  const snapshot = storeSnapshot(opened.database.sqlite, document, now);
  const operationsHash = operationHash([]);
  const access = resolveAccess(opened.database.sqlite, "local");
  const integrityHash = revisionHash({
    parentRevisionHash: parent.revision_hash,
    snapshotHash: snapshot.hash,
    operationHash: operationsHash,
    metadata: {
      id: revisionId,
      designId: opened.created.document.id,
      version: 2,
      parentRevisionId: current.revision.id,
      actorId: access.principalId,
      message: "Redesign mapping evidence fixture",
      createdAt: now,
    },
  });
  opened.database.sqlite.prepare(
    `INSERT INTO revisions
     (id, design_id, version, parent_revision_id, actor_id, message, document_json, operations_json,
      snapshot_hash, operation_hash, parent_revision_hash, revision_hash, created_at)
     VALUES (?, ?, 2, ?, ?, 'Redesign mapping evidence fixture', ?, '[]', ?, ?, ?, ?, ?)`,
  ).run(
    revisionId,
    opened.created.document.id,
    current.revision.id,
    access.principalId,
    snapshot.canonicalJson,
    snapshot.hash,
    operationsHash,
    parent.revision_hash,
    integrityHash,
    now,
  );
  opened.database.sqlite.prepare(
    "UPDATE designs SET current_version = 2, current_revision_id = ?, updated_at = ? WHERE id = ?",
  ).run(revisionId, now, opened.created.document.id);
  const handoffs = new WorkspaceHandoffService(opened.database, {
    now: () => new Date("2026-07-19T12:10:02.000Z"),
  });
  const inventory = handoffs.persistRepositoryInventory("local", redesignMappingInventory());
  return {
    designId: opened.created.document.id,
    designVersion: 2,
    revisionId,
    snapshotHash: snapshot.hash,
    revisionHash: integrityHash,
    frameId,
    handoffs,
    inventory,
  };
}

function prepareMappedSource(opened: ReturnType<typeof setup>) {
  const source = prepareMappingSource(opened);
  const mapping = source.handoffs.createImplementationMappings("local", {
    designId: source.designId,
    revisionId: source.revisionId,
    expectedDesignVersion: source.designVersion,
    inventoryId: source.inventory.id,
    idempotencyKey: "redesign-mapping-evidence-0001",
    mappings: [{
      entityKind: "screen",
      entityId: source.frameId,
      inventoryEntityId: REDESIGN_MAPPING_SOURCE_ID,
    }],
  });
  return { ...source, mapping: mapping.mappings[0]! };
}

function insertTamperedMappingEvidence(
  opened: ReturnType<typeof setup>,
  source: ReturnType<typeof prepareMappingSource>,
): string {
  const design = opened.designer.getDesign("local", source.designId, source.designVersion);
  if (design.canonicalDocument.schema_version !== 2) throw new Error("Expected a V2 redesign mapping fixture.");
  const specification = canonicalProductSpecification(design.canonicalDocument.product_specification);
  const mappingId = "mapping_redesigninvalidpin000001";
  const details = {
    schemaVersion: 1,
    designPin: {
      designId: source.designId,
      revisionId: source.revisionId,
      designVersion: source.designVersion,
      snapshotHash: source.snapshotHash,
      revisionHash: source.revisionHash,
    },
    productSpecificationPin: {
      source: "document",
      version: specification.specification.version,
      hash: specification.hash,
    },
    inventoryPin: {
      inventoryId: source.inventory.id,
      inventoryHash: source.inventory.inventoryHash,
      repositoryFingerprint: source.inventory.repositoryFingerprint,
      platform: "web",
    },
    designEntity: { kind: "screen", id: source.frameId },
    sourceEntity: {
      id: REDESIGN_MAPPING_SOURCE_ID,
      kind: "route",
      symbol: REDESIGN_MAPPING_SOURCE_ID,
      locationId: `loc_${"7".repeat(40)}`,
      line: 12,
    },
  };
  const access = resolveAccess(opened.database.sqlite, "local");
  opened.database.sqlite.prepare(
    `INSERT INTO implementation_mappings
     (id, organization_id, design_id, revision_id, inventory_id, entity_kind,
      entity_id, platform, symbol, mapping_json, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, 'screen', ?, 'web', ?, ?, ?, ?)`,
  ).run(
    mappingId,
    access.organizationId,
    source.designId,
    source.revisionId,
    source.inventory.id,
    source.frameId,
    REDESIGN_MAPPING_SOURCE_ID,
    JSON.stringify(details),
    access.principalId,
    "2026-07-19T12:10:03.000Z",
  );
  return mappingId;
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

function insertActiveInventory(database: DesignerDatabase, marker: string): string {
  const access = resolveAccess(database.sqlite, "local");
  const hexMarker = createHash("sha256").update(marker).digest("hex");
  const inventoryId = `inventory_${hexMarker.slice(0, 32)}`;
  database.sqlite.prepare(
    `INSERT INTO repository_inventories
     (id, organization_id, repository_fingerprint, inventory_hash, inventory_json,
      status, created_by, created_at, revoked_at)
     VALUES (?, ?, ?, ?, '{}', 'active', ?, ?, NULL)`,
  ).run(
    inventoryId,
    access.organizationId,
    hexMarker,
    createHash("sha256").update(`inventory:${marker}`).digest("hex"),
    access.principalId,
    "2026-07-19T12:00:00.000Z",
  );
  return inventoryId;
}

function advance(
  studio: RedesignStudioService,
  current: RedesignAssessmentResult,
  toStage: RedesignStage,
): RedesignAssessmentResult {
  const reviewed = studio.reviseStageArtifact("local", current.id, {
    expectedVersion: current.currentVersion,
    expectedDesignVersion: current.current.base.designVersion ?? undefined,
    stage: current.currentStage,
    artifact: completeStageArtifact(current.currentStage),
  });
  return studio.transition("local", reviewed.id, {
    expectedVersion: reviewed.currentVersion,
    expectedDesignVersion: reviewed.current.base.designVersion ?? undefined,
    toStage,
    decision: "advanced",
    content: { summary: `Started ${toStage}` },
  });
}

afterEach(() => {
  for (const database of openedDatabases.splice(0)) database.close();
});

describe("RedesignStudioService", () => {
  it("makes design-backed assessments opaque after the project is archived", () => {
    const opened = setup();
    const assessment = opened.studio.createOneClickAssessment("local", {
      designId: opened.created.document.id,
      expectedDesignVersion: 1,
      brief: "Retain this assessment as immutable evidence after project archival.",
    });

    opened.designer.archiveDesign("local", opened.created.document.id, {
      expectedVersion: 1,
      idempotencyKey: "redesign-archive-opacity-0001",
      confirmationName: opened.created.design.name,
    });

    expect(captureThrown(() => opened.studio.getAssessment("local", assessment.id)))
      .toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
    expect(captureThrown(() => opened.studio.getStageArtifact(
      "local",
      assessment.id,
      "connect_inspect",
    ))).toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
    expect(captureThrown(() => opened.studio.reviseCurrentStage("local", assessment.id, {
      expectedVersion: 1,
      expectedDesignVersion: 1,
      content: { finding: "Archived projects cannot be mutated through retained assessments." },
    }))).toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
    expect(captureThrown(() => opened.studio.createOneClickAssessment("local", {
      designId: opened.created.document.id,
      expectedDesignVersion: 1,
      brief: "Archived projects cannot start new redesign assessments.",
    }))).toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
    expect(opened.database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM redesign_assessments WHERE id = ?",
    ).get(assessment.id)).toEqual({ count: 1 });
  });

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

  it("stores strict stage artifacts as immutable CAS versions and exposes stage history", () => {
    const opened = setup();
    const beforeDesign = opened.database.sqlite.prepare(
      "SELECT current_version, current_revision_id FROM designs WHERE id = ?",
    ).get(opened.created.document.id);
    let result = opened.studio.createOneClickAssessment("local", {
      designId: opened.created.document.id,
      expectedDesignVersion: 1,
      brief: "Capture exact current-state evidence before proposing the redesign.",
    });
    expect(result.current.artifact).toEqual(createEmptyRedesignStageArtifact("connect_inspect"));
    expect(opened.studio.getStageArtifact("local", result.id, "connect_inspect")).toMatchObject({
      headVersion: 1,
      current: { assessmentVersion: 1, artifact: { stage: "connect_inspect" } },
    });

    result = advance(opened.studio, result, "document_current_state");
    const artifact = {
      ...createEmptyRedesignStageArtifact("document_current_state"),
      summary: "Checkout navigation and role constraints reviewed against the current product.",
      review_status: "ready_for_review" as const,
      inventory: [artifactItem("redesign_item_inventory001", "Checkout and payment screens")],
      navigation: [artifactItem("redesign_item_navigation001", "Cart to receipt navigation")],
      roles: [artifactItem("redesign_item_roles0000001", "Buyer and support roles")],
      accessibility_findings: [artifactItem("redesign_item_accessibility1", "Focus order gap")],
      localization_findings: [artifactItem("redesign_item_localization01", "RTL total alignment")],
    };
    const versionBeforeArtifact = result.currentVersion;
    result = opened.studio.reviseStageArtifact("local", result.id, {
      expectedVersion: versionBeforeArtifact,
      expectedDesignVersion: 1,
      stage: "document_current_state",
      artifact,
    });

    expect(result.currentVersion).toBe(versionBeforeArtifact + 1);
    expect(result.current.artifact).toEqual(artifact);
    expect(result.stageArtifacts.document_current_state).toEqual(artifact);
    expect(opened.studio.getStageArtifact("local", result.id, "document_current_state")).toMatchObject({
      headVersion: versionBeforeArtifact + 1,
      current: { assessmentVersion: versionBeforeArtifact + 1, artifact },
      versions: [
        { assessmentVersion: versionBeforeArtifact, artifact: { review_status: "draft" } },
        { assessmentVersion: versionBeforeArtifact + 1, artifact },
      ],
    });
    const persistedBefore = JSON.parse((opened.database.sqlite.prepare(
      "SELECT content_json FROM redesign_assessment_versions WHERE assessment_id = ? AND version = ?",
    ).get(result.id, versionBeforeArtifact) as { content_json: string }).content_json) as {
      stageArtifacts: { document_current_state: { inventory: unknown[] } };
    };
    expect(persistedBefore.stageArtifacts.document_current_state.inventory).toEqual([]);
    expect(opened.database.sqlite.prepare(
      "SELECT current_version, current_revision_id FROM designs WHERE id = ?",
    ).get(opened.created.document.id)).toEqual(beforeDesign);

    expect(captureThrown(() => opened.studio.reviseStageArtifact("local", result.id, {
      expectedVersion: versionBeforeArtifact,
      expectedDesignVersion: 1,
      stage: "document_current_state",
      artifact,
    }))).toMatchObject({ code: "VERSION_CONFLICT", statusCode: 409 });
    expect(captureThrown(() => opened.studio.reviseStageArtifact("local", result.id, {
      expectedVersion: result.currentVersion,
      expectedDesignVersion: 1,
      stage: "document_current_state",
      artifact: createEmptyRedesignStageArtifact("design"),
    }))).toMatchObject({ code: "VALIDATION_FAILED", statusCode: 422 });
  });

  it("blocks forward transitions until every required outcome is reviewed or approved", () => {
    const opened = setup();
    let result = opened.studio.createOneClickAssessment("local", {
      designId: opened.created.document.id,
      expectedDesignVersion: 1,
      brief: "Do not advance incomplete or unreviewed redesign evidence.",
    });

    expect(captureThrown(() => opened.studio.transition("local", result.id, {
      expectedVersion: result.currentVersion,
      expectedDesignVersion: 1,
      toStage: "document_current_state",
      decision: "advanced",
    }))).toMatchObject({
      code: "VALIDATION_FAILED",
      statusCode: 422,
      details: {
        stage: "connect_inspect",
        requiredReviewStatus: "reviewed",
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: "REDESIGN_STAGE_OUTCOME_REQUIRED", path: "inventory" }),
          expect.objectContaining({ code: "REDESIGN_STAGE_REVIEW_REQUIRED", path: "review_status" }),
        ]),
      },
    });
    expect(opened.studio.getAssessment("local", result.id).currentVersion).toBe(result.currentVersion);

    result = opened.studio.reviseStageArtifact("local", result.id, {
      expectedVersion: result.currentVersion,
      expectedDesignVersion: 1,
      stage: "connect_inspect",
      artifact: {
        ...completeStageArtifact("connect_inspect"),
        review_status: "ready_for_review",
      },
    });
    expect(captureThrown(() => opened.studio.transition("local", result.id, {
      expectedVersion: result.currentVersion,
      expectedDesignVersion: 1,
      toStage: "document_current_state",
      decision: "advanced",
    }))).toMatchObject({
      code: "VALIDATION_FAILED",
      details: {
        diagnostics: [expect.objectContaining({ code: "REDESIGN_STAGE_REVIEW_REQUIRED" })],
      },
    });

    const blockedAdvance = completeStageArtifact("connect_inspect");
    if (blockedAdvance.stage !== "connect_inspect") throw new Error("Expected connect/inspect artifact.");
    blockedAdvance.constraints[0] = {
      ...blockedAdvance.constraints[0]!,
      status: "blocked",
      priority: "critical",
    };
    result = opened.studio.reviseStageArtifact("local", result.id, {
      expectedVersion: result.currentVersion,
      expectedDesignVersion: 1,
      stage: "connect_inspect",
      artifact: blockedAdvance,
    });
    expect(captureThrown(() => opened.studio.transition("local", result.id, {
      expectedVersion: result.currentVersion,
      expectedDesignVersion: 1,
      toStage: "document_current_state",
      decision: "advanced",
    }))).toMatchObject({
      code: "VALIDATION_FAILED",
      details: {
        diagnostics: [expect.objectContaining({
          code: "REDESIGN_STAGE_ITEM_BLOCKED",
          itemStatus: "blocked",
          itemPriority: "critical",
        })],
      },
    });

    result = opened.studio.reviseStageArtifact("local", result.id, {
      expectedVersion: result.currentVersion,
      expectedDesignVersion: 1,
      stage: "connect_inspect",
      artifact: completeStageArtifact("connect_inspect"),
    });
    result = opened.studio.transition("local", result.id, {
      expectedVersion: result.currentVersion,
      expectedDesignVersion: 1,
      toStage: "document_current_state",
      decision: "advanced",
    });
    expect(result.currentStage).toBe("document_current_state");
  });

  it("allows design-only assessment work through the PM interview but blocks future-state entry without inventory mappings", () => {
    const opened = setup();
    let result = opened.studio.createOneClickAssessment("local", {
      designId: opened.created.document.id,
      expectedDesignVersion: 1,
      brief: "Keep early redesign discovery available before repository evidence is connected.",
    });
    result = advance(opened.studio, result, "document_current_state");
    result = advance(opened.studio, result, "pm_interview");
    result = opened.studio.reviseStageArtifact("local", result.id, {
      expectedVersion: result.currentVersion,
      expectedDesignVersion: 1,
      stage: "pm_interview",
      artifact: completeStageArtifact("pm_interview"),
    });

    expect(captureThrown(() => opened.studio.transition("local", result.id, {
      expectedVersion: result.currentVersion,
      expectedDesignVersion: 1,
      toStage: "future_state_proposal",
      decision: "advanced",
    }))).toMatchObject({
      code: "VALIDATION_FAILED",
      statusCode: 422,
      details: {
        diagnostics: [expect.objectContaining({ code: "REDESIGN_FUTURE_STATE_INVENTORY_PIN_REQUIRED" })],
      },
    });

    result = opened.studio.transition("local", result.id, {
      expectedVersion: result.currentVersion,
      expectedDesignVersion: 1,
      toStage: "document_current_state",
      decision: "returned",
    });
    expect(result.currentStage).toBe("document_current_state");
    result = opened.studio.transition("local", result.id, {
      expectedVersion: result.currentVersion,
      expectedDesignVersion: 1,
      toStage: "document_current_state",
      decision: "cancelled",
    });
    expect(result.status).toBe("cancelled");
  });

  it("enters future-state proposal only with an exact current inventory and verified immutable mapping", () => {
    const opened = setup();
    const source = prepareMappedSource(opened);
    let result = opened.studio.createOneClickAssessment("local", {
      designId: source.designId,
      inventoryId: source.inventory.id,
      expectedDesignVersion: source.designVersion,
      brief: "Require exact implementation evidence before proposing the future state.",
    });
    result = advance(opened.studio, result, "document_current_state");
    result = advance(opened.studio, result, "pm_interview");
    result = advance(opened.studio, result, "future_state_proposal");

    expect(result.currentStage).toBe("future_state_proposal");
    expect(result.current.base).toEqual({
      designVersion: source.designVersion,
      revisionId: source.revisionId,
      inventoryId: source.inventory.id,
    });
    expect(() => opened.database.sqlite.prepare(
      "UPDATE implementation_mappings SET mapping_json = '{}' WHERE id = ?",
    ).run(source.mapping.id)).toThrow(/immutable/);
  });

  it("rejects missing, stale, or integrity-mismatched mapping evidence at the future-state boundary", () => {
    const missingOpened = setup();
    const missingSource = prepareMappingSource(missingOpened);
    let missing = missingOpened.studio.createOneClickAssessment("local", {
      designId: missingSource.designId,
      inventoryId: missingSource.inventory.id,
      expectedDesignVersion: missingSource.designVersion,
      brief: "Do not accept inventory presence as a substitute for an implementation mapping.",
    });
    missing = advance(missingOpened.studio, missing, "document_current_state");
    missing = advance(missingOpened.studio, missing, "pm_interview");
    missing = missingOpened.studio.reviseStageArtifact("local", missing.id, {
      expectedVersion: missing.currentVersion,
      expectedDesignVersion: missingSource.designVersion,
      stage: "pm_interview",
      artifact: completeStageArtifact("pm_interview"),
    });
    expect(captureThrown(() => missingOpened.studio.transition("local", missing.id, {
      expectedVersion: missing.currentVersion,
      expectedDesignVersion: missingSource.designVersion,
      toStage: "future_state_proposal",
      decision: "advanced",
    }))).toMatchObject({
      code: "VALIDATION_FAILED",
      details: {
        diagnostics: [expect.objectContaining({ code: "REDESIGN_IMPLEMENTATION_MAPPING_REQUIRED" })],
      },
    });

    const staleOpened = setup();
    const staleSource = prepareMappedSource(staleOpened);
    let stale = staleOpened.studio.createOneClickAssessment("local", {
      designId: staleSource.designId,
      inventoryId: staleSource.inventory.id,
      expectedDesignVersion: staleSource.designVersion,
      brief: "Reject mappings whose selected repository inventory is no longer current.",
    });
    stale = advance(staleOpened.studio, stale, "document_current_state");
    stale = advance(staleOpened.studio, stale, "pm_interview");
    stale = staleOpened.studio.reviseStageArtifact("local", stale.id, {
      expectedVersion: stale.currentVersion,
      expectedDesignVersion: staleSource.designVersion,
      stage: "pm_interview",
      artifact: completeStageArtifact("pm_interview"),
    });
    staleOpened.database.sqlite.prepare(
      "UPDATE repository_inventories SET status = 'superseded' WHERE id = ?",
    ).run(staleSource.inventory.id);
    expect(captureThrown(() => staleOpened.studio.transition("local", stale.id, {
      expectedVersion: stale.currentVersion,
      expectedDesignVersion: staleSource.designVersion,
      toStage: "future_state_proposal",
      decision: "advanced",
    }))).toMatchObject({
      code: "VERSION_CONFLICT",
      details: {
        diagnostics: [expect.objectContaining({ code: "REDESIGN_BOUND_INVENTORY_NOT_CURRENT" })],
      },
    });

    const invalidOpened = setup();
    const invalidSource = prepareMappingSource(invalidOpened);
    const invalidMappingId = insertTamperedMappingEvidence(invalidOpened, invalidSource);
    let invalid = invalidOpened.studio.createOneClickAssessment("local", {
      designId: invalidSource.designId,
      inventoryId: invalidSource.inventory.id,
      expectedDesignVersion: invalidSource.designVersion,
      brief: "Reject an immutable mapping whose opaque source location was forged.",
    });
    invalid = advance(invalidOpened.studio, invalid, "document_current_state");
    invalid = advance(invalidOpened.studio, invalid, "pm_interview");
    invalid = invalidOpened.studio.reviseStageArtifact("local", invalid.id, {
      expectedVersion: invalid.currentVersion,
      expectedDesignVersion: invalidSource.designVersion,
      stage: "pm_interview",
      artifact: completeStageArtifact("pm_interview"),
    });
    expect(captureThrown(() => invalidOpened.studio.transition("local", invalid.id, {
      expectedVersion: invalid.currentVersion,
      expectedDesignVersion: invalidSource.designVersion,
      toStage: "future_state_proposal",
      decision: "advanced",
    }))).toMatchObject({
      code: "INTERNAL_ERROR",
      statusCode: 500,
      details: {
        diagnostics: [expect.objectContaining({
          code: "REDESIGN_IMPLEMENTATION_MAPPING_INTEGRITY_FAILED",
          invalidMappings: [expect.objectContaining({ mappingId: invalidMappingId, reason: "pin_mismatch" })],
        })],
      },
    });
  });

  it("requires explicit approval for handoff approval and final completion", () => {
    const opened = setup();
    const source = prepareMappedSource(opened);
    const designVersion = source.designVersion;
    let result = opened.studio.createOneClickAssessment("local", {
      designId: source.designId,
      inventoryId: source.inventory.id,
      expectedDesignVersion: designVersion,
      brief: "Require approved evidence at both implementation authorization boundaries.",
    });
    for (const stage of ["document_current_state", "pm_interview", "future_state_proposal", "design", "handoff"] as const) {
      result = advance(opened.studio, result, stage);
    }
    result = opened.studio.reviseStageArtifact("local", result.id, {
      expectedVersion: result.currentVersion,
      expectedDesignVersion: designVersion,
      stage: "handoff",
      artifact: completeStageArtifact("handoff"),
    });
    expect(captureThrown(() => opened.studio.transition("local", result.id, {
      expectedVersion: result.currentVersion,
      expectedDesignVersion: designVersion,
      toStage: "approved_implementation",
      decision: "approved",
    }))).toMatchObject({
      code: "VALIDATION_FAILED",
      details: {
        requiredReviewStatus: "approved",
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: "REDESIGN_STAGE_APPROVAL_REQUIRED" }),
          expect.objectContaining({ code: "REDESIGN_STAGE_ITEM_APPROVAL_REQUIRED" }),
        ]),
      },
    });
    const blockedHandoff = completeStageArtifact("handoff", "approved");
    if (blockedHandoff.stage !== "handoff") throw new Error("Expected handoff artifact.");
    blockedHandoff.risks[0] = { ...blockedHandoff.risks[0]!, status: "blocked" };
    result = opened.studio.reviseStageArtifact("local", result.id, {
      expectedVersion: result.currentVersion,
      expectedDesignVersion: designVersion,
      stage: "handoff",
      artifact: blockedHandoff,
    });
    expect(captureThrown(() => opened.studio.transition("local", result.id, {
      expectedVersion: result.currentVersion,
      expectedDesignVersion: designVersion,
      toStage: "approved_implementation",
      decision: "approved",
    }))).toMatchObject({
      code: "VALIDATION_FAILED",
      details: { diagnostics: [expect.objectContaining({ code: "REDESIGN_STAGE_ITEM_BLOCKED" })] },
    });
    result = opened.studio.reviseStageArtifact("local", result.id, {
      expectedVersion: result.currentVersion,
      expectedDesignVersion: designVersion,
      stage: "handoff",
      artifact: completeStageArtifact("handoff", "approved"),
    });
    result = opened.studio.transition("local", result.id, {
      expectedVersion: result.currentVersion,
      expectedDesignVersion: designVersion,
      toStage: "approved_implementation",
      decision: "approved",
    });
    result = opened.studio.reviseStageArtifact("local", result.id, {
      expectedVersion: result.currentVersion,
      expectedDesignVersion: designVersion,
      stage: "approved_implementation",
      artifact: completeStageArtifact("approved_implementation"),
    });
    expect(captureThrown(() => opened.studio.transition("local", result.id, {
      expectedVersion: result.currentVersion,
      expectedDesignVersion: designVersion,
      toStage: "approved_implementation",
      decision: "completed",
    }))).toMatchObject({
      code: "VALIDATION_FAILED",
      details: { diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "REDESIGN_STAGE_APPROVAL_REQUIRED" }),
        expect.objectContaining({ code: "REDESIGN_STAGE_ITEM_APPROVAL_REQUIRED" }),
      ]) },
    });
    const pendingImplementation = completeStageArtifact("approved_implementation", "approved");
    if (pendingImplementation.stage !== "approved_implementation") throw new Error("Expected implementation artifact.");
    pendingImplementation.validation_evidence[0] = {
      ...pendingImplementation.validation_evidence[0]!,
      status: "ready",
    };
    result = opened.studio.reviseStageArtifact("local", result.id, {
      expectedVersion: result.currentVersion,
      expectedDesignVersion: designVersion,
      stage: "approved_implementation",
      artifact: pendingImplementation,
    });
    expect(captureThrown(() => opened.studio.transition("local", result.id, {
      expectedVersion: result.currentVersion,
      expectedDesignVersion: designVersion,
      toStage: "approved_implementation",
      decision: "completed",
    }))).toMatchObject({
      code: "VALIDATION_FAILED",
      details: { diagnostics: [expect.objectContaining({ code: "REDESIGN_STAGE_ITEM_APPROVAL_REQUIRED" })] },
    });
    result = opened.studio.reviseStageArtifact("local", result.id, {
      expectedVersion: result.currentVersion,
      expectedDesignVersion: designVersion,
      stage: "approved_implementation",
      artifact: completeStageArtifact("approved_implementation", "approved"),
    });
    result = opened.studio.transition("local", result.id, {
      expectedVersion: result.currentVersion,
      expectedDesignVersion: designVersion,
      toStage: "approved_implementation",
      decision: "completed",
    });
    expect(result.status).toBe("completed");
  });

  it("revalidates bound sources for forward decisions without blocking return or cancellation", () => {
    const opened = setup();
    let designAssessment = opened.studio.createOneClickAssessment("local", {
      designId: opened.created.document.id,
      expectedDesignVersion: 1,
      brief: "Detect a stale bound design before another forward decision.",
    });
    designAssessment = advance(opened.studio, designAssessment, "document_current_state");
    const frameId = opened.created.document.pages[0]!.children[0]!;
    opened.designer.applyRevision("local", opened.created.document.id, {
      baseVersion: 1,
      operations: [{ type: "update_node", node_id: frameId, patch: { name: "Changed after assessment binding" } }],
      idempotencyKey: "redesign-stale-source-design",
    });

    designAssessment = opened.studio.transition("local", designAssessment.id, {
      expectedVersion: designAssessment.currentVersion,
      expectedDesignVersion: 1,
      toStage: "connect_inspect",
      decision: "returned",
    });
    expect(designAssessment.currentStage).toBe("connect_inspect");
    expect(captureThrown(() => opened.studio.transition("local", designAssessment.id, {
      expectedVersion: designAssessment.currentVersion,
      expectedDesignVersion: 2,
      toStage: "document_current_state",
      decision: "advanced",
    }))).toMatchObject({
      code: "VERSION_CONFLICT",
      statusCode: 409,
      details: {
        diagnostics: [expect.objectContaining({
          code: "REDESIGN_BOUND_DESIGN_NOT_CURRENT",
          boundDesignVersion: 1,
          currentDesignVersion: 2,
        })],
      },
    });
    designAssessment = opened.studio.transition("local", designAssessment.id, {
      expectedVersion: designAssessment.currentVersion,
      expectedDesignVersion: 1,
      toStage: "connect_inspect",
      decision: "cancelled",
    });
    expect(designAssessment.status).toBe("cancelled");

    const inventoryId = insertActiveInventory(opened.database, "stale-inventory");
    let inventoryAssessment = opened.studio.createOneClickAssessment("local", {
      inventoryId,
      brief: "Detect a repository inventory that is no longer current.",
    });
    inventoryAssessment = opened.studio.reviseStageArtifact("local", inventoryAssessment.id, {
      expectedVersion: inventoryAssessment.currentVersion,
      stage: "connect_inspect",
      artifact: completeStageArtifact("connect_inspect"),
    });
    opened.database.sqlite.prepare(
      "UPDATE repository_inventories SET status = 'superseded' WHERE id = ?",
    ).run(inventoryId);
    expect(captureThrown(() => opened.studio.transition("local", inventoryAssessment.id, {
      expectedVersion: inventoryAssessment.currentVersion,
      toStage: "document_current_state",
      decision: "advanced",
    }))).toMatchObject({
      code: "VERSION_CONFLICT",
      details: {
        diagnostics: [expect.objectContaining({
          code: "REDESIGN_BOUND_INVENTORY_NOT_CURRENT",
          inventoryId,
          status: "superseded",
        })],
      },
    });
    inventoryAssessment = opened.studio.transition("local", inventoryAssessment.id, {
      expectedVersion: inventoryAssessment.currentVersion,
      toStage: "connect_inspect",
      decision: "cancelled",
    });
    expect(inventoryAssessment.status).toBe("cancelled");
  });

  it("hides inventory-only assessments from project-restricted grants across reads and mutations", () => {
    const opened = setup();
    const inventoryId = insertActiveInventory(opened.database, "inventory-only-authorization");
    const assessment = opened.studio.createOneClickAssessment("local", {
      inventoryId,
      brief: "This organization-wide inventory assessment must not leak through a project grant.",
    });
    const restrictedActor = createGrant(
      opened.database,
      "redesign_inventory_project_restricted",
      ["redesign:read", "redesign:review"],
      [opened.created.document.id],
    );

    for (const action of [
      () => opened.studio.getAssessment(restrictedActor, assessment.id),
      () => opened.studio.getStageArtifact(restrictedActor, assessment.id, "connect_inspect"),
      () => opened.studio.reviseCurrentStage(restrictedActor, assessment.id, {
        expectedVersion: assessment.currentVersion,
        content: { forbidden: true },
      }),
      () => opened.studio.reviseStageArtifact(restrictedActor, assessment.id, {
        expectedVersion: assessment.currentVersion,
        stage: "connect_inspect",
        artifact: createEmptyRedesignStageArtifact("connect_inspect"),
      }),
    ]) {
      expect(captureThrown(action)).toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
    }
    expect(opened.studio.getAssessment("local", assessment.id).currentVersion).toBe(1);
  });

  it("persists the exact seven-stage flow with append-only versions and transitions", () => {
    const opened = setup();
    const source = prepareMappedSource(opened);
    let result = opened.studio.createOneClickAssessment("local", {
      designId: source.designId,
      inventoryId: source.inventory.id,
      expectedDesignVersion: source.designVersion,
      brief: "Redesign the product through independently reviewed stages.",
    });
    result = advance(opened.studio, result, "document_current_state");
    result = advance(opened.studio, result, "pm_interview");
    result = advance(opened.studio, result, "future_state_proposal");
    result = advance(opened.studio, result, "design");
    result = advance(opened.studio, result, "handoff");
    result = opened.studio.reviseStageArtifact("local", result.id, {
      expectedVersion: result.currentVersion,
      expectedDesignVersion: source.designVersion,
      stage: "handoff",
      artifact: completeStageArtifact("handoff", "approved"),
    });
    result = opened.studio.transition("local", result.id, {
      expectedVersion: result.currentVersion,
      expectedDesignVersion: source.designVersion,
      toStage: "approved_implementation",
      decision: "approved",
      content: { approval: "Product manager approved the reviewed handoff." },
    });
    result = opened.studio.reviseStageArtifact("local", result.id, {
      expectedVersion: result.currentVersion,
      expectedDesignVersion: source.designVersion,
      stage: "approved_implementation",
      artifact: completeStageArtifact("approved_implementation", "approved"),
    });
    result = opened.studio.transition("local", result.id, {
      expectedVersion: result.currentVersion,
      expectedDesignVersion: source.designVersion,
      toStage: "approved_implementation",
      decision: "completed",
      details: { outcome: "Implementation task may now close." },
    });

    expect(result.status).toBe("completed");
    expect(result.currentStage).toBe("approved_implementation");
    expect(result.currentVersion).toBe(15);
    expect(result.versions.at(-1)?.stage).toBe("approved_implementation");
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
    ).get(result.id)).toEqual({ count: 15 });
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
    expect(result.currentVersion).toBe(5);
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
    const source = prepareMappedSource(opened);
    const designId = source.designId;
    const designVersion = source.designVersion;
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
      expectedDesignVersion: designVersion,
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
      expectedDesignVersion: designVersion,
      toStage: "document_current_state",
      decision: "advanced",
    }))).toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
    result = opened.studio.reviseStageArtifact(reviewActor, result.id, {
      expectedVersion: result.currentVersion,
      expectedDesignVersion: designVersion,
      stage: "connect_inspect",
      artifact: completeStageArtifact("connect_inspect"),
    });
    result = opened.studio.transition(reviewActor, result.id, {
      expectedVersion: result.currentVersion,
      expectedDesignVersion: designVersion,
      toStage: "document_current_state",
      decision: "advanced",
    });
    expect(captureThrown(() => opened.studio.reviseStageArtifact(proposalActor, result.id, {
      expectedVersion: result.currentVersion,
      expectedDesignVersion: designVersion,
      stage: "document_current_state",
      artifact: createEmptyRedesignStageArtifact("document_current_state"),
    }))).toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
    result = opened.studio.reviseStageArtifact(reviewActor, result.id, {
      expectedVersion: result.currentVersion,
      expectedDesignVersion: designVersion,
      stage: "document_current_state",
      artifact: {
        ...createEmptyRedesignStageArtifact("document_current_state"),
        inventory: [artifactItem("redesign_item_scopedinv001", "Scoped inventory")],
      },
    });
    result = advance(opened.studio, result, "pm_interview");
    result = opened.studio.createOneClickAssessment("local", {
      designId,
      inventoryId: source.inventory.id,
      expectedDesignVersion: designVersion,
      brief: "Mapped redesign assessment for independently scoped proposal and implementation decisions.",
    });
    result = advance(opened.studio, result, "document_current_state");
    result = advance(opened.studio, result, "pm_interview");
    result = advance(opened.studio, result, "future_state_proposal");
    result = advance(opened.studio, result, "design");
    result = advance(opened.studio, result, "handoff");
    expect(captureThrown(() => opened.studio.transition(implementActor, result.id, {
      expectedVersion: result.currentVersion,
      expectedDesignVersion: designVersion,
      toStage: "approved_implementation",
      decision: "approved",
    }))).toMatchObject({ code: "FORBIDDEN", statusCode: 403 });

    result = opened.studio.reviseStageArtifact("local", result.id, {
      expectedVersion: result.currentVersion,
      expectedDesignVersion: designVersion,
      stage: "handoff",
      artifact: completeStageArtifact("handoff", "approved"),
    });
    result = opened.studio.transition(approveActor, result.id, {
      expectedVersion: result.currentVersion,
      expectedDesignVersion: designVersion,
      toStage: "approved_implementation",
      decision: "approved",
    });
    expect(captureThrown(() => opened.studio.transition(approveActor, result.id, {
      expectedVersion: result.currentVersion,
      expectedDesignVersion: designVersion,
      toStage: "approved_implementation",
      decision: "completed",
    }))).toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
    result = opened.studio.reviseStageArtifact(implementActor, result.id, {
      expectedVersion: result.currentVersion,
      expectedDesignVersion: designVersion,
      stage: "approved_implementation",
      artifact: completeStageArtifact("approved_implementation", "approved"),
    });
    result = opened.studio.transition(implementActor, result.id, {
      expectedVersion: result.currentVersion,
      expectedDesignVersion: designVersion,
      toStage: "approved_implementation",
      decision: "completed",
    });
    expect(result.status).toBe("completed");
  });
});
