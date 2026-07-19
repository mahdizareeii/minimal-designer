import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { safeFilename, validateImageAsset } from "./assets.js";
import type { ServerConfig } from "./config.js";
import { DomainError } from "./errors.js";
import type { EventHub } from "./events.js";
import type { PngRenderer } from "./render.js";
import type { DesignerService, RevisionResult } from "./service.js";

const idempotencyKeySchema = z.string().trim().min(8).max(200);
const designIdParams = z.object({ id: z.string().min(1).max(200) });

const createDesignSchema = z.object({
  name: z.string().trim().min(1).max(255),
  preset: z.enum(["web", "phone", "tablet"]).default("web"),
  idempotencyKey: idempotencyKeySchema,
}).strict();

const previewSchema = z.object({
  baseVersion: z.number().int().positive().optional(),
  basePreviewId: z.string().min(1).optional(),
  operations: z.array(z.unknown()).min(1).max(500),
}).strict();

const revisionSchema = z.object({
  baseVersion: z.number().int().positive(),
  operations: z.array(z.unknown()).min(1).max(500),
  idempotencyKey: idempotencyKeySchema,
  message: z.string().trim().min(1).max(500).optional(),
}).strict();

const restoreSchema = z.object({
  targetVersion: z.number().int().positive(),
  expectedBaseVersion: z.number().int().positive(),
  idempotencyKey: idempotencyKeySchema,
}).strict();

const archiveSchema = z.object({
  nodeIds: z.array(z.string().min(1)).min(1).max(500),
  expectedBaseVersion: z.number().int().positive(),
  idempotencyKey: idempotencyKeySchema,
}).strict();

const contextSchema = z.object({
  designId: z.string().min(1).nullable().optional(),
  pageId: z.string().min(1).nullable().optional(),
  selectedNodeIds: z.array(z.string().min(1)).max(500).default([]),
}).strict();

function revisionResponse(result: RevisionResult): Record<string, unknown> {
  return {
    version: result.revision.version,
    revisionId: result.revision.id,
    document: result.document,
    diagnostics: result.diagnostics,
    createdIds: result.createdIds,
  };
}

function parseInteger(value: unknown, fallback?: number): number | undefined {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new DomainError("VALIDATION_FAILED", "Expected a positive integer query value.", 422);
  return number;
}

