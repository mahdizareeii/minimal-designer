import { createHash } from "node:crypto";
import fs from "node:fs";
import http, { type ClientRequest, type IncomingMessage, type OutgoingHttpHeaders } from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { loadConfig } from "./config.js";

interface ParsedSseEvent {
  id: number;
  event: string;
  data: Record<string, unknown>;
}

interface HttpResult {
  statusCode: number;
  body: string;
}

const applications: DesignerApplication[] = [];
const captures: SseCapture[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const capture of captures.splice(0)) capture.destroy();
  await Promise.all(applications.splice(0).map((application) => application.app.close()));
  await Promise.all(temporaryDirectories.splice(0).map(
    (directory) => fs.promises.rm(directory, { recursive: true, force: true }),
  ));
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

  waitForClose(timeoutMs = 1_000): Promise<void> {
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

function request(port: number, route: string, headers: OutgoingHttpHeaders): Promise<HttpResult> {
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

async function startApplication(
  label: string,
  authMode: "none" | "session" = "none",
): Promise<{ application: DesignerApplication; port: number }> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `formaspec-sse-http-${label}-`));
  temporaryDirectories.push(root);
  const application = await buildApplication(loadConfig({
    APP_MODE: "local",
    HOST: "127.0.0.1",
    PORT: "4310",
    DATA_DIR: path.join(root, "data"),
    BACKUP_DIR: path.join(root, "backups"),
    DESIGNER_DATABASE_PATH: ":memory:",
    PUBLIC_BASE_URL: "http://127.0.0.1:4310",
    AUTH_MODE: authMode,
    FORMASPEC_ALLOW_SOFTWARE_RENDERER: "true",
    DESIGNER_LOG_LEVEL: "silent",
  }));
  applications.push(application);
  await application.app.listen({ host: "127.0.0.1", port: 0 });
  const address = application.app.server.address();
  if (!address || typeof address === "string") throw new Error("Expected a loopback TCP listener.");
  return { application, port: (address as AddressInfo).port };
}

function installForeignGrant(application: DesignerApplication, id: string): string {
  const organizationId = `organization_${id}`;
  const principalId = `principal_${id}`;
  const connectionId = `connection_${id}`;
  const token = `fsg_${id}_foreign_token_00000001`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 60_000).toISOString();
  application.database.sqlite.prepare(
    `INSERT INTO organizations (id, name, config_json, created_at, updated_at)
     VALUES (?, ?, '{}', ?, ?)`,
  ).run(organizationId, `Foreign ${id}`, now.toISOString(), now.toISOString());
  application.database.sqlite.prepare(
    `INSERT INTO principals (id, organization_id, kind, display_name, external_id, created_at)
     VALUES (?, ?, 'agent', ?, ?, ?)`,
  ).run(principalId, organizationId, id, `foreign:${id}`, now.toISOString());
  application.database.sqlite.prepare(
    `INSERT INTO memberships (organization_id, principal_id, role, created_at)
     VALUES (?, ?, 'agent', ?)`,
  ).run(organizationId, principalId, now.toISOString());
  application.database.sqlite.prepare(
    `INSERT INTO agent_connections
     (id, organization_id, principal_id, adapter, display_name, status, scopes_json, project_ids_json,
      expires_at, created_at, updated_at)
     VALUES (?, ?, ?, 'generic_mcp', ?, 'active', '["design:read","design:write"]', '[]', ?, ?, ?)`,
  ).run(connectionId, organizationId, principalId, id, expiresAt, now.toISOString(), now.toISOString());
  application.database.sqlite.prepare(
    `INSERT INTO agent_grants
     (id, organization_id, principal_id, token_hash, scopes_json, project_ids_json, created_at, expires_at)
     VALUES (?, ?, ?, ?, '["design:read","design:write"]', '[]', ?, ?)`,
  ).run(id, organizationId, principalId, createHash("sha256").update(token).digest("hex"), now.toISOString(), expiresAt);
  return `grant_${id}`;
}

