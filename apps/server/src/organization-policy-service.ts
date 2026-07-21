import { randomUUID } from "node:crypto";

import type { DesignerDatabase } from "./db/database.js";
import { appendAuditEvent, assertScope, resolveAccess, type AccessContext } from "./authorization.js";
import { DomainError } from "./errors.js";
import { canonicalJson, hashPayload } from "./ids.js";
import {
  canonicalOrganizationPolicy,
  loadOrganizationPolicy,
  organizationPolicyYaml,
  parseOrganizationPolicy,
  sha256Text,
  type LoadedOrganizationPolicy,
} from "./organization-policy-model.js";

export interface OrganizationPolicyUpdateResult extends LoadedOrganizationPolicy {
  previousConfigurationHash: string;
}

export interface AuditRetentionCandidateSummary {
  count: number;
  bytes: number;
  firstId: number | null;
  lastId: number | null;
  sha256: string;
  hasMore: boolean;
}

export interface AuditRetentionPreview {
  previewId: string;
  configurationHash: string;
  policyHash: string;
  retentionDays: number;
  cutoffAt: string;
  planHash: string;
  auditEvents: AuditRetentionCandidateSummary;
  outboxEvents: AuditRetentionCandidateSummary;
  generatedAt: string;
  expiresAt: string;
}

export interface AuditRetentionRun {
  runId: string;
  previewId: string;
  configurationHash: string;
  policyHash: string;
  retentionDays: number;
  cutoffAt: string;
  planHash: string;
  auditEvents: AuditRetentionCandidateSummary;
  outboxEvents: AuditRetentionCandidateSummary;
  previousRunHash: string | null;
  runHash: string;
  commitAuditEventId: number;
  commitOutboxEventId: number;
  completedAt: string;
}

interface AuditCandidateRow {
  id: number;
  actor_id: string;
  action: string;
  target_type: string;
  target_id: string | null;
  details_json: string;
  created_at: string;
}

interface OutboxCandidateRow {
  id: number;
  actor_id: string;
  event_type: string;
  payload_json: string;
  workspace: number;
  created_at: string;
  published_at: string;
}

interface CandidateSet<Row> {
  ids: number[];
  rows: Row[];
  summary: AuditRetentionCandidateSummary;
}

interface AuditRetentionPlan {
  configurationHash: string;
  policyHash: string;
  retentionDays: number;
  cutoffAt: string;
  planHash: string;
  audit: CandidateSet<AuditCandidateRow>;
  outbox: CandidateSet<OutboxCandidateRow>;
}

interface AuditRetentionPreviewRow {
  id: string;
  organization_id: string;
  actor_id: string;
  configuration_hash: string;
  policy_hash: string;
  retention_days: number;
  cutoff_at: string;
  audit_event_ids_json: string;
  audit_event_count: number;
  audit_event_bytes: number;
  audit_first_id: number | null;
  audit_last_id: number | null;
  audit_events_hash: string;
  audit_has_more: 0 | 1;
  outbox_event_ids_json: string;
  outbox_event_count: number;
  outbox_event_bytes: number;
  outbox_first_id: number | null;
  outbox_last_id: number | null;
  outbox_events_hash: string;
  outbox_has_more: 0 | 1;
  plan_hash: string;
  status: "ready" | "expired" | "committed";
  created_at: string;
  expires_at: string;
  committed_run_id: string | null;
  committed_at: string | null;
}

interface AuditRetentionRunRow {
  id: string;
  preview_id: string;
  request_hash: string;
  configuration_hash: string;
  policy_hash: string;
  retention_days: number;
  cutoff_at: string;
  audit_event_count: number;
  audit_event_bytes: number;
  audit_first_id: number | null;
  audit_last_id: number | null;
  audit_events_hash: string;
  audit_has_more: 0 | 1;
  outbox_event_count: number;
  outbox_event_bytes: number;
  outbox_first_id: number | null;
  outbox_last_id: number | null;
  outbox_events_hash: string;
  outbox_has_more: 0 | 1;
  plan_hash: string;
  previous_run_hash: string | null;
  run_hash: string;
  commit_audit_event_id: number;
  commit_outbox_event_id: number;
  completed_at: string;
}

