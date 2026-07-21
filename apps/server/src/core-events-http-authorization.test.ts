import { createHash } from "node:crypto";
import fs from "node:fs";
import http, { type ClientRequest, type IncomingMessage, type OutgoingHttpHeaders } from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { loadConfig } from "./config.js";
import { DomainError } from "./errors.js";
import type { DesignerEventType } from "./events.js";

const PROXY_SECRET = "core-events-proxy-secret-0123456789abcdef";
const PUBLIC_ORIGIN = "https://design.example.test";
const ADMIN_IDENTITY = "core-events-admin@example.test";
const VIEWER_IDENTITY = "core-events-viewer@example.test";
const ADMIN_ACTOR = `trusted:${ADMIN_IDENTITY}`;
const PRIVATE_MARKER = "CORE_EVENTS_PRIVATE_MARKER_39ad71";
const PRIVATE_TOKEN = "fsg_core_events_private_token_4e812b";
const FOREIGN_MARKER = "CORE_EVENTS_FOREIGN_MARKER_f70c2d";

const applications: DesignerApplication[] = [];
const captures: SseCapture[] = [];
const temporaryDirectories: string[] = [];

interface ParsedSseEvent {
  id: number;
  event: string;
  data: Record<string, unknown>;
}

interface GrantFixture {
  actorId: string;
  connectionId: string;
  token: string;
}

interface Fixture {
  application: DesignerApplication;
  root: string;
  port: number;
  allowedDesignId: string;
  allowedFrameId: string;
  deniedDesignId: string;
  deniedFrameId: string;
  foreignDesignId: string;
  restrictedGrant: GrantFixture;
  taskGrant: GrantFixture;
  scopeDeniedGrant: GrantFixture;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const capture of captures.splice(0)) capture.destroy();
  await Promise.all(applications.splice(0).map((application) => application.app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.promises.rm(directory, { recursive: true, force: true })
  )));
});

function parseEvents(raw: string): ParsedSseEvent[] {
  const parsed: ParsedSseEvent[] = [];
  for (const frame of raw.split("\n\n")) {
    let id: number | undefined;
    let event: string | undefined;
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("id: ")) id = Number(line.slice(4));
      else if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
    }
    if (id === undefined || !Number.isSafeInteger(id) || !event || dataLines.length === 0) continue;
    const data = JSON.parse(dataLines.join("\n")) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) continue;
    parsed.push({ id, event, data: data as Record<string, unknown> });
  }
  return parsed;
}

class SseCapture {
  #raw = "";
  #closed = false;
  readonly #listeners = new Set<() => void>();

  constructor(
    readonly statusCode: number,
    readonly headers: IncomingMessage["headers"],
    readonly request: ClientRequest,
    readonly response: IncomingMessage,
  ) {
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => {
      this.#raw += chunk;
      this.#notify();
    });
    response.once("end", () => this.#markClosed());
    response.once("close", () => this.#markClosed());
    response.once("error", () => this.#markClosed());
  }

  get raw(): string {
    return this.#raw;
  }

  get events(): ParsedSseEvent[] {
    return parseEvents(this.#raw);
  }

  waitFor(predicate: (capture: SseCapture) => boolean, timeoutMs = 2_000): Promise<void> {
    if (predicate(this)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#listeners.delete(onUpdate);
        reject(new Error(`Timed out waiting for SSE data. Received: ${this.#raw}`));
      }, timeoutMs);
      const onUpdate = () => {
        if (!predicate(this)) return;
        clearTimeout(timeout);
        this.#listeners.delete(onUpdate);
        resolve();
      };
      this.#listeners.add(onUpdate);
    });
  }

  waitForClose(timeoutMs = 2_000): Promise<void> {
    return this.waitFor((capture) => capture.#closed, timeoutMs);
  }

  destroy(): void {
    this.response.destroy();
    this.request.destroy();
    this.#markClosed();
  }

  #markClosed(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#notify();
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}

async function openSse(
  port: number,
  route: string,
  headers: OutgoingHttpHeaders,
): Promise<SseCapture> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      method: "GET",
      path: route,
      headers,
      agent: false,
    }, (response) => {
      const capture = new SseCapture(response.statusCode ?? 0, response.headers, request, response);
      captures.push(capture);
      resolve(capture);
    });
    request.once("error", reject);
    request.end();
  });
}

