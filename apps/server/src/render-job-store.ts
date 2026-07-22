import { createHash, randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import {
  RASTER_NORMALIZER_VERSION,
  RENDERER_IPC_PROTOCOL_VERSION,
  RENDERER_VERSION,
} from "@designer/core";

import { activeDesignSqlPredicate, isDesignArchived } from "./active-design.js";
import { canonicalJson, createId } from "./ids.js";

export type RenderJobKind = "render" | "normalize_raster";

export type RenderJobScope =
  | {
    kind: "organization";
    organizationId: string;
    designId?: string;
    operation: string;
  }
  | {
    kind: "internal";
    operation: string;
  };

export interface RenderJobRequestRecord {
  kind: RenderJobKind;
  requestHash: string;
  requestMetadata: Readonly<Record<string, unknown>>;
  documentId?: string;
  documentRevision?: number;
  scope?: RenderJobScope;
}

export interface RenderJobSuccessRecord {
  output: Buffer;
  width: number;
  height: number;
  renderer: "playwright" | "software" | "chromium";
  warnings?: readonly string[];
}

export interface RenderJobFailureRecord {
  code: string;
  message: string;
  retryable: boolean;
}

export interface RenderJobRecorder {
  queue(input: RenderJobRequestRecord): string;
  start(jobId: string): void;
  succeed(jobId: string, output: RenderJobSuccessRecord): void;
  fail(jobId: string, failure: RenderJobFailureRecord): void;
}

export interface SqliteRenderJobStoreOptions {
  ownerId?: string;
  leaseMilliseconds?: number;
  now?: () => Date;
}

const MAX_REQUEST_METADATA_BYTES = 8 * 1024;
const MAX_WARNINGS_JSON_BYTES = 7_500;
const MAX_WARNING_COUNT = 16;
const MAX_WARNING_LENGTH = 512;
const MAX_ERROR_CODE_LENGTH = 64;
const MAX_ERROR_MESSAGE_LENGTH = 1_000;
const DEFAULT_LEASE_MILLISECONDS = 45_000;
const MIN_LEASE_MILLISECONDS = 10_000;
const MAX_LEASE_MILLISECONDS = 10 * 60_000;
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_RETENTION_BATCH = 500;

function boundedText(value: string, maximum: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maximum);
}

function boundedWarnings(values: readonly string[]): string {
  const warnings: string[] = [];
  for (const warning of values.slice(0, MAX_WARNING_COUNT)) {
    const candidate = [...warnings, boundedText(warning, MAX_WARNING_LENGTH)];
    const json = canonicalJson(candidate);
    if (Buffer.byteLength(json, "utf8") > MAX_WARNINGS_JSON_BYTES) break;
    warnings.push(candidate.at(-1)!);
  }
  return canonicalJson(warnings);
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function requireSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest.`);
}

function requirePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer.`);
}

function canonicalTimestamp(value: Date, label: string): string {
  if (!Number.isFinite(value.getTime())) throw new Error(`${label} must be a valid timestamp.`);
  return value.toISOString();
}

function retentionCutoff(now: string, retentionDays: number): string {
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 3_650) {
    throw new Error("Render-job retention days must be between 1 and 3650.");
  }
  return new Date(Date.parse(now) - retentionDays * 86_400_000).toISOString();
}

export function cleanupRetainedRenderJobs(
  sqlite: Database.Database,
  now = new Date().toISOString(),
  retentionDays = DEFAULT_RETENTION_DAYS,
  batchSize = DEFAULT_RETENTION_BATCH,
): number {
  const parsedNow = new Date(now);
  const canonicalNow = canonicalTimestamp(parsedNow, "Render-job cleanup timestamp");
  if (canonicalNow !== now) throw new Error("Render-job cleanup timestamp must be canonical ISO-8601 UTC.");
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 2_000) {
    throw new Error("Render-job retention batch size must be between 1 and 2000.");
  }
  const cutoff = retentionCutoff(now, retentionDays);
  const transaction = sqlite.transaction(() => {
    const scope = sqlite.prepare(
      `SELECT organization_id
       FROM render_jobs
       WHERE status IN ('succeeded', 'failed') AND completed_at <= ?
       ORDER BY completed_at, id
       LIMIT 1`,
    ).get(cutoff) as { organization_id: string | null } | undefined;
    if (!scope) return 0;
    sqlite.prepare(
      `INSERT INTO render_job_delete_permits (job_id, organization_id, cutoff_at, created_at)
       SELECT id, organization_id, ?, ?
       FROM render_jobs
       WHERE organization_id IS ?
         AND status IN ('succeeded', 'failed')
         AND completed_at <= ?
       ORDER BY completed_at, id
       LIMIT ?`,
    ).run(cutoff, now, scope.organization_id, cutoff, batchSize);
    const deleted = sqlite.prepare(
      `DELETE FROM render_jobs
       WHERE id IN (SELECT job_id FROM render_job_delete_permits)`,
    ).run().changes;
    const remaining = sqlite.prepare(
      "SELECT COUNT(*) AS count FROM render_job_delete_permits",
    ).get() as { count: number };
    if (remaining.count !== 0) {
      throw new Error("Render-job retention permits were not consumed exactly.");
    }
    return deleted;
  });
  return transaction.immediate();
}

