import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DesignerDatabase } from "./db/database.js";
import { DEFAULT_ORGANIZATION_POLICY } from "./organization-policy-model.js";
import { OrganizationPolicyService } from "./organization-policy-service.js";

const databases: DesignerDatabase[] = [];
const fixedNow = "2026-07-20T12:00:00.000Z";
const oldAt = "2025-07-20T11:59:59.999Z";
const cutoffBoundary = "2025-07-20T12:00:00.000Z";
const recentAt = "2026-07-20T11:00:00.000Z";

function setup(now: () => Date = () => new Date(fixedNow)) {
  const database = new DesignerDatabase(":memory:");
  databases.push(database);
  return { database, policies: new OrganizationPolicyService(database, { now }) };
}

function insertAudit(
  database: DesignerDatabase,
  organizationId: string,
  createdAt: string,
  action = "test.action",
): number {
  const result = database.sqlite.prepare(
    `INSERT INTO audit_events
     (organization_id, actor_id, action, target_type, target_id, details_json, created_at)
     VALUES (?, 'principal_local', ?, 'test', 'target', '{"bounded":true}', ?)`,
  ).run(organizationId, action, createdAt);
  return Number(result.lastInsertRowid);
}

function insertOutbox(
  database: DesignerDatabase,
  organizationId: string,
  createdAt: string,
  published = true,
): number {
  const result = database.sqlite.prepare(
    `INSERT INTO event_outbox
     (organization_id, actor_id, event_type, payload_json, workspace, created_at, published_at)
     VALUES (?, 'local', 'design.updated', '{"designId":"document_test"}', 1, ?, ?)`,
  ).run(organizationId, createdAt, published ? createdAt : null);
  return Number(result.lastInsertRowid);
}

