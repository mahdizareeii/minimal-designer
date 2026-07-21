import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HandoffExecutionReview,
  handoffCompletionReadiness,
  handoffMutationErrorMessage,
  handoffStartReadiness,
  requiredHandoffValidationChecks,
} from "../components/EngineeringHandoffPanel";
import {
  ApiError,
  approveEngineeringHandoff,
  completeEngineeringHandoff,
  HANDOFF_EXECUTION_DECISION_KINDS,
  readEngineeringHandoff,
  readHandoffExecutionDecisions,
  recordHandoffExecutionDecision,
  startEngineeringHandoffImplementation,
  type EngineeringHandoffRecord,
  type HandoffExecutionDecisionKind,
  type HandoffExecutionDecisionOutcome,
  type HandoffExecutionDecisionRecord,
  type HandoffExecutionDecisionState,
} from "../lib/api";

afterEach(() => vi.restoreAllMocks());

function decision(
  kind: HandoffExecutionDecisionKind,
  outcome: HandoffExecutionDecisionOutcome,
  evidence: Record<string, unknown>,
  sequence: number,
): HandoffExecutionDecisionRecord {
  return {
    id: `handoff_decision_${String(sequence).padStart(32, "0")}`,
    handoffId: "handoff_execution_ui_0001",
    handoffVersion: 3,
    sequence,
    kind,
    outcome,
    supersedesDecisionId: null,
    evidence,
    evidenceHash: String(sequence).repeat(64).slice(0, 64),
    actorId: kind === "diff_review" || kind === "validation_approval" || kind === "isolation_choice"
      ? "principal_engineer"
      : "principal_product_manager",
    createdAt: `2026-07-21T10:0${sequence}:00.000Z`,
  };
}

function decisionState(rows: readonly HandoffExecutionDecisionRecord[]): HandoffExecutionDecisionState {
  const state = Object.fromEntries(HANDOFF_EXECUTION_DECISION_KINDS.map((kind) => [kind, null])) as HandoffExecutionDecisionState;
  for (const row of rows) state[row.kind] = row;
  return state;
}

function implementingHandoff(rows: HandoffExecutionDecisionRecord[]): EngineeringHandoffRecord {
  return {
    id: "handoff_execution_ui_0001",
    designId: "design_execution_ui_0001",
    revisionId: "revision_execution_ui_0001",
    designVersion: 9,
    inventoryId: "inventory_11111111111111111111111111111111",
    status: "implementing",
    currentVersion: 3,
    specification: {
      title: "Implement reviewed checkout",
      implementationSlices: [{ validationChecks: ["typecheck", "unit_tests", "build"] }],
    },
    versions: [],
    transitions: [],
    executionDecisions: rows,
    executionDecisionState: decisionState(rows),
    createdBy: "principal_product_manager",
    createdAt: "2026-07-21T09:00:00.000Z",
    updatedAt: "2026-07-21T10:00:00.000Z",
  };
}

function completeRows(): HandoffExecutionDecisionRecord[] {
  const diffHash = "a".repeat(64);
  return [
    decision("plan_approval", "approved", {
      summary: "Reviewed plan.",
      acceptanceCriteriaConfirmed: true,
      implementationPlanConfirmed: true,
    }, 1),
    decision("isolation_choice", "worktree", { summary: "Use an isolated worktree." }, 2),
    decision("diff_review", "approved", { summary: "Reviewed bounded diff.", diffHash, changedFileCount: 3 }, 3),
    decision("validation_approval", "approved", {
      summary: "Required validation passed.",
      checks: ["typecheck", "unit_tests", "build"].map((name) => ({ name, status: "passed" })),
    }, 4),
    decision("commit_approval", "approved", {
      summary: "Approve exact reviewed diff.",
      diffHash,
      commitMessage: "Implement approved checkout",
    }, 5),
    decision("push_authorization", "denied", { reason: "Keep the approved commit local." }, 6),
    decision("pull_request_request", "not_requested", { reason: "No pull request was requested." }, 7),
  ];
}

