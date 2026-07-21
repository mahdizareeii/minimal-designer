import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { loadConfig } from "./config.js";
import type { DomainError } from "./errors.js";
import type { AgentTaskResult, PlanningSessionResult } from "./enterprise-service.js";

const PROXY_SECRET = "opaque-route-proxy-secret-0123456789abcdef";
const ADMIN_IDENTITY = "opaque-route-admin@example.test";
const VIEWER_IDENTITY = "opaque-route-viewer@example.test";

const applications: DesignerApplication[] = [];
const temporaryDirectories: string[] = [];

interface OpaqueRouteFixture {
  application: DesignerApplication;
  allowedDesignId: string;
  deniedDesignId: string;
  allowedSession: PlanningSessionResult;
  deniedSession: PlanningSessionResult;
  allowedTask: AgentTaskResult;
  deniedTask: AgentTaskResult;
  foreignSession: PlanningSessionResult;
  foreignTask: AgentTaskResult;
  foreignGrantToken: string;
  markers: string[];
}

interface WorkflowState {
  sessions: unknown[];
  sessionVersions: unknown[];
  answers: unknown[];
  taskTransitions: unknown[];
}

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.promises.rm(directory, { recursive: true, force: true })));
});

async function temporaryRoot(label: string): Promise<string> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `formaspec-opaque-http-${label}-`));
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
    DESIGNER_TOKEN: "opaque-route-bootstrap-token-0001",
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

function scopedGrantHeaders(token: string): Record<string, string> {
  return {
    host: "design.example.test",
    authorization: `Bearer ${token}`,
    "x-formaspec-proxy-secret": PROXY_SECRET,
  };
}

function installForeignGrant(application: DesignerApplication, input: {
  id: string;
  organizationId: string;
  scopes: string[];
}): { actorId: string; token: string } {
  const principalId = `principal_${input.id}`;
  const connectionId = `connection_${input.id}`;
  const token = `fsg_${input.id}_opaque_route_token_0001`;
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 3_600_000).toISOString();
  const scopesJson = JSON.stringify(input.scopes);

  application.database.sqlite.prepare(
    `INSERT INTO organizations (id, name, config_json, created_at, updated_at)
     VALUES (?, ?, '{}', ?, ?)`,
  ).run(input.organizationId, "Foreign opaque-route organization", createdAt, createdAt);
  application.database.sqlite.prepare(
    `INSERT INTO principals (id, organization_id, kind, display_name, external_id, created_at)
     VALUES (?, ?, 'agent', ?, ?, ?)`,
  ).run(principalId, input.organizationId, input.id, `opaque:${input.id}`, createdAt);
  application.database.sqlite.prepare(
    `INSERT INTO memberships (organization_id, principal_id, role, created_at)
     VALUES (?, ?, 'agent', ?)`,
  ).run(input.organizationId, principalId, createdAt);
  application.database.sqlite.prepare(
    `INSERT INTO agent_connections
     (id, organization_id, principal_id, adapter, display_name, status, scopes_json, project_ids_json,
      expires_at, created_at, updated_at)
     VALUES (?, ?, ?, 'generic_mcp', ?, 'active', ?, '[]', ?, ?, ?)`,
  ).run(connectionId, input.organizationId, principalId, input.id, scopesJson, expiresAt, createdAt, createdAt);
  application.database.sqlite.prepare(
    `INSERT INTO agent_grants
     (id, organization_id, principal_id, token_hash, scopes_json, project_ids_json, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, '[]', ?, ?)`,
  ).run(
    input.id,
    input.organizationId,
    principalId,
    createHash("sha256").update(token).digest("hex"),
    scopesJson,
    createdAt,
    expiresAt,
  );
  return { actorId: `grant_${input.id}`, token };
}

