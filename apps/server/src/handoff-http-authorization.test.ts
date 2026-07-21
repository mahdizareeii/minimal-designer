import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { resolveAccess } from "./authorization.js";
import { loadConfig } from "./config.js";
import type { DomainError } from "./errors.js";
import { PROTECTED_NON_MCP_ROUTE_CONTRACTS } from "./public-route-contract.js";
import type {
  HandoffResult,
  HandoffSpecification,
  RepositoryInventoryResult,
  UploadRepositoryInventory,
} from "./workspace-handoff-service.js";

const PROXY_SECRET = "handoff-http-proxy-secret-0123456789abcdef";
const ADMIN = "handoff-admin@example.test";
const PRODUCT_MANAGER = "handoff-pm@example.test";
const ENGINEER = "handoff-engineer@example.test";
const EDITOR_A = "handoff-editor-a@example.test";
const EDITOR_B = "handoff-editor-b@example.test";
const VIEWER = "handoff-viewer@example.test";

const HANDOFF_ROUTE_KEYS = [
  "GET /api/designs/:id/handoffs",
  "POST /api/designs/:id/handoffs",
  "GET /api/handoffs/:handoffId",
  "PUT /api/handoffs/:handoffId",
  "POST /api/handoffs/:handoffId/submit-review",
  "POST /api/handoffs/:handoffId/return-draft",
  "POST /api/handoffs/:handoffId/approve",
  "POST /api/handoffs/:handoffId/start-implementation",
  "GET /api/handoffs/:handoffId/execution-decisions",
  "POST /api/handoffs/:handoffId/execution-decisions",
  "POST /api/handoffs/:handoffId/complete",
  "POST /api/handoffs/:handoffId/cancel",
] as const;

const applications: DesignerApplication[] = [];
const temporaryDirectories: string[] = [];

interface DesignFixture {
  id: string;
  revisionId: string;
  version: number;
}

interface ForeignFixture {
  actorId: string;
  token: string;
  design: DesignFixture;
  inventory: RepositoryInventoryResult;
  handoff: HandoffResult;
}

interface HandoffHttpFixture {
  application: DesignerApplication;
  allowed: DesignFixture;
  denied: DesignFixture;
  allowedInventory: RepositoryInventoryResult;
  deniedInventory: RepositoryInventoryResult;
  allowedHandoff: HandoffResult;
  deniedHandoff: HandoffResult;
  foreign: ForeignFixture;
  markers: string[];
}

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.promises.rm(directory, { recursive: true, force: true })
  )));
});

async function serverApplication(label: string): Promise<DesignerApplication> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `formaspec-handoff-http-${label}-`));
  temporaryDirectories.push(root);
  const application = await buildApplication(loadConfig({
    APP_MODE: "server",
    HOST: "0.0.0.0",
    PORT: "4310",
    DATA_DIR: path.join(root, "data"),
    BACKUP_DIR: path.join(root, "backups"),
    DESIGNER_DATABASE_PATH: ":memory:",
    PUBLIC_BASE_URL: "https://design.example.test",
    AUTH_MODE: "trusted-header",
    DESIGNER_TOKEN: "handoff-http-bootstrap-token-0001",
    FORMASPEC_TRUSTED_PROXIES: "127.0.0.1",
    FORMASPEC_PROXY_SECRET: PROXY_SECRET,
    DESIGNER_CORS_ORIGINS: "https://design.example.test",
    DESIGNER_LOG_LEVEL: "silent",
  }));
  applications.push(application);
  await application.app.ready();
  return application;
}

function trustedHeaders(identity = ADMIN): Record<string, string> {
  return {
    host: "design.example.test",
    origin: "https://design.example.test",
    "x-formaspec-csrf": "1",
    "x-designer-user": identity,
    "x-formaspec-proxy-secret": PROXY_SECRET,
  };
}

async function warm(application: DesignerApplication, identity: string): Promise<void> {
  const response = await application.app.inject({
    method: "GET",
    url: "/api/designs",
    remoteAddress: "127.0.0.1",
    headers: trustedHeaders(identity),
  });
  expect(response.statusCode, response.body).toBe(200);
}

function design(
  application: DesignerApplication,
  actorId: string,
  label: string,
  name: string,
): DesignFixture {
  const created = application.service.createDesign(actorId, {
    name,
    preset: "web",
    idempotencyKey: `handoff-http-design-${label}-0001`,
  });
  return {
    id: created.document.id,
    revisionId: created.revision.id,
    version: created.design.version,
  };
}

function inventory(seed: string, marker: string): UploadRepositoryInventory {
  return {
    schemaVersion: 1,
    repositoryFingerprint: seed.repeat(64),
    generatedAt: "2026-07-21T10:00:00.000Z",
    platforms: ["web"],
    gitHead: seed.repeat(40),
    excludedPatterns: [".env", ".env.*", "*.pem", "*.key", "**/secrets/**", "**/.git/**"],
    scannedFileCount: 4,
    skippedFileCount: 2,
    bytesRead: 1_024,
    truncated: false,
    entities: [{
      id: `inv_${seed.repeat(40)}`,
      kind: "component",
      name: marker,
      symbol: "CheckoutScreen",
      locationId: `loc_${seed.repeat(40)}`,
      line: 42,
    }],
    excluded: [{ category: "secret", count: 2 }],
  };
}

function specification(entityId: string, marker: string): HandoffSpecification {
  return {
    schemaVersion: 1,
    title: "Implement the approved checkout",
    summary: marker,
    acceptanceCriteria: [{
      id: "checkout_matches",
      statement: "The implementation matches the exact approved FormaSpec revision.",
      designEntityIds: [],
    }],
    implementationSlices: [{
      id: "checkout_slice",
      title: "Checkout screen",
      objective: "Implement one bounded checkout screen without unrelated source changes.",
      inventoryEntityIds: [entityId],
      designEntityIds: [],
      dependsOn: [],
      validationChecks: ["typecheck"],
    }],
    risks: [],
    openQuestions: [],
    implementationPolicy: {
      preferredIsolation: "worktree",
      commitRequiresExplicitApproval: true,
      pullRequestRequiresExplicitRequest: true,
    },
  };
}

function createHandoff(
  application: DesignerApplication,
  actorId: string,
  project: DesignFixture,
  persistedInventory: RepositoryInventoryResult,
  marker: string,
): HandoffResult {
  return application.handoffs.createHandoff(actorId, {
    designId: project.id,
    revisionId: project.revisionId,
    expectedDesignVersion: project.version,
    inventoryId: persistedInventory.id,
    specification: specification(persistedInventory.inventory.entities[0]!.id, marker),
  });
}

