import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { loadConfig } from "./config.js";
import {
  HANDOFF_EXECUTION_DECISION_SCOPES,
  type HandoffResult,
  type UploadRepositoryInventory,
} from "./workspace-handoff-service.js";

const applications: DesignerApplication[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.promises.rm(directory, { recursive: true, force: true })
  )));
});

async function localApplication(): Promise<DesignerApplication> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "formaspec-handoff-public-"));
  temporaryDirectories.push(root);
  const application = await buildApplication(loadConfig({
    APP_MODE: "local",
    HOST: "127.0.0.1",
    PORT: "4310",
    DATA_DIR: path.join(root, "data"),
    BACKUP_DIR: path.join(root, "backups"),
    DESIGNER_DATABASE_PATH: ":memory:",
    PUBLIC_BASE_URL: "http://127.0.0.1:4310",
    AUTH_MODE: "none",
    FORMASPEC_ALLOW_SOFTWARE_RENDERER: "true",
    DESIGNER_LOG_LEVEL: "silent",
  }));
  applications.push(application);
  await application.app.ready();
  return application;
}

function inventory(): UploadRepositoryInventory {
  return {
    schemaVersion: 1,
    repositoryFingerprint: "a".repeat(64),
    generatedAt: "2026-07-21T09:00:00.000Z",
    platforms: ["web"],
    gitHead: "b".repeat(40),
    excludedPatterns: [".env", ".env.*", "*.pem", "*.key", "**/secrets/**", "**/.git/**"],
    scannedFileCount: 1,
    skippedFileCount: 0,
    bytesRead: 128,
    truncated: false,
    entities: [{
      id: `inv_${"1".repeat(40)}`,
      kind: "component",
      name: "CheckoutScreen",
      symbol: "CheckoutScreen",
      locationId: `loc_${"2".repeat(40)}`,
      line: 12,
    }],
    excluded: [],
  };
}

function createReviewHandoff(application: DesignerApplication, suffix: string): HandoffResult {
  const created = application.service.createDesign("local", {
    name: `Handoff public fixture ${suffix}`,
    preset: "web",
    idempotencyKey: `handoff-public-design-${suffix}`,
  });
  const persistedInventory = application.handoffs.persistRepositoryInventory("local", inventory());
  let handoff = application.handoffs.createHandoff("local", {
    designId: created.document.id,
    revisionId: created.revision.id,
    expectedDesignVersion: 1,
    inventoryId: persistedInventory.id,
    specification: {
      schemaVersion: 1,
      title: "Implement the approved checkout",
      summary: "Implement one bounded checkout slice from the immutable design handoff.",
      acceptanceCriteria: [{
        id: "checkout_matches",
        statement: "The checkout matches the approved design.",
        designEntityIds: [],
      }],
      implementationSlices: [{
        id: "checkout_slice",
        title: "Checkout screen",
        objective: "Implement the checkout screen without unrelated source changes.",
        inventoryEntityIds: [`inv_${"1".repeat(40)}`],
        designEntityIds: [],
        dependsOn: [],
        validationChecks: ["typecheck"],
      }],
      risks: [],
      openQuestions: [],
      implementationPolicy: {
        preferredIsolation: "worktree",
        commitRequiresExplicitApproval: true,
        pullRequestRequiresExplicitRequest: true,
      },
    },
  });
  handoff = application.handoffs.submitHandoffForReview("local", handoff.id, {
    expectedVersion: 1,
    summary: "Ready for explicit execution decisions.",
  });
  return handoff;
}

