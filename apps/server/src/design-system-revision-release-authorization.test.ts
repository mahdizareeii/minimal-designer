import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { loadConfig } from "./config.js";
import type {
  DesignSystemReleaseResult,
  RevisionDesignSystemReleaseResult,
} from "./design-system-service.js";
import { DomainError } from "./errors.js";
import { moveDesignFixtureToOrganization } from "../test-fixtures/product.js";

const PROXY_SECRET = "revision-release-proxy-secret-0123456789abcdef";
const PUBLIC_ORIGIN = "https://design.example.test";
const ADMIN_IDENTITY = "revision-release-admin@example.test";
const VIEWER_IDENTITY = "revision-release-viewer@example.test";
const ADMIN_ACTOR = `trusted:${ADMIN_IDENTITY}`;
const FOREIGN_ORGANIZATION_ID = "organization_revision_release_foreign";
const PRIVATE_MARKER = "REVISION_RELEASE_PRIVATE_8d31f4";
const PRIVATE_PATH = "/Users/private/company/historical-release.json";
const PRIVATE_TOKEN = "fsg_revision_release_private_token_7d191a";

const applications: DesignerApplication[] = [];
const temporaryDirectories: string[] = [];

interface Fixture {
  application: DesignerApplication;
  allowedDesignId: string;
  deniedDesignId: string;
  foreignDesignId: string;
  historicalRevisionId: string;
  currentRevisionId: string;
  deniedRevisionId: string;
  foreignRevisionId: string;
  release1: DesignSystemReleaseResult;
  release2: DesignSystemReleaseResult;
}

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.promises.rm(directory, { recursive: true, force: true })));
});

