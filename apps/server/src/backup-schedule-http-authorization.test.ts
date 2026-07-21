import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { loadConfig } from "./config.js";
import type { PublicBackupRecord, PublicBackupSchedule, ScheduledBackupRunResult } from "./operations-service.js";

const PROXY_SECRET = "backup-schedule-proxy-secret-0123456789abcdef";
const ADMIN_IDENTITY = "backup-schedule-admin@example.test";
const VIEWER_IDENTITY = "backup-schedule-viewer@example.test";
const PRIVATE_MARKER = "FOREIGN_BACKUP_SCHEDULE_PRIVATE_4d81a9";

const applications: DesignerApplication[] = [];
const temporaryDirectories: string[] = [];

interface Fixture {
  application: DesignerApplication;
  projectScopedGrantActorId: string;
  projectScopedGrantToken: string;
}

interface ForeignFixture {
  organizationId: string;
  backupId: string;
  filename: string;
  cronExpression: string;
  markers: string[];
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(applications.splice(0).map((application) => application.app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.promises.rm(directory, { recursive: true, force: true })));
});

function digest(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

async function serverApplication(label: string): Promise<DesignerApplication> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `formaspec-backup-schedule-auth-${label}-`));
  temporaryDirectories.push(root);
  const application = await buildApplication(loadConfig({
    APP_MODE: "server",
    HOST: "0.0.0.0",
    PORT: "4310",
    DATA_DIR: path.join(root, "data"),
    BACKUP_DIR: path.join(root, "backups"),
    DESIGNER_DATABASE_PATH: ":memory:",
    PUBLIC_BASE_URL: "https://design.example.test",
    AUTH_MODE: "trusted-header",
    DESIGNER_TOKEN: "backup-schedule-bootstrap-token-0001",
    FORMASPEC_TRUSTED_PROXIES: "127.0.0.1",
    FORMASPEC_PROXY_SECRET: PROXY_SECRET,
    DESIGNER_CORS_ORIGINS: "https://design.example.test",
    DESIGNER_LOG_LEVEL: "silent",
  }));
  applications.push(application);
  await application.app.ready();
  return application;
}

function serverHeaders(identity = ADMIN_IDENTITY): Record<string, string> {
  return {
    host: "design.example.test",
    origin: "https://design.example.test",
    "x-formaspec-csrf": "1",
    "x-designer-user": identity,
    "x-formaspec-proxy-secret": PROXY_SECRET,
  };
}

function grantHeaders(token: string): Record<string, string> {
  return {
    host: "design.example.test",
    origin: "https://design.example.test",
    "x-formaspec-csrf": "1",
    authorization: `Bearer ${token}`,
    "x-formaspec-proxy-secret": PROXY_SECRET,
  };
}

async function warmIdentity(application: DesignerApplication, identity: string): Promise<void> {
  const response = await application.app.inject({
    method: "GET",
    url: "/api/designs",
    headers: serverHeaders(identity),
  });
  expect(response.statusCode, response.body).toBe(200);
}

async function createFixture(label: string): Promise<Fixture> {
  const application = await serverApplication(label);
  await warmIdentity(application, ADMIN_IDENTITY);
  const current = application.policies.read(`trusted:${ADMIN_IDENTITY}`);
  const policy = structuredClone(current.policy);
  policy.backups.scheduleUtc = "17 4 * * *";
  policy.backups.retention = { daily: 3, weekly: 2, monthly: 5 };
  policy.identity.roleMappings = [
    { claim: "identity", value: ADMIN_IDENTITY, role: "organization_admin" },
    { claim: "identity", value: VIEWER_IDENTITY, role: "viewer" },
  ];
  application.policies.update(`trusted:${ADMIN_IDENTITY}`, {
    expectedConfigurationHash: current.configurationHash,
    policy,
  });
  await warmIdentity(application, VIEWER_IDENTITY);

  const design = application.service.createDesign("local", {
    name: `Backup schedule authorization ${label}`,
    preset: "phone",
    idempotencyKey: `backup-schedule-authorization-${label}-0001`,
  });
  const challenge = application.enterprise.createAgentConnection("local", {
    adapter: "codex",
    displayName: `Project-scoped backup schedule agent ${label}`,
    scopes: ["design:read"],
    projectIds: [design.document.id],
    expiresInSeconds: 3_600,
  });
  const paired = application.enterprise.pairAgentConnection(challenge.nonce);
  return {
    application,
    projectScopedGrantActorId: paired.grant.actorId,
    projectScopedGrantToken: paired.grant.token,
  };
}

