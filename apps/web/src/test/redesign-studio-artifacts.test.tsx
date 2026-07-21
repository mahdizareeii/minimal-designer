import { createEmptyRedesignStageArtifact, type RedesignArtifactItem } from "@designer/core";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RedesignArtifactOverview,
  redesignArtifactSections,
  redesignTransitionAvailability,
} from "../components/RedesignStudio";
import { readRedesignStageArtifact, reviseRedesignStageArtifact } from "../lib/api";

function item(id: string, title: string): RedesignArtifactItem {
  return {
    id,
    title,
    description: `${title} detail`,
    status: "reviewed",
    priority: "high",
    evidence: [],
    linked_ids: [],
  };
}

afterEach(() => vi.restoreAllMocks());

describe("Redesign Studio artifact review UI", () => {
  it("presents the concrete future-state deliverables instead of one free-form notes box", () => {
    const artifact = {
      ...createEmptyRedesignStageArtifact("future_state_proposal"),
      summary: "Reviewed target experience",
      principles: [item("redesign_item_webprinciple1", "Make critical state visible")],
      migration_phases: [item("redesign_item_webmigration1", "Foundation migration")],
      engineering_epics: [item("redesign_item_webepic00001", "Checkout modernization")],
      risks: [item("redesign_item_webrisk000001", "Dual-system rollout")],
      open_questions: [item("redesign_item_webquestion01", "Who approves support overrides?")],
    };
    expect(redesignArtifactSections(artifact).map((section) => section.key)).toEqual([
      "principles",
      "target_system",
      "token_proposals",
      "component_consolidation",
      "screen_plans",
      "migration_phases",
      "engineering_epics",
      "risks",
      "open_questions",
    ]);
    const markup = renderToStaticMarkup(<RedesignArtifactOverview artifact={artifact} />);
    expect(markup).toContain("Design principles");
    expect(markup).toContain("Migration phases");
    expect(markup).toContain("Engineering epics");
    expect(markup).toContain("Checkout modernization");
    expect(markup).toContain("Not recorded yet");
  });

  it("uses the stage-specific CAS read and write endpoints", async () => {
    const artifact = {
      ...createEmptyRedesignStageArtifact("connect_inspect"),
      inventory: [item("redesign_item_webinventory1", "Bounded design inventory")],
    };
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ assessment: { id: "redesign_httpfixture" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        stageArtifact: {
          assessmentId: "redesign_httpfixture",
          stage: "connect_inspect",
          headVersion: 4,
          sourceMutation: "none",
          current: null,
          versions: [],
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));

    await reviseRedesignStageArtifact({
      assessmentId: "redesign_httpfixture",
      expectedVersion: 3,
      expectedDesignVersion: 7,
      stage: "connect_inspect",
      artifact,
    });
    await readRedesignStageArtifact("redesign_httpfixture", "connect_inspect");

    expect(fetch.mock.calls[0]?.[0]).toBe("/api/redesign-assessments/redesign_httpfixture/stages/connect_inspect/artifact");
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("PUT");
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      expectedVersion: 3,
      expectedDesignVersion: 7,
      artifact,
    });
    expect(fetch.mock.calls[1]?.[0]).toBe("/api/redesign-assessments/redesign_httpfixture/stages/connect_inspect/artifact");
  });

  it("disables forward actions with an explanation until the saved artifact reaches the required review state", () => {
    const draft = createEmptyRedesignStageArtifact("connect_inspect");
    expect(redesignTransitionAvailability(draft, "advanced")).toMatchObject({
      available: false,
      disabled: true,
      requirement: "reviewed",
      reason: expect.stringContaining("3 required collections"),
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "REDESIGN_STAGE_REVIEW_REQUIRED" }),
      ]),
    });

    const reviewed = {
      ...draft,
      review_status: "reviewed" as const,
      inventory: [item("redesign_item_webreadyinv", "Inventory reviewed")],
      source_connections: [item("redesign_item_webreadyconn", "Connection reviewed")],
      constraints: [item("redesign_item_webreadyrule", "Constraint reviewed")],
    };
    expect(redesignTransitionAvailability(reviewed, "advanced")).toMatchObject({
      available: true,
      disabled: false,
      reason: null,
    });
    expect(redesignTransitionAvailability(reviewed, "approved")).toMatchObject({
      available: false,
      disabled: true,
      requirement: "approved",
      reason: expect.stringContaining("Approved"),
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "REDESIGN_STAGE_ITEM_APPROVAL_REQUIRED" }),
        expect.objectContaining({ code: "REDESIGN_STAGE_APPROVAL_REQUIRED" }),
      ]),
    });

    const blocked = {
      ...reviewed,
      review_status: "approved" as const,
      constraints: [{ ...reviewed.constraints[0]!, status: "blocked" as const }],
    };
    expect(redesignTransitionAvailability(blocked, "completed")).toMatchObject({
      available: false,
      disabled: true,
      reason: expect.stringContaining("resolve 1 blocked item"),
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "REDESIGN_STAGE_ITEM_BLOCKED" }),
      ]),
    });
  });
});
