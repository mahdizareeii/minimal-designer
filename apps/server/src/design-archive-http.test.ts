import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { resolveAccess, type OrganizationRole } from "./authorization.js";
import { loadConfig } from "./config.js";
import { DesignerDatabase } from "./db/database.js";
import { DomainError } from "./errors.js";
import { EventHub } from "./events.js";
import { canonicalJson } from "./ids.js";
import { DesignerService } from "./service.js";

const applications: DesignerApplication[] = [];
const databases: DesignerDatabase[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.app.close()));
  for (const database of databases.splice(0)) database.close();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.promises.rm(directory, { recursive: true, force: true })
  )));
});

function serviceFixture(): { database: DesignerDatabase; service: DesignerService } {
  const database = new DesignerDatabase(":memory:");
  databases.push(database);
  return { database, service: new DesignerService(database, new EventHub(), 900) };
}

function setRole(database: DesignerDatabase, actorId: string, role: OrganizationRole): void {
  const access = resolveAccess(database.sqlite, actorId);
  database.sqlite.prepare(
    "UPDATE memberships SET role = ? WHERE organization_id = ? AND principal_id = ?",
  ).run(role, access.organizationId, access.principalId);
}

function expectDomainError(action: () => unknown, code: DomainError["code"]): DomainError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
    return error as DomainError;
  }
  throw new Error(`Expected ${code}.`);
}

