import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { loadConfig } from "./config.js";

const builtWebIndex = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist/index.html");

interface RevisionEnvelope {
  version: number;
  revisionId: string;
  document: {
    id: string;
    revision: number;
    pages: Array<{ id: string; children: string[] }>;
    nodes: Record<string, {
      id: string;
      type: string;
      name: string;
      children?: string[];
      layout: Record<string, unknown>;
    }>;
  };
  createdIds?: {
    temporary?: Record<string, string>;
  };
}

function testConfig() {
  return loadConfig({
    HOST: "127.0.0.1",
    PORT: "4310",
    DATA_DIR: "/tmp/minimal-ui-designer-tests",
    DESIGNER_DATABASE_PATH: ":memory:",
    PUBLIC_BASE_URL: "http://127.0.0.1:4310",
    AUTH_MODE: "none",
    DESIGNER_LOG_LEVEL: "silent",
  });
}

async function createDesign(app: FastifyInstance, actor = "alice", key = "create-key-0001"): Promise<RevisionEnvelope> {
  const response = await app.inject({
    method: "POST",
    url: "/api/designs",
    headers: { "x-designer-user": actor },
    payload: { name: "Checkout", preset: "phone", idempotencyKey: key },
  });
  expect(response.statusCode).toBe(201);
  return response.json<RevisionEnvelope>();
}

function captureThrown(callback: () => unknown): unknown {
  try {
    callback();
  } catch (error) {
    return error;
  }
  throw new Error("Expected callback to throw.");
}

