import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveAccess } from "./authorization.js";
import { buildApplication, type DesignerApplication } from "./app.js";
import { loadConfig } from "./config.js";
import type { DesignSystemReleaseResult, DesignSystemUpgradePreviewResult } from "./design-system-service.js";
import { DomainError } from "./errors.js";

const PROXY_SECRET = "enterprise-final-proxy-secret-0123456789abcdef";
const PUBLIC_ORIGIN = "https://design.example.test";
const ADMIN_IDENTITY = "enterprise-final-admin@example.test";
const PRODUCT_MANAGER_IDENTITY = "enterprise-final-product@example.test";
const EDITOR_IDENTITY = "enterprise-final-editor@example.test";
const ENGINEER_IDENTITY = "enterprise-final-engineer@example.test";
const VIEWER_IDENTITY = "enterprise-final-viewer@example.test";
const ADMIN_ACTOR = `trusted:${ADMIN_IDENTITY}`;
const FOREIGN_ORGANIZATION_ID = "organization_enterprise_final_foreign";
const PRIVATE_MARKER = "ENTERPRISE_FINAL_PRIVATE_6b4e92";
const PRIVATE_PATH = "/Users/private/company/enterprise-final/.env.production";
const PRIVATE_TOKEN = "fsg_enterprise_final_private_token_491ca7";
const PRIVATE_MAPPING_ID = `mapping_${"f".repeat(32)}`;

const applications: DesignerApplication[] = [];
const temporaryDirectories: string[] = [];

interface Fixture {
  application: DesignerApplication;
  upgradeDesignId: string;
  targetRelease: DesignSystemReleaseResult;
  foreignRelease: DesignSystemReleaseResult;
  stalePreviewId: string;
  mappingAllowedDesignId: string;
  mappingDeniedDesignId: string;
  conflictEvidenceDesignId: string;
  conflictEvidenceBaseVersion: number;
  conflictCleanDesignId: string;
  foreignDesignId: string;
  bearerToken: string;
  mappingGrantActorId: string;
  missingMappingScopeActorId: string;
  restrictedConflictActorId: string;
  missingConflictWriteActorId: string;
  unrestrictedConflictActorId: string;
}

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.promises.rm(directory, { recursive: true, force: true })));
});

function serverHeaders(identity: string): Record<string, string> {
  return {
    host: "design.example.test",
    origin: PUBLIC_ORIGIN,
    "x-formaspec-csrf": "1",
    "x-designer-user": identity,
    "x-formaspec-proxy-secret": PROXY_SECRET,
  };
}

function grantHeaders(token: string): Record<string, string> {
  return {
    host: "design.example.test",
    origin: PUBLIC_ORIGIN,
    "x-formaspec-csrf": "1",
    authorization: `Bearer ${token}`,
    "x-formaspec-proxy-secret": PROXY_SECRET,
  };
}

async function warmIdentity(application: DesignerApplication, identity: string): Promise<void> {
  const response = await application.app.inject({
    method: "GET",
    url: "/api/designs",
    headers: serverHeaders(identity),
  });
  expect(response.statusCode, response.body).toBe(200);
}

function publishedRelease(
  application: DesignerApplication,
  designSystemId: string,
  expectedLatestVersion: number,
  name: string,
): DesignSystemReleaseResult {
  return application.designSystems.createRelease(ADMIN_ACTOR, designSystemId, {
    expectedLatestVersion,
    name,
    status: "published",
    tokenVersions: [],
    componentVersions: [],
  });
}

function createDesign(application: DesignerApplication, label: string, name: string) {
  return application.service.createDesign(ADMIN_ACTOR, {
    name,
    preset: "web",
    idempotencyKey: `enterprise-final-${label}-0001`,
  });
}

