import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { loadConfig } from "./config.js";
import { MCP_TOOL_OUTPUT_SCHEMAS } from "./mcp.js";
import {
  MCP_AUTHORIZATION_RESIDUAL_ALLOWLIST,
  MCP_RESOURCE_CONTRACTS,
  MCP_TOOL_CONTRACTS,
  type McpToolEffect,
} from "./mcp-contract.js";

const applications: DesignerApplication[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.promises.rm(directory, { recursive: true, force: true })));
});

async function localApplication(): Promise<DesignerApplication> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "formaspec-mcp-contract-"));
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

function installGrant(
  application: DesignerApplication,
  id: string,
  scopes: string[],
  role: "agent" | "viewer" = "agent",
): string {
  const principalId = `principal_${id}`;
  const token = `fsg_${id}_mcp_contract_token_0001`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 60_000).toISOString();
  application.database.sqlite.prepare(
    `INSERT INTO principals (id, organization_id, kind, display_name, external_id, created_at)
     VALUES (?, 'organization_legacy', 'agent', ?, ?, ?)`,
  ).run(principalId, id, `mcp-contract:${id}`, now.toISOString());
  application.database.sqlite.prepare(
    `INSERT INTO memberships (organization_id, principal_id, role, created_at)
     VALUES ('organization_legacy', ?, ?, ?)`,
  ).run(principalId, role, now.toISOString());
  application.database.sqlite.prepare(
    `INSERT INTO agent_connections
     (id, organization_id, principal_id, adapter, display_name, status, scopes_json, project_ids_json,
      expires_at, created_at, updated_at)
     VALUES (?, 'organization_legacy', ?, 'generic_mcp', ?, 'active', ?, '[]', ?, ?, ?)`,
  ).run(`connection_${id}`, principalId, id, JSON.stringify(scopes), expiresAt, now.toISOString(), now.toISOString());
  application.database.sqlite.prepare(
    `INSERT INTO agent_grants
     (id, organization_id, principal_id, token_hash, scopes_json, project_ids_json, created_at, expires_at)
     VALUES (?, 'organization_legacy', ?, ?, ?, '[]', ?, ?)`,
  ).run(id, principalId, createHash("sha256").update(token).digest("hex"), JSON.stringify(scopes), now.toISOString(), expiresAt);
  return token;
}

function mcpRequest(application: DesignerApplication, payload: Record<string, unknown>, token?: string) {
  return application.app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      host: "127.0.0.1:4310",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    payload,
  });
}

function toolCall(application: DesignerApplication, token: string, name: string, args: Record<string, unknown>) {
  return mcpRequest(application, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  }, token);
}

const expectedAnnotations: Record<McpToolEffect, Record<string, boolean>> = {
  read: { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true },
  preview: { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: false },
  write: { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: true },
  destructive: { readOnlyHint: false, openWorldHint: false, destructiveHint: true, idempotentHint: true },
};

function inventoryProbe() {
  return {
    schemaVersion: 1,
    repositoryFingerprint: "a".repeat(64),
    generatedAt: "2026-07-21T00:00:00.000Z",
    platforms: ["generic-git"],
    gitHead: null,
    excludedPatterns: [".env", ".env.*", "*.pem", "*.key", "**/secrets/**", "**/.git/**"],
    scannedFileCount: 0,
    skippedFileCount: 0,
    bytesRead: 0,
    truncated: false,
    entities: [],
    excluded: [],
  };
}

