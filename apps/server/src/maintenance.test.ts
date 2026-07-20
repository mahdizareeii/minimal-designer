import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { loadConfig } from "./config.js";
import { DesignerDatabase } from "./db/database.js";
import { MaintenanceStore, type MaintenanceMarker } from "./maintenance.js";
import { RestoreOperationStore, type RestoreOperationState } from "./restore-operation-store.js";
import { RestoreWorkerLockStore } from "./restore-worker-lock.js";

const applications: DesignerApplication[] = [];
const temporaryDirectories: string[] = [];
const restoreOperationId = "restore_maintenance_test001";

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.promises.rm(directory, { recursive: true, force: true })));
});

async function temporaryRoot(label: string): Promise<string> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `formaspec-maintenance-${label}-`));
  temporaryDirectories.push(root);
  return root;
}

function marker(phase: MaintenanceMarker["phase"] = "restore"): MaintenanceMarker {
  return {
    schemaVersion: 1,
    active: true,
    phase,
    operationId: restoreOperationId,
    startedAt: "2000-01-01T00:00:00.000Z",
  };
}

function restoreOperationState(phase: "reconciled" | "rolled_back" = "reconciled"): RestoreOperationState {
  const record = {
    id: `backup_${"a".repeat(40)}`,
    organizationId: "organization_legacy",
    filename: "formaspec-backup-20260719T120000Z.tar",
    bundleSha256: "c".repeat(64),
    createdBy: "system:restore-worker",
    createdAt: "2026-07-19T12:00:00.000Z",
    sizeBytes: 1234,
    retentionClass: "manual" as const,
  };
  const common = {
    format: "formaspec-restore-operation",
    version: 1 as const,
    operationId: restoreOperationId,
    backupId: record.id,
    target: record,
    safety: {
      ...record,
      id: `backup_${"b".repeat(40)}`,
      filename: "formaspec-backup-20260719T120001Z.tar",
      bundleSha256: "d".repeat(64),
    },
    monotonicFloor: { auditEventId: 7, outboxEventId: 9 },
    createdAt: "2026-07-19T12:00:00.000Z",
    updatedAt: "2026-07-19T12:01:00.000Z",
  };
  if (phase === "rolled_back") {
    return {
      ...common,
      phase: "rolled_back",
      smoke: null,
      result: null,
      errorCode: "RENDER_FAILED",
    };
  }
  return {
    ...common,
    phase: "reconciled",
    smoke: { schemaVersion: 10, renderedDesignId: null },
    result: { auditEventId: 8, outboxEventId: 10, revoked: { grants: 1, connections: 1, nonces: 1 } },
    errorCode: null,
  };
}

async function localApplication(root: string): Promise<DesignerApplication> {
  const application = await buildApplication(loadConfig({
    APP_MODE: "local",
    HOST: "127.0.0.1",
    PORT: "4310",
    DATA_DIR: path.join(root, "data"),
    BACKUP_DIR: path.join(root, "backups"),
    DESIGNER_DATABASE_PATH: ":memory:",
    PUBLIC_BASE_URL: "http://127.0.0.1:4310",
    AUTH_MODE: "none",
    FORMASPEC_ALLOW_SOFTWARE_RENDERER: "true",
    DESIGNER_LOG_LEVEL: "silent",
  }));
  applications.push(application);
  await application.app.ready();
  return application;
}

