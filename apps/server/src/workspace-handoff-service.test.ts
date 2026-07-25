import { createHash } from "node:crypto";

import { DesignDocumentV2Schema, migrateDesignDocumentV1ToV2 } from "@designer/core";
import { afterEach, describe, expect, it } from "vitest";

import { resolveAccess, type OrganizationRole } from "./authorization.js";
import { DesignerDatabase } from "./db/database.js";
import { EventHub } from "./events.js";
import { DEFAULT_ORGANIZATION_POLICY } from "./organization-policy-model.js";
import { OrganizationPolicyService } from "./organization-policy-service.js";
import { operationHash, revisionHash, storeSnapshot } from "./persistence.js";
import { canonicalProductSpecification } from "./product-spec-persistence.js";
import { DesignerService } from "./service.js";
import {
  HANDOFF_SPECIFICATION_MAX_BYTES,
  HANDOFF_EXECUTION_DECISION_MAX_BYTES,
  IMPLEMENTATION_MAPPING_MAX_BATCH_BYTES,
  WORKSPACE_INVENTORY_MAX_BYTES,
  WorkspaceHandoffService,
  type CreateImplementationMappingsRequest,
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

const mappingIds = {
  component: "component_checkoutmapping_0001",
  token: "token_checkoutmapping_000001",
  screen: "node_checkoutmapping_screen01",
  asset: "asset_checkoutmapping_000001",
  flow: "flow_checkoutmapping_0000001",
  businessRule: "rule_checkoutmapping_0000001",
  sourceComponent: `inv_${"1".repeat(40)}`,
  sourceToken: `inv_${"3".repeat(40)}`,
  sourceRoute: `inv_${"5".repeat(40)}`,
  sourceAsset: `inv_${"7".repeat(40)}`,
  sourceFlow: `inv_${"9".repeat(40)}`,
  sourceBusinessRule: `inv_${"a".repeat(40)}`,
} as const;

function upgradeFixtureToV2(opened: Opened) {
  const current = opened.designer.getDesign("local", opened.designId, 1);
  const now = "2026-07-19T12:34:57.000Z";
  const migrated = migrateDesignDocumentV1ToV2({
    ...current.canonicalDocument,
    revision: 2,
    updated_at: now,
  }, { migratedAt: now, sourceRevisionId: current.revision.id, sourceSnapshotHash: current.revision.snapshotHash });
  const sourceFrame = migrated.nodes[opened.frameId];
  if (!sourceFrame || sourceFrame.type !== "frame") throw new Error("Expected a migrated frame.");
  const document = DesignDocumentV2Schema.parse({
    ...migrated,
    nodes: {
      ...migrated.nodes,
      [mappingIds.screen]: {
        ...sourceFrame,
        id: mappingIds.screen,
        name: "Checkout screen",
        children: [],
        screen_purpose: "Complete checkout",
      },
    },
    pages: migrated.pages.map((page, index) => index === 0
      ? { ...page, children: [...page.children, mappingIds.screen] }
      : page),
    tokens: {
      ...migrated.tokens,
      [mappingIds.token]: {
        id: mappingIds.token,
        path: "color.checkout.action",
        name: "Checkout action",
        family: "color",
        layer: "semantic",
        value: "#2457e6",
        deprecated: false,
      },
    },
    assets: {
      ...migrated.assets,
      [mappingIds.asset]: {
        id: mappingIds.asset,
        name: "Legacy checkout asset",
        kind: "binary",
        mime_type: "application/octet-stream",
        size_bytes: 12,
        status: "legacy_quarantined",
        display_filename: "checkout.bin",
        metadata: {},
      },
    },
    component_definitions: {
      ...migrated.component_definitions,
      [mappingIds.component]: {
        id: mappingIds.component,
        key: "checkout.button",
        name: "Checkout button",
        version: 1,
        status: "published",
        root_node_id: opened.frameId,
        properties_schema: [],
        slots: [],
        states: [{ key: "default", name: "Default", node_id: opened.frameId }],
        allowed_overrides: {
          allow_text: false,
          allow_assets: false,
          allow_icons: false,
          allowed_token_families: [],
          allowed_style_paths: [],
        },
        platform_mappings: [],
        documentation: { summary: "", usage: [], accessibility: [], do_list: [], dont_list: [] },
      },
    },
    product_specification: {
      ...migrated.product_specification,
      flows: [{
        id: mappingIds.flow,
        title: "Checkout flow",
        description: "Complete the purchase.",
        links: {},
        role_ids: [],
        steps: [{ id: "step_checkoutmapping_00001", title: "Confirm checkout", conditions: [] }],
      }],
      business_rules: [{
        id: mappingIds.businessRule,
        title: "Checkout eligibility",
        description: "Only eligible carts can complete checkout.",
        links: {},
        conditions: [],
        outcomes: ["Allow checkout for eligible carts."],
        priority: "high",
      }],
    },
  });
  const parent = opened.database.sqlite.prepare(
    "SELECT revision_hash FROM revisions WHERE id = ?",
  ).get(current.revision.id) as { revision_hash: string };
  const revisionId = "revision_mappingv2revision_0001";
  const snapshot = storeSnapshot(opened.database.sqlite, document, now);
  const operationsHash = operationHash([]);
  const integrityHash = revisionHash({
    parentRevisionHash: parent.revision_hash,
    snapshotHash: snapshot.hash,
    operationHash: operationsHash,
    metadata: {
      id: revisionId,
      designId: opened.designId,
      version: 2,
      parentRevisionId: current.revision.id,
      actorId: "local",
      message: "Mapping test V2 revision",
      createdAt: now,
    },
  });
  opened.database.sqlite.prepare(
    `INSERT INTO revisions
     (id, design_id, version, parent_revision_id, actor_id, message, document_json, operations_json,
      snapshot_hash, operation_hash, parent_revision_hash, revision_hash, created_at)
     VALUES (?, ?, 2, ?, 'local', 'Mapping test V2 revision', ?, '[]', ?, ?, ?, ?, ?)`,
  ).run(
    revisionId,
    opened.designId,
    current.revision.id,
    snapshot.canonicalJson,
    snapshot.hash,
    operationsHash,
    parent.revision_hash,
    integrityHash,
    now,
  );
  opened.database.sqlite.prepare(
    "UPDATE designs SET current_version = 2, current_revision_id = ?, updated_at = ? WHERE id = ?",
  ).run(revisionId, now, opened.designId);
  return { revisionId, snapshotHash: snapshot.hash, revisionHash: integrityHash };
}

function mappingInventory(platforms: UploadRepositoryInventory["platforms"] = ["web"]): UploadRepositoryInventory {
  return inventory({
    repositoryFingerprint: "c".repeat(64),
    generatedAt: "2026-07-19T12:20:00.000Z",
    platforms,
    gitHead: "d".repeat(40),
    entities: [
      { id: mappingIds.sourceComponent, kind: "component", name: "CheckoutButton", symbol: "CheckoutButton", locationId: `loc_${"2".repeat(40)}`, line: 42 },
      { id: mappingIds.sourceToken, kind: "token", name: "checkoutAction", symbol: "checkoutAction", locationId: `loc_${"4".repeat(40)}`, line: 9 },
      { id: mappingIds.sourceRoute, kind: "route", name: "Checkout route", symbol: null, locationId: `loc_${"6".repeat(40)}`, line: 18 },
      { id: mappingIds.sourceAsset, kind: "asset", name: "Checkout asset", symbol: "checkoutAsset", locationId: `loc_${"8".repeat(40)}`, line: 7 },
      { id: mappingIds.sourceFlow, kind: "flow", name: "Checkout flow", symbol: "checkoutFlow", locationId: `loc_${"b".repeat(40)}`, line: 64 },
      { id: mappingIds.sourceBusinessRule, kind: "business-rule", name: "Checkout eligibility", symbol: "checkoutEligibility", locationId: `loc_${"c".repeat(40)}`, line: 81 },
    ],
  });
}

function insertLinkedSpecification(opened: Opened, revisionId: string, version: number, summary: string) {
  const result = opened.designer.getDesign("local", opened.designId, 2);
  if (result.canonicalDocument.schema_version !== 2) throw new Error("Expected a V2 mapping fixture.");
  const canonical = canonicalProductSpecification({
    ...result.canonicalDocument.product_specification,
    version,
    summary,
  });
  opened.database.sqlite.prepare(
    `INSERT INTO product_specifications
     (design_id, version, specification_json, organization_id, specification_hash, message,
      revision_id, actor_id, created_at)
     VALUES (?, ?, ?, 'organization_legacy', ?, ?, ?, 'principal_local', ?)`,
  ).run(
    opened.designId,
    version,
    canonical.json,
    canonical.hash,
    summary,
    revisionId,
    `2026-07-19T12:35:0${version}.000Z`,
  );
  return canonical;
}

function mappingRequest(
  opened: Opened,
  revisionId: string,
  inventoryId: string,
  overrides: Partial<CreateImplementationMappingsRequest> = {},
): CreateImplementationMappingsRequest {
  return {
    designId: opened.designId,
    revisionId,
    expectedDesignVersion: 2,
    inventoryId,
    idempotencyKey: "mapping-create-0001",
    mappings: [
      { entityKind: "component", entityId: mappingIds.component, inventoryEntityId: mappingIds.sourceComponent },
      { entityKind: "token", entityId: mappingIds.token, inventoryEntityId: mappingIds.sourceToken },
      { entityKind: "screen", entityId: mappingIds.screen, inventoryEntityId: mappingIds.sourceRoute },
      { entityKind: "asset", entityId: mappingIds.asset, inventoryEntityId: mappingIds.sourceAsset },
      { entityKind: "flow", entityId: mappingIds.flow, inventoryEntityId: mappingIds.sourceFlow },
      { entityKind: "business_rule", entityId: mappingIds.businessRule, inventoryEntityId: mappingIds.sourceBusinessRule },
    ],
    ...overrides,
  };
}

function createMappingGrant(
  database: DesignerDatabase,
  id: string,
  scopes: string[],
  projectIds: string[],
): string {
  const access = resolveAccess(database.sqlite, "local");
  const principalId = `principal_${id}`;
  const now = "2026-07-19T12:00:00.000Z";
  database.sqlite.prepare(
    `INSERT INTO principals (id, organization_id, kind, display_name, external_id, created_at)
     VALUES (?, ?, 'agent', ?, ?, ?)`,
  ).run(principalId, access.organizationId, id, id, now);
  database.sqlite.prepare(
    `INSERT INTO memberships (organization_id, principal_id, role, created_at)
     VALUES (?, ?, 'agent', ?)`,
  ).run(access.organizationId, principalId, now);
  database.sqlite.prepare(
    `INSERT INTO agent_connections
     (id, organization_id, principal_id, adapter, display_name, status, scopes_json, project_ids_json,
      expires_at, created_at, updated_at)
     VALUES (?, ?, ?, 'generic_mcp', ?, 'active', ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`,
  ).run(`connection_${id}`, access.organizationId, principalId, id, JSON.stringify(scopes), JSON.stringify(projectIds), now, now);
  database.sqlite.prepare(
    `INSERT INTO agent_grants
     (id, organization_id, principal_id, token_hash, scopes_json, project_ids_json, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, '2099-01-01T00:00:00.000Z')`,
  ).run(
    id,
    access.organizationId,
    principalId,
    createHash("sha256").update(id).digest("hex"),
    JSON.stringify(scopes),
    JSON.stringify(projectIds),
    now,
  );
  return `grant_${id}`;
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

function prepareImplementingHandoff(opened: Opened) {
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
  handoff = opened.handoffs.submitHandoffForReview("local", handoff.id, {
    expectedVersion: 1,
    summary: "Ready for explicit execution decisions.",
  });
  handoff = opened.handoffs.approveHandoff("pm-user", handoff.id, {
    expectedVersion: 1,
    expectedPriorDecisionId: null,
    decision: "approved",
    summary: "Approve the exact plan and acceptance criteria.",
    acceptanceCriteriaConfirmed: true,
    implementationPlanConfirmed: true,
  });
  opened.handoffs.recordHandoffExecutionDecision("engineer-user", handoff.id, {
    expectedVersion: 1,
    expectedPriorDecisionId: null,
    idempotencyKey: `isolation-${handoff.id}`,
    kind: "isolation_choice",
    outcome: "branch",
    evidence: { summary: "Use a dedicated branch for the implementation." },
  });
  handoff = opened.handoffs.startHandoffImplementation("engineer-user", handoff.id, {
    expectedVersion: 1,
    approvedVersion: 1,
    authorization: "start_implementation",
  });
  return handoff;
}

function recordCoreCompletionApprovals(opened: Opened, handoffId: string, diffHash: string): void {
  opened.handoffs.recordHandoffExecutionDecision("engineer-user", handoffId, {
    expectedVersion: 1,
    expectedPriorDecisionId: null,
    idempotencyKey: `core-diff-${handoffId}`,
    kind: "diff_review",
    outcome: "approved",
    evidence: { summary: "Reviewed the exact bounded implementation diff.", diffHash, changedFileCount: 2 },
  });
  opened.handoffs.recordHandoffExecutionDecision("engineer-user", handoffId, {
    expectedVersion: 1,
    expectedPriorDecisionId: null,
    idempotencyKey: `core-validation-${handoffId}`,
    kind: "validation_approval",
    outcome: "approved",
    evidence: {
      summary: "All validation checks required by the handoff passed.",
      checks: [
        { name: "typecheck", status: "passed" },
        { name: "unit_tests", status: "passed" },
        { name: "accessibility", status: "passed" },
      ],
    },
  });
  opened.handoffs.recordHandoffExecutionDecision("pm-user", handoffId, {
    expectedVersion: 1,
    expectedPriorDecisionId: null,
    idempotencyKey: `core-commit-${handoffId}`,
    kind: "commit_approval",
    outcome: "approved",
    evidence: { summary: "Approve committing the reviewed diff.", diffHash, commitMessage: "Implement approved handoff" },
  });
}

describe("persisted Workspace Bridge repository inventories", () => {
  it("persists a bounded path-free inventory, deduplicates exact retries, and supersedes immutable versions", () => {
    const opened = setup();
    expect(opened.database.schemaVersion()).toBe(17);

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

describe("revision-pinned implementation mappings", () => {
  it("creates a strict path-free batch atomically, pins exact hashes, and replays idempotently", () => {
    const opened = setup();
    const v2 = upgradeFixtureToV2(opened);
    const linkedSpecification = insertLinkedSpecification(opened, v2.revisionId, 2, "Exact implementation mapping specification.");
    const persistedInventory = opened.handoffs.persistRepositoryInventory("local", mappingInventory());
    const request = mappingRequest(opened, v2.revisionId, persistedInventory.id);

    const created = opened.handoffs.createImplementationMappings("local", request);
    expect(created).toMatchObject({
      designId: opened.designId,
      revisionId: v2.revisionId,
      designVersion: 2,
      snapshotHash: v2.snapshotHash,
      revisionHash: v2.revisionHash,
      productSpecificationSource: "revision_link",
      productSpecificationVersion: 2,
      productSpecificationHash: linkedSpecification.hash,
      inventoryId: persistedInventory.id,
      inventoryHash: persistedInventory.inventoryHash,
    });
    expect(created.mappings).toHaveLength(6);
    expect(created.mappings.map((mapping) => mapping.entityKind)).toEqual([
      "component",
      "token",
      "screen",
      "asset",
      "flow",
      "business_rule",
    ]);
    expect(created.mappings.find((mapping) => mapping.entityKind === "screen")).toMatchObject({
      platform: "web",
      symbol: mappingIds.sourceRoute,
      inventoryEntityId: mappingIds.sourceRoute,
      inventoryEntityKind: "route",
      locationId: `loc_${"6".repeat(40)}`,
      line: 18,
    });

    const replay = opened.handoffs.createImplementationMappings("local", request);
    expect(replay).toEqual(created);
    insertLinkedSpecification(opened, v2.revisionId, 3, "Later specification linked to the same immutable design revision.");
    expect(opened.database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM implementation_mappings WHERE design_id = ?",
    ).get(opened.designId)).toEqual({ count: 6 });
    expect(captureThrown(() => opened.handoffs.createImplementationMappings("local", {
      ...request,
      mappings: request.mappings.slice(0, 5),
    }))).toMatchObject({ code: "IDEMPOTENCY_CONFLICT", statusCode: 409 });

    setRole(opened.database, "viewer-user", "viewer");
    const first = created.mappings[0]!;
    expect(opened.handoffs.readImplementationMapping("viewer-user", first.id)).toEqual(first);
    expect(opened.handoffs.listImplementationMappings("viewer-user", {
      designId: opened.designId,
      revisionId: v2.revisionId,
      entityKind: "component",
      limit: "10" as unknown as number,
    })).toEqual([first]);

    const persistedRows = opened.database.sqlite.prepare(
      "SELECT mapping_json FROM implementation_mappings WHERE design_id = ? ORDER BY id",
    ).all(opened.designId) as Array<{ mapping_json: string }>;
    expect(persistedRows).toHaveLength(6);
    for (const row of persistedRows) {
      expect(row.mapping_json).not.toContain("relativePath");
      expect(row.mapping_json).not.toContain("repositoryRoot");
      expect(row.mapping_json).not.toContain("/Users/");
      expect(row.mapping_json).not.toContain("sourcePath");
    }
    expect(() => opened.database.sqlite.prepare(
      "UPDATE implementation_mappings SET symbol = 'Tampered' WHERE id = ?",
    ).run(first.id)).toThrow(/immutable/);
    expect(() => opened.database.sqlite.prepare(
      "DELETE FROM implementation_mappings WHERE id = ?",
    ).run(first.id)).toThrow(/immutable/);
    expect(opened.database.sqlite.prepare(
      "SELECT action, target_type FROM audit_events WHERE action LIKE 'implementation_mapping.%'",
    ).all()).toEqual([{ action: "implementation_mapping.create_batch", target_type: "implementation_mapping" }]);
    expect(opened.database.sqlite.prepare(
      "SELECT event_type, published_at FROM event_outbox WHERE event_type = 'implementation_mapping.changed'",
    ).all()).toEqual([{ event_type: "implementation_mapping.changed", published_at: null }]);
  });

  it("rejects V1, stale pins, unknown entities, incompatible sources, ambiguous platforms, and untrusted fields", () => {
    const opened = setup();
    const initialInventory = opened.handoffs.persistRepositoryInventory("local", mappingInventory());
    expect(captureThrown(() => opened.handoffs.createImplementationMappings("local", {
      designId: opened.designId,
      revisionId: opened.revisionId,
      expectedDesignVersion: 1,
      inventoryId: initialInventory.id,
      idempotencyKey: "mapping-v1-rejected",
      mappings: [{ entityKind: "screen", entityId: opened.frameId, inventoryEntityId: mappingIds.sourceRoute }],
    }))).toMatchObject({
      code: "VALIDATION_FAILED",
      statusCode: 422,
      details: { requiredSchemaVersion: 2, actualSchemaVersion: 1 },
    });

    const v2 = upgradeFixtureToV2(opened);
    expect(captureThrown(() => opened.handoffs.createImplementationMappings("local", mappingRequest(
      opened,
      v2.revisionId,
      initialInventory.id,
      { expectedDesignVersion: 3, idempotencyKey: "mapping-stale-version" },
    )))).toMatchObject({ code: "VERSION_CONFLICT", statusCode: 409 });
    expect(captureThrown(() => opened.handoffs.createImplementationMappings("local", mappingRequest(
      opened,
      v2.revisionId,
      initialInventory.id,
      {
        idempotencyKey: "mapping-unknown-flow",
        mappings: [{ entityKind: "flow", entityId: "flow_missingmapping_0001", inventoryEntityId: mappingIds.sourceFlow }],
      },
    )))).toMatchObject({ code: "VALIDATION_FAILED", details: { entityKind: "flow" } });
    expect(captureThrown(() => opened.handoffs.createImplementationMappings("local", mappingRequest(
      opened,
      v2.revisionId,
      initialInventory.id,
      {
        idempotencyKey: "mapping-incompatible-source",
        mappings: [{ entityKind: "component", entityId: mappingIds.component, inventoryEntityId: mappingIds.sourceToken }],
      },
    )))).toMatchObject({
      code: "VALIDATION_FAILED",
      details: { designEntityKind: "component", inventoryEntityKind: "token" },
    });

    const ambiguousInventory = opened.handoffs.persistRepositoryInventory("local", mappingInventory(["web", "android"]));
    expect(captureThrown(() => opened.handoffs.createImplementationMappings("local", mappingRequest(
      opened,
      v2.revisionId,
      ambiguousInventory.id,
      { idempotencyKey: "mapping-ambiguous-platform" },
    )))).toMatchObject({
      code: "AMBIGUOUS_CONTEXT",
      statusCode: 409,
      details: { platforms: ["web", "android"], requiredAction: "upload_per_platform_inventory" },
    });

    expect(captureThrown(() => opened.handoffs.createImplementationMappings("local", {
      ...mappingRequest(opened, v2.revisionId, ambiguousInventory.id, { idempotencyKey: "mapping-path-field" }),
      mappings: [{
        entityKind: "component",
        entityId: mappingIds.component,
        inventoryEntityId: mappingIds.sourceComponent,
        sourcePath: "/Users/private/company/Checkout.tsx",
        symbol: "InjectedSymbol",
      }],
    } as unknown as CreateImplementationMappingsRequest))).toMatchObject({ code: "VALIDATION_FAILED" });
    expect(captureThrown(() => opened.handoffs.createImplementationMappings("local", {
      ...mappingRequest(opened, v2.revisionId, ambiguousInventory.id, { idempotencyKey: "mapping-oversized" }),
      diagnostic: "x".repeat(IMPLEMENTATION_MAPPING_MAX_BATCH_BYTES + 1),
    } as unknown as CreateImplementationMappingsRequest))).toMatchObject({ code: "PAYLOAD_TOO_LARGE", statusCode: 413 });
    expect(opened.database.sqlite.prepare("SELECT COUNT(*) AS count FROM implementation_mappings").get()).toEqual({ count: 0 });
  });

  it("rolls back every mapping, audit event, outbox event, and idempotency record when one insert fails", () => {
    const opened = setup();
    const v2 = upgradeFixtureToV2(opened);
    const persistedInventory = opened.handoffs.persistRepositoryInventory("local", mappingInventory());
    opened.database.sqlite.exec(`
      CREATE TRIGGER implementation_mapping_test_failure
      BEFORE INSERT ON implementation_mappings
      WHEN NEW.entity_kind = 'token'
      BEGIN SELECT RAISE(ABORT, 'forced mapping failure'); END;
    `);
    const request = mappingRequest(opened, v2.revisionId, persistedInventory.id, {
      idempotencyKey: "mapping-atomic-failure",
      mappings: [
        { entityKind: "component", entityId: mappingIds.component, inventoryEntityId: mappingIds.sourceComponent },
        { entityKind: "token", entityId: mappingIds.token, inventoryEntityId: mappingIds.sourceToken },
      ],
    });
    expect(() => opened.handoffs.createImplementationMappings("local", request)).toThrow(/forced mapping failure/);
    expect(opened.database.sqlite.prepare("SELECT COUNT(*) AS count FROM implementation_mappings").get()).toEqual({ count: 0 });
    expect(opened.database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM audit_events WHERE action LIKE 'implementation_mapping.%'",
    ).get()).toEqual({ count: 0 });
    expect(opened.database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM event_outbox WHERE event_type = 'implementation_mapping.changed'",
    ).get()).toEqual({ count: 0 });
    expect(opened.database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM idempotency WHERE scope LIKE 'implementation_mapping:%'",
    ).get()).toEqual({ count: 0 });
  });

  it("enforces human roles, agent scopes, and project restrictions for writes and reads", () => {
    const opened = setup();
    const v2 = upgradeFixtureToV2(opened);
    const persistedInventory = opened.handoffs.persistRepositoryInventory("local", mappingInventory());
    const request = mappingRequest(opened, v2.revisionId, persistedInventory.id, {
      idempotencyKey: "mapping-authorized-agent",
      mappings: [{ entityKind: "component", entityId: mappingIds.component, inventoryEntityId: mappingIds.sourceComponent }],
    });
    setRole(opened.database, "pm-user", "product_manager");
    expect(captureThrown(() => opened.handoffs.createImplementationMappings("pm-user", {
      ...request,
      idempotencyKey: "mapping-product-manager-denied",
    }))).toMatchObject({ code: "FORBIDDEN", statusCode: 403 });

    const readOnly = createMappingGrant(
      opened.database,
      "mapping_read_only",
      ["implementation_mapping:read"],
      [opened.designId],
    );
    expect(captureThrown(() => opened.handoffs.createImplementationMappings(readOnly, {
      ...request,
      idempotencyKey: "mapping-read-scope-denied",
    }))).toMatchObject({ code: "FORBIDDEN", statusCode: 403 });

    const writer = createMappingGrant(
      opened.database,
      "mapping_writer",
      ["implementation_mapping:read", "implementation_mapping:write"],
      [opened.designId],
    );
    const created = opened.handoffs.createImplementationMappings(writer, request);
    expect(created.mappings).toHaveLength(1);
    opened.database.sqlite.prepare(
      "UPDATE agent_grants SET project_ids_json = ? WHERE id = 'mapping_writer'",
    ).run(JSON.stringify(["document_accessrevoked_0001"]));
    expect(captureThrown(() => opened.handoffs.createImplementationMappings(writer, request)))
      .toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
    expect(opened.handoffs.readImplementationMapping(readOnly, created.mappings[0]!.id)).toEqual(created.mappings[0]);
    expect(opened.handoffs.listImplementationMappings(readOnly, { designId: opened.designId })).toEqual(created.mappings);
    expect(opened.handoffs.listImplementationMappings("pm-user", { designId: opened.designId })).toEqual(created.mappings);

    const wrongProject = createMappingGrant(
      opened.database,
      "mapping_wrong_project",
      ["implementation_mapping:read", "implementation_mapping:write"],
      ["document_unrelatedproject_0001"],
    );
    expect(captureThrown(() => opened.handoffs.listImplementationMappings(wrongProject, {
      designId: opened.designId,
    }))).toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
    expect(captureThrown(() => opened.handoffs.createImplementationMappings(wrongProject, {
      ...request,
      idempotencyKey: "mapping-wrong-project-denied",
    }))).toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
  });

  it("keeps mapping evidence immutable but makes it opaque after project archival", () => {
    const opened = setup();
    const v2 = upgradeFixtureToV2(opened);
    const persistedInventory = opened.handoffs.persistRepositoryInventory("local", mappingInventory());
    const created = opened.handoffs.createImplementationMappings("local", mappingRequest(
      opened,
      v2.revisionId,
      persistedInventory.id,
      {
        idempotencyKey: "mapping-archive-opacity-0001",
        mappings: [{
          entityKind: "component",
          entityId: mappingIds.component,
          inventoryEntityId: mappingIds.sourceComponent,
        }],
      },
    ));
    const design = opened.designer.getDesign("local", opened.designId, 2);
    opened.designer.archiveDesign("local", opened.designId, {
      expectedVersion: 2,
      idempotencyKey: "mapping-project-archive-0001",
      confirmationName: design.design.name,
    });

    expect(captureThrown(() => opened.handoffs.readImplementationMapping(
      "local",
      created.mappings[0]!.id,
    ))).toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
    expect(captureThrown(() => opened.handoffs.listImplementationMappings("local", {
      designId: opened.designId,
    }))).toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
    expect(captureThrown(() => opened.handoffs.createImplementationMappings("local", {
      ...mappingRequest(opened, v2.revisionId, persistedInventory.id),
      idempotencyKey: "mapping-after-project-archive-0001",
    }))).toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
    expect(opened.database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM implementation_mappings WHERE design_id = ?",
    ).get(opened.designId)).toEqual({ count: 1 });
  });
});

describe("approval-gated engineering handoffs", () => {
  it("filters archived-project handoffs before pagination and rejects retained IDs as not found", () => {
    const opened = setup();
    const persistedInventory = opened.handoffs.persistRepositoryInventory("local", inventory());
    const handoff = opened.handoffs.createHandoff("local", {
      designId: opened.designId,
      revisionId: opened.revisionId,
      expectedDesignVersion: 1,
      inventoryId: persistedInventory.id,
      specification: specification(),
    });
    const design = opened.designer.getDesign("local", opened.designId, 1);
    opened.designer.archiveDesign("local", opened.designId, {
      expectedVersion: 1,
      idempotencyKey: "handoff-project-archive-0001",
      confirmationName: design.design.name,
    });

    expect(captureThrown(() => opened.handoffs.readHandoff("local", handoff.id)))
      .toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
    expect(captureThrown(() => opened.handoffs.updateHandoff("local", handoff.id, {
      expectedVersion: 1,
      specification: specification({ summary: "Archived projects remain immutable and hidden." }),
    }))).toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
    expect(opened.handoffs.listHandoffs("local", { limit: 1 })).toEqual([]);
    expect(opened.handoffs.listHandoffSummaries("local", { limit: 1 })).toEqual({
      handoffs: [],
      nextCursor: null,
    });
    expect(captureThrown(() => opened.handoffs.listHandoffs("local", {
      designId: opened.designId,
    }))).toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
    expect(captureThrown(() => opened.handoffs.listHandoffSummaries("local", {
      designId: opened.designId,
    }))).toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
    expect(captureThrown(() => opened.handoffs.createHandoff("local", {
      designId: opened.designId,
      revisionId: opened.revisionId,
      expectedDesignVersion: 1,
      inventoryId: persistedInventory.id,
      specification: specification(),
    }))).toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
    expect(opened.database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM handoffs WHERE id = ?",
    ).get(handoff.id)).toEqual({ count: 1 });
  });

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
      expectedPriorDecisionId: null,
      decision: "approved",
      summary: "Engineer cannot self-authorize through this role.",
      acceptanceCriteriaConfirmed: true,
      implementationPlanConfirmed: true,
    }))).toMatchObject({ code: "FORBIDDEN" });
    expect(captureThrown(() => opened.handoffs.approveHandoff("pm-user", handoff.id, {
      expectedVersion: 2,
      expectedPriorDecisionId: null,
      decision: "approved",
      summary: "Missing explicit plan confirmation.",
      acceptanceCriteriaConfirmed: true,
      implementationPlanConfirmed: false,
    } as unknown as Parameters<WorkspaceHandoffService["approveHandoff"]>[2]))).toMatchObject({ code: "VALIDATION_FAILED" });

    const deniedPlan = opened.handoffs.recordHandoffExecutionDecision("pm-user", handoff.id, {
      expectedVersion: 2,
      expectedPriorDecisionId: null,
      idempotencyKey: "handoff-plan-denied-before-approval-0001",
      kind: "plan_approval",
      outcome: "denied",
      evidence: { reason: "The product plan needs one more explicit review." },
    });
    expect(captureThrown(() => opened.handoffs.approveHandoff("pm-user", handoff.id, {
      expectedVersion: 2,
      expectedPriorDecisionId: null,
      decision: "approved",
      summary: "A stale approval must not overwrite the newer denial.",
      acceptanceCriteriaConfirmed: true,
      implementationPlanConfirmed: true,
    }))).toMatchObject({
      code: "VERSION_CONFLICT",
      details: { expectedPriorDecisionId: null, currentDecisionId: deniedPlan.id },
    });

    handoff = opened.handoffs.approveHandoff("pm-user", handoff.id, {
      expectedVersion: 2,
      expectedPriorDecisionId: deniedPlan.id,
      decision: "approved",
      summary: "Acceptance criteria and implementation slices reviewed.",
      acceptanceCriteriaConfirmed: true,
      implementationPlanConfirmed: true,
    });
    expect(handoff.status).toBe("approved");
    expect(handoff.executionDecisionState.plan_approval).toMatchObject({
      kind: "plan_approval",
      outcome: "approved",
      sequence: 2,
      supersedesDecisionId: deniedPlan.id,
    });
    expect(captureThrown(() => opened.handoffs.updateHandoff("local", handoff.id, {
      expectedVersion: 2,
      specification: specification({ summary: "Unapproved post-approval edit" }),
    }))).toMatchObject({ code: "VERSION_CONFLICT" });
    expect(captureThrown(() => opened.handoffs.startHandoffImplementation("engineer-user", handoff.id, {
      expectedVersion: 2,
      approvedVersion: 2,
      authorization: "start_implementation",
    }))).toMatchObject({
      code: "VERSION_CONFLICT",
      details: { missingOrBlocked: ["isolation_choice"] },
    });

    const isolation = opened.handoffs.recordHandoffExecutionDecision("engineer-user", handoff.id, {
      expectedVersion: 2,
      expectedPriorDecisionId: null,
      idempotencyKey: "handoff-isolation-worktree-0001",
      kind: "isolation_choice",
      outcome: "worktree",
      evidence: { summary: "Use an isolated worktree for the approved handoff." },
    });
    expect(opened.handoffs.recordHandoffExecutionDecision("engineer-user", handoff.id, {
      expectedVersion: 2,
      expectedPriorDecisionId: null,
      idempotencyKey: "handoff-isolation-worktree-0001",
      kind: "isolation_choice",
      outcome: "worktree",
      evidence: { summary: "Use an isolated worktree for the approved handoff." },
    })).toEqual(isolation);

    handoff = opened.handoffs.startHandoffImplementation("engineer-user", handoff.id, {
      expectedVersion: 2,
      approvedVersion: 2,
      authorization: "start_implementation",
    });
    expect(handoff.status).toBe("implementing");
    expect(captureThrown(() => opened.handoffs.completeHandoffImplementation("engineer-user", handoff.id, {
      expectedVersion: 2,
      summary: "Self-asserted booleans are no longer accepted.",
      diffReviewed: true,
      validationApproved: true,
      commitApproved: true,
      pullRequestRequested: false,
    } as unknown as Parameters<WorkspaceHandoffService["completeHandoffImplementation"]>[2]))).toMatchObject({ code: "VALIDATION_FAILED" });

    const diffHash = "d".repeat(64);
    opened.handoffs.recordHandoffExecutionDecision("engineer-user", handoff.id, {
      expectedVersion: 2,
      expectedPriorDecisionId: null,
      idempotencyKey: "handoff-diff-review-0001",
      kind: "diff_review",
      outcome: "approved",
      evidence: { summary: "Reviewed the bounded workspace diff.", diffHash, changedFileCount: 4 },
    });
    opened.handoffs.recordHandoffExecutionDecision("engineer-user", handoff.id, {
      expectedVersion: 2,
      expectedPriorDecisionId: null,
      idempotencyKey: "handoff-validation-approval-0001",
      kind: "validation_approval",
      outcome: "approved",
      evidence: {
        summary: "All validation required by the handoff plan passed.",
        checks: [
          { name: "typecheck", status: "passed" },
          { name: "unit_tests", status: "passed", evidenceHash: "a".repeat(64) },
          { name: "accessibility", status: "passed" },
        ],
      },
    });
    opened.handoffs.recordHandoffExecutionDecision("pm-user", handoff.id, {
      expectedVersion: 2,
      expectedPriorDecisionId: null,
      idempotencyKey: "handoff-commit-approval-0001",
      kind: "commit_approval",
      outcome: "approved",
      evidence: { summary: "Approve committing the reviewed diff.", diffHash, commitMessage: "Implement approved checkout refinement" },
    });
    opened.handoffs.recordHandoffExecutionDecision("pm-user", handoff.id, {
      expectedVersion: 2,
      expectedPriorDecisionId: null,
      idempotencyKey: "handoff-push-authorization-0001",
      kind: "push_authorization",
      outcome: "authorized",
      evidence: { summary: "Authorize pushing the approved commit.", commitHash: "b".repeat(40), targetRef: "feature/checkout-refinement" },
    });
    opened.handoffs.recordHandoffExecutionDecision("pm-user", handoff.id, {
      expectedVersion: 2,
      expectedPriorDecisionId: null,
      idempotencyKey: "handoff-pull-request-0001",
      kind: "pull_request_request",
      outcome: "requested",
      evidence: {
        summary: "Request a reviewed pull request for the approved implementation.",
        title: "Implement checkout refinement",
        baseRef: "main",
        headRef: "feature/checkout-refinement",
      },
    });

    handoff = opened.handoffs.completeHandoffImplementation("engineer-user", handoff.id, {
      expectedVersion: 2,
      summary: "Completion derives every required gate from immutable decision records.",
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
    expect(handoff.transitions.at(-1)?.details).toMatchObject({
      isolationMode: "worktree",
      diffHash,
      validationChecks: ["accessibility", "typecheck", "unit_tests"],
      pushAuthorized: true,
      pullRequestRequested: true,
    });
    expect(handoff.executionDecisions.map((decision) => decision.kind)).toEqual([
      "plan_approval",
      "plan_approval",
      "isolation_choice",
      "diff_review",
      "validation_approval",
      "commit_approval",
      "push_authorization",
      "pull_request_request",
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
      { action: "handoff.execution_decision.plan_approval" },
      { action: "handoff.execution_decision.plan_approval" },
      { action: "handoff.approve" },
      { action: "handoff.execution_decision.isolation_choice" },
      { action: "handoff.start_implementation" },
      { action: "handoff.execution_decision.diff_review" },
      { action: "handoff.execution_decision.validation_approval" },
      { action: "handoff.execution_decision.commit_approval" },
      { action: "handoff.execution_decision.push_authorization" },
      { action: "handoff.execution_decision.pull_request_request" },
      { action: "handoff.complete" },
    ]);
  });

  it("keeps decision replacements, denials, and revocations append-only with prior-decision CAS", () => {
    const opened = setup();
    const handoff = prepareImplementingHandoff(opened);
    const diffHash = "c".repeat(64);
    const approved = opened.handoffs.recordHandoffExecutionDecision("engineer-user", handoff.id, {
      expectedVersion: 1,
      expectedPriorDecisionId: null,
      idempotencyKey: "decision-cas-diff-approved-0001",
      kind: "diff_review",
      outcome: "approved",
      evidence: { summary: "The first bounded diff review passed.", diffHash, changedFileCount: 2 },
    });
    expect(captureThrown(() => opened.handoffs.recordHandoffExecutionDecision("engineer-user", handoff.id, {
      expectedVersion: 1,
      expectedPriorDecisionId: null,
      idempotencyKey: "decision-cas-stale-prior-0001",
      kind: "diff_review",
      outcome: "denied",
      evidence: { reason: "This stale writer must not replace the approved review." },
    }))).toMatchObject({
      code: "VERSION_CONFLICT",
      details: { expectedPriorDecisionId: null, currentDecisionId: approved.id },
    });

    const revoked = opened.handoffs.recordHandoffExecutionDecision("engineer-user", handoff.id, {
      expectedVersion: 1,
      expectedPriorDecisionId: approved.id,
      idempotencyKey: "decision-cas-diff-revoked-0001",
      kind: "diff_review",
      outcome: "revoked",
      evidence: { reason: "A later workspace change invalidated the reviewed diff." },
    });
    expect(captureThrown(() => opened.handoffs.completeHandoffImplementation("engineer-user", handoff.id, {
      expectedVersion: 1,
      summary: "Revoked review must block completion.",
    }))).toMatchObject({
      code: "VERSION_CONFLICT",
      details: {
        missingOrBlocked: [
          "diff_review",
          "validation_approval",
          "commit_approval",
          "push_authorization",
          "pull_request_request",
        ],
      },
    });

    const replacement = opened.handoffs.recordHandoffExecutionDecision("engineer-user", handoff.id, {
      expectedVersion: 1,
      expectedPriorDecisionId: revoked.id,
      idempotencyKey: "decision-cas-diff-reapproved-0001",
      kind: "diff_review",
      outcome: "approved",
      evidence: { summary: "Reviewed the replacement diff after the workspace change.", diffHash, changedFileCount: 3 },
    });
    const read = opened.handoffs.readHandoffExecutionDecisions("local", handoff.id);
    expect(read.decisions.map((decision) => ({
      sequence: decision.sequence,
      kind: decision.kind,
      outcome: decision.outcome,
      supersedesDecisionId: decision.supersedesDecisionId,
    }))).toEqual([
      { sequence: 1, kind: "plan_approval", outcome: "approved", supersedesDecisionId: null },
      { sequence: 2, kind: "isolation_choice", outcome: "branch", supersedesDecisionId: null },
      { sequence: 3, kind: "diff_review", outcome: "approved", supersedesDecisionId: null },
      { sequence: 4, kind: "diff_review", outcome: "revoked", supersedesDecisionId: approved.id },
      { sequence: 5, kind: "diff_review", outcome: "approved", supersedesDecisionId: revoked.id },
    ]);
    expect(read.current.diff_review?.id).toBe(replacement.id);
    expect(opened.handoffs.readHandoff("local", handoff.id).executionDecisionState).toEqual(read.current);
    expect(() => opened.database.sqlite.prepare(
      "UPDATE handoff_execution_decisions SET outcome = 'denied' WHERE id = ?",
    ).run(approved.id)).toThrow(/immutable/);
    expect(() => opened.database.sqlite.prepare(
      "DELETE FROM handoff_execution_decisions WHERE id = ?",
    ).run(approved.id)).toThrow(/immutable/);
    const directEvidence = {
      summary: "A direct stale insert must fail the database CAS trigger.",
      diffHash,
      changedFileCount: 3,
    };
    expect(() => opened.database.sqlite.prepare(
      `INSERT INTO handoff_execution_decisions
       (id, handoff_id, handoff_version, sequence, kind, outcome, supersedes_decision_id,
        evidence_json, evidence_hash, actor_id, created_at)
       VALUES (?, ?, 1, 99, 'diff_review', 'approved', ?, ?, ?, 'principal_local', ?)`,
    ).run(
      `handoff_decision_${"f".repeat(32)}`,
      handoff.id,
      approved.id,
      JSON.stringify(directEvidence),
      createHash("sha256").update(JSON.stringify(directEvidence)).digest("hex"),
      "2026-07-19T12:40:00.000Z",
    )).toThrow(/append-only CAS or lifecycle integrity/);
  });

  it("requires persisted push and pull-request dispositions and supports explicit no-push/no-PR completion", () => {
    const opened = setup();
    let handoff = prepareImplementingHandoff(opened);
    const diffHash = "9".repeat(64);
    recordCoreCompletionApprovals(opened, handoff.id, diffHash);

    expect(captureThrown(() => opened.handoffs.completeHandoffImplementation("engineer-user", handoff.id, {
      expectedVersion: 1,
      summary: "Missing push and pull-request decisions must not default to false.",
    }))).toMatchObject({
      code: "VERSION_CONFLICT",
      details: { missingOrBlocked: ["push_authorization", "pull_request_request"] },
    });

    opened.handoffs.recordHandoffExecutionDecision("pm-user", handoff.id, {
      expectedVersion: 1,
      expectedPriorDecisionId: null,
      idempotencyKey: "explicit-no-push-0001",
      kind: "push_authorization",
      outcome: "denied",
      evidence: { reason: "Keep the approved commit local for this handoff." },
    });
    opened.handoffs.recordHandoffExecutionDecision("pm-user", handoff.id, {
      expectedVersion: 1,
      expectedPriorDecisionId: null,
      idempotencyKey: "explicit-no-pull-request-0001",
      kind: "pull_request_request",
      outcome: "not_requested",
      evidence: { reason: "No pull request is requested for this local-only implementation." },
    });
    handoff = opened.handoffs.completeHandoffImplementation("engineer-user", handoff.id, {
      expectedVersion: 1,
      summary: "Complete with explicit persisted no-push and no-PR decisions.",
    });
    expect(handoff.status).toBe("completed");
    expect(handoff.transitions.at(-1)?.details).toMatchObject({
      pushDecision: "denied",
      pullRequestDecision: "not_requested",
      pushAuthorized: false,
      pullRequestRequested: false,
    });
  });

  it("treats append-only revocation as an explicit negative disposition without reviving prior authority", () => {
    const opened = setup();
    let handoff = prepareImplementingHandoff(opened);
    recordCoreCompletionApprovals(opened, handoff.id, "8".repeat(64));
    const push = opened.handoffs.recordHandoffExecutionDecision("pm-user", handoff.id, {
      expectedVersion: 1,
      expectedPriorDecisionId: null,
      idempotencyKey: "revoked-push-authorized-0001",
      kind: "push_authorization",
      outcome: "authorized",
      evidence: { summary: "Initially authorize the approved commit.", commitHash: "7".repeat(40), targetRef: "feature/revoked-authority" },
    });
    const pullRequest = opened.handoffs.recordHandoffExecutionDecision("pm-user", handoff.id, {
      expectedVersion: 1,
      expectedPriorDecisionId: null,
      idempotencyKey: "revoked-pr-requested-0001",
      kind: "pull_request_request",
      outcome: "requested",
      evidence: {
        summary: "Initially request a pull request.",
        title: "Revoked authority fixture",
        baseRef: "main",
        headRef: "feature/revoked-authority",
      },
    });
    opened.handoffs.recordHandoffExecutionDecision("pm-user", handoff.id, {
      expectedVersion: 1,
      expectedPriorDecisionId: pullRequest.id,
      idempotencyKey: "revoked-pr-withdrawn-0001",
      kind: "pull_request_request",
      outcome: "revoked",
      evidence: { reason: "Withdraw the pull-request request before completion." },
    });
    opened.handoffs.recordHandoffExecutionDecision("pm-user", handoff.id, {
      expectedVersion: 1,
      expectedPriorDecisionId: push.id,
      idempotencyKey: "revoked-push-withdrawn-0001",
      kind: "push_authorization",
      outcome: "revoked",
      evidence: { reason: "Withdraw push authorization before completion." },
    });
    handoff = opened.handoffs.completeHandoffImplementation("engineer-user", handoff.id, {
      expectedVersion: 1,
      summary: "Complete locally after both external actions were explicitly revoked.",
    });
    expect(handoff.transitions.at(-1)?.details).toMatchObject({
      pushDecision: "revoked",
      pullRequestDecision: "revoked",
      pushAuthorized: false,
      pullRequestRequested: false,
    });
  });

  it("keeps historical-version decisions visible without treating them as current after a new handoff version", () => {
    const opened = setup();
    setRole(opened.database, "pm-user", "product_manager");
    const persistedInventory = opened.handoffs.persistRepositoryInventory("local", inventory());
    let handoff = opened.handoffs.createHandoff("local", {
      designId: opened.designId,
      revisionId: opened.revisionId,
      expectedDesignVersion: 1,
      inventoryId: persistedInventory.id,
      specification: specification(),
    });
    handoff = opened.handoffs.submitHandoffForReview("local", handoff.id, {
      expectedVersion: 1,
      summary: "Review version one.",
    });
    const denied = opened.handoffs.recordHandoffExecutionDecision("pm-user", handoff.id, {
      expectedVersion: 1,
      expectedPriorDecisionId: null,
      idempotencyKey: "handoff-version-one-plan-denied-0001",
      kind: "plan_approval",
      outcome: "denied",
      evidence: { reason: "Version one needs a corrected implementation slice." },
    });
    handoff = opened.handoffs.returnHandoffToDraft("pm-user", handoff.id, {
      expectedVersion: 1,
      reason: "Revise the implementation slice.",
    });
    handoff = opened.handoffs.updateHandoff("local", handoff.id, {
      expectedVersion: 1,
      specification: specification({ summary: "Corrected version-two handoff." }),
    });
    const read = opened.handoffs.readHandoffExecutionDecisions("local", handoff.id);
    expect(read.decisions).toEqual([denied]);
    expect(read.current.plan_approval).toBeNull();
    expect(opened.handoffs.readHandoff("local", handoff.id).executionDecisionState.plan_approval).toBeNull();
  });

  it("enforces decision-specific roles, agent scopes, project restrictions, strict evidence, and atomic audit/outbox writes", () => {
    const opened = setup();
    const handoff = prepareImplementingHandoff(opened);
    const diffHash = "e".repeat(64);
    expect(captureThrown(() => opened.handoffs.recordHandoffExecutionDecision("engineer-user", handoff.id, {
      expectedVersion: 1,
      expectedPriorDecisionId: null,
      idempotencyKey: "decision-role-commit-denied-0001",
      kind: "commit_approval",
      outcome: "approved",
      evidence: { summary: "An engineer cannot self-approve commit.", diffHash, commitMessage: "Unsafe self approval" },
    }))).toMatchObject({ code: "FORBIDDEN", statusCode: 403 });

    expect(captureThrown(() => opened.handoffs.recordHandoffExecutionDecision("engineer-user", handoff.id, {
      expectedVersion: 1,
      expectedPriorDecisionId: null,
      idempotencyKey: "decision-strict-evidence-0001",
      kind: "diff_review",
      outcome: "approved",
      evidence: {
        summary: "Unknown source paths are forbidden from central decision evidence.",
        diffHash,
        changedFileCount: 1,
        sourcePath: "/Users/private/company/src/Checkout.tsx",
      },
    } as unknown as Parameters<WorkspaceHandoffService["recordHandoffExecutionDecision"]>[2])))
      .toMatchObject({ code: "VALIDATION_FAILED", statusCode: 422 });
    expect(captureThrown(() => opened.handoffs.recordHandoffExecutionDecision("engineer-user", handoff.id, {
      expectedVersion: 1,
      expectedPriorDecisionId: null,
      idempotencyKey: "decision-oversized-evidence-0001",
      kind: "diff_review",
      outcome: "denied",
      evidence: { reason: "x".repeat(HANDOFF_EXECUTION_DECISION_MAX_BYTES + 1) },
    }))).toMatchObject({ code: "PAYLOAD_TOO_LARGE", statusCode: 413 });

    const readOnlyAgent = createMappingGrant(
      opened.database,
      "handoff_decision_read_only",
      ["handoff:read"],
      [opened.designId],
    );
    expect(captureThrown(() => opened.handoffs.recordHandoffExecutionDecision(readOnlyAgent, handoff.id, {
      expectedVersion: 1,
      expectedPriorDecisionId: null,
      idempotencyKey: "decision-agent-scope-denied-0001",
      kind: "diff_review",
      outcome: "approved",
      evidence: { summary: "Missing the exact decision scope.", diffHash, changedFileCount: 1 },
    }))).toMatchObject({ code: "FORBIDDEN", statusCode: 403 });

    const decisionAgent = createMappingGrant(
      opened.database,
      "handoff_decision_writer",
      ["handoff:read", "handoff:execution:diff_review"],
      [opened.designId],
    );
    opened.database.sqlite.exec(`
      CREATE TRIGGER handoff_execution_decision_test_failure
      BEFORE INSERT ON handoff_execution_decisions
      WHEN NEW.kind = 'diff_review'
      BEGIN SELECT RAISE(ABORT, 'forced decision failure'); END;
    `);
    expect(() => opened.handoffs.recordHandoffExecutionDecision(decisionAgent, handoff.id, {
      expectedVersion: 1,
      expectedPriorDecisionId: null,
      idempotencyKey: "decision-agent-atomic-failure-0001",
      kind: "diff_review",
      outcome: "approved",
      evidence: { summary: "This insert is forced to roll back.", diffHash, changedFileCount: 1 },
    })).toThrow(/forced decision failure/);
    expect(opened.database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM handoff_execution_decisions WHERE handoff_id = ? AND kind = 'diff_review'",
    ).get(handoff.id)).toEqual({ count: 0 });
    expect(opened.database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'handoff.execution_decision.diff_review'",
    ).get()).toEqual({ count: 0 });
    expect(opened.database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM idempotency WHERE scope LIKE '%:execution_decision:diff_review'",
    ).get()).toEqual({ count: 0 });
    opened.database.sqlite.exec("DROP TRIGGER handoff_execution_decision_test_failure");

    const created = opened.handoffs.recordHandoffExecutionDecision(decisionAgent, handoff.id, {
      expectedVersion: 1,
      expectedPriorDecisionId: null,
      idempotencyKey: "decision-agent-authorized-0001",
      kind: "diff_review",
      outcome: "approved",
      evidence: { summary: "The exact scoped decision is authorized.", diffHash, changedFileCount: 1 },
    });
    expect(created.kind).toBe("diff_review");
    opened.database.sqlite.prepare(
      "UPDATE agent_grants SET project_ids_json = ? WHERE id = 'handoff_decision_writer'",
    ).run(JSON.stringify(["document_unrelatedproject_0001"]));
    expect(captureThrown(() => opened.handoffs.readHandoffExecutionDecisions(decisionAgent, handoff.id)))
      .toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
    expect(opened.database.sqlite.prepare(
      "SELECT event_type, published_at FROM event_outbox WHERE event_type = 'handoff.transitioned' AND payload_json LIKE '%diff_review%'",
    ).all()).toEqual([{ event_type: "handoff.transitioned", published_at: null }]);
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
      expectedPriorDecisionId: null,
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
