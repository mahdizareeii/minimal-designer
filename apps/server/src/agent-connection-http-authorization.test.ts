import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { loadConfig } from "./config.js";
import type {
  AgentConnectionResult,
  PairedAgentConnection,
  PairingChallenge,
} from "./enterprise-service.js";

const PROXY_SECRET = "agent-connection-proxy-secret-0123456789abcdef";
const ADMIN_IDENTITY = "agent-connection-admin@example.test";
const ENGINEER_IDENTITY = "agent-connection-engineer@example.test";
const VIEWER_IDENTITY = "agent-connection-viewer@example.test";
const PAIRING_IDENTITY = "unmapped-pairing-client@example.test";
const ROTATION_DISPLAY_NAME = "Codex shared rotation target";

const applications: DesignerApplication[] = [];
const temporaryDirectories: string[] = [];

interface ForeignFixture {
  organizationId: string;
  principalId: string;
  connectionId: string;
  grantId: string;
  actorId: string;
  token: string;
  designId: string;
  markers: string[];
}

interface Fixture {
  application: DesignerApplication;
  localDesignId: string;
  foreign: ForeignFixture;
}

interface ConnectionState {
  connections: unknown[];
  nonces: unknown[];
  grants: unknown[];
  audits: unknown[];
  outbox: unknown[];
}

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.promises.rm(directory, { recursive: true, force: true })));
});

async function temporaryRoot(label: string): Promise<string> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `formaspec-agent-connection-http-${label}-`));
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
    DESIGNER_TOKEN: "agent-connection-bootstrap-token-0001",
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
  const digest = createHash("sha256").update(label).digest("hex");
  const organizationId = `organization_agent_connection_foreign_${digest.slice(0, 12)}`;
  const principalId = `principal_agent_connection_foreign_${digest.slice(12, 24)}`;
  const connectionId = `connection_${digest.slice(0, 32)}`;
  const grantId = `agent_connection_foreign_${digest.slice(24, 40)}`;
  const token = `fsg_agent_connection_foreign_${label}_SECRET_TOKEN_71ac9e`;
  const connectionMarker = `FOREIGN_CONNECTION_SECRET_${digest.slice(0, 10)}`;
  const projectMarker = `FOREIGN_PROJECT_SECRET_${digest.slice(10, 20)}`;
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 3_600_000).toISOString();
  const scopes = ["design:write"];
  const scopesJson = JSON.stringify(scopes);

  application.database.sqlite.prepare(
    "INSERT INTO organizations (id, name, config_json, created_at, updated_at) VALUES (?, ?, '{}', ?, ?)",
  ).run(organizationId, `Foreign agent-connection organization ${connectionMarker}`, createdAt, createdAt);
  application.database.sqlite.prepare(
    `INSERT INTO principals (id, organization_id, kind, display_name, external_id, created_at)
     VALUES (?, ?, 'agent', ?, ?, ?)`,
  ).run(principalId, organizationId, connectionMarker, `foreign:agent-connection:${label}`, createdAt);
  application.database.sqlite.prepare(
    "INSERT INTO memberships (organization_id, principal_id, role, created_at) VALUES (?, ?, 'agent', ?)",
  ).run(organizationId, principalId, createdAt);
  application.database.sqlite.prepare(
    `INSERT INTO agent_connections
     (id, organization_id, principal_id, adapter, display_name, status, scopes_json, project_ids_json,
      expires_at, created_at, updated_at)
     VALUES (?, ?, ?, 'codex', ?, 'active', ?, '[]', ?, ?, ?)`,
  ).run(connectionId, organizationId, principalId, connectionMarker, scopesJson, expiresAt, createdAt, createdAt);
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
  const design = application.service.createDesign(actorId, {
    name: projectMarker,
    preset: "tablet",
    idempotencyKey: `agent-connection-foreign-design-${label}-0001`,
  });
  return {
    organizationId,
    principalId,
    connectionId,
    grantId,
    actorId,
    token,
    designId: design.document.id,
    markers: [connectionMarker, projectMarker, token],
  };
}