function sendSse(reply: FastifyReply, events: EventHub, actorId: string): void {
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  reply.raw.write(": connected\n\n");
  const unsubscribe = events.subscribe(actorId, (event) => {
    const data = JSON.stringify({ type: event.type, actorId: event.actorId, timestamp: event.timestamp, ...event.data });
    reply.raw.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${data}\n\n`);
  });
  const heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 15_000);
  reply.raw.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

export function registerHttpRoutes(
  app: FastifyInstance,
  dependencies: {
    config: ServerConfig;
    service: DesignerService;
    events: EventHub;
    renderer: PngRenderer;
  },
): void {
  const { config, service, events, renderer } = dependencies;

  app.get("/health", async () => ({ ok: true }));
  app.get("/ready", async () => ({ ok: true, database: "ready" }));

  app.get("/api/designs", async (request) => {
    const query = z.object({ limit: z.coerce.number().int().min(1).max(100).optional(), cursor: z.string().optional() }).parse(request.query);
    return service.listDesigns(request.actorId, query.limit, query.cursor);
  });

  app.post("/api/designs", async (request, reply) => {
    const input = createDesignSchema.parse(request.body);
    const result = service.createDesign(request.actorId, input);
    return reply.code(201).send(revisionResponse(result));
  });

  app.get("/api/designs/:id", async (request) => {
    const { id } = designIdParams.parse(request.params);
    const query = request.query as Record<string, unknown>;
    return revisionResponse(service.getDesign(request.actorId, id, parseInteger(query.version)));
  });

  app.post("/api/designs/:id/previews", async (request, reply) => {
    const { id } = designIdParams.parse(request.params);
    const input = previewSchema.parse(request.body);
    const preview = service.createPreview(request.actorId, id, {
      ...(input.baseVersion === undefined ? {} : { baseVersion: input.baseVersion }),
      ...(input.basePreviewId === undefined ? {} : { basePreviewId: input.basePreviewId }),
      operations: input.operations,
    });
    return reply.code(201).send({
      previewId: preview.id,
      designId: preview.designId,
      rootBaseVersion: preview.rootBaseVersion,
      operationHash: preview.operationHash,
      expiresAt: preview.expiresAt,
      canCommit: preview.canCommit,
      destructive: preview.destructive,
      diagnostics: preview.diagnostics,
      createdIds: preview.createdIds,
      document: preview.document,
    });
  });

  app.post("/api/designs/:id/previews/:previewId/commit", async (request) => {
    const params = z.object({ id: z.string(), previewId: z.string() }).parse(request.params);
    const input = z.object({
      expectedBaseVersion: z.number().int().positive(),
      idempotencyKey: idempotencyKeySchema,
      message: z.string().trim().min(1).max(500).optional(),
    }).strict().parse(request.body);
    return revisionResponse(service.commitPreview(request.actorId, params.id, {
      previewId: params.previewId,
      expectedBaseVersion: input.expectedBaseVersion,
      idempotencyKey: input.idempotencyKey,
      allowDestructive: true,
      ...(input.message === undefined ? {} : { message: input.message }),
    }));
  });

  app.post("/api/designs/:id/revisions", async (request) => {
    const { id } = designIdParams.parse(request.params);
    const input = revisionSchema.parse(request.body);
    return revisionResponse(service.applyRevision(request.actorId, id, {
      baseVersion: input.baseVersion,
      operations: input.operations,
      idempotencyKey: input.idempotencyKey,
      ...(input.message === undefined ? {} : { message: input.message }),
    }));
  });

  app.get("/api/designs/:id/history", async (request) => {
    const { id } = designIdParams.parse(request.params);
    const query = z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }).parse(request.query);
    return { revisions: service.history(request.actorId, id, query.limit) };
  });

  app.post("/api/designs/:id/restore", async (request) => {
    const { id } = designIdParams.parse(request.params);
    return revisionResponse(service.restoreRevision(request.actorId, id, restoreSchema.parse(request.body)));
  });

  app.post("/api/designs/:id/archive", async (request) => {
    const { id } = designIdParams.parse(request.params);
    return revisionResponse(service.archiveNodes(request.actorId, id, archiveSchema.parse(request.body)));
  });

  app.get("/api/designs/:id/export", async (request, reply) => {
    const { id } = designIdParams.parse(request.params);
    const query = request.query as Record<string, unknown>;
    const result = service.getDesign(request.actorId, id, parseInteger(query.version));
    return reply
      .header("content-disposition", `attachment; filename="${id}-v${result.revision.version}.json"`)
      .send(result.document);
  });

  const renderDocument = async (
    actorId: string,
    designId: string,
    source: { version?: number; previewId?: string },
    query: Record<string, unknown>,
  ) => {
    const document = source.previewId
      ? service.getPreview(actorId, designId, source.previewId).document
      : service.getDesign(actorId, designId, source.version).document;
    const maxSize = parseInteger(query.maxSize, 2048);
    return renderer.render(document, {
      ...(typeof query.pageId === "string" ? { pageId: query.pageId } : {}),
      ...(typeof query.nodeId === "string" ? { nodeId: query.nodeId } : {}),
      ...(maxSize === undefined ? {} : { maxSize }),
    }, (assetId) => {
      try {
        const asset = service.getAsset(actorId, assetId);
        return `data:${asset.mimeType};base64,${asset.data.toString("base64")}`;
      } catch {
        return null;
      }
    });
  };

  app.get("/api/designs/:id/render.png", async (request, reply) => {
    const { id } = designIdParams.parse(request.params);
    const query = request.query as Record<string, unknown>;
    const version = parseInteger(query.version);
    const rendered = await renderDocument(request.actorId, id, version === undefined ? {} : { version }, query);
    return reply
      .header("content-type", "image/png")
      .header("cache-control", query.version ? "private, max-age=31536000, immutable" : "no-store")
      .header("x-designer-renderer", rendered.renderer)
      .header("x-designer-render-warnings", rendered.warnings.join(" | ").slice(0, 1000))
      .send(rendered.png);
  });

  app.get("/api/designs/:id/previews/:previewId/render.png", async (request, reply) => {
    const params = z.object({ id: z.string(), previewId: z.string() }).parse(request.params);
    const query = request.query as Record<string, unknown>;
    const rendered = await renderDocument(request.actorId, params.id, { previewId: params.previewId }, query);
    return reply
      .header("content-type", "image/png")
      .header("cache-control", "no-store")
      .header("x-designer-renderer", rendered.renderer)
      .header("x-designer-render-warnings", rendered.warnings.join(" | ").slice(0, 1000))
      .send(rendered.png);
  });

  app.get("/api/context", async (request) => service.getContext(request.actorId));
  app.put("/api/context", async (request) => {
    const input = contextSchema.parse(request.body);
    return service.setContext(request.actorId, {
      ...(input.designId !== undefined ? { designId: input.designId } : {}),
      ...(input.pageId !== undefined ? { pageId: input.pageId } : {}),
      selection: input.selectedNodeIds,
    });
  });

  app.get("/api/events", async (request, reply) => sendSse(reply, events, request.actorId));

  app.post("/api/assets", async (request, reply) => {
    const part = await request.file({ limits: { files: 1, fileSize: config.maxAssetBytes, fields: 8 } });
    if (!part) throw new DomainError("VALIDATION_FAILED", "A multipart file field is required.", 422);
    const data = await part.toBuffer();
    const info = validateImageAsset(data, part.mimetype, { maxBytes: config.maxAssetBytes, maxPixels: config.maxAssetPixels });
    const query = z.object({ designId: z.string().optional() }).parse(request.query);
    const asset = service.saveAsset(request.actorId, {
      ...(query.designId ? { designId: query.designId } : {}),
      filename: safeFilename(part.filename, info.mimeType),
      mimeType: info.mimeType,
      width: info.width,
      height: info.height,
      data,
    });
    const designAsset = {
      id: asset.id,
      name: asset.filename,
      kind: "image",
      mime_type: asset.mimeType,
      size_bytes: asset.sizeBytes,
      storage_key: `asset:${asset.id}`,
      sha256: asset.sha256,
      width: asset.width,
      height: asset.height,
      metadata: {},
    };
    return reply.code(201).send({
      ...asset,
      url: `${config.publicBaseUrl}/api/assets/${asset.id}`,
      designAsset,
      operation: { type: "upsert_asset", asset: designAsset },
    });
  });

  app.get("/api/assets/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const asset = service.getAsset(request.actorId, id);
    return reply
      .header("content-type", asset.mimeType)
      .header("content-length", asset.sizeBytes)
      .header("cache-control", "private, max-age=31536000, immutable")
      .header("etag", `"${asset.sha256}"`)
      .header("content-disposition", `inline; filename="${asset.filename.replaceAll('"', "_")}"`)
      .send(asset.data);
  });
}
