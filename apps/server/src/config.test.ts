import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { loadConfig } from "./config.js";
import {
  DEFAULT_MAX_ASSET_BYTES,
  DEFAULT_RENDER_IPC_MAX_BYTES,
  DEFAULT_RENDER_MAX_PIXELS,
  MAX_RASTER_NORMALIZATION_BYTES,
  MAX_RASTER_NORMALIZATION_PIXELS,
  requiredRasterIpcMessageBytes,
} from "./renderer-contract.js";

const applications: DesignerApplication[] = [];
const PROXY_SECRET = "proxy-secret-0123456789abcdef0123456789abcdef";

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.app.close()));
});

describe("FormaSpec application modes", () => {
  it("keeps local and worker raster limits on one bounded contract", () => {
    const defaults = loadConfig({});
    expect(defaults).toMatchObject({
      maxAssetBytes: DEFAULT_MAX_ASSET_BYTES,
      maxAssetPixels: DEFAULT_RENDER_MAX_PIXELS,
      renderMaxPixels: DEFAULT_RENDER_MAX_PIXELS,
      renderIpcMaxBytes: DEFAULT_RENDER_IPC_MAX_BYTES,
    });

    expect(() => loadConfig({
      DESIGNER_MAX_ASSET_PIXELS: String(DEFAULT_RENDER_MAX_PIXELS + 1),
      FORMASPEC_RENDER_MAX_PIXELS: String(DEFAULT_RENDER_MAX_PIXELS),
    })).toThrow(/cannot exceed FORMASPEC_RENDER_MAX_PIXELS/);

    expect(() => loadConfig({
      MAX_UPLOAD_BYTES: String(1024 * 1024),
      FORMASPEC_RENDER_IPC_MAX_BYTES: String(1024 * 1024),
    })).toThrow(/base64 framing/);

    expect(() => loadConfig({
      DESIGNER_MAX_ASSET_BYTES: String(MAX_RASTER_NORMALIZATION_BYTES + 1),
    })).toThrow();
    expect(() => loadConfig({
      DESIGNER_MAX_ASSET_PIXELS: String(MAX_RASTER_NORMALIZATION_PIXELS + 1),
    })).toThrow();

    const hardCaps = loadConfig({
      DESIGNER_MAX_ASSET_BYTES: String(MAX_RASTER_NORMALIZATION_BYTES),
      DESIGNER_MAX_ASSET_PIXELS: String(MAX_RASTER_NORMALIZATION_PIXELS),
      FORMASPEC_RENDER_MAX_PIXELS: String(MAX_RASTER_NORMALIZATION_PIXELS),
      FORMASPEC_RENDER_IPC_MAX_BYTES: String(requiredRasterIpcMessageBytes(MAX_RASTER_NORMALIZATION_BYTES)),
    });
    expect(hardCaps.maxAssetBytes).toBe(MAX_RASTER_NORMALIZATION_BYTES);
    expect(hardCaps.maxAssetPixels).toBe(MAX_RASTER_NORMALIZATION_PIXELS);
  });

  it("refuses unsafe local and server configurations", () => {
    expect(() => loadConfig({
      APP_MODE: "local",
      HOST: "0.0.0.0",
      PUBLIC_BASE_URL: "http://0.0.0.0:4310",
    })).toThrow(/loopback/);

    expect(() => loadConfig({
      APP_MODE: "server",
      HOST: "0.0.0.0",
      PUBLIC_BASE_URL: "https://design.example.com",
      AUTH_MODE: "trusted-header",
      DESIGNER_TOKEN: "designer-token-0123456789abcdef0123456789",
      FORMASPEC_TRUSTED_PROXIES: "127.0.0.1",
      FORMASPEC_CONTAINER_LOCAL: "true",
    })).toThrow(/cannot be enabled in server mode/);

    expect(() => loadConfig({
      APP_MODE: "server",
      HOST: "0.0.0.0",
      PUBLIC_BASE_URL: "http://design.example.com",
      AUTH_MODE: "trusted-header",
      DESIGNER_TOKEN: "0123456789abcdef",
      FORMASPEC_TRUSTED_PROXIES: "127.0.0.1",
    })).toThrow(/HTTPS/);

    expect(() => loadConfig({
      APP_MODE: "server",
      HOST: "0.0.0.0",
      PUBLIC_BASE_URL: "https://design.example.com",
      AUTH_MODE: "trusted-header",
      DESIGNER_TOKEN: "0123456789abcdef",
    })).toThrow(/TRUSTED_PROXIES/);

    expect(() => loadConfig({
      APP_MODE: "server",
      HOST: "0.0.0.0",
      PUBLIC_BASE_URL: "https://design.example.com",
      AUTH_MODE: "trusted-header",
      DESIGNER_TOKEN: "0123456789abcdef",
      FORMASPEC_TRUSTED_PROXIES: "127.0.0.1",
      FORMASPEC_PROXY_SECRET: PROXY_SECRET,
      FORMASPEC_ALLOW_SOFTWARE_RENDERER: "true",
    })).toThrow(/development-only/);

    expect(() => loadConfig({
      APP_MODE: "local",
      HOST: "127.0.0.1",
      PUBLIC_BASE_URL: "http://127.0.0.1:4310",
      FORMASPEC_RENDER_SOCKET: "relative/renderer.sock",
    })).toThrow(/absolute Unix-domain-socket/);

    expect(loadConfig({
      APP_MODE: "local",
      HOST: "127.0.0.1",
      PUBLIC_BASE_URL: "http://127.0.0.1:4310",
      FORMASPEC_RENDER_SOCKET: String.raw`\\.\pipe\formaspec-renderer-user`,
    }, "win32").renderSocket).toBe(String.raw`\\.\pipe\formaspec-renderer-user`);

    expect(() => loadConfig({
      APP_MODE: "local",
      HOST: "127.0.0.1",
      PUBLIC_BASE_URL: "http://127.0.0.1:4310",
      FORMASPEC_RENDER_SOCKET: "C:\\temp\\renderer.sock",
    }, "win32")).toThrow(/Windows named pipe/);

    const secureServerEnvironment = {
      APP_MODE: "server",
      HOST: "0.0.0.0",
      PUBLIC_BASE_URL: "https://design.example.com",
      AUTH_MODE: "trusted-header",
      DESIGNER_TOKEN: "designer-token-0123456789abcdef0123456789",
      FORMASPEC_TRUSTED_PROXIES: "127.0.0.1",
      FORMASPEC_PROXY_SECRET: PROXY_SECRET,
    } as const;
    for (const reservedHeader of [
      "host",
      "origin",
      "authorization",
      "forwarded",
      "x-forwarded-for",
      "x-real-ip",
      "x-auth-user",
      "x-formaspec-csrf",
      "x-formaspec-proxy-secret",
      "x-request-id",
    ]) {
      expect(() => loadConfig({
        ...secureServerEnvironment,
        TRUSTED_USER_HEADER: reservedHeader,
      })).toThrow(/dedicated x-\* identity header/);
    }
    expect(() => loadConfig({
      ...secureServerEnvironment,
      TRUSTED_USER_HEADER: "x-company-identity",
      FORMASPEC_CSRF_HEADER: "x-company-identity",
    })).toThrow(/dedicated x-\* identity header/);
    expect(() => loadConfig({
      ...secureServerEnvironment,
      FORMASPEC_TRUSTED_PROXIES: "loopback",
    })).toThrow(/invalid IP address or CIDR/);
    expect(() => loadConfig({
      ...secureServerEnvironment,
      FORMASPEC_TRUSTED_PROXIES: "192.0.2.0\/33",
    })).toThrow(/invalid IP address or CIDR/);
    expect(() => loadConfig({
      ...secureServerEnvironment,
      FORMASPEC_PROXY_SECRET: "",
    })).toThrow(/FORMASPEC_PROXY_SECRET/);
    expect(() => loadConfig({
      ...secureServerEnvironment,
      FORMASPEC_PROXY_SECRET: "too-short",
    })).toThrow(/32 to 256/);
    expect(() => loadConfig({
      ...secureServerEnvironment,
      FORMASPEC_PROXY_SECRET: secureServerEnvironment.DESIGNER_TOKEN,
    })).toThrow(/separate from DESIGNER_TOKEN/);
    expect(() => loadConfig({
      APP_MODE: "local",
      FORMASPEC_PROXY_SECRET: PROXY_SECRET,
    })).toThrow(/server-only/);
  });

  it("separates the development browser origin from the API while requiring root-only safe URLs", () => {
    const development = loadConfig({
      APP_MODE: "local",
      HOST: "127.0.0.1",
      PORT: "4310",
      PUBLIC_BASE_URL: "http://127.0.0.1:4310/",
      FORMASPEC_WEB_BASE_URL: "http://127.0.0.1:4311/",
    });
    expect(development.publicBaseUrl).toBe("http://127.0.0.1:4310");
    expect(development.webBaseUrl).toBe("http://127.0.0.1:4311");
    expect(development.corsOrigins).toEqual(expect.arrayContaining([
      "http://127.0.0.1:4310",
      "http://127.0.0.1:4311",
    ]));

    for (const invalid of [
      "http://user:password@127.0.0.1:4311",
      "http://127.0.0.1:4311/formaspec",
      "http://127.0.0.1:4311?workspace=other",
      "http://127.0.0.1:4311#review",
    ]) {
      expect(() => loadConfig({
        APP_MODE: "local",
        HOST: "127.0.0.1",
        PUBLIC_BASE_URL: "http://127.0.0.1:4310",
        FORMASPEC_WEB_BASE_URL: invalid,
      })).toThrow(/root HTTP\(S\) origin/);
    }

    expect(() => loadConfig({
      APP_MODE: "server",
      HOST: "0.0.0.0",
      PUBLIC_BASE_URL: "https://api.example.test",
      FORMASPEC_WEB_BASE_URL: "https://design.example.test",
      AUTH_MODE: "trusted-header",
      DESIGNER_TOKEN: "designer-token-0123456789abcdef0123456789",
      FORMASPEC_TRUSTED_PROXIES: "127.0.0.1",
      FORMASPEC_PROXY_SECRET: PROXY_SECRET,
    })).toThrow(/same public origin/);
  });

  it("allows an explicit loopback-published container boundary without weakening ordinary local mode", () => {
    const config = loadConfig({
      APP_MODE: "local",
      HOST: "0.0.0.0",
      PORT: "4310",
      PUBLIC_BASE_URL: "http://127.0.0.1:4310",
      AUTH_MODE: "none",
      FORMASPEC_CONTAINER_LOCAL: "true",
    });
    expect(config.containerLocalMode).toBe(true);
    expect(config.host).toBe("0.0.0.0");
    expect(config.allowedHosts).toContain("127.0.0.1:4310");
  });

  it("enforces the configured Host and rejects proxy identity at the container-local boundary", async () => {
    const application = await buildApplication(loadConfig({
      APP_MODE: "local",
      HOST: "0.0.0.0",
      PORT: "4310",
      DATA_DIR: "/tmp/formaspec-container-config-tests",
      DESIGNER_DATABASE_PATH: ":memory:",
      PUBLIC_BASE_URL: "http://127.0.0.1:4310",
      AUTH_MODE: "none",
      FORMASPEC_CONTAINER_LOCAL: "true",
      DESIGNER_LOG_LEVEL: "silent",
    }));
    applications.push(application);

    const accepted = await application.app.inject({
      method: "GET",
      url: "/health/live",
      headers: { host: "127.0.0.1:4310" },
      remoteAddress: "172.18.0.1",
    });
    expect(accepted.statusCode).toBe(200);

    const badHost = await application.app.inject({
      method: "GET",
      url: "/health/live",
      headers: { host: "attacker.example" },
      remoteAddress: "172.18.0.1",
    });
    expect(badHost.statusCode).toBe(403);

    const spoofed = await application.app.inject({
      method: "GET",
      url: "/health/live",
      headers: { host: "127.0.0.1:4310", "x-forwarded-for": "127.0.0.1" },
      remoteAddress: "172.18.0.1",
    });
    expect(spoofed.statusCode).toBe(403);
  });

  it("ignores caller-controlled identity headers in local mode", async () => {
    const application = await buildApplication(loadConfig({
      APP_MODE: "local",
      HOST: "127.0.0.1",
      PORT: "4310",
      DATA_DIR: "/tmp/formaspec-config-tests",
      DESIGNER_DATABASE_PATH: ":memory:",
      PUBLIC_BASE_URL: "http://127.0.0.1:4310",
      AUTH_MODE: "none",
      DESIGNER_LOG_LEVEL: "silent",
    }));
    applications.push(application);

    const created = await application.app.inject({
      method: "POST",
      url: "/api/designs",
      headers: { "x-designer-user": "attacker-controlled" },
      payload: { name: "Local project", preset: "web", idempotencyKey: "local-mode-key-0001" },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json<{ document: { id: string } }>().document.id;
    const history = await application.app.inject({ method: "GET", url: `/api/designs/${id}/history` });
    expect(history.statusCode).toBe(200);
    expect(history.json<{ revisions: Array<{ actorId: string }> }>().revisions[0]?.actorId).toBe("local");
  });

  it("enforces trusted host, origin, identity, and CSRF intent in server mode", async () => {
    const application = await buildApplication(loadConfig({
      APP_MODE: "server",
      HOST: "0.0.0.0",
      PORT: "4310",
      DATA_DIR: "/tmp/formaspec-config-tests",
      DESIGNER_DATABASE_PATH: ":memory:",
      PUBLIC_BASE_URL: "https://design.example.com",
      AUTH_MODE: "trusted-header",
      DESIGNER_TOKEN: "0123456789abcdef",
      FORMASPEC_TRUSTED_PROXIES: "127.0.0.1",
      FORMASPEC_PROXY_SECRET: PROXY_SECRET,
      DESIGNER_CORS_ORIGINS: "https://design.example.com",
      DESIGNER_LOG_LEVEL: "silent",
    }));
    applications.push(application);

    const rejected = await application.app.inject({
      method: "POST",
      url: "/api/designs",
      headers: { host: "design.example.com", "x-designer-user": "alice" },
      payload: { name: "Rejected", preset: "web", idempotencyKey: "server-mode-key-0001" },
    });
    expect(rejected.statusCode).toBe(403);
    expect(application.database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM principals WHERE external_id = 'trusted:alice'",
    ).get()).toEqual({ count: 0 });

    const wrongProxySecret = await application.app.inject({
      method: "GET",
      url: "/api/designs",
      headers: {
        host: "design.example.com",
        "x-designer-user": "mallory",
        "x-formaspec-proxy-secret": `${PROXY_SECRET}-wrong`,
      },
    });
    expect(wrongProxySecret.statusCode).toBe(403);
    expect(application.database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM principals WHERE external_id = 'trusted:mallory'",
    ).get()).toEqual({ count: 0 });
    expect(application.database.sqlite.prepare(
      `SELECT COUNT(*) AS count FROM memberships m
       JOIN principals p ON p.id = m.principal_id
       WHERE p.external_id IN ('trusted:alice', 'trusted:mallory')`,
    ).get()).toEqual({ count: 0 });

    const health = await application.app.inject({
      method: "GET",
      url: "/health/live",
      headers: { host: "design.example.com" },
    });
    expect(health.statusCode).toBe(200);

    const accepted = await application.app.inject({
      method: "POST",
      url: "/api/designs",
      headers: {
        host: "design.example.com",
        origin: "https://design.example.com",
        "x-formaspec-csrf": "1",
        "x-designer-user": "alice",
        "x-formaspec-proxy-secret": PROXY_SECRET,
      },
      payload: { name: "Accepted", preset: "web", idempotencyKey: "server-mode-key-0002" },
    });
    expect(accepted.statusCode).toBe(201);
    expect(accepted.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(accepted.headers["strict-transport-security"]).toContain("max-age=31536000");
  });

  it("rejects trusted identity from an untrusted raw socket peer before principal bootstrap", async () => {
    const application = await buildApplication(loadConfig({
      APP_MODE: "server",
      HOST: "0.0.0.0",
      PORT: "4310",
      DATA_DIR: "/tmp/formaspec-config-tests",
      DESIGNER_DATABASE_PATH: ":memory:",
      PUBLIC_BASE_URL: "https://design.example.com",
      AUTH_MODE: "trusted-header",
      DESIGNER_TOKEN: "0123456789abcdef",
      TRUSTED_USER_HEADER: "x-company-identity",
      FORMASPEC_TRUSTED_PROXIES: "127.0.0.1,172.16.0.0/12",
      FORMASPEC_PROXY_SECRET: PROXY_SECRET,
      DESIGNER_CORS_ORIGINS: "https://design.example.com",
      DESIGNER_LOG_LEVEL: "silent",
    }));
    applications.push(application);

    const before = application.database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM principals WHERE external_id = ?",
    ).get("trusted:mallory@example.test") as { count: number };
    expect(before.count).toBe(0);

    const response = await application.app.inject({
      method: "GET",
      url: "/api/designs",
      remoteAddress: "203.0.113.19",
      headers: {
        host: "design.example.com",
        "x-company-identity": "mallory@example.test",
        "x-forwarded-for": "127.0.0.1",
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("FORBIDDEN");

    const after = application.database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM principals WHERE external_id = ?",
    ).get("trusted:mallory@example.test") as { count: number };
    expect(after.count).toBe(0);
    const membership = application.database.sqlite.prepare(
      `SELECT COUNT(*) AS count FROM memberships m
       JOIN principals p ON p.id = m.principal_id
       WHERE p.external_id = ?`,
    ).get("trusted:mallory@example.test") as { count: number };
    expect(membership.count).toBe(0);
  });

  it("authenticates MCP with hashed, expiring, revocable scoped grants", async () => {
    const application = await buildApplication(loadConfig({
      APP_MODE: "server",
      HOST: "0.0.0.0",
      PORT: "4310",
      DATA_DIR: "/tmp/formaspec-config-tests",
      DESIGNER_DATABASE_PATH: ":memory:",
      PUBLIC_BASE_URL: "https://design.example.com",
      AUTH_MODE: "trusted-header",
      DESIGNER_TOKEN: "legacy-bootstrap-token-0001",
      FORMASPEC_TRUSTED_PROXIES: "127.0.0.1",
      FORMASPEC_PROXY_SECRET: PROXY_SECRET,
      DESIGNER_CORS_ORIGINS: "https://design.example.com",
      DESIGNER_LOG_LEVEL: "silent",
    }));
    applications.push(application);

    const token = "scoped-agent-token-0000000001";
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 60_000).toISOString();
    application.database.sqlite.prepare(
      `INSERT INTO principals (id, organization_id, kind, display_name, external_id, created_at)
       VALUES ('principal_scoped_test', 'organization_legacy', 'agent', 'Scoped test agent', 'scoped-test', ?)`,
    ).run(now.toISOString());
    application.database.sqlite.prepare(
      `INSERT INTO memberships (organization_id, principal_id, role, created_at)
       VALUES ('organization_legacy', 'principal_scoped_test', 'agent', ?)`,
    ).run(now.toISOString());
    application.database.sqlite.prepare(
      `INSERT INTO agent_connections
       (id, organization_id, principal_id, adapter, display_name, status, scopes_json, project_ids_json,
        expires_at, created_at, updated_at)
       VALUES ('connection_scoped_test', 'organization_legacy', 'principal_scoped_test', 'generic_mcp',
               'Scoped test connection', 'active', '["design:read"]', '[]', ?, ?, ?)`,
    ).run(expiresAt, now.toISOString(), now.toISOString());
    application.database.sqlite.prepare(
      `INSERT INTO agent_grants
       (id, organization_id, principal_id, token_hash, scopes_json, project_ids_json, created_at, expires_at)
       VALUES ('scoped_test', 'organization_legacy', 'principal_scoped_test', ?, '["design:read"]', '[]', ?, ?)`,
    ).run(
      createHash("sha256").update(token).digest("hex"),
      now.toISOString(),
      expiresAt,
    );

    const initialize = () => application.app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        host: "design.example.com",
        authorization: `Bearer ${token}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "x-formaspec-proxy-secret": PROXY_SECRET,
      },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "scoped-test", version: "1.0.0" },
        },
      },
    });

    const accepted = await initialize();
    expect(accepted.statusCode).toBe(200);
    expect(application.database.sqlite.prepare(
      "SELECT last_used_at FROM agent_grants WHERE id = 'scoped_test'",
    ).get()).toMatchObject({ last_used_at: expect.any(String) });
    expect(application.database.sqlite.prepare(
      "SELECT last_used_at FROM agent_connections WHERE id = 'connection_scoped_test'",
    ).get()).toMatchObject({ last_used_at: expect.any(String) });

    application.database.sqlite.prepare(
      "UPDATE agent_connections SET status = 'revoked', updated_at = ? WHERE id = 'connection_scoped_test'",
    ).run(new Date().toISOString());
    const connectionRevoked = await initialize();
    expect(connectionRevoked.statusCode).toBe(401);
    expect(connectionRevoked.json<{ error: { code: string } }>().error.code).toBe("AUTH_REQUIRED");

    application.database.sqlite.prepare(
      "UPDATE agent_connections SET status = 'active', updated_at = ? WHERE id = 'connection_scoped_test'",
    ).run(new Date().toISOString());
    application.database.sqlite.prepare(
      "UPDATE agent_grants SET revoked_at = ? WHERE id = 'scoped_test'",
    ).run(new Date().toISOString());
    const revoked = await initialize();
    expect(revoked.statusCode).toBe(401);
    expect(revoked.json<{ error: { code: string } }>().error.code).toBe("AUTH_REQUIRED");
  });
});
