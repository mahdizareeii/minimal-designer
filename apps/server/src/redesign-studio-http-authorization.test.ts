import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createEmptyRedesignStageArtifact } from "@designer/core";
import { afterEach, describe, expect, it } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { loadConfig } from "./config.js";
import type { DomainError } from "./errors.js";
import { PROTECTED_NON_MCP_ROUTE_CONTRACTS } from "./public-route-contract.js";
import type { RedesignAssessmentResult } from "./redesign-studio-service.js";
import type { UploadRepositoryInventory } from "./workspace-handoff-service.js";

const PROXY_SECRET = "redesign-http-proxy-secret-0123456789abcdef";
const ADMIN = "redesign-admin@example.test";
const PRODUCT_MANAGER = "redesign-pm@example.test";
const EDITOR = "redesign-editor@example.test";
const ENGINEER = "redesign-engineer@example.test";
const VIEWER = "redesign-viewer@example.test";

const REDESIGN_ROUTE_KEYS = [
  "POST /api/redesign-assessments",
  "GET /api/redesign-assessments/:assessmentId",
  "GET /api/redesign-assessments/:assessmentId/stages/:stage/artifact",
  "PUT /api/redesign-assessments/:assessmentId/stages/:stage/artifact",
  "PATCH /api/redesign-assessments/:assessmentId/current-stage",
  "POST /api/redesign-assessments/:assessmentId/transition",
] as const;

const applications: DesignerApplication[] = [];
const temporaryDirectories: string[] = [];

interface DesignFixture {
  id: string;
  revisionId: string;
  version: number;
}

interface ForeignFixture {
  actorId: string;
  token: string;
  design: DesignFixture;
  assessment: RedesignAssessmentResult;
}

interface RedesignHttpFixture {
  application: DesignerApplication;
  allowed: DesignFixture;
  denied: DesignFixture;
  inventoryId: string;
  allowedAssessment: RedesignAssessmentResult;
  deniedAssessment: RedesignAssessmentResult;
  inventoryAssessment: RedesignAssessmentResult;
  foreign: ForeignFixture;
  markers: string[];
}

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.promises.rm(directory, { recursive: true, force: true })
  )));
});

async function serverApplication(label: string): Promise<DesignerApplication> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `formaspec-redesign-auth-${label}-`));
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
    DESIGNER_TOKEN: "redesign-http-bootstrap-token-0001",
    FORMASPEC_TRUSTED_PROXIES: "127.0.0.1",
    FORMASPEC_PROXY_SECRET: PROXY_SECRET,
    DESIGNER_CORS_ORIGINS: "https://design.example.test",
    DESIGNER_LOG_LEVEL: "silent",
  }));
  applications.push(application);
  await application.app.ready();
  return application;
}

function trustedHeaders(identity = ADMIN): Record<string, string> {
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
    headers: trustedHeaders(identity),
  });
  expect(response.statusCode, response.body).toBe(200);
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
    idempotencyKey: `redesign-auth-design-${label}-0001`,
  });
  return {
    id: created.document.id,
    revisionId: created.revision.id,
    version: created.design.version,
  };
}

function inventory(seed: string, marker: string): UploadRepositoryInventory {
  return {
    schemaVersion: 1,
    repositoryFingerprint: seed.repeat(64),
    generatedAt: "2026-07-21T11:00:00.000Z",
    platforms: ["web"],
    gitHead: seed.repeat(40),
    excludedPatterns: [".env", ".env.*", "*.pem", "*.key", "**/secrets/**", "**/.git/**"],
    scannedFileCount: 3,
    skippedFileCount: 2,
    bytesRead: 2_048,
    truncated: false,
    entities: [{
      id: `inv_${seed.repeat(40)}`,
      kind: "screen",
      name: marker,
      symbol: "CheckoutScreen",
      locationId: `loc_${seed.repeat(40)}`,
      line: 21,
    }],
    excluded: [{ category: "secret", count: 2 }],
  };
}