export class SqliteRenderJobStore implements RenderJobRecorder {
  readonly ownerId: string;
  readonly #leaseMilliseconds: number;
  readonly #now: () => Date;

  constructor(readonly sqlite: Database.Database, options: SqliteRenderJobStoreOptions = {}) {
    this.ownerId = options.ownerId ?? `render_owner_${randomUUID().replaceAll("-", "")}`;
    if (!/^render_owner_[a-f0-9]{32}$/.test(this.ownerId)) {
      throw new Error("Render-job owner ID is invalid.");
    }
    this.#leaseMilliseconds = options.leaseMilliseconds ?? DEFAULT_LEASE_MILLISECONDS;
    if (!Number.isSafeInteger(this.#leaseMilliseconds)
      || this.#leaseMilliseconds < MIN_LEASE_MILLISECONDS
      || this.#leaseMilliseconds > MAX_LEASE_MILLISECONDS) {
      throw new Error("Render-job lease duration is outside the supported range.");
    }
    this.#now = options.now ?? (() => new Date());
  }

  #timestamps(now = this.#now()): { now: string; leaseExpiresAt: string } {
    const current = canonicalTimestamp(now, "Render-job timestamp");
    return {
      now: current,
      leaseExpiresAt: new Date(now.getTime() + this.#leaseMilliseconds).toISOString(),
    };
  }

  queue(input: RenderJobRequestRecord): string {
    requireSha256(input.requestHash, "Render-job request hash");
    if (input.documentId !== undefined
      && (input.documentId.length < 1 || Buffer.byteLength(input.documentId, "utf8") > 256)) {
      throw new Error("Render-job document ID must be between 1 and 256 UTF-8 bytes.");
    }
    if (input.documentRevision !== undefined
      && (!Number.isSafeInteger(input.documentRevision) || input.documentRevision < 0)) {
      throw new Error("Render-job document revision must be a non-negative safe integer.");
    }
    const requestMetadataJson = canonicalJson(input.requestMetadata);
    if (Buffer.byteLength(requestMetadataJson, "utf8") > MAX_REQUEST_METADATA_BYTES) {
      throw new Error(`Render-job request metadata exceeds ${MAX_REQUEST_METADATA_BYTES} bytes.`);
    }

    const resolved = input.documentId
      ? this.sqlite.prepare(
        `SELECT d.id AS design_id, d.organization_id,
                r.id AS revision_id
         FROM designs d
         LEFT JOIN revisions r
           ON r.design_id = d.id AND r.version = ?
         WHERE d.id = ? AND ${activeDesignSqlPredicate("d")}`,
      ).get(input.documentRevision ?? -1, input.documentId) as {
        design_id: string;
        organization_id: string;
        revision_id: string | null;
      } | undefined
      : undefined;
    if (input.documentId !== undefined && !resolved && isDesignArchived(this.sqlite, input.documentId)) {
      throw new Error("Render-job document references an archived design.");
    }
    let organizationId = resolved?.organization_id ?? null;
    let designId = resolved?.design_id ?? null;
    let scopeKind: "organization" | "internal" = resolved ? "organization" : "internal";
    const operation = boundedText(input.scope?.operation ?? input.kind, 128);
    if (!operation) throw new Error("Render-job operation is required.");
    if (input.scope?.kind === "organization") {
      const scopedDesign = input.scope.designId
        ? this.sqlite.prepare(
          `SELECT id, organization_id FROM designs
           WHERE id = ? AND ${activeDesignSqlPredicate("designs")}`,
        ).get(input.scope.designId) as {
          id: string;
          organization_id: string;
        } | undefined
        : undefined;
      if (input.scope.designId && (!scopedDesign || scopedDesign.organization_id !== input.scope.organizationId)) {
        throw new Error("Render-job scope references an unknown or cross-organization design.");
      }
      const organization = this.sqlite.prepare("SELECT id FROM organizations WHERE id = ?").get(input.scope.organizationId);
      if (!organization) throw new Error("Render-job scope references an unknown organization.");
      if (organizationId && organizationId !== input.scope.organizationId) {
        throw new Error("Render-job document and explicit organization scope do not match.");
      }
      if (designId && scopedDesign && designId !== scopedDesign.id) {
        throw new Error("Render-job document and explicit design scope do not match.");
      }
      organizationId = input.scope.organizationId;
      designId = scopedDesign?.id ?? designId;
      scopeKind = "organization";
    } else if (input.scope?.kind === "internal" && resolved) {
      throw new Error("A persisted design render cannot be downgraded to internal scope.");
    }

    const { now, leaseExpiresAt } = this.#timestamps();
    const jobId = createId("render");
    this.sqlite.prepare(
      `INSERT INTO render_jobs
       (id, organization_id, design_id, revision_id, document_id, document_revision,
        scope_kind, operation, kind, status, owner_id, request_hash, request_metadata_json,
        renderer_version, renderer_ipc_protocol_version, raster_normalizer_version,
        warnings_json, created_at, heartbeat_at, lease_expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?)`,
    ).run(
      jobId,
      organizationId,
      designId,
      resolved?.revision_id ?? null,
      input.documentId ?? null,
      input.documentRevision ?? null,
      scopeKind,
      operation,
      input.kind,
      this.ownerId,
      input.requestHash,
      requestMetadataJson,
      RENDERER_VERSION,
      RENDERER_IPC_PROTOCOL_VERSION,
      RASTER_NORMALIZER_VERSION,
      now,
      now,
      leaseExpiresAt,
    );
    return jobId;
  }

  heartbeat(): number {
    const { now, leaseExpiresAt } = this.#timestamps();
    return this.sqlite.prepare(
      `UPDATE render_jobs
       SET heartbeat_at = ?, lease_expires_at = ?
       WHERE owner_id = ? AND status IN ('queued', 'running')`,
    ).run(now, leaseExpiresAt, this.ownerId).changes;
  }

  start(jobId: string): void {
    const { now, leaseExpiresAt } = this.#timestamps();
    const result = this.sqlite.prepare(
      `UPDATE render_jobs
       SET status = 'running', started_at = ?, heartbeat_at = ?, lease_expires_at = ?
       WHERE id = ? AND owner_id = ? AND status = 'queued'`,
    ).run(now, now, leaseExpiresAt, jobId, this.ownerId);
    if (result.changes !== 1) throw new Error(`Render job ${jobId} is not queued by this owner.`);
  }

  succeed(jobId: string, output: RenderJobSuccessRecord): void {
    requirePositiveInteger(output.output.length, "Render-job output bytes");
    requirePositiveInteger(output.width, "Render-job output width");
    requirePositiveInteger(output.height, "Render-job output height");
    const warningsJson = boundedWarnings(output.warnings ?? []);
    const { now } = this.#timestamps();
    const result = this.sqlite.prepare(
      `UPDATE render_jobs
       SET status = 'succeeded', output_sha256 = ?, output_bytes = ?, output_width = ?,
           output_height = ?, output_renderer = ?, warnings_json = ?, completed_at = ?
       WHERE id = ? AND owner_id = ? AND status = 'running'`,
    ).run(
      sha256(output.output),
      output.output.length,
      output.width,
      output.height,
      output.renderer,
      warningsJson,
      now,
      jobId,
      this.ownerId,
    );
    if (result.changes !== 1) throw new Error(`Render job ${jobId} is not running under this owner.`);
  }

  fail(jobId: string, failure: RenderJobFailureRecord): void {
    const code = boundedText(failure.code, MAX_ERROR_CODE_LENGTH) || "INTERNAL_ERROR";
    const message = boundedText(failure.message, MAX_ERROR_MESSAGE_LENGTH) || "Render job failed.";
    const { now } = this.#timestamps();
    const result = this.sqlite.prepare(
      `UPDATE render_jobs
       SET status = 'failed', error_code = ?, error_message = ?, retryable = ?, completed_at = ?
       WHERE id = ? AND owner_id = ? AND status IN ('queued', 'running')`,
    ).run(code, message, failure.retryable ? 1 : 0, now, jobId, this.ownerId);
    if (result.changes !== 1) throw new Error(`Render job ${jobId} is already terminal, missing, or owned elsewhere.`);
  }

  recoverExpired(now = this.#now()): number {
    const canonicalNow = canonicalTimestamp(now, "Render-job recovery timestamp");
    const result = this.sqlite.prepare(
      `UPDATE render_jobs
       SET status = 'failed', error_code = 'RENDER_INTERRUPTED',
           error_message = 'The owning API process stopped renewing this render job lease.',
           retryable = 1, completed_at = ?
       WHERE status IN ('queued', 'running') AND lease_expires_at <= ?`,
    ).run(canonicalNow, canonicalNow);
    return result.changes;
  }

  cleanupRetention(now = this.#now()): number {
    return cleanupRetainedRenderJobs(this.sqlite, canonicalTimestamp(now, "Render-job retention timestamp"));
  }
}
