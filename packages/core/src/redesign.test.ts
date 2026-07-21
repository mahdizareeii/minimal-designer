import { describe, expect, it } from "vitest";

import {
  REDESIGN_ARTIFACT_COLLECTIONS,
  RedesignStageArtifactMapSchema,
  RedesignStageArtifactSchema,
  createEmptyRedesignStageArtifact,
  evaluateRedesignStageReadiness,
} from "./redesign.js";

function item(id: string, title: string) {
  return {
    id,
    title,
    description: "Reviewed evidence",
    status: "reviewed" as const,
    priority: "normal" as const,
    evidence: [],
    linked_ids: [],
  };
}

describe("redesign stage artifacts", () => {
  it("creates strict empty drafts for every persisted stage", () => {
    for (const stage of Object.keys(REDESIGN_ARTIFACT_COLLECTIONS) as Array<keyof typeof REDESIGN_ARTIFACT_COLLECTIONS>) {
      const artifact = createEmptyRedesignStageArtifact(stage);
      expect(artifact).toMatchObject({ schema_version: 1, stage, review_status: "draft", summary: "" });
      for (const collection of REDESIGN_ARTIFACT_COLLECTIONS[stage]) {
        expect((artifact as unknown as Record<string, unknown>)[collection]).toEqual([]);
      }
    }
  });

  it("requires explicit outcomes in every stage collection before review", () => {
    const draft = createEmptyRedesignStageArtifact("document_current_state");
    const incomplete = RedesignStageArtifactSchema.safeParse({
      ...draft,
      review_status: "ready_for_review",
      inventory: [item("redesign_item_inventory001", "Screen inventory")],
    });
    expect(incomplete.success).toBe(false);
    if (!incomplete.success) {
      expect(incomplete.error.issues.map((issue) => issue.path[0])).toEqual(expect.arrayContaining([
        "navigation",
        "roles",
        "accessibility_findings",
        "localization_findings",
      ]));
    }
  });

  it("rejects duplicate stable item ids and mismatched stage-map keys", () => {
    const duplicateId = "redesign_item_duplicate001";
    const artifact = {
      ...createEmptyRedesignStageArtifact("connect_inspect"),
      inventory: [item(duplicateId, "Inventory")],
      source_connections: [item(duplicateId, "Connection")],
    };
    expect(RedesignStageArtifactSchema.safeParse(artifact).success).toBe(false);
    expect(RedesignStageArtifactMapSchema.safeParse({ document_current_state: artifact }).success).toBe(false);
  });

  it("reports structured transition diagnostics for missing outcomes and review state", () => {
    const draft = createEmptyRedesignStageArtifact("connect_inspect");
    const draftReadiness = evaluateRedesignStageReadiness(draft, "reviewed");
    expect(draftReadiness.ready).toBe(false);
    expect(draftReadiness.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "REDESIGN_STAGE_OUTCOME_REQUIRED", path: "inventory" }),
      expect.objectContaining({ code: "REDESIGN_STAGE_OUTCOME_REQUIRED", path: "source_connections" }),
      expect.objectContaining({ code: "REDESIGN_STAGE_OUTCOME_REQUIRED", path: "constraints" }),
      expect.objectContaining({ code: "REDESIGN_STAGE_REVIEW_REQUIRED", path: "review_status" }),
    ]));

    const reviewed = {
      ...draft,
      review_status: "reviewed" as const,
      inventory: [item("redesign_item_readyinventory", "Inventory")],
      source_connections: [item("redesign_item_readyconnection", "Connection")],
      constraints: [item("redesign_item_readyconstraint", "Constraint")],
    };
    expect(evaluateRedesignStageReadiness(reviewed, "reviewed")).toMatchObject({ ready: true, diagnostics: [] });
    expect(evaluateRedesignStageReadiness(reviewed, "approved")).toMatchObject({
      ready: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "REDESIGN_STAGE_ITEM_APPROVAL_REQUIRED" }),
        expect.objectContaining({ code: "REDESIGN_STAGE_APPROVAL_REQUIRED" }),
      ]),
    });

    const blocked = {
      ...reviewed,
      review_status: "approved" as const,
      constraints: [{ ...item("redesign_item_blockedconstraint", "Blocked constraint"), status: "blocked" as const, priority: "critical" as const }],
    };
    expect(evaluateRedesignStageReadiness(blocked, "reviewed")).toMatchObject({
      ready: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "REDESIGN_STAGE_ITEM_BLOCKED",
          itemId: "redesign_item_blockedconstraint",
          itemStatus: "blocked",
          itemPriority: "critical",
        }),
      ]),
    });

    const approved = {
      ...reviewed,
      review_status: "approved" as const,
      inventory: [{ ...reviewed.inventory[0]!, status: "approved" as const }],
      source_connections: [{ ...reviewed.source_connections[0]!, status: "resolved" as const }],
      constraints: [{ ...reviewed.constraints[0]!, status: "approved" as const }],
    };
    expect(evaluateRedesignStageReadiness(approved, "approved")).toMatchObject({ ready: true, diagnostics: [] });
  });
});
