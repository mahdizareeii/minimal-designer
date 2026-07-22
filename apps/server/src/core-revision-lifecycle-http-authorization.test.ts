import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { loadConfig } from "./config.js";
import type { DesignerDatabase } from "./db/database.js";
import { DomainError } from "./errors.js";
import { encodeRgbaPng } from "./render.js";

const PROXY_SECRET = "core-revision-lifecycle-proxy-secret-0123456789abcdef";
const PUBLIC_ORIGIN = "https://design.example.test";
const ADMIN_IDENTITY = "core-revision-admin@example.test";
const PRODUCT_MANAGER_IDENTITY = "core-revision-pm@example.test";
const EDITOR_IDENTITY = "core-revision-editor@example.test";
const VIEWER_IDENTITY = "core-revision-viewer@example.test";
const ADMIN_ACTOR = `trusted:${ADMIN_IDENTITY}`;
const PRIVATE_MARKER = "CORE_REVISION_LIFECYCLE_PRIVATE_9e42d1";
const PRIVATE_PATH = "/Users/private/company/formaspec/revision-plan.json";
const PRIVATE_TOKEN = "fsg_core_revision_lifecycle_private_token_37a1bc";
const FOREIGN_MARKER = "CORE_REVISION_FOREIGN_PRIVATE_f51d09";
const FOREIGN_PATH = "/srv/foreign-company/formaspec/revision-chain.json";
const FOREIGN_TOKEN = "fsg_core_revision_foreign_token_0fd783";

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
  agentProject: DesignFixture;
  foreign: DesignFixture;
  deniedArchivePreviewId: string;
  foreignArchivePreviewId: string;
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

async function serverApplication(label: string): Promise<DesignerApplication> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `formaspec-core-revision-lifecycle-${label}-`));
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
    DESIGNER_TOKEN: "core-revision-lifecycle-bootstrap-token-0001",
    FORMASPEC_TRUSTED_PROXIES: "127.0.0.1",
    FORMASPEC_PROXY_SECRET: PROXY_SECRET,
    DESIGNER_CORS_ORIGINS: PUBLIC_ORIGIN,
    DESIGNER_LOG_LEVEL: "silent",
  }));
  const renderPng = encodeRgbaPng(24, 16, Buffer.alloc(24 * 16 * 4, 255));
  vi.spyOn(application.renderer, "render").mockResolvedValue({
    png: renderPng,
    width: 24,
    height: 16,
    renderer: "software",
    warnings: ["Deterministic revision lifecycle test renderer."],
  });
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
  const token = `fsg_${input.id}_secret_64a2e1`;
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 3_600_000).toISOString();

  application.database.sqlite.prepare(
    "INSERT OR IGNORE INTO organizations (id, name, config_json, created_at, updated_at) VALUES (?, ?, '{}', ?, ?)",
  ).run(organizationId, `Core revision organization ${input.id}`, createdAt, createdAt);
  application.database.sqlite.prepare(
    `INSERT INTO principals (id, organization_id, kind, display_name, external_id, created_at)
     VALUES (?, ?, 'agent', ?, ?, ?)`,
  ).run(principalId, organizationId, input.id, `core-revision:${input.id}`, createdAt);
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
    idempotencyKey: `core-revision-lifecycle-${label}-0001`,
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
    { claim: "identity", value: EDITOR_IDENTITY, role: "design_editor" },
    { claim: "identity", value: VIEWER_IDENTITY, role: "viewer" },
  ];
  application.policies.update(ADMIN_ACTOR, {
    expectedConfigurationHash: current.configurationHash,
    policy,
  });
  await warmIdentity(application, PRODUCT_MANAGER_IDENTITY);
  await warmIdentity(application, EDITOR_IDENTITY);
  await warmIdentity(application, VIEWER_IDENTITY);

  const allowed = createDesign(application, "local", `${label}-allowed`, "Allowed revision lifecycle project");
  const denied = createDesign(
    application,
    "local",
    `${label}-denied`,
    `Denied revision project ${PRIVATE_MARKER}`,
  );
  const agentProject = createDesign(application, "local", `${label}-agent`, "Scoped agent revision project");
  const foreignGrant = installGrant(application, {
    id: `core_revision_foreign_${label}`,
    organizationId: `organization_core_revision_foreign_${label}`,
    projectIds: [],
    scopes: ["design:read", "design:preview", "design:write"],
  });
  const foreign = createDesign(
    application,
    foreignGrant.actorId,
    `${label}-foreign`,
    `Foreign ${FOREIGN_MARKER} ${FOREIGN_PATH} ${FOREIGN_TOKEN}`,
  );
  const restrictedGrant = installGrant(application, {
    id: `core_revision_restricted_${label}`,
    projectIds: [agentProject.id],
    scopes: ["design:read", "design:preview", "design:write"],
  });
  const scopeDeniedGrant = installGrant(application, {
    id: `core_revision_scope_denied_${label}`,
    projectIds: [agentProject.id],
    scopes: ["task:read"],
  });
  const deniedArchivePreview = application.service.createPreview("local", denied.id, {
    baseVersion: 1,
    operations: [{ type: "archive_nodes", node_ids: [denied.frameId] }],
    kind: "archive",
  });
  const foreignArchivePreview = application.service.createPreview(foreignGrant.actorId, foreign.id, {
    baseVersion: 1,
    operations: [{ type: "archive_nodes", node_ids: [foreign.frameId] }],
    kind: "archive",
  });
  return {
    application,
    allowed,
    denied,
    agentProject,
    foreign,
    deniedArchivePreviewId: deniedArchivePreview.id,
    foreignArchivePreviewId: foreignArchivePreview.id,
    foreignGrant,
    restrictedGrant,
    scopeDeniedGrant,
  };
}