function artifactItem(id: string, title: string) {
  return {
    id,
    title,
    description: `${title} reviewed evidence`,
    status: "reviewed" as const,
    priority: "normal" as const,
    evidence: [],
    linked_ids: [],
  };
}

function reviewedConnectArtifact() {
  return {
    ...createEmptyRedesignStageArtifact("connect_inspect"),
    summary: "The exact design and access boundaries were reviewed.",
    review_status: "reviewed" as const,
    inventory: [artifactItem("redesign_item_authinventory", "Current design inventory")],
    source_connections: [artifactItem("redesign_item_authconnection", "Explicit design connection")],
    constraints: [artifactItem("redesign_item_authconstraint", "No source mutation")],
  };
}

function installForeignFixture(application: DesignerApplication, label: string): ForeignFixture {
  const organizationId = `organization_redesign_foreign_${label}`;
  const principalId = `principal_redesign_foreign_${label}`;
  const connectionId = `connection_redesign_foreign_${label}`;
  const grantId = `redesign_foreign_${label}`;
  const token = `fsg_redesign_foreign_${label}_SECRET_TOKEN_8b16f2`;
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 3_600_000).toISOString();
  const scopes = ["design:write", "redesign:assessment", "redesign:read", "redesign:review"];
  const scopesJson = JSON.stringify(scopes);

  application.database.sqlite.prepare(
    "INSERT INTO organizations (id, name, config_json, created_at, updated_at) VALUES (?, ?, '{}', ?, ?)",
  ).run(organizationId, `Foreign redesign organization ${label}`, createdAt, createdAt);
  application.database.sqlite.prepare(
    `INSERT INTO principals (id, organization_id, kind, display_name, external_id, created_at)
     VALUES (?, ?, 'agent', ?, ?, ?)`,
  ).run(principalId, organizationId, `Foreign redesign actor ${label}`, `foreign:redesign:${label}`, createdAt);
  application.database.sqlite.prepare(
    "INSERT INTO memberships (organization_id, principal_id, role, created_at) VALUES (?, ?, 'agent', ?)",
  ).run(organizationId, principalId, createdAt);
  application.database.sqlite.prepare(
    `INSERT INTO agent_connections
     (id, organization_id, principal_id, adapter, display_name, status, scopes_json, project_ids_json,
      expires_at, created_at, updated_at)
     VALUES (?, ?, ?, 'generic_mcp', ?, 'active', ?, '[]', ?, ?, ?)`,
  ).run(connectionId, organizationId, principalId, `Foreign redesign connection ${label}`, scopesJson, expiresAt, createdAt, createdAt);
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
  const foreignDesign = createDesign(
    application,
    actorId,
    `${label}-foreign`,
    "FOREIGN_REDESIGN_PROJECT_MARKER_26f18d",
  );
  const assessment = application.redesign.createOneClickAssessment(actorId, {
    designId: foreignDesign.id,
    expectedDesignVersion: 1,
    brief: "FOREIGN_REDESIGN_ASSESSMENT_MARKER_11ca74 /srv/private/.env.production",
    content: { sourceMarker: "FOREIGN_REDESIGN_CONTENT_MARKER_75a201" },
  });
  return { actorId, token, design: foreignDesign, assessment };
}

