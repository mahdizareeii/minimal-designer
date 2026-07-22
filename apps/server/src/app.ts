import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import staticFiles from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";

import { registerAuthentication } from "./auth.js";
import { ContentAddressedRasterStore } from "./assets.js";
import { BackupManager, inspectRestoreJournal } from "./backup.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { DesignerDatabase } from "./db/database.js";
import { ComponentInsertionService } from "./component-insertion-service.js";
import { DesignSystemService } from "./design-system-service.js";
import { registerEnterpriseDomainHttpRoutes } from "./enterprise-domain-http-routes.js";
import { asDomainError, DomainError } from "./errors.js";
import { EventHub, flushPersistedEventOutbox } from "./events.js";
import { EnterpriseService } from "./enterprise-service.js";
import { registerEnterpriseHttpRoutes } from "./enterprise-http-routes.js";
import { registerHttpRoutes } from "./http-routes.js";
import {
  MaintenanceStore,
  registerMaintenanceGuard,
  registerMaintenanceStatusRoute,
} from "./maintenance.js";
import { registerMcpEndpoint } from "./mcp.js";
import { registerOperationsHttpRoutes } from "./operations-http-routes.js";
import { OperationsService } from "./operations-service.js";
import { registerOrganizationPolicyHttpRoutes } from "./organization-policy-http-routes.js";
import { OrganizationPolicyService } from "./organization-policy-service.js";
import {
  collectProtectedNonMcpRouteRegistration,
  type ProtectedNonMcpRouteKey,
} from "./public-route-contract.js";
import { PngRenderer } from "./render.js";
import { SqliteRenderJobStore } from "./render-job-store.js";
import { RedesignStudioService } from "./redesign-studio-service.js";
import { RestoreOperationStore } from "./restore-operation-store.js";
import { RestoreWorkerLockStore } from "./restore-worker-lock.js";
import {
  isPublicSessionAuthenticationWritePath,
  registerSessionAuthenticationRoutes,
  SessionAuthenticationService,
} from "./session-auth.js";
import { DesignerService } from "./service.js";
import { WorkspaceHandoffService } from "./workspace-handoff-service.js";
import {
  INTERNAL_PROXY_SECRET_HEADER,
  internalProxySecretMatches,
} from "./trusted-proxy.js";

function isMinimalHealthRequest(url: string): boolean {
  const pathOnly = url.split("?", 1)[0];
  return pathOnly === "/health"
    || pathOnly === "/ready"
    || pathOnly === "/health/live"
    || pathOnly === "/health/ready"
    || pathOnly === "/health/render";
}

function isSessionPairingNonceWrite(method: string, url: string, authMode: ServerConfig["authMode"]): boolean {
  return authMode === "session"
    && method === "POST"
    && (url.split("?", 1)[0] ?? url) === "/api/agent-connections/pair";
}

export interface DesignerApplication {
  app: FastifyInstance;
  config: ServerConfig;
  database: DesignerDatabase;
  service: DesignerService;
  enterprise: EnterpriseService;
  designSystems: DesignSystemService;
  componentInsertions: ComponentInsertionService;
  handoffs: WorkspaceHandoffService;
  redesign: RedesignStudioService;
  events: EventHub;
  renderer: PngRenderer;
  renderJobs: SqliteRenderJobStore;
  backups: BackupManager;
  operations: OperationsService;
  policies: OrganizationPolicyService;
  maintenance: MaintenanceStore;
  sessions: SessionAuthenticationService;
  registeredProtectedNonMcpRoutes: ReadonlySet<ProtectedNonMcpRouteKey>;
}

