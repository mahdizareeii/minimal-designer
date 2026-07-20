import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createSequentialIdFactory, createStarterDocument } from "@designer/core";
import { zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { loadConfig } from "./config.js";
import { DomainError } from "./errors.js";
import { createPortableProjectBundle, readPortableProjectBundle } from "./portable-export.js";

const applications: DesignerApplication[] = [];
const temporaryDirectories: string[] = [];
const PROXY_SECRET = "proxy-secret-0123456789abcdef0123456789abcdef";

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.promises.rm(directory, { recursive: true, force: true })));
});

async function temporaryRoot(label: string): Promise<string> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `formaspec-security-${label}-`));
  temporaryDirectories.push(root);
  return root;
}

async function localApplication(label: string, containerLocal = false): Promise<DesignerApplication> {
  const root = await temporaryRoot(label);
  const application = await buildApplication(loadConfig({
    APP_MODE: "local",
    HOST: containerLocal ? "0.0.0.0" : "127.0.0.1",
    PORT: "4310",
    DATA_DIR: path.join(root, "data"),
    BACKUP_DIR: path.join(root, "backups"),
    DESIGNER_DATABASE_PATH: ":memory:",
    PUBLIC_BASE_URL: "http://127.0.0.1:4310",
    AUTH_MODE: "none",
    FORMASPEC_CONTAINER_LOCAL: containerLocal ? "true" : "false",
    FORMASPEC_ALLOW_SOFTWARE_RENDERER: "true",
    DESIGNER_LOG_LEVEL: "silent",
  }));
  applications.push(application);
  await application.app.ready();
  return application;
}

async function serverApplication(label: string): Promise<DesignerApplication> {
  const root = await temporaryRoot(label);
  const application = await buildApplication(loadConfig({
    APP_MODE: "server",
    HOST: "0.0.0.0",
    PORT: "4310",
    DATA_DIR: path.join(root, "data"),
    BACKUP_DIR: path.join(root, "backups"),
    DESIGNER_DATABASE_PATH: ":memory:",
    PUBLIC_BASE_URL: "https://design.example.com",
    AUTH_MODE: "trusted-header",
    DESIGNER_TOKEN: "security-bootstrap-token-0001",
    FORMASPEC_TRUSTED_PROXIES: "127.0.0.1",
    FORMASPEC_PROXY_SECRET: PROXY_SECRET,
    DESIGNER_CORS_ORIGINS: "https://design.example.com",
    DESIGNER_LOG_LEVEL: "silent",
  }));
  applications.push(application);
  await application.app.ready();
  return application;
}

