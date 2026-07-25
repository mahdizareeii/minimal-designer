import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { loadConfig } from "./config.js";
import {
  deterministicPdfExport,
  deterministicSvgExport,
} from "./deterministic-document-export.js";
import { encodeRgbaPng } from "./render.js";
import { moveDesignFixtureToOrganization } from "../test-fixtures/product.js";

const PUBLIC_ORIGIN = "https://design.example.test";
const PROXY_SECRET = "deterministic-export-http-proxy-secret-0123456789abcdef";
const ADMIN_IDENTITY = "deterministic-export-admin@example.test";
const PRIVATE_MARKER = "DETERMINISTIC_EXPORT_PRIVATE_9f41c2";
const UNKNOWN_TOKEN = "fsg_deterministic_export_unknown_903ac1";

const applications: DesignerApplication[] = [];
const temporaryDirectories: string[] = [];

interface DesignFixture {
  id: string;
  name: string;
  pageId: string;
  frameId: string;
}

interface ExportFixture {
  application: DesignerApplication;
  allowed: DesignFixture;
  foreign: DesignFixture;
  archived: DesignFixture;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(applications.splice(0).map((application) => application.app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.promises.rm(directory, { recursive: true, force: true })
  )));
});

function serverHeaders(identity = ADMIN_IDENTITY): Record<string, string> {
  return {
    host: "design.example.test",
    origin: PUBLIC_ORIGIN,
    "x-formaspec-csrf": "1",
    "x-designer-user": identity,
    "x-formaspec-proxy-secret": PROXY_SECRET,
  };
}

function bearerHeaders(token: string): Record<string, string> {
  return {
    host: "design.example.test",
    origin: PUBLIC_ORIGIN,
    "x-formaspec-csrf": "1",
    authorization: `Bearer ${token}`,
    "x-formaspec-proxy-secret": PROXY_SECRET,
  };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function serverApplication(label: string): Promise<DesignerApplication> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `formaspec-deterministic-export-http-${label}-`));
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
    DESIGNER_TOKEN: "deterministic-export-http-bootstrap-token-0001",
    FORMASPEC_TRUSTED_PROXIES: "127.0.0.1",
    FORMASPEC_PROXY_SECRET: PROXY_SECRET,
    DESIGNER_CORS_ORIGINS: PUBLIC_ORIGIN,
    DESIGNER_LOG_LEVEL: "silent",
  }));
  applications.push(application);
  await application.app.ready();
  return application;
}

async function warmAdmin(application: DesignerApplication): Promise<void> {
  const response = await application.app.inject({
    method: "GET",
    url: "/api/designs",
    headers: serverHeaders(),
  });
  expect(response.statusCode, response.body).toBe(200);
}

function createDesign(application: DesignerApplication, label: string, name: string): DesignFixture {
  const created = application.service.createDesign("local", {
    name,
    preset: "web",
    idempotencyKey: `deterministic-export-http-create-${label}-0001`,
  });
  return {
    id: created.design.id,
    name: created.design.name,
    pageId: created.document.pages[0]!.id,
    frameId: created.document.pages[0]!.children[0]!,
  };
}

async function createFixture(label: string): Promise<ExportFixture> {
  const application = await serverApplication(label);
  await warmAdmin(application);
  const allowed = createDesign(application, `${label}-allowed`, "Authorized export project");
  const foreign = createDesign(application, `${label}-foreign`, `Foreign ${PRIVATE_MARKER}`);
  const archived = createDesign(application, `${label}-archived`, `Archived ${PRIVATE_MARKER}`);
  const foreignOrganizationId = `organization_deterministic_export_foreign_${label}`;
  const now = new Date().toISOString();
  application.database.sqlite.prepare(
    "INSERT INTO organizations (id, name, config_json, created_at, updated_at) VALUES (?, ?, '{}', ?, ?)",
  ).run(foreignOrganizationId, `Foreign export ${PRIVATE_MARKER}`, now, now);
  moveDesignFixtureToOrganization(application.database.sqlite, {
    designId: foreign.id,
    organizationId: foreignOrganizationId,
    name: foreign.name,
  });
  application.service.archiveDesign("local", archived.id, {
    expectedVersion: 1,
    idempotencyKey: `deterministic-export-http-archive-${label}-0001`,
    confirmationName: archived.name,
  });
  return {
    application,
    allowed,
    foreign,
    archived,
  };
}

function expectDomainError(
  response: { statusCode: number; body: string; json<T>(): T },
  statusCode: number,
  code: string,
): void {
  expect(response.statusCode, response.body).toBe(statusCode);
  expect(response.json<{ error: { code: string } }>().error.code, response.body).toBe(code);
  expect(response.body).not.toContain(PRIVATE_MARKER);
}

