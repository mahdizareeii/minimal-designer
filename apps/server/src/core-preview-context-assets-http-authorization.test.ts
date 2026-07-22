import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { loadConfig } from "./config.js";
import { DomainError } from "./errors.js";

const PROXY_SECRET = "core-preview-context-assets-proxy-secret-0123456789abcdef";
const PUBLIC_ORIGIN = "https://design.example.test";
const ADMIN_IDENTITY = "core-assets-admin@example.test";
const PRODUCT_MANAGER_IDENTITY = "core-assets-pm@example.test";
const VIEWER_IDENTITY = "core-assets-viewer@example.test";
const ADMIN_ACTOR = `trusted:${ADMIN_IDENTITY}`;
const PRODUCT_MANAGER_ACTOR = `trusted:${PRODUCT_MANAGER_IDENTITY}`;
const PRIVATE_MARKER = "CORE_PREVIEW_CONTEXT_ASSET_PRIVATE_67e1b4";
const PRIVATE_PATH = "/Users/private/company/formaspec/preview-asset.png";
const PRIVATE_TOKEN = "fsg_core_preview_context_asset_private_2a9c51";
const FOREIGN_MARKER = "CORE_ASSET_FOREIGN_PRIVATE_104fd8";
const FOREIGN_PATH = "/srv/foreign-company/formaspec/private-asset.png";
const FOREIGN_TOKEN = "fsg_core_asset_foreign_private_ef6012";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=",
  "base64",
);

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
  connectionId: string;
  token: string;
}

interface AssetFixture {
  id: string;
  filename: string;
}

interface Fixture {
  application: DesignerApplication;
  root: string;
  allowed: DesignFixture;
  denied: DesignFixture;
  agentProject: DesignFixture;
  foreign: DesignFixture;
  ownerPreviewId: string;
  deniedPreviewId: string;
  foreignPreviewId: string;
  taskPreviewId: string;
  taskId: string;
  allowedAsset: AssetFixture;
  deniedAsset: AssetFixture;
  organizationAsset: AssetFixture;
  agentAsset: AssetFixture;
  foreignAsset: AssetFixture;
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

function unauthenticatedHeaders(contentType?: string): Record<string, string> {
  return {
    host: "design.example.test",
    origin: PUBLIC_ORIGIN,
    "x-formaspec-csrf": "1",
    authorization: `Bearer ${PRIVATE_TOKEN}`,
    ...(contentType ? { "content-type": contentType } : {}),
    "x-formaspec-proxy-secret": PROXY_SECRET,
  };
}

function grantHeaders(token: string, contentType?: string): Record<string, string> {
  return {
    host: "design.example.test",
    origin: PUBLIC_ORIGIN,
    "x-formaspec-csrf": "1",
    authorization: `Bearer ${token}`,
    ...(contentType ? { "content-type": contentType } : {}),
    "x-formaspec-proxy-secret": PROXY_SECRET,
  };
}

function multipart(data: Buffer, filename = "pixel.png"): { boundary: string; body: Buffer } {
  const boundary = "----formaspec-core-auth-boundary";
  return {
    boundary,
    body: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

async function serverApplication(label: string): Promise<{ application: DesignerApplication; root: string }> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `formaspec-core-preview-context-assets-${label}-`));
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
    DESIGNER_TOKEN: "core-preview-context-assets-bootstrap-token-0001",
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
  const token = `fsg_${input.id}_secret_6da310`;
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 3_600_000).toISOString();

  application.database.sqlite.prepare(
    "INSERT OR IGNORE INTO organizations (id, name, config_json, created_at, updated_at) VALUES (?, ?, '{}', ?, ?)",
  ).run(organizationId, `Core asset organization ${input.id}`, createdAt, createdAt);
  application.database.sqlite.prepare(
    `INSERT INTO principals (id, organization_id, kind, display_name, external_id, created_at)
     VALUES (?, ?, 'agent', ?, ?, ?)`,
  ).run(principalId, organizationId, input.id, `core-assets:${input.id}`, createdAt);
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
  return { actorId: `grant_${input.id}`, connectionId, token };
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
    idempotencyKey: `core-preview-context-assets-${label}-0001`,
  });
  return {
    id: created.document.id,
    pageId: created.document.pages[0]!.id,
    frameId: created.document.pages[0]!.children[0]!,
    name,
  };
}

