import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { loadConfig } from "./config.js";
import type { DomainError } from "./errors.js";
import {
  canonicalOrganizationPolicy,
  DEFAULT_ORGANIZATION_POLICY,
} from "./organization-policy-model.js";

const PROXY_SECRET = "organization-context-maintenance-proxy-secret-0123456789abcdef";
const PUBLIC_ORIGIN = "https://design.example.test";
const ADMIN_IDENTITY = "organization-boundary-admin@example.test";
const VIEWER_IDENTITY = "organization-boundary-viewer@example.test";
const PRIVATE_MARKER = "ORGANIZATION_CONTEXT_PRIVATE_9d4f21";
const PRIVATE_PATH = "/Users/private/company/formaspec/organization-policy.yaml";
const PRIVATE_TOKEN = "fsg_organization_context_private_token_7b29a1";

const applications: DesignerApplication[] = [];
const temporaryDirectories: string[] = [];

interface DesignFixture {
  id: string;
}

interface GrantFixture {
  actorId: string;
  token: string;
  connectionId: string;
  projectIds: string[];
  scopes: string[];
}

interface Fixture {
  application: DesignerApplication;
  allowed: DesignFixture;
  denied: DesignFixture;
  scopedAgent: GrantFixture;
  scopeDeniedAgent: GrantFixture;
  revokedAgent: GrantFixture;
  expiredAgent: GrantFixture;
  foreignAgent: GrantFixture;
  foreignDesign: DesignFixture;
  hidden: string[];
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(applications.splice(0).map((application) => application.app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.promises.rm(directory, { recursive: true, force: true })));
});

async function serverApplication(label: string): Promise<DesignerApplication> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `formaspec-org-context-maintenance-${label}-`));
  temporaryDirectories.push(root);
  const application = await buildApplication(loadConfig({
    APP_MODE: "server",
    HOST: "0.0.0.0",
    PORT: "4310",
    DATA_DIR: path.join(root, "data"),
    BACKUP_DIR: path.join(root, "backups"),
    DESIGNER_DATABASE_PATH: ":memory:",
    PUBLIC_BASE_URL: PUBLIC_ORIGIN,
    AUTH_MODE: "trusted-header",
    DESIGNER_TOKEN: "organization-context-maintenance-bootstrap-token-0001",
    FORMASPEC_TRUSTED_PROXIES: "127.0.0.1",
    FORMASPEC_PROXY_SECRET: PROXY_SECRET,
    DESIGNER_CORS_ORIGINS: PUBLIC_ORIGIN,
    DESIGNER_LOG_LEVEL: "silent",
  }));
  applications.push(application);
  await application.app.ready();
  return application;
}

function serverHeaders(identity = ADMIN_IDENTITY): Record<string, string> {
  return {
    host: "design.example.test",
    origin: PUBLIC_ORIGIN,
    "x-formaspec-csrf": "1",
    "x-designer-user": identity,
    "x-formaspec-proxy-secret": PROXY_SECRET,
  };
}

function unauthenticatedHeaders(): Record<string, string> {
  return {
    host: "design.example.test",
    origin: PUBLIC_ORIGIN,
    "x-formaspec-csrf": "1",
    "x-formaspec-proxy-secret": PROXY_SECRET,
  };
}

function grantHeaders(token: string): Record<string, string> {
  return {
    host: "design.example.test",
    origin: PUBLIC_ORIGIN,
    "x-formaspec-csrf": "1",
    authorization: `Bearer ${token}`,
    "x-formaspec-proxy-secret": PROXY_SECRET,
  };
}

async function warmIdentity(application: DesignerApplication, identity: string): Promise<void> {
  const response = await application.app.inject({
    method: "GET",
    url: "/api/designs",
    remoteAddress: "127.0.0.1",
    headers: serverHeaders(identity),
  });
  expect(response.statusCode, response.body).toBe(200);
}

function createDesign(application: DesignerApplication, actorId: string, label: string, name: string): DesignFixture {
  const created = application.service.createDesign(actorId, {
    name,
    preset: "web",
    idempotencyKey: `organization-context-design-${label}-0001`,
  });
  return { id: created.document.id };
}