describe("designer server", () => {
  let application: DesignerApplication;

  beforeEach(async () => {
    application = await buildApplication(testConfig());
    await application.app.ready();
  });

  afterEach(async () => {
    await application.app.close();
  });

  it("creates a starter design and lets another workspace user edit it", async () => {
    const created = await createDesign(application.app);
    expect(created.document.id).toMatch(/^document_/);
    expect(created.document.revision).toBe(1);
    expect(created.document.pages).toHaveLength(1);
    const frameId = created.document.pages[0]?.children[0];
    expect(frameId).toBeTruthy();
    expect(created.document.nodes[frameId as string]?.type).toBe("frame");
    expect(created.document.nodes[frameId as string]?.layout.width).toBe(390);

    const listed = await application.app.inject({
      method: "GET",
      url: "/api/designs",
      headers: { "x-designer-user": "bob" },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ designs: Array<{ id: string }> }>().designs[0]?.id).toBe(created.document.id);

    const updatePayload = {
      baseVersion: 1,
      operations: [{ type: "update_node", node_id: frameId, patch: { name: "Shared checkout" } }],
      idempotencyKey: "update-key-0001",
      message: "Rename screen",
    };
    const updated = await application.app.inject({
      method: "POST",
      url: `/api/designs/${created.document.id}/revisions`,
      headers: { "x-designer-user": "bob" },
      payload: updatePayload,
    });
    expect(updated.statusCode).toBe(200);
    const updateBody = updated.json<RevisionEnvelope>();
    expect(updateBody.version).toBe(2);
    expect(updateBody.document.nodes[frameId as string]?.name).toBe("Shared checkout");

    const replay = await application.app.inject({
      method: "POST",
      url: `/api/designs/${created.document.id}/revisions`,
      headers: { "x-designer-user": "bob" },
      payload: updatePayload,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json<RevisionEnvelope>().revisionId).toBe(updateBody.revisionId);

    const stale = await application.app.inject({
      method: "POST",
      url: `/api/designs/${created.document.id}/revisions`,
      headers: { "x-designer-user": "alice" },
      payload: {
        ...updatePayload,
        idempotencyKey: "update-key-0002",
        operations: [{ type: "update_node", node_id: frameId, patch: { name: "Stale change" } }],
      },
    });
    expect(stale.statusCode).toBe(409);
    const staleBody = stale.json<{ error?: { code?: string } }>();
    expect(staleBody.error?.code, stale.body).toBe("VERSION_CONFLICT");

    const historicalExport = await application.app.inject({
      method: "GET",
      url: `/api/designs/${created.document.id}/export?version=1`,
      headers: { "x-designer-user": "alice" },
    });
    expect(historicalExport.statusCode).toBe(200);
    expect(historicalExport.headers["content-disposition"]).toContain("-v1.json");
    expect(historicalExport.json<{ revision: number }>().revision).toBe(1);

    expect(() => application.database.sqlite.prepare("UPDATE revisions SET message = 'tampered'").run()).toThrow(/immutable/);
  });

  it("normalizes temporary node IDs, renders a preview, and commits the exact snapshot", async () => {
    const created = await createDesign(application.app, "alice", "create-key-0002");
    const frameId = created.document.pages[0]?.children[0] as string;
    const operations = [{
      type: "create_tree",
      parent: { node_id: frameId },
      root_ids: ["tmp:card"],
      nodes: [{
        id: "tmp:card",
        type: "rectangle",
        name: "Summary card",
        layout: {
          x: 24,
          y: 24,
          width: 342,
          height: 180,
          mode: "absolute",
          width_sizing: "fixed",
          height_sizing: "fixed",
        },
        style: { fill: "#eef2ff", radius: 18 },
        visible: true,
        locked: false,
        archived: false,
        metadata: {},
      }],
    }];

    const previewResponse = await application.app.inject({
      method: "POST",
      url: `/api/designs/${created.document.id}/previews`,
      headers: { "x-designer-user": "alice" },
      payload: { baseVersion: 1, operations },
    });
    expect(previewResponse.statusCode).toBe(201);
    const preview = previewResponse.json<{
      previewId: string;
      canCommit: boolean;
      createdIds: { temporary: Record<string, string> };
    }>();
    expect(preview.canCommit).toBe(true);
    expect(preview.createdIds.temporary["tmp:card"]).toMatch(/^node_/);

    const render = await application.app.inject({
      method: "GET",
      url: `/api/designs/${created.document.id}/previews/${preview.previewId}/render.png?maxSize=512`,
      headers: { "x-designer-user": "alice" },
    });
    expect(render.statusCode).toBe(200);
    expect(render.headers["content-type"]).toContain("image/png");
    expect(render.rawPayload.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

    const committed = await application.app.inject({
      method: "POST",
      url: `/api/designs/${created.document.id}/previews/${preview.previewId}/commit`,
      headers: { "x-designer-user": "alice" },
      payload: { expectedBaseVersion: 1, idempotencyKey: "commit-key-0001", message: "Add summary card" },
    });
    expect(committed.statusCode).toBe(200);
    const commitBody = committed.json<RevisionEnvelope>();
    expect(commitBody.version).toBe(2);
    expect(commitBody.document.nodes[preview.createdIds.temporary["tmp:card"] as string]?.name).toBe("Summary card");
  });

  it("rejects oversized preview operation payloads at the service boundary", async () => {
    const created = await createDesign(application.app, "alice", "create-key-preview-limits");
    const tooManyOperations = Array.from({ length: 501 }, () => ({ type: "invalid_operation" }));
    const tooManyError = captureThrown(() => application.service.createPreview("alice", created.document.id, {
      baseVersion: 1,
      operations: tooManyOperations,
    }));
    expect(tooManyError).toMatchObject({
      name: "DomainError",
      code: "PAYLOAD_TOO_LARGE",
      statusCode: 413,
      retryable: false,
      message: "A preview may contain at most 500 operations or 1 MiB of operation JSON.",
    });

    const oversizedJson = [{ type: "invalid_operation", payload: "x".repeat(1_048_576) }];
    const oversizedJsonError = captureThrown(() => application.service.createPreview("alice", created.document.id, {
      baseVersion: 1,
      operations: oversizedJson,
    }));
    expect(oversizedJsonError).toMatchObject({
      name: "DomainError",
      code: "PAYLOAD_TOO_LARGE",
      statusCode: 413,
      retryable: false,
      message: "A preview may contain at most 500 operations or 1 MiB of operation JSON.",
    });

    const previewCount = application.database.sqlite.prepare("SELECT COUNT(*) AS count FROM previews").get() as { count: number };
    expect(previewCount.count).toBe(0);
  });

  it("sniffs image uploads and returns a canonical upsert_asset operation", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=",
      "base64",
    );
    const boundary = "----designer-test-boundary";
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="pixel.png"\r\nContent-Type: image/png\r\n\r\n`),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const response = await application.app.inject({
      method: "POST",
      url: "/api/assets",
      headers: {
        "x-designer-user": "alice",
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });
    expect(response.statusCode).toBe(201);
    const asset = response.json<{
      id: string;
      width: number;
      height: number;
      operation: { type: string; asset: { id: string; storage_key: string } };
    }>();
    expect(asset.id).toMatch(/^asset_/);
    expect(asset.width).toBe(1);
    expect(asset.height).toBe(1);
    expect(asset.operation).toMatchObject({
      type: "upsert_asset",
      asset: { id: asset.id, storage_key: `asset:${asset.id}` },
    });

    const fetched = await application.app.inject({
      method: "GET",
      url: `/api/assets/${asset.id}`,
      headers: { "x-designer-user": "bob" },
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.rawPayload).toEqual(png);

    const invalidBody = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="unsafe.svg"\r\nContent-Type: image/png\r\n\r\n<svg onload="alert(1)"/>\r\n--${boundary}--\r\n`,
    );
    const invalid = await application.app.inject({
      method: "POST",
      url: "/api/assets",
      headers: {
        "x-designer-user": "alice",
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: invalidBody,
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json<{ error: { code: string } }>().error.code).toBe("UNSUPPORTED_ASSET");

    const truncatedBody = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="truncated.png"\r\nContent-Type: image/png\r\n\r\n`),
      png.subarray(0, 24),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const truncated = await application.app.inject({
      method: "POST",
      url: "/api/assets",
      headers: {
        "x-designer-user": "alice",
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: truncatedBody,
    });
    expect(truncated.statusCode).toBe(422);
    expect(truncated.json<{ error: { code: string } }>().error.code).toBe("UNSUPPORTED_ASSET");
  });

  it("rejects untrusted origins and non-POST MCP transport methods", async () => {
    const invalidOrigin = await application.app.inject({
      method: "GET",
      url: "/api/designs",
      headers: { origin: "https://attacker.example" },
    });
    expect(invalidOrigin.statusCode).toBe(403);
    expect(invalidOrigin.json<{ error: { code: string } }>().error.code).toBe("FORBIDDEN");

    for (const method of ["GET", "DELETE"] as const) {
      const response = await application.app.inject({ method, url: "/mcp" });
      expect(response.statusCode).toBe(405);
      expect(response.json<{ error: { code: number } }>().error.code).toBe(-32_000);
    }
  });

  it("initializes the stateless Streamable HTTP MCP endpoint", async () => {
    const mcpRequest = (payload: Record<string, unknown>) => application.app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "x-designer-user": "alice",
      },
      payload,
    });
    const response = await mcpRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "integration-test", version: "1.0.0" },
        },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ result: { serverInfo: { name: string }; instructions: string } }>();
    expect(body.result.serverInfo.name).toBe("minimal-ui-designer");
    expect(body.result.instructions).toContain("design_preview_changes");
    expect(body.result.instructions).toContain("tmp:<label>");
    expect(body.result.instructions.length).toBeLessThanOrEqual(512);

    const toolsResponse = await mcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(toolsResponse.statusCode).toBe(200);
    const tools = toolsResponse.json<{ result: { tools: Array<{
      name: string;
      inputSchema?: { properties?: Record<string, unknown> };
      outputSchema?: unknown;
      annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
    }> } }>().result.tools;
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "design_list",
      "design_create",
      "design_preview_changes",
      "design_commit_preview",
    ]));
    expect(tools.find((tool) => tool.name === "design_read")?.inputSchema?.properties).toMatchObject({
      node_id: expect.any(Object),
      depth: expect.any(Object),
      max_nodes: expect.any(Object),
      projection: expect.any(Object),
    });
    expect(tools.every((tool) => Boolean(tool.outputSchema))).toBe(true);
    expect(tools.find((tool) => tool.name === "design_preview_changes")?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
    });
    expect(tools.find((tool) => tool.name === "design_commit_destructive_preview")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });

    const schemaResourceResponse = await mcpRequest({
      jsonrpc: "2.0",
      id: 20,
      method: "resources/read",
      params: { uri: "designer://schema/v1" },
    });
    const schemaResource = schemaResourceResponse.json<{
      result: { contents: Array<{ text: string }> };
    }>();
    const schema = JSON.parse(schemaResource.result.contents[0]!.text) as Record<string, unknown>;
    expect(schema).toMatchObject({
      schema_version: 1,
      document_schema: expect.any(Object),
      preview_operation_schema: expect.any(Object),
      temporary_ids: { format: "tmp:<label>" },
    });
    expect(JSON.stringify(schema.preview_operation_schema)).toContain("tmp:");

    const missingResourceResponse = await mcpRequest({
      jsonrpc: "2.0",
      id: 21,
      method: "resources/read",
      params: { uri: "designer://designs/document_missing_12345678/head" },
    });
    const missingResource = missingResourceResponse.json<{
      error: { data?: { error?: { code?: string } } };
    }>();
    expect(missingResource.error.data?.error?.code).toBe("NOT_FOUND");

    const callResponse = await mcpRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "design_list", arguments: { limit: 10 } },
    });
    expect(callResponse.statusCode).toBe(200);
    const call = callResponse.json<{ result: { structuredContent: { ok: boolean; designs: unknown[] } } }>();
    expect(call.result.structuredContent.ok).toBe(true);
    expect(call.result.structuredContent.designs).toEqual([]);

    const createResponse = await mcpRequest({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "design_create",
        arguments: {
          name: "MCP checkout",
          preset: "phone",
          idempotency_key: "mcp-create-key-0001",
        },
      },
    });
    expect(createResponse.statusCode).toBe(200);
    const created = createResponse.json<{
      result: {
        structuredContent: {
          ok: boolean;
          design: { version: number };
          document: { id: string; pages: Array<{ children: string[] }>; nodes: Record<string, { layout: { width: number } }> };
          deepLink: string;
        };
      };
    }>();
    expect(created.result.structuredContent.ok).toBe(true);
    expect(created.result.structuredContent.design.version).toBe(1);
    expect(created.result.structuredContent.document.id).toMatch(/^document_/);
    const rootNodeId = created.result.structuredContent.document.pages[0]?.children[0];
    expect(rootNodeId).toBeTruthy();
    expect(created.result.structuredContent.document.nodes[rootNodeId as string]?.layout.width).toBe(390);
    expect(created.result.structuredContent.deepLink).toBe(`http://127.0.0.1:4310/design/${created.result.structuredContent.document.id}`);

    const subtreeResponse = await mcpRequest({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "design_read",
        arguments: {
          design_id: created.result.structuredContent.document.id,
          node_id: rootNodeId,
          depth: 0,
          projection: "structure",
        },
      },
    });
    const subtree = subtreeResponse.json<{
      result: { structuredContent: { ok: boolean; subtree: { rootId: string; projection: string; nodes: Record<string, unknown> } } };
    }>();
    expect(subtree.result.structuredContent).toMatchObject({
      ok: true,
      subtree: { rootId: rootNodeId, projection: "structure" },
    });
    expect(Object.keys(subtree.result.structuredContent.subtree.nodes)).toEqual([rootNodeId]);

    const previewResponse = await mcpRequest({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "design_preview_changes",
        arguments: {
          design_id: created.result.structuredContent.document.id,
          base_version: 1,
          operations: [{
            type: "create_tree",
            parent: { node_id: rootNodeId },
            root_ids: ["tmp:card"],
            nodes: [{
              id: "tmp:card",
              type: "rectangle",
              name: "MCP card",
              layout: { x: 24, y: 24, width: 342, height: 120, mode: "absolute", width_sizing: "fixed", height_sizing: "fixed" },
              style: { fill: "#eef2ff", radius: 16 },
              visible: true,
              locked: false,
              archived: false,
              metadata: {},
            }],
          }],
          max_size: 512,
        },
      },
    });
    expect(previewResponse.statusCode).toBe(200);
    const preview = previewResponse.json<{
      result: {
        content: Array<{ type: string; mimeType?: string }>;
        structuredContent: {
          preview: { id: string; rootBaseVersion: number; editorDeepLink: string; createdIds: { temporary: Record<string, string> } };
        };
      };
    }>();
    expect(preview.result.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "image", mimeType: "image/png" })]));
    expect(preview.result.structuredContent.preview.rootBaseVersion).toBe(1);
    expect(preview.result.structuredContent.preview.createdIds.temporary["tmp:card"]).toMatch(/^node_/);
    expect(preview.result.structuredContent.preview.editorDeepLink).toContain(`/design/${created.result.structuredContent.document.id}`);

    const commitResponse = await mcpRequest({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "design_commit_preview",
        arguments: {
          design_id: created.result.structuredContent.document.id,
          preview_id: preview.result.structuredContent.preview.id,
          expected_base_version: 1,
          idempotency_key: "mcp-commit-key-0001",
          message: "Add MCP card",
        },
      },
    });
    const committed = commitResponse.json<{
      result: { structuredContent: { ok: boolean; design: { version: number }; deepLink: string } };
    }>();
    expect(committed.result.structuredContent).toMatchObject({
      ok: true,
      design: { version: 2 },
      deepLink: `http://127.0.0.1:4310/design/${created.result.structuredContent.document.id}`,
    });

    const createdCardId = preview.result.structuredContent.preview.createdIds.temporary["tmp:card"]!;
    const archivePreviewResponse = await mcpRequest({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: {
        name: "design_preview_changes",
        arguments: {
          design_id: created.result.structuredContent.document.id,
          base_version: 2,
          operations: [{ type: "archive_nodes", node_ids: [createdCardId] }],
          max_size: 512,
        },
      },
    });
    const archivePreview = archivePreviewResponse.json<{
      result: { structuredContent: { preview: { id: string; destructive: boolean } } };
    }>();
    expect(archivePreview.result.structuredContent.preview.destructive).toBe(true);

    const ordinaryArchiveCommit = await mcpRequest({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name: "design_commit_preview",
        arguments: {
          design_id: created.result.structuredContent.document.id,
          preview_id: archivePreview.result.structuredContent.preview.id,
          expected_base_version: 2,
          idempotency_key: "mcp-archive-ordinary-0001",
          message: "Archive MCP card",
        },
      },
    });
    expect(ordinaryArchiveCommit.json<{
      result: { structuredContent: { ok: boolean; error: { code: string; details?: { requiredTool?: string } } } };
    }>().result.structuredContent).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_FAILED", details: { requiredTool: "design_commit_destructive_preview" } },
    });

    const destructiveArchiveCommit = await mcpRequest({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "design_commit_destructive_preview",
        arguments: {
          design_id: created.result.structuredContent.document.id,
          preview_id: archivePreview.result.structuredContent.preview.id,
          expected_base_version: 2,
          idempotency_key: "mcp-archive-destructive-0001",
          message: "Archive MCP card",
        },
      },
    });
    expect(destructiveArchiveCommit.json<{
      result: { structuredContent: { ok: boolean; design: { version: number } } };
    }>().result.structuredContent).toMatchObject({ ok: true, design: { version: 3 } });
  });

  it.skipIf(!fs.existsSync(builtWebIndex))(
    "serves built SPA deep links without intercepting API 404s",
    async () => {
      const deepLink = await application.app.inject({
        method: "GET",
        url: "/design/document_example_12345678",
        headers: { accept: "text/html", origin: "http://127.0.0.1:4310" },
      });
      expect(deepLink.statusCode).toBe(200);
      expect(deepLink.headers["content-type"]).toContain("text/html");
      expect(deepLink.body).toContain("id=\"root\"");
      expect(deepLink.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:4310");

      const missingApi = await application.app.inject({
        method: "GET",
        url: "/api/not-a-route",
        headers: { accept: "text/html" },
      });
      expect(missingApi.statusCode).toBe(404);
      expect(missingApi.headers["content-type"]).toContain("application/json");
    },
  );

  it("supports trusted-header UI auth and bearer MCP auth at the same time", async () => {
    expect(() => loadConfig({ AUTH_MODE: "trusted-header" })).toThrow(/DESIGNER_TOKEN/);
    const secured = await buildApplication(loadConfig({
      HOST: "127.0.0.1",
      PORT: "4310",
      DATA_DIR: "/tmp/minimal-ui-designer-tests",
      DESIGNER_DATABASE_PATH: ":memory:",
      PUBLIC_BASE_URL: "http://127.0.0.1:4310",
      AUTH_MODE: "trusted-header",
      DESIGNER_TOKEN: "test-token-1234567890",
      TRUSTED_USER_HEADER: "x-company-user",
      DESIGNER_LOG_LEVEL: "silent",
    }));
    await secured.app.ready();
    try {
      const missingUiIdentity = await secured.app.inject({ method: "GET", url: "/api/designs" });
      expect(missingUiIdentity.statusCode).toBe(401);

      const ui = await secured.app.inject({
        method: "POST",
        url: "/api/designs",
        headers: { "x-company-user": "alice@example.test" },
        payload: { name: "Secure selection", preset: "web", idempotencyKey: "secure-create-0001" },
      });
      expect(ui.statusCode).toBe(201);
      const uiDesign = ui.json<RevisionEnvelope>();
      const selectedNodeId = uiDesign.document.pages[0]?.children[0] as string;

      const contextUpdate = await secured.app.inject({
        method: "PUT",
        url: "/api/context",
        headers: { "x-company-user": "alice@example.test" },
        payload: {
          designId: uiDesign.document.id,
          pageId: uiDesign.document.pages[0]?.id,
          selectedNodeIds: [selectedNodeId],
        },
      });
      expect(contextUpdate.statusCode).toBe(200);

      const mcpWithoutToken = await secured.app.inject({
        method: "POST",
        url: "/mcp",
        headers: { accept: "application/json, text/event-stream", "content-type": "application/json", "x-company-user": "alice@example.test" },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      });
      expect(mcpWithoutToken.statusCode).toBe(401);

      const mcp = await secured.app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          authorization: "Bearer test-token-1234567890",
        },
        payload: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      });
      expect(mcp.statusCode).toBe(200);
      expect(mcp.json<{ result: { tools: unknown[] } }>().result.tools.length).toBeGreaterThan(0);

      const mcpContext = await secured.app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          authorization: "Bearer test-token-1234567890",
        },
        payload: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "context_get", arguments: {} } },
      });
      const context = mcpContext.json<{
        result: { structuredContent: { context: { designId: string; pageId: string; selection: string[]; contextRef: string; contextSource: string } } };
      }>().result.structuredContent.context;
      expect(context).toMatchObject({
        designId: uiDesign.document.id,
        pageId: uiDesign.document.pages[0]?.id,
        selection: [selectedNodeId],
        contextSource: "workspace",
      });

      const secondContext = await secured.app.inject({
        method: "PUT",
        url: "/api/context",
        headers: { "x-company-user": "bob@example.test" },
        payload: {
          designId: uiDesign.document.id,
          pageId: uiDesign.document.pages[0]?.id,
          selectedNodeIds: [],
        },
      });
      expect(secondContext.statusCode).toBe(200);

      const ambiguousContext = await secured.app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          authorization: "Bearer test-token-1234567890",
        },
        payload: { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "context_get", arguments: {} } },
      });
      const ambiguous = ambiguousContext.json<{
        result: { structuredContent: { ok: boolean; error: { code: string; details: { candidates: unknown[] } } } };
      }>().result.structuredContent;
      expect(ambiguous).toMatchObject({ ok: false, error: { code: "AMBIGUOUS_CONTEXT" } });
      expect(ambiguous.error.details.candidates).toHaveLength(2);

      const selectedContext = await secured.app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          authorization: "Bearer test-token-1234567890",
        },
        payload: {
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: { name: "context_get", arguments: { context_ref: context.contextRef } },
        },
      });
      expect(selectedContext.json<{
        result: { structuredContent: { context: { selection: string[]; contextRef: string } } };
      }>().result.structuredContent.context).toMatchObject({
        selection: [selectedNodeId],
        contextRef: context.contextRef,
      });
    } finally {
      await secured.app.close();
    }
  });
});
