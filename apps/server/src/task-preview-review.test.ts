import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { resolveAccess } from "./authorization.js";
import { loadConfig } from "./config.js";

function testConfig() {
  return loadConfig({
    APP_MODE: "local",
    HOST: "127.0.0.1",
    PORT: "4310",
    DATA_DIR: "/tmp/formaspec-task-preview-review-tests",
    BACKUP_DIR: "/tmp/formaspec-task-preview-review-backups",
    DESIGNER_DATABASE_PATH: ":memory:",
    PUBLIC_BASE_URL: "http://127.0.0.1:4310",
    AUTH_MODE: "none",
    FORMASPEC_ALLOW_SOFTWARE_RENDERER: "true",
    DESIGNER_LOG_LEVEL: "silent",
  });
}

function installAgent(application: DesignerApplication, designId: string) {
  const id = "task_preview_agent";
  const principalId = `principal_${id}`;
  const token = `fsg_${id}_token_0000000000000001`;
  const actorId = `grant_${id}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 60 * 60 * 1_000).toISOString();
  const scopes = ["design:read", "design:preview", "design:write", "task:read", "task:claim", "task:update"];
  application.database.sqlite.prepare(
    `INSERT INTO principals (id, organization_id, kind, display_name, external_id, created_at)
     VALUES (?, 'organization_legacy', 'agent', ?, ?, ?)`,
  ).run(principalId, id, `test:${id}`, now.toISOString());
  application.database.sqlite.prepare(
    `INSERT INTO memberships (organization_id, principal_id, role, created_at)
     VALUES ('organization_legacy', ?, 'agent', ?)`,
  ).run(principalId, now.toISOString());
  application.database.sqlite.prepare(
    `INSERT INTO agent_connections
     (id, organization_id, principal_id, adapter, display_name, status, scopes_json, project_ids_json,
      expires_at, created_at, updated_at)
     VALUES (?, 'organization_legacy', ?, 'codex', ?, 'active', ?, ?, ?, ?, ?)`,
  ).run(
    `connection_${id}`,
    principalId,
    id,
    JSON.stringify(scopes),
    JSON.stringify([designId]),
    expiresAt,
    now.toISOString(),
    now.toISOString(),
  );
  application.database.sqlite.prepare(
    `INSERT INTO agent_grants
     (id, organization_id, principal_id, token_hash, scopes_json, project_ids_json, created_at, expires_at)
     VALUES (?, 'organization_legacy', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    principalId,
    createHash("sha256").update(token).digest("hex"),
    JSON.stringify(scopes),
    JSON.stringify([designId]),
    now.toISOString(),
    expiresAt,
  );
  return { actorId, token };
}

function captureThrown(callback: () => unknown): unknown {
  try {
    callback();
  } catch (error) {
    return error;
  }
  throw new Error("Expected callback to throw.");
}