function pairAgent(
  application: DesignerApplication,
  label: string,
  scopes: string[],
  projectIds: string[],
): GrantFixture {
  const challenge = application.enterprise.createAgentConnection("local", {
    adapter: "codex",
    displayName: `Organization context agent ${label}`,
    scopes,
    projectIds,
    expiresInSeconds: 3_600,
  });
  const paired = application.enterprise.pairAgentConnection(challenge.nonce);
  return {
    actorId: paired.grant.actorId,
    token: paired.grant.token,
    connectionId: challenge.connection.id,
    projectIds,
    scopes,
  };
}

function installForeignAgent(application: DesignerApplication, label: string): {
  agent: GrantFixture;
  design: DesignFixture;
} {
  const organizationId = `organization_context_foreign_${label}`;
  const principalId = `principal_context_foreign_${label}`;
  const connectionId = `connection_context_foreign_${label}`;
  const grantId = `context_foreign_${label}`;
  const token = `fsg_${label}_${PRIVATE_TOKEN}`;
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 3_600_000).toISOString();
  const scopes = ["organization_policy:read", "design:write"];
  const scopesJson = JSON.stringify(scopes);
  const foreignPolicy = structuredClone(DEFAULT_ORGANIZATION_POLICY);
  foreignPolicy.identity.roleMappings = [
    { claim: "identity", value: PRIVATE_MARKER, role: "viewer" },
  ];

  application.database.sqlite.prepare(
    "INSERT INTO organizations (id, name, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(
    organizationId,
    `Foreign ${PRIVATE_MARKER}`,
    canonicalOrganizationPolicy(foreignPolicy),
    createdAt,
    createdAt,
  );
  application.database.sqlite.prepare(
    `INSERT INTO principals (id, organization_id, kind, display_name, external_id, created_at)
     VALUES (?, ?, 'agent', ?, ?, ?)`,
  ).run(principalId, organizationId, `Foreign ${PRIVATE_MARKER}`, `foreign:${PRIVATE_PATH}`, createdAt);
  application.database.sqlite.prepare(
    "INSERT INTO memberships (organization_id, principal_id, role, created_at) VALUES (?, ?, 'agent', ?)",
  ).run(organizationId, principalId, createdAt);
  application.database.sqlite.prepare(
    `INSERT INTO agent_connections
     (id, organization_id, principal_id, adapter, display_name, status, scopes_json, project_ids_json,
      expires_at, created_at, updated_at)
     VALUES (?, ?, ?, 'generic_mcp', ?, 'active', ?, '[]', ?, ?, ?)`,
  ).run(
    connectionId,
    organizationId,
    principalId,
    `Foreign ${PRIVATE_MARKER}`,
    scopesJson,
    expiresAt,
    createdAt,
    createdAt,
  );
  application.database.sqlite.prepare(
    `INSERT INTO agent_grants
     (id, organization_id, principal_id, token_hash, scopes_json, project_ids_json, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, '[]', ?, ?)`,
  ).run(
    grantId,
    organizationId,
    principalId,
    createHash("sha256").update(token).digest("hex"),
    scopesJson,
    createdAt,
    expiresAt,
  );
  const actorId = `grant_${grantId}`;
  const design = createDesign(application, actorId, `${label}-foreign`, `Foreign ${PRIVATE_MARKER} ${PRIVATE_PATH}`);
  const projectIds = [design.id];
  application.database.sqlite.prepare(
    "UPDATE agent_grants SET project_ids_json = ? WHERE id = ?",
  ).run(JSON.stringify(projectIds), grantId);
  application.database.sqlite.prepare(
    "UPDATE agent_connections SET project_ids_json = ? WHERE id = ?",
  ).run(JSON.stringify(projectIds), connectionId);
  return {
    agent: { actorId, token, connectionId, projectIds, scopes },
    design,
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

  const allowed = createDesign(application, "local", `${label}-allowed`, "Allowed organization-context project");
  const denied = createDesign(
    application,
    "local",
    `${label}-denied`,
    `Denied ${PRIVATE_MARKER} ${PRIVATE_PATH}`,
  );
  const scopedAgent = pairAgent(
    application,
    `${label}-scoped`,
    ["organization_policy:read", "design:read"],
    [allowed.id],
  );
  const scopeDeniedAgent = pairAgent(
    application,
    `${label}-scope-denied`,
    ["design:read"],
    [allowed.id],
  );
  const revokedAgent = pairAgent(
    application,
    `${label}-revoked`,
    ["organization_policy:read"],
    [allowed.id],
  );
  application.enterprise.revokeAgentConnection("local", revokedAgent.connectionId);
  const expiredAgent = pairAgent(
    application,
    `${label}-expired`,
    ["organization_policy:read"],
    [allowed.id],
  );
  application.database.sqlite.prepare(
    "UPDATE agent_grants SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
  ).run(expiredAgent.actorId.slice("grant_".length));
  const foreign = installForeignAgent(application, label);

  return {
    application,
    allowed,
    denied,
    scopedAgent,
    scopeDeniedAgent,
    revokedAgent,
    expiredAgent,
    foreignAgent: foreign.agent,
    foreignDesign: foreign.design,
    hidden: [
      PRIVATE_MARKER,
      PRIVATE_PATH,
      PRIVATE_TOKEN,
      denied.id,
      foreign.design.id,
      scopedAgent.token,
      scopeDeniedAgent.token,
      revokedAgent.token,
      expiredAgent.token,
      foreign.agent.token,
    ],
  };
}