async function createFixture(label: string): Promise<Fixture> {
  const application = await serverApplication(label);
  await warmIdentity(application, ADMIN_IDENTITY);
  const current = application.policies.read(`trusted:${ADMIN_IDENTITY}`);
  const policy = structuredClone(current.policy);
  policy.identity.roleMappings = [
    { claim: "identity", value: ADMIN_IDENTITY, role: "organization_admin" },
    { claim: "identity", value: ENGINEER_IDENTITY, role: "engineer" },
    { claim: "identity", value: VIEWER_IDENTITY, role: "viewer" },
  ];
  application.policies.update(`trusted:${ADMIN_IDENTITY}`, {
    expectedConfigurationHash: current.configurationHash,
    policy,
  });
  await warmIdentity(application, ENGINEER_IDENTITY);
  await warmIdentity(application, VIEWER_IDENTITY);

  const localDesign = application.service.createDesign("local", {
    name: `Local agent-connection project ${label}`,
    preset: "phone",
    idempotencyKey: `agent-connection-local-design-${label}-0001`,
  });
  return {
    application,
    localDesignId: localDesign.document.id,
    foreign: installForeignFixture(application, label),
  };
}

function connectionState(application: DesignerApplication): ConnectionState {
  return {
    connections: application.database.sqlite.prepare(
      `SELECT id, organization_id, principal_id, adapter, display_name, status, scopes_json,
              project_ids_json, expires_at, created_at
       FROM agent_connections ORDER BY id`,
    ).all(),
    nonces: application.database.sqlite.prepare(
      `SELECT nonce_hash, connection_id, created_by, created_at, expires_at, consumed_at, revoked_at
       FROM pairing_nonces ORDER BY nonce_hash`,
    ).all(),
    grants: application.database.sqlite.prepare(
      `SELECT id, organization_id, principal_id, token_hash, scopes_json, project_ids_json,
              created_at, expires_at, revoked_at
       FROM agent_grants ORDER BY id`,
    ).all(),
    audits: application.database.sqlite.prepare(
      `SELECT organization_id, actor_id, action, target_id, details_json
       FROM audit_events WHERE target_type = 'agent_connection' ORDER BY id`,
    ).all(),
    outbox: application.database.sqlite.prepare(
      `SELECT organization_id, event_type, payload_json
       FROM event_outbox WHERE event_type = 'agent_connection.changed' ORDER BY id`,
    ).all(),
  };
}

function expectError(
  response: { statusCode: number; body: string; json<T>(): T },
  statusCode: number,
  code: string,
  hidden: string[] = [],
): void {
  expect(response.statusCode, response.body).toBe(statusCode);
  expect(response.json<{ error: { code: string } }>().error.code, response.body).toBe(code);
  for (const marker of hidden) expect(response.body).not.toContain(marker);
}

