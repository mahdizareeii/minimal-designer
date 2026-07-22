import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { resolveAccess } from "./authorization.js";
import { loadConfig } from "./config.js";
import { encodeRgbaPng } from "./render.js";

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

function installAgent(application: DesignerApplication, designId: string, id = "task_preview_agent") {
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
  return { actorId, principalId, token };
}

function captureThrown(callback: () => unknown): unknown {
  try {
    callback();
  } catch (error) {
    return error;
  }
  throw new Error("Expected callback to throw.");
}

function persistExactRender(
  application: DesignerApplication,
  actorId: string,
  designId: string,
  previewId: string,
  pageId: string,
  nodeId: string,
): void {
  const width = 24;
  const height = 16;
  application.service.recordPreviewRenderMetadata(actorId, designId, previewId, {
    options: { pageId, nodeId, maxSize: 512 },
    png: encodeRgbaPng(width, height, Buffer.alloc(width * height * 4, 255)),
    width,
    height,
    renderer: "software",
    warnings: ["Deterministic task approval test render."],
  });
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
    const pageId = created.document.pages[0]!.id;
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
    persistExactRender(application, agent.actorId, designId, preview.id, pageId, frameId);

    expect(captureThrown(() => application.service.commitPreview(agent.actorId, designId, {
      previewId: preview.id,
      expectedBaseVersion: 1,
      idempotencyKey: "task-preview-agent-self-commit-0001",
      message: "Agent must not approve its own task preview",
      requireRenderEvidence: true,
    }))).toMatchObject({ code: "FORBIDDEN", statusCode: 403 });

    const listed = await application.app.inject({
      method: "GET",
      url: `/api/designs/${designId}/agent-tasks`,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ tasks: Array<{
      id: string;
      status: string;
      claimedBy: string | null;
      transitions: Array<{ toStatus: string; data: Record<string, unknown> }>;
    }> }>().tasks[0]).toMatchObject({
      id: task.id,
      status: "awaiting_approval",
      claimedBy: expect.stringMatching(/^principal_/),
      transitions: expect.arrayContaining([
        expect.objectContaining({ toStatus: "awaiting_approval", data: { previewId: preview.id } }),
      ]),
    });
    expect(application.database.sqlite.prepare(
      `SELECT event_type, payload_json FROM event_outbox
       WHERE event_type = 'agent_task.transitioned' ORDER BY id DESC LIMIT 1`,
    ).get()).toMatchObject({
      event_type: "agent_task.transitioned",
      payload_json: expect.stringContaining(`"taskId":"${task.id}"`),
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
    expect(captureThrown(() => application.enterprise.approveAgentTaskDesignPreview("preview-viewer", task.id, {
      designId,
      previewId: preview.id,
      expectedBaseVersion: 1,
      idempotencyKey: "task-preview-viewer-commit-0001",
      message: "Viewer must not approve",
    }))).toMatchObject({ code: "FORBIDDEN", statusCode: 403 });

    const editor = resolveAccess(application.database.sqlite, "preview-editor");
    application.database.sqlite.prepare(
      "UPDATE memberships SET role = 'design_editor' WHERE organization_id = ? AND principal_id = ?",
    ).run(editor.organizationId, editor.principalId);
    expect(captureThrown(() => application.enterprise.approveAgentTaskDesignPreview("preview-editor", task.id, {
      designId,
      previewId: preview.id,
      expectedBaseVersion: 1,
      idempotencyKey: "task-preview-editor-approval-0001",
      message: "Design editor must not approve",
    }))).toMatchObject({ code: "FORBIDDEN", statusCode: 403 });

    expect(captureThrown(() => application.enterprise.transitionAgentTask("local", task.id, {
      expectedStatus: "awaiting_approval",
      toStatus: "completed",
      message: "Generic completion must not bypass atomic approval",
      data: { previewId: preview.id },
    }))).toMatchObject({ code: "VALIDATION_FAILED", statusCode: 422 });

    const approvalRequest = {
      method: "POST",
      url: `/api/designs/${designId}/previews/${preview.id}/commit`,
      payload: {
        expectedBaseVersion: 1,
        idempotencyKey: "task-preview-commit-0001",
        message: "Approve exact agent preview",
        taskId: task.id,
      },
    } as const;
    const committed = await application.app.inject(approvalRequest);
    expect(committed.statusCode).toBe(200);
    const committedBody = committed.json<{
      version: number;
      revisionId: string;
      document: { nodes: Record<string, { name: string }> };
      task: { id: string; status: string };
    }>();
    expect(committedBody).toMatchObject({
      version: 2,
      document: { nodes: { [frameId]: { name: "Agent-refined checkout" } } },
      task: { id: task.id, status: "completed" },
    });

    const replay = await application.app.inject(approvalRequest);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toMatchObject({
      version: 2,
      revisionId: committedBody.revisionId,
      task: { id: task.id, status: "completed" },
    });
    expect(application.database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM revisions WHERE design_id = ? AND version = 2",
    ).get(designId)).toEqual({ count: 1 });

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

  it("rolls back atomic approval without persisting completion or idempotency when exact render evidence is missing", async () => {
    const created = application.service.createDesign("local", {
      name: "Atomic approval rollback",
      preset: "phone",
      idempotencyKey: "task-preview-rollback-create-0001",
    });
    const designId = created.document.id;
    const pageId = created.document.pages[0]!.id;
    const frameId = created.document.pages[0]!.children[0]!;
    const agent = installAgent(application, designId);
    const task = application.enterprise.createAgentTask("local", {
      designId,
      brief: "Return an exact preview that needs approval",
      selection: [frameId],
      baseVersion: 1,
      expectedOutput: "design_preview",
      idempotencyKey: "task-preview-rollback-task-0001",
      expiresInSeconds: 3_600,
    });
    application.enterprise.claimAgentTask(agent.actorId, task.id);
    application.enterprise.transitionAgentTask(agent.actorId, task.id, {
      expectedStatus: "claimed",
      toStatus: "in_progress",
    });
    const preview = application.service.createPreview(agent.actorId, designId, {
      baseVersion: 1,
      operations: [{ type: "update_node", node_id: frameId, patch: { name: "Needs render evidence" } }],
    });
    application.enterprise.transitionAgentTask(agent.actorId, task.id, {
      expectedStatus: "in_progress",
      toStatus: "awaiting_approval",
      data: { previewId: preview.id },
    });

    const payload = {
      expectedBaseVersion: 1,
      idempotencyKey: "task-preview-rollback-approval-0001",
      message: "Approve only with exact evidence",
      taskId: task.id,
    };
    const rejected = await application.app.inject({
      method: "POST",
      url: `/api/designs/${designId}/previews/${preview.id}/commit`,
      payload,
    });
    expect(rejected.statusCode, rejected.body).toBe(409);
    expect(rejected.json()).toMatchObject({ error: { code: "PREVIEW_ENGINE_MISMATCH" } });
    expect(application.service.getDesign("local", designId).revision.version).toBe(1);
    expect(application.database.sqlite.prepare("SELECT status FROM previews WHERE id = ?").get(preview.id)).toEqual({ status: "ready" });
    expect(application.enterprise.readAgentTask("local", task.id).status).toBe("awaiting_approval");
    expect(application.database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM agent_task_transitions WHERE task_id = ? AND to_status = 'completed'",
    ).get(task.id)).toEqual({ count: 0 });
    expect(application.database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM idempotency WHERE scope = ? AND key = ?",
    ).get(`task:${task.id}:approve-design-preview`, payload.idempotencyKey)).toEqual({ count: 0 });

    persistExactRender(application, agent.actorId, designId, preview.id, pageId, frameId);
    const retried = await application.app.inject({
      method: "POST",
      url: `/api/designs/${designId}/previews/${preview.id}/commit`,
      payload,
    });
    expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.json()).toMatchObject({ version: 2, task: { id: task.id, status: "completed" } });
  });

  it("rolls back revision, preview, task, audit, outbox, and idempotency when completion insertion fails after the design write", async () => {
    const created = application.service.createDesign("local", {
      name: "Post-write atomic rollback",
      preset: "phone",
      idempotencyKey: "task-preview-postwrite-create-0001",
    });
    const designId = created.document.id;
    const pageId = created.document.pages[0]!.id;
    const frameId = created.document.pages[0]!.children[0]!;
    const agent = installAgent(application, designId);
    const task = application.enterprise.createAgentTask("local", {
      designId,
      brief: "Prove approval rollback after the design write",
      selection: [frameId],
      baseVersion: 1,
      expectedOutput: "design_preview",
      idempotencyKey: "task-preview-postwrite-task-0001",
      expiresInSeconds: 3_600,
    });
    application.enterprise.claimAgentTask(agent.actorId, task.id);
    application.enterprise.transitionAgentTask(agent.actorId, task.id, {
      expectedStatus: "claimed",
      toStatus: "in_progress",
    });
    const preview = application.service.createPreview(agent.actorId, designId, {
      baseVersion: 1,
      operations: [{ type: "update_node", node_id: frameId, patch: { name: "Must roll back" } }],
    });
    application.enterprise.transitionAgentTask(agent.actorId, task.id, {
      expectedStatus: "in_progress",
      toStatus: "awaiting_approval",
      data: { previewId: preview.id },
    });
    persistExactRender(application, agent.actorId, designId, preview.id, pageId, frameId);
    const before = {
      audits: (application.database.sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as { count: number }).count,
      outbox: (application.database.sqlite.prepare("SELECT COUNT(*) AS count FROM event_outbox").get() as { count: number }).count,
    };
    application.database.sqlite.exec(`
      CREATE TRIGGER force_task_approval_completion_failure
      BEFORE INSERT ON agent_task_transitions
      WHEN NEW.to_status = 'completed'
      BEGIN SELECT RAISE(ABORT, 'forced task approval completion failure'); END;
    `);
    const payload = {
      expectedBaseVersion: 1,
      idempotencyKey: "task-preview-postwrite-approval-0001",
      message: "Approval must be all-or-nothing",
      taskId: task.id,
    };
    const rejected = await application.app.inject({
      method: "POST",
      url: `/api/designs/${designId}/previews/${preview.id}/commit`,
      payload,
    });
    expect(rejected.statusCode, rejected.body).toBe(500);
    expect(application.service.getDesign("local", designId).revision.version).toBe(1);
    expect(application.database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM revisions WHERE design_id = ?",
    ).get(designId)).toEqual({ count: 1 });
    expect(application.database.sqlite.prepare(
      "SELECT status, committed_revision_id FROM previews WHERE id = ?",
    ).get(preview.id)).toEqual({ status: "ready", committed_revision_id: null });
    expect(application.enterprise.readAgentTask("local", task.id).status).toBe("awaiting_approval");
    expect(application.database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM agent_task_transitions WHERE task_id = ? AND to_status = 'completed'",
    ).get(task.id)).toEqual({ count: 0 });
    expect(application.database.sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events").get()).toEqual({ count: before.audits });
    expect(application.database.sqlite.prepare("SELECT COUNT(*) AS count FROM event_outbox").get()).toEqual({ count: before.outbox });
    expect(application.database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM idempotency WHERE scope = ? AND key = ?",
    ).get(`task:${task.id}:approve-design-preview`, payload.idempotencyKey)).toEqual({ count: 0 });

    application.database.sqlite.exec("DROP TRIGGER force_task_approval_completion_failure");
    const retried = await application.app.inject({
      method: "POST",
      url: `/api/designs/${designId}/previews/${preview.id}/commit`,
      payload,
    });
    expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.json()).toMatchObject({ version: 2, task: { status: "completed" } });
  });

  it("durably expires an awaiting task when human approval arrives after its deadline", async () => {
    const created = application.service.createDesign("local", {
      name: "Expired human approval",
      preset: "phone",
      idempotencyKey: "expired-human-approval-create-0001",
    });
    const designId = created.document.id;
    const pageId = created.document.pages[0]!.id;
    const frameId = created.document.pages[0]!.children[0]!;
    const agent = installAgent(application, designId);
    const preview = application.service.createPreview(agent.actorId, designId, {
      baseVersion: 1,
      operations: [{ type: "update_node", node_id: frameId, patch: { name: "Too late to approve" } }],
    });
    persistExactRender(application, agent.actorId, designId, preview.id, pageId, frameId);
    const taskId = "task_expired_human_approval_0001";
    const local = resolveAccess(application.database.sqlite, "local");
    const createdAt = "2000-01-01T00:00:00.000Z";
    application.database.sqlite.prepare(
      `INSERT INTO agent_tasks
       (id, organization_id, design_id, actor_id, brief, selection_json, base_version,
        expected_output, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 'design_preview', ?, '2000-01-01T01:00:00.000Z')`,
    ).run(taskId, local.organizationId, designId, local.principalId, "Expired exact preview approval", JSON.stringify([frameId]), createdAt);
    const insertTransition = application.database.sqlite.prepare(
      `INSERT INTO agent_task_transitions
       (id, task_id, from_status, to_status, actor_id, message, data_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertTransition.run("transition_expired_human_queued_0001", taskId, null, "queued", local.principalId, "Task created", "{}", createdAt);
    insertTransition.run("transition_expired_human_claimed_0001", taskId, "queued", "claimed", agent.principalId, "Task claimed", "{}", createdAt);
    insertTransition.run("transition_expired_human_progress_0001", taskId, "claimed", "in_progress", agent.principalId, "Task started", "{}", createdAt);
    insertTransition.run(
      "transition_expired_human_approval_0001",
      taskId,
      "in_progress",
      "awaiting_approval",
      agent.principalId,
      "Ready too late",
      JSON.stringify({ previewId: preview.id }),
      createdAt,
    );
    const beforeOutbox = (application.database.sqlite.prepare("SELECT COUNT(*) AS count FROM event_outbox").get() as { count: number }).count;
    const rejected = await application.app.inject({
      method: "POST",
      url: `/api/designs/${designId}/previews/${preview.id}/commit`,
      payload: {
        expectedBaseVersion: 1,
        idempotencyKey: "expired-human-approval-commit-0001",
        message: "Late human approval",
        taskId,
      },
    });
    expect(rejected.statusCode, rejected.body).toBe(410);
    expect(rejected.json()).toMatchObject({ error: { code: "TASK_EXPIRED" } });
    expect(application.service.getDesign("local", designId).revision.version).toBe(1);
    expect(application.database.sqlite.prepare(
      "SELECT status, committed_revision_id FROM previews WHERE id = ?",
    ).get(preview.id)).toEqual({ status: "ready", committed_revision_id: null });
    const expiredTask = application.enterprise.readAgentTask("local", taskId);
    expect(expiredTask.status).toBe("expired");
    expect(expiredTask.transitions.at(-1)).toMatchObject({
      fromStatus: "awaiting_approval",
      toStatus: "expired",
      data: { previewId: preview.id },
    });
    expect((application.database.sqlite.prepare("SELECT COUNT(*) AS count FROM event_outbox").get() as { count: number }).count)
      .toBe(beforeOutbox + 1);
    expect(application.database.sqlite.prepare(
      "SELECT action, target_id FROM audit_events WHERE target_id = ? ORDER BY rowid DESC LIMIT 1",
    ).get(taskId)).toEqual({ action: "agent_task.expire", target_id: taskId });
    expect(application.database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM idempotency WHERE scope = ? AND key = ?",
    ).get(`task:${taskId}:approve-design-preview`, "expired-human-approval-commit-0001")).toEqual({ count: 0 });
  });

  it("requires compatible persisted render evidence for ordinary and archive REST commits", async () => {
    const cases = [
      { kind: "ordinary" as const, incompatible: false },
      { kind: "archive" as const, incompatible: false },
      { kind: "ordinary" as const, incompatible: true },
      { kind: "archive" as const, incompatible: true },
    ];
    for (const [index, testCase] of cases.entries()) {
      const created = application.service.createDesign("local", {
        name: `REST evidence ${index}`,
        preset: "phone",
        idempotencyKey: `rest-evidence-create-${index}-0001`,
      });
      const designId = created.document.id;
      const pageId = created.document.pages[0]!.id;
      const frameId = created.document.pages[0]!.children[0]!;
      const operations = testCase.kind === "archive"
        ? [{ type: "archive_nodes" as const, node_ids: [frameId] }]
        : [{ type: "update_node" as const, node_id: frameId, patch: { name: `Evidence ${index}` } }];
      const preview = application.service.createPreview("local", designId, {
        baseVersion: 1,
        operations,
        kind: testCase.kind,
      });
      if (testCase.incompatible) {
        persistExactRender(application, "local", designId, preview.id, pageId, frameId);
        application.database.sqlite.prepare(
          "UPDATE previews SET renderer_version = 'incompatible-test-renderer' WHERE id = ?",
        ).run(preview.id);
      }
      const previewPath = testCase.kind === "archive" ? "archive-previews" : "previews";
      const response = await application.app.inject({
        method: "POST",
        url: `/api/designs/${designId}/${previewPath}/${preview.id}/commit`,
        payload: {
          expectedBaseVersion: 1,
          idempotencyKey: `rest-evidence-commit-${index}-0001`,
          message: "Commit only exact evidence",
        },
      });
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: "PREVIEW_ENGINE_MISMATCH" } });
      expect(application.service.getDesign("local", designId).revision.version).toBe(1);
      expect(application.database.sqlite.prepare("SELECT status FROM previews WHERE id = ?").get(preview.id)).toEqual({ status: "ready" });
    }
  });

  it("does not overblock an unrelated direct preview after a matching task expires without a transition", () => {
    const created = application.service.createDesign("local", {
      name: "Expired task direct preview",
      preset: "phone",
      idempotencyKey: "expired-task-direct-create-0001",
    });
    const designId = created.document.id;
    const pageId = created.document.pages[0]!.id;
    const frameId = created.document.pages[0]!.children[0]!;
    const agent = installAgent(application, designId);
    const taskId = "task_expired_without_transition_0001";
    const local = resolveAccess(application.database.sqlite, "local");
    const now = new Date().toISOString();
    application.database.sqlite.prepare(
      `INSERT INTO agent_tasks
       (id, organization_id, design_id, actor_id, brief, selection_json, base_version,
        expected_output, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 'design_preview', ?, '2000-01-01T00:00:00.000Z')`,
    ).run(taskId, local.organizationId, designId, local.principalId, "Expired task without an expiry transition", JSON.stringify([frameId]), now);
    const insertTransition = application.database.sqlite.prepare(
      `INSERT INTO agent_task_transitions
       (id, task_id, from_status, to_status, actor_id, message, data_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, '{}', ?)`,
    );
    insertTransition.run("transition_expired_queued_0001", taskId, null, "queued", local.principalId, "Task created", now);
    insertTransition.run("transition_expired_claimed_0001", taskId, "queued", "claimed", agent.principalId, "Task claimed", now);
    insertTransition.run("transition_expired_progress_0001", taskId, "claimed", "in_progress", agent.principalId, "Task started", now);
    const preview = application.service.createPreview(agent.actorId, designId, {
      baseVersion: 1,
      operations: [{ type: "update_node", node_id: frameId, patch: { name: "Independent direct preview" } }],
    });
    persistExactRender(application, agent.actorId, designId, preview.id, pageId, frameId);
    const committed = application.service.commitPreview(agent.actorId, designId, {
      previewId: preview.id,
      expectedBaseVersion: 1,
      idempotencyKey: "expired-task-direct-commit-0001",
      message: "Commit unrelated direct preview",
      requireRenderEvidence: true,
    });
    expect(committed.revision.version).toBe(2);
  });

  it("reserves every unexpired claimed design task against agent commits, revisions, restores, and early expiry", () => {
    const direct = application.service.createDesign("local", {
      name: "Unreserved direct restore",
      preset: "phone",
      idempotencyKey: "unreserved-direct-restore-create-0001",
    });
    const directFrameId = direct.document.pages[0]!.children[0]!;
    const directAgent = installAgent(application, direct.document.id, "task_preview_direct_restore_agent");
    application.service.applyRevision(directAgent.actorId, direct.document.id, {
      baseVersion: 1,
      operations: [{ type: "update_node", node_id: directFrameId, patch: { name: "Direct version two" } }],
      idempotencyKey: "unreserved-direct-revision-0001",
    });
    const restored = application.service.restoreRevision(directAgent.actorId, direct.document.id, {
      targetVersion: 1,
      expectedBaseVersion: 2,
      idempotencyKey: "unreserved-direct-restore-0001",
    });
    expect(restored.revision.version).toBe(3);

    for (const [index, terminal] of (["failed", "cancelled"] as const).entries()) {
      const created = application.service.createDesign("local", {
        name: `Reserved ${terminal}`,
        preset: "phone",
        idempotencyKey: `reserved-${terminal}-create-${index}-0001`,
      });
      const designId = created.document.id;
      const pageId = created.document.pages[0]!.id;
      const frameId = created.document.pages[0]!.children[0]!;
      const agent = installAgent(application, designId, `task_preview_reserved_${terminal}_${index}`);
      const task = application.enterprise.createAgentTask("local", {
        designId,
        brief: `Attempt terminal ${terminal} bypass`,
        selection: [frameId],
        baseVersion: 1,
        expectedOutput: "design_preview",
        idempotencyKey: `reserved-${terminal}-task-${index}-0001`,
        expiresInSeconds: 3_600,
      });
      application.enterprise.claimAgentTask(agent.actorId, task.id);
      application.enterprise.transitionAgentTask(agent.actorId, task.id, {
        expectedStatus: "claimed",
        toStatus: "in_progress",
      });
      const preview = application.service.createPreview(agent.actorId, designId, {
        baseVersion: 1,
        operations: [{ type: "update_node", node_id: frameId, patch: { name: `Reserved ${terminal} preview` } }],
      });
      persistExactRender(application, agent.actorId, designId, preview.id, pageId, frameId);
      application.enterprise.transitionAgentTask(agent.actorId, task.id, {
        expectedStatus: "in_progress",
        toStatus: terminal,
        data: {},
      });
      expect(captureThrown(() => application.service.commitPreview(agent.actorId, designId, {
        previewId: preview.id,
        expectedBaseVersion: 1,
        idempotencyKey: `reserved-${terminal}-commit-${index}-0001`,
        requireRenderEvidence: true,
      }))).toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
      expect(captureThrown(() => application.service.applyRevision(agent.actorId, designId, {
        baseVersion: 1,
        operations: [{ type: "update_node", node_id: frameId, patch: { name: "Bypass revision" } }],
        idempotencyKey: `reserved-${terminal}-revision-${index}-0001`,
      }))).toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
      expect(captureThrown(() => application.service.restoreRevision(agent.actorId, designId, {
        targetVersion: 1,
        expectedBaseVersion: 1,
        idempotencyKey: `reserved-${terminal}-restore-${index}-0001`,
      }))).toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
    }

    const early = application.service.createDesign("local", {
      name: "Early expiry reservation",
      preset: "phone",
      idempotencyKey: "reserved-early-expiry-create-0001",
    });
    const earlyFrameId = early.document.pages[0]!.children[0]!;
    const earlyAgent = installAgent(application, early.document.id, "task_preview_early_expiry_agent");
    const earlyTask = application.enterprise.createAgentTask("local", {
      designId: early.document.id,
      brief: "Attempt to expire before the deadline",
      selection: [earlyFrameId],
      baseVersion: 1,
      expectedOutput: "design_preview",
      idempotencyKey: "reserved-early-expiry-task-0001",
      expiresInSeconds: 3_600,
    });
    application.enterprise.claimAgentTask(earlyAgent.actorId, earlyTask.id);
    application.enterprise.transitionAgentTask(earlyAgent.actorId, earlyTask.id, {
      expectedStatus: "claimed",
      toStatus: "in_progress",
    });
    expect(captureThrown(() => application.enterprise.transitionAgentTask(earlyAgent.actorId, earlyTask.id, {
      expectedStatus: "in_progress",
      toStatus: "expired",
      data: {},
    }))).toMatchObject({ code: "VALIDATION_FAILED", statusCode: 422 });
    expect(application.enterprise.readAgentTask("local", earlyTask.id).status).toBe("in_progress");
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
    }))).toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
    expect(application.service.getDesign("local", designId).revision.version).toBe(1);
  });
});