function createAsset(
  application: DesignerApplication,
  actorId: string,
  filename: string,
  designId?: string,
): AssetFixture {
  return application.service.saveAsset(actorId, {
    ...(designId ? { designId } : {}),
    filename,
    mimeType: "image/png",
    width: 1,
    height: 1,
    data: PNG,
  });
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

  const allowed = createDesign(application, "local", `${label}-allowed`, "Allowed preview and asset project");
  const denied = createDesign(application, "local", `${label}-denied`, `Denied ${PRIVATE_MARKER}`);
  const agentProject = createDesign(application, "local", `${label}-agent`, "Scoped agent preview project");
  const foreignGrant = installGrant(application, {
    id: `core_asset_foreign_${label}`,
    organizationId: `organization_core_asset_foreign_${label}`,
    projectIds: [],
    scopes: ["context:write", "design:read", "design:preview", "design:write", "task:read", "task:claim", "task:update"],
  });
  const foreign = createDesign(
    application,
    foreignGrant.actorId,
    `${label}-foreign`,
    `Foreign ${FOREIGN_MARKER} ${FOREIGN_PATH} ${FOREIGN_TOKEN}`,
  );
  const restrictedGrant = installGrant(application, {
    id: `core_asset_restricted_${label}`,
    projectIds: [agentProject.id],
    scopes: ["context:write", "design:read", "design:preview", "design:write", "task:read", "task:claim", "task:update"],
  });
  const scopeDeniedGrant = installGrant(application, {
    id: `core_asset_scope_denied_${label}`,
    projectIds: [agentProject.id],
    scopes: ["task:read"],
  });

  const ownerPreview = application.service.createPreview(PRODUCT_MANAGER_ACTOR, allowed.id, {
    baseVersion: 1,
    operations: [{ type: "update_node", node_id: allowed.frameId, patch: { name: "Owner preview" } }],
  });
  const deniedPreview = application.service.createPreview("local", denied.id, {
    baseVersion: 1,
    operations: [{ type: "update_node", node_id: denied.frameId, patch: { name: PRIVATE_MARKER } }],
  });
  const foreignPreview = application.service.createPreview(foreignGrant.actorId, foreign.id, {
    baseVersion: 1,
    operations: [{ type: "update_node", node_id: foreign.frameId, patch: { name: FOREIGN_MARKER } }],
  });

  const task = application.enterprise.createAgentTask(ADMIN_ACTOR, {
    designId: agentProject.id,
    brief: "Prepare a task-owned preview for review",
    selection: [agentProject.frameId],
    baseVersion: 1,
    expectedOutput: "design_preview",
    idempotencyKey: `core-preview-context-assets-task-${label}-0001`,
    expiresInSeconds: 3_600,
  });
  application.enterprise.claimAgentTask(restrictedGrant.actorId, task.id);
  application.enterprise.transitionAgentTask(restrictedGrant.actorId, task.id, {
    expectedStatus: "claimed",
    toStatus: "in_progress",
  });
  const taskPreview = application.service.createPreview(restrictedGrant.actorId, agentProject.id, {
    baseVersion: 1,
    operations: [{ type: "update_node", node_id: agentProject.frameId, patch: { name: "Task preview" } }],
  });
  application.enterprise.transitionAgentTask(restrictedGrant.actorId, task.id, {
    expectedStatus: "in_progress",
    toStatus: "awaiting_approval",
    data: { previewId: taskPreview.id },
  });

  const allowedAsset = createAsset(application, ADMIN_ACTOR, "allowed.png", allowed.id);
  const deniedAsset = createAsset(application, ADMIN_ACTOR, `denied-${PRIVATE_MARKER}.png`, denied.id);
  const organizationAsset = createAsset(application, ADMIN_ACTOR, "organization-only.png");
  const agentAsset = createAsset(application, restrictedGrant.actorId, "agent.png", agentProject.id);
  const foreignAsset = createAsset(
    application,
    foreignGrant.actorId,
    `foreign-${FOREIGN_MARKER}.png`,
    foreign.id,
  );
  return {
    application,
    root,
    allowed,
    denied,
    agentProject,
    foreign,
    ownerPreviewId: ownerPreview.id,
    deniedPreviewId: deniedPreview.id,
    foreignPreviewId: foreignPreview.id,
    taskPreviewId: taskPreview.id,
    taskId: task.id,
    allowedAsset,
    deniedAsset,
    organizationAsset,
    agentAsset,
    foreignAsset,
    foreignGrant,
    restrictedGrant,
    scopeDeniedGrant,
  };
}

