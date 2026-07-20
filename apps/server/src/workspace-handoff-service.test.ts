import { afterEach, describe, expect, it } from "vitest";

import { resolveAccess, type OrganizationRole } from "./authorization.js";
import { DesignerDatabase } from "./db/database.js";
import { EventHub } from "./events.js";
import { DEFAULT_ORGANIZATION_POLICY } from "./organization-policy-model.js";
import { OrganizationPolicyService } from "./organization-policy-service.js";
import { DesignerService } from "./service.js";
import {
  HANDOFF_SPECIFICATION_MAX_BYTES,
  WORKSPACE_INVENTORY_MAX_BYTES,
  WorkspaceHandoffService,
  type HandoffSpecification,
  type UploadRepositoryInventory,
} from "./workspace-handoff-service.js";

interface Opened {
  database: DesignerDatabase;
  designer: DesignerService;
  handoffs: WorkspaceHandoffService;
  designId: string;
  revisionId: string;
  frameId: string;
}

const openedDatabases: DesignerDatabase[] = [];

afterEach(() => {
  for (const database of openedDatabases.splice(0)) database.close();
});

function setup(): Opened {
  const database = new DesignerDatabase(":memory:");
  openedDatabases.push(database);
  const events = new EventHub();
  const designer = new DesignerService(database, events, 900);
  const created = designer.createDesign("local", {
    name: "Engineering handoff",
    preset: "web",
    idempotencyKey: `handoff-test-${Math.random()}`,
  });
  const frameId = created.document.pages[0]?.children[0];
  if (!frameId) throw new Error("Starter frame was not created.");
  return {
    database,
    designer,
    handoffs: new WorkspaceHandoffService(database, { now: () => new Date("2026-07-19T12:34:56.000Z") }),
    designId: created.document.id,
    revisionId: created.revision.id,
    frameId,
  };
}

function setRole(database: DesignerDatabase, actorId: string, role: OrganizationRole): void {
  const access = resolveAccess(database.sqlite, actorId);
  database.sqlite.prepare(
    "UPDATE memberships SET role = ? WHERE organization_id = ? AND principal_id = ?",
  ).run(role, access.organizationId, access.principalId);
}

function inventory(overrides: Partial<UploadRepositoryInventory> = {}): UploadRepositoryInventory {
  return {
    schemaVersion: 1,
    repositoryFingerprint: "a".repeat(64),
    generatedAt: "2026-07-19T12:00:00.000Z",
    platforms: ["web"],
    gitHead: "b".repeat(40),
    scannedFileCount: 12,
    skippedFileCount: 3,
    bytesRead: 12_345,
    truncated: false,
    excludedPatterns: [".env", ".env.*", "*.pem", "*.key", "**/secrets/**", "**/.git/**"],
    entities: [
      {
        id: `inv_${"1".repeat(40)}`,
        kind: "component",
        name: "CheckoutButton",
        symbol: "CheckoutButton",
        locationId: `loc_${"2".repeat(40)}`,
        line: 42,
      },
      {
        id: `inv_${"3".repeat(40)}`,
        kind: "route",
        name: "/checkout",
        symbol: null,
        locationId: `loc_${"4".repeat(40)}`,
        line: 18,
      },
    ],
    excluded: [
      { category: "secret", count: 2 },
      { category: "generated", count: 5 },
      { category: "symlink", count: 1 },
      { category: "limit", count: 0 },
    ],
    ...overrides,
  };
}

function specification(overrides: Partial<HandoffSpecification> = {}): HandoffSpecification {
  return {
    schemaVersion: 1,
    title: "Implement checkout refinement",
    summary: "Match the approved FormaSpec revision without widening repository access.",
    acceptanceCriteria: [
      {
        id: "criterion_checkout",
        statement: "Checkout renders the approved state and preserves keyboard navigation.",
        designEntityIds: ["node_checkout_frame"],
      },
    ],
    implementationSlices: [
      {
        id: "slice_checkout_ui",
        title: "Checkout interface",
        objective: "Map the approved checkout design to the existing component.",
        inventoryEntityIds: [`inv_${"1".repeat(40)}`],
        designEntityIds: ["node_checkout_frame"],
        dependsOn: [],
        validationChecks: ["typecheck", "unit_tests", "accessibility"],
      },
    ],
    risks: ["Existing route state may require a guarded migration."],
    openQuestions: [],
    implementationPolicy: {
      preferredIsolation: "worktree",
      commitRequiresExplicitApproval: true,
      pullRequestRequiresExplicitRequest: true,
    },
    ...overrides,
  };
}

