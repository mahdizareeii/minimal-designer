import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DesignerDatabase } from "./db/database.js";
import { EnterpriseService } from "./enterprise-service.js";
import { EventHub } from "./events.js";
import { canonicalJson } from "./ids.js";
import { ContentAddressedPreviewRenderStore } from "./preview-render-store.js";
import { encodeRgbaPng } from "./render.js";
import { DesignerService } from "./service.js";

const temporaryDirectories: string[] = [];

function fixture(filename = ":memory:") {
  const database = new DesignerDatabase(filename);
  const events = new EventHub();
  const service = new DesignerService(database, events, 900);
  const enterprise = new EnterpriseService(database, events, { designerService: service });
  const created = service.createDesign("alice", {
    name: "Preview render metadata",
    preset: "phone",
    idempotencyKey: "preview-render-create-0001",
  });
  const pageId = created.document.pages[0]?.id;
  const frameId = created.document.pages[0]?.children[0];
  if (!pageId || !frameId) throw new Error("Starter page and frame were not created.");
  const preview = service.createPreview("alice", created.document.id, {
    baseVersion: 1,
    operations: [{ type: "update_node", node_id: frameId, patch: { name: "Rendered frame" } }],
  });
  return { database, service, enterprise, created, preview, pageId, frameId };
}

function temporaryDatabase(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "formaspec-preview-render-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "designer.sqlite");
}

function installPreviewGrant(database: DesignerDatabase, designId: string): string {
  const grantId = "preview_render_grant";
  const principalId = "principal_preview_render_grant";
  const actorId = `grant_${grantId}`;
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const scopes = JSON.stringify(["design:read", "design:preview", "task:claim", "task:update"]);
  const projects = JSON.stringify([designId]);
  database.sqlite.prepare(
    `INSERT INTO principals (id, organization_id, kind, display_name, external_id, created_at)
     VALUES (?, 'organization_legacy', 'agent', 'Preview renderer', 'preview-render-test', ?)`,
  ).run(principalId, now);
  database.sqlite.prepare(
    `INSERT INTO memberships (organization_id, principal_id, role, created_at)
     VALUES ('organization_legacy', ?, 'agent', ?)`,
  ).run(principalId, now);
  database.sqlite.prepare(
    `INSERT INTO agent_connections
     (id, organization_id, principal_id, adapter, display_name, status, scopes_json, project_ids_json,
      expires_at, created_at, updated_at)
     VALUES ('connection_preview_render_grant', 'organization_legacy', ?, 'codex', 'Preview renderer',
             'active', ?, ?, ?, ?, ?)`,
  ).run(principalId, scopes, projects, expiresAt, now, now);
  database.sqlite.prepare(
    `INSERT INTO agent_grants
     (id, organization_id, principal_id, token_hash, scopes_json, project_ids_json, created_at, expires_at)
     VALUES (?, 'organization_legacy', ?, ?, ?, ?, ?, ?)`,
  ).run(grantId, principalId, "a".repeat(64), scopes, projects, now, expiresAt);
  return actorId;
}

function png(width = 120, height = 80): Buffer {
  return encodeRgbaPng(width, height, Buffer.alloc(width * height * 4, 255));
}

