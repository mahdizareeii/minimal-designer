import { createHash, timingSafeEqual } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";

import type { ServerConfig } from "./config.js";
import type { DesignerDatabase } from "./db/database.js";
import { resolveAccess } from "./authorization.js";
import { DomainError } from "./errors.js";
import { actorIdFromToken } from "./ids.js";

declare module "fastify" {
  interface FastifyRequest {
    actorId: string;
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function bearerToken(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return undefined;
  return authorization.slice(7).trim() || undefined;
}

function requestPath(url: string): string {
  return url.split("?", 1)[0] ?? url;
}

function isEventStreamPath(url: string): boolean {
  const path = requestPath(url);
  return path === "/events" || path === "/api/events";
}

function isPairingNoncePath(url: string): boolean {
  return requestPath(url) === "/api/agent-connections/pair";
}

function actorIdFromScopedGrant(database: DesignerDatabase, token: string): string | undefined {
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const now = new Date().toISOString();
  const row = database.sqlite.prepare(
    `SELECT g.id, g.expires_at, g.revoked_at, p.disabled_at,
            (
              SELECT c.id FROM agent_connections c
              WHERE c.organization_id = g.organization_id
                AND c.principal_id = g.principal_id
                AND c.status = 'active'
                AND (c.expires_at IS NULL OR c.expires_at > ?)
              ORDER BY c.updated_at DESC, c.id
              LIMIT 1
            ) AS connection_id
     FROM agent_grants g
     JOIN principals p ON p.id = g.principal_id AND p.organization_id = g.organization_id
     WHERE g.token_hash = ?`,
  ).get(now, tokenHash) as {
    id: string;
    expires_at: string;
    revoked_at: string | null;
    disabled_at: string | null;
    connection_id: string | null;
  } | undefined;
  if (!row) return undefined;

  if (row.revoked_at || row.disabled_at || row.expires_at <= now || !row.connection_id) {
    throw new DomainError("AUTH_REQUIRED", "The agent grant is expired, revoked, or unavailable.", 401);
  }
  database.sqlite.transaction(() => {
    database.sqlite.prepare(
      "UPDATE agent_grants SET last_used_at = ? WHERE id = ? AND revoked_at IS NULL",
    ).run(now, row.id);
    database.sqlite.prepare(
      `UPDATE agent_connections SET last_used_at = ?, updated_at = ?
       WHERE id = ? AND status = 'active'`,
    ).run(now, now, row.connection_id);
  }).immediate();
  return `grant_${row.id}`;
}

export function registerAuthentication(
  app: FastifyInstance,
  config: ServerConfig,
  database: DesignerDatabase,
): void {
  app.decorateRequest("actorId", "local");
  app.addHook("onRequest", async (request) => {
    if (request.url === "/health" || request.url === "/ready" || request.url.startsWith("/health/")) {
      request.actorId = "anonymous";
      return;
    }

    if (requestPath(request.url) === "/api/agent-authorization-context") {
      const token = bearerToken(request);
      if (!token) {
        throw new DomainError("AUTH_REQUIRED", "A valid scoped agent grant is required.", 401);
      }
      const scopedActorId = actorIdFromScopedGrant(database, token);
      if (!scopedActorId) {
        throw new DomainError("AUTH_REQUIRED", "A valid scoped agent grant is required.", 401);
      }
      resolveAccess(database.sqlite, scopedActorId);
      request.actorId = scopedActorId;
      return;
    }

    if (isEventStreamPath(request.url)) {
      const token = bearerToken(request);
      if (token) {
        const scopedActorId = actorIdFromScopedGrant(database, token);
        if (scopedActorId) {
          // Keep agent event streams on the same revocable, project-scoped
          // authorization path as MCP. Browser EventSource requests without a
          // bearer token continue through the local/trusted-user flow below.
          resolveAccess(database.sqlite, scopedActorId);
          request.actorId = scopedActorId;
          return;
        }
        if (config.authToken && safeEqual(token, config.authToken)) {
          const actorId = actorIdFromToken(token);
          resolveAccess(database.sqlite, actorId);
          request.actorId = actorId;
          return;
        }
        throw new DomainError("AUTH_REQUIRED", "A valid bearer token is required for the event stream.", 401);
      }
    }

    if (request.url.startsWith("/mcp")) {
      const token = bearerToken(request);
      if (!token && config.appMode === "local") {
        request.actorId = "local";
        return;
      }
      if (!token) {
        throw new DomainError("AUTH_REQUIRED", "A valid bearer token is required for MCP.", 401);
      }
      const scopedActorId = actorIdFromScopedGrant(database, token);
      if (scopedActorId) {
        // Re-evaluate organization policy at the HTTP boundary so MCP
        // initialize and discovery cannot keep using a grant after its
        // adapter, scopes, or project-restriction policy is revoked.
        resolveAccess(database.sqlite, scopedActorId);
        request.actorId = scopedActorId;
        return;
      }
      // Compatibility for existing environment-token deployments. Newly paired
      // clients use the revocable scoped-grant path above.
      if (config.authToken && safeEqual(token, config.authToken)) {
        const actorId = actorIdFromToken(token);
        // Authenticate the legacy token against current organization policy at
        // the HTTP boundary as well as inside individual service calls. MCP
        // initialize and discovery methods do not otherwise enter the service
        // authorization layer.
        resolveAccess(database.sqlite, actorId);
        request.actorId = actorId;
        return;
      }
      throw new DomainError("AUTH_REQUIRED", "A valid bearer token is required for MCP.", 401);
    }

    if (config.appMode === "local") {
      // Local browser requests deliberately ignore identity headers. Trusting a
      // caller-supplied header on loopback would let any local web page
      // impersonate a user when the browser reaches the service.
      request.actorId = "local";
      return;
    }

    if (config.authMode === "trusted-header") {
      const identity = request.headers[config.trustedUserHeader];
      if (typeof identity !== "string" || !identity.trim()) {
        throw new DomainError("AUTH_REQUIRED", `Missing trusted identity header ${config.trustedUserHeader}.`, 401);
      }
      const normalizedIdentity = identity.trim();
      if (identity !== normalizedIdentity
        || Buffer.byteLength(normalizedIdentity, "utf8") > 200
        || /[\u0000-\u001f\u007f,]/.test(normalizedIdentity)) {
        throw new DomainError(
          "AUTH_REQUIRED",
          `Trusted identity header ${config.trustedUserHeader} is ambiguous or malformed.`,
          401,
        );
      }
      const actorId = `trusted:${normalizedIdentity}`;
      if (!isPairingNoncePath(request.url)) {
        // Resolve identity mapping before route parsing or multipart work. The
        // one-time pairing endpoint remains nonce-authorized by design; every
        // other trusted-header surface must have a live mapped principal.
        resolveAccess(database.sqlite, actorId);
      }
      request.actorId = actorId;
      return;
    }

    const token = bearerToken(request);
    if (!token || !config.authToken || !safeEqual(token, config.authToken)) {
      throw new DomainError("AUTH_REQUIRED", "A valid bearer token is required.", 401);
    }
    request.actorId = actorIdFromToken(token);
  });
}