function request(
  port: number,
  route: string,
  headers: OutgoingHttpHeaders,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const client = http.request({
      host: "127.0.0.1",
      port,
      method: "GET",
      path: route,
      headers,
      agent: false,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => resolve({
        statusCode: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    client.once("error", reject);
    client.end();
  });
}

function serverHeaders(identity = ADMIN_IDENTITY): Record<string, string> {
  return {
    host: "design.example.test",
    accept: "text/event-stream",
    "x-designer-user": identity,
    "x-formaspec-proxy-secret": PROXY_SECRET,
  };
}

function grantHeaders(token: string): Record<string, string> {
  return {
    host: "design.example.test",
    accept: "text/event-stream",
    authorization: `Bearer ${token}`,
    "x-formaspec-proxy-secret": PROXY_SECRET,
  };
}

async function warmIdentity(application: DesignerApplication, identity: string): Promise<void> {
  const response = await application.app.inject({
    method: "GET",
    url: "/api/designs",
    headers: {
      host: "design.example.test",
      "x-designer-user": identity,
      "x-formaspec-proxy-secret": PROXY_SECRET,
    },
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
  const token = `fsg_${input.id}_secret_918f2d`;
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 3_600_000).toISOString();
  application.database.sqlite.prepare(
    "INSERT OR IGNORE INTO organizations (id, name, config_json, created_at, updated_at) VALUES (?, ?, '{}', ?, ?)",
  ).run(organizationId, `Core events organization ${input.id}`, createdAt, createdAt);
  application.database.sqlite.prepare(
    `INSERT INTO principals (id, organization_id, kind, display_name, external_id, created_at)
     VALUES (?, ?, 'agent', ?, ?, ?)`,
  ).run(principalId, organizationId, input.id, `core-events:${input.id}`, createdAt);
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

async function createFixture(label: string): Promise<Fixture> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `formaspec-core-events-${label}-`));
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
    DESIGNER_TOKEN: "core-events-bootstrap-token-0001",
    FORMASPEC_TRUSTED_PROXIES: "127.0.0.1",
    FORMASPEC_PROXY_SECRET: PROXY_SECRET,
    DESIGNER_CORS_ORIGINS: PUBLIC_ORIGIN,
    DESIGNER_LOG_LEVEL: "silent",
  }));
  applications.push(application);
  await application.app.ready();
  await warmIdentity(application, ADMIN_IDENTITY);
  const current = application.policies.read(ADMIN_ACTOR);
  const policy = structuredClone(current.policy);
  policy.identity.roleMappings = [
    { claim: "identity", value: ADMIN_IDENTITY, role: "organization_admin" },
    { claim: "identity", value: VIEWER_IDENTITY, role: "viewer" },
  ];
  application.policies.update(ADMIN_ACTOR, {
    expectedConfigurationHash: current.configurationHash,
    policy,
  });
  await warmIdentity(application, VIEWER_IDENTITY);

  const allowed = application.service.createDesign(ADMIN_ACTOR, {
    name: "Allowed SSE project",
    preset: "web",
    idempotencyKey: `core-events-allowed-${label}-0001`,
  });
  const denied = application.service.createDesign(ADMIN_ACTOR, {
    name: `Denied SSE ${PRIVATE_MARKER}`,
    preset: "phone",
    idempotencyKey: `core-events-denied-${label}-0001`,
  });
  const foreignGrant = installGrant(application, {
    id: `core_events_foreign_${label}`,
    organizationId: `organization_core_events_foreign_${label}`,
    projectIds: [],
    scopes: ["design:read", "design:write"],
  });
  const foreign = application.service.createDesign(foreignGrant.actorId, {
    name: `Foreign SSE ${FOREIGN_MARKER}`,
    preset: "tablet",
    idempotencyKey: `core-events-foreign-${label}-0001`,
  });
  const restrictedGrant = installGrant(application, {
    id: `core_events_restricted_${label}`,
    projectIds: [allowed.document.id],
    scopes: ["design:read"],
  });
  const taskGrant = installGrant(application, {
    id: `core_events_task_${label}`,
    projectIds: [allowed.document.id],
    scopes: ["task:read"],
  });
  const scopeDeniedGrant = installGrant(application, {
    id: `core_events_scope_denied_${label}`,
    projectIds: [allowed.document.id],
    scopes: ["design:write"],
  });
  const allowedFrameId = allowed.document.pages[0]!.children[0]!;
  const deniedFrameId = denied.document.pages[0]!.children[0]!;
  application.service.applyRevision(ADMIN_ACTOR, allowed.document.id, {
    baseVersion: 1,
    operations: [{ type: "update_node", node_id: allowedFrameId, patch: { name: "Allowed replay" } }],
    idempotencyKey: `core-events-allowed-replay-${label}-0001`,
  });
  application.service.applyRevision(ADMIN_ACTOR, denied.document.id, {
    baseVersion: 1,
    operations: [{ type: "update_node", node_id: deniedFrameId, patch: { name: PRIVATE_MARKER } }],
    idempotencyKey: `core-events-denied-replay-${label}-0001`,
  });

  await application.app.listen({ host: "127.0.0.1", port: 0 });
  const address = application.app.server.address();
  if (!address || typeof address === "string") throw new Error("Expected a loopback TCP listener.");
  return {
    application,
    root,
    port: (address as AddressInfo).port,
    allowedDesignId: allowed.document.id,
    allowedFrameId,
    deniedDesignId: denied.document.id,
    deniedFrameId,
    foreignDesignId: foreign.document.id,
    restrictedGrant,
    taskGrant,
    scopeDeniedGrant,
  };
}

