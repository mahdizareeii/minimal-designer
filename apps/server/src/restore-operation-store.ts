import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import { DomainError } from "./errors.js";

const MAX_STATE_BYTES = 16 * 1024;
const CONTROL_DIRECTORY = ".formaspec";
const STATE_FILENAME = "restore-operation.json";
const ARCHIVE_DIRECTORY = "restore-history";

const backupIdSchema = z.string().regex(/^backup_[a-f0-9]{40}$/);
const operationIdSchema = z.string().min(16).max(120)
  .regex(/^restore_[A-Za-z0-9][A-Za-z0-9_-]+$/);
const timestampSchema = z.string().max(40).datetime({ offset: true });
const recordSchema = z.object({
  id: backupIdSchema,
  organizationId: z.string().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  filename: z.string().regex(/^formaspec-backup-[0-9TZ-]+\.tar$/),
  bundleSha256: z.string().regex(/^[a-f0-9]{64}$/),
  createdBy: z.string().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9@+._:-]*$/),
  createdAt: timestampSchema,
  sizeBytes: z.number().int().nonnegative(),
  retentionClass: z.enum(["manual", "daily", "weekly", "monthly"]),
}).strict();
const smokeSchema = z.object({
  schemaVersion: z.number().int().positive(),
  renderedDesignId: z.string().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/).nullable(),
}).strict();
const resultSchema = z.object({
  auditEventId: z.number().int().positive(),
  outboxEventId: z.number().int().positive(),
  revoked: z.object({
    grants: z.number().int().nonnegative(),
    connections: z.number().int().nonnegative(),
    nonces: z.number().int().nonnegative(),
    sessions: z.number().int().nonnegative().default(0),
  }).strict(),
}).strict();
const recoverySchema = z.object({
  mode: z.literal("offline"),
  safetyKind: z.literal("forensic"),
}).strict();
const common = z.object({
  format: z.literal("formaspec-restore-operation"),
  version: z.literal(1),
  operationId: operationIdSchema,
  backupId: backupIdSchema,
  target: recordSchema,
  safety: recordSchema.extend({ retentionClass: z.literal("manual") }),
  monotonicFloor: z.object({
    auditEventId: z.number().int().nonnegative(),
    outboxEventId: z.number().int().nonnegative(),
  }).strict(),
  recovery: recoverySchema.optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();

export const RestoreOperationStateSchema = z.discriminatedUnion("phase", [
  common.extend({
    phase: z.literal("prepared"),
    smoke: z.null(),
    result: z.null(),
    errorCode: z.null(),
  }).strict(),
  common.extend({
    phase: z.literal("cutover_committed"),
    smoke: smokeSchema,
    result: z.null(),
    errorCode: z.null(),
  }).strict(),
  common.extend({
    phase: z.literal("reconciled"),
    smoke: smokeSchema,
    result: resultSchema,
    errorCode: z.null(),
  }).strict(),
  common.extend({
    phase: z.literal("rolled_back"),
    smoke: z.null(),
    result: z.null(),
    errorCode: z.string().min(1).max(64).regex(/^[A-Z][A-Z0-9_]*$/),
  }).strict(),
]);

export type RestoreOperationState = z.infer<typeof RestoreOperationStateSchema>;
export type RestoreOperationRecord = z.infer<typeof recordSchema>;

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

async function ensureRealDirectory(directory: string): Promise<void> {
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.promises.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new DomainError("VALIDATION_FAILED", "Restore operation control directory is not a real directory.", 422);
  }
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

export class RestoreOperationStore {
  readonly #directory: string;
  readonly #filename: string;

  constructor(backupDirectory: string) {
    this.#directory = path.join(path.resolve(backupDirectory), CONTROL_DIRECTORY);
    this.#filename = path.join(this.#directory, STATE_FILENAME);
  }

  async read(): Promise<RestoreOperationState | null> {
    let handle: fs.promises.FileHandle | undefined;
    try {
      const entry = await fs.promises.lstat(this.#filename);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_STATE_BYTES) {
        throw new DomainError("TEMPORARILY_UNAVAILABLE", "Restore operation state is invalid.", 503);
      }
      handle = await fs.promises.open(
        this.#filename,
        process.platform === "win32"
          ? fs.constants.O_RDONLY
          : fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
      );
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_STATE_BYTES) {
        throw new DomainError("TEMPORARILY_UNAVAILABLE", "Restore operation state is invalid.", 503);
      }
      const buffer = Buffer.alloc(MAX_STATE_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_STATE_BYTES) {
        throw new DomainError("TEMPORARILY_UNAVAILABLE", "Restore operation state is invalid.", 503);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
      } catch (error) {
        throw new DomainError("TEMPORARILY_UNAVAILABLE", "Restore operation state is invalid.", 503, { cause: error });
      }
      const state = RestoreOperationStateSchema.safeParse(parsed);
      if (!state.success) {
        throw new DomainError("TEMPORARILY_UNAVAILABLE", "Restore operation state is invalid.", 503);
      }
      return state.data;
    } catch (error) {
      if (missing(error)) return null;
      if (error instanceof DomainError) throw error;
      throw new DomainError("TEMPORARILY_UNAVAILABLE", "Restore operation state is unreadable.", 503, { cause: error });
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async write(state: RestoreOperationState): Promise<void> {
    const validated = RestoreOperationStateSchema.parse(state);
    const serialized = `${JSON.stringify(validated)}\n`;
    if (Buffer.byteLength(serialized) > MAX_STATE_BYTES) {
      throw new DomainError("PAYLOAD_TOO_LARGE", "Restore operation state exceeds its fixed limit.", 413);
    }
    await ensureRealDirectory(this.#directory);
    const temporary = path.join(this.#directory, `.${STATE_FILENAME}.${randomUUID()}.tmp`);
    let handle: fs.promises.FileHandle | undefined;
    try {
      handle = await fs.promises.open(temporary, "wx", 0o600);
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.promises.rename(temporary, this.#filename);
      await syncDirectory(this.#directory);
    } finally {
      await handle?.close().catch(() => undefined);
      await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async #archive(
    expectedOperationId: string,
    allowedPhases: ReadonlySet<RestoreOperationState["phase"]>,
    label: string,
  ): Promise<{ archiveId: string }> {
    const operationId = operationIdSchema.parse(expectedOperationId);
    const state = await this.read();
    if (!state || state.operationId !== operationId) {
      throw new DomainError("VERSION_CONFLICT", "Matching restore operation state is required for finalization.", 409);
    }
    if (!allowedPhases.has(state.phase)) {
      throw new DomainError("VERSION_CONFLICT", `Restore operation state cannot be archived as ${label}.`, 409);
    }
    const archiveId = randomUUID();
    const archiveDirectory = path.join(this.#directory, ARCHIVE_DIRECTORY);
    await ensureRealDirectory(this.#directory);
    await ensureRealDirectory(archiveDirectory);
    const archiveFilename = `${operationId}-${archiveId}.json`;
    const destination = path.resolve(archiveDirectory, archiveFilename);
    if (path.dirname(destination) !== archiveDirectory || path.basename(destination) !== archiveFilename) {
      throw new DomainError("INTERNAL_ERROR", "Restore operation archive path was not safe.", 500);
    }
    await fs.promises.rename(this.#filename, destination);
    await syncDirectory(this.#directory);
    await syncDirectory(archiveDirectory);
    return { archiveId };
  }

  async archiveTerminal(expectedOperationId: string): Promise<{ archiveId: string }> {
    return this.#archive(expectedOperationId, new Set(["reconciled", "rolled_back"]), "terminal");
  }

  async archivePreparedCancellation(expectedOperationId: string): Promise<{ archiveId: string }> {
    return this.#archive(expectedOperationId, new Set(["prepared"]), "prepared cancellation");
  }
}
