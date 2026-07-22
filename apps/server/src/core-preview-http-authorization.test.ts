import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { loadConfig } from "./config.js";
import { encodeRgbaPng } from "./render.js";

const PROXY_SECRET = "core-preview-http-proxy-secret-0123456789abcdef";
const ADMIN = "core-preview-admin@example.test";
const PM = "core-preview-pm@example.test";
const OTHER_PM = "core-preview-other-pm@example.test";
const VIEWER = "core-preview-viewer@example.test";
const PRIVATE_MARKER = "CORE_PREVIEW_PRIVATE_MARKER_4f6ca8";

const applications: DesignerApplication[] = [];
const temporaryDirectories: string[] = [];

interface DesignFixture {
  id: string;
  frameId: string;
  version: number;
}

interface Fixture {
  application: DesignerApplication;
  allowed: DesignFixture;
  denied: DesignFixture;
  foreign: DesignFixture;
  foreignActorId: string;
}

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.promises.rm(directory, { recursive: true, force: true })
  )));
});

async function serverApplication(label: string): Promise<DesignerApplication> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `formaspec-core-preview-http-${label}-`));
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
    DESIGNER_TOKEN: "core-preview-bootstrap-token-0001",
    FORMASPEC_TRUSTED_PROXIES: "127.0.0.1",
    FORMASPEC_PROXY_SECRET: PROXY_SECRET,
    DESIGNER_CORS_ORIGINS: "https://design.example.test",
    DESIGNER_LOG_LEVEL: "silent",
  }));
  const renderPng = encodeRgbaPng(24, 16, Buffer.alloc(24 * 16 * 4, 255));
  vi.spyOn(application.renderer, "render").mockResolvedValue({
    png: renderPng,
    width: 24,
    height: 16,
    renderer: "software",
    warnings: ["Deterministic preview authorization test renderer."],
  });
  applications.push(application);
  await application.app.ready();
  return application;
}

function headers(identity = PM): Record<string, string> {
  return {
    host: "design.example.test",
    origin: "https://design.example.test",
    "x-formaspec-csrf": "1",
    "x-designer-user": identity,
    "x-formaspec-proxy-secret": PROXY_SECRET,
  };
}

async function warm(application: DesignerApplication, identity: string): Promise<void> {
  const response = await application.app.inject({
    method: "GET",
    url: "/api/designs",
    remoteAddress: "127.0.0.1",
    headers: headers(identity),
  });
  expect(response.statusCode, response.body).toBe(200);
}

function installGrant(application: DesignerApplication, input: {
  id: string;
  organizationId?: string;
  projectIds: string[];
  scopes: string[];
}): { actorId: string; token: string } {
  const organizationId = input.organizationId ?? "organization_legacy";
  const principalId = `principal_${input.id}`;
  const connectionId = `connection_${input.id}`;
  const token = `fsg_${input.id}_CORE_PREVIEW_SECRET_86d1b0`;
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 3_600_000).toISOString();

  application.database.sqlite.prepare(
    "INSERT OR IGNORE INTO organizations (id, name, config_json, created_at, updated_at) VALUES (?, ?, '{}', ?, ?)",
  ).run(organizationId, `Core preview organization ${input.id}`, createdAt, createdAt);
  application.database.sqlite.prepare(
    `INSERT INTO principals (id, organization_id, kind, display_name, external_id, created_at)
     VALUES (?, ?, 'agent', ?, ?, ?)`,
  ).run(principalId, organizationId, input.id, `core-preview:${input.id}`, createdAt);
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
    idempotencyKey: `core-preview-design-${label}-0001`,
  });
  return {
    id: created.document.id,
    frameId: created.document.pages[0]!.children[0]!,
    version: created.design.version,
  };
}

async function setup(label: string): Promise<Fixture> {
  const application = await serverApplication(label);
  await warm(application, ADMIN);
  const current = application.policies.read(`trusted:${ADMIN}`);
  const policy = structuredClone(current.policy);
  policy.identity.roleMappings = [
    { claim: "identity", value: ADMIN, role: "organization_admin" },
    { claim: "identity", value: PM, role: "product_manager" },
    { claim: "identity", value: OTHER_PM, role: "product_manager" },
    { claim: "identity", value: VIEWER, role: "viewer" },
  ];
  application.policies.update(`trusted:${ADMIN}`, {
    expectedConfigurationHash: current.configurationHash,
    policy,
  });
  await Promise.all([warm(application, PM), warm(application, OTHER_PM), warm(application, VIEWER)]);

  const allowed = createDesign(application, "local", `${label}-allowed`, "Allowed core preview project");
  const denied = createDesign(application, "local", `${label}-denied`, "DENIED_CORE_PREVIEW_PROJECT_239eb7");
  const foreignGrant = installGrant(application, {
    id: `core_preview_foreign_${label}`,
    organizationId: `organization_core_preview_foreign_${label}`,
    projectIds: [],
    scopes: ["design:read", "design:preview", "design:write"],
  });
  const foreign = createDesign(
    application,
    foreignGrant.actorId,
    `${label}-foreign`,
    "FOREIGN_CORE_PREVIEW_PROJECT_6b28de",
  );
  return { application, allowed, denied, foreign, foreignActorId: foreignGrant.actorId };
}