function emitWorkspaceEvent(
  application: DesignerApplication,
  type: DesignerEventType,
  data: Record<string, unknown>,
): number {
  const now = new Date().toISOString();
  const inserted = application.database.sqlite.prepare(
    `INSERT INTO event_outbox
     (organization_id, actor_id, event_type, payload_json, workspace, created_at, published_at)
     VALUES ('organization_legacy', ?, ?, ?, 1, ?, ?)`,
  ).run(ADMIN_ACTOR, type, JSON.stringify(data), now, now);
  const id = Number(inserted.lastInsertRowid);
  application.events.publishPersisted({
    id,
    type,
    actorId: ADMIN_ACTOR,
    organizationId: "organization_legacy",
    ...(typeof data.designId === "string" ? { designId: data.designId } : {}),
    timestamp: now,
    data,
  }, true);
  return id;
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

function eventState(application: DesignerApplication): unknown {
  return {
    outbox: application.database.sqlite.prepare(
      "SELECT id, organization_id, actor_id, event_type, payload_json, workspace, created_at FROM event_outbox ORDER BY id",
    ).all(),
    audits: application.database.sqlite.prepare(
      "SELECT organization_id, actor_id, action, target_type, target_id, details_json FROM audit_events ORDER BY id",
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

describe("core SSE HTTP authorization", () => {
  it("authorizes both stream routes before Last-Event-ID parsing or stream registration without side effects", async () => {
    const fixture = await createFixture("ordering");
    const { application } = fixture;
    const hidden = [
      PRIVATE_MARKER,
      PRIVATE_TOKEN,
      fixture.allowedDesignId,
      fixture.deniedDesignId,
      fixture.foreignDesignId,
      fixture.restrictedGrant.token,
      fixture.scopeDeniedGrant.token,
    ];
    const before = eventState(application);
    const beforeFiles = await filesBelow(fixture.root);
    const subscribe = vi.spyOn(application.events, "subscribe");
    const latestEventId = vi.spyOn(application.service, "latestEventId");
    const eventsSince = vi.spyOn(application.service, "eventsSince");

    for (const route of ["/events", "/api/events"] as const) {
      const missingIdentity = await application.app.inject({
        method: "GET",
        url: route,
        headers: {
          host: "design.example.test",
          accept: "text/event-stream",
          "last-event-id": PRIVATE_MARKER,
          authorization: `Bearer ${PRIVATE_TOKEN}`,
          "x-formaspec-proxy-secret": PROXY_SECRET,
        },
      });
      expectError(missingIdentity, 401, "AUTH_REQUIRED", hidden);

      const scopeDenied = await application.app.inject({
        method: "GET",
        url: route,
        headers: {
          ...grantHeaders(fixture.scopeDeniedGrant.token),
          "last-event-id": PRIVATE_MARKER,
        },
      });
      expectError(scopeDenied, 403, "FORBIDDEN", hidden);

      const invalidCursor = await application.app.inject({
        method: "GET",
        url: route,
        headers: {
          ...serverHeaders(VIEWER_IDENTITY),
          "last-event-id": PRIVATE_MARKER,
        },
      });
      expectError(invalidCursor, 422, "VALIDATION_FAILED", hidden);
    }

    const directScopeError = captureDomainError(
      () => application.service.authorizeEventRead(fixture.scopeDeniedGrant.actorId),
    );
    expect(directScopeError).toMatchObject({ statusCode: 403, code: "FORBIDDEN" });
    for (const value of hidden) expect(JSON.stringify(directScopeError.toJSON())).not.toContain(value);

    expect(subscribe).not.toHaveBeenCalled();
    expect(latestEventId).not.toHaveBeenCalled();
    expect(eventsSince).not.toHaveBeenCalled();
    expect(eventState(application)).toEqual(before);
    expect(await filesBelow(fixture.root)).toEqual(beforeFiles);
  });

  it("filters replay, bounds, and cursors by event scope, human role, and project before LIMIT", async () => {
    const fixture = await createFixture("event-policy-replay");
    const { application } = fixture;
    const designFirstMarker = "SSE_DESIGN_FIRST_850f5f";
    const designSentinel = "SSE_DESIGN_SENTINEL_198e45";
    const taskFirstMarker = "SSE_TASK_FIRST_67e12a";
    const taskSentinel = "SSE_TASK_SENTINEL_56317f";
    const deniedTaskMarker = "SSE_DENIED_TASK_a6597c";
    const handoffMarker = "SSE_HANDOFF_PRIVATE_91d7ce";
    const redesignMarker = "SSE_REDESIGN_PRIVATE_6b316e";
    const adminMarker = "SSE_ADMIN_PRIVATE_e2a17f";
    const injectedAdminMarker = "SSE_INJECTED_ADMIN_5ab284";

    const firstDesignId = emitWorkspaceEvent(application, "design.updated", {
      designId: fixture.allowedDesignId,
      marker: designFirstMarker,
    });
    const firstTaskId = emitWorkspaceEvent(application, "agent_task.transitioned", {
      designId: fixture.allowedDesignId,
      marker: taskFirstMarker,
    });
    emitWorkspaceEvent(application, "agent_task.transitioned", {
      designId: fixture.deniedDesignId,
      marker: deniedTaskMarker,
    });
    emitWorkspaceEvent(application, "handoff.transitioned", {
      designId: fixture.allowedDesignId,
      marker: handoffMarker,
    });
    emitWorkspaceEvent(application, "redesign.transitioned", {
      designId: fixture.allowedDesignId,
      marker: redesignMarker,
    });
    emitWorkspaceEvent(application, "backup.operation", { marker: adminMarker });
    emitWorkspaceEvent(application, "backup.operation", {
      designId: fixture.allowedDesignId,
      marker: injectedAdminMarker,
    });
    const designSentinelId = emitWorkspaceEvent(application, "design.updated", {
      designId: fixture.allowedDesignId,
      marker: designSentinel,
    });
    const taskSentinelId = emitWorkspaceEvent(application, "agent_task.transitioned", {
      designId: fixture.allowedDesignId,
      marker: taskSentinel,
    });

    const designReplay = application.service.eventsSince(fixture.restrictedGrant.actorId, 0);
    const designReplayJson = JSON.stringify(designReplay.events);
    expect(designReplayJson).toContain(designFirstMarker);
    expect(designReplayJson).toContain(designSentinel);
    for (const hidden of [taskFirstMarker, taskSentinel, deniedTaskMarker, handoffMarker, redesignMarker, adminMarker]) {
      expect(designReplayJson).not.toContain(hidden);
    }
    expect(designReplay.latestId).toBe(designSentinelId);
    expect(application.service.latestEventId(fixture.restrictedGrant.actorId)).toBe(designSentinelId);
    expect(application.service.eventsSince(fixture.restrictedGrant.actorId, firstDesignId, 1)).toMatchObject({
      events: [{ id: designSentinelId, data: { marker: designSentinel } }],
      latestId: designSentinelId,
      hasMore: false,
    });

    application.service.authorizeEventRead(fixture.taskGrant.actorId);
    const taskReplay = application.service.eventsSince(fixture.taskGrant.actorId, 0);
    const taskReplayJson = JSON.stringify(taskReplay.events);
    expect(taskReplayJson).toContain(taskFirstMarker);
    expect(taskReplayJson).toContain(taskSentinel);
    for (const hidden of [designFirstMarker, designSentinel, deniedTaskMarker, handoffMarker, redesignMarker, adminMarker]) {
      expect(taskReplayJson).not.toContain(hidden);
    }
    expect(taskReplay.latestId).toBe(taskSentinelId);
    expect(application.service.latestEventId(fixture.taskGrant.actorId)).toBe(taskSentinelId);
    expect(application.service.eventsSince(fixture.taskGrant.actorId, firstTaskId, 1)).toMatchObject({
      events: [{ id: taskSentinelId, data: { marker: taskSentinel } }],
      latestId: taskSentinelId,
      hasMore: false,
    });

    const [designStream, taskStream, viewerStream, adminStream] = await Promise.all([
      openSse(fixture.port, "/events", {
        ...grantHeaders(fixture.restrictedGrant.token),
        "last-event-id": String(firstDesignId - 1),
      }),
      openSse(fixture.port, "/api/events", {
        ...grantHeaders(fixture.taskGrant.token),
        "last-event-id": String(firstTaskId - 1),
      }),
      openSse(fixture.port, "/api/events", {
        ...serverHeaders(VIEWER_IDENTITY),
        "last-event-id": String(firstDesignId - 1),
      }),
      openSse(fixture.port, "/events", {
        ...serverHeaders(ADMIN_IDENTITY),
        "last-event-id": String(firstDesignId - 1),
      }),
    ]);
    await Promise.all([
      designStream.waitFor((capture) => capture.raw.includes(designSentinel)),
      taskStream.waitFor((capture) => capture.raw.includes(taskSentinel)),
      viewerStream.waitFor((capture) => capture.raw.includes(taskSentinel)),
      adminStream.waitFor((capture) => capture.raw.includes(taskSentinel)),
    ]);
    for (const hidden of [taskFirstMarker, taskSentinel, deniedTaskMarker, handoffMarker, redesignMarker, adminMarker]) {
      expect(designStream.raw).not.toContain(hidden);
    }
    for (const hidden of [designFirstMarker, designSentinel, deniedTaskMarker, handoffMarker, redesignMarker, adminMarker]) {
      expect(taskStream.raw).not.toContain(hidden);
    }
    expect(viewerStream.raw).toContain(handoffMarker);
    expect(viewerStream.raw).toContain(redesignMarker);
    expect(viewerStream.raw).not.toContain(adminMarker);
    expect(viewerStream.raw).not.toContain(injectedAdminMarker);
    expect(adminStream.raw).toContain(adminMarker);
    expect(adminStream.raw).not.toContain(injectedAdminMarker);
  }, 15_000);

  it("keeps live delivery aligned with replay and closes streams on scope-policy removal or revocation", async () => {
    const fixture = await createFixture("event-policy-live");
    const { application } = fixture;
    const [designStream, taskStream, viewerStream, adminStream] = await Promise.all([
      openSse(fixture.port, "/events", grantHeaders(fixture.restrictedGrant.token)),
      openSse(fixture.port, "/api/events", grantHeaders(fixture.taskGrant.token)),
      openSse(fixture.port, "/api/events", serverHeaders(VIEWER_IDENTITY)),
      openSse(fixture.port, "/events", serverHeaders(ADMIN_IDENTITY)),
    ]);
    for (const stream of [designStream, taskStream, viewerStream, adminStream]) {
      expect(stream.statusCode).toBe(200);
      await stream.waitFor((capture) => capture.raw.includes(": connected"));
    }

    const taskMarker = "SSE_LIVE_TASK_7e1c38";
    const deniedTaskMarker = "SSE_LIVE_DENIED_TASK_bd91aa";
    const handoffMarker = "SSE_LIVE_HANDOFF_a0682f";
    const redesignMarker = "SSE_LIVE_REDESIGN_9fd003";
    const adminMarker = "SSE_LIVE_ADMIN_09cb87";
    const designMarker = "SSE_LIVE_DESIGN_0b8e59";
    const taskSentinel = "SSE_LIVE_TASK_SENTINEL_d973eb";
    emitWorkspaceEvent(application, "agent_task.transitioned", {
      designId: fixture.allowedDesignId,
      marker: taskMarker,
    });
    emitWorkspaceEvent(application, "agent_task.transitioned", {
      designId: fixture.deniedDesignId,
      marker: deniedTaskMarker,
    });
    emitWorkspaceEvent(application, "handoff.transitioned", {
      designId: fixture.allowedDesignId,
      marker: handoffMarker,
    });
    emitWorkspaceEvent(application, "redesign.transitioned", {
      designId: fixture.allowedDesignId,
      marker: redesignMarker,
    });
    emitWorkspaceEvent(application, "agent_connection.changed", { marker: adminMarker });
    emitWorkspaceEvent(application, "design.updated", {
      designId: fixture.allowedDesignId,
      marker: designMarker,
    });
    emitWorkspaceEvent(application, "agent_task.transitioned", {
      designId: fixture.allowedDesignId,
      marker: taskSentinel,
    });

    await Promise.all([
      designStream.waitFor((capture) => capture.raw.includes(designMarker)),
      taskStream.waitFor((capture) => capture.raw.includes(taskSentinel)),
      viewerStream.waitFor((capture) => capture.raw.includes(taskSentinel)),
      adminStream.waitFor((capture) => capture.raw.includes(taskSentinel)),
    ]);
    expect(designStream.raw).not.toContain(taskMarker);
    expect(designStream.raw).not.toContain(taskSentinel);
    expect(designStream.raw).not.toContain(handoffMarker);
    expect(designStream.raw).not.toContain(redesignMarker);
    expect(designStream.raw).not.toContain(adminMarker);
    expect(taskStream.raw).toContain(taskMarker);
    expect(taskStream.raw).toContain(taskSentinel);
    expect(taskStream.raw).not.toContain(designMarker);
    expect(taskStream.raw).not.toContain(deniedTaskMarker);
    expect(taskStream.raw).not.toContain(handoffMarker);
    expect(taskStream.raw).not.toContain(redesignMarker);
    expect(taskStream.raw).not.toContain(adminMarker);
    expect(viewerStream.raw).toContain(taskMarker);
    expect(viewerStream.raw).toContain(handoffMarker);
    expect(viewerStream.raw).toContain(redesignMarker);
    expect(viewerStream.raw).not.toContain(adminMarker);
    expect(adminStream.raw).toContain(adminMarker);

    const current = application.policies.read(ADMIN_ACTOR);
    const policy = structuredClone(current.policy);
    policy.agents.allowedScopes = policy.agents.allowedScopes.filter((scope) => scope !== "task:read");
    const policyUpdate = await application.app.inject({
      method: "PUT",
      url: "/api/organization/policy",
      headers: {
        ...serverHeaders(ADMIN_IDENTITY),
        origin: PUBLIC_ORIGIN,
        "x-formaspec-csrf": "1",
      },
      payload: {
        expectedConfigurationHash: current.configurationHash,
        policy,
      },
    });
    expect(policyUpdate.statusCode, policyUpdate.body).toBe(200);
    await taskStream.waitForClose();

    application.enterprise.revokeAgentConnection(ADMIN_ACTOR, fixture.restrictedGrant.connectionId);
    await designStream.waitForClose();
  }, 15_000);

  it("preserves trusted UI streams and project-filtered scoped streams with immediate revocation on both routes", async () => {
    const fixture = await createFixture("allowed");
    const { application } = fixture;

    const ui = await openSse(fixture.port, "/events", serverHeaders(VIEWER_IDENTITY));
    expect(ui.statusCode).toBe(200);
    expect(ui.headers["content-type"]).toContain("text/event-stream");
    await ui.waitFor((capture) => capture.raw.includes(": connected"));
    ui.destroy();

    const replay = application.service.eventsSince(fixture.restrictedGrant.actorId, 0).events;
    const firstAllowed = replay.find(
      (event) => event.data.designId === fixture.allowedDesignId && event.data.version === 1,
    );
    const secondAllowed = replay.find(
      (event) => event.data.designId === fixture.allowedDesignId && event.data.version === 2,
    );
    expect(firstAllowed).toBeDefined();
    expect(secondAllowed).toBeDefined();

    const streams = await Promise.all(["/events", "/api/events"].map((route) => openSse(
      fixture.port,
      route,
      {
        ...grantHeaders(fixture.restrictedGrant.token),
        "last-event-id": String(firstAllowed!.id),
      },
    )));
    for (const stream of streams) {
      expect(stream.statusCode).toBe(200);
      await stream.waitFor((capture) => capture.events.some((event) => event.id === secondAllowed!.id));
      expect(stream.raw).not.toContain(fixture.deniedDesignId);
      expect(stream.raw).not.toContain(fixture.foreignDesignId);
      expect(stream.raw).not.toContain(PRIVATE_MARKER);
      expect(stream.raw).not.toContain(FOREIGN_MARKER);
    }

    application.service.applyRevision(ADMIN_ACTOR, fixture.deniedDesignId, {
      baseVersion: 2,
      operations: [{ type: "update_node", node_id: fixture.deniedFrameId, patch: { name: PRIVATE_MARKER } }],
      idempotencyKey: "core-events-denied-live-0001",
    });
    application.service.applyRevision(ADMIN_ACTOR, fixture.allowedDesignId, {
      baseVersion: 2,
      operations: [{ type: "update_node", node_id: fixture.allowedFrameId, patch: { name: "Allowed live" } }],
      idempotencyKey: "core-events-allowed-live-0001",
    });
    for (const stream of streams) {
      await stream.waitFor((capture) => capture.events.some(
        (event) => event.data.designId === fixture.allowedDesignId && event.data.version === 3,
      ));
      expect(stream.raw).not.toContain(fixture.deniedDesignId);
      expect(stream.raw).not.toContain(fixture.foreignDesignId);
      expect(stream.raw).not.toContain(PRIVATE_MARKER);
      expect(stream.raw).not.toContain(FOREIGN_MARKER);
    }

    application.enterprise.revokeAgentConnection(ADMIN_ACTOR, fixture.restrictedGrant.connectionId);
    await Promise.all(streams.map((stream) => stream.waitForClose()));
    for (const route of ["/events", "/api/events"] as const) {
      const revoked = await request(fixture.port, route, grantHeaders(fixture.restrictedGrant.token));
      expect(revoked.statusCode).toBe(401);
      expect(revoked.body).not.toContain(fixture.allowedDesignId);
      expect(revoked.body).not.toContain(fixture.deniedDesignId);
      expect(revoked.body).not.toContain(fixture.foreignDesignId);
      expect(revoked.body).not.toContain(fixture.restrictedGrant.token);
    }
  }, 15_000);
});
