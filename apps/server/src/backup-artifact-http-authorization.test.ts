import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { loadConfig } from "./config.js";
import type { BackupPrunePreview, PublicBackupRecord } from "./operations-service.js";

const PROXY_SECRET = "backup-artifact-proxy-secret-0123456789abcdef";
const ADMIN_IDENTITY = "backup-artifact-admin@example.test";
const VIEWER_IDENTITY = "backup-artifact-viewer@example.test";
const PRIVATE_TOKEN = "BACKUP_ARTIFACT_SECRET_67d19e";

const applications: DesignerApplication[] = [];
const temporaryDirectories: string[] = [];

interface ForeignFixture {
  organizationId: string;
  backupId: string;
  previewId: string;
  planHash: string;
  markers: string[];
}

interface Fixture {
  application: DesignerApplication;
  localBackup: PublicBackupRecord;
  projectScopedGrantActorId: string;
  projectScopedGrantToken: string;
  foreign: ForeignFixture;
}

interface BackupState {
  backups: unknown[];
  locks: unknown[];
  audits: unknown[];
}

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.promises.rm(directory, { recursive: true, force: true })));
});

function digest(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

async function temporaryRoot(label: string): Promise<string> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `formaspec-backup-auth-${label}-`));
  temporaryDirectories.push(root);
  return root;
}

