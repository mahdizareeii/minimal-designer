import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RestoreOperationStore, type RestoreOperationState } from "./restore-operation-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.promises.rm(directory, { recursive: true, force: true })));
});

function preparedState(): RestoreOperationState {
  return {
    format: "formaspec-restore-operation",
    version: 1,
    operationId: "restore_0123456789abcdef",
    backupId: `backup_${"a".repeat(40)}`,
    phase: "prepared",
    target: {
      id: `backup_${"a".repeat(40)}`,
      organizationId: "organization_legacy",
      filename: "formaspec-backup-2026-07-20T00-00-00-000Z.tar",
      bundleSha256: "b".repeat(64),
      createdBy: "principal_local",
      createdAt: "2026-07-20T00:00:00.000Z",
      sizeBytes: 1_024,
      retentionClass: "manual",
    },
    safety: {
      id: `backup_${"c".repeat(40)}`,
      organizationId: "organization_legacy",
      filename: "formaspec-backup-2026-07-20T00-01-00-000Z.tar",
      bundleSha256: "d".repeat(64),
      createdBy: "system_restore_worker",
      createdAt: "2026-07-20T00:01:00.000Z",
      sizeBytes: 2_048,
      retentionClass: "manual",
    },
    monotonicFloor: { auditEventId: 41, outboxEventId: 73 },
    smoke: null,
    result: null,
    errorCode: null,
    createdAt: "2026-07-20T00:01:00.000Z",
    updatedAt: "2026-07-20T00:01:00.000Z",
  };
}

describe("RestoreOperationStore", () => {
  it("atomically persists one bounded path-free operation outside the data directory", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "formaspec-restore-operation-store-"));
    temporaryDirectories.push(root);
    const backupDirectory = path.join(root, "backups");
    const dataDirectory = path.join(root, "data");
    const store = new RestoreOperationStore(backupDirectory);
    expect(await store.read()).toBeNull();
    await store.write(preparedState());

    const filename = path.join(backupDirectory, ".formaspec", "restore-operation.json");
    const serialized = await fs.promises.readFile(filename, "utf8");
    expect(JSON.parse(serialized)).toEqual(preparedState());
    expect(serialized).not.toContain(dataDirectory);
    expect(serialized).not.toContain(backupDirectory);
    expect((await fs.promises.stat(filename)).mode & 0o777).toBe(0o600);
    expect(await fs.promises.readdir(path.dirname(filename))).toEqual(["restore-operation.json"]);
    await expect(store.read()).resolves.toEqual(preparedState());
    await expect(store.archiveTerminal(preparedState().operationId)).rejects.toMatchObject({ code: "VERSION_CONFLICT" });

    const terminal: RestoreOperationState = {
      ...preparedState(),
      phase: "reconciled",
      smoke: { schemaVersion: 10, renderedDesignId: "design_fixture" },
      result: {
        auditEventId: 42,
        outboxEventId: 74,
        revoked: { grants: 1, connections: 2, nonces: 3, sessions: 4 },
      },
      errorCode: null,
      updatedAt: "2026-07-20T00:02:00.000Z",
    };
    await store.write(terminal);
    const archived = await store.archiveTerminal(terminal.operationId);
    expect(archived.archiveId).toMatch(/^[a-f0-9-]{36}$/);
    expect(await store.read()).toBeNull();
    const historyDirectory = path.join(backupDirectory, ".formaspec", "restore-history");
    const history = await fs.promises.readdir(historyDirectory);
    expect(history).toHaveLength(1);
    expect(history[0]).toContain(terminal.operationId);
    expect(JSON.parse(await fs.promises.readFile(path.join(historyDirectory, history[0]!), "utf8"))).toEqual(terminal);
  });

  it("fails closed for malformed, oversized, and path-bearing state", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "formaspec-restore-operation-invalid-"));
    temporaryDirectories.push(root);
    const backupDirectory = path.join(root, "backups");
    const controlDirectory = path.join(backupDirectory, ".formaspec");
    const filename = path.join(controlDirectory, "restore-operation.json");
    const store = new RestoreOperationStore(backupDirectory);
    await fs.promises.mkdir(controlDirectory, { recursive: true });

    await fs.promises.writeFile(filename, "{invalid", { mode: 0o600 });
    await expect(store.read()).rejects.toMatchObject({ code: "TEMPORARILY_UNAVAILABLE" });

    await fs.promises.writeFile(filename, "x".repeat(16 * 1024 + 1), { mode: 0o600 });
    await expect(store.read()).rejects.toMatchObject({ code: "TEMPORARILY_UNAVAILABLE" });

    await fs.promises.writeFile(filename, JSON.stringify({
      ...preparedState(),
      target: { ...preparedState().target, sourcePath: "/private/restore.tar" },
    }), { mode: 0o600 });
    await expect(store.read()).rejects.toMatchObject({ code: "TEMPORARILY_UNAVAILABLE" });
  });
});