async function installForeignFixture(application: DesignerApplication, label: string): Promise<ForeignFixture> {
  const organizationId = `organization_backup_schedule_foreign_${digest(label, 12)}`;
  const backupId = `backup_${digest(`backup:${label}`, 40)}`;
  const filename = `foreign-${PRIVATE_MARKER}-${digest(label, 8)}.tar`;
  const cronExpression = "47 23 * * *";
  const createdAt = "2038-11-23T19:17:31.000Z";
  const bytes = Buffer.from(`${PRIVATE_MARKER}:${organizationId}:${backupId}`);
  const bundleSha256 = createHash("sha256").update(bytes).digest("hex");
  await fs.promises.mkdir(application.config.backupDir, { recursive: true });
  await fs.promises.writeFile(path.join(application.config.backupDir, filename), bytes, { mode: 0o600 });

  application.database.sqlite.prepare(
    "INSERT INTO organizations (id, name, config_json, created_at, updated_at) VALUES (?, ?, '{}', ?, ?)",
  ).run(organizationId, `Foreign ${PRIVATE_MARKER}`, createdAt, createdAt);
  application.database.sqlite.prepare(
    `INSERT INTO backup_records
     (id, organization_id, filename, bundle_sha256, status, manifest_json, created_by, created_at,
      verified_at, size_bytes, verification_json, retention_class, completed_at)
     VALUES (?, ?, ?, ?, 'valid', ?, ?, ?, ?, ?, '{}', 'daily', ?)`,
  ).run(
    backupId,
    organizationId,
    filename,
    bundleSha256,
    JSON.stringify({
      format: "formaspec-backup",
      formatVersion: 2,
      createdAt,
      files: [],
      privateMarker: PRIVATE_MARKER,
    }),
    `foreign-actor-${PRIVATE_MARKER}`,
    createdAt,
    createdAt,
    bytes.length,
    createdAt,
  );
  application.database.sqlite.prepare(
    `INSERT INTO backup_schedules
     (organization_id, enabled, cron_expression, daily_retention, weekly_retention, monthly_retention, updated_at)
     VALUES (?, 1, ?, 91, 52, 24, ?)`,
  ).run(organizationId, cronExpression, createdAt);

  return {
    organizationId,
    backupId,
    filename,
    cronExpression,
    markers: [organizationId, backupId, filename, PRIVATE_MARKER],
  };
}

async function filesystemState(root: string): Promise<Array<Record<string, string | number>>> {
  const records: Array<Record<string, string | number>> = [];
  const walk = async (directory: string, relativeDirectory: string): Promise<void> => {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        records.push({ path: relativePath, kind: "directory" });
        await walk(absolutePath, relativePath);
      } else if (entry.isSymbolicLink()) {
        records.push({ path: relativePath, kind: "symlink", target: await fs.promises.readlink(absolutePath) });
      } else {
        const data = await fs.promises.readFile(absolutePath);
        records.push({
          path: relativePath,
          kind: "file",
          size: data.length,
          sha256: createHash("sha256").update(data).digest("hex"),
        });
      }
    }
  };
  await walk(root, "");
  return records;
}

async function backupAdministrationState(application: DesignerApplication): Promise<unknown> {
  return {
    backups: application.database.sqlite.prepare(
      `SELECT id, organization_id, filename, bundle_sha256, status, manifest_json, created_by,
              verified_at, size_bytes, verification_json, retention_class, completed_at
       FROM backup_records ORDER BY organization_id, id`,
    ).all(),
    schedules: application.database.sqlite.prepare(
      `SELECT organization_id, enabled, cron_expression, daily_retention, weekly_retention,
              monthly_retention, updated_at
       FROM backup_schedules ORDER BY organization_id`,
    ).all(),
    locks: application.database.sqlite.prepare(
      `SELECT name, organization_id, holder_id, purpose, metadata_json, acquired_at, expires_at
       FROM operational_locks ORDER BY organization_id, name`,
    ).all(),
    audits: application.database.sqlite.prepare(
      `SELECT organization_id, actor_id, action, target_type, target_id, details_json
       FROM audit_events
       WHERE action LIKE 'backup.%' OR target_type = 'operational_lock'
       ORDER BY id`,
    ).all(),
    files: await filesystemState(application.config.backupDir),
  };
}

function foreignState(application: DesignerApplication, organizationId: string): unknown {
  return {
    backups: application.database.sqlite.prepare(
      "SELECT * FROM backup_records WHERE organization_id = ? ORDER BY id",
    ).all(organizationId),
    schedules: application.database.sqlite.prepare(
      "SELECT * FROM backup_schedules WHERE organization_id = ? ORDER BY organization_id",
    ).all(organizationId),
  };
}

