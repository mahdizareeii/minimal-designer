import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PLANNING_SECTIONS } from "@designer/core";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { resolveAccess } from "./authorization.js";
import { DesignerDatabase } from "./db/database.js";
import { EnterpriseService } from "./enterprise-service.js";
import { EventHub } from "./events.js";
import { DEFAULT_ORGANIZATION_POLICY } from "./organization-policy-model.js";
import { OrganizationPolicyService } from "./organization-policy-service.js";
import { encodeRgbaPng } from "./render.js";
import { DesignerService } from "./service.js";
import { designReadinessFixture } from "../test-fixtures/product.js";

const temporaryDirectories: string[] = [];

function databasePath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "formaspec-enterprise-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "designer.sqlite");
}

function setup(filename = ":memory:") {
  const database = new DesignerDatabase(filename);
  const events = new EventHub();
  const designer = new DesignerService(database, events, 900);
  const enterprise = new EnterpriseService(database, events, { designerService: designer });
  const created = designer.createDesign("local", {
    name: "Enterprise workflow",
    preset: "phone",
    idempotencyKey: `create-${Math.random()}`,
  });
  const frameId = created.document.pages[0]?.children[0];
  if (!frameId) throw new Error("Starter frame was not created.");
  return { database, events, designer, enterprise, created, frameId };
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

describe("enterprise workflow migration", () => {
  it("catches up a database that recorded v3 before product_spec_previews existed", () => {
    const filename = databasePath();
    const first = new DesignerDatabase(filename);
    first.close();

    const simulatedV5 = new Database(filename);
    simulatedV5.exec(`
      DROP TRIGGER schema_migrations_immutable_update;
      DROP TRIGGER schema_migrations_immutable_delete;
      DROP TABLE product_spec_previews;
      DELETE FROM schema_migrations WHERE version >= 6;
    `);
    simulatedV5.close();

    const migrated = new DesignerDatabase(filename);
    try {
      expect(migrated.schemaVersion()).toBe(18);
      expect(migrated.sqlite.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'product_spec_previews'",
      ).get()).toEqual({ name: "product_spec_previews" });
      expect(migrated.sqlite.prepare(
        "SELECT name FROM schema_migrations WHERE version = 6",
      ).get()).toEqual({ name: "enterprise_workflow_integrity" });
      expect(migrated.sqlite.prepare(
        "SELECT name FROM schema_migrations WHERE version = 7",
      ).get()).toEqual({ name: "enterprise_delivery_operations" });
      expect(migrated.sqlite.prepare(
        "SELECT name FROM schema_migrations WHERE version = 8",
      ).get()).toEqual({ name: "enterprise_domain_models" });
      expect(migrated.sqlite.prepare(
        "SELECT name FROM schema_migrations WHERE version = 9",
      ).get()).toEqual({ name: "audit_retention_execution" });
      expect(migrated.sqlite.prepare(
        "SELECT name FROM schema_migrations WHERE version = 10",
      ).get()).toEqual({ name: "portable_import_provenance" });
    } finally {
      migrated.close();
    }
  });
});

describe("product specification workflow", () => {
  it("commits the exact canonical preview, is idempotent, and rejects stale writes", () => {
    const opened = setup();
    try {
      const designId = opened.created.document.id;
      const preview = opened.enterprise.previewProductSpecification("local", {
        designId,
        baseVersion: 0,
        naturalLanguageBrief: "A bilingual checkout flow with guarded refunds.",
      });
      const stalePreview = opened.enterprise.previewProductSpecification("local", {
        designId,
        baseVersion: 0,
        specification: {
          id: "spec_stale12345678",
          version: 1,
          natural_language_brief: "A stale alternative",
        },
      });
      expect(preview.resultVersion).toBe(1);
      expect(preview.canCommit).toBe(true);
      expect(preview.diagnostics.map((item) => item.code)).toEqual([
        "SPEC_GOALS_MISSING",
        "SPEC_FLOWS_MISSING",
        "SPEC_ACCEPTANCE_MISSING",
      ]);

      const persistedPreview = opened.database.sqlite.prepare(
        "SELECT specification_json, specification_hash FROM product_spec_previews WHERE id = ?",
      ).get(preview.id) as { specification_json: string; specification_hash: string };
      const committed = opened.enterprise.commitProductSpecificationPreview("local", {
        designId,
        previewId: preview.id,
        expectedBaseVersion: 0,
        idempotencyKey: "commit-specification-0001",
        message: "Save the PM brief",
      });
      const persistedSpecification = opened.database.sqlite.prepare(
        "SELECT specification_json, specification_hash FROM product_specifications WHERE design_id = ? AND version = 1",
      ).get(designId) as { specification_json: string; specification_hash: string };
      expect(persistedSpecification).toEqual(persistedPreview);
      expect(committed.specificationHash).toBe(preview.specificationHash);
      expect(committed.specification).toEqual(preview.specification);

      const restartedEnterprise = new EnterpriseService(opened.database, opened.events);
      const replay = restartedEnterprise.commitProductSpecificationPreview("local", {
        designId,
        previewId: preview.id,
        expectedBaseVersion: 0,
        idempotencyKey: "commit-specification-0001",
        message: "Save the PM brief",
      });
      expect(replay).toEqual(committed);

      expect(captureThrown(() => opened.enterprise.commitProductSpecificationPreview("local", {
        designId,
        previewId: stalePreview.id,
        expectedBaseVersion: 0,
        idempotencyKey: "commit-stale-specification",
      }))).toMatchObject({ code: "VERSION_CONFLICT", statusCode: 409 });
      expect(() => opened.database.sqlite.prepare(
        "UPDATE product_specifications SET message = 'tamper' WHERE design_id = ?",
      ).run(designId)).toThrow(/immutable/);
      expect(opened.enterprise.readProductSpecification("local", designId)).toEqual(committed);
    } finally {
      opened.database.close();
    }
  });

  it("replays an exact product-spec commit after a database restart", () => {
    const filename = databasePath();
    const opened = setup(filename);
    const designId = opened.created.document.id;
    const preview = opened.enterprise.previewProductSpecification("local", {
      designId,
      baseVersion: 0,
      naturalLanguageBrief: "Restart-safe exact commit",
    });
    const request = {
      designId,
      previewId: preview.id,
      expectedBaseVersion: 0,
      idempotencyKey: "restart-safe-product-spec",
      message: "Persist across restart",
    };
    const committed = opened.enterprise.commitProductSpecificationPreview("local", request);
    opened.database.close();

    const reopenedDatabase = new DesignerDatabase(filename);
    try {
      const reopened = new EnterpriseService(reopenedDatabase, new EventHub());
      expect(reopened.commitProductSpecificationPreview("local", request)).toEqual(committed);
    } finally {
      reopenedDatabase.close();
    }
  });

  it("enforces role authorization at the service boundary", () => {
    const opened = setup();
    try {
      const designId = opened.created.document.id;
      resolveAccess(opened.database.sqlite, "viewer-user");
      opened.database.sqlite.prepare(
        `UPDATE memberships SET role = 'viewer'
         WHERE principal_id = (SELECT id FROM principals WHERE external_id = 'viewer-user')`,
      ).run();
      expect(captureThrown(() => opened.enterprise.previewProductSpecification("viewer-user", {
        designId,
        baseVersion: 0,
        naturalLanguageBrief: "Viewer cannot write",
      }))).toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
    } finally {
      opened.database.close();
    }
  });
});

