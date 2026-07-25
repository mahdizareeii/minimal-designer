import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { loadConfig } from "./config.js";
import type {
  DesignSystemReleaseResult,
  DesignSystemResult,
  ProjectDesignSystemPinResult,
} from "./design-system-service.js";
import { DomainError } from "./errors.js";
import { moveDesignFixtureToOrganization } from "../test-fixtures/product.js";

const PROXY_SECRET = "design-system-release-pin-proxy-secret-0123456789abcdef";
const PUBLIC_ORIGIN = "https://design.example.test";
const ADMIN_IDENTITY = "design-system-release-pin-admin@example.test";
const EDITOR_IDENTITY = "design-system-release-pin-editor@example.test";
const VIEWER_IDENTITY = "design-system-release-pin-viewer@example.test";
const ADMIN_ACTOR = `trusted:${ADMIN_IDENTITY}`;
const FOREIGN_ORGANIZATION_ID = "organization_design_system_release_pin_foreign";
const PRIVATE_MARKER = "DESIGN_SYSTEM_RELEASE_PIN_PRIVATE_5e17c9";
const PRIVATE_PATH = "/Users/private/company/design-system/release-pin.json";
const PRIVATE_TOKEN = "fsg_design_system_release_pin_private_token_52a91d";

const applications: DesignerApplication[] = [];
const temporaryDirectories: string[] = [];

interface Fixture {
  application: DesignerApplication;
  localSystem: DesignSystemResult;
  release1: DesignSystemReleaseResult;
  release2: DesignSystemReleaseResult;
  foreignSystem: DesignSystemResult;
  foreignRelease: DesignSystemReleaseResult;
  pinnedDesignId: string;
  unpinnedDesignId: string;
  foreignDesignId: string;
  foreignReleasePinDesignId: string;
  swappedReleasePinDesignId: string;
  projectScopedGrantActorId: string;
  projectScopedGrantToken: string;
  unrestrictedGrantActorId: string;
  missingScopeGrantActorId: string;
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

function createRelease(
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

async function createFixture(label: string): Promise<Fixture> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `formaspec-design-system-release-pin-${label}-`));
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
    DESIGNER_TOKEN: "design-system-release-pin-bootstrap-token-0001",
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
    { claim: "identity", value: EDITOR_IDENTITY, role: "design_editor" },
    { claim: "identity", value: VIEWER_IDENTITY, role: "viewer" },
  ];
  application.policies.update(ADMIN_ACTOR, {
    expectedConfigurationHash: current.configurationHash,
    policy,
  });
  await warmIdentity(application, EDITOR_IDENTITY);
  await warmIdentity(application, VIEWER_IDENTITY);

  const localSystem = application.designSystems.createDesignSystem(ADMIN_ACTOR, {
    name: `Local release catalog ${label}`,
  });
  const release1 = createRelease(application, localSystem.id, 0, "Local release 1");
  const release2 = createRelease(application, localSystem.id, 1, "Local release 2");
  const foreignSystem = application.designSystems.createDesignSystem(ADMIN_ACTOR, {
    name: PRIVATE_MARKER,
    description: `${PRIVATE_PATH}\n${PRIVATE_TOKEN}`,
  });
  const foreignRelease = createRelease(application, foreignSystem.id, 0, PRIVATE_MARKER);

  const pinned = application.service.createDesign(ADMIN_ACTOR, {
    name: `Pinned release project ${label}`,
    preset: "web",
    idempotencyKey: `release-pin-pinned-${label}-0001`,
  });
  const unpinned = application.service.createDesign(ADMIN_ACTOR, {
    name: `Unpinned release project ${label}`,
    preset: "phone",
    idempotencyKey: `release-pin-unpinned-${label}-0001`,
  });
  const foreign = application.service.createDesign(ADMIN_ACTOR, {
    name: PRIVATE_MARKER,
    preset: "tablet",
    idempotencyKey: `release-pin-foreign-${label}-0001`,
  });
  const foreignReleasePin = application.service.createDesign(ADMIN_ACTOR, {
    name: `Foreign release pin integrity ${label}`,
    preset: "web",
    idempotencyKey: `release-pin-foreign-integrity-${label}-0001`,
  });
  const swappedReleasePin = application.service.createDesign(ADMIN_ACTOR, {
    name: `Swapped release pin integrity ${label}`,
    preset: "web",
    idempotencyKey: `release-pin-swapped-integrity-${label}-0001`,
  });
  for (const designId of [
    pinned.document.id,
    foreignReleasePin.document.id,
    swappedReleasePin.document.id,
  ]) {
    application.designSystems.pinProject(ADMIN_ACTOR, {
      designId,
      releaseId: release1.id,
      expectedCurrentReleaseId: null,
    });
  }

  const now = new Date().toISOString();
  application.database.sqlite.prepare(
    `INSERT INTO organizations (id, name, config_json, created_at, updated_at)
     VALUES (?, 'Foreign release and pin organization', '{}', ?, ?)`,
  ).run(FOREIGN_ORGANIZATION_ID, now, now);
  application.database.sqlite.prepare(
    "UPDATE design_systems SET organization_id = ? WHERE id = ?",
  ).run(FOREIGN_ORGANIZATION_ID, foreignSystem.id);
  moveDesignFixtureToOrganization(application.database.sqlite, {
    designId: foreign.document.id,
    organizationId: FOREIGN_ORGANIZATION_ID,
  });
  application.database.sqlite.prepare(
    "UPDATE project_design_system_pins SET release_id = ? WHERE design_id = ?",
  ).run(foreignRelease.id, foreignReleasePin.document.id);
  application.database.sqlite.prepare(
    "UPDATE project_design_system_pins SET release_id = ? WHERE design_id = ?",
  ).run(release2.id, swappedReleasePin.document.id);

  const projectScoped = application.enterprise.createAgentConnection(ADMIN_ACTOR, {
    adapter: "codex",
    displayName: `Project-scoped release pin ${label}`,
    scopes: ["design_system:read"],
    projectIds: [pinned.document.id],
    expiresInSeconds: 3_600,
  });
  const unrestricted = application.enterprise.createAgentConnection(ADMIN_ACTOR, {
    adapter: "codex",
    displayName: `Organization release reader ${label}`,
    scopes: ["design_system:read"],
    projectIds: [],
    expiresInSeconds: 3_600,
  });
  const missingScope = application.enterprise.createAgentConnection(ADMIN_ACTOR, {
    adapter: "codex",
    displayName: `Missing release scope ${label}`,
    scopes: ["design:read"],
    projectIds: [pinned.document.id],
    expiresInSeconds: 3_600,
  });
  const pairedProjectScoped = application.enterprise.pairAgentConnection(projectScoped.nonce);
  const pairedUnrestricted = application.enterprise.pairAgentConnection(unrestricted.nonce);
  const pairedMissingScope = application.enterprise.pairAgentConnection(missingScope.nonce);

  return {
    application,
    localSystem,
    release1,
    release2,
    foreignSystem,
    foreignRelease,
    pinnedDesignId: pinned.document.id,
    unpinnedDesignId: unpinned.document.id,
    foreignDesignId: foreign.document.id,
    foreignReleasePinDesignId: foreignReleasePin.document.id,
    swappedReleasePinDesignId: swappedReleasePin.document.id,
    projectScopedGrantActorId: pairedProjectScoped.grant.actorId,
    projectScopedGrantToken: pairedProjectScoped.grant.token,
    unrestrictedGrantActorId: pairedUnrestricted.grant.actorId,
    missingScopeGrantActorId: pairedMissingScope.grant.actorId,
  };
}

