import path from "node:path";

import { z } from "zod";

const booleanValue = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((value) => value === "true" || value === "1");

const optionalToken = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().min(16).optional(),
);

const envSchema = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4310),
  DATA_DIR: z.string().default("data"),
  PUBLIC_BASE_URL: z.string().url().optional(),
  AUTH_MODE: z.enum(["none", "token", "trusted-header"]).default("none"),
  DESIGNER_TOKEN: optionalToken,
  TRUSTED_USER_HEADER: z.string().regex(/^[A-Za-z0-9-]+$/).default("x-designer-user"),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024),
  DESIGNER_DATABASE_PATH: z.string().optional(),
  DESIGNER_AUTH_TOKEN: optionalToken,
  DESIGNER_AUTH_REQUIRED: booleanValue,
  DESIGNER_CORS_ORIGINS: z.string().default(
    "http://localhost:4310,http://127.0.0.1:4310,http://localhost:4311,http://127.0.0.1:4311,http://localhost:5173,http://127.0.0.1:5173",
  ),
  DESIGNER_MAX_ASSET_BYTES: z.coerce.number().int().positive().optional(),
  DESIGNER_MAX_ASSET_PIXELS: z.coerce.number().int().positive().default(40_000_000),
  DESIGNER_PREVIEW_TTL_SECONDS: z.coerce.number().int().min(30).max(86_400).default(900),
  DESIGNER_LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export interface ServerConfig {
  host: string;
  port: number;
  dataDir: string;
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
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): ServerConfig {
  const parsed = envSchema.parse(environment);
  const dataDir = path.resolve(parsed.DATA_DIR);
  const configuredDatabasePath = parsed.DESIGNER_DATABASE_PATH ?? path.join(dataDir, "designer.sqlite");
  const databasePath = configuredDatabasePath === ":memory:"
    ? ":memory:"
    : path.resolve(configuredDatabasePath);
  const authToken = parsed.DESIGNER_TOKEN ?? parsed.DESIGNER_AUTH_TOKEN;
  const authMode = parsed.DESIGNER_AUTH_REQUIRED && parsed.AUTH_MODE === "none" ? "token" : parsed.AUTH_MODE;
  const publicBaseUrl = parsed.PUBLIC_BASE_URL ?? `http://${parsed.HOST}:${parsed.PORT}`;
  const corsOrigins = new Set(parsed.DESIGNER_CORS_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean));
  corsOrigins.add(new URL(publicBaseUrl).origin);

  if ((authMode === "token" || authMode === "trusted-header") && !authToken) {
    throw new Error("DESIGNER_TOKEN is required when AUTH_MODE is token or trusted-header");
  }

  return {
    host: parsed.HOST,
    port: parsed.PORT,
    dataDir,
    databasePath,
    publicBaseUrl,
    authMode,
    ...(authToken ? { authToken } : {}),
    trustedUserHeader: parsed.TRUSTED_USER_HEADER.toLowerCase(),
    corsOrigins: [...corsOrigins],
    maxAssetBytes: parsed.DESIGNER_MAX_ASSET_BYTES ?? parsed.MAX_UPLOAD_BYTES,
    maxAssetPixels: parsed.DESIGNER_MAX_ASSET_PIXELS,
    previewTtlSeconds: parsed.DESIGNER_PREVIEW_TTL_SECONDS,
    logLevel: parsed.DESIGNER_LOG_LEVEL,
  };
}