function seedVerifiedBackup(database: DesignerDatabase, id: string, createdAt: string): void {
  const manifest = {
    format: "formaspec-backup",
    formatVersion: 2,
    createdAt,
    databaseSchemaVersion: database.schemaVersion(),
  } as const;
  const verification = {
    valid: true,
    manifest,
    sqliteIntegrity: "ok",
    foreignKeyViolations: 0,
    extractedBytes: 1,
    entryCount: 1,
  };
  database.sqlite.prepare(
    `INSERT INTO backup_records
     (id, organization_id, filename, bundle_sha256, status, manifest_json, created_by, created_at, verified_at,
      size_bytes, verification_json, retention_class, completed_at)
     VALUES (?, 'organization_legacy', 'core-revision-migration.tar', ?, 'valid', ?, 'principal_local', ?, ?, 1, ?, 'manual', ?)`,
  ).run(
    id,
    "a".repeat(64),
    JSON.stringify(manifest),
    createdAt,
    createdAt,
    JSON.stringify(verification),
    createdAt,
  );
}

function lifecycleState(application: DesignerApplication): unknown {
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
    previews: application.database.sqlite.prepare(
      `SELECT id, organization_id, design_id, actor_id, status, kind, committed_revision_id, committed_at,
              expires_at, committable, operation_hash, result_snapshot_hash
       FROM previews ORDER BY id`,
    ).all(),
    idempotency: application.database.sqlite.prepare(
      "SELECT actor_id, scope, key, request_hash, response_json, expires_at FROM idempotency ORDER BY actor_id, scope, key",
    ).all(),
    backups: application.database.sqlite.prepare(
      `SELECT id, organization_id, filename, bundle_sha256, status, manifest_json, verification_json,
              created_at, verified_at, completed_at
       FROM backup_records ORDER BY id`,
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

describe("core revision lifecycle HTTP authorization", () => {
  it("authorizes exactly four routes before malformed input and any lifecycle, backup, cleanup, or mutation work", async () => {
    const fixture = await createFixture("ordering");
    const { application } = fixture;
    const encodedPrivatePath = encodeURIComponent(PRIVATE_PATH);
    const invalidWrite = {
      expectedBaseVersion: PRIVATE_MARKER,
      baseVersion: PRIVATE_MARKER,
      backupId: PRIVATE_PATH,
      operations: [{ type: PRIVATE_MARKER, token: PRIVATE_TOKEN }],
      idempotencyKey: PRIVATE_TOKEN,
      message: PRIVATE_PATH,
      taskId: PRIVATE_MARKER,
    };
    const malformedRequests = [
      {
        method: "POST",
        url: `/api/designs/${encodedPrivatePath}/archive-previews/${encodedPrivatePath}/commit`,
        payload: invalidWrite,
      },
      { method: "POST", url: `/api/designs/${encodedPrivatePath}/revisions`, payload: invalidWrite },
      { method: "POST", url: `/api/designs/${encodedPrivatePath}/migrations/v2`, payload: invalidWrite },
      { method: "GET", url: `/api/designs/${encodedPrivatePath}/history?limit=${PRIVATE_MARKER}` },
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
    const before = lifecycleState(application);
    const commitPreview = vi.spyOn(application.service, "commitPreview");
    const applyRevision = vi.spyOn(application.service, "applyRevision");
    const migrateDesign = vi.spyOn(application.service, "migrateDesignHeadToV2");
    const history = vi.spyOn(application.service, "history");
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

    for (const [request, identity] of [
      [malformedRequests[0], VIEWER_IDENTITY],
      [malformedRequests[1], VIEWER_IDENTITY],
      [malformedRequests[2], PRODUCT_MANAGER_IDENTITY],
    ] as const) {
      const response = await application.app.inject({ ...request, headers: serverHeaders(identity) });
      expectError(response, 403, "FORBIDDEN", hidden);
    }

    for (const callback of [
      () => application.service.authorizePreviewCommit(
        fixture.scopeDeniedGrant.actorId,
        PRIVATE_PATH,
        PRIVATE_PATH,
      ),
      () => application.service.authorizeDesignRevision(fixture.scopeDeniedGrant.actorId, PRIVATE_PATH),
      () => application.service.authorizeDesignMigration(fixture.scopeDeniedGrant.actorId, PRIVATE_PATH),
      () => application.service.authorizeDesignRead(fixture.scopeDeniedGrant.actorId, PRIVATE_PATH),
    ]) {
      const error = captureDomainError(callback);
      expect(error).toMatchObject({ statusCode: 403, code: "FORBIDDEN" });
      for (const value of hidden) expect(JSON.stringify(error.toJSON())).not.toContain(value);
    }

    for (const callback of [
      () => application.service.authorizePreviewCommit(
        fixture.restrictedGrant.actorId,
        fixture.denied.id,
        fixture.deniedArchivePreviewId,
      ),
      () => application.service.authorizeDesignRevision(fixture.restrictedGrant.actorId, fixture.denied.id),
      () => application.service.authorizeDesignRead(fixture.restrictedGrant.actorId, fixture.denied.id),
    ]) {
      const error = captureDomainError(callback);
      expect(error).toMatchObject({ statusCode: 404, code: "NOT_FOUND" });
      expect(JSON.stringify(error.toJSON())).not.toContain(fixture.denied.id);
      expect(JSON.stringify(error.toJSON())).not.toContain(fixture.denied.name);
    }
    expect(captureDomainError(
      () => application.service.authorizeDesignMigration(fixture.restrictedGrant.actorId, fixture.denied.id),
    )).toMatchObject({ statusCode: 403, code: "FORBIDDEN" });

    const foreignHidden = [
      ...hidden,
      fixture.foreign.id,
      fixture.foreign.name,
      fixture.foreignArchivePreviewId,
      FOREIGN_MARKER,
      FOREIGN_PATH,
      FOREIGN_TOKEN,
    ];
    for (const request of [
      {
        method: "POST",
        url: `/api/designs/${fixture.foreign.id}/archive-previews/${fixture.foreignArchivePreviewId}/commit`,
        payload: invalidWrite,
      },
      { method: "POST", url: `/api/designs/${fixture.foreign.id}/revisions`, payload: invalidWrite },
      { method: "POST", url: `/api/designs/${fixture.foreign.id}/migrations/v2`, payload: invalidWrite },
      { method: "GET", url: `/api/designs/${fixture.foreign.id}/history?limit=${PRIVATE_MARKER}` },
    ] as const) {
      const response = await application.app.inject({ ...request, headers: serverHeaders(ADMIN_IDENTITY) });
      expectError(response, 404, "NOT_FOUND", foreignHidden);
    }

    expect(commitPreview).not.toHaveBeenCalled();
    expect(applyRevision).not.toHaveBeenCalled();
    expect(migrateDesign).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();
    expect(cleanupIdempotency).not.toHaveBeenCalled();
    expect(cleanupPreviews).not.toHaveBeenCalled();
    expect(lifecycleState(application)).toEqual(before);
  });

  it("preserves valid trusted-header UI and scoped-agent revision lifecycle behavior", async () => {
    const fixture = await createFixture("allowed");
    const { application } = fixture;

    const revised = await application.app.inject({
      method: "POST",
      url: `/api/designs/${fixture.allowed.id}/revisions`,
      headers: serverHeaders(PRODUCT_MANAGER_IDENTITY),
      payload: {
        baseVersion: 1,
        operations: [{
          type: "update_node",
          node_id: fixture.allowed.frameId,
          patch: { name: "Product-approved revision" },
        }],
        idempotencyKey: "core-revision-lifecycle-ui-revision-0001",
        message: "Product manager revision",
      },
    });
    expect(revised.statusCode, revised.body).toBe(200);
    expect(revised.json<{ version: number }>().version).toBe(2);

    const archivePreview = await application.app.inject({
      method: "POST",
      url: `/api/designs/${fixture.allowed.id}/archive-previews`,
      headers: serverHeaders(EDITOR_IDENTITY),
      payload: {
        baseVersion: 2,
        operations: [{ type: "archive_nodes", node_ids: [fixture.allowed.frameId] }],
      },
    });
    expect(archivePreview.statusCode, archivePreview.body).toBe(201);
    const archivePreviewBody = archivePreview.json<{
      previewId: string;
      renderMetadata: { sha256: string; width: number; height: number };
    }>();
    const archivePreviewId = archivePreviewBody.previewId;
    expect(archivePreviewBody.renderMetadata).toMatchObject({
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      width: 24,
      height: 16,
    });
    const exactArchiveRender = await application.app.inject({
      method: "GET",
      url: `/api/designs/${fixture.allowed.id}/previews/${archivePreviewId}/render.png`,
      headers: serverHeaders(EDITOR_IDENTITY),
    });
    expect(exactArchiveRender.statusCode, exactArchiveRender.body).toBe(200);
    expect(exactArchiveRender.headers["content-type"]).toContain("image/png");
    expect(exactArchiveRender.headers["x-formaspec-preview-render-mode"]).toBe("exact");
    expect(exactArchiveRender.headers["x-formaspec-preview-render-sha256"]).toBe(archivePreviewBody.renderMetadata.sha256);
    expect(createHash("sha256").update(exactArchiveRender.rawPayload).digest("hex"))
      .toBe(archivePreviewBody.renderMetadata.sha256);
    const archived = await application.app.inject({
      method: "POST",
      url: `/api/designs/${fixture.allowed.id}/archive-previews/${archivePreviewId}/commit`,
      headers: serverHeaders(EDITOR_IDENTITY),
      payload: {
        expectedBaseVersion: 2,
        idempotencyKey: "core-revision-lifecycle-ui-archive-0001",
        message: "Approved archive",
      },
    });
    expect(archived.statusCode, archived.body).toBe(200);
    expect(archived.json<{ version: number }>().version).toBe(3);

    const history = await application.app.inject({
      method: "GET",
      url: `/api/designs/${fixture.allowed.id}/history?limit=10`,
      headers: serverHeaders(VIEWER_IDENTITY),
    });
    expect(history.statusCode, history.body).toBe(200);
    expect(history.json<{ revisions: Array<{ version: number }> }>().revisions.map((revision) => revision.version))
      .toEqual([3, 2, 1]);

    const head = application.service.getDesign(ADMIN_ACTOR, fixture.allowed.id);
    const backupCreatedAt = new Date(Date.parse(head.design.updatedAt) + 1_000).toISOString();
    const backupId = "backup_core_revision_lifecycle_valid_0001";
    seedVerifiedBackup(application.database, backupId, backupCreatedAt);
    const migrated = await application.app.inject({
      method: "POST",
      url: `/api/designs/${fixture.allowed.id}/migrations/v2`,
      headers: serverHeaders(ADMIN_IDENTITY),
      payload: {
        expectedBaseVersion: 3,
        backupId,
        idempotencyKey: "core-revision-lifecycle-ui-migration-0001",
      },
    });
    expect(migrated.statusCode, migrated.body).toBe(200);
    expect(migrated.json<{ migrated: boolean; version: number; schemaVersion: number }>() ).toMatchObject({
      migrated: true,
      version: 4,
      schemaVersion: 2,
    });

    const agentRevision = application.service.applyRevision(
      fixture.restrictedGrant.actorId,
      fixture.agentProject.id,
      {
        baseVersion: 1,
        operations: [{
          type: "update_node",
          node_id: fixture.agentProject.frameId,
          patch: { name: "Scoped agent revision" },
        }],
        idempotencyKey: "core-revision-lifecycle-agent-revision-0001",
      },
    );
    expect(agentRevision.revision.version).toBe(2);
    const agentArchivePreview = application.service.createPreview(
      fixture.restrictedGrant.actorId,
      fixture.agentProject.id,
      {
        baseVersion: 2,
        operations: [{ type: "archive_nodes", node_ids: [fixture.agentProject.frameId] }],
        kind: "archive",
      },
    );
    const agentArchived = application.service.commitPreview(
      fixture.restrictedGrant.actorId,
      fixture.agentProject.id,
      {
        previewId: agentArchivePreview.id,
        expectedBaseVersion: 2,
        idempotencyKey: "core-revision-lifecycle-agent-archive-0001",
        kind: "archive",
      },
    );
    expect(agentArchived.revision.version).toBe(3);
    expect(application.service.history(fixture.restrictedGrant.actorId, fixture.agentProject.id)
      .map((revision) => revision.version)).toEqual([3, 2, 1]);
    expect(captureDomainError(
      () => application.service.authorizeDesignMigration(
        fixture.restrictedGrant.actorId,
        fixture.agentProject.id,
      ),
    )).toMatchObject({ statusCode: 403, code: "FORBIDDEN" });
  });
});