async function createFixture(label: string): Promise<Fixture> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `formaspec-enterprise-final-${label}-`));
  temporaryDirectories.push(root);
  const application = await buildApplication(loadConfig({
    APP_MODE: "server",
    HOST: "0.0.0.0",
    PORT: "4310",
    DATA_DIR: path.join(root, "data"),
    BACKUP_DIR: path.join(root, "backups"),
    DESIGNER_DATABASE_PATH: ":memory:",
    PUBLIC_BASE_URL: PUBLIC_ORIGIN,
    AUTH_MODE: "trusted-header",
    DESIGNER_TOKEN: "enterprise-final-bootstrap-token-0001",
    FORMASPEC_TRUSTED_PROXIES: "127.0.0.1",
    FORMASPEC_PROXY_SECRET: PROXY_SECRET,
    DESIGNER_CORS_ORIGINS: PUBLIC_ORIGIN,
    DESIGNER_LOG_LEVEL: "silent",
  }));
  applications.push(application);
  await application.app.ready();

  await warmIdentity(application, ADMIN_IDENTITY);
  const current = application.policies.read(ADMIN_ACTOR);
  const policy = structuredClone(current.policy);
  policy.identity.roleMappings = [
    { claim: "identity", value: ADMIN_IDENTITY, role: "organization_admin" },
    { claim: "identity", value: PRODUCT_MANAGER_IDENTITY, role: "product_manager" },
    { claim: "identity", value: EDITOR_IDENTITY, role: "design_editor" },
    { claim: "identity", value: ENGINEER_IDENTITY, role: "engineer" },
    { claim: "identity", value: VIEWER_IDENTITY, role: "viewer" },
  ];
  application.policies.update(ADMIN_ACTOR, {
    expectedConfigurationHash: current.configurationHash,
    policy,
  });
  for (const identity of [PRODUCT_MANAGER_IDENTITY, EDITOR_IDENTITY, ENGINEER_IDENTITY, VIEWER_IDENTITY]) {
    await warmIdentity(application, identity);
  }

  const localSystem = application.designSystems.createDesignSystem(ADMIN_ACTOR, {
    name: `Enterprise final local system ${label}`,
  });
  const currentRelease = publishedRelease(application, localSystem.id, 0, "Enterprise final release 1");
  const targetRelease = publishedRelease(application, localSystem.id, 1, "Enterprise final release 2");
  const foreignSystem = application.designSystems.createDesignSystem(ADMIN_ACTOR, {
    name: PRIVATE_MARKER,
    description: `${PRIVATE_PATH}\n${PRIVATE_TOKEN}`,
  });
  const foreignRelease = publishedRelease(application, foreignSystem.id, 0, PRIVATE_MARKER);

  const upgradeDesign = createDesign(application, `upgrade-${label}`, `Upgrade project ${label}`);
  application.designSystems.pinProject(ADMIN_ACTOR, {
    designId: upgradeDesign.document.id,
    releaseId: currentRelease.id,
    expectedCurrentReleaseId: null,
  });
  const stalePreview = application.designSystems.previewProjectUpgrade(ADMIN_ACTOR, {
    designId: upgradeDesign.document.id,
    targetReleaseId: targetRelease.id,
  });
  application.database.sqlite.prepare(
    "UPDATE design_system_upgrade_previews SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
  ).run(stalePreview.id);

  const mappingAllowed = createDesign(application, `mapping-allowed-${label}`, `Mapping allowed ${label}`);
  const mappingDenied = createDesign(application, `mapping-denied-${label}`, `Mapping denied ${label}`);
  const conflictEvidence = createDesign(application, `conflict-evidence-${label}`, `Conflict evidence ${label}`);
  const conflictClean = createDesign(application, `conflict-clean-${label}`, `Conflict clean ${label}`);
  const foreign = createDesign(application, `foreign-${label}`, PRIVATE_MARKER);

  const assetBytes = Buffer.from(`enterprise-final-asset-${label}`);
  const sourceAsset = application.service.saveAsset(ADMIN_ACTOR, {
    designId: conflictEvidence.document.id,
    filename: `${PRIVATE_MARKER}.png`,
    mimeType: "image/png",
    width: 1,
    height: 1,
    data: assetBytes,
  });
  const withAsset = application.service.applyRevision(ADMIN_ACTOR, conflictEvidence.document.id, {
    baseVersion: 1,
    idempotencyKey: `enterprise-final-conflict-asset-${label}`,
    operations: [{
      type: "upsert_asset",
      asset: {
        id: sourceAsset.id,
        name: sourceAsset.filename,
        kind: "image",
        mime_type: sourceAsset.mimeType,
        size_bytes: sourceAsset.sizeBytes,
        storage_key: `asset:${sourceAsset.id}`,
        sha256: sourceAsset.sha256,
        width: sourceAsset.width,
        height: sourceAsset.height,
        metadata: {},
      },
    }],
  });
  application.database.sqlite.prepare(
    `INSERT INTO implementation_mappings
     (id, organization_id, design_id, revision_id, inventory_id, entity_kind, entity_id,
      platform, symbol, mapping_json, created_by, created_at)
     VALUES (?, 'organization_legacy', ?, ?, NULL, 'screen', ?, 'web', ?, ?, ?, ?)`,
  ).run(
    PRIVATE_MAPPING_ID,
    conflictEvidence.document.id,
    withAsset.revision.id,
    conflictEvidence.document.pages[0]!.children[0]!,
    PRIVATE_PATH,
    JSON.stringify({ privateMarker: PRIVATE_MARKER, accessToken: PRIVATE_TOKEN }),
    resolveAccess(application.database.sqlite, ADMIN_ACTOR).principalId,
    new Date().toISOString(),
  );
  const adminAccess = resolveAccess(application.database.sqlite, ADMIN_ACTOR);
  application.database.sqlite.prepare(
    `INSERT INTO idempotency
     (actor_id, scope, key, request_hash, response_json, created_at, expires_at)
     VALUES (?, ?, ?, ?, '{}', '1999-12-31T23:59:00.000Z', '2000-01-01T00:00:00.000Z')`,
  ).run(
    adminAccess.principalId,
    `design:${conflictEvidence.document.id}:conflict-recovery-duplicate`,
    `expired-${PRIVATE_MARKER}`,
    "a".repeat(64),
  );

  const now = new Date().toISOString();
  application.database.sqlite.prepare(
    `INSERT INTO organizations (id, name, config_json, created_at, updated_at)
     VALUES (?, 'Foreign enterprise-final organization', '{}', ?, ?)`,
  ).run(FOREIGN_ORGANIZATION_ID, now, now);
  application.database.sqlite.prepare(
    "UPDATE design_systems SET organization_id = ? WHERE id = ?",
  ).run(FOREIGN_ORGANIZATION_ID, foreignSystem.id);
  application.database.sqlite.prepare(
    "UPDATE designs SET organization_id = ? WHERE id = ?",
  ).run(FOREIGN_ORGANIZATION_ID, foreign.document.id);

  const mappingGrant = application.enterprise.createAgentConnection(ADMIN_ACTOR, {
    adapter: "codex",
    displayName: `Mapping reader ${label}`,
    scopes: ["implementation_mapping:read"],
    projectIds: [mappingAllowed.document.id],
    expiresInSeconds: 3_600,
  });
  const missingMappingScope = application.enterprise.createAgentConnection(ADMIN_ACTOR, {
    adapter: "codex",
    displayName: `Missing mapping scope ${label}`,
    scopes: ["design:read"],
    projectIds: [mappingAllowed.document.id],
    expiresInSeconds: 3_600,
  });
  const restrictedConflict = application.enterprise.createAgentConnection(ADMIN_ACTOR, {
    adapter: "codex",
    displayName: `Restricted conflict duplicate ${label}`,
    scopes: ["design:read", "design:write"],
    projectIds: [conflictEvidence.document.id],
    expiresInSeconds: 3_600,
  });
  const missingConflictWrite = application.enterprise.createAgentConnection(ADMIN_ACTOR, {
    adapter: "codex",
    displayName: `Missing conflict write ${label}`,
    scopes: ["design:read"],
    projectIds: [],
    expiresInSeconds: 3_600,
  });
  const unrestrictedConflict = application.enterprise.createAgentConnection(ADMIN_ACTOR, {
    adapter: "codex",
    displayName: `Unrestricted conflict duplicate ${label}`,
    scopes: ["design:read", "design:write"],
    projectIds: [],
    expiresInSeconds: 3_600,
  });
  const pairedMapping = application.enterprise.pairAgentConnection(mappingGrant.nonce);
  const pairedMissingMapping = application.enterprise.pairAgentConnection(missingMappingScope.nonce);
  const pairedRestrictedConflict = application.enterprise.pairAgentConnection(restrictedConflict.nonce);
  const pairedMissingConflictWrite = application.enterprise.pairAgentConnection(missingConflictWrite.nonce);
  const pairedUnrestrictedConflict = application.enterprise.pairAgentConnection(unrestrictedConflict.nonce);

  return {
    application,
    upgradeDesignId: upgradeDesign.document.id,
    targetRelease,
    foreignRelease,
    stalePreviewId: stalePreview.id,
    mappingAllowedDesignId: mappingAllowed.document.id,
    mappingDeniedDesignId: mappingDenied.document.id,
    conflictEvidenceDesignId: conflictEvidence.document.id,
    conflictEvidenceBaseVersion: withAsset.revision.version,
    conflictCleanDesignId: conflictClean.document.id,
    foreignDesignId: foreign.document.id,
    bearerToken: pairedMapping.grant.token,
    mappingGrantActorId: pairedMapping.grant.actorId,
    missingMappingScopeActorId: pairedMissingMapping.grant.actorId,
    restrictedConflictActorId: pairedRestrictedConflict.grant.actorId,
    missingConflictWriteActorId: pairedMissingConflictWrite.grant.actorId,
    unrestrictedConflictActorId: pairedUnrestrictedConflict.grant.actorId,
  };
}