describe("MaintenanceStore", () => {
  it("uses one atomic, strict, path-free marker outside DATA_DIR without automatic expiry", async () => {
    const root = await temporaryRoot("store");
    const dataDirectory = path.join(root, "data");
    const backupDirectory = path.join(root, "backups");
    const store = new MaintenanceStore(backupDirectory, dataDirectory);

    await expect(store.read()).resolves.toEqual({ active: false, markerValid: true });
    await store.write(marker("migration"));

    const markerPath = path.join(backupDirectory, ".formaspec", "maintenance.json");
    const persisted = JSON.parse(await fs.promises.readFile(markerPath, "utf8")) as Record<string, unknown>;
    expect(persisted).toEqual(marker("migration"));
    expect(Object.keys(persisted).sort()).toEqual([
      "active",
      "operationId",
      "phase",
      "schemaVersion",
      "startedAt",
    ]);
    expect(JSON.stringify(persisted)).not.toContain(dataDirectory);
    expect(JSON.stringify(persisted)).not.toContain(backupDirectory);
    expect((await fs.promises.stat(markerPath)).mode & 0o777).toBe(0o600);
    expect(await fs.promises.readdir(path.dirname(markerPath))).toEqual(["maintenance.json"]);

    // A deliberately old marker remains active until an operator explicitly clears it.
    await expect(new MaintenanceStore(backupDirectory, dataDirectory).read()).resolves.toEqual({
      active: true,
      markerValid: true,
      phase: "migration",
      operationId: restoreOperationId,
      startedAt: "2000-01-01T00:00:00.000Z",
    });
    await store.clear();
    await expect(store.read()).resolves.toEqual({ active: false, markerValid: true });

    await expect(store.write({ ...marker(), dataPath: dataDirectory } as MaintenanceMarker))
      .rejects.toThrow();
    expect(() => new MaintenanceStore(path.join(dataDirectory, "backups"), dataDirectory))
      .toThrow(/outside DATA_DIR/);
  });

  it("fails closed for malformed, oversized, and non-regular markers", async () => {
    const root = await temporaryRoot("invalid");
    const backupDirectory = path.join(root, "backups");
    const controlDirectory = path.join(backupDirectory, ".formaspec");
    const markerPath = path.join(controlDirectory, "maintenance.json");
    const store = new MaintenanceStore(backupDirectory, path.join(root, "data"));
    await fs.promises.mkdir(controlDirectory, { recursive: true });

    await fs.promises.writeFile(markerPath, "{not-json", { mode: 0o600 });
    await expect(store.read()).resolves.toEqual({ active: true, markerValid: false, phase: "unknown" });

    await fs.promises.writeFile(markerPath, JSON.stringify({ ...marker(), phase: "../../restore" }), { mode: 0o600 });
    await expect(store.read()).resolves.toEqual({ active: true, markerValid: false, phase: "unknown" });

    await fs.promises.writeFile(markerPath, "x".repeat(4 * 1024 + 1), { mode: 0o600 });
    await expect(store.read()).resolves.toEqual({ active: true, markerValid: false, phase: "unknown" });

    await fs.promises.rm(markerPath);
    await fs.promises.mkdir(markerPath);
    await expect(store.read()).resolves.toEqual({ active: true, markerValid: false, phase: "unknown" });
  });

  it("refuses to open SQLite while an offline restore cutover is incomplete", async () => {
    const root = await temporaryRoot("startup-fence");
    const dataDirectory = path.join(root, "data");
    const backupDirectory = path.join(root, "backups");
    const databasePath = path.join(dataDirectory, "designer.sqlite");
    const store = new MaintenanceStore(backupDirectory, dataDirectory);
    await store.write(marker("restore"));
    const config = loadConfig({
      APP_MODE: "local",
      HOST: "127.0.0.1",
      PORT: "4310",
      DATA_DIR: dataDirectory,
      BACKUP_DIR: backupDirectory,
      DESIGNER_DATABASE_PATH: databasePath,
      PUBLIC_BASE_URL: "http://127.0.0.1:4310",
      AUTH_MODE: "none",
      FORMASPEC_ALLOW_SOFTWARE_RENDERER: "true",
      DESIGNER_LOG_LEVEL: "silent",
    });
    await expect(buildApplication(config)).rejects.toMatchObject({
      code: "TEMPORARILY_UNAVAILABLE",
      details: { maintenance: true, phase: "restore" },
    });
    expect(fs.existsSync(databasePath)).toBe(false);

    await store.write(marker("verification"));
    const workerLease = await new RestoreWorkerLockStore(backupDirectory).acquire({
      operationId: restoreOperationId,
      ownerId: "worker_0123456789abcdef0123456789abcdef",
      processId: 4242,
      acquiredAt: "2026-07-19T12:00:00.000Z",
    });
    await expect(buildApplication(config)).rejects.toMatchObject({
      code: "TEMPORARILY_UNAVAILABLE",
      details: { maintenance: true, restoreWorkerLocked: true, lockValid: true },
    });
    expect(fs.existsSync(databasePath)).toBe(false);
    await workerLease.release();

    await expect(buildApplication(config)).rejects.toMatchObject({
      code: "TEMPORARILY_UNAVAILABLE",
      details: {
        maintenance: true,
        phase: "verification",
        operationPhase: null,
        journalPhase: null,
      },
    });
    expect(fs.existsSync(databasePath)).toBe(false);

    await new RestoreOperationStore(backupDirectory).write(restoreOperationState());

    const application = await buildApplication(config);
    applications.push(application);
    await application.app.ready();
    expect(fs.existsSync(databasePath)).toBe(true);
  });

  it("refuses verification startup when an incomplete cutover journal remains", async () => {
    const root = await temporaryRoot("startup-journal");
    const dataDirectory = path.join(root, "data");
    const backupDirectory = path.join(root, "backups");
    const databasePath = path.join(dataDirectory, "designer.sqlite");
    await new MaintenanceStore(backupDirectory, dataDirectory).write(marker("verification"));
    await new RestoreOperationStore(backupDirectory).write(restoreOperationState());
    const journalDirectory = path.join(dataDirectory, ".formaspec-restore-journal");
    await fs.promises.mkdir(journalDirectory, { recursive: true });
    await fs.promises.writeFile(path.join(journalDirectory, "journal.json"), JSON.stringify({
      format: "formaspec-restore-journal",
      version: 1,
      restoreId: "00000000-0000-4000-8000-000000000000",
      sourceBundleSha256: "e".repeat(64),
      createdAt: "2026-07-19T12:00:00.000Z",
      updatedAt: "2026-07-19T12:01:00.000Z",
      phase: "moving-candidate",
      candidateCutoverStarted: true,
      originalEntries: [],
      candidateEntries: [],
      steps: [],
    }));
    const config = loadConfig({
      APP_MODE: "local",
      HOST: "127.0.0.1",
      PORT: "4310",
      DATA_DIR: dataDirectory,
      BACKUP_DIR: backupDirectory,
      DESIGNER_DATABASE_PATH: databasePath,
      PUBLIC_BASE_URL: "http://127.0.0.1:4310",
      AUTH_MODE: "none",
      FORMASPEC_ALLOW_SOFTWARE_RENDERER: "true",
      DESIGNER_LOG_LEVEL: "silent",
    });
    await expect(buildApplication(config)).rejects.toMatchObject({
      code: "TEMPORARILY_UNAVAILABLE",
      details: { operationPhase: "reconciled", journalPhase: "moving-candidate" },
    });
    expect(fs.existsSync(databasePath)).toBe(false);
  });

  it("restarts after a proven rollback once its terminal journal and maintenance marker are cleared", async () => {
    const root = await temporaryRoot("startup-rolled-back");
    const dataDirectory = path.join(root, "data");
    const backupDirectory = path.join(root, "backups");
    const databasePath = path.join(dataDirectory, "designer.sqlite");
    const database = new DesignerDatabase(databasePath);
    database.close();
    await new RestoreOperationStore(backupDirectory).write(restoreOperationState("rolled_back"));

    const application = await buildApplication(loadConfig({
      APP_MODE: "local",
      HOST: "127.0.0.1",
      PORT: "4310",
      DATA_DIR: dataDirectory,
      BACKUP_DIR: backupDirectory,
      DESIGNER_DATABASE_PATH: databasePath,
      PUBLIC_BASE_URL: "http://127.0.0.1:4310",
      AUTH_MODE: "none",
      FORMASPEC_ALLOW_SOFTWARE_RENDERER: "true",
      DESIGNER_LOG_LEVEL: "silent",
    }));
    applications.push(application);
    await application.app.ready();
    expect(await application.maintenance.read()).toEqual({ active: false, markerValid: true });
    expect(fs.existsSync(path.join(dataDirectory, ".formaspec-restore-journal"))).toBe(false);
    expect(application.database.schemaVersion()).toBe(11);
  });
});

