import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { loadConfig } from "./config.js";
import type { DomainError } from "./errors.js";
import type {
  RepositoryInventoryResult,
  UploadRepositoryInventory,
} from "./workspace-handoff-service.js";

const PROXY_SECRET = "repository-inventory-proxy-secret-0123456789abcdef";
const ADMIN_IDENTITY = "repository-inventory-admin@example.test";
const PM_IDENTITY = "repository-inventory-pm@example.test";
const DESIGNER_IDENTITY = "repository-inventory-designer@example.test";
const ENGINEER_IDENTITY = "repository-inventory-engineer@example.test";
const VIEWER_IDENTITY = "repository-inventory-viewer@example.test";
const PRIVATE_PATH = "/Users/private/company-repository/src/secret.ts";
const PRIVATE_TOKEN = "REPOSITORY_TOKEN_SECRET_4d72a1";
const EXCLUDED_PATTERNS = [".env", ".env.*", "*.pem", "*.key", "**/secrets/**", "**/.git/**"];

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
  inventory: RepositoryInventoryResult;
  markers: string[];
}

interface Fixture {
  application: DesignerApplication;
  localDesignId: string;
  foreign: ForeignFixture;
}

interface InventoryState {
  inventories: unknown[];
  audits: unknown[];
}

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.promises.rm(directory, { recursive: true, force: true })));
});

async function temporaryRoot(label: string): Promise<string> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `formaspec-inventory-http-${label}-`));
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
    DESIGNER_TOKEN: "repository-inventory-bootstrap-token-0001",
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

function digest(value: string, length = 64): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function inventory(
  seed: string,
  overrides: Partial<UploadRepositoryInventory> = {},
): UploadRepositoryInventory {
  const marker = `Inventory marker ${seed}`;
  return {
    schemaVersion: 1,
    repositoryFingerprint: digest(`fingerprint:${seed}`),
    generatedAt: "2026-07-21T00:00:00.000Z",
    platforms: ["web"],
    gitHead: digest(`git:${seed}`, 40),
    scannedFileCount: 12,
    skippedFileCount: 3,
    bytesRead: 12_345,
    truncated: false,
    excludedPatterns: EXCLUDED_PATTERNS,
    entities: [
      {
        id: `inv_${digest(`entity:${seed}`, 40)}`,
        kind: "component",
        name: marker,
        symbol: "InventoryComponent",
        locationId: `loc_${digest(`location:${seed}`, 40)}`,
        line: 42,
      },
    ],
    excluded: [
      { category: "secret", count: 2 },
      { category: "generated", count: 5 },
      { category: "symlink", count: 1 },
      { category: "limit", count: 0 },
    ],
    ...overrides,
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
  const idDigest = digest(label);
  const organizationId = `organization_inventory_foreign_${idDigest.slice(0, 12)}`;
  const principalId = `principal_inventory_foreign_${idDigest.slice(12, 24)}`;
  const connectionId = `connection_${idDigest.slice(0, 32)}`;
  const grantId = `inventory_foreign_${idDigest.slice(24, 40)}`;
  const token = `fsg_inventory_foreign_${label}_${PRIVATE_TOKEN}`;
  const connectionMarker = `FOREIGN_INVENTORY_CONNECTION_${idDigest.slice(0, 10)}`;
  const projectMarker = `FOREIGN_INVENTORY_PROJECT_${idDigest.slice(10, 20)}`;
  const inventoryMarker = `foreign-inventory-${label}`;
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 3_600_000).toISOString();
  const scopes = ["design:write", "workspace:inventory:read", "workspace:inventory:write"];
  const scopesJson = JSON.stringify(scopes);

  application.database.sqlite.prepare(
    "INSERT INTO organizations (id, name, config_json, created_at, updated_at) VALUES (?, ?, '{}', ?, ?)",
  ).run(organizationId, `Foreign inventory organization ${connectionMarker}`, createdAt, createdAt);
  application.database.sqlite.prepare(
    `INSERT INTO principals (id, organization_id, kind, display_name, external_id, created_at)
     VALUES (?, ?, 'agent', ?, ?, ?)`,
  ).run(principalId, organizationId, connectionMarker, `foreign:inventory:${label}`, createdAt);
  application.database.sqlite.prepare(
    "INSERT INTO memberships (organization_id, principal_id, role, created_at) VALUES (?, ?, 'agent', ?)",
  ).run(organizationId, principalId, createdAt);
  application.database.sqlite.prepare(
    `INSERT INTO agent_connections
     (id, organization_id, principal_id, adapter, display_name, status, scopes_json, project_ids_json,
      expires_at, created_at, updated_at)
     VALUES (?, ?, ?, 'generic_mcp', ?, 'active', ?, '[]', ?, ?, ?)`,
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
    idempotencyKey: `inventory-foreign-design-${label}-0001`,
  });
  const persistedInventory = application.handoffs.persistRepositoryInventory(
    actorId,
    inventory(inventoryMarker),
  );
  return {
    organizationId,
    principalId,
    connectionId,
    grantId,
    actorId,
    token,
    designId: design.document.id,
    inventory: persistedInventory,
    markers: [connectionMarker, projectMarker, inventoryMarker, token, PRIVATE_PATH, PRIVATE_TOKEN],
  };
}

