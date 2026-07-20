import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { PngRenderer } from "./render.js";
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
import {
  defaultRendererEndpoint,
  validateRendererEndpoint,
} from "./renderer-endpoint.js";
import { RendererSocketClient, startRendererWorker } from "./renderer-ipc.js";

const booleanValue = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((value) => value === "true" || value === "1");

const workerEnvironmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
  FORMASPEC_RENDER_SOCKET: z.string().min(1).max(256).optional(),
  FORMASPEC_RENDER_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(15_000),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().max(MAX_RASTER_NORMALIZATION_BYTES)
    .default(DEFAULT_MAX_ASSET_BYTES),
  DESIGNER_MAX_ASSET_BYTES: z.coerce.number().int().positive().max(MAX_RASTER_NORMALIZATION_BYTES).optional(),
  DESIGNER_MAX_ASSET_PIXELS: z.coerce.number().int().positive().max(MAX_RASTER_NORMALIZATION_PIXELS).optional(),
  FORMASPEC_RENDER_MAX_PIXELS: z.coerce.number().int().positive().max(MAX_RASTER_NORMALIZATION_PIXELS)
    .default(DEFAULT_RENDER_MAX_PIXELS),
  FORMASPEC_RENDER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  FORMASPEC_RENDER_QUEUE_LIMIT: z.coerce.number().int().min(1).max(64).default(32),
  FORMASPEC_RENDER_IPC_MAX_BYTES: z.coerce.number().int().min(MIN_RENDER_IPC_MAX_BYTES)
    .max(MAX_RENDER_IPC_MAX_BYTES)
    .default(DEFAULT_RENDER_IPC_MAX_BYTES),
  FORMASPEC_ALLOW_SYSTEM_CHROME: booleanValue,
}).passthrough();

export interface RendererWorkerConfig {
  nodeEnvironment: "development" | "test" | "production";
  socketPath: string;
  timeoutMs: number;
  maxAssetBytes: number;
  maxAssetPixels: number;
  maxPixels: number;
  concurrency: number;
  queueLimit: number;
  ipcMaxMessageBytes: number;
  allowSystemChrome: boolean;
}

const RENDERER_MOUNTINFO_MAX_BYTES = 1024 * 1024;
const FORBIDDEN_RENDERER_MOUNT_ROOTS = ["/data", "/backups"] as const;

function decodeMountInfoPath(value: string): string {
  return value.replace(/\\(040|011|012|134)/g, (_match, code: string) => {
    switch (code) {
      case "040": return " ";
      case "011": return "\t";
      case "012": return "\n";
      case "134": return "\\";
      default: return _match;
    }
  });
}

export function validateRendererMountInfo(
  mountInfo: string,
  forbiddenRoots: readonly string[] = FORBIDDEN_RENDERER_MOUNT_ROOTS,
): void {
  const normalizedRoots = forbiddenRoots.map((root) => path.posix.resolve(root));
  const violations = new Set<string>();
  for (const line of mountInfo.split("\n")) {
    if (!line) continue;
    const fields = line.split(" ");
    if (fields.length < 6 || !fields.includes("-")) {
      throw new Error("Renderer mount information is malformed; filesystem isolation cannot be verified.");
    }
    const mountPoint = path.posix.resolve(decodeMountInfoPath(fields[4]!));
    for (const root of normalizedRoots) {
      if (mountPoint === root || mountPoint.startsWith(`${root}/`)) violations.add(root);
    }
  }
  if (violations.size > 0) {
    throw new Error("Renderer filesystem isolation failed: production data or backup storage is mounted into the worker.");
  }
}