async function createFixture(label: string): Promise<OpaqueRouteFixture> {
  const application = await serverApplication(label);
  const allowedSessionMarker = "ALLOWED_SESSION_SECRET_1a9f4b";
  const deniedSessionMarker = "DENIED_SESSION_SECRET_8d2c71";
  const allowedTaskMarker = "ALLOWED_TASK_SECRET_2c0f95";
  const deniedTaskMarker = "DENIED_TASK_SECRET_b7e431";
  const foreignSessionMarker = "FOREIGN_SESSION_SECRET_57ca80";
  const foreignTaskMarker = "FOREIGN_TASK_SECRET_e3b621";

  const allowedDesign = application.service.createDesign("local", {
    name: "Allowed opaque-route project",
    preset: "phone",
    idempotencyKey: `opaque-allowed-design-${label}-0001`,
  });
  const deniedDesign = application.service.createDesign("local", {
    name: "Restricted opaque-route project",
    preset: "web",
    idempotencyKey: `opaque-denied-design-${label}-0001`,
  });
  let allowedSession = application.enterprise.createPlanningSession("local", {
    designId: allowedDesign.document.id,
    idempotencyKey: `opaque-allowed-session-${label}-0001`,
  });
  allowedSession = application.enterprise.savePlanningAnswer("local", allowedSession.session.id, {
    expectedVersion: allowedSession.session.version,
    section: "product_purpose",
    answer: allowedSessionMarker,
  });
  let deniedSession = application.enterprise.createPlanningSession("local", {
    designId: deniedDesign.document.id,
    idempotencyKey: `opaque-denied-session-${label}-0001`,
  });
  deniedSession = application.enterprise.savePlanningAnswer("local", deniedSession.session.id, {
    expectedVersion: deniedSession.session.version,
    section: "product_purpose",
    answer: deniedSessionMarker,
  });
  const allowedTask = application.enterprise.createAgentTask("local", {
    designId: allowedDesign.document.id,
    brief: allowedTaskMarker,
    baseVersion: allowedDesign.design.version,
    expectedOutput: "design_preview",
    idempotencyKey: `opaque-allowed-task-${label}-0001`,
  });
  const deniedTask = application.enterprise.createAgentTask("local", {
    designId: deniedDesign.document.id,
    brief: deniedTaskMarker,
    baseVersion: deniedDesign.design.version,
    expectedOutput: "design_preview",
    idempotencyKey: `opaque-denied-task-${label}-0001`,
  });

  // Bootstrap and then pin the two trusted identities before adding a foreign
  // organization's non-local principal. Subsequent requests use the production
  // trusted-header authentication and role-mapping path.
  const bootstrap = await application.app.inject({
    method: "GET",
    url: `/api/planning-sessions/${allowedSession.session.id}`,
    headers: serverHeaders(),
  });
  expect(bootstrap.statusCode, bootstrap.body).toBe(200);
  const currentPolicy = application.policies.read(`trusted:${ADMIN_IDENTITY}`);
  const mappedPolicy = structuredClone(currentPolicy.policy);
  mappedPolicy.identity.roleMappings = [
    { claim: "identity", value: ADMIN_IDENTITY, role: "organization_admin" },
    { claim: "identity", value: VIEWER_IDENTITY, role: "viewer" },
  ];
  application.policies.update(`trusted:${ADMIN_IDENTITY}`, {
    expectedConfigurationHash: currentPolicy.configurationHash,
    policy: mappedPolicy,
  });

  const foreignGrant = installForeignGrant(application, {
    id: `foreign_opaque_${label}`,
    organizationId: `organization_foreign_opaque_${label}`,
    scopes: ["design:write", "planning:read", "planning:write", "task:create", "task:read", "task:claim", "task:update"],
  });
  const foreignDesign = application.service.createDesign(foreignGrant.actorId, {
    name: "Foreign opaque-route project",
    preset: "tablet",
    idempotencyKey: `opaque-foreign-design-${label}-0001`,
  });
  let foreignSession = application.enterprise.createPlanningSession(foreignGrant.actorId, {
    designId: foreignDesign.document.id,
    idempotencyKey: `opaque-foreign-session-${label}-0001`,
  });
  foreignSession = application.enterprise.savePlanningAnswer(foreignGrant.actorId, foreignSession.session.id, {
    expectedVersion: foreignSession.session.version,
    section: "product_purpose",
    answer: foreignSessionMarker,
  });
  const foreignTask = application.enterprise.createAgentTask(foreignGrant.actorId, {
    designId: foreignDesign.document.id,
    brief: foreignTaskMarker,
    baseVersion: foreignDesign.design.version,
    expectedOutput: "design_preview",
    idempotencyKey: `opaque-foreign-task-${label}-0001`,
  });

  return {
    application,
    allowedDesignId: allowedDesign.document.id,
    deniedDesignId: deniedDesign.document.id,
    allowedSession,
    deniedSession,
    allowedTask,
    deniedTask,
    foreignSession,
    foreignTask,
    foreignGrantToken: foreignGrant.token,
    markers: [
      allowedSessionMarker,
      deniedSessionMarker,
      allowedTaskMarker,
      deniedTaskMarker,
      foreignSessionMarker,
      foreignTaskMarker,
      foreignGrant.token,
    ],
  };
}