function captureThrown(callback: () => unknown): unknown {
  try {
    callback();
  } catch (error) {
    return error;
  }
  throw new Error("Expected callback to throw.");
}

describe("persisted Workspace Bridge repository inventories", () => {
  it("persists a bounded path-free inventory, deduplicates exact retries, and supersedes immutable versions", () => {
    const opened = setup();
    expect(opened.database.schemaVersion()).toBe(11);

    const first = opened.handoffs.persistRepositoryInventory("local", inventory());
    expect(first).toMatchObject({ status: "active", deduplicated: false });
    expect(first.inventory.entities[0]).not.toHaveProperty("relativePath");
    const exactRetry = opened.handoffs.persistRepositoryInventory("local", inventory());
    expect(exactRetry).toMatchObject({ id: first.id, status: "active", deduplicated: true });

    const secondInput = inventory({
      generatedAt: "2026-07-19T12:10:00.000Z",
      gitHead: "c".repeat(40),
      entities: [
        ...inventory().entities,
        {
          id: `inv_${"5".repeat(40)}`,
          kind: "token",
          name: "--color-checkout",
          symbol: null,
          locationId: `loc_${"6".repeat(40)}`,
          line: 9,
        },
      ],
    });
    const second = opened.handoffs.persistRepositoryInventory("local", secondInput);
    expect(second).toMatchObject({ status: "active", deduplicated: false });
    expect(second.id).not.toBe(first.id);
    expect(opened.handoffs.readRepositoryInventory("local", first.id).status).toBe("superseded");
    expect(opened.handoffs.listRepositoryInventories("local", { repositoryFingerprint: "a".repeat(64) }))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: first.id, status: "superseded" }),
        expect.objectContaining({ id: second.id, status: "active" }),
      ]));

    const persisted = opened.database.sqlite.prepare(
      "SELECT inventory_json FROM repository_inventories WHERE id = ?",
    ).get(second.id) as { inventory_json: string };
    expect(persisted.inventory_json).not.toContain("relativePath");
    expect(persisted.inventory_json).not.toContain("repositoryRoot");
    expect(persisted.inventory_json).not.toContain("/Users/");
    expect(() => opened.database.sqlite.prepare("DELETE FROM repository_inventories WHERE id = ?").run(first.id)).toThrow(/cannot be deleted/);
    opened.database.sqlite.prepare(
      "UPDATE repository_inventories SET inventory_json = ? WHERE id = ?",
    ).run(JSON.stringify(inventory({ generatedAt: "2026-07-19T12:30:00.000Z" })), first.id);
    expect(captureThrown(() => opened.handoffs.readRepositoryInventory("local", first.id)))
      .toMatchObject({ code: "INTERNAL_ERROR", statusCode: 500 });
    expect(opened.database.sqlite.prepare(
      "SELECT action FROM audit_events WHERE target_type = 'repository_inventory' ORDER BY id",
    ).all()).toEqual([
      { action: "repository_inventory.persist" },
      { action: "repository_inventory.persist" },
    ]);
  });

  it("rejects oversized, path-bearing, shell-bearing, and source-symbol injection shapes before persistence", () => {
    const opened = setup();
    const pathBearing = { ...inventory(), repositoryRoot: "/Users/private/company-repository" };
    expect(captureThrown(() => opened.handoffs.persistRepositoryInventory("local", pathBearing)))
      .toMatchObject({ code: "VALIDATION_FAILED" });

    const entityWithPath = {
      ...inventory(),
      entities: [{ ...inventory().entities[0], relativePath: "src/private/Checkout.tsx" }],
    };
    expect(captureThrown(() => opened.handoffs.persistRepositoryInventory("local", entityWithPath)))
      .toMatchObject({ code: "VALIDATION_FAILED" });

    const entityWithShell = {
      ...inventory(),
      entities: [{ ...inventory().entities[0], symbol: "CheckoutButton;rm" }],
      command: "rm -rf /",
    };
    expect(captureThrown(() => opened.handoffs.persistRepositoryInventory("local", entityWithShell)))
      .toMatchObject({ code: "VALIDATION_FAILED" });

    const oversized = { ...inventory(), diagnostic: "x".repeat(WORKSPACE_INVENTORY_MAX_BYTES + 1) };
    expect(captureThrown(() => opened.handoffs.persistRepositoryInventory("local", oversized)))
      .toMatchObject({ code: "PAYLOAD_TOO_LARGE", statusCode: 413 });
    expect(opened.database.sqlite.prepare("SELECT COUNT(*) AS count FROM repository_inventories").get()).toEqual({ count: 0 });
  });

  it("rejects inventories that were not scanned with the current organization exclusion policy", () => {
    const opened = setup();
    expect(captureThrown(() => opened.handoffs.persistRepositoryInventory("local", inventory({ excludedPatterns: [] }))))
      .toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
    expect(opened.database.sqlite.prepare("SELECT COUNT(*) AS count FROM repository_inventories").get()).toEqual({ count: 0 });
  });

  it("requires a new explicit grant before stale-policy inventory can enter a handoff", () => {
    const opened = setup();
    const persisted = opened.handoffs.persistRepositoryInventory("local", inventory());
    const policies = new OrganizationPolicyService(opened.database);
    const current = policies.read("local");
    const policy = structuredClone(DEFAULT_ORGANIZATION_POLICY);
    policy.repositories.excludedPatterns.push("**/internal-only/**");
    policies.update("local", { expectedConfigurationHash: current.configurationHash, policy });

    expect(captureThrown(() => opened.handoffs.createHandoff("local", {
      designId: opened.designId,
      revisionId: opened.revisionId,
      expectedDesignVersion: 1,
      inventoryId: persisted.id,
      specification: specification(),
    }))).toMatchObject({
      code: "VERSION_CONFLICT",
      statusCode: 409,
      details: { reason: "repository_exclusion_policy_changed" },
    });
    expect(opened.database.sqlite.prepare("SELECT COUNT(*) AS count FROM handoffs").get()).toEqual({ count: 0 });
  });

  it("revokes immediately and never reactivates an identical historical inventory", () => {
    const opened = setup();
    const persisted = opened.handoffs.persistRepositoryInventory("local", inventory());
    const revoked = opened.handoffs.revokeRepositoryInventory("local", persisted.id);
    expect(revoked).toMatchObject({ id: persisted.id, status: "revoked", revokedAt: "2026-07-19T12:34:56.000Z" });
    expect(captureThrown(() => opened.handoffs.persistRepositoryInventory("local", inventory())))
      .toMatchObject({ code: "VERSION_CONFLICT", statusCode: 409 });
  });
});

