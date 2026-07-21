import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DesignDocumentV2Schema, migrateDesignDocumentV1ToV2 } from "@designer/core";
import { afterEach, describe, expect, it } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { resolveAccess } from "./authorization.js";
import { loadConfig } from "./config.js";
import { DomainError } from "./errors.js";
import { operationHash, revisionHash, storeSnapshot } from "./persistence.js";
import { canonicalProductSpecification } from "./product-spec-persistence.js";
import type {
  ImplementationMappingResult,
  RepositoryInventoryResult,
  UploadRepositoryInventory,
} from "./workspace-handoff-service.js";

const PROXY_SECRET = "mapping-http-proxy-secret-0123456789abcdef";
const READER_IDENTITY = "mapping-reader@example.test";
const WRITER_IDENTITY = "mapping-writer@example.test";
const SOURCE_SECRET_MARKER = "/Users/private-company/.env.production::MAPPING_HTTP_SECRET_4f82f3a1";
const DENIED_PROJECT_MARKER = "DENIED_MAPPING_PROJECT_8e6c1440";
const FOREIGN_PROJECT_MARKER = "FOREIGN_MAPPING_PROJECT_5c1d7a03";

interface ExactDesignFixture {
  designId: string;
  revisionId: string;
  componentId: string;
  organizationId: string;
  principalId: string;
}

interface MappingHttpFixture {
  application: DesignerApplication;
  allowed: ExactDesignFixture;
  denied: ExactDesignFixture;
  foreign: ExactDesignFixture;
  allowedMapping: ImplementationMappingResult;
  deniedMapping: ImplementationMappingResult;
  foreignMapping: ImplementationMappingResult;
  foreignSourceMarker: string;
  grant: {
    actorId: string;
    token: string;
    connectionId: string;
  };
}

const applications: DesignerApplication[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.app.close()));
  await Promise.all(temporaryDirectories.splice(0).map(
    (directory) => fs.promises.rm(directory, { recursive: true, force: true }),
  ));
});

function totalChanges(application: DesignerApplication): number {
  return (application.database.sqlite.prepare("SELECT total_changes() AS count").get() as { count: number }).count;
}

function mappingMutationState(application: DesignerApplication): Record<string, unknown[]> {
  return {
    mappings: application.database.sqlite.prepare(
      "SELECT * FROM implementation_mappings ORDER BY id",
    ).all(),
    idempotency: application.database.sqlite.prepare(
      "SELECT * FROM idempotency ORDER BY actor_id, scope, key",
    ).all(),
    auditEvents: application.database.sqlite.prepare(
      "SELECT * FROM audit_events WHERE action LIKE 'implementation_mapping.%' ORDER BY id",
    ).all(),
    outbox: application.database.sqlite.prepare(
      `SELECT id, organization_id, actor_id, event_type, payload_json, workspace, created_at
       FROM event_outbox WHERE event_type = 'implementation_mapping.changed' ORDER BY id`,
    ).all(),
  };
}

function insertExpiredIdempotency(
  application: DesignerApplication,
  actorId: string,
  scope: string,
  key: string,
  hashSeed: string,
): void {
  application.database.sqlite.prepare(
    `INSERT INTO idempotency
     (actor_id, scope, key, request_hash, response_json, created_at, expires_at)
     VALUES (?, ?, ?, ?, '{}', '1999-12-31T23:59:00.000Z', '2000-01-01T00:00:00.000Z')`,
  ).run(actorId, scope, key, hashSeed.repeat(64));
}