function captureThrown(callback: () => unknown): unknown {
  try {
    callback();
  } catch (error) {
    return error;
  }
  throw new Error("Expected callback to throw.");
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("organization audit retention", () => {
  it("commits an exact organization-scoped batch, preserves hash-chained evidence, and is idempotent", () => {
    const opened = setup();
    opened.database.sqlite.prepare(
      `INSERT INTO organizations (id, name, config_json, created_at, updated_at)
       VALUES ('organization_other', 'Other', '{}', ?, ?)`,
    ).run(fixedNow, fixedNow);

    const oldAuditId = insertAudit(opened.database, "organization_legacy", oldAt);
    const boundaryAuditId = insertAudit(opened.database, "organization_legacy", cutoffBoundary);
    const recentAuditId = insertAudit(opened.database, "organization_legacy", recentAt);
    const foreignAuditId = insertAudit(opened.database, "organization_other", oldAt);
    const oldOutboxId = insertOutbox(opened.database, "organization_legacy", oldAt);
    const recentOutboxId = insertOutbox(opened.database, "organization_legacy", recentAt);
    const unpublishedOldOutboxId = insertOutbox(opened.database, "organization_legacy", oldAt, false);
    const foreignOutboxId = insertOutbox(opened.database, "organization_other", oldAt);

    const preview = opened.policies.previewAuditRetention("local");
    expect(preview).toMatchObject({
      retentionDays: 365,
      cutoffAt: cutoffBoundary,
      auditEvents: { count: 1, firstId: oldAuditId, lastId: oldAuditId, hasMore: false },
      outboxEvents: { count: 1, firstId: oldOutboxId, lastId: oldOutboxId, hasMore: false },
    });
    expect(preview.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.auditEvents.sha256).toMatch(/^[a-f0-9]{64}$/);

    const input = { expectedPlanHash: preview.planHash, idempotencyKey: "audit-retention-test-0001" };
    const result = opened.policies.executeAuditRetention("local", preview.previewId, input);
    expect(result).toMatchObject({
      previewId: preview.previewId,
      planHash: preview.planHash,
      previousRunHash: null,
      auditEvents: { count: 1, firstId: oldAuditId, lastId: oldAuditId },
      outboxEvents: { count: 1, firstId: oldOutboxId, lastId: oldOutboxId },
    });
    expect(result.runHash).toMatch(/^[a-f0-9]{64}$/);
    expect(opened.policies.executeAuditRetention("local", preview.previewId, input)).toEqual(result);
    expect(opened.policies.listAuditRetentionRuns("local")).toEqual([result]);

    expect(opened.database.sqlite.prepare("SELECT id FROM audit_events WHERE id = ?").get(oldAuditId)).toBeUndefined();
    expect(opened.database.sqlite.prepare("SELECT id FROM event_outbox WHERE id = ?").get(oldOutboxId)).toBeUndefined();
    expect(opened.database.sqlite.prepare("SELECT id FROM audit_events WHERE id IN (?, ?)").all(boundaryAuditId, recentAuditId)).toHaveLength(2);
    expect(opened.database.sqlite.prepare("SELECT id FROM event_outbox WHERE id IN (?, ?)").all(recentOutboxId, unpublishedOldOutboxId)).toHaveLength(2);
    expect(opened.database.sqlite.prepare("SELECT id FROM audit_events WHERE id = ?").get(foreignAuditId)).toEqual({ id: foreignAuditId });
    expect(opened.database.sqlite.prepare("SELECT id FROM event_outbox WHERE id = ?").get(foreignOutboxId)).toEqual({ id: foreignOutboxId });
    expect(opened.database.sqlite.prepare("SELECT COUNT(*) AS count FROM audit_retention_delete_permits").get()).toEqual({ count: 0 });
    expect(opened.database.sqlite.prepare(
      "SELECT action FROM audit_events WHERE id = ?",
    ).get(result.commitAuditEventId)).toEqual({ action: "audit_retention.commit" });
    expect(opened.database.sqlite.prepare(
      "SELECT event_type FROM event_outbox WHERE id = ?",
    ).get(result.commitOutboxEventId)).toEqual({ event_type: "audit.retention" });
    expect(() => opened.database.sqlite.prepare("DELETE FROM audit_events WHERE id = ?").run(recentAuditId)).toThrow(/immutable outside exact retention/);
    expect(() => opened.database.sqlite.prepare("DELETE FROM event_outbox WHERE id = ?").run(recentOutboxId)).toThrow(/exact published-event retention/);
    expect(() => opened.database.sqlite.prepare("UPDATE audit_retention_runs SET completed_at = ? WHERE id = ?").run(recentAt, result.runId)).toThrow(/immutable/);

    insertAudit(opened.database, "organization_legacy", oldAt, "test.second");
    insertOutbox(opened.database, "organization_legacy", oldAt);
    const secondPreview = opened.policies.previewAuditRetention("local");
    expect(captureThrown(() => opened.policies.executeAuditRetention("local", secondPreview.previewId, {
      expectedPlanHash: secondPreview.planHash,
      idempotencyKey: input.idempotencyKey,
    }))).toMatchObject({ code: "IDEMPOTENCY_CONFLICT", statusCode: 409 });
    const second = opened.policies.executeAuditRetention("local", secondPreview.previewId, {
      expectedPlanHash: secondPreview.planHash,
      idempotencyKey: "audit-retention-test-0002",
    });
    expect(second.previousRunHash).toBe(result.runHash);
    expect(opened.policies.listAuditRetentionRuns("local")).toEqual([second, result]);
  });

  it("replays the exact idempotent result after a database restart", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "formaspec-audit-retention-restart-"));
    const filename = path.join(root, "designer.sqlite");
    try {
      const firstDatabase = new DesignerDatabase(filename);
      const firstPolicies = new OrganizationPolicyService(firstDatabase, { now: () => new Date(fixedNow) });
      insertAudit(firstDatabase, "organization_legacy", oldAt, "restart.old");
      const preview = firstPolicies.previewAuditRetention("local");
      const input = { expectedPlanHash: preview.planHash, idempotencyKey: "audit-retention-restart-0001" };
      const committed = firstPolicies.executeAuditRetention("local", preview.previewId, input);
      firstDatabase.close();

      const reopened = new DesignerDatabase(filename);
      try {
        const policies = new OrganizationPolicyService(reopened, { now: () => new Date(fixedNow) });
        expect(policies.executeAuditRetention("local", preview.previewId, input)).toEqual(committed);
        expect(policies.listAuditRetentionRuns("local")).toEqual([committed]);
        expect(reopened.sqlite.prepare("SELECT COUNT(*) AS count FROM audit_retention_runs").get()).toEqual({ count: 1 });
      } finally {
        reopened.close();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects policy changes, stale candidates, expired previews, and idempotency-key reuse without deleting data", () => {
    let now = new Date(fixedNow);
    const opened = setup(() => new Date(now));
    const oldAuditId = insertAudit(opened.database, "organization_legacy", oldAt);
    const oldOutboxId = insertOutbox(opened.database, "organization_legacy", oldAt);
    const policyPreview = opened.policies.previewAuditRetention("local");
    const current = opened.policies.read("local");
    const policy = structuredClone(DEFAULT_ORGANIZATION_POLICY);
    policy.audit.retentionDays = 730;
    opened.policies.update("local", { expectedConfigurationHash: current.configurationHash, policy });
    expect(captureThrown(() => opened.policies.executeAuditRetention("local", policyPreview.previewId, {
      expectedPlanHash: policyPreview.planHash,
      idempotencyKey: "audit-retention-policy-0001",
    }))).toMatchObject({ code: "VERSION_CONFLICT", statusCode: 409 });
    expect(opened.database.sqlite.prepare("SELECT id FROM audit_events WHERE id = ?").get(oldAuditId)).toEqual({ id: oldAuditId });
    expect(opened.database.sqlite.prepare("SELECT id FROM event_outbox WHERE id = ?").get(oldOutboxId)).toEqual({ id: oldOutboxId });

    const stored = opened.policies.read("local");
    const restoredPolicy = structuredClone(DEFAULT_ORGANIZATION_POLICY);
    opened.policies.update("local", { expectedConfigurationHash: stored.configurationHash, policy: restoredPolicy });
    const stalePreview = opened.policies.previewAuditRetention("local");
    insertAudit(opened.database, "organization_legacy", oldAt, "test.changed");
    expect(captureThrown(() => opened.policies.executeAuditRetention("local", stalePreview.previewId, {
      expectedPlanHash: stalePreview.planHash,
      idempotencyKey: "audit-retention-stale-0001",
    }))).toMatchObject({ code: "VERSION_CONFLICT", statusCode: 409 });

    const expiring = opened.policies.previewAuditRetention("local");
    now = new Date("2026-07-20T12:16:00.000Z");
    expect(captureThrown(() => opened.policies.executeAuditRetention("local", expiring.previewId, {
      expectedPlanHash: expiring.planHash,
      idempotencyKey: "audit-retention-expired-0001",
    }))).toMatchObject({ code: "PREVIEW_EXPIRED", statusCode: 410 });
    expect(opened.database.sqlite.prepare("SELECT COUNT(*) AS count FROM audit_retention_runs").get()).toEqual({ count: 0 });
  });

  it("never includes rows at or inside the configured 30-day minimum cutoff", () => {
    const opened = setup();
    const current = opened.policies.read("local");
    const policy = structuredClone(DEFAULT_ORGANIZATION_POLICY);
    policy.audit.retentionDays = 30;
    opened.policies.update("local", { expectedConfigurationHash: current.configurationHash, policy });
    const eligible = insertAudit(opened.database, "organization_legacy", "2026-06-20T11:59:59.999Z", "minimum.eligible");
    const boundary = insertAudit(opened.database, "organization_legacy", "2026-06-20T12:00:00.000Z", "minimum.boundary");
    const inside = insertAudit(opened.database, "organization_legacy", "2026-06-21T00:00:00.000Z", "minimum.inside");

    const preview = opened.policies.previewAuditRetention("local");
    expect(preview).toMatchObject({
      retentionDays: 30,
      cutoffAt: "2026-06-20T12:00:00.000Z",
      auditEvents: { count: 1, firstId: eligible, lastId: eligible },
    });
    opened.policies.executeAuditRetention("local", preview.previewId, {
      expectedPlanHash: preview.planHash,
      idempotencyKey: "audit-retention-minimum-0001",
    });
    expect(opened.database.sqlite.prepare("SELECT id FROM audit_events WHERE id = ?").get(eligible)).toBeUndefined();
    expect(opened.database.sqlite.prepare("SELECT id FROM audit_events WHERE id IN (?, ?)").all(boundary, inside)).toHaveLength(2);
  });

  it("processes large histories as deterministic bounded batches", () => {
    const opened = setup();
    const insert = opened.database.sqlite.prepare(
      `INSERT INTO audit_events
       (organization_id, actor_id, action, target_type, target_id, details_json, created_at)
       VALUES ('organization_legacy', 'principal_local', 'batch.old', 'test', NULL, '{}', ?)`,
    );
    opened.database.sqlite.transaction(() => {
      for (let index = 0; index < 2_001; index += 1) insert.run(oldAt);
    }).immediate();

    const first = opened.policies.previewAuditRetention("local");
    expect(first.auditEvents).toMatchObject({ count: 2_000, hasMore: true });
    opened.policies.executeAuditRetention("local", first.previewId, {
      expectedPlanHash: first.planHash,
      idempotencyKey: "audit-retention-batch-0001",
    });
    const second = opened.policies.previewAuditRetention("local");
    expect(second.auditEvents).toMatchObject({ count: 1, hasMore: false });
  });

  it("retains policy-governance and restore-recovery evidence permanently", () => {
    const opened = setup();
    const policyAuditId = insertAudit(opened.database, "organization_legacy", oldAt, "organization_policy.update");
    const restoreAuditId = insertAudit(opened.database, "organization_legacy", oldAt, "backup.restore_commit");
    const ordinaryAuditId = insertAudit(opened.database, "organization_legacy", oldAt, "ordinary.old");
    const insertProtectedOutbox = opened.database.sqlite.prepare(
      `INSERT INTO event_outbox
       (organization_id, actor_id, event_type, payload_json, workspace, created_at, published_at)
       VALUES ('organization_legacy', 'local', ?, ?, 1, ?, ?)`,
    );
    const policyOutboxId = Number(insertProtectedOutbox.run(
      "organization_policy.changed",
      JSON.stringify({ auditEventId: policyAuditId, action: "organization_policy.update" }),
      oldAt,
      oldAt,
    ).lastInsertRowid);
    const restoreOutboxId = Number(insertProtectedOutbox.run(
      "backup.operation",
      JSON.stringify({ auditEventId: restoreAuditId, action: "backup.restore_commit" }),
      oldAt,
      oldAt,
    ).lastInsertRowid);
    const ordinaryOutboxId = insertOutbox(opened.database, "organization_legacy", oldAt);

    const preview = opened.policies.previewAuditRetention("local");
    expect(preview.auditEvents).toMatchObject({ count: 1, firstId: ordinaryAuditId, lastId: ordinaryAuditId });
    expect(preview.outboxEvents).toMatchObject({ count: 1, firstId: ordinaryOutboxId, lastId: ordinaryOutboxId });
    opened.policies.executeAuditRetention("local", preview.previewId, {
      expectedPlanHash: preview.planHash,
      idempotencyKey: "audit-retention-evidence-0001",
    });

    expect(opened.database.sqlite.prepare("SELECT id FROM audit_events WHERE id IN (?, ?)").all(policyAuditId, restoreAuditId)).toHaveLength(2);
    expect(opened.database.sqlite.prepare("SELECT id FROM event_outbox WHERE id IN (?, ?)").all(policyOutboxId, restoreOutboxId)).toHaveLength(2);
    opened.database.sqlite.prepare(
      "UPDATE organizations SET config_json = '{malformed' WHERE id = 'organization_legacy'",
    ).run();
    expect(opened.policies.read("local")).toMatchObject({
      source: "corrupt_fail_closed",
      policy: { agents: { enabled: false }, repositories: { enabled: false } },
    });
  });

  it("rolls back candidates, evidence, permits, and preview state on any delete failure", () => {
    const opened = setup();
    const auditId = insertAudit(opened.database, "organization_legacy", oldAt, "rollback.old");
    const outboxId = insertOutbox(opened.database, "organization_legacy", oldAt);
    const preview = opened.policies.previewAuditRetention("local");
    opened.database.sqlite.exec(`
      CREATE TRIGGER audit_retention_injected_failure
      BEFORE DELETE ON audit_events
      WHEN OLD.id = ${auditId}
      BEGIN SELECT RAISE(ABORT, 'injected audit retention failure'); END;
    `);

    expect(() => opened.policies.executeAuditRetention("local", preview.previewId, {
      expectedPlanHash: preview.planHash,
      idempotencyKey: "audit-retention-rollback-0001",
    })).toThrow(/injected audit retention failure/);
    expect(opened.database.sqlite.prepare("SELECT id FROM audit_events WHERE id = ?").get(auditId)).toEqual({ id: auditId });
    expect(opened.database.sqlite.prepare("SELECT id FROM event_outbox WHERE id = ?").get(outboxId)).toEqual({ id: outboxId });
    expect(opened.database.sqlite.prepare("SELECT COUNT(*) AS count FROM audit_retention_runs").get()).toEqual({ count: 0 });
    expect(opened.database.sqlite.prepare("SELECT COUNT(*) AS count FROM audit_retention_delete_permits").get()).toEqual({ count: 0 });
    expect(opened.database.sqlite.prepare("SELECT status FROM audit_retention_previews WHERE id = ?").get(preview.previewId)).toEqual({ status: "ready" });
    expect(opened.database.sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action = 'audit_retention.commit'").get()).toEqual({ count: 0 });
    expect(opened.database.sqlite.prepare("SELECT COUNT(*) AS count FROM event_outbox WHERE event_type = 'audit.retention'").get()).toEqual({ count: 0 });
  });

  it("bounds every persisted field before materializing canonical retention evidence", () => {
    const opened = setup();
    opened.database.sqlite.prepare(
      `INSERT INTO audit_events
       (organization_id, actor_id, action, target_type, target_id, details_json, created_at)
       VALUES ('organization_legacy', ?, 'oversized.actor', 'test', NULL, '{}', ?)`,
    ).run("x".repeat(1_400_000), oldAt);

    expect(captureThrown(() => opened.policies.previewAuditRetention("local"))).toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
      statusCode: 413,
    });
  });

  it("requires an organization administrator", () => {
    const opened = setup();
    expect(captureThrown(() => opened.policies.listAuditRetentionRuns("local", 0))).toMatchObject({
      code: "VALIDATION_FAILED",
      statusCode: 422,
    });
    expect(captureThrown(() => opened.policies.previewAuditRetention("ordinary-user"))).toMatchObject({
      code: "FORBIDDEN",
      statusCode: 403,
    });
    expect(captureThrown(() => opened.policies.listAuditRetentionRuns("ordinary-user"))).toMatchObject({
      code: "FORBIDDEN",
      statusCode: 403,
    });
  });
});