function approveAndStart(application: DesignerApplication, handoff: HandoffResult): HandoffResult {
  let current = application.handoffs.approveHandoff("local", handoff.id, {
    expectedVersion: 1,
    expectedPriorDecisionId: null,
    decision: "approved",
    summary: "Approve the exact plan and acceptance criteria.",
    acceptanceCriteriaConfirmed: true,
    implementationPlanConfirmed: true,
  });
  application.handoffs.recordHandoffExecutionDecision("local", handoff.id, {
    expectedVersion: 1,
    expectedPriorDecisionId: null,
    idempotencyKey: `public-isolation-${handoff.id}`,
    kind: "isolation_choice",
    outcome: "worktree",
    evidence: { summary: "Use the approved isolated worktree." },
  });
  current = application.handoffs.startHandoffImplementation("local", handoff.id, {
    expectedVersion: 1,
    approvedVersion: 1,
    authorization: "start_implementation",
  });
  return current;
}

function installAgentGrant(
  application: DesignerApplication,
  id: string,
  projectId: string,
  scopes: string[],
): string {
  const principalId = `principal_${id}`;
  const token = `fsg_${id}_handoff_public_token`;
  const now = "2026-07-21T09:00:00.000Z";
  application.database.sqlite.prepare(
    `INSERT INTO principals (id, organization_id, kind, display_name, external_id, created_at)
     VALUES (?, 'organization_legacy', 'agent', ?, ?, ?)`,
  ).run(principalId, id, `handoff-public:${id}`, now);
  application.database.sqlite.prepare(
    `INSERT INTO memberships (organization_id, principal_id, role, created_at)
     VALUES ('organization_legacy', ?, 'agent', ?)`,
  ).run(principalId, now);
  application.database.sqlite.prepare(
    `INSERT INTO agent_connections
     (id, organization_id, principal_id, adapter, display_name, status, scopes_json, project_ids_json,
      expires_at, created_at, updated_at)
     VALUES (?, 'organization_legacy', ?, 'generic_mcp', ?, 'active', ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`,
  ).run(`connection_${id}`, principalId, id, JSON.stringify(scopes), JSON.stringify([projectId]), now, now);
  application.database.sqlite.prepare(
    `INSERT INTO agent_grants
     (id, organization_id, principal_id, token_hash, scopes_json, project_ids_json, created_at, expires_at)
     VALUES (?, 'organization_legacy', ?, ?, ?, ?, ?, '2099-01-01T00:00:00.000Z')`,
  ).run(
    id,
    principalId,
    createHash("sha256").update(token).digest("hex"),
    JSON.stringify(scopes),
    JSON.stringify([projectId]),
    now,
  );
  return token;
}

function mcpRequest(
  application: DesignerApplication,
  token: string | null,
  payload: Record<string, unknown>,
) {
  return application.app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    payload,
  });
}

function mcpDecision(
  application: DesignerApplication,
  token: string,
  handoffId: string,
  decision: Record<string, unknown>,
) {
  return mcpRequest(application, token, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "handoff_execution_decision_record",
      arguments: { handoff_id: handoffId, decision },
    },
  });
}