async function serverApplication(label: string): Promise<DesignerApplication> {
  const root = await temporaryRoot(label);
  const application = await buildApplication(loadConfig({
    APP_MODE: "server",
    HOST: "0.0.0.0",
    PORT: "4310",
    DATA_DIR: path.join(root, "data"),
    BACKUP_DIR: path.join(root, "backups"),
    DESIGNER_DATABASE_PATH: ":memory:",
    PUBLIC_BASE_URL: "https://design.example.test",
    AUTH_MODE: "trusted-header",
    DESIGNER_TOKEN: "backup-artifact-bootstrap-token-0001",
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

function installForeignFixture(application: DesignerApplication, label: string): ForeignFixture {
  const organizationId = `organization_backup_foreign_${digest(label, 12)}`;
  const backupId = `backup_${digest(`backup:${label}`, 40)}`;
  const previewId = `backup_prune_preview_${digest(`preview:${label}`, 32)}`;
  const planHash = digest(`plan:${label}`, 64);
  const filenameMarker = `FOREIGN_BACKUP_${PRIVATE_TOKEN}_${digest(label, 8)}.tar`;
  const holderMarker = `foreign-backup-holder-${PRIVATE_TOKEN}-${digest(label, 8)}`;
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 3_600_000).toISOString();

  application.database.sqlite.prepare(
    "INSERT INTO organizations (id, name, config_json, created_at, updated_at) VALUES (?, ?, '{}', ?, ?)",
  ).run(organizationId, `Foreign backup organization ${PRIVATE_TOKEN}`, createdAt, createdAt);
  application.database.sqlite.prepare(
    `INSERT INTO backup_records
     (id, organization_id, filename, bundle_sha256, status, manifest_json, created_by, created_at,
      verified_at, size_bytes, verification_json, retention_class, completed_at)
     VALUES (?, ?, ?, ?, 'valid', ?, ?, ?, ?, 123, '{}', 'manual', ?)`,
  ).run(
    backupId,
    organizationId,
    filenameMarker,
    digest(`bundle:${label}`, 64),
    JSON.stringify({
      format: "formaspec-backup",
      formatVersion: 2,
      createdAt,
      files: [],
      privateMarker: PRIVATE_TOKEN,
    }),
    holderMarker,
    createdAt,
    createdAt,
    createdAt,
  );
  application.database.sqlite.prepare(
    `INSERT INTO operational_locks
     (name, organization_id, holder_id, purpose, metadata_json, acquired_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `backup-prune-preview:${previewId}`,
    organizationId,
    holderMarker,
    `Foreign prune preview ${PRIVATE_TOKEN}`,
    JSON.stringify({
      format: "formaspec-backup-prune-preview",
      formatVersion: 1,
      planHash,
      backupIds: [backupId],
      generatedAt: createdAt,
      expiresAt,
      privateMarker: PRIVATE_TOKEN,
    }),
    createdAt,
    expiresAt,
  );
  return {
    organizationId,
    backupId,
    previewId,
    planHash,
    markers: [organizationId, backupId, previewId, filenameMarker, holderMarker, PRIVATE_TOKEN],
  };
}

async function createFixture(label: string): Promise<Fixture> {
  const application = await serverApplication(label);
  await warmIdentity(application, ADMIN_IDENTITY);
  const current = application.policies.read(`trusted:${ADMIN_IDENTITY}`);
  const policy = structuredClone(current.policy);
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
    name: `Backup authorization project ${label}`,
    preset: "phone",
    idempotencyKey: `backup-authorization-project-${label}-0001`,
  });
  const challenge = application.enterprise.createAgentConnection("local", {
    adapter: "codex",
    displayName: `Project-scoped backup agent ${label}`,
    scopes: ["design:read"],
    projectIds: [design.document.id],
    expiresInSeconds: 3_600,
  });
  const paired = application.enterprise.pairAgentConnection(challenge.nonce);
  const localBackup = await application.operations.createBackup("local");
  return {
    application,
    localBackup,
    projectScopedGrantActorId: paired.grant.actorId,
    projectScopedGrantToken: paired.grant.token,
    foreign: installForeignFixture(application, label),
  };
}

function backupState(application: DesignerApplication): BackupState {
  return {
    backups: application.database.sqlite.prepare(
      `SELECT id, organization_id, filename, bundle_sha256, status, manifest_json, created_by,
              verified_at, size_bytes, verification_json, retention_class, completed_at
       FROM backup_records ORDER BY organization_id, id`,
    ).all(),
    locks: application.database.sqlite.prepare(
      `SELECT name, organization_id, holder_id, purpose, metadata_json, acquired_at, expires_at
       FROM operational_locks ORDER BY organization_id, name`,
    ).all(),
    audits: application.database.sqlite.prepare(
      `SELECT organization_id, actor_id, action, target_type, target_id, details_json
       FROM audit_events WHERE target_type IN ('backup', 'backup_prune_preview', 'operational_lock')
       ORDER BY id`,
    ).all(),
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

describe("backup artifact HTTP authorization", () => {
  it("authorizes before validation on the four artifact-control routes without mutating backup state", async () => {
    const fixture = await createFixture("ordering");
    const { application, foreign } = fixture;
    const hidden = [...foreign.markers, fixture.projectScopedGrantToken];
    const before = backupState(application);
    const requests = [
      { method: "POST", url: "/api/backups/prune/previews", payload: { secret: PRIVATE_TOKEN } },
      {
        method: "POST",
        url: "/api/backups/prune/previews/%20/commit",
        payload: { expectedPlanHash: PRIVATE_TOKEN },
      },
      { method: "POST", url: "/api/backups/%20/verify", payload: { secret: PRIVATE_TOKEN } },
      { method: "GET", url: "/api/backups/%20/download" },
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
    expect(backupState(application)).toEqual(before);
  });

  it("keeps foreign backups and prune previews opaque while local admin behavior remains available", async () => {
    const fixture = await createFixture("opaque");
    const { application, foreign } = fixture;
    const { localBackup } = fixture;
    const hidden = [...foreign.markers, fixture.projectScopedGrantToken];
    const foreignBefore = backupState(application);

    const grantDenied = await Promise.all([
      application.app.inject({
        method: "POST",
        url: "/api/backups/prune/previews",
        headers: grantHeaders(fixture.projectScopedGrantToken),
        payload: {},
      }),
      application.app.inject({
        method: "POST",
        url: `/api/backups/prune/previews/${foreign.previewId}/commit`,
        headers: grantHeaders(fixture.projectScopedGrantToken),
        payload: { expectedPlanHash: foreign.planHash },
      }),
      application.app.inject({
        method: "POST",
        url: `/api/backups/${localBackup.id}/verify`,
        headers: grantHeaders(fixture.projectScopedGrantToken),
        payload: {},
      }),
      application.app.inject({
        method: "GET",
        url: `/api/backups/${localBackup.id}/download`,
        headers: grantHeaders(fixture.projectScopedGrantToken),
      }),
    ]);
    for (const response of grantDenied) expectError(response, 401, "AUTH_REQUIRED", hidden);

    const grantServiceCalls = [
      () => application.operations.previewBackupPrune(fixture.projectScopedGrantActorId),
      () => application.operations.executeBackupPrune(
        fixture.projectScopedGrantActorId,
        foreign.previewId,
        foreign.planHash,
      ),
      () => application.operations.verifyBackup(fixture.projectScopedGrantActorId, localBackup.id),
      () => application.operations.openBackupDownload(fixture.projectScopedGrantActorId, localBackup.id),
    ];
    for (const call of grantServiceCalls) {
      await expect(call()).rejects.toMatchObject({ statusCode: 403, code: "FORBIDDEN" });
    }

    const foreignResponses = await Promise.all([
      application.app.inject({
        method: "POST",
        url: `/api/backups/prune/previews/${foreign.previewId}/commit`,
        headers: serverHeaders(),
        payload: { expectedPlanHash: foreign.planHash },
      }),
      application.app.inject({
        method: "POST",
        url: `/api/backups/${foreign.backupId}/verify`,
        headers: serverHeaders(),
        payload: {},
      }),
      application.app.inject({
        method: "GET",
        url: `/api/backups/${foreign.backupId}/download`,
        headers: serverHeaders(),
      }),
    ]);
    for (const response of foreignResponses) expectError(response, 404, "NOT_FOUND", hidden);

    const previewResponse = await application.app.inject({
      method: "POST",
      url: "/api/backups/prune/previews",
      headers: serverHeaders(),
      payload: {},
    });
    expect(previewResponse.statusCode, previewResponse.body).toBe(201);
    const preview = previewResponse.json<{ preview: BackupPrunePreview }>().preview;
    const commitResponse = await application.app.inject({
      method: "POST",
      url: `/api/backups/prune/previews/${preview.previewId}/commit`,
      headers: serverHeaders(),
      payload: { expectedPlanHash: preview.planHash },
    });
    expect(commitResponse.statusCode, commitResponse.body).toBe(200);

    const verifyResponse = await application.app.inject({
      method: "POST",
      url: `/api/backups/${localBackup.id}/verify`,
      headers: serverHeaders(),
      payload: {},
    });
    expect(verifyResponse.statusCode, verifyResponse.body).toBe(200);
    expect(verifyResponse.json<{ backup: PublicBackupRecord }>().backup).toMatchObject({
      id: localBackup.id,
      status: "valid",
    });
    const downloadResponse = await application.app.inject({
      method: "GET",
      url: `/api/backups/${localBackup.id}/download`,
      headers: serverHeaders(),
    });
    expect(downloadResponse.statusCode, downloadResponse.body).toBe(200);
    expect(downloadResponse.headers["x-formaspec-backup-id"]).toBe(localBackup.id);
    expect(downloadResponse.headers["cache-control"]).toBe("private, no-store");

    const foreignAfter = backupState(application);
    expect(foreignAfter.backups.filter((row) => JSON.stringify(row).includes(foreign.organizationId)))
      .toEqual(foreignBefore.backups.filter((row) => JSON.stringify(row).includes(foreign.organizationId)));
    expect(foreignAfter.locks.filter((row) => JSON.stringify(row).includes(foreign.organizationId)))
      .toEqual(foreignBefore.locks.filter((row) => JSON.stringify(row).includes(foreign.organizationId)));
    for (const response of [previewResponse, commitResponse, verifyResponse, downloadResponse]) {
      for (const marker of foreign.markers) expect(response.body).not.toContain(marker);
    }
  });
});