async function setup(label: string): Promise<RedesignHttpFixture> {
  const application = await serverApplication(label);
  await warm(application, ADMIN);
  const current = application.policies.read(`trusted:${ADMIN}`);
  const policy = structuredClone(current.policy);
  policy.identity.roleMappings = [
    { claim: "identity", value: ADMIN, role: "organization_admin" },
    { claim: "identity", value: PRODUCT_MANAGER, role: "product_manager" },
    { claim: "identity", value: EDITOR, role: "design_editor" },
    { claim: "identity", value: ENGINEER, role: "engineer" },
    { claim: "identity", value: VIEWER, role: "viewer" },
  ];
  application.policies.update(`trusted:${ADMIN}`, {
    expectedConfigurationHash: current.configurationHash,
    policy,
  });
  await Promise.all([
    warm(application, PRODUCT_MANAGER),
    warm(application, EDITOR),
    warm(application, ENGINEER),
    warm(application, VIEWER),
  ]);

  const allowed = createDesign(application, "local", `${label}-allowed`, "Allowed redesign project");
  const denied = createDesign(application, "local", `${label}-denied`, "DENIED_REDESIGN_PROJECT_MARKER_91bc03");
  const persistedInventory = application.handoffs.persistRepositoryInventory(
    "local",
    inventory("c", "INVENTORY_ONLY_SOURCE_PATH_MARKER_/Users/private/.env"),
  );
  const allowedAssessment = application.redesign.createOneClickAssessment("local", {
    designId: allowed.id,
    expectedDesignVersion: 1,
    brief: "ALLOWED_REDESIGN_ASSESSMENT_MARKER_497bf1",
  });
  const deniedAssessment = application.redesign.createOneClickAssessment("local", {
    designId: denied.id,
    expectedDesignVersion: 1,
    brief: "DENIED_REDESIGN_ASSESSMENT_MARKER_e8105a /Users/private/company/App.tsx",
  });
  const inventoryAssessment = application.redesign.createOneClickAssessment("local", {
    inventoryId: persistedInventory.id,
    brief: "INVENTORY_ONLY_REDESIGN_ASSESSMENT_MARKER_30d1ac",
  });
  const foreign = installForeignFixture(application, label);
  return {
    application,
    allowed,
    denied,
    inventoryId: persistedInventory.id,
    allowedAssessment,
    deniedAssessment,
    inventoryAssessment,
    foreign,
    markers: [
      "DENIED_REDESIGN_PROJECT_MARKER_91bc03",
      "DENIED_REDESIGN_ASSESSMENT_MARKER_e8105a",
      "INVENTORY_ONLY_SOURCE_PATH_MARKER_/Users/private/.env",
      "INVENTORY_ONLY_REDESIGN_ASSESSMENT_MARKER_30d1ac",
      "FOREIGN_REDESIGN_PROJECT_MARKER_26f18d",
      "FOREIGN_REDESIGN_ASSESSMENT_MARKER_11ca74",
      "FOREIGN_REDESIGN_CONTENT_MARKER_75a201",
      foreign.token,
    ],
  };
}

function state(application: DesignerApplication): Record<string, unknown[]> {
  return {
    designs: application.database.sqlite.prepare(
      "SELECT id, current_version, current_revision_id FROM designs ORDER BY id",
    ).all(),
    assessments: application.database.sqlite.prepare(
      "SELECT * FROM redesign_assessments ORDER BY id",
    ).all(),
    versions: application.database.sqlite.prepare(
      "SELECT * FROM redesign_assessment_versions ORDER BY assessment_id, version",
    ).all(),
    transitions: application.database.sqlite.prepare(
      "SELECT * FROM redesign_transitions ORDER BY rowid",
    ).all(),
    auditEvents: application.database.sqlite.prepare(
      "SELECT * FROM audit_events WHERE action LIKE 'redesign.%' ORDER BY id",
    ).all(),
    outbox: application.database.sqlite.prepare(
      `SELECT id, organization_id, actor_id, event_type, payload_json, workspace, created_at
       FROM event_outbox WHERE event_type = 'redesign.transitioned' ORDER BY id`,
    ).all(),
  };
}

