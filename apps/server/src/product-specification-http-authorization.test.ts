import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { resolveAccess } from "./authorization.js";
import { loadConfig } from "./config.js";
import type { DomainError } from "./errors.js";
import { canonicalProductSpecification } from "./product-spec-persistence.js";

const PROXY_SECRET = "product-spec-http-proxy-secret-0123456789abcdef";
const ADMIN = "product-spec-admin@example.test";
const PM = "product-spec-pm@example.test";
const OTHER_PM = "product-spec-other-pm@example.test";
const VIEWER = "product-spec-viewer@example.test";

const applications: DesignerApplication[] = [];
const temporaryDirectories: string[] = [];

interface DesignFixture {
  id: string;
  revisionId: string;
  version: number;
}

interface Fixture {
  application: DesignerApplication;
  allowed: DesignFixture;
  denied: DesignFixture;
  foreign: DesignFixture;
  foreignActorId: string;
  foreignToken: string;
}

interface PreviewFixture {
  id: string;
  marker: string;
}

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.promises.rm(directory, { recursive: true, force: true })
  )));
});

async function serverApplication(label: string): Promise<DesignerApplication> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `formaspec-product-spec-http-${label}-`));
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
    DESIGNER_TOKEN: "product-spec-http-bootstrap-token-0001",
    FORMASPEC_TRUSTED_PROXIES: "127.0.0.1",
    FORMASPEC_PROXY_SECRET: PROXY_SECRET,
    DESIGNER_CORS_ORIGINS: "https://design.example.test",
    DESIGNER_LOG_LEVEL: "silent",
  }));
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

function createDesign(
  application: DesignerApplication,
  actorId: string,
  label: string,
  name: string,
): DesignFixture {
  const created = application.service.createDesign(actorId, {
    name,
    preset: "web",
    idempotencyKey: `product-spec-http-design-${label}-0001`,
  });
  return {
    id: created.document.id,
    revisionId: created.revision.id,
    version: created.design.version,
  };
}

function installForeignActor(application: DesignerApplication, label: string): {
  actorId: string;
  token: string;
} {
  const organizationId = `organization_product_spec_foreign_${label}`;
  const principalId = `principal_product_spec_foreign_${label}`;
  const connectionId = `connection_product_spec_foreign_${label}`;
  const grantId = `product_spec_foreign_${label}`;
  const token = `fsg_product_spec_foreign_${label}_SECRET_TOKEN_9c14e2`;
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 3_600_000).toISOString();
  const scopes = ["design:write", "product_spec:read", "product_spec:preview", "product_spec:write"];
  const scopesJson = JSON.stringify(scopes);

  application.database.sqlite.prepare(
    "INSERT INTO organizations (id, name, config_json, created_at, updated_at) VALUES (?, ?, '{}', ?, ?)",
  ).run(organizationId, `Foreign product-spec organization ${label}`, createdAt, createdAt);
  application.database.sqlite.prepare(
    `INSERT INTO principals (id, organization_id, kind, display_name, external_id, created_at)
     VALUES (?, ?, 'agent', ?, ?, ?)`,
  ).run(principalId, organizationId, `Foreign product-spec actor ${label}`, `foreign:product-spec:${label}`, createdAt);
  application.database.sqlite.prepare(
    "INSERT INTO memberships (organization_id, principal_id, role, created_at) VALUES (?, ?, 'agent', ?)",
  ).run(organizationId, principalId, createdAt);
  application.database.sqlite.prepare(
    `INSERT INTO agent_connections
     (id, organization_id, principal_id, adapter, display_name, status, scopes_json, project_ids_json,
      expires_at, created_at, updated_at)
     VALUES (?, ?, ?, 'generic_mcp', ?, 'active', ?, '[]', ?, ?, ?)`,
  ).run(connectionId, organizationId, principalId, `Foreign product-spec connection ${label}`, scopesJson, expiresAt, createdAt, createdAt);
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
  return { actorId: `grant_${grantId}`, token };
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

  const allowed = createDesign(application, "local", `${label}-allowed`, "Allowed product-spec project");
  const denied = createDesign(application, "local", `${label}-denied`, "DENIED_PRODUCT_SPEC_PROJECT_86d41a");
  const foreignActor = installForeignActor(application, label);
  const foreign = createDesign(
    application,
    foreignActor.actorId,
    `${label}-foreign`,
    "FOREIGN_PRODUCT_SPEC_PROJECT_4bc210",
  );
  return {
    application,
    allowed,
    denied,
    foreign,
    foreignActorId: foreignActor.actorId,
    foreignToken: foreignActor.token,
  };
}