function serverHeaders(identity?: string): Record<string, string> {
  return {
    host: "design.example.test",
    origin: PUBLIC_ORIGIN,
    "x-formaspec-csrf": "1",
    "x-formaspec-proxy-secret": PROXY_SECRET,
    ...(identity === undefined ? {} : { "x-designer-user": identity }),
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

function seedVerifiedMigrationBackup(
  application: DesignerApplication,
  id: string,
  createdAt: string,
): void {
  const manifest = {
    format: "formaspec-backup",
    formatVersion: 2,
    createdAt,
    databaseSchemaVersion: application.database.schemaVersion(),
  };
  const verification = {
    valid: true,
    manifest,
    sqliteIntegrity: "ok",
    foreignKeyViolations: 0,
    extractedBytes: 1,
    entryCount: 1,
  };
  application.database.sqlite.prepare(
    `INSERT INTO backup_records
     (id, organization_id, filename, bundle_sha256, status, manifest_json, created_by, created_at, verified_at,
      size_bytes, verification_json, retention_class, completed_at)
     VALUES (?, 'organization_legacy', 'revision-release-v2-gate.tar', ?, 'valid', ?, 'principal_local', ?, ?, 1, ?, 'manual', ?)`,
  ).run(id, "a".repeat(64), JSON.stringify(manifest), createdAt, createdAt, JSON.stringify(verification), createdAt);
}

function createAgentGrant(
  fixture: Fixture,
  label: string,
  scopes: string[],
): ReturnType<DesignerApplication["enterprise"]["pairAgentConnection"]> {
  const challenge = fixture.application.enterprise.createAgentConnection(ADMIN_ACTOR, {
    adapter: "codex",
    displayName: `Revision release ${label}`,
    scopes,
    projectIds: [fixture.allowedDesignId],
    expiresInSeconds: 3_600,
  });
  return fixture.application.enterprise.pairAgentConnection(challenge.nonce);
}

function mcpTool(
  fixture: Fixture,
  token: string,
  name: string,
  args: Record<string, unknown>,
) {
  return fixture.application.app.inject({
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

function captureDomainError(callback: () => unknown): DomainError {
  try {
    callback();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error("Expected a DomainError.");
}

async function createFixture(): Promise<Fixture> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "formaspec-revision-release-auth-"));
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
    DESIGNER_TOKEN: "revision-release-bootstrap-token-0001",
    FORMASPEC_TRUSTED_PROXIES: "127.0.0.1",
    FORMASPEC_PROXY_SECRET: PROXY_SECRET,
    DESIGNER_CORS_ORIGINS: PUBLIC_ORIGIN,
    DESIGNER_LOG_LEVEL: "silent",
  }));
  applications.push(application);
  await application.app.ready();

  await warmIdentity(application, ADMIN_IDENTITY);
  const currentPolicy = application.policies.read(ADMIN_ACTOR);
  const policy = structuredClone(currentPolicy.policy);
  policy.identity.roleMappings = [
    { claim: "identity", value: ADMIN_IDENTITY, role: "organization_admin" },
    { claim: "identity", value: VIEWER_IDENTITY, role: "viewer" },
  ];
  application.policies.update(ADMIN_ACTOR, {
    expectedConfigurationHash: currentPolicy.configurationHash,
    policy,
  });
  await warmIdentity(application, VIEWER_IDENTITY);

  const allowed = application.service.createDesign(ADMIN_ACTOR, {
    name: "Historical release project",
    preset: "web",
    idempotencyKey: "revision-release-allowed-0001",
  });
  const denied = application.service.createDesign(ADMIN_ACTOR, {
    name: PRIVATE_MARKER,
    preset: "phone",
    idempotencyKey: "revision-release-denied-0001",
  });
  const foreign = application.service.createDesign(ADMIN_ACTOR, {
    name: `${PRIVATE_MARKER} foreign`,
    preset: "tablet",
    idempotencyKey: "revision-release-foreign-0001",
  });

  const system = application.designSystems.createDesignSystem(ADMIN_ACTOR, {
    name: "Revision-bound product system",
    description: "Exact historical release fixture.",
  });
  const release1 = application.designSystems.createRelease(ADMIN_ACTOR, system.id, {
    expectedLatestVersion: 0,
    name: "Historical release 1",
    status: "published",
    tokenVersions: [],
    componentVersions: [],
  });
  const release2 = application.designSystems.createRelease(ADMIN_ACTOR, system.id, {
    expectedLatestVersion: 1,
    name: "Current release 2",
    status: "published",
    tokenVersions: [],
    componentVersions: [],
  });

  const backupId = "backup_revisionreleasev2gate01";
  seedVerifiedMigrationBackup(application, backupId, allowed.design.updatedAt);
  application.service.migrateDesignHeadToV2(ADMIN_ACTOR, allowed.design.id, {
    expectedBaseVersion: 1,
    backupId,
    idempotencyKey: "revision-release-v2-migration-0001",
  });
  application.designSystems.pinProject(ADMIN_ACTOR, {
    designId: allowed.design.id,
    releaseId: release1.id,
    expectedCurrentReleaseId: null,
  });
  const historical = application.service.getDesign(ADMIN_ACTOR, allowed.design.id);
  const preview = application.designSystems.previewProjectUpgrade(ADMIN_ACTOR, {
    designId: allowed.design.id,
    targetReleaseId: release2.id,
  });
  application.designSystems.commitProjectUpgrade(ADMIN_ACTOR, {
    previewId: preview.id,
    expectedPreviewHash: preview.previewHash,
  });
  const current = application.service.getDesign(ADMIN_ACTOR, allowed.design.id);

  const now = new Date().toISOString();
  application.database.sqlite.prepare(
    `INSERT INTO organizations (id, name, config_json, created_at, updated_at)
     VALUES (?, 'Foreign revision release organization', '{}', ?, ?)`,
  ).run(FOREIGN_ORGANIZATION_ID, now, now);
  moveDesignFixtureToOrganization(application.database.sqlite, {
    designId: foreign.design.id,
    organizationId: FOREIGN_ORGANIZATION_ID,
  });

  return {
    application,
    allowedDesignId: allowed.design.id,
    deniedDesignId: denied.design.id,
    foreignDesignId: foreign.design.id,
    historicalRevisionId: historical.revision.id,
    currentRevisionId: current.revision.id,
    deniedRevisionId: denied.revision.id,
    foreignRevisionId: foreign.revision.id,
    release1,
    release2,
  };
}