function installGrant(application: DesignerApplication, input: {
  id: string;
  projectIds: string[];
  scopes: string[];
  role?: "agent" | "organization_admin";
}): { actorId: string; token: string } {
  const principalId = `principal_${input.id}`;
  const token = `fsg_${input.id}_security_token_00000001`;
  const now = new Date();
  application.database.sqlite.prepare(
    `INSERT INTO principals (id, organization_id, kind, display_name, external_id, created_at)
     VALUES (?, 'organization_legacy', 'agent', ?, ?, ?)`,
  ).run(principalId, input.id, `security:${input.id}`, now.toISOString());
  application.database.sqlite.prepare(
    `INSERT INTO memberships (organization_id, principal_id, role, created_at)
     VALUES ('organization_legacy', ?, ?, ?)`,
  ).run(principalId, input.role ?? "agent", now.toISOString());
  application.database.sqlite.prepare(
    `INSERT INTO agent_connections
     (id, organization_id, principal_id, adapter, display_name, status, scopes_json, project_ids_json,
      expires_at, created_at, updated_at)
     VALUES (?, 'organization_legacy', ?, 'generic_mcp', ?, 'active', ?, ?, ?, ?, ?)`,
  ).run(
    `connection_${input.id}`,
    principalId,
    input.id,
    JSON.stringify(input.scopes),
    JSON.stringify(input.projectIds),
    new Date(now.getTime() + 60_000).toISOString(),
    now.toISOString(),
    now.toISOString(),
  );
  application.database.sqlite.prepare(
    `INSERT INTO agent_grants
     (id, organization_id, principal_id, token_hash, scopes_json, project_ids_json, created_at, expires_at)
     VALUES (?, 'organization_legacy', ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    principalId,
    createHash("sha256").update(token).digest("hex"),
    JSON.stringify(input.scopes),
    JSON.stringify(input.projectIds),
    now.toISOString(),
    new Date(now.getTime() + 60_000).toISOString(),
  );
  return { actorId: `grant_${input.id}`, token };
}

function thrown(callback: () => unknown): DomainError {
  try {
    callback();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error("Expected a DomainError.");
}

function multipart(data: Buffer, filename = "project.formaspec.zip"): { boundary: string; body: Buffer } {
  const boundary = "----formaspec-security-boundary";
  return {
    boundary,
    body: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/zip\r\n\r\n`),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

function portableFixture(): Buffer {
  const document = createStarterDocument({
    name: "Security fixture",
    now: "2026-07-19T00:00:00.000Z",
    idFactory: createSequentialIdFactory("security"),
  });
  return createPortableProjectBundle({
    document,
    revisionId: "revision_security_00000001",
    revisionHash: "a".repeat(64),
    designSystemVersion: 1,
    createdAt: "2026-07-19T00:00:00.000Z",
  });
}

describe("public security boundaries", () => {
  it("keeps project-restricted grants inside their revision and asset boundary", async () => {
    const application = await localApplication("scoped-grants");
    const allowed = application.service.createDesign("local", {
      name: "Allowed project",
      preset: "web",
      idempotencyKey: "security-create-allowed-0001",
    });
    const denied = application.service.createDesign("local", {
      name: "Denied project",
      preset: "phone",
      idempotencyKey: "security-create-denied-0001",
    });
    const allowedAsset = application.service.saveAsset("local", {
      designId: allowed.document.id,
      filename: "allowed.png",
      mimeType: "image/png",
      width: 1,
      height: 1,
      data: Buffer.from("allowed-normalized-raster"),
    });
    const deniedAsset = application.service.saveAsset("local", {
      designId: denied.document.id,
      filename: "denied.png",
      mimeType: "image/png",
      width: 1,
      height: 1,
      data: Buffer.from("denied-normalized-raster"),
    });
    const organizationAsset = application.service.saveAsset("local", {
      filename: "organization.png",
      mimeType: "image/png",
      width: 1,
      height: 1,
      data: Buffer.from("organization-normalized-raster"),
    });
    const grant = installGrant(application, {
      id: "project_limited",
      projectIds: [allowed.document.id],
      scopes: ["design:read", "design:write"],
    });

    expect(application.service.getDesign(grant.actorId, allowed.document.id).document.id).toBe(allowed.document.id);
    expect(application.service.history(grant.actorId, allowed.document.id)).toHaveLength(1);
    expect(application.service.getAsset(grant.actorId, allowedAsset.id).id).toBe(allowedAsset.id);
    expect(thrown(() => application.service.getDesign(grant.actorId, denied.document.id))).toMatchObject({ code: "NOT_FOUND" });
    expect(thrown(() => application.service.history(grant.actorId, denied.document.id))).toMatchObject({ code: "NOT_FOUND" });
    expect(thrown(() => application.service.getAsset(grant.actorId, deniedAsset.id))).toMatchObject({ code: "NOT_FOUND" });
    expect(thrown(() => application.service.getAsset(grant.actorId, organizationAsset.id))).toMatchObject({ code: "NOT_FOUND" });
    expect(thrown(() => application.service.saveAsset(grant.actorId, {
      filename: "unscoped.png",
      mimeType: "image/png",
      width: 1,
      height: 1,
      data: Buffer.from("unscoped-raster"),
    }))).toMatchObject({ code: "FORBIDDEN" });

    const mcpCall = (name: string, args: Record<string, unknown>) => application.app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        host: "127.0.0.1:4310",
        authorization: `Bearer ${grant.token}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    });
    const allowedRead = await mcpCall("design_read", { design_id: allowed.document.id });
    expect(allowedRead.statusCode).toBe(200);
    expect(allowedRead.json<{ result: { structuredContent: { ok: boolean } } }>().result.structuredContent.ok).toBe(true);
    const deniedHistory = await mcpCall("design_history", { design_id: denied.document.id, limit: 10 });
    expect(deniedHistory.statusCode).toBe(200);
    expect(deniedHistory.json<{
      result: { structuredContent: { ok: boolean; error: { code: string } } };
    }>().result.structuredContent).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });

    const adminGrant = installGrant(application, {
      id: "admin_project_limited",
      projectIds: [allowed.document.id],
      scopes: ["design:read"],
      role: "organization_admin",
    });
    const allowedExport = await application.operations.createPortableExport(adminGrant.actorId, allowed.document.id);
    expect(readPortableProjectBundle(allowedExport.data).document.id).toBe(allowed.document.id);
    await expect(application.operations.createPortableExport(adminGrant.actorId, denied.document.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("requires the dedicated destructive preview and commit route for every archive", async () => {
    const application = await localApplication("archive-gate");
    const created = application.service.createDesign("local", {
      name: "Archive gate",
      preset: "phone",
      idempotencyKey: "security-create-archive-0001",
    });
    const frameId = created.document.pages[0]!.children[0]!;
    const archiveOperation = { type: "archive_nodes", node_ids: [frameId] };

    for (const [url, payload] of [
      [`/api/designs/${created.document.id}/revisions`, {
        baseVersion: 1,
        operations: [archiveOperation],
        idempotencyKey: "security-archive-revision-0001",
      }],
      [`/api/designs/${created.document.id}/previews`, {
        baseVersion: 1,
        operations: [archiveOperation],
      }],
    ] as const) {
      const response = await application.app.inject({ method: "POST", url, payload });
      expect(response.statusCode).toBe(422);
      expect(response.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_FAILED");
    }

    const archivePreviewResponse = await application.app.inject({
      method: "POST",
      url: `/api/designs/${created.document.id}/archive-previews`,
      payload: { baseVersion: 1, operations: [archiveOperation] },
    });
    expect(archivePreviewResponse.statusCode).toBe(201);
    const archivePreviewId = archivePreviewResponse.json<{ previewId: string }>().previewId;
    const ordinaryCommit = await application.app.inject({
      method: "POST",
      url: `/api/designs/${created.document.id}/previews/${archivePreviewId}/commit`,
      payload: {
        expectedBaseVersion: 1,
        idempotencyKey: "security-archive-wrong-commit-0001",
        message: "Attempt ordinary commit",
      },
    });
    expect(ordinaryCommit.statusCode).toBe(422);
    expect(ordinaryCommit.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_FAILED");

    const shortcut = await application.app.inject({
      method: "POST",
      url: `/api/designs/${created.document.id}/archive`,
      payload: { nodeIds: [frameId] },
    });
    expect(shortcut.statusCode).toBe(404);
    expect(shortcut.json<{ error: { code: string } }>().error.code).toBe("NOT_FOUND");
  });

  it("enforces Host, Origin, and CSRF intent before server-mode browser writes", async () => {
    const application = await serverApplication("server-request-guards");
    const basePayload = { name: "Guarded project", preset: "web", idempotencyKey: "security-guarded-create-0001" };
    const validHeaders = {
      host: "design.example.com",
      origin: "https://design.example.com",
      "x-formaspec-csrf": "1",
      "x-designer-user": "admin@example.com",
      "x-formaspec-proxy-secret": PROXY_SECRET,
    };

    const rejectedHeaders = [
      { ...validHeaders, host: "design.example.com.attacker.invalid" },
      { ...validHeaders, origin: "https://attacker.invalid" },
      { ...validHeaders, origin: "null" },
      { host: validHeaders.host, "x-formaspec-csrf": "1", "x-designer-user": validHeaders["x-designer-user"] },
      { host: validHeaders.host, origin: validHeaders.origin, "x-designer-user": validHeaders["x-designer-user"] },
    ];
    for (const headers of rejectedHeaders) {
      const response = await application.app.inject({ method: "POST", url: "/api/designs", headers, payload: basePayload });
      expect(response.statusCode).toBe(403);
      expect(response.json<{ error: { code: string } }>().error.code).toBe("FORBIDDEN");
    }

    const accepted = await application.app.inject({ method: "POST", url: "/api/designs", headers: validHeaders, payload: basePayload });
    expect(accepted.statusCode).toBe(201);
  });

  it("rejects proxy and identity spoofing at the container-local boundary", async () => {
    const application = await localApplication("container-local", true);
    const accepted = await application.app.inject({
      method: "GET",
      url: "/health/live",
      headers: { host: "127.0.0.1:4310" },
      remoteAddress: "172.18.0.1",
    });
    expect(accepted.statusCode).toBe(200);

    for (const headers of [
      { host: "attacker.invalid" },
      { host: "127.0.0.1:4310", forwarded: "for=127.0.0.1" },
      { host: "127.0.0.1:4310", "x-forwarded-for": "127.0.0.1" },
      { host: "127.0.0.1:4310", "x-forwarded-host": "127.0.0.1:4310" },
      { host: "127.0.0.1:4310", "x-forwarded-proto": "http" },
      { host: "127.0.0.1:4310", "x-designer-user": "spoofed-admin" },
    ]) {
      const response = await application.app.inject({ method: "GET", url: "/health/live", headers, remoteAddress: "172.18.0.1" });
      expect(response.statusCode).toBe(403);
      expect(response.json<{ error: { code: string } }>().error.code).toBe("FORBIDDEN");
    }
  });

  it("rejects traversal, malformed ZIP internals, and declared decompression bombs with structured errors", async () => {
    const application = await localApplication("portable-abuse");
    const traversal = Buffer.from(zipSync({ "../outside.txt": Buffer.from("escape") }));
    const malformed = Buffer.from(portableFixture());
    const centralHeader = malformed.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(centralHeader).toBeGreaterThan(0);
    malformed.writeUInt32LE(malformed.length - 1, centralHeader + 42);
    const declaredBomb = Buffer.from(zipSync({ "payload.bin": Buffer.from("small") }));
    const bombCentralHeader = declaredBomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(bombCentralHeader).toBeGreaterThan(0);
    declaredBomb.writeUInt32LE(0xffff_ffff, bombCentralHeader + 24);

    const cases = [
      { data: traversal, status: 422, code: "VALIDATION_FAILED" },
      { data: malformed, status: 422, code: "VALIDATION_FAILED" },
      { data: declaredBomb, status: 413, code: "PAYLOAD_TOO_LARGE" },
    ];
    for (const testCase of cases) {
      const upload = multipart(testCase.data);
      const response = await application.app.inject({
        method: "POST",
        url: "/api/imports/validate",
        headers: { "content-type": `multipart/form-data; boundary=${upload.boundary}` },
        payload: upload.body,
      });
      expect(response.statusCode).toBe(testCase.status);
      expect(response.json<{ error: { code: string } }>().error.code).toBe(testCase.code);

      const mutationUpload = multipart(testCase.data);
      const mutation = await application.app.inject({
        method: "POST",
        url: "/api/imports",
        headers: {
          "content-type": `multipart/form-data; boundary=${mutationUpload.boundary}`,
          "idempotency-key": `portable-abuse-${testCase.code.toLowerCase()}`,
        },
        payload: mutationUpload.body,
      });
      expect(mutation.statusCode).toBe(testCase.status);
      expect(mutation.json<{ error: { code: string } }>().error.code).toBe(testCase.code);
    }

    expect(thrown(() => readPortableProjectBundle(declaredBomb))).toMatchObject({ code: "PAYLOAD_TOO_LARGE", statusCode: 413 });
    expect(application.database.sqlite.prepare("SELECT COUNT(*) AS count FROM designs").get()).toEqual({ count: 0 });
    expect(application.database.sqlite.prepare("SELECT COUNT(*) AS count FROM portable_imports").get()).toEqual({ count: 0 });
  });
});