async function createFixture(label: string): Promise<Fixture> {
  const application = await serverApplication(label);
  await warmIdentity(application, ADMIN_IDENTITY);
  const current = application.policies.read(`trusted:${ADMIN_IDENTITY}`);
  const policy = structuredClone(current.policy);
  policy.identity.roleMappings = [
    { claim: "identity", value: ADMIN_IDENTITY, role: "organization_admin" },
    { claim: "identity", value: PM_IDENTITY, role: "product_manager" },
    { claim: "identity", value: DESIGNER_IDENTITY, role: "design_editor" },
    { claim: "identity", value: ENGINEER_IDENTITY, role: "engineer" },
    { claim: "identity", value: VIEWER_IDENTITY, role: "viewer" },
  ];
  application.policies.update(`trusted:${ADMIN_IDENTITY}`, {
    expectedConfigurationHash: current.configurationHash,
    policy,
  });
  await warmIdentity(application, PM_IDENTITY);
  await warmIdentity(application, DESIGNER_IDENTITY);
  await warmIdentity(application, ENGINEER_IDENTITY);
  await warmIdentity(application, VIEWER_IDENTITY);
  const localDesign = application.service.createDesign("local", {
    name: `Local inventory project ${label}`,
    preset: "phone",
    idempotencyKey: `inventory-local-design-${label}-0001`,
  });
  return {
    application,
    localDesignId: localDesign.document.id,
    foreign: installForeignFixture(application, label),
  };
}

