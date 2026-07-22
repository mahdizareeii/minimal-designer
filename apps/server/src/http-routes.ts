import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { normalizeImageAsset, safeFilename } from "./assets.js";
import { appendAuditEvent, resolveAccess } from "./authorization.js";
import { verifyBackupBundle, type BackupManager } from "./backup.js";
import type { ServerConfig } from "./config.js";
import { DomainError } from "./errors.js";
import { canReadDesignerEvent } from "./event-authorization.js";
import type { DesignerEvent, EventHub } from "./events.js";
import type { MaintenanceStore } from "./maintenance.js";
import type { OperationsService } from "./operations-service.js";
import type { PngRenderer, RenderOptions } from "./render.js";
import { createPortableProjectBundle, readPortableProjectBundle } from "./portable-export.js";
import {
  buildRevisionInspectSnapshot,
  type RevisionImplementationMappingRow,
} from "./revision-inspect.js";
import type { DesignerService, PreviewResult, RevisionResult } from "./service.js";
import type { EnterpriseService } from "./enterprise-service.js";

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

const previewRenderQuerySchema = z.object({
  taskId: z.string().min(1).max(240).optional(),
  _retry: z.string().max(100).optional(),
  mode: z.enum(["exact", "adhoc"]).default("exact"),
  pageId: z.string().min(1).max(300).optional(),
  nodeId: z.string().min(1).max(300).optional(),
  maxSize: z.coerce.number().int().min(64).max(4096).optional(),
}).strict();

const revisionSchema = z.object({
  baseVersion: z.number().int().positive(),
  operations: z.array(z.unknown()).min(1).max(500),
  idempotencyKey: idempotencyKeySchema,
  message: z.string().trim().min(1).max(500).optional(),
}).strict();

const v2MigrationSchema = z.object({
  expectedBaseVersion: z.number().int().positive(),
  backupId: z.string().regex(/^backup_[A-Za-z0-9][A-Za-z0-9_-]{7,}$/),
  idempotencyKey: idempotencyKeySchema,
}).strict();

const restoreSchema = z.object({
  targetVersion: z.number().int().positive(),
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
    snapshotHash: result.revision.snapshotHash,
    operationHash: result.revision.operationHash,
    revisionHash: result.revision.revisionHash,
    schemaVersion: result.schemaVersion,
    document: result.document,
    diagnostics: result.diagnostics,
    createdIds: result.createdIds,
  };
}

function previewResponse(preview: PreviewResult): Record<string, unknown> {
  return {
    previewId: preview.id,
    designId: preview.designId,
    rootBaseVersion: preview.rootBaseVersion,
    baseRevisionId: preview.baseRevisionId,
    baseSnapshotHash: preview.baseSnapshotHash,
    operationHash: preview.operationHash,
    resultSnapshotHash: preview.resultSnapshotHash,
    expiresAt: preview.expiresAt,
    canCommit: preview.canCommit,
    destructive: preview.destructive,
    kind: preview.kind,
    status: preview.status,
    committedRevisionId: preview.committedRevisionId,
    changedNodeIds: preview.changedNodeIds,
    versions: preview.versions,
    renderMetadata: preview.renderMetadata,
    diagnostics: preview.diagnostics,
    createdIds: preview.createdIds,
    document: preview.document,
    schemaVersion: preview.schemaVersion,
  };
}

function parseInteger(value: unknown, fallback?: number): number | undefined {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new DomainError("VALIDATION_FAILED", "Expected a positive integer query value.", 422);
  return number;
}

function rawRequestField(value: unknown, field: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === "string" ? candidate : "";
}