async function readBoundedMountInfo(filename: string): Promise<string> {
  const handle = await fs.promises.open(
    filename,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const buffer = Buffer.alloc(RENDERER_MOUNTINFO_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > RENDERER_MOUNTINFO_MAX_BYTES) {
      throw new Error("Renderer mount information exceeds its fixed safety limit.");
    }
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

export async function assertRendererFilesystemIsolation(
  platform: NodeJS.Platform = process.platform,
  mountInfoPath = "/proc/self/mountinfo",
): Promise<void> {
  if (platform !== "linux") return;
  let mountInfo: string;
  try {
    mountInfo = await readBoundedMountInfo(mountInfoPath);
  } catch (error) {
    throw new Error(
      "Renderer filesystem isolation could not be verified from the Linux mount table.",
      { cause: error },
    );
  }
  validateRendererMountInfo(mountInfo);
}

export function loadRendererWorkerConfig(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): RendererWorkerConfig {
  const parsed = workerEnvironmentSchema.parse(environment);
  const maxAssetBytes = parsed.DESIGNER_MAX_ASSET_BYTES ?? parsed.MAX_UPLOAD_BYTES;
  const maxAssetPixels = parsed.DESIGNER_MAX_ASSET_PIXELS ?? parsed.FORMASPEC_RENDER_MAX_PIXELS;
  const socketPath = validateRendererEndpoint(
    parsed.FORMASPEC_RENDER_SOCKET ?? defaultRendererEndpoint(platform),
    platform,
  );
  if (parsed.NODE_ENV === "production" && parsed.FORMASPEC_ALLOW_SYSTEM_CHROME) {
    throw new Error("Production renderer workers require pinned Playwright Chromium; system Chrome is not allowed.");
  }
  validateRendererLimitParity({
    maxAssetBytes,
    maxAssetPixels,
    renderMaxPixels: parsed.FORMASPEC_RENDER_MAX_PIXELS,
    renderIpcMaxBytes: parsed.FORMASPEC_RENDER_IPC_MAX_BYTES,
  });
  return {
    nodeEnvironment: parsed.NODE_ENV,
    socketPath,
    timeoutMs: parsed.FORMASPEC_RENDER_TIMEOUT_MS,
    maxAssetBytes,
    maxAssetPixels,
    maxPixels: parsed.FORMASPEC_RENDER_MAX_PIXELS,
    concurrency: parsed.FORMASPEC_RENDER_CONCURRENCY,
    queueLimit: parsed.FORMASPEC_RENDER_QUEUE_LIMIT,
    ipcMaxMessageBytes: parsed.FORMASPEC_RENDER_IPC_MAX_BYTES,
    allowSystemChrome: parsed.FORMASPEC_ALLOW_SYSTEM_CHROME,
  };
}

async function main(): Promise<void> {
  const config = loadRendererWorkerConfig();
  await assertRendererFilesystemIsolation();
  if (process.argv.includes("--health")) {
    const health = await new RendererSocketClient({
      socketPath: config.socketPath,
      timeoutMs: Math.min(config.timeoutMs, 5_000),
      maxMessageBytes: config.ipcMaxMessageBytes,
    }).health();
    process.stdout.write(`${JSON.stringify(health)}\n`);
    return;
  }

  if (config.nodeEnvironment === "production" && process.getuid?.() === 0) {
    throw new Error("The production renderer worker refuses to run as root.");
  }

  const renderer = new PngRenderer({
    timeoutMs: config.timeoutMs,
    maxPixels: config.maxPixels,
    concurrency: config.concurrency,
    queueLimit: config.queueLimit,
    allowSoftwareFallback: false,
    allowSystemChrome: config.allowSystemChrome,
  });
  const worker = await startRendererWorker({
    socketPath: config.socketPath,
    renderer,
    timeoutMs: config.timeoutMs,
    maxMessageBytes: config.ipcMaxMessageBytes,
    maxConnections: Math.min(config.concurrency + config.queueLimit, 16),
    normalizationLimits: {
      maxBytes: config.maxAssetBytes,
      maxPixels: config.maxAssetPixels,
    },
  });
  process.stdout.write(`FormaSpec renderer worker ready on ${worker.socketPath}\n`);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void worker.close().finally(() => process.exit(0));
    });
  }
}

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entrypoint === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`FormaSpec renderer worker failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
