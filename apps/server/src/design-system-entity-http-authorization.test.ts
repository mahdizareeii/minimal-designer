import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { loadConfig } from "./config.js";
import type {
  ComponentDefinitionCatalogResult,
  ComponentDefinitionVersionResult,
  DesignSystemResult,
  DesignSystemTokenVersionResult,
} from "./design-system-service.js";
import { DomainError } from "./errors.js";
import {
  createComponentSourceRevisionFixture,
  type ComponentSourceRevisionFixture,
} from "../test-fixtures/component-source.js";

const PROXY_SECRET = "design-system-entity-proxy-secret-0123456789abcdef";
const PUBLIC_ORIGIN = "https://design.example.test";
const ADMIN_IDENTITY = "design-system-entity-admin@example.test";
const EDITOR_IDENTITY = "design-system-entity-editor@example.test";
const VIEWER_IDENTITY = "design-system-entity-viewer@example.test";
const ADMIN_ACTOR = `trusted:${ADMIN_IDENTITY}`;
const EDITOR_ACTOR = `trusted:${EDITOR_IDENTITY}`;
const FOREIGN_ORGANIZATION_ID = "organization_design_system_entity_foreign";
const LOCAL_COMPONENT_ID = "component_entitylocal0001";
const FOREIGN_COMPONENT_ID = "component_entityforeign0001";
const AUTHORED_COMPONENT_ID = "component_entityauthored0001";
const PRIVATE_MARKER = "DESIGN_SYSTEM_ENTITY_PRIVATE_9c41a7";
const PRIVATE_PATH = "/Users/private/company/design-system/entity-catalog.json";
const PRIVATE_TOKEN = "fsg_design_system_entity_private_token_83d2a1";

const applications: DesignerApplication[] = [];
const temporaryDirectories: string[] = [];

interface Fixture {
  application: DesignerApplication;
  localSystem: DesignSystemResult;
  foreignSystem: DesignSystemResult;
  projectScopedGrantActorId: string;
  projectScopedGrantToken: string;
  missingScopeGrantActorId: string;
  missingScopeGrantToken: string;
  componentSource: ComponentSourceRevisionFixture;
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

function token(id: string, value: string) {
  return {
    id,
    path: "action.primary.background",
    name: "Entity authorization primary action",
    family: "color" as const,
    layer: "semantic" as const,
    value,
    deprecated: false,
  };
}

function component(input: {
  id: string;
  version: number;
  status?: "draft" | "published" | "deprecated";
  name?: string;
  summary?: string;
}) {
  const rootNodeId = input.id === FOREIGN_COMPONENT_ID
    ? "node_entityforeignroot0001"
    : input.id === AUTHORED_COMPONENT_ID
      ? "node_entityauthoredroot0001"
      : "node_entitylocalroot0001";
  return {
    id: input.id,
    key: input.id === FOREIGN_COMPONENT_ID
      ? "private.foreign"
      : input.id === AUTHORED_COMPONENT_ID
        ? "button.secondary"
        : "button.primary",
    name: input.name ?? "Primary button",
    version: input.version,
    status: input.status ?? "draft" as const,
    root_node_id: rootNodeId,
    properties_schema: [{
      key: "label",
      label: "Label",
      required: true,
      type: "text" as const,
      default: "Continue",
    }],
    slots: [],
    states: [{ key: "default" as const, name: "Default", node_id: rootNodeId }],
    allowed_overrides: {
      allow_text: true,
      allow_assets: false,
      allow_icons: false,
      allowed_token_families: ["color" as const],
      allowed_style_paths: ["fill" as const],
    },
    platform_mappings: [],
    documentation: {
      summary: input.summary ?? "Primary product action.",
      usage: [],
      accessibility: [],
      do_list: [],
      dont_list: [],
    },
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
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `formaspec-design-system-entity-auth-${label}-`));
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
    DESIGNER_TOKEN: "design-system-entity-bootstrap-token-0001",
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
  const componentSource = createComponentSourceRevisionFixture(
    application.database,
    application.service,
    ADMIN_ACTOR,
    [
      "node_entitylocalroot0001",
      "node_entityforeignroot0001",
      "node_entityauthoredroot0001",
    ],
    `design-system-entity-${label}`,
  );

  const localSystem = application.designSystems.createDesignSystem(ADMIN_ACTOR, {
    name: `Local entity catalog ${label}`,
    description: "Organization-visible component and token definitions.",
  });
  application.designSystems.createComponentVersion(EDITOR_ACTOR, localSystem.id, {
    expectedLatestVersion: 0,
    definition: component({ id: LOCAL_COMPONENT_ID, version: 1 }),
    source: componentSource,
  });