function insertExpiredPreview(
  application: DesignerApplication,
  actorId: string,
  designId: string,
  seed: string,
  marker: string,
): PreviewFixture {
  const access = resolveAccess(application.database.sqlite, actorId);
  const current = application.database.sqlite.prepare(
    "SELECT COALESCE(MAX(version), 0) AS version FROM product_specifications WHERE design_id = ?",
  ).get(designId) as { version: number };
  const canonical = canonicalProductSpecification({
    id: `spec_${seed.repeat(16)}`,
    version: current.version + 1,
    natural_language_brief: marker,
  });
  const id = `specpreview_${seed.repeat(32)}`;
  application.database.sqlite.prepare(
    `INSERT INTO product_spec_previews
     (id, organization_id, design_id, actor_id, base_version, specification_json, specification_hash,
      diagnostics_json, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, '[]', 'ready', '1999-12-31T23:59:00.000Z', '2000-01-01T00:00:00.000Z')`,
  ).run(
    id,
    access.organizationId,
    designId,
    access.principalId,
    current.version,
    canonical.json,
    canonical.hash,
  );
  return { id, marker };
}

function statuses(application: DesignerApplication, ids: string[]): Record<string, string> {
  return Object.fromEntries(ids.map((id) => {
    const row = application.database.sqlite.prepare(
      "SELECT status FROM product_spec_previews WHERE id = ?",
    ).get(id) as { status: string };
    return [id, row.status];
  }));
}

