import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { loadConfig } from "./config.js";

describe("organization audit-retention HTTP routes", () => {
  let application: DesignerApplication;
  let root: string;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "formaspec-audit-retention-http-"));
    application = await buildApplication(loadConfig({
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
    await application.app.ready();
  });

  afterEach(async () => {
    await application.app.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("requires a reviewed exact plan and exposes immutable run evidence", async () => {
    application.database.sqlite.prepare(
      `INSERT INTO audit_events
       (organization_id, actor_id, action, target_type, target_id, details_json, created_at)
       VALUES ('organization_legacy', 'principal_local', 'http.old', 'test', NULL, '{}', '2020-01-01T00:00:00.000Z')`,
    ).run();
    const oldOutbox = application.database.sqlite.prepare(
      `INSERT INTO event_outbox
       (organization_id, actor_id, event_type, payload_json, workspace, created_at, published_at)
       VALUES ('organization_legacy', 'local', 'design.updated', '{}', 1,
               '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:01.000Z')`,
    ).run();
    application.database.sqlite.prepare(
      `INSERT INTO event_outbox
       (organization_id, actor_id, event_type, payload_json, workspace, created_at, published_at)
       VALUES ('organization_legacy', 'local', 'design.updated', '{}', 1,
               '2020-01-02T00:00:00.000Z', '2020-01-02T00:00:01.000Z')`,
    ).run();

    const previewResponse = await application.app.inject({
      method: "POST",
      url: "/api/organization/audit-retention/previews",
      payload: {},
    });
    expect(previewResponse.statusCode).toBe(201);
    const preview = previewResponse.json<{ preview: {
      previewId: string;
      planHash: string;
      retentionDays: number;
      auditEvents: { count: number };
      outboxEvents: { count: number };
    } }>().preview;
    expect(preview).toMatchObject({
      retentionDays: 365,
      auditEvents: { count: 1 },
      outboxEvents: { count: 2 },
    });

    const wrongHash = await application.app.inject({
      method: "POST",
      url: `/api/organization/audit-retention/previews/${preview.previewId}/commit`,
      payload: { expectedPlanHash: "f".repeat(64), idempotencyKey: "http-audit-retention-0001" },
    });
    expect(wrongHash.statusCode).toBe(409);
    expect(wrongHash.json()).toMatchObject({ error: { code: "VERSION_CONFLICT" } });
    expect(application.database.sqlite.prepare("SELECT COUNT(*) AS count FROM audit_retention_runs").get()).toEqual({ count: 0 });

    const committed = await application.app.inject({
      method: "POST",
      url: `/api/organization/audit-retention/previews/${preview.previewId}/commit`,
      payload: { expectedPlanHash: preview.planHash, idempotencyKey: "http-audit-retention-0001" },
    });
    expect(committed.statusCode).toBe(200);
    const result = committed.json<{ result: {
      runId: string;
      runHash: string;
      commitAuditEventId: number;
      commitOutboxEventId: number;
      auditEvents: { count: number };
      outboxEvents: { count: number };
    } }>().result;
    expect(result).toMatchObject({ auditEvents: { count: 1 }, outboxEvents: { count: 2 } });
    expect(result.runId).toMatch(/^audit_retention_run_[a-f0-9]{32}$/);
    expect(result.runHash).toMatch(/^[a-f0-9]{64}$/);

    const retry = await application.app.inject({
      method: "POST",
      url: `/api/organization/audit-retention/previews/${preview.previewId}/commit`,
      payload: { expectedPlanHash: preview.planHash, idempotencyKey: "http-audit-retention-0001" },
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual({ result });

    const listed = await application.app.inject({
      method: "GET",
      url: "/api/organization/audit-retention/runs?limit=1",
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({ runs: [result] });
    expect(application.database.sqlite.prepare("SELECT COUNT(*) AS count FROM audit_retention_runs").get()).toEqual({ count: 1 });
    expect(application.database.sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action = 'http.old'").get()).toEqual({ count: 0 });
    expect(application.service.eventsSince("local", Number(oldOutbox.lastInsertRowid))).toMatchObject({
      gap: true,
      earliestId: result.commitOutboxEventId,
    });
  });

  it("validates destructive commit inputs before service execution", async () => {
    const response = await application.app.inject({
      method: "POST",
      url: `/api/organization/audit-retention/previews/audit_retention_preview_${"a".repeat(32)}/commit`,
      payload: { expectedPlanHash: "not-a-hash", idempotencyKey: "short" },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
  });
});
