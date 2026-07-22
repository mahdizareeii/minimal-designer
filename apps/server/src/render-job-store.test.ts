import { createHash } from "node:crypto";

import { ENGINE_VERSIONS } from "@designer/core";
import { describe, expect, it } from "vitest";

import { createDocument } from "./core-adapter.js";
import { DesignerDatabase } from "./db/database.js";
import { EventHub } from "./events.js";
import { PngRenderer } from "./render.js";
import { cleanupRetainedRenderJobs, SqliteRenderJobStore } from "./render-job-store.js";
import { DesignerService } from "./service.js";

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

describe("persistent render jobs", () => {
  it("records bounded design context and permits only an exact success lifecycle", () => {
    const database = new DesignerDatabase(":memory:");
    try {
      const service = new DesignerService(database, new EventHub(), 900);
      const created = service.createDesign("local", {
        name: "Render lifecycle",
        preset: "phone",
        idempotencyKey: "render-lifecycle-create-0001",
      });
      const store = new SqliteRenderJobStore(database.sqlite);
      const requestHash = "a".repeat(64);
      const jobId = store.queue({
        kind: "render",
        requestHash,
        requestMetadata: { documentSha256: "b".repeat(64), options: { maxSize: 512 } },
        documentId: created.document.id,
        documentRevision: created.document.revision,
      });
      expect(database.sqlite.prepare(
        `SELECT organization_id, design_id, revision_id, document_id, document_revision,
                scope_kind, operation, kind, status, owner_id, request_hash, renderer_version,
                renderer_ipc_protocol_version, raster_normalizer_version, started_at, completed_at
         FROM render_jobs WHERE id = ?`,
      ).get(jobId)).toMatchObject({
        organization_id: "organization_legacy",
        design_id: created.document.id,
        revision_id: created.revision.id,
        document_id: created.document.id,
        document_revision: 1,
        scope_kind: "organization",
        operation: "render",
        kind: "render",
        status: "queued",
        owner_id: store.ownerId,
        request_hash: requestHash,
        renderer_version: ENGINE_VERSIONS.renderer,
        renderer_ipc_protocol_version: ENGINE_VERSIONS.rendererIpcProtocol,
        raster_normalizer_version: ENGINE_VERSIONS.rasterNormalizer,
        started_at: null,
        completed_at: null,
      });

      expect(() => database.sqlite.prepare(
        "UPDATE render_jobs SET request_hash = ? WHERE id = ?",
      ).run("c".repeat(64), jobId)).toThrow(/valid lifecycle transitions/);

      store.start(jobId);
      const output = Buffer.from("deterministic-render-output", "utf8");
      store.succeed(jobId, {
        output,
        width: 320,
        height: 640,
        renderer: "playwright",
        warnings: ["first warning"],
      });
      expect(database.sqlite.prepare(
        `SELECT status, output_sha256, output_bytes, output_width, output_height,
                output_renderer, warnings_json, error_code, retryable
         FROM render_jobs WHERE id = ?`,
      ).get(jobId)).toEqual({
        status: "succeeded",
        output_sha256: sha256(output),
        output_bytes: output.length,
        output_width: 320,
        output_height: 640,
        output_renderer: "playwright",
        warnings_json: '["first warning"]',
        error_code: null,
        retryable: null,
      });
      expect(() => database.sqlite.prepare(
        "UPDATE render_jobs SET status = 'failed' WHERE id = ?",
      ).run(jobId)).toThrow(/valid lifecycle transitions/);
      expect(() => database.sqlite.prepare("DELETE FROM render_jobs WHERE id = ?").run(jobId))
        .toThrow(/exact retention permit/);
    } finally {
      database.close();
    }
  });

  it("rejects archived projects as render-job document or explicit scope context", () => {
    const database = new DesignerDatabase(":memory:");
    try {
      const service = new DesignerService(database, new EventHub(), 900);
      const created = service.createDesign("local", {
        name: "Archived render project",
        preset: "phone",
        idempotencyKey: "render-archive-create-0001",
      });
      service.archiveDesign("local", created.document.id, {
        expectedVersion: created.document.revision,
        idempotencyKey: "render-archive-project-0001",
        confirmationName: created.design.name,
      });
      const store = new SqliteRenderJobStore(database.sqlite);

      expect(() => store.queue({
        kind: "render",
        requestHash: "9".repeat(64),
        requestMetadata: { documentSha256: "a".repeat(64) },
        documentId: created.document.id,
        documentRevision: created.document.revision,
      })).toThrow(/archived design/);
      expect(() => store.queue({
        kind: "render",
        requestHash: "b".repeat(64),
        requestMetadata: { documentSha256: "c".repeat(64) },
        scope: {
          kind: "organization",
          organizationId: "organization_legacy",
          designId: created.document.id,
          operation: "archived_render",
        },
      })).toThrow(/unknown or cross-organization design/);
      expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM render_jobs").get())
        .toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("leases jobs to one API owner and recovers only expired owners", () => {
    const database = new DesignerDatabase(":memory:");
    try {
      let now = new Date("2026-07-20T08:00:00.000Z");
      const store = new SqliteRenderJobStore(database.sqlite, {
        ownerId: `render_owner_${"a".repeat(32)}`,
        leaseMilliseconds: 10_000,
        now: () => now,
      });
      const observer = new SqliteRenderJobStore(database.sqlite, {
        ownerId: `render_owner_${"b".repeat(32)}`,
        leaseMilliseconds: 10_000,
        now: () => now,
      });
      const queued = store.queue({
        kind: "render",
        requestHash: "d".repeat(64),
        requestMetadata: { documentSha256: "e".repeat(64) },
      });
      const running = store.queue({
        kind: "normalize_raster",
        requestHash: "f".repeat(64),
        requestMetadata: { sourceSha256: "0".repeat(64) },
      });
      store.start(running);

      now = new Date("2026-07-20T08:00:09.000Z");
      expect(observer.recoverExpired()).toBe(0);
      expect(store.heartbeat()).toBe(2);
      now = new Date("2026-07-20T08:00:18.000Z");
      expect(observer.recoverExpired()).toBe(0);
      now = new Date("2026-07-20T08:00:20.000Z");
      expect(observer.recoverExpired()).toBe(2);
      const rows = database.sqlite.prepare(
        `SELECT id, status, started_at, completed_at, error_code, retryable
         FROM render_jobs ORDER BY id`,
      ).all() as Array<Record<string, unknown>>;
      expect(rows).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: queued,
          status: "failed",
          started_at: null,
          completed_at: "2026-07-20T08:00:20.000Z",
          error_code: "RENDER_INTERRUPTED",
          retryable: 1,
        }),
        expect.objectContaining({
          id: running,
          status: "failed",
          completed_at: "2026-07-20T08:00:20.000Z",
          error_code: "RENDER_INTERRUPTED",
          retryable: 1,
        }),
      ]));
      expect(store.recoverExpired()).toBe(0);
    } finally {
      database.close();
    }
  });

  it("bounds escaped warning bytes and rejects forged terminal inserts", () => {
    const database = new DesignerDatabase(":memory:");
    try {
      const store = new SqliteRenderJobStore(database.sqlite);
      const jobId = store.queue({
        kind: "render",
        requestHash: "1".repeat(64),
        requestMetadata: { documentSha256: "2".repeat(64) },
      });
      store.start(jobId);
      store.succeed(jobId, {
        output: Buffer.from("rendered"),
        width: 1,
        height: 1,
        renderer: "playwright",
        warnings: Array.from({ length: 16 }, () => "\\".repeat(512)),
      });
      const succeeded = database.sqlite.prepare(
        "SELECT status, warnings_json FROM render_jobs WHERE id = ?",
      ).get(jobId) as { status: string; warnings_json: string };
      expect(succeeded.status).toBe("succeeded");
      expect(Buffer.byteLength(succeeded.warnings_json, "utf8")).toBeLessThanOrEqual(7_500);
      expect(JSON.parse(succeeded.warnings_json)).toHaveLength(7);

      const timestamp = "2026-07-20T08:00:00.000Z";
      expect(() => database.sqlite.prepare(
        `INSERT INTO render_jobs
         (id, scope_kind, operation, kind, status, owner_id, request_hash, request_metadata_json,
          renderer_version, renderer_ipc_protocol_version, raster_normalizer_version,
          output_sha256, output_bytes, output_width, output_height, output_renderer, warnings_json,
          created_at, started_at, completed_at, heartbeat_at, lease_expires_at)
         VALUES (?, 'internal', 'forged', 'render', 'succeeded', ?, ?, '{}', '2', 2, '1',
                 ?, 1, 1, 1, 'playwright', '[]', ?, ?, ?, ?, ?)`,
      ).run(
        createHash("sha256").update("forged-id").digest("hex"),
        `render_owner_${"c".repeat(32)}`,
        "3".repeat(64),
        "4".repeat(64),
        timestamp,
        timestamp,
        timestamp,
        timestamp,
        timestamp,
      )).toThrow(/canonical queued state/);
    } finally {
      database.close();
    }
  });

  it("retains terminal jobs in bounded organization-scoped batches", () => {
    const database = new DesignerDatabase(":memory:");
    try {
      const service = new DesignerService(database, new EventHub(), 900);
      const created = service.createDesign("local", {
        name: "Retention project",
        preset: "phone",
        idempotencyKey: "render-retention-create-0001",
      });
      let now = new Date("2026-01-01T00:00:00.000Z");
      const store = new SqliteRenderJobStore(database.sqlite, {
        ownerId: `render_owner_${"d".repeat(32)}`,
        now: () => now,
      });
      const organizationJob = store.queue({
        kind: "render",
        requestHash: "5".repeat(64),
        requestMetadata: { documentSha256: "6".repeat(64) },
        documentId: created.document.id,
        documentRevision: 1,
      });
      const internalJob = store.queue({
        kind: "normalize_raster",
        requestHash: "7".repeat(64),
        requestMetadata: { sourceSha256: "8".repeat(64) },
        scope: { kind: "internal", operation: "backup_verification" },
      });
      for (const jobId of [organizationJob, internalJob]) {
        store.start(jobId);
        store.fail(jobId, { code: "RENDER_FAILED", message: "expected", retryable: true });
      }
      expect(() => database.sqlite.prepare("DELETE FROM render_jobs WHERE id = ?").run(organizationJob))
        .toThrow(/exact retention permit/);
      now = new Date("2026-02-01T00:00:00.000Z");
      expect(cleanupRetainedRenderJobs(database.sqlite, now.toISOString(), 30, 500)).toBe(1);
      expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM render_jobs").get()).toEqual({ count: 1 });
      expect(cleanupRetainedRenderJobs(database.sqlite, now.toISOString(), 30, 500)).toBe(1);
      expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM render_jobs").get()).toEqual({ count: 0 });
      expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM render_job_delete_permits").get())
        .toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("persists renderer validation failures without storing document bytes", async () => {
    const database = new DesignerDatabase(":memory:");
    const store = new SqliteRenderJobStore(database.sqlite);
    const renderer = new PngRenderer({ jobRecorder: store, allowSoftwareFallback: false });
    try {
      const invalidDocument = {
        ...createDocument("document_renderfailure1234", "Invalid render", "2026-07-20T08:00:00.000Z", "phone"),
        schema_version: 99,
      };
      await expect(renderer.render(invalidDocument as never, {}, () => null)).rejects.toBeTruthy();
      const row = database.sqlite.prepare(
        `SELECT status, error_code, error_message, started_at, request_metadata_json
         FROM render_jobs ORDER BY created_at DESC LIMIT 1`,
      ).get() as {
        status: string;
        error_code: string;
        error_message: string;
        started_at: string | null;
        request_metadata_json: string;
      };
      expect(row).toMatchObject({
        status: "failed",
        error_code: "INTERNAL_ERROR",
        error_message: "The render job failed unexpectedly.",
        started_at: null,
      });
      expect(row.request_metadata_json).not.toContain("Invalid render");
      expect(row.request_metadata_json).not.toContain("nodes");
    } finally {
      await renderer.close();
      database.close();
    }
  });
});