export async function buildApplication(config = loadConfig()): Promise<DesignerApplication> {
  const maintenance = new MaintenanceStore(config.backupDir, config.dataDir);
  const [startupMaintenance, startupWorkerLock, startupOperation, startupJournal] = await Promise.all([
    maintenance.read(),
    new RestoreWorkerLockStore(config.backupDir).read(),
    new RestoreOperationStore(config.backupDir).read(),
    inspectRestoreJournal(config.dataDir),
  ]);
  if (startupWorkerLock.active) {
    throw new DomainError(
      "TEMPORARILY_UNAVAILABLE",
      "FormaSpec will not open its database while a restore worker owns the shared volume lock.",
      503,
      {
        retryable: true,
        details: {
          maintenance: true,
          restoreWorkerLocked: true,
          lockValid: startupWorkerLock.lockValid,
          ...(startupWorkerLock.lockValid ? { operationId: startupWorkerLock.operationId } : {}),
        },
      },
    );
  }
  const terminalWithoutMaintenance = !startupMaintenance.active
    && (startupOperation === null
      || startupOperation.phase === "reconciled"
      || startupOperation.phase === "rolled_back")
    && !startupJournal.present;
  const verifiedRestore = startupMaintenance.active
    && startupMaintenance.markerValid
    && startupMaintenance.phase === "verification"
    && startupOperation?.operationId === startupMaintenance.operationId
    && startupOperation.phase === "reconciled"
    && !startupJournal.present;
  const verifiedRollback = startupMaintenance.active
    && startupMaintenance.markerValid
    && (startupMaintenance.phase === "rollback" || startupMaintenance.phase === "verification")
    && startupOperation?.operationId === startupMaintenance.operationId
    && startupOperation.phase === "rolled_back"
    && (!startupJournal.present || startupJournal.phase === "rolled-back");
  if (!terminalWithoutMaintenance && !verifiedRestore && !verifiedRollback) {
    throw new DomainError(
      "TEMPORARILY_UNAVAILABLE",
      "FormaSpec will not open its database without matching terminal restore evidence.",
      503,
      {
        retryable: true,
        details: {
          maintenance: startupMaintenance.active,
          phase: startupMaintenance.active ? startupMaintenance.phase : null,
          operationPhase: startupOperation?.phase ?? null,
          journalPhase: startupJournal.present ? startupJournal.phase : null,
        },
      },
    );
  }
  const app = Fastify({
    logger: config.logLevel === "silent" ? false : { level: config.logLevel },
    bodyLimit: Math.max(config.maxAssetBytes + 1024 * 1024, 2 * 1024 * 1024),
    trustProxy: config.appMode === "server" ? config.trustedProxies : false,
  });
  const registeredProtectedNonMcpRoutes = new Set<ProtectedNonMcpRouteKey>();
  app.addHook("onRoute", (routeOptions) => {
    collectProtectedNonMcpRouteRegistration(
      registeredProtectedNonMcpRoutes,
      routeOptions.method,
      routeOptions.url,
    );
  });
  const assetStore = new ContentAddressedRasterStore(config.dataDir);
  const database = new DesignerDatabase(config.databasePath);
  let sessions: SessionAuthenticationService;
  try {
    sessions = new SessionAuthenticationService(database, {
      ...(config.bootstrapTokenHash ? { bootstrapTokenHash: config.bootstrapTokenHash } : {}),
      requireBootstrapCredential: config.appMode === "server" && config.authMode === "session",
    });
  } catch (error) {
    database.close();
    throw error;
  }
  const events = new EventHub();
  const renderJobs = new SqliteRenderJobStore(database.sqlite);
  renderJobs.recoverExpired();
  renderJobs.cleanupRetention();
  const renderer = new PngRenderer({
    timeoutMs: config.renderTimeoutMs,
    maxPixels: config.renderMaxPixels,
    concurrency: config.renderConcurrency,
    queueLimit: config.renderQueueLimit,
    allowSoftwareFallback: config.allowSoftwareRenderer,
    allowSystemChrome: config.allowSystemChrome,
    ...(config.renderSocket ? { socketPath: config.renderSocket } : {}),
    ipcMaxMessageBytes: config.renderIpcMaxBytes,
    jobRecorder: renderJobs,
  });
  const service = new DesignerService(database, events, config.previewTtlSeconds, {}, assetStore);
  const enterprise = new EnterpriseService(database, events, {
    productSpecPreviewTtlSeconds: config.previewTtlSeconds,
    designerService: service,
  });
  const designSystems = new DesignSystemService(database, {
    upgradePreviewTtlSeconds: config.previewTtlSeconds,
    designerService: service,
  });
  const componentInsertions = new ComponentInsertionService(database, service);
  const handoffs = new WorkspaceHandoffService(database);
  const redesign = new RedesignStudioService(database);
  const backups = new BackupManager(database, config.dataDir, config.backupDir, {
    engine: renderer,
    limits: {
      maxBytes: config.maxAssetBytes,
      maxPixels: config.maxAssetPixels,
    },
  });
  const operations = new OperationsService(service, enterprise, renderer, backups, config.backupDir);
  const policies = new OrganizationPolicyService(database);

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

  app.addHook("onRequest", async (request) => {
    if (config.appMode === "local") {
      if (config.containerLocalMode) {
        const host = request.headers.host?.trim().toLowerCase();
        if (!host || !config.allowedHosts.includes(host)) {
          throw new DomainError("FORBIDDEN", "Container-local mode accepts only the configured loopback Host.", 403);
        }
        const forwarded = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"]
          .some((header) => request.headers[header] !== undefined);
        if (forwarded || request.headers[config.trustedUserHeader] !== undefined) {
          throw new DomainError("FORBIDDEN", "Container-local mode rejects proxy and caller identity headers.", 403);
        }
        if (config.authMode === "session"
          && request.url.startsWith("/api/")
          && ["POST", "PUT", "PATCH", "DELETE"].includes(request.method)
          && !isSessionPairingNonceWrite(request.method, request.url, config.authMode)) {
          const origin = request.headers.origin;
          if (!origin || !config.corsOrigins.includes(origin)) {
            throw new DomainError("FORBIDDEN", "A trusted Origin is required for browser writes.", 403);
          }
          if (isPublicSessionAuthenticationWritePath(request.url)
            && request.headers[config.csrfHeader] !== "1") {
            throw new DomainError("FORBIDDEN", `Missing CSRF intent header ${config.csrfHeader}.`, 403);
          }
        }
        return;
      }
      const address = request.ip.replace(/^::ffff:/, "");
      if (address !== "127.0.0.1" && address !== "::1") {
        throw new DomainError("FORBIDDEN", "Local mode accepts loopback requests only.", 403);
      }
      if (config.authMode === "session"
        && request.url.startsWith("/api/")
        && ["POST", "PUT", "PATCH", "DELETE"].includes(request.method)
        && !isSessionPairingNonceWrite(request.method, request.url, config.authMode)) {
        const origin = request.headers.origin;
        if (!origin || !config.corsOrigins.includes(origin)) {
          throw new DomainError("FORBIDDEN", "A trusted Origin is required for browser writes.", 403);
        }
        if (isPublicSessionAuthenticationWritePath(request.url)
          && request.headers[config.csrfHeader] !== "1") {
          throw new DomainError("FORBIDDEN", `Missing CSRF intent header ${config.csrfHeader}.`, 403);
        }
      }
      return;
    }

    const rawPeerAddress = request.raw.socket.remoteAddress;
    if (!config.isTrustedProxyAddress(rawPeerAddress)) {
      throw new DomainError(
        "FORBIDDEN",
        "Server mode accepts requests only from a configured trusted raw socket peer or reverse proxy.",
        403,
      );
    }

    if (!isMinimalHealthRequest(request.url)
      && (!config.proxySecret
        || !internalProxySecretMatches(config.proxySecret, request.headers[INTERNAL_PROXY_SECRET_HEADER]))) {
      throw new DomainError(
        "FORBIDDEN",
        "Server request did not originate through the authorized internal reverse-proxy hop.",
        403,
      );
    }

    const host = request.headers.host?.trim().toLowerCase();
    if (!host || !config.allowedHosts.includes(host)) {
      throw new DomainError("FORBIDDEN", "Host is not allowed.", 403);
    }
    if (request.url.startsWith("/api/") && ["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
      if (isSessionPairingNonceWrite(request.method, request.url, config.authMode)) return;
      const origin = request.headers.origin;
      if (!origin || !config.corsOrigins.includes(origin)) {
        throw new DomainError("FORBIDDEN", "A trusted Origin is required for browser writes.", 403);
      }
      const publicSessionAuthenticationWrite = config.authMode === "session"
        && isPublicSessionAuthenticationWritePath(request.url);
      if (publicSessionAuthenticationWrite && request.headers[config.csrfHeader] !== "1") {
        throw new DomainError("FORBIDDEN", `Missing CSRF intent header ${config.csrfHeader}.`, 403);
      }
      if (config.authMode !== "session" && request.headers[config.csrfHeader] !== "1") {
        throw new DomainError("FORBIDDEN", `Missing CSRF intent header ${config.csrfHeader}.`, 403);
      }
    }
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");
    reply.header(
      "content-security-policy",
      "default-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    if (config.appMode === "server") reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
    try {
      flushPersistedEventOutbox(database.sqlite, events);
    } catch {
      // The durable outbox remains replayable and can be flushed by a later request.
    }
    return payload;
  });

  registerMaintenanceGuard(app, maintenance);

  await app.register(cors, {
    origin(origin, callback) {
      if (!origin || config.corsOrigins.includes(origin)) callback(null, true);
      else callback(new DomainError("FORBIDDEN", "Origin is not allowed.", 403), false);
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["authorization", "content-type", "idempotency-key", config.trustedUserHeader, config.csrfHeader],
  });
  await app.register(multipart, {
    limits: { fileSize: config.maxAssetBytes, files: 1, fields: 8 },
  });

  registerAuthentication(app, config, database, sessions);
  registerSessionAuthenticationRoutes(app, config, database, sessions);
  registerMaintenanceStatusRoute(app, maintenance);
  registerHttpRoutes(app, { config, service, enterprise, events, renderer, backups, maintenance, operations });
  registerEnterpriseHttpRoutes(app, enterprise);
  registerEnterpriseDomainHttpRoutes(app, {
    designSystems,
    componentInsertions,
    designer: service,
    renderer,
    handoffs,
    redesign,
  });
  registerOperationsHttpRoutes(app, operations);
  registerOrganizationPolicyHttpRoutes(app, policies);
  registerMcpEndpoint(app, {
    config,
    service,
    enterprise,
    designSystems,
    componentInsertions,
    handoffs,
    redesign,
    renderer,
    policies,
  });

  const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  if (fs.existsSync(path.join(webDist, "index.html"))) {
    await app.register(staticFiles, {
      root: webDist,
      prefix: "/",
      wildcard: false,
    });
    app.setNotFoundHandler((request, reply) => {
      const protectedPrefix = ["/api", "/events", "/mcp", "/health", "/ready"].some((prefix) =>
        request.url === prefix || request.url.startsWith(`${prefix}/`) || request.url.startsWith(`${prefix}?`));
      const acceptsHtml = request.method === "GET" && (request.headers.accept?.includes("text/html") ?? false);
      if (!protectedPrefix && acceptsHtml) return reply.sendFile("index.html");
      return reply.code(404).send({
        error: { code: "NOT_FOUND", message: "Route not found.", retryable: false },
      });
    });
  }

  let renderJobLeaseTicks = 0;
  const renderJobLeaseTimer = setInterval(() => {
    try {
      renderJobs.heartbeat();
      renderJobs.recoverExpired();
      renderJobLeaseTicks += 1;
      if (renderJobLeaseTicks % 6 === 0) renderJobs.cleanupRetention();
    } catch (error) {
      app.log.error({ error }, "Render-job lease maintenance failed.");
    }
  }, 10_000);
  renderJobLeaseTimer.unref?.();

  app.addHook("onClose", async () => {
    clearInterval(renderJobLeaseTimer);
    await renderer.close();
    database.close();
  });

  return {
    app,
    config,
    database,
    service,
    enterprise,
    designSystems,
    componentInsertions,
    handoffs,
    redesign,
    events,
    renderer,
    renderJobs,
    backups,
    operations,
    policies,
    maintenance,
    sessions,
    registeredProtectedNonMcpRoutes,
  };
}
