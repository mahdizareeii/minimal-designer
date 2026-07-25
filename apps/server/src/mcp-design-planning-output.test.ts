import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { loadConfig } from "./config.js";
import { MCP_TOOL_OUTPUT_SCHEMAS } from "./mcp.js";
import { designReadinessFixture } from "../test-fixtures/product.js";

const applications: DesignerApplication[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.promises.rm(directory, { recursive: true, force: true })));
});

async function application(): Promise<DesignerApplication> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "formaspec-mcp-design-output-"));
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
  token?: string,
): Promise<Record<string, unknown>> {
  return (await callToolEnvelope(built, name, args, token)).output;
}

async function callToolEnvelope(
  built: DesignerApplication,
  name: keyof typeof MCP_TOOL_OUTPUT_SCHEMAS,
  args: Record<string, unknown>,
  token?: string,
): Promise<{
  output: Record<string, unknown>;
  content: Array<Record<string, unknown>>;
}> {
  const response = await built.app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      host: "127.0.0.1:4310",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
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
    result?: {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
      content?: Array<Record<string, unknown>>;
    };
    error?: unknown;
  }>();
  expect(body.error, `${name}: ${response.body}`).toBeUndefined();
  expect(body.result?.isError, `${name}: ${response.body}`).not.toBe(true);
  expect(body.result?.structuredContent, `${name}: ${response.body}`).toMatchObject({ ok: true });
  const output = body.result!.structuredContent!;
  expect(MCP_TOOL_OUTPUT_SCHEMAS[name].safeParse(output).success, name).toBe(true);
  return { output, content: body.result?.content ?? [] };
}

async function callToolError(
  built: DesignerApplication,
  name: keyof typeof MCP_TOOL_OUTPUT_SCHEMAS,
  args: Record<string, unknown>,
  token?: string,
): Promise<Record<string, unknown>> {
  const response = await built.app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      host: "127.0.0.1:4310",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    payload: {
      jsonrpc: "2.0",
      id: `${name}-error-probe`,
      method: "tools/call",
      params: { name, arguments: args },
    },
  });
  expect(response.statusCode, `${name}: ${response.body}`).toBe(200);
  const output = response.json<{
    result: { isError?: boolean; structuredContent: Record<string, unknown> };
  }>().result.structuredContent;
  expect(output, response.body).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  expect(MCP_TOOL_OUTPUT_SCHEMAS[name].safeParse(output).success, name).toBe(true);
  return output;
}