async function filesBelow(root: string): Promise<string[]> {
  const result: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute);
      if (entry.isDirectory()) await visit(absolute);
      else result.push(relative);
    }
  };
  await visit(root);
  return result.sort();
}

function boundaryState(application: DesignerApplication): unknown {
  return {
    contexts: application.database.sqlite.prepare(
      "SELECT actor_id, design_id, page_id, selection_json, organization_id FROM contexts ORDER BY actor_id",
    ).all(),
    previews: application.database.sqlite.prepare(
      "SELECT id, organization_id, design_id, actor_id, status, kind, committed_revision_id FROM previews ORDER BY id",
    ).all(),
    assets: application.database.sqlite.prepare(
      "SELECT id, organization_id, design_id, filename, mime_type, size_bytes, sha256, created_at FROM assets ORDER BY id",
    ).all(),
    renderJobs: application.database.sqlite.prepare(
      `SELECT id, organization_id, design_id, revision_id, scope_kind, operation, kind, status,
              request_hash, request_metadata_json, output_sha256, error_code
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

describe("core preview render, context, and asset HTTP authorization", () => {
  it("authorizes exactly four routes before parsing, rendering, multipart decode, storage, or mutation", async () => {
    const fixture = await createFixture("ordering");
    const { application } = fixture;
    const encodedPrivatePath = encodeURIComponent(PRIVATE_PATH);
    const upload = multipart(Buffer.from(PRIVATE_TOKEN), `${PRIVATE_MARKER}.png`);
    const invalidContext = {
      designId: 42,
      pageId: PRIVATE_PATH,
      selectedNodeIds: [PRIVATE_TOKEN],
    };
    const malformedRequests = [
      {
        method: "GET",
        url: `/api/designs/${encodedPrivatePath}/previews/${PRIVATE_MARKER}/render.png?taskId=${PRIVATE_MARKER}&maxSize=${PRIVATE_MARKER}`,
      },
      { method: "PUT", url: "/api/context", payload: invalidContext },
      {
        method: "POST",
        url: `/api/assets?designId=${encodedPrivatePath}`,
        headers: { "content-type": `multipart/form-data; boundary=${upload.boundary}` },
        payload: upload.body,
      },
      { method: "GET", url: `/api/assets/${encodedPrivatePath}` },
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
    const before = boundaryState(application);
    const beforeFiles = await filesBelow(fixture.root);
    const getPreview = vi.spyOn(application.service, "getPreview");
    const setContext = vi.spyOn(application.service, "setContext");
    const saveAsset = vi.spyOn(application.service, "saveAsset");
    const getAsset = vi.spyOn(application.service, "getAsset");
    const render = vi.spyOn(application.renderer, "render");
    const normalizeRaster = vi.spyOn(application.renderer, "normalizeRaster");
    const writeNormalized = application.service.assetStore
      ? vi.spyOn(application.service.assetStore, "writeNormalized")
      : null;
    const readNormalized = application.service.assetStore
      ? vi.spyOn(application.service.assetStore, "readNormalized")
      : null;

    for (const request of malformedRequests) {
      const response = await application.app.inject({
        ...request,
        headers: { ...unauthenticatedHeaders(), ...request.headers },
      });
      expectError(response, 401, "AUTH_REQUIRED", hidden);
    }
    for (const request of malformedRequests) {
      const response = await application.app.inject({
        ...request,
        headers: { ...grantHeaders(fixture.scopeDeniedGrant.token), ...request.headers },
      });
      expectError(response, 401, "AUTH_REQUIRED", hidden);
    }

    const viewerUpload = await application.app.inject({
      ...malformedRequests[2],
      headers: { ...serverHeaders(VIEWER_IDENTITY), ...malformedRequests[2].headers },
    });
    expectError(viewerUpload, 403, "FORBIDDEN", hidden);
    const invalidViewerContext = await application.app.inject({
      ...malformedRequests[1],
      headers: serverHeaders(VIEWER_IDENTITY),
    });
    expectError(invalidViewerContext, 422, "VALIDATION_FAILED", hidden);
    for (const request of [malformedRequests[0], malformedRequests[3]]) {
      const response = await application.app.inject({ ...request, headers: serverHeaders(VIEWER_IDENTITY) });
      expectError(response, 404, "NOT_FOUND", hidden);
    }

    for (const callback of [
      () => application.service.authorizePreviewRead(
        fixture.scopeDeniedGrant.actorId,
        PRIVATE_PATH,
        PRIVATE_PATH,
      ),
      () => application.service.authorizeContextWrite(fixture.scopeDeniedGrant.actorId, PRIVATE_PATH),
      () => application.service.authorizeAssetUpload(fixture.scopeDeniedGrant.actorId, PRIVATE_PATH),
      () => application.service.authorizeAssetRead(fixture.scopeDeniedGrant.actorId, PRIVATE_PATH),
    ]) {
      const error = captureDomainError(callback);
      expect(error).toMatchObject({ statusCode: 403, code: "FORBIDDEN" });
      for (const value of hidden) expect(JSON.stringify(error.toJSON())).not.toContain(value);
    }
    for (const callback of [
      () => application.service.authorizePreviewRead(
        fixture.restrictedGrant.actorId,
        fixture.denied.id,
        fixture.deniedPreviewId,
      ),
      () => application.service.authorizeContextWrite(fixture.restrictedGrant.actorId, fixture.denied.id),
      () => application.service.authorizeAssetUpload(fixture.restrictedGrant.actorId, fixture.denied.id),
      () => application.service.authorizeAssetRead(fixture.restrictedGrant.actorId, fixture.deniedAsset.id),
      () => application.service.authorizeAssetRead(fixture.restrictedGrant.actorId, fixture.organizationAsset.id),
    ]) {
      const error = captureDomainError(callback);
      expect(error).toMatchObject({ statusCode: 404, code: "NOT_FOUND" });
      expect(JSON.stringify(error.toJSON())).not.toContain(fixture.denied.id);
      expect(JSON.stringify(error.toJSON())).not.toContain(fixture.denied.name);
    }
    expect(captureDomainError(
      () => application.service.authorizeAssetUpload(fixture.restrictedGrant.actorId),
    )).toMatchObject({ statusCode: 403, code: "FORBIDDEN" });

    const previewWithoutTask = await application.app.inject({
      method: "GET",
      url: `/api/designs/${fixture.agentProject.id}/previews/${fixture.taskPreviewId}/render.png`,
      headers: serverHeaders(VIEWER_IDENTITY),
    });
    expectError(previewWithoutTask, 404, "NOT_FOUND", hidden);
    const ownerMismatch = await application.app.inject({
      method: "GET",
      url: `/api/designs/${fixture.allowed.id}/previews/${fixture.ownerPreviewId}/render.png`,
      headers: serverHeaders(VIEWER_IDENTITY),
    });
    expectError(ownerMismatch, 404, "NOT_FOUND", hidden);
    for (const [designId, previewId] of [
      [fixture.allowed.id, fixture.deniedPreviewId],
      [fixture.denied.id, fixture.ownerPreviewId],
    ] as const) {
      const swapped = await application.app.inject({
        method: "GET",
        url: `/api/designs/${designId}/previews/${previewId}/render.png?taskId=${PRIVATE_MARKER}`,
        headers: serverHeaders(ADMIN_IDENTITY),
      });
      expectError(swapped, 404, "NOT_FOUND", hidden);
    }

    const foreignHidden = [
      ...hidden,
      fixture.foreign.id,
      fixture.foreign.name,
      fixture.foreignPreviewId,
      fixture.foreignAsset.id,
      fixture.foreignAsset.filename,
      FOREIGN_MARKER,
      FOREIGN_PATH,
      FOREIGN_TOKEN,
    ];
    for (const request of [
      {
        method: "GET",
        url: `/api/designs/${fixture.foreign.id}/previews/${fixture.foreignPreviewId}/render.png?maxSize=${PRIVATE_MARKER}`,
      },
      { method: "PUT", url: "/api/context", payload: { ...invalidContext, designId: fixture.foreign.id } },
      {
        method: "POST",
        url: `/api/assets?designId=${fixture.foreign.id}`,
        headers: { "content-type": `multipart/form-data; boundary=${upload.boundary}` },
        payload: upload.body,
      },
      { method: "GET", url: `/api/assets/${fixture.foreignAsset.id}` },
    ] as const) {
      const response = await application.app.inject({
        ...request,
        headers: { ...serverHeaders(ADMIN_IDENTITY), ...request.headers },
      });
      expectError(response, 404, "NOT_FOUND", foreignHidden);
    }

    expect(getPreview).not.toHaveBeenCalled();
    expect(setContext).not.toHaveBeenCalled();
    expect(saveAsset).not.toHaveBeenCalled();
    expect(getAsset).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
    expect(normalizeRaster).not.toHaveBeenCalled();
    expect(writeNormalized).not.toHaveBeenCalled();
    expect(readNormalized).not.toHaveBeenCalled();
    expect(boundaryState(application)).toEqual(before);
    expect(await filesBelow(fixture.root)).toEqual(beforeFiles);
  });

  it("preserves valid UI and scoped-agent preview, context, and asset behavior", async () => {
    const fixture = await createFixture("allowed");
    const { application } = fixture;
    const render = vi.spyOn(application.renderer, "render").mockResolvedValue({
      png: Buffer.from("89504e470d0a1a0a", "hex"),
      width: 1200,
      height: 800,
      renderer: "playwright",
      warnings: [],
    });

    const ownerRender = await application.app.inject({
      method: "GET",
      url: `/api/designs/${fixture.allowed.id}/previews/${fixture.ownerPreviewId}/render.png?mode=adhoc&maxSize=512`,
      headers: serverHeaders(PRODUCT_MANAGER_IDENTITY),
    });
    expect(ownerRender.statusCode, ownerRender.body).toBe(200);
    const taskRender = await application.app.inject({
      method: "GET",
      url: `/api/designs/${fixture.agentProject.id}/previews/${fixture.taskPreviewId}/render.png?mode=adhoc&taskId=${fixture.taskId}&maxSize=512`,
      headers: serverHeaders(VIEWER_IDENTITY),
    });
    expect(taskRender.statusCode, taskRender.body).toBe(200);
    expect(render).toHaveBeenCalledTimes(2);

    const context = await application.app.inject({
      method: "PUT",
      url: "/api/context",
      headers: serverHeaders(VIEWER_IDENTITY),
      payload: {
        designId: fixture.allowed.id,
        pageId: fixture.allowed.pageId,
        selectedNodeIds: [fixture.allowed.frameId],
      },
    });
    expect(context.statusCode, context.body).toBe(200);
    expect(context.json<{ designId: string; selection: string[] }>()).toMatchObject({
      designId: fixture.allowed.id,
      selection: [fixture.allowed.frameId],
    });
    expect(application.service.setContext(fixture.restrictedGrant.actorId, {
      designId: fixture.agentProject.id,
      pageId: fixture.agentProject.pageId,
      selection: [fixture.agentProject.frameId],
    })).toMatchObject({ designId: fixture.agentProject.id });
    expect(application.service.getPreview(
      fixture.restrictedGrant.actorId,
      fixture.agentProject.id,
      fixture.taskPreviewId,
    ).id).toBe(fixture.taskPreviewId);

    vi.spyOn(application.renderer, "normalizeRaster").mockResolvedValue({
      data: PNG,
      mimeType: "image/png",
      width: 1,
      height: 1,
    });
    const upload = multipart(PNG, "uploaded.png");
    const uploaded = await application.app.inject({
      method: "POST",
      url: `/api/assets?designId=${fixture.allowed.id}`,
      headers: {
        ...serverHeaders(PRODUCT_MANAGER_IDENTITY),
        "content-type": `multipart/form-data; boundary=${upload.boundary}`,
      },
      payload: upload.body,
    });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const uploadedAsset = uploaded.json<{ id: string; sha256: string }>();
    const fetched = await application.app.inject({
      method: "GET",
      url: `/api/assets/${uploadedAsset.id}`,
      headers: serverHeaders(VIEWER_IDENTITY),
    });
    expect(fetched.statusCode, fetched.body).toBe(200);
    expect(fetched.rawPayload).toEqual(PNG);
    expect(fetched.headers.etag).toBe(`"${uploadedAsset.sha256}"`);

    expect(application.service.authorizeAssetUpload(
      fixture.restrictedGrant.actorId,
      fixture.agentProject.id,
    )).toBe("organization_legacy");
    expect(application.service.getAsset(
      fixture.restrictedGrant.actorId,
      fixture.agentAsset.id,
    ).id).toBe(fixture.agentAsset.id);
  });
});
