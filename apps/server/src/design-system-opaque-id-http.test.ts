import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { loadConfig, type ServerConfig } from "./config.js";
import type {
  DesignSystemReleaseResult,
  DesignSystemUpgradePreviewResult,
} from "./design-system-service.js";
import { DomainError } from "./errors.js";
import { DEFAULT_ORGANIZATION_POLICY } from "./organization-policy-model.js";

const PROXY_SECRET = "opaque-route-proxy-secret-0123456789abcdef";
const PUBLIC_ORIGIN = "https://formaspec.example.test";
const ADMIN_IDENTITY = "opaque-admin@example.test";
const OTHER_ADMIN_IDENTITY = "opaque-other-admin@example.test";
const EDITOR_IDENTITY = "opaque-editor@example.test";
const ADMIN_ACTOR = `trusted:${ADMIN_IDENTITY}`;
const FOREIGN_ORGANIZATION_ID = "organization_opaque_foreign";
const FOREIGN_RELEASE_MARKER = "FOREIGN_RELEASE_MARKER_8f59c2d1";
const RESTRICTED_PROJECT_MARKER = "RESTRICTED_PROJECT_MARKER_17d04a6b";

interface OpaqueRouteFixture {
  application: DesignerApplication;
  root: string;
  config: ServerConfig;
  allowedDesignId: string;
  restrictedDesignId: string;
  currentRelease: DesignSystemReleaseResult;
  targetRelease: DesignSystemReleaseResult;
  foreignRelease: DesignSystemReleaseResult;
  allowedPreview: DesignSystemUpgradePreviewResult;
  restrictedPreview: DesignSystemUpgradePreviewResult;
  otherCreatorExpiredPreviewId: string;
  swappedReleasePreviewId: string;
  foreignPreviewId: string;
}

const applications: DesignerApplication[] = [];
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map(async (application) => {
    try {
      await application.app.close();
    } catch {
      // A restart test may already have closed this instance.
    }
  }));
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function serverConfig(root: string): ServerConfig {
  return loadConfig({
    APP_MODE: "server",
    HOST: "0.0.0.0",
    PORT: "4310",
    DATA_DIR: path.join(root, "data"),
    BACKUP_DIR: path.join(root, "backups"),
    DESIGNER_DATABASE_PATH: path.join(root, "data", "designer.sqlite"),
    PUBLIC_BASE_URL: PUBLIC_ORIGIN,
    AUTH_MODE: "trusted-header",
    DESIGNER_TOKEN: "opaque-route-bootstrap-token-0001",
    TRUSTED_USER_HEADER: "x-company-user",
    FORMASPEC_TRUSTED_PROXIES: "127.0.0.1",
    FORMASPEC_PROXY_SECRET: PROXY_SECRET,
    DESIGNER_CORS_ORIGINS: PUBLIC_ORIGIN,
    DESIGNER_LOG_LEVEL: "silent",
  });
}

function browserHeaders(identity: string): Record<string, string> {
  return {
    host: "formaspec.example.test",
    origin: PUBLIC_ORIGIN,
    "x-formaspec-csrf": "1",
    "x-company-user": identity,
    "x-formaspec-proxy-secret": PROXY_SECRET,
  };
}

function anonymousHeaders(): Record<string, string> {
  return {
    host: "formaspec.example.test",
    "x-formaspec-proxy-secret": PROXY_SECRET,
  };
}

