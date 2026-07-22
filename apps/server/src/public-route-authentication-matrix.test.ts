import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApplication, type DesignerApplication } from "./app.js";
import { resolveAccess } from "./authorization.js";
import { loadConfig } from "./config.js";
import {
  PROTECTED_NON_MCP_ROUTE_CONTRACTS,
  type ProtectedNonMcpRouteContract,
} from "./public-route-contract.js";

const PROXY_SECRET = "proxy-secret-0123456789abcdef0123456789abcdef";
const ROUTE_MARKER = "SECRET_ROUTE_MARKER_7d0f62e1";

const applications: DesignerApplication[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.app.close()));
  await Promise.all(temporaryDirectories.splice(0).map(
    (directory) => fs.promises.rm(directory, { recursive: true, force: true }),
  ));
});

async function serverApplication(): Promise<DesignerApplication> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "formaspec-route-authentication-"));
  temporaryDirectories.push(root);
  const application = await buildApplication(loadConfig({
    APP_MODE: "server",
    HOST: "0.0.0.0",
    PORT: "4310",
    DATA_DIR: path.join(root, "data"),
    BACKUP_DIR: path.join(root, "backups"),
    DESIGNER_DATABASE_PATH: ":memory:",
    PUBLIC_BASE_URL: "https://design.example.com",
    AUTH_MODE: "trusted-header",
    DESIGNER_TOKEN: "route-authentication-token-00000001",
    TRUSTED_USER_HEADER: "x-designer-user",
    FORMASPEC_TRUSTED_PROXIES: "127.0.0.1",
    FORMASPEC_PROXY_SECRET: PROXY_SECRET,
    DESIGNER_CORS_ORIGINS: "https://design.example.com",
    DESIGNER_LOG_LEVEL: "silent",
  }));
  applications.push(application);
  await application.app.ready();
  return application;
}

function concretePath(contract: ProtectedNonMcpRouteContract): string {
  return contract.path.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, (_match, parameter: string) => (
    `${parameter}_${ROUTE_MARKER}`
  ));
}

function proxyHeaders(identity?: string): Record<string, string> {
  return {
    host: "design.example.com",
    origin: "https://design.example.com",
    "x-formaspec-csrf": "1",
    "x-formaspec-proxy-secret": PROXY_SECRET,
    accept: "application/json, text/event-stream",
    ...(identity === undefined ? {} : { "x-designer-user": identity }),
  };
}

function totalChanges(application: DesignerApplication): number {
  return (application.database.sqlite.prepare("SELECT total_changes() AS count").get() as { count: number }).count;
}

async function expectAuthenticationFailure(
  application: DesignerApplication,
  contract: ProtectedNonMcpRouteContract,
  identity?: string,
): Promise<void> {
  const response = await application.app.inject({
    method: contract.method,
    url: concretePath(contract),
    headers: proxyHeaders(identity),
    remoteAddress: "127.0.0.1",
  });
  expect(response.statusCode, contract.key).toBe(401);
  expect(response.json<{ error: { code: string } }>().error.code, contract.key).toBe("AUTH_REQUIRED");
  expect(response.body, contract.key).not.toContain(ROUTE_MARKER);
}

describe("protected non-MCP route authentication matrix", () => {
  it("rejects missing trusted identity before parsing or mutating every protected route", async () => {
    const application = await serverApplication();
    const before = totalChanges(application);

    for (const contract of PROTECTED_NON_MCP_ROUTE_CONTRACTS.values()) {
      await expectAuthenticationFailure(application, contract);
    }

    expect(PROTECTED_NON_MCP_ROUTE_CONTRACTS.size).toBe(110);
    expect(totalChanges(application)).toBe(before);
  }, 30_000);

  it("rejects ambiguous trusted identity before parsing or mutating every protected route", async () => {
    const application = await serverApplication();
    const before = totalChanges(application);

    for (const contract of PROTECTED_NON_MCP_ROUTE_CONTRACTS.values()) {
      await expectAuthenticationFailure(application, contract, "alice@example.test,bob@example.test");
    }

    expect(PROTECTED_NON_MCP_ROUTE_CONTRACTS.size).toBe(110);
    expect(totalChanges(application)).toBe(before);
  }, 30_000);

  it("rejects an unmapped trusted identity before parsing every non-pairing route", async () => {
    const application = await serverApplication();
    resolveAccess(application.database.sqlite, "trusted:bootstrap-admin@example.test");
    const before = totalChanges(application);
    const contracts = [...PROTECTED_NON_MCP_ROUTE_CONTRACTS.values()]
      .filter((contract) => contract.authorization !== "pairing_nonce");

    for (const contract of contracts) {
      await expectAuthenticationFailure(application, contract, "unmapped@example.test");
    }

    expect(contracts).toHaveLength(109);
    expect(totalChanges(application)).toBe(before);
  }, 30_000);

  it("rejects a disabled trusted identity before parsing every non-pairing route", async () => {
    const application = await serverApplication();
    const access = resolveAccess(application.database.sqlite, "trusted:disabled-admin@example.test");
    application.database.sqlite.prepare(
      "UPDATE principals SET disabled_at = ? WHERE id = ?",
    ).run(new Date().toISOString(), access.principalId);
    const before = totalChanges(application);
    const contracts = [...PROTECTED_NON_MCP_ROUTE_CONTRACTS.values()]
      .filter((contract) => contract.authorization !== "pairing_nonce");

    for (const contract of contracts) {
      await expectAuthenticationFailure(application, contract, "disabled-admin@example.test");
    }

    expect(contracts).toHaveLength(109);
    expect(totalChanges(application)).toBe(before);
  }, 30_000);

  it("keeps the explicit pairing exception bound to a valid one-time nonce", async () => {
    const application = await serverApplication();
    const challenge = application.enterprise.createAgentConnection("local", {
      adapter: "codex",
      displayName: "Route-matrix pairing exception",
      scopes: ["design:read"],
      expiresInSeconds: 3_600,
    });

    const paired = await application.app.inject({
      method: "POST",
      url: "/api/agent-connections/pair",
      headers: proxyHeaders("unmapped-pairing-client@example.test"),
      remoteAddress: "127.0.0.1",
      payload: { nonce: challenge.nonce },
    });
    expect(paired.statusCode, paired.body).toBe(200);
    expect(paired.json()).toMatchObject({
      connection: { id: challenge.connection.id, status: "active" },
      grant: { actorId: expect.stringMatching(/^grant_/), token: expect.stringMatching(/^fsg_/) },
    });

    const replay = await application.app.inject({
      method: "POST",
      url: "/api/agent-connections/pair",
      headers: proxyHeaders("unmapped-pairing-client@example.test"),
      remoteAddress: "127.0.0.1",
      payload: { nonce: challenge.nonce },
    });
    expect(replay.statusCode).toBe(409);
    expect(replay.json<{ error: { code: string } }>().error.code).toBe("VERSION_CONFLICT");
    expect(replay.body).not.toContain(challenge.nonce);
  });
});
