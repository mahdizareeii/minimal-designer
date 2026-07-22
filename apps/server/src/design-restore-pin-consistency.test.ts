import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { loadConfig } from "./config.js";

const applications: DesignerApplication[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.promises.rm(directory, { recursive: true, force: true })));
});

async function application(): Promise<DesignerApplication> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "formaspec-restore-pin-"));
  temporaryDirectories.push(root);
  const built = await buildApplication(loadConfig({
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
  applications.push(built);
  await built.app.ready();
  return built;
}

function seedVerifiedMigrationBackup(
  app: DesignerApplication,
  id: string,
  createdAt: string,
): void {
  const manifest = {
    format: "formaspec-backup",
    formatVersion: 2,
    createdAt,
    databaseSchemaVersion: app.database.schemaVersion(),
  };
  const verification = {
    valid: true,
    manifest,
    sqliteIntegrity: "ok",
    foreignKeyViolations: 0,
    extractedBytes: 1,
    entryCount: 1,
  };
  app.database.sqlite.prepare(
    `INSERT INTO backup_records
     (id, organization_id, filename, bundle_sha256, status, manifest_json, created_by, created_at, verified_at,
      size_bytes, verification_json, retention_class, completed_at)
     VALUES (?, 'organization_legacy', 'restore-pin-gate.tar', ?, 'valid', ?, 'principal_local', ?, ?, 1, ?, 'manual', ?)`,
  ).run(
    id,
    "b".repeat(64),
    JSON.stringify(manifest),
    createdAt,
    createdAt,
    JSON.stringify(verification),
    createdAt,
  );
}

function persistedState(app: DesignerApplication, designId: string) {
  return {
    head: app.service.getDesign("local", designId),
    pin: app.designSystems.readProjectPin("local", designId),
    revisionCount: (app.database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM revisions WHERE design_id = ?",
    ).get(designId) as { count: number }).count,
    snapshotCount: (app.database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM snapshots",
    ).get() as { count: number }).count,
    outboxCount: (app.database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM event_outbox",
    ).get() as { count: number }).count,
    idempotencyCount: (app.database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM idempotency",
    ).get() as { count: number }).count,
  };
}