function installForeignFixture(application: DesignerApplication, label: string): ForeignFixture {
  const organizationId = `organization_handoff_foreign_${label}`;
  const principalId = `principal_handoff_foreign_${label}`;
  const connectionId = `connection_handoff_foreign_${label}`;
  const grantId = `handoff_foreign_${label}`;
  const token = `fsg_handoff_foreign_${label}_SECRET_TOKEN_76a3b1`;
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 3_600_000).toISOString();
  const scopes = ["design:write", "workspace:inventory:write", "handoff:read"];
  const scopesJson = JSON.stringify(scopes);

  application.database.sqlite.prepare(
    "INSERT INTO organizations (id, name, config_json, created_at, updated_at) VALUES (?, ?, '{}', ?, ?)",
  ).run(organizationId, `Foreign handoff organization ${label}`, createdAt, createdAt);
  application.database.sqlite.prepare(
    `INSERT INTO principals (id, organization_id, kind, display_name, external_id, created_at)
     VALUES (?, ?, 'agent', ?, ?, ?)`,
  ).run(principalId, organizationId, `Foreign handoff actor ${label}`, `foreign:handoff:${label}`, createdAt);
  application.database.sqlite.prepare(
    "INSERT INTO memberships (organization_id, principal_id, role, created_at) VALUES (?, ?, 'agent', ?)",
  ).run(organizationId, principalId, createdAt);
  application.database.sqlite.prepare(
    `INSERT INTO agent_connections
     (id, organization_id, principal_id, adapter, display_name, status, scopes_json, project_ids_json,
      expires_at, created_at, updated_at)
     VALUES (?, ?, ?, 'generic_mcp', ?, 'active', ?, '[]', ?, ?, ?)`,
  ).run(connectionId, organizationId, principalId, `Foreign handoff connection ${label}`, scopesJson, expiresAt, createdAt, createdAt);
  application.database.sqlite.prepare(
    `INSERT INTO agent_grants
     (id, organization_id, principal_id, token_hash, scopes_json, project_ids_json, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, '[]', ?, ?)`,
  ).run(
    grantId,
    organizationId,
    principalId,
    createHash("sha256").update(token).digest("hex"),
    scopesJson,
    createdAt,
    expiresAt,
  );

  const actorId = `grant_${grantId}`;
  const foreignDesign = design(
    application,
    actorId,
    `${label}-foreign`,
    "FOREIGN_HANDOFF_PROJECT_MARKER_7a19c4",
  );
  const foreignInventory = application.handoffs.persistRepositoryInventory(
    actorId,
    inventory("f", "FOREIGN_SOURCE_PATH_MARKER_/srv/private/.env.production"),
  );
  application.database.sqlite.prepare(
    "UPDATE memberships SET role = 'engineer' WHERE organization_id = ? AND principal_id = ?",
  ).run(organizationId, principalId);
  const foreignHandoff = createHandoff(
    application,
    actorId,
    foreignDesign,
    foreignInventory,
    "FOREIGN_HANDOFF_SPEC_MARKER_68de31 /srv/private/company/Checkout.tsx",
  );
  application.database.sqlite.prepare(
    "UPDATE memberships SET role = 'agent' WHERE organization_id = ? AND principal_id = ?",
  ).run(organizationId, principalId);
  return {
    actorId,
    token,
    design: foreignDesign,
    inventory: foreignInventory,
    handoff: foreignHandoff,
  };
}

async function setup(label: string): Promise<HandoffHttpFixture> {
  const application = await serverApplication(label);
  await warm(application, ADMIN);
  const current = application.policies.read(`trusted:${ADMIN}`);
  const policy = structuredClone(current.policy);
  policy.identity.roleMappings = [
    { claim: "identity", value: ADMIN, role: "organization_admin" },
    { claim: "identity", value: PRODUCT_MANAGER, role: "product_manager" },
    { claim: "identity", value: ENGINEER, role: "engineer" },
    { claim: "identity", value: EDITOR_A, role: "design_editor" },
    { claim: "identity", value: EDITOR_B, role: "design_editor" },
    { claim: "identity", value: VIEWER, role: "viewer" },
  ];
  application.policies.update(`trusted:${ADMIN}`, {
    expectedConfigurationHash: current.configurationHash,
    policy,
  });
  await Promise.all([
    warm(application, PRODUCT_MANAGER),
    warm(application, ENGINEER),
    warm(application, EDITOR_A),
    warm(application, EDITOR_B),
    warm(application, VIEWER),
  ]);

  const allowed = design(application, "local", `${label}-allowed`, "Allowed handoff project");
  const denied = design(application, "local", `${label}-denied`, "DENIED_HANDOFF_PROJECT_MARKER_51bc93");
  const allowedInventory = application.handoffs.persistRepositoryInventory(
    "local",
    inventory("a", "ALLOWED_SOURCE_SYMBOL_MARKER_2e0c81"),
  );
  const deniedInventory = application.handoffs.persistRepositoryInventory(
    "local",
    inventory("b", "DENIED_SOURCE_PATH_MARKER_/Users/private/.env"),
  );
  const allowedHandoff = createHandoff(
    application,
    "local",
    allowed,
    allowedInventory,
    "ALLOWED_HANDOFF_SPEC_MARKER_f62d08",
  );
  const deniedHandoff = createHandoff(
    application,
    "local",
    denied,
    deniedInventory,
    "DENIED_HANDOFF_SPEC_MARKER_b1f730 /Users/private/company/Checkout.tsx",
  );
  const foreign = installForeignFixture(application, label);
  return {
    application,
    allowed,
    denied,
    allowedInventory,
    deniedInventory,
    allowedHandoff,
    deniedHandoff,
    foreign,
    markers: [
      "DENIED_HANDOFF_PROJECT_MARKER_51bc93",
      "DENIED_SOURCE_PATH_MARKER_/Users/private/.env",
      "DENIED_HANDOFF_SPEC_MARKER_b1f730",
      "FOREIGN_HANDOFF_PROJECT_MARKER_7a19c4",
      "FOREIGN_SOURCE_PATH_MARKER_/srv/private/.env.production",
      "FOREIGN_HANDOFF_SPEC_MARKER_68de31",
      foreign.token,
    ],
  };
}

function state(application: DesignerApplication): Record<string, unknown[]> {
  return {
    inventories: application.database.sqlite.prepare(
      "SELECT * FROM repository_inventories ORDER BY id",
    ).all(),
    handoffs: application.database.sqlite.prepare("SELECT * FROM handoffs ORDER BY id").all(),
    versions: application.database.sqlite.prepare(
      "SELECT * FROM handoff_versions ORDER BY handoff_id, version",
    ).all(),
    transitions: application.database.sqlite.prepare(
      "SELECT * FROM handoff_transitions ORDER BY rowid",
    ).all(),
    decisions: application.database.sqlite.prepare(
      "SELECT * FROM handoff_execution_decisions ORDER BY rowid",
    ).all(),
    idempotency: application.database.sqlite.prepare(
      "SELECT * FROM idempotency ORDER BY actor_id, scope, key",
    ).all(),
    auditEvents: application.database.sqlite.prepare("SELECT * FROM audit_events ORDER BY id").all(),
    outbox: application.database.sqlite.prepare(
      `SELECT id, organization_id, actor_id, event_type, payload_json, workspace, created_at
       FROM event_outbox ORDER BY id`,
    ).all(),
  };
}

