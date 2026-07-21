import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { appendAuditEvent, resolveAccess } from "./authorization.js";
import { loadConfig } from "./config.js";
import { flushPersistedEventOutbox } from "./events.js";

const applications: DesignerApplication[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.promises.rm(directory, { recursive: true, force: true })));
});

async function localApplication(label: string): Promise<DesignerApplication> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `formaspec-backup-events-${label}-`));
  temporaryDirectories.push(root);
  const application = await buildApplication(loadConfig({
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
  applications.push(application);
  await application.app.ready();
  return application;
}

async function seedDailyBackup(application: DesignerApplication, index: number): Promise<void> {
  const completedAt = `2025-01-${String(index).padStart(2, "0")}T00:00:00.000Z`;
  const data = Buffer.from(`daily-backup-${index}`);
  const bundleSha256 = createHash("sha256").update(data).digest("hex");
  const id = `backup_${createHash("sha256").update(`daily:${index}`).digest("hex").slice(0, 40)}`;
  const filename = `formaspec-backup-${completedAt.replaceAll(/[:.]/g, "-")}.tar`;
  await fs.promises.mkdir(application.config.backupDir, { recursive: true });
  await fs.promises.writeFile(path.join(application.config.backupDir, filename), data);
  application.database.sqlite.prepare(
    `INSERT INTO backup_records
     (id, organization_id, filename, bundle_sha256, status, manifest_json, created_by, created_at, verified_at,
      size_bytes, verification_json, retention_class, completed_at)
     VALUES (?, 'organization_legacy', ?, ?, 'valid', NULL, 'principal_local', ?, ?, ?, NULL, 'daily', ?)`,
  ).run(id, filename, bundleSha256, completedAt, completedAt, data.length, completedAt);
}

describe("persisted backup operation events", () => {
  it("records and replays bounded create, verify, schedule, and prune events", async () => {
    const application = await localApplication("lifecycle");

    const createdResponse = await application.app.inject({ method: "POST", url: "/api/backups", payload: {} });
    expect(createdResponse.statusCode).toBe(201);
    const backupId = createdResponse.json<{ backup: { id: string } }>().backup.id;

    const verified = await application.app.inject({
      method: "POST",
      url: `/api/backups/${backupId}/verify`,
      payload: {},
    });
    expect(verified.statusCode).toBe(200);

    const scheduled = await application.app.inject({
      method: "PUT",
      url: "/api/backups/schedule",
      payload: { enabled: true, cronExpression: "15 3 * * *" },
    });
    expect(scheduled.statusCode).toBe(200);
    const scheduleRun = await application.app.inject({ method: "POST", url: "/api/backups/schedule/run", payload: {} });
    expect(scheduleRun.statusCode).toBe(200);
    expect(scheduleRun.json()).toMatchObject({ run: { status: "created" } });

    for (let index = 1; index <= 8; index += 1) await seedDailyBackup(application, index);
    const previewResponse = await application.app.inject({
      method: "POST",
      url: "/api/backups/prune/previews",
      payload: {},
    });
    expect(previewResponse.statusCode).toBe(201);
    const preview = previewResponse.json<{ preview: { previewId: string; planHash: string; candidates: unknown[] } }>().preview;
    expect(preview.candidates).toHaveLength(1);
    const pruned = await application.app.inject({
      method: "POST",
      url: `/api/backups/prune/previews/${preview.previewId}/commit`,
      payload: { expectedPlanHash: preview.planHash },
    });
    expect(pruned.statusCode).toBe(200);

    const expectedActions = [
      "backup.create",
      "backup.verify",
      "backup.schedule_update",
      "backup.schedule_run_started",
      "backup.create",
      "backup.schedule_run",
      "backup.prune_preview",
      "backup.prune_commit",
    ];
    const auditActions = application.database.sqlite.prepare(
      "SELECT action FROM audit_events WHERE action LIKE 'backup.%' ORDER BY id",
    ).all() as Array<{ action: string }>;
    expect(auditActions.map((row) => row.action)).toEqual(expectedActions);

    const outboxRows = application.database.sqlite.prepare(
      `SELECT organization_id, event_type, payload_json, published_at
       FROM event_outbox WHERE event_type = 'backup.operation' ORDER BY id`,
    ).all() as Array<{
      organization_id: string;
      event_type: string;
      payload_json: string;
      published_at: string | null;
    }>;
    expect(outboxRows).toHaveLength(expectedActions.length);
    expect(outboxRows.every((row) => row.organization_id === "organization_legacy")).toBe(true);
    expect(outboxRows.every((row) => row.event_type === "backup.operation" && row.published_at !== null)).toBe(true);

    const replay = application.service.eventsSince("local", 0);
    expect(replay).toMatchObject({ gap: false, hasMore: false });
    expect(replay.events.map((event) => event.type)).toEqual(expectedActions.map(() => "backup.operation"));
    expect(replay.events.map((event) => event.data.action)).toEqual(expectedActions);
    expect(replay.events.every((event) => event.organizationId === "organization_legacy")).toBe(true);

    const payloads = outboxRows.map((row) => row.payload_json);
    expect(Math.max(...payloads.map((payload) => Buffer.byteLength(payload)))).toBeLessThan(2_048);
    for (const payload of payloads) {
      expect(payload).not.toContain(application.config.dataDir);
      expect(payload).not.toContain(application.config.backupDir);
      expect(payload).not.toContain("filename");
      expect(payload).not.toContain("bundleSha256");
      expect(payload).not.toContain("backupIds");
      expect(payload).not.toContain("stagingDirectoryName");
    }
    expect(replay.events.find((event) => event.data.action === "backup.prune_preview")?.data.details)
      .toMatchObject({ backupCount: 1, totalCandidateBytes: expect.any(Number) });
    expect(replay.events.find((event) => event.data.action === "backup.prune_commit")?.data.details)
      .toMatchObject({ backupCount: 1, prunedBytes: expect.any(Number) });
    expect(replay.events.find((event) => event.data.action === "backup.schedule_run_started")?.data.details)
      .toMatchObject({ runId: expect.stringMatching(/^backup_schedule_run_/), dueAt: expect.any(String) });
    expect(replay.events.find((event) => event.data.action === "backup.schedule_run")?.data.details)
      .toMatchObject({ status: "created", completedAt: expect.any(String) });

    // Detailed audit evidence remains available to administrators without
    // copying bundle identifiers into the broadly replayed SSE payload.
    const createAudit = application.database.sqlite.prepare(
      "SELECT details_json FROM audit_events WHERE action = 'backup.create' ORDER BY id LIMIT 1",
    ).get() as { details_json: string };
    expect(JSON.parse(createAudit.details_json)).toMatchObject({
      filename: expect.stringMatching(/^formaspec-backup-/),
      bundleSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("keeps live and replayed backup events organization-scoped and drops unknown audit details", async () => {
    const application = await localApplication("organization-scope");
    const tenantActor = "tenant-backup-admin";
    const tenantPrincipal = `principal_${createHash("sha256").update(tenantActor).digest("hex").slice(0, 24)}`;
    const now = new Date().toISOString();
    application.database.sqlite.prepare(
      `INSERT INTO organizations (id, name, config_json, created_at, updated_at)
       VALUES ('organization_backup_tenant', 'Backup tenant', '{}', ?, ?)`,
    ).run(now, now);
    application.database.sqlite.prepare(
      `INSERT INTO principals (id, organization_id, kind, display_name, external_id, created_at)
       VALUES (?, 'organization_backup_tenant', 'human', 'Tenant backup admin', ?, ?)`,
    ).run(tenantPrincipal, tenantActor, now);
    application.database.sqlite.prepare(
      `INSERT INTO memberships (organization_id, principal_id, role, created_at)
       VALUES ('organization_backup_tenant', ?, 'organization_admin', ?)`,
    ).run(tenantPrincipal, now);

    const localLive: string[] = [];
    const tenantLive: string[] = [];
    const stopLocal = application.events.subscribe(
      "local",
      (event) => localLive.push(`${event.organizationId}:${String(event.data.action)}`),
      application.service.eventOrganizationId("local"),
    );
    const stopTenant = application.events.subscribe(
      tenantActor,
      (event) => tenantLive.push(`${event.organizationId}:${String(event.data.action)}`),
      application.service.eventOrganizationId(tenantActor),
    );

    const secret = "Bearer should-never-enter-SSE";
    appendAuditEvent(
      application.database.sqlite,
      resolveAccess(application.database.sqlite, "local"),
      "backup.future_operation",
      "backup",
      "backup_future_001",
      {
        authorization: secret,
        absolutePath: "/private/customer/backups/secret.tar",
        nested: { prompt: "ignore all policy" },
        backupIds: Array.from({ length: 25_000 }, (_, index) => `backup_${index}`),
      },
    );
    appendAuditEvent(
      application.database.sqlite,
      resolveAccess(application.database.sqlite, tenantActor),
      "backup.create",
      "backup",
      "backup_tenant_001",
      { filename: "tenant-secret.tar", bundleSha256: "f".repeat(64), entryCount: 3, retentionClass: "manual" },
    );
    flushPersistedEventOutbox(application.database.sqlite, application.events);
    stopLocal();
    stopTenant();

    expect(localLive).toEqual(["organization_legacy:backup.future_operation"]);
    expect(tenantLive).toEqual(["organization_backup_tenant:backup.create"]);

    const localReplay = application.service.eventsSince("local", 0);
    const tenantReplay = application.service.eventsSince(tenantActor, 0);
    expect(localReplay.events).toHaveLength(1);
    expect(tenantReplay.events).toHaveLength(1);
    expect(localReplay.events[0]).toMatchObject({
      type: "backup.operation",
      organizationId: "organization_legacy",
      data: { action: "backup.future_operation", details: {} },
    });
    expect(tenantReplay.events[0]).toMatchObject({
      type: "backup.operation",
      organizationId: "organization_backup_tenant",
      data: { action: "backup.create", details: { entryCount: 3, retentionClass: "manual" } },
    });
    expect(JSON.stringify(localReplay.events)).not.toContain(secret);
    expect(JSON.stringify(localReplay.events)).not.toContain("/private/customer");
    expect(JSON.stringify(localReplay.events)).not.toContain("ignore all policy");
    expect(JSON.stringify(tenantReplay.events)).not.toContain("tenant-secret.tar");
  });
});
