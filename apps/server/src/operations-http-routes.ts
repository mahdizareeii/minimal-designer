import type { FastifyInstance, FastifyRequest } from "fastify";
import { TOKEN_EXPORT_TARGETS } from "@designer/core";
import { z } from "zod";

import { DomainError } from "./errors.js";
import type { OperationsService } from "./operations-service.js";

const MAX_PORTABLE_ARCHIVE_BYTES = 256 * 1024 * 1024;
const designParams = z.object({ id: z.string().trim().min(1).max(240) }).strict();
const backupParams = z.object({ backupId: z.string().regex(/^backup_[a-f0-9]{40}$/) }).strict();
const backupPruneParams = z.object({
  previewId: z.string().regex(/^backup_prune_preview_[a-f0-9]{32}$/),
}).strict();
const portableImportQuery = z.object({
  mode: z.enum(["conflict_fail", "clone"]).default("conflict_fail"),
}).strict();

function portableImportIdempotencyKey(headers: FastifyRequest["headers"]): string {
  const raw = headers["idempotency-key"];
  return z.string().trim().min(8).max(240).parse(Array.isArray(raw) ? raw[0] : raw);
}

async function portableUpload(request: FastifyRequest): Promise<Buffer> {
  const part = await request.file({
    limits: { files: 1, fields: 0, fileSize: MAX_PORTABLE_ARCHIVE_BYTES },
  });
  if (!part) throw new DomainError("VALIDATION_FAILED", "A multipart FormaSpec bundle is required.", 422);
  if (!["application/zip", "application/octet-stream", "application/x-zip-compressed"].includes(part.mimetype)) {
    throw new DomainError("VALIDATION_FAILED", "The uploaded portable bundle must use a ZIP-compatible media type.", 422);
  }
  return part.toBuffer();
}

export function registerOperationsHttpRoutes(app: FastifyInstance, operations: OperationsService): void {
  app.get("/api/designs/:id/export.formaspec.zip", async (request, reply) => {
    const { id } = designParams.parse(request.params);
    const query = z.object({
      version: z.coerce.number().int().positive().optional(),
      includePreviews: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
    }).strict().parse(request.query);
    const exported = await operations.createPortableExport(request.actorId, id, query.version, query.includePreviews);
    return reply
      .header("content-type", "application/zip")
      .header("content-length", exported.data.length)
      .header("content-disposition", `attachment; filename="${exported.filename}"`)
      .header("cache-control", "private, no-store")
      .header("x-formaspec-bundle-sha256", exported.sha256)
      .header("x-formaspec-export-id", exported.exportId)
      .header("x-formaspec-revision-id", exported.revisionId)
      .send(exported.data);
  });

  app.get("/api/designs/:id/tokens/export/:target", async (request, reply) => {
    const params = z.object({
      id: z.string().trim().min(1).max(240),
      target: z.enum(TOKEN_EXPORT_TARGETS),
    }).strict().parse(request.params);
    const query = z.object({
      version: z.coerce.number().int().positive().optional(),
      mode: z.string().trim().min(1).max(120).optional(),
    }).strict().parse(request.query);
    const exported = operations.exportTokens(request.actorId, params.id, params.target, query.version, query.mode);
    return reply
      .header("content-type", `${exported.mediaType}; charset=utf-8`)
      .header("content-disposition", `attachment; filename="${exported.filename}"`)
      .header("cache-control", "private, no-store")
      .header("x-formaspec-exported-token-count", exported.exportedTokenIds.length)
      .header("x-formaspec-token-diagnostic-count", exported.diagnostics.length)
      .send(exported.content);
  });

  app.post("/api/imports/validate", { bodyLimit: MAX_PORTABLE_ARCHIVE_BYTES + 1024 * 1024 }, async (request) => {
    const data = await portableUpload(request);
    return operations.validatePortableImport(request.actorId, data);
  });

  app.post("/api/imports", { bodyLimit: MAX_PORTABLE_ARCHIVE_BYTES + 1024 * 1024 }, async (request, reply) => {
    const { mode } = portableImportQuery.parse(request.query);
    const idempotencyKey = portableImportIdempotencyKey(request.headers);
    const data = await portableUpload(request);
    const imported = await operations.importPortableProject(request.actorId, data, { mode, idempotencyKey });
    return reply.code(201).send(imported);
  });

  app.get("/api/backups", async (request) => ({
    backups: operations.listBackups(request.actorId),
  }));

  app.post("/api/backups", async (request, reply) => {
    z.object({}).strict().parse(request.body ?? {});
    const backup = await operations.createBackup(request.actorId);
    return reply.code(201).send({ backup });
  });

  app.get("/api/backups/schedule", async (request) => ({
    schedule: operations.getBackupSchedule(request.actorId),
  }));

  app.put("/api/backups/schedule", async (request) => {
    const body = z.object({
      enabled: z.boolean(),
      cronExpression: z.string().trim().min(9).max(32),
    }).strict().parse(request.body);
    return { schedule: operations.updateBackupSchedule(request.actorId, body) };
  });

  app.post("/api/backups/schedule/run", async (request) => {
    z.object({}).strict().parse(request.body ?? {});
    return { run: await operations.runScheduledBackup(request.actorId) };
  });

  app.post("/api/backups/prune/previews", async (request, reply) => {
    z.object({}).strict().parse(request.body ?? {});
    const preview = await operations.previewBackupPrune(request.actorId);
    return reply.code(201).send({ preview });
  });

  app.post("/api/backups/prune/previews/:previewId/commit", async (request) => {
    const { previewId } = backupPruneParams.parse(request.params);
    const { expectedPlanHash } = z.object({
      expectedPlanHash: z.string().regex(/^[a-f0-9]{64}$/),
    }).strict().parse(request.body);
    return { result: await operations.executeBackupPrune(request.actorId, previewId, expectedPlanHash) };
  });

  app.post("/api/backups/:backupId/verify", async (request) => {
    const { backupId } = backupParams.parse(request.params);
    z.object({}).strict().parse(request.body ?? {});
    return { backup: await operations.verifyBackup(request.actorId, backupId) };
  });

  app.get("/api/backups/:backupId/download", async (request, reply) => {
    const { backupId } = backupParams.parse(request.params);
    const download = await operations.openBackupDownload(request.actorId, backupId);
    return reply
      .header("content-type", "application/x-tar")
      .header("content-length", download.sizeBytes)
      .header("content-disposition", `attachment; filename="${download.record.filename}"`)
      .header("cache-control", "private, no-store")
      .header("x-formaspec-backup-id", download.record.id)
      .header("x-formaspec-bundle-sha256", download.record.bundleSha256 as string)
      .send(download.stream);
  });
}
