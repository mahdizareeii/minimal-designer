import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { loadConfig } from "./config.js";
import { DEFAULT_ORGANIZATION_POLICY } from "./organization-policy-model.js";
import { designReadinessFixture } from "../test-fixtures/product.js";

const builtWebIndex = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist/index.html");
const PROXY_SECRET = "proxy-secret-0123456789abcdef0123456789abcdef";

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
    DATA_DIR: "/tmp/formaspec-designer-tests",
    DESIGNER_DATABASE_PATH: ":memory:",
    PUBLIC_BASE_URL: "http://127.0.0.1:4310",
    AUTH_MODE: "none",
    FORMASPEC_ALLOW_SOFTWARE_RENDERER: "true",
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

  it("exposes the stable data-store identity on live and ready health", async () => {
    const expected = application.database.dataStoreId();
    const live = await application.app.inject({ method: "GET", url: "/health/live" });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ ok: true, service: "formaspec-api", dataStoreId: expected });

    const ready = await application.app.inject({ method: "GET", url: "/health/ready" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ ok: true, database: "ready", dataStoreId: expected });
  });

  it("returns a schema-valid inactive MCP context after the local editor clears its row", async () => {
    const cleared = await application.app.inject({
      method: "PUT",
      url: "/api/context",
      payload: { designId: null, selectedNodeIds: [] },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toEqual({ designId: null, pageId: null, selection: [], updatedAt: null });

    const response = await application.app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "context_get", arguments: {} },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{
      result: { structuredContent: { ok: boolean; context: Record<string, unknown> } };
    }>().result.structuredContent).toEqual({
      ok: true,
      context: { designId: null, pageId: null, selection: [], updatedAt: null },
    });
  });

  it("keeps local editor client leases separate across HTTP and MCP until one client releases", async () => {
    const firstDesign = await createDesign(application.app, "alice", "create-client-context-http-0001");
    const secondDesign = await createDesign(application.app, "alice", "create-client-context-http-0002");
    const firstClientContextId = "browser_tab_context_0001";
    const secondClientContextId = "browser_tab_context_0002";

    const firstUpdate = await application.app.inject({
      method: "PUT",
      url: "/api/context",
      payload: {
        designId: firstDesign.document.id,
        pageId: firstDesign.document.pages[0]!.id,
        selectedNodeIds: [],
        clientContextId: firstClientContextId,
      },
    });
    expect(firstUpdate.statusCode).toBe(200);
    const firstContext = firstUpdate.json<{ contextRef: string }>();
    expect(firstContext.contextRef).toMatch(/^context_[a-f0-9]{24}$/);

    const secondNodeId = secondDesign.document.pages[0]!.children[0]!;
    const secondUpdate = await application.app.inject({
      method: "PUT",
      url: "/api/context",
      payload: {
        designId: secondDesign.document.id,
        pageId: secondDesign.document.pages[0]!.id,
        selectedNodeIds: [secondNodeId],
        clientContextId: secondClientContextId,
      },
    });
    expect(secondUpdate.statusCode).toBe(200);

    const callContextGet = (id: number, contextRef?: string) => application.app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      payload: {
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          name: "context_get",
          arguments: contextRef === undefined ? {} : { context_ref: contextRef },
        },
      },
    });

    const ambiguousResponse = await callContextGet(2);
    expect(ambiguousResponse.statusCode).toBe(200);
    const ambiguous = ambiguousResponse.json<{
      result: { structuredContent: { ok: boolean; error: { code: string; details: { candidates: unknown[] } } } };
    }>().result.structuredContent;
    expect(ambiguous).toMatchObject({ ok: false, error: { code: "AMBIGUOUS_CONTEXT" } });
    expect(ambiguous.error.details.candidates).toHaveLength(2);

    const released = await application.app.inject({
      method: "PUT",
      url: "/api/context",
      payload: {
        designId: null,
        selectedNodeIds: [],
        clientContextId: firstClientContextId,
      },
    });
    expect(released.statusCode).toBe(200);
    expect(released.json()).toEqual({ designId: null, pageId: null, selection: [], updatedAt: null });

    const resolvedResponse = await callContextGet(3);
    expect(resolvedResponse.statusCode).toBe(200);
    expect(resolvedResponse.json<{
      result: { structuredContent: { ok: boolean; context: Record<string, unknown> } };
    }>().result.structuredContent).toMatchObject({
      ok: true,
      context: {
        designId: secondDesign.document.id,
        pageId: secondDesign.document.pages[0]!.id,
        selection: [secondNodeId],
        contextSource: "actor",
      },
    });

    const releasedRefResponse = await callContextGet(4, firstContext.contextRef);
    expect(releasedRefResponse.statusCode).toBe(200);
    expect(releasedRefResponse.json<{
      result: { structuredContent: { ok: boolean; error: { code: string } } };
    }>().result.structuredContent).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });

    const malformed = await application.app.inject({
      method: "PUT",
      url: "/api/context",
      payload: {
        designId: secondDesign.document.id,
        selectedNodeIds: [],
        clientContextId: "bad/client",
      },
    });
    expect(malformed.statusCode).toBe(422);
    expect(malformed.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_FAILED");
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
    const staleBody = stale.json<{ error?: {
      code?: string;
      details?: {
        currentRevisionId?: string;
        latestRevision?: {
          id: string;
          version: number;
          actorId: string;
          createdAt: string;
          message?: string;
        } | null;
      };
    } }>();
    expect(staleBody.error?.code, stale.body).toBe("VERSION_CONFLICT");
    expect(staleBody.error?.details).toMatchObject({
      currentRevisionId: updateBody.revisionId,
      latestRevision: {
        id: updateBody.revisionId,
        version: 2,
        actorId: "local",
        message: "Rename screen",
      },
    });
    expect(staleBody.error?.details?.latestRevision?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

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
      dataStoreId: string;
      renderMetadata: { sha256: string };
    }>();
    expect(preview.canCommit).toBe(true);
    expect(preview.createdIds.temporary["tmp:card"]).toMatch(/^node_/);
    expect(preview.dataStoreId).toBe(application.database.dataStoreId());

    const renderJobsBeforeExact = (application.database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM render_jobs WHERE design_id = ?",
    ).get(created.document.id) as { count: number }).count;
    const exact = await application.app.inject({
      method: "GET",
      url: `/api/designs/${created.document.id}/previews/${preview.previewId}/render.png?storeId=${preview.dataStoreId}`,
      headers: { "x-designer-user": "alice" },
    });
    expect(exact.statusCode, exact.body).toBe(200);
    expect(exact.headers["cache-control"]).toBe("no-store");
    expect(exact.headers["x-formaspec-preview-artifact"]).toBe("stored");
    expect(createHash("sha256").update(exact.rawPayload).digest("hex")).toBe(preview.renderMetadata.sha256);
    expect((application.database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM render_jobs WHERE design_id = ?",
    ).get(created.document.id) as { count: number }).count).toBe(renderJobsBeforeExact);

    await fs.promises.rm(application.previewRenderStore.artifactPath(preview.renderMetadata.sha256));
    const hydrated = await application.app.inject({
      method: "GET",
      url: `/api/designs/${created.document.id}/previews/${preview.previewId}/render.png?storeId=${preview.dataStoreId}`,
      headers: { "x-designer-user": "alice" },
    });
    expect(hydrated.statusCode, hydrated.body).toBe(200);
    expect(hydrated.headers["x-formaspec-preview-artifact"]).toBe("hydrated");
    expect(createHash("sha256").update(hydrated.rawPayload).digest("hex")).toBe(preview.renderMetadata.sha256);
    expect(application.previewRenderStore.read(preview.renderMetadata.sha256)).toEqual(hydrated.rawPayload);

    const wrongStore = await application.app.inject({
      method: "GET",
      url: `/api/designs/${created.document.id}/previews/${preview.previewId}?storeId=store_${"f".repeat(32)}`,
      headers: { "x-designer-user": "alice" },
    });
    expect(wrongStore.statusCode).toBe(409);
    expect(wrongStore.json()).toMatchObject({ error: { code: "DATA_STORE_MISMATCH" } });

    const render = await application.app.inject({
      method: "GET",
      url: `/api/designs/${created.document.id}/previews/${preview.previewId}/render.png?mode=adhoc&maxSize=512`,
      headers: { "x-designer-user": "alice" },
    });
    expect(render.statusCode).toBe(200);
    expect(render.headers["content-type"]).toContain("image/png");
    expect(render.rawPayload.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(application.database.sqlite.prepare(
      `SELECT organization_id, design_id, revision_id, document_revision, kind, status,
              output_sha256, output_bytes, output_renderer
       FROM render_jobs WHERE design_id = ? ORDER BY created_at DESC LIMIT 1`,
    ).get(created.document.id)).toMatchObject({
      organization_id: "organization_legacy",
      design_id: created.document.id,
      revision_id: null,
      document_revision: 2,
      kind: "render",
      status: "succeeded",
      output_sha256: createHash("sha256").update(render.rawPayload).digest("hex"),
      output_bytes: render.rawPayload.length,
      output_renderer: expect.stringMatching(/^(playwright|software)$/),
    });

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
      sha256: string;
      operation: { type: string; asset: { id: string; storage_key: string } };
    }>();
    expect(asset.id).toMatch(/^asset_/);
    expect(asset.width).toBe(1);
    expect(asset.height).toBe(1);
    expect(asset.operation).toMatchObject({
      type: "upsert_asset",
      asset: { id: asset.id, storage_key: `asset:${asset.id}` },
    });
    expect(application.database.sqlite.prepare(
      `SELECT organization_id, design_id, scope_kind, operation, kind, status, output_renderer
       FROM render_jobs WHERE kind = 'normalize_raster' ORDER BY created_at DESC LIMIT 1`,
    ).get()).toEqual({
      organization_id: "organization_legacy",
      design_id: null,
      scope_kind: "organization",
      operation: "asset_upload",
      kind: "normalize_raster",
      status: "succeeded",
      output_renderer: "chromium",
    });

    const fetched = await application.app.inject({
      method: "GET",
      url: `/api/assets/${asset.id}`,
      headers: { "x-designer-user": "bob" },
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.rawPayload).not.toEqual(png);
    expect(fetched.rawPayload.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(fetched.headers.etag).toBe(`"${asset.sha256}"`);

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

  it("reserves the archive route for exact-name project soft deletion, not node mutation", async () => {
    const created = await createDesign(application.app, "alice", "create-no-archive-shortcut-0001");
    const response = await application.app.inject({
      method: "POST",
      url: `/api/designs/${created.document.id}/archive`,
      payload: {
        nodeIds: [created.document.pages[0]!.children[0]!],
        expectedBaseVersion: 1,
        idempotencyKey: "removed-archive-shortcut-0001",
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_FAILED");
    expect(application.service.getDesign("alice", created.document.id).revision.version).toBe(1);
  });

  it("serves exact product-specification previews, planning sessions, and immutable agent tasks", async () => {
    const created = await createDesign(application.app, "alice", "enterprise-http-design-0001");
    const designId = created.document.id;
    const previewResponse = await application.app.inject({
      method: "POST",
      url: `/api/designs/${designId}/product-specification/previews`,
      payload: {
        baseVersion: 0,
        naturalLanguageBrief: "A bilingual courier dashboard with dispatcher roles, sensitive payout actions, and explicit loading, empty, and error states.",
      },
    });
    expect(previewResponse.statusCode).toBe(201);
    const preview = previewResponse.json<{
      previewId: string;
      baseVersion: number;
      version: number;
      specificationHash: string;
      naturalLanguageBrief: string;
      canCommit: boolean;
    }>();
    expect(preview).toMatchObject({ baseVersion: 0, version: 1, canCommit: true });
    expect(preview.specificationHash).toMatch(/^[a-f0-9]{64}$/);

    const commitPayload = {
      expectedBaseVersion: 0,
      idempotencyKey: "enterprise-http-spec-commit-0001",
      message: "Create canonical product brief",
    };
    const committedResponse = await application.app.inject({
      method: "POST",
      url: `/api/designs/${designId}/product-specification/previews/${preview.previewId}/commit`,
      payload: commitPayload,
    });
    expect(committedResponse.statusCode).toBe(200);
    const committed = committedResponse.json<{ version: number; specificationHash: string; naturalLanguageBrief: string }>();
    expect(committed).toMatchObject({
      version: 1,
      specificationHash: preview.specificationHash,
      naturalLanguageBrief: preview.naturalLanguageBrief,
    });
    const retried = await application.app.inject({
      method: "POST",
      url: `/api/designs/${designId}/product-specification/previews/${preview.previewId}/commit`,
      payload: commitPayload,
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toEqual(committedResponse.json());

    const planning = await application.app.inject({
      method: "POST",
      url: `/api/designs/${designId}/planning-sessions`,
      payload: { idempotencyKey: "enterprise-http-planning-0001" },
    });
    expect(planning.statusCode).toBe(201);
    expect(planning.json<{ session: { current_section: string }; sectionCount: number }>()
      .session.current_section).toBe("product_purpose");
    expect(planning.json<{ sectionCount: number }>().sectionCount).toBe(22);

    const removedBrowserTaskCreate = await application.app.inject({
      method: "POST",
      url: `/api/designs/${designId}/agent-tasks`,
      payload: {
        brief: committed.naturalLanguageBrief,
        selection: [],
        baseVersion: 1,
        expectedOutput: "design_preview",
        idempotencyKey: "enterprise-http-task-0001",
      },
    });
    expect(removedBrowserTaskCreate.statusCode).toBe(404);

    const seededTask = application.enterprise.createAgentTask("local", {
      designId,
      brief: committed.naturalLanguageBrief,
      selection: [],
      baseVersion: 1,
      expectedOutput: "design_preview",
      idempotencyKey: "enterprise-service-task-0001",
    });
    const taskListResponse = await application.app.inject({
      method: "GET",
      url: `/api/designs/${designId}/agent-tasks`,
    });
    expect(taskListResponse.statusCode).toBe(200);
    const task = taskListResponse.json<{ tasks: Array<{ id: string; status: string; launchUrl: string }> }>()
      .tasks.find((candidate) => candidate.id === seededTask.id)!;
    expect(task.status).toBe("queued");
    const taskLaunch = new URL(task.launchUrl);
    expect(taskLaunch.protocol).toBe("codex:");
    expect(taskLaunch.hostname).toBe("new");
    expect([...taskLaunch.searchParams.keys()]).toEqual(["prompt"]);
    expect(taskLaunch.searchParams.get("prompt")).toContain(`Claim task ${task.id} with task_claim`);
    expect(taskLaunch.searchParams.get("prompt")).toContain("design_preview_changes");
    expect(taskLaunch.searchParams.get("prompt")).toContain("returned PNG in Codex");
    expect(taskLaunch.searchParams.get("prompt")).toContain("immutable Product");
    expect(taskLaunch.searchParams.get("prompt")).toContain('task_transition to awaiting_approval with data {"previewId":"<preview id>","readiness":');
    expect(taskLaunch.searchParams.get("prompt")).toContain("DesignReadinessReport");
    expect(taskLaunch.searchParams.get("prompt")).toContain("Do not commit it");
    expect(task.launchUrl).not.toMatch(/(?:bearer(?:%20|\+|\s)+[a-z0-9._~-]+|(?:access|mcp|auth)[_-]?token(?:=|%3D)|nonce(?:=|%3D))/i);

    const inspectResponse = await application.app.inject({
      method: "GET",
      url: `/api/projects/${designId}/revisions/${created.revisionId}/inspect`,
    });
    expect(inspectResponse.statusCode).toBe(200);
    const inspect = inspectResponse.json<{
      project: { version: number; revisionId: string };
      head: { version: number; revisionId: string };
      integrity: { revisionId: string; revisionHash: string; snapshotHash: string; schemaVersion: number };
      nodes: Array<{ id: string; jsonPath: string; boundingBox: { width: number } }>;
      evidence: {
        tokens: unknown[];
        assets: unknown[];
        components: unknown[];
        businessRules: unknown[];
        acceptanceCriteria: unknown[];
        implementationMappings: unknown[];
      };
      limitations: string[];
    }>();
    expect(inspect.project).toMatchObject({ version: 1, revisionId: created.revisionId });
    expect(inspect.head).toMatchObject({ version: 1, revisionId: created.revisionId });
    expect(inspect.integrity).toMatchObject({ revisionId: created.revisionId, schemaVersion: 1 });
    expect(inspect.integrity.revisionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(inspect.integrity.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
    expect(inspect.nodes[0]?.jsonPath).toContain('$.nodes["node_');
    expect(inspect.nodes[0]?.boundingBox.width).toBeGreaterThan(0);
    expect(inspect.evidence).toMatchObject({
      tokens: [],
      assets: [],
      components: [],
      businessRules: [],
      acceptanceCriteria: [],
      implementationMappings: [],
    });
    expect(inspect.limitations).toContain("No product specification version is explicitly pinned to this historical design revision.");
  });

  it("accepts staged connection rotation through REST and rejects the old grant only after pairing", async () => {
    const connectionInput = {
      adapter: "codex",
      displayName: "Codex through the local FormaSpec bridge",
      scopes: ["design:read"],
      expiresInSeconds: 3_600,
    };
    const firstResponse = await application.app.inject({
      method: "POST",
      url: "/api/agent-connections",
      payload: connectionInput,
    });
    expect(firstResponse.statusCode).toBe(201);
    const first = firstResponse.json<{ connection: { id: string }; nonce: string }>();
    const pairedResponse = await application.app.inject({
      method: "POST",
      url: "/api/agent-connections/pair",
      payload: { nonce: first.nonce },
    });
    expect(pairedResponse.statusCode).toBe(200);
    const paired = pairedResponse.json<{ grant: { token: string } }>();

    const replacementResponse = await application.app.inject({
      method: "POST",
      url: "/api/agent-connections",
      payload: { ...connectionInput, replaceExisting: true },
    });
    expect(replacementResponse.statusCode).toBe(201);
    const replacement = replacementResponse.json<{ connection: { id: string; status: string }; nonce: string }>();
    expect(replacement.connection).toMatchObject({ status: "pending" });

    const connectionsResponse = await application.app.inject({ method: "GET", url: "/api/agent-connections" });
    const connections = connectionsResponse.json<{ connections: Array<{ id: string; status: string }> }>().connections;
    expect(connections.find((connection) => connection.id === first.connection.id)?.status).toBe("active");
    expect(connections.find((connection) => connection.id === replacement.connection.id)?.status).toBe("pending");

    const grantDuringPairing = await application.app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${paired.grant.token}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "rotation-test", version: "1.0.0" },
        },
      },
    });
    expect(grantDuringPairing.statusCode).toBe(200);

    const pairedReplacement = await application.app.inject({
      method: "POST",
      url: "/api/agent-connections/pair",
      payload: { nonce: replacement.nonce },
    });
    expect(pairedReplacement.statusCode).toBe(200);

    const rejectedGrant = await application.app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${paired.grant.token}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      payload: {
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "rotation-test", version: "1.0.0" },
        },
      },
    });
    expect(rejectedGrant.statusCode).toBe(401);
    expect(rejectedGrant.json<{ error: { code: string } }>().error.code).toBe("AUTH_REQUIRED");
  });

  it("returns only the authenticated scoped grant's own authorization context", async () => {
    const created = await createDesign(application.app, "local", "authorization-context-design-0001");
    const challengeResponse = await application.app.inject({
      method: "POST",
      url: "/api/agent-connections",
      payload: {
        adapter: "codex",
        displayName: "Authorization context test",
        scopes: ["design:read", "task:read"],
        projectIds: [created.document.id],
        expiresInSeconds: 3_600,
      },
    });
    expect(challengeResponse.statusCode).toBe(201);
    const challenge = challengeResponse.json<{ nonce: string }>();
    const pairedResponse = await application.app.inject({
      method: "POST",
      url: "/api/agent-connections/pair",
      payload: { nonce: challenge.nonce },
    });
    expect(pairedResponse.statusCode).toBe(200);
    const paired = pairedResponse.json<{ grant: { token: string } }>();

    const unauthenticated = await application.app.inject({
      method: "GET",
      url: "/api/agent-authorization-context",
    });
    expect(unauthenticated.statusCode).toBe(401);

    const contextResponse = await application.app.inject({
      method: "GET",
      url: "/api/agent-authorization-context",
      headers: { authorization: `Bearer ${paired.grant.token}` },
    });
    expect(contextResponse.statusCode).toBe(200);
    expect(contextResponse.headers["cache-control"]).toBe("no-store");
    const context = contextResponse.json<Record<string, unknown>>();
    expect(context).toEqual({
      role: "agent",
      scopes: ["design:read", "task:read"],
      projectIds: [created.document.id],
    });
    expect(Object.keys(context).sort()).toEqual(["projectIds", "role", "scopes"]);
    expect(JSON.stringify(context)).not.toMatch(/token|credential|grant|principal|connection/i);
  });

  it("exposes persisted design-system, inventory, handoff, and redesign workflows through REST and the replayable outbox", async () => {
    const created = await createDesign(application.app, "local", "enterprise-domain-create-0001");
    const headers = { "x-designer-user": "local" };

    const systemResponse = await application.app.inject({
      method: "POST",
      url: "/api/design-systems",
      headers,
      payload: { name: "Company system", description: "Published organization primitives and components." },
    });
    expect(systemResponse.statusCode).toBe(201);
    expect(systemResponse.json<{ designSystem: { id: string; status: string } }>().designSystem).toMatchObject({
      id: expect.stringMatching(/^system_/),
      status: "active",
    });

    const inventoryEntityId = `inv_${"a".repeat(40)}`;
    const inventoryResponse = await application.app.inject({
      method: "POST",
      url: "/api/repository-inventories",
      headers,
      payload: {
        schemaVersion: 1,
        repositoryFingerprint: "b".repeat(64),
        generatedAt: "2026-07-19T12:00:00.000Z",
        platforms: ["web"],
        gitHead: null,
        scannedFileCount: 1,
        skippedFileCount: 0,
        bytesRead: 128,
        truncated: false,
        excludedPatterns: [".env", ".env.*", "*.pem", "*.key", "**/secrets/**", "**/.git/**"],
        entities: [{
          id: inventoryEntityId,
          kind: "component",
          name: "CheckoutScreen",
          symbol: "CheckoutScreen",
          locationId: `loc_${"c".repeat(40)}`,
          line: 1,
        }],
        excluded: [
          { category: "secret", count: 0 },
          { category: "generated", count: 0 },
          { category: "symlink", count: 0 },
          { category: "limit", count: 0 },
        ],
      },
    });
    expect(inventoryResponse.statusCode).toBe(201);
    const inventoryId = inventoryResponse.json<{ inventory: { id: string } }>().inventory.id;

    const mappingListResponse = await application.app.inject({
      method: "GET",
      url: `/api/designs/${created.document.id}/implementation-mappings?limit=25`,
      headers,
    });
    expect(mappingListResponse.statusCode).toBe(200);
    expect(mappingListResponse.json<{ mappings: unknown[] }>().mappings).toEqual([]);

    const handoffResponse = await application.app.inject({
      method: "POST",
      url: `/api/designs/${created.document.id}/handoffs`,
      headers,
      payload: {
        revisionId: created.revisionId,
        expectedDesignVersion: 1,
        inventoryId,
        specification: {
          schemaVersion: 1,
          title: "Implement checkout",
          summary: "Implement the exact approved checkout revision in one bounded slice.",
          acceptanceCriteria: [{
            id: "checkout_renders",
            statement: "The checkout screen matches the approved revision.",
            designEntityIds: [],
          }],
          implementationSlices: [{
            id: "checkout_screen",
            title: "Checkout screen",
            objective: "Implement the mapped checkout screen without unrelated source changes.",
            inventoryEntityIds: [inventoryEntityId],
            designEntityIds: [],
            dependsOn: [],
            validationChecks: ["typecheck", "unit_tests", "build"],
          }],
          risks: [],
          openQuestions: [],
          implementationPolicy: {
            preferredIsolation: "worktree",
            commitRequiresExplicitApproval: true,
            pullRequestRequiresExplicitRequest: true,
          },
        },
      },
    });
    expect(handoffResponse.statusCode).toBe(201);
    expect(handoffResponse.json<{ handoff: { status: string; currentVersion: number } }>().handoff).toMatchObject({
      status: "draft",
      currentVersion: 1,
    });

    const redesignResponse = await application.app.inject({
      method: "POST",
      url: "/api/redesign-assessments",
      headers,
      payload: {
        designId: created.document.id,
        expectedDesignVersion: 1,
        brief: "Assess the current checkout before proposing any future-state design.",
        content: { requestedBy: "product_manager" },
      },
    });
    expect(redesignResponse.statusCode).toBe(201);
    expect(redesignResponse.json<{ assessment: { currentStage: string; sourceMutation: string } }>().assessment).toMatchObject({
      currentStage: "connect_inspect",
      sourceMutation: "none",
    });

    expect(application.database.sqlite.prepare(
      `SELECT event_type, published_at IS NOT NULL AS published
       FROM event_outbox
       WHERE event_type IN (
         'design_system.changed', 'repository_inventory.changed',
         'handoff.transitioned', 'redesign.transitioned'
       ) ORDER BY id`,
    ).all()).toEqual([
      { event_type: "design_system.changed", published: 1 },
      { event_type: "repository_inventory.changed", published: 1 },
      { event_type: "handoff.transitioned", published: 1 },
      { event_type: "redesign.transitioned", published: 1 },
    ]);
  });

  it("initializes the stateless Streamable HTTP MCP endpoint", async () => {
    let mcpToken: string | undefined;
    const mcpRequest = (payload: Record<string, unknown>) => application.app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "x-designer-user": "alice",
        ...(mcpToken === undefined ? {} : { authorization: `Bearer ${mcpToken}` }),
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
    const body = response.json<{ result: { serverInfo: { name: string; version: string }; instructions: string } }>();
    expect(body.result.serverInfo.name).toBe("formaspec");
    expect(body.result.serverInfo.version).toBe("0.4.0");
    expect(body.result.instructions).toContain("one exact Product and Design");
    expect(body.result.instructions).toContain("context_get is informational only");
    expect(body.result.instructions).toContain("task_create.selection_confirmation");
    expect(body.result.instructions).toContain("frozen product specification");
    expect(body.result.instructions).toContain("effective design-system release");
    expect(body.result.instructions).toContain("repository inventory/mappings");
    expect(body.result.instructions).toContain("validated data.readiness");
    expect(body.result.instructions).not.toContain("Use Minimal UI");
    expect(body.result.instructions).not.toContain("plugin://minimal-ui");
    expect(body.result.instructions).toContain("Only a human may Commit or Discard");
    expect(body.result.instructions).toContain("agents never commit");
    expect(body.result.instructions).toContain("tmp:<label>");
    expect(body.result.instructions.length).toBeLessThanOrEqual(1_024);

    const toolsResponse = await mcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(toolsResponse.statusCode).toBe(200);
    const tools = toolsResponse.json<{ result: { tools: Array<{
      name: string;
      description?: string;
      inputSchema?: { properties?: Record<string, unknown> };
      outputSchema?: unknown;
      annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
    }> } }>().result.tools;
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "design_list",
      "design_create",
      "design_preview_changes",
      "design_preview_archive_nodes",
      "design_commit_preview",
      "product_spec_preview",
      "planning_session_create",
      "task_claim",
      "organization_policy_read",
      "design_system_read",
      "design_system_list",
      "repository_inventory_persist",
      "repository_inventory_read",
      "implementation_mapping_read",
      "implementation_mapping_create",
      "handoff_read",
      "redesign_assessment_list",
      "redesign_assessment_create",
      "redesign_stage_artifact_read",
      "redesign_stage_artifact_write",
      "redesign_stage_transition",
    ]));
    expect(tools.find((tool) => tool.name === "task_create")?.inputSchema?.properties)
      .toHaveProperty("selection_confirmation");
    expect(tools.find((tool) => tool.name === "redesign_stage_transition")?.description).toContain("review-ready");
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
    expect(tools.find((tool) => tool.name === "design_commit_archive_preview")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(tools.find((tool) => tool.name === "repository_inventory_persist")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(tools.find((tool) => tool.name === "implementation_mapping_read")?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(tools.find((tool) => tool.name === "implementation_mapping_create")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });

    const policyToolResponse = await mcpRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "organization_policy_read", arguments: { format: "json" } },
    });
    expect(policyToolResponse.statusCode).toBe(200);
    expect(policyToolResponse.json<{ result: { structuredContent: { organizationPolicy: { policyHash: string } } } }>()
      .result.structuredContent.organizationPolicy.policyHash).toMatch(/^[a-f0-9]{64}$/);

    const inventoryToolResponse = await mcpRequest({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "repository_inventory_persist",
        arguments: {
          inventory: {
            schemaVersion: 1,
            repositoryFingerprint: "a".repeat(64),
            generatedAt: "2026-07-20T12:00:00.000Z",
            platforms: ["generic-git"],
            gitHead: null,
            excludedPatterns: [".env", ".env.*", "*.pem", "*.key", "**/secrets/**", "**/.git/**"],
            scannedFileCount: 0,
            skippedFileCount: 0,
            bytesRead: 0,
            truncated: false,
            entities: [],
            excluded: [],
          },
        },
      },
    });
    expect(inventoryToolResponse.statusCode).toBe(200);
    expect(inventoryToolResponse.json<{
      result: { structuredContent: { ok: boolean; inventory: { id: string; repositoryFingerprint: string } } };
    }>().result.structuredContent).toMatchObject({
      ok: true,
      inventory: { repositoryFingerprint: "a".repeat(64) },
    });

    const schemaResourceResponse = await mcpRequest({
      jsonrpc: "2.0",
      id: 20,
      method: "resources/read",
      params: { uri: "formaspec://schema/v1" },
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
      params: { uri: "formaspec://designs/document_missing_12345678/head" },
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

    const previewConnection = application.enterprise.createAgentConnection("local", {
      adapter: "codex",
      displayName: "MCP task-preview integration",
      scopes: [
        "design:read",
        "design:preview",
        "design:write",
        "task:create",
        "task:read",
        "task:claim",
        "task:update",
      ],
      projectIds: [created.result.structuredContent.document.id],
      expiresInSeconds: 3_600,
    });
    mcpToken = application.enterprise.pairAgentConnection(previewConnection.nonce).grant.token;
    const confirmedTarget = application.database.sqlite.prepare(
      `SELECT design.id AS design_id, design.name AS design_name,
              product.id AS product_id, product.name AS product_name
       FROM designs design JOIN products product ON product.id = design.product_id
       WHERE design.id = ?`,
    ).get(created.result.structuredContent.document.id) as {
      design_id: string;
      design_name: string;
      product_id: string;
      product_name: string;
    };
    const taskResponse = await mcpRequest({
      jsonrpc: "2.0",
      id: 51,
      method: "tools/call",
      params: {
        name: "task_create",
        arguments: {
          design_id: created.result.structuredContent.document.id,
          brief: "Create the MCP card as an exact proposal",
          selection: [rootNodeId],
          base_version: 1,
          selection_confirmation: {
            source: "user_confirmed",
            ...confirmedTarget,
            base_version: 1,
          },
          expected_output: "design_preview",
          idempotency_key: "mcp-preview-task-create-0001",
        },
      },
    });
    const taskId = taskResponse.json<{
      result: { structuredContent: { task: { id: string } } };
    }>().result.structuredContent.task.id;
    await mcpRequest({
      jsonrpc: "2.0",
      id: 52,
      method: "tools/call",
      params: { name: "task_claim", arguments: { task_id: taskId } },
    });
    await mcpRequest({
      jsonrpc: "2.0",
      id: 53,
      method: "tools/call",
      params: {
        name: "task_transition",
        arguments: { task_id: taskId, expected_status: "claimed", to_status: "in_progress" },
      },
    });

    const previewResponse = await mcpRequest({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "design_preview_changes",
        arguments: {
          design_id: created.result.structuredContent.document.id,
          task_id: taskId,
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
          preview: {
            id: string;
            rootBaseVersion: number;
            projectDeepLink: string;
            reviewDeepLink: string | null;
            createdIds: { temporary: Record<string, string> };
          };
        };
      };
    }>();
    expect(preview.result.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "image", mimeType: "image/png" })]));
    expect(preview.result.structuredContent.preview.rootBaseVersion).toBe(1);
    expect(preview.result.structuredContent.preview.createdIds.temporary["tmp:card"]).toMatch(/^node_/);
    expect(preview.result.structuredContent.preview.projectDeepLink).toContain(`/design/${created.result.structuredContent.document.id}`);
    expect(preview.result.structuredContent.preview.reviewDeepLink).toBeNull();

    const awaitingResponse = await mcpRequest({
      jsonrpc: "2.0",
      id: 61,
      method: "tools/call",
      params: {
        name: "task_transition",
        arguments: {
          task_id: taskId,
          expected_status: "in_progress",
          to_status: "awaiting_approval",
          data: {
            previewId: preview.result.structuredContent.preview.id,
            readiness: designReadinessFixture(
              application.enterprise.readAgentTask("local", taskId).resolvedContext,
            ),
          },
        },
      },
    });
    expect(awaitingResponse.json<{
      result: { structuredContent: { task: { status: string }; reviewDeepLink: string } };
    }>().result.structuredContent).toMatchObject({
      task: { status: "awaiting_approval" },
      reviewDeepLink: expect.stringContaining(preview.result.structuredContent.preview.id),
    });

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
      result: { structuredContent: { ok: boolean; error: { code: string } } };
    }>();
    expect(committed.result.structuredContent).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
    const humanCommit = await application.app.inject({
      method: "POST",
      url: `/api/designs/${created.result.structuredContent.document.id}/previews/${preview.result.structuredContent.preview.id}/commit`,
      headers: { "x-designer-user": "alice" },
      payload: {
        expectedBaseVersion: 1,
        idempotencyKey: "mcp-human-commit-key-0001",
        message: "Approve MCP card",
        taskId,
      },
    });
    expect(humanCommit.statusCode, humanCommit.body).toBe(200);
    expect(humanCommit.json()).toMatchObject({ version: 2, task: { status: "completed" } });

    const createdCardId = preview.result.structuredContent.preview.createdIds.temporary["tmp:card"]!;
    const archiveTaskResponse = await mcpRequest({
      jsonrpc: "2.0",
      id: 62,
      method: "tools/call",
      params: {
        name: "task_create",
        arguments: {
          design_id: created.result.structuredContent.document.id,
          brief: "Archive the MCP card after human review",
          selection: [createdCardId],
          base_version: 2,
          selection_confirmation: {
            source: "user_confirmed",
            ...confirmedTarget,
            base_version: 2,
          },
          expected_output: "design_preview",
          idempotency_key: "mcp-archive-task-create-0001",
        },
      },
    });
    const archiveTaskId = archiveTaskResponse.json<{
      result: { structuredContent: { task: { id: string } } };
    }>().result.structuredContent.task.id;
    await mcpRequest({
      jsonrpc: "2.0",
      id: 63,
      method: "tools/call",
      params: { name: "task_claim", arguments: { task_id: archiveTaskId } },
    });
    await mcpRequest({
      jsonrpc: "2.0",
      id: 64,
      method: "tools/call",
      params: {
        name: "task_transition",
        arguments: { task_id: archiveTaskId, expected_status: "claimed", to_status: "in_progress" },
      },
    });
    const archivePreviewResponse = await mcpRequest({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: {
        name: "design_preview_archive_nodes",
        arguments: {
          design_id: created.result.structuredContent.document.id,
          task_id: archiveTaskId,
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
    await mcpRequest({
      jsonrpc: "2.0",
      id: 65,
      method: "tools/call",
      params: {
        name: "task_transition",
        arguments: {
          task_id: archiveTaskId,
          expected_status: "in_progress",
          to_status: "awaiting_approval",
          data: {
            previewId: archivePreview.result.structuredContent.preview.id,
            readiness: designReadinessFixture(
              application.enterprise.readAgentTask("local", archiveTaskId).resolvedContext,
            ),
          },
        },
      },
    });

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
      error: { code: "FORBIDDEN" },
    });

    const destructiveArchiveCommit = await mcpRequest({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "design_commit_archive_preview",
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
      result: { structuredContent: { ok: boolean; error: { code: string } } };
    }>().result.structuredContent).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    const humanArchiveCommit = await application.app.inject({
      method: "POST",
      url: `/api/designs/${created.result.structuredContent.document.id}/archive-previews/${archivePreview.result.structuredContent.preview.id}/commit`,
      headers: { "x-designer-user": "alice" },
      payload: {
        expectedBaseVersion: 2,
        idempotencyKey: "mcp-archive-human-commit-0001",
        message: "Approve MCP card archive",
        taskId: archiveTaskId,
      },
    });
    expect(humanArchiveCommit.statusCode, humanArchiveCommit.body).toBe(200);
    expect(humanArchiveCommit.json()).toMatchObject({ version: 3, task: { status: "completed" } });
  });

  it("serves, updates, audits, and exports the strict secret-free organization policy", async () => {
    const read = await application.app.inject({ method: "GET", url: "/api/organization/policy" });
    expect(read.statusCode).toBe(200);
    const current = read.json<{
      organizationPolicy: {
        source: string;
        configurationHash: string;
        policyHash: string;
        policy: Record<string, unknown>;
      };
    }>().organizationPolicy;
    expect(current.source).toBe("default");

    const policy = structuredClone(current.policy) as {
      agents: { maximumActiveConnections: number };
      repositories: { allowedPlatforms: string[] };
    };
    policy.agents.maximumActiveConnections = 4;
    policy.repositories.allowedPlatforms = ["web", "android"];
    const updated = await application.app.inject({
      method: "PUT",
      url: "/api/organization/policy",
      payload: { expectedConfigurationHash: current.configurationHash, policy },
    });
    expect(updated.statusCode).toBe(200);
    const updatedPolicy = updated.json<{
      organizationPolicy: { configurationHash: string; policyHash: string; policy: { agents: { maximumActiveConnections: number } } };
    }>().organizationPolicy;
    expect(updatedPolicy.policy.agents.maximumActiveConnections).toBe(4);
    expect(updatedPolicy.configurationHash).toBe(updatedPolicy.policyHash);

    const exported = await application.app.inject({ method: "GET", url: "/api/organization/configuration" });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers["content-type"]).toContain("application/yaml");
    expect(exported.headers["content-disposition"]).toContain("organization.formaspec.yaml");
    expect(exported.body).toContain('format: "formaspec-organization-config"');
    expect(exported.body).not.toMatch(/bearer|password|token_hash/i);
    expect(application.database.sqlite.prepare(
      "SELECT action FROM audit_events WHERE action = 'organization_policy.update'",
    ).get()).toEqual({ action: "organization_policy.update" });
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
      APP_MODE: "server",
      HOST: "0.0.0.0",
      PORT: "4310",
      DATA_DIR: "/tmp/formaspec-designer-tests",
      DESIGNER_DATABASE_PATH: ":memory:",
      PUBLIC_BASE_URL: "https://designer.example.test",
      AUTH_MODE: "trusted-header",
      DESIGNER_TOKEN: "test-token-1234567890",
      TRUSTED_USER_HEADER: "x-company-user",
      FORMASPEC_TRUSTED_PROXIES: "127.0.0.1",
      FORMASPEC_PROXY_SECRET: PROXY_SECRET,
      DESIGNER_CORS_ORIGINS: "https://designer.example.test",
      DESIGNER_LOG_LEVEL: "silent",
    }));
    await secured.app.ready();
    try {
      const missingUiIdentity = await secured.app.inject({
        method: "GET",
        url: "/api/designs",
        headers: { host: "designer.example.test", "x-formaspec-proxy-secret": PROXY_SECRET },
      });
      expect(missingUiIdentity.statusCode).toBe(401);

      const ui = await secured.app.inject({
        method: "POST",
        url: "/api/designs",
        headers: {
          host: "designer.example.test",
          origin: "https://designer.example.test",
          "x-formaspec-csrf": "1",
          "x-company-user": "alice@example.test",
          "x-formaspec-proxy-secret": PROXY_SECRET,
        },
        payload: { name: "Secure selection", preset: "web", idempotencyKey: "secure-create-0001" },
      });
      expect(ui.statusCode).toBe(201);
      const uiDesign = ui.json<RevisionEnvelope>();
      const selectedNodeId = uiDesign.document.pages[0]?.children[0] as string;
      const identityPolicy = secured.policies.read("trusted:alice@example.test");
      const mappedIdentityPolicy = structuredClone(identityPolicy.policy);
      mappedIdentityPolicy.identity.roleMappings = [
        { claim: "identity", value: "alice@example.test", role: "organization_admin" },
        { claim: "identity", value: "bob@example.test", role: "design_editor" },
      ];
      secured.policies.update("trusted:alice@example.test", {
        expectedConfigurationHash: identityPolicy.configurationHash,
        policy: mappedIdentityPolicy,
      });

      const contextUpdate = await secured.app.inject({
        method: "PUT",
        url: "/api/context",
        headers: {
          host: "designer.example.test",
          origin: "https://designer.example.test",
          "x-formaspec-csrf": "1",
          "x-company-user": "alice@example.test",
          "x-formaspec-proxy-secret": PROXY_SECRET,
        },
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
        headers: {
          host: "designer.example.test",
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "x-company-user": "alice@example.test",
          "x-formaspec-proxy-secret": PROXY_SECRET,
        },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      });
      expect(mcpWithoutToken.statusCode).toBe(401);

      const mcp = await secured.app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          host: "designer.example.test",
          authorization: "Bearer test-token-1234567890",
          "x-formaspec-proxy-secret": PROXY_SECRET,
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
          host: "designer.example.test",
          authorization: "Bearer test-token-1234567890",
          "x-formaspec-proxy-secret": PROXY_SECRET,
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
        headers: {
          host: "designer.example.test",
          origin: "https://designer.example.test",
          "x-formaspec-csrf": "1",
          "x-company-user": "bob@example.test",
          "x-formaspec-proxy-secret": PROXY_SECRET,
        },
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
          host: "designer.example.test",
          authorization: "Bearer test-token-1234567890",
          "x-formaspec-proxy-secret": PROXY_SECRET,
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
          host: "designer.example.test",
          authorization: "Bearer test-token-1234567890",
          "x-formaspec-proxy-secret": PROXY_SECRET,
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

  it("enforces trusted-role mappings and legacy MCP-token policy through the HTTP boundary", async () => {
    const secured = await buildApplication(loadConfig({
      APP_MODE: "server",
      HOST: "0.0.0.0",
      PORT: "4310",
      DATA_DIR: "/tmp/formaspec-designer-tests",
      DESIGNER_DATABASE_PATH: ":memory:",
      PUBLIC_BASE_URL: "https://designer.example.test",
      AUTH_MODE: "trusted-header",
      DESIGNER_TOKEN: "policy-http-token-1234567890",
      TRUSTED_USER_HEADER: "x-company-user",
      FORMASPEC_TRUSTED_PROXIES: "127.0.0.1",
      FORMASPEC_PROXY_SECRET: PROXY_SECRET,
      DESIGNER_CORS_ORIGINS: "https://designer.example.test",
      DESIGNER_LOG_LEVEL: "silent",
    }));
    await secured.app.ready();
    try {
      const adminHeaders = {
        host: "designer.example.test",
        origin: "https://designer.example.test",
        "x-formaspec-csrf": "1",
        "x-company-user": "admin@example.test",
        "x-formaspec-proxy-secret": PROXY_SECRET,
      };
      const bootstrap = await secured.app.inject({ method: "GET", url: "/api/organization/policy", headers: adminHeaders });
      expect(bootstrap.statusCode).toBe(200);
      const current = secured.policies.read("trusted:admin@example.test");
      const disabled = structuredClone(DEFAULT_ORGANIZATION_POLICY);
      disabled.identity.roleMappings = [
        { claim: "identity", value: "admin@example.test", role: "organization_admin" },
        { claim: "trusted_user", value: "viewer@example.test", role: "viewer" },
      ];
      disabled.agents.allowLegacyEnvironmentToken = false;
      secured.policies.update("trusted:admin@example.test", {
        expectedConfigurationHash: current.configurationHash,
        policy: disabled,
      });

      const viewerWrite = await secured.app.inject({
        method: "POST",
        url: "/api/designs",
        headers: {
          host: "designer.example.test",
          origin: "https://designer.example.test",
          "x-formaspec-csrf": "1",
          "x-company-user": "viewer@example.test",
          "x-formaspec-proxy-secret": PROXY_SECRET,
        },
        payload: { name: "Forbidden viewer project", preset: "web", idempotencyKey: "viewer-policy-create-0001" },
      });
      expect(viewerWrite.statusCode).toBe(403);

      const deniedLegacy = await secured.app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer policy-http-token-1234567890",
          "content-type": "application/json",
          host: "designer.example.test",
          "x-formaspec-proxy-secret": PROXY_SECRET,
        },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      });
      expect(deniedLegacy.statusCode).toBe(401);

      const stored = secured.policies.read("trusted:admin@example.test");
      const readOnly = structuredClone(disabled);
      readOnly.agents.allowLegacyEnvironmentToken = true;
      readOnly.agents.allowedScopes = ["organization_policy:read", "design:read"];
      secured.policies.update("trusted:admin@example.test", {
        expectedConfigurationHash: stored.configurationHash,
        policy: readOnly,
      });
      const readOnlyWrite = await secured.app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer policy-http-token-1234567890",
          "content-type": "application/json",
          host: "designer.example.test",
          "x-formaspec-proxy-secret": PROXY_SECRET,
        },
        payload: {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "design_create",
            arguments: { name: "Forbidden legacy write", preset: "web", idempotency_key: "legacy-policy-create-0001" },
          },
        },
      });
      expect(readOnlyWrite.statusCode).toBe(200);
      expect(readOnlyWrite.json<{
        result: { structuredContent: { ok: boolean; error: { code: string } } };
      }>().result.structuredContent).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    } finally {
      await secured.app.close();
    }
  });
});
