import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { loadConfig } from "./config.js";
import type { DesignSystemResult } from "./design-system-service.js";
import { DomainError } from "./errors.js";

const PROXY_SECRET = "design-system-catalog-proxy-secret-0123456789abcdef";
const PUBLIC_ORIGIN = "https://design.example.test";
const ADMIN_IDENTITY = "design-system-catalog-admin@example.test";
const ENGINEER_IDENTITY = "design-system-catalog-engineer@example.test";
const VIEWER_IDENTITY = "design-system-catalog-viewer@example.test";
const ADMIN_ACTOR = `trusted:${ADMIN_IDENTITY}`;
const FOREIGN_ORGANIZATION_ID = "organization_design_system_catalog_foreign";
const PRIVATE_MARKER = "DESIGN_SYSTEM_CATALOG_PRIVATE_7a91c4";
const PRIVATE_PATH = "/Users/private/company/design-system/catalog.json";
const PRIVATE_TOKEN = "fsg_design_system_catalog_private_token_4d2a91";

const applications: DesignerApplication[] = [];
const temporaryDirectories: string[] = [];

interface Fixture {
  application: DesignerApplication;
  localSystem: DesignSystemResult;
  foreignSystem: DesignSystemResult;
  projectScopedGrantActorId: string;
  projectScopedGrantToken: string;
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

async function createFixture(label: string): Promise<Fixture> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `formaspec-design-system-catalog-auth-${label}-`));
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
    DESIGNER_TOKEN: "design-system-catalog-bootstrap-token-0001",
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
    { claim: "identity", value: ENGINEER_IDENTITY, role: "engineer" },
    { claim: "identity", value: VIEWER_IDENTITY, role: "viewer" },
  ];
  application.policies.update(ADMIN_ACTOR, {
    expectedConfigurationHash: current.configurationHash,
    policy,
  });
  await warmIdentity(application, ENGINEER_IDENTITY);
  await warmIdentity(application, VIEWER_IDENTITY);

  const localSystem = application.designSystems.createDesignSystem(ADMIN_ACTOR, {
    name: `Local catalog ${label}`,
    description: "Visible only inside the local organization.",
  });
  const foreignSystem = application.designSystems.createDesignSystem(ADMIN_ACTOR, {
    name: PRIVATE_MARKER,
    description: `${PRIVATE_PATH}\n${PRIVATE_TOKEN}`,
  });
  const now = new Date().toISOString();
  application.database.sqlite.prepare(
    `INSERT INTO organizations (id, name, config_json, created_at, updated_at)
     VALUES (?, 'Foreign design-system catalog organization', '{}', ?, ?)`,
  ).run(FOREIGN_ORGANIZATION_ID, now, now);
  application.database.sqlite.prepare(
    "UPDATE design_systems SET organization_id = ? WHERE id = ?",
  ).run(FOREIGN_ORGANIZATION_ID, foreignSystem.id);

  const design = application.service.createDesign(ADMIN_ACTOR, {
    name: `Catalog grant project ${label}`,
    preset: "web",
    idempotencyKey: `design-system-catalog-auth-${label}-0001`,
  });
  const challenge = application.enterprise.createAgentConnection(ADMIN_ACTOR, {
    adapter: "codex",
    displayName: `Project-scoped catalog grant ${label}`,
    scopes: ["design_system:read"],
    projectIds: [design.document.id],
    expiresInSeconds: 3_600,
  });
  const paired = application.enterprise.pairAgentConnection(challenge.nonce);
  return {
    application,
    localSystem,
    foreignSystem,
    projectScopedGrantActorId: paired.grant.actorId,
    projectScopedGrantToken: paired.grant.token,
  };
}