async function readResource(built: DesignerApplication, uri: string, token?: string): Promise<Array<Record<string, unknown>>> {
  const response = await built.app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      host: "127.0.0.1:4310",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    payload: {
      jsonrpc: "2.0",
      id: "preview-render-resource-probe",
      method: "resources/read",
      params: { uri },
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  const body = response.json<{
    result?: { contents?: Array<Record<string, unknown>> };
    error?: unknown;
  }>();
  expect(body.error, response.body).toBeUndefined();
  return body.result?.contents ?? [];
}

function nestedObject(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = { leaf: true };
  for (let index = 0; index < depth; index += 1) value = { child: value };
  return value;
}

describe("exact core-design and planning MCP results", () => {
  it("accepts real read/preview/commit/archive/restore and planning outputs", async () => {
    const built = await application();
    const context = await callTool(built, "context_get", {});
    expect(context).toMatchObject({ context: { designId: null, selection: [] } });

    const created = await callTool(built, "design_create", {
      name: "Exact output contract",
      preset: "phone",
      idempotency_key: "exact-output-design-create",
    });
    const design = created.design as { id: string };
    const document = created.document as { pages: Array<{ children: string[] }> };
    const frameId = document.pages[0]!.children[0]!;
    const connection = built.enterprise.createAgentConnection("local", {
      adapter: "codex",
      displayName: "Exact output task preview agent",
      scopes: [
        "design:read",
        "design:preview",
        "design:write",
        "task:create",
        "task:read",
        "task:claim",
        "task:update",
      ],
      projectIds: [design.id],
      expiresInSeconds: 3_600,
    });
    const agent = built.enterprise.pairAgentConnection(connection.nonce).grant;

    const listed = await callTool(built, "design_list", {});
    expect(listed).toMatchObject({ designs: [expect.objectContaining({ id: design.id })] });
    await callTool(built, "design_read", { design_id: design.id });
    await callTool(built, "design_read", {
      design_id: design.id,
      node_id: frameId,
      depth: 2,
      max_nodes: 100,
      projection: "structure",
    });
    await callTool(built, "node_search", { design_id: design.id, query: "screen" });

    const previewTask = await callTool(built, "task_create", {
      design_id: design.id,
      brief: "Create an exact task-backed component proposal",
      selection: [frameId],
      base_version: 1,
      expected_output: "design_preview",
      idempotency_key: "exact-output-preview-task-create",
    }, agent.token);
    const previewTaskId = (previewTask.task as { id: string }).id;
    await callTool(built, "task_claim", { task_id: previewTaskId }, agent.token);
    await callTool(built, "task_transition", {
      task_id: previewTaskId,
      expected_status: "claimed",
      to_status: "in_progress",
    }, agent.token);

    const previewEnvelope = await callToolEnvelope(built, "design_preview_changes", {
      design_id: design.id,
      task_id: previewTaskId,
      base_version: 1,
      operations: [{
        type: "create_tree",
        parent: { node_id: frameId },
        root_ids: ["tmp:contract-card"],
        nodes: [{
          id: "tmp:contract-card",
          type: "rectangle",
          name: "Contract card",
          layout: {
            x: 24,
            y: 24,
            width: 220,
            height: 120,
            mode: "absolute",
            width_sizing: "fixed",
            height_sizing: "fixed",
          },
          style: { fill: "#ffffff" },
          visible: true,
          locked: false,
          archived: false,
          metadata: {},
        }],
      }],
      page_id: (created.document as { pages: Array<{ id: string }> }).pages[0]!.id,
      node_id: frameId,
      max_size: 512,
    }, agent.token);
    const preview = previewEnvelope.output;
    const previewResult = preview.preview as {
      id: string;
      createdIds: { temporary: Record<string, string> };
    };
    const previewRender = preview.render as {
      options: { pageId: string; nodeId: string; maxSize: number };
      width: number;
      height: number;
      renderer: string;
      warnings: string[];
      sha256: string;
      resourceUri: string;
    };
    expect(previewRender.options).toEqual({
      pageId: (created.document as { pages: Array<{ id: string }> }).pages[0]!.id,
      nodeId: frameId,
      maxSize: 512,
    });
    expect(previewRender.sha256).toMatch(/^[a-f0-9]{64}$/);
    const previewImage = previewEnvelope.content.find((item) => item.type === "image") as {
      data?: string;
      mimeType?: string;
    } | undefined;
    expect(previewImage?.mimeType).toBe("image/png");
    expect(createHash("sha256").update(Buffer.from(previewImage!.data!, "base64")).digest("hex"))
      .toBe(previewRender.sha256);
    const persistedMetadata = built.database.sqlite.prepare(
      "SELECT render_metadata_json FROM previews WHERE id = ?",
    ).get(previewResult.id) as { render_metadata_json: string };
    expect(JSON.parse(persistedMetadata.render_metadata_json)).toEqual({
      options: previewRender.options,
      width: previewRender.width,
      height: previewRender.height,
      renderer: previewRender.renderer,
      warnings: previewRender.warnings,
      sha256: previewRender.sha256,
    });
    await callTool(built, "design_render", {
      design_id: design.id,
      preview_id: previewResult.id,
      max_size: 512,
    }, agent.token);
    await callTool(built, "design_lint", {
      design_id: design.id,
      preview_id: previewResult.id,
    }, agent.token);
    const awaitingPreview = await callTool(built, "task_transition", {
      task_id: previewTaskId,
      expected_status: "in_progress",
      to_status: "awaiting_approval",
      data: {
        previewId: previewResult.id,
        readiness: designReadinessFixture(
          built.enterprise.readAgentTask("local", previewTaskId).resolvedContext,
        ),
      },
    }, agent.token);
    expect(awaitingPreview).toMatchObject({
      task: { status: "awaiting_approval" },
      reviewDeepLink: expect.stringContaining(previewResult.id),
    });
    const previewRead = await built.app.inject({
      method: "GET",
      url: `/api/designs/${encodeURIComponent(design.id)}/previews/${encodeURIComponent(previewResult.id)}?taskId=${encodeURIComponent(previewTaskId)}`,
    });
    expect(previewRead.statusCode, previewRead.body).toBe(200);
    expect(previewRead.json<{ renderMetadata: unknown }>().renderMetadata).toEqual({
      options: previewRender.options,
      width: previewRender.width,
      height: previewRender.height,
      renderer: previewRender.renderer,
      warnings: previewRender.warnings,
      sha256: previewRender.sha256,
    });
    const persistedCrop = await built.app.inject({
      method: "GET",
      url: `/api/designs/${encodeURIComponent(design.id)}/previews/${encodeURIComponent(previewResult.id)}/render.png?taskId=${encodeURIComponent(previewTaskId)}&_retry=1`,
    });
    expect(persistedCrop.statusCode, persistedCrop.body).toBe(200);
    expect(persistedCrop.headers["x-formaspec-preview-render-mode"]).toBe("exact");
    expect(persistedCrop.headers["x-formaspec-preview-render-sha256"]).toBe(previewRender.sha256);
    expect(createHash("sha256").update(persistedCrop.rawPayload).digest("hex")).toBe(previewRender.sha256);
    const override = await built.app.inject({
      method: "GET",
      url: `/api/designs/${encodeURIComponent(design.id)}/previews/${encodeURIComponent(previewResult.id)}/render.png?taskId=${encodeURIComponent(previewTaskId)}&maxSize=256`,
    });
    expect(override.statusCode, override.body).toBe(409);
    expect(override.json<{ error?: { code?: string } }>().error?.code).toBe("PREVIEW_ENGINE_MISMATCH");
    const adHoc = await built.app.inject({
      method: "GET",
      url: `/api/designs/${encodeURIComponent(design.id)}/previews/${encodeURIComponent(previewResult.id)}/render.png?taskId=${encodeURIComponent(previewTaskId)}&mode=adhoc&nodeId=${encodeURIComponent(frameId)}&maxSize=256`,
    });
    expect(adHoc.statusCode, adHoc.body).toBe(200);
    expect(adHoc.headers["x-formaspec-preview-render-mode"]).toBe("adhoc");
    expect(createHash("sha256").update(adHoc.rawPayload).digest("hex")).not.toBe(previewRender.sha256);
    const resource = await readResource(built, previewRender.resourceUri, agent.token);
    const resourceImage = resource[0] as { mimeType?: string; blob?: string } | undefined;
    expect(resourceImage?.mimeType).toBe("image/png");
    expect(createHash("sha256").update(Buffer.from(resourceImage!.blob!, "base64")).digest("hex"))
      .toBe(previewRender.sha256);
    const cardId = previewResult.createdIds.temporary["tmp:contract-card"]!;
    await callToolError(built, "design_commit_preview", {
      design_id: design.id,
      preview_id: previewResult.id,
      expected_base_version: 1,
      idempotency_key: "exact-output-preview-commit",
      message: "Commit exact output contract preview",
    }, agent.token);
    const committed = await built.app.inject({
      method: "POST",
      url: `/api/designs/${encodeURIComponent(design.id)}/previews/${encodeURIComponent(previewResult.id)}/commit`,
      payload: {
        expectedBaseVersion: 1,
        idempotencyKey: "exact-output-preview-human-commit",
        message: "Approve exact output contract preview",
        taskId: previewTaskId,
      },
    });
    expect(committed.statusCode, committed.body).toBe(200);
    expect(committed.json()).toMatchObject({ version: 2, task: { status: "completed" } });

    const archiveTask = await callTool(built, "task_create", {
      design_id: design.id,
      brief: "Archive the proposed card with human approval",
      selection: [cardId],
      base_version: 2,
      expected_output: "design_preview",
      idempotency_key: "exact-output-archive-task-create",
    }, agent.token);
    const archiveTaskId = (archiveTask.task as { id: string }).id;
    await callTool(built, "task_claim", { task_id: archiveTaskId }, agent.token);
    await callTool(built, "task_transition", {
      task_id: archiveTaskId,
      expected_status: "claimed",
      to_status: "in_progress",
    }, agent.token);
    const archivePreview = await callTool(built, "design_preview_archive_nodes", {
      design_id: design.id,
      task_id: archiveTaskId,
      base_version: 2,
      operations: [{ type: "archive_nodes", node_ids: [cardId] }],
      page_id: (created.document as { pages: Array<{ id: string }> }).pages[0]!.id,
      node_id: frameId,
      max_size: 512,
    }, agent.token);
    expect(archivePreview.render).toMatchObject({
      options: {
        pageId: (created.document as { pages: Array<{ id: string }> }).pages[0]!.id,
        nodeId: frameId,
        maxSize: 512,
      },
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(built.database.sqlite.prepare(
      "SELECT render_metadata_json IS NOT NULL AS persisted FROM previews WHERE id = ?",
    ).get((archivePreview.preview as { id: string }).id)).toEqual({ persisted: 1 });
    const archivePreviewId = (archivePreview.preview as { id: string }).id;
    await callTool(built, "task_transition", {
      task_id: archiveTaskId,
      expected_status: "in_progress",
      to_status: "awaiting_approval",
      data: {
        previewId: archivePreviewId,
        readiness: designReadinessFixture(
          built.enterprise.readAgentTask("local", archiveTaskId).resolvedContext,
        ),
      },
    }, agent.token);
    await callToolError(built, "design_commit_archive_preview", {
      design_id: design.id,
      preview_id: archivePreviewId,
      expected_base_version: 2,
      idempotency_key: "exact-output-archive-commit",
      message: "Archive exact output contract card",
    }, agent.token);
    const archived = await built.app.inject({
      method: "POST",
      url: `/api/designs/${encodeURIComponent(design.id)}/archive-previews/${encodeURIComponent(archivePreviewId)}/commit`,
      payload: {
        expectedBaseVersion: 2,
        idempotencyKey: "exact-output-archive-human-commit",
        message: "Approve exact archive preview",
        taskId: archiveTaskId,
      },
    });
    expect(archived.statusCode, archived.body).toBe(200);
    expect(archived.json()).toMatchObject({ version: 3, task: { status: "completed" } });
    await callTool(built, "design_history", { design_id: design.id, limit: 20 });
    await callToolError(built, "design_restore_revision", {
      design_id: design.id,
      target_version: 1,
      expected_base_version: 3,
      idempotency_key: "exact-output-design-restore",
    });
    const restored = await built.app.inject({
      method: "POST",
      url: `/api/designs/${encodeURIComponent(design.id)}/restore`,
      payload: {
        targetVersion: 1,
        expectedBaseVersion: 3,
        idempotencyKey: "exact-output-design-human-restore",
      },
    });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(restored.json()).toMatchObject({ version: 4 });

    const planningCreated = await callTool(built, "planning_session_create", {
      design_id: design.id,
      idempotency_key: "exact-output-planning-create",
    });
    const sessionId = ((planningCreated.session as { session: { id: string } }).session).id;
    await callTool(built, "planning_session_list", { design_id: design.id });
    await callTool(built, "planning_session_read", { session_id: sessionId });
    await callTool(built, "planning_session_save_answer", {
      session_id: sessionId,
      expected_version: 1,
      section: "product_purpose",
      answer: "Define and verify the exact planning DTO contract.",
    });
  });

  it("rejects nested unknown keys, excessive collections/strings, shape mismatches, and malformed errors", () => {
    const designSummary = {
      id: "document_outputschema0001",
      name: "Output schema",
      version: 1,
      revisionId: "revision_outputschema0001",
      createdAt: "2026-07-21T00:00:00.000Z",
      updatedAt: "2026-07-21T00:00:00.000Z",
    };
    expect(MCP_TOOL_OUTPUT_SCHEMAS.design_list.safeParse({
      ok: true,
      designs: [{ ...designSummary, unexpected: true }],
      nextCursor: null,
    }).success).toBe(false);
    expect(MCP_TOOL_OUTPUT_SCHEMAS.design_list.safeParse({
      ok: true,
      designs: Array.from({ length: 101 }, () => designSummary),
      nextCursor: null,
    }).success).toBe(false);
    expect(MCP_TOOL_OUTPUT_SCHEMAS.design_list.safeParse({
      ok: true,
      designs: [{ ...designSummary, version: "1" }],
      nextCursor: null,
    }).success).toBe(false);

    const planningSession = {
      session: {
        id: "planning_outputschema0001",
        project_id: "document_outputschema0001",
        version: 1,
        status: "draft",
        current_section: "product_purpose",
        answers: [],
        created_at: "2026-07-21T00:00:00.000Z",
        updated_at: "2026-07-21T00:00:00.000Z",
      },
      versions: [{
        version: 1,
        status: "draft",
        currentSection: "product_purpose",
        actorId: "principal_local",
        createdAt: "2026-07-21T00:00:00.000Z",
      }],
      answeredSections: [],
      sectionCount: 22,
    };
    expect(MCP_TOOL_OUTPUT_SCHEMAS.planning_session_read.safeParse({
      ok: true,
      session: { ...planningSession, unexpected: true },
      sections: [...Array(22)].map((_value, index) => index === 0 ? "product_purpose" : "open_questions"),
    }).success).toBe(false);
    expect(MCP_TOOL_OUTPUT_SCHEMAS.planning_session_save_answer.safeParse({
      ok: true,
      session: {
        ...planningSession,
        session: {
          ...planningSession.session,
          answers: [{
            id: "planning_answer_outputschema0001",
            section: "product_purpose",
            version: 1,
            answer: "x".repeat(100_001),
            actor_id: "principal_local",
            created_at: "2026-07-21T00:00:00.000Z",
          }],
        },
      },
    }).success).toBe(false);

    const error = {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: "Missing design.",
        retryable: false,
      },
    } as const;
    expect(MCP_TOOL_OUTPUT_SCHEMAS.design_read.safeParse(error).success).toBe(true);
    expect(MCP_TOOL_OUTPUT_SCHEMAS.design_read.safeParse({
      ...error,
      error: { ...error.error, unexpected: true },
    }).success).toBe(false);
    expect(MCP_TOOL_OUTPUT_SCHEMAS.design_read.safeParse({
      ...error,
      error: { ...error.error, details: nestedObject(33) },
    }).success).toBe(false);
  });
});