describe("22-section planning workflow", () => {
  it("keeps append-only answer and session versions and requires every section before review", () => {
    const opened = setup();
    try {
      let planning = opened.enterprise.createPlanningSession("local", {
        designId: opened.created.document.id,
        idempotencyKey: "planning-session-0001",
      });
      expect(planning.sectionCount).toBe(22);
      expect(PLANNING_SECTIONS).toHaveLength(22);
      expect(planning.session.version).toBe(1);

      planning = opened.enterprise.savePlanningAnswer("local", planning.session.id, {
        expectedVersion: 1,
        section: PLANNING_SECTIONS[0],
        answer: "First answer",
      });
      planning = opened.enterprise.savePlanningAnswer("local", planning.session.id, {
        expectedVersion: 2,
        section: PLANNING_SECTIONS[0],
        answer: "Edited answer",
      });
      expect(planning.session.answers).toEqual([
        expect.objectContaining({ section: PLANNING_SECTIONS[0], version: 2, answer: "Edited answer" }),
      ]);
      expect(planning.versions).toHaveLength(3);
      expect(captureThrown(() => opened.enterprise.transitionPlanningSession("local", planning.session.id, {
        expectedVersion: 3,
        status: "ready_for_review",
      }))).toMatchObject({ code: "VALIDATION_FAILED" });

      for (const [index, section] of PLANNING_SECTIONS.slice(1).entries()) {
        planning = opened.enterprise.savePlanningAnswer("local", planning.session.id, {
          expectedVersion: planning.session.version,
          section,
          answer: `Answer ${index + 2}`,
          ...(section === PLANNING_SECTIONS.at(-1) ? { status: "ready_for_review" as const } : {}),
        });
      }
      expect(planning.answeredSections).toEqual(PLANNING_SECTIONS);
      expect(planning.session.status).toBe("ready_for_review");
      planning = opened.enterprise.transitionPlanningSession("local", planning.session.id, {
        expectedVersion: planning.session.version,
        status: "completed",
      });
      expect(planning.session.status).toBe("completed");
      expect(planning.versions).toHaveLength(25);
      expect(() => opened.database.sqlite.prepare(
        "UPDATE planning_session_versions SET status = 'cancelled' WHERE session_id = ? AND version = 1",
      ).run(planning.session.id)).toThrow(/immutable/);
    } finally {
      opened.database.close();
    }
  });
});