function mutationState(application: DesignerApplication): unknown {
  return {
    designs: application.database.sqlite.prepare(
      "SELECT id, organization_id, current_version, current_revision_id, name, updated_at FROM designs ORDER BY id",
    ).all(),
    revisions: application.database.sqlite.prepare(
      `SELECT id, design_id, version, parent_revision_id, snapshot_hash, operation_hash,
              parent_revision_hash, revision_hash, message, created_at
       FROM revisions ORDER BY design_id, version`,
    ).all(),
    snapshots: application.database.sqlite.prepare(
      "SELECT snapshot_hash, encoding, uncompressed_bytes, created_at FROM snapshots ORDER BY snapshot_hash",
    ).all(),
    assets: application.database.sqlite.prepare(
      `SELECT id, organization_id, design_id, filename, mime_type, size_bytes, width, height, sha256, created_at
       FROM assets ORDER BY id`,
    ).all(),
    mappings: application.database.sqlite.prepare(
      "SELECT * FROM implementation_mappings ORDER BY id",
    ).all(),
    specifications: application.database.sqlite.prepare(
      "SELECT * FROM product_specifications ORDER BY design_id, version",
    ).all(),
    previews: application.database.sqlite.prepare(
      `SELECT id, organization_id, design_id, current_release_id, target_release_id,
              preview_hash, status, created_by, created_at, expires_at, committed_at
       FROM design_system_upgrade_previews ORDER BY id`,
    ).all(),
    idempotency: application.database.sqlite.prepare(
      "SELECT * FROM idempotency ORDER BY actor_id, scope, key",
    ).all(),
    audits: application.database.sqlite.prepare(
      "SELECT * FROM audit_events ORDER BY id",
    ).all(),
    outbox: application.database.sqlite.prepare(
      "SELECT * FROM event_outbox ORDER BY id",
    ).all(),
    grants: application.database.sqlite.prepare(
      `SELECT id, principal_id, scopes_json, project_ids_json, revoked_at, last_used_at
       FROM agent_grants ORDER BY id`,
    ).all(),
  };
}

