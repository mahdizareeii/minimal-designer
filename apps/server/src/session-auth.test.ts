import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { loadConfig } from "./config.js";
import { SessionAuthenticationService } from "./session-auth.js";

const LOCAL_ORIGIN = "http://127.0.0.1:4310";
const SERVER_ORIGIN = "https://design.example.test";
const PROXY_SECRET = "proxy-secret-0123456789abcdef0123456789abcdef";
const PASSWORD = "correct horse battery staple 2026";
const LOGIN_NAME = "admin@example.test";
const BOOTSTRAP_TOKEN = "server-bootstrap-token-0123456789abcdef0123456789abcdef";
const BOOTSTRAP_TOKEN_HASH = createHash("sha256").update(BOOTSTRAP_TOKEN).digest("hex");

const applications: DesignerApplication[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.app.close()));
  await Promise.all(temporaryDirectories.splice(0).map(
    (directory) => fs.promises.rm(directory, { recursive: true, force: true }),
  ));
});

async function localApplication(authMode: "none" | "session"): Promise<DesignerApplication> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "formaspec-session-auth-"));
  temporaryDirectories.push(root);
  const application = await buildApplication(loadConfig({
    APP_MODE: "local",
    HOST: "127.0.0.1",
    PORT: "4310",
    DATA_DIR: path.join(root, "data"),
    BACKUP_DIR: path.join(root, "backups"),
    DESIGNER_DATABASE_PATH: ":memory:",
    PUBLIC_BASE_URL: LOCAL_ORIGIN,
    AUTH_MODE: authMode,
    FORMASPEC_ALLOW_SOFTWARE_RENDERER: "true",
    DESIGNER_LOG_LEVEL: "silent",
  }));
  applications.push(application);
  await application.app.ready();
  return application;
}

async function serverApplication(): Promise<DesignerApplication> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "formaspec-server-session-auth-"));
  temporaryDirectories.push(root);
  const application = await buildApplication(loadConfig({
    APP_MODE: "server",
    HOST: "0.0.0.0",
    PORT: "4310",
    DATA_DIR: path.join(root, "data"),
    BACKUP_DIR: path.join(root, "backups"),
    DESIGNER_DATABASE_PATH: ":memory:",
    PUBLIC_BASE_URL: SERVER_ORIGIN,
    AUTH_MODE: "session",
    FORMASPEC_BOOTSTRAP_TOKEN_HASH: BOOTSTRAP_TOKEN_HASH,
    FORMASPEC_TRUSTED_PROXIES: "127.0.0.1",
    FORMASPEC_PROXY_SECRET: PROXY_SECRET,
    DESIGNER_CORS_ORIGINS: SERVER_ORIGIN,
    DESIGNER_LOG_LEVEL: "silent",
  }));
  applications.push(application);
  await application.app.ready();
  return application;
}

function localWriteHeaders(cookie?: string, csrf = "1"): Record<string, string> {
  return {
    origin: LOCAL_ORIGIN,
    "x-formaspec-csrf": csrf,
    ...(cookie ? { cookie } : {}),
  };
}

function serverHeaders(options: { write?: boolean; cookie?: string; csrf?: string } = {}): Record<string, string> {
  return {
    host: "design.example.test",
    "x-formaspec-proxy-secret": PROXY_SECRET,
    ...(options.write ? { origin: SERVER_ORIGIN, "x-formaspec-csrf": options.csrf ?? "1" } : {}),
    ...(options.cookie ? { cookie: options.cookie } : {}),
  };
}

function cookieFrom(response: { headers: Record<string, string | string[] | undefined> }): string {
  const value = response.headers["set-cookie"];
  const serialized = Array.isArray(value) ? value[0] : value;
  if (!serialized) throw new Error("Expected a session cookie.");
  return serialized.split(";", 1)[0]!;
}

async function bootstrap(
  application: DesignerApplication,
  headers: Record<string, string> = localWriteHeaders(),
  bootstrapToken?: string,
) {
  return application.app.inject({
    method: "POST",
    url: "/api/auth/bootstrap",
    headers,
    payload: {
      loginName: LOGIN_NAME,
      displayName: "FormaSpec Administrator",
      password: PASSWORD,
      ...(bootstrapToken ? { bootstrapToken } : {}),
    },
  });
}