const AUDIT_RETENTION_PREVIEW_TTL_MS = 15 * 60 * 1_000;
const AUDIT_RETENTION_EXPIRED_PREVIEW_GRACE_MS = 24 * 60 * 60 * 1_000;
const AUDIT_RETENTION_MINIMUM_DAYS = 30;
const MAX_RETENTION_CANDIDATES_PER_KIND = 2_000;
const MAX_RETENTION_CANONICAL_BYTES_PER_KIND = 8 * 1_024 * 1_024;
const RETENTION_ROW_OVERHEAD_BYTES = 2_048;
const auditRetentionPreviewIdPattern = /^audit_retention_preview_[a-f0-9]{32}$/;
const auditRetentionPlanHashPattern = /^[a-f0-9]{64}$/;
const auditRetentionIdempotencyKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;

function sameNumberArray(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function parsePersistedIds(value: string, expectedCount: number, label: string): number[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)
      || parsed.length !== expectedCount
      || !parsed.every((id) => Number.isSafeInteger(id) && id > 0)
      || new Set(parsed).size !== parsed.length) {
      throw new Error("invalid IDs");
    }
    return parsed as number[];
  } catch (error) {
    throw new DomainError("INTERNAL_ERROR", `The persisted ${label} candidate list is invalid.`, 500, { cause: error });
  }
}

function candidateSummary(row: {
  count: number;
  bytes: number;
  firstId: number | null;
  lastId: number | null;
  sha256: string;
  hasMore: boolean;
}): AuditRetentionCandidateSummary {
  return {
    count: row.count,
    bytes: row.bytes,
    firstId: row.firstId,
    lastId: row.lastId,
    sha256: row.sha256,
    hasMore: row.hasMore,
  };
}

export class OrganizationPolicyService {
  readonly #now: () => Date;

