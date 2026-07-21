import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { loadConfig } from "./config.js";
import { DomainError } from "./errors.js";

const PROXY_SECRET = "core-inspect-restore-render-proxy-secret-0123456789abcdef";
const PUBLIC_ORIGIN = "https://design.example.test";
const ADMIN_IDENTITY = "core-inspect-admin@example.test";
const PRODUCT_MANAGER_IDENTITY = "core-inspect-pm@example.test";
const VIEWER_IDENTITY = "core-inspect-viewer@example.test";
const ADMIN_ACTOR = `trusted:${ADMIN_IDENTITY}`;
const PRIVATE_MARKER = "CORE_INSPECT_RESTORE_RENDER_PRIVATE_81e3c9";
const PRIVATE_PATH = "/Users/private/company/formaspec/revision-inspect.json";
const PRIVATE_TOKEN = "fsg_core_inspect_restore_render_private_1f7a94";
const FOREIGN_MARKER = "CORE_INSPECT_FOREIGN_PRIVATE_5ac2d7";
const FOREIGN_PATH = "/srv/foreign-company/formaspec/immutable-revision.json";
const FOREIGN_TOKEN = "fsg_core_inspect_foreign_private_40d6bf";

const applications: DesignerApplication[] = [];
const temporaryDirectories: string[] = [];

interface DesignFixture {
  id: string;
  pageId: string;
  frameId: string;
  revisionId: string;
  name: string;
}

interface GrantFixture {
  actorId: string;
  token: string;
}

interface Fixture {
  application: DesignerApplication;
  root: string;
  allowed: DesignFixture;
  other: DesignFixture;
  denied: DesignFixture;
  agentProject: DesignFixture;
  foreign: DesignFixture;
  foreignGrant: GrantFixture;
  restrictedGrant: GrantFixture;
  scopeDeniedGrant: GrantFixture;
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

async function serverApplication(label: string): Promise<{ application: DesignerApplication; root: string }> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `formaspec-core-inspect-restore-render-${label}-`));
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
    DESIGNER_TOKEN: "core-inspect-restore-render-bootstrap-token-0001",
    FORMASPEC_TRUSTED_PROXIES: "127.0.0.1",
    FORMASPEC_PROXY_SECRET: PROXY_SECRET,
    DESIGNER_CORS_ORIGINS: PUBLIC_ORIGIN,
    DESIGNER_LOG_LEVEL: "silent",
  }));
  applications.push(application);
  await application.app.ready();
  return { application, root };
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
  const token = `fsg_${input.id}_secret_b3a519`;
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 3_600_000).toISOString();

  application.database.sqlite.prepare(
    "INSERT OR IGNORE INTO organizations (id, name, config_json, created_at, updated_at) VALUES (?, ?, '{}', ?, ?)",
  ).run(organizationId, `Core inspect organization ${input.id}`, createdAt, createdAt);
  application.database.sqlite.prepare(
    `INSERT INTO principals (id, organization_id, kind, display_name, external_id, created_at)
     VALUES (?, ?, 'agent', ?, ?, ?)`,
  ).run(principalId, organizationId, input.id, `core-inspect:${input.id}`, createdAt);
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
    idempotencyKey: `core-inspect-restore-render-${label}-0001`,
  });
  return {
    id: created.document.id,
    pageId: created.document.pages[0]!.id,
    frameId: created.document.pages[0]!.children[0]!,
    revisionId: created.revision.id,
    name,
  };
}

async function createFixture(label: string): Promise<Fixture> {
  const { application, root } = await serverApplication(label);
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

  const allowed = createDesign(application, "local", `${label}-allowed`, "Allowed immutable inspect project");
  const other = createDesign(application, "local", `${label}-other`, "Other local immutable project");
  const denied = createDesign(application, "local", `${label}-denied`, `Denied ${PRIVATE_MARKER}`);
  const agentProject = createDesign(application, "local", `${label}-agent`, "Scoped agent inspect project");
  const foreignGrant = installGrant(application, {
    id: `core_inspect_foreign_${label}`,
    organizationId: `organization_core_inspect_foreign_${label}`,
    projectIds: [],
    scopes: ["design:read", "design:write"],
  });
  const foreign = createDesign(
    application,
    foreignGrant.actorId,
    `${label}-foreign`,
    `Foreign ${FOREIGN_MARKER} ${FOREIGN_PATH} ${FOREIGN_TOKEN}`,
  );
  const restrictedGrant = installGrant(application, {
    id: `core_inspect_restricted_${label}`,
    projectIds: [agentProject.id],
    scopes: ["design:read", "design:write"],
  });
  const scopeDeniedGrant = installGrant(application, {
    id: `core_inspect_scope_denied_${label}`,
    projectIds: [agentProject.id],
    scopes: ["task:read"],
  });
  return {
    application,
    root,
    allowed,
    other,
    denied,
    agentProject,
    foreign,
    foreignGrant,
    restrictedGrant,
    scopeDeniedGrant,
  };
}

