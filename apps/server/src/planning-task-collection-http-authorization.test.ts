import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { resolveAccess } from "./authorization.js";
import { loadConfig } from "./config.js";
import type { DomainError } from "./errors.js";
import type { AgentTaskResult, PlanningSessionResult } from "./enterprise-service.js";

const PROXY_SECRET = "planning-task-collection-proxy-secret-0123456789abcdef";
const PUBLIC_ORIGIN = "https://design.example.test";
const ADMIN_IDENTITY = "planning-task-admin@example.test";
const PRODUCT_MANAGER_IDENTITY = "planning-task-pm@example.test";
const DESIGN_EDITOR_IDENTITY = "planning-task-editor@example.test";
const VIEWER_IDENTITY = "planning-task-viewer@example.test";
const PRIVATE_MARKER = "PLANNING_TASK_COLLECTION_PRIVATE_8e31b6";
const PRIVATE_PATH = "/Users/private/company/formaspec/product-plan.json";
const PRIVATE_TOKEN = "fsg_planning_task_private_token_5a0d29";

const applications: DesignerApplication[] = [];
const temporaryDirectories: string[] = [];

interface DesignFixture {
  id: string;
  version: number;
}

interface GrantFixture {
  actorId: string;
  token: string;
}

interface Fixture {
  application: DesignerApplication;
  allowed: DesignFixture;
  restricted: DesignFixture;
  foreign: DesignFixture;
  allowedSession: PlanningSessionResult;
  restrictedSession: PlanningSessionResult;
  foreignSession: PlanningSessionResult;
  allowedTask: AgentTaskResult;
  restrictedTask: AgentTaskResult;
  foreignTask: AgentTaskResult;
  scopedAgent: GrantFixture;
  scopeDeniedAgent: GrantFixture;
  foreignAgent: GrantFixture;
  hidden: string[];
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(applications.splice(0).map((application) => application.app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.promises.rm(directory, { recursive: true, force: true })));
});

async function serverApplication(label: string): Promise<DesignerApplication> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `formaspec-planning-task-collection-${label}-`));
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
    DESIGNER_TOKEN: "planning-task-collection-bootstrap-token-0001",
    FORMASPEC_TRUSTED_PROXIES: "127.0.0.1",
    FORMASPEC_PROXY_SECRET: PROXY_SECRET,
    DESIGNER_CORS_ORIGINS: PUBLIC_ORIGIN,
    DESIGNER_LOG_LEVEL: "silent",
  }));
  applications.push(application);
  await application.app.ready();
  return application;
}