function inventoryState(application: DesignerApplication): InventoryState {
  return {
    inventories: application.database.sqlite.prepare(
      `SELECT id, organization_id, repository_fingerprint, inventory_hash, inventory_json,
              status, created_by, created_at, revoked_at
       FROM repository_inventories ORDER BY id`,
    ).all(),
    audits: application.database.sqlite.prepare(
      `SELECT organization_id, actor_id, action, target_id, details_json
       FROM audit_events WHERE target_type = 'repository_inventory' ORDER BY id`,
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

function captureDomainError(callback: () => unknown): DomainError {
  try {
    callback();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error("Expected a DomainError.");
}

function expectHiddenDomainError(
  error: DomainError,
  statusCode: number,
  code: string,
  hidden: string[],
): void {
  expect(error).toMatchObject({ statusCode, code });
  const serialized = JSON.stringify(error.toJSON());
  for (const marker of hidden) expect(serialized).not.toContain(marker);
}

async function persistInventory(
  application: DesignerApplication,
  payload: UploadRepositoryInventory,
  identity = ADMIN_IDENTITY,
): Promise<RepositoryInventoryResult> {
  const response = await application.app.inject({
    method: "POST",
    url: "/api/repository-inventories",
    headers: serverHeaders(identity),
    payload,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ inventory: RepositoryInventoryResult }>().inventory;
}

describe("repository-inventory HTTP authorization", () => {
  it("enforces read/write roles across all four routes and keeps inventory responses path- and token-free", async () => {
    const fixture = await createFixture("role_matrix");
    const { application } = fixture;
    const created = await persistInventory(application, inventory("role-matrix-local"), ENGINEER_IDENTITY);

    const list = await application.app.inject({
      method: "GET",
      url: "/api/repository-inventories",
      headers: serverHeaders(PM_IDENTITY),
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json<{ inventories: Array<{ id: string; entityCount: number }> }>().inventories).toEqual([
      expect.objectContaining({ id: created.id, entityCount: 1 }),
    ]);

    const read = await application.app.inject({
      method: "GET",
      url: `/api/repository-inventories/${created.id}`,
      headers: serverHeaders(DESIGNER_IDENTITY),
    });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json<{ inventory: RepositoryInventoryResult }>().inventory).toMatchObject({
      id: created.id,
      status: "active",
      deduplicated: false,
    });
    expect(read.body).not.toContain("repositoryRoot");
    expect(read.body).not.toContain("relativePath");
    expect(read.body).not.toContain(PRIVATE_PATH);
    expect(read.body).not.toContain(PRIVATE_TOKEN);

    const beforeDenied = inventoryState(application);
    const denied = await Promise.all([
      application.app.inject({
        method: "GET",
        url: "/api/repository-inventories",
        headers: serverHeaders(VIEWER_IDENTITY),
      }),
      application.app.inject({
        method: "GET",
        url: `/api/repository-inventories/${created.id}`,
        headers: serverHeaders(VIEWER_IDENTITY),
      }),
      application.app.inject({
        method: "POST",
        url: "/api/repository-inventories",
        headers: serverHeaders(PM_IDENTITY),
        payload: inventory("pm-denied-write"),
      }),
      application.app.inject({
        method: "POST",
        url: `/api/repository-inventories/${created.id}/revoke`,
        headers: serverHeaders(PM_IDENTITY),
        payload: {},
      }),
    ]);
    for (const response of denied) expectError(response, 403, "FORBIDDEN", fixture.foreign.markers);
    expect(inventoryState(application)).toEqual(beforeDenied);

    const revoked = await application.app.inject({
      method: "POST",
      url: `/api/repository-inventories/${created.id}/revoke`,
      headers: serverHeaders(),
      payload: {},
    });
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(revoked.json<{ inventory: RepositoryInventoryResult }>().inventory).toMatchObject({
      id: created.id,
      status: "revoked",
      revokedAt: expect.any(String),
    });
  });

  it("authorizes before parsing and hides foreign, type-swapped, path-bearing, and token-bearing input without mutation", async () => {
    const fixture = await createFixture("opaque_and_order");
    const { application, foreign } = fixture;
    const localInventory = application.handoffs.persistRepositoryInventory("local", inventory("opaque-local"));
    const hidden = [
      ...foreign.markers,
      foreign.inventory.id,
      foreign.designId,
      foreign.connectionId,
      PRIVATE_PATH,
      PRIVATE_TOKEN,
    ];
    const invalidPayload = {
      ...inventory("invalid-private-payload"),
      repositoryRoot: PRIVATE_PATH,
      accessToken: PRIVATE_TOKEN,
    };
    const before = inventoryState(application);

    const roleDeniedBeforeParsing = await Promise.all([
      application.app.inject({
        method: "GET",
        url: "/api/repository-inventories?limit=0&repositoryFingerprint=not-a-hash",
        headers: serverHeaders(VIEWER_IDENTITY),
      }),
      application.app.inject({
        method: "GET",
        url: "/api/repository-inventories/%20",
        headers: serverHeaders(VIEWER_IDENTITY),
      }),
      application.app.inject({
        method: "POST",
        url: "/api/repository-inventories",
        headers: serverHeaders(PM_IDENTITY),
        payload: invalidPayload,
      }),
      application.app.inject({
        method: "POST",
        url: "/api/repository-inventories/%20/revoke",
        headers: serverHeaders(PM_IDENTITY),
        payload: { accessToken: PRIVATE_TOKEN },
      }),
    ]);
    for (const response of roleDeniedBeforeParsing) expectError(response, 403, "FORBIDDEN", hidden);

    const opaqueIds = await Promise.all([
      application.app.inject({
        method: "GET",
        url: `/api/repository-inventories/${foreign.inventory.id}`,
        headers: serverHeaders(),
      }),
      application.app.inject({
        method: "POST",
        url: `/api/repository-inventories/${foreign.inventory.id}/revoke`,
        headers: serverHeaders(),
        payload: {},
      }),
      application.app.inject({
        method: "GET",
        url: `/api/repository-inventories/${fixture.localDesignId}`,
        headers: serverHeaders(),
      }),
      application.app.inject({
        method: "POST",
        url: `/api/repository-inventories/${fixture.localDesignId}/revoke`,
        headers: serverHeaders(),
        payload: {},
      }),
      application.app.inject({
        method: "GET",
        url: `/api/repository-inventories/${foreign.connectionId}`,
        headers: serverHeaders(),
      }),
    ]);
    for (const response of opaqueIds) expectError(response, 404, "NOT_FOUND", hidden);

    const invalidList = await application.app.inject({
      method: "GET",
      url: "/api/repository-inventories?limit=0&repositoryFingerprint=not-a-hash",
      headers: serverHeaders(),
    });
    expectError(invalidList, 422, "VALIDATION_FAILED", hidden);
    const invalidPersist = await application.app.inject({
      method: "POST",
      url: "/api/repository-inventories",
      headers: serverHeaders(),
      payload: invalidPayload,
    });
    expectError(invalidPersist, 422, "VALIDATION_FAILED", hidden);

    const list = await application.app.inject({
      method: "GET",
      url: "/api/repository-inventories",
      headers: serverHeaders(),
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json<{ inventories: Array<{ id: string }> }>().inventories.map((entry) => entry.id))
      .toEqual([localInventory.id]);
    for (const marker of foreign.markers) expect(list.body).not.toContain(marker);

    expect(inventoryState(application)).toEqual(before);
    expect(application.handoffs.readRepositoryInventory(foreign.actorId, foreign.inventory.id).status).toBe("active");
  });

  it("filters organization and fingerprint before limit while supersession cleanup stays organization-scoped", async () => {
    const fixture = await createFixture("filter_and_supersede");
    const { application, foreign } = fixture;
    const sharedFingerprint = "a".repeat(64);
    const first = await persistInventory(application, inventory("shared-local-first", {
      repositoryFingerprint: sharedFingerprint,
      generatedAt: "2026-07-21T01:00:00.000Z",
    }), ENGINEER_IDENTITY);
    application.database.sqlite.prepare(
      "UPDATE repository_inventories SET created_at = '2026-01-01T00:00:00.000Z' WHERE id = ?",
    ).run(first.id);

    const foreignShared = application.handoffs.persistRepositoryInventory(foreign.actorId, inventory("shared-foreign", {
      repositoryFingerprint: sharedFingerprint,
      generatedAt: "2026-07-21T02:00:00.000Z",
    }));
    const second = await persistInventory(application, inventory("shared-local-second", {
      repositoryFingerprint: sharedFingerprint,
      generatedAt: "2026-07-21T03:00:00.000Z",
    }), ENGINEER_IDENTITY);

    const futureForeignIds = [foreign.inventory.id, foreignShared.id];
    for (const [index, inventoryId] of futureForeignIds.entries()) {
      application.database.sqlite.prepare(
        "UPDATE repository_inventories SET created_at = ? WHERE id = ?",
      ).run(`2099-01-0${index + 1}T00:00:00.000Z`, inventoryId);
    }

    const limited = await application.app.inject({
      method: "GET",
      url: "/api/repository-inventories?limit=1",
      headers: serverHeaders(),
    });
    expect(limited.statusCode, limited.body).toBe(200);
    expect(limited.json<{ inventories: Array<{ id: string }> }>().inventories).toEqual([
      expect.objectContaining({ id: second.id }),
    ]);

    const unrelated = await persistInventory(application, inventory("newer-unrelated-local", {
      repositoryFingerprint: "b".repeat(64),
      generatedAt: "2026-07-21T04:00:00.000Z",
    }), ENGINEER_IDENTITY);
    application.database.sqlite.prepare(
      "UPDATE repository_inventories SET created_at = '2098-12-31T00:00:00.000Z' WHERE id = ?",
    ).run(unrelated.id);

    const filtered = await application.app.inject({
      method: "GET",
      url: `/api/repository-inventories?repositoryFingerprint=${sharedFingerprint}&limit=1`,
      headers: serverHeaders(),
    });
    expect(filtered.statusCode, filtered.body).toBe(200);
    expect(filtered.json<{ inventories: Array<{ id: string; repositoryFingerprint: string }> }>().inventories)
      .toEqual([expect.objectContaining({ id: second.id, repositoryFingerprint: sharedFingerprint })]);

    expect(application.database.sqlite.prepare(
      "SELECT status FROM repository_inventories WHERE id = ?",
    ).get(first.id)).toEqual({ status: "superseded" });
    expect(application.database.sqlite.prepare(
      "SELECT status FROM repository_inventories WHERE id = ?",
    ).get(second.id)).toEqual({ status: "active" });
    expect(application.database.sqlite.prepare(
      "SELECT status FROM repository_inventories WHERE id = ?",
    ).get(foreignShared.id)).toEqual({ status: "active" });
    for (const marker of foreign.markers) {
      expect(limited.body).not.toContain(marker);
      expect(filtered.body).not.toContain(marker);
    }
  });

  it("rejects project-scoped inventory grants before validation or lookup and revokes them immediately", async () => {
    const fixture = await createFixture("scoped_agent");
    const { application, foreign } = fixture;
    const localInventory = application.handoffs.persistRepositoryInventory("local", inventory("scoped-local"));
    const challenge = application.enterprise.createAgentConnection("local", {
      adapter: "codex",
      displayName: "Project-scoped repository inventory agent",
      scopes: ["workspace:inventory:read", "workspace:inventory:write"],
      projectIds: [fixture.localDesignId],
      expiresInSeconds: 3_600,
    });
    const paired = application.enterprise.pairAgentConnection(challenge.nonce);
    const hidden = [
      ...foreign.markers,
      foreign.inventory.id,
      PRIVATE_PATH,
      PRIVATE_TOKEN,
      paired.grant.token,
    ];

    const activeContext = await application.app.inject({
      method: "GET",
      url: "/api/agent-authorization-context",
      headers: grantHeaders(paired.grant.token),
    });
    expect(activeContext.statusCode, activeContext.body).toBe(200);
    expect(activeContext.json()).toEqual({
      role: "agent",
      scopes: ["workspace:inventory:read", "workspace:inventory:write"],
      projectIds: [fixture.localDesignId],
    });

    const before = inventoryState(application);
    const denied = [
      () => application.handoffs.listRepositoryInventories(paired.grant.actorId, { limit: 0 }),
      () => application.handoffs.readRepositoryInventory(paired.grant.actorId, foreign.inventory.id),
      () => application.handoffs.persistRepositoryInventory(paired.grant.actorId, {
        repositoryRoot: PRIVATE_PATH,
        accessToken: PRIVATE_TOKEN,
      }),
      () => application.handoffs.revokeRepositoryInventory(paired.grant.actorId, localInventory.id),
    ];
    for (const callback of denied) {
      expectHiddenDomainError(captureDomainError(callback), 403, "FORBIDDEN", hidden);
    }
    expect(inventoryState(application)).toEqual(before);

    application.enterprise.revokeAgentConnection("local", challenge.connection.id);
    const revokedContext = await application.app.inject({
      method: "GET",
      url: "/api/agent-authorization-context",
      headers: grantHeaders(paired.grant.token),
    });
    expectError(revokedContext, 401, "AUTH_REQUIRED", hidden);

    for (const callback of denied) {
      expectHiddenDomainError(captureDomainError(callback), 401, "AUTH_REQUIRED", hidden);
    }
    expect(inventoryState(application)).toEqual(before);
  });
});
