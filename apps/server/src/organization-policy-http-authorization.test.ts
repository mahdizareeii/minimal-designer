import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { loadConfig } from "./config.js";
import type { AuditRetentionPreview, AuditRetentionRun } from "./organization-policy-service.js";

const PROXY_SECRET = "organization-policy-proxy-secret-0123456789abcdef";
const ADMIN_IDENTITY = "organization-policy-admin@example.test";
const VIEWER_IDENTITY = "organization-policy-viewer@example.test";
const PRIVATE_MARKER = "ORGANIZATION_POLICY_PRIVATE_7e914c";

const applications: DesignerApplication[] = [];
const temporaryDirectories: string[] = [];

interface Fixture {
  application: DesignerApplication;
  projectScopedGrantToken: string;
}

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.promises.rm(directory, { recursive: true, force: true })));
});

async function serverApplication(label: string): Promise<DesignerApplication> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `formaspec-organization-policy-auth-${label}-`));
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
    DESIGNER_TOKEN: "organization-policy-bootstrap-token-0001",
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
    name: `Organization policy authorization ${label}`,
    preset: "phone",
    idempotencyKey: `organization-policy-authorization-${label}-0001`,
  });
  const challenge = application.enterprise.createAgentConnection("local", {
    adapter: "codex",
    displayName: `Project-scoped organization policy agent ${label}`,
    scopes: ["design:read"],
    projectIds: [design.document.id],
    expiresInSeconds: 3_600,
  });
  return {
    application,
    projectScopedGrantToken: application.enterprise.pairAgentConnection(challenge.nonce).grant.token,
  };
}

function organizationAdministrationState(application: DesignerApplication): unknown {
  return {
    organizations: application.database.sqlite.prepare(
      "SELECT id, config_json, updated_at FROM organizations ORDER BY id",
    ).all(),
    previews: application.database.sqlite.prepare(
      "SELECT id, organization_id, actor_id, plan_hash, status FROM audit_retention_previews ORDER BY id",
    ).all(),
    runs: application.database.sqlite.prepare(
      "SELECT id, organization_id, preview_id, actor_id, plan_hash FROM audit_retention_runs ORDER BY id",
    ).all(),
    audits: application.database.sqlite.prepare(
      `SELECT organization_id, actor_id, action, target_type, target_id, details_json
       FROM audit_events
       WHERE action IN ('organization_policy.update', 'audit_retention.commit')
       ORDER BY id`,
    ).all(),
    outbox: application.database.sqlite.prepare(
      `SELECT organization_id, actor_id, event_type, payload_json
       FROM event_outbox
       WHERE event_type IN ('organization_policy.changed', 'audit.retention')
       ORDER BY id`,
    ).all(),
  };
}

function expectError(
  response: { statusCode: number; body: string; json<T>(): T },
  statusCode: number,
  code: string,
): void {
  expect(response.statusCode, response.body).toBe(statusCode);
  expect(response.json<{ error: { code: string } }>().error.code, response.body).toBe(code);
  expect(response.body).not.toContain(PRIVATE_MARKER);
}

describe("organization policy HTTP authorization", () => {
  it("authorizes before validation on exactly four organization-administration routes", async () => {
    const { application, projectScopedGrantToken } = await createFixture("ordering");
    const before = organizationAdministrationState(application);
    const requests = [
      {
        method: "PUT",
        url: "/api/organization/policy",
        payload: { privateMarker: PRIVATE_MARKER },
      },
      {
        method: "POST",
        url: "/api/organization/audit-retention/previews",
        payload: { privateMarker: PRIVATE_MARKER },
      },
      {
        method: "POST",
        url: "/api/organization/audit-retention/previews/%20/commit",
        payload: { expectedPlanHash: PRIVATE_MARKER, idempotencyKey: PRIVATE_MARKER },
      },
      {
        method: "GET",
        url: `/api/organization/audit-retention/runs?limit=${PRIVATE_MARKER}`,
      },
    ] as const;

    for (const request of requests) {
      const roleDenied = await application.app.inject({
        ...request,
        headers: serverHeaders(VIEWER_IDENTITY),
      });
      expectError(roleDenied, 403, "FORBIDDEN");
      const grantDenied = await application.app.inject({
        ...request,
        headers: grantHeaders(projectScopedGrantToken),
      });
      expectError(grantDenied, 401, "AUTH_REQUIRED");
    }
    expect(organizationAdministrationState(application)).toEqual(before);
  });

  it("preserves legitimate administrator behavior on all four routes", async () => {
    const { application } = await createFixture("allowed");
    const actorId = `trusted:${ADMIN_IDENTITY}`;
    const current = application.policies.read(actorId);
    const policy = structuredClone(current.policy);
    policy.audit.retentionDays = 366;

    const updated = await application.app.inject({
      method: "PUT",
      url: "/api/organization/policy",
      headers: serverHeaders(),
      payload: { expectedConfigurationHash: current.configurationHash, policy },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json<{ organizationPolicy: { policy: { audit: { retentionDays: number } } } }>()
      .organizationPolicy.policy.audit.retentionDays).toBe(366);

    const previewResponse = await application.app.inject({
      method: "POST",
      url: "/api/organization/audit-retention/previews",
      headers: serverHeaders(),
      payload: {},
    });
    expect(previewResponse.statusCode, previewResponse.body).toBe(201);
    const preview = previewResponse.json<{ preview: AuditRetentionPreview }>().preview;
    expect(preview.retentionDays).toBe(366);

    const committed = await application.app.inject({
      method: "POST",
      url: `/api/organization/audit-retention/previews/${preview.previewId}/commit`,
      headers: serverHeaders(),
      payload: {
        expectedPlanHash: preview.planHash,
        idempotencyKey: "organization-policy-http-authorization-0001",
      },
    });
    expect(committed.statusCode, committed.body).toBe(200);
    const result = committed.json<{ result: AuditRetentionRun }>().result;
    expect(result.previewId).toBe(preview.previewId);

    const runs = await application.app.inject({
      method: "GET",
      url: "/api/organization/audit-retention/runs?limit=1",
      headers: serverHeaders(),
    });
    expect(runs.statusCode, runs.body).toBe(200);
    expect(runs.json<{ runs: AuditRetentionRun[] }>().runs).toEqual([result]);
  });

  it("rejects duplicate effective trusted identities before any policy mutation", async () => {
    const { application } = await createFixture("duplicate-identity");
    const actorId = `trusted:${ADMIN_IDENTITY}`;
    const current = application.policies.read(actorId);
    const policy = structuredClone(current.policy);
    policy.identity.roleMappings.push({
      claim: "trusted_user",
      value: ` ${ADMIN_IDENTITY} `,
      role: "viewer",
    });
    const before = organizationAdministrationState(application);

    const response = await application.app.inject({
      method: "PUT",
      url: "/api/organization/policy",
      headers: serverHeaders(),
      payload: { expectedConfigurationHash: current.configurationHash, policy },
    });

    expectError(response, 422, "VALIDATION_FAILED");
    expect(response.json<{
      error: { details: { issues: Array<{ path: string; message: string }> } };
    }>().error.details.issues).toContainEqual({
      path: "identity.roleMappings.2.value",
      message: "Trusted identity mapping values must be unique across all claim aliases.",
      code: "custom",
    });
    expect(organizationAdministrationState(application)).toEqual(before);
  });
});