describe("immutable agent task workflow", () => {
  it("allows only one nonterminal design-preview task per project and preserves idempotent retries", () => {
    const opened = setup();
    try {
      const input = {
        designId: opened.created.document.id,
        brief: "First active proposal",
        baseVersion: 1,
        expectedOutput: "design_preview" as const,
        idempotencyKey: "single-active-task-0001",
      };
      const first = opened.enterprise.createAgentTask("local", input);
      expect(opened.enterprise.createAgentTask("local", input)).toEqual(first);

      expect(captureThrown(() => opened.enterprise.createAgentTask("local", {
        ...input,
        brief: "Conflicting proposal",
        idempotencyKey: "single-active-task-0002",
      }))).toMatchObject({
        code: "TASK_STATE_CONFLICT",
        statusCode: 409,
        retryable: false,
        details: {
          designId: opened.created.document.id,
          expectedOutput: "design_preview",
          activeTaskId: first.id,
          activeStatus: "queued",
          activeBaseVersion: 1,
          activeTaskIds: [first.id],
        },
      });

      opened.enterprise.transitionAgentTask("local", first.id, {
        expectedStatus: "queued",
        toStatus: "cancelled",
      });
      const next = opened.enterprise.createAgentTask("local", {
        ...input,
        brief: "Replacement proposal",
        idempotencyKey: "single-active-task-0003",
      });
      expect(next).toMatchObject({ status: "queued", designId: opened.created.document.id });
      expect(next.id).not.toBe(first.id);
    } finally {
      opened.database.close();
    }
  });

  it("materializes an expired active task before accepting its replacement", () => {
    const opened = setup();
    try {
      const first = opened.enterprise.createAgentTask("local", {
        designId: opened.created.document.id,
        brief: "Short-lived proposal",
        baseVersion: 1,
        expectedOutput: "design_preview",
        idempotencyKey: "expired-active-task-0001",
        expiresInSeconds: 60,
      });
      const future = new EnterpriseService(opened.database, opened.events, {
        designerService: opened.designer,
        now: () => new Date(Date.now() + 120_000),
      });
      const replacement = future.createAgentTask("local", {
        designId: opened.created.document.id,
        brief: "Replacement after expiry",
        baseVersion: 1,
        expectedOutput: "design_preview",
        idempotencyKey: "expired-active-task-0002",
      });
      expect(replacement.status).toBe("queued");
      expect(future.readAgentTask("local", first.id)).toMatchObject({
        status: "expired",
        transitions: expect.arrayContaining([
          expect.objectContaining({ toStatus: "expired", data: { reason: "expired" } }),
        ]),
      });
    } finally {
      opened.database.close();
    }
  });

  it("materializes a stale queued task before accepting a task pinned to the new head", () => {
    const opened = setup();
    try {
      const stale = opened.enterprise.createAgentTask("local", {
        designId: opened.created.document.id,
        brief: "Queued against the old head",
        baseVersion: 1,
        expectedOutput: "design_preview",
        idempotencyKey: "stale-active-task-0001",
      });
      opened.designer.applyRevision("local", opened.created.document.id, {
        baseVersion: 1,
        operations: [{ type: "update_node", node_id: opened.frameId, patch: { name: "Version two" } }],
        idempotencyKey: "stale-active-task-head-0001",
      });
      const replacement = opened.enterprise.createAgentTask("local", {
        designId: opened.created.document.id,
        brief: "Pinned to the new head",
        baseVersion: 2,
        expectedOutput: "design_preview",
        idempotencyKey: "stale-active-task-0002",
      });
      expect(replacement).toMatchObject({ status: "queued", baseVersion: 2 });
      expect(opened.enterprise.readAgentTask("local", stale.id)).toMatchObject({
        status: "cancelled",
        transitions: expect.arrayContaining([
          expect.objectContaining({
            toStatus: "cancelled",
            data: { reason: "stale_base", expectedBaseVersion: 1, currentVersion: 2 },
          }),
        ]),
      });
    } finally {
      opened.database.close();
    }
  });

  it("claims a task, validates the expected output, and preserves its transition chain", () => {
    const opened = setup();
    try {
      expect(captureThrown(() => opened.enterprise.createAgentTask("local", {
        designId: opened.created.document.id,
        brief: "Invalid selection",
        selection: ["node_missing12345678"],
        baseVersion: 1,
        expectedOutput: "design_preview",
        idempotencyKey: "task-invalid-selection",
      }))).toMatchObject({ code: "VALIDATION_FAILED" });
      const task = opened.enterprise.createAgentTask("local", {
        designId: opened.created.document.id,
        brief: "Create a clearer checkout summary",
        selection: [opened.frameId],
        baseVersion: 1,
        expectedOutput: "design_preview",
        idempotencyKey: "task-create-0001",
      });
      expect(task.status).toBe("queued");
      expect(opened.enterprise.claimAgentTask("usr_codex", task.id).status).toBe("claimed");
      expect(opened.enterprise.transitionAgentTask("usr_codex", task.id, {
        expectedStatus: "claimed",
        toStatus: "in_progress",
      }).status).toBe("in_progress");

      const preview = opened.designer.createPreview("usr_codex", opened.created.document.id, {
        baseVersion: 1,
        operations: [{ type: "update_node", node_id: opened.frameId, patch: { name: "Refined checkout" } }],
        taskId: task.id,
      });
      expect(captureThrown(() => opened.enterprise.transitionAgentTask("usr_codex", task.id, {
        expectedStatus: "in_progress",
        toStatus: "completed",
        data: { previewId: preview.id, unexpected: true },
      }))).toMatchObject({ code: "VALIDATION_FAILED" });
      const png = encodeRgbaPng(16, 16, Buffer.alloc(16 * 16 * 4, 255));
      opened.designer.recordPreviewRenderMetadata("usr_codex", opened.created.document.id, preview.id, {
        options: { nodeId: opened.frameId, maxSize: 256 },
        png,
        width: 16,
        height: 16,
        renderer: "software",
        warnings: [],
      }, { taskId: task.id });
      const awaitingApproval = opened.enterprise.transitionAgentTask("usr_codex", task.id, {
        expectedStatus: "in_progress",
        toStatus: "awaiting_approval",
        data: { previewId: preview.id, readiness: designReadinessFixture(task.resolvedContext) },
      });
      expect(awaitingApproval.status).toBe("awaiting_approval");
      const completed = opened.enterprise.approveAgentTaskDesignPreview("local", task.id, {
        designId: opened.created.document.id,
        previewId: preview.id,
        expectedBaseVersion: 1,
        idempotencyKey: "task-approval-0001",
      });
      expect(completed.task.status).toBe("completed");
      expect(completed.task.transitions.map((transition) => transition.toStatus)).toEqual([
        "queued",
        "claimed",
        "in_progress",
        "awaiting_approval",
        "completed",
      ]);
      expect(() => opened.database.sqlite.prepare(
        "UPDATE agent_tasks SET brief = 'tamper' WHERE id = ?",
      ).run(task.id)).toThrow(/immutable/);
    } finally {
      opened.database.close();
    }
  });

  it("rejects a different agent and detects a stale task base before work starts", () => {
    const opened = setup();
    try {
      const ownedTask = opened.enterprise.createAgentTask("local", {
        designId: opened.created.document.id,
        brief: "Agent ownership",
        baseVersion: 1,
        expectedOutput: "design_preview",
        idempotencyKey: "task-owner-0001",
      });
      opened.enterprise.claimAgentTask("usr_codex", ownedTask.id);
      expect(captureThrown(() => opened.enterprise.transitionAgentTask("usr_other", ownedTask.id, {
        expectedStatus: "claimed",
        toStatus: "in_progress",
      }))).toMatchObject({ code: "FORBIDDEN" });
      opened.enterprise.transitionAgentTask("local", ownedTask.id, {
        expectedStatus: "claimed",
        toStatus: "cancelled",
      });

      const staleTask = opened.enterprise.createAgentTask("local", {
        designId: opened.created.document.id,
        brief: "Stale base",
        baseVersion: 1,
        expectedOutput: "design_preview",
        idempotencyKey: "task-stale-0001",
      });
      opened.designer.applyRevision("local", opened.created.document.id, {
        baseVersion: 1,
        operations: [{ type: "update_node", node_id: opened.frameId, patch: { name: "New head" } }],
        idempotencyKey: "advance-design-head",
      });
      expect(captureThrown(() => opened.enterprise.claimAgentTask("usr_codex", staleTask.id))).toMatchObject({
        code: "VERSION_CONFLICT",
        statusCode: 409,
      });
      expect(opened.enterprise.readAgentTask("local", staleTask.id)).toMatchObject({
        status: "cancelled",
        transitions: expect.arrayContaining([
          expect.objectContaining({
            toStatus: "cancelled",
            data: { reason: "stale_base", expectedBaseVersion: 1, currentVersion: 2 },
          }),
        ]),
      });
    } finally {
      opened.database.close();
    }
  });

  it("cancels a task and expires its proposal when the design changes before approval", () => {
    const opened = setup();
    try {
      const task = opened.enterprise.createAgentTask("local", {
        designId: opened.created.document.id,
        brief: "Proposal that will become stale",
        baseVersion: 1,
        expectedOutput: "design_preview",
        idempotencyKey: "task-stale-before-approval-0001",
      });
      opened.enterprise.claimAgentTask("usr_codex", task.id);
      opened.enterprise.transitionAgentTask("usr_codex", task.id, {
        expectedStatus: "claimed",
        toStatus: "in_progress",
      });
      const preview = opened.designer.createPreview("usr_codex", opened.created.document.id, {
        baseVersion: 1,
        operations: [{ type: "update_node", node_id: opened.frameId, patch: { name: "Stale proposal" } }],
        taskId: task.id,
      });
      opened.designer.applyRevision("local", opened.created.document.id, {
        baseVersion: 1,
        operations: [{ type: "update_node", node_id: opened.frameId, patch: { name: "Human head" } }],
        idempotencyKey: "task-stale-before-approval-human-head",
      });

      expect(captureThrown(() => opened.enterprise.transitionAgentTask("usr_codex", task.id, {
        expectedStatus: "in_progress",
        toStatus: "awaiting_approval",
        data: { previewId: preview.id },
      }))).toMatchObject({
        code: "VERSION_CONFLICT",
        details: { expectedVersion: 1, currentVersion: 2, subject: "design" },
      });
      expect(opened.enterprise.readAgentTask("local", task.id)).toMatchObject({
        status: "cancelled",
        transitions: expect.arrayContaining([
          expect.objectContaining({
            toStatus: "cancelled",
            data: {
              reason: "stale_base",
              expectedBaseVersion: 1,
              currentVersion: 2,
              previewId: preview.id,
            },
          }),
        ]),
      });
      expect(opened.database.sqlite.prepare("SELECT status FROM previews WHERE id = ?").get(preview.id))
        .toEqual({ status: "expired" });
    } finally {
      opened.database.close();
    }
  });
});

