import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { loadConfig } from "./config.js";
import { DomainError } from "./errors.js";

const PROXY_SECRET = "core-design-catalog-proxy-secret-0123456789abcdef";
const PUBLIC_ORIGIN = "https://design.example.test";
const ADMIN_IDENTITY = "core-design-catalog-admin@example.test";
const PRODUCT_MANAGER_IDENTITY = "core-design-catalog-pm@example.test";
const VIEWER_IDENTITY = "core-design-catalog-viewer@example.test";
const ADMIN_ACTOR = `trusted:${ADMIN_IDENTITY}`;
const VIEWER_ACTOR = `trusted:${VIEWER_IDENTITY}`;
const PRIVATE_MARKER = "CORE_DESIGN_CATALOG_PRIVATE_6f91a2";
const PRIVATE_PATH = "/Users/private/company/formaspec/catalog.json";
const PRIVATE_TOKEN = "fsg_core_design_catalog_private_token_7d8f31";
const DENIED_PROJECT_MARKER = "CORE_DESIGN_DENIED_PROJECT_PRIVATE_d11b93";
const FOREIGN_PROJECT_MARKER = "CORE_DESIGN_FOREIGN_PROJECT_PRIVATE_48ec2a";
const FOREIGN_PRIVATE_PATH = "/srv/foreign-company/formaspec/private-project.json";
const FOREIGN_PRIVATE_TOKEN = "fsg_foreign_core_design_private_token_82a913";

const applications: DesignerApplication[] = [];
const temporaryDirectories: string[] = [];

interface DesignFixture {
  id: string;
  pageId: string;
  frameId: string;
  name: string;
}

interface GrantFixture {
  actorId: string;
  token: string;
}

interface Fixture {
  application: DesignerApplication;
  allowed: DesignFixture;
  denied: DesignFixture;
  foreign: DesignFixture;
  foreignGrant: GrantFixture;
  restrictedGrant: GrantFixture;
  scopeDeniedGrant: GrantFixture;
  unrestrictedWriterGrant: GrantFixture;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(applications.splice(0).map((application) => application.app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.promises.rm(directory, { recursive: true, force: true })
  )));
});

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
    authorization: `Bearer ${PRIVATE_TOKEN}`,
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

async function serverApplication(label: string): Promise<DesignerApplication> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `formaspec-core-design-catalog-auth-${label}-`));
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
    DESIGNER_TOKEN: "core-design-catalog-bootstrap-token-0001",
    FORMASPEC_TRUSTED_PROXIES: "127.0.0.1",
    FORMASPEC_PROXY_SECRET: PROXY_SECRET,
    DESIGNER_CORS_ORIGINS: PUBLIC_ORIGIN,
    DESIGNER_LOG_LEVEL: "silent",
  }));
  applications.push(application);
  await application.app.ready();
  return application;
}

async function warmIdentity(application: DesignerApplication, identity: string): Promise<void> {
  const response = await application.app.inject({
    method: "GET",
    url: "/api/designs",
    headers: serverHeaders(identity),
  });
  expect(response.statusCode, response.body).toBe(200);
}