  const foreignSystem = application.designSystems.createDesignSystem(ADMIN_ACTOR, {
    name: PRIVATE_MARKER,
    description: `${PRIVATE_PATH}\n${PRIVATE_TOKEN}`,
  });
  application.designSystems.createComponentVersion(ADMIN_ACTOR, foreignSystem.id, {
    expectedLatestVersion: 0,
    definition: component({
      id: FOREIGN_COMPONENT_ID,
      version: 1,
      status: "published",
      name: PRIVATE_MARKER,
      summary: `${PRIVATE_PATH}\n${PRIVATE_TOKEN}`,
    }),
    source: componentSource,
  });
  const now = new Date().toISOString();
  application.database.sqlite.prepare(
    `INSERT INTO organizations (id, name, config_json, created_at, updated_at)
     VALUES (?, 'Foreign design-system entity organization', '{}', ?, ?)`,
  ).run(FOREIGN_ORGANIZATION_ID, now, now);
  application.database.sqlite.prepare(
    "UPDATE design_systems SET organization_id = ? WHERE id = ?",
  ).run(FOREIGN_ORGANIZATION_ID, foreignSystem.id);

  const design = application.service.createDesign(ADMIN_ACTOR, {
    name: `Entity catalog restricted project ${label}`,
    preset: "web",
    idempotencyKey: `design-system-entity-auth-${label}-0001`,
  });
  const projectScoped = application.enterprise.createAgentConnection(ADMIN_ACTOR, {
    adapter: "codex",
    displayName: `Project-scoped entity catalog ${label}`,
    scopes: ["design_system:read"],
    projectIds: [design.document.id],
    expiresInSeconds: 3_600,
  });
  const missingScope = application.enterprise.createAgentConnection(ADMIN_ACTOR, {
    adapter: "codex",
    displayName: `Missing-scope entity catalog ${label}`,
    scopes: ["design:read"],
    projectIds: [],
    expiresInSeconds: 3_600,
  });
  const pairedProjectScoped = application.enterprise.pairAgentConnection(projectScoped.nonce);
  const pairedMissingScope = application.enterprise.pairAgentConnection(missingScope.nonce);
  return {
    application,
    localSystem,
    foreignSystem,
    projectScopedGrantActorId: pairedProjectScoped.grant.actorId,
    projectScopedGrantToken: pairedProjectScoped.grant.token,
    missingScopeGrantActorId: pairedMissingScope.grant.actorId,
    missingScopeGrantToken: pairedMissingScope.grant.token,
    componentSource,
  };
}