describe("maintenance HTTP gate", () => {
  it("allows health and authenticated status while rejecting REST, MCP, and SSE without mutation", async () => {
    const root = await temporaryRoot("http");
    const application = await localApplication(root);
    await application.maintenance.write(marker("restore"));

    const live = await application.app.inject({ method: "GET", url: "/health/live" });
    expect(live.statusCode).toBe(200);

    const render = await application.app.inject({ method: "GET", url: "/health/render" });
    expect([200, 503]).toContain(render.statusCode);
    expect(render.json<{ status?: string }>().status).not.toBe("maintenance");

    const fullReady = await application.app.inject({ method: "GET", url: "/health/ready" });
    expect(fullReady.statusCode).toBe(503);
    expect(fullReady.json()).toMatchObject({
      ok: false,
      status: "maintenance",
      database: "ready",
      migrations: 11,
      maintenance: { active: true, phase: "restore", operationId: restoreOperationId },
      render: { ok: true },
    });
    const readyAlias = await application.app.inject({ method: "GET", url: "/ready" });
    expect(readyAlias.statusCode).toBe(503);
    expect(readyAlias.json()).toEqual({
      ok: false,
      status: "maintenance",
      maintenance: { active: true, phase: "restore" },
    });

    const status = await application.app.inject({ method: "GET", url: "/api/maintenance/status" });
    expect(status.statusCode).toBe(200);
    expect(status.headers["cache-control"]).toBe("no-store");
    expect(status.json()).toEqual({
      active: true,
      phase: "restore",
      operationId: restoreOperationId,
      startedAt: "2000-01-01T00:00:00.000Z",
      markerValid: true,
    });

    const rest = await application.app.inject({ method: "GET", url: "/api/designs" });
    const mcp = await application.app.inject({
      method: "POST",
      url: "/mcp",
      payload: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    });
    const sse = await application.app.inject({ method: "GET", url: "/events" });
    const legacySse = await application.app.inject({ method: "GET", url: "/api/events" });
    for (const response of [rest, mcp, sse, legacySse]) {
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        error: {
          code: "TEMPORARILY_UNAVAILABLE",
          retryable: true,
          details: { maintenance: true, phase: "restore" },
        },
      });
    }
    expect((application.database.sqlite.prepare("SELECT COUNT(*) AS count FROM designs").get() as { count: number }).count)
      .toBe(0);

    await application.maintenance.clear();
    const resumed = await application.app.inject({ method: "GET", url: "/api/designs" });
    expect(resumed.statusCode).toBe(200);

    const mutation = await application.app.inject({ method: "POST", url: "/api/maintenance/status", payload: {} });
    const selfRestore = await application.app.inject({ method: "POST", url: "/api/maintenance/restore", payload: {} });
    expect(mutation.statusCode).toBe(404);
    expect(selfRestore.statusCode).toBe(404);
  });

  it("reports only an unknown phase and remains closed when the marker is malformed", async () => {
    const root = await temporaryRoot("malformed-http");
    const application = await localApplication(root);
    const controlDirectory = path.join(application.config.backupDir, ".formaspec");
    await fs.promises.mkdir(controlDirectory, { recursive: true });
    await fs.promises.writeFile(path.join(controlDirectory, "maintenance.json"), JSON.stringify({
      active: true,
      phase: "/private/customer/restore",
      reason: "operator supplied secret",
    }), { mode: 0o600 });

    const ready = await application.app.inject({ method: "GET", url: "/health/ready" });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toMatchObject({
      ok: false,
      status: "maintenance",
      database: "ready",
      migrations: 11,
      maintenance: { active: true, phase: "unknown" },
    });
    expect(ready.body).not.toContain("private");
    expect(ready.body).not.toContain("secret");

    const status = await application.app.inject({ method: "GET", url: "/api/maintenance/status" });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({ active: true, phase: "unknown", markerValid: false });

    const blocked = await application.app.inject({ method: "GET", url: "/api/designs" });
    expect(blocked.statusCode).toBe(503);
    expect(blocked.json()).toMatchObject({
      error: { code: "TEMPORARILY_UNAVAILABLE", details: { phase: "unknown" } },
    });
  });

  it("keeps the maintenance status endpoint behind server-mode authentication", async () => {
    const root = await temporaryRoot("auth");
    const application = await buildApplication(loadConfig({
      APP_MODE: "server",
      HOST: "0.0.0.0",
      PORT: "4310",
      DATA_DIR: path.join(root, "data"),
      BACKUP_DIR: path.join(root, "backups"),
      DESIGNER_DATABASE_PATH: ":memory:",
      PUBLIC_BASE_URL: "https://design.example.com",
      AUTH_MODE: "trusted-header",
      DESIGNER_TOKEN: "0123456789abcdef",
      FORMASPEC_TRUSTED_PROXIES: "127.0.0.1",
      DESIGNER_CORS_ORIGINS: "https://design.example.com",
      DESIGNER_LOG_LEVEL: "silent",
    }));
    applications.push(application);
    await application.app.ready();
    await application.maintenance.write(marker("verification"));

    const unauthorized = await application.app.inject({
      method: "GET",
      url: "/api/maintenance/status",
      headers: { host: "design.example.com" },
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.json<{ error: { code: string } }>().error.code).toBe("AUTH_REQUIRED");

    const authorized = await application.app.inject({
      method: "GET",
      url: "/api/maintenance/status",
      headers: { host: "design.example.com", "x-designer-user": "operator@example.com" },
    });
    expect(authorized.statusCode).toBe(200);
    expect(authorized.json()).toMatchObject({ active: true, phase: "verification", markerValid: true });
  });
});
