import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import staticFiles from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";

import { registerAuthentication } from "./auth.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { DesignerDatabase } from "./db/database.js";
import { asDomainError, DomainError } from "./errors.js";
import { EventHub } from "./events.js";
import { registerHttpRoutes } from "./http-routes.js";
import { registerMcpEndpoint } from "./mcp.js";
import { PngRenderer } from "./render.js";
import { DesignerService } from "./service.js";

export interface DesignerApplication {
  app: FastifyInstance;
  config: ServerConfig;
  database: DesignerDatabase;
  service: DesignerService;
  events: EventHub;
  renderer: PngRenderer;
}

export async function buildApplication(config = loadConfig()): Promise<DesignerApplication> {
  const app = Fastify({
    logger: config.logLevel === "silent" ? false : { level: config.logLevel },
    bodyLimit: Math.max(config.maxAssetBytes + 1024 * 1024, 2 * 1024 * 1024),
    trustProxy: config.authMode === "trusted-header",
  });
  const database = new DesignerDatabase(config.databasePath);
  const events = new EventHub();
  const renderer = new PngRenderer();
  const service = new DesignerService(database, events, config.previewTtlSeconds);

  app.setErrorHandler((error, request, reply) => {
    let domainError: DomainError;
    if (error instanceof DomainError) {
      domainError = error;
    } else if (error instanceof ZodError) {
      domainError = new DomainError("VALIDATION_FAILED", "The request did not match the expected schema.", 422, {
        details: { issues: error.issues },
      });
    } else if ((error as { statusCode?: unknown }).statusCode === 413) {
      domainError = new DomainError("PAYLOAD_TOO_LARGE", "The request payload exceeds the configured limit.", 413);
    } else if (typeof (error as { statusCode?: unknown }).statusCode === "number"
      && ((error as { statusCode: number }).statusCode >= 400)
      && ((error as { statusCode: number }).statusCode < 500)) {
      domainError = new DomainError(
        "VALIDATION_FAILED",
        error instanceof Error ? error.message : "The request is invalid.",
        (error as { statusCode: number }).statusCode,
      );
    } else {
      domainError = asDomainError(error);
    }
    if (domainError.statusCode >= 500) request.log.error({ error }, domainError.message);
    return reply.code(domainError.statusCode).send({ error: domainError.toJSON() });
  });

  await app.register(cors, {
    origin(origin, callback) {
      if (!origin || config.corsOrigins.includes(origin)) callback(null, true);
      else callback(new DomainError("FORBIDDEN", "Origin is not allowed.", 403), false);
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["authorization", "content-type", config.trustedUserHeader],
  });
  await app.register(multipart, {
    limits: { fileSize: config.maxAssetBytes, files: 1, fields: 8 },
  });

  registerAuthentication(app, config);
  registerHttpRoutes(app, { config, service, events, renderer });
  registerMcpEndpoint(app, { config, service, renderer });

  const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  if (fs.existsSync(path.join(webDist, "index.html"))) {
    await app.register(staticFiles, {
      root: webDist,
      prefix: "/",
      wildcard: false,
    });
    app.setNotFoundHandler((request, reply) => {
      const protectedPrefix = ["/api", "/mcp", "/health", "/ready"].some((prefix) =>
        request.url === prefix || request.url.startsWith(`${prefix}/`) || request.url.startsWith(`${prefix}?`));
      const acceptsHtml = request.method === "GET" && (request.headers.accept?.includes("text/html") ?? false);
      if (!protectedPrefix && acceptsHtml) return reply.sendFile("index.html");
      return reply.code(404).send({
        error: { code: "NOT_FOUND", message: "Route not found.", retryable: false },
      });
    });
  }

  app.addHook("onClose", async () => {
    await renderer.close();
    database.close();
  });

  return { app, config, database, service, events, renderer };
}