function expectHiddenError(
  response: { statusCode: number; body: string; json<T>(): T },
  statusCode: number,
  code: string,
  hidden: string[],
): void {
  expect(response.statusCode, response.body).toBe(statusCode);
  expect(response.json<{ error: { code: string } }>().error.code, response.body).toBe(code);
  for (const marker of hidden) expect(response.body).not.toContain(marker);
}

function captureDomainError(callback: () => unknown): DomainError {
  try {
    callback();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error("Expected a DomainError.");
}

function expectHiddenDomainError(error: DomainError, statusCode: number, code: string, hidden: string[]): void {
  expect(error).toMatchObject({ statusCode, code });
  const serialized = JSON.stringify(error.toJSON());
  for (const marker of hidden) expect(serialized).not.toContain(marker);
}

function totalChanges(application: DesignerApplication): number {
  return (application.database.sqlite.prepare("SELECT total_changes() AS count").get() as { count: number }).count;
}

function grantUsage(application: DesignerApplication, actorId: string): unknown {
  return application.database.sqlite.prepare(
    "SELECT expires_at, revoked_at, last_used_at FROM agent_grants WHERE id = ?",
  ).get(actorId.slice("grant_".length));
}

describe("organization policy, self context, and maintenance HTTP authorization", () => {
  it("authorizes organization reads before policy loading or YAML serialization and preserves viewer/scoped-agent semantics", async () => {
    const fixture = await createFixture("organization-reads");
    const { application } = fixture;
    const preflight = vi.spyOn(application.policies, "assertOrganizationReadAllowed");
    const read = vi.spyOn(application.policies, "read");
    const exportYaml = vi.spyOn(application.policies, "exportYaml");
    const beforeDenied = totalChanges(application);

    for (const url of ["/api/organization/policy", "/api/organization/configuration"]) {
      const unauthenticated = await application.app.inject({
        method: "GET",
        url,
        remoteAddress: "127.0.0.1",
        headers: unauthenticatedHeaders(),
      });
      expectHiddenError(unauthenticated, 401, "AUTH_REQUIRED", fixture.hidden);
      const restGrant = await application.app.inject({
        method: "GET",
        url,
        remoteAddress: "127.0.0.1",
        headers: grantHeaders(fixture.scopedAgent.token),
      });
      expectHiddenError(restGrant, 401, "AUTH_REQUIRED", fixture.hidden);
    }
    expect(preflight).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(exportYaml).not.toHaveBeenCalled();
    expect(totalChanges(application)).toBe(beforeDenied);

    const viewerPolicy = await application.app.inject({
      method: "GET",
      url: "/api/organization/policy",
      remoteAddress: "127.0.0.1",
      headers: serverHeaders(VIEWER_IDENTITY),
    });
    expect(viewerPolicy.statusCode, viewerPolicy.body).toBe(200);
    expect(viewerPolicy.json()).toMatchObject({
      organizationPolicy: { policy: { schemaVersion: 1 }, source: "stored" },
    });
    const adminConfiguration = await application.app.inject({
      method: "GET",
      url: "/api/organization/configuration",
      remoteAddress: "127.0.0.1",
      headers: serverHeaders(),
    });
    expect(adminConfiguration.statusCode, adminConfiguration.body).toBe(200);
    expect(adminConfiguration.headers["content-type"]).toContain("application/yaml");
    expect(adminConfiguration.headers["content-disposition"]).toContain("organization.formaspec.yaml");
    expect(adminConfiguration.headers["cache-control"]).toBe("private, no-store");
    expect(adminConfiguration.headers.etag).toMatch(/^"[a-f0-9]{64}"$/);
    for (const response of [viewerPolicy, adminConfiguration]) {
      for (const marker of fixture.hidden) expect(response.body).not.toContain(marker);
    }
    expect(preflight).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledTimes(2);
    expect(exportYaml).toHaveBeenCalledTimes(1);

    const localPolicy = application.policies.read(fixture.scopedAgent.actorId);
    const localYaml = application.policies.exportYaml(fixture.scopedAgent.actorId);
    expect(localPolicy.policy.identity.roleMappings.some((mapping) => mapping.value === PRIVATE_MARKER)).toBe(false);
    expect(localYaml.yaml).not.toContain(PRIVATE_MARKER);
    expect(localYaml.yaml).not.toContain(PRIVATE_PATH);
    expect(localYaml.yaml).not.toContain(PRIVATE_TOKEN);

    const foreignPolicy = application.policies.read(fixture.foreignAgent.actorId);
    const foreignYaml = application.policies.exportYaml(fixture.foreignAgent.actorId);
    expect(foreignPolicy.policy.identity.roleMappings).toContainEqual({
      claim: "identity",
      value: PRIVATE_MARKER,
      role: "viewer",
    });
    expect(foreignYaml.yaml).toContain(PRIVATE_MARKER);
    expect(foreignYaml.yaml).not.toContain(fixture.scopedAgent.token);

    const beforeScopeDenied = totalChanges(application);
    const deniedCalls = [
      () => application.policies.assertOrganizationReadAllowed(fixture.scopeDeniedAgent.actorId),
      () => application.policies.read(fixture.scopeDeniedAgent.actorId),
      () => application.policies.exportYaml(fixture.scopeDeniedAgent.actorId),
    ];
    for (const callback of deniedCalls) {
      expectHiddenDomainError(captureDomainError(callback), 403, "FORBIDDEN", fixture.hidden);
    }
    expect(totalChanges(application)).toBe(beforeScopeDenied);
  });

  it("returns only each live scoped grant's own context and rejects human, revoked, and expired callers before service reads", async () => {
    const fixture = await createFixture("self-context");
    const { application } = fixture;
    const readContext = vi.spyOn(application.enterprise, "readOwnAuthorizationContext");
    const beforeDenied = totalChanges(application);

    const human = await application.app.inject({
      method: "GET",
      url: "/api/agent-authorization-context",
      remoteAddress: "127.0.0.1",
      headers: serverHeaders(VIEWER_IDENTITY),
    });
    expectHiddenError(human, 401, "AUTH_REQUIRED", fixture.hidden);
    const missing = await application.app.inject({
      method: "GET",
      url: "/api/agent-authorization-context",
      remoteAddress: "127.0.0.1",
      headers: unauthenticatedHeaders(),
    });
    expectHiddenError(missing, 401, "AUTH_REQUIRED", fixture.hidden);
    const revokedBefore = grantUsage(application, fixture.revokedAgent.actorId);
    const revoked = await application.app.inject({
      method: "GET",
      url: "/api/agent-authorization-context",
      remoteAddress: "127.0.0.1",
      headers: grantHeaders(fixture.revokedAgent.token),
    });
    expectHiddenError(revoked, 401, "AUTH_REQUIRED", fixture.hidden);
    expect(grantUsage(application, fixture.revokedAgent.actorId)).toEqual(revokedBefore);
    const expiredBefore = grantUsage(application, fixture.expiredAgent.actorId);
    const expired = await application.app.inject({
      method: "GET",
      url: "/api/agent-authorization-context",
      remoteAddress: "127.0.0.1",
      headers: grantHeaders(fixture.expiredAgent.token),
    });
    expectHiddenError(expired, 401, "AUTH_REQUIRED", fixture.hidden);
    expect(grantUsage(application, fixture.expiredAgent.actorId)).toEqual(expiredBefore);
    expect(readContext).not.toHaveBeenCalled();
    expect(totalChanges(application)).toBe(beforeDenied);

    const local = await application.app.inject({
      method: "GET",
      url: "/api/agent-authorization-context",
      remoteAddress: "127.0.0.1",
      headers: grantHeaders(fixture.scopedAgent.token),
    });
    expect(local.statusCode, local.body).toBe(200);
    expect(local.json()).toEqual({
      role: "agent",
      scopes: fixture.scopedAgent.scopes,
      projectIds: [fixture.allowed.id],
    });
    expect(local.body).not.toContain(fixture.denied.id);
    expect(local.body).not.toContain(fixture.foreignDesign.id);

    const foreign = await application.app.inject({
      method: "GET",
      url: "/api/agent-authorization-context",
      remoteAddress: "127.0.0.1",
      headers: grantHeaders(fixture.foreignAgent.token),
    });
    expect(foreign.statusCode, foreign.body).toBe(200);
    expect(foreign.json()).toEqual({
      role: "agent",
      scopes: fixture.foreignAgent.scopes,
      projectIds: [fixture.foreignDesign.id],
    });
    expect(foreign.body).not.toContain(fixture.allowed.id);
    expect(foreign.body).not.toContain(fixture.denied.id);
    for (const response of [local, foreign]) {
      expect(response.body).not.toContain(PRIVATE_TOKEN);
      expect(response.body).not.toContain(PRIVATE_PATH);
      expect(response.body).not.toContain(fixture.scopedAgent.token);
      expect(response.body).not.toContain(fixture.foreignAgent.token);
    }
    expect(readContext).toHaveBeenCalledTimes(2);
  });

  it("authenticates before maintenance-store reads and exposes only bounded active or fail-closed status", async () => {
    const fixture = await createFixture("maintenance-status");
    const { application } = fixture;
    await application.maintenance.write({
      schemaVersion: 1,
      active: true,
      phase: "verification",
      operationId: "restore_operation_public_0001",
      startedAt: "2026-07-21T00:00:00.000Z",
    });
    const read = vi.spyOn(application.maintenance, "read");
    const beforeDenied = totalChanges(application);

    const unauthenticated = await application.app.inject({
      method: "GET",
      url: "/api/maintenance/status",
      remoteAddress: "127.0.0.1",
      headers: unauthenticatedHeaders(),
    });
    expectHiddenError(unauthenticated, 401, "AUTH_REQUIRED", fixture.hidden);
    const agent = await application.app.inject({
      method: "GET",
      url: "/api/maintenance/status",
      remoteAddress: "127.0.0.1",
      headers: grantHeaders(fixture.scopedAgent.token),
    });
    expectHiddenError(agent, 401, "AUTH_REQUIRED", fixture.hidden);
    expect(read).not.toHaveBeenCalled();
    expect(totalChanges(application)).toBe(beforeDenied);

    const viewer = await application.app.inject({
      method: "GET",
      url: "/api/maintenance/status",
      remoteAddress: "127.0.0.1",
      headers: serverHeaders(VIEWER_IDENTITY),
    });
    expect(viewer.statusCode, viewer.body).toBe(200);
    expect(viewer.headers["cache-control"]).toBe("no-store");
    expect(viewer.json()).toEqual({
      active: true,
      phase: "verification",
      operationId: "restore_operation_public_0001",
      startedAt: "2026-07-21T00:00:00.000Z",
      markerValid: true,
    });
    const admin = await application.app.inject({
      method: "GET",
      url: "/api/maintenance/status",
      remoteAddress: "127.0.0.1",
      headers: serverHeaders(),
    });
    expect(admin.statusCode, admin.body).toBe(200);
    expect(admin.json()).toEqual(viewer.json());
    expect(read).toHaveBeenCalledTimes(2);
    for (const response of [viewer, admin]) {
      for (const marker of fixture.hidden) expect(response.body).not.toContain(marker);
    }

    const controlDirectory = path.join(application.config.backupDir, ".formaspec");
    await fs.promises.writeFile(path.join(controlDirectory, "maintenance.json"), JSON.stringify({
      active: true,
      phase: PRIVATE_PATH,
      operationId: PRIVATE_TOKEN,
      reason: PRIVATE_MARKER,
    }), { mode: 0o600 });
    const malformed = await application.app.inject({
      method: "GET",
      url: "/api/maintenance/status",
      remoteAddress: "127.0.0.1",
      headers: serverHeaders(VIEWER_IDENTITY),
    });
    expect(malformed.statusCode, malformed.body).toBe(200);
    expect(malformed.json()).toEqual({ active: true, phase: "unknown", markerValid: false });
    for (const marker of fixture.hidden) expect(malformed.body).not.toContain(marker);
  });
});