function handoffSpecificationProbe() {
  return {
    schemaVersion: 1,
    title: "Denied handoff",
    summary: "A schema-valid handoff authorization probe.",
    acceptanceCriteria: [{ id: "criterion_contract0001", statement: "Authorization is required.", designEntityIds: [] }],
    implementationSlices: [{
      id: "slice_contract0001",
      title: "Denied slice",
      objective: "Verify the service guard runs before mutation.",
      inventoryEntityIds: [`inv_${"b".repeat(40)}`],
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
  };
}

const expectedMcpSuccessFields = {
  context_get: [["context"]],
  organization_policy_read: [["organizationPolicy"], ["organizationPolicy", "filename", "yaml"]],
  design_list: [["designs", "nextCursor"]],
  design_create: [
    ["design", "revision", "document", "schemaVersion", "diagnostics", "deepLink"],
    ["design", "revision", "document", "compatibilityDocument", "schemaVersion", "diagnostics", "deepLink"],
  ],
  design_read: [
    ["design", "revision", "subtree", "diagnostics"],
    ["design", "revision", "document", "schemaVersion", "diagnostics"],
    ["design", "revision", "document", "compatibilityDocument", "schemaVersion", "diagnostics"],
  ],
  node_search: [["nodes"]],
  design_preview_changes: [["preview", "render"]],
  design_preview_archive_nodes: [["preview", "render"]],
  design_render: [["render"]],
  design_lint: [["diagnostics"]],
  design_commit_preview: [["design", "revision", "diagnostics", "createdIds", "deepLink"]],
  design_commit_archive_preview: [["design", "revision", "diagnostics", "createdIds", "deepLink"]],
  design_history: [["revisions"]],
  design_restore_revision: [["design", "revision", "diagnostics", "restore", "restorePolicy", "deepLink"]],
  product_spec_read: [["specification"]],
  product_spec_preview: [["preview", "resourceUri", "deepLink"]],
  product_spec_commit_preview: [["specification", "deepLink"]],
  planning_session_list: [["sessions", "sections"]],
  planning_session_create: [["session", "sections"]],
  planning_session_read: [["session", "sections"]],
  planning_session_save_answer: [["session"]],
  task_create: [["task", "codexLaunchUrl", "websiteTaskLink"]],
  task_list: [["tasks"]],
  task_read: [["task", "reviewDeepLink"]],
  task_claim: [["task"]],
  task_transition: [["task", "reviewDeepLink"]],
  design_system_read: [["designSystem"]],
  design_system_list: [["designSystems"]],
  design_system_release_read: [["release"]],
  design_system_revision_release_read: [["revisionRelease"]],
  design_system_project_pin_read: [["pin"]],
  design_system_component_insert_preview: [["preview", "component", "render"]],
  design_system_upgrade_preview: [["preview", "resourceUri", "deepLink"]],
  design_system_upgrade_commit: [["preview", "pin"]],
  repository_inventory_list: [["inventories"]],
  repository_inventory_persist: [["inventory"]],
  repository_inventory_read: [["inventory"]],
  implementation_mapping_read: [["mapping", "resourceUri"], ["mappings"]],
  implementation_mapping_create: [["result", "resourceUris", "deepLink"]],
  handoff_list: [["handoffs", "nextCursor"]],
  handoff_read: [["handoff"]],
  handoff_execution_decisions_read: [["decisions", "current", "resourceUri"]],
  handoff_execution_decision_record: [["decision", "requiredScope", "resourceUri"]],
  handoff_create: [["handoff", "resourceUri", "deepLink"]],
  handoff_update: [["handoff"]],
  handoff_submit_review: [["handoff"]],
  redesign_assessment_create: [["assessment", "resourceUri"]],
  redesign_assessment_read: [["assessment"]],
  redesign_stage_revise: [["assessment"]],
  redesign_stage_artifact_read: [["stageArtifact"]],
  redesign_stage_artifact_write: [["assessment", "stageArtifact"]],
  redesign_stage_transition: [["assessment"]],
} as const satisfies Record<keyof typeof MCP_TOOL_CONTRACTS, readonly (readonly string[])[]>;

interface AdvertisedOutputBranch {
  type?: string;
  additionalProperties?: boolean;
  properties?: Record<string, {
    const?: boolean;
    type?: string;
    additionalProperties?: boolean;
    properties?: Record<string, unknown>;
    required?: string[];
  }>;
  required?: string[];
}

describe("MCP contract matrix", () => {
  it("covers every advertised tool and resource with strict top-level schemas", async () => {
    const application = await localApplication();
    const toolsResponse = await mcpRequest(application, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const tools = toolsResponse.json<{ result: { tools: Array<{
      name: string;
      inputSchema: {
        type?: string;
        additionalProperties?: boolean;
        properties?: Record<string, unknown>;
        anyOf?: Array<{
          type?: string;
          additionalProperties?: boolean;
          properties?: Record<string, unknown>;
          required?: string[];
        }>;
      };
      outputSchema?: {
        anyOf?: AdvertisedOutputBranch[];
      };
      annotations?: Record<string, boolean>;
    }> } }>().result.tools;
    expect(tools.map((entry) => entry.name).sort()).toEqual(Object.keys(MCP_TOOL_CONTRACTS).sort());
    expect(tools).toHaveLength(52);
    for (const advertised of tools) {
      const contract = MCP_TOOL_CONTRACTS[advertised.name as keyof typeof MCP_TOOL_CONTRACTS];
      expect(contract, advertised.name).toBeDefined();
      const inputBranches = advertised.inputSchema.anyOf ?? [advertised.inputSchema];
      expect(inputBranches.length, advertised.name).toBeGreaterThan(0);
      for (const branch of inputBranches) {
        expect(branch, advertised.name).toMatchObject({ type: "object", additionalProperties: false });
      }
      const outputBranches = advertised.outputSchema?.anyOf ?? [];
      const successBranches = outputBranches.filter((branch) => branch.properties?.ok?.const === true);
      const errorBranches = outputBranches.filter((branch) => branch.properties?.ok?.const === false);
      expect(successBranches.length, advertised.name).toBe(expectedMcpSuccessFields[advertised.name as keyof typeof MCP_TOOL_CONTRACTS].length);
      expect(errorBranches, advertised.name).toHaveLength(1);
      for (const branch of outputBranches) {
        expect(branch, advertised.name).toMatchObject({ type: "object", additionalProperties: false });
      }
      expect(JSON.stringify(advertised.inputSchema), advertised.name).not.toContain('"additionalProperties":{}');
      expect(JSON.stringify(advertised.inputSchema), advertised.name).not.toContain('"items":{}');
      expect(JSON.stringify(advertised.outputSchema), advertised.name).not.toContain('"additionalProperties":{}');
      expect(JSON.stringify(advertised.outputSchema), advertised.name).not.toContain('"items":{}');
      const advertisedSuccessFields = successBranches.map((branch) =>
        Object.keys(branch.properties ?? {}).filter((key) => key !== "ok").sort().join("|"),
      ).sort();
      const expectedSuccessFields = expectedMcpSuccessFields[advertised.name as keyof typeof MCP_TOOL_CONTRACTS]
        .map((fields) => [...fields].sort().join("|"))
        .sort();
      expect(advertisedSuccessFields, advertised.name).toEqual(expectedSuccessFields);
      for (const branch of successBranches) {
        expect([...(branch.required ?? [])].sort(), advertised.name).toEqual(
          Object.keys(branch.properties ?? {}).sort(),
        );
      }
      expect(errorBranches[0], advertised.name).toMatchObject({
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { const: false },
          error: {
            type: "object",
            additionalProperties: false,
            properties: {
              code: expect.any(Object),
              message: expect.any(Object),
              retryable: expect.any(Object),
              details: expect.any(Object),
            },
            required: expect.arrayContaining(["code", "message", "retryable"]),
          },
        },
        required: ["ok", "error"],
      });
      const runtimeOutputSchema = MCP_TOOL_OUTPUT_SCHEMAS[advertised.name as keyof typeof MCP_TOOL_OUTPUT_SCHEMAS];
      const representativeError = {
        ok: false,
        error: { code: "NOT_FOUND", message: "Missing contract probe.", retryable: false },
      } as const;
      expect(runtimeOutputSchema.safeParse(representativeError).success, advertised.name).toBe(true);
      expect(runtimeOutputSchema.safeParse({ ok: true }).success, advertised.name).toBe(false);
      expect(runtimeOutputSchema.safeParse({ ok: false }).success, advertised.name).toBe(false);
      expect(runtimeOutputSchema.safeParse({ ok: true, undeclared: true }).success, advertised.name).toBe(false);
      expect(runtimeOutputSchema.safeParse({ ...representativeError, undeclared: true }).success, advertised.name).toBe(false);
      expect(runtimeOutputSchema.safeParse({
        ...representativeError,
        error: { ...representativeError.error, undeclared: true },
      }).success, advertised.name).toBe(false);
      expect(advertised.annotations, advertised.name).toMatchObject(expectedAnnotations[contract.effect]);
      expect(contract.outputSchemaRequired).toBe(true);
      expect(contract.humanRoles).toBeDefined();
      expect(contract.enforcement.length).toBeGreaterThan(0);
    }
    const previewOperationSchema = JSON.stringify(
      tools.find((entry) => entry.name === "design_preview_changes")?.inputSchema.properties?.operations,
    );
    for (const operationType of [
      "create_page",
      "create_tree",
      "update_node",
      "move_node",
      "archive_nodes",
      "upsert_token",
      "upsert_asset",
      "insert_template",
      "set_prototype_link",
      "set_metadata",
    ]) {
      expect(previewOperationSchema).toContain(operationType);
    }
    expect(previewOperationSchema).toContain("tmp:");
    expect(tools.find((entry) => entry.name === "design_preview_changes")?.inputSchema.properties)
      .toHaveProperty("task_id");

    const taskTransitionInput = tools.find((entry) => entry.name === "task_transition")?.inputSchema;
    expect(taskTransitionInput?.anyOf).toHaveLength(6);
    expect(taskTransitionInput?.anyOf?.every((branch) => branch.additionalProperties === false)).toBe(true);
    expect(JSON.stringify(taskTransitionInput)).toContain('"previewId"');
    expect(JSON.stringify(taskTransitionInput)).toContain('"revisionId"');

    const redesignTransitionInput = tools.find((entry) => entry.name === "redesign_stage_transition")?.inputSchema;
    expect(redesignTransitionInput?.anyOf).toHaveLength(5);
    expect(redesignTransitionInput?.anyOf?.every((branch) => branch.additionalProperties === false)).toBe(true);
    expect(JSON.stringify(redesignTransitionInput)).toContain('"maxItems":10000');

    const resourcesResponse = await mcpRequest(application, { jsonrpc: "2.0", id: 2, method: "resources/list", params: {} });
    const fixedResources = resourcesResponse.json<{ result: { resources: Array<{ name: string; uri: string }> } }>().result.resources;
    const templatesResponse = await mcpRequest(application, { jsonrpc: "2.0", id: 3, method: "resources/templates/list", params: {} });
    const templates = templatesResponse.json<{ result: { resourceTemplates: Array<{ name: string; uriTemplate: string }> } }>().result.resourceTemplates;
    const advertisedResources = [
      ...fixedResources.map((entry) => ({ name: entry.name, uri: entry.uri, template: false })),
      ...templates.map((entry) => ({ name: entry.name, uri: entry.uriTemplate, template: true })),
    ];
    expect(advertisedResources.map((entry) => entry.name).sort()).toEqual(Object.keys(MCP_RESOURCE_CONTRACTS).sort());
    expect(advertisedResources).toHaveLength(25);
    for (const advertised of advertisedResources) {
      const contract = MCP_RESOURCE_CONTRACTS[advertised.name as keyof typeof MCP_RESOURCE_CONTRACTS];
      expect(advertised).toMatchObject({ uri: contract.uri, template: contract.template });
      expect(contract.humanRoles).toBeDefined();
      expect(contract.enforcement.length).toBeGreaterThan(0);
    }

    expect(MCP_AUTHORIZATION_RESIDUAL_ALLOWLIST).toEqual({});
  });

  it("accepts representative strict success and domain-error tool results", async () => {
    const application = await localApplication();
    const callAsLocalActor = (name: string, args: Record<string, unknown>) => mcpRequest(application, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name, arguments: args },
    });
    const successResponse = await callAsLocalActor("design_system_read", {});
    expect(successResponse.statusCode).toBe(200);
    expect(successResponse.json<{
      result?: { isError?: boolean; structuredContent?: Record<string, unknown> };
      error?: unknown;
    }>(), successResponse.body).toMatchObject({
      result: {
        structuredContent: {
          ok: true,
          designSystem: expect.any(Object),
        },
      },
    });

    const errorResponse = await callAsLocalActor("design_read", {
      design_id: "document_missing_contract0001",
    });
    expect(errorResponse.statusCode).toBe(200);
    expect(errorResponse.json<{
      result?: { isError?: boolean; structuredContent?: Record<string, unknown> };
      error?: unknown;
    }>(), errorResponse.body).toMatchObject({
      result: {
        isError: true,
        structuredContent: {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: expect.any(String),
            retryable: false,
          },
        },
      },
    });
  });

  it("rejects unknown fields for raw-shape, zero-argument, required, and prebuilt-object tool inputs", async () => {
    const application = await localApplication();
    const probes = [
      ["design_system_read", { unexpected: true }],
      ["design_list", { unexpected: true }],
      ["design_read", { design_id: "document_contract0001", unexpected: true }],
      ["handoff_execution_decisions_read", { handoff_id: `handoff_${"a".repeat(32)}`, unexpected: true }],
      ["design_preview_changes", {
        design_id: "document_contract0001",
        base_version: 1,
        operations: [{
          type: "create_tree",
          parent: { node_id: "node_contract0001" },
          root_ids: ["tmp:card"],
          nodes: [{
            id: "tmp:card",
            type: "rectangle",
            name: "Card",
            layout: {
              x: 0,
              y: 0,
              width: 100,
              height: 100,
              mode: "absolute",
              width_sizing: "fixed",
              height_sizing: "fixed",
            },
            style: {},
            visible: true,
            locked: false,
            archived: false,
            metadata: {},
            unexpected: true,
          }],
        }],
      }],
    ] as const;
    for (const [name, args] of probes) {
      const response = await mcpRequest(application, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name, arguments: args },
      });
      expect(response.statusCode, name).toBe(200);
      expect(response.json<{ result?: { isError?: boolean } }>().result, response.body).toMatchObject({ isError: true });
      expect(response.body, name).toContain("-32602");
      expect(response.body, name).toContain("Unrecognized key");
    }
  });

  it("fails closed for every statically authorized tool before reading or mutating domain state", async () => {
    const application = await localApplication();
    const design = application.service.createDesign("local", {
      name: "MCP contract authorization probe",
      preset: "web",
      idempotencyKey: "mcp-contract-probe-design",
    });
    const assessment = application.redesign.createOneClickAssessment("local", {
      designId: design.document.id,
      expectedDesignVersion: 1,
      brief: "Authorization probe assessment",
    });
    const token = installGrant(application, "mcp_contract_empty", []);
    const inventory = inventoryProbe();
    const handoffSpecification = handoffSpecificationProbe();
    const probes: Record<string, Record<string, unknown>> = {
      context_get: {},
      organization_policy_read: {},
      design_list: {},
      design_create: { name: "Denied", preset: "web", idempotency_key: "contract-design-create" },
      design_read: { design_id: "document_contract0001" },
      node_search: { design_id: "document_contract0001" },
      design_preview_changes: {
        design_id: "document_contract0001",
        task_id: "task_contract0001",
        base_version: 1,
        operations: [{ type: "set_metadata", target: { kind: "document" }, metadata: { probe: true } }],
      },
      design_preview_archive_nodes: {
        design_id: "document_contract0001",
        task_id: "task_contract0001",
        base_version: 1,
        operations: [{ type: "archive_nodes", node_ids: ["node_contract0001"] }],
      },
      design_render: { design_id: "document_contract0001" },
      design_lint: { design_id: "document_contract0001" },
      design_commit_preview: {
        design_id: "document_contract0001",
        preview_id: "preview_contract0001",
        expected_base_version: 1,
        idempotency_key: "contract-commit-preview",
        message: "Denied",
      },
      design_commit_archive_preview: {
        design_id: "document_contract0001",
        preview_id: "preview_contract0001",
        expected_base_version: 1,
        idempotency_key: "contract-archive-commit",
        message: "Denied",
      },
      design_history: { design_id: "document_contract0001" },
      design_restore_revision: {
        design_id: "document_contract0001",
        target_version: 1,
        expected_base_version: 1,
        idempotency_key: "contract-restore-revision",
      },
      product_spec_read: { design_id: "document_contract0001" },
      product_spec_preview: { design_id: "document_contract0001", base_version: 0, natural_language_brief: "Denied" },
      product_spec_commit_preview: {
        design_id: "document_contract0001",
        preview_id: "specpreview_contract0001",
        expected_base_version: 0,
        idempotency_key: "contract-product-commit",
      },
      planning_session_list: { design_id: "document_contract0001" },
      planning_session_create: { design_id: "document_contract0001", idempotency_key: "contract-planning-create" },
      planning_session_read: { session_id: "planning_contract0001" },
      planning_session_save_answer: {
        session_id: "planning_contract0001",
        expected_version: 1,
        section: "product_purpose",
        answer: "Denied",
      },
      task_create: {
        design_id: "document_contract0001",
        brief: "Denied",
        selection: [],
        base_version: 1,
        expected_output: "design_preview",
        idempotency_key: "contract-task-create",
      },
      task_list: {},
      task_read: { task_id: "task_contract0001" },
      task_claim: { task_id: "task_contract0001" },
      task_transition: { task_id: "task_contract0001", expected_status: "claimed", to_status: "in_progress" },
      design_system_list: {},
      design_system_release_read: { release_id: "release_contract0001" },
      design_system_revision_release_read: {
        design_id: "document_contract0001",
        revision_id: "revision_contract0001",
      },
      design_system_project_pin_read: { design_id: "document_contract0001" },
      design_system_component_insert_preview: {
        design_id: "document_contract0001",
        task_id: "task_contract0001",
        base_version: 1,
        component_definition_id: "component_contract0001",
        parent: { node_id: "node_contract0001" },
      },
      design_system_upgrade_preview: { design_id: "document_contract0001", target_release_id: "release_contract0001" },
      design_system_upgrade_commit: { preview_id: "upgrade_contract0001", expected_preview_hash: "a".repeat(64) },
      repository_inventory_list: {},
      repository_inventory_persist: { inventory },
      repository_inventory_read: { inventory_id: `inventory_${"a".repeat(32)}` },
      implementation_mapping_read: { mapping_id: `mapping_${"a".repeat(32)}` },
      implementation_mapping_create: {
        design_id: "document_contract0001",
        revision_id: "revision_contract0001",
        expected_design_version: 1,
        inventory_id: `inventory_${"a".repeat(32)}`,
        idempotency_key: "contract-mapping-create",
        mappings: [{ entityKind: "screen", entityId: "screen_contract0001", inventoryEntityId: `inv_${"b".repeat(40)}` }],
      },
      handoff_list: {},
      handoff_read: { handoff_id: `handoff_${"a".repeat(32)}` },
      handoff_execution_decisions_read: { handoff_id: `handoff_${"a".repeat(32)}` },
      handoff_create: {
        design_id: "document_contract0001",
        revision_id: "revision_contract0001",
        expected_design_version: 1,
        inventory_id: `inventory_${"a".repeat(32)}`,
        specification: handoffSpecification,
      },
      handoff_update: { handoff_id: `handoff_${"a".repeat(32)}`, expected_version: 1, specification: handoffSpecification },
      handoff_submit_review: { handoff_id: `handoff_${"a".repeat(32)}`, expected_version: 1, summary: "Denied" },
      redesign_assessment_create: { design_id: "document_contract0001", expected_design_version: 1, brief: "Denied" },
      redesign_assessment_read: { assessment_id: assessment.id },
      redesign_stage_artifact_read: { assessment_id: assessment.id, stage: "connect_inspect" },
    };
    const staticallyAuthorizedTools = Object.entries(MCP_TOOL_CONTRACTS)
      .filter(([, contract]) => contract.agent.mode === "all_scopes" || contract.agent.mode === "denied")
      .map(([name]) => name)
      .sort();
    expect(Object.keys(probes).sort()).toEqual(staticallyAuthorizedTools);
    for (const [name, args] of Object.entries(probes)) {
      const response = await toolCall(application, token, name, args);
      expect(response.statusCode, name).toBe(200);
      expect(response.json<{
        result?: { structuredContent?: { ok?: boolean; error?: { code?: string } } };
        error?: { code?: number; message?: string };
      }>(), `${name}: ${response.body}`).toMatchObject({
        result: { structuredContent: { ok: false, error: { code: "FORBIDDEN" } } },
      });
    }

    const missingReadToken = installGrant(application, "mcp_contract_missing_read", ["design:preview", "design:write"]);
    for (const [name, args] of Object.entries(probes).filter(([name]) => [
      "design_preview_changes",
      "design_preview_archive_nodes",
      "design_system_component_insert_preview",
    ].includes(name))) {
      const response = await toolCall(application, missingReadToken, name, args);
      expect(response.json<{ result: { structuredContent: unknown } }>().result.structuredContent, name).toMatchObject({
        ok: false,
        error: { code: "FORBIDDEN", message: expect.stringContaining("design:read") },
      });
    }
  });

  it("enforces every scoped MCP resource through its service authorization boundary", async () => {
    const application = await localApplication();
    const design = application.service.createDesign("local", {
      name: "MCP resource authorization probe",
      preset: "phone",
      idempotencyKey: "mcp-resource-probe-design",
    });
    const assessment = application.redesign.createOneClickAssessment("local", {
      designId: design.document.id,
      expectedDesignVersion: 1,
      brief: "Resource authorization probe assessment",
    });
    const token = installGrant(application, "mcp_resource_empty", []);
    const values: Record<string, string> = {
      designId: "document_contract0001",
      version: "1",
      nodeId: "node_contract0001",
      previewId: "preview_contract0001",
      sessionId: "planning_contract0001",
      taskId: "task_contract0001",
      releaseId: "release_contract0001",
      revisionId: "revision_contract0001",
      inventoryId: `inventory_${"a".repeat(32)}`,
      mappingId: `mapping_${"a".repeat(32)}`,
      handoffId: `handoff_${"a".repeat(32)}`,
      assessmentId: assessment.id,
      stage: "connect_inspect",
    };
    const scopedResources = Object.entries(MCP_RESOURCE_CONTRACTS)
      .filter(([, contract]) => contract.agent.mode === "all_scopes");
    expect(scopedResources).toHaveLength(22);
    for (const [name, contract] of scopedResources) {
      const uri = contract.uri.replace(/\{([^}]+)\}/g, (_match, key: string) => values[key] ?? `missing_${key}`);
      const response = await mcpRequest(application, {
        jsonrpc: "2.0",
        id: 5,
        method: "resources/read",
        params: { uri },
      }, token);
      expect(response.statusCode, name).toBe(200);
      expect(response.json<{
        error?: { data?: { error?: { code?: string; message?: string } } };
      }>().error?.data?.error, `${name}: ${response.body}`).toMatchObject({ code: "FORBIDDEN" });
    }
  });
});