function captureDomainError(callback: () => unknown): DomainError {
  try {
    callback();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error("Expected a DomainError.");
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

describe("Redesign Studio HTTP authorization", () => {
  it("exercises all six routes with shared project ownership and immutable stage history", async () => {
    const fixture = await setup("happy");
    const { application } = fixture;
    const registered = [...PROTECTED_NON_MCP_ROUTE_CONTRACTS.keys()]
      .filter((key) => REDESIGN_ROUTE_KEYS.includes(key as (typeof REDESIGN_ROUTE_KEYS)[number]));
    expect(registered).toEqual(REDESIGN_ROUTE_KEYS);

    const created = await application.app.inject({
      method: "POST",
      url: "/api/redesign-assessments",
      remoteAddress: "127.0.0.1",
      headers: trustedHeaders(EDITOR),
      payload: {
        designId: fixture.allowed.id,
        expectedDesignVersion: 1,
        brief: "EDITOR_CREATED_REDESIGN_ASSESSMENT_MARKER_a0712f",
        content: { objective: "Document before proposing" },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    let assessment = created.json<{ assessment: RedesignAssessmentResult }>().assessment;
    expect(assessment).toMatchObject({
      designId: fixture.allowed.id,
      currentStage: "connect_inspect",
      currentVersion: 1,
      sourceMutation: "none",
    });

    const read = await application.app.inject({
      method: "GET",
      url: `/api/redesign-assessments/${assessment.id}`,
      remoteAddress: "127.0.0.1",
      headers: trustedHeaders(VIEWER),
    });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json<{ assessment: RedesignAssessmentResult }>().assessment.id).toBe(assessment.id);

    const artifactRead = await application.app.inject({
      method: "GET",
      url: `/api/redesign-assessments/${assessment.id}/stages/connect_inspect/artifact`,
      remoteAddress: "127.0.0.1",
      headers: trustedHeaders(VIEWER),
    });
    expect(artifactRead.statusCode, artifactRead.body).toBe(200);
    expect(artifactRead.json<{ stageArtifact: { assessmentId: string; headVersion: number } }>().stageArtifact)
      .toMatchObject({ assessmentId: assessment.id, headVersion: 1 });

    const revised = await application.app.inject({
      method: "PATCH",
      url: `/api/redesign-assessments/${assessment.id}/current-stage`,
      remoteAddress: "127.0.0.1",
      headers: trustedHeaders(EDITOR),
      payload: {
        expectedVersion: 1,
        expectedDesignVersion: 1,
        content: { objective: "Evidence-backed current-state review" },
      },
    });
    expect(revised.statusCode, revised.body).toBe(200);
    assessment = revised.json<{ assessment: RedesignAssessmentResult }>().assessment;
    expect(assessment.currentVersion).toBe(2);

    const artifact = reviewedConnectArtifact();
    const artifactWrite = await application.app.inject({
      method: "PUT",
      url: `/api/redesign-assessments/${assessment.id}/stages/connect_inspect/artifact`,
      remoteAddress: "127.0.0.1",
      headers: trustedHeaders(ENGINEER),
      payload: {
        expectedVersion: 2,
        expectedDesignVersion: 1,
        artifact,
      },
    });
    expect(artifactWrite.statusCode, artifactWrite.body).toBe(200);
    assessment = artifactWrite.json<{ assessment: RedesignAssessmentResult }>().assessment;
    expect(assessment).toMatchObject({
      currentVersion: 3,
      current: { artifact },
    });

    const transitioned = await application.app.inject({
      method: "POST",
      url: `/api/redesign-assessments/${assessment.id}/transition`,
      remoteAddress: "127.0.0.1",
      headers: trustedHeaders(EDITOR),
      payload: {
        expectedVersion: 3,
        expectedDesignVersion: 1,
        toStage: "document_current_state",
        decision: "advanced",
        content: { objective: "Document the reviewed current state" },
      },
    });
    expect(transitioned.statusCode, transitioned.body).toBe(200);
    assessment = transitioned.json<{ assessment: RedesignAssessmentResult }>().assessment;
    expect(assessment).toMatchObject({
      currentStage: "document_current_state",
      currentVersion: 4,
      sourceMutation: "none",
    });
    expect(assessment.versions).toHaveLength(4);
    expect(assessment.transitions.map((transition) => transition.decision)).toEqual(["created", "advanced"]);
  });

  it("checks dynamic role authorization before exposing assessment status, version, or current stage", async () => {
    const fixture = await setup("role-order");
    const { application } = fixture;
    const hidden = [
      ...fixture.markers,
      fixture.deniedAssessment.id,
      fixture.foreign.assessment.id,
    ];
    const before = state(application);

    const viewerCreate = await application.app.inject({
      method: "POST",
      url: "/api/redesign-assessments",
      remoteAddress: "127.0.0.1",
      headers: trustedHeaders(VIEWER),
      payload: {
        designId: fixture.allowed.id,
        expectedDesignVersion: 1,
        brief: "Viewer must not create a redesign assessment.",
      },
    });
    expectHiddenError(viewerCreate, 403, "FORBIDDEN", hidden);

    const staleRevision = await application.app.inject({
      method: "PATCH",
      url: `/api/redesign-assessments/${fixture.allowedAssessment.id}/current-stage`,
      remoteAddress: "127.0.0.1",
      headers: trustedHeaders(VIEWER),
      payload: {
        expectedVersion: 999,
        expectedDesignVersion: 1,
        content: { forbidden: true },
      },
    });
    expectHiddenError(staleRevision, 403, "FORBIDDEN", hidden);

    const stageMismatch = await application.app.inject({
      method: "PUT",
      url: `/api/redesign-assessments/${fixture.allowedAssessment.id}/stages/document_current_state/artifact`,
      remoteAddress: "127.0.0.1",
      headers: trustedHeaders(VIEWER),
      payload: {
        expectedVersion: 1,
        expectedDesignVersion: 1,
        artifact: createEmptyRedesignStageArtifact("document_current_state"),
      },
    });
    expectHiddenError(stageMismatch, 403, "FORBIDDEN", hidden);

    const staleTransition = await application.app.inject({
      method: "POST",
      url: `/api/redesign-assessments/${fixture.allowedAssessment.id}/transition`,
      remoteAddress: "127.0.0.1",
      headers: trustedHeaders(VIEWER),
      payload: {
        expectedVersion: 999,
        expectedDesignVersion: 1,
        toStage: "document_current_state",
        decision: "advanced",
      },
    });
    expectHiddenError(staleTransition, 403, "FORBIDDEN", hidden);

    const engineerCancel = await application.app.inject({
      method: "POST",
      url: `/api/redesign-assessments/${fixture.allowedAssessment.id}/transition`,
      remoteAddress: "127.0.0.1",
      headers: trustedHeaders(ENGINEER),
      payload: {
        expectedVersion: 1,
        expectedDesignVersion: 1,
        toStage: "connect_inspect",
        decision: "cancelled",
      },
    });
    expectHiddenError(engineerCancel, 403, "FORBIDDEN", hidden);
    expect(state(application)).toEqual(before);
  });

  it("hides foreign and type-swapped assessment parents on all opaque-ID routes without mutation", async () => {
    const fixture = await setup("opaque-ids");
    const { application } = fixture;
    const hidden = [
      ...fixture.markers,
      fixture.denied.id,
      fixture.deniedAssessment.id,
      fixture.foreign.design.id,
      fixture.foreign.design.revisionId,
      fixture.foreign.assessment.id,
      fixture.inventoryId,
    ];
    const before = state(application);

    const foreignDesign = await application.app.inject({
      method: "POST",
      url: "/api/redesign-assessments",
      remoteAddress: "127.0.0.1",
      headers: trustedHeaders(),
      payload: {
        designId: fixture.foreign.design.id,
        expectedDesignVersion: 1,
        brief: "Must not create against a foreign project.",
      },
    });
    expectHiddenError(foreignDesign, 404, "NOT_FOUND", hidden);

    const swappedInventory = await application.app.inject({
      method: "POST",
      url: "/api/redesign-assessments",
      remoteAddress: "127.0.0.1",
      headers: trustedHeaders(),
      payload: {
        designId: fixture.allowed.id,
        inventoryId: fixture.foreign.assessment.id,
        expectedDesignVersion: 1,
        brief: "A redesign assessment ID must not bind as an inventory.",
      },
    });
    expectHiddenError(swappedInventory, 404, "NOT_FOUND", hidden);

    const assessmentRoutes = [
      { method: "GET", suffix: "" },
      { method: "GET", suffix: "/stages/connect_inspect/artifact" },
      {
        method: "PUT",
        suffix: "/stages/connect_inspect/artifact",
        payload: {
          expectedVersion: 1,
          expectedDesignVersion: 1,
          artifact: reviewedConnectArtifact(),
        },
      },
      {
        method: "PATCH",
        suffix: "/current-stage",
        payload: {
          expectedVersion: 1,
          expectedDesignVersion: 1,
          content: { forbidden: true },
        },
      },
      {
        method: "POST",
        suffix: "/transition",
        payload: {
          expectedVersion: 1,
          expectedDesignVersion: 1,
          toStage: "connect_inspect",
          decision: "cancelled",
        },
      },
    ] as const;
    for (const candidateId of [
      fixture.foreign.assessment.id,
      fixture.allowed.id,
      fixture.inventoryId,
    ]) {
      for (const route of assessmentRoutes) {
        const response = await application.app.inject({
          method: route.method,
          url: `/api/redesign-assessments/${candidateId}${route.suffix}`,
          remoteAddress: "127.0.0.1",
          headers: trustedHeaders(),
          ...("payload" in route ? { payload: route.payload } : {}),
        });
        expectHiddenError(response, 404, "NOT_FOUND", hidden);
      }
    }
    expect(state(application)).toEqual(before);
  });

  it("enforces project-scoped service and MCP access plus immediate connection revocation", async () => {
    const fixture = await setup("scoped-agent");
    const { application } = fixture;
    const challenge = application.enterprise.createAgentConnection("local", {
      adapter: "codex",
      displayName: "Project-restricted redesign reviewer",
      scopes: ["redesign:read", "redesign:review"],
      projectIds: [fixture.allowed.id],
      expiresInSeconds: 3_600,
    });
    const paired = application.enterprise.pairAgentConnection(challenge.nonce);
    const actorId = paired.grant.actorId;

    const bearerRest = await application.app.inject({
      method: "GET",
      url: `/api/redesign-assessments/${fixture.allowedAssessment.id}`,
      remoteAddress: "127.0.0.1",
      headers: {
        host: "design.example.test",
        authorization: `Bearer ${paired.grant.token}`,
        "x-formaspec-proxy-secret": PROXY_SECRET,
      },
    });
    expectHiddenError(bearerRest, 401, "AUTH_REQUIRED", [...fixture.markers, paired.grant.token]);

    expect(application.redesign.getAssessment(actorId, fixture.allowedAssessment.id).id)
      .toBe(fixture.allowedAssessment.id);
    expect(application.redesign.getStageArtifact(
      actorId,
      fixture.allowedAssessment.id,
      "connect_inspect",
    ).assessmentId).toBe(fixture.allowedAssessment.id);
    let revised = application.redesign.reviseCurrentStage(actorId, fixture.allowedAssessment.id, {
      expectedVersion: 1,
      expectedDesignVersion: 1,
      content: { summary: "Scoped review content" },
    });
    revised = application.redesign.reviseStageArtifact(actorId, revised.id, {
      expectedVersion: revised.currentVersion,
      expectedDesignVersion: 1,
      stage: "connect_inspect",
      artifact: reviewedConnectArtifact(),
    });
    expect(revised.currentVersion).toBe(3);

    const allowedMcp = await mcpTool(application, paired.grant.token, "redesign_assessment_read", {
      assessment_id: revised.id,
    });
    expect(allowedMcp.statusCode, allowedMcp.body).toBe(200);
    expect(allowedMcp.json<{
      result: { structuredContent: { ok: boolean; assessment: { id: string; designId: string } } };
    }>().result.structuredContent).toMatchObject({
      ok: true,
      assessment: { id: revised.id, designId: fixture.allowed.id },
    });

    const hidden = [
      ...fixture.markers,
      fixture.denied.id,
      fixture.deniedAssessment.id,
      fixture.inventoryAssessment.id,
      fixture.foreign.design.id,
      fixture.foreign.assessment.id,
      paired.grant.token,
    ];
    const deniedAssessments = [
      { id: fixture.deniedAssessment.id, expectedDesignVersion: 1 },
      { id: fixture.foreign.assessment.id, expectedDesignVersion: 1 },
      { id: fixture.inventoryAssessment.id, expectedDesignVersion: undefined },
    ];
    const beforeDenied = state(application);
    for (const denied of deniedAssessments) {
      const callbacks = [
        () => application.redesign.getAssessment(actorId, denied.id),
        () => application.redesign.getStageArtifact(actorId, denied.id, "connect_inspect"),
        () => application.redesign.reviseCurrentStage(actorId, denied.id, {
          expectedVersion: 1,
          ...(denied.expectedDesignVersion === undefined
            ? {}
            : { expectedDesignVersion: denied.expectedDesignVersion }),
          content: { forbidden: true },
        }),
        () => application.redesign.reviseStageArtifact(actorId, denied.id, {
          expectedVersion: 1,
          ...(denied.expectedDesignVersion === undefined
            ? {}
            : { expectedDesignVersion: denied.expectedDesignVersion }),
          stage: "connect_inspect",
          artifact: reviewedConnectArtifact(),
        }),
        () => application.redesign.transition(actorId, denied.id, {
          expectedVersion: 1,
          ...(denied.expectedDesignVersion === undefined
            ? {}
            : { expectedDesignVersion: denied.expectedDesignVersion }),
          toStage: "document_current_state",
          decision: "advanced",
        }),
      ];
      for (const callback of callbacks) {
        expectHiddenDomainError(captureDomainError(callback), 404, "NOT_FOUND", hidden);
      }
    }
    expect(state(application)).toEqual(beforeDenied);

    const deniedMcp = await mcpTool(application, paired.grant.token, "redesign_stage_revise", {
      assessment_id: fixture.deniedAssessment.id,
      expected_version: 1,
      expected_design_version: 1,
      content: { forbidden: true },
    });
    expect(deniedMcp.statusCode, deniedMcp.body).toBe(200);
    expect(deniedMcp.json<{
      result: { structuredContent: { ok: boolean; error: { code: string; message: string } } };
    }>().result.structuredContent).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND", message: "Design not found." },
    });
    for (const marker of hidden) expect(deniedMcp.body).not.toContain(marker);
    expect(state(application)).toEqual(beforeDenied);

    application.enterprise.revokeAgentConnection("local", challenge.connection.id);
    const beforeRevoked = state(application);
    const revokedCallbacks = [
      () => application.redesign.getAssessment(actorId, revised.id),
      () => application.redesign.getStageArtifact(actorId, revised.id, "connect_inspect"),
      () => application.redesign.reviseCurrentStage(actorId, revised.id, {
        expectedVersion: revised.currentVersion,
        expectedDesignVersion: 1,
        content: { forbidden: "revoked" },
      }),
      () => application.redesign.transition(actorId, revised.id, {
        expectedVersion: revised.currentVersion,
        expectedDesignVersion: 1,
        toStage: "document_current_state",
        decision: "advanced",
      }),
    ];
    for (const callback of revokedCallbacks) {
      expectHiddenDomainError(captureDomainError(callback), 401, "AUTH_REQUIRED", hidden);
    }
    expect(state(application)).toEqual(beforeRevoked);

    const revokedMcp = await mcpTool(application, paired.grant.token, "redesign_assessment_read", {
      assessment_id: revised.id,
    });
    expectHiddenError(revokedMcp, 401, "AUTH_REQUIRED", hidden);
  });
});
