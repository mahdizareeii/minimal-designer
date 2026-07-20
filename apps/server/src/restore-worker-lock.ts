import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import { DomainError } from "./errors.js";

const CONTROL_DIRECTORY = ".formaspec";
const LOCK_FILENAME = "restore-worker.lock.json";
const MAX_LOCK_BYTES = 4 * 1024;

const operationIdSchema = z.string().min(16).max(120)
  .regex(/^restore_[A-Za-z0-9][A-Za-z0-9_-]+$/);
const ownerIdSchema = z.string().regex(/^worker_[a-f0-9]{32}$/);
const containerIdSchema = z.string().min(1).max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const timestampSchema = z.string().max(40).datetime({ offset: true });

export const RestoreWorkerLockRecordSchema = z.object({
  format: z.literal("formaspec-restore-worker-lock"),
  version: z.literal(1),
  operationId: operationIdSchema,
  ownerId: ownerIdSchema,
  containerId: containerIdSchema.nullable(),
  processId: z.number().int().positive().max(2_147_483_647),
  acquiredAt: timestampSchema,
}).strict();

export type RestoreWorkerLockRecord = z.infer<typeof RestoreWorkerLockRecordSchema>;

export type RestoreWorkerLockStatus =
  | { active: false; lockValid: true }
  | { active: true; lockValid: false }
  | ({ active: true; lockValid: true } & RestoreWorkerLockRecord);

export interface AcquireRestoreWorkerLockInput {
  operationId: string;
  containerId?: string | null;
  processId?: number;
  acquiredAt?: string;
  ownerId?: string;
}