function expectError(
  response: { statusCode: number; body: string; json<T>(): T },
  statusCode: number,
  code: string,
  hidden: string[],
): void {
  expect(response.statusCode, response.body).toBe(statusCode);
  expect(response.json<{ error: { code: string } }>().error.code, response.body).toBe(code);
  for (const marker of hidden) expect(response.body).not.toContain(marker);
}

function asPromise<T>(callback: () => T | Promise<T>): Promise<T> {
  return Promise.resolve().then(callback);
}

describe("backup and schedule HTTP authorization", () => {
  it("authorizes before schema parsing and side effects on exactly five backup-administration routes", async () => {
    const fixture = await createFixture("ordering");
    const { application } = fixture;
    const foreign = await installForeignFixture(application, "ordering");
    const hidden = [...foreign.markers, fixture.projectScopedGrantToken];
    const before = await backupAdministrationState(application);
    const preflight = vi.spyOn(application.operations, "assertBackupAdministrationAllowed");
    const listBackups = vi.spyOn(application.operations, "listBackups");
    const createBackup = vi.spyOn(application.operations, "createBackup");
    const getBackupSchedule = vi.spyOn(application.operations, "getBackupSchedule");
    const updateBackupSchedule = vi.spyOn(application.operations, "updateBackupSchedule");
    const runScheduledBackup = vi.spyOn(application.operations, "runScheduledBackup");
    const requests = [
      { method: "GET", url: `/api/backups?organizationId=${encodeURIComponent(foreign.organizationId)}` },
      { method: "POST", url: "/api/backups", payload: { privateMarker: PRIVATE_MARKER } },
      { method: "GET", url: `/api/backups/schedule?organizationId=${encodeURIComponent(foreign.organizationId)}` },
      {
        method: "PUT",
        url: "/api/backups/schedule",
        payload: { enabled: PRIVATE_MARKER, cronExpression: PRIVATE_MARKER },
      },
      { method: "POST", url: "/api/backups/schedule/run", payload: { privateMarker: PRIVATE_MARKER } },
    ] as const;

    for (const request of requests) {
      const roleDenied = await application.app.inject({ ...request, headers: serverHeaders(VIEWER_IDENTITY) });
      expectError(roleDenied, 403, "FORBIDDEN", hidden);
      const grantDenied = await application.app.inject({
        ...request,
        headers: grantHeaders(fixture.projectScopedGrantToken),
      });
      expectError(grantDenied, 401, "AUTH_REQUIRED", hidden);
    }

    expect(preflight).toHaveBeenCalledTimes(5);
    expect(listBackups).not.toHaveBeenCalled();
    expect(createBackup).not.toHaveBeenCalled();
    expect(getBackupSchedule).not.toHaveBeenCalled();
    expect(updateBackupSchedule).not.toHaveBeenCalled();
    expect(runScheduledBackup).not.toHaveBeenCalled();
    expect(await backupAdministrationState(application)).toEqual(before);

    vi.restoreAllMocks();
    const serviceCalls = [
      () => application.operations.listBackups(fixture.projectScopedGrantActorId),
      () => application.operations.createBackup(fixture.projectScopedGrantActorId),
      () => application.operations.getBackupSchedule(fixture.projectScopedGrantActorId),
      () => application.operations.updateBackupSchedule(fixture.projectScopedGrantActorId, {
        enabled: true,
        cronExpression: PRIVATE_MARKER,
      }),
      () => application.operations.runScheduledBackup(fixture.projectScopedGrantActorId),
    ];
    for (const call of serviceCalls) {
      await expect(asPromise(call)).rejects.toMatchObject({ statusCode: 403, code: "FORBIDDEN" });
    }
    expect(await backupAdministrationState(application)).toEqual(before);
  });

  it("keeps foreign organization state opaque while preserving administrator and policy behavior", async () => {
    const { application } = await createFixture("allowed");
    const adminActorId = `trusted:${ADMIN_IDENTITY}`;

    const initialScheduleResponse = await application.app.inject({
      method: "GET",
      url: "/api/backups/schedule",
      headers: serverHeaders(),
    });
    expect(initialScheduleResponse.statusCode, initialScheduleResponse.body).toBe(200);
    const initialSchedule = initialScheduleResponse.json<{ schedule: PublicBackupSchedule }>().schedule;
    expect(initialSchedule).toMatchObject({
      enabled: true,
      cronExpression: "17 4 * * *",
      timezone: "UTC",
      retention: { daily: 3, weekly: 2, monthly: 5 },
    });
    expect(initialSchedule.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(initialSchedule.nextDueAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const createdResponse = await application.app.inject({
      method: "POST",
      url: "/api/backups",
      headers: serverHeaders(),
      payload: {},
    });
    expect(createdResponse.statusCode, createdResponse.body).toBe(201);
    const manualBackup = createdResponse.json<{ backup: PublicBackupRecord }>().backup;
    expect(manualBackup).toMatchObject({ status: "valid", retentionClass: "manual" });

    const configuredResponse = await application.app.inject({
      method: "PUT",
      url: "/api/backups/schedule",
      headers: serverHeaders(),
      payload: { enabled: true, cronExpression: "15 3 * * *" },
    });
    expect(configuredResponse.statusCode, configuredResponse.body).toBe(200);
    expect(configuredResponse.json<{ schedule: PublicBackupSchedule }>().schedule).toMatchObject({
      enabled: true,
      cronExpression: "15 3 * * *",
      retention: { daily: 3, weekly: 2, monthly: 5 },
    });

    const runResponse = await application.app.inject({
      method: "POST",
      url: "/api/backups/schedule/run",
      headers: serverHeaders(),
      payload: {},
    });
    expect(runResponse.statusCode, runResponse.body).toBe(200);
    const run = runResponse.json<{ run: ScheduledBackupRunResult }>().run;
    expect(run.status).toBe("created");
    expect(run.backup).toMatchObject({ status: "valid" });
    expect(run.backup?.id).not.toBe(manualBackup.id);

    const foreign = await installForeignFixture(application, "allowed");
    const foreignBefore = foreignState(application, foreign.organizationId);
    const listedResponse = await application.app.inject({
      method: "GET",
      url: "/api/backups",
      headers: serverHeaders(),
    });
    expect(listedResponse.statusCode, listedResponse.body).toBe(200);
    const listedIds = listedResponse.json<{ backups: PublicBackupRecord[] }>().backups.map((backup) => backup.id);
    expect(listedIds).toEqual(expect.arrayContaining([manualBackup.id, run.backup!.id]));
    expect(listedIds).not.toContain(foreign.backupId);

    const scheduleResponse = await application.app.inject({
      method: "GET",
      url: "/api/backups/schedule",
      headers: serverHeaders(),
    });
    expect(scheduleResponse.statusCode, scheduleResponse.body).toBe(200);
    expect(scheduleResponse.json<{ schedule: PublicBackupSchedule }>().schedule).toMatchObject({
      enabled: true,
      cronExpression: "15 3 * * *",
      retention: { daily: 3, weekly: 2, monthly: 5 },
    });
    for (const response of [createdResponse, configuredResponse, runResponse, listedResponse, scheduleResponse]) {
      for (const marker of foreign.markers) expect(response.body).not.toContain(marker);
      expect(response.body).not.toContain(foreign.cronExpression);
    }

    const current = application.policies.read(adminActorId);
    const disabledPolicy = structuredClone(current.policy);
    disabledPolicy.backups.enabled = false;
    application.policies.update(adminActorId, {
      expectedConfigurationHash: current.configurationHash,
      policy: disabledPolicy,
    });
    const beforePolicyDenials = await backupAdministrationState(application);

    const blockedCreate = await application.app.inject({
      method: "POST",
      url: "/api/backups",
      headers: serverHeaders(),
      payload: {},
    });
    expectError(blockedCreate, 403, "FORBIDDEN", foreign.markers);
    const blockedEnable = await application.app.inject({
      method: "PUT",
      url: "/api/backups/schedule",
      headers: serverHeaders(),
      payload: { enabled: true, cronExpression: "45 5 * * *" },
    });
    expectError(blockedEnable, 403, "FORBIDDEN", foreign.markers);
    const disabledRun = await application.app.inject({
      method: "POST",
      url: "/api/backups/schedule/run",
      headers: serverHeaders(),
      payload: {},
    });
    expect(disabledRun.statusCode, disabledRun.body).toBe(200);
    expect(disabledRun.json<{ run: ScheduledBackupRunResult }>().run).toEqual({
      status: "disabled",
      dueAt: null,
      nextDueAt: null,
      retentionClass: null,
      backup: null,
    });
    const disabledSchedule = await application.app.inject({
      method: "GET",
      url: "/api/backups/schedule",
      headers: serverHeaders(),
    });
    expect(disabledSchedule.statusCode, disabledSchedule.body).toBe(200);
    expect(disabledSchedule.json<{ schedule: PublicBackupSchedule }>().schedule).toMatchObject({
      enabled: false,
      cronExpression: "17 4 * * *",
      retention: { daily: 3, weekly: 2, monthly: 5 },
      nextDueAt: null,
    });
    for (const response of [disabledRun, disabledSchedule]) {
      for (const marker of foreign.markers) expect(response.body).not.toContain(marker);
    }
    expect(await backupAdministrationState(application)).toEqual(beforePolicyDenials);
    expect(foreignState(application, foreign.organizationId)).toEqual(foreignBefore);
  });
});
