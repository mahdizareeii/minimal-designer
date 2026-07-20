import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { DomainError } from "./errors.js";

const MAX_MARKER_BYTES = 4 * 1024;
const CONTROL_DIRECTORY = ".formaspec";
const MARKER_FILENAME = "maintenance.json";

export const maintenancePhases = [
  "preparing",
  "backup",
  "migration",
  "restore",
  "verification",
  "rollback",
] as const;

const maintenanceMarkerSchema = z.object({
  schemaVersion: z.literal(1),
  active: z.literal(true),
  phase: z.enum(maintenancePhases),
  operationId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  startedAt: z.string().max(40).datetime({ offset: true }),
}).strict();

export type MaintenancePhase = typeof maintenancePhases[number];
export type MaintenanceMarker = z.infer<typeof maintenanceMarkerSchema>;

export type MaintenanceStatus =
  | { active: false; markerValid: true }
  | {
    active: true;
    markerValid: true;
    phase: MaintenancePhase;
    operationId: string;
    startedAt: string;
  }
  | { active: true; markerValid: false; phase: "unknown" };

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await fs.promises.open(directory, "r");
  try {
    await handle.sync().catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EINVAL" && error.code !== "ENOTSUP") throw error;
    });
  } finally {
    await handle.close();
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/**
 * A fixed-location, path-free maintenance marker store.
 *
 * Inactive state is represented only by an absent marker. Any present marker
 * that cannot be read or validated is treated as active so recovery fails
 * closed. Marker age is deliberately ignored; only an explicit removal ends
 * maintenance mode.
 */
export class MaintenanceStore {
  readonly #controlDirectory: string;
  readonly #markerPath: string;

  constructor(backupDirectory: string, dataDirectory: string) {
    const resolvedBackupDirectory = path.resolve(backupDirectory);
    const resolvedDataDirectory = path.resolve(dataDirectory);
    this.#controlDirectory = path.join(resolvedBackupDirectory, CONTROL_DIRECTORY);
    this.#markerPath = path.join(this.#controlDirectory, MARKER_FILENAME);
    if (isWithin(resolvedDataDirectory, this.#controlDirectory)) {
      throw new Error("FormaSpec maintenance state must be stored outside DATA_DIR.");
    }
  }

  async read(): Promise<MaintenanceStatus> {
    let handle: fs.promises.FileHandle | undefined;
    try {
      const entry = await fs.promises.lstat(this.#markerPath);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_MARKER_BYTES) {
        return { active: true, markerValid: false, phase: "unknown" };
      }
      handle = await fs.promises.open(
        this.#markerPath,
        process.platform === "win32"
          ? fs.constants.O_RDONLY
          : fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
      );
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_MARKER_BYTES) {
        return { active: true, markerValid: false, phase: "unknown" };
      }
      const buffer = Buffer.alloc(MAX_MARKER_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_MARKER_BYTES) {
        return { active: true, markerValid: false, phase: "unknown" };
      }
      const parsed = maintenanceMarkerSchema.safeParse(JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")));
      if (!parsed.success) return { active: true, markerValid: false, phase: "unknown" };
      return {
        active: true,
        markerValid: true,
        phase: parsed.data.phase,
        operationId: parsed.data.operationId,
        startedAt: parsed.data.startedAt,
      };
    } catch (error) {
      if (isMissingFile(error)) return { active: false, markerValid: true };
      return { active: true, markerValid: false, phase: "unknown" };
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async write(marker: MaintenanceMarker): Promise<void> {
    const validated = maintenanceMarkerSchema.parse(marker);
    await fs.promises.mkdir(this.#controlDirectory, { recursive: true, mode: 0o700 });
    const temporaryPath = path.join(this.#controlDirectory, `.${MARKER_FILENAME}.${randomUUID()}.tmp`);
    let handle: fs.promises.FileHandle | undefined;
    try {
      handle = await fs.promises.open(temporaryPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(validated)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.promises.rename(temporaryPath, this.#markerPath);
      await syncDirectory(this.#controlDirectory);
    } finally {
      await handle?.close().catch(() => undefined);
      await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  async clear(): Promise<void> {
    await fs.promises.rm(this.#markerPath, { force: true });
    await syncDirectory(this.#controlDirectory);
  }
}

function requestPath(url: string): string {
  return url.split("?", 1)[0] ?? url;
}

function isProtectedDomainPath(pathname: string): boolean {
  return pathname === "/api"
    || pathname.startsWith("/api/")
    || pathname === "/mcp"
    || pathname.startsWith("/mcp/")
    || pathname === "/events"
    || pathname.startsWith("/events/");
}

function publicStatus(status: MaintenanceStatus): Record<string, unknown> {
  if (!status.active) return { active: false };
  if (!status.markerValid) return { active: true, phase: "unknown", markerValid: false };
  return {
    active: true,
    phase: status.phase,
    operationId: status.operationId,
    startedAt: status.startedAt,
    markerValid: true,
  };
}

/** Register before authentication so an active restore never touches the DB. */
export function registerMaintenanceGuard(app: FastifyInstance, store: MaintenanceStore): void {
  app.addHook("onRequest", async (request, reply) => {
    const pathname = requestPath(request.url);
    // /health/ready performs its full database/renderer check in the route
    // before returning a maintenance 503. The lightweight /ready alias can
    // be rejected here without touching additional services.
    if (pathname === "/health/ready") return;
    if (pathname === "/ready") {
      const status = await store.read();
      if (status.active) {
        return reply.code(503).send({
          ok: false,
          status: "maintenance",
          maintenance: { active: true, phase: status.phase },
        });
      }
      return;
    }
    if (pathname === "/api/maintenance/status" || !isProtectedDomainPath(pathname)) return;

    const status = await store.read();
    if (!status.active) return;
    throw new DomainError(
      "TEMPORARILY_UNAVAILABLE",
      "FormaSpec is temporarily unavailable for maintenance.",
      503,
      {
        retryable: true,
        details: { maintenance: true, phase: status.phase },
      },
    );
  });
}

/** Register after authentication; this is intentionally the only API exception. */
export function registerMaintenanceStatusRoute(app: FastifyInstance, store: MaintenanceStore): void {
  app.get("/api/maintenance/status", async (_request, reply) => reply
    .header("cache-control", "no-store")
    .send(publicStatus(await store.read())));
}