describe("handoff execution-decision public interfaces", () => {
  it("exposes strict HTTP CAS/idempotency state and derives completion from persisted decisions", async () => {
    const application = await localApplication();
    const handoff = approveAndStart(application, createReviewHandoff(application, "http-0001"));
    const url = `/api/handoffs/${handoff.id}/execution-decisions`;
    const diffHash = "c".repeat(64);
    const diffDecision = {
      expectedVersion: 1,
      expectedPriorDecisionId: null,
      idempotencyKey: "public-http-diff-0001",
      kind: "diff_review",
      outcome: "approved",
      evidence: {
        summary: "Reviewed the exact bounded implementation diff.",
        diffHash,
        changedFileCount: 2,
      },
    };

    const unknownField = await application.app.inject({
      method: "POST",
      url,
      payload: { ...diffDecision, sourcePath: "/private/company/Checkout.tsx" },
    });
    expect(unknownField.statusCode).toBe(422);
    expect(unknownField.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_FAILED");

    const unknownEvidenceField = await application.app.inject({
      method: "POST",
      url,
      payload: {
        ...diffDecision,
        evidence: {
          ...diffDecision.evidence,
          sourcePath: "/private/company/Checkout.tsx",
        },
      },
    });
    expect(unknownEvidenceField.statusCode).toBe(422);
    expect(unknownEvidenceField.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_FAILED");

    const legacyCompletion = await application.app.inject({
      method: "POST",
      url: `/api/handoffs/${handoff.id}/complete`,
      payload: {
        expectedVersion: 1,
        summary: "Legacy self-asserted completion must fail.",
        diffReviewed: true,
        validationApproved: true,
        commitApproved: true,
        pullRequestRequested: false,
      },
    });
    expect(legacyCompletion.statusCode).toBe(422);
    expect(legacyCompletion.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_FAILED");

    const incomplete = await application.app.inject({
      method: "POST",
      url: `/api/handoffs/${handoff.id}/complete`,
      payload: { expectedVersion: 1, summary: "Persisted execution gates are still missing." },
    });
    expect(incomplete.statusCode).toBe(409);
    expect(incomplete.json<{ error: { code: string; details: { missingOrBlocked: string[] } } }>().error)
      .toMatchObject({
        code: "VERSION_CONFLICT",
        details: {
          missingOrBlocked: [
            "diff_review",
            "validation_approval",
            "commit_approval",
            "push_authorization",
            "pull_request_request",
          ],
        },
      });

    const created = await application.app.inject({ method: "POST", url, payload: diffDecision });
    expect(created.statusCode).toBe(201);
    const firstDecision = created.json<{ decision: { id: string; kind: string; evidenceHash: string } }>().decision;
    expect(firstDecision).toMatchObject({
      id: expect.stringMatching(/^handoff_decision_/),
      kind: "diff_review",
      evidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    const replay = await application.app.inject({ method: "POST", url, payload: diffDecision });
    expect(replay.statusCode).toBe(201);
    expect(replay.json<{ decision: { id: string } }>().decision.id).toBe(firstDecision.id);

    const reusedKey = await application.app.inject({
      method: "POST",
      url,
      payload: {
        ...diffDecision,
        evidence: { ...diffDecision.evidence, changedFileCount: 3 },
      },
    });
    expect(reusedKey.statusCode).toBe(409);
    expect(reusedKey.json<{ error: { code: string } }>().error.code).toBe("IDEMPOTENCY_CONFLICT");

    const staleCas = await application.app.inject({
      method: "POST",
      url,
      payload: { ...diffDecision, idempotencyKey: "public-http-diff-0002" },
    });
    expect(staleCas.statusCode).toBe(409);
    expect(staleCas.json<{ error: { code: string; details: { currentDecisionId: string } } }>().error)
      .toMatchObject({ code: "VERSION_CONFLICT", details: { currentDecisionId: firstDecision.id } });

    const remaining = [
      {
        idempotencyKey: "public-http-validation-0001",
        kind: "validation_approval",
        outcome: "approved",
        evidence: {
          summary: "The required validation passed.",
          checks: [{ name: "typecheck", status: "passed" }],
        },
      },
      {
        idempotencyKey: "public-http-commit-0001",
        kind: "commit_approval",
        outcome: "approved",
        evidence: { summary: "Approve the reviewed diff for commit.", diffHash, commitMessage: "Implement checkout handoff" },
      },
      {
        idempotencyKey: "public-http-push-0001",
        kind: "push_authorization",
        outcome: "denied",
        evidence: { reason: "Keep the approved commit local." },
      },
      {
        idempotencyKey: "public-http-pr-0001",
        kind: "pull_request_request",
        outcome: "not_requested",
        evidence: { reason: "No pull request was requested." },
      },
    ];
    for (const decision of remaining) {
      const response = await application.app.inject({
        method: "POST",
        url,
        payload: {
          expectedVersion: 1,
          expectedPriorDecisionId: null,
          ...decision,
        },
      });
      expect(response.statusCode, response.body).toBe(201);
    }

    const read = await application.app.inject({ method: "GET", url });
    expect(read.statusCode).toBe(200);
    expect(read.json<{ decisions: unknown[]; current: Record<string, { outcome: string }> }>()).toMatchObject({
      decisions: expect.any(Array),
      current: {
        diff_review: { outcome: "approved" },
        validation_approval: { outcome: "approved" },
        commit_approval: { outcome: "approved" },
        push_authorization: { outcome: "denied" },
        pull_request_request: { outcome: "not_requested" },
      },
    });

    const completed = await application.app.inject({
      method: "POST",
      url: `/api/handoffs/${handoff.id}/complete`,
      payload: { expectedVersion: 1, summary: "Complete from persisted execution decisions." },
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json<{ handoff: HandoffResult }>().handoff).toMatchObject({
      status: "completed",
      executionDecisionState: {
        push_authorization: { outcome: "denied" },
        pull_request_request: { outcome: "not_requested" },
      },
    });
  });

  it("publishes annotated MCP tools/resources and enforces every kind-specific agent scope", async () => {
    const application = await localApplication();
    const handoff = createReviewHandoff(application, "mcp-0001");
    const projectId = handoff.designId;
    const tokens = Object.fromEntries(Object.entries(HANDOFF_EXECUTION_DECISION_SCOPES).map(([kind, scope]) => [
      kind,
      installAgentGrant(application, `public_${kind}`, projectId, ["handoff:read", scope]),
    ])) as Record<keyof typeof HANDOFF_EXECUTION_DECISION_SCOPES, string>;

    const toolsResponse = await mcpRequest(application, null, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
    const tools = toolsResponse.json<{ result: { tools: Array<{
      name: string;
      inputSchema: { additionalProperties?: boolean; properties?: Record<string, unknown> };
      annotations?: Record<string, boolean>;
    }> } }>().result.tools;
    expect(tools.find((tool) => tool.name === "handoff_execution_decisions_read")?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(tools.find((tool) => tool.name === "handoff_execution_decision_record")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });
    const decisionWriteTool = tools.find((tool) => tool.name === "handoff_execution_decision_record");
    expect(decisionWriteTool?.inputSchema).toMatchObject({
      additionalProperties: false,
      properties: { handoff_id: expect.any(Object), decision: expect.any(Object) },
    });
    const advertisedDecisionSchema = JSON.stringify(decisionWriteTool?.inputSchema.properties?.decision);
    expect(advertisedDecisionSchema).toContain('"anyOf"');
    expect(advertisedDecisionSchema).toContain('"plan_approval"');
    expect(advertisedDecisionSchema).toContain('"diffHash"');
    expect(advertisedDecisionSchema).toContain('"pull_request_request"');
    expect(advertisedDecisionSchema).toContain('"headRef"');

    const approved = application.handoffs.approveHandoff("local", handoff.id, {
      expectedVersion: 1,
      expectedPriorDecisionId: null,
      decision: "approved",
      summary: "Approve the exact reviewed handoff.",
      acceptanceCriteriaConfirmed: true,
      implementationPlanConfirmed: true,
    });
    const priorPlanDecisionId = approved.executionDecisionState.plan_approval?.id;
    expect(priorPlanDecisionId).toBeTruthy();
    const plan = await mcpDecision(application, tokens.plan_approval, handoff.id, {
      expectedVersion: 1,
      expectedPriorDecisionId: priorPlanDecisionId,
      idempotencyKey: "public-mcp-plan-0001",
      kind: "plan_approval",
      outcome: "approved",
      evidence: {
        summary: "The product plan is explicitly approved.",
        acceptanceCriteriaConfirmed: true,
        implementationPlanConfirmed: true,
      },
    });
    const planResult = plan.json<{
      result: { structuredContent: { ok: boolean; requiredScope?: string; error?: { code: string; message: string } } };
    }>().result.structuredContent;
    expect(planResult, JSON.stringify(planResult))
      .toMatchObject({ ok: true, requiredScope: HANDOFF_EXECUTION_DECISION_SCOPES.plan_approval });

    const wrongScope = await mcpDecision(application, tokens.plan_approval, handoff.id, {
      expectedVersion: 1,
      expectedPriorDecisionId: null,
      idempotencyKey: "public-mcp-wrong-scope-0001",
      kind: "isolation_choice",
      outcome: "worktree",
      evidence: { summary: "This agent lacks the isolation scope." },
    });
    expect(wrongScope.json<{ result: { structuredContent: { ok: boolean; error: { code: string } } } }>()
      .result.structuredContent).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });

    const isolation = await mcpDecision(application, tokens.isolation_choice, handoff.id, {
      expectedVersion: 1,
      expectedPriorDecisionId: null,
      idempotencyKey: "public-mcp-isolation-0001",
      kind: "isolation_choice",
      outcome: "worktree",
      evidence: { summary: "Use an isolated worktree." },
    });
    expect(isolation.json<{ result: { structuredContent: { ok: boolean; requiredScope: string } } }>().result.structuredContent)
      .toMatchObject({ ok: true, requiredScope: HANDOFF_EXECUTION_DECISION_SCOPES.isolation_choice });
    application.handoffs.startHandoffImplementation("local", handoff.id, {
      expectedVersion: 1,
      approvedVersion: 1,
      authorization: "start_implementation",
    });

    const diffHash = "d".repeat(64);
    const decisions: Array<[keyof typeof HANDOFF_EXECUTION_DECISION_SCOPES, Record<string, unknown>]> = [
      ["diff_review", {
        outcome: "approved",
        evidence: { summary: "Reviewed the exact diff.", diffHash, changedFileCount: 1 },
      }],
      ["validation_approval", {
        outcome: "approved",
        evidence: { summary: "Typecheck passed.", checks: [{ name: "typecheck", status: "passed" }] },
      }],
      ["commit_approval", {
        outcome: "approved",
        evidence: { summary: "Approve committing the reviewed diff.", diffHash, commitMessage: "Implement MCP handoff" },
      }],
      ["push_authorization", {
        outcome: "authorized",
        evidence: { summary: "Authorize the approved commit push.", commitHash: "e".repeat(40), targetRef: "feature/mcp-handoff" },
      }],
      ["pull_request_request", {
        outcome: "requested",
        evidence: { summary: "Request a reviewed pull request.", title: "Implement MCP handoff", baseRef: "main", headRef: "feature/mcp-handoff" },
      }],
    ];
    for (const [kind, variant] of decisions) {
      const response = await mcpDecision(application, tokens[kind], handoff.id, {
        expectedVersion: 1,
        expectedPriorDecisionId: null,
        idempotencyKey: `public-mcp-${kind}-0001`,
        kind,
        ...variant,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json<{ result: { structuredContent: { ok: boolean; requiredScope: string } } }>()
        .result.structuredContent).toMatchObject({ ok: true, requiredScope: HANDOFF_EXECUTION_DECISION_SCOPES[kind] });
    }

    const read = await mcpRequest(application, tokens.plan_approval, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "handoff_execution_decisions_read", arguments: { handoff_id: handoff.id } },
    });
    expect(read.json<{ result: { structuredContent: { decisions: unknown[]; current: Record<string, unknown> } } }>()
      .result.structuredContent).toMatchObject({ decisions: expect.any(Array), current: expect.any(Object) });

    const resource = await mcpRequest(application, tokens.plan_approval, {
      jsonrpc: "2.0",
      id: 3,
      method: "resources/read",
      params: { uri: `formaspec://handoffs/${handoff.id}/execution-decisions` },
    });
    const contents = resource.json<{ result: { contents: Array<{ text: string }> } }>().result.contents;
    const resourceBody = JSON.parse(contents[0]!.text) as { decisions: unknown[]; current: Record<string, unknown> };
    expect(resourceBody.decisions).toHaveLength(8);
    expect(resourceBody.current.pull_request_request).toMatchObject({ outcome: "requested" });
  });
});