  constructor(readonly database: DesignerDatabase, options: { now?: () => Date } = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  assertOrganizationAdministrationAllowed(actorId: string): void {
    this.assertOrganizationAdmin(resolveAccess(this.database.sqlite, actorId));
  }

  assertOrganizationReadAllowed(actorId: string): void {
    this.assertRead(resolveAccess(this.database.sqlite, actorId));
  }

  read(actorId: string): LoadedOrganizationPolicy {
    const access = resolveAccess(this.database.sqlite, actorId);
    this.assertRead(access);
    return loadOrganizationPolicy(this.database.sqlite, access.organizationId);
  }

  exportYaml(actorId: string): { filename: string; yaml: string; policyHash: string; configurationHash: string } {
    const result = this.read(actorId);
    return {
      filename: "organization.formaspec.yaml",
      yaml: organizationPolicyYaml(result),
      policyHash: result.policyHash,
      configurationHash: result.configurationHash,
    };
  }

  update(actorId: string, input: { expectedConfigurationHash: string; policy: unknown }): OrganizationPolicyUpdateResult {
    const access = resolveAccess(this.database.sqlite, actorId);
    this.assertOrganizationAdmin(access);
    if (!/^[a-f0-9]{64}$/.test(input.expectedConfigurationHash)) {
      throw new DomainError("VALIDATION_FAILED", "The expected organization configuration hash is invalid.", 422);
    }
    const policy = parseOrganizationPolicy(input.policy);
    const policyJson = canonicalOrganizationPolicy(policy);
    const policyHash = sha256Text(policyJson);
    const transaction = this.database.sqlite.transaction(() => {
      const current = loadOrganizationPolicy(this.database.sqlite, access.organizationId);
      if (current.configurationHash !== input.expectedConfigurationHash) {
        throw new DomainError("VERSION_CONFLICT", "The organization policy changed before this update.", 409, {
          details: {
            expectedConfigurationHash: input.expectedConfigurationHash,
            currentConfigurationHash: current.configurationHash,
            currentPolicyHash: current.policyHash,
          },
        });
      }
      const now = this.#now().toISOString();
      const changed = this.database.sqlite.prepare(
        "UPDATE organizations SET config_json = ?, updated_at = ? WHERE id = ? AND config_json = ?",
      ).run(policyJson, now, access.organizationId, this.currentRawConfiguration(access.organizationId));
      if (changed.changes !== 1) {
        throw new DomainError("VERSION_CONFLICT", "The organization policy changed concurrently.", 409);
      }
      this.database.sqlite.prepare(
        `INSERT INTO backup_schedules
         (organization_id, enabled, cron_expression, daily_retention, weekly_retention, monthly_retention, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(organization_id) DO UPDATE SET
           enabled = excluded.enabled,
           cron_expression = excluded.cron_expression,
           daily_retention = excluded.daily_retention,
           weekly_retention = excluded.weekly_retention,
           monthly_retention = excluded.monthly_retention,
           updated_at = excluded.updated_at`,
      ).run(
        access.organizationId,
        policy.backups.enabled ? 1 : 0,
        policy.backups.scheduleUtc,
        policy.backups.retention.daily,
        policy.backups.retention.weekly,
        policy.backups.retention.monthly,
        now,
      );
      appendAuditEvent(this.database.sqlite, access, "organization_policy.update", "organization", access.organizationId, {
        previousConfigurationHash: current.configurationHash,
        policyHash,
        schemaVersion: policy.schemaVersion,
      });
      return {
        ...loadOrganizationPolicy(this.database.sqlite, access.organizationId),
        previousConfigurationHash: current.configurationHash,
      };
    });
    return transaction.immediate();
  }

  previewAuditRetention(actorId: string): AuditRetentionPreview {
    const access = resolveAccess(this.database.sqlite, actorId);
    this.assertOrganizationAdmin(access);
    const transaction = this.database.sqlite.transaction(() => {
      const generatedDate = this.#now();
      const generatedAt = generatedDate.toISOString();
      const cleanupBefore = new Date(generatedDate.getTime() - AUDIT_RETENTION_EXPIRED_PREVIEW_GRACE_MS).toISOString();
      this.database.sqlite.prepare(
        `UPDATE audit_retention_previews SET status = 'expired'
         WHERE organization_id = ? AND status = 'ready' AND expires_at <= ?`,
      ).run(access.organizationId, generatedAt);
      this.database.sqlite.prepare(
        `DELETE FROM audit_retention_previews
         WHERE organization_id = ? AND status = 'expired' AND expires_at < ?`,
      ).run(access.organizationId, cleanupBefore);

      const loaded = this.loadRetentionPolicy(access);
      const retentionDays = Math.max(AUDIT_RETENTION_MINIMUM_DAYS, loaded.policy.audit.retentionDays);
      const cutoffAt = new Date(generatedDate.getTime() - retentionDays * 86_400_000).toISOString();
      const plan = this.buildAuditRetentionPlan(access.organizationId, loaded, cutoffAt);
      const previewId = `audit_retention_preview_${randomUUID().replaceAll("-", "")}`;
      const expiresAt = new Date(generatedDate.getTime() + AUDIT_RETENTION_PREVIEW_TTL_MS).toISOString();
      this.database.sqlite.prepare(
        `INSERT INTO audit_retention_previews
         (id, organization_id, actor_id, configuration_hash, policy_hash, retention_days, cutoff_at,
          audit_event_ids_json, audit_event_count, audit_event_bytes, audit_first_id, audit_last_id,
          audit_events_hash, audit_has_more, outbox_event_ids_json, outbox_event_count, outbox_event_bytes,
          outbox_first_id, outbox_last_id, outbox_events_hash, outbox_has_more, plan_hash, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)`,
      ).run(
        previewId,
        access.organizationId,
        access.principalId,
        plan.configurationHash,
        plan.policyHash,
        plan.retentionDays,
        plan.cutoffAt,
        JSON.stringify(plan.audit.ids),
        plan.audit.summary.count,
        plan.audit.summary.bytes,
        plan.audit.summary.firstId,
        plan.audit.summary.lastId,
        plan.audit.summary.sha256,
        plan.audit.summary.hasMore ? 1 : 0,
        JSON.stringify(plan.outbox.ids),
        plan.outbox.summary.count,
        plan.outbox.summary.bytes,
        plan.outbox.summary.firstId,
        plan.outbox.summary.lastId,
        plan.outbox.summary.sha256,
        plan.outbox.summary.hasMore ? 1 : 0,
        plan.planHash,
        generatedAt,
        expiresAt,
      );
      return this.publicAuditRetentionPreview(previewId, generatedAt, expiresAt, plan);
    });
    return transaction.immediate();
  }

  executeAuditRetention(
    actorId: string,
    previewId: string,
    input: { expectedPlanHash: string; idempotencyKey: string },
  ): AuditRetentionRun {
    const access = resolveAccess(this.database.sqlite, actorId);
    this.assertOrganizationAdmin(access);
    if (!auditRetentionPreviewIdPattern.test(previewId)) {
      throw new DomainError("NOT_FOUND", "Audit-retention preview not found.", 404);
    }
    if (!auditRetentionPlanHashPattern.test(input.expectedPlanHash)) {
      throw new DomainError("VALIDATION_FAILED", "The expected audit-retention plan hash is invalid.", 422);
    }
    if (!auditRetentionIdempotencyKeyPattern.test(input.idempotencyKey)) {
      throw new DomainError("VALIDATION_FAILED", "The audit-retention idempotency key is invalid.", 422);
    }
    const requestHash = hashPayload({ previewId, expectedPlanHash: input.expectedPlanHash });
    const transaction = this.database.sqlite.transaction(() => {
      const existing = this.database.sqlite.prepare(
        `SELECT * FROM audit_retention_runs
         WHERE organization_id = ? AND actor_id = ? AND idempotency_key = ?`,
      ).get(access.organizationId, access.principalId, input.idempotencyKey) as AuditRetentionRunRow | undefined;
      if (existing) {
        if (existing.request_hash !== requestHash) {
          throw new DomainError("IDEMPOTENCY_CONFLICT", "The audit-retention idempotency key was already used with different input.", 409);
        }
        return this.publicAuditRetentionRun(existing);
      }

      const preview = this.database.sqlite.prepare(
        "SELECT * FROM audit_retention_previews WHERE id = ? AND organization_id = ?",
      ).get(previewId, access.organizationId) as AuditRetentionPreviewRow | undefined;
      if (!preview) throw new DomainError("NOT_FOUND", "Audit-retention preview not found.", 404);
      if (preview.actor_id !== access.principalId) {
        throw new DomainError("FORBIDDEN", "The audit-retention preview belongs to another administrator.", 403);
      }
      if (preview.status === "committed") {
        throw new DomainError("PREVIEW_ALREADY_COMMITTED", "The audit-retention preview was already committed.", 409, {
          details: { runId: preview.committed_run_id },
        });
      }
      const completedDate = this.#now();
      const completedAt = completedDate.toISOString();
      if (preview.status === "expired" || preview.expires_at <= completedAt) {
        throw new DomainError("PREVIEW_EXPIRED", "The audit-retention preview expired.", 410);
      }
      if (preview.plan_hash !== input.expectedPlanHash) {
        throw new DomainError("VERSION_CONFLICT", "The audit-retention plan hash does not match the preview.", 409, {
          details: { expectedPlanHash: input.expectedPlanHash, previewPlanHash: preview.plan_hash },
        });
      }

      const loaded = this.loadRetentionPolicy(access);
      if (loaded.configurationHash !== preview.configuration_hash
        || loaded.policyHash !== preview.policy_hash
        || loaded.policy.audit.retentionDays !== preview.retention_days) {
        throw new DomainError("VERSION_CONFLICT", "Organization audit policy changed after the retention preview.", 409, {
          details: {
            previewConfigurationHash: preview.configuration_hash,
            currentConfigurationHash: loaded.configurationHash,
            previewPolicyHash: preview.policy_hash,
            currentPolicyHash: loaded.policyHash,
          },
        });
      }
      const safeCutoffAt = new Date(completedDate.getTime() - loaded.policy.audit.retentionDays * 86_400_000).toISOString();
      if (preview.cutoff_at > safeCutoffAt) {
        throw new DomainError("VERSION_CONFLICT", "The retention preview cutoff is no longer old enough for the configured minimum.", 409, {
          details: { previewCutoffAt: preview.cutoff_at, currentSafeCutoffAt: safeCutoffAt },
        });
      }

      const previewAuditIds = parsePersistedIds(preview.audit_event_ids_json, preview.audit_event_count, "audit-retention audit-event");
      const previewOutboxIds = parsePersistedIds(preview.outbox_event_ids_json, preview.outbox_event_count, "audit-retention outbox-event");
      const current = this.buildAuditRetentionPlan(access.organizationId, loaded, preview.cutoff_at);
      if (current.planHash !== preview.plan_hash
        || !sameNumberArray(current.audit.ids, previewAuditIds)
        || !sameNumberArray(current.outbox.ids, previewOutboxIds)) {
        throw new DomainError("VERSION_CONFLICT", "Audit or event-outbox state changed after the retention preview; create a new preview.", 409, {
          details: { previewPlanHash: preview.plan_hash, currentPlanHash: current.planHash },
        });
      }

      const prior = this.database.sqlite.prepare(
        `SELECT run_hash FROM audit_retention_runs
         WHERE organization_id = ? ORDER BY commit_audit_event_id DESC LIMIT 1`,
      ).get(access.organizationId) as { run_hash: string } | undefined;
      const previousRunHash = prior?.run_hash ?? null;
      const runId = `audit_retention_run_${randomUUID().replaceAll("-", "")}`;
      const runHash = hashPayload({
        format: "formaspec-audit-retention-run",
        formatVersion: 1,
        runId,
        organizationId: access.organizationId,
        previewId,
        actorId: access.principalId,
        configurationHash: current.configurationHash,
        policyHash: current.policyHash,
        retentionDays: current.retentionDays,
        cutoffAt: current.cutoffAt,
        planHash: current.planHash,
        auditEvents: current.audit.summary,
        outboxEvents: current.outbox.summary,
        previousRunHash,
        completedAt,
      });
      const commitAuditEventId = appendAuditEvent(
        this.database.sqlite,
        access,
        "audit_retention.commit",
        "audit_retention_run",
        runId,
        {
          previewId,
          planHash: current.planHash,
          runHash,
          previousRunHash,
          retentionDays: current.retentionDays,
          cutoffAt: current.cutoffAt,
          auditEventCount: current.audit.summary.count,
          auditEventsHash: current.audit.summary.sha256,
          outboxEventCount: current.outbox.summary.count,
          outboxEventsHash: current.outbox.summary.sha256,
          auditHasMore: current.audit.summary.hasMore,
          outboxHasMore: current.outbox.summary.hasMore,
        },
      );
      const commitOutbox = this.database.sqlite.prepare(
        `SELECT id FROM event_outbox
         WHERE organization_id = ? AND event_type = 'audit.retention'
           AND json_extract(payload_json, '$.auditEventId') = ?`,
      ).get(access.organizationId, commitAuditEventId) as { id: number } | undefined;
      if (!commitOutbox) {
        throw new DomainError("INTERNAL_ERROR", "Audit-retention evidence did not enter the durable outbox.", 500);
      }

      this.database.sqlite.prepare(
        `INSERT INTO audit_retention_runs
         (id, organization_id, preview_id, actor_id, idempotency_key, request_hash,
          configuration_hash, policy_hash, retention_days, cutoff_at,
          audit_event_ids_json, audit_event_count, audit_event_bytes, audit_first_id, audit_last_id,
          audit_events_hash, audit_has_more, outbox_event_ids_json, outbox_event_count, outbox_event_bytes,
          outbox_first_id, outbox_last_id, outbox_events_hash, outbox_has_more, plan_hash,
          previous_run_hash, run_hash, commit_audit_event_id, commit_outbox_event_id, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        runId,
        access.organizationId,
        previewId,
        access.principalId,
        input.idempotencyKey,
        requestHash,
        current.configurationHash,
        current.policyHash,
        current.retentionDays,
        current.cutoffAt,
        JSON.stringify(current.audit.ids),
        current.audit.summary.count,
        current.audit.summary.bytes,
        current.audit.summary.firstId,
        current.audit.summary.lastId,
        current.audit.summary.sha256,
        current.audit.summary.hasMore ? 1 : 0,
        JSON.stringify(current.outbox.ids),
        current.outbox.summary.count,
        current.outbox.summary.bytes,
        current.outbox.summary.firstId,
        current.outbox.summary.lastId,
        current.outbox.summary.sha256,
        current.outbox.summary.hasMore ? 1 : 0,
        current.planHash,
        previousRunHash,
        runHash,
        commitAuditEventId,
        commitOutbox.id,
        completedAt,
      );

      const insertPermit = this.database.sqlite.prepare(
        `INSERT INTO audit_retention_delete_permits (run_id, organization_id, event_kind, event_id)
         VALUES (?, ?, ?, ?)`,
      );
      for (const id of current.audit.ids) insertPermit.run(runId, access.organizationId, "audit", id);
      for (const id of current.outbox.ids) insertPermit.run(runId, access.organizationId, "outbox", id);

      const deletedOutbox = this.database.sqlite.prepare(
        `DELETE FROM event_outbox
         WHERE organization_id = ? AND id IN (
           SELECT event_id FROM audit_retention_delete_permits
           WHERE run_id = ? AND event_kind = 'outbox'
         )`,
      ).run(access.organizationId, runId);
      const deletedAudit = this.database.sqlite.prepare(
        `DELETE FROM audit_events
         WHERE organization_id = ? AND id IN (
           SELECT event_id FROM audit_retention_delete_permits
           WHERE run_id = ? AND event_kind = 'audit'
         )`,
      ).run(access.organizationId, runId);
      if (deletedAudit.changes !== current.audit.ids.length || deletedOutbox.changes !== current.outbox.ids.length) {
        throw new DomainError("VERSION_CONFLICT", "Audit-retention candidates changed during commit.", 409);
      }
      const removedPermits = this.database.sqlite.prepare(
        "DELETE FROM audit_retention_delete_permits WHERE run_id = ?",
      ).run(runId);
      if (removedPermits.changes !== current.audit.ids.length + current.outbox.ids.length) {
        throw new DomainError("INTERNAL_ERROR", "Audit-retention delete permits were not cleaned up atomically.", 500);
      }
      const committed = this.database.sqlite.prepare(
        `UPDATE audit_retention_previews
         SET status = 'committed', committed_run_id = ?, committed_at = ?
         WHERE id = ? AND organization_id = ? AND actor_id = ? AND status = 'ready'`,
      ).run(runId, completedAt, previewId, access.organizationId, access.principalId);
      if (committed.changes !== 1) {
        throw new DomainError("VERSION_CONFLICT", "Audit-retention preview changed during commit.", 409);
      }

      return this.publicAuditRetentionRun({
        id: runId,
        preview_id: previewId,
        request_hash: requestHash,
        configuration_hash: current.configurationHash,
        policy_hash: current.policyHash,
        retention_days: current.retentionDays,
        cutoff_at: current.cutoffAt,
        audit_event_count: current.audit.summary.count,
        audit_event_bytes: current.audit.summary.bytes,
        audit_first_id: current.audit.summary.firstId,
        audit_last_id: current.audit.summary.lastId,
        audit_events_hash: current.audit.summary.sha256,
        audit_has_more: current.audit.summary.hasMore ? 1 : 0,
        outbox_event_count: current.outbox.summary.count,
        outbox_event_bytes: current.outbox.summary.bytes,
        outbox_first_id: current.outbox.summary.firstId,
        outbox_last_id: current.outbox.summary.lastId,
        outbox_events_hash: current.outbox.summary.sha256,
        outbox_has_more: current.outbox.summary.hasMore ? 1 : 0,
        plan_hash: current.planHash,
        previous_run_hash: previousRunHash,
        run_hash: runHash,
        commit_audit_event_id: commitAuditEventId,
        commit_outbox_event_id: commitOutbox.id,
        completed_at: completedAt,
      });
    });
    return transaction.immediate();
  }

  listAuditRetentionRuns(actorId: string, limit = 50): AuditRetentionRun[] {
    const access = resolveAccess(this.database.sqlite, actorId);
    this.assertOrganizationAdmin(access);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new DomainError("VALIDATION_FAILED", "Audit-retention run limit must be an integer from 1 to 100.", 422);
    }
    const rows = this.database.sqlite.prepare(
      `SELECT * FROM audit_retention_runs
       WHERE organization_id = ? ORDER BY commit_audit_event_id DESC LIMIT ?`,
    ).all(access.organizationId, limit) as AuditRetentionRunRow[];
    return rows.map((row) => this.publicAuditRetentionRun(row));
  }

  private buildAuditRetentionPlan(
    organizationId: string,
    loaded: LoadedOrganizationPolicy,
    cutoffAt: string,
  ): AuditRetentionPlan {
    const audit = this.auditRetentionCandidates(organizationId, cutoffAt);
    const outbox = this.outboxRetentionCandidates(organizationId, cutoffAt);
    const retentionDays = Math.max(AUDIT_RETENTION_MINIMUM_DAYS, loaded.policy.audit.retentionDays);
    const planHash = hashPayload({
      format: "formaspec-audit-retention-plan",
      formatVersion: 1,
      organizationId,
      configurationHash: loaded.configurationHash,
      policyHash: loaded.policyHash,
      retentionDays,
      cutoffAt,
      auditEventIds: audit.ids,
      auditEvents: audit.summary,
      outboxEventIds: outbox.ids,
      outboxEvents: outbox.summary,
    });
    return {
      configurationHash: loaded.configurationHash,
      policyHash: loaded.policyHash,
      retentionDays,
      cutoffAt,
      planHash,
      audit,
      outbox,
    };
  }

  private auditRetentionCandidates(organizationId: string, cutoffAt: string): CandidateSet<AuditCandidateRow> {
    const metadata = this.database.sqlite.prepare(
      `SELECT id,
              length(CAST(actor_id AS BLOB))
                + length(CAST(action AS BLOB))
                + length(CAST(target_type AS BLOB))
                + COALESCE(length(CAST(target_id AS BLOB)), 0)
                + length(CAST(details_json AS BLOB))
                + length(CAST(created_at AS BLOB)) AS payload_bytes
       FROM audit_events
       WHERE organization_id = ? AND created_at < ?
         AND action NOT LIKE 'audit_retention.%'
         AND action <> 'organization_policy.update'
         AND action NOT IN ('backup.pre_restore_create', 'backup.restore_commit', 'backup.restore_rolled_back')
       ORDER BY id LIMIT ?`,
    ).all(organizationId, cutoffAt, MAX_RETENTION_CANDIDATES_PER_KIND + 1) as Array<{ id: number; payload_bytes: number }>;
    const selected = this.selectBoundedCandidateIds(metadata, "audit event");
    const rows = selected.ids.length === 0 ? [] : this.database.sqlite.prepare(
      `SELECT id, actor_id, action, target_type, target_id, details_json, created_at
       FROM audit_events
       WHERE organization_id = ? AND created_at < ?
         AND action NOT LIKE 'audit_retention.%'
         AND action <> 'organization_policy.update'
         AND action NOT IN ('backup.pre_restore_create', 'backup.restore_commit', 'backup.restore_rolled_back')
       ORDER BY id LIMIT ?`,
    ).all(organizationId, cutoffAt, selected.ids.length) as AuditCandidateRow[];
    if (!sameNumberArray(rows.map((row) => row.id), selected.ids)) {
      throw new DomainError("VERSION_CONFLICT", "Audit events changed while the retention plan was built.", 409);
    }
    return this.candidateSet(rows, selected.hasMore);
  }

  private outboxRetentionCandidates(organizationId: string, cutoffAt: string): CandidateSet<OutboxCandidateRow> {
    const metadata = this.database.sqlite.prepare(
      `SELECT id,
              length(CAST(actor_id AS BLOB))
                + length(CAST(event_type AS BLOB))
                + length(CAST(payload_json AS BLOB))
                + length(CAST(created_at AS BLOB))
                + length(CAST(published_at AS BLOB)) AS payload_bytes
       FROM event_outbox
       WHERE organization_id = ? AND created_at < ? AND published_at IS NOT NULL
         AND event_type <> 'audit.retention'
         AND NOT (
           json_valid(payload_json) = 1
           AND (
             (event_type = 'organization_policy.changed'
               AND json_extract(payload_json, '$.action') = 'organization_policy.update')
             OR (event_type = 'backup.operation'
               AND json_extract(payload_json, '$.action') IN (
                 'backup.pre_restore_create', 'backup.restore_commit', 'backup.restore_rolled_back'
               ))
           )
         )
       ORDER BY id LIMIT ?`,
    ).all(organizationId, cutoffAt, MAX_RETENTION_CANDIDATES_PER_KIND + 1) as Array<{ id: number; payload_bytes: number }>;
    const selected = this.selectBoundedCandidateIds(metadata, "event outbox row");
    const rows = selected.ids.length === 0 ? [] : this.database.sqlite.prepare(
      `SELECT id, actor_id, event_type, payload_json, workspace, created_at, published_at
       FROM event_outbox
       WHERE organization_id = ? AND created_at < ? AND published_at IS NOT NULL
         AND event_type <> 'audit.retention'
         AND NOT (
           json_valid(payload_json) = 1
           AND (
             (event_type = 'organization_policy.changed'
               AND json_extract(payload_json, '$.action') = 'organization_policy.update')
             OR (event_type = 'backup.operation'
               AND json_extract(payload_json, '$.action') IN (
                 'backup.pre_restore_create', 'backup.restore_commit', 'backup.restore_rolled_back'
               ))
           )
         )
       ORDER BY id LIMIT ?`,
    ).all(organizationId, cutoffAt, selected.ids.length) as OutboxCandidateRow[];
    if (!sameNumberArray(rows.map((row) => row.id), selected.ids)) {
      throw new DomainError("VERSION_CONFLICT", "Event outbox rows changed while the retention plan was built.", 409);
    }
    return this.candidateSet(rows, selected.hasMore);
  }

  private selectBoundedCandidateIds(
    metadata: Array<{ id: number; payload_bytes: number }>,
    label: string,
  ): { ids: number[]; hasMore: boolean } {
    const ids: number[] = [];
    let estimatedBytes = 0;
    for (const row of metadata.slice(0, MAX_RETENTION_CANDIDATES_PER_KIND)) {
      const rowBytes = row.payload_bytes * 6 + RETENTION_ROW_OVERHEAD_BYTES;
      if (!Number.isSafeInteger(rowBytes) || rowBytes < 0) {
        throw new DomainError("PAYLOAD_TOO_LARGE", `Audit retention cannot safely size ${label} ${row.id}.`, 413);
      }
      if (rowBytes > MAX_RETENTION_CANONICAL_BYTES_PER_KIND && ids.length === 0) {
        throw new DomainError("PAYLOAD_TOO_LARGE", `Audit retention cannot safely hash ${label} ${row.id} in one bounded run.`, 413, {
          details: { eventId: row.id, maximumCanonicalBytes: MAX_RETENTION_CANONICAL_BYTES_PER_KIND },
        });
      }
      if (estimatedBytes + rowBytes > MAX_RETENTION_CANONICAL_BYTES_PER_KIND) break;
      ids.push(row.id);
      estimatedBytes += rowBytes;
    }
    return { ids, hasMore: metadata.length > ids.length };
  }

  private candidateSet<Row extends { id: number }>(rows: Row[], hasMore: boolean): CandidateSet<Row> {
    const canonical = canonicalJson(rows);
    const canonicalBytes = Buffer.byteLength(canonical, "utf8");
    if (canonicalBytes > MAX_RETENTION_CANONICAL_BYTES_PER_KIND) {
      throw new DomainError("PAYLOAD_TOO_LARGE", "Audit-retention canonical evidence exceeds the bounded 8 MiB limit.", 413, {
        details: { canonicalBytes, maximumCanonicalBytes: MAX_RETENTION_CANONICAL_BYTES_PER_KIND },
      });
    }
    return {
      ids: rows.map((row) => row.id),
      rows,
      summary: candidateSummary({
        count: rows.length,
        bytes: canonicalBytes,
        firstId: rows[0]?.id ?? null,
        lastId: rows.at(-1)?.id ?? null,
        sha256: sha256Text(canonical),
        hasMore,
      }),
    };
  }

  private publicAuditRetentionPreview(
    previewId: string,
    generatedAt: string,
    expiresAt: string,
    plan: AuditRetentionPlan,
  ): AuditRetentionPreview {
    return {
      previewId,
      configurationHash: plan.configurationHash,
      policyHash: plan.policyHash,
      retentionDays: plan.retentionDays,
      cutoffAt: plan.cutoffAt,
      planHash: plan.planHash,
      auditEvents: plan.audit.summary,
      outboxEvents: plan.outbox.summary,
      generatedAt,
      expiresAt,
    };
  }

  private publicAuditRetentionRun(row: AuditRetentionRunRow): AuditRetentionRun {
    return {
      runId: row.id,
      previewId: row.preview_id,
      configurationHash: row.configuration_hash,
      policyHash: row.policy_hash,
      retentionDays: row.retention_days,
      cutoffAt: row.cutoff_at,
      planHash: row.plan_hash,
      auditEvents: candidateSummary({
        count: row.audit_event_count,
        bytes: row.audit_event_bytes,
        firstId: row.audit_first_id,
        lastId: row.audit_last_id,
        sha256: row.audit_events_hash,
        hasMore: row.audit_has_more === 1,
      }),
      outboxEvents: candidateSummary({
        count: row.outbox_event_count,
        bytes: row.outbox_event_bytes,
        firstId: row.outbox_first_id,
        lastId: row.outbox_last_id,
        sha256: row.outbox_events_hash,
        hasMore: row.outbox_has_more === 1,
      }),
      previousRunHash: row.previous_run_hash,
      runHash: row.run_hash,
      commitAuditEventId: row.commit_audit_event_id,
      commitOutboxEventId: row.commit_outbox_event_id,
      completedAt: row.completed_at,
    };
  }

  private loadRetentionPolicy(access: AccessContext): LoadedOrganizationPolicy {
    const loaded = loadOrganizationPolicy(this.database.sqlite, access.organizationId);
    if (loaded.source === "corrupt_fail_closed") {
      throw new DomainError("FORBIDDEN", "Audit retention is disabled until the corrupt organization policy is replaced.", 403);
    }
    if (loaded.policy.audit.retentionDays < AUDIT_RETENTION_MINIMUM_DAYS) {
      throw new DomainError("FORBIDDEN", `Audit retention cannot be shorter than ${AUDIT_RETENTION_MINIMUM_DAYS} days.`, 403);
    }
    return loaded;
  }

  private currentRawConfiguration(organizationId: string): string {
    const row = this.database.sqlite.prepare(
      "SELECT config_json FROM organizations WHERE id = ?",
    ).get(organizationId) as { config_json: string } | undefined;
    if (!row) throw new DomainError("NOT_FOUND", "Organization not found.", 404);
    return row.config_json;
  }

  private assertRead(access: AccessContext): void {
    if (access.role === "agent") assertScope(access, "organization_policy:read");
  }

  private assertOrganizationAdmin(access: AccessContext): void {
    if (access.role !== "organization_admin") {
      throw new DomainError("FORBIDDEN", "Organization Administrator permission is required.", 403);
    }
  }
}