describe("password-session bootstrap authentication", () => {
  it("fails a fresh public session deployment closed until the installer supplies a bootstrap hash", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "formaspec-missing-bootstrap-hash-"));
    temporaryDirectories.push(root);
    const config = loadConfig({
      APP_MODE: "server",
      HOST: "0.0.0.0",
      DATA_DIR: path.join(root, "data"),
      BACKUP_DIR: path.join(root, "backups"),
      DESIGNER_DATABASE_PATH: path.join(root, "data", "designer.sqlite"),
      PUBLIC_BASE_URL: SERVER_ORIGIN,
      AUTH_MODE: "session",
      FORMASPEC_TRUSTED_PROXIES: "127.0.0.1",
      FORMASPEC_PROXY_SECRET: PROXY_SECRET,
      DESIGNER_CORS_ORIGINS: SERVER_ORIGIN,
      DESIGNER_LOG_LEVEL: "silent",
    });
    await expect(buildApplication(config)).rejects.toThrow(/FORMASPEC_BOOTSTRAP_TOKEN_HASH/);
  });

  it("keeps AUTH_MODE=none local behavior and local MCP unchanged", async () => {
    const application = await localApplication("none");
    const status = await application.app.inject({ method: "GET", url: "/api/auth/status" });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ mode: "local", authenticated: true, bootstrapRequired: false });

    const created = await application.app.inject({
      method: "POST",
      url: "/api/designs",
      payload: { name: "No-login local project", preset: "web", idempotencyKey: "local-none-0001" },
    });
    expect(created.statusCode, created.body).toBe(201);

    const mcp = await application.app.inject({
      method: "POST",
      url: "/mcp",
      payload: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
    });
    expect(mcp.statusCode).not.toBe(401);
  });

  it("atomically creates exactly one administrator and stores only hardened credential/session hashes", async () => {
    const application = await localApplication("session");
    expect(application.database.schemaVersion()).toBe(14);

    const before = await application.app.inject({ method: "GET", url: "/api/auth/status" });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toEqual({
      mode: "session",
      bootstrapRequired: true,
      bootstrapTokenRequired: false,
      authenticated: false,
    });

    const protectedBefore = await application.app.inject({ method: "GET", url: "/api/designs" });
    expect(protectedBefore.statusCode).toBe(401);
    const publicShell = await application.app.inject({ method: "GET", url: "/", headers: { accept: "text/html" } });
    expect(publicShell.statusCode).not.toBe(401);

    const [left, right] = await Promise.all([bootstrap(application), bootstrap(application)]);
    expect([left.statusCode, right.statusCode].sort((a, b) => a - b)).toEqual([201, 409]);
    const successful = left.statusCode === 201 ? left : right;
    const conflicting = left.statusCode === 409 ? left : right;
    expect(conflicting.json<{ error: { code: string } }>().error.code).toBe("VERSION_CONFLICT");

    const account = application.database.sqlite.prepare(
      `SELECT a.id, a.principal_id, a.password_hash, a.login_name_normalized, m.role
       FROM password_accounts a
       JOIN memberships m ON m.organization_id = a.organization_id AND m.principal_id = a.principal_id`,
    ).get() as { id: string; principal_id: string; password_hash: string; login_name_normalized: string; role: string };
    expect(account.role).toBe("organization_admin");
    expect(account.login_name_normalized).toBe(LOGIN_NAME);
    expect(account.password_hash).toMatch(/^scrypt\$1\$16384\$8\$1\$/);
    expect(account.password_hash).not.toContain(PASSWORD);
    expect(application.database.sqlite.prepare("SELECT COUNT(*) AS count FROM password_accounts").get()).toEqual({ count: 1 });

    const response = successful.json<{ csrfToken: string; account: { principalId: string; role: string } }>();
    expect(response.account).toMatchObject({ principalId: account.principal_id, role: "organization_admin" });
    const cookie = cookieFrom(successful);
    const setCookie = String(successful.headers["set-cookie"]);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).not.toContain("; Secure");
    const rawSessionToken = cookie.slice(cookie.indexOf("=") + 1);
    const storedSession = application.database.sqlite.prepare(
      "SELECT token_hash, csrf_token_hash FROM browser_sessions WHERE revoked_at IS NULL",
    ).get() as { token_hash: string; csrf_token_hash: string };
    expect(storedSession.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(storedSession.csrf_token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(storedSession.token_hash).not.toBe(rawSessionToken);
    expect(storedSession.csrf_token_hash).not.toBe(response.csrfToken);

    const after = await application.app.inject({ method: "GET", url: "/api/auth/status", headers: { cookie } });
    expect(after.statusCode).toBe(200);
    expect(after.json()).toMatchObject({ mode: "session", bootstrapRequired: false, authenticated: true });

    const retry = await bootstrap(application);
    expect(retry.statusCode).toBe(409);
    expect(() => application.database.sqlite.prepare("DELETE FROM password_accounts WHERE id = ?").run(account.id))
      .toThrow(/cannot be deleted/);
  });

  it("requires per-session CSRF, rotates and revokes sessions, and honors expiry and disabled principals", async () => {
    const application = await localApplication("session");
    const bootstrapped = await bootstrap(application);
    expect(bootstrapped.statusCode, bootstrapped.body).toBe(201);
    const bootstrapCookie = cookieFrom(bootstrapped);
    const bootstrapBody = bootstrapped.json<{ csrfToken: string; account: { principalId: string } }>();

    const fixedIntent = await application.app.inject({
      method: "POST",
      url: "/api/designs",
      headers: localWriteHeaders(bootstrapCookie, "1"),
      payload: { name: "Rejected CSRF", preset: "web", idempotencyKey: "session-csrf-rejected-0001" },
    });
    expect(fixedIntent.statusCode).toBe(403);

    const created = await application.app.inject({
      method: "POST",
      url: "/api/designs",
      headers: localWriteHeaders(bootstrapCookie, bootstrapBody.csrfToken),
      payload: { name: "Authenticated project", preset: "web", idempotencyKey: "session-csrf-accepted-0001" },
    });
    expect(created.statusCode, created.body).toBe(201);

    const connection = await application.app.inject({
      method: "POST",
      url: "/api/agent-connections",
      headers: localWriteHeaders(bootstrapCookie, bootstrapBody.csrfToken),
      payload: {
        adapter: "codex",
        displayName: "Local session pairing test",
        scopes: ["design:read"],
        expiresInSeconds: 3_600,
      },
    });
    expect(connection.statusCode, connection.body).toBe(201);
    const challenge = connection.json<{ nonce: string; connection: { id: string } }>();
    const paired = await application.app.inject({
      method: "POST",
      url: "/api/agent-connections/pair",
      payload: { nonce: challenge.nonce },
    });
    expect(paired.statusCode, paired.body).toBe(200);
    expect(paired.json()).toMatchObject({
      connection: { id: challenge.connection.id, status: "active" },
      grant: { token: expect.stringMatching(/^fsg_/) },
    });

    const wrongLogout = await application.app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: localWriteHeaders(bootstrapCookie, "1"),
    });
    expect(wrongLogout.statusCode).toBe(403);

    const login = await application.app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: localWriteHeaders(),
      payload: { loginName: LOGIN_NAME, password: PASSWORD },
    });
    expect(login.statusCode, login.body).toBe(200);
    const loginCookie = cookieFrom(login);
    const loginBody = login.json<{ csrfToken: string }>();
    const rotatedOut = await application.app.inject({ method: "GET", url: "/api/designs", headers: { cookie: bootstrapCookie } });
    expect(rotatedOut.statusCode).toBe(401);

    const logout = await application.app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: localWriteHeaders(loginCookie, loginBody.csrfToken),
    });
    expect(logout.statusCode).toBe(204);
    expect(String(logout.headers["set-cookie"])).toContain("Max-Age=0");
    const loggedOut = await application.app.inject({ method: "GET", url: "/api/designs", headers: { cookie: loginCookie } });
    expect(loggedOut.statusCode).toBe(401);

    const relogin = await application.app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: localWriteHeaders(),
      payload: { loginName: LOGIN_NAME, password: PASSWORD },
    });
    expect(relogin.statusCode).toBe(200);
    const expiringCookie = cookieFrom(relogin);
    application.database.sqlite.prepare(
      "UPDATE browser_sessions SET idle_expires_at = ? WHERE principal_id = ? AND revoked_at IS NULL",
    ).run("2000-01-01T00:00:00.000Z", bootstrapBody.account.principalId);
    const expired = await application.app.inject({ method: "GET", url: "/api/designs", headers: { cookie: expiringCookie } });
    expect(expired.statusCode).toBe(401);

    const activeAgain = await application.app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: localWriteHeaders(),
      payload: { loginName: LOGIN_NAME, password: PASSWORD },
    });
    expect(activeAgain.statusCode).toBe(200);
    const disabledCookie = cookieFrom(activeAgain);
    application.database.sqlite.prepare("UPDATE principals SET disabled_at = ? WHERE id = ?")
      .run(new Date().toISOString(), bootstrapBody.account.principalId);
    const disabled = await application.app.inject({ method: "GET", url: "/api/designs", headers: { cookie: disabledCookie } });
    expect(disabled.statusCode).toBe(401);
  });

  it("uses generic login failures and persistent lockout state", async () => {
    const application = await localApplication("session");
    expect((await bootstrap(application)).statusCode).toBe(201);
    const wrongPayload = { loginName: LOGIN_NAME, password: "incorrect password value 2026" };
    const unknownPayload = { loginName: "unknown@example.test", password: "incorrect password value 2026" };
    const wrong = await application.app.inject({ method: "POST", url: "/api/auth/login", headers: localWriteHeaders(), payload: wrongPayload });
    const unknown = await application.app.inject({ method: "POST", url: "/api/auth/login", headers: localWriteHeaders(), payload: unknownPayload });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
    expect(wrong.json()).toEqual({
      error: { code: "AUTH_REQUIRED", message: "Invalid login credentials.", retryable: false },
    });

    for (let attempt = 1; attempt < 5; attempt += 1) {
      const response = await application.app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: localWriteHeaders(),
        payload: wrongPayload,
      });
      expect(response.statusCode).toBe(401);
    }
    const locked = application.database.sqlite.prepare(
      "SELECT failure_count, locked_until FROM login_attempts WHERE locked_until IS NOT NULL ORDER BY updated_at DESC LIMIT 1",
    ).get() as { failure_count: number; locked_until: string };
    expect(locked.failure_count).toBeGreaterThanOrEqual(5);
    expect(locked.locked_until).toBeTruthy();
    const correctWhileLocked = await application.app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: localWriteHeaders(),
      payload: { loginName: LOGIN_NAME, password: PASSWORD },
    });
    expect(correctWhileLocked.statusCode).toBe(401);
    expect(correctWhileLocked.json()).toEqual(wrong.json());

    application.database.sqlite.prepare("UPDATE login_attempts SET locked_until = ?").run("2000-01-01T00:00:00.000Z");
    const recovered = await application.app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: localWriteHeaders(),
      payload: { loginName: LOGIN_NAME, password: PASSWORD },
    });
    expect(recovered.statusCode, recovered.body).toBe(200);
    expect(application.database.sqlite.prepare("SELECT COUNT(*) AS count FROM login_attempts").get()).toEqual({ count: 1 });
  });

  it("uses Secure cookies behind HTTPS while keeping MCP bearer authentication separate", async () => {
    expect(() => loadConfig({
      APP_MODE: "server",
      HOST: "0.0.0.0",
      PUBLIC_BASE_URL: SERVER_ORIGIN,
      AUTH_MODE: "session",
      FORMASPEC_TRUSTED_PROXIES: "127.0.0.1",
      FORMASPEC_PROXY_SECRET: PROXY_SECRET,
    })).not.toThrow();
    const application = await serverApplication();
    const status = await application.app.inject({
      method: "GET",
      url: "/api/auth/status",
      remoteAddress: "127.0.0.1",
      headers: serverHeaders(),
    });
    expect(status.json()).toEqual({
      mode: "session",
      bootstrapRequired: true,
      bootstrapTokenRequired: true,
      authenticated: false,
    });
    const missingToken = await bootstrap(application, serverHeaders({ write: true }));
    expect(missingToken.statusCode).toBe(401);
    expect(application.database.sqlite.prepare("SELECT COUNT(*) AS count FROM password_accounts").get()).toEqual({ count: 0 });
    const response = await bootstrap(application, serverHeaders({ write: true }), BOOTSTRAP_TOKEN);
    expect(response.statusCode, response.body).toBe(201);
    expect(String(response.headers["set-cookie"])).toContain("; Secure");
    expect(application.database.sqlite.prepare(
      "SELECT consumed_at IS NOT NULL AS consumed, consumed_by IS NOT NULL AS consumedBy FROM bootstrap_credentials",
    ).get()).toEqual({ consumed: 1, consumedBy: 1 });
    expect(() => new SessionAuthenticationService(application.database, { requireBootstrapCredential: true }))
      .not.toThrow();
    expect(() => new SessionAuthenticationService(application.database, {
      bootstrapTokenHash: "f".repeat(64),
      requireBootstrapCredential: true,
    })).not.toThrow();
    const browser = response.json<{ csrfToken: string }>();
    const cookie = cookieFrom(response);
    const connection = await application.app.inject({
      method: "POST",
      url: "/api/agent-connections",
      remoteAddress: "127.0.0.1",
      headers: serverHeaders({ write: true, cookie, csrf: browser.csrfToken }),
      payload: {
        adapter: "codex",
        displayName: "Server session pairing test",
        scopes: ["design:read"],
        expiresInSeconds: 3_600,
      },
    });
    expect(connection.statusCode, connection.body).toBe(201);
    const challenge = connection.json<{ nonce: string; connection: { id: string } }>();
    const paired = await application.app.inject({
      method: "POST",
      url: "/api/agent-connections/pair",
      remoteAddress: "127.0.0.1",
      headers: serverHeaders(),
      payload: { nonce: challenge.nonce },
    });
    expect(paired.statusCode, paired.body).toBe(200);
    expect(paired.json()).toMatchObject({
      connection: { id: challenge.connection.id, status: "active" },
      grant: { token: expect.stringMatching(/^fsg_/) },
    });

    const mcp = await application.app.inject({
      method: "POST",
      url: "/mcp",
      remoteAddress: "127.0.0.1",
      headers: serverHeaders(),
      payload: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
    });
    expect(mcp.statusCode).toBe(401);
    expect(mcp.json<{ error: { code: string } }>().error.code).toBe("AUTH_REQUIRED");
  });
});