function serverHeaders(identity = PRODUCT_MANAGER_IDENTITY): Record<string, string> {
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

async function warmIdentity(application: DesignerApplication, identity: string): Promise<void> {
  const response = await application.app.inject({
    method: "GET",
    url: "/api/designs",
    remoteAddress: "127.0.0.1",
    headers: serverHeaders(identity),
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
    idempotencyKey: `planning-task-collection-design-${label}-0001`,
  });
  return { id: created.document.id, version: created.design.version };
}

function installForeignAgent(application: DesignerApplication, label: string): GrantFixture {
  const organizationId = `organization_planning_task_foreign_${label}`;
  const principalId = `principal_planning_task_foreign_${label}`;
  const connectionId = `connection_planning_task_foreign_${label}`;
  const grantId = `planning_task_foreign_${label}`;
  const token = `fsg_${label}_${PRIVATE_TOKEN}`;
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 3_600_000).toISOString();
  const scopes = ["design:write", "planning:read", "planning:write", "task:read", "task:create"];
  const scopesJson = JSON.stringify(scopes);

  application.database.sqlite.prepare(
    "INSERT INTO organizations (id, name, config_json, created_at, updated_at) VALUES (?, ?, '{}', ?, ?)",
  ).run(organizationId, `Foreign planning/task organization ${PRIVATE_MARKER}`, createdAt, createdAt);
  application.database.sqlite.prepare(
    `INSERT INTO principals (id, organization_id, kind, display_name, external_id, created_at)
     VALUES (?, ?, 'agent', ?, ?, ?)`,
  ).run(principalId, organizationId, `Foreign ${PRIVATE_MARKER}`, `foreign:${PRIVATE_PATH}`, createdAt);
  application.database.sqlite.prepare(
    "INSERT INTO memberships (organization_id, principal_id, role, created_at) VALUES (?, ?, 'agent', ?)",
  ).run(organizationId, principalId, createdAt);
  application.database.sqlite.prepare(
    `INSERT INTO agent_connections
     (id, organization_id, principal_id, adapter, display_name, status, scopes_json, project_ids_json,
      expires_at, created_at, updated_at)
     VALUES (?, ?, ?, 'generic_mcp', ?, 'active', ?, '[]', ?, ?, ?)`,
  ).run(
    connectionId,
    organizationId,
    principalId,
    `Foreign ${PRIVATE_MARKER}`,
    scopesJson,
    expiresAt,
    createdAt,
    createdAt,
  );
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

function seedPlanningSession(
  application: DesignerApplication,
  actorId: string,
  designId: string,
  label: string,
  answer: string,
): PlanningSessionResult {
  const created = application.enterprise.createPlanningSession(actorId, {
    designId,
    idempotencyKey: `planning-task-collection-session-${label}-0001`,
  });
  return application.enterprise.savePlanningAnswer(actorId, created.session.id, {
    expectedVersion: created.session.version,
    section: "product_purpose",
    answer,
  });
}

function seedAgentTask(
  application: DesignerApplication,
  actorId: string,
  design: DesignFixture,
  label: string,
  brief: string,
): AgentTaskResult {
  return application.enterprise.createAgentTask(actorId, {
    designId: design.id,
    brief,
    baseVersion: design.version,
    expectedOutput: "design_preview",
    idempotencyKey: `planning-task-collection-task-${label}-0001`,
  });
}

async function createFixture(label: string): Promise<Fixture> {
  const application = await serverApplication(label);
  await warmIdentity(application, ADMIN_IDENTITY);
  const current = application.policies.read(`trusted:${ADMIN_IDENTITY}`);
  const policy = structuredClone(current.policy);
  policy.identity.roleMappings = [
    { claim: "identity", value: ADMIN_IDENTITY, role: "organization_admin" },
    { claim: "identity", value: PRODUCT_MANAGER_IDENTITY, role: "product_manager" },
    { claim: "identity", value: DESIGN_EDITOR_IDENTITY, role: "design_editor" },
    { claim: "identity", value: VIEWER_IDENTITY, role: "viewer" },
  ];
  application.policies.update(`trusted:${ADMIN_IDENTITY}`, {
    expectedConfigurationHash: current.configurationHash,
    policy,
  });
  await Promise.all([
    warmIdentity(application, PRODUCT_MANAGER_IDENTITY),
    warmIdentity(application, DESIGN_EDITOR_IDENTITY),
    warmIdentity(application, VIEWER_IDENTITY),
  ]);

  const allowed = createDesign(application, "local", `${label}-allowed`, "Allowed planning/task project");
  const restricted = createDesign(
    application,
    "local",
    `${label}-restricted`,
    `Restricted ${PRIVATE_MARKER} ${PRIVATE_PATH}`,
  );
  const allowedSession = seedPlanningSession(
    application,
    "local",
    allowed.id,
    `${label}-allowed`,
    "Allowed product planning answer",
  );
  const restrictedSession = seedPlanningSession(
    application,
    "local",
    restricted.id,
    `${label}-restricted`,
    `${PRIVATE_MARKER}:${PRIVATE_PATH}`,
  );
  const allowedTask = seedAgentTask(
    application,
    "local",
    allowed,
    `${label}-allowed`,
    "Allowed product design task",
  );
  const restrictedTask = seedAgentTask(
    application,
    "local",
    restricted,
    `${label}-restricted`,
    `${PRIVATE_MARKER}:${PRIVATE_TOKEN}:${PRIVATE_PATH}`,
  );

  const foreignAgent = installForeignAgent(application, label);
  const foreign = createDesign(
    application,
    foreignAgent.actorId,
    `${label}-foreign`,
    `Foreign ${PRIVATE_MARKER} ${PRIVATE_PATH}`,
  );
  const foreignSession = seedPlanningSession(
    application,
    foreignAgent.actorId,
    foreign.id,
    `${label}-foreign`,
    `${PRIVATE_MARKER}:${PRIVATE_TOKEN}:${PRIVATE_PATH}`,
  );
  const foreignTask = seedAgentTask(
    application,
    foreignAgent.actorId,
    foreign,
    `${label}-foreign`,
    `${PRIVATE_MARKER}:${PRIVATE_TOKEN}:${PRIVATE_PATH}`,
  );

  const scopedChallenge = application.enterprise.createAgentConnection("local", {
    adapter: "codex",
    displayName: `Scoped planning/task agent ${label}`,
    scopes: ["planning:read", "planning:write", "task:read", "task:create"],
    projectIds: [allowed.id],
    expiresInSeconds: 3_600,
  });
  const scopedPairing = application.enterprise.pairAgentConnection(scopedChallenge.nonce);
  const deniedChallenge = application.enterprise.createAgentConnection("local", {
    adapter: "codex",
    displayName: `Scope-denied planning/task agent ${label}`,
    scopes: ["design:read"],
    projectIds: [allowed.id],
    expiresInSeconds: 3_600,
  });
  const deniedPairing = application.enterprise.pairAgentConnection(deniedChallenge.nonce);

  return {
    application,
    allowed,
    restricted,
    foreign,
    allowedSession,
    restrictedSession,
    foreignSession,
    allowedTask,
    restrictedTask,
    foreignTask,
    scopedAgent: { actorId: scopedPairing.grant.actorId, token: scopedPairing.grant.token },
    scopeDeniedAgent: { actorId: deniedPairing.grant.actorId, token: deniedPairing.grant.token },
    foreignAgent,
    hidden: [
      PRIVATE_MARKER,
      PRIVATE_PATH,
      PRIVATE_TOKEN,
      foreignAgent.token,
      restricted.id,
      foreign.id,
      restrictedSession.session.id,
      foreignSession.session.id,
      restrictedTask.id,
      foreignTask.id,
    ],
  };
}

function seedExpiredIdempotency(application: DesignerApplication, label: string): void {
  const access = resolveAccess(application.database.sqlite, "local");
  application.database.sqlite.prepare(
    `INSERT INTO idempotency
     (actor_id, scope, key, request_hash, response_json, created_at, expires_at)
     VALUES (?, ?, ?, ?, '{}', '1999-12-31T23:59:59.000Z', '2000-01-01T00:00:00.000Z')`,
  ).run(
    access.principalId,
    `planning-task-collection-expired:${label}`,
    `planning-task-expired-${label}-0001`,
    createHash("sha256").update(label).digest("hex"),
  );
}

function workflowState(application: DesignerApplication): unknown {
  return {
    sessions: application.database.sqlite.prepare("SELECT * FROM planning_sessions ORDER BY organization_id, id").all(),
    versions: application.database.sqlite.prepare(
      "SELECT * FROM planning_session_versions ORDER BY session_id, version",
    ).all(),
    answers: application.database.sqlite.prepare(
      "SELECT * FROM planning_answers ORDER BY session_id, section, version",
    ).all(),
    tasks: application.database.sqlite.prepare("SELECT * FROM agent_tasks ORDER BY organization_id, id").all(),
    transitions: application.database.sqlite.prepare(
      "SELECT * FROM agent_task_transitions ORDER BY task_id, rowid",
    ).all(),
    idempotency: application.database.sqlite.prepare(
      "SELECT * FROM idempotency ORDER BY actor_id, scope, key",
    ).all(),
    audits: application.database.sqlite.prepare(
      `SELECT organization_id, actor_id, action, target_type, target_id, details_json
       FROM audit_events
       WHERE action LIKE 'planning_session.%' OR action LIKE 'agent_task.%'
       ORDER BY id`,
    ).all(),
    outbox: application.database.sqlite.prepare(
      `SELECT organization_id, actor_id, event_type, payload_json, workspace, created_at
       FROM event_outbox
       WHERE event_type LIKE 'planning_session.%' OR event_type LIKE 'agent_task.%'
       ORDER BY id`,
    ).all(),
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

function expectHiddenDomainError(error: DomainError, statusCode: number, code: string, hidden: string[]): void {
  expect(error).toMatchObject({ statusCode, code });
  const serialized = JSON.stringify(error.toJSON());
  for (const marker of hidden) expect(serialized).not.toContain(marker);
}

describe("planning-session and agent-task collection HTTP authorization", () => {
  it("authorizes all four routes before malformed path, query, body, cleanup, or deeper service work", async () => {
    const fixture = await createFixture("ordering");
    const { application } = fixture;
    seedExpiredIdempotency(application, "ordering");
    const before = workflowState(application);
    const planningList = vi.spyOn(application.enterprise, "listPlanningSessions");
    const planningCreate = vi.spyOn(application.enterprise, "createPlanningSession");
    const taskList = vi.spyOn(application.enterprise, "listAgentTasks");
    const taskCreate = vi.spyOn(application.enterprise, "createAgentTask");

    const unauthenticated = [
      { method: "GET", url: `/api/designs/%20/planning-sessions?limit=${PRIVATE_MARKER}` },
      { method: "POST", url: "/api/designs/%20/planning-sessions", payload: { privateMarker: PRIVATE_MARKER } },
      { method: "GET", url: `/api/designs/%20/agent-tasks?status=${PRIVATE_MARKER}` },
      { method: "POST", url: "/api/designs/%20/agent-tasks", payload: { privateMarker: PRIVATE_MARKER } },
    ] as const;
    for (const request of unauthenticated) {
      const response = await application.app.inject({
        ...request,
        remoteAddress: "127.0.0.1",
        headers: unauthenticatedHeaders(),
      });
      expectHiddenError(response, 401, "AUTH_REQUIRED", fixture.hidden);
    }

    const viewerHeaders = serverHeaders(VIEWER_IDENTITY);
    const roleDenied = await Promise.all([
      application.app.inject({
        method: "POST",
        url: "/api/designs/%20/planning-sessions",
        remoteAddress: "127.0.0.1",
        headers: viewerHeaders,
        payload: { privateMarker: PRIVATE_MARKER },
      }),
      application.app.inject({
        method: "POST",
        url: "/api/designs/%20/agent-tasks",
        remoteAddress: "127.0.0.1",
        headers: viewerHeaders,
        payload: { privateMarker: PRIVATE_MARKER },
      }),
    ]);
    for (const response of roleDenied) expectHiddenError(response, 403, "FORBIDDEN", fixture.hidden);

    const projectDenied = await Promise.all([
      application.app.inject({
        method: "GET",
        url: `/api/designs/${fixture.foreign.id}/planning-sessions?limit=${PRIVATE_MARKER}`,
        remoteAddress: "127.0.0.1",
        headers: serverHeaders(),
      }),
      application.app.inject({
        method: "POST",
        url: `/api/designs/${fixture.foreign.id}/planning-sessions`,
        remoteAddress: "127.0.0.1",
        headers: serverHeaders(),
        payload: { privateMarker: PRIVATE_MARKER },
      }),
      application.app.inject({
        method: "GET",
        url: `/api/designs/${fixture.foreign.id}/agent-tasks?status=${PRIVATE_MARKER}&limit=${PRIVATE_MARKER}`,
        remoteAddress: "127.0.0.1",
        headers: serverHeaders(),
      }),
      application.app.inject({
        method: "POST",
        url: `/api/designs/${fixture.foreign.id}/agent-tasks`,
        remoteAddress: "127.0.0.1",
        headers: serverHeaders(),
        payload: { privateMarker: PRIVATE_MARKER },
      }),
    ]);
    for (const response of projectDenied) expectHiddenError(response, 404, "NOT_FOUND", fixture.hidden);

    const malformedReadPaths = await Promise.all([
      application.app.inject({
        method: "GET",
        url: `/api/designs/%20/planning-sessions?limit=${PRIVATE_MARKER}`,
        remoteAddress: "127.0.0.1",
        headers: viewerHeaders,
      }),
      application.app.inject({
        method: "GET",
        url: `/api/designs/%20/agent-tasks?status=${PRIVATE_MARKER}`,
        remoteAddress: "127.0.0.1",
        headers: viewerHeaders,
      }),
    ]);
    for (const response of malformedReadPaths) expectHiddenError(response, 404, "NOT_FOUND", fixture.hidden);

    const restGrant = await application.app.inject({
      method: "GET",
      url: `/api/designs/${fixture.allowed.id}/agent-tasks`,
      remoteAddress: "127.0.0.1",
      headers: grantHeaders(fixture.scopedAgent.token),
    });
    expectHiddenError(restGrant, 401, "AUTH_REQUIRED", fixture.hidden);

    expect(planningList).not.toHaveBeenCalled();
    expect(planningCreate).not.toHaveBeenCalled();
    expect(taskList).not.toHaveBeenCalled();
    expect(taskCreate).not.toHaveBeenCalled();
    expect(workflowState(application)).toEqual(before);
  });

  it("keeps restricted and foreign projects opaque while preserving scoped-agent collection semantics", async () => {
    const fixture = await createFixture("scoped-agent");
    const { application } = fixture;
    const actorId = fixture.scopedAgent.actorId;

    expect(application.enterprise.listPlanningSessions(actorId, fixture.allowed.id)
      .map((result) => result.session.id)).toContain(fixture.allowedSession.session.id);
    expect(application.enterprise.listAgentTasks(actorId, { designId: fixture.allowed.id })
      .map((task) => task.id)).toContain(fixture.allowedTask.id);
    application.enterprise.transitionAgentTask("local", fixture.allowedTask.id, {
      expectedStatus: "queued",
      toStatus: "cancelled",
    });

    const createdSession = application.enterprise.createPlanningSession(actorId, {
      designId: fixture.allowed.id,
      idempotencyKey: "planning-task-scoped-session-create-0001",
    });
    expect(createdSession).toMatchObject({
      session: { project_id: fixture.allowed.id, version: 1, status: "draft" },
      answeredSections: [],
      sectionCount: 22,
    });
    const createdTask = application.enterprise.createAgentTask(actorId, {
      designId: fixture.allowed.id,
      brief: "Scoped agent should create this immutable task",
      selection: [],
      baseVersion: fixture.allowed.version,
      expectedOutput: "design_preview",
      idempotencyKey: "planning-task-scoped-task-create-0001",
    });
    expect(createdTask).toMatchObject({
      designId: fixture.allowed.id,
      status: "queued",
      baseVersion: fixture.allowed.version,
      expectedOutput: "design_preview",
    });
    expect(application.enterprise.listPlanningSessions(actorId, fixture.allowed.id)
      .map((result) => result.session.id)).toContain(createdSession.session.id);
    expect(application.enterprise.listAgentTasks(actorId, { designId: fixture.allowed.id })
      .map((task) => task.id)).toContain(createdTask.id);

    const afterAllowed = workflowState(application);
    const opaqueCallbacks = [
      () => application.enterprise.listPlanningSessions(actorId, fixture.restricted.id),
      () => application.enterprise.createPlanningSession(actorId, {
        designId: fixture.restricted.id,
        idempotencyKey: "planning-task-restricted-session-0001",
      }),
      () => application.enterprise.listAgentTasks(actorId, { designId: fixture.restricted.id }),
      () => application.enterprise.createAgentTask(actorId, {
        designId: fixture.restricted.id,
        brief: "Must not persist",
        baseVersion: fixture.restricted.version,
        expectedOutput: "design_preview",
        idempotencyKey: "planning-task-restricted-task-0001",
      }),
      () => application.enterprise.listPlanningSessions(actorId, fixture.foreign.id),
      () => application.enterprise.createPlanningSession(actorId, {
        designId: fixture.foreign.id,
        idempotencyKey: "planning-task-foreign-session-0001",
      }),
      () => application.enterprise.listAgentTasks(actorId, { designId: fixture.foreign.id }),
      () => application.enterprise.createAgentTask(actorId, {
        designId: fixture.foreign.id,
        brief: "Must not persist",
        baseVersion: fixture.foreign.version,
        expectedOutput: "design_preview",
        idempotencyKey: "planning-task-foreign-task-0001",
      }),
    ];
    for (const callback of opaqueCallbacks) {
      expectHiddenDomainError(captureDomainError(callback), 404, "NOT_FOUND", fixture.hidden);
    }

    const scopeCallbacks = [
      () => application.enterprise.listPlanningSessions(fixture.scopeDeniedAgent.actorId, PRIVATE_PATH),
      () => application.enterprise.createPlanningSession(fixture.scopeDeniedAgent.actorId, {
        designId: PRIVATE_PATH,
        idempotencyKey: PRIVATE_MARKER,
      }),
      () => application.enterprise.listAgentTasks(fixture.scopeDeniedAgent.actorId, { designId: PRIVATE_PATH }),
      () => application.enterprise.createAgentTask(fixture.scopeDeniedAgent.actorId, {
        designId: PRIVATE_PATH,
        brief: PRIVATE_MARKER,
        baseVersion: -1,
        expectedOutput: "design_preview",
        idempotencyKey: PRIVATE_MARKER,
      }),
    ];
    for (const callback of scopeCallbacks) {
      expectHiddenDomainError(captureDomainError(callback), 403, "FORBIDDEN", fixture.hidden);
    }
    expect(workflowState(application)).toEqual(afterAllowed);
  });

  it("preserves trusted role behavior, idempotent creation, filters, and secret-free task launch links", async () => {
    const fixture = await createFixture("trusted-roles");
    const { application } = fixture;

    const initialPlanning = await application.app.inject({
      method: "GET",
      url: `/api/designs/${fixture.allowed.id}/planning-sessions?limit=100`,
      remoteAddress: "127.0.0.1",
      headers: serverHeaders(VIEWER_IDENTITY),
    });
    expect(initialPlanning.statusCode, initialPlanning.body).toBe(200);
    expect(initialPlanning.json<{ sessions: PlanningSessionResult[] }>().sessions
      .map((result) => result.session.id)).toContain(fixture.allowedSession.session.id);

    const planningPayload = { idempotencyKey: "planning-task-http-session-create-0001" };
    const createdPlanning = await application.app.inject({
      method: "POST",
      url: `/api/designs/${fixture.allowed.id}/planning-sessions`,
      remoteAddress: "127.0.0.1",
      headers: serverHeaders(),
      payload: planningPayload,
    });
    expect(createdPlanning.statusCode, createdPlanning.body).toBe(201);
    const planning = createdPlanning.json<PlanningSessionResult>();
    expect(planning).toMatchObject({
      session: { project_id: fixture.allowed.id, version: 1, status: "draft" },
      answeredSections: [],
      sectionCount: 22,
    });
    const planningRetry = await application.app.inject({
      method: "POST",
      url: `/api/designs/${fixture.allowed.id}/planning-sessions`,
      remoteAddress: "127.0.0.1",
      headers: serverHeaders(),
      payload: planningPayload,
    });
    expect(planningRetry.statusCode, planningRetry.body).toBe(201);
    expect(planningRetry.json<PlanningSessionResult>().session.id).toBe(planning.session.id);

    application.enterprise.transitionAgentTask("local", fixture.allowedTask.id, {
      expectedStatus: "queued",
      toStatus: "cancelled",
    });

    const taskPayload = {
      brief: "Create a professional review-ready design proposal",
      selection: [],
      baseVersion: fixture.allowed.version,
      expectedOutput: "design_preview",
      idempotencyKey: "planning-task-http-task-create-0001",
      expiresInSeconds: 3_600,
    } as const;
    const createdTaskResponse = await application.app.inject({
      method: "POST",
      url: `/api/designs/${fixture.allowed.id}/agent-tasks`,
      remoteAddress: "127.0.0.1",
      headers: serverHeaders(),
      payload: taskPayload,
    });
    expect(createdTaskResponse.statusCode, createdTaskResponse.body).toBe(201);
    const createdTask = createdTaskResponse.json<{
      task: AgentTaskResult;
      launchUrl: string;
      websiteTaskLink: string;
    }>();
    expect(createdTask.task).toMatchObject({
      designId: fixture.allowed.id,
      status: "queued",
      selection: [],
      baseVersion: fixture.allowed.version,
      expectedOutput: "design_preview",
    });
    const taskLaunch = new URL(createdTask.launchUrl);
    expect(taskLaunch.protocol).toBe("codex:");
    expect(taskLaunch.hostname).toBe("new");
    expect([...taskLaunch.searchParams.keys()]).toEqual(["prompt"]);
    expect(taskLaunch.searchParams.get("prompt")).toContain(`Claim task ${createdTask.task.id} with task_claim`);
    expect(taskLaunch.searchParams.get("prompt")).toContain("design_preview_changes");
    expect(taskLaunch.searchParams.get("prompt")).toContain("returned PNG in Codex");
    expect(taskLaunch.searchParams.get("prompt")).toContain("immutable Product");
    expect(taskLaunch.searchParams.get("prompt")).toContain('task_transition to awaiting_approval with data {"previewId":"<preview id>","readiness":');
    expect(taskLaunch.searchParams.get("prompt")).toContain("DesignReadinessReport");
    expect(taskLaunch.searchParams.get("prompt")).toContain("Do not commit it");
    const websiteTaskLink = new URL(createdTask.websiteTaskLink);
    expect(websiteTaskLink.origin).toBe(PUBLIC_ORIGIN);
    expect(websiteTaskLink.pathname).toBe(`/design/${fixture.allowed.id}`);
    expect(websiteTaskLink.searchParams.get("task")).toBe(createdTask.task.id);
    expect(websiteTaskLink.searchParams.get("store")).toBe(fixture.application.database.dataStoreId());
    expect([...websiteTaskLink.searchParams.keys()]).toEqual(["task", "store"]);
    for (const marker of fixture.hidden) expect(createdTaskResponse.body).not.toContain(marker);
    const taskRetry = await application.app.inject({
      method: "POST",
      url: `/api/designs/${fixture.allowed.id}/agent-tasks`,
      remoteAddress: "127.0.0.1",
      headers: serverHeaders(),
      payload: taskPayload,
    });
    expect(taskRetry.statusCode, taskRetry.body).toBe(201);
    expect(taskRetry.json<{ task: AgentTaskResult }>().task.id).toBe(createdTask.task.id);

    const queuedTasks = await application.app.inject({
      method: "GET",
      url: `/api/designs/${fixture.allowed.id}/agent-tasks?status=queued&limit=100`,
      remoteAddress: "127.0.0.1",
      headers: serverHeaders(VIEWER_IDENTITY),
    });
    expect(queuedTasks.statusCode, queuedTasks.body).toBe(200);
    const queuedIds = queuedTasks.json<{ tasks: AgentTaskResult[] }>().tasks.map((task) => task.id);
    expect(queuedIds).toContain(createdTask.task.id);
    expect(queuedIds).not.toContain(fixture.allowedTask.id);
    for (const marker of fixture.hidden) expect(queuedTasks.body).not.toContain(marker);

    const beforeViewerWrites = workflowState(application);
    const viewerWrites = await Promise.all([
      application.app.inject({
        method: "POST",
        url: `/api/designs/${fixture.allowed.id}/planning-sessions`,
        remoteAddress: "127.0.0.1",
        headers: serverHeaders(VIEWER_IDENTITY),
        payload: { idempotencyKey: "planning-task-viewer-session-denied-0001" },
      }),
      application.app.inject({
        method: "POST",
        url: `/api/designs/${fixture.allowed.id}/agent-tasks`,
        remoteAddress: "127.0.0.1",
        headers: serverHeaders(VIEWER_IDENTITY),
        payload: { ...taskPayload, idempotencyKey: "planning-task-viewer-task-denied-0001" },
      }),
      application.app.inject({
        method: "POST",
        url: `/api/designs/${fixture.allowed.id}/planning-sessions`,
        remoteAddress: "127.0.0.1",
        headers: serverHeaders(DESIGN_EDITOR_IDENTITY),
        payload: { idempotencyKey: "planning-task-editor-session-denied-0001" },
      }),
    ]);
    for (const response of viewerWrites) expectHiddenError(response, 403, "FORBIDDEN", fixture.hidden);
    expect(workflowState(application)).toEqual(beforeViewerWrites);

    const editorTask = await application.app.inject({
      method: "POST",
      url: `/api/designs/${fixture.allowed.id}/agent-tasks`,
      remoteAddress: "127.0.0.1",
      headers: serverHeaders(DESIGN_EDITOR_IDENTITY),
      payload: { ...taskPayload, idempotencyKey: "planning-task-editor-task-create-0001" },
    });
    expect(editorTask.statusCode, editorTask.body).toBe(409);
    expect(editorTask.json<{ error: { code: string; details: Record<string, unknown> } }>().error).toMatchObject({
      code: "TASK_STATE_CONFLICT",
      details: {
        designId: fixture.allowed.id,
        expectedOutput: "design_preview",
        activeTaskId: createdTask.task.id,
        activeStatus: "queued",
      },
    });
    for (const marker of fixture.hidden) expect(editorTask.body).not.toContain(marker);
  });
});