async function createConnection(
  application: DesignerApplication,
  input: {
    displayName: string;
    projectIds?: string[];
    replaceExisting?: boolean;
  },
): Promise<PairingChallenge> {
  const response = await application.app.inject({
    method: "POST",
    url: "/api/agent-connections",
    headers: serverHeaders(),
    payload: {
      adapter: "codex",
      displayName: input.displayName,
      scopes: ["design:read"],
      expiresInSeconds: 3_600,
      ...(input.projectIds === undefined ? {} : { projectIds: input.projectIds }),
      ...(input.replaceExisting === undefined ? {} : { replaceExisting: input.replaceExisting }),
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<PairingChallenge>();
}

async function pairConnection(application: DesignerApplication, nonce: string): Promise<PairedAgentConnection> {
  const response = await application.app.inject({
    method: "POST",
    url: "/api/agent-connections/pair",
    headers: serverHeaders(PAIRING_IDENTITY),
    payload: { nonce },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<PairedAgentConnection>();
}

describe("agent-connection HTTP authorization", () => {
  it("runs the five public routes through trusted-header administration and immediately invalidates rotated grants", async () => {
    const fixture = await createFixture("admin_lifecycle");
    const { application } = fixture;
    const challenge = await createConnection(application, {
      displayName: "Codex lifecycle connection",
      projectIds: [fixture.localDesignId],
    });
    expect(challenge.connection).toMatchObject({
      adapter: "codex",
      status: "pending",
      projectIds: [fixture.localDesignId],
      principalId: null,
    });
    expect(challenge.nonce).toMatch(/^fspair_/);

    const listedPending = await application.app.inject({
      method: "GET",
      url: "/api/agent-connections",
      headers: serverHeaders(),
    });
    expect(listedPending.statusCode, listedPending.body).toBe(200);
    expect(listedPending.json<{ connections: AgentConnectionResult[] }>().connections).toEqual([
      expect.objectContaining({ id: challenge.connection.id, status: "pending" }),
    ]);
    expect(listedPending.body).not.toContain(challenge.nonce);

    const firstPair = await pairConnection(application, challenge.nonce);
    expect(firstPair.connection).toMatchObject({ id: challenge.connection.id, status: "active" });
    expect(firstPair.grant).toMatchObject({
      token: expect.stringMatching(/^fsg_/),
      projectIds: [fixture.localDesignId],
      scopes: ["design:read"],
    });
    const storedGrant = application.database.sqlite.prepare(
      "SELECT token_hash FROM agent_grants WHERE id = ?",
    ).get(firstPair.grant.id) as { token_hash: string };
    expect(storedGrant.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(storedGrant.token_hash).not.toContain(firstPair.grant.token);

    const activeContext = await application.app.inject({
      method: "GET",
      url: "/api/agent-authorization-context",
      headers: grantHeaders(firstPair.grant.token),
    });
    expect(activeContext.statusCode, activeContext.body).toBe(200);

    const reconnect = await application.app.inject({
      method: "POST",
      url: `/api/agent-connections/${challenge.connection.id}/reconnect`,
      headers: serverHeaders(),
    });
    expect(reconnect.statusCode, reconnect.body).toBe(200);
    const renewed = reconnect.json<PairingChallenge>();
    expect(renewed.connection).toMatchObject({ id: challenge.connection.id, status: "pending" });
    expect(renewed.nonce).not.toBe(challenge.nonce);

    const rotatedGrant = await application.app.inject({
      method: "GET",
      url: "/api/agent-authorization-context",
      headers: grantHeaders(firstPair.grant.token),
    });
    expectError(rotatedGrant, 401, "AUTH_REQUIRED", [firstPair.grant.token]);

    const secondPair = await pairConnection(application, renewed.nonce);
    expect(secondPair.connection).toMatchObject({ id: challenge.connection.id, status: "active" });
    expect(secondPair.connection.principalId).toBe(firstPair.connection.principalId);

    const revoke = await application.app.inject({
      method: "POST",
      url: `/api/agent-connections/${challenge.connection.id}/revoke`,
      headers: serverHeaders(),
    });
    expect(revoke.statusCode, revoke.body).toBe(200);
    expect(revoke.json<AgentConnectionResult>()).toMatchObject({ id: challenge.connection.id, status: "revoked" });

    const revokedGrant = await application.app.inject({
      method: "GET",
      url: "/api/agent-authorization-context",
      headers: grantHeaders(secondPair.grant.token),
    });
    expectError(revokedGrant, 401, "AUTH_REQUIRED", [secondPair.grant.token]);

    const actions = application.database.sqlite.prepare(
      "SELECT action FROM audit_events WHERE target_type = 'agent_connection' AND target_id = ? ORDER BY id",
    ).all(challenge.connection.id) as Array<{ action: string }>;
    expect(actions.map((row) => row.action)).toEqual([
      "agent_connection.create",
      "agent_connection.pair",
      "agent_connection.reconnect",
      "agent_connection.pair",
      "agent_connection.revoke",
    ]);
  });

  it("denies non-admin roles before opaque lookup and hides foreign, project, and type-swapped IDs without mutation", async () => {
    const fixture = await createFixture("roles_and_foreign_ids");
    const { application, foreign } = fixture;
    const localChallenge = await createConnection(application, {
      displayName: "Protected local connection",
      projectIds: [fixture.localDesignId],
    });
    const hidden = [
      ...foreign.markers,
      foreign.connectionId,
      foreign.designId,
      localChallenge.nonce,
    ];
    const before = connectionState(application);

    const roleDenied = await Promise.all([
      application.app.inject({
        method: "GET",
        url: "/api/agent-connections",
        headers: serverHeaders(VIEWER_IDENTITY),
      }),
      application.app.inject({
        method: "POST",
        url: "/api/agent-connections",
        headers: serverHeaders(VIEWER_IDENTITY),
        payload: {
          adapter: "codex",
          displayName: "Viewer must not create this",
          scopes: ["design:read"],
          projectIds: [fixture.localDesignId],
          expiresInSeconds: 3_600,
        },
      }),
      application.app.inject({
        method: "POST",
        url: "/api/agent-connections",
        headers: serverHeaders(VIEWER_IDENTITY),
        payload: {},
      }),
      application.app.inject({
        method: "POST",
        url: `/api/agent-connections/${localChallenge.connection.id}/reconnect`,
        headers: serverHeaders(ENGINEER_IDENTITY),
      }),
      application.app.inject({
        method: "POST",
        url: `/api/agent-connections/${localChallenge.connection.id}/revoke`,
        headers: serverHeaders(ENGINEER_IDENTITY),
      }),
      application.app.inject({
        method: "POST",
        url: "/api/agent-connections/%20/reconnect",
        headers: serverHeaders(ENGINEER_IDENTITY),
      }),
      application.app.inject({
        method: "POST",
        url: "/api/agent-connections/%20/revoke",
        headers: serverHeaders(ENGINEER_IDENTITY),
      }),
    ]);
    for (const response of roleDenied) expectError(response, 403, "FORBIDDEN", hidden);

    const foreignAndSwapped = await Promise.all([
      application.app.inject({
        method: "POST",
        url: `/api/agent-connections/${foreign.connectionId}/reconnect`,
        headers: serverHeaders(),
      }),
      application.app.inject({
        method: "POST",
        url: `/api/agent-connections/${foreign.connectionId}/revoke`,
        headers: serverHeaders(),
      }),
      application.app.inject({
        method: "POST",
        url: `/api/agent-connections/${fixture.localDesignId}/reconnect`,
        headers: serverHeaders(),
      }),
      application.app.inject({
        method: "POST",
        url: `/api/agent-connections/${fixture.localDesignId}/revoke`,
        headers: serverHeaders(),
      }),
      application.app.inject({
        method: "POST",
        url: "/api/agent-connections",
        headers: serverHeaders(),
        payload: {
          adapter: "codex",
          displayName: "Foreign-project rejection",
          scopes: ["design:read"],
          projectIds: [foreign.designId],
          expiresInSeconds: 3_600,
        },
      }),
      application.app.inject({
        method: "POST",
        url: "/api/agent-connections",
        headers: serverHeaders(),
        payload: {
          adapter: "codex",
          displayName: "Type-swapped project rejection",
          scopes: ["design:read"],
          projectIds: [foreign.connectionId],
          expiresInSeconds: 3_600,
        },
      }),
    ]);
    for (const response of foreignAndSwapped) expectError(response, 404, "NOT_FOUND", hidden);

    const invalidPairing = await application.app.inject({
      method: "POST",
      url: "/api/agent-connections/pair",
      headers: serverHeaders(PAIRING_IDENTITY),
      payload: { nonce: `fspair_${"z".repeat(43)}` },
    });
    expectError(invalidPairing, 404, "NOT_FOUND", hidden);

    const list = await application.app.inject({
      method: "GET",
      url: "/api/agent-connections",
      headers: serverHeaders(),
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json<{ connections: AgentConnectionResult[] }>().connections.map((connection) => connection.id))
      .toEqual([localChallenge.connection.id]);
    for (const marker of foreign.markers) expect(list.body).not.toContain(marker);

    expect(connectionState(application)).toEqual(before);
    expect(application.enterprise.readOwnAuthorizationContext(foreign.actorId)).toEqual({
      role: "agent",
      scopes: ["design:write"],
      projectIds: [],
    });
  });

  it("scopes replacement cleanup to the current organization and revokes every replaced local grant and nonce", async () => {
    const fixture = await createFixture("replacement_cleanup");
    const { application, foreign } = fixture;
    const foreignCollisionId = `connection_${createHash("sha256").update("foreign-collision").digest("hex").slice(0, 32)}`;
    const foreignCollisionNonce = `fspair_${createHash("sha256").update("foreign-collision-nonce").digest("base64url")}`;
    const now = new Date();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + 3_600_000).toISOString();
    application.database.sqlite.prepare(
      `INSERT INTO agent_connections
       (id, organization_id, principal_id, adapter, display_name, status, scopes_json, project_ids_json,
        expires_at, created_at, updated_at)
       VALUES (?, ?, NULL, 'codex', ?, 'pending', '["design:read"]', '[]', ?, ?, ?)`,
    ).run(foreignCollisionId, foreign.organizationId, ROTATION_DISPLAY_NAME, expiresAt, createdAt, createdAt);
    application.database.sqlite.prepare(
      `INSERT INTO pairing_nonces
       (nonce_hash, connection_id, created_by, created_at, expires_at, consumed_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
    ).run(
      createHash("sha256").update(foreignCollisionNonce).digest("hex"),
      foreignCollisionId,
      foreign.principalId,
      createdAt,
      expiresAt,
    );

    const activeChallenge = await createConnection(application, { displayName: ROTATION_DISPLAY_NAME });
    const active = await pairConnection(application, activeChallenge.nonce);
    const pending = await createConnection(application, { displayName: ROTATION_DISPLAY_NAME });

    const replacement = await createConnection(application, {
      displayName: ROTATION_DISPLAY_NAME,
      replaceExisting: true,
    });
    expect(replacement.connection.status).toBe("pending");

    const localRows = application.database.sqlite.prepare(
      "SELECT id, status FROM agent_connections WHERE organization_id = 'organization_legacy' ORDER BY id",
    ).all() as Array<{ id: string; status: string }>;
    const statuses = new Map(localRows.map((row) => [row.id, row.status]));
    expect(statuses.get(active.connection.id)).toBe("revoked");
    expect(statuses.get(pending.connection.id)).toBe("revoked");
    expect(statuses.get(replacement.connection.id)).toBe("pending");
    expect(application.database.sqlite.prepare(
      "SELECT status FROM agent_connections WHERE id = ? AND organization_id = ?",
    ).get(foreignCollisionId, foreign.organizationId)).toEqual({ status: "pending" });
    expect(application.database.sqlite.prepare(
      "SELECT revoked_at FROM pairing_nonces WHERE connection_id = ?",
    ).get(foreignCollisionId)).toEqual({ revoked_at: null });

    const invalidatedGrant = await application.app.inject({
      method: "GET",
      url: "/api/agent-authorization-context",
      headers: grantHeaders(active.grant.token),
    });
    expectError(invalidatedGrant, 401, "AUTH_REQUIRED", [active.grant.token]);

    const revokedPendingNonce = await application.app.inject({
      method: "POST",
      url: "/api/agent-connections/pair",
      headers: serverHeaders(PAIRING_IDENTITY),
      payload: { nonce: pending.nonce },
    });
    expectError(revokedPendingNonce, 410, "CONNECTION_REVOKED", [pending.nonce, ...foreign.markers]);

    const replacementList = await application.app.inject({
      method: "GET",
      url: "/api/agent-connections",
      headers: serverHeaders(),
    });
    expect(replacementList.statusCode, replacementList.body).toBe(200);
    const listedIds = replacementList.json<{ connections: AgentConnectionResult[] }>().connections
      .map((connection) => connection.id);
    expect(listedIds).toEqual(expect.arrayContaining([
      active.connection.id,
      pending.connection.id,
      replacement.connection.id,
    ]));
    expect(listedIds).not.toContain(foreign.connectionId);
    expect(listedIds).not.toContain(foreignCollisionId);

    const replacementAudit = application.database.sqlite.prepare(
      `SELECT target_id, details_json FROM audit_events
       WHERE action = 'agent_connection.revoke' AND target_id IN (?, ?) ORDER BY target_id`,
    ).all(active.connection.id, pending.connection.id) as Array<{ target_id: string; details_json: string }>;
    expect(replacementAudit).toHaveLength(2);
    for (const row of replacementAudit) {
      expect(JSON.parse(row.details_json)).toEqual({
        reason: "replaced",
        replacementConnectionId: replacement.connection.id,
      });
    }
  });
});