describe("task-scoped agent preview review", () => {
  let application: DesignerApplication;

  beforeEach(async () => {
    application = await buildApplication(testConfig());
    await application.app.ready();
  });

  afterEach(async () => {
    await application.app.close();
  });

  it("lets an authorized human read and commit only the preview linked by an awaiting-approval task", async () => {
    const created = application.service.createDesign("local", {
      name: "Agent review",
      preset: "phone",
      idempotencyKey: "task-preview-create-0001",
    });
    const designId = created.document.id;
    const frameId = created.document.pages[0]!.children[0]!;
    const agent = installAgent(application, designId);
    const task = application.enterprise.createAgentTask("local", {
      designId,
      brief: "Refine the checkout frame",
      selection: [frameId],
      baseVersion: 1,
      expectedOutput: "design_preview",
      idempotencyKey: "task-preview-task-0001",
      expiresInSeconds: 3_600,
    });
    application.enterprise.claimAgentTask(agent.actorId, task.id);
    application.enterprise.transitionAgentTask(agent.actorId, task.id, {
      expectedStatus: "claimed",
      toStatus: "in_progress",
      message: "Designing",
    });
    const preview = application.service.createPreview(agent.actorId, designId, {
      baseVersion: 1,
      operations: [{ type: "update_node", node_id: frameId, patch: { name: "Agent-refined checkout" } }],
    });

    const hiddenBeforeApproval = await application.app.inject({
      method: "GET",
      url: `/api/designs/${designId}/previews/${preview.id}?taskId=${task.id}`,
    });
    expect(hiddenBeforeApproval.statusCode).toBe(404);

    application.enterprise.transitionAgentTask(agent.actorId, task.id, {
      expectedStatus: "in_progress",
      toStatus: "awaiting_approval",
      message: "Ready for product-manager review",
      data: { previewId: preview.id },
    });

    const hiddenWithoutTask = await application.app.inject({
      method: "GET",
      url: `/api/designs/${designId}/previews/${preview.id}`,
    });
    expect(hiddenWithoutTask.statusCode).toBe(404);

    const readable = await application.app.inject({
      method: "GET",
      url: `/api/designs/${designId}/previews/${preview.id}?taskId=${task.id}`,
    });
    expect(readable.statusCode).toBe(200);
    expect(readable.json<{
      previewId: string;
      rootBaseVersion: number;
      changedNodeIds: string[];
      document: { nodes: Record<string, { name: string }> };
    }>()).toMatchObject({
      previewId: preview.id,
      rootBaseVersion: 1,
      changedNodeIds: [frameId],
      document: { nodes: { [frameId]: { name: "Agent-refined checkout" } } },
    });

    const viewer = resolveAccess(application.database.sqlite, "preview-viewer");
    application.database.sqlite.prepare(
      "UPDATE memberships SET role = 'viewer' WHERE organization_id = ? AND principal_id = ?",
    ).run(viewer.organizationId, viewer.principalId);
    expect(captureThrown(() => application.service.commitPreview("preview-viewer", designId, {
      previewId: preview.id,
      expectedBaseVersion: 1,
      idempotencyKey: "task-preview-viewer-commit-0001",
      message: "Viewer must not approve",
      taskId: task.id,
    }))).toMatchObject({ code: "FORBIDDEN", statusCode: 403 });

    const committed = await application.app.inject({
      method: "POST",
      url: `/api/designs/${designId}/previews/${preview.id}/commit`,
      payload: {
        expectedBaseVersion: 1,
        idempotencyKey: "task-preview-commit-0001",
        message: "Approve exact agent preview",
        taskId: task.id,
      },
    });
    expect(committed.statusCode).toBe(200);
    expect(committed.json<{ version: number; document: { nodes: Record<string, { name: string }> } }>()).toMatchObject({
      version: 2,
      document: { nodes: { [frameId]: { name: "Agent-refined checkout" } } },
    });

    const completed = application.enterprise.transitionAgentTask("local", task.id, {
      expectedStatus: "awaiting_approval",
      toStatus: "completed",
      message: "Approved",
      data: { previewId: preview.id },
    });
    expect(completed.status).toBe("completed");

    const committedPreview = await application.app.inject({
      method: "GET",
      url: `/api/designs/${designId}/previews/${preview.id}?taskId=${task.id}`,
    });
    expect(committedPreview.statusCode).toBe(200);
    expect(committedPreview.json<{ status: string; committedRevisionId: string | null }>()).toMatchObject({
      status: "committed",
      committedRevisionId: expect.stringMatching(/^revision_/),
    });
  });

  it("atomically expires a discarded task preview so its creating agent cannot commit it later", () => {
    const created = application.service.createDesign("local", {
      name: "Discard agent review",
      preset: "phone",
      idempotencyKey: "task-preview-discard-create-0001",
    });
    const designId = created.document.id;
    const frameId = created.document.pages[0]!.children[0]!;
    const agent = installAgent(application, designId);
    const task = application.enterprise.createAgentTask("local", {
      designId,
      brief: "Propose a disposable change",
      selection: [frameId],
      baseVersion: 1,
      expectedOutput: "design_preview",
      idempotencyKey: "task-preview-discard-task-0001",
      expiresInSeconds: 3_600,
    });
    application.enterprise.claimAgentTask(agent.actorId, task.id);
    application.enterprise.transitionAgentTask(agent.actorId, task.id, {
      expectedStatus: "claimed",
      toStatus: "in_progress",
    });
    const preview = application.service.createPreview(agent.actorId, designId, {
      baseVersion: 1,
      operations: [{ type: "update_node", node_id: frameId, patch: { name: "Discard me" } }],
    });
    application.enterprise.transitionAgentTask(agent.actorId, task.id, {
      expectedStatus: "in_progress",
      toStatus: "awaiting_approval",
      data: { previewId: preview.id },
    });

    const cancelled = application.enterprise.transitionAgentTask("local", task.id, {
      expectedStatus: "awaiting_approval",
      toStatus: "cancelled",
      message: "Discard without changing history",
      data: { previewId: preview.id, discarded: true },
    });
    expect(cancelled.status).toBe("cancelled");
    expect(application.database.sqlite.prepare(
      "SELECT status FROM previews WHERE id = ?",
    ).get(preview.id)).toEqual({ status: "expired" });
    expect(captureThrown(() => application.service.commitPreview(agent.actorId, designId, {
      previewId: preview.id,
      expectedBaseVersion: 1,
      idempotencyKey: "task-preview-discard-late-commit-0001",
    }))).toMatchObject({ code: "PREVIEW_EXPIRED", statusCode: 410 });
    expect(application.service.getDesign("local", designId).revision.version).toBe(1);
  });
});