function captureDomainError(callback: () => unknown): DomainError {
  try {
    callback();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error("Expected a DomainError.");
}

function trustedHeaders(identity = READER_IDENTITY): Record<string, string> {
  return {
    host: "design.example.com",
    origin: "https://design.example.com",
    "x-formaspec-csrf": "1",
    "x-formaspec-proxy-secret": PROXY_SECRET,
    "x-designer-user": identity,
  };
}

function scopedGrantHeaders(token: string): Record<string, string> {
  return {
    host: "design.example.com",
    authorization: `Bearer ${token}`,
    "x-formaspec-proxy-secret": PROXY_SECRET,
  };
}

function mcpReadMapping(application: DesignerApplication, token: string, mappingId: string) {
  return application.app.inject({
    method: "POST",
    url: "/mcp",
    remoteAddress: "127.0.0.1",
    headers: {
      ...scopedGrantHeaders(token),
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "implementation_mapping_read",
        arguments: { mapping_id: mappingId },
      },
    },
  });
}

function inventory(input: {
  fingerprintHex: string;
  entityHex: string;
  locationHex: string;
  sourceName: string;
}): UploadRepositoryInventory {
  return {
    schemaVersion: 1,
    repositoryFingerprint: input.fingerprintHex.repeat(64),
    generatedAt: "2026-07-21T08:00:00.000Z",
    platforms: ["web"],
    gitHead: "e".repeat(40),
    scannedFileCount: 17,
    skippedFileCount: 4,
    bytesRead: 42_000,
    truncated: false,
    excludedPatterns: [".env", ".env.*", "*.pem", "*.key", "**/secrets/**", "**/.git/**"],
    entities: [{
      id: `inv_${input.entityHex.repeat(40)}`,
      kind: "component",
      name: input.sourceName,
      symbol: "CheckoutButton",
      locationId: `loc_${input.locationHex.repeat(40)}`,
      line: 42,
    }],
    excluded: [
      { category: "secret", count: 3 },
      { category: "generated", count: 5 },
      { category: "symlink", count: 1 },
      { category: "limit", count: 0 },
    ],
  };
}