function entityState(application: DesignerApplication): unknown {
  return {
    systems: application.database.sqlite.prepare(
      `SELECT id, organization_id, name, description, status, updated_at
       FROM design_systems ORDER BY id`,
    ).all(),
    tokens: application.database.sqlite.prepare(
      `SELECT design_system_id, token_id, version, status, token_json, created_by, created_at
       FROM design_system_tokens ORDER BY design_system_id, token_id, version`,
    ).all(),
    components: application.database.sqlite.prepare(
      `SELECT design_system_id, component_id, version, status, definition_json,
              replacement_component_id, created_by, created_at
       FROM component_definitions ORDER BY design_system_id, component_id, version`,
    ).all(),
    audits: application.database.sqlite.prepare(
      `SELECT organization_id, actor_id, action, target_type, target_id, details_json
       FROM audit_events WHERE action LIKE 'design_system.%' ORDER BY id`,
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

describe("design-system entity HTTP authorization", () => {
  it("authorizes all four entity routes before parsing or lookup and keeps foreign data opaque without mutation", async () => {
    const {
      application,
      localSystem,
      foreignSystem,
      projectScopedGrantActorId,
      projectScopedGrantToken,
      missingScopeGrantActorId,
      missingScopeGrantToken,
      componentSource,
    } = await createFixture("denied");
    const systemSegment = encodeURIComponent(" ");
    const componentSegment = encodeURIComponent(" ");
    const hidden = [
      foreignSystem.id,
      FOREIGN_COMPONENT_ID,
      PRIVATE_MARKER,
      PRIVATE_PATH,
      PRIVATE_TOKEN,
    ];
    const invalidBody = {
      expectedLatestVersion: -1,
      targetStatus: PRIVATE_MARKER,
      definition: { documentation: PRIVATE_PATH },
      token: { accessToken: PRIVATE_TOKEN },
      privateMarker: PRIVATE_MARKER,
    };
    const before = entityState(application);

    const projectScopedDenied = await Promise.all([
      application.app.inject({
        method: "POST",
        url: `/api/design-systems/${systemSegment}/tokens`,
        headers: grantHeaders(projectScopedGrantToken),
        payload: invalidBody,
      }),
      application.app.inject({
        method: "POST",
        url: `/api/design-systems/${systemSegment}/components`,
        headers: grantHeaders(projectScopedGrantToken),
        payload: invalidBody,
      }),
      application.app.inject({
        method: "GET",
        url: `/api/design-systems/${systemSegment}/components?privateMarker=${encodeURIComponent(PRIVATE_MARKER)}`,
        headers: grantHeaders(projectScopedGrantToken),
      }),
      application.app.inject({
        method: "POST",
        url: `/api/design-systems/${systemSegment}/components/${componentSegment}/lifecycle`,
        headers: grantHeaders(projectScopedGrantToken),
        payload: invalidBody,
      }),
    ]);
    for (const response of projectScopedDenied) expectError(response, 401, "AUTH_REQUIRED", hidden);

    const missingScopeRead = await application.app.inject({
      method: "GET",
      url: `/api/design-systems/${systemSegment}/components?privateMarker=${encodeURIComponent(PRIVATE_MARKER)}`,
      headers: grantHeaders(missingScopeGrantToken),
    });
    expectError(missingScopeRead, 401, "AUTH_REQUIRED", hidden);

    for (const callback of [
      () => application.designSystems.createTokenVersion(projectScopedGrantActorId, " ", {
        expectedLatestVersion: -1,
        status: "published",
        token: { privateMarker: PRIVATE_MARKER, privatePath: PRIVATE_PATH, accessToken: PRIVATE_TOKEN },
      }),
      () => application.designSystems.createComponentVersion(projectScopedGrantActorId, " ", {
        expectedLatestVersion: -1,
        definition: { privateMarker: PRIVATE_MARKER, privatePath: PRIVATE_PATH, accessToken: PRIVATE_TOKEN },
      }),
      () => application.designSystems.listComponentDefinitions(projectScopedGrantActorId, " ", true),
      () => application.designSystems.transitionComponentLifecycle(projectScopedGrantActorId, " ", " ", {
        expectedLatestVersion: 1,
        targetStatus: "published",
      }),
      () => application.designSystems.listComponentDefinitions(missingScopeGrantActorId, " ", true),
    ]) {
      const error = captureDomainError(callback);
      expect(error).toMatchObject({ statusCode: 403, code: "FORBIDDEN" });
      for (const value of hidden) expect(JSON.stringify(error.toJSON())).not.toContain(value);
    }

    const viewerWriteDenied = await Promise.all([
      application.app.inject({
        method: "POST",
        url: `/api/design-systems/${systemSegment}/tokens`,
        headers: serverHeaders(VIEWER_IDENTITY),
        payload: invalidBody,
      }),
      application.app.inject({
        method: "POST",
        url: `/api/design-systems/${systemSegment}/components`,
        headers: serverHeaders(VIEWER_IDENTITY),
        payload: invalidBody,
      }),
      application.app.inject({
        method: "POST",
        url: `/api/design-systems/${systemSegment}/components/${componentSegment}/lifecycle`,
        headers: serverHeaders(VIEWER_IDENTITY),
        payload: invalidBody,
      }),
    ]);
    for (const response of viewerWriteDenied) expectError(response, 403, "FORBIDDEN", hidden);

    const editorTokenDenied = await application.app.inject({
      method: "POST",
      url: `/api/design-systems/${systemSegment}/tokens`,
      headers: serverHeaders(EDITOR_IDENTITY),
      payload: invalidBody,
    });
    expectError(editorTokenDenied, 403, "FORBIDDEN", hidden);

    const foreignDenied = await Promise.all([
      application.app.inject({
        method: "POST",
        url: `/api/design-systems/${foreignSystem.id}/tokens`,
        headers: serverHeaders(ADMIN_IDENTITY),
        payload: {
          expectedLatestVersion: 0,
          status: "published",
          token: token("token_entityforeign0001", "#9c41a7"),
        },
      }),
      application.app.inject({
        method: "POST",
        url: `/api/design-systems/${foreignSystem.id}/components`,
        headers: serverHeaders(EDITOR_IDENTITY),
        payload: {
          expectedLatestVersion: 0,
          definition: component({ id: "component_entityattempt0001", version: 1 }),
          source: componentSource,
        },
      }),
      application.app.inject({
        method: "GET",
        url: `/api/design-systems/${foreignSystem.id}/components?includeHistory=true`,
        headers: serverHeaders(VIEWER_IDENTITY),
      }),
      application.app.inject({
        method: "POST",
        url: `/api/design-systems/${localSystem.id}/components/${FOREIGN_COMPONENT_ID}/lifecycle`,
        headers: serverHeaders(EDITOR_IDENTITY),
        payload: { expectedLatestVersion: 1, targetStatus: "published", source: componentSource },
      }),
    ]);
    for (const response of foreignDenied) expectError(response, 404, "NOT_FOUND", hidden);

    expect(entityState(application)).toEqual(before);
  });

  it("preserves administrator token authoring, design-editor component authoring, and viewer catalog reads", async () => {
    const { application, localSystem, foreignSystem, componentSource } = await createFixture("allowed");
    const hidden = [foreignSystem.id, FOREIGN_COMPONENT_ID, PRIVATE_MARKER, PRIVATE_PATH, PRIVATE_TOKEN];

    const createdToken = await application.app.inject({
      method: "POST",
      url: `/api/design-systems/${localSystem.id}/tokens`,
      headers: serverHeaders(ADMIN_IDENTITY),
      payload: {
        expectedLatestVersion: 0,
        status: "published",
        token: token("token_entityprimary0001", "#2457e6"),
      },
    });
    expect(createdToken.statusCode, createdToken.body).toBe(201);
    expect(createdToken.json<{ tokenVersion: DesignSystemTokenVersionResult }>().tokenVersion).toMatchObject({
      designSystemId: localSystem.id,
      tokenId: "token_entityprimary0001",
      version: 1,
      status: "published",
    });

    const createdComponent = await application.app.inject({
      method: "POST",
      url: `/api/design-systems/${localSystem.id}/components`,
      headers: serverHeaders(EDITOR_IDENTITY),
      payload: {
        expectedLatestVersion: 0,
        definition: component({
          id: AUTHORED_COMPONENT_ID,
          version: 1,
          name: "Secondary button",
        }),
        source: componentSource,
      },
    });
    expect(createdComponent.statusCode, createdComponent.body).toBe(201);
    expect(createdComponent.json<{ componentVersion: ComponentDefinitionVersionResult }>().componentVersion)
      .toMatchObject({
        designSystemId: localSystem.id,
        componentId: AUTHORED_COMPONENT_ID,
        version: 1,
        status: "draft",
      });

    for (const [identity, canAuthorComponents] of [
      [ADMIN_IDENTITY, true],
      [EDITOR_IDENTITY, true],
      [VIEWER_IDENTITY, false],
    ] as const) {
      const listed = await application.app.inject({
        method: "GET",
        url: `/api/design-systems/${localSystem.id}/components?includeHistory=false`,
        headers: serverHeaders(identity),
      });
      expect(listed.statusCode, listed.body).toBe(200);
      const body = listed.json<{
        components: ComponentDefinitionCatalogResult[];
        permissions: { designSystemId: string; canAuthorComponents: boolean };
      }>();
      expect(body.permissions).toEqual({ designSystemId: localSystem.id, canAuthorComponents });
      expect(body.components.map((entry) => entry.componentId).sort()).toEqual([
        AUTHORED_COMPONENT_ID,
        LOCAL_COMPONENT_ID,
      ]);
      for (const value of hidden) expect(listed.body).not.toContain(value);
    }

    const lifecycle = await application.app.inject({
      method: "POST",
      url: `/api/design-systems/${localSystem.id}/components/${LOCAL_COMPONENT_ID}/lifecycle`,
      headers: serverHeaders(EDITOR_IDENTITY),
      payload: { expectedLatestVersion: 1, targetStatus: "published", source: componentSource },
    });
    expect(lifecycle.statusCode, lifecycle.body).toBe(201);
    expect(lifecycle.json<{ componentVersion: ComponentDefinitionVersionResult }>().componentVersion)
      .toMatchObject({
        designSystemId: localSystem.id,
        componentId: LOCAL_COMPONENT_ID,
        version: 2,
        status: "published",
      });

    const history = await application.app.inject({
      method: "GET",
      url: `/api/design-systems/${localSystem.id}/components?includeHistory=true`,
      headers: serverHeaders(VIEWER_IDENTITY),
    });
    expect(history.statusCode, history.body).toBe(200);
    const localVersions = history
      .json<{ components: ComponentDefinitionCatalogResult[] }>()
      .components
      .filter((entry) => entry.componentId === LOCAL_COMPONENT_ID)
      .map((entry) => ({ version: entry.version, status: entry.status, isLatest: entry.isLatest }));
    expect(localVersions).toEqual([
      { version: 2, status: "published", isLatest: true },
      { version: 1, status: "draft", isLatest: false },
    ]);
    for (const value of hidden) expect(history.body).not.toContain(value);
  });
});