describe("deterministic SVG and PDF export HTTP contract", () => {
  it("authenticates and authorizes before parsing export options and keeps archived projects opaque", async () => {
    const fixture = await createFixture("authorization");
    const getDesign = vi.spyOn(fixture.application.service, "getDesign");
    const render = vi.spyOn(fixture.application.renderer, "render");
    const invalidQuery = `format=${PRIVATE_MARKER}&version=${PRIVATE_MARKER}&maxSize=${PRIVATE_MARKER}`;

    const unauthenticated = await fixture.application.app.inject({
      method: "GET",
      url: `/api/designs/${fixture.allowed.id}/export?${invalidQuery}`,
      headers: bearerHeaders(UNKNOWN_TOKEN),
    });
    expectDomainError(unauthenticated, 401, "AUTH_REQUIRED");

    const organizationDenied = await fixture.application.app.inject({
      method: "GET",
      url: `/api/designs/${fixture.foreign.id}/export?${invalidQuery}`,
      headers: serverHeaders(),
    });
    expectDomainError(organizationDenied, 404, "NOT_FOUND");
    expect(organizationDenied.body).not.toContain(fixture.foreign.id);
    expect(organizationDenied.body).not.toContain(fixture.foreign.name);

    for (const query of [invalidQuery, "format=svg&version=1"]) {
      const archived = await fixture.application.app.inject({
        method: "GET",
        url: `/api/designs/${fixture.archived.id}/export?${query}`,
        headers: serverHeaders(),
      });
      expectDomainError(archived, 404, "NOT_FOUND");
      expect(archived.body).not.toContain(fixture.archived.id);
      expect(archived.body).not.toContain(fixture.archived.name);
    }

    expect(getDesign).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
  });

  it("returns byte-identical exports with verifiable hashes and restrictive response headers", async () => {
    const fixture = await createFixture("determinism");
    const rgba = Buffer.from([
      24, 87, 230, 255,
      4, 12, 28, 255,
      255, 255, 255, 255,
      104, 113, 139, 128,
    ]);
    const png = encodeRgbaPng(2, 2, rgba);
    const render = vi.spyOn(fixture.application.renderer, "render").mockResolvedValue({
      png,
      width: 2,
      height: 2,
      renderer: "playwright",
      warnings: ["deterministic fixture"],
    });

    const cases = [
      {
        format: "svg",
        contentType: "image/svg+xml; charset=utf-8",
        expected: deterministicSvgExport(png, 2, 2),
        selection: `pageId=${fixture.allowed.pageId}`,
      },
      {
        format: "pdf",
        contentType: "application/pdf",
        expected: deterministicPdfExport(png, 2, 2),
        selection: `nodeId=${fixture.allowed.frameId}`,
      },
    ] as const;

    for (const exportCase of cases) {
      const url = `/api/designs/${fixture.allowed.id}/export?format=${exportCase.format}&version=1&maxSize=512&${exportCase.selection}`;
      const first = await fixture.application.app.inject({ method: "GET", url, headers: serverHeaders() });
      const second = await fixture.application.app.inject({ method: "GET", url, headers: serverHeaders() });

      for (const response of [first, second]) {
        expect(response.statusCode, response.body).toBe(200);
        expect(response.rawPayload).toEqual(exportCase.expected);
        expect(response.headers["content-type"]).toBe(exportCase.contentType);
        expect(response.headers["content-disposition"])
          .toBe(`attachment; filename="${fixture.allowed.id}-v1.${exportCase.format}"`);
        expect(response.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
        expect(response.headers["content-security-policy"])
          .toBe("default-src 'none'; img-src data:; style-src 'none'; sandbox");
        expect(response.headers["x-content-type-options"]).toBe("nosniff");
        expect(response.headers["x-formaspec-export-format"]).toBe(exportCase.format);
        expect(response.headers["x-formaspec-export-sha256"]).toBe(sha256(exportCase.expected));
        expect(response.headers["x-formaspec-source-png-sha256"]).toBe(sha256(png));
        expect(response.headers["x-designer-renderer"]).toBe("playwright");
        expect(response.headers["x-designer-render-warnings"]).toBe("deterministic fixture");
      }
      expect(first.rawPayload).toEqual(second.rawPayload);
      expect(first.headers["x-formaspec-export-sha256"])
        .toBe(second.headers["x-formaspec-export-sha256"]);
    }

    expect(render).toHaveBeenCalledTimes(4);
    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({ id: fixture.allowed.id, revision: 1 }),
      { pageId: fixture.allowed.pageId, maxSize: 512 },
      expect.any(Function),
    );
    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({ id: fixture.allowed.id, revision: 1 }),
      { nodeId: fixture.allowed.frameId, maxSize: 512 },
      expect.any(Function),
    );
  });
});