function createExactV2Design(
  application: DesignerApplication,
  actorId: string,
  label: string,
  name: string,
): ExactDesignFixture {
  const created = application.service.createDesign(actorId, {
    name,
    preset: "web",
    idempotencyKey: `mapping-http-design-${label}-0001`,
  });
  const current = application.service.getDesign(actorId, created.document.id, 1);
  const access = resolveAccess(application.database.sqlite, actorId);
  const migratedAt = "2026-07-21T08:01:00.000Z";
  const migrated = migrateDesignDocumentV1ToV2({
    ...current.canonicalDocument,
    revision: 2,
    updated_at: migratedAt,
  }, {
    migratedAt,
    sourceRevisionId: current.revision.id,
    sourceSnapshotHash: current.revision.snapshotHash,
  });
  const frameId = migrated.pages[0]?.children[0];
  const frame = frameId ? migrated.nodes[frameId] : undefined;
  if (!frameId || !frame || frame.type !== "frame") throw new Error("Expected a migrated web frame.");
  const componentId = `component_mappinghttp_${label}_0001`;
  const document = DesignDocumentV2Schema.parse({
    ...migrated,
    component_definitions: {
      ...migrated.component_definitions,
      [componentId]: {
        id: componentId,
        key: `mapping-http.${label}.checkout-button`,
        name: `${label} checkout button`,
        version: 1,
        status: "published",
        root_node_id: frameId,
        properties_schema: [],
        slots: [],
        states: [{ key: "default", name: "Default", node_id: frameId }],
        allowed_overrides: {
          allow_text: false,
          allow_assets: false,
          allow_icons: false,
          allowed_token_families: [],
          allowed_style_paths: [],
        },
        platform_mappings: [],
        documentation: { summary: "", usage: [], accessibility: [], do_list: [], dont_list: [] },
      },
    },
  });
  const parent = application.database.sqlite.prepare(
    "SELECT revision_hash FROM revisions WHERE id = ?",
  ).get(current.revision.id) as { revision_hash: string };
  const revisionId = `revision_mappinghttp_${label}_0001`;
  const snapshot = storeSnapshot(application.database.sqlite, document, migratedAt);
  const operationsHash = operationHash([]);
  const integrityHash = revisionHash({
    parentRevisionHash: parent.revision_hash,
    snapshotHash: snapshot.hash,
    operationHash: operationsHash,
    metadata: {
      id: revisionId,
      designId: created.document.id,
      version: 2,
      parentRevisionId: current.revision.id,
      actorId: access.principalId,
      message: `Exact ${label} mapping revision`,
      createdAt: migratedAt,
    },
  });
  application.database.sqlite.prepare(
    `INSERT INTO revisions
     (id, design_id, version, parent_revision_id, actor_id, message, document_json, operations_json,
      snapshot_hash, operation_hash, parent_revision_hash, revision_hash, created_at)
     VALUES (?, ?, 2, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?)`,
  ).run(
    revisionId,
    created.document.id,
    current.revision.id,
    access.principalId,
    `Exact ${label} mapping revision`,
    snapshot.canonicalJson,
    snapshot.hash,
    operationsHash,
    parent.revision_hash,
    integrityHash,
    migratedAt,
  );
  application.database.sqlite.prepare(
    "UPDATE designs SET current_version = 2, current_revision_id = ?, updated_at = ? WHERE id = ?",
  ).run(revisionId, migratedAt, created.document.id);

  const linkedSpecification = canonicalProductSpecification({
    ...document.product_specification,
    version: 2,
    summary: `Exact revision-linked product specification for ${label}.`,
  });
  application.database.sqlite.prepare(
    `INSERT INTO product_specifications
     (design_id, version, specification_json, organization_id, specification_hash, message,
      revision_id, actor_id, created_at)
     VALUES (?, 2, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    created.document.id,
    linkedSpecification.json,
    access.organizationId,
    linkedSpecification.hash,
    `Pin the exact ${label} product specification`,
    revisionId,
    access.principalId,
    "2026-07-21T08:02:00.000Z",
  );
  return {
    designId: created.document.id,
    revisionId,
    componentId,
    organizationId: access.organizationId,
    principalId: access.principalId,
  };
}

function createMapping(
  application: DesignerApplication,
  actorId: string,
  design: ExactDesignFixture,
  persistedInventory: RepositoryInventoryResult,
  inventoryEntityId: string,
  idempotencyKey: string,
): ImplementationMappingResult {
  return application.handoffs.createImplementationMappings(actorId, {
    designId: design.designId,
    revisionId: design.revisionId,
    expectedDesignVersion: 2,
    inventoryId: persistedInventory.id,
    idempotencyKey,
    mappings: [{
      entityKind: "component",
      entityId: design.componentId,
      inventoryEntityId,
    }],
  }).mappings[0]!;
}

function installForeignAgent(application: DesignerApplication): { actorId: string; token: string } {
  const organizationId = "organization_mapping_http_foreign";
  const principalId = "principal_mapping_http_foreign";
  const connectionId = "connection_mapping_http_foreign";
  const grantId = "mapping_http_foreign";
  const token = "fsg_mapping_http_foreign_token_00000001";
  const now = "2026-07-21T08:00:00.000Z";
  const expiresAt = "2099-01-01T00:00:00.000Z";
  const scopes = [
    "design:read",
    "design:write",
    "workspace:inventory:read",
    "workspace:inventory:write",
    "implementation_mapping:read",
    "implementation_mapping:write",
  ];
  application.database.sqlite.prepare(
    "INSERT INTO organizations (id, name, config_json, created_at, updated_at) VALUES (?, ?, '{}', ?, ?)",
  ).run(organizationId, "Foreign mapping organization", now, now);
  application.database.sqlite.prepare(
    `INSERT INTO principals (id, organization_id, kind, display_name, external_id, created_at)
     VALUES (?, ?, 'agent', 'Foreign mapping agent', 'foreign:mapping-http', ?)`,
  ).run(principalId, organizationId, now);
  application.database.sqlite.prepare(
    "INSERT INTO memberships (organization_id, principal_id, role, created_at) VALUES (?, ?, 'agent', ?)",
  ).run(organizationId, principalId, now);
  application.database.sqlite.prepare(
    `INSERT INTO agent_connections
     (id, organization_id, principal_id, adapter, display_name, status, scopes_json, project_ids_json,
      expires_at, created_at, updated_at)
     VALUES (?, ?, ?, 'generic_mcp', 'Foreign mapping fixture', 'active', ?, '[]', ?, ?, ?)`,
  ).run(connectionId, organizationId, principalId, JSON.stringify(scopes), expiresAt, now, now);
  application.database.sqlite.prepare(
    `INSERT INTO agent_grants
     (id, organization_id, principal_id, token_hash, scopes_json, project_ids_json, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, '[]', ?, ?)`,
  ).run(
    grantId,
    organizationId,
    principalId,
    createHash("sha256").update(token).digest("hex"),
    JSON.stringify(scopes),
    now,
    expiresAt,
  );
  return { actorId: `grant_${grantId}`, token };
}

async function setupFixture(): Promise<MappingHttpFixture> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "formaspec-mapping-http-"));
  temporaryDirectories.push(root);
  const application = await buildApplication(loadConfig({
    APP_MODE: "server",
    HOST: "0.0.0.0",
    PORT: "4310",
    DATA_DIR: path.join(root, "data"),
    BACKUP_DIR: path.join(root, "backups"),
    DESIGNER_DATABASE_PATH: ":memory:",
    PUBLIC_BASE_URL: "https://design.example.com",
    AUTH_MODE: "trusted-header",
    DESIGNER_TOKEN: "mapping-http-bootstrap-token-0001",
    FORMASPEC_TRUSTED_PROXIES: "127.0.0.1",
    FORMASPEC_PROXY_SECRET: PROXY_SECRET,
    DESIGNER_CORS_ORIGINS: "https://design.example.com",
    DESIGNER_LOG_LEVEL: "silent",
  }));
  applications.push(application);
  await application.app.ready();

  const allowed = createExactV2Design(application, "local", "allowed", "Allowed mapping project");
  const denied = createExactV2Design(application, "local", "denied", DENIED_PROJECT_MARKER);
  const localInventoryInput = inventory({
    fingerprintHex: "c",
    entityHex: "1",
    locationHex: "2",
    sourceName: SOURCE_SECRET_MARKER,
  });
  const localInventory = application.handoffs.persistRepositoryInventory("local", localInventoryInput);
  const localInventoryEntityId = localInventoryInput.entities[0]!.id;
  const allowedMapping = createMapping(
    application,
    "local",
    allowed,
    localInventory,
    localInventoryEntityId,
    "mapping-http-allowed-0001",
  );
  const deniedMapping = createMapping(
    application,
    "local",
    denied,
    localInventory,
    localInventoryEntityId,
    "mapping-http-denied-0001",
  );

  const foreignAgent = installForeignAgent(application);
  const foreign = createExactV2Design(application, foreignAgent.actorId, "foreign", FOREIGN_PROJECT_MARKER);
  const foreignSourceMarker = "/srv/private/.env::FOREIGN_MAPPING_SECRET_84b06d2c";
  const foreignInventoryInput = inventory({
    fingerprintHex: "d",
    entityHex: "3",
    locationHex: "4",
    sourceName: foreignSourceMarker,
  });
  const foreignInventory = application.handoffs.persistRepositoryInventory(
    foreignAgent.actorId,
    foreignInventoryInput,
  );
  const foreignMapping = createMapping(
    application,
    foreignAgent.actorId,
    foreign,
    foreignInventory,
    foreignInventoryInput.entities[0]!.id,
    "mapping-http-foreign-0001",
  );
  expect(application.handoffs.readImplementationMapping(foreignAgent.actorId, foreignMapping.id))
    .toEqual(foreignMapping);

  const policyState = application.policies.read("local");
  const policy = structuredClone(policyState.policy);
  policy.identity.roleMappings = [
    ...policy.identity.roleMappings,
    { claim: "identity", value: READER_IDENTITY, role: "viewer" },
    { claim: "identity", value: WRITER_IDENTITY, role: "design_editor" },
  ];
  application.policies.update("local", {
    expectedConfigurationHash: policyState.configurationHash,
    policy,
  });

  const challenge = application.enterprise.createAgentConnection("local", {
    adapter: "codex",
    displayName: "Project-restricted mapping reader",
    scopes: ["implementation_mapping:read"],
    projectIds: [allowed.designId],
    expiresInSeconds: 3_600,
  });
  const paired = application.enterprise.pairAgentConnection(challenge.nonce);
  return {
    application,
    allowed,
    denied,
    foreign,
    allowedMapping,
    deniedMapping,
    foreignMapping,
    foreignSourceMarker,
    grant: {
      actorId: paired.grant.actorId,
      token: paired.grant.token,
      connectionId: paired.connection.id,
    },
  };
}

describe("GET /api/implementation-mappings/:mappingId authorization", () => {
  it("returns only a path-free exact mapping, hides foreign opaque IDs, and performs no read-side writes", async () => {
    const fixture = await setupFixture();
    const { application } = fixture;
    const warmAuthentication = await application.app.inject({
      method: "GET",
      url: "/api/designs",
      remoteAddress: "127.0.0.1",
      headers: trustedHeaders(),
    });
    expect(warmAuthentication.statusCode).toBe(200);
    const before = totalChanges(application);

    const allowed = await application.app.inject({
      method: "GET",
      url: `/api/implementation-mappings/${fixture.allowedMapping.id}`,
      remoteAddress: "127.0.0.1",
      headers: trustedHeaders(),
    });
    expect(allowed.statusCode).toBe(200);
    const mapping = allowed.json<{ mapping: ImplementationMappingResult }>().mapping;
    expect(mapping).toEqual(fixture.allowedMapping);
    expect(mapping).toMatchObject({
      designId: fixture.allowed.designId,
      revisionId: fixture.allowed.revisionId,
      productSpecificationSource: "revision_link",
      productSpecificationVersion: 2,
      entityKind: "component",
      entityId: fixture.allowed.componentId,
      inventoryEntityKind: "component",
      symbol: "CheckoutButton",
    });
    expect(Object.keys(mapping).sort()).toEqual([
      "createdAt",
      "createdBy",
      "designId",
      "designVersion",
      "entityId",
      "entityKind",
      "id",
      "inventoryEntityId",
      "inventoryEntityKind",
      "inventoryHash",
      "inventoryId",
      "line",
      "locationId",
      "platform",
      "productSpecificationHash",
      "productSpecificationSource",
      "productSpecificationVersion",
      "revisionHash",
      "revisionId",
      "snapshotHash",
      "symbol",
    ]);
    for (const forbidden of [
      SOURCE_SECRET_MARKER,
      "/Users/",
      ".env.production",
      "relativePath",
      "repositoryRoot",
      "sourcePath",
      "repositoryFingerprint",
    ]) {
      expect(allowed.body).not.toContain(forbidden);
    }

    const foreign = await application.app.inject({
      method: "GET",
      url: `/api/implementation-mappings/${fixture.foreignMapping.id}`,
      remoteAddress: "127.0.0.1",
      headers: trustedHeaders(),
    });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json<{ error: { code: string; message: string } }>().error).toEqual(expect.objectContaining({
      code: "NOT_FOUND",
      message: "Implementation mapping not found.",
    }));
    for (const forbidden of [
      fixture.foreign.designId,
      fixture.foreign.revisionId,
      FOREIGN_PROJECT_MARKER,
      fixture.foreignSourceMarker,
    ]) {
      expect(foreign.body).not.toContain(forbidden);
    }

    for (const missingId of [`mapping_${"f".repeat(32)}`, "mapping_invalid_identifier"]) {
      const missing = await application.app.inject({
        method: "GET",
        url: `/api/implementation-mappings/${missingId}`,
        remoteAddress: "127.0.0.1",
        headers: trustedHeaders(),
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json<{ error: { code: string; message: string } }>().error).toEqual(expect.objectContaining({
        code: "NOT_FOUND",
        message: "Implementation mapping not found.",
      }));
    }

    expect(totalChanges(application)).toBe(before);
  });

  it("enforces project restriction in the mapping service and MCP and rejects revocation immediately", async () => {
    const fixture = await setupFixture();
    const { application } = fixture;
    const beforeReads = totalChanges(application);

    expect(application.handoffs.readImplementationMapping(fixture.grant.actorId, fixture.allowedMapping.id))
      .toEqual(fixture.allowedMapping);
    const denied = captureDomainError(() => application.handoffs.readImplementationMapping(
      fixture.grant.actorId,
      fixture.deniedMapping.id,
    ));
    expect(denied).toMatchObject({ code: "NOT_FOUND", statusCode: 404, message: "Design not found." });
    expect(JSON.stringify(denied.toJSON())).not.toContain(DENIED_PROJECT_MARKER);
    expect(JSON.stringify(denied.toJSON())).not.toContain(fixture.denied.designId);

    const foreign = captureDomainError(() => application.handoffs.readImplementationMapping(
      fixture.grant.actorId,
      fixture.foreignMapping.id,
    ));
    expect(foreign).toMatchObject({
      code: "NOT_FOUND",
      statusCode: 404,
      message: "Implementation mapping not found.",
    });
    expect(JSON.stringify(foreign.toJSON())).not.toContain(FOREIGN_PROJECT_MARKER);
    expect(totalChanges(application)).toBe(beforeReads);

    const allowedMcp = await mcpReadMapping(application, fixture.grant.token, fixture.allowedMapping.id);
    expect(allowedMcp.statusCode).toBe(200);
    expect(allowedMcp.json<{
      result: { structuredContent: { ok: boolean; mapping: ImplementationMappingResult } };
    }>().result.structuredContent).toMatchObject({
      ok: true,
      mapping: fixture.allowedMapping,
    });

    const deniedMcp = await mcpReadMapping(application, fixture.grant.token, fixture.deniedMapping.id);
    expect(deniedMcp.statusCode).toBe(200);
    expect(deniedMcp.json<{
      result: { structuredContent: { ok: boolean; error: { code: string; message: string } } };
    }>().result.structuredContent).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND", message: "Design not found." },
    });
    expect(deniedMcp.body).not.toContain(DENIED_PROJECT_MARKER);
    expect(deniedMcp.body).not.toContain(fixture.denied.designId);

    const activeContext = await application.app.inject({
      method: "GET",
      url: "/api/agent-authorization-context",
      remoteAddress: "127.0.0.1",
      headers: scopedGrantHeaders(fixture.grant.token),
    });
    expect(activeContext.statusCode).toBe(200);
    expect(activeContext.json<Record<string, unknown>>()).toEqual({
      role: "agent",
      scopes: ["implementation_mapping:read"],
      projectIds: [fixture.allowed.designId],
    });

    application.enterprise.revokeAgentConnection("local", fixture.grant.connectionId);
    const revokedRead = captureDomainError(() => application.handoffs.readImplementationMapping(
      fixture.grant.actorId,
      fixture.allowedMapping.id,
    ));
    expect(revokedRead).toMatchObject({ code: "AUTH_REQUIRED", statusCode: 401 });

    const revokedContext = await application.app.inject({
      method: "GET",
      url: "/api/agent-authorization-context",
      remoteAddress: "127.0.0.1",
      headers: scopedGrantHeaders(fixture.grant.token),
    });
    expect(revokedContext.statusCode).toBe(401);
    expect(revokedContext.json<{ error: { code: string } }>().error.code).toBe("AUTH_REQUIRED");
    expect(revokedContext.body).not.toContain(fixture.allowedMapping.id);
    expect(revokedContext.body).not.toContain(fixture.allowed.designId);

    const revokedMcp = await mcpReadMapping(application, fixture.grant.token, fixture.allowedMapping.id);
    expect(revokedMcp.statusCode).toBe(401);
    expect(revokedMcp.json<{ error: { code: string } }>().error.code).toBe("AUTH_REQUIRED");
    expect(revokedMcp.body).not.toContain(fixture.allowedMapping.id);
    expect(revokedMcp.body).not.toContain(fixture.allowed.designId);
  });
});

describe("POST /api/designs/:id/implementation-mappings authorization", () => {
  it("scopes expired idempotency cleanup to the exact actor and design-revision operation", async () => {
    const fixture = await setupFixture();
    const { application } = fixture;
    const warmWriter = await application.app.inject({
      method: "GET",
      url: "/api/designs",
      remoteAddress: "127.0.0.1",
      headers: trustedHeaders(WRITER_IDENTITY),
    });
    expect(warmWriter.statusCode, warmWriter.body).toBe(200);
    const writer = resolveAccess(application.database.sqlite, `trusted:${WRITER_IDENTITY}`);
    const allowedScope = `implementation_mapping:${fixture.allowed.designId}:${fixture.allowed.revisionId}:create`;
    const deniedScope = `implementation_mapping:${fixture.denied.designId}:${fixture.denied.revisionId}:create`;
    const foreignScope = `implementation_mapping:${fixture.foreign.designId}:${fixture.foreign.revisionId}:create`;

    insertExpiredIdempotency(
      application,
      writer.principalId,
      allowedScope,
      "mapping-expired-own-exact-scope",
      "1",
    );
    insertExpiredIdempotency(
      application,
      writer.principalId,
      deniedScope,
      "mapping-expired-own-other-project",
      "2",
    );
    insertExpiredIdempotency(
      application,
      fixture.allowed.principalId,
      allowedScope,
      "mapping-expired-other-actor-same-org",
      "3",
    );
    insertExpiredIdempotency(
      application,
      fixture.foreignMapping.createdBy,
      allowedScope,
      "mapping-expired-foreign-actor-allowed-scope",
      "4",
    );
    insertExpiredIdempotency(
      application,
      fixture.foreignMapping.createdBy,
      foreignScope,
      "mapping-expired-foreign-actor-foreign-scope",
      "5",
    );

    const created = await application.app.inject({
      method: "POST",
      url: `/api/designs/${fixture.allowed.designId}/implementation-mappings`,
      remoteAddress: "127.0.0.1",
      headers: trustedHeaders(WRITER_IDENTITY),
      payload: {
        revisionId: fixture.allowed.revisionId,
        expectedDesignVersion: 2,
        inventoryId: fixture.allowedMapping.inventoryId,
        idempotencyKey: "mapping-http-scoped-cleanup-create-0001",
        mappings: [{
          entityKind: "component",
          entityId: fixture.allowed.componentId,
          inventoryEntityId: fixture.allowedMapping.inventoryEntityId,
        }],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json<{ result: { mappings: ImplementationMappingResult[] } }>().result.mappings)
      .toHaveLength(1);
    expect(application.database.sqlite.prepare(
      "SELECT key FROM idempotency WHERE key = 'mapping-expired-own-exact-scope'",
    ).get()).toBeUndefined();
    expect(application.database.sqlite.prepare(
      "SELECT actor_id, scope, key FROM idempotency WHERE key LIKE 'mapping-expired-%' ORDER BY key",
    ).all()).toEqual([
      {
        actor_id: fixture.foreignMapping.createdBy,
        scope: allowedScope,
        key: "mapping-expired-foreign-actor-allowed-scope",
      },
      {
        actor_id: fixture.foreignMapping.createdBy,
        scope: foreignScope,
        key: "mapping-expired-foreign-actor-foreign-scope",
      },
      {
        actor_id: fixture.allowed.principalId,
        scope: allowedScope,
        key: "mapping-expired-other-actor-same-org",
      },
      {
        actor_id: writer.principalId,
        scope: deniedScope,
        key: "mapping-expired-own-other-project",
      },
    ]);
  });

  it("rolls back exact-scope cleanup and every mapping side effect on denied project and foreign writes", async () => {
    const fixture = await setupFixture();
    const { application } = fixture;
    const warmWriter = await application.app.inject({
      method: "GET",
      url: "/api/designs",
      remoteAddress: "127.0.0.1",
      headers: trustedHeaders(WRITER_IDENTITY),
    });
    expect(warmWriter.statusCode, warmWriter.body).toBe(200);
    const writer = resolveAccess(application.database.sqlite, `trusted:${WRITER_IDENTITY}`);
    const challenge = application.enterprise.createAgentConnection("local", {
      adapter: "codex",
      displayName: "Project-restricted mapping writer",
      scopes: ["implementation_mapping:write"],
      projectIds: [fixture.allowed.designId],
      expiresInSeconds: 3_600,
    });
    const paired = application.enterprise.pairAgentConnection(challenge.nonce);
    const grant = resolveAccess(application.database.sqlite, paired.grant.actorId);
    const deniedScope = `implementation_mapping:${fixture.denied.designId}:${fixture.denied.revisionId}:create`;
    const foreignScope = `implementation_mapping:${fixture.foreign.designId}:${fixture.foreign.revisionId}:create`;
    insertExpiredIdempotency(
      application,
      grant.principalId,
      deniedScope,
      "mapping-expired-denied-project-attempt",
      "6",
    );
    insertExpiredIdempotency(
      application,
      writer.principalId,
      foreignScope,
      "mapping-expired-foreign-project-attempt",
      "7",
    );
    const before = mappingMutationState(application);

    const denied = captureDomainError(() => application.handoffs.createImplementationMappings(
      paired.grant.actorId,
      {
        designId: fixture.denied.designId,
        revisionId: fixture.denied.revisionId,
        expectedDesignVersion: 2,
        inventoryId: fixture.allowedMapping.inventoryId,
        idempotencyKey: "mapping-http-denied-project-create-0001",
        mappings: [{
          entityKind: "component",
          entityId: fixture.denied.componentId,
          inventoryEntityId: fixture.allowedMapping.inventoryEntityId,
        }],
      },
    ));
    expect(denied).toMatchObject({ code: "NOT_FOUND", statusCode: 404, message: "Design not found." });
    expect(JSON.stringify(denied.toJSON())).not.toContain(DENIED_PROJECT_MARKER);
    expect(JSON.stringify(denied.toJSON())).not.toContain(fixture.denied.designId);

    const foreign = await application.app.inject({
      method: "POST",
      url: `/api/designs/${fixture.foreign.designId}/implementation-mappings`,
      remoteAddress: "127.0.0.1",
      headers: trustedHeaders(WRITER_IDENTITY),
      payload: {
        revisionId: fixture.foreign.revisionId,
        expectedDesignVersion: 2,
        inventoryId: fixture.foreignMapping.inventoryId,
        idempotencyKey: "mapping-http-foreign-project-create-0001",
        mappings: [{
          entityKind: "component",
          entityId: fixture.foreign.componentId,
          inventoryEntityId: fixture.foreignMapping.inventoryEntityId,
        }],
      },
    });
    expect(foreign.statusCode, foreign.body).toBe(404);
    expect(foreign.json<{ error: { code: string; message: string } }>().error).toEqual(expect.objectContaining({
      code: "NOT_FOUND",
      message: "Design not found.",
    }));
    for (const marker of [
      FOREIGN_PROJECT_MARKER,
      fixture.foreignSourceMarker,
      fixture.foreign.designId,
      fixture.foreign.revisionId,
      fixture.foreignMapping.inventoryId,
    ]) {
      expect(foreign.body).not.toContain(marker);
    }
    expect(mappingMutationState(application)).toEqual(before);
  });
});
