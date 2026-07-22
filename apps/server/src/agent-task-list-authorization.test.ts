import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { buildApplication } from "./app.js";
import { loadConfig } from "./config.js";
import { DesignerDatabase } from "./db/database.js";
import { DomainError } from "./errors.js";
import { EventHub } from "./events.js";
import { registerEnterpriseHttpRoutes } from "./enterprise-http-routes.js";
import { EnterpriseService, type AgentTaskResult } from "./enterprise-service.js";
import { DesignerService } from "./service.js";

interface TaskListFixture {
  database: DesignerDatabase;
  enterprise: EnterpriseService;
  actorId: string;
  allowedDesignId: string;
  deniedDesignId: string;
  allowedTask: AgentTaskResult;
  deniedTask: AgentTaskResult;
  deniedMarker: string;
  setNow(value: string): void;
}

const openDatabases: DesignerDatabase[] = [];
const openApps: FastifyInstance[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  for (const database of openDatabases.splice(0)) database.close();
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.promises.rm(directory, { recursive: true, force: true })));
});

function totalChanges(database: DesignerDatabase): number {
  return (database.sqlite.prepare("SELECT total_changes() AS count").get() as { count: number }).count;
}

function captureThrown(callback: () => unknown): unknown {
  try {
    callback();
  } catch (error) {
    return error;
  }
  throw new Error("Expected callback to throw.");
}

function taskListFixture(): TaskListFixture {
  const database = new DesignerDatabase(":memory:");
  openDatabases.push(database);
  const events = new EventHub();
  const designer = new DesignerService(database, events, 900);
  // Keep the scoped grant valid regardless of the wall clock on the machine
  // running this deterministic service-clock fixture.
  let now = "2099-07-21T00:00:01.000Z";
  const enterprise = new EnterpriseService(database, events, {
    now: () => new Date(now),
  });
  const allowed = designer.createDesign("local", {
    name: "Allowed task-list project",
    preset: "phone",
    idempotencyKey: "task-list-allowed-design-0001",
  });
  const denied = designer.createDesign("local", {
    name: "Denied task-list project",
    preset: "web",
    idempotencyKey: "task-list-denied-design-0001",
  });
  const allowedTask = enterprise.createAgentTask("local", {
    designId: allowed.document.id,
    brief: "Allowed project task",
    baseVersion: 1,
    expectedOutput: "design_preview",
    idempotencyKey: "task-list-allowed-task-0001",
  });
  const deniedMarker = "FOREIGN_TASK_MARKER_7b01d4e2";
  now = "2099-07-21T00:00:02.000Z";
  const deniedTask = enterprise.createAgentTask("local", {
    designId: denied.document.id,
    brief: deniedMarker,
    baseVersion: 1,
    expectedOutput: "design_preview",
    idempotencyKey: "task-list-denied-task-0001",
  });
  const challenge = enterprise.createAgentConnection("local", {
    adapter: "codex",
    displayName: "Task-list authorization fixture",
    scopes: ["task:read"],
    projectIds: [allowed.document.id],
  });
  const paired = enterprise.pairAgentConnection(challenge.nonce);
  return {
    database,
    enterprise,
    actorId: paired.grant.actorId,
    allowedDesignId: allowed.document.id,
    deniedDesignId: denied.document.id,
    allowedTask,
    deniedTask,
    deniedMarker,
    setNow(value: string) {
      now = value;
    },
  };
}

async function waitForClockAdvance(): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() === startedAt) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

async function taskListHttpApp(fixture: TaskListFixture): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  openApps.push(app);
  app.decorateRequest("actorId", "local");
  app.addHook("onRequest", async (request) => {
    const actorId = request.headers["x-test-actor-id"];
    if (typeof actorId === "string") request.actorId = actorId;
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError) {
      return reply.code(error.statusCode).send({ error: error.toJSON() });
    }
    if (error instanceof ZodError) {
      return reply.code(422).send({
        error: {
          code: "VALIDATION_FAILED",
          message: "The request did not match the expected schema.",
          retryable: false,
          details: { issues: error.issues },
        },
      });
    }
    throw error;
  });
  registerEnterpriseHttpRoutes(app, fixture.enterprise);
  await app.ready();
  return app;
}

describe("EnterpriseService.listAgentTasks project authorization", () => {
  it("lists an allowed project and rejects missing or restricted projects without leaking task markers or mutating state", () => {
    const fixture = taskListFixture();
    const before = totalChanges(fixture.database);

    expect(fixture.enterprise.listAgentTasks(fixture.actorId, {
      designId: fixture.allowedDesignId,
    }).map((task) => task.id)).toEqual([fixture.allowedTask.id]);

    const missing = captureThrown(() => fixture.enterprise.listAgentTasks(fixture.actorId, {
      designId: "document_missing_task_list_project",
    }));
    expect(missing).toMatchObject({ code: "NOT_FOUND", statusCode: 404, message: "Design not found." });

    const restricted = captureThrown(() => fixture.enterprise.listAgentTasks(fixture.actorId, {
      designId: fixture.deniedDesignId,
    }));
    expect(restricted).toMatchObject({ code: "NOT_FOUND", statusCode: 404, message: "Design not found." });
    expect(JSON.stringify({ missing, restricted })).not.toContain(fixture.deniedMarker);
    expect(JSON.stringify({ missing, restricted })).not.toContain(fixture.deniedTask.id);
    expect(totalChanges(fixture.database)).toBe(before);
  });

  it("applies project and status predicates before the bounded task-list limit", () => {
    const fixture = taskListFixture();
    fixture.setNow("2099-07-21T00:00:03.000Z");
    const cancelled = fixture.enterprise.createAgentTask("local", {
      designId: fixture.allowedDesignId,
      brief: "Newer cancelled allowed task",
      baseVersion: 1,
      expectedOutput: "design_preview",
      idempotencyKey: "task-list-cancelled-task-0001",
    });
    fixture.enterprise.transitionAgentTask("local", cancelled.id, {
      expectedStatus: "queued",
      toStatus: "cancelled",
    });

    expect(fixture.enterprise.listAgentTasks(fixture.actorId, {
      status: "queued",
      limit: 1,
    }).map((task) => task.id)).toEqual([fixture.allowedTask.id]);
  });
});