function installGrant(application: DesignerApplication, input: {
  id: string;
  organizationId?: string;
  projectIds: string[];
  scopes: string[];
}): GrantFixture {
  const organizationId = input.organizationId ?? "organization_legacy";
  const principalId = `principal_${input.id}`;
  const connectionId = `connection_${input.id}`;
  const token = `fsg_${input.id}_secret_93d7c1`;
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 3_600_000).toISOString();

  application.database.sqlite.prepare(
    "INSERT OR IGNORE INTO organizations (id, name, config_json, created_at, updated_at) VALUES (?, ?, '{}', ?, ?)",
  ).run(organizationId, `Core design catalog organization ${input.id}`, createdAt, createdAt);
  application.database.sqlite.prepare(
    `INSERT INTO principals (id, organization_id, kind, display_name, external_id, created_at)
     VALUES (?, ?, 'agent', ?, ?, ?)`,
  ).run(principalId, organizationId, input.id, `core-design-catalog:${input.id}`, createdAt);
  application.database.sqlite.prepare(
    "INSERT INTO memberships (organization_id, principal_id, role, created_at) VALUES (?, ?, 'agent', ?)",
  ).run(organizationId, principalId, createdAt);
  application.database.sqlite.prepare(
    `INSERT INTO agent_connections
     (id, organization_id, principal_id, adapter, display_name, status, scopes_json, project_ids_json,
      expires_at, created_at, updated_at)
     VALUES (?, ?, ?, 'generic_mcp', ?, 'active', ?, ?, ?, ?, ?)`,
  ).run(
    connectionId,
    organizationId,
    principalId,
    input.id,
    JSON.stringify(input.scopes),
    JSON.stringify(input.projectIds),
    expiresAt,
    createdAt,
    createdAt,
  );
  application.database.sqlite.prepare(
    `INSERT INTO agent_grants
     (id, organization_id, principal_id, token_hash, scopes_json, project_ids_json, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    organizationId,
    principalId,
    createHash("sha256").update(token).digest("hex"),
    JSON.stringify(input.scopes),
    JSON.stringify(input.projectIds),
    createdAt,
    expiresAt,
  );
  return { actorId: `grant_${input.id}`, token };
}

function createDesign(
  application: DesignerApplication,
  actorId: string,
  label: string,
  name: string,
): DesignFixture {
  const created = application.service.createDesign(actorId, {
    name,
    preset: "web",
    idempotencyKey: `core-design-catalog-${label}-0001`,
  });
  return {
    id: created.document.id,
    pageId: created.document.pages[0]!.id,
    frameId: created.document.pages[0]!.children[0]!,
    name,
  };
}

async function createFixture(label: string): Promise<Fixture> {
  const application = await serverApplication(label);
  await warmIdentity(application, ADMIN_IDENTITY);
  const current = application.policies.read(ADMIN_ACTOR);
  const policy = structuredClone(current.policy);
  policy.identity.roleMappings = [
    { claim: "identity", value: ADMIN_IDENTITY, role: "organization_admin" },
    { claim: "identity", value: PRODUCT_MANAGER_IDENTITY, role: "product_manager" },
    { claim: "identity", value: VIEWER_IDENTITY, role: "viewer" },
  ];
  application.policies.update(ADMIN_ACTOR, {
    expectedConfigurationHash: current.configurationHash,
    policy,
  });
  await warmIdentity(application, PRODUCT_MANAGER_IDENTITY);
  await warmIdentity(application, VIEWER_IDENTITY);

  const allowed = createDesign(application, "local", `${label}-allowed`, "Allowed core catalog project");
  const denied = createDesign(
    application,
    "local",
    `${label}-denied`,
    `Denied ${DENIED_PROJECT_MARKER}`,
  );
  const foreignGrant = installGrant(application, {
    id: `core_design_catalog_foreign_${label}`,
    organizationId: `organization_core_design_catalog_foreign_${label}`,
    projectIds: [],
    scopes: ["design:read", "design:write"],
  });
  const foreign = createDesign(
    application,
    foreignGrant.actorId,
    `${label}-foreign`,
    `Foreign ${FOREIGN_PROJECT_MARKER} ${FOREIGN_PRIVATE_PATH} ${FOREIGN_PRIVATE_TOKEN}`,
  );
  const restrictedGrant = installGrant(application, {
    id: `core_design_catalog_restricted_${label}`,
    projectIds: [allowed.id],
    scopes: ["design:read", "design:write"],
  });
  const scopeDeniedGrant = installGrant(application, {
    id: `core_design_catalog_scope_denied_${label}`,
    projectIds: [allowed.id],
    scopes: ["task:read"],
  });
  const unrestrictedWriterGrant = installGrant(application, {
    id: `core_design_catalog_writer_${label}`,
    projectIds: [],
    scopes: ["design:read", "design:write"],
  });
  return {
    application,
    allowed,
    denied,
    foreign,
    foreignGrant,
    restrictedGrant,
    scopeDeniedGrant,
    unrestrictedWriterGrant,
  };
}

function catalogState(application: DesignerApplication): unknown {
  return {
    designs: application.database.sqlite.prepare(
      "SELECT id, actor_id, name, current_version, current_revision_id, organization_id FROM designs ORDER BY id",
    ).all(),
    revisions: application.database.sqlite.prepare(
      `SELECT id, design_id, version, parent_revision_id, actor_id, snapshot_hash, operation_hash, revision_hash
       FROM revisions ORDER BY design_id, version`,
    ).all(),
    snapshots: application.database.sqlite.prepare(
      "SELECT snapshot_hash, encoding, uncompressed_bytes, created_at FROM snapshots ORDER BY snapshot_hash",
    ).all(),
    idempotency: application.database.sqlite.prepare(
      "SELECT actor_id, scope, key, request_hash, response_json, expires_at FROM idempotency ORDER BY actor_id, scope, key",
    ).all(),
    contexts: application.database.sqlite.prepare(
      "SELECT actor_id, design_id, page_id, selection_json, organization_id FROM contexts ORDER BY actor_id",
    ).all(),
    audits: application.database.sqlite.prepare(
      "SELECT organization_id, actor_id, action, target_type, target_id, details_json FROM audit_events ORDER BY id",
    ).all(),
    outbox: application.database.sqlite.prepare(
      "SELECT id, organization_id, actor_id, event_type, payload_json, workspace, created_at FROM event_outbox ORDER BY id",
    ).all(),
  };
}

function putContext(
  application: DesignerApplication,
  actorId: string,
  organizationId: string,
  design: DesignFixture,
): void {
  application.database.sqlite.prepare(
    `INSERT INTO contexts (actor_id, design_id, page_id, selection_json, updated_at, organization_id)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(actor_id) DO UPDATE SET
       design_id = excluded.design_id,
       page_id = excluded.page_id,
       selection_json = excluded.selection_json,
       updated_at = excluded.updated_at,
       organization_id = excluded.organization_id`,
  ).run(actorId, design.id, design.pageId, JSON.stringify([design.frameId]), new Date().toISOString(), organizationId);
}

function expectError(
  response: { statusCode: number; body: string; json<T>(): T },
  statusCode: number,
  code: string,
  hidden: string[],
): void {
  expect(response.statusCode, response.body).toBe(statusCode);
  expect(response.json<{ error: { code: string } }>().error.code, response.body).toBe(code);
  for (const value of hidden) expect(response.body).not.toContain(value);
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

describe("core design catalog HTTP authorization", () => {
  it("authorizes exactly four routes before malformed query, path, or body validation and before deeper work", async () => {
    const fixture = await createFixture("ordering");
    const { application } = fixture;
    const encodedPrivatePath = encodeURIComponent(PRIVATE_PATH);
    const hidden = [
      PRIVATE_MARKER,
      PRIVATE_PATH,
      encodedPrivatePath,
      PRIVATE_TOKEN,
      fixture.scopeDeniedGrant.token,
      fixture.restrictedGrant.token,
    ];
    const invalidBody = {
      name: "",
      preset: PRIVATE_MARKER,
      idempotencyKey: PRIVATE_TOKEN,
      privatePath: PRIVATE_PATH,
    };
    const malformedRequests = [
      { method: "GET", url: `/api/designs?limit=${PRIVATE_MARKER}&cursor=${encodedPrivatePath}` },
      { method: "POST", url: "/api/designs", payload: invalidBody },
      { method: "GET", url: `/api/designs/${encodedPrivatePath}?version=${PRIVATE_MARKER}` },
      { method: "GET", url: `/api/context?limit=${PRIVATE_MARKER}&path=${encodedPrivatePath}` },
    ] as const;
    const before = catalogState(application);
    const listDesigns = vi.spyOn(application.service, "listDesigns");
    const createDesignCall = vi.spyOn(application.service, "createDesign");
    const getDesign = vi.spyOn(application.service, "getDesign");
    const getContext = vi.spyOn(application.service, "getContext");
    const cleanupIdempotency = vi.spyOn(application.database, "cleanupIdempotency");
    const cleanupPreviews = vi.spyOn(application.database, "cleanupPreviews");

    for (const request of malformedRequests) {
      const response = await application.app.inject({
        ...request,
        headers: unauthenticatedHeaders(),
      });
      expectError(response, 401, "AUTH_REQUIRED", hidden);
    }

    const viewerDeniedCreate = await application.app.inject({
      ...malformedRequests[1],
      headers: serverHeaders(VIEWER_IDENTITY),
    });
    expectError(viewerDeniedCreate, 403, "FORBIDDEN", hidden);

    for (const request of malformedRequests) {
      const scopedBearerRejected = await application.app.inject({
        ...request,
        headers: grantHeaders(fixture.scopeDeniedGrant.token),
      });
      expectError(scopedBearerRejected, 401, "AUTH_REQUIRED", hidden);
    }

    for (const callback of [
      () => application.service.authorizeDesignList(fixture.scopeDeniedGrant.actorId),
      () => application.service.authorizeDesignCreation(fixture.scopeDeniedGrant.actorId),
      () => application.service.authorizeDesignRead(fixture.scopeDeniedGrant.actorId, PRIVATE_PATH),
      () => application.service.authorizeContextRead(fixture.scopeDeniedGrant.actorId),
    ]) {
      const error = captureDomainError(callback);
      expect(error).toMatchObject({ statusCode: 403, code: "FORBIDDEN" });
      for (const value of hidden) expect(JSON.stringify(error.toJSON())).not.toContain(value);
    }
    expect(captureDomainError(
      () => application.service.authorizeDesignCreation(fixture.restrictedGrant.actorId),
    )).toMatchObject({ statusCode: 403, code: "FORBIDDEN" });

    expect(listDesigns).not.toHaveBeenCalled();
    expect(createDesignCall).not.toHaveBeenCalled();
    expect(getDesign).not.toHaveBeenCalled();
    expect(getContext).not.toHaveBeenCalled();
    expect(cleanupIdempotency).not.toHaveBeenCalled();
    expect(cleanupPreviews).not.toHaveBeenCalled();
    expect(catalogState(application)).toEqual(before);
  });

  it("keeps foreign-organization and out-of-grant designs and contexts opaque", async () => {
    const fixture = await createFixture("opaque");
    const { application } = fixture;
    const localHidden = [
      fixture.foreign.id,
      fixture.foreign.name,
      FOREIGN_PROJECT_MARKER,
      FOREIGN_PRIVATE_PATH,
      FOREIGN_PRIVATE_TOKEN,
    ];
    const restrictedHidden = [fixture.denied.id, fixture.denied.name, DENIED_PROJECT_MARKER, PRIVATE_MARKER];

    const localList = await application.app.inject({
      method: "GET",
      url: "/api/designs?limit=100",
      headers: serverHeaders(VIEWER_IDENTITY),
    });
    expect(localList.statusCode, localList.body).toBe(200);
    expect(localList.json<{ designs: Array<{ id: string }> }>().designs.map((design) => design.id))
      .toEqual(expect.arrayContaining([fixture.allowed.id, fixture.denied.id]));
    for (const value of localHidden) expect(localList.body).not.toContain(value);

    const restrictedList = application.service.listDesigns(fixture.restrictedGrant.actorId, 100);
    expect(restrictedList.designs.map((design) => design.id))
      .toEqual([fixture.allowed.id]);
    for (const value of restrictedHidden) expect(JSON.stringify(restrictedList)).not.toContain(value);

    const restrictedRead = captureDomainError(
      () => application.service.authorizeDesignRead(fixture.restrictedGrant.actorId, fixture.denied.id),
    );
    expect(restrictedRead).toMatchObject({ statusCode: 404, code: "NOT_FOUND" });
    for (const value of restrictedHidden) expect(JSON.stringify(restrictedRead.toJSON())).not.toContain(value);

    const foreignRead = await application.app.inject({
      method: "GET",
      url: `/api/designs/${fixture.foreign.id}?version=${PRIVATE_MARKER}`,
      headers: serverHeaders(ADMIN_IDENTITY),
    });
    expectError(foreignRead, 404, "NOT_FOUND", localHidden);

    putContext(application, fixture.restrictedGrant.actorId, "organization_legacy", fixture.denied);
    const restrictedContext = captureDomainError(
      () => application.service.getContext(fixture.restrictedGrant.actorId),
    );
    expect(restrictedContext).toMatchObject({ statusCode: 404, code: "NOT_FOUND" });
    for (const value of restrictedHidden) expect(JSON.stringify(restrictedContext.toJSON())).not.toContain(value);

    putContext(application, VIEWER_ACTOR, "organization_legacy", fixture.foreign);
    const foreignContext = await application.app.inject({
      method: "GET",
      url: `/api/context?privateMarker=${PRIVATE_MARKER}`,
      headers: serverHeaders(VIEWER_IDENTITY),
    });
    expectError(foreignContext, 404, "NOT_FOUND", localHidden);
  });

  it("preserves valid trusted-header UI behavior and scoped-agent catalog behavior", async () => {
    const fixture = await createFixture("allowed");
    const { application } = fixture;

    const createdByUi = await application.app.inject({
      method: "POST",
      url: "/api/designs",
      headers: serverHeaders(PRODUCT_MANAGER_IDENTITY),
      payload: {
        name: "Product manager catalog project",
        preset: "phone",
        idempotencyKey: "core-design-catalog-ui-create-0001",
      },
    });
    expect(createdByUi.statusCode, createdByUi.body).toBe(201);
    const uiDocument = createdByUi.json<{ document: { id: string; pages: Array<{ id: string; children: string[] }> } }>().document;

    const uiRead = await application.app.inject({
      method: "GET",
      url: `/api/designs/${uiDocument.id}?version=1`,
      headers: serverHeaders(VIEWER_IDENTITY),
    });
    expect(uiRead.statusCode, uiRead.body).toBe(200);
    expect(uiRead.json<{ document: { id: string } }>().document.id).toBe(uiDocument.id);

    application.service.setContext(VIEWER_ACTOR, {
      designId: uiDocument.id,
      pageId: uiDocument.pages[0]!.id,
      selection: [uiDocument.pages[0]!.children[0]!],
    });
    const uiContext = await application.app.inject({
      method: "GET",
      url: "/api/context",
      headers: serverHeaders(VIEWER_IDENTITY),
    });
    expect(uiContext.statusCode, uiContext.body).toBe(200);
    expect(uiContext.json<{ designId: string; selection: string[] }>() ).toMatchObject({
      designId: uiDocument.id,
      selection: [uiDocument.pages[0]!.children[0]!],
    });

    putContext(application, fixture.restrictedGrant.actorId, "organization_legacy", fixture.allowed);
    const agentContext = application.service.getContext(fixture.restrictedGrant.actorId);
    expect(agentContext).toMatchObject({
      designId: fixture.allowed.id,
      version: 1,
    });

    const agentRead = application.service.getDesign(fixture.restrictedGrant.actorId, fixture.allowed.id);
    expect(agentRead.document.id).toBe(fixture.allowed.id);

    const agentCreated = application.service.createDesign(fixture.unrestrictedWriterGrant.actorId, {
      name: "Scoped agent catalog project",
      preset: "tablet",
      idempotencyKey: "core-design-catalog-agent-create-0001",
    });
    expect(agentCreated.document.name).toBe("Scoped agent catalog project");

    const foreignList = application.service.listDesigns(fixture.foreignGrant.actorId, 100);
    expect(foreignList.designs.map((design) => design.id))
      .toEqual([fixture.foreign.id]);
  });
});