function catalogState(application: DesignerApplication): unknown {
  return {
    systems: application.database.sqlite.prepare(
      `SELECT id, organization_id, name, description, status, created_by, created_at, updated_at
       FROM design_systems ORDER BY id`,
    ).all(),
    audits: application.database.sqlite.prepare(
      `SELECT organization_id, actor_id, action, target_type, target_id, details_json
       FROM audit_events
       WHERE action IN ('design_system.create', 'design_system.update')
       ORDER BY id`,
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

describe("design-system catalog HTTP authorization", () => {
  it("authorizes before query, body, and path parsing on exactly four catalog routes without mutation", async () => {
    const {
      application,
      foreignSystem,
      projectScopedGrantActorId,
      projectScopedGrantToken,
    } = await createFixture("ordering");
    const hidden = [foreignSystem.id, PRIVATE_MARKER, PRIVATE_PATH, PRIVATE_TOKEN];
    const privatePathSegment = encodeURIComponent(PRIVATE_PATH);
    const invalidBody = {
      name: "",
      description: PRIVATE_PATH,
      accessToken: PRIVATE_TOKEN,
      privateMarker: PRIVATE_MARKER,
    };
    const before = catalogState(application);

    const projectGrantDenied = await Promise.all([
      application.app.inject({
        method: "GET",
        url: `/api/design-systems?privateMarker=${PRIVATE_MARKER}`,
        headers: grantHeaders(projectScopedGrantToken),
      }),
      application.app.inject({
        method: "POST",
        url: "/api/design-systems",
        headers: grantHeaders(projectScopedGrantToken),
        payload: invalidBody,
      }),
      application.app.inject({
        method: "GET",
        url: `/api/design-systems/${privatePathSegment}`,
        headers: grantHeaders(projectScopedGrantToken),
      }),
      application.app.inject({
        method: "PATCH",
        url: `/api/design-systems/${privatePathSegment}`,
        headers: grantHeaders(projectScopedGrantToken),
        payload: invalidBody,
      }),
    ]);
    for (const response of projectGrantDenied) expectError(response, 401, "AUTH_REQUIRED", hidden);

    const viewerWriteDenied = await Promise.all([
      application.app.inject({
        method: "POST",
        url: "/api/design-systems",
        headers: serverHeaders(VIEWER_IDENTITY),
        payload: invalidBody,
      }),
      application.app.inject({
        method: "PATCH",
        url: `/api/design-systems/${privatePathSegment}`,
        headers: serverHeaders(VIEWER_IDENTITY),
        payload: invalidBody,
      }),
    ]);
    for (const response of viewerWriteDenied) expectError(response, 403, "FORBIDDEN", hidden);

    for (const callback of [
      () => application.designSystems.listDesignSystems(projectScopedGrantActorId),
      () => application.designSystems.readDesignSystem(projectScopedGrantActorId, foreignSystem.id),
    ]) {
      const error = captureDomainError(callback);
      expect(error).toMatchObject({ statusCode: 403, code: "FORBIDDEN" });
      for (const value of hidden) expect(JSON.stringify(error.toJSON())).not.toContain(value);
    }

    const foreignRead = await application.app.inject({
      method: "GET",
      url: `/api/design-systems/${foreignSystem.id}`,
      headers: serverHeaders(VIEWER_IDENTITY),
    });
    expectError(foreignRead, 404, "NOT_FOUND", hidden);
    const foreignPatch = await application.app.inject({
      method: "PATCH",
      url: `/api/design-systems/${foreignSystem.id}`,
      headers: serverHeaders(ADMIN_IDENTITY),
      payload: { expectedUpdatedAt: foreignSystem.updatedAt, name: "Still foreign" },
    });
    expectError(foreignPatch, 404, "NOT_FOUND", hidden);

    expect(catalogState(application)).toEqual(before);
  });

  it("preserves legitimate catalog reads and administrator creates and updates", async () => {
    const { application, localSystem, foreignSystem } = await createFixture("allowed");
    const hidden = [foreignSystem.id, PRIVATE_MARKER, PRIVATE_PATH, PRIVATE_TOKEN];
    const archivedSystem = application.designSystems.createDesignSystem(ADMIN_ACTOR, {
      name: "Archived local catalog",
      description: "Must stay hidden when includeArchived=false.",
    });
    application.designSystems.updateDesignSystem(ADMIN_ACTOR, archivedSystem.id, {
      expectedUpdatedAt: archivedSystem.updatedAt,
      status: "archived",
    });

    const listed = await application.app.inject({
      method: "GET",
      url: "/api/design-systems?includeArchived=false",
      headers: serverHeaders(VIEWER_IDENTITY),
    });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json<{ designSystems: DesignSystemResult[] }>().designSystems.map((system) => system.id))
      .toEqual([localSystem.id]);
    for (const value of hidden) expect(listed.body).not.toContain(value);

    const read = await application.app.inject({
      method: "GET",
      url: `/api/design-systems/${localSystem.id}`,
      headers: serverHeaders(ENGINEER_IDENTITY),
    });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json<{ designSystem: DesignSystemResult }>().designSystem).toMatchObject({
      id: localSystem.id,
      name: localSystem.name,
      status: "active",
    });

    const created = await application.app.inject({
      method: "POST",
      url: "/api/design-systems",
      headers: serverHeaders(ADMIN_IDENTITY),
      payload: { name: "Administrator-created catalog", description: "Allowed catalog mutation." },
    });
    expect(created.statusCode, created.body).toBe(201);
    const createdSystem = created.json<{ designSystem: DesignSystemResult }>().designSystem;

    const updated = await application.app.inject({
      method: "PATCH",
      url: `/api/design-systems/${createdSystem.id}`,
      headers: serverHeaders(ADMIN_IDENTITY),
      payload: {
        expectedUpdatedAt: createdSystem.updatedAt,
        name: "Administrator-updated catalog",
        status: "archived",
      },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json<{ designSystem: DesignSystemResult }>().designSystem).toMatchObject({
      id: createdSystem.id,
      name: "Administrator-updated catalog",
      status: "archived",
    });
  });
});