describe("agent-task list HTTP project authorization", () => {
  it("returns the allowed list and the normal hidden-project 404 for missing and restricted project IDs", async () => {
    const fixture = taskListFixture();
    const app = await taskListHttpApp(fixture);
    const headers = { "x-test-actor-id": fixture.actorId };
    const before = totalChanges(fixture.database);

    const allowed = await app.inject({
      method: "GET",
      url: `/api/designs/${fixture.allowedDesignId}/agent-tasks`,
      headers,
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json<{ tasks: AgentTaskResult[] }>().tasks.map((task) => task.id)).toEqual([
      fixture.allowedTask.id,
    ]);

    const missing = await app.inject({
      method: "GET",
      url: "/api/designs/document_missing_task_list_project/agent-tasks",
      headers,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json<{ error: { code: string; message: string } }>().error).toMatchObject({
      code: "NOT_FOUND",
      message: "Design not found.",
    });

    const restricted = await app.inject({
      method: "GET",
      url: `/api/designs/${fixture.deniedDesignId}/agent-tasks`,
      headers,
    });
    expect(restricted.statusCode).toBe(404);
    expect(restricted.json<{ error: { code: string; message: string } }>().error).toMatchObject({
      code: "NOT_FOUND",
      message: "Design not found.",
    });
    expect(`${missing.body}\n${restricted.body}`).not.toContain(fixture.deniedMarker);
    expect(`${missing.body}\n${restricted.body}`).not.toContain(fixture.deniedTask.id);
    expect(totalChanges(fixture.database)).toBe(before);
  });
});

describe("agent-task list MCP project authorization", () => {
  it("does not let newer hidden or wrong-status tasks displace the allowed queued task", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "formaspec-task-list-mcp-"));
    temporaryDirectories.push(root);
    const application = await buildApplication(loadConfig({
      APP_MODE: "local",
      HOST: "127.0.0.1",
      PORT: "4310",
      DATA_DIR: path.join(root, "data"),
      BACKUP_DIR: path.join(root, "backups"),
      DESIGNER_DATABASE_PATH: ":memory:",
      PUBLIC_BASE_URL: "http://127.0.0.1:4310",
      AUTH_MODE: "none",
      FORMASPEC_ALLOW_SOFTWARE_RENDERER: "true",
      DESIGNER_LOG_LEVEL: "silent",
    }));
    openApps.push(application.app);
    await application.app.ready();

    const allowed = application.service.createDesign("local", {
      name: "MCP allowed task-list project",
      preset: "phone",
      idempotencyKey: "task-list-mcp-allowed-design-0001",
    });
    const denied = application.service.createDesign("local", {
      name: "MCP denied task-list project",
      preset: "web",
      idempotencyKey: "task-list-mcp-denied-design-0001",
    });
    const queued = application.enterprise.createAgentTask("local", {
      designId: allowed.document.id,
      brief: "Allowed queued MCP task",
      baseVersion: 1,
      expectedOutput: "design_preview",
      idempotencyKey: "task-list-mcp-queued-task-0001",
    });
    await waitForClockAdvance();
    const cancelled = application.enterprise.createAgentTask("local", {
      designId: allowed.document.id,
      brief: "Newer cancelled MCP task",
      baseVersion: 1,
      expectedOutput: "design_preview",
      idempotencyKey: "task-list-mcp-cancelled-task-0001",
    });
    application.enterprise.transitionAgentTask("local", cancelled.id, {
      expectedStatus: "queued",
      toStatus: "cancelled",
    });
    await waitForClockAdvance();
    const hidden = application.enterprise.createAgentTask("local", {
      designId: denied.document.id,
      brief: "HIDDEN_MCP_TASK_MARKER_4dd49a",
      baseVersion: 1,
      expectedOutput: "design_preview",
      idempotencyKey: "task-list-mcp-hidden-task-0001",
    });
    const challenge = application.enterprise.createAgentConnection("local", {
      adapter: "codex",
      displayName: "Scoped task-list MCP",
      scopes: ["task:read"],
      projectIds: [allowed.document.id],
    });
    const paired = application.enterprise.pairAgentConnection(challenge.nonce);
    const response = await application.app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        host: "127.0.0.1:4310",
        authorization: `Bearer ${paired.grant.token}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "task_list",
          arguments: { status: "queued", limit: 1 },
        },
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<{
      result: { structuredContent: { ok: boolean; tasks: AgentTaskResult[] } };
    }>().result.structuredContent).toMatchObject({
      ok: true,
      tasks: [{ id: queued.id, status: "queued" }],
    });
    expect(response.body).not.toContain(hidden.id);
    expect(response.body).not.toContain("HIDDEN_MCP_TASK_MARKER_4dd49a");
  });
});