describe("revision-bound historical design-system release authorization", () => {
  it("reads current and past pins through the project-bound HTTP route while keeping swapped and foreign IDs opaque", async () => {
    const fixture = await createFixture();
    const hidden = [
      fixture.deniedDesignId,
      fixture.foreignDesignId,
      fixture.deniedRevisionId,
      fixture.foreignRevisionId,
      PRIVATE_MARKER,
      PRIVATE_PATH,
      PRIVATE_TOKEN,
    ];

    const unauthenticated = await fixture.application.app.inject({
      method: "GET",
      url: `/api/projects/${encodeURIComponent(PRIVATE_PATH)}/revisions/${encodeURIComponent(PRIVATE_TOKEN)}/design-system-release?private=${encodeURIComponent(PRIVATE_MARKER)}`,
      headers: serverHeaders(),
    });
    expect(unauthenticated.statusCode, unauthenticated.body).toBe(401);
    expect(unauthenticated.json()).toMatchObject({ error: { code: "AUTH_REQUIRED" } });

    for (const [revisionId, release] of [
      [fixture.historicalRevisionId, fixture.release1],
      [fixture.currentRevisionId, fixture.release2],
    ] as const) {
      const response = await fixture.application.app.inject({
        method: "GET",
        url: `/api/projects/${fixture.allowedDesignId}/revisions/${revisionId}/design-system-release`,
        headers: serverHeaders(VIEWER_IDENTITY),
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json<{ revisionRelease: RevisionDesignSystemReleaseResult }>().revisionRelease)
        .toMatchObject({
          designId: fixture.allowedDesignId,
          revisionId,
          schemaVersion: 2,
          pin: {
            designSystemId: release.designSystemId,
            releaseId: release.id,
            releaseVersion: release.version,
          },
          release: { id: release.id, version: release.version },
        });
      for (const value of hidden) expect(response.body).not.toContain(value);
    }

    for (const [projectId, revisionId] of [
      [fixture.allowedDesignId, fixture.deniedRevisionId],
      [fixture.allowedDesignId, fixture.foreignRevisionId],
      [fixture.foreignDesignId, fixture.foreignRevisionId],
    ]) {
      const response = await fixture.application.app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/revisions/${revisionId}/design-system-release`,
        headers: serverHeaders(VIEWER_IDENTITY),
      });
      expect(response.statusCode, response.body).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
      for (const value of hidden) expect(response.body).not.toContain(value);
    }
  });

  it("lets a project-scoped agent read exact historical releases without exposing the organization catalog and rechecks revocation or expiry", async () => {
    const fixture = await createFixture();
    const allowed = createAgentGrant(fixture, "allowed", ["design_system:read"]);

    expect(fixture.application.designSystems.readRevisionRelease(
      allowed.grant.actorId,
      fixture.allowedDesignId,
      fixture.historicalRevisionId,
    )).toMatchObject({ release: { id: fixture.release1.id } });
    expect(fixture.application.designSystems.readRevisionRelease(
      allowed.grant.actorId,
      fixture.allowedDesignId,
      fixture.currentRevisionId,
    )).toMatchObject({ release: { id: fixture.release2.id } });

    for (const callback of [
      () => fixture.application.designSystems.readRelease(allowed.grant.actorId, fixture.release1.id),
      () => fixture.application.designSystems.listDesignSystems(allowed.grant.actorId),
      () => fixture.application.designSystems.listReleases(allowed.grant.actorId, fixture.release1.designSystemId),
      () => fixture.application.designSystems.readRevisionRelease(
        allowed.grant.actorId,
        fixture.deniedDesignId,
        fixture.deniedRevisionId,
      ),
      () => fixture.application.designSystems.readRevisionRelease(
        allowed.grant.actorId,
        fixture.allowedDesignId,
        fixture.deniedRevisionId,
      ),
      () => fixture.application.designSystems.readRevisionRelease(
        allowed.grant.actorId,
        fixture.foreignDesignId,
        fixture.foreignRevisionId,
      ),
    ]) {
      const error = captureDomainError(callback);
      expect(["FORBIDDEN", "NOT_FOUND"]).toContain(error.code);
      const serialized = JSON.stringify(error.toJSON());
      for (const value of [PRIVATE_MARKER, PRIVATE_PATH, PRIVATE_TOKEN]) expect(serialized).not.toContain(value);
    }

    const mcp = await mcpTool(fixture, allowed.grant.token, "design_system_revision_release_read", {
      design_id: fixture.allowedDesignId,
      revision_id: fixture.historicalRevisionId,
    });
    expect(mcp.statusCode, mcp.body).toBe(200);
    expect(mcp.json<{
      result: { structuredContent: { ok: boolean; revisionRelease: RevisionDesignSystemReleaseResult } };
    }>().result.structuredContent).toMatchObject({
      ok: true,
      revisionRelease: {
        designId: fixture.allowedDesignId,
        revisionId: fixture.historicalRevisionId,
        release: { id: fixture.release1.id },
      },
    });

    fixture.application.enterprise.revokeAgentConnection(ADMIN_ACTOR, allowed.connection.id);
    expect(captureDomainError(() => fixture.application.designSystems.readRevisionRelease(
      allowed.grant.actorId,
      fixture.allowedDesignId,
      fixture.historicalRevisionId,
    ))).toMatchObject({ code: "AUTH_REQUIRED", statusCode: 401 });

    const expired = createAgentGrant(fixture, "expired", ["design_system:read"]);
    fixture.application.database.sqlite.prepare(
      "UPDATE agent_grants SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
    ).run(expired.grant.id);
    expect(captureDomainError(() => fixture.application.designSystems.readRevisionRelease(
      expired.grant.actorId,
      fixture.allowedDesignId,
      fixture.currentRevisionId,
    ))).toMatchObject({ code: "AUTH_REQUIRED", statusCode: 401 });

    const missingScope = createAgentGrant(fixture, "missing-scope", ["design:read"]);
    expect(captureDomainError(() => fixture.application.designSystems.readRevisionRelease(
      missingScope.grant.actorId,
      fixture.allowedDesignId,
      fixture.currentRevisionId,
    ))).toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
  });
});