interface ReadLockResult {
  status: RestoreWorkerLockStatus;
  identity?: { dev: bigint; ino: bigint };
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

async function ensureControlDirectory(root: string, directory: string): Promise<void> {
  await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
  const rootStat = await fs.promises.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new DomainError(
      "TEMPORARILY_UNAVAILABLE",
      "Restore backup directory is invalid.",
      503,
    );
  }
  await fs.promises.mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const controlStat = await fs.promises.lstat(directory);
  if (!controlStat.isDirectory() || controlStat.isSymbolicLink()) {
    throw new DomainError(
      "TEMPORARILY_UNAVAILABLE",
      "Restore worker lock directory is invalid.",
      503,
    );
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

function sameIdentity(
  left: { dev: bigint; ino: bigint },
  right: { dev: bigint; ino: bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function activeLockError(status: RestoreWorkerLockStatus): DomainError {
  if (status.active && status.lockValid) {
    return new DomainError(
      "VERSION_CONFLICT",
      "A restore worker already owns the shared restore lock.",
      409,
      {
        retryable: true,
        details: {
          restoreWorkerLocked: true,
          operationId: status.operationId,
        },
      },
    );
  }
  return new DomainError(
    "TEMPORARILY_UNAVAILABLE",
    "Restore worker lock state is invalid and requires operator inspection.",
    503,
    { retryable: false, details: { restoreWorkerLocked: true, lockValid: false } },
  );
}

export class RestoreWorkerLockLease {
  #released = false;

  constructor(
    private readonly store: RestoreWorkerLockStore,
    readonly record: RestoreWorkerLockRecord,
  ) {}

  async release(): Promise<void> {
    if (this.#released) return;
    await this.store.releaseOwned(this.record);
    this.#released = true;
  }
}

/**
 * Volume-shared, fail-closed exclusion for one-shot restore workers.
 *
 * The lock is deliberately not age-expiring. A process death leaves a stale
 * record that only an external supervisor may clear after proving the owner is
 * no longer live. The record contains bounded opaque identities and no paths.
 */
export class RestoreWorkerLockStore {
  readonly #root: string;
  readonly #directory: string;
  readonly #filename: string;

  constructor(backupDirectory: string) {
    this.#root = path.resolve(backupDirectory);
    this.#directory = path.join(this.#root, CONTROL_DIRECTORY);
    this.#filename = path.join(this.#directory, LOCK_FILENAME);
  }

  async #readInternal(): Promise<ReadLockResult> {
    let handle: fs.promises.FileHandle | undefined;
    try {
      const root = await fs.promises.lstat(this.#root);
      if (!root.isDirectory() || root.isSymbolicLink()) {
        return { status: { active: true, lockValid: false } };
      }
      const control = await fs.promises.lstat(this.#directory);
      if (!control.isDirectory() || control.isSymbolicLink()) {
        return { status: { active: true, lockValid: false } };
      }
      const entry = await fs.promises.lstat(this.#filename, { bigint: true });
      if (!entry.isFile() || entry.isSymbolicLink() || entry.size > BigInt(MAX_LOCK_BYTES)) {
        return { status: { active: true, lockValid: false } };
      }
      handle = await fs.promises.open(
        this.#filename,
        process.platform === "win32"
          ? fs.constants.O_RDONLY
          : fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
      );
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile() || stat.size > BigInt(MAX_LOCK_BYTES)
        || !sameIdentity({ dev: entry.dev, ino: entry.ino }, { dev: stat.dev, ino: stat.ino })) {
        return { status: { active: true, lockValid: false } };
      }
      const buffer = Buffer.alloc(MAX_LOCK_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_LOCK_BYTES) {
        return { status: { active: true, lockValid: false } };
      }
      let json: unknown;
      try {
        json = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
      } catch {
        return { status: { active: true, lockValid: false } };
      }
      const record = RestoreWorkerLockRecordSchema.safeParse(json);
      if (!record.success) return { status: { active: true, lockValid: false } };
      return {
        status: { active: true, lockValid: true, ...record.data },
        identity: { dev: stat.dev, ino: stat.ino },
      };
    } catch (error) {
      if (isMissing(error)) return { status: { active: false, lockValid: true } };
      return { status: { active: true, lockValid: false } };
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async read(): Promise<RestoreWorkerLockStatus> {
    return (await this.#readInternal()).status;
  }

  async acquire(input: AcquireRestoreWorkerLockInput): Promise<RestoreWorkerLockLease> {
    const record = RestoreWorkerLockRecordSchema.parse({
      format: "formaspec-restore-worker-lock",
      version: 1,
      operationId: input.operationId,
      ownerId: input.ownerId ?? `worker_${randomUUID().replaceAll("-", "")}`,
      containerId: input.containerId ?? null,
      processId: input.processId ?? process.pid,
      acquiredAt: input.acquiredAt ?? new Date().toISOString(),
    });
    const serialized = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(serialized) > MAX_LOCK_BYTES) {
      throw new DomainError("PAYLOAD_TOO_LARGE", "Restore worker lock exceeds its fixed limit.", 413);
    }
    await ensureControlDirectory(this.#root, this.#directory);

    let handle: fs.promises.FileHandle | undefined;
    let created = false;
    try {
      handle = await fs.promises.open(this.#filename, "wx", 0o600);
      created = true;
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await syncDirectory(this.#directory);
      return new RestoreWorkerLockLease(this, record);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      handle = undefined;
      if ((error as NodeJS.ErrnoException | undefined)?.code === "EEXIST") {
        throw activeLockError(await this.read());
      }
      if (created) {
        await fs.promises.unlink(this.#filename).then(
          () => syncDirectory(this.#directory),
          () => undefined,
        ).catch(() => undefined);
      }
      if (error instanceof DomainError) throw error;
      throw new DomainError(
        "TEMPORARILY_UNAVAILABLE",
        "Restore worker lock could not be acquired safely.",
        503,
        { cause: error },
      );
    }
  }

  async #removeMatching(
    expectedOperationId: string,
    expectedOwnerId?: string,
  ): Promise<void> {
    const operationId = operationIdSchema.parse(expectedOperationId);
    const current = await this.#readInternal();
    if (!current.status.active) {
      throw new DomainError("VERSION_CONFLICT", "A matching restore worker lock is required.", 409);
    }
    if (!current.status.lockValid || !current.identity) {
      throw new DomainError(
        "TEMPORARILY_UNAVAILABLE",
        "Restore worker lock state is invalid and requires operator inspection.",
        503,
      );
    }
    if (current.status.operationId !== operationId
      || (expectedOwnerId !== undefined && current.status.ownerId !== expectedOwnerId)) {
      throw new DomainError("VERSION_CONFLICT", "Restore worker lock ownership does not match.", 409);
    }

    let pathStat: fs.BigIntStats;
    try {
      pathStat = await fs.promises.lstat(this.#filename, { bigint: true });
    } catch (error) {
      if (isMissing(error)) {
        throw new DomainError("VERSION_CONFLICT", "Restore worker lock changed before removal.", 409);
      }
      throw new DomainError(
        "TEMPORARILY_UNAVAILABLE",
        "Restore worker lock could not be verified for removal.",
        503,
        { cause: error },
      );
    }
    if (!pathStat.isFile() || pathStat.isSymbolicLink()
      || !sameIdentity(current.identity, { dev: pathStat.dev, ino: pathStat.ino })) {
      throw new DomainError("VERSION_CONFLICT", "Restore worker lock changed before removal.", 409);
    }
    try {
      await fs.promises.unlink(this.#filename);
      await syncDirectory(this.#directory);
    } catch (error) {
      throw new DomainError(
        "TEMPORARILY_UNAVAILABLE",
        "Restore worker lock could not be removed durably.",
        503,
        { cause: error },
      );
    }
  }

  async releaseOwned(record: RestoreWorkerLockRecord): Promise<void> {
    const validated = RestoreWorkerLockRecordSchema.parse(record);
    await this.#removeMatching(validated.operationId, validated.ownerId);
  }

  /** External supervisors must prove the owner is dead before calling this. */
  async clearStale(expectedOperationId: string): Promise<void> {
    await this.#removeMatching(expectedOperationId);
  }
}
