import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { loadConfig } from "./config.js";
import type { DesignerDatabase } from "./db/database.js";
import { hashPayload } from "./ids.js";
import { MCP_TOOL_OUTPUT_SCHEMAS } from "./mcp.js";
import type {
  HandoffSpecification,
  UploadRepositoryInventory,
} from "./workspace-handoff-service.js";

const applications: DesignerApplication[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.promises.rm(directory, { recursive: true, force: true })
  )));
});

async function application(): Promise<DesignerApplication> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "formaspec-mcp-handoff-output-"));
  temporaryDirectories.push(root);
  const built = await buildApplication(loadConfig({
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
  applications.push(built);
  await built.app.ready();
  return built;
}

async function callTool(
  built: DesignerApplication,
  name: keyof typeof MCP_TOOL_OUTPUT_SCHEMAS,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await built.app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      host: "127.0.0.1:4310",
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    payload: {
      jsonrpc: "2.0",
      id: `${name}-probe`,
      method: "tools/call",
      params: { name, arguments: args },
    },
  });
  expect(response.statusCode, `${name}: ${response.body}`).toBe(200);
  const body = response.json<{
    result?: { isError?: boolean; structuredContent?: Record<string, unknown> };
    error?: unknown;
  }>();
  expect(body.error, `${name}: ${response.body}`).toBeUndefined();
  expect(body.result?.isError, `${name}: ${response.body}`).not.toBe(true);
  expect(body.result?.structuredContent, `${name}: ${response.body}`).toMatchObject({ ok: true });
  const output = body.result!.structuredContent!;
  const parsed = MCP_TOOL_OUTPUT_SCHEMAS[name].safeParse(output);
  expect(parsed.success, parsed.success ? name : `${name}: ${parsed.error.message}`).toBe(true);
  return output;
}

function seedVerifiedBackup(database: DesignerDatabase, id: string, createdAt: string): void {
  const verification = {
    valid: true,
    manifest: {
      format: "formaspec-backup",
      formatVersion: 2,
      createdAt,
      databaseSchemaVersion: database.schemaVersion(),
    },
    sqliteIntegrity: "ok",
    foreignKeyViolations: 0,
    extractedBytes: 1,
    entryCount: 1,
  };
  database.sqlite.prepare(
    `INSERT INTO backup_records
     (id, organization_id, filename, bundle_sha256, status, manifest_json, created_by, created_at, verified_at,
      size_bytes, verification_json, retention_class, completed_at)
     VALUES (?, 'organization_legacy', 'mcp-output-migration-gate.tar', ?, 'valid', ?, 'principal_local', ?, ?, 1, ?, 'manual', ?)`,
  ).run(
    id,
    "a".repeat(64),
    JSON.stringify(verification.manifest),
    createdAt,
    createdAt,
    JSON.stringify(verification),
    createdAt,
  );
}

const inventoryEntityId = `inv_${"1".repeat(40)}`;
const inventoryLocationId = `loc_${"2".repeat(40)}`;

function repositoryInventory(): UploadRepositoryInventory {
  return {
    schemaVersion: 1,
    repositoryFingerprint: "b".repeat(64),
    generatedAt: "2026-07-21T08:00:00.000Z",
    platforms: ["web"],
    gitHead: "c".repeat(40),
    excludedPatterns: [".env", ".env.*", "*.pem", "*.key", "**/secrets/**", "**/.git/**"],
    scannedFileCount: 12,
    skippedFileCount: 2,
    bytesRead: 4_096,
    truncated: false,
    entities: [{
      id: inventoryEntityId,
      kind: "route",
      name: "Checkout route",
      symbol: null,
      locationId: inventoryLocationId,
      line: 18,
    }],
    excluded: [
      { category: "secret", count: 1 },
      { category: "generated", count: 2 },
    ],
  };
}