describe("approval-gated engineering handoffs", () => {
  it("keeps immutable specification history, enforces CAS, and requires explicit review, approval, implementation, and completion gates", () => {
    const opened = setup();
    setRole(opened.database, "pm-user", "product_manager");
    setRole(opened.database, "engineer-user", "engineer");
    const persistedInventory = opened.handoffs.persistRepositoryInventory("engineer-user", inventory());

    let handoff = opened.handoffs.createHandoff("local", {
      designId: opened.designId,
      revisionId: opened.revisionId,
      expectedDesignVersion: 1,
      inventoryId: persistedInventory.id,
      specification: specification(),
    });
    expect(handoff).toMatchObject({ status: "draft", currentVersion: 1, designVersion: 1 });
    expect(handoff.versions).toHaveLength(1);
    expect(handoff.transitions.map((transition) => transition.toStatus)).toEqual(["draft"]);

    handoff = opened.handoffs.updateHandoff("local", handoff.id, {
      expectedVersion: 1,
      specification: specification({ summary: "Version two approved-ready handoff." }),
    });
    expect(handoff.currentVersion).toBe(2);
    expect(handoff.versions.map((version) => version.specification.summary)).toEqual([
      "Match the approved FormaSpec revision without widening repository access.",
      "Version two approved-ready handoff.",
    ]);
    expect(captureThrown(() => opened.handoffs.updateHandoff("local", handoff.id, {
      expectedVersion: 1,
      specification: specification({ summary: "Stale overwrite" }),
    }))).toMatchObject({ code: "VERSION_CONFLICT", statusCode: 409 });
    expect(opened.handoffs.readHandoff("local", handoff.id).versions).toHaveLength(2);

    handoff = opened.handoffs.submitHandoffForReview("local", handoff.id, {
      expectedVersion: 2,
      summary: "Ready for product approval.",
    });
    expect(handoff.status).toBe("in_review");
    expect(captureThrown(() => opened.handoffs.startHandoffImplementation("engineer-user", handoff.id, {
      expectedVersion: 2,
      approvedVersion: 2,
      authorization: "start_implementation",
    }))).toMatchObject({ code: "VERSION_CONFLICT" });
    expect(captureThrown(() => opened.handoffs.approveHandoff("engineer-user", handoff.id, {
      expectedVersion: 2,
      decision: "approved",
      summary: "Engineer cannot self-authorize through this role.",
      acceptanceCriteriaConfirmed: true,
      implementationPlanConfirmed: true,
    }))).toMatchObject({ code: "FORBIDDEN" });
    expect(captureThrown(() => opened.handoffs.approveHandoff("pm-user", handoff.id, {
      expectedVersion: 2,
      decision: "approved",
      summary: "Missing explicit plan confirmation.",
      acceptanceCriteriaConfirmed: true,
      implementationPlanConfirmed: false,
    } as unknown as Parameters<WorkspaceHandoffService["approveHandoff"]>[2]))).toMatchObject({ code: "VALIDATION_FAILED" });

    handoff = opened.handoffs.approveHandoff("pm-user", handoff.id, {
      expectedVersion: 2,
      decision: "approved",
      summary: "Acceptance criteria and implementation slices reviewed.",
      acceptanceCriteriaConfirmed: true,
      implementationPlanConfirmed: true,
    });
    expect(handoff.status).toBe("approved");
    expect(captureThrown(() => opened.handoffs.updateHandoff("local", handoff.id, {
      expectedVersion: 2,
      specification: specification({ summary: "Unapproved post-approval edit" }),
    }))).toMatchObject({ code: "VERSION_CONFLICT" });

    handoff = opened.handoffs.startHandoffImplementation("engineer-user", handoff.id, {
      expectedVersion: 2,
      approvedVersion: 2,
      authorization: "start_implementation",
    });
    expect(handoff.status).toBe("implementing");
    expect(captureThrown(() => opened.handoffs.completeHandoffImplementation("engineer-user", handoff.id, {
      expectedVersion: 2,
      summary: "Validation not explicitly approved.",
      diffReviewed: true,
      validationApproved: false,
      commitApproved: true,
      pullRequestRequested: false,
    } as unknown as Parameters<WorkspaceHandoffService["completeHandoffImplementation"]>[2]))).toMatchObject({ code: "VALIDATION_FAILED" });

    handoff = opened.handoffs.completeHandoffImplementation("engineer-user", handoff.id, {
      expectedVersion: 2,
      summary: "Diff, validation, and commit were explicitly approved.",
      diffReviewed: true,
      validationApproved: true,
      commitApproved: true,
      pullRequestRequested: false,
    });
    expect(handoff.status).toBe("completed");
    expect(handoff.currentVersion).toBe(2);
    expect(handoff.versions).toHaveLength(2);
    expect(handoff.transitions.map((transition) => transition.toStatus)).toEqual([
      "draft",
      "in_review",
      "approved",
      "implementing",
      "completed",
    ]);
    expect(() => opened.database.sqlite.prepare(
      "UPDATE handoff_versions SET specification_json = '{}' WHERE handoff_id = ? AND version = 1",
    ).run(handoff.id)).toThrow(/immutable/);
    expect(() => opened.database.sqlite.prepare(
      "DELETE FROM handoff_transitions WHERE handoff_id = ?",
    ).run(handoff.id)).toThrow(/immutable/);
    expect(opened.database.sqlite.prepare(
      "SELECT action FROM audit_events WHERE target_type = 'handoff' ORDER BY id",
    ).all()).toEqual([
      { action: "handoff.create" },
      { action: "handoff.version.create" },
      { action: "handoff.submit_review" },
      { action: "handoff.approve" },
      { action: "handoff.start_implementation" },
      { action: "handoff.complete" },
    ]);
  });

  it("blocks approval when either the pinned design revision or repository inventory becomes stale", () => {
    const opened = setup();
    setRole(opened.database, "pm-user", "product_manager");
    const persistedInventory = opened.handoffs.persistRepositoryInventory("local", inventory());
    const create = () => opened.handoffs.createHandoff("local", {
      designId: opened.designId,
      revisionId: opened.revisionId,
      expectedDesignVersion: 1,
      inventoryId: persistedInventory.id,
      specification: specification(),
    });

    const designStale = create();
    opened.handoffs.submitHandoffForReview("local", designStale.id, { expectedVersion: 1, summary: "Review" });
    const preview = opened.designer.createPreview("local", opened.designId, {
      baseVersion: 1,
      operations: [{ type: "update_node", node_id: opened.frameId, patch: { name: "Changed after handoff" } }],
    });
    opened.designer.commitPreview("local", opened.designId, {
      previewId: preview.id,
      expectedBaseVersion: 1,
      idempotencyKey: "handoff-design-stale-commit",
    });
    expect(captureThrown(() => opened.handoffs.approveHandoff("pm-user", designStale.id, {
      expectedVersion: 1,
      decision: "approved",
      summary: "This must be rejected as stale.",
      acceptanceCriteriaConfirmed: true,
      implementationPlanConfirmed: true,
    }))).toMatchObject({ code: "VERSION_CONFLICT", details: { pinnedDesignVersion: 1, currentDesignVersion: 2 } });

    const secondOpened = setup();
    setRole(secondOpened.database, "pm-user", "product_manager");
    const firstInventory = secondOpened.handoffs.persistRepositoryInventory("local", inventory());
    const inventoryStale = secondOpened.handoffs.createHandoff("local", {
      designId: secondOpened.designId,
      revisionId: secondOpened.revisionId,
      expectedDesignVersion: 1,
      inventoryId: firstInventory.id,
      specification: specification(),
    });
    secondOpened.handoffs.persistRepositoryInventory("local", inventory({
      generatedAt: "2026-07-19T12:20:00.000Z",
      gitHead: "d".repeat(40),
    }));
    expect(captureThrown(() => secondOpened.handoffs.submitHandoffForReview("local", inventoryStale.id, {
      expectedVersion: 1,
      summary: "Inventory is no longer current.",
    }))).toMatchObject({ code: "VERSION_CONFLICT", details: { status: "superseded" } });
  });

  it("rejects arbitrary repository paths, shell commands, unknown execution fields, and oversized handoff payloads", () => {
    const opened = setup();
    const persistedInventory = opened.handoffs.persistRepositoryInventory("local", inventory());
    const base = {
      designId: opened.designId,
      revisionId: opened.revisionId,
      expectedDesignVersion: 1,
      inventoryId: persistedInventory.id,
      specification: specification(),
    };
    expect(captureThrown(() => opened.handoffs.createHandoff("local", {
      ...base,
      repositoryPath: "/Users/private/company-repository",
      shell: "/bin/zsh",
    } as unknown as Parameters<WorkspaceHandoffService["createHandoff"]>[1]))).toMatchObject({ code: "VALIDATION_FAILED" });

    expect(captureThrown(() => opened.handoffs.createHandoff("local", {
      ...base,
      specification: {
        ...specification(),
        implementationSlices: [{
          ...specification().implementationSlices[0],
          sourcePath: "src/Checkout.tsx",
          command: "pnpm test && rm -rf /",
        }],
      },
    }))).toMatchObject({ code: "VALIDATION_FAILED" });

    expect(captureThrown(() => opened.handoffs.createHandoff("local", {
      ...base,
      specification: { ...specification(), notes: "x".repeat(HANDOFF_SPECIFICATION_MAX_BYTES + 1) },
    }))).toMatchObject({ code: "PAYLOAD_TOO_LARGE", statusCode: 413 });
    expect(opened.database.sqlite.prepare("SELECT COUNT(*) AS count FROM handoffs").get()).toEqual({ count: 0 });

    const valid = opened.handoffs.createHandoff("local", base);
    setRole(opened.database, "engineer-user", "engineer");
    expect(captureThrown(() => opened.handoffs.startHandoffImplementation("engineer-user", valid.id, {
      expectedVersion: 1,
      approvedVersion: 1,
      authorization: "start_implementation",
      workspacePath: "/Users/private/company-repository",
      command: "codex --dangerously-bypass-approvals-and-sandbox",
    } as unknown as Parameters<WorkspaceHandoffService["startHandoffImplementation"]>[2]))).toMatchObject({ code: "VALIDATION_FAILED" });
    expect(opened.handoffs.readHandoff("local", valid.id).transitions.map((transition) => transition.toStatus)).toEqual(["draft"]);
  });
});
