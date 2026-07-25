import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { loadConfig } from "./config.js";
import { moveDesignFixtureToOrganization } from "../test-fixtures/product.js";

const PROXY_SECRET = "portable-http-proxy-secret-0123456789abcdef";
const ADMIN_IDENTITY = "portable-http-admin@example.test";
const VIEWER_IDENTITY = "portable-http-viewer@example.test";
const PRIVATE_MARKER = "PORTABLE_HTTP_PRIVATE_531a6f7c";

const applications: DesignerApplication[] = [];
const temporaryDirectories: string[] = [];

interface Fixture {
  application: DesignerApplication;
  root: string;
  allowedProjectId: string;
  deniedProjectId: string;
  foreignProjectId: string;
  grantActorId: string;
  grantToken: string;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(applications.splice(0).map((application) => application.app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.promises.rm(directory, { recursive: true, force: true })));
});

async function serverApplication(label: string): Promise<{ application: DesignerApplication; root: string }> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `formaspec-portable-http-auth-${label}-`));
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
    DESIGNER_TOKEN: "portable-http-bootstrap-token-0001",
    FORMASPEC_TRUSTED_PROXIES: "127.0.0.1",
    FORMASPEC_PROXY_SECRET: PROXY_SECRET,
    DESIGNER_CORS_ORIGINS: "https://design.example.test",
    DESIGNER_LOG_LEVEL: "silent",
  }));
  applications.push(application);
  await application.app.ready();
  return { application, root };
}

function serverHeaders(identity = ADMIN_IDENTITY): Record<string, string> {
  return {
    host: "design.example.test",
    origin: "https://design.example.test",
    "x-formaspec-csrf": "1",
    "x-designer-user": identity,
    "x-formaspec-proxy-secret": PROXY_SECRET,
  };
}

