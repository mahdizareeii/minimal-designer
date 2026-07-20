import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RestoreWorkerLockStore } from "./restore-worker-lock.js";

const temporaryDirectories: string[] = [];
const operationId = "restore_0123456789abcdef0123456789abcdef";
const anotherOperationId = "restore_ffffffffffffffffffffffffffffffff";
const acquiredAt = "2026-07-20T09:00:00.000Z";

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.promises.rm(directory, { recursive: true, force: true })
  )));
});

async function fixture(): Promise<{ backupDirectory: string; lockPath: string }> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "formaspec-worker-lock-"));
  temporaryDirectories.push(root);
  const backupDirectory = path.join(root, "backups");
  await fs.promises.mkdir(backupDirectory);
  return {
    backupDirectory,
    lockPath: path.join(backupDirectory, ".formaspec", "restore-worker.lock.json"),
  };
}

describe("restore worker volume lock", () => {
  it("acquires a strict path-free record with O_EXCL semantics and refuses every concurrent worker", async () => {
    const { backupDirectory, lockPath } = await fixture();
    const firstStore = new RestoreWorkerLockStore(backupDirectory);
    const secondStore = new RestoreWorkerLockStore(backupDirectory);
    const first = await firstStore.acquire({
      operationId,
      ownerId: `worker_${"a".repeat(32)}`,
      containerId: "container-a",
      processId: 41,
      acquiredAt,
    });

    await expect(secondStore.acquire({
      operationId: anotherOperationId,
      ownerId: `worker_${"b".repeat(32)}`,
      containerId: "container-b",
      processId: 42,
      acquiredAt,
    })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    await expect(secondStore.acquire({
      operationId,
      ownerId: `worker_${"c".repeat(32)}`,
      containerId: "container-c",
      processId: 43,
      acquiredAt,
    })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });

    await expect(firstStore.read()).resolves.toMatchObject({
      active: true,
      lockValid: true,
      operationId,
      ownerId: `worker_${"a".repeat(32)}`,
      containerId: "container-a",
      processId: 41,
      acquiredAt,
    });
    const serialized = await fs.promises.readFile(lockPath, "utf8");
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(4 * 1024);
    expect(Object.keys(JSON.parse(serialized) as Record<string, unknown>).sort()).toEqual([
      "acquiredAt",
      "containerId",
      "format",
      "operationId",
      "ownerId",
      "processId",
      "version",
    ]);
    expect(serialized).not.toContain(backupDirectory);
    await first.release();
  });

  it("removes its owned lock on normal release and makes release idempotent", async () => {
    const { backupDirectory, lockPath } = await fixture();
    const store = new RestoreWorkerLockStore(backupDirectory);
    const lease = await store.acquire({ operationId, acquiredAt });
    expect(fs.existsSync(lockPath)).toBe(true);

    await lease.release();
    await lease.release();

    expect(fs.existsSync(lockPath)).toBe(false);
    await expect(store.read()).resolves.toEqual({ active: false, lockValid: true });
  });

  it("represents a process-death lock as active indefinitely and never clears it automatically", async () => {
    const { backupDirectory } = await fixture();
    const crashedStore = new RestoreWorkerLockStore(backupDirectory);
    await crashedStore.acquire({
      operationId,
      ownerId: `worker_${"d".repeat(32)}`,
      containerId: "dead-container",
      processId: 99,
      acquiredAt,
    });

    const restartedStore = new RestoreWorkerLockStore(backupDirectory);
    await expect(restartedStore.read()).resolves.toEqual({
      active: true,
      lockValid: true,
      format: "formaspec-restore-worker-lock",
      version: 1,
      operationId,
      ownerId: `worker_${"d".repeat(32)}`,
      containerId: "dead-container",
      processId: 99,
      acquiredAt,
    });
    await expect(restartedStore.acquire({ operationId, acquiredAt }))
      .rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  });

  it("requires the exact operation ID for explicit stale clearing", async () => {
    const { backupDirectory, lockPath } = await fixture();
    const store = new RestoreWorkerLockStore(backupDirectory);
    await store.acquire({ operationId, acquiredAt });

    await expect(store.clearStale(anotherOperationId))
      .rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(fs.existsSync(lockPath)).toBe(true);

    await store.clearStale(operationId);
    expect(fs.existsSync(lockPath)).toBe(false);
    await expect(store.read()).resolves.toEqual({ active: false, lockValid: true });
  });

  it("fails closed for malformed, oversized, and symlink lock entries", async () => {
    const malformed = await fixture();
    await fs.promises.mkdir(path.dirname(malformed.lockPath));
    await fs.promises.writeFile(malformed.lockPath, "not-json", { mode: 0o600 });
    await expect(new RestoreWorkerLockStore(malformed.backupDirectory).read())
      .resolves.toEqual({ active: true, lockValid: false });
    await expect(new RestoreWorkerLockStore(malformed.backupDirectory).clearStale(operationId))
      .rejects.toMatchObject({ code: "TEMPORARILY_UNAVAILABLE" });

    const oversized = await fixture();
    await fs.promises.mkdir(path.dirname(oversized.lockPath));
    await fs.promises.writeFile(oversized.lockPath, "x".repeat(4 * 1024 + 1), { mode: 0o600 });
    await expect(new RestoreWorkerLockStore(oversized.backupDirectory).read())
      .resolves.toEqual({ active: true, lockValid: false });

    if (process.platform !== "win32") {
      const symlink = await fixture();
      const target = path.join(path.dirname(symlink.backupDirectory), "outside.json");
      await fs.promises.mkdir(path.dirname(symlink.lockPath));
      await fs.promises.writeFile(target, "{}", { mode: 0o600 });
      await fs.promises.symlink(target, symlink.lockPath);
      await expect(new RestoreWorkerLockStore(symlink.backupDirectory).read())
        .resolves.toEqual({ active: true, lockValid: false });

      const controlSymlink = await fixture();
      const outsideDirectory = path.join(path.dirname(controlSymlink.backupDirectory), "outside-control");
      await fs.promises.mkdir(outsideDirectory);
      await fs.promises.symlink(outsideDirectory, path.dirname(controlSymlink.lockPath));
      const controlStore = new RestoreWorkerLockStore(controlSymlink.backupDirectory);
      await expect(controlStore.read()).resolves.toEqual({ active: true, lockValid: false });
      await expect(controlStore.acquire({ operationId, acquiredAt }))
        .rejects.toMatchObject({ code: "TEMPORARILY_UNAVAILABLE" });
    }
  });
});