describe("agent pairing and revocation", () => {
  it("issues a one-time challenge, enforces project scopes, and revokes immediately", () => {
    const opened = setup();
    try {
      const productPreview = opened.enterprise.previewProductSpecification("local", {
        designId: opened.created.document.id,
        baseVersion: 0,
        naturalLanguageBrief: "Connection test specification",
      });
      opened.enterprise.commitProductSpecificationPreview("local", {
        designId: opened.created.document.id,
        previewId: productPreview.id,
        expectedBaseVersion: 0,
        idempotencyKey: "connection-test-spec",
      });
      const other = opened.designer.createDesign("local", {
        name: "Restricted project",
        preset: "web",
        idempotencyKey: "create-restricted-project",
      });
      const challenge = opened.enterprise.createAgentConnection("local", {
        adapter: "codex",
        displayName: "Codex on this Mac",
        scopes: ["design:read", "product_spec:read", "task:read", "task:claim", "task:update"],
        projectIds: [opened.created.document.id],
      });
      const persistedNonce = opened.database.sqlite.prepare(
        "SELECT nonce_hash FROM pairing_nonces WHERE connection_id = ?",
      ).get(challenge.connection.id) as { nonce_hash: string };
      expect(persistedNonce.nonce_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(persistedNonce.nonce_hash).not.toContain(challenge.nonce);

      const paired = opened.enterprise.pairAgentConnection(challenge.nonce);
      expect(paired.connection.status).toBe("active");
      expect(opened.enterprise.resolveGrantActorId(paired.grant.token)).toBe(paired.grant.actorId);
      expect(opened.enterprise.readOwnAuthorizationContext(paired.grant.actorId)).toEqual({
        role: "agent",
        scopes: ["design:read", "product_spec:read", "task:read", "task:claim", "task:update"],
        projectIds: [opened.created.document.id],
      });
      expect(opened.enterprise.readProductSpecification(paired.grant.actorId, opened.created.document.id).version).toBe(1);
      expect(captureThrown(() => opened.enterprise.readProductSpecification(
        paired.grant.actorId,
        other.document.id,
      ))).toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
      expect(captureThrown(() => opened.enterprise.pairAgentConnection(challenge.nonce))).toMatchObject({ code: "VERSION_CONFLICT" });

      const reconnect = opened.enterprise.renewAgentConnectionPairing("local", paired.connection.id);
      expect(reconnect.connection).toMatchObject({ status: "pending", principalId: null });
      expect(reconnect.connection.id).not.toBe(paired.connection.id);
      expect(opened.enterprise.resolveGrantActorId(paired.grant.token)).toBe(paired.grant.actorId);
      const rePaired = opened.enterprise.pairAgentConnection(reconnect.nonce);
      expect(rePaired.connection.id).toBe(reconnect.connection.id);
      expect(rePaired.connection.principalId).not.toBe(paired.connection.principalId);
      expect(captureThrown(() => opened.enterprise.resolveGrantActorId(paired.grant.token))).toMatchObject({
        code: "AUTH_REQUIRED",
        statusCode: 401,
      });
      expect(opened.enterprise.resolveGrantActorId(rePaired.grant.token)).toBe(rePaired.grant.actorId);
      expect(captureThrown(() => opened.enterprise.pairAgentConnection(reconnect.nonce))).toMatchObject({
        code: "VERSION_CONFLICT",
        statusCode: 409,
      });
      expect(opened.enterprise.resolveGrantActorId(rePaired.grant.token)).toBe(rePaired.grant.actorId);

      expect(opened.enterprise.revokeAgentConnection("local", rePaired.connection.id).status).toBe("revoked");
      expect(captureThrown(() => opened.enterprise.resolveGrantActorId(rePaired.grant.token))).toMatchObject({
        code: "AUTH_REQUIRED",
        statusCode: 401,
      });
      const originalAuditActions = opened.database.sqlite.prepare(
        "SELECT action FROM audit_events WHERE target_id = ? ORDER BY id",
      ).all(paired.connection.id) as Array<{ action: string }>;
      expect(originalAuditActions.map((row) => row.action)).toEqual([
        "agent_connection.create",
        "agent_connection.pair",
        "agent_connection.revoke",
      ]);
      const replacementAuditActions = opened.database.sqlite.prepare(
        "SELECT action FROM audit_events WHERE target_id = ? ORDER BY id",
      ).all(rePaired.connection.id) as Array<{ action: string }>;
      expect(replacementAuditActions.map((row) => row.action)).toEqual([
        "agent_connection.reconnect",
        "agent_connection.pair",
        "agent_connection.revoke",
      ]);
    } finally {
      opened.database.close();
    }
  });

  it("stages matching connections and atomically invalidates predecessors only after pairing", () => {
    const opened = setup();
    try {
      const connectionInput = {
        adapter: "codex" as const,
        displayName: "Codex through the local FormaSpec bridge",
        scopes: ["design:read"],
      };
      const activeChallenge = opened.enterprise.createAgentConnection("local", connectionInput);
      const active = opened.enterprise.pairAgentConnection(activeChallenge.nonce);
      expect(opened.enterprise.resolveGrantActorId(active.grant.token)).toBe(active.grant.actorId);

      const pending = opened.enterprise.createAgentConnection("local", connectionInput);
      const staleRevokedChallenge = opened.enterprise.createAgentConnection("local", connectionInput);
      const staleRevoked = opened.enterprise.pairAgentConnection(staleRevokedChallenge.nonce);
      opened.database.sqlite.prepare(
        "UPDATE agent_connections SET status = 'revoked', updated_at = ? WHERE id = ?",
      ).run(new Date().toISOString(), staleRevoked.connection.id);
      const unrelatedAdapter = opened.enterprise.createAgentConnection("local", {
        ...connectionInput,
        adapter: "generic_mcp",
      });
      const unrelatedName = opened.enterprise.createAgentConnection("local", {
        ...connectionInput,
        displayName: "Another Codex bridge",
      });
      const otherOrganizationId = "organization_connection_rotation_other";
      const otherOrganizationConnectionId = "connection_rotation_other_org";
      const now = new Date().toISOString();
      opened.database.sqlite.prepare(
        `INSERT INTO organizations (id, name, config_json, created_at, updated_at)
         VALUES (?, 'Other organization', '{}', ?, ?)`,
      ).run(otherOrganizationId, now, now);
      opened.database.sqlite.prepare(
        `INSERT INTO agent_connections
         (id, organization_id, principal_id, adapter, display_name, status, scopes_json, project_ids_json,
          expires_at, created_at, updated_at)
         VALUES (?, ?, NULL, 'codex', ?, 'pending', '["design:read"]', '[]', ?, ?, ?)`,
      ).run(
        otherOrganizationConnectionId,
        otherOrganizationId,
        connectionInput.displayName,
        "2099-01-01T00:00:00.000Z",
        now,
        now,
      );
      const replacement = opened.enterprise.createAgentConnection("local", {
        ...connectionInput,
        replaceExisting: true,
      });

      const statuses = new Map(opened.enterprise.listAgentConnections("local").map((connection) => [
        connection.id,
        connection.status,
      ]));
      expect(statuses.get(active.connection.id)).toBe("active");
      expect(statuses.get(pending.connection.id)).toBe("pending");
      expect(statuses.get(staleRevoked.connection.id)).toBe("revoked");
      expect(statuses.get(unrelatedAdapter.connection.id)).toBe("pending");
      expect(statuses.get(unrelatedName.connection.id)).toBe("pending");
      expect(statuses.get(replacement.connection.id)).toBe("pending");
      expect(opened.database.sqlite.prepare(
        "SELECT status FROM agent_connections WHERE id = ?",
      ).get(otherOrganizationConnectionId)).toEqual({ status: "pending" });
      expect(opened.enterprise.resolveGrantActorId(active.grant.token)).toBe(active.grant.actorId);
      const pairedPending = opened.enterprise.pairAgentConnection(pending.nonce);
      expect(opened.enterprise.resolveGrantActorId(pairedPending.grant.token)).toBe(pairedPending.grant.actorId);

      const pairedReplacement = opened.enterprise.pairAgentConnection(replacement.nonce);
      expect(opened.enterprise.resolveGrantActorId(pairedReplacement.grant.token)).toBe(pairedReplacement.grant.actorId);
      const pairedStatuses = new Map(opened.enterprise.listAgentConnections("local").map((connection) => [
        connection.id,
        connection.status,
      ]));
      expect(pairedStatuses.get(active.connection.id)).toBe("revoked");
      expect(pairedStatuses.get(pending.connection.id)).toBe("revoked");
      expect(pairedStatuses.get(replacement.connection.id)).toBe("active");
      expect(captureThrown(() => opened.enterprise.resolveGrantActorId(active.grant.token))).toMatchObject({
        code: "AUTH_REQUIRED",
        statusCode: 401,
      });
      expect(captureThrown(() => opened.enterprise.resolveGrantActorId(pairedPending.grant.token))).toMatchObject({
        code: "AUTH_REQUIRED",
        statusCode: 401,
      });
      expect(captureThrown(() => resolveAccess(opened.database.sqlite, active.grant.actorId))).toMatchObject({
        code: "AUTH_REQUIRED",
        statusCode: 401,
      });

      const persistedGrant = opened.database.sqlite.prepare(
        "SELECT revoked_at FROM agent_grants WHERE id = ?",
      ).get(active.grant.id) as { revoked_at: string | null };
      expect(persistedGrant.revoked_at).not.toBeNull();
      expect(opened.database.sqlite.prepare(
        "SELECT revoked_at FROM agent_grants WHERE id = ?",
      ).get(pairedPending.grant.id)).toMatchObject({ revoked_at: expect.any(String) });
      const revokedNonces = opened.database.sqlite.prepare(
        `SELECT connection_id, revoked_at FROM pairing_nonces
         WHERE connection_id IN (?, ?) ORDER BY connection_id`,
      ).all(
        active.connection.id,
        pending.connection.id,
      ) as Array<{ connection_id: string; revoked_at: string | null }>;
      expect(revokedNonces).toHaveLength(2);
      expect(revokedNonces.every((row) => row.revoked_at !== null)).toBe(true);

      const replacementAudit = opened.database.sqlite.prepare(
        `SELECT target_id, details_json FROM audit_events
         WHERE action = 'agent_connection.revoke' AND target_id IN (?, ?)
         ORDER BY target_id`,
      ).all(active.connection.id, pending.connection.id) as Array<{ target_id: string; details_json: string }>;
      expect(replacementAudit).toHaveLength(2);
      expect(replacementAudit.map((row) => JSON.parse(row.details_json))).toEqual([
        { reason: "replaced", replacementConnectionId: replacement.connection.id },
        { reason: "replaced", replacementConnectionId: replacement.connection.id },
      ]);
      const replacementEvents = (opened.database.sqlite.prepare(
        "SELECT payload_json FROM event_outbox WHERE event_type = 'agent_connection.changed' ORDER BY id",
      ).all() as Array<{ payload_json: string }>)
        .map((row) => JSON.parse(row.payload_json) as Record<string, unknown>)
        .filter((payload) => payload.reason === "replaced");
      expect(replacementEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          connectionId: active.connection.id,
          status: "revoked",
          replacementConnectionId: replacement.connection.id,
        }),
        expect.objectContaining({
          connectionId: pending.connection.id,
          status: "revoked",
          replacementConnectionId: replacement.connection.id,
        }),
      ]));

      expect(opened.database.sqlite.prepare(
        "SELECT value FROM system_metadata WHERE key = ?",
      ).get(`agent_connection_replacement:${replacement.connection.id}`)).toBeUndefined();
    } finally {
      opened.database.close();
    }
  });

  it("replaces the legacy Minimal UI managed connection when FormaSpec is paired", () => {
    const opened = setup();
    try {
      const legacyChallenge = opened.enterprise.createAgentConnection("local", {
        adapter: "codex",
        displayName: "Codex — Minimal UI",
        scopes: ["design:read"],
      });
      const legacy = opened.enterprise.pairAgentConnection(legacyChallenge.nonce);
      const unrelatedChallenge = opened.enterprise.createAgentConnection("local", {
        adapter: "codex",
        displayName: "Independent Codex bridge",
        scopes: ["design:read"],
      });
      const replacement = opened.enterprise.createAgentConnection("local", {
        adapter: "codex",
        displayName: "Codex — FormaSpec",
        scopes: ["design:read"],
        replaceExisting: true,
      });

      const statuses = new Map(opened.enterprise.listAgentConnections("local").map((connection) => [
        connection.id,
        connection.status,
      ]));
      expect(statuses.get(legacy.connection.id)).toBe("active");
      expect(statuses.get(unrelatedChallenge.connection.id)).toBe("pending");
      expect(statuses.get(replacement.connection.id)).toBe("pending");
      expect(opened.enterprise.resolveGrantActorId(legacy.grant.token)).toBe(legacy.grant.actorId);

      opened.enterprise.pairAgentConnection(replacement.nonce);
      expect(captureThrown(() => opened.enterprise.resolveGrantActorId(legacy.grant.token))).toMatchObject({
        code: "AUTH_REQUIRED",
        statusCode: 401,
      });
    } finally {
      opened.database.close();
    }
  });

  it("persists staged replacement intent across restart and switches only after pairing", () => {
    const filename = databasePath();
    const opened = setup(filename);
    const connectionInput = {
      adapter: "codex" as const,
      displayName: "Restart-safe Codex bridge",
      scopes: ["design:read"],
    };
    const originalChallenge = opened.enterprise.createAgentConnection("local", connectionInput);
    const original = opened.enterprise.pairAgentConnection(originalChallenge.nonce);
    const replacement = opened.enterprise.createAgentConnection("local", {
      ...connectionInput,
      replaceExisting: true,
    });
    opened.database.close();

    const reopenedDatabase = new DesignerDatabase(filename);
    const reopenedEnterprise = new EnterpriseService(reopenedDatabase, new EventHub());
    try {
      expect(reopenedEnterprise.resolveGrantActorId(original.grant.token)).toBe(original.grant.actorId);
      const statuses = new Map(reopenedEnterprise.listAgentConnections("local").map((connection) => [
        connection.id,
        connection.status,
      ]));
      expect(statuses.get(original.connection.id)).toBe("active");
      expect(statuses.get(replacement.connection.id)).toBe("pending");

      reopenedEnterprise.pairAgentConnection(replacement.nonce);
      expect(captureThrown(() => reopenedEnterprise.resolveGrantActorId(original.grant.token))).toMatchObject({
        code: "AUTH_REQUIRED",
        statusCode: 401,
      });
      const pairedStatuses = new Map(reopenedEnterprise.listAgentConnections("local").map((connection) => [
        connection.id,
        connection.status,
      ]));
      expect(pairedStatuses.get(original.connection.id)).toBe("revoked");
      expect(pairedStatuses.get(replacement.connection.id)).toBe("active");
    } finally {
      reopenedDatabase.close();
    }
  });

  it("rolls back replacement revocations, audit records, and outbox events when insertion fails", () => {
    const opened = setup();
    try {
      const connectionInput = {
        adapter: "codex" as const,
        displayName: "Rollback-safe Codex bridge",
        scopes: ["design:read"],
      };
      const activeChallenge = opened.enterprise.createAgentConnection("local", connectionInput);
      const active = opened.enterprise.pairAgentConnection(activeChallenge.nonce);
      const pending = opened.enterprise.createAgentConnection("local", connectionInput);
      const auditCount = (opened.database.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM audit_events",
      ).get() as { count: number }).count;
      const outboxCount = (opened.database.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM event_outbox",
      ).get() as { count: number }).count;
      const connectionCount = (opened.database.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM agent_connections",
      ).get() as { count: number }).count;
      opened.database.sqlite.exec(`
        CREATE TRIGGER force_agent_connection_insert_failure
        BEFORE INSERT ON agent_connections
        BEGIN
          SELECT RAISE(ABORT, 'forced replacement insert failure');
        END;
      `);

      const error = captureThrown(() => opened.enterprise.createAgentConnection("local", {
        ...connectionInput,
        replaceExisting: true,
      }));
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain("forced replacement insert failure");
      expect(opened.enterprise.resolveGrantActorId(active.grant.token)).toBe(active.grant.actorId);
      const statuses = new Map(opened.enterprise.listAgentConnections("local").map((connection) => [
        connection.id,
        connection.status,
      ]));
      expect(statuses.get(active.connection.id)).toBe("active");
      expect(statuses.get(pending.connection.id)).toBe("pending");
      expect(opened.database.sqlite.prepare(
        "SELECT revoked_at FROM agent_grants WHERE id = ?",
      ).get(active.grant.id)).toEqual({ revoked_at: null });
      expect(opened.database.sqlite.prepare(
        `SELECT COUNT(*) AS count FROM pairing_nonces
         WHERE connection_id IN (?, ?) AND revoked_at IS NOT NULL`,
      ).get(active.connection.id, pending.connection.id)).toEqual({ count: 0 });
      expect((opened.database.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM audit_events",
      ).get() as { count: number }).count).toBe(auditCount);
      expect((opened.database.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM event_outbox",
      ).get() as { count: number }).count).toBe(outboxCount);
      expect((opened.database.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM agent_connections",
      ).get() as { count: number }).count).toBe(connectionCount);
    } finally {
      opened.database.close();
    }
  });

  it("rolls back the entire replacement switchover when final pair persistence fails", () => {
    const opened = setup();
    try {
      const connectionInput = {
        adapter: "codex" as const,
        displayName: "Atomic pair Codex bridge",
        scopes: ["design:read"],
      };
      const originalChallenge = opened.enterprise.createAgentConnection("local", connectionInput);
      const original = opened.enterprise.pairAgentConnection(originalChallenge.nonce);
      const replacement = opened.enterprise.createAgentConnection("local", {
        ...connectionInput,
        replaceExisting: true,
      });
      const grantCount = (opened.database.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM agent_grants",
      ).get() as { count: number }).count;
      opened.database.sqlite.exec(`
        CREATE TRIGGER force_agent_connection_pair_audit_failure
        BEFORE INSERT ON audit_events
        WHEN NEW.action = 'agent_connection.pair' AND NEW.target_id = '${replacement.connection.id}'
        BEGIN
          SELECT RAISE(ABORT, 'forced replacement pair failure');
        END;
      `);

      const error = captureThrown(() => opened.enterprise.pairAgentConnection(replacement.nonce));
      expect(String(error)).toContain("forced replacement pair failure");
      expect(opened.enterprise.resolveGrantActorId(original.grant.token)).toBe(original.grant.actorId);
      expect(opened.database.sqlite.prepare(
        "SELECT status FROM agent_connections WHERE id = ?",
      ).get(replacement.connection.id)).toEqual({ status: "pending" });
      expect(opened.database.sqlite.prepare(
        "SELECT consumed_at, revoked_at FROM pairing_nonces WHERE connection_id = ?",
      ).get(replacement.connection.id)).toEqual({ consumed_at: null, revoked_at: null });
      expect((opened.database.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM agent_grants",
      ).get() as { count: number }).count).toBe(grantCount);

      opened.database.sqlite.exec("DROP TRIGGER force_agent_connection_pair_audit_failure");
      const pairedReplacement = opened.enterprise.pairAgentConnection(replacement.nonce);
      expect(opened.enterprise.resolveGrantActorId(pairedReplacement.grant.token)).toBe(pairedReplacement.grant.actorId);
      expect(captureThrown(() => opened.enterprise.resolveGrantActorId(original.grant.token))).toMatchObject({
        code: "AUTH_REQUIRED",
        statusCode: 401,
      });
    } finally {
      opened.database.close();
    }
  });

  it("allows one staged replacement at the logical connection limit without admitting an unrelated connection", () => {
    const opened = setup();
    try {
      const policies = new OrganizationPolicyService(opened.database);
      const currentPolicy = policies.read("local");
      const policy = structuredClone(DEFAULT_ORGANIZATION_POLICY);
      policy.agents.maximumActiveConnections = 1;
      policies.update("local", {
        expectedConfigurationHash: currentPolicy.configurationHash,
        policy,
      });
      const connectionInput = {
        adapter: "codex" as const,
        displayName: "Limit-safe Codex bridge",
        scopes: ["design:read"],
      };
      const originalChallenge = opened.enterprise.createAgentConnection("local", connectionInput);
      const original = opened.enterprise.pairAgentConnection(originalChallenge.nonce);

      const replacement = opened.enterprise.createAgentConnection("local", {
        ...connectionInput,
        replaceExisting: true,
      });
      expect(opened.enterprise.resolveGrantActorId(original.grant.token)).toBe(original.grant.actorId);
      expect(captureThrown(() => opened.enterprise.createAgentConnection("local", {
        ...connectionInput,
        displayName: "Unrelated Codex bridge",
      }))).toMatchObject({ code: "FORBIDDEN", statusCode: 403 });

      const pairedReplacement = opened.enterprise.pairAgentConnection(replacement.nonce);
      expect(opened.enterprise.resolveGrantActorId(pairedReplacement.grant.token)).toBe(pairedReplacement.grant.actorId);
      expect(captureThrown(() => opened.enterprise.resolveGrantActorId(original.grant.token))).toMatchObject({
        code: "AUTH_REQUIRED",
        statusCode: 401,
      });
    } finally {
      opened.database.close();
    }
  });

  it("expires only the pending replacement and leaves the working predecessor grant usable", () => {
    const database = new DesignerDatabase(":memory:");
    const events = new EventHub();
    const designer = new DesignerService(database, events, 900);
    designer.createDesign("local", {
      name: "Replacement expiry",
      preset: "phone",
      idempotencyKey: "replacement-expiry-design",
    });
    let clock = new Date("2026-07-19T12:00:00.000Z");
    const enterprise = new EnterpriseService(database, events, {
      now: () => clock,
      pairingTtlSeconds: 60,
    });
    try {
      const connectionInput = {
        adapter: "codex" as const,
        displayName: "Expiring replacement Codex",
        scopes: ["design:read"],
      };
      const originalChallenge = enterprise.createAgentConnection("local", connectionInput);
      const original = enterprise.pairAgentConnection(originalChallenge.nonce);
      const replacement = enterprise.createAgentConnection("local", {
        ...connectionInput,
        replaceExisting: true,
      });

      clock = new Date("2026-07-19T12:01:01.000Z");
      expect(captureThrown(() => enterprise.pairAgentConnection(replacement.nonce))).toMatchObject({
        code: "PAIRING_EXPIRED",
        statusCode: 410,
      });
      expect(enterprise.resolveGrantActorId(original.grant.token)).toBe(original.grant.actorId);
      const statuses = new Map(enterprise.listAgentConnections("local").map((connection) => [
        connection.id,
        connection.status,
      ]));
      expect(statuses.get(original.connection.id)).toBe("active");
      expect(statuses.get(replacement.connection.id)).toBe("expired");
      expect(database.sqlite.prepare(
        "SELECT value FROM system_metadata WHERE key = ?",
      ).get(`agent_connection_replacement:${replacement.connection.id}`)).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("revokes a cancelled pending replacement without touching the working predecessor", () => {
    const opened = setup();
    try {
      const connectionInput = {
        adapter: "codex" as const,
        displayName: "Cancelled replacement Codex",
        scopes: ["design:read"],
      };
      const originalChallenge = opened.enterprise.createAgentConnection("local", connectionInput);
      const original = opened.enterprise.pairAgentConnection(originalChallenge.nonce);
      const replacement = opened.enterprise.createAgentConnection("local", {
        ...connectionInput,
        replaceExisting: true,
      });

      expect(opened.enterprise.revokeAgentConnection("local", replacement.connection.id).status).toBe("revoked");
      expect(opened.enterprise.resolveGrantActorId(original.grant.token)).toBe(original.grant.actorId);
      expect(captureThrown(() => opened.enterprise.pairAgentConnection(replacement.nonce))).toMatchObject({
        code: "CONNECTION_REVOKED",
        statusCode: 410,
      });
      expect(opened.database.sqlite.prepare(
        "SELECT value FROM system_metadata WHERE key = ?",
      ).get(`agent_connection_replacement:${replacement.connection.id}`)).toBeUndefined();
    } finally {
      opened.database.close();
    }
  });

  it("persists pairing expiry and emits an audited lifecycle transition", () => {
    const database = new DesignerDatabase(":memory:");
    const events = new EventHub();
    const designer = new DesignerService(database, events, 900);
    designer.createDesign("local", {
      name: "Pairing expiry",
      preset: "phone",
      idempotencyKey: "pairing-expiry-design",
    });
    let clock = new Date("2026-07-19T12:00:00.000Z");
    const enterprise = new EnterpriseService(database, events, {
      now: () => clock,
      pairingTtlSeconds: 60,
    });
    try {
      const challenge = enterprise.createAgentConnection("local", {
        adapter: "codex",
        displayName: "Expiring Codex",
        scopes: ["design:read"],
      });
      clock = new Date("2026-07-19T12:01:01.000Z");
      expect(captureThrown(() => enterprise.pairAgentConnection(challenge.nonce))).toMatchObject({
        code: "PAIRING_EXPIRED",
        statusCode: 410,
      });
      expect(enterprise.listAgentConnections("local")[0]?.status).toBe("expired");
      expect(database.sqlite.prepare(
        "SELECT action FROM audit_events WHERE target_id = ? ORDER BY id DESC LIMIT 1",
      ).get(challenge.connection.id)).toEqual({ action: "agent_connection.expire" });
    } finally {
      database.close();
    }
  });
});