function grantHeaders(token: string): Record<string, string> {
  return {
    host: "design.example.test",
    origin: "https://design.example.test",
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

function multipart(data: Buffer): { boundary: string; body: Buffer } {
  const boundary = "----formaspec-portable-http-authorization";
  return {
    boundary,
    body: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${PRIVATE_MARKER}.formaspec.zip"\r\nContent-Type: application/zip\r\n\r\n`),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

function createProject(application: DesignerApplication, label: string): string {
  return application.service.createDesign("local", {
    name: `Portable authorization ${label}`,
    preset: "phone",
    idempotencyKey: `portable-http-authorization-${label}-0001`,
  }).document.id;
}

async function createFixture(label: string): Promise<Fixture> {
  const { application, root } = await serverApplication(label);
  await warmIdentity(application, ADMIN_IDENTITY);
  const current = application.policies.read(`trusted:${ADMIN_IDENTITY}`);
  const policy = structuredClone(current.policy);
  policy.identity.roleMappings = [
    { claim: "identity", value: ADMIN_IDENTITY, role: "organization_admin" },
    { claim: "identity", value: VIEWER_IDENTITY, role: "viewer" },
  ];
  application.policies.update(`trusted:${ADMIN_IDENTITY}`, {
    expectedConfigurationHash: current.configurationHash,
    policy,
  });
  await warmIdentity(application, VIEWER_IDENTITY);

  const allowedProjectId = createProject(application, `${label}-allowed`);
  const deniedProjectId = createProject(application, `${label}-denied`);
  const foreignProjectId = createProject(application, `${label}-foreign-${PRIVATE_MARKER}`);
  const foreignOrganizationId = `organization_portable_foreign_${label.replaceAll(/[^a-z0-9]/gi, "_")}`;
  const now = new Date().toISOString();
  application.database.sqlite.prepare(
    "INSERT INTO organizations (id, name, config_json, created_at, updated_at) VALUES (?, ?, '{}', ?, ?)",
  ).run(foreignOrganizationId, `Foreign ${PRIVATE_MARKER}`, now, now);
  moveDesignFixtureToOrganization(application.database.sqlite, {
    designId: foreignProjectId,
    organizationId: foreignOrganizationId,
    name: `Foreign project ${PRIVATE_MARKER}`,
  });

  const challenge = application.enterprise.createAgentConnection("local", {
    adapter: "codex",
    displayName: `Portable project-scoped agent ${label}`,
    scopes: ["design:read"],
    projectIds: [allowedProjectId],
    expiresInSeconds: 3_600,
  });
  const grant = application.enterprise.pairAgentConnection(challenge.nonce).grant;
  return {
    application,
    root,
    allowedProjectId,
    deniedProjectId,
    foreignProjectId,
    grantActorId: grant.actorId,
    grantToken: grant.token,
  };
}

function portableMutationState(application: DesignerApplication): Record<string, unknown[]> {
  return {
    designs: application.database.sqlite.prepare(
      "SELECT id, organization_id, current_version, current_revision_id FROM designs ORDER BY id",
    ).all(),
    exports: application.database.sqlite.prepare(
      "SELECT id, organization_id, design_id, revision_id FROM portable_exports ORDER BY id",
    ).all(),
    imports: application.database.sqlite.prepare(
      "SELECT id, organization_id, target_design_id, target_revision_id FROM portable_imports ORDER BY id",
    ).all(),
    idempotency: application.database.sqlite.prepare(
      "SELECT actor_id, scope, key, request_hash, response_json FROM idempotency ORDER BY actor_id, scope, key",
    ).all(),
    audits: application.database.sqlite.prepare(
      "SELECT action, target_type, target_id, details_json FROM audit_events WHERE action LIKE 'portable_%' OR action = 'token_export.create' ORDER BY id",
    ).all(),
  };
}

async function filesBelow(root: string): Promise<string[]> {
  const entries = await fs.promises.readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(root, entry.name);
    if (!entry.isDirectory()) return [entryPath];
    return filesBelow(entryPath);
  }));
  return nested.flat().sort();
}

function expectError(
  response: { statusCode: number; body: string; json<T>(): T },
  statusCode: number,
  code: string,
): void {
  expect(response.statusCode, response.body).toBe(statusCode);
  expect(response.json<{ error: { code: string } }>().error.code, response.body).toBe(code);
  expect(response.body).not.toContain(PRIVATE_MARKER);
}

describe("portable REST authorization", () => {
  it("authorizes all four routes before route, query, header, or multipart parsing without side effects", async () => {
    const fixture = await createFixture("ordering");
    const { application, allowedProjectId } = fixture;
    const invalidUpload = multipart(Buffer.from(PRIVATE_MARKER));
    const requests = [
      {
        method: "GET",
        url: `/api/designs/${allowedProjectId}/export.formaspec.zip?version=${PRIVATE_MARKER}&includePreviews=secret`,
      },
      {
        method: "GET",
        url: `/api/designs/${allowedProjectId}/tokens/export/%20?version=${PRIVATE_MARKER}&mode=%20`,
      },
      {
        method: "POST",
        url: "/api/imports/validate",
        headers: { "content-type": `multipart/form-data; boundary=${invalidUpload.boundary}` },
        payload: invalidUpload.body,
      },
      {
        method: "POST",
        url: `/api/imports?mode=${PRIVATE_MARKER}`,
        headers: {
          "content-type": `multipart/form-data; boundary=${invalidUpload.boundary}`,
          "idempotency-key": "short",
        },
        payload: invalidUpload.body,
      },
    ] as const;
    const beforeState = portableMutationState(application);
    const beforeFiles = await filesBelow(fixture.root);
    const originalMkdtemp = fs.promises.mkdtemp.bind(fs.promises);
    const stagedDirectories: string[] = [];
    vi.spyOn(fs.promises, "mkdtemp").mockImplementation(async (prefix, options) => {
      const created = await originalMkdtemp(prefix, options as BufferEncoding | { encoding: BufferEncoding } | undefined);
      const createdPath = String(created);
      if (String(prefix).includes("formaspec-portable-imports")) stagedDirectories.push(createdPath);
      return created as never;
    });

    for (const request of requests) {
      const roleDenied = await application.app.inject({
        ...request,
        headers: { ...serverHeaders(VIEWER_IDENTITY), ...request.headers },
      });
      expectError(roleDenied, 403, "FORBIDDEN");
      const grantDenied = await application.app.inject({
        ...request,
        headers: { ...grantHeaders(fixture.grantToken), ...request.headers },
      });
      expectError(grantDenied, 401, "AUTH_REQUIRED");
    }

    expect(stagedDirectories).toEqual([]);
    expect(portableMutationState(application)).toEqual(beforeState);
    expect(await filesBelow(fixture.root)).toEqual(beforeFiles);
  });

  it("keeps foreign and out-of-grant projects opaque while preserving deeper administrator policy", async () => {
    const fixture = await createFixture("opaque");
    const { application } = fixture;
    const before = portableMutationState(application);

    const foreignBundle = await application.app.inject({
      method: "GET",
      url: `/api/designs/${fixture.foreignProjectId}/export.formaspec.zip?version=${PRIVATE_MARKER}`,
      headers: serverHeaders(),
    });
    expectError(foreignBundle, 404, "NOT_FOUND");
    const foreignTokens = await application.app.inject({
      method: "GET",
      url: `/api/designs/${fixture.foreignProjectId}/tokens/export/%20?version=${PRIVATE_MARKER}`,
      headers: serverHeaders(),
    });
    expectError(foreignTokens, 404, "NOT_FOUND");

    expect(application.service.getDesign(fixture.grantActorId, fixture.allowedProjectId).document.id)
      .toBe(fixture.allowedProjectId);
    expect(() => application.service.getDesign(fixture.grantActorId, fixture.deniedProjectId))
      .toThrow(expect.objectContaining({ statusCode: 404, code: "NOT_FOUND" }));
    expect(() => application.service.getDesign(fixture.grantActorId, fixture.foreignProjectId))
      .toThrow(expect.objectContaining({ statusCode: 404, code: "NOT_FOUND" }));
    await expect(application.operations.createPortableExport(fixture.grantActorId, fixture.allowedProjectId))
      .rejects.toMatchObject({ statusCode: 403, code: "FORBIDDEN" });
    expect(() => application.operations.exportTokens(fixture.grantActorId, fixture.allowedProjectId, "css"))
      .toThrow(expect.objectContaining({ statusCode: 403, code: "FORBIDDEN" }));
    expect(() => application.operations.assertPortableImportAllowed(fixture.grantActorId))
      .toThrow(expect.objectContaining({ statusCode: 403, code: "FORBIDDEN" }));
    expect(portableMutationState(application)).toEqual(before);
  });

  it("preserves valid authorized bundle export, token export, validation, and import behavior", async () => {
    const fixture = await createFixture("allowed");
    const { application, allowedProjectId } = fixture;
    const exported = await application.app.inject({
      method: "GET",
      url: `/api/designs/${allowedProjectId}/export.formaspec.zip?includePreviews=false`,
      headers: serverHeaders(),
    });
    expect(exported.statusCode, exported.body).toBe(200);
    expect(exported.headers["content-type"]).toContain("application/zip");

    const tokens = await application.app.inject({
      method: "GET",
      url: `/api/designs/${allowedProjectId}/tokens/export/css`,
      headers: serverHeaders(),
    });
    expect(tokens.statusCode, tokens.body).toBe(200);
    expect(tokens.headers["content-type"]).toContain("text/css");

    const validationUpload = multipart(exported.rawPayload);
    const validated = await application.app.inject({
      method: "POST",
      url: "/api/imports/validate",
      headers: {
        ...serverHeaders(),
        "content-type": `multipart/form-data; boundary=${validationUpload.boundary}`,
      },
      payload: validationUpload.body,
    });
    expect(validated.statusCode, validated.body).toBe(200);
    expect(validated.json()).toMatchObject({
      valid: true,
      validationOnly: true,
      mutationsApplied: false,
      project: { id: allowedProjectId },
    });

    const designsBeforeImport = (application.database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM designs",
    ).get() as { count: number }).count;
    const importsBefore = (application.database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM portable_imports",
    ).get() as { count: number }).count;
    const idempotencyBefore = (application.database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM idempotency",
    ).get() as { count: number }).count;
    const importUpload = multipart(exported.rawPayload);
    const imported = await application.app.inject({
      method: "POST",
      url: "/api/imports?mode=clone",
      headers: {
        ...serverHeaders(),
        "content-type": `multipart/form-data; boundary=${importUpload.boundary}`,
        "idempotency-key": "portable-http-authorized-import-0001",
      },
      payload: importUpload.body,
    });
    expect(imported.statusCode, imported.body).toBe(201);
    expect(imported.json()).toMatchObject({ imported: true, mutationsApplied: true, mode: "clone" });
    expect((application.database.sqlite.prepare("SELECT COUNT(*) AS count FROM designs").get() as { count: number }).count)
      .toBe(designsBeforeImport + 1);
    expect((application.database.sqlite.prepare("SELECT COUNT(*) AS count FROM portable_imports").get() as { count: number }).count)
      .toBe(importsBefore + 1);
    expect((application.database.sqlite.prepare("SELECT COUNT(*) AS count FROM idempotency").get() as { count: number }).count)
      .toBe(idempotencyBefore + 1);
  });
});
