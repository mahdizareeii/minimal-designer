import path from "node:path";

import { z } from "zod";

import {
  DEFAULT_MAX_ASSET_BYTES,
  DEFAULT_RENDER_IPC_MAX_BYTES,
  DEFAULT_RENDER_MAX_PIXELS,
  MAX_RASTER_NORMALIZATION_BYTES,
  MAX_RASTER_NORMALIZATION_PIXELS,
  MAX_RENDER_IPC_MAX_BYTES,
  MIN_RENDER_IPC_MAX_BYTES,
  validateRendererLimitParity,
} from "./renderer-contract.js";
import { validateRendererEndpoint } from "./renderer-endpoint.js";

const booleanValue = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((value) => value === "true" || value === "1");

const optionalToken = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().min(16).optional(),
);

const optionalNonEmptyString = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().min(1).optional(),
);

const envSchema = z.object({
  APP_MODE: z.enum(["local", "server"]).default("local"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4310),
  DATA_DIR: z.string().default("data"),
  BACKUP_DIR: z.string().optional(),
  PUBLIC_BASE_URL: z.string().url().optional(),
  AUTH_MODE: z.enum(["none", "token", "trusted-header"]).default("none"),
  DESIGNER_TOKEN: optionalToken,
  TRUSTED_USER_HEADER: z.string().regex(/^[A-Za-z0-9-]+$/).default("x-designer-user"),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().max(MAX_RASTER_NORMALIZATION_BYTES)
    .default(DEFAULT_MAX_ASSET_BYTES),
  DESIGNER_DATABASE_PATH: z.string().optional(),
  DESIGNER_AUTH_TOKEN: optionalToken,
  DESIGNER_AUTH_REQUIRED: booleanValue,
  DESIGNER_CORS_ORIGINS: z.string().default(
    "http://localhost:4310,http://127.0.0.1:4310,http://localhost:4311,http://127.0.0.1:4311,http://localhost:5173,http://127.0.0.1:5173",
  ),
  DESIGNER_MAX_ASSET_BYTES: z.coerce.number().int().positive().max(MAX_RASTER_NORMALIZATION_BYTES).optional(),
  DESIGNER_MAX_ASSET_PIXELS: z.coerce.number().int().positive().max(MAX_RASTER_NORMALIZATION_PIXELS).optional(),
  DESIGNER_PREVIEW_TTL_SECONDS: z.coerce.number().int().min(30).max(86_400).default(900),
  DESIGNER_LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  FORMASPEC_ALLOWED_HOSTS: z.string().optional(),
  FORMASPEC_TRUSTED_PROXIES: z.string().optional(),
  FORMASPEC_CSRF_HEADER: z.string().regex(/^[A-Za-z0-9-]+$/).default("x-formaspec-csrf"),
  FORMASPEC_RENDER_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(15_000),
  FORMASPEC_RENDER_MAX_PIXELS: z.coerce.number().int().positive().max(MAX_RASTER_NORMALIZATION_PIXELS)
    .default(DEFAULT_RENDER_MAX_PIXELS),
  FORMASPEC_RENDER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  FORMASPEC_RENDER_QUEUE_LIMIT: z.coerce.number().int().min(1).max(1_000).default(32),
  FORMASPEC_RENDER_SOCKET: optionalNonEmptyString,
  FORMASPEC_RENDER_IPC_MAX_BYTES: z.coerce.number().int().min(MIN_RENDER_IPC_MAX_BYTES)
    .max(MAX_RENDER_IPC_MAX_BYTES)
    .default(DEFAULT_RENDER_IPC_MAX_BYTES),
  FORMASPEC_ALLOW_SOFTWARE_RENDERER: booleanValue,
  FORMASPEC_ALLOW_SYSTEM_CHROME: booleanValue,
  FORMASPEC_CONTAINER_LOCAL: booleanValue,
});

export interface ServerConfig {
  appMode: "local" | "server";
  host: string;
  port: number;
  dataDir: string;
  backupDir: string;
  databasePath: string;
  publicBaseUrl: string;
  authMode: "none" | "token" | "trusted-header";
  authToken?: string;
  trustedUserHeader: string;
  corsOrigins: string[];
  maxAssetBytes: number;
  maxAssetPixels: number;
  previewTtlSeconds: number;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  allowedHosts: string[];
  trustedProxies: string[];
  csrfHeader: string;
  renderTimeoutMs: number;
  renderMaxPixels: number;
  renderConcurrency: number;
  renderQueueLimit: number;
  renderSocket?: string;
  renderIpcMaxBytes: number;
  allowSoftwareRenderer: boolean;
  allowSystemChrome: boolean;
  containerLocalMode: boolean;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ServerConfig {
  const parsed = envSchema.parse(environment);
  const dataDir = path.resolve(parsed.DATA_DIR);
  const backupDir = path.resolve(parsed.BACKUP_DIR ?? path.join(dataDir, "..", "backups"));
  const configuredDatabasePath = parsed.DESIGNER_DATABASE_PATH ?? path.join(dataDir, "designer.sqlite");
  const databasePath = configuredDatabasePath === ":memory:"
    ? ":memory:"
    : path.resolve(configuredDatabasePath);
  const authToken = parsed.DESIGNER_TOKEN ?? parsed.DESIGNER_AUTH_TOKEN;
  const authMode = parsed.DESIGNER_AUTH_REQUIRED && parsed.AUTH_MODE === "none" ? "token" : parsed.AUTH_MODE;
  const publicBaseUrl = parsed.PUBLIC_BASE_URL ?? `http://${parsed.HOST}:${parsed.PORT}`;
  const publicUrl = new URL(publicBaseUrl);
  const maxAssetBytes = parsed.DESIGNER_MAX_ASSET_BYTES ?? parsed.MAX_UPLOAD_BYTES;
  const maxAssetPixels = parsed.DESIGNER_MAX_ASSET_PIXELS ?? parsed.FORMASPEC_RENDER_MAX_PIXELS;
  const corsOrigins = new Set(parsed.DESIGNER_CORS_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean));
  corsOrigins.add(new URL(publicBaseUrl).origin);