function handoffSpecification(frameId: string, summary = "Implement the immutable checkout design handoff."): HandoffSpecification {
  return {
    schemaVersion: 1,
    title: "Implement checkout",
    summary,
    acceptanceCriteria: [{
      id: "criterion_checkout_output",
      statement: "The implementation matches the exact FormaSpec revision.",
      designEntityIds: [frameId],
    }],
    implementationSlices: [{
      id: "slice_checkout_output",
      title: "Checkout screen",
      objective: "Implement the selected checkout screen without unrelated source changes.",
      inventoryEntityIds: [inventoryEntityId],
      designEntityIds: [frameId],
      dependsOn: [],
      validationChecks: ["typecheck", "unit_tests"],
    }],
    risks: [],
    openQuestions: [],
    implementationPolicy: {
      preferredIsolation: "worktree",
      commitRequiresExplicitApproval: true,
      pullRequestRequiresExplicitRequest: true,
    },
  };
}

function emptyDecisionState() {
  return {
    plan_approval: null,
    isolation_choice: null,
    diff_review: null,
    validation_approval: null,
    commit_approval: null,
    push_authorization: null,
    pull_request_request: null,
  };
}

function nestedObject(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = { leaf: true };
  for (let index = 0; index < depth; index += 1) value = { child: value };
  return value;
}

