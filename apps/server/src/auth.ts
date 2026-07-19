import { timingSafeEqual } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";

import type { ServerConfig } from "./config.js";
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

export function registerAuthentication(app: FastifyInstance, config: ServerConfig): void {
  app.decorateRequest("actorId", "local");
  app.addHook("onRequest", async (request) => {
    if (request.url === "/health" || request.url === "/ready") {
      request.actorId = "anonymous";
      return;
    }

    if (config.authMode === "none") {
      const localIdentity = request.headers[config.trustedUserHeader];
      request.actorId = typeof localIdentity === "string" && localIdentity.trim()
        ? `local:${localIdentity.trim().slice(0, 120)}`
        : "local";
      return;
    }

    if (config.authMode === "trusted-header" && request.url.startsWith("/mcp") && config.authToken) {
      const token = bearerToken(request);
      if (!token || !safeEqual(token, config.authToken)) {
        throw new DomainError("AUTH_REQUIRED", "A valid bearer token is required for MCP.", 401);
      }
      request.actorId = actorIdFromToken(token);
      return;
    }

    if (config.authMode === "trusted-header") {
      const identity = request.headers[config.trustedUserHeader];
      if (typeof identity !== "string" || !identity.trim()) {
        throw new DomainError("AUTH_REQUIRED", `Missing trusted identity header ${config.trustedUserHeader}.`, 401);
      }
      request.actorId = `trusted:${identity.trim().slice(0, 200)}`;
      return;
    }

    const token = bearerToken(request);
    if (!token || !config.authToken || !safeEqual(token, config.authToken)) {
      throw new DomainError("AUTH_REQUIRED", "A valid bearer token is required.", 401);
    }
    request.actorId = actorIdFromToken(token);
  });
}
