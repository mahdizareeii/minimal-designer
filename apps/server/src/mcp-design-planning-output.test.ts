import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { loadConfig } from "./config.js";
import { MCP_TOOL_OUTPUT_SCHEMAS } from "./mcp.js";

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
  expect(MCP_TOOL_OUTPUT_SCHEMAS[name].safeParse(output).success, name).toBe(true);
  return output;
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

    const preview = await callTool(built, "design_preview_changes", {
      design_id: design.id,
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
      max_size: 512,
    });
    const previewResult = preview.preview as {
      id: string;
      createdIds: { temporary: Record<string, string> };
    };
    const cardId = previewResult.createdIds.temporary["tmp:contract-card"]!;
    await callTool(built, "design_render", { design_id: design.id, preview_id: previewResult.id, max_size: 512 });
    await callTool(built, "design_lint", { design_id: design.id, preview_id: previewResult.id });
    await callTool(built, "design_commit_preview", {
      design_id: design.id,
      preview_id: previewResult.id,
      expected_base_version: 1,
      idempotency_key: "exact-output-preview-commit",
      message: "Commit exact output contract preview",
    });

    const archivePreview = await callTool(built, "design_preview_archive_nodes", {
      design_id: design.id,
      base_version: 2,
      operations: [{ type: "archive_nodes", node_ids: [cardId] }],
      max_size: 512,
    });
    await callTool(built, "design_commit_archive_preview", {
      design_id: design.id,
      preview_id: (archivePreview.preview as { id: string }).id,
      expected_base_version: 2,
      idempotency_key: "exact-output-archive-commit",
      message: "Archive exact output contract card",
    });
    await callTool(built, "design_history", { design_id: design.id, limit: 20 });
    await callTool(built, "design_restore_revision", {
      design_id: design.id,
      target_version: 1,
      expected_base_version: 3,
      idempotency_key: "exact-output-design-restore",
    });

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