describe("SSE HTTP authorization boundary", () => {
  it("closes a cookie-authenticated stream as soon as logout revokes its token-bound session actor", async () => {
    const { application, port } = await startApplication("browser-session-logout", "session");
    const session = await application.sessions.bootstrap({
      loginName: "admin@example.test",
      displayName: "SSE session administrator",
      password: "correct horse battery staple 2026",
    });
    const cookie = `formaspec_session=${session.sessionToken}`;
    const capture = await openSse(port, "/events", { cookie, accept: "text/event-stream" });
    expect(capture.statusCode).toBe(200);
    await capture.waitFor((stream) => stream.raw.includes(": connected"));

    const logout = await fetch(`http://127.0.0.1:${port}/api/auth/logout`, {
      method: "POST",
      headers: {
        cookie,
        origin: "http://127.0.0.1:4310",
        "x-formaspec-csrf": session.csrfToken,
      },
    });
    expect(logout.status).toBe(204);
    application.service.createDesign("local", {
      name: "Session revocation close signal",
      preset: "web",
      idempotencyKey: "sse-session-revocation-signal-0001",
    });
    await capture.waitForClose();

    const rejected = await request(port, "/events", { cookie, accept: "text/event-stream" });
    expect(rejected.statusCode).toBe(401);
  });

  it.each(["/events", "/api/events"])(
    "filters replay/live events and closes %s immediately when its scoped grant is revoked",
    async (route) => {
      const routeLabel = route === "/events" ? "current" : "legacy";
      const { application, port } = await startApplication(routeLabel);
      const allowed = application.service.createDesign("local", {
        name: "Allowed SSE HTTP project",
        preset: "web",
        idempotencyKey: `sse-http-allowed-${routeLabel}`,
      });
      const denied = application.service.createDesign("local", {
        name: "Denied SSE HTTP project",
        preset: "phone",
        idempotencyKey: `sse-http-denied-${routeLabel}`,
      });
      const foreignActorId = installForeignGrant(application, `sse_http_${routeLabel}`);
      const foreignReplay = application.service.createDesign(foreignActorId, {
        name: "Foreign replay marker",
        preset: "tablet",
        idempotencyKey: `sse-http-foreign-replay-${routeLabel}`,
      });
      const allowedFrame = allowed.document.pages[0]!.children[0]!;
      const deniedFrame = denied.document.pages[0]!.children[0]!;
      application.service.applyRevision("local", allowed.document.id, {
        baseVersion: 1,
        operations: [{ type: "update_node", node_id: allowedFrame, patch: { name: "Allowed replay marker" } }],
        idempotencyKey: `sse-http-allowed-replay-${routeLabel}`,
      });
      application.service.applyRevision("local", denied.document.id, {
        baseVersion: 1,
        operations: [{ type: "update_node", node_id: deniedFrame, patch: { name: "Denied replay marker" } }],
        idempotencyKey: `sse-http-denied-replay-${routeLabel}`,
      });

      const challenge = application.enterprise.createAgentConnection("local", {
        adapter: "codex",
        displayName: `SSE HTTP ${route}`,
        scopes: ["design:read"],
        projectIds: [allowed.document.id],
        expiresInSeconds: 3_600,
      });
      const paired = application.enterprise.pairAgentConnection(challenge.nonce);
      const authorizedReplay = application.service.eventsSince(paired.grant.actorId, 0).events;
      const firstAllowed = authorizedReplay.find((event) => event.data.designId === allowed.document.id && event.data.version === 1);
      const secondAllowed = authorizedReplay.find((event) => event.data.designId === allowed.document.id && event.data.version === 2);
      expect(firstAllowed).toBeDefined();
      expect(secondAllowed).toBeDefined();

      const capture = await openSse(port, route, {
        authorization: `Bearer ${paired.grant.token}`,
        accept: "text/event-stream",
        "last-event-id": String(firstAllowed!.id),
      });
      expect(capture.statusCode).toBe(200);
      expect(capture.headers["content-type"]).toContain("text/event-stream");
      await capture.waitFor((stream) => stream.events.some((event) => event.id === secondAllowed!.id));
      expect(capture.events.some((event) => event.id === firstAllowed!.id)).toBe(false);
      expect(capture.raw).not.toContain(denied.document.id);
      expect(capture.raw).not.toContain(foreignReplay.document.id);

      application.service.applyRevision("local", denied.document.id, {
        baseVersion: 2,
        operations: [{ type: "update_node", node_id: deniedFrame, patch: { name: "Denied live marker" } }],
        idempotencyKey: `sse-http-denied-live-${routeLabel}`,
      });
      const foreignLive = application.service.createDesign(foreignActorId, {
        name: "Foreign live marker",
        preset: "web",
        idempotencyKey: `sse-http-foreign-live-${routeLabel}`,
      });
      application.service.applyRevision("local", allowed.document.id, {
        baseVersion: 2,
        operations: [{ type: "update_node", node_id: allowedFrame, patch: { name: "Allowed live marker" } }],
        idempotencyKey: `sse-http-allowed-live-${routeLabel}`,
      });
      await capture.waitFor((stream) => stream.events.some(
        (event) => event.data.designId === allowed.document.id && event.data.version === 3,
      ));
      expect(capture.raw).not.toContain(denied.document.id);
      expect(capture.raw).not.toContain(foreignReplay.document.id);
      expect(capture.raw).not.toContain(foreignLive.document.id);

      application.enterprise.revokeAgentConnection("local", paired.connection.id);
      await capture.waitForClose();
      expect(capture.raw).not.toContain(paired.connection.id);

      const revoked = await request(port, route, {
        authorization: `Bearer ${paired.grant.token}`,
        accept: "text/event-stream",
      });
      expect(revoked.statusCode).toBe(401);
      expect(revoked.body).not.toContain(allowed.document.id);
      expect(revoked.body).not.toContain(denied.document.id);
      expect(revoked.body).not.toContain(foreignReplay.document.id);
    },
    15_000,
  );
});