describe("confirmed project archival", () => {
  it("restricts roles, requires exact confirmation and CAS, then hides the project without deleting evidence", () => {
    const { database, service } = serviceFixture();
    const created = service.createDesign("local", {
      name: "Enterprise checkout",
      preset: "web",
      idempotencyKey: "create-archive-evidence-0001",
    });
    const asset = service.saveAsset("local", {
      designId: created.design.id,
      filename: "retained.png",
      mimeType: "image/png",
      width: 1,
      height: 1,
      data: Buffer.from("retained normalized bytes"),
    });

    for (const [actorId, role, allowed] of [
      ["archive-admin", "organization_admin", true],
      ["archive-product-manager", "product_manager", true],
      ["archive-editor", "design_editor", false],
      ["archive-engineer", "engineer", false],
      ["archive-viewer", "viewer", false],
      ["archive-agent", "agent", false],
    ] as const) {
      setRole(database, actorId, role);
      if (allowed) {
        expect(() => service.authorizeDesignArchive(actorId, created.design.id)).not.toThrow();
      } else {
        expectDomainError(() => service.authorizeDesignArchive(actorId, created.design.id), "FORBIDDEN");
      }
    }

    const actorId = "archive-product-manager";
    expectDomainError(() => service.archiveDesign(actorId, created.design.id, {
      expectedVersion: created.design.version,
      idempotencyKey: "archive-wrong-confirmation-0001",
      confirmationName: "enterprise checkout",
    }), "VALIDATION_FAILED");
    expectDomainError(() => service.archiveDesign(actorId, created.design.id, {
      expectedVersion: created.design.version + 1,
      idempotencyKey: "archive-stale-version-0001",
      confirmationName: created.design.name,
    }), "VERSION_CONFLICT");
    expect(database.sqlite.prepare(
      "SELECT key FROM system_metadata WHERE key = ?",
    ).get(`design_archive:${created.design.id}`)).toBeUndefined();

    const input = {
      expectedVersion: created.design.version,
      idempotencyKey: "archive-success-replay-0001",
      confirmationName: created.design.name,
    };
    service.setContext(actorId, {
      designId: created.design.id,
      pageId: created.document.pages[0]?.id,
      selection: [],
    });
    const archived = service.archiveDesign(actorId, created.design.id, input);
    expect(archived).toMatchObject({
      id: created.design.id,
      name: created.design.name,
      version: created.design.version,
      revisionId: created.design.revisionId,
    });
    expect(Number.isNaN(Date.parse(archived.archivedAt))).toBe(false);

    const tombstoneRow = database.sqlite.prepare(
      "SELECT value, updated_at FROM system_metadata WHERE key = ?",
    ).get(`design_archive:${created.design.id}`) as { value: string; updated_at: string };
    const tombstone = JSON.parse(tombstoneRow.value) as Record<string, unknown>;
    expect(tombstoneRow.value).toBe(canonicalJson(tombstone));
    expect(tombstone).toEqual({
      schema_version: 1,
      design_id: created.design.id,
      organization_id: "organization_legacy",
      archived_by: resolveAccess(database.sqlite, actorId).principalId,
      archived_at: archived.archivedAt,
      version: created.design.version,
      revision_id: created.design.revisionId,
    });
    expect(tombstoneRow.updated_at).toBe(archived.archivedAt);

    expect(service.listDesigns(actorId).designs).toEqual([]);
    expectDomainError(() => service.getDesign(actorId, created.design.id), "NOT_FOUND");
    expect(service.getContext(actorId)).toMatchObject({ designId: null, pageId: null, selection: [] });
    expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM designs WHERE id = ?").get(created.design.id))
      .toEqual({ count: 1 });
    expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM revisions WHERE design_id = ?").get(created.design.id))
      .toEqual({ count: 1 });
    expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM assets WHERE id = ? AND design_id = ?").get(asset.id, created.design.id))
      .toEqual({ count: 1 });
    expectDomainError(() => service.getAsset(actorId, asset.id), "NOT_FOUND");

    const audit = database.sqlite.prepare(
      "SELECT action, target_type, target_id, details_json FROM audit_events WHERE action = 'design.archive'",
    ).get() as { action: string; target_type: string; target_id: string; details_json: string };
    expect(audit).toMatchObject({ action: "design.archive", target_type: "design", target_id: created.design.id });
    expect(JSON.parse(audit.details_json)).toMatchObject({
      version: created.design.version,
      revisionId: created.design.revisionId,
      archivedAt: archived.archivedAt,
    });
    const outbox = database.sqlite.prepare(
      `SELECT event_type, payload_json FROM event_outbox
       WHERE event_type = 'design.updated' AND json_extract(payload_json, '$.archived') = 1`,
    ).get() as { event_type: string; payload_json: string };
    expect(outbox.event_type).toBe("design.updated");
    expect(JSON.parse(outbox.payload_json)).toEqual({
      designId: created.design.id,
      version: created.design.version,
      revisionId: created.design.revisionId,
      archived: true,
    });

    const beforeReplay = {
      audits: (database.sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action = 'design.archive'").get() as { count: number }).count,
      events: (database.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM event_outbox WHERE json_extract(payload_json, '$.archived') = 1",
      ).get() as { count: number }).count,
    };
    expect(service.archiveDesign(actorId, created.design.id, input)).toEqual(archived);
    expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action = 'design.archive'").get())
      .toEqual({ count: beforeReplay.audits });
    expect(database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM event_outbox WHERE json_extract(payload_json, '$.archived') = 1",
    ).get()).toEqual({ count: beforeReplay.events });
    expectDomainError(() => service.archiveDesign(actorId, created.design.id, {
      ...input,
      confirmationName: `${input.confirmationName} changed`,
    }), "IDEMPOTENCY_CONFLICT");
    expectDomainError(() => service.archiveDesign(actorId, created.design.id, {
      ...input,
      idempotencyKey: "archive-new-key-after-delete-0001",
    }), "NOT_FOUND");
  });

  it("rolls back the tombstone and idempotency record when a later transaction write fails", () => {
    const { database, service } = serviceFixture();
    const created = service.createDesign("local", {
      name: "Atomic archival",
      preset: "phone",
      idempotencyKey: "create-atomic-archive-0001",
    });
    service.setContext("local", {
      designId: created.design.id,
      pageId: created.document.pages[0]?.id,
      selection: [],
    });
    database.sqlite.exec(`
      CREATE TRIGGER reject_design_archive_audit
      BEFORE INSERT ON audit_events
      WHEN NEW.action = 'design.archive'
      BEGIN SELECT RAISE(ABORT, 'injected archive audit failure'); END;
    `);

    expect(() => service.archiveDesign("local", created.design.id, {
      expectedVersion: created.design.version,
      idempotencyKey: "archive-atomic-failure-0001",
      confirmationName: created.design.name,
    })).toThrow("injected archive audit failure");
    expect(database.sqlite.prepare("SELECT key FROM system_metadata WHERE key = ?").get(`design_archive:${created.design.id}`))
      .toBeUndefined();
    expect(database.sqlite.prepare(
      "SELECT key FROM idempotency WHERE actor_id = 'local' AND scope = ?",
    ).get(`design:${created.design.id}:archive`)).toBeUndefined();
    expect(database.sqlite.prepare(
      "SELECT id FROM event_outbox WHERE json_extract(payload_json, '$.archived') = 1",
    ).get()).toBeUndefined();
    expect(service.getDesign("local", created.design.id).design.id).toBe(created.design.id);
    expect(service.getContext("local")).toMatchObject({ designId: created.design.id });
  });

  it("exposes one strict confirmed-archive REST endpoint and filters subsequent list/read requests", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "formaspec-design-archive-http-"));
    temporaryDirectories.push(root);
    const application = await buildApplication(loadConfig({
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
    const created = application.service.createDesign("local", {
      name: "Archive through REST",
      preset: "tablet",
      idempotencyKey: "create-archive-http-0001",
    });
    const asset = application.service.saveAsset("local", {
      designId: created.design.id,
      filename: "archive-http-retained.png",
      mimeType: "image/png",
      width: 1,
      height: 1,
      data: Buffer.from("archive HTTP retained bytes"),
    });

    const response = await application.app.inject({
      method: "POST",
      url: `/api/designs/${created.design.id}/archive`,
      payload: {
        expectedVersion: created.design.version,
        idempotencyKey: "archive-through-http-0001",
        confirmationName: created.design.name,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      id: created.design.id,
      name: created.design.name,
      version: created.design.version,
      revisionId: created.design.revisionId,
    });

    const list = await application.app.inject({ method: "GET", url: "/api/designs" });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json()).toEqual({ designs: [], nextCursor: null });
    const read = await application.app.inject({ method: "GET", url: `/api/designs/${created.design.id}` });
    expect(read.statusCode).toBe(404);
    expect(read.json<{ error: { code: string } }>().error.code).toBe("NOT_FOUND");
    const assetRead = await application.app.inject({ method: "GET", url: `/api/assets/${asset.id}` });
    expect(assetRead.statusCode).toBe(404);
    expect(assetRead.json<{ error: { code: string } }>().error.code).toBe("NOT_FOUND");
    expect(application.database.sqlite.prepare("SELECT size_bytes FROM assets WHERE id = ?").get(asset.id))
      .toEqual({ size_bytes: asset.sizeBytes });
  });
});