function captureDomainError(callback: () => unknown): DomainError {
  try {
    callback();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error("Expected a DomainError.");
}

function expectHiddenError(
  response: { statusCode: number; body: string; json<T>(): T },
  statusCode: number,
  code: string,
  hidden: string[],
): void {
  expect(response.statusCode, response.body).toBe(statusCode);
  expect(response.json<{ error: { code: string } }>().error.code, response.body).toBe(code);
  for (const marker of hidden) expect(response.body).not.toContain(marker);
}

function expectHiddenDomainError(
  error: DomainError,
  statusCode: number,
  code: string,
  hidden: string[],
): void {
  expect(error).toMatchObject({ statusCode, code });
  const serialized = JSON.stringify(error.toJSON());
  for (const marker of hidden) expect(serialized).not.toContain(marker);
}

function mcpTool(
  application: DesignerApplication,
  token: string,
  name: string,
  args: Record<string, unknown>,
) {
  return application.app.inject({
    method: "POST",
    url: "/mcp",
    remoteAddress: "127.0.0.1",
    headers: {
      host: "design.example.test",
      authorization: `Bearer ${token}`,
      "x-formaspec-proxy-secret": PROXY_SECRET,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    },
  });
}

function createBody(fixture: HandoffHttpFixture, marker: string): Record<string, unknown> {
  return {
    revisionId: fixture.allowed.revisionId,
    expectedDesignVersion: fixture.allowed.version,
    inventoryId: fixture.allowedInventory.id,
    specification: specification(fixture.allowedInventory.inventory.entities[0]!.id, marker),
  };
}

function recordCompletionDecisions(
  application: DesignerApplication,
  handoffId: string,
  handoffVersion: number,
  diffHash: string,
): void {
  application.handoffs.recordHandoffExecutionDecision("local", handoffId, {
    expectedVersion: handoffVersion,
    expectedPriorDecisionId: null,
    idempotencyKey: `handoff-http-validation-${handoffId}`,
    kind: "validation_approval",
    outcome: "approved",
    evidence: {
      summary: "The approved validation plan passed.",
      checks: [{ name: "typecheck", status: "passed" }],
    },
  });
  application.handoffs.recordHandoffExecutionDecision("local", handoffId, {
    expectedVersion: handoffVersion,
    expectedPriorDecisionId: null,
    idempotencyKey: `handoff-http-commit-${handoffId}`,
    kind: "commit_approval",
    outcome: "approved",
    evidence: {
      summary: "Approve committing the exact reviewed diff.",
      diffHash,
      commitMessage: "Implement the approved handoff",
    },
  });
  application.handoffs.recordHandoffExecutionDecision("local", handoffId, {
    expectedVersion: handoffVersion,
    expectedPriorDecisionId: null,
    idempotencyKey: `handoff-http-push-${handoffId}`,
    kind: "push_authorization",
    outcome: "denied",
    evidence: { reason: "Keep this verification fixture local." },
  });
  application.handoffs.recordHandoffExecutionDecision("local", handoffId, {
    expectedVersion: handoffVersion,
    expectedPriorDecisionId: null,
    idempotencyKey: `handoff-http-pr-${handoffId}`,
    kind: "pull_request_request",
    outcome: "not_requested",
    evidence: { reason: "No pull request is needed for this verification fixture." },
  });
}

describe("handoff lifecycle HTTP authorization", () => {
  it("exercises all twelve routes with project-shared ownership and role-specific transitions", async () => {
    const fixture = await setup("happy");
    const { application } = fixture;
    const registered = [...PROTECTED_NON_MCP_ROUTE_CONTRACTS.keys()]
      .filter((key) => HANDOFF_ROUTE_KEYS.includes(key as (typeof HANDOFF_ROUTE_KEYS)[number]));
    expect(registered).toEqual(HANDOFF_ROUTE_KEYS);

    const listed = await application.app.inject({
      method: "GET",
      url: `/api/designs/${fixture.allowed.id}/handoffs`,
      remoteAddress: "127.0.0.1",
      headers: trustedHeaders(VIEWER),
    });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json<{ handoffs: HandoffResult[] }>().handoffs.map((handoff) => handoff.id))
      .toContain(fixture.allowedHandoff.id);

    const read = await application.app.inject({
      method: "GET",
      url: `/api/handoffs/${fixture.allowedHandoff.id}`,
      remoteAddress: "127.0.0.1",
      headers: trustedHeaders(VIEWER),
    });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json<{ handoff: HandoffResult }>().handoff).toMatchObject({
      id: fixture.allowedHandoff.id,
      status: "draft",
    });

    const decisionRead = await application.app.inject({
      method: "GET",
      url: `/api/handoffs/${fixture.allowedHandoff.id}/execution-decisions`,
      remoteAddress: "127.0.0.1",
      headers: trustedHeaders(VIEWER),
    });
    expect(decisionRead.statusCode, decisionRead.body).toBe(200);
    expect(decisionRead.json<{ decisions: unknown[] }>().decisions).toEqual([]);

    const created = await application.app.inject({
      method: "POST",
      url: `/api/designs/${fixture.allowed.id}/handoffs`,
      remoteAddress: "127.0.0.1",
      headers: trustedHeaders(EDITOR_A),
      payload: createBody(fixture, "EDITOR_A_CREATED_HANDOFF_MARKER_806f2c"),
    });
    expect(created.statusCode, created.body).toBe(201);
    let handoff = created.json<{ handoff: HandoffResult }>().handoff;
    expect(handoff).toMatchObject({ status: "draft", currentVersion: 1 });

    const updated = await application.app.inject({
      method: "PUT",
      url: `/api/handoffs/${handoff.id}`,
      remoteAddress: "127.0.0.1",
      headers: trustedHeaders(EDITOR_B),
      payload: {
        expectedVersion: 1,
        specification: specification(
          fixture.allowedInventory.inventory.entities[0]!.id,
          "EDITOR_B_UPDATED_SHARED_HANDOFF_MARKER_4f19ac",
        ),
      },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    handoff = updated.json<{ handoff: HandoffResult }>().handoff;
    expect(handoff).toMatchObject({ currentVersion: 2, status: "draft" });

    const submitted = await application.app.inject({
      method: "POST",
      url: `/api/handoffs/${handoff.id}/submit-review`,
      remoteAddress: "127.0.0.1",
      headers: trustedHeaders(EDITOR_B),
      payload: { expectedVersion: 2, summary: "Submit the shared handoff for product review." },
    });
    expect(submitted.statusCode, submitted.body).toBe(200);
    expect(submitted.json<{ handoff: HandoffResult }>().handoff.status).toBe("in_review");

    const returned = await application.app.inject({
      method: "POST",
      url: `/api/handoffs/${handoff.id}/return-draft`,
      remoteAddress: "127.0.0.1",
      headers: trustedHeaders(EDITOR_A),
      payload: { expectedVersion: 2, reason: "One explicit correction is required." },
    });
    expect(returned.statusCode, returned.body).toBe(200);
    expect(returned.json<{ handoff: HandoffResult }>().handoff.status).toBe("draft");

    const resubmitted = await application.app.inject({
      method: "POST",
      url: `/api/handoffs/${handoff.id}/submit-review`,
      remoteAddress: "127.0.0.1",
      headers: trustedHeaders(EDITOR_B),
      payload: { expectedVersion: 2, summary: "Correction verified; resubmit for approval." },
    });
    expect(resubmitted.statusCode, resubmitted.body).toBe(200);

    const approved = await application.app.inject({
      method: "POST",
      url: `/api/handoffs/${handoff.id}/approve`,
      remoteAddress: "127.0.0.1",
      headers: trustedHeaders(PRODUCT_MANAGER),
      payload: {
        expectedVersion: 2,
        expectedPriorDecisionId: null,
        decision: "approved",
        summary: "Approve the exact acceptance criteria and implementation plan.",
        acceptanceCriteriaConfirmed: true,
        implementationPlanConfirmed: true,
      },
    });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json<{ handoff: HandoffResult }>().handoff.status).toBe("approved");

    const isolation = await application.app.inject({
      method: "POST",
      url: `/api/handoffs/${handoff.id}/execution-decisions`,
      remoteAddress: "127.0.0.1",
      headers: trustedHeaders(ENGINEER),
      payload: {
        expectedVersion: 2,
        expectedPriorDecisionId: null,
        idempotencyKey: "handoff-http-isolation-0001",
        kind: "isolation_choice",
        outcome: "worktree",
        evidence: { summary: "Use the approved isolated worktree." },
      },
    });
    expect(isolation.statusCode, isolation.body).toBe(201);

    const started = await application.app.inject({
      method: "POST",
      url: `/api/handoffs/${handoff.id}/start-implementation`,
      remoteAddress: "127.0.0.1",
      headers: trustedHeaders(ENGINEER),
      payload: {
        expectedVersion: 2,
        approvedVersion: 2,
        authorization: "start_implementation",
      },
    });
    expect(started.statusCode, started.body).toBe(200);
    expect(started.json<{ handoff: HandoffResult }>().handoff.status).toBe("implementing");

    const diffHash = "d".repeat(64);
    const diff = await application.app.inject({
      method: "POST",
      url: `/api/handoffs/${handoff.id}/execution-decisions`,
      remoteAddress: "127.0.0.1",
      headers: trustedHeaders(ENGINEER),
      payload: {
        expectedVersion: 2,
        expectedPriorDecisionId: null,
        idempotencyKey: "handoff-http-diff-review-0001",
        kind: "diff_review",
        outcome: "approved",
        evidence: { summary: "Review the exact bounded diff.", diffHash, changedFileCount: 2 },
      },
    });
    expect(diff.statusCode, diff.body).toBe(201);
    recordCompletionDecisions(application, handoff.id, 2, diffHash);

    const completed = await application.app.inject({
      method: "POST",
      url: `/api/handoffs/${handoff.id}/complete`,
      remoteAddress: "127.0.0.1",
      headers: trustedHeaders(ENGINEER),
      payload: { expectedVersion: 2, summary: "Complete from persisted approval evidence." },
    });
    expect(completed.statusCode, completed.body).toBe(200);
    expect(completed.json<{ handoff: HandoffResult }>().handoff.status).toBe("completed");

    const cancelled = await application.app.inject({
      method: "POST",
      url: `/api/handoffs/${fixture.allowedHandoff.id}/cancel`,
      remoteAddress: "127.0.0.1",
      headers: trustedHeaders(PRODUCT_MANAGER),
      payload: { expectedVersion: 1, reason: "Cancel the unused draft fixture." },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json<{ handoff: HandoffResult }>().handoff.status).toBe("cancelled");
  });

  it("rejects viewer and wrong-role writes without changing handoff, audit, outbox, or idempotency state", async () => {
    const fixture = await setup("role-denials");
    const { application } = fixture;
    const hidden = [
      ...fixture.markers,
      fixture.deniedHandoff.id,
      fixture.foreign.handoff.id,
      fixture.foreign.inventory.id,
    ];
    const before = state(application);
    const viewerWrites = [
      await application.app.inject({
        method: "POST",
        url: `/api/designs/${fixture.allowed.id}/handoffs`,
        remoteAddress: "127.0.0.1",
        headers: trustedHeaders(VIEWER),
        payload: createBody(fixture, "Viewer must not create this handoff"),
      }),
      await application.app.inject({
        method: "PUT",
        url: `/api/handoffs/${fixture.allowedHandoff.id}`,
        remoteAddress: "127.0.0.1",
        headers: trustedHeaders(VIEWER),
        payload: {
          expectedVersion: 1,
          specification: specification(
            fixture.allowedInventory.inventory.entities[0]!.id,
            "Viewer must not update this handoff",
          ),
        },
      }),
      await application.app.inject({
        method: "POST",
        url: `/api/handoffs/${fixture.allowedHandoff.id}/submit-review`,
        remoteAddress: "127.0.0.1",
        headers: trustedHeaders(VIEWER),
        payload: { expectedVersion: 1, summary: "Viewer must not submit." },
      }),
      await application.app.inject({
        method: "POST",
        url: `/api/handoffs/${fixture.allowedHandoff.id}/return-draft`,
        remoteAddress: "127.0.0.1",
        headers: trustedHeaders(VIEWER),
        payload: { expectedVersion: 1, reason: "Viewer must not return." },
      }),
      await application.app.inject({
        method: "POST",
        url: `/api/handoffs/${fixture.allowedHandoff.id}/approve`,
        remoteAddress: "127.0.0.1",
        headers: trustedHeaders(VIEWER),
        payload: {
          expectedVersion: 1,
          expectedPriorDecisionId: null,
          decision: "approved",
          summary: "Viewer must not approve.",
          acceptanceCriteriaConfirmed: true,
          implementationPlanConfirmed: true,
        },
      }),
      await application.app.inject({
        method: "POST",
        url: `/api/handoffs/${fixture.allowedHandoff.id}/start-implementation`,
        remoteAddress: "127.0.0.1",
        headers: trustedHeaders(VIEWER),
        payload: {
          expectedVersion: 1,
          approvedVersion: 1,
          authorization: "start_implementation",
        },
      }),
      await application.app.inject({
        method: "POST",
        url: `/api/handoffs/${fixture.allowedHandoff.id}/execution-decisions`,
        remoteAddress: "127.0.0.1",
        headers: trustedHeaders(VIEWER),
        payload: {
          expectedVersion: 1,
          expectedPriorDecisionId: null,
          idempotencyKey: "handoff-http-viewer-decision-0001",
          kind: "diff_review",
          outcome: "approved",
          evidence: {
            summary: "Viewer must not approve the diff.",
            diffHash: "a".repeat(64),
            changedFileCount: 1,
          },
        },
      }),
      await application.app.inject({
        method: "POST",
        url: `/api/handoffs/${fixture.allowedHandoff.id}/complete`,
        remoteAddress: "127.0.0.1",
        headers: trustedHeaders(VIEWER),
        payload: { expectedVersion: 1, summary: "Viewer must not complete." },
      }),
      await application.app.inject({
        method: "POST",
        url: `/api/handoffs/${fixture.allowedHandoff.id}/cancel`,
        remoteAddress: "127.0.0.1",
        headers: trustedHeaders(VIEWER),
        payload: { expectedVersion: 1, reason: "Viewer must not cancel." },
      }),
    ];
    for (const response of viewerWrites) expectHiddenError(response, 403, "FORBIDDEN", hidden);

    const wrongRoleWrites = [
      await application.app.inject({
        method: "POST",
        url: `/api/handoffs/${fixture.allowedHandoff.id}/approve`,
        remoteAddress: "127.0.0.1",
        headers: trustedHeaders(ENGINEER),
        payload: {
          expectedVersion: 1,
          expectedPriorDecisionId: null,
          decision: "approved",
          summary: "Engineer cannot self-approve the product plan.",
          acceptanceCriteriaConfirmed: true,
          implementationPlanConfirmed: true,
        },
      }),
      await application.app.inject({
        method: "POST",
        url: `/api/handoffs/${fixture.allowedHandoff.id}/start-implementation`,
        remoteAddress: "127.0.0.1",
        headers: trustedHeaders(PRODUCT_MANAGER),
        payload: {
          expectedVersion: 1,
          approvedVersion: 1,
          authorization: "start_implementation",
        },
      }),
      await application.app.inject({
        method: "POST",
        url: `/api/handoffs/${fixture.allowedHandoff.id}/complete`,
        remoteAddress: "127.0.0.1",
        headers: trustedHeaders(PRODUCT_MANAGER),
        payload: { expectedVersion: 1, summary: "Product manager cannot self-complete implementation." },
      }),
      await application.app.inject({
        method: "POST",
        url: `/api/handoffs/${fixture.allowedHandoff.id}/cancel`,
        remoteAddress: "127.0.0.1",
        headers: trustedHeaders(EDITOR_A),
        payload: { expectedVersion: 1, reason: "Design editor lacks cancellation authority." },
      }),
    ];
    for (const response of wrongRoleWrites) expectHiddenError(response, 403, "FORBIDDEN", hidden);

    const decisionRoleWrites = [
      await application.app.inject({
        method: "POST",
        url: `/api/handoffs/${fixture.allowedHandoff.id}/execution-decisions`,
        remoteAddress: "127.0.0.1",
        headers: trustedHeaders(PRODUCT_MANAGER),
        payload: {
          expectedVersion: 1,
          expectedPriorDecisionId: null,
          idempotencyKey: "handoff-http-pm-isolation-denied-0001",
          kind: "isolation_choice",
          outcome: "worktree",
          evidence: { summary: "Product manager cannot choose engineering isolation." },
        },
      }),
      await application.app.inject({
        method: "POST",
        url: `/api/handoffs/${fixture.allowedHandoff.id}/execution-decisions`,
        remoteAddress: "127.0.0.1",
        headers: trustedHeaders(PRODUCT_MANAGER),
        payload: {
          expectedVersion: 1,
          expectedPriorDecisionId: null,
          idempotencyKey: "handoff-http-pm-diff-denied-0001",
          kind: "diff_review",
          outcome: "approved",
          evidence: {
            summary: "Product manager cannot perform engineering diff review.",
            diffHash: "1".repeat(64),
            changedFileCount: 1,
          },
        },
      }),
      await application.app.inject({
        method: "POST",
        url: `/api/handoffs/${fixture.allowedHandoff.id}/execution-decisions`,
        remoteAddress: "127.0.0.1",
        headers: trustedHeaders(PRODUCT_MANAGER),
        payload: {
          expectedVersion: 1,
          expectedPriorDecisionId: null,
          idempotencyKey: "handoff-http-pm-validation-denied-0001",
          kind: "validation_approval",
          outcome: "approved",
          evidence: {
            summary: "Product manager cannot approve engineering validation.",
            checks: [{ name: "typecheck", status: "passed" }],
          },
        },
      }),
      await application.app.inject({
        method: "POST",
        url: `/api/handoffs/${fixture.allowedHandoff.id}/execution-decisions`,
        remoteAddress: "127.0.0.1",
        headers: trustedHeaders(ENGINEER),
        payload: {
          expectedVersion: 1,
          expectedPriorDecisionId: null,
          idempotencyKey: "handoff-http-engineer-plan-denied-0001",
          kind: "plan_approval",
          outcome: "approved",
          evidence: {
            summary: "Engineer cannot self-approve the product plan.",
            acceptanceCriteriaConfirmed: true,
            implementationPlanConfirmed: true,
          },
        },
      }),
      await application.app.inject({
        method: "POST",
        url: `/api/handoffs/${fixture.allowedHandoff.id}/execution-decisions`,
        remoteAddress: "127.0.0.1",
        headers: trustedHeaders(ENGINEER),
        payload: {
          expectedVersion: 1,
          expectedPriorDecisionId: null,
          idempotencyKey: "handoff-http-engineer-commit-denied-0001",
          kind: "commit_approval",
          outcome: "approved",
          evidence: {
            summary: "Engineer cannot self-approve commit.",
            diffHash: "2".repeat(64),
            commitMessage: "Unapproved self-commit",
          },
        },
      }),
      await application.app.inject({
        method: "POST",
        url: `/api/handoffs/${fixture.allowedHandoff.id}/execution-decisions`,
        remoteAddress: "127.0.0.1",
        headers: trustedHeaders(ENGINEER),
        payload: {
          expectedVersion: 1,
          expectedPriorDecisionId: null,
          idempotencyKey: "handoff-http-engineer-push-denied-0001",
          kind: "push_authorization",
          outcome: "authorized",
          evidence: {
            summary: "Engineer cannot self-authorize push.",
            commitHash: "3".repeat(40),
            targetRef: "feature/handoff-role-test",
          },
        },
      }),
      await application.app.inject({
        method: "POST",
        url: `/api/handoffs/${fixture.allowedHandoff.id}/execution-decisions`,
        remoteAddress: "127.0.0.1",
        headers: trustedHeaders(ENGINEER),
        payload: {
          expectedVersion: 1,
          expectedPriorDecisionId: null,
          idempotencyKey: "handoff-http-engineer-pr-denied-0001",
          kind: "pull_request_request",
          outcome: "requested",
          evidence: {
            summary: "Engineer cannot independently request the pull request.",
            title: "Unapproved handoff pull request",
            baseRef: "main",
            headRef: "feature/handoff-role-test",
          },
        },
      }),
    ];
    for (const response of decisionRoleWrites) expectHiddenError(response, 403, "FORBIDDEN", hidden);
    expect(state(application)).toEqual(before);
  });

  it("hides foreign and type-swapped parents and handoff IDs on every route without rejected-write mutation", async () => {
    const fixture = await setup("opaque-ids");
    const { application } = fixture;
    const hidden = [
      ...fixture.markers,
      fixture.denied.id,
      fixture.denied.revisionId,
      fixture.deniedInventory.id,
      fixture.deniedHandoff.id,
      fixture.foreign.design.id,
      fixture.foreign.design.revisionId,
      fixture.foreign.inventory.id,
      fixture.foreign.handoff.id,
    ];
    const before = state(application);

    for (const parentId of [
      fixture.foreign.design.id,
      fixture.allowedHandoff.id,
      fixture.allowedInventory.id,
    ]) {
      const list = await application.app.inject({
        method: "GET",
        url: `/api/designs/${parentId}/handoffs`,
        remoteAddress: "127.0.0.1",
        headers: trustedHeaders(),
      });
      expectHiddenError(list, 404, "NOT_FOUND", hidden);

      const create = await application.app.inject({
        method: "POST",
        url: `/api/designs/${parentId}/handoffs`,
        remoteAddress: "127.0.0.1",
        headers: trustedHeaders(),
        payload: createBody(fixture, "A swapped parent must not create a handoff."),
      });
      expectHiddenError(create, 404, "NOT_FOUND", hidden);
    }

    const foreignInventory = await application.app.inject({
      method: "POST",
      url: `/api/designs/${fixture.allowed.id}/handoffs`,
      remoteAddress: "127.0.0.1",
      headers: trustedHeaders(),
      payload: {
        ...createBody(fixture, "A foreign inventory must not bind to the allowed project."),
        inventoryId: fixture.foreign.inventory.id,
      },
    });
    expectHiddenError(foreignInventory, 404, "NOT_FOUND", hidden);

    const swappedRevision = await application.app.inject({
      method: "POST",
      url: `/api/designs/${fixture.allowed.id}/handoffs`,
      remoteAddress: "127.0.0.1",
      headers: trustedHeaders(),
      payload: {
        ...createBody(fixture, "A revision from another project must not bind to this handoff."),
        revisionId: fixture.denied.revisionId,
      },
    });
    expect(swappedRevision.statusCode, swappedRevision.body).toBe(409);
    expect(swappedRevision.json<{ error: { code: string } }>().error.code).toBe("VERSION_CONFLICT");
    for (const marker of fixture.markers) expect(swappedRevision.body).not.toContain(marker);

    const handoffRoutes = [
      { method: "GET", suffix: "" },
      {
        method: "PUT",
        suffix: "",
        payload: {
          expectedVersion: 1,
          specification: specification(
            fixture.allowedInventory.inventory.entities[0]!.id,
            "A foreign or swapped handoff must not be updated.",
          ),
        },
      },
      {
        method: "POST",
        suffix: "/submit-review",
        payload: { expectedVersion: 1, summary: "Must not submit." },
      },
      {
        method: "POST",
        suffix: "/return-draft",
        payload: { expectedVersion: 1, reason: "Must not return." },
      },
      {
        method: "POST",
        suffix: "/approve",
        payload: {
          expectedVersion: 1,
          expectedPriorDecisionId: null,
          decision: "approved",
          summary: "Must not approve.",
          acceptanceCriteriaConfirmed: true,
          implementationPlanConfirmed: true,
        },
      },
      {
        method: "POST",
        suffix: "/start-implementation",
        payload: {
          expectedVersion: 1,
          approvedVersion: 1,
          authorization: "start_implementation",
        },
      },
      { method: "GET", suffix: "/execution-decisions" },
      {
        method: "POST",
        suffix: "/execution-decisions",
        payload: {
          expectedVersion: 1,
          expectedPriorDecisionId: null,
          idempotencyKey: "handoff-http-opaque-decision-0001",
          kind: "diff_review",
          outcome: "approved",
          evidence: {
            summary: "Must not append a decision.",
            diffHash: "e".repeat(64),
            changedFileCount: 1,
          },
        },
      },
      {
        method: "POST",
        suffix: "/complete",
        payload: { expectedVersion: 1, summary: "Must not complete." },
      },
      {
        method: "POST",
        suffix: "/cancel",
        payload: { expectedVersion: 1, reason: "Must not cancel." },
      },
    ] as const;
    for (const candidateId of [
      fixture.foreign.handoff.id,
      fixture.allowedInventory.id,
      fixture.allowed.revisionId,
    ]) {
      for (const route of handoffRoutes) {
        const response = await application.app.inject({
          method: route.method,
          url: `/api/handoffs/${candidateId}${route.suffix}`,
          remoteAddress: "127.0.0.1",
          headers: trustedHeaders(),
          ...("payload" in route ? { payload: route.payload } : {}),
        });
        expectHiddenError(response, 404, "NOT_FOUND", hidden);
      }
    }
    expect(state(application)).toEqual(before);
  });

  it("binds prior-decision child IDs to the exact handoff and decision kind without partial writes", async () => {
    const fixture = await setup("decision-parent");
    const { application } = fixture;
    const target = createHandoff(
      application,
      "local",
      fixture.allowed,
      fixture.allowedInventory,
      "TARGET_HANDOFF_DECISION_PARENT_MARKER_9a70e2",
    );
    const donor = createHandoff(
      application,
      "local",
      fixture.allowed,
      fixture.allowedInventory,
      "DONOR_HANDOFF_DECISION_PARENT_MARKER_10f8c4",
    );
    application.handoffs.submitHandoffForReview("local", target.id, {
      expectedVersion: 1,
      summary: "Target is ready for review.",
    });
    application.handoffs.submitHandoffForReview("local", donor.id, {
      expectedVersion: 1,
      summary: "Donor is ready for review.",
    });
    const donorDecision = application.handoffs.recordHandoffExecutionDecision("local", donor.id, {
      expectedVersion: 1,
      expectedPriorDecisionId: null,
      idempotencyKey: "handoff-http-donor-plan-0001",
      kind: "plan_approval",
      outcome: "denied",
      evidence: { reason: "The donor plan remains denied." },
    });
    const hidden = [
      ...fixture.markers,
      "TARGET_HANDOFF_DECISION_PARENT_MARKER_9a70e2",
      "DONOR_HANDOFF_DECISION_PARENT_MARKER_10f8c4",
    ];
    const before = state(application);

    const approve = await application.app.inject({
      method: "POST",
      url: `/api/handoffs/${target.id}/approve`,
      remoteAddress: "127.0.0.1",
      headers: trustedHeaders(PRODUCT_MANAGER),
      payload: {
        expectedVersion: 1,
        expectedPriorDecisionId: donorDecision.id,
        decision: "approved",
        summary: "A donor decision must not authorize the target.",
        acceptanceCriteriaConfirmed: true,
        implementationPlanConfirmed: true,
      },
    });
    expectHiddenError(approve, 409, "VERSION_CONFLICT", hidden);

    const sameKind = await application.app.inject({
      method: "POST",
      url: `/api/handoffs/${target.id}/execution-decisions`,
      remoteAddress: "127.0.0.1",
      headers: trustedHeaders(PRODUCT_MANAGER),
      payload: {
        expectedVersion: 1,
        expectedPriorDecisionId: donorDecision.id,
        idempotencyKey: "handoff-http-cross-handoff-plan-0001",
        kind: "plan_approval",
        outcome: "approved",
        evidence: {
          summary: "A donor plan decision must not replace the target plan.",
          acceptanceCriteriaConfirmed: true,
          implementationPlanConfirmed: true,
        },
      },
    });
    expectHiddenError(sameKind, 409, "VERSION_CONFLICT", hidden);

    const differentKind = await application.app.inject({
      method: "POST",
      url: `/api/handoffs/${target.id}/execution-decisions`,
      remoteAddress: "127.0.0.1",
      headers: trustedHeaders(ENGINEER),
      payload: {
        expectedVersion: 1,
        expectedPriorDecisionId: donorDecision.id,
        idempotencyKey: "handoff-http-cross-kind-isolation-0001",
        kind: "isolation_choice",
        outcome: "worktree",
        evidence: { summary: "A plan decision must not bind as an isolation predecessor." },
      },
    });
    expectHiddenError(differentKind, 409, "VERSION_CONFLICT", hidden);
    expect(state(application)).toEqual(before);
  });

  it("requires return-to-draft before editing an in-review handoff so a denial cannot be bypassed", async () => {
    const fixture = await setup("review-edit");
    const { application } = fixture;
    application.handoffs.submitHandoffForReview("local", fixture.allowedHandoff.id, {
      expectedVersion: 1,
      summary: "Submit version one for product review.",
    });
    const denial = application.handoffs.recordHandoffExecutionDecision("local", fixture.allowedHandoff.id, {
      expectedVersion: 1,
      expectedPriorDecisionId: null,
      idempotencyKey: "handoff-http-review-denial-0001",
      kind: "plan_approval",
      outcome: "denied",
      evidence: { reason: "Version one requires a corrected implementation slice." },
    });
    const before = state(application);
    const update = await application.app.inject({
      method: "PUT",
      url: `/api/handoffs/${fixture.allowedHandoff.id}`,
      remoteAddress: "127.0.0.1",
      headers: trustedHeaders(EDITOR_B),
      payload: {
        expectedVersion: 1,
        specification: specification(
          fixture.allowedInventory.inventory.entities[0]!.id,
          "A review denial must survive until an explicit return-to-draft transition.",
        ),
      },
    });
    expectHiddenError(update, 409, "VERSION_CONFLICT", fixture.markers);
    expect(state(application)).toEqual(before);
    expect(application.handoffs.readHandoff("local", fixture.allowedHandoff.id)).toMatchObject({
      currentVersion: 1,
      status: "in_review",
      executionDecisionState: {
        plan_approval: { id: denial.id, outcome: "denied" },
      },
    });
  });

  it("applies project restriction before list limits so hidden activity cannot displace authorized handoffs", async () => {
    const fixture = await setup("list-limit");
    const { application } = fixture;
    application.database.sqlite.prepare(
      "UPDATE handoffs SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
    ).run(fixture.allowedHandoff.id);
    application.database.sqlite.prepare(
      "UPDATE handoffs SET updated_at = '2099-01-01T00:00:00.000Z' WHERE id = ?",
    ).run(fixture.deniedHandoff.id);
    const challenge = application.enterprise.createAgentConnection("local", {
      adapter: "codex",
      displayName: "Handoff list-limit agent",
      scopes: ["handoff:read"],
      projectIds: [fixture.allowed.id],
      expiresInSeconds: 3_600,
    });
    const paired = application.enterprise.pairAgentConnection(challenge.nonce);
    expect(application.handoffs.listHandoffs(paired.grant.actorId, { limit: 1 }).map((handoff) => handoff.id))
      .toEqual([fixture.allowedHandoff.id]);
  });

  it("enforces project-scoped agent reads and decisions plus immediate revocation at service and MCP boundaries", async () => {
    const fixture = await setup("scoped-agent");
    const { application } = fixture;
    let implementing = createHandoff(
      application,
      "local",
      fixture.allowed,
      fixture.allowedInventory,
      "SCOPED_AGENT_ALLOWED_HANDOFF_MARKER_a6c132",
    );
    implementing = application.handoffs.submitHandoffForReview("local", implementing.id, {
      expectedVersion: 1,
      summary: "Ready for exact agent-bound execution evidence.",
    });
    implementing = application.handoffs.approveHandoff("local", implementing.id, {
      expectedVersion: 1,
      expectedPriorDecisionId: null,
      decision: "approved",
      summary: "Approve the exact handoff plan.",
      acceptanceCriteriaConfirmed: true,
      implementationPlanConfirmed: true,
    });
    application.handoffs.recordHandoffExecutionDecision("local", implementing.id, {
      expectedVersion: 1,
      expectedPriorDecisionId: null,
      idempotencyKey: "handoff-http-agent-isolation-0001",
      kind: "isolation_choice",
      outcome: "worktree",
      evidence: { summary: "Use an isolated worktree." },
    });
    implementing = application.handoffs.startHandoffImplementation("local", implementing.id, {
      expectedVersion: 1,
      approvedVersion: 1,
      authorization: "start_implementation",
    });

    const challenge = application.enterprise.createAgentConnection("local", {
      adapter: "codex",
      displayName: "Project-restricted handoff agent",
      scopes: ["handoff:read", "handoff:execution:diff_review"],
      projectIds: [fixture.allowed.id],
      expiresInSeconds: 3_600,
    });
    const paired = application.enterprise.pairAgentConnection(challenge.nonce);
    const actorId = paired.grant.actorId;

    const bearerRest = await application.app.inject({
      method: "GET",
      url: `/api/handoffs/${implementing.id}`,
      remoteAddress: "127.0.0.1",
      headers: {
        host: "design.example.test",
        authorization: `Bearer ${paired.grant.token}`,
        "x-formaspec-proxy-secret": PROXY_SECRET,
      },
    });
    expectHiddenError(bearerRest, 401, "AUTH_REQUIRED", [...fixture.markers, paired.grant.token]);

    expect(application.handoffs.listHandoffs(actorId).map((handoff) => handoff.designId))
      .toEqual(expect.arrayContaining([fixture.allowed.id]));
    expect(application.handoffs.listHandoffs(actorId).every((handoff) => handoff.designId === fixture.allowed.id))
      .toBe(true);
    expect(application.handoffs.listHandoffs(actorId, { designId: fixture.allowed.id }).map((handoff) => handoff.id))
      .toContain(implementing.id);
    expect(application.handoffs.readHandoff(actorId, implementing.id).id).toBe(implementing.id);
    expect(application.handoffs.readHandoffExecutionDecisions(actorId, implementing.id).decisions).toHaveLength(2);
    const diff = application.handoffs.recordHandoffExecutionDecision(actorId, implementing.id, {
      expectedVersion: 1,
      expectedPriorDecisionId: null,
      idempotencyKey: "handoff-http-agent-diff-0001",
      kind: "diff_review",
      outcome: "approved",
      evidence: {
        summary: "The scoped agent reviewed the exact bounded diff.",
        diffHash: "7".repeat(64),
        changedFileCount: 2,
      },
    });
    expect(diff).toMatchObject({ handoffId: implementing.id, kind: "diff_review", outcome: "approved" });

    const allowedMcp = await mcpTool(application, paired.grant.token, "handoff_read", {
      handoff_id: implementing.id,
    });
    expect(allowedMcp.statusCode, allowedMcp.body).toBe(200);
    expect(allowedMcp.json<{
      result: { structuredContent: { ok: boolean; handoff: { id: string; designId: string } } };
    }>().result.structuredContent).toMatchObject({
      ok: true,
      handoff: { id: implementing.id, designId: fixture.allowed.id },
    });

    const hidden = [
      ...fixture.markers,
      fixture.denied.id,
      fixture.deniedHandoff.id,
      fixture.foreign.design.id,
      fixture.foreign.handoff.id,
      paired.grant.token,
    ];
    const deniedCallbacks = [
      () => application.handoffs.listHandoffs(actorId, { designId: fixture.denied.id }),
      () => application.handoffs.readHandoff(actorId, fixture.deniedHandoff.id),
      () => application.handoffs.readHandoffExecutionDecisions(actorId, fixture.deniedHandoff.id),
      () => application.handoffs.recordHandoffExecutionDecision(actorId, fixture.deniedHandoff.id, {
        expectedVersion: 1,
        expectedPriorDecisionId: null,
        idempotencyKey: "handoff-http-agent-denied-diff-0001",
        kind: "diff_review",
        outcome: "approved",
        evidence: {
          summary: "Must not write in a denied project.",
          diffHash: "8".repeat(64),
          changedFileCount: 1,
        },
      }),
      () => application.handoffs.listHandoffs(actorId, { designId: fixture.foreign.design.id }),
      () => application.handoffs.readHandoff(actorId, fixture.foreign.handoff.id),
      () => application.handoffs.readHandoffExecutionDecisions(actorId, fixture.foreign.handoff.id),
      () => application.handoffs.recordHandoffExecutionDecision(actorId, fixture.foreign.handoff.id, {
        expectedVersion: 1,
        expectedPriorDecisionId: null,
        idempotencyKey: "handoff-http-agent-foreign-diff-0001",
        kind: "diff_review",
        outcome: "approved",
        evidence: {
          summary: "Must not write in a foreign organization.",
          diffHash: "9".repeat(64),
          changedFileCount: 1,
        },
      }),
    ];
    const beforeDenied = state(application);
    for (const callback of deniedCallbacks) {
      expectHiddenDomainError(captureDomainError(callback), 404, "NOT_FOUND", hidden);
    }
    expect(state(application)).toEqual(beforeDenied);

    const humanOnlyCallbacks = [
      () => application.handoffs.createHandoff(actorId, {
        designId: fixture.allowed.id,
        revisionId: fixture.allowed.revisionId,
        expectedDesignVersion: 1,
        inventoryId: fixture.allowedInventory.id,
        specification: specification(
          fixture.allowedInventory.inventory.entities[0]!.id,
          "An agent must not create a human-owned handoff.",
        ),
      }),
      () => application.handoffs.updateHandoff(actorId, implementing.id, {
        expectedVersion: 1,
        specification: specification(
          fixture.allowedInventory.inventory.entities[0]!.id,
          "An agent must not revise the human-owned handoff.",
        ),
      }),
      () => application.handoffs.submitHandoffForReview(actorId, implementing.id, {
        expectedVersion: 1,
        summary: "An agent must not submit the human-owned handoff.",
      }),
    ];
    for (const callback of humanOnlyCallbacks) {
      expectHiddenDomainError(captureDomainError(callback), 403, "FORBIDDEN", hidden);
    }
    expect(state(application)).toEqual(beforeDenied);

    const deniedMcp = await mcpTool(application, paired.grant.token, "handoff_execution_decision_record", {
      handoff_id: fixture.deniedHandoff.id,
      decision: {
        expectedVersion: 1,
        expectedPriorDecisionId: null,
        idempotencyKey: "handoff-http-agent-mcp-denied-0001",
        kind: "diff_review",
        outcome: "approved",
        evidence: {
          summary: "MCP must not write in a denied project.",
          diffHash: "a".repeat(64),
          changedFileCount: 1,
        },
      },
    });
    expect(deniedMcp.statusCode, deniedMcp.body).toBe(200);
    expect(deniedMcp.json<{
      result: { structuredContent: { ok: boolean; error: { code: string; message: string } } };
    }>().result.structuredContent).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND", message: "Design not found." },
    });
    for (const marker of hidden) expect(deniedMcp.body).not.toContain(marker);
    expect(state(application)).toEqual(beforeDenied);

    application.enterprise.revokeAgentConnection("local", challenge.connection.id);
    const beforeRevoked = state(application);
    const revokedCallbacks = [
      () => application.handoffs.listHandoffs(actorId, { designId: fixture.allowed.id }),
      () => application.handoffs.readHandoff(actorId, implementing.id),
      () => application.handoffs.readHandoffExecutionDecisions(actorId, implementing.id),
      () => application.handoffs.recordHandoffExecutionDecision(actorId, implementing.id, {
        expectedVersion: 1,
        expectedPriorDecisionId: diff.id,
        idempotencyKey: "handoff-http-agent-revoked-diff-0001",
        kind: "diff_review",
        outcome: "revoked",
        evidence: { reason: "Must not revoke a decision after connection revocation." },
      }),
    ];
    for (const callback of revokedCallbacks) {
      expectHiddenDomainError(captureDomainError(callback), 401, "AUTH_REQUIRED", hidden);
    }
    expect(state(application)).toEqual(beforeRevoked);

    const revokedMcp = await mcpTool(application, paired.grant.token, "handoff_read", {
      handoff_id: implementing.id,
    });
    expectHiddenError(revokedMcp, 401, "AUTH_REQUIRED", hidden);
  });

  it("keeps successful decision idempotency cleanup inside the authorized principal boundary", async () => {
    const fixture = await setup("idempotency-scope");
    const { application } = fixture;
    let handoff = createHandoff(
      application,
      "local",
      fixture.allowed,
      fixture.allowedInventory,
      "IDEMPOTENCY_SCOPE_HANDOFF_MARKER_82e5a0",
    );
    handoff = application.handoffs.submitHandoffForReview("local", handoff.id, {
      expectedVersion: 1,
      summary: "Ready for scoped cleanup verification.",
    });
    handoff = application.handoffs.approveHandoff("local", handoff.id, {
      expectedVersion: 1,
      expectedPriorDecisionId: null,
      decision: "approved",
      summary: "Approve the scoped cleanup verification plan.",
      acceptanceCriteriaConfirmed: true,
      implementationPlanConfirmed: true,
    });
    application.handoffs.recordHandoffExecutionDecision("local", handoff.id, {
      expectedVersion: 1,
      expectedPriorDecisionId: null,
      idempotencyKey: "handoff-http-idempotency-isolation-0001",
      kind: "isolation_choice",
      outcome: "worktree",
      evidence: { summary: "Use an isolated worktree." },
    });
    handoff = application.handoffs.startHandoffImplementation("local", handoff.id, {
      expectedVersion: 1,
      approvedVersion: 1,
      authorization: "start_implementation",
    });

    const engineerAccess = resolveAccess(application.database.sqlite, `trusted:${ENGINEER}`);
    const foreignAccess = resolveAccess(application.database.sqlite, fixture.foreign.actorId);
    const insertExpired = application.database.sqlite.prepare(
      `INSERT INTO idempotency
       (actor_id, scope, key, request_hash, response_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, '{}', '1999-12-31T23:59:00.000Z', '2000-01-01T00:00:00.000Z')`,
    );
    insertExpired.run(
      engineerAccess.principalId,
      "handoff:test:authorized",
      "handoff-expired-own-key",
      "1".repeat(64),
    );
    insertExpired.run(
      foreignAccess.principalId,
      "handoff:test:foreign",
      "handoff-expired-foreign-key",
      "2".repeat(64),
    );

    const decision = await application.app.inject({
      method: "POST",
      url: `/api/handoffs/${handoff.id}/execution-decisions`,
      remoteAddress: "127.0.0.1",
      headers: trustedHeaders(ENGINEER),
      payload: {
        expectedVersion: 1,
        expectedPriorDecisionId: null,
        idempotencyKey: "handoff-http-idempotency-diff-0001",
        kind: "diff_review",
        outcome: "approved",
        evidence: {
          summary: "Review the exact diff while cleaning only this principal's stale keys.",
          diffHash: "b".repeat(64),
          changedFileCount: 1,
        },
      },
    });
    expect(decision.statusCode, decision.body).toBe(201);
    expect(application.database.sqlite.prepare(
      "SELECT key FROM idempotency WHERE key = 'handoff-expired-own-key'",
    ).get()).toBeUndefined();
    expect(application.database.sqlite.prepare(
      "SELECT actor_id, key FROM idempotency WHERE key = 'handoff-expired-foreign-key'",
    ).get()).toEqual({
      actor_id: foreignAccess.principalId,
      key: "handoff-expired-foreign-key",
    });
  });
});