export function sendSse(
  reply: FastifyReply,
  events: EventHub,
  service: DesignerService,
  actorId: string,
  lastEventId: number | undefined,
): void {
  service.authorizeEventRead(actorId);
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  reply.raw.write(": connected\n\n");
  let cursor = lastEventId ?? 0;
  let replaying = true;
  let closed = false;
  const pending: DesignerEvent[] = [];
  let unsubscribe: () => void = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const closeUnauthorized = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe();
    reply.raw.end();
  };
  const writeEvent = (event: DesignerEvent, safeControlEvent = false) => {
    if (closed || event.id <= cursor) return;
    let access: ReturnType<typeof resolveAccess>;
    try {
      access = resolveAccess(service.database.sqlite, actorId);
    } catch {
      closeUnauthorized();
      return;
    }
    if (event.organizationId && event.organizationId !== access.organizationId) return;
    if (event.type === "events.gap" && !safeControlEvent) return;
    if (!canReadDesignerEvent(access, event)) return;
    const data = JSON.stringify({ type: event.type, actorId: event.actorId, timestamp: event.timestamp, ...event.data });
    reply.raw.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${data}\n\n`);
    cursor = event.id;
  };
  // Deliberately subscribe without the access snapshot captured at connection
  // time. Every delivered event is authorized again in writeEvent so policy
  // changes and grant revocations take effect immediately for an open stream.
  unsubscribe = events.subscribe(actorId, (event) => {
    if (replaying) pending.push(event);
    else writeEvent(event);
  });

  if (lastEventId === undefined) {
    cursor = service.latestEventId(actorId);
  } else {
    const replay = service.eventsSince(actorId, lastEventId);
    if (replay.gap || replay.hasMore) {
      writeEvent({
        id: replay.latestId,
        type: "events.gap",
        actorId,
        timestamp: new Date().toISOString(),
        data: {
          requestedAfterId: lastEventId,
          earliestAvailableId: replay.earliestId,
          latestAvailableId: replay.latestId,
          recovery: "Refetch the authoritative project head and active context.",
        },
      }, true);
    } else {
      for (const event of replay.events) writeEvent(event);
    }
  }
  replaying = false;
  pending.sort((left, right) => left.id - right.id).forEach((event) => writeEvent(event));
  heartbeat = setInterval(() => {
    try {
      service.authorizeEventRead(actorId);
      reply.raw.write(": heartbeat\n\n");
    } catch {
      closeUnauthorized();
    }
  }, 15_000);
  reply.raw.on("close", () => {
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe();
  });
}

export function registerHttpRoutes(
  app: FastifyInstance,
  dependencies: {
    config: ServerConfig;
    service: DesignerService;
    enterprise: EnterpriseService;
    events: EventHub;
    renderer: PngRenderer;
    backups: BackupManager;
    maintenance: MaintenanceStore;
    operations: OperationsService;
  },
): void {
  const { config, service, enterprise, events, renderer, backups, maintenance, operations } = dependencies;

  app.get("/health", async () => ({ ok: true }));
  app.get("/health/live", async () => ({ ok: true, service: "formaspec-api" }));
  app.get("/ready", async () => ({ ok: true, database: "ready" }));
  app.get("/health/ready", async (_request, reply) => {
    const maintenanceStatus = await maintenance.read();
    const backupSupervision = operations.backupSupervisionHealth();
    try {
      const render = await renderer.health();
      if (maintenanceStatus.active) {
        return reply.code(503).send({
          ok: false,
          status: "maintenance",
          database: "ready",
          migrations: service.database.schemaVersion(),
          render,
          backupSupervision,
          maintenance: {
            active: true,
            phase: maintenanceStatus.phase,
            ...(maintenanceStatus.markerValid ? { operationId: maintenanceStatus.operationId } : {}),
          },
        });
      }
      return {
        ok: true,
        database: "ready",
        migrations: service.database.schemaVersion(),
        render,
        backupSupervision,
      };
    } catch {
      return reply.code(503).send({
        ok: false,
        ...(maintenanceStatus.active ? {
          status: "maintenance",
          maintenance: {
            active: true,
            phase: maintenanceStatus.phase,
            ...(maintenanceStatus.markerValid ? { operationId: maintenanceStatus.operationId } : {}),
          },
        } : {}),
        database: "ready",
        migrations: service.database.schemaVersion(),
        backupSupervision,
        render: { ok: false, mode: renderer.remote ? "worker" : "in-process", renderer: "unavailable" },
      });
    }
  });
  app.get("/health/render", async (_request, reply) => {
    try {
      return await renderer.health();
    } catch {
      return reply.code(503).send({
        ok: false,
        mode: renderer.remote ? "worker" : "in-process",
        renderer: "unavailable",
        softwareFallback: false,
      });
    }
  });

  app.get("/api/designs", async (request) => {
    service.authorizeDesignList(request.actorId);
    const query = z.object({ limit: z.coerce.number().int().min(1).max(100).optional(), cursor: z.string().optional() }).parse(request.query);
    return service.listDesigns(request.actorId, query.limit, query.cursor);
  });

  app.post("/api/designs", async (request, reply) => {
    service.authorizeDesignCreation(request.actorId);
    const input = createDesignSchema.parse(request.body);
    const result = service.createDesign(request.actorId, input);
    return reply.code(201).send(revisionResponse(result));
  });

  app.get("/api/designs/:id", async (request) => {
    service.authorizeDesignRead(request.actorId, rawRequestField(request.params, "id"));
    const { id } = designIdParams.parse(request.params);
    const query = request.query as Record<string, unknown>;
    return revisionResponse(service.getDesign(request.actorId, id, parseInteger(query.version)));
  });

  app.post("/api/designs/:id/previews", async (request, reply) => {
    service.authorizePreviewCreation(request.actorId, rawRequestField(request.params, "id"));
    const { id } = designIdParams.parse(request.params);
    const input = previewSchema.parse(request.body);
    const preview = service.createPreview(request.actorId, id, {
      ...(input.baseVersion === undefined ? {} : { baseVersion: input.baseVersion }),
      ...(input.basePreviewId === undefined ? {} : { basePreviewId: input.basePreviewId }),
      operations: input.operations,
    });
    const renderOptions: RenderOptions = { maxSize: 2048 };
    const rendered = await renderCanonicalDocument(request.actorId, preview.canonicalDocument, renderOptions);
    service.recordPreviewRenderMetadata(request.actorId, id, preview.id, {
      options: renderOptions,
      png: rendered.png,
      width: rendered.width,
      height: rendered.height,
      renderer: rendered.renderer,
      warnings: rendered.warnings,
    });
    return reply.code(201).send(previewResponse(service.getPreview(request.actorId, id, preview.id)));
  });

  app.get("/api/designs/:id/previews/:previewId", async (request) => {
    service.authorizePreviewRead(
      request.actorId,
      rawRequestField(request.params, "id"),
      rawRequestField(request.params, "previewId"),
      rawRequestField(request.query, "taskId") || undefined,
    );
    const params = z.object({ id: z.string(), previewId: z.string() }).parse(request.params);
    const query = z.object({ taskId: z.string().min(1).max(240).optional() }).strict().parse(request.query);
    return previewResponse(service.getPreview(request.actorId, params.id, params.previewId, query));
  });

  app.post("/api/designs/:id/previews/:previewId/commit", async (request) => {
    const rawTaskId = rawRequestField(request.body, "taskId") || undefined;
    if (rawTaskId === undefined) {
      service.authorizePreviewCommit(
        request.actorId,
        rawRequestField(request.params, "id"),
        rawRequestField(request.params, "previewId"),
      );
    } else {
      enterprise.authorizeAgentTaskPreviewApproval(
        request.actorId,
        rawTaskId,
        rawRequestField(request.params, "id"),
        rawRequestField(request.params, "previewId"),
      );
    }
    const params = z.object({ id: z.string(), previewId: z.string() }).parse(request.params);
    const input = z.object({
      expectedBaseVersion: z.number().int().positive(),
      idempotencyKey: idempotencyKeySchema,
      message: z.string().trim().min(1).max(500).optional(),
      taskId: z.string().min(1).max(240).optional(),
    }).strict().parse(request.body);
    if (input.taskId !== undefined) {
      const approved = enterprise.approveAgentTaskDesignPreview(request.actorId, input.taskId, {
        designId: params.id,
        previewId: params.previewId,
        expectedBaseVersion: input.expectedBaseVersion,
        idempotencyKey: input.idempotencyKey,
        kind: "ordinary",
        ...(input.message === undefined ? {} : { message: input.message }),
      });
      return { ...revisionResponse(approved.revision), task: approved.task };
    }
    return revisionResponse(service.commitPreview(request.actorId, params.id, {
      previewId: params.previewId,
      expectedBaseVersion: input.expectedBaseVersion,
      idempotencyKey: input.idempotencyKey,
      kind: "ordinary",
      requireRenderEvidence: true,
      ...(input.message === undefined ? {} : { message: input.message }),
    }));
  });

  app.post("/api/designs/:id/archive-previews", async (request, reply) => {
    service.authorizePreviewCreation(request.actorId, rawRequestField(request.params, "id"));
    const { id } = designIdParams.parse(request.params);
    const input = previewSchema.parse(request.body);
    const preview = service.createPreview(request.actorId, id, {
      ...(input.baseVersion === undefined ? {} : { baseVersion: input.baseVersion }),
      ...(input.basePreviewId === undefined ? {} : { basePreviewId: input.basePreviewId }),
      operations: input.operations,
      kind: "archive",
    });
    const renderOptions: RenderOptions = { maxSize: 2048 };
    const rendered = await renderCanonicalDocument(request.actorId, preview.canonicalDocument, renderOptions);
    service.recordPreviewRenderMetadata(request.actorId, id, preview.id, {
      options: renderOptions,
      png: rendered.png,
      width: rendered.width,
      height: rendered.height,
      renderer: rendered.renderer,
      warnings: rendered.warnings,
    });
    return reply.code(201).send(previewResponse(service.getPreview(request.actorId, id, preview.id)));
  });

  app.post("/api/designs/:id/archive-previews/:previewId/commit", async (request) => {
    const rawTaskId = rawRequestField(request.body, "taskId") || undefined;
    if (rawTaskId === undefined) {
      service.authorizePreviewCommit(
        request.actorId,
        rawRequestField(request.params, "id"),
        rawRequestField(request.params, "previewId"),
      );
    } else {
      enterprise.authorizeAgentTaskPreviewApproval(
        request.actorId,
        rawTaskId,
        rawRequestField(request.params, "id"),
        rawRequestField(request.params, "previewId"),
      );
    }
    const params = z.object({ id: z.string(), previewId: z.string() }).parse(request.params);
    const input = z.object({
      expectedBaseVersion: z.number().int().positive(),
      idempotencyKey: idempotencyKeySchema,
      message: z.string().trim().min(1).max(500).optional(),
      taskId: z.string().min(1).max(240).optional(),
    }).strict().parse(request.body);
    if (input.taskId !== undefined) {
      const approved = enterprise.approveAgentTaskDesignPreview(request.actorId, input.taskId, {
        designId: params.id,
        previewId: params.previewId,
        expectedBaseVersion: input.expectedBaseVersion,
        idempotencyKey: input.idempotencyKey,
        kind: "archive",
        ...(input.message === undefined ? {} : { message: input.message }),
      });
      return { ...revisionResponse(approved.revision), task: approved.task };
    }
    return revisionResponse(service.commitPreview(request.actorId, params.id, {
      previewId: params.previewId,
      expectedBaseVersion: input.expectedBaseVersion,
      idempotencyKey: input.idempotencyKey,
      kind: "archive",
      requireRenderEvidence: true,
      ...(input.message === undefined ? {} : { message: input.message }),
    }));
  });

  app.post("/api/designs/:id/revisions", async (request) => {
    service.authorizeDesignRevision(request.actorId, rawRequestField(request.params, "id"));
    const { id } = designIdParams.parse(request.params);
    const input = revisionSchema.parse(request.body);
    return revisionResponse(service.applyRevision(request.actorId, id, {
      baseVersion: input.baseVersion,
      operations: input.operations,
      idempotencyKey: input.idempotencyKey,
      ...(input.message === undefined ? {} : { message: input.message }),
    }));
  });

  app.post("/api/designs/:id/migrations/v2", async (request) => {
    service.authorizeDesignMigration(request.actorId, rawRequestField(request.params, "id"));
    const { id } = designIdParams.parse(request.params);
    const input = v2MigrationSchema.parse(request.body);
    const migrated = service.migrateDesignHeadToV2(request.actorId, id, input);
    return {
      migrated: migrated.migrated,
      backupId: migrated.backupId,
      ...revisionResponse(migrated.result),
    };
  });

  app.get("/api/designs/:id/history", async (request) => {
    service.authorizeDesignRead(request.actorId, rawRequestField(request.params, "id"));
    const { id } = designIdParams.parse(request.params);
    const query = z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }).parse(request.query);
    return { revisions: service.history(request.actorId, id, query.limit) };
  });

  app.get("/api/projects/:projectId/revisions/:revisionId/inspect", async (request) => {
    service.authorizeDesignRead(request.actorId, rawRequestField(request.params, "projectId"));
    const params = z.object({ projectId: z.string().min(1).max(240), revisionId: z.string().min(1).max(240) }).strict().parse(request.params);
    // Authorize the project before resolving the opaque revision ID.
    service.getDesign(request.actorId, params.projectId);
    const row = service.database.sqlite.prepare(
      `SELECT id, version FROM revisions WHERE id = ? AND design_id = ?`,
    ).get(params.revisionId, params.projectId) as { id: string; version: number } | undefined;
    if (!row) throw new DomainError("NOT_FOUND", "Revision not found.", 404);
    const result = service.getDesign(request.actorId, params.projectId, row.version);
    const linkedSpecification = service.database.sqlite.prepare(
      `SELECT version, specification_hash, specification_json
       FROM product_specifications WHERE design_id = ? AND revision_id = ?`,
    ).get(params.projectId, params.revisionId) as {
      version: number;
      specification_hash: string;
      specification_json: string;
    } | undefined;
    const implementationMappings = service.database.sqlite.prepare(
      `SELECT id, entity_kind, entity_id, platform, symbol, inventory_id,
              mapping_json, created_by, created_at
       FROM implementation_mappings
       WHERE design_id = ? AND revision_id = ?
       ORDER BY created_at, id`,
    ).all(params.projectId, params.revisionId) as RevisionImplementationMappingRow[];
    const inspect = buildRevisionInspectSnapshot({
      canonicalDocument: result.canonicalDocument,
      editorDocument: result.document,
      linkedSpecification: linkedSpecification ? {
        version: linkedSpecification.version,
        specificationHash: linkedSpecification.specification_hash,
        specification: JSON.parse(linkedSpecification.specification_json) as unknown,
      } : null,
      implementationMappings,
    });
    return {
      project: {
        id: result.canonicalDocument.id,
        name: result.canonicalDocument.name,
        version: result.revision.version,
        revisionId: result.revision.id,
        createdAt: result.canonicalDocument.created_at,
        updatedAt: result.canonicalDocument.updated_at,
      },
      head: {
        version: result.design.version,
        revisionId: result.design.revisionId,
      },
      revision: result.revision,
      integrity: {
        revisionId: result.revision.id,
        parentRevisionId: result.revision.parentRevisionId,
        revisionHash: result.revision.revisionHash,
        snapshotHash: result.revision.snapshotHash,
        operationHash: result.revision.operationHash,
        schemaVersion: result.schemaVersion,
        documentRevision: result.canonicalDocument.revision,
        createdAt: result.revision.createdAt,
      },
      document: result.canonicalDocument,
      nodes: inspect.nodes,
      tokens: result.canonicalDocument.tokens,
      assets: result.canonicalDocument.assets,
      prototypeLinks: result.canonicalDocument.prototype_links,
      productSpecification: inspect.productSpecification,
      evidence: inspect.evidence,
      limitations: inspect.limitations,
    };
  });

  app.post("/api/designs/:id/restore", async (request) => {
    service.authorizeDesignRestore(request.actorId, rawRequestField(request.params, "id"));
    const { id } = designIdParams.parse(request.params);
    const result = service.restoreRevision(request.actorId, id, restoreSchema.parse(request.body));
    return {
      ...revisionResponse(result),
      restore: result.restore,
      restorePolicy: {
        designSystem: result.restore.designSystem.status,
      },
    };
  });

  app.get("/api/designs/:id/export", async (request, reply) => {
    service.authorizeDesignRead(request.actorId, rawRequestField(request.params, "id"));
    const { id } = designIdParams.parse(request.params);
    const query = request.query as Record<string, unknown>;
    const result = service.getDesign(request.actorId, id, parseInteger(query.version));
    return reply
      .header("content-disposition", `attachment; filename="${id}-v${result.revision.version}.json"`)
      .send(result.canonicalDocument);
  });

  const renderCanonicalDocument = async (
    actorId: string,
    document: Parameters<PngRenderer["render"]>[0],
    options: RenderOptions,
  ) => renderer.render(document, options, (assetId) => {
      try {
        const asset = service.getAsset(actorId, assetId);
        return `data:${asset.mimeType};base64,${asset.data.toString("base64")}`;
      } catch {
        return null;
      }
    });

  const renderDocument = async (
    actorId: string,
    designId: string,
    source: { version?: number; previewId?: string },
    query: Record<string, unknown>,
  ) => {
    const document = source.previewId
      ? service.getPreview(actorId, designId, source.previewId, {
        ...(typeof query.taskId === "string" ? { taskId: query.taskId } : {}),
      }).canonicalDocument
      : service.getDesign(actorId, designId, source.version).canonicalDocument;
    const maxSize = parseInteger(query.maxSize, 2048);
    if (maxSize !== undefined && (maxSize < 64 || maxSize > 4096)) {
      throw new DomainError("VALIDATION_FAILED", "Render maxSize must be between 64 and 4096.", 422);
    }
    return renderCanonicalDocument(actorId, document, {
      ...(typeof query.pageId === "string" ? { pageId: query.pageId } : {}),
      ...(typeof query.nodeId === "string" ? { nodeId: query.nodeId } : {}),
      ...(maxSize === undefined ? {} : { maxSize }),
    });
  };

  app.get("/api/designs/:id/render.png", async (request, reply) => {
    service.authorizeDesignRead(request.actorId, rawRequestField(request.params, "id"));
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
    service.authorizePreviewRead(
      request.actorId,
      rawRequestField(request.params, "id"),
      rawRequestField(request.params, "previewId"),
      rawRequestField(request.query, "taskId") || undefined,
    );
    const params = z.object({ id: z.string(), previewId: z.string() }).parse(request.params);
    const query = previewRenderQuerySchema.parse(request.query);
    if (query.mode === "adhoc") {
      const rendered = await renderDocument(request.actorId, params.id, { previewId: params.previewId }, query);
      return reply
        .header("content-type", "image/png")
        .header("cache-control", "no-store")
        .header("x-formaspec-preview-render-mode", "adhoc")
        .header("x-designer-renderer", rendered.renderer)
        .header("x-designer-render-warnings", rendered.warnings.join(" | ").slice(0, 1000))
        .send(rendered.png);
    }
    if (query.pageId !== undefined || query.nodeId !== undefined || query.maxSize !== undefined) {
      throw new DomainError(
        "PREVIEW_ENGINE_MISMATCH",
        "Exact preview renders do not accept page, node, or size overrides; use mode=adhoc for an explicit ad-hoc render.",
        409,
      );
    }
    const access = query.taskId === undefined ? {} : { taskId: query.taskId };
    const exact = service.getExactPreviewForRender(request.actorId, params.id, params.previewId, access);
    const rendered = await renderCanonicalDocument(
      request.actorId,
      exact.preview.canonicalDocument,
      exact.renderMetadata.options,
    );
    const verified = service.verifyExactPreviewRender(request.actorId, params.id, params.previewId, {
      png: rendered.png,
      width: rendered.width,
      height: rendered.height,
      renderer: rendered.renderer,
      warnings: rendered.warnings,
    }, access);
    return reply
      .header("content-type", "image/png")
      .header("cache-control", "no-store")
      .header("etag", `"${verified.sha256}"`)
      .header("x-formaspec-preview-render-mode", "exact")
      .header("x-formaspec-preview-render-sha256", verified.sha256)
      .header("x-designer-renderer", rendered.renderer)
      .header("x-designer-render-warnings", rendered.warnings.join(" | ").slice(0, 1000))
      .send(rendered.png);
  });

  app.get("/api/context", async (request) => {
    service.authorizeContextRead(request.actorId);
    return service.getContext(request.actorId);
  });
  app.put("/api/context", async (request) => {
    service.authorizeContextWrite(
      request.actorId,
      rawRequestField(request.body, "designId") || undefined,
    );
    const input = contextSchema.parse(request.body);
    return service.setContext(request.actorId, {
      ...(input.designId !== undefined ? { designId: input.designId } : {}),
      ...(input.pageId !== undefined ? { pageId: input.pageId } : {}),
      selection: input.selectedNodeIds,
    });
  });

  const eventStream = async (request: FastifyRequest, reply: FastifyReply) => {
    service.authorizeEventRead(request.actorId);
    const rawLastEventId = request.headers["last-event-id"];
    const value = Array.isArray(rawLastEventId) ? rawLastEventId[0] : rawLastEventId;
    let lastEventId: number | undefined;
    if (value !== undefined) {
      lastEventId = Number(value);
      if (!Number.isSafeInteger(lastEventId) || lastEventId < 0) {
        throw new DomainError("VALIDATION_FAILED", "Last-Event-ID must be a non-negative safe integer.", 422);
      }
    }
    sendSse(reply, events, service, request.actorId, lastEventId);
  };
  app.get("/events", eventStream);
  app.get("/api/events", eventStream);

  app.post("/api/assets", async (request, reply) => {
    const organizationId = service.authorizeAssetUpload(
      request.actorId,
      rawRequestField(request.query, "designId") || undefined,
    );
    const query = z.object({ designId: z.string().optional() }).parse(request.query);
    const part = await request.file({ limits: { files: 1, fileSize: config.maxAssetBytes, fields: 8 } });
    if (!part) throw new DomainError("VALIDATION_FAILED", "A multipart file field is required.", 422);
    const data = await part.toBuffer();
    const normalized = await normalizeImageAsset(
      data,
      part.mimetype,
      { maxBytes: config.maxAssetBytes, maxPixels: config.maxAssetPixels },
      renderer,
      {
        scope: "organization",
        organizationId,
        ...(query.designId ? { designId: query.designId } : {}),
        operation: "asset_upload",
      },
    );
    const asset = service.saveAsset(request.actorId, {
      ...(query.designId ? { designId: query.designId } : {}),
      filename: safeFilename(part.filename, normalized.mimeType),
      mimeType: normalized.mimeType,
      width: normalized.width,
      height: normalized.height,
      data: normalized.data,
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
    service.authorizeAssetRead(request.actorId, rawRequestField(request.params, "id"));
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