function workflowState(application: DesignerApplication): WorkflowState {
  return {
    sessions: application.database.sqlite.prepare(
      "SELECT id, version, status, current_section, updated_at FROM planning_sessions ORDER BY id",
    ).all(),
    sessionVersions: application.database.sqlite.prepare(
      "SELECT session_id, version, status, current_section, actor_id, created_at FROM planning_session_versions ORDER BY session_id, version",
    ).all(),
    answers: application.database.sqlite.prepare(
      "SELECT id, session_id, section, version, answer, actor_id, created_at FROM planning_answers ORDER BY session_id, section, version",
    ).all(),
    taskTransitions: application.database.sqlite.prepare(
      "SELECT id, task_id, from_status, to_status, actor_id, message, data_json, created_at FROM agent_task_transitions ORDER BY task_id, rowid",
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

describe("planning-session and agent-task opaque-ID HTTP authorization", () => {
  it("uses production trusted-header authentication for allowed reads/writes and role-denied mutations", async () => {
    const fixture = await createFixture("trusted_roles");
    const { application } = fixture;
    const headers = serverHeaders();

    const planningRead = await application.app.inject({
      method: "GET",
      url: `/api/planning-sessions/${fixture.allowedSession.session.id}`,
      headers,
    });
    expect(planningRead.statusCode, planningRead.body).toBe(200);
    expect(planningRead.json<PlanningSessionResult>().session.answers[0]?.answer).toBe(fixture.markers[0]);

    const answer = await application.app.inject({
      method: "POST",
      url: `/api/planning-sessions/${fixture.allowedSession.session.id}/answers`,
      headers,
      payload: {
        expectedVersion: fixture.allowedSession.session.version,
        section: "business_goals",
        answer: "Trusted product manager answer",
      },
    });
    expect(answer.statusCode, answer.body).toBe(200);
    expect(answer.json<PlanningSessionResult>().session).toMatchObject({ version: 3, status: "in_progress" });

    const planningTransition = await application.app.inject({
      method: "POST",
      url: `/api/planning-sessions/${fixture.allowedSession.session.id}/transition`,
      headers,
      payload: { expectedVersion: 3, status: "cancelled" },
    });
    expect(planningTransition.statusCode, planningTransition.body).toBe(200);
    expect(planningTransition.json<PlanningSessionResult>().session).toMatchObject({ version: 4, status: "cancelled" });

    const taskRead = await application.app.inject({
      method: "GET",
      url: `/api/agent-tasks/${fixture.allowedTask.id}`,
      headers,
    });
    expect(taskRead.statusCode, taskRead.body).toBe(200);
    expect(taskRead.json<{ task: AgentTaskResult }>().task).toMatchObject({
      id: fixture.allowedTask.id,
      brief: fixture.markers[2],
      status: "queued",
    });

    const beforeHumanClaim = workflowState(application);
    const humanClaim = await application.app.inject({
      method: "POST",
      url: `/api/agent-tasks/${fixture.allowedTask.id}/claim`,
      headers,
    });
    expectHiddenError(humanClaim, 403, "FORBIDDEN", fixture.markers);
    expect(workflowState(application)).toEqual(beforeHumanClaim);

    const taskTransition = await application.app.inject({
      method: "POST",
      url: `/api/agent-tasks/${fixture.allowedTask.id}/transition`,
      headers,
      payload: { expectedStatus: "queued", toStatus: "cancelled", message: "Cancelled by the product owner" },
    });
    expect(taskTransition.statusCode, taskTransition.body).toBe(200);
    expect(taskTransition.json<{ task: AgentTaskResult }>().task.status).toBe("cancelled");

    const roleSession = application.enterprise.createPlanningSession("local", {
      designId: fixture.allowedDesignId,
      idempotencyKey: "opaque-role-session-trusted-roles-0001",
    });
    const roleTask = application.enterprise.createAgentTask("local", {
      designId: fixture.allowedDesignId,
      brief: "VIEWER_DENIED_TASK_SECRET_9f8162",
      baseVersion: 1,
      expectedOutput: "design_preview",
      idempotencyKey: "opaque-role-task-trusted-roles-0001",
    });
    const viewerHeaders = serverHeaders(VIEWER_IDENTITY);
    const beforeViewerWrites = workflowState(application);
    const viewerResponses = await Promise.all([
      application.app.inject({
        method: "POST",
        url: `/api/planning-sessions/${roleSession.session.id}/answers`,
        headers: viewerHeaders,
        payload: { expectedVersion: 1, section: "product_purpose", answer: "Must not persist" },
      }),
      application.app.inject({
        method: "POST",
        url: `/api/planning-sessions/${roleSession.session.id}/transition`,
        headers: viewerHeaders,
        payload: { expectedVersion: 1, status: "cancelled" },
      }),
      application.app.inject({
        method: "POST",
        url: `/api/agent-tasks/${roleTask.id}/claim`,
        headers: viewerHeaders,
      }),
      application.app.inject({
        method: "POST",
        url: `/api/agent-tasks/${roleTask.id}/transition`,
        headers: viewerHeaders,
        payload: { expectedStatus: "queued", toStatus: "cancelled" },
      }),
    ]);
    for (const response of viewerResponses) {
      expectHiddenError(response, 403, "FORBIDDEN", [...fixture.markers, roleTask.brief]);
    }
    expect(workflowState(application)).toEqual(beforeViewerWrites);
  });

  it("hides swapped and foreign-organization session/task IDs on all six Fastify routes without rejected-write side effects", async () => {
    const fixture = await createFixture("foreign_and_swapped");
    const { application } = fixture;
    const headers = serverHeaders();
    const hidden = [
      ...fixture.markers,
      fixture.foreignSession.session.id,
      fixture.foreignTask.id,
      fixture.deniedSession.session.id,
      fixture.deniedTask.id,
    ];
    const before = workflowState(application);

    const planningCases = [
      fixture.foreignSession.session.id,
      fixture.allowedTask.id,
    ];
    for (const sessionId of planningCases) {
      const read = await application.app.inject({
        method: "GET",
        url: `/api/planning-sessions/${sessionId}`,
        headers,
      });
      expectHiddenError(read, 404, "NOT_FOUND", hidden);

      const answer = await application.app.inject({
        method: "POST",
        url: `/api/planning-sessions/${sessionId}/answers`,
        headers,
        payload: { expectedVersion: 2, section: "business_goals", answer: "Must not persist" },
      });
      expectHiddenError(answer, 404, "NOT_FOUND", hidden);

      const transition = await application.app.inject({
        method: "POST",
        url: `/api/planning-sessions/${sessionId}/transition`,
        headers,
        payload: { expectedVersion: 2, status: "cancelled" },
      });
      expectHiddenError(transition, 404, "NOT_FOUND", hidden);
    }

    const taskCases = [
      fixture.foreignTask.id,
      fixture.allowedSession.session.id,
    ];
    for (const taskId of taskCases) {
      const read = await application.app.inject({
        method: "GET",
        url: `/api/agent-tasks/${taskId}`,
        headers,
      });
      expectHiddenError(read, 404, "NOT_FOUND", hidden);

      // Ordinary REST identity is human-only. The role gate deliberately runs
      // before opaque task lookup, so claim stays a data-free 403 for every ID.
      const claim = await application.app.inject({
        method: "POST",
        url: `/api/agent-tasks/${taskId}/claim`,
        headers,
      });
      expectHiddenError(claim, 403, "FORBIDDEN", hidden);

      const transition = await application.app.inject({
        method: "POST",
        url: `/api/agent-tasks/${taskId}/transition`,
        headers,
        payload: { expectedStatus: "queued", toStatus: "cancelled" },
      });
      expectHiddenError(transition, 404, "NOT_FOUND", hidden);
    }

    expect(workflowState(application)).toEqual(before);
  });

  it("enforces project restriction and immediate grant revocation across the six backing service operations", async () => {
    const fixture = await createFixture("scoped_agent");
    const { application } = fixture;
    const challenge = application.enterprise.createAgentConnection("local", {
      adapter: "codex",
      displayName: "Opaque route scoped agent",
      scopes: ["planning:read", "planning:write", "task:read", "task:claim", "task:update"],
      projectIds: [fixture.allowedDesignId],
      expiresInSeconds: 3_600,
    });
    const paired = application.enterprise.pairAgentConnection(challenge.nonce);
    const actorId = paired.grant.actorId;

    const activeContext = await application.app.inject({
      method: "GET",
      url: "/api/agent-authorization-context",
      headers: scopedGrantHeaders(paired.grant.token),
    });
    expect(activeContext.statusCode, activeContext.body).toBe(200);
    expect(activeContext.json()).toEqual({
      role: "agent",
      scopes: ["planning:read", "planning:write", "task:read", "task:claim", "task:update"],
      projectIds: [fixture.allowedDesignId],
    });

    expect(application.enterprise.readPlanningSession(actorId, fixture.allowedSession.session.id).session.id)
      .toBe(fixture.allowedSession.session.id);
    const answered = application.enterprise.savePlanningAnswer(actorId, fixture.allowedSession.session.id, {
      expectedVersion: fixture.allowedSession.session.version,
      section: "business_goals",
      answer: "Scoped agent answer",
    });
    const transitionedSession = application.enterprise.transitionPlanningSession(actorId, fixture.allowedSession.session.id, {
      expectedVersion: answered.session.version,
      status: "in_progress",
    });
    expect(transitionedSession.session.version).toBe(4);

    expect(application.enterprise.readAgentTask(actorId, fixture.allowedTask.id).id).toBe(fixture.allowedTask.id);
    expect(application.enterprise.claimAgentTask(actorId, fixture.allowedTask.id).status).toBe("claimed");
    expect(application.enterprise.transitionAgentTask(actorId, fixture.allowedTask.id, {
      expectedStatus: "claimed",
      toStatus: "in_progress",
      message: "Scoped agent started work",
    }).status).toBe("in_progress");

    const deniedCallbacks = [
      () => application.enterprise.readPlanningSession(actorId, fixture.deniedSession.session.id),
      () => application.enterprise.savePlanningAnswer(actorId, fixture.deniedSession.session.id, {
        expectedVersion: fixture.deniedSession.session.version,
        section: "business_goals",
        answer: "Must not persist",
      }),
      () => application.enterprise.transitionPlanningSession(actorId, fixture.deniedSession.session.id, {
        expectedVersion: fixture.deniedSession.session.version,
        status: "cancelled",
      }),
      () => application.enterprise.readAgentTask(actorId, fixture.deniedTask.id),
      () => application.enterprise.claimAgentTask(actorId, fixture.deniedTask.id),
      () => application.enterprise.transitionAgentTask(actorId, fixture.deniedTask.id, {
        expectedStatus: "queued",
        toStatus: "cancelled",
      }),
      () => application.enterprise.readPlanningSession(actorId, fixture.foreignSession.session.id),
      () => application.enterprise.savePlanningAnswer(actorId, fixture.foreignSession.session.id, {
        expectedVersion: fixture.foreignSession.session.version,
        section: "business_goals",
        answer: "Must not persist",
      }),
      () => application.enterprise.transitionPlanningSession(actorId, fixture.foreignSession.session.id, {
        expectedVersion: fixture.foreignSession.session.version,
        status: "cancelled",
      }),
      () => application.enterprise.readAgentTask(actorId, fixture.foreignTask.id),
      () => application.enterprise.claimAgentTask(actorId, fixture.foreignTask.id),
      () => application.enterprise.transitionAgentTask(actorId, fixture.foreignTask.id, {
        expectedStatus: "queued",
        toStatus: "cancelled",
      }),
      () => application.enterprise.readPlanningSession(actorId, fixture.allowedTask.id),
      () => application.enterprise.savePlanningAnswer(actorId, fixture.allowedTask.id, {
        expectedVersion: 1,
        section: "business_goals",
        answer: "Must not persist",
      }),
      () => application.enterprise.transitionPlanningSession(actorId, fixture.allowedTask.id, {
        expectedVersion: 1,
        status: "cancelled",
      }),
      () => application.enterprise.readAgentTask(actorId, fixture.allowedSession.session.id),
      () => application.enterprise.claimAgentTask(actorId, fixture.allowedSession.session.id),
      () => application.enterprise.transitionAgentTask(actorId, fixture.allowedSession.session.id, {
        expectedStatus: "queued",
        toStatus: "cancelled",
      }),
    ];
    const beforeDenied = workflowState(application);
    for (const callback of deniedCallbacks) {
      expectHiddenDomainError(captureDomainError(callback), 404, "NOT_FOUND", [
        ...fixture.markers,
        fixture.deniedSession.session.id,
        fixture.deniedTask.id,
        fixture.foreignSession.session.id,
        fixture.foreignTask.id,
      ]);
    }
    expect(workflowState(application)).toEqual(beforeDenied);

    application.enterprise.revokeAgentConnection("local", challenge.connection.id);
    const revokedContext = await application.app.inject({
      method: "GET",
      url: "/api/agent-authorization-context",
      headers: scopedGrantHeaders(paired.grant.token),
    });
    expectHiddenError(revokedContext, 401, "AUTH_REQUIRED", [...fixture.markers, paired.grant.token]);

    const revokedCallbacks = [
      () => application.enterprise.readPlanningSession(actorId, fixture.allowedSession.session.id),
      () => application.enterprise.savePlanningAnswer(actorId, fixture.allowedSession.session.id, {
        expectedVersion: transitionedSession.session.version,
        section: "user_groups_and_roles",
        answer: "Must not persist after revocation",
      }),
      () => application.enterprise.transitionPlanningSession(actorId, fixture.allowedSession.session.id, {
        expectedVersion: transitionedSession.session.version,
        status: "cancelled",
      }),
      () => application.enterprise.readAgentTask(actorId, fixture.allowedTask.id),
      () => application.enterprise.claimAgentTask(actorId, fixture.allowedTask.id),
      () => application.enterprise.transitionAgentTask(actorId, fixture.allowedTask.id, {
        expectedStatus: "in_progress",
        toStatus: "failed",
      }),
    ];
    const beforeRevoked = workflowState(application);
    for (const callback of revokedCallbacks) {
      expectHiddenDomainError(captureDomainError(callback), 401, "AUTH_REQUIRED", [
        ...fixture.markers,
        paired.grant.token,
      ]);
    }
    expect(workflowState(application)).toEqual(beforeRevoked);
  });
});