describe("exact repository, mapping, and handoff MCP results", () => {
  it("accepts real inventory, V2 mapping, handoff, and execution-decision lifecycles", async () => {
    const built = await application();
    const created = built.service.createDesign("local", {
      name: "Workspace handoff output contract",
      preset: "web",
      idempotencyKey: "workspace-handoff-output-design",
    });
    const backupId = "backup_mcpoutputmigration01";
    seedVerifiedBackup(built.database, backupId, created.design.updatedAt);
    const migrated = built.service.migrateDesignHeadToV2("local", created.design.id, {
      expectedBaseVersion: 1,
      backupId,
      idempotencyKey: "workspace-handoff-output-v2-migration",
    });
    if (migrated.result.canonicalDocument.schema_version !== 2) throw new Error("Expected a V2 fixture.");
    const frameId = migrated.result.canonicalDocument.pages[0]?.children[0];
    if (!frameId) throw new Error("Expected a migrated frame.");
    const designId = created.design.id;
    const revisionId = migrated.result.revision.id;

    const persisted = await callTool(built, "repository_inventory_persist", {
      inventory: repositoryInventory(),
    });
    const inventory = persisted.inventory as { id: string };
    await callTool(built, "repository_inventory_list", {
      repository_fingerprint: "b".repeat(64),
      limit: 25,
    });
    await callTool(built, "repository_inventory_read", { inventory_id: inventory.id });

    const mappingCreated = await callTool(built, "implementation_mapping_create", {
      design_id: designId,
      revision_id: revisionId,
      expected_design_version: 2,
      inventory_id: inventory.id,
      idempotency_key: "workspace-handoff-output-mapping",
      mappings: [{
        entityKind: "screen",
        entityId: frameId,
        inventoryEntityId,
      }],
    });
    const mapping = (mappingCreated.result as { mappings: Array<{ id: string }> }).mappings[0]!;
    expect(MCP_TOOL_OUTPUT_SCHEMAS.implementation_mapping_create.safeParse({
      ...mappingCreated,
      resourceUris: [`formaspec://implementation-mappings/mapping_${"f".repeat(32)}`],
    }).success).toBe(false);
    const mismatchedBatch = structuredClone(mappingCreated) as {
      result: { mappings: Array<{ inventoryHash: string }> };
    } & Record<string, unknown>;
    mismatchedBatch.result.mappings[0]!.inventoryHash = "f".repeat(64);
    expect(MCP_TOOL_OUTPUT_SCHEMAS.implementation_mapping_create.safeParse(mismatchedBatch).success).toBe(false);
    const mappingRead = await callTool(built, "implementation_mapping_read", { mapping_id: mapping.id });
    expect(MCP_TOOL_OUTPUT_SCHEMAS.implementation_mapping_read.safeParse({
      ...mappingRead,
      mapping: { ...(mappingRead.mapping as Record<string, unknown>), sourcePath: "/private/company/Checkout.tsx" },
    }).success).toBe(false);
    expect(MCP_TOOL_OUTPUT_SCHEMAS.implementation_mapping_read.safeParse({
      ...mappingRead,
      resourceUri: `formaspec://implementation-mappings/mapping_${"e".repeat(32)}`,
    }).success).toBe(false);
    expect(MCP_TOOL_OUTPUT_SCHEMAS.implementation_mapping_read.safeParse({
      ok: true,
      mappings: Array.from({ length: 201 }, () => mappingRead.mapping),
    }).success).toBe(false);
    await callTool(built, "implementation_mapping_read", {
      design_id: designId,
      revision_id: revisionId,
      entity_kind: "screen",
      inventory_id: inventory.id,
      limit: 100,
    });

    const createdHandoff = await callTool(built, "handoff_create", {
      design_id: designId,
      revision_id: revisionId,
      expected_design_version: 2,
      inventory_id: inventory.id,
      specification: handoffSpecification(frameId),
    });
    const handoffId = (createdHandoff.handoff as { id: string }).id;
    expect(MCP_TOOL_OUTPUT_SCHEMAS.handoff_create.safeParse({
      ...createdHandoff,
      resourceUri: `formaspec://handoffs/handoff_${"e".repeat(32)}`,
    }).success).toBe(false);
    expect(MCP_TOOL_OUTPUT_SCHEMAS.handoff_create.safeParse({
      ...createdHandoff,
      deepLink: "http://127.0.0.1:4310/design/document_wrongoutput0001",
    }).success).toBe(false);
    await callTool(built, "handoff_read", { handoff_id: handoffId });
    await callTool(built, "handoff_list", { design_id: designId, limit: 25 });
    await callTool(built, "handoff_update", {
      handoff_id: handoffId,
      expected_version: 1,
      specification: handoffSpecification(frameId, "Implement the reviewed immutable checkout handoff."),
    });
    await callTool(built, "handoff_submit_review", {
      handoff_id: handoffId,
      expected_version: 2,
      summary: "Ready for explicit plan review.",
    });
    await callTool(built, "handoff_execution_decisions_read", { handoff_id: handoffId });
    const decision = await callTool(built, "handoff_execution_decision_record", {
      handoff_id: handoffId,
      decision: {
        expectedVersion: 2,
        expectedPriorDecisionId: null,
        idempotencyKey: "workspace-handoff-output-plan-denial",
        kind: "plan_approval",
        outcome: "denied",
        evidence: { reason: "The plan requires one more explicit review." },
      },
    });
    expect(decision).toMatchObject({
      decision: { kind: "plan_approval", outcome: "denied" },
      requiredScope: "handoff:execution:plan",
    });
    expect(MCP_TOOL_OUTPUT_SCHEMAS.handoff_execution_decision_record.safeParse({
      ...decision,
      requiredScope: "handoff:execution:commit",
    }).success).toBe(false);
    expect(MCP_TOOL_OUTPUT_SCHEMAS.handoff_execution_decision_record.safeParse({
      ...decision,
      resourceUri: `formaspec://handoffs/handoff_${"e".repeat(32)}/execution-decisions`,
    }).success).toBe(false);
    const decisions = await callTool(built, "handoff_execution_decisions_read", { handoff_id: handoffId });
    expect(decisions).toMatchObject({
      decisions: [expect.objectContaining({ kind: "plan_approval", outcome: "denied" })],
      current: { plan_approval: expect.objectContaining({ kind: "plan_approval", outcome: "denied" }) },
    });
    const deniedDecisionId = (decision.decision as { id: string }).id;
    built.handoffs.approveHandoff("local", handoffId, {
      expectedVersion: 2,
      expectedPriorDecisionId: deniedDecisionId,
      decision: "approved",
      summary: "Approve the exact plan and acceptance criteria.",
      acceptanceCriteriaConfirmed: true,
      implementationPlanConfirmed: true,
    });
    await callTool(built, "handoff_execution_decision_record", {
      handoff_id: handoffId,
      decision: {
        expectedVersion: 2,
        expectedPriorDecisionId: null,
        idempotencyKey: "workspace-handoff-output-isolation",
        kind: "isolation_choice",
        outcome: "worktree",
        evidence: { summary: "Use the explicitly approved isolated worktree." },
      },
    });
    built.handoffs.startHandoffImplementation("local", handoffId, {
      expectedVersion: 2,
      approvedVersion: 2,
      authorization: "start_implementation",
    });
    const diffHash = "d".repeat(64);
    for (const executionDecision of [
      {
        idempotencyKey: "workspace-handoff-output-diff",
        kind: "diff_review",
        outcome: "approved",
        evidence: { summary: "Reviewed the bounded implementation diff.", diffHash, changedFileCount: 2 },
      },
      {
        idempotencyKey: "workspace-handoff-output-validation",
        kind: "validation_approval",
        outcome: "approved",
        evidence: {
          summary: "All required handoff validation passed.",
          checks: [
            { name: "typecheck", status: "passed" },
            { name: "unit_tests", status: "passed", evidenceHash: "a".repeat(64) },
          ],
        },
      },
      {
        idempotencyKey: "workspace-handoff-output-commit",
        kind: "commit_approval",
        outcome: "approved",
        evidence: { summary: "Approve committing the reviewed diff.", diffHash, commitMessage: "Implement checkout" },
      },
      {
        idempotencyKey: "workspace-handoff-output-push",
        kind: "push_authorization",
        outcome: "denied",
        evidence: { reason: "Keep the approved commit local." },
      },
      {
        idempotencyKey: "workspace-handoff-output-pr",
        kind: "pull_request_request",
        outcome: "not_requested",
        evidence: { reason: "No pull request was requested." },
      },
    ]) {
      await callTool(built, "handoff_execution_decision_record", {
        handoff_id: handoffId,
        decision: {
          expectedVersion: 2,
          expectedPriorDecisionId: null,
          ...executionDecision,
        },
      });
    }
    built.handoffs.completeHandoffImplementation("local", handoffId, {
      expectedVersion: 2,
      summary: "Completed from the exact persisted execution decisions.",
    });
    const completedRead = await callTool(built, "handoff_read", { handoff_id: handoffId });
    expect(completedRead).toMatchObject({ handoff: { status: "completed" } });
    const mismatchedCompletion = structuredClone(completedRead) as {
      handoff: { transitions: Array<{ details: { executionDecisionIds?: Record<string, string> } }> };
    } & Record<string, unknown>;
    mismatchedCompletion.handoff.transitions.at(-1)!.details.executionDecisionIds!.diff_review = `handoff_decision_${"f".repeat(32)}`;
    expect(MCP_TOOL_OUTPUT_SCHEMAS.handoff_read.safeParse(mismatchedCompletion).success).toBe(false);
    const mismatchedState = structuredClone(completedRead) as {
      handoff: {
        executionDecisionState: { plan_approval: { evidence: { summary: string }; evidenceHash: string } };
      };
    } & Record<string, unknown>;
    mismatchedState.handoff.executionDecisionState.plan_approval.evidence.summary = "Mutated state with the same decision ID.";
    mismatchedState.handoff.executionDecisionState.plan_approval.evidenceHash = hashPayload(
      mismatchedState.handoff.executionDecisionState.plan_approval.evidence,
    );
    expect(MCP_TOOL_OUTPUT_SCHEMAS.handoff_read.safeParse(mismatchedState).success).toBe(false);
    await callTool(built, "handoff_list", { design_id: designId, limit: 25 });
  });

  it("rejects nested drift, invalid hashes, transition mismatches, excessive values, and malformed errors", () => {
    const timestamp = "2026-07-21T08:00:00.000Z";
    const inventory = repositoryInventory();
    const inventoryId = `inventory_${"a".repeat(32)}`;
    const inventoryResult = {
      id: inventoryId,
      repositoryFingerprint: inventory.repositoryFingerprint,
      inventoryHash: hashPayload(inventory),
      inventory,
      status: "active",
      createdBy: "principal_local",
      createdAt: timestamp,
      revokedAt: null,
      deduplicated: false,
    };
    expect(MCP_TOOL_OUTPUT_SCHEMAS.repository_inventory_persist.safeParse({
      ok: true,
      inventory: inventoryResult,
    }).success).toBe(true);
    expect(MCP_TOOL_OUTPUT_SCHEMAS.repository_inventory_persist.safeParse({
      ok: true,
      inventory: {
        ...inventoryResult,
        inventory: {
          ...inventory,
          entities: [{ ...inventory.entities[0]!, sourcePath: "/private/company/Checkout.tsx" }],
        },
      },
    }).success).toBe(false);
    expect(MCP_TOOL_OUTPUT_SCHEMAS.repository_inventory_persist.safeParse({
      ok: true,
      inventory: { ...inventoryResult, inventoryHash: "d".repeat(64) },
    }).success).toBe(false);
    expect(MCP_TOOL_OUTPUT_SCHEMAS.repository_inventory_persist.safeParse({
      ok: true,
      inventory: { ...inventoryResult, status: "revoked", revokedAt: null },
    }).success).toBe(false);

    const summary = {
      id: inventoryId,
      repositoryFingerprint: inventory.repositoryFingerprint,
      inventoryHash: inventoryResult.inventoryHash,
      status: "active",
      platforms: ["web"],
      entityCount: 1,
      scannedFileCount: 12,
      skippedFileCount: 2,
      truncated: false,
      createdAt: timestamp,
      revokedAt: null,
    };
    expect(MCP_TOOL_OUTPUT_SCHEMAS.repository_inventory_list.safeParse({
      ok: true,
      inventories: [{ ...summary, entityCount: "1" }],
    }).success).toBe(false);
    expect(MCP_TOOL_OUTPUT_SCHEMAS.repository_inventory_list.safeParse({
      ok: true,
      inventories: Array.from({ length: 101 }, () => summary),
    }).success).toBe(false);
    const oversizedNameInventory = {
      ...inventory,
      entities: [{ ...inventory.entities[0]!, name: "x".repeat(241) }],
    };
    expect(MCP_TOOL_OUTPUT_SCHEMAS.repository_inventory_read.safeParse({
      ok: true,
      inventory: {
        ...inventoryResult,
        inventory: oversizedNameInventory,
        inventoryHash: hashPayload(oversizedNameInventory),
      },
    }).success).toBe(false);
    const oversizedInventory = {
      ...inventory,
      scannedFileCount: 10_000,
      bytesRead: 32 * 1_024 * 1_024,
      entities: Array.from({ length: 10_000 }, (_value, index) => ({
        id: `inv_${index.toString(16).padStart(40, "0")}`,
        kind: "route" as const,
        name: "x".repeat(240),
        symbol: null,
        locationId: `loc_${(index + 20_000).toString(16).padStart(40, "0")}`,
        line: index + 1,
      })),
    };
    expect(Buffer.byteLength(JSON.stringify(oversizedInventory), "utf8")).toBeGreaterThan(1_048_576);
    expect(MCP_TOOL_OUTPUT_SCHEMAS.repository_inventory_read.safeParse({
      ok: true,
      inventory: {
        ...inventoryResult,
        inventory: oversizedInventory,
        inventoryHash: hashPayload(oversizedInventory),
      },
    }).success).toBe(false);

    const handoffId = `handoff_${"b".repeat(32)}`;
    const specification = handoffSpecification("frame_outputschema0001");
    const transition = {
      id: `handoff_transition_${"c".repeat(32)}`,
      fromStatus: null,
      toStatus: "draft",
      actorId: "principal_local",
      details: { decision: "created", version: 1 },
      createdAt: timestamp,
    };
    const handoff = {
      id: handoffId,
      designId: "document_outputschema0001",
      revisionId: "revision_outputschema0001",
      designVersion: 1,
      inventoryId,
      status: "draft",
      currentVersion: 1,
      specification,
      versions: [{ version: 1, specification, actorId: "principal_local", createdAt: timestamp }],
      transitions: [transition],
      executionDecisions: [],
      executionDecisionState: emptyDecisionState(),
      createdBy: "principal_local",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    expect(MCP_TOOL_OUTPUT_SCHEMAS.handoff_read.safeParse({ ok: true, handoff }).success).toBe(true);
    expect(MCP_TOOL_OUTPUT_SCHEMAS.handoff_read.safeParse({
      ok: true,
      handoff: {
        ...handoff,
        transitions: [{ ...transition, toStatus: "completed" }],
        status: "completed",
      },
    }).success).toBe(false);
    expect(MCP_TOOL_OUTPUT_SCHEMAS.handoff_read.safeParse({
      ok: true,
      handoff: {
        ...handoff,
        transitions: [{
          ...transition,
          details: { decision: "completed", summary: "Incomplete completion evidence.", completedVersion: 1 },
        }],
      },
    }).success).toBe(false);
    expect(MCP_TOOL_OUTPUT_SCHEMAS.handoff_read.safeParse({
      ok: true,
      handoff: { ...handoff, status: "in_review" },
    }).success).toBe(false);
    expect(MCP_TOOL_OUTPUT_SCHEMAS.handoff_read.safeParse({
      ok: true,
      handoff: {
        ...handoff,
        transitions: [{ ...transition, details: { decision: "created", version: 2 } }],
      },
    }).success).toBe(false);
    const oversizedSpecification = {
      ...specification,
      acceptanceCriteria: Array.from({ length: 200 }, (_value, index) => ({
        id: `criterion_${index}`,
        statement: "x".repeat(1_000),
        designEntityIds: ["frame_outputschema0001"],
      })),
      implementationSlices: Array.from({ length: 100 }, (_value, index) => ({
        id: `slice_${index}`,
        title: "Oversized output slice",
        objective: "x".repeat(2_000),
        inventoryEntityIds: [inventoryEntityId],
        designEntityIds: ["frame_outputschema0001"],
        dependsOn: [],
        validationChecks: ["typecheck" as const],
      })),
      risks: Array.from({ length: 100 }, () => "x".repeat(1_000)),
      openQuestions: Array.from({ length: 100 }, () => "x".repeat(1_000)),
    };
    expect(Buffer.byteLength(JSON.stringify(oversizedSpecification), "utf8")).toBeGreaterThan(524_288);
    expect(MCP_TOOL_OUTPUT_SCHEMAS.handoff_read.safeParse({
      ok: true,
      handoff: {
        ...handoff,
        specification: oversizedSpecification,
        versions: [{
          ...handoff.versions[0],
          specification: oversizedSpecification,
        }],
      },
    }).success).toBe(false);

    const evidence = { reason: "The plan needs another review." };
    const executionDecision = {
      id: `handoff_decision_${"d".repeat(32)}`,
      handoffId,
      handoffVersion: 1,
      sequence: 1,
      kind: "plan_approval",
      outcome: "denied",
      supersedesDecisionId: null,
      evidence,
      evidenceHash: hashPayload(evidence),
      actorId: "principal_local",
      createdAt: timestamp,
    };
    expect(MCP_TOOL_OUTPUT_SCHEMAS.handoff_execution_decision_record.safeParse({
      ok: true,
      decision: executionDecision,
      requiredScope: "handoff:execution:plan",
      resourceUri: `${"formaspec://handoffs/"}${handoffId}/execution-decisions`,
    }).success).toBe(true);
    expect(MCP_TOOL_OUTPUT_SCHEMAS.handoff_execution_decision_record.safeParse({
      ok: true,
      decision: { ...executionDecision, evidenceHash: "e".repeat(64) },
      requiredScope: "handoff:execution:plan",
      resourceUri: `${"formaspec://handoffs/"}${handoffId}/execution-decisions`,
    }).success).toBe(false);
    const unknownEvidence = { ...evidence, sourcePath: "/private/company/Checkout.tsx" };
    expect(MCP_TOOL_OUTPUT_SCHEMAS.handoff_execution_decision_record.safeParse({
      ok: true,
      decision: {
        ...executionDecision,
        evidence: unknownEvidence,
        evidenceHash: hashPayload(unknownEvidence),
      },
      requiredScope: "handoff:execution:plan",
      resourceUri: `${"formaspec://handoffs/"}${handoffId}/execution-decisions`,
    }).success).toBe(false);

    const error = {
      ok: false,
      error: {
        code: "VERSION_CONFLICT",
        message: "The handoff changed concurrently.",
        retryable: false,
        details: { subject: "handoff", expectedVersion: 1, currentVersion: 2 },
      },
    } as const;
    expect(MCP_TOOL_OUTPUT_SCHEMAS.handoff_read.safeParse(error).success).toBe(true);
    expect(MCP_TOOL_OUTPUT_SCHEMAS.handoff_read.safeParse({
      ...error,
      error: { ...error.error, sourcePath: "/private/company/Checkout.tsx" },
    }).success).toBe(false);
    expect(MCP_TOOL_OUTPUT_SCHEMAS.handoff_read.safeParse({
      ...error,
      error: { ...error.error, details: nestedObject(33) },
    }).success).toBe(false);
    expect(MCP_TOOL_OUTPUT_SCHEMAS.handoff_read.safeParse({
      ...error,
      error: { ...error.error, message: "x".repeat(4_001) },
    }).success).toBe(false);
  });
});