  validateRendererLimitParity({
    maxAssetBytes,
    maxAssetPixels,
    renderMaxPixels: parsed.FORMASPEC_RENDER_MAX_PIXELS,
    renderIpcMaxBytes: parsed.FORMASPEC_RENDER_IPC_MAX_BYTES,
  });

  if ((authMode === "token" || authMode === "trusted-header") && !authToken) {
    throw new Error("DESIGNER_TOKEN is required when AUTH_MODE is token or trusted-header");
  }

  if (parsed.APP_MODE === "local") {
    const containerHost = parsed.FORMASPEC_CONTAINER_LOCAL
      && ["0.0.0.0", "::"].includes(parsed.HOST.trim().toLowerCase().replace(/^\[|\]$/g, ""));
    if ((!isLoopbackHost(parsed.HOST) && !containerHost) || !isLoopbackHost(publicUrl.hostname)) {
      throw new Error("APP_MODE=local requires HOST and PUBLIC_BASE_URL to use loopback only");
    }
    if (parsed.FORMASPEC_CONTAINER_LOCAL && !containerHost) {
      throw new Error("FORMASPEC_CONTAINER_LOCAL requires APP_MODE=local and HOST=0.0.0.0 or ::");
    }
  } else {
    if (parsed.FORMASPEC_CONTAINER_LOCAL) throw new Error("FORMASPEC_CONTAINER_LOCAL cannot be enabled in server mode");
    if (publicUrl.protocol !== "https:") throw new Error("APP_MODE=server requires an HTTPS PUBLIC_BASE_URL");
    if (authMode !== "trusted-header") {
      throw new Error("APP_MODE=server requires AUTH_MODE=trusted-header for browser identity and scoped MCP authentication");
    }
  }

  const allowedHosts = new Set(
    (parsed.FORMASPEC_ALLOWED_HOSTS ?? publicUrl.host)
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  );
  allowedHosts.add(publicUrl.host.toLowerCase());
  const trustedProxies = (parsed.FORMASPEC_TRUSTED_PROXIES ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (parsed.APP_MODE === "server" && trustedProxies.length === 0) {
    throw new Error("APP_MODE=server requires FORMASPEC_TRUSTED_PROXIES");
  }
  if (parsed.FORMASPEC_RENDER_SOCKET) validateRendererEndpoint(parsed.FORMASPEC_RENDER_SOCKET, platform);
  if ((parsed.APP_MODE === "server" || parsed.FORMASPEC_RENDER_SOCKET) && parsed.FORMASPEC_ALLOW_SOFTWARE_RENDERER) {
    throw new Error("Software rendering is development-only and cannot be enabled in server or renderer-worker mode");
  }

  return {
    appMode: parsed.APP_MODE,
    host: parsed.HOST,
    port: parsed.PORT,
    dataDir,
    backupDir,
    databasePath,
    publicBaseUrl,
    authMode,
    ...(authToken ? { authToken } : {}),
    trustedUserHeader: parsed.TRUSTED_USER_HEADER.toLowerCase(),
    corsOrigins: [...corsOrigins],
    maxAssetBytes,
    maxAssetPixels,
    previewTtlSeconds: parsed.DESIGNER_PREVIEW_TTL_SECONDS,
    logLevel: parsed.DESIGNER_LOG_LEVEL,
    allowedHosts: [...allowedHosts],
    trustedProxies,
    csrfHeader: parsed.FORMASPEC_CSRF_HEADER.toLowerCase(),
    renderTimeoutMs: parsed.FORMASPEC_RENDER_TIMEOUT_MS,
    renderMaxPixels: parsed.FORMASPEC_RENDER_MAX_PIXELS,
    renderConcurrency: parsed.FORMASPEC_RENDER_CONCURRENCY,
    renderQueueLimit: parsed.FORMASPEC_RENDER_QUEUE_LIMIT,
    ...(parsed.FORMASPEC_RENDER_SOCKET ? { renderSocket: parsed.FORMASPEC_RENDER_SOCKET } : {}),
    renderIpcMaxBytes: parsed.FORMASPEC_RENDER_IPC_MAX_BYTES,
    allowSoftwareRenderer: parsed.FORMASPEC_ALLOW_SOFTWARE_RENDERER,
    allowSystemChrome: parsed.FORMASPEC_ALLOW_SYSTEM_CHROME,
    containerLocalMode: parsed.FORMASPEC_CONTAINER_LOCAL,
  };
}