async function filesBelow(root: string): Promise<string[]> {
  const result: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute);
      if (entry.isDirectory()) await visit(absolute);
      else result.push(relative);
    }
  };
  await visit(root);
  return result.sort();
}

function immutableState(application: DesignerApplication): unknown {
  return {
    designs: application.database.sqlite.prepare(
      "SELECT id, name, current_version, current_revision_id, updated_at, organization_id FROM designs ORDER BY id",
    ).all(),
    revisions: application.database.sqlite.prepare(
      `SELECT id, design_id, version, parent_revision_id, actor_id, message, snapshot_hash, operation_hash, revision_hash
       FROM revisions ORDER BY design_id, version`,
    ).all(),
    snapshots: application.database.sqlite.prepare(
      "SELECT snapshot_hash, encoding, uncompressed_bytes, created_at FROM snapshots ORDER BY snapshot_hash",
    ).all(),
    idempotency: application.database.sqlite.prepare(
      "SELECT actor_id, scope, key, request_hash, response_json, expires_at FROM idempotency ORDER BY actor_id, scope, key",
    ).all(),
    renderJobs: application.database.sqlite.prepare(
      `SELECT id, organization_id, design_id, revision_id, document_id, document_revision, scope_kind,
              operation, kind, status, request_hash, request_metadata_json, output_sha256, error_code
       FROM render_jobs ORDER BY id`,
    ).all(),
    audits: application.database.sqlite.prepare(
      "SELECT organization_id, actor_id, action, target_type, target_id, details_json FROM audit_events ORDER BY id",
    ).all(),
    outbox: application.database.sqlite.prepare(
      "SELECT id, organization_id, actor_id, event_type, payload_json, workspace, created_at FROM event_outbox ORDER BY id",
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

describe("core inspect, restore, export, and render HTTP authorization", () => {
  it("authorizes exactly four routes before parsing, restore cleanup, revision lookup, rendering, or serialization", async () => {
    const fixture = await createFixture("ordering");
    const { application } = fixture;
    const encodedPrivatePath = encodeURIComponent(PRIVATE_PATH);
    const invalidRestore = {
      targetVersion: PRIVATE_MARKER,
      expectedBaseVersion: PRIVATE_MARKER,
      idempotencyKey: PRIVATE_TOKEN,
      privatePath: PRIVATE_PATH,
    };
    const malformedRequests = [
      {
        method: "GET",
        url: `/api/projects/${encodedPrivatePath}/revisions/${PRIVATE_MARKER}/inspect?path=${encodedPrivatePath}`,
      },
      { method: "POST", url: `/api/designs/${encodedPrivatePath}/restore`, payload: invalidRestore },
      { method: "GET", url: `/api/designs/${encodedPrivatePath}/export?version=${PRIVATE_MARKER}` },
      {
        method: "GET",
        url: `/api/designs/${encodedPrivatePath}/render.png?version=${PRIVATE_MARKER}&maxSize=${PRIVATE_MARKER}`,
      },
    ] as const;
    const hidden = [
      PRIVATE_MARKER,
      PRIVATE_PATH,
      encodedPrivatePath,
      PRIVATE_TOKEN,
      fixture.scopeDeniedGrant.token,
      fixture.restrictedGrant.token,
      fixture.foreignGrant.token,
    ];
    const before = immutableState(application);
    const beforeFiles = await filesBelow(fixture.root);
    const getDesign = vi.spyOn(application.service, "getDesign");
    const restoreRevision = vi.spyOn(application.service, "restoreRevision");
    const render = vi.spyOn(application.renderer, "render");
    const cleanupIdempotency = vi.spyOn(application.database, "cleanupIdempotency");
    const cleanupPreviews = vi.spyOn(application.database, "cleanupPreviews");

    for (const request of malformedRequests) {
      const response = await application.app.inject({ ...request, headers: unauthenticatedHeaders() });
      expectError(response, 401, "AUTH_REQUIRED", hidden);
    }

    for (const request of malformedRequests) {
      const response = await application.app.inject({
        ...request,
        headers: grantHeaders(fixture.scopeDeniedGrant.token),
      });
      expectError(response, 401, "AUTH_REQUIRED", hidden);
    }

    const viewerRestore = await application.app.inject({
      ...malformedRequests[1],
      headers: serverHeaders(VIEWER_IDENTITY),
    });
    expectError(viewerRestore, 403, "FORBIDDEN", hidden);
    for (const request of [malformedRequests[0], malformedRequests[2], malformedRequests[3]]) {
      const response = await application.app.inject({ ...request, headers: serverHeaders(VIEWER_IDENTITY) });
      expectError(response, 404, "NOT_FOUND", hidden);
    }

    for (const callback of [
      () => application.service.authorizeDesignRead(fixture.scopeDeniedGrant.actorId, PRIVATE_PATH),
      () => application.service.authorizeDesignRestore(fixture.scopeDeniedGrant.actorId, PRIVATE_PATH),
    ]) {
      const error = captureDomainError(callback);
      expect(error).toMatchObject({ statusCode: 403, code: "FORBIDDEN" });
      for (const value of hidden) expect(JSON.stringify(error.toJSON())).not.toContain(value);
    }
    for (const callback of [
      () => application.service.authorizeDesignRead(fixture.restrictedGrant.actorId, fixture.denied.id),
      () => application.service.authorizeDesignRestore(fixture.restrictedGrant.actorId, fixture.denied.id),
    ]) {
      const error = captureDomainError(callback);
      expect(error).toMatchObject({ statusCode: 404, code: "NOT_FOUND" });
      expect(JSON.stringify(error.toJSON())).not.toContain(fixture.denied.id);
      expect(JSON.stringify(error.toJSON())).not.toContain(fixture.denied.name);
    }

    const foreignHidden = [
      ...hidden,
      fixture.foreign.id,
      fixture.foreign.revisionId,
      fixture.foreign.name,
      FOREIGN_MARKER,
      FOREIGN_PATH,
      FOREIGN_TOKEN,
    ];
    for (const request of [
      {
        method: "GET",
        url: `/api/projects/${fixture.foreign.id}/revisions/${fixture.foreign.revisionId}/inspect?path=${PRIVATE_MARKER}`,
      },
      { method: "POST", url: `/api/designs/${fixture.foreign.id}/restore`, payload: invalidRestore },
      { method: "GET", url: `/api/designs/${fixture.foreign.id}/export?version=${PRIVATE_MARKER}` },
      {
        method: "GET",
        url: `/api/designs/${fixture.foreign.id}/render.png?version=${PRIVATE_MARKER}&maxSize=${PRIVATE_MARKER}`,
      },
    ] as const) {
      const response = await application.app.inject({ ...request, headers: serverHeaders(ADMIN_IDENTITY) });
      expectError(response, 404, "NOT_FOUND", foreignHidden);
    }

    expect(getDesign).not.toHaveBeenCalled();
    expect(restoreRevision).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
    expect(cleanupIdempotency).not.toHaveBeenCalled();
    expect(cleanupPreviews).not.toHaveBeenCalled();
    expect(immutableState(application)).toEqual(before);
    expect(await filesBelow(fixture.root)).toEqual(beforeFiles);
  });

  it("keeps swapped project and revision IDs opaque without state, render, or filesystem side effects", async () => {
    const fixture = await createFixture("swapped");
    const { application } = fixture;
    const before = immutableState(application);
    const beforeFiles = await filesBelow(fixture.root);
    const render = vi.spyOn(application.renderer, "render");
    const hidden = [
      fixture.allowed.id,
      fixture.allowed.revisionId,
      fixture.other.id,
      fixture.other.revisionId,
      fixture.foreign.id,
      fixture.foreign.revisionId,
      FOREIGN_MARKER,
      FOREIGN_PATH,
      FOREIGN_TOKEN,
    ];

    for (const [projectId, revisionId] of [
      [fixture.allowed.id, fixture.other.revisionId],
      [fixture.other.id, fixture.allowed.revisionId],
      [fixture.allowed.id, fixture.foreign.revisionId],
      [fixture.foreign.id, fixture.allowed.revisionId],
    ] as const) {
      const response = await application.app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/revisions/${revisionId}/inspect`,
        headers: serverHeaders(ADMIN_IDENTITY),
      });
      expectError(response, 404, "NOT_FOUND", hidden);
    }

    expect(render).not.toHaveBeenCalled();
    expect(immutableState(application)).toEqual(before);
    expect(await filesBelow(fixture.root)).toEqual(beforeFiles);
  });

  it("preserves valid trusted-header UI and scoped-agent inspect, restore, export, and render behavior", async () => {
    const fixture = await createFixture("allowed");
    const { application } = fixture;
    const inspect = await application.app.inject({
      method: "GET",
      url: `/api/projects/${fixture.allowed.id}/revisions/${fixture.allowed.revisionId}/inspect`,
      headers: serverHeaders(VIEWER_IDENTITY),
    });
    expect(inspect.statusCode, inspect.body).toBe(200);
    expect(inspect.json<{
      project: { id: string; revisionId: string };
      integrity: { revisionId: string; documentRevision: number };
    }>() ).toMatchObject({
      project: { id: fixture.allowed.id, revisionId: fixture.allowed.revisionId },
      integrity: { revisionId: fixture.allowed.revisionId, documentRevision: 1 },
    });

    const exported = await application.app.inject({
      method: "GET",
      url: `/api/designs/${fixture.allowed.id}/export?version=1`,
      headers: serverHeaders(VIEWER_IDENTITY),
    });
    expect(exported.statusCode, exported.body).toBe(200);
    expect(exported.headers["content-disposition"]).toContain(`${fixture.allowed.id}-v1.json`);
    expect(exported.json<{ id: string; revision: number }>()).toMatchObject({
      id: fixture.allowed.id,
      revision: 1,
    });

    const renderedPng = Buffer.from("89504e470d0a1a0a", "hex");
    const render = vi.spyOn(application.renderer, "render").mockResolvedValue({
      png: renderedPng,
      width: 1200,
      height: 800,
      renderer: "playwright",
      warnings: [],
    });
    const rendered = await application.app.inject({
      method: "GET",
      url: `/api/designs/${fixture.allowed.id}/render.png?version=1&maxSize=512&pageId=${fixture.allowed.pageId}&nodeId=${fixture.allowed.frameId}`,
      headers: serverHeaders(VIEWER_IDENTITY),
    });
    expect(rendered.statusCode, rendered.body).toBe(200);
    expect(rendered.headers["content-type"]).toContain("image/png");
    expect(rendered.rawPayload).toEqual(renderedPng);
    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({ id: fixture.allowed.id, revision: 1 }),
      {
        pageId: fixture.allowed.pageId,
        nodeId: fixture.allowed.frameId,
        maxSize: 512,
      },
      expect.any(Function),
    );

    const updated = application.service.applyRevision(ADMIN_ACTOR, fixture.allowed.id, {
      baseVersion: 1,
      operations: [{
        type: "update_node",
        node_id: fixture.allowed.frameId,
        patch: { name: "Revision before restore" },
      }],
      idempotencyKey: "core-inspect-restore-ui-update-0001",
    });
    expect(updated.revision.version).toBe(2);
    const restored = await application.app.inject({
      method: "POST",
      url: `/api/designs/${fixture.allowed.id}/restore`,
      headers: serverHeaders(PRODUCT_MANAGER_IDENTITY),
      payload: {
        targetVersion: 1,
        expectedBaseVersion: 2,
        idempotencyKey: "core-inspect-restore-ui-restore-0001",
      },
    });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(restored.json<{ version: number; restore: { targetVersion: number } }>() ).toMatchObject({
      version: 3,
      restore: { targetVersion: 1 },
    });

    const agentUpdated = application.service.applyRevision(
      fixture.restrictedGrant.actorId,
      fixture.agentProject.id,
      {
        baseVersion: 1,
        operations: [{
          type: "update_node",
          node_id: fixture.agentProject.frameId,
          patch: { name: "Scoped agent revision before restore" },
        }],
        idempotencyKey: "core-inspect-restore-agent-update-0001",
      },
    );
    expect(agentUpdated.revision.version).toBe(2);
    const agentRestored = application.service.restoreRevision(
      fixture.restrictedGrant.actorId,
      fixture.agentProject.id,
      {
        targetVersion: 1,
        expectedBaseVersion: 2,
        idempotencyKey: "core-inspect-restore-agent-restore-0001",
      },
    );
    expect(agentRestored.revision.version).toBe(3);
    expect(agentRestored.restore.targetVersion).toBe(1);
    const agentHistorical = application.service.getDesign(
      fixture.restrictedGrant.actorId,
      fixture.agentProject.id,
      1,
    );
    expect(agentHistorical.canonicalDocument).toMatchObject({
      id: fixture.agentProject.id,
      revision: 1,
    });
    application.service.authorizeDesignRead(fixture.restrictedGrant.actorId, fixture.agentProject.id);
  });
});