describe("V2 design restore pin consistency", () => {
  it("preserves the active pin through idempotent human REST restores and denies MCP restores", async () => {
    const app = await application();
    const created = app.service.createDesign("local", {
      name: "Restore pin surfaces",
      preset: "web",
      idempotencyKey: "restore-pin-surface-create-0001",
    });
    const backupId = "backup_restorepinsurface01";
    seedVerifiedMigrationBackup(app, backupId, created.design.updatedAt);
    app.service.migrateDesignHeadToV2("local", created.design.id, {
      expectedBaseVersion: 1,
      backupId,
      idempotencyKey: "restore-pin-surface-migrate-0001",
    });
    const system = app.designSystems.createDesignSystem("local", {
      name: "Pinned surface system",
    });
    const release = app.designSystems.createRelease("local", system.id, {
      expectedLatestVersion: 0,
      name: "Pinned release",
      status: "published",
      tokenVersions: [],
      componentVersions: [],
    });
    app.designSystems.pinProject("local", {
      designId: created.design.id,
      releaseId: release.id,
      expectedCurrentReleaseId: null,
    });
    const before = persistedState(app, created.design.id);

    const tools = await app.app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        host: "127.0.0.1:4310",
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    const restoreTool = tools.json<{
      result: { tools: Array<{ name: string; description?: string }> };
    }>().result.tools.find((tool) => tool.name === "design_restore_revision");
    expect(restoreTool?.description).toContain("Compatibility placeholder only");
    expect(restoreTool?.description).toContain("human");

    const httpPayload = {
      targetVersion: 2,
      expectedBaseVersion: 3,
      idempotencyKey: "restore-pin-http-preserve-0001",
    };
    const http = await app.app.inject({
      method: "POST",
      url: `/api/designs/${created.design.id}/restore`,
      payload: httpPayload,
    });
    expect(http.statusCode).toBe(200);
    expect(http.json<{
      version: number;
      revisionId: string;
      diagnostics: Array<Record<string, unknown>>;
      restore: { designSystem: { status: string } };
      restorePolicy: { designSystem: string };
    }>()).toMatchObject({
      version: 4,
      restore: { designSystem: { status: "active_pin_preserved" } },
      restorePolicy: { designSystem: "active_pin_preserved" },
      diagnostics: expect.arrayContaining([expect.objectContaining({
        code: "RESTORE_DESIGN_SYSTEM_PIN_PRESERVED",
        target_version: 2,
        active_design_system_id: system.id,
        active_release_id: release.id,
        active_release_version: 1,
        historical_design_system_id: "system_formaspec_foundation",
        historical_release_id: "release_formaspec_foundation_1",
        historical_release_version: 1,
      })]),
    });
    const httpBody = http.json<{ revisionId: string }>();
    const afterHttp = persistedState(app, created.design.id);
    expect(afterHttp.revisionCount).toBe(before.revisionCount + 1);
    expect(afterHttp.pin).toEqual(before.pin);
    if (afterHttp.head.canonicalDocument.schema_version !== 2) throw new Error("Expected V2 project head.");
    expect(afterHttp.head.canonicalDocument.design_system).toEqual({
      design_system_id: system.id,
      release_id: release.id,
      release_version: 1,
    });

    const httpReplay = await app.app.inject({
      method: "POST",
      url: `/api/designs/${created.design.id}/restore`,
      payload: httpPayload,
    });
    expect(httpReplay.statusCode).toBe(200);
    expect(httpReplay.json<{ revisionId: string }>().revisionId).toBe(httpBody.revisionId);
    expect(persistedState(app, created.design.id)).toEqual(afterHttp);

    const mcpArguments = {
      design_id: created.design.id,
      target_version: 2,
      expected_base_version: 4,
      idempotency_key: "restore-pin-mcp-preserve-0001",
    };
    const mcp = await app.app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        host: "127.0.0.1:4310",
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "design_restore_revision",
          arguments: mcpArguments,
        },
      },
    });
    expect(mcp.statusCode).toBe(200);
    const mcpBody = mcp.json<{
      result: {
        structuredContent: {
          ok: boolean;
          error: { code: string };
        };
      };
    }>().result.structuredContent;
    expect(mcpBody).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    const afterMcp = persistedState(app, created.design.id);
    expect(afterMcp).toEqual(afterHttp);

    const mcpReplay = await app.app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        host: "127.0.0.1:4310",
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      payload: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "design_restore_revision", arguments: mcpArguments },
      },
    });
    expect(mcpReplay.json<{
      result: { structuredContent: { ok: boolean; error: { code: string } } };
    }>().result.structuredContent).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(persistedState(app, created.design.id)).toEqual(afterMcp);

    const v1Http = await app.app.inject({
      method: "POST",
      url: `/api/designs/${created.design.id}/restore`,
      payload: {
        targetVersion: 1,
        expectedBaseVersion: 4,
        idempotencyKey: "restore-pin-http-v1-policy-0001",
      },
    });
    expect(v1Http.statusCode).toBe(200);
    expect(v1Http.json<{
      schemaVersion: number;
      restore: { targetSchemaVersion: number; designSystem: { status: string } };
      restorePolicy: { designSystem: string };
    }>()).toMatchObject({
      schemaVersion: 1,
      restore: {
        targetSchemaVersion: 1,
        designSystem: { status: "not_applicable_v1" },
      },
      restorePolicy: { designSystem: "not_applicable_v1" },
    });

    const v1Mcp = await app.app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        host: "127.0.0.1:4310",
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      payload: {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "design_restore_revision",
          arguments: {
            design_id: created.design.id,
            target_version: 1,
            expected_base_version: 5,
            idempotency_key: "restore-pin-mcp-v1-policy-0001",
          },
        },
      },
    });
    const v1McpBody = v1Mcp.json<{
      result: {
        content: Array<{ type: string; text: string }>;
        structuredContent: {
          ok: boolean;
          error: { code: string };
        };
      };
    }>().result;
    expect(v1McpBody.content[0]?.text).toContain("FORBIDDEN");
    expect(v1McpBody.structuredContent).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(app.designSystems.readProjectPin("local", created.design.id)).toEqual(before.pin);
  });
});