describe("engineering handoff execution review", () => {
  it("derives start and completion only from current immutable gate state", () => {
    const rows = completeRows();
    const current = decisionState(rows);
    expect(handoffStartReadiness(current)).toEqual({ ready: true, missingOrBlocked: [], integrityIssues: [] });
    expect(requiredHandoffValidationChecks(implementingHandoff(rows).specification)).toEqual([
      "typecheck",
      "unit_tests",
      "build",
    ]);
    expect(handoffCompletionReadiness(current, ["typecheck", "unit_tests", "build"])).toEqual({
      ready: true,
      missingOrBlocked: [],
      integrityIssues: [],
    });

    const revokedDiff = decisionState(rows.map((row) => row.kind === "diff_review"
      ? { ...row, outcome: "revoked", evidence: { reason: "Workspace changed after review." } }
      : row));
    expect(handoffCompletionReadiness(revokedDiff, ["typecheck", "unit_tests", "build"])).toMatchObject({
      ready: false,
      missingOrBlocked: ["diff_review"],
    });

    const mismatchedCommit = decisionState(rows.map((row) => row.kind === "commit_approval"
      ? { ...row, evidence: { ...row.evidence, diffHash: "b".repeat(64) } }
      : row));
    expect(handoffCompletionReadiness(mismatchedCommit, ["typecheck", "unit_tests", "build"]).integrityIssues)
      .toContain("Commit approval does not reference the current reviewed diff.");
  });

  it("renders all seven role-scoped controls, immutable history, and explicit negative dispositions", () => {
    const rows = completeRows();
    const markup = renderToStaticMarkup(
      <HandoffExecutionReview handoff={implementingHandoff(rows)} onHandoffChanged={() => undefined} />,
    );

    for (const label of [
      "Plan approval",
      "Isolation",
      "Diff review",
      "Validation",
      "Commit approval",
      "Push disposition",
      "Pull request disposition",
    ]) expect(markup).toContain(label);
    expect(markup).toContain("Keep the approved commit local.");
    expect(markup).toContain("No pull request was requested.");
    expect(markup).toContain("All seven current dispositions satisfy completion rules.");
    expect(markup).toContain("Immutable decision history");
    expect(markup).not.toMatch(/sourcePath|workspacePath|\/Users\/|C:\\Users\\|password=|token=/i);
  });

  it("keeps lifecycle actions disabled until their persisted gate requirements are current", () => {
    const plan = completeRows()[0]!;
    const approved = {
      ...implementingHandoff([plan]),
      status: "approved" as const,
      executionDecisionState: decisionState([plan]),
    };
    const approvedMarkup = renderToStaticMarkup(
      <HandoffExecutionReview handoff={approved} onHandoffChanged={() => undefined} />,
    );
    expect(approvedMarkup).toContain("Start is blocked by: isolation_choice.");
    expect(approvedMarkup).toMatch(/<button class="button button-primary" type="button" disabled="">[\s\S]*Authorize implementation stage/);

    const implementingMarkup = renderToStaticMarkup(
      <HandoffExecutionReview handoff={implementingHandoff([plan])} onHandoffChanged={() => undefined} />,
    );
    expect(implementingMarkup).toContain("Completion is blocked by:");
    expect(implementingMarkup).toMatch(/aria-label="Implementation completion summary"[\s\S]*<button class="button button-primary" type="button" disabled="">[\s\S]*Complete from decisions/);
  });

  it("uses strict HTTP payloads with decision CAS, idempotency, and summary-only completion", async () => {
    const rows = completeRows();
    const handoff = implementingHandoff(rows);
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ decisions: rows, current: decisionState(rows) }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ decision: rows[2] }), { status: 201, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ handoff: { ...handoff, status: "approved" } }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ handoff }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ handoff: { ...handoff, status: "completed" } }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ handoff }), { status: 200, headers: { "content-type": "application/json" } }));

    await readHandoffExecutionDecisions(handoff.id);
    await recordHandoffExecutionDecision(handoff.id, {
      expectedVersion: 3,
      expectedPriorDecisionId: rows[2]!.id,
      idempotencyKey: "handoff-ui-diff-fixed-retry-key",
      kind: "diff_review",
      outcome: "approved",
      evidence: { summary: "Reviewed replacement diff.", diffHash: "c".repeat(64), changedFileCount: 4 },
    });
    await approveEngineeringHandoff(handoff.id, 3, rows[0]!.id, "Approve reviewed handoff plan.");
    await startEngineeringHandoffImplementation(handoff.id, 3);
    await completeEngineeringHandoff(handoff.id, 3, "Complete from immutable decisions.");
    await readEngineeringHandoff(handoff.id);

    expect(fetch.mock.calls[0]?.[0]).toBe(`/api/handoffs/${handoff.id}/execution-decisions`);
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      expectedVersion: 3,
      expectedPriorDecisionId: rows[2]!.id,
      idempotencyKey: "handoff-ui-diff-fixed-retry-key",
      kind: "diff_review",
      outcome: "approved",
      evidence: { summary: "Reviewed replacement diff.", diffHash: "c".repeat(64), changedFileCount: 4 },
    });
    expect(JSON.parse(String(fetch.mock.calls[2]?.[1]?.body))).toEqual({
      expectedVersion: 3,
      expectedPriorDecisionId: rows[0]!.id,
      decision: "approved",
      summary: "Approve reviewed handoff plan.",
      acceptanceCriteriaConfirmed: true,
      implementationPlanConfirmed: true,
    });
    expect(JSON.parse(String(fetch.mock.calls[3]?.[1]?.body))).toEqual({
      expectedVersion: 3,
      approvedVersion: 3,
      authorization: "start_implementation",
    });
    const completion = JSON.parse(String(fetch.mock.calls[4]?.[1]?.body));
    expect(completion).toEqual({ expectedVersion: 3, summary: "Complete from immutable decisions." });
    expect(completion).not.toHaveProperty("diffReviewed");
    expect(completion).not.toHaveProperty("validationApproved");
    expect(completion).not.toHaveProperty("commitApproved");
    expect(completion).not.toHaveProperty("pullRequestRequested");
    expect(fetch.mock.calls[5]?.[0]).toBe(`/api/handoffs/${handoff.id}`);
  });

  it("surfaces role and structured CAS conflicts without implying authority", () => {
    expect(handoffMutationErrorMessage(new ApiError("Denied", { code: "FORBIDDEN", status: 403 })))
      .toContain("organization role is not authorized");
    expect(handoffMutationErrorMessage(new ApiError("Changed", {
      code: "VERSION_CONFLICT",
      status: 409,
      details: { currentDecisionId: "handoff_decision_latest0000000000000000000000" },
    }))).toContain("changed concurrently");
    expect(handoffMutationErrorMessage(new ApiError("Blocked", {
      code: "VERSION_CONFLICT",
      status: 409,
      details: { missingOrBlocked: ["diff_review", "commit_approval"] },
    }))).toContain("diff_review, commit_approval");
  });
});