function expectError(
  response: { statusCode: number; body: string; json<T>(): T },
  statusCode: number,
  code: string,
  hidden: string[],
): void {
  expect(response.statusCode, response.body).toBe(statusCode);
  expect(response.json<{ error: { code: string } }>().error.code, response.body).toBe(code);
  for (const value of hidden) expect(response.body).not.toContain(value);
}

function captureDomainError(callback: () => unknown): DomainError {
  try {
    callback();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error("Expected a DomainError.");
}

describe("final enterprise and operations route authorization", () => {
  it("authorizes before parsing, cleanup, or copying and keeps capabilities static and secret-free", async () => {
    const fixture = await createFixture("denied");
    const {
      application,
      upgradeDesignId,
      foreignRelease,
      mappingAllowedDesignId,
      mappingDeniedDesignId,
      conflictEvidenceDesignId,
      conflictEvidenceBaseVersion,
      foreignDesignId,
      bearerToken,
      mappingGrantActorId,
      missingMappingScopeActorId,
      restrictedConflictActorId,
      missingConflictWriteActorId,
    } = fixture;
    const malformedSegment = encodeURIComponent(" ");
    const hidden = [
      foreignRelease.id,
      foreignDesignId,
      PRIVATE_MAPPING_ID,
      PRIVATE_MARKER,
      PRIVATE_PATH,
      PRIVATE_TOKEN,
      PROXY_SECRET,
    ];
    const invalidUpgradeBody = { targetReleaseId: PRIVATE_TOKEN, privateMarker: PRIVATE_MARKER };
    const invalidConflictBody = {
      baseVersion: 0,
      operations: [{ type: PRIVATE_MARKER, privatePath: PRIVATE_PATH }],
      idempotencyKey: "short",
      privateToken: PRIVATE_TOKEN,
    };
    const before = mutationState(application);

    const unauthenticatedCapabilities = await application.app.inject({
      method: "GET",
      url: "/api/enterprise-domain-capabilities",
      headers: { host: "design.example.test", "x-formaspec-proxy-secret": PROXY_SECRET },
    });
    expectError(unauthenticatedCapabilities, 401, "AUTH_REQUIRED", hidden);

    const bearerDenied = await Promise.all([
      application.app.inject({
        method: "POST",
        url: `/api/designs/${malformedSegment}/design-system-upgrade-previews`,
        headers: grantHeaders(bearerToken),
        payload: invalidUpgradeBody,
      }),
      application.app.inject({
        method: "GET",
        url: `/api/designs/${malformedSegment}/implementation-mappings?privateMarker=${encodeURIComponent(PRIVATE_MARKER)}`,
        headers: grantHeaders(bearerToken),
      }),
      application.app.inject({
        method: "POST",
        url: `/api/designs/${malformedSegment}/conflict-recovery/duplicate`,
        headers: grantHeaders(bearerToken),
        payload: invalidConflictBody,
      }),
      application.app.inject({
        method: "GET",
        url: `/api/enterprise-domain-capabilities?privateMarker=${encodeURIComponent(PRIVATE_MARKER)}`,
        headers: grantHeaders(bearerToken),
      }),
    ]);
    for (const response of bearerDenied) expectError(response, 401, "AUTH_REQUIRED", hidden);

    const roleDenied = await Promise.all([
      application.app.inject({
        method: "POST",
        url: `/api/designs/${malformedSegment}/design-system-upgrade-previews`,
        headers: serverHeaders(EDITOR_IDENTITY),
        payload: invalidUpgradeBody,
      }),
      application.app.inject({
        method: "POST",
        url: `/api/designs/${malformedSegment}/conflict-recovery/duplicate`,
        headers: serverHeaders(VIEWER_IDENTITY),
        payload: invalidConflictBody,
      }),
      application.app.inject({
        method: "POST",
        url: `/api/designs/${malformedSegment}/conflict-recovery/duplicate`,
        headers: serverHeaders(ENGINEER_IDENTITY),
        payload: invalidConflictBody,
      }),
    ]);
    for (const response of roleDenied) expectError(response, 403, "FORBIDDEN", hidden);

    const projectOpaque = await Promise.all([
      application.app.inject({
        method: "POST",
        url: `/api/designs/${malformedSegment}/design-system-upgrade-previews`,
        headers: serverHeaders(ADMIN_IDENTITY),
        payload: invalidUpgradeBody,
      }),
      application.app.inject({
        method: "GET",
        url: `/api/designs/${malformedSegment}/implementation-mappings?privateMarker=${encodeURIComponent(PRIVATE_MARKER)}`,
        headers: serverHeaders(VIEWER_IDENTITY),
      }),
      application.app.inject({
        method: "POST",
        url: `/api/designs/${malformedSegment}/conflict-recovery/duplicate`,
        headers: serverHeaders(PRODUCT_MANAGER_IDENTITY),
        payload: invalidConflictBody,
      }),
      application.app.inject({
        method: "POST",
        url: `/api/designs/${foreignDesignId}/design-system-upgrade-previews`,
        headers: serverHeaders(ADMIN_IDENTITY),
        payload: invalidUpgradeBody,
      }),
      application.app.inject({
        method: "GET",
        url: `/api/designs/${foreignDesignId}/implementation-mappings?privateMarker=${encodeURIComponent(PRIVATE_MARKER)}`,
        headers: serverHeaders(VIEWER_IDENTITY),
      }),
      application.app.inject({
        method: "POST",
        url: `/api/designs/${foreignDesignId}/conflict-recovery/duplicate`,
        headers: serverHeaders(PRODUCT_MANAGER_IDENTITY),
        payload: invalidConflictBody,
      }),
    ]);
    for (const response of projectOpaque) expectError(response, 404, "NOT_FOUND", hidden);

    for (const callback of [
      () => application.handoffs.listImplementationMappings(missingMappingScopeActorId, {
        designId: mappingAllowedDesignId,
      }),
      () => application.handoffs.listImplementationMappings(mappingGrantActorId, {
        designId: mappingDeniedDesignId,
      }),
      () => application.operations.duplicateConflictingDraft(restrictedConflictActorId, conflictEvidenceDesignId, {
        baseVersion: conflictEvidenceBaseVersion,
        operations: new Proxy({}, { get: () => { throw new Error(PRIVATE_MARKER); } }),
        idempotencyKey: "restricted-conflict-duplicate-0001",
      }),
      () => application.operations.duplicateConflictingDraft(missingConflictWriteActorId, conflictEvidenceDesignId, {
        baseVersion: conflictEvidenceBaseVersion,
        operations: new Proxy({}, { get: () => { throw new Error(PRIVATE_MARKER); } }),
        idempotencyKey: "missing-write-conflict-duplicate-0001",
      }),
      () => application.designSystems.previewProjectUpgrade(mappingGrantActorId, {
        designId: upgradeDesignId,
        targetReleaseId: foreignRelease.id,
      }),
    ]) {
      const error = captureDomainError(callback);
      expect(error).toMatchObject({ statusCode: expect.any(Number) });
      expect(["FORBIDDEN", "NOT_FOUND"]).toContain(error.code);
      for (const value of hidden) expect(JSON.stringify(error.toJSON())).not.toContain(value);
    }

    const foreignTarget = await application.app.inject({
      method: "POST",
      url: `/api/designs/${upgradeDesignId}/design-system-upgrade-previews`,
      headers: serverHeaders(ADMIN_IDENTITY),
      payload: { targetReleaseId: foreignRelease.id },
    });
    expectError(foreignTarget, 404, "NOT_FOUND", hidden);

    const invalidMappingQuery = await application.app.inject({
      method: "GET",
      url: `/api/designs/${mappingAllowedDesignId}/implementation-mappings?privateMarker=${encodeURIComponent(PRIVATE_MARKER)}`,
      headers: serverHeaders(VIEWER_IDENTITY),
    });
    expectError(invalidMappingQuery, 422, "VALIDATION_FAILED", hidden);

    const invalidConflictOperations = await application.app.inject({
      method: "POST",
      url: `/api/designs/${conflictEvidenceDesignId}/conflict-recovery/duplicate`,
      headers: serverHeaders(ADMIN_IDENTITY),
      payload: {
        baseVersion: conflictEvidenceBaseVersion,
        operations: [{ type: "not_a_real_operation", privateMarker: PRIVATE_MARKER }],
        idempotencyKey: "invalid-conflict-operation-0001",
      },
    });
    expectError(invalidConflictOperations, 422, "VALIDATION_FAILED", hidden);

    const adminCapabilities = await application.app.inject({
      method: "GET",
      url: "/api/enterprise-domain-capabilities",
      headers: serverHeaders(ADMIN_IDENTITY),
    });
    const viewerCapabilities = await application.app.inject({
      method: "GET",
      url: "/api/enterprise-domain-capabilities",
      headers: serverHeaders(VIEWER_IDENTITY),
    });
    expect(adminCapabilities.statusCode, adminCapabilities.body).toBe(200);
    expect(viewerCapabilities.statusCode, viewerCapabilities.body).toBe(200);
    expect(adminCapabilities.json()).toEqual(viewerCapabilities.json());
    expect(adminCapabilities.json()).toEqual({
      handoffStatuses: ["draft", "in_review", "approved", "implementing", "completed", "cancelled"],
      redesignStages: [
        "connect_inspect",
        "document_current_state",
        "pm_interview",
        "future_state_proposal",
        "design",
        "handoff",
        "approved_implementation",
      ],
    });
    for (const value of [...hidden, ADMIN_IDENTITY, VIEWER_IDENTITY]) {
      expect(adminCapabilities.body).not.toContain(value);
    }
    const invalidCapabilityQuery = await application.app.inject({
      method: "GET",
      url: `/api/enterprise-domain-capabilities?privateMarker=${encodeURIComponent(PRIVATE_MARKER)}`,
      headers: serverHeaders(ADMIN_IDENTITY),
    });
    expectError(invalidCapabilityQuery, 422, "VALIDATION_FAILED", hidden);

    expect(mutationState(application)).toEqual(before);
  });

  it("preserves valid upgrade previews, mapping reads, static capabilities, and UI/scoped-agent duplication", async () => {
    const {
      application,
      upgradeDesignId,
      targetRelease,
      stalePreviewId,
      mappingAllowedDesignId,
      conflictCleanDesignId,
      mappingGrantActorId,
      unrestrictedConflictActorId,
    } = await createFixture("allowed");
    const hidden = [PRIVATE_MAPPING_ID, PRIVATE_MARKER, PRIVATE_PATH, PRIVATE_TOKEN, PROXY_SECRET];

    const preview = await application.app.inject({
      method: "POST",
      url: `/api/designs/${upgradeDesignId}/design-system-upgrade-previews`,
      headers: serverHeaders(ADMIN_IDENTITY),
      payload: { targetReleaseId: targetRelease.id },
    });
    expect(preview.statusCode, preview.body).toBe(201);
    expect(preview.json<{ preview: DesignSystemUpgradePreviewResult }>().preview).toMatchObject({
      designId: upgradeDesignId,
      targetReleaseId: targetRelease.id,
      status: "ready",
      canCommit: true,
    });
    expect(application.database.sqlite.prepare(
      "SELECT status FROM design_system_upgrade_previews WHERE id = ?",
    ).get(stalePreviewId)).toEqual({ status: "expired" });

    for (const identity of [
      ADMIN_IDENTITY,
      PRODUCT_MANAGER_IDENTITY,
      EDITOR_IDENTITY,
      ENGINEER_IDENTITY,
      VIEWER_IDENTITY,
    ]) {
      const mappings = await application.app.inject({
        method: "GET",
        url: `/api/designs/${mappingAllowedDesignId}/implementation-mappings?limit=25`,
        headers: serverHeaders(identity),
      });
      expect(mappings.statusCode, mappings.body).toBe(200);
      expect(mappings.json<{ mappings: unknown[] }>().mappings).toEqual([]);
      for (const value of hidden) expect(mappings.body).not.toContain(value);
    }
    expect(application.handoffs.listImplementationMappings(mappingGrantActorId, {
      designId: mappingAllowedDesignId,
      limit: 25,
    })).toEqual([]);

    const uiDuplicate = await application.app.inject({
      method: "POST",
      url: `/api/designs/${conflictCleanDesignId}/conflict-recovery/duplicate`,
      headers: serverHeaders(PRODUCT_MANAGER_IDENTITY),
      payload: {
        baseVersion: 1,
        operations: [],
        idempotencyKey: "ui-conflict-duplicate-0001",
        name: "UI recovered project",
      },
    });
    expect(uiDuplicate.statusCode, uiDuplicate.body).toBe(201);
    expect(uiDuplicate.json<{ duplicated: boolean; project: { id: string; name: string } }>()).toMatchObject({
      duplicated: true,
      project: { name: "UI recovered project" },
    });

    const agentDuplicate = application.operations.duplicateConflictingDraft(
      unrestrictedConflictActorId,
      conflictCleanDesignId,
      {
        baseVersion: 1,
        operations: [],
        idempotencyKey: "agent-conflict-duplicate-0001",
        name: "Agent recovered project",
      },
    );
    expect(agentDuplicate).toMatchObject({
      duplicated: true,
      project: { name: "Agent recovered project" },
    });
    expect(agentDuplicate.project.id).not.toBe(
      uiDuplicate.json<{ project: { id: string } }>().project.id,
    );

    const capabilities = await application.app.inject({
      method: "GET",
      url: "/api/enterprise-domain-capabilities",
      headers: serverHeaders(VIEWER_IDENTITY),
    });
    expect(capabilities.statusCode, capabilities.body).toBe(200);
    expect(Object.keys(capabilities.json<Record<string, unknown>>()).sort()).toEqual([
      "handoffStatuses",
      "redesignStages",
    ]);
    for (const value of hidden) expect(capabilities.body).not.toContain(value);
  });
});