function captureThrown(callback: () => unknown): unknown {
  try {
    callback();
  } catch (error) {
    return error;
  }
  throw new Error("Expected callback to throw.");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("exact preview render metadata", () => {
  it("purges retained expired preview rows before collecting their old exact PNGs on startup", () => {
    const filename = temporaryDatabase();
    const dataDirectory = path.dirname(filename);
    const store = new ContentAddressedPreviewRenderStore(dataDirectory);
    const database = new DesignerDatabase(filename);
    const events = new EventHub();
    const service = new DesignerService(database, events, 900, {}, undefined, store);
    const created = service.createDesign("alice", {
      name: "Expired exact preview",
      preset: "phone",
      idempotencyKey: "expired-preview-render-create-0001",
    });
    const pageId = created.document.pages[0]!.id;
    const frameId = created.document.pages[0]!.children[0]!;
    const preview = service.createPreview("alice", created.document.id, {
      baseVersion: 1,
      operations: [{ type: "update_node", node_id: frameId, patch: { name: "Expired frame" } }],
    });
    const output = png();
    const metadata = service.recordPreviewRenderMetadata("alice", created.document.id, preview.id, {
      options: { pageId, nodeId: frameId, maxSize: 128 },
      png: output,
      width: 120,
      height: 80,
      renderer: "software",
      warnings: [],
    });
    database.sqlite.prepare(
      "UPDATE previews SET status = 'expired', expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
    ).run(preview.id);
    const old = new Date("2000-01-02T00:00:00.000Z");
    fs.utimesSync(store.artifactPath(metadata.sha256), old, old);
    database.close();

    const reopened = new DesignerDatabase(filename);
    try {
      new DesignerService(reopened, new EventHub(), 900, {}, undefined, store);
      expect(reopened.sqlite.prepare("SELECT id FROM previews WHERE id = ?").get(preview.id)).toBeUndefined();
      expect(store.read(metadata.sha256)).toBeNull();
    } finally {
      reopened.close();
    }
  });

  it("records the PNG target and output exactly once and reads it after restart-safe persistence", () => {
    const { database, service, created, preview, pageId, frameId } = fixture();
    try {
      expect(preview.renderMetadata).toBeNull();
      const output = png();
      const capture = {
        options: { pageId, nodeId: frameId, maxSize: 128 },
        png: output,
        width: 120,
        height: 80,
        renderer: "software" as const,
        warnings: ["Deterministic test renderer."],
      };
      const recorded = service.recordPreviewRenderMetadata(
        "alice",
        created.document.id,
        preview.id,
        capture,
      );
      expect(recorded).toEqual({
        options: capture.options,
        width: 120,
        height: 80,
        renderer: "software",
        warnings: capture.warnings,
        sha256: createHash("sha256").update(output).digest("hex"),
      });
      expect(service.recordPreviewRenderMetadata(
        "alice",
        created.document.id,
        preview.id,
        capture,
      )).toEqual(recorded);
      expect(service.getPreview("alice", created.document.id, preview.id).renderMetadata).toEqual(recorded);
      expect(database.sqlite.prepare(
        "SELECT render_metadata_json FROM previews WHERE id = ?",
      ).get(preview.id)).toEqual({ render_metadata_json: canonicalJson(recorded) });

      expect(captureThrown(() => service.recordPreviewRenderMetadata(
        "alice",
        created.document.id,
        preview.id,
        { ...capture, options: { ...capture.options, maxSize: 256 } },
      ))).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      expect(() => database.sqlite.prepare(
        "UPDATE previews SET render_metadata_json = ? WHERE id = ?",
      ).run(canonicalJson({ ...recorded, width: 119 }), preview.id)).toThrow(/immutable once recorded/);
    } finally {
      database.close();
    }
  });

  it("rejects invalid IDs, limits, PNG bytes, dimensions, and oversized stored JSON", () => {
    const { database, service, created, preview, pageId, frameId } = fixture();
    const output = png();
    const valid = {
      options: { pageId, nodeId: frameId, maxSize: 128 },
      png: output,
      width: 120,
      height: 80,
      renderer: "playwright" as const,
      warnings: [],
    };
    try {
      expect(captureThrown(() => service.getExactPreviewForRender(
        "alice",
        created.document.id,
        preview.id,
      ))).toMatchObject({ code: "PREVIEW_ENGINE_MISMATCH" });
      const invalidCaptures = [
        { ...valid, options: { ...valid.options, pageId: `page_${"f".repeat(32)}` } },
        { ...valid, options: { ...valid.options, nodeId: `node_${"f".repeat(32)}` } },
        { ...valid, options: { ...valid.options, maxSize: 63 } },
        { ...valid, png: Buffer.from("not a png") },
        { ...valid, width: 119 },
      ];
      for (const capture of invalidCaptures) {
        expect(captureThrown(() => service.recordPreviewRenderMetadata(
          "alice",
          created.document.id,
          preview.id,
          capture,
        ))).toMatchObject({ code: "VALIDATION_FAILED" });
      }
      expect(service.getPreview("alice", created.document.id, preview.id).renderMetadata).toBeNull();
      expect(() => database.sqlite.prepare(
        "UPDATE previews SET render_metadata_json = ? WHERE id = ?",
      ).run(JSON.stringify({ value: "x".repeat(65_536) }), preview.id)).toThrow(/CHECK constraint failed/);
      expect(service.getPreview("alice", created.document.id, preview.id).renderMetadata).toBeNull();
    } finally {
      database.close();
    }
  });

  it("survives a file-database reopen and rejects incompatible renderer versions or changed PNG bytes", () => {
    const filename = temporaryDatabase();
    const { database, service, created, preview, pageId, frameId } = fixture(filename);
    const output = png();
    const capture = {
      options: { pageId, nodeId: frameId, maxSize: 128 },
      png: output,
      width: 120,
      height: 80,
      renderer: "software" as const,
      warnings: [],
    };
    const recorded = service.recordPreviewRenderMetadata("alice", created.document.id, preview.id, capture);
    database.close();

    const reopened = new DesignerDatabase(filename);
    try {
      const reopenedService = new DesignerService(reopened, new EventHub(), 900);
      expect(reopenedService.getPreview("alice", created.document.id, preview.id).renderMetadata).toEqual(recorded);
      expect(reopenedService.verifyExactPreviewRender("alice", created.document.id, preview.id, {
        png: output,
        width: 120,
        height: 80,
        renderer: "software",
        warnings: [],
      })).toEqual(recorded);
      const changed = encodeRgbaPng(120, 80, Buffer.alloc(120 * 80 * 4, 0));
      expect(captureThrown(() => reopenedService.verifyExactPreviewRender(
        "alice",
        created.document.id,
        preview.id,
        {
          png: changed,
          width: 120,
          height: 80,
          renderer: "software",
          warnings: [],
        },
      ))).toMatchObject({ code: "PREVIEW_ENGINE_MISMATCH" });
      const incompatible = new DesignerService(reopened, new EventHub(), 900, { renderer: "incompatible" });
      expect(captureThrown(() => incompatible.getExactPreviewForRender(
        "alice",
        created.document.id,
        preview.id,
      ))).toMatchObject({ code: "PREVIEW_ENGINE_MISMATCH" });
    } finally {
      reopened.close();
    }
  });

  it("rechecks preview scope, ownership, expiry, and lifecycle status at the metadata write boundary", () => {
    const owner = fixture();
    const capture = {
      options: { pageId: owner.pageId, nodeId: owner.frameId, maxSize: 128 },
      png: png(),
      width: 120,
      height: 80,
      renderer: "software" as const,
      warnings: [],
    };
    try {
      expect(captureThrown(() => owner.service.recordPreviewRenderMetadata(
        "bob",
        owner.created.document.id,
        owner.preview.id,
        capture,
      ))).toMatchObject({ code: "NOT_FOUND" });
      owner.database.sqlite.prepare(
        "UPDATE previews SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
      ).run(owner.preview.id);
      expect(captureThrown(() => owner.service.recordPreviewRenderMetadata(
        "alice",
        owner.created.document.id,
        owner.preview.id,
        capture,
      ))).toMatchObject({ code: "PREVIEW_EXPIRED" });
      expect(owner.database.sqlite.prepare(
        "SELECT render_metadata_json FROM previews WHERE id = ?",
      ).get(owner.preview.id)).toEqual({ render_metadata_json: null });
    } finally {
      owner.database.close();
    }

    const committed = fixture();
    try {
      committed.service.commitPreview("alice", committed.created.document.id, {
        previewId: committed.preview.id,
        expectedBaseVersion: 1,
        idempotencyKey: "preview-render-status-commit",
      });
      expect(captureThrown(() => committed.service.recordPreviewRenderMetadata(
        "alice",
        committed.created.document.id,
        committed.preview.id,
        {
          ...capture,
          options: { pageId: committed.pageId, nodeId: committed.frameId, maxSize: 128 },
        },
      ))).toMatchObject({ code: "PREVIEW_ALREADY_COMMITTED" });
    } finally {
      committed.database.close();
    }

    const granted = fixture();
    try {
      const actorId = installPreviewGrant(granted.database, granted.created.document.id);
      const task = granted.enterprise.createAgentTask("local", {
        designId: granted.created.document.id,
        brief: "Render one exact agent-owned preview",
        selection: [granted.frameId],
        baseVersion: 1,
        expectedOutput: "design_preview",
        idempotencyKey: "preview-render-agent-task-0001",
        expiresInSeconds: 3_600,
      });
      granted.enterprise.claimAgentTask(actorId, task.id);
      granted.enterprise.transitionAgentTask(actorId, task.id, {
        expectedStatus: "claimed",
        toStatus: "in_progress",
      });
      const agentPreview = granted.service.createPreview(actorId, granted.created.document.id, {
        baseVersion: 1,
        operations: [{
          type: "update_node",
          node_id: granted.frameId,
          patch: { name: "Agent render" },
        }],
        taskId: task.id,
      });
      granted.database.sqlite.prepare(
        "UPDATE agent_grants SET revoked_at = ? WHERE id = 'preview_render_grant'",
      ).run(new Date().toISOString());
      expect(captureThrown(() => granted.service.recordPreviewRenderMetadata(
        actorId,
        granted.created.document.id,
        agentPreview.id,
        {
          ...capture,
          options: { pageId: granted.pageId, nodeId: granted.frameId, maxSize: 128 },
        },
      ))).toMatchObject({ code: "AUTH_REQUIRED" });
      expect(granted.database.sqlite.prepare(
        "SELECT render_metadata_json FROM previews WHERE id = ?",
      ).get(agentPreview.id)).toEqual({ render_metadata_json: null });
    } finally {
      granted.database.close();
    }
  });
});