function releasePinState(application: DesignerApplication): unknown {
  return {
    releases: application.database.sqlite.prepare(
      `SELECT id, design_system_id, version, name, status, release_json, created_by, created_at, published_at
       FROM design_system_releases ORDER BY id`,
    ).all(),
    pins: application.database.sqlite.prepare(
      `SELECT design_id, organization_id, design_system_id, release_id, release_version, pinned_by, pinned_at
       FROM project_design_system_pins ORDER BY design_id`,
    ).all(),
    designs: application.database.sqlite.prepare(
      `SELECT id, organization_id, current_version, current_revision_id, updated_at
       FROM designs ORDER BY id`,
    ).all(),
    revisions: application.database.sqlite.prepare(
      `SELECT id, design_id, version, parent_revision_id, snapshot_hash, operation_hash,
              parent_revision_hash, revision_hash, message, created_at
       FROM revisions ORDER BY design_id, version`,
    ).all(),
    snapshots: application.database.sqlite.prepare(
      `SELECT snapshot_hash, encoding, uncompressed_bytes, created_at
       FROM snapshots ORDER BY snapshot_hash`,
    ).all(),
    audits: application.database.sqlite.prepare(
      `SELECT id, organization_id, actor_id, action, target_type, target_id, details_json
       FROM audit_events ORDER BY id`,
    ).all(),
    outbox: application.database.sqlite.prepare(
      `SELECT id, organization_id, actor_id, event_type, payload_json, workspace, created_at, published_at
       FROM event_outbox ORDER BY id`,
    ).all(),
    grants: application.database.sqlite.prepare(
      `SELECT id, organization_id, principal_id, scopes_json, project_ids_json,
              expires_at, revoked_at, last_used_at
       FROM agent_grants ORDER BY id`,
    ).all(),
    connections: application.database.sqlite.prepare(
      `SELECT id, organization_id, principal_id, status, expires_at, last_used_at, updated_at
       FROM agent_connections ORDER BY id`,
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

describe("design-system release and project-pin HTTP authorization", () => {
  it("authorizes before parsing and lookup while keeping foreign and inconsistent releases opaque without side effects", async () => {
    const fixture = await createFixture("denied");
    const {
      application,
      localSystem,
      release1,
      release2,
      foreignSystem,
      foreignRelease,
      pinnedDesignId,
      unpinnedDesignId,
      foreignDesignId,
      foreignReleasePinDesignId,
      swappedReleasePinDesignId,
      projectScopedGrantActorId,
      projectScopedGrantToken,
      missingScopeGrantActorId,
    } = fixture;
    const malformedSegment = encodeURIComponent(" ");
    const hidden = [
      foreignSystem.id,
      foreignRelease.id,
      foreignDesignId,
      PRIVATE_MARKER,
      PRIVATE_PATH,
      PRIVATE_TOKEN,
    ];
    const invalidReleaseBody = {
      expectedLatestVersion: -1,
      name: "",
      status: PRIVATE_MARKER,
      tokenVersions: [{ tokenId: PRIVATE_TOKEN, version: 0 }],
      componentVersions: [{ componentDefinitionId: PRIVATE_PATH, version: 0 }],
      privateMarker: PRIVATE_MARKER,
    };
    const invalidPinBody = {
      releaseId: PRIVATE_TOKEN,
      expectedCurrentReleaseId: PRIVATE_PATH,
      privateMarker: PRIVATE_MARKER,
    };
    const before = releasePinState(application);

    const scopedBearerDenied = await Promise.all([
      application.app.inject({
        method: "GET",
        url: `/api/design-systems/${malformedSegment}/releases?privateMarker=${encodeURIComponent(PRIVATE_MARKER)}`,
        headers: grantHeaders(projectScopedGrantToken),
      }),
      application.app.inject({
        method: "POST",
        url: `/api/design-systems/${malformedSegment}/releases`,
        headers: grantHeaders(projectScopedGrantToken),
        payload: invalidReleaseBody,
      }),
      application.app.inject({
        method: "GET",
        url: `/api/designs/${malformedSegment}/design-system-pin?privateMarker=${encodeURIComponent(PRIVATE_MARKER)}`,
        headers: grantHeaders(projectScopedGrantToken),
      }),
      application.app.inject({
        method: "PUT",
        url: `/api/designs/${malformedSegment}/design-system-pin`,
        headers: grantHeaders(projectScopedGrantToken),
        payload: invalidPinBody,
      }),
    ]);
    for (const response of scopedBearerDenied) expectError(response, 401, "AUTH_REQUIRED", hidden);

    const roleDenied = await Promise.all([
      application.app.inject({
        method: "POST",
        url: `/api/design-systems/${malformedSegment}/releases`,
        headers: serverHeaders(VIEWER_IDENTITY),
        payload: invalidReleaseBody,
      }),
      application.app.inject({
        method: "POST",
        url: `/api/design-systems/${malformedSegment}/releases`,
        headers: serverHeaders(EDITOR_IDENTITY),
        payload: invalidReleaseBody,
      }),
      application.app.inject({
        method: "PUT",
        url: `/api/designs/${malformedSegment}/design-system-pin`,
        headers: serverHeaders(VIEWER_IDENTITY),
        payload: invalidPinBody,
      }),
      application.app.inject({
        method: "PUT",
        url: `/api/designs/${malformedSegment}/design-system-pin`,
        headers: serverHeaders(EDITOR_IDENTITY),
        payload: invalidPinBody,
      }),
    ]);
    for (const response of roleDenied) expectError(response, 403, "FORBIDDEN", hidden);

    const projectOpacityDenied = await Promise.all([
      application.app.inject({
        method: "GET",
        url: `/api/designs/${malformedSegment}/design-system-pin?privateMarker=${encodeURIComponent(PRIVATE_MARKER)}`,
        headers: serverHeaders(VIEWER_IDENTITY),
      }),
      application.app.inject({
        method: "PUT",
        url: `/api/designs/${malformedSegment}/design-system-pin`,
        headers: serverHeaders(ADMIN_IDENTITY),
        payload: invalidPinBody,
      }),
    ]);
    for (const response of projectOpacityDenied) expectError(response, 404, "NOT_FOUND", hidden);

    for (const callback of [
      () => application.designSystems.listReleases(projectScopedGrantActorId, " "),
      () => application.designSystems.createRelease(projectScopedGrantActorId, " ", {
        expectedLatestVersion: -1,
        name: PRIVATE_MARKER,
        status: "draft",
        tokenVersions: [],
        componentVersions: [],
      }),
      () => application.designSystems.pinProject(projectScopedGrantActorId, {
        designId: " ",
        releaseId: PRIVATE_TOKEN,
        expectedCurrentReleaseId: PRIVATE_PATH,
      }),
      () => application.designSystems.listReleases(missingScopeGrantActorId, " "),
      () => application.designSystems.readProjectPin(missingScopeGrantActorId, " "),
    ]) {
      const error = captureDomainError(callback);
      expect(error).toMatchObject({ statusCode: 403, code: "FORBIDDEN" });
      for (const value of hidden) expect(JSON.stringify(error.toJSON())).not.toContain(value);
    }

    const foreignDenied = await Promise.all([
      application.app.inject({
        method: "GET",
        url: `/api/design-systems/${foreignSystem.id}/releases`,
        headers: serverHeaders(VIEWER_IDENTITY),
      }),
      application.app.inject({
        method: "POST",
        url: `/api/design-systems/${foreignSystem.id}/releases`,
        headers: serverHeaders(ADMIN_IDENTITY),
        payload: {
          expectedLatestVersion: 1,
          name: "Foreign mutation attempt",
          status: "draft",
          tokenVersions: [],
          componentVersions: [],
        },
      }),
      application.app.inject({
        method: "GET",
        url: `/api/designs/${foreignDesignId}/design-system-pin?privateMarker=${encodeURIComponent(PRIVATE_MARKER)}`,
        headers: serverHeaders(VIEWER_IDENTITY),
      }),
      application.app.inject({
        method: "PUT",
        url: `/api/designs/${foreignDesignId}/design-system-pin`,
        headers: serverHeaders(ADMIN_IDENTITY),
        payload: invalidPinBody,
      }),
      application.app.inject({
        method: "PUT",
        url: `/api/designs/${unpinnedDesignId}/design-system-pin`,
        headers: serverHeaders(ADMIN_IDENTITY),
        payload: { releaseId: foreignRelease.id, expectedCurrentReleaseId: null },
      }),
      application.app.inject({
        method: "PUT",
        url: `/api/designs/${unpinnedDesignId}/design-system-pin`,
        headers: serverHeaders(ADMIN_IDENTITY),
        payload: { releaseId: release1.id, expectedCurrentReleaseId: foreignRelease.id },
      }),
    ]);
    for (const response of foreignDenied) expectError(response, 404, "NOT_FOUND", hidden);

    const foreignPin = await application.app.inject({
      method: "GET",
      url: `/api/designs/${foreignReleasePinDesignId}/design-system-pin`,
      headers: serverHeaders(VIEWER_IDENTITY),
    });
    expectError(foreignPin, 500, "INTERNAL_ERROR", hidden);
    const swappedPin = await application.app.inject({
      method: "GET",
      url: `/api/designs/${swappedReleasePinDesignId}/design-system-pin`,
      headers: serverHeaders(VIEWER_IDENTITY),
    });
    expectError(swappedPin, 500, "INTERNAL_ERROR", hidden);

    const corruptPinWrite = await application.app.inject({
      method: "PUT",
      url: `/api/designs/${foreignReleasePinDesignId}/design-system-pin`,
      headers: serverHeaders(ADMIN_IDENTITY),
      payload: { releaseId: release1.id, expectedCurrentReleaseId: null },
    });
    expectError(corruptPinWrite, 500, "INTERNAL_ERROR", hidden);

    const swappedFields = await application.app.inject({
      method: "PUT",
      url: `/api/designs/${pinnedDesignId}/design-system-pin`,
      headers: serverHeaders(ADMIN_IDENTITY),
      payload: { releaseId: release1.id, expectedCurrentReleaseId: release2.id },
    });
    expectError(swappedFields, 409, "VERSION_CONFLICT", hidden);
    const upgradeBypass = await application.app.inject({
      method: "PUT",
      url: `/api/designs/${pinnedDesignId}/design-system-pin`,
      headers: serverHeaders(ADMIN_IDENTITY),
      payload: { releaseId: release2.id, expectedCurrentReleaseId: release1.id },
    });
    expectError(upgradeBypass, 422, "PREVIEW_NOT_COMMITTABLE", hidden);

    expect(releasePinState(application)).toEqual(before);
  });

  it("preserves human catalog reads, administrator release and pin writes, and scoped-agent project reads", async () => {
    const {
      application,
      localSystem,
      release1,
      release2,
      foreignSystem,
      foreignRelease,
      pinnedDesignId,
      unpinnedDesignId,
      projectScopedGrantActorId,
      unrestrictedGrantActorId,
    } = await createFixture("allowed");
    const hidden = [foreignSystem.id, foreignRelease.id, PRIVATE_MARKER, PRIVATE_PATH, PRIVATE_TOKEN];

    for (const identity of [ADMIN_IDENTITY, EDITOR_IDENTITY, VIEWER_IDENTITY]) {
      const releases = await application.app.inject({
        method: "GET",
        url: `/api/design-systems/${localSystem.id}/releases`,
        headers: serverHeaders(identity),
      });
      expect(releases.statusCode, releases.body).toBe(200);
      expect(releases.json<{ releases: DesignSystemReleaseResult[] }>().releases.map((release) => release.id))
        .toEqual([release2.id, release1.id]);
      for (const value of hidden) expect(releases.body).not.toContain(value);

      const pin = await application.app.inject({
        method: "GET",
        url: `/api/designs/${pinnedDesignId}/design-system-pin`,
        headers: serverHeaders(identity),
      });
      expect(pin.statusCode, pin.body).toBe(200);
      expect(pin.json<{ pin: ProjectDesignSystemPinResult }>().pin).toMatchObject({
        designId: pinnedDesignId,
        designSystemId: localSystem.id,
        releaseId: release1.id,
        releaseVersion: 1,
      });
      for (const value of hidden) expect(pin.body).not.toContain(value);
    }

    const createdRelease = await application.app.inject({
      method: "POST",
      url: `/api/design-systems/${localSystem.id}/releases`,
      headers: serverHeaders(ADMIN_IDENTITY),
      payload: {
        expectedLatestVersion: 2,
        name: "Administrator draft release 3",
        status: "draft",
        tokenVersions: [],
        componentVersions: [],
      },
    });
    expect(createdRelease.statusCode, createdRelease.body).toBe(201);
    expect(createdRelease.json<{ release: DesignSystemReleaseResult }>().release).toMatchObject({
      designSystemId: localSystem.id,
      version: 3,
      status: "draft",
    });

    const createdPin = await application.app.inject({
      method: "PUT",
      url: `/api/designs/${unpinnedDesignId}/design-system-pin`,
      headers: serverHeaders(ADMIN_IDENTITY),
      payload: { releaseId: release1.id, expectedCurrentReleaseId: null },
    });
    expect(createdPin.statusCode, createdPin.body).toBe(200);
    expect(createdPin.json<{ pin: ProjectDesignSystemPinResult }>().pin).toMatchObject({
      designId: unpinnedDesignId,
      designSystemId: localSystem.id,
      releaseId: release1.id,
      releaseVersion: 1,
    });

    expect(application.designSystems.listReleases(unrestrictedGrantActorId, localSystem.id).map((release) => release.version))
      .toEqual([3, 2, 1]);
    expect(application.designSystems.readProjectPin(projectScopedGrantActorId, pinnedDesignId)).toMatchObject({
      designId: pinnedDesignId,
      releaseId: release1.id,
    });
    expect(application.designSystems.readProjectPin(unrestrictedGrantActorId, unpinnedDesignId)).toMatchObject({
      designId: unpinnedDesignId,
      releaseId: release1.id,
    });
    const restrictedProject = captureDomainError(() =>
      application.designSystems.readProjectPin(projectScopedGrantActorId, unpinnedDesignId));
    expect(restrictedProject).toMatchObject({ statusCode: 404, code: "NOT_FOUND" });
    for (const value of hidden) expect(JSON.stringify(restrictedProject.toJSON())).not.toContain(value);

    const viewerPin = await application.app.inject({
      method: "GET",
      url: `/api/designs/${unpinnedDesignId}/design-system-pin`,
      headers: serverHeaders(VIEWER_IDENTITY),
    });
    expect(viewerPin.statusCode, viewerPin.body).toBe(200);
    expect(viewerPin.json<{ pin: ProjectDesignSystemPinResult }>().pin.releaseId).toBe(release1.id);
    for (const value of hidden) expect(viewerPin.body).not.toContain(value);
  });
});