function state(application: DesignerApplication): Record<string, unknown[]> {
  return {
    previews: application.database.sqlite.prepare("SELECT * FROM product_spec_previews ORDER BY id").all(),
    specifications: application.database.sqlite.prepare(
      "SELECT * FROM product_specifications ORDER BY design_id, version",
    ).all(),
    idempotency: application.database.sqlite.prepare(
      "SELECT * FROM idempotency ORDER BY actor_id, scope, key",
    ).all(),
    auditEvents: application.database.sqlite.prepare("SELECT * FROM audit_events ORDER BY id").all(),
    outbox: application.database.sqlite.prepare("SELECT * FROM event_outbox ORDER BY id").all(),
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
  for (const value of hidden) expect(response.body).not.toContain(value);
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
  for (const value of hidden) expect(serialized).not.toContain(value);
}

function mcpTool(
  application: DesignerApplication,
  token: string,
  name: string,
  args: Record<string, unknown>,
) {
  return application.app.inject({
    method: "POST",
    url: "/mcp",
    remoteAddress: "127.0.0.1",
    headers: {
      host: "design.example.test",
      authorization: `Bearer ${token}`,
      "x-formaspec-proxy-secret": PROXY_SECRET,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    },
  });
}

describe("product-specification HTTP authorization", () => {
  it("covers specification history and preview routes with trusted-header roles and creator-isolated previews", async () => {
    const fixture = await setup("roles");
    const { application } = fixture;
    const seed = application.enterprise.previewProductSpecification("local", {
      designId: fixture.allowed.id,
      baseVersion: 0,
      naturalLanguageBrief: "COMMITTED_PRODUCT_SPEC_MARKER_20ca91",
    });
    application.enterprise.commitProductSpecificationPreview("local", {
      designId: fixture.allowed.id,
      previewId: seed.id,
      expectedBaseVersion: 0,
      idempotencyKey: "product-spec-http-seed-commit-0001",
    });

    const read = await application.app.inject({
      method: "GET",
      url: `/api/designs/${fixture.allowed.id}/product-specification`,
      remoteAddress: "127.0.0.1",
      headers: headers(VIEWER),
    });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json<{ version: number; naturalLanguageBrief: string }>()).toMatchObject({
      version: 1,
      naturalLanguageBrief: "COMMITTED_PRODUCT_SPEC_MARKER_20ca91",
    });

    const history = await application.app.inject({
      method: "GET",
      url: `/api/designs/${fixture.allowed.id}/product-specification/history?limit=1`,
      remoteAddress: "127.0.0.1",
      headers: headers(VIEWER),
    });
    expect(history.statusCode, history.body).toBe(200);
    expect(history.json<{
      versions: Array<{
        version: number;
        naturalLanguageBrief: string;
        counts: Record<string, number>;
      }>;
      nextBeforeVersion: number | null;
    }>()).toMatchObject({
      versions: [{
        version: 1,
        naturalLanguageBrief: "COMMITTED_PRODUCT_SPEC_MARKER_20ca91",
        counts: { roles: 0, flows: 0, business_rules: 0, acceptance_criteria: 0 },
      }],
      nextBeforeVersion: null,
    });

    const beforeViewerPreview = state(application);
    const viewerPreview = await application.app.inject({
      method: "POST",
      url: `/api/designs/${fixture.allowed.id}/product-specification/previews`,
      remoteAddress: "127.0.0.1",
      headers: headers(VIEWER),
      payload: { baseVersion: 1, naturalLanguageBrief: "Viewer must not create this preview" },
    });
    expectHiddenError(viewerPreview, 403, "FORBIDDEN", [fixture.foreignToken]);
    expect(state(application)).toEqual(beforeViewerPreview);

    const created = await application.app.inject({
      method: "POST",
      url: `/api/designs/${fixture.allowed.id}/product-specification/previews`,
      remoteAddress: "127.0.0.1",
      headers: headers(),
      payload: { baseVersion: 1, naturalLanguageBrief: "PM_HTTP_PREVIEW_MARKER_b84e02" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const preview = created.json<{
      id: string;
      previewId: string;
      version: number;
      status: string;
      specificationHash: string;
    }>();
    expect(preview).toMatchObject({ id: preview.previewId, version: 2, status: "ready" });

    const previewRead = await application.app.inject({
      method: "GET",
      url: `/api/designs/${fixture.allowed.id}/product-specification/previews/${preview.id}`,
      remoteAddress: "127.0.0.1",
      headers: headers(),
    });
    expect(previewRead.statusCode, previewRead.body).toBe(200);
    expect(previewRead.json<{ id: string; naturalLanguageBrief: string }>()).toMatchObject({
      id: preview.id,
      naturalLanguageBrief: "PM_HTTP_PREVIEW_MARKER_b84e02",
    });

    const beforeDeniedReads = state(application);
    const creatorDenied = await application.app.inject({
      method: "GET",
      url: `/api/designs/${fixture.allowed.id}/product-specification/previews/${preview.id}`,
      remoteAddress: "127.0.0.1",
      headers: headers(OTHER_PM),
    });
    expectHiddenError(creatorDenied, 404, "NOT_FOUND", ["PM_HTTP_PREVIEW_MARKER_b84e02", fixture.foreignToken]);
    const viewerCommit = await application.app.inject({
      method: "POST",
      url: `/api/designs/${fixture.allowed.id}/product-specification/previews/${preview.id}/commit`,
      remoteAddress: "127.0.0.1",
      headers: headers(VIEWER),
      payload: { expectedBaseVersion: 1, idempotencyKey: "product-spec-http-viewer-denied-0001" },
    });
    expectHiddenError(viewerCommit, 403, "FORBIDDEN", ["PM_HTTP_PREVIEW_MARKER_b84e02", fixture.foreignToken]);
    expect(state(application)).toEqual(beforeDeniedReads);

    const committed = await application.app.inject({
      method: "POST",
      url: `/api/designs/${fixture.allowed.id}/product-specification/previews/${preview.id}/commit`,
      remoteAddress: "127.0.0.1",
      headers: headers(),
      payload: {
        expectedBaseVersion: 1,
        idempotencyKey: "product-spec-http-pm-commit-0001",
        message: "Commit the exact trusted-header preview",
      },
    });
    expect(committed.statusCode, committed.body).toBe(200);
    expect(committed.json<{ version: number; specificationHash: string; naturalLanguageBrief: string }>()).toMatchObject({
      version: 2,
      specificationHash: preview.specificationHash,
      naturalLanguageBrief: "PM_HTTP_PREVIEW_MARKER_b84e02",
    });

    const newestHistory = await application.app.inject({
      method: "GET",
      url: `/api/designs/${fixture.allowed.id}/product-specification/history?limit=1`,
      remoteAddress: "127.0.0.1",
      headers: headers(VIEWER),
    });
    expect(newestHistory.statusCode, newestHistory.body).toBe(200);
    expect(newestHistory.json<{ versions: Array<{ version: number }>; nextBeforeVersion: number | null }>()).toMatchObject({
      versions: [{ version: 2 }],
      nextBeforeVersion: 2,
    });
    const previousHistory = await application.app.inject({
      method: "GET",
      url: `/api/designs/${fixture.allowed.id}/product-specification/history?limit=1&beforeVersion=2`,
      remoteAddress: "127.0.0.1",
      headers: headers(VIEWER),
    });
    expect(previousHistory.statusCode, previousHistory.body).toBe(200);
    expect(previousHistory.json<{ versions: Array<{ version: number }>; nextBeforeVersion: number | null }>()).toMatchObject({
      versions: [{ version: 1 }],
      nextBeforeVersion: null,
    });
  });

  it("authorizes exact preview ownership before expiry mutation on swapped and foreign IDs", async () => {
    const fixture = await setup("expiry-scope");
    const { application } = fixture;
    const pmActorId = `trusted:${PM}`;
    const adminActorId = `trusted:${ADMIN}`;
    const sameScope = insertExpiredPreview(
      application,
      pmActorId,
      fixture.allowed.id,
      "1",
      "SAME_SCOPE_EXPIRED_PREVIEW_MARKER_623f10",
    );
    const deniedScope = insertExpiredPreview(
      application,
      pmActorId,
      fixture.denied.id,
      "2",
      "DENIED_SCOPE_EXPIRED_PREVIEW_MARKER_a8f204",
    );
    const otherCreator = insertExpiredPreview(
      application,
      adminActorId,
      fixture.allowed.id,
      "3",
      "OTHER_CREATOR_EXPIRED_PREVIEW_MARKER_17c9ba",
    );
    const foreign = insertExpiredPreview(
      application,
      fixture.foreignActorId,
      fixture.foreign.id,
      "4",
      "FOREIGN_EXPIRED_PREVIEW_MARKER_c12e84",
    );

    const create = await application.app.inject({
      method: "POST",
      url: `/api/designs/${fixture.allowed.id}/product-specification/previews`,
      remoteAddress: "127.0.0.1",
      headers: headers(),
      payload: { baseVersion: 0, naturalLanguageBrief: "Create after scoped preview expiry" },
    });
    expect(create.statusCode, create.body).toBe(201);
    expect(statuses(application, [sameScope.id, deniedScope.id, otherCreator.id, foreign.id])).toEqual({
      [sameScope.id]: "expired",
      [deniedScope.id]: "ready",
      [otherCreator.id]: "ready",
      [foreign.id]: "ready",
    });

    const wrongParent = insertExpiredPreview(
      application,
      pmActorId,
      fixture.allowed.id,
      "5",
      "WRONG_PARENT_EXPIRED_PREVIEW_MARKER_036ab7",
    );
    const hidden = [
      deniedScope.marker,
      otherCreator.marker,
      foreign.marker,
      wrongParent.marker,
      fixture.foreignToken,
      fixture.foreign.id,
      "DENIED_PRODUCT_SPEC_PROJECT_86d41a",
      "FOREIGN_PRODUCT_SPEC_PROJECT_4bc210",
    ];
    const beforeDenied = state(application);
    const deniedResponses = [
      await application.app.inject({
        method: "GET",
        url: `/api/designs/${fixture.allowed.id}/product-specification/previews/${foreign.id}`,
        remoteAddress: "127.0.0.1",
        headers: headers(),
      }),
      await application.app.inject({
        method: "POST",
        url: `/api/designs/${fixture.allowed.id}/product-specification/previews/${foreign.id}/commit`,
        remoteAddress: "127.0.0.1",
        headers: headers(),
        payload: {
          expectedBaseVersion: 0,
          idempotencyKey: "product-spec-http-foreign-preview-0001",
        },
      }),
      await application.app.inject({
        method: "GET",
        url: `/api/designs/${fixture.allowed.id}/product-specification/previews/${otherCreator.id}`,
        remoteAddress: "127.0.0.1",
        headers: headers(),
      }),
      await application.app.inject({
        method: "POST",
        url: `/api/designs/${fixture.allowed.id}/product-specification/previews/${otherCreator.id}/commit`,
        remoteAddress: "127.0.0.1",
        headers: headers(),
        payload: {
          expectedBaseVersion: 0,
          idempotencyKey: "product-spec-http-other-creator-0001",
        },
      }),
      await application.app.inject({
        method: "GET",
        url: `/api/designs/${fixture.denied.id}/product-specification/previews/${wrongParent.id}`,
        remoteAddress: "127.0.0.1",
        headers: headers(),
      }),
      await application.app.inject({
        method: "POST",
        url: `/api/designs/${fixture.denied.id}/product-specification/previews/${wrongParent.id}/commit`,
        remoteAddress: "127.0.0.1",
        headers: headers(),
        payload: {
          expectedBaseVersion: 0,
          idempotencyKey: "product-spec-http-wrong-parent-0001",
        },
      }),
      await application.app.inject({
        method: "GET",
        url: `/api/designs/${fixture.foreign.id}/product-specification`,
        remoteAddress: "127.0.0.1",
        headers: headers(),
      }),
      await application.app.inject({
        method: "GET",
        url: `/api/designs/${fixture.foreign.id}/product-specification/history`,
        remoteAddress: "127.0.0.1",
        headers: headers(),
      }),
      await application.app.inject({
        method: "POST",
        url: `/api/designs/${fixture.foreign.id}/product-specification/previews`,
        remoteAddress: "127.0.0.1",
        headers: headers(),
        payload: { baseVersion: 0, naturalLanguageBrief: "Must not create in a foreign project" },
      }),
    ];
    for (const response of deniedResponses) expectHiddenError(response, 404, "NOT_FOUND", hidden);
    expect(state(application)).toEqual(beforeDenied);
    expect(statuses(application, [deniedScope.id, otherCreator.id, foreign.id, wrongParent.id])).toEqual({
      [deniedScope.id]: "ready",
      [otherCreator.id]: "ready",
      [foreign.id]: "ready",
      [wrongParent.id]: "ready",
    });

    const exactExpired = insertExpiredPreview(
      application,
      pmActorId,
      fixture.allowed.id,
      "6",
      "EXACT_AUTHORIZED_EXPIRED_PREVIEW_MARKER_b731e5",
    );
    const exactRead = await application.app.inject({
      method: "GET",
      url: `/api/designs/${fixture.allowed.id}/product-specification/previews/${exactExpired.id}`,
      remoteAddress: "127.0.0.1",
      headers: headers(),
    });
    expectHiddenError(exactRead, 410, "PREVIEW_EXPIRED", [exactExpired.marker, fixture.foreignToken]);
    expect(statuses(application, [
      exactExpired.id,
      deniedScope.id,
      otherCreator.id,
      foreign.id,
      wrongParent.id,
    ])).toEqual({
      [exactExpired.id]: "expired",
      [deniedScope.id]: "ready",
      [otherCreator.id]: "ready",
      [foreign.id]: "ready",
      [wrongParent.id]: "ready",
    });
  });

  it("enforces project-restricted grants and immediate revocation across the five backing operations", async () => {
    const fixture = await setup("scoped-agent");
    const { application } = fixture;
    const deniedPreview = application.enterprise.previewProductSpecification("local", {
      designId: fixture.denied.id,
      baseVersion: 0,
      naturalLanguageBrief: "DENIED_AGENT_PREVIEW_MARKER_c48a12",
    });
    const foreignPreview = application.enterprise.previewProductSpecification(fixture.foreignActorId, {
      designId: fixture.foreign.id,
      baseVersion: 0,
      naturalLanguageBrief: "FOREIGN_AGENT_PREVIEW_MARKER_94d31b",
    });
    const challenge = application.enterprise.createAgentConnection("local", {
      adapter: "codex",
      displayName: "Project-restricted product-spec agent",
      scopes: ["product_spec:read", "product_spec:preview", "product_spec:write"],
      projectIds: [fixture.allowed.id],
      expiresInSeconds: 3_600,
    });
    const paired = application.enterprise.pairAgentConnection(challenge.nonce);
    const actorId = paired.grant.actorId;

    const allowedPreview = application.enterprise.previewProductSpecification(actorId, {
      designId: fixture.allowed.id,
      baseVersion: 0,
      naturalLanguageBrief: "SCOPED_AGENT_ALLOWED_PREVIEW_MARKER_718ce0",
    });
    expect(application.enterprise.readProductSpecificationPreview(
      actorId,
      fixture.allowed.id,
      allowedPreview.id,
    ).id).toBe(allowedPreview.id);
    const committed = application.enterprise.commitProductSpecificationPreview(actorId, {
      designId: fixture.allowed.id,
      previewId: allowedPreview.id,
      expectedBaseVersion: 0,
      idempotencyKey: "product-spec-scoped-agent-commit-0001",
    });
    expect(application.enterprise.readProductSpecification(actorId, fixture.allowed.id)).toEqual(committed);
    expect(application.enterprise.listProductSpecificationHistory(actorId, fixture.allowed.id)).toMatchObject({
      versions: [{ version: 1, specificationHash: committed.specificationHash }],
      nextBeforeVersion: null,
    });

    const allowedMcp = await mcpTool(application, paired.grant.token, "product_spec_read", {
      design_id: fixture.allowed.id,
    });
    expect(allowedMcp.statusCode, allowedMcp.body).toBe(200);
    expect(allowedMcp.json<{
      result: { structuredContent: { ok: boolean; specification: { designId: string; version: number } } };
    }>().result.structuredContent).toMatchObject({
      ok: true,
      specification: { designId: fixture.allowed.id, version: 1 },
    });

    const hidden = [
      "DENIED_AGENT_PREVIEW_MARKER_c48a12",
      "FOREIGN_AGENT_PREVIEW_MARKER_94d31b",
      fixture.foreignToken,
      fixture.denied.id,
      fixture.foreign.id,
    ];
    const deniedCallbacks = [
      () => application.enterprise.readProductSpecification(actorId, fixture.denied.id),
      () => application.enterprise.listProductSpecificationHistory(actorId, fixture.denied.id),
      () => application.enterprise.previewProductSpecification(actorId, {
        designId: fixture.denied.id,
        baseVersion: 0,
        naturalLanguageBrief: "Must not create in a denied project",
      }),
      () => application.enterprise.readProductSpecificationPreview(
        actorId,
        fixture.denied.id,
        deniedPreview.id,
      ),
      () => application.enterprise.commitProductSpecificationPreview(actorId, {
        designId: fixture.denied.id,
        previewId: deniedPreview.id,
        expectedBaseVersion: 0,
        idempotencyKey: "product-spec-scoped-denied-commit-0001",
      }),
      () => application.enterprise.readProductSpecification(actorId, fixture.foreign.id),
      () => application.enterprise.listProductSpecificationHistory(actorId, fixture.foreign.id),
      () => application.enterprise.previewProductSpecification(actorId, {
        designId: fixture.foreign.id,
        baseVersion: 0,
        naturalLanguageBrief: "Must not create in a foreign project",
      }),
      () => application.enterprise.readProductSpecificationPreview(
        actorId,
        fixture.foreign.id,
        foreignPreview.id,
      ),
      () => application.enterprise.commitProductSpecificationPreview(actorId, {
        designId: fixture.foreign.id,
        previewId: foreignPreview.id,
        expectedBaseVersion: 0,
        idempotencyKey: "product-spec-scoped-foreign-commit-0001",
      }),
    ];
    const beforeDenied = state(application);
    for (const callback of deniedCallbacks) {
      expectHiddenDomainError(captureDomainError(callback), 404, "NOT_FOUND", hidden);
    }
    expect(state(application)).toEqual(beforeDenied);

    const deniedMcp = await mcpTool(application, paired.grant.token, "product_spec_preview", {
      design_id: fixture.denied.id,
      base_version: 0,
      natural_language_brief: "MCP must not create in a denied project",
    });
    expect(deniedMcp.statusCode, deniedMcp.body).toBe(200);
    expect(deniedMcp.json<{
      result: { structuredContent: { ok: boolean; error: { code: string; message: string } } };
    }>().result.structuredContent).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND", message: "Design not found." },
    });
    for (const value of hidden) expect(deniedMcp.body).not.toContain(value);

    application.enterprise.revokeAgentConnection("local", challenge.connection.id);
    const beforeRevoked = state(application);
    const revokedCallbacks = [
      () => application.enterprise.readProductSpecification(actorId, fixture.allowed.id),
      () => application.enterprise.listProductSpecificationHistory(actorId, fixture.allowed.id),
      () => application.enterprise.previewProductSpecification(actorId, {
        designId: fixture.allowed.id,
        baseVersion: 1,
        naturalLanguageBrief: "Must not create after revocation",
      }),
      () => application.enterprise.readProductSpecificationPreview(
        actorId,
        fixture.allowed.id,
        allowedPreview.id,
      ),
      () => application.enterprise.commitProductSpecificationPreview(actorId, {
        designId: fixture.allowed.id,
        previewId: allowedPreview.id,
        expectedBaseVersion: 0,
        idempotencyKey: "product-spec-revoked-commit-0001",
      }),
    ];
    for (const callback of revokedCallbacks) {
      expectHiddenDomainError(captureDomainError(callback), 401, "AUTH_REQUIRED", [
        ...hidden,
        paired.grant.token,
      ]);
    }
    expect(state(application)).toEqual(beforeRevoked);

    const revokedMcp = await mcpTool(application, paired.grant.token, "product_spec_read", {
      design_id: fixture.allowed.id,
    });
    expectHiddenError(revokedMcp, 401, "AUTH_REQUIRED", [...hidden, paired.grant.token]);
  });
});