function token(value: string) {
  return {
    id: "token_opaqueprimary0001",
    path: "action.primary.background",
    name: "Opaque route primary action",
    family: "color" as const,
    layer: "semantic" as const,
    value,
    deprecated: false,
  };
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

function domainState(application: DesignerApplication, designIds: string[]) {
  const placeholders = designIds.map(() => "?").join(", ");
  return {
    pins: application.database.sqlite.prepare(
      `SELECT design_id, design_system_id, release_id, release_version, pinned_by, pinned_at
       FROM project_design_system_pins
       WHERE design_id IN (${placeholders})
       ORDER BY design_id`,
    ).all(...designIds),
    revisions: application.database.sqlite.prepare(
      `SELECT design_id, COUNT(*) AS count, MAX(version) AS maximum_version
       FROM revisions
       WHERE design_id IN (${placeholders})
       GROUP BY design_id
       ORDER BY design_id`,
    ).all(...designIds),
    previews: application.database.sqlite.prepare(
      `SELECT id, organization_id, design_id, current_release_id, target_release_id,
              preview_hash, status, created_by, expires_at, committed_at
       FROM design_system_upgrade_previews
       ORDER BY id`,
    ).all(),
  };
}

async function createFixture(): Promise<OpaqueRouteFixture> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "formaspec-opaque-design-system-http-"));
  temporaryRoots.push(root);
  const config = serverConfig(root);
  const application = await buildApplication(config);
  applications.push(application);
  await application.app.ready();

  const bootstrap = await application.app.inject({
    method: "GET",
    url: "/api/organization/policy",
    headers: browserHeaders(ADMIN_IDENTITY),
  });
  expect(bootstrap.statusCode).toBe(200);
  const currentPolicy = application.policies.read(ADMIN_ACTOR);
  const policy = structuredClone(DEFAULT_ORGANIZATION_POLICY);
  policy.identity.roleMappings = [
    { claim: "identity", value: ADMIN_IDENTITY, role: "organization_admin" },
    { claim: "identity", value: OTHER_ADMIN_IDENTITY, role: "organization_admin" },
    { claim: "identity", value: EDITOR_IDENTITY, role: "design_editor" },
  ];
  application.policies.update(ADMIN_ACTOR, {
    expectedConfigurationHash: currentPolicy.configurationHash,
    policy,
  });

  const allowed = application.service.createDesign(ADMIN_ACTOR, {
    name: "Allowed opaque route project",
    preset: "web",
    idempotencyKey: "opaque-route-allowed-design-0001",
  });
  const restricted = application.service.createDesign(ADMIN_ACTOR, {
    name: RESTRICTED_PROJECT_MARKER,
    preset: "phone",
    idempotencyKey: "opaque-route-restricted-design-0001",
  });

  const system = application.designSystems.createDesignSystem(ADMIN_ACTOR, {
    name: "Opaque route design system",
  });
  application.designSystems.createTokenVersion(ADMIN_ACTOR, system.id, {
    expectedLatestVersion: 0,
    status: "published",
    token: token("#2457e6"),
  });
  const currentRelease = application.designSystems.createRelease(ADMIN_ACTOR, system.id, {
    expectedLatestVersion: 0,
    name: "Opaque release 1",
    status: "published",
    tokenVersions: [{ tokenId: "token_opaqueprimary0001", version: 1 }],
    componentVersions: [],
  });
  for (const designId of [allowed.document.id, restricted.document.id]) {
    application.designSystems.pinProject(ADMIN_ACTOR, {
      designId,
      releaseId: currentRelease.id,
      expectedCurrentReleaseId: null,
    });
  }
  application.designSystems.createTokenVersion(ADMIN_ACTOR, system.id, {
    expectedLatestVersion: 1,
    status: "published",
    token: token("#173ea5"),
  });
  const targetRelease = application.designSystems.createRelease(ADMIN_ACTOR, system.id, {
    expectedLatestVersion: 1,
    name: "Opaque release 2",
    status: "published",
    tokenVersions: [{ tokenId: "token_opaqueprimary0001", version: 2 }],
    componentVersions: [],
  });
  const allowedPreview = application.designSystems.previewProjectUpgrade(ADMIN_ACTOR, {
    designId: allowed.document.id,
    targetReleaseId: targetRelease.id,
  });
  const restrictedPreview = application.designSystems.previewProjectUpgrade(ADMIN_ACTOR, {
    designId: restricted.document.id,
    targetReleaseId: targetRelease.id,
  });

  const foreignSystem = application.designSystems.createDesignSystem(ADMIN_ACTOR, {
    name: "Foreign opaque design system",
  });
  const foreignRelease = application.designSystems.createRelease(ADMIN_ACTOR, foreignSystem.id, {
    expectedLatestVersion: 0,
    name: FOREIGN_RELEASE_MARKER,
    status: "published",
    tokenVersions: [],
    componentVersions: [],
  });
  const now = new Date().toISOString();
  application.database.sqlite.prepare(
    `INSERT INTO organizations (id, name, config_json, created_at, updated_at)
     VALUES (?, 'Foreign opaque organization', '{}', ?, ?)`,
  ).run(FOREIGN_ORGANIZATION_ID, now, now);
  application.database.sqlite.prepare(
    "UPDATE design_systems SET organization_id = ? WHERE id = ?",
  ).run(FOREIGN_ORGANIZATION_ID, foreignSystem.id);

  const foreignPreviewId = `upgrade_${"f".repeat(32)}`;
  const otherCreatorExpiredPreviewId = `upgrade_${"d".repeat(32)}`;
  const swappedReleasePreviewId = `upgrade_${"e".repeat(32)}`;
  application.database.sqlite.prepare(
    `INSERT INTO design_system_upgrade_previews
     (id, organization_id, design_id, current_release_id, target_release_id, diagnostics_json,
      preview_hash, status, created_by, created_at, expires_at, committed_at)
     SELECT ?, organization_id, design_id, current_release_id, target_release_id, diagnostics_json,
            preview_hash, 'ready', created_by, created_at, '2000-01-01T00:00:00.000Z', NULL
     FROM design_system_upgrade_previews WHERE id = ?`,
  ).run(otherCreatorExpiredPreviewId, allowedPreview.id);
  application.database.sqlite.prepare(
    `INSERT INTO design_system_upgrade_previews
     (id, organization_id, design_id, current_release_id, target_release_id, diagnostics_json,
      preview_hash, status, created_by, created_at, expires_at, committed_at)
     SELECT ?, organization_id, design_id, current_release_id, ?, diagnostics_json,
            preview_hash, 'ready', created_by, created_at, expires_at, NULL
     FROM design_system_upgrade_previews WHERE id = ?`,
  ).run(swappedReleasePreviewId, currentRelease.id, allowedPreview.id);
  application.database.sqlite.prepare(
    `INSERT INTO design_system_upgrade_previews
     (id, organization_id, design_id, current_release_id, target_release_id, diagnostics_json,
      preview_hash, status, created_by, created_at, expires_at, committed_at)
     SELECT ?, ?, design_id, current_release_id, ?, diagnostics_json,
            preview_hash, 'ready', created_by, created_at, '2000-01-01T00:00:00.000Z', NULL
     FROM design_system_upgrade_previews WHERE id = ?`,
  ).run(foreignPreviewId, FOREIGN_ORGANIZATION_ID, foreignRelease.id, restrictedPreview.id);

  return {
    application,
    root,
    config,
    allowedDesignId: allowed.document.id,
    restrictedDesignId: restricted.document.id,
    currentRelease,
    targetRelease,
    foreignRelease,
    allowedPreview,
    restrictedPreview,
    otherCreatorExpiredPreviewId,
    swappedReleasePreviewId,
    foreignPreviewId,
  };
}