function previewState(application: DesignerApplication): Record<string, unknown[]> {
  return {
    designs: application.database.sqlite.prepare(
      "SELECT id, current_version, current_revision_id, updated_at FROM designs ORDER BY id",
    ).all(),
    revisions: application.database.sqlite.prepare("SELECT * FROM revisions ORDER BY design_id, version").all(),
    previews: application.database.sqlite.prepare("SELECT * FROM previews ORDER BY id").all(),
    snapshots: application.database.sqlite.prepare("SELECT * FROM snapshots ORDER BY snapshot_hash").all(),
    idempotency: application.database.sqlite.prepare("SELECT * FROM idempotency ORDER BY actor_id, scope, key").all(),
    auditEvents: application.database.sqlite.prepare("SELECT * FROM audit_events ORDER BY id").all(),
    outbox: application.database.sqlite.prepare("SELECT * FROM event_outbox ORDER BY id").all(),
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

describe("core preview HTTP authorization", () => {
  it("authorizes all four routes before path, body, or query validation without lifecycle mutation", async () => {
    const fixture = await setup("ordering");
    const { application } = fixture;
    const expiring = application.service.createPreview("local", fixture.denied.id, {
      baseVersion: 1,
      operations: [{
        type: "update_node",
        node_id: fixture.denied.frameId,
        patch: { name: "EXPIRED_CORE_PREVIEW_MARKER_7d34fa" },
      }],
    });
    application.database.sqlite.prepare(
      "UPDATE previews SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
    ).run(expiring.id);
    const hidden = [
      PRIVATE_MARKER,
      "EXPIRED_CORE_PREVIEW_MARKER_7d34fa",
      "FOREIGN_CORE_PREVIEW_PROJECT_6b28de",
    ];
    const before = previewState(application);
    const requests = [
      application.app.inject({
        method: "POST",
        url: "/api/designs/%20/previews",
        remoteAddress: "127.0.0.1",
        headers: headers(),
        payload: { privateMarker: PRIVATE_MARKER },
      }),
      application.app.inject({
        method: "GET",
        url: `/api/designs/${fixture.foreign.id}/previews/${expiring.id}?taskId=`,
        remoteAddress: "127.0.0.1",
        headers: headers(),
      }),
      application.app.inject({
        method: "POST",
        url: "/api/designs/%20/previews/%20/commit",
        remoteAddress: "127.0.0.1",
        headers: headers(VIEWER),
        payload: { privateMarker: PRIVATE_MARKER },
      }),
      application.app.inject({
        method: "POST",
        url: "/api/designs/%20/archive-previews",
        remoteAddress: "127.0.0.1",
        headers: headers(),
        payload: { privateMarker: PRIVATE_MARKER },
      }),
    ];
    const [ordinaryCreate, read, commit, archiveCreate] = await Promise.all(requests);
    expectError(ordinaryCreate, 404, "NOT_FOUND", hidden);
    expectError(read, 404, "NOT_FOUND", hidden);
    expectError(commit, 403, "FORBIDDEN", hidden);
    expectError(archiveCreate, 404, "NOT_FOUND", hidden);

    for (const url of [
      `/api/designs/${fixture.foreign.id}/previews`,
      `/api/designs/${fixture.foreign.id}/archive-previews`,
    ]) {
      const denied = await application.app.inject({
        method: "POST",
        url,
        remoteAddress: "127.0.0.1",
        headers: headers(),
        payload: {
          baseVersion: 1,
          operations: [{ type: "update_node", node_id: fixture.foreign.frameId, patch: { name: PRIVATE_MARKER } }],
        },
      });
      expectError(denied, 404, "NOT_FOUND", hidden);
    }
    const deniedCommit = await application.app.inject({
      method: "POST",
      url: `/api/designs/${fixture.denied.id}/previews/${expiring.id}/commit`,
      remoteAddress: "127.0.0.1",
      headers: headers(VIEWER),
      payload: {
        expectedBaseVersion: 1,
        idempotencyKey: "core-preview-viewer-denied-0001",
        message: PRIVATE_MARKER,
      },
    });
    expectError(deniedCommit, 403, "FORBIDDEN", hidden);
    expect(previewState(application)).toEqual(before);
  });

  it("keeps foreign and swapped design or preview IDs opaque without mutating state", async () => {
    const fixture = await setup("opaque");
    const { application } = fixture;
    const localPreview = application.service.createPreview("local", fixture.allowed.id, {
      baseVersion: 1,
      operations: [{
        type: "update_node",
        node_id: fixture.allowed.frameId,
        patch: { name: "LOCAL_CORE_PREVIEW_MARKER_38fd6e" },
      }],
    });
    const foreignPreview = application.service.createPreview(fixture.foreignActorId, fixture.foreign.id, {
      baseVersion: 1,
      operations: [{
        type: "update_node",
        node_id: fixture.foreign.frameId,
        patch: { name: "FOREIGN_CORE_PREVIEW_MARKER_9180cb" },
      }],
    });
    const hidden = [
      "LOCAL_CORE_PREVIEW_MARKER_38fd6e",
      "FOREIGN_CORE_PREVIEW_MARKER_9180cb",
      "FOREIGN_CORE_PREVIEW_PROJECT_6b28de",
      fixture.foreign.id,
      foreignPreview.id,
    ];
    const before = previewState(application);
    const responses = await Promise.all([
      application.app.inject({
        method: "GET",
        url: `/api/designs/${fixture.allowed.id}/previews/${foreignPreview.id}`,
        remoteAddress: "127.0.0.1",
        headers: headers(),
      }),
      application.app.inject({
        method: "GET",
        url: `/api/designs/${fixture.foreign.id}/previews/${localPreview.id}`,
        remoteAddress: "127.0.0.1",
        headers: headers(),
      }),
      application.app.inject({
        method: "POST",
        url: `/api/designs/${fixture.allowed.id}/previews/${foreignPreview.id}/commit`,
        remoteAddress: "127.0.0.1",
        headers: headers(),
        payload: {
          expectedBaseVersion: 1,
          idempotencyKey: "core-preview-swapped-commit-0001",
          message: PRIVATE_MARKER,
        },
      }),
      application.app.inject({
        method: "POST",
        url: `/api/designs/${fixture.foreign.id}/previews/${localPreview.id}/commit`,
        remoteAddress: "127.0.0.1",
        headers: headers(),
        payload: {
          expectedBaseVersion: 1,
          idempotencyKey: "core-preview-foreign-commit-0001",
          message: PRIVATE_MARKER,
        },
      }),
    ]);
    for (const response of responses) expectError(response, 404, "NOT_FOUND", hidden);
    expect(previewState(application)).toEqual(before);
  });

  it("enforces project-scoped grants across the four backing operations without denied mutation", async () => {
    const fixture = await setup("project-scope");
    const { application } = fixture;
    const deniedPreview = application.service.createPreview("local", fixture.denied.id, {
      baseVersion: 1,
      operations: [{
        type: "update_node",
        node_id: fixture.denied.frameId,
        patch: { name: "DENIED_SCOPED_PREVIEW_MARKER_f75a13" },
      }],
    });
    const expiring = application.service.createPreview("local", fixture.allowed.id, {
      baseVersion: 1,
      operations: [{
        type: "update_node",
        node_id: fixture.allowed.frameId,
        patch: { name: "SCOPED_LIFECYCLE_MARKER_5a63d1" },
      }],
    });
    application.database.sqlite.prepare(
      "UPDATE previews SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
    ).run(expiring.id);
    const grant = installGrant(application, {
      id: "core_preview_project_scoped",
      projectIds: [fixture.allowed.id],
      scopes: ["design:read", "design:preview", "design:write"],
    });

    const allowedPreview = application.service.createPreview(grant.actorId, fixture.allowed.id, {
      baseVersion: 1,
      operations: [{
        type: "update_node",
        node_id: fixture.allowed.frameId,
        patch: { name: "SCOPED_ALLOWED_PREVIEW_MARKER_634b8d" },
      }],
    });
    expect(application.service.getPreview(grant.actorId, fixture.allowed.id, allowedPreview.id).id)
      .toBe(allowedPreview.id);
    const committed = application.service.commitPreview(grant.actorId, fixture.allowed.id, {
      previewId: allowedPreview.id,
      expectedBaseVersion: 1,
      idempotencyKey: "core-preview-scoped-commit-0001",
    });
    expect(committed.design.version).toBe(2);
    const archivePreview = application.service.createPreview(grant.actorId, fixture.allowed.id, {
      baseVersion: 2,
      operations: [{ type: "archive_nodes", node_ids: [fixture.allowed.frameId] }],
      kind: "archive",
    });
    expect(archivePreview).toMatchObject({ kind: "archive", destructive: true });

    const beforeDenied = previewState(application);
    const deniedCalls = [
      () => application.service.createPreview(grant.actorId, fixture.denied.id, {
        baseVersion: 1,
        operations: [{
          type: "update_node",
          node_id: fixture.denied.frameId,
          patch: { name: PRIVATE_MARKER },
        }],
      }),
      () => application.service.getPreview(grant.actorId, fixture.denied.id, deniedPreview.id),
      () => application.service.commitPreview(grant.actorId, fixture.denied.id, {
        previewId: deniedPreview.id,
        expectedBaseVersion: 1,
        idempotencyKey: "core-preview-scoped-denied-0001",
      }),
      () => application.service.createPreview(grant.actorId, fixture.denied.id, {
        baseVersion: 1,
        operations: [{ type: "archive_nodes", node_ids: [fixture.denied.frameId] }],
        kind: "archive",
      }),
    ];
    for (const call of deniedCalls) expect(call).toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
    expect(previewState(application)).toEqual(beforeDenied);
  });

  it("preserves legitimate viewer and product-manager behavior on all four routes", async () => {
    const fixture = await setup("legitimate");
    const { application } = fixture;

    const viewerPreviewResponse = await application.app.inject({
      method: "POST",
      url: `/api/designs/${fixture.allowed.id}/previews`,
      remoteAddress: "127.0.0.1",
      headers: headers(VIEWER),
      payload: {
        baseVersion: 1,
        operations: [{
          type: "update_node",
          node_id: fixture.allowed.frameId,
          patch: { name: "VIEWER_CORE_PREVIEW_MARKER_d8350c" },
        }],
      },
    });
    expect(viewerPreviewResponse.statusCode, viewerPreviewResponse.body).toBe(201);
    const viewerPreview = viewerPreviewResponse.json<{ previewId: string; kind: string }>();
    expect(viewerPreview.kind).toBe("ordinary");

    const viewerRead = await application.app.inject({
      method: "GET",
      url: `/api/designs/${fixture.allowed.id}/previews/${viewerPreview.previewId}`,
      remoteAddress: "127.0.0.1",
      headers: headers(VIEWER),
    });
    expect(viewerRead.statusCode, viewerRead.body).toBe(200);
    expect(viewerRead.body).toContain("VIEWER_CORE_PREVIEW_MARKER_d8350c");

    const archiveResponse = await application.app.inject({
      method: "POST",
      url: `/api/designs/${fixture.allowed.id}/archive-previews`,
      remoteAddress: "127.0.0.1",
      headers: headers(VIEWER),
      payload: {
        baseVersion: 1,
        operations: [{ type: "archive_nodes", node_ids: [fixture.allowed.frameId] }],
      },
    });
    expect(archiveResponse.statusCode, archiveResponse.body).toBe(201);
    expect(archiveResponse.json<{ kind: string; destructive: boolean }>()).toMatchObject({
      kind: "archive",
      destructive: true,
    });

    const pmPreviewResponse = await application.app.inject({
      method: "POST",
      url: `/api/designs/${fixture.allowed.id}/previews`,
      remoteAddress: "127.0.0.1",
      headers: headers(),
      payload: {
        baseVersion: 1,
        operations: [{
          type: "update_node",
          node_id: fixture.allowed.frameId,
          patch: { name: "PM_CORE_PREVIEW_MARKER_c1907a" },
        }],
      },
    });
    expect(pmPreviewResponse.statusCode, pmPreviewResponse.body).toBe(201);
    const pmPreviewId = pmPreviewResponse.json<{ previewId: string }>().previewId;

    const otherCreator = await application.app.inject({
      method: "GET",
      url: `/api/designs/${fixture.allowed.id}/previews/${pmPreviewId}`,
      remoteAddress: "127.0.0.1",
      headers: headers(OTHER_PM),
    });
    expectError(otherCreator, 404, "NOT_FOUND", ["PM_CORE_PREVIEW_MARKER_c1907a"]);

    const committed = await application.app.inject({
      method: "POST",
      url: `/api/designs/${fixture.allowed.id}/previews/${pmPreviewId}/commit`,
      remoteAddress: "127.0.0.1",
      headers: headers(),
      payload: {
        expectedBaseVersion: 1,
        idempotencyKey: "core-preview-pm-commit-0001",
        message: "Commit the authorized core preview",
      },
    });
    expect(committed.statusCode, committed.body).toBe(200);
    expect(committed.json<{ version: number }>().version).toBe(2);
  });
});