function pairProjectGrant(
  fixture: OpaqueRouteFixture,
  label: string,
  projectIds: string[],
) {
  const challenge = fixture.application.enterprise.createAgentConnection(ADMIN_ACTOR, {
    adapter: "codex",
    displayName: `Opaque route grant ${label}`,
    scopes: ["design_system:read"],
    projectIds,
  });
  return fixture.application.enterprise.pairAgentConnection(challenge.nonce);
}

function mcpTool(
  fixture: OpaqueRouteFixture,
  token: string,
  name: string,
  args: Record<string, unknown>,
) {
  return fixture.application.app.inject({
    method: "POST",
    url: "/mcp",
    remoteAddress: "127.0.0.1",
    headers: {
      host: "formaspec.example.test",
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

describe("design-system opaque-ID HTTP authorization", () => {
  it("uses trusted-header roles, hides foreign organization IDs, validates strict commit bodies, and leaves rejected state unchanged", async () => {
    const fixture = await createFixture();
    const { application } = fixture;
    const before = domainState(application, [fixture.allowedDesignId, fixture.restrictedDesignId]);

    const missingIdentity = await application.app.inject({
      method: "GET",
      url: `/api/design-system-releases/${fixture.targetRelease.id}`,
      headers: anonymousHeaders(),
    });
    expect(missingIdentity.statusCode).toBe(401);
    expect(missingIdentity.json()).toMatchObject({ error: { code: "AUTH_REQUIRED" } });

    for (const identity of [ADMIN_IDENTITY, EDITOR_IDENTITY]) {
      const release = await application.app.inject({
        method: "GET",
        url: `/api/design-system-releases/${fixture.targetRelease.id}`,
        headers: browserHeaders(identity),
      });
      expect(release.statusCode).toBe(200);
      expect(release.json<{ release: DesignSystemReleaseResult }>().release).toMatchObject({
        id: fixture.targetRelease.id,
        designSystemId: fixture.targetRelease.designSystemId,
        version: 2,
      });

      const preview = await application.app.inject({
        method: "GET",
        url: `/api/design-system-upgrade-previews/${fixture.allowedPreview.id}`,
        headers: browserHeaders(identity),
      });
      expect(preview.statusCode).toBe(200);
      expect(preview.json<{ preview: DesignSystemUpgradePreviewResult }>().preview).toMatchObject({
        id: fixture.allowedPreview.id,
        designId: fixture.allowedDesignId,
        currentReleaseId: fixture.currentRelease.id,
        targetReleaseId: fixture.targetRelease.id,
        status: "ready",
      });
    }

    const editorCommit = await application.app.inject({
      method: "POST",
      url: `/api/design-system-upgrade-previews/${fixture.allowedPreview.id}/commit`,
      headers: browserHeaders(EDITOR_IDENTITY),
      payload: { expectedPreviewHash: fixture.allowedPreview.previewHash },
    });
    expect(editorCommit.statusCode).toBe(403);
    expect(editorCommit.json()).toMatchObject({ error: { code: "FORBIDDEN" } });

    const otherAdminCommit = await application.app.inject({
      method: "POST",
      url: `/api/design-system-upgrade-previews/${fixture.otherCreatorExpiredPreviewId}/commit`,
      headers: browserHeaders(OTHER_ADMIN_IDENTITY),
      payload: { expectedPreviewHash: fixture.allowedPreview.previewHash },
    });
    expect(otherAdminCommit.statusCode).toBe(404);
    expect(otherAdminCommit.json()).toMatchObject({
      error: { code: "NOT_FOUND", message: "Design-system upgrade preview not found." },
    });

    const nonSchemaIdempotency = await application.app.inject({
      method: "POST",
      url: `/api/design-system-upgrade-previews/${fixture.allowedPreview.id}/commit`,
      headers: browserHeaders(ADMIN_IDENTITY),
      payload: {
        expectedPreviewHash: fixture.allowedPreview.previewHash,
        idempotencyKey: "not-supported-on-exact-upgrade-commit",
      },
    });
    expect(nonSchemaIdempotency.statusCode).toBe(422);
    expect(nonSchemaIdempotency.json()).toMatchObject({ error: { code: "VALIDATION_FAILED" } });

    const malformedHash = await application.app.inject({
      method: "POST",
      url: `/api/design-system-upgrade-previews/${fixture.allowedPreview.id}/commit`,
      headers: browserHeaders(ADMIN_IDENTITY),
      payload: { expectedPreviewHash: "not-a-sha256" },
    });
    expect(malformedHash.statusCode).toBe(422);

    const wrongHash = await application.app.inject({
      method: "POST",
      url: `/api/design-system-upgrade-previews/${fixture.allowedPreview.id}/commit`,
      headers: browserHeaders(ADMIN_IDENTITY),
      payload: { expectedPreviewHash: "0".repeat(64) },
    });
    expect(wrongHash.statusCode).toBe(409);
    expect(wrongHash.json()).toMatchObject({ error: { code: "VERSION_CONFLICT" } });

    const swappedReleaseCommit = await application.app.inject({
      method: "POST",
      url: `/api/design-system-upgrade-previews/${fixture.swappedReleasePreviewId}/commit`,
      headers: browserHeaders(ADMIN_IDENTITY),
      payload: { expectedPreviewHash: fixture.allowedPreview.previewHash },
    });
    expect(swappedReleaseCommit.statusCode).toBe(409);
    expect(swappedReleaseCommit.json()).toMatchObject({ error: { code: "VERSION_CONFLICT" } });

    const foreignRelease = await application.app.inject({
      method: "GET",
      url: `/api/design-system-releases/${fixture.foreignRelease.id}`,
      headers: browserHeaders(ADMIN_IDENTITY),
    });
    expect(foreignRelease.statusCode).toBe(404);
    expect(foreignRelease.json()).toMatchObject({
      error: { code: "NOT_FOUND", message: "Design-system release not found." },
    });

    const foreignPreview = await application.app.inject({
      method: "GET",
      url: `/api/design-system-upgrade-previews/${fixture.foreignPreviewId}`,
      headers: browserHeaders(ADMIN_IDENTITY),
    });
    expect(foreignPreview.statusCode).toBe(404);
    expect(foreignPreview.json()).toMatchObject({
      error: { code: "NOT_FOUND", message: "Design-system upgrade preview not found." },
    });

    const foreignCommit = await application.app.inject({
      method: "POST",
      url: `/api/design-system-upgrade-previews/${fixture.foreignPreviewId}/commit`,
      headers: browserHeaders(ADMIN_IDENTITY),
      payload: { expectedPreviewHash: fixture.restrictedPreview.previewHash },
    });
    expect(foreignCommit.statusCode).toBe(404);

    const deniedBodies = [
      missingIdentity.body,
      editorCommit.body,
      otherAdminCommit.body,
      nonSchemaIdempotency.body,
      malformedHash.body,
      wrongHash.body,
      swappedReleaseCommit.body,
      foreignRelease.body,
      foreignPreview.body,
      foreignCommit.body,
    ].join("\n");
    expect(deniedBodies).not.toContain(FOREIGN_RELEASE_MARKER);
    expect(deniedBodies).not.toContain(RESTRICTED_PROJECT_MARKER);
    expect(deniedBodies).not.toContain(fixture.restrictedDesignId);
    expect(domainState(application, [fixture.allowedDesignId, fixture.restrictedDesignId])).toEqual(before);
  });

  it("expires only the requested preview after its organization and project access are established", async () => {
    const fixture = await createFixture();
    fixture.application.database.sqlite.prepare(
      "UPDATE design_system_upgrade_previews SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
    ).run(fixture.allowedPreview.id);

    const response = await fixture.application.app.inject({
      method: "GET",
      url: `/api/design-system-upgrade-previews/${fixture.allowedPreview.id}`,
      headers: browserHeaders(EDITOR_IDENTITY),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ preview: DesignSystemUpgradePreviewResult }>().preview).toMatchObject({
      id: fixture.allowedPreview.id,
      status: "expired",
      canCommit: false,
    });
    expect(fixture.application.database.sqlite.prepare(
      "SELECT status FROM design_system_upgrade_previews WHERE id = ?",
    ).get(fixture.allowedPreview.id)).toEqual({ status: "expired" });
    expect(fixture.application.database.sqlite.prepare(
      "SELECT status FROM design_system_upgrade_previews WHERE id = ?",
    ).get(fixture.foreignPreviewId)).toEqual({ status: "ready" });
  });

  it("enforces scoped project restrictions and immediate grant expiry or revocation at the service boundary", async () => {
    const fixture = await createFixture();
    const { application } = fixture;
    const readGrant = pairProjectGrant(fixture, "read", [fixture.allowedDesignId]);

    expect(application.designSystems.readRelease(
      readGrant.grant.actorId,
      fixture.currentRelease.id,
    )).toMatchObject({ id: fixture.currentRelease.id });

    const unpinnedReleaseRead = captureDomainError(() => application.designSystems.readRelease(
      readGrant.grant.actorId,
      fixture.targetRelease.id,
    ));
    expect(unpinnedReleaseRead).toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
    expect(JSON.stringify(unpinnedReleaseRead.toJSON())).not.toContain(FOREIGN_RELEASE_MARKER);

    const pinnedReleaseMcp = await mcpTool(
      fixture,
      readGrant.grant.token,
      "design_system_release_read",
      { release_id: fixture.currentRelease.id },
    );
    expect(pinnedReleaseMcp.statusCode, pinnedReleaseMcp.body).toBe(200);
    expect(pinnedReleaseMcp.json<{
      result: { structuredContent: { ok: boolean; release: { id: string } } };
    }>().result.structuredContent).toMatchObject({
      ok: true,
      release: { id: fixture.currentRelease.id },
    });

    const unpinnedReleaseMcp = await mcpTool(
      fixture,
      readGrant.grant.token,
      "design_system_release_read",
      { release_id: fixture.targetRelease.id },
    );
    expect(unpinnedReleaseMcp.statusCode, unpinnedReleaseMcp.body).toBe(200);
    expect(unpinnedReleaseMcp.json<{
      result: { structuredContent: { ok: boolean; error: { code: string } } };
    }>().result.structuredContent).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(unpinnedReleaseMcp.body).not.toContain(FOREIGN_RELEASE_MARKER);

    expect(application.designSystems.readUpgradePreview(
      readGrant.grant.actorId,
      fixture.allowedPreview.id,
    ).designId).toBe(fixture.allowedDesignId);

    application.database.sqlite.prepare(
      "UPDATE design_system_upgrade_previews SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
    ).run(fixture.restrictedPreview.id);
    const beforeRestrictedRead = domainState(application, [fixture.allowedDesignId, fixture.restrictedDesignId]);
    const restrictedRead = captureDomainError(() => application.designSystems.readUpgradePreview(
      readGrant.grant.actorId,
      fixture.restrictedPreview.id,
    ));
    expect(restrictedRead).toMatchObject({ code: "NOT_FOUND", statusCode: 404, message: "Design not found." });
    expect(JSON.stringify(restrictedRead.toJSON())).not.toContain(RESTRICTED_PROJECT_MARKER);
    expect(domainState(application, [fixture.allowedDesignId, fixture.restrictedDesignId])).toEqual(beforeRestrictedRead);

    application.enterprise.revokeAgentConnection(ADMIN_ACTOR, readGrant.connection.id);
    const revoked = captureDomainError(() => application.designSystems.readUpgradePreview(
      readGrant.grant.actorId,
      fixture.allowedPreview.id,
    ));
    expect(revoked).toMatchObject({ code: "AUTH_REQUIRED", statusCode: 401 });

    const expiredGrant = pairProjectGrant(fixture, "expired", [fixture.allowedDesignId]);
    application.database.sqlite.prepare(
      "UPDATE agent_grants SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
    ).run(expiredGrant.grant.id);
    const expired = captureDomainError(() => application.designSystems.readUpgradePreview(
      expiredGrant.grant.actorId,
      fixture.allowedPreview.id,
    ));
    expect(expired).toMatchObject({ code: "AUTH_REQUIRED", statusCode: 401 });

    application.database.sqlite.prepare(
      "UPDATE design_system_upgrade_previews SET status = 'ready', expires_at = '2999-01-01T00:00:00.000Z', created_by = ? WHERE id = ?",
    ).run(expiredGrant.connection.principalId, fixture.restrictedPreview.id);
    application.database.sqlite.prepare(
      "UPDATE agent_grants SET expires_at = '2999-01-01T00:00:00.000Z' WHERE id = ?",
    ).run(expiredGrant.grant.id);
    application.database.sqlite.prepare(
      "UPDATE memberships SET role = 'organization_admin' WHERE organization_id = 'organization_legacy' AND principal_id = ?",
    ).run(expiredGrant.connection.principalId);
    const beforeRestrictedCommit = domainState(application, [fixture.allowedDesignId, fixture.restrictedDesignId]);
    const restrictedCommit = captureDomainError(() => application.designSystems.commitProjectUpgrade(
      expiredGrant.grant.actorId,
      {
        previewId: fixture.restrictedPreview.id,
        expectedPreviewHash: fixture.restrictedPreview.previewHash,
      },
    ));
    expect(restrictedCommit).toMatchObject({ code: "NOT_FOUND", statusCode: 404, message: "Design not found." });
    expect(JSON.stringify(restrictedCommit.toJSON())).not.toContain(RESTRICTED_PROJECT_MARKER);
    expect(domainState(application, [fixture.allowedDesignId, fixture.restrictedDesignId])).toEqual(beforeRestrictedCommit);
  });

  it("commits once through the authenticated HTTP route and preserves the exact committed state across restart", async () => {
    const fixture = await createFixture();
    const before = domainState(fixture.application, [fixture.allowedDesignId, fixture.restrictedDesignId]);
    const committed = await fixture.application.app.inject({
      method: "POST",
      url: `/api/design-system-upgrade-previews/${fixture.allowedPreview.id}/commit`,
      headers: browserHeaders(ADMIN_IDENTITY),
      payload: { expectedPreviewHash: fixture.allowedPreview.previewHash },
    });
    expect(committed.statusCode).toBe(200);
    expect(committed.json()).toMatchObject({
      preview: { id: fixture.allowedPreview.id, status: "committed" },
      pin: {
        designId: fixture.allowedDesignId,
        releaseId: fixture.targetRelease.id,
        releaseVersion: 2,
      },
    });
    const afterCommit = domainState(fixture.application, [fixture.allowedDesignId, fixture.restrictedDesignId]);
    expect(afterCommit.revisions).toEqual(before.revisions);
    expect(afterCommit.pins).not.toEqual(before.pins);

    await fixture.application.app.close();
    applications.splice(applications.indexOf(fixture.application), 1);
    const restarted = await buildApplication(fixture.config);
    applications.push(restarted);
    await restarted.app.ready();
    const beforeReplay = domainState(restarted, [fixture.allowedDesignId, fixture.restrictedDesignId]);

    const replay = await restarted.app.inject({
      method: "POST",
      url: `/api/design-system-upgrade-previews/${fixture.allowedPreview.id}/commit`,
      headers: browserHeaders(ADMIN_IDENTITY),
      payload: { expectedPreviewHash: fixture.allowedPreview.previewHash },
    });
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toMatchObject({ error: { code: "PREVIEW_ALREADY_COMMITTED" } });
    expect(domainState(restarted, [fixture.allowedDesignId, fixture.restrictedDesignId])).toEqual(beforeReplay);
  });
});
