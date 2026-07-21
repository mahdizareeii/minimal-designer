import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildApplication } from "./app.js";
import { loadConfig } from "./config.js";
import {
  PROTECTED_NON_MCP_AUTHORIZATION_CLASSES,
  PROTECTED_NON_MCP_ROUTE_CONTRACTS,
  PROTECTED_NON_MCP_ROUTE_EXCLUSIONS,
  PROTECTED_NON_MCP_ROUTE_FAMILIES,
  defineProtectedNonMcpRouteContracts,
  isProtectedNonMcpRoute,
} from "./public-route-contract.js";

describe("protected non-MCP public route contract", () => {
  it("rejects duplicate normalized METHOD + path keys", () => {
    expect(() => defineProtectedNonMcpRouteContracts([
      {
        method: "GET",
        path: "/api/example/",
        family: "core_design",
        authorization: "authenticated_organization",
      },
      {
        method: "GET",
        path: "//api//example?ignored=true",
        family: "core_design",
        authorization: "authenticated_project",
      },
    ])).toThrow("Duplicate protected non-MCP route contract: GET /api/example");
  });

  it("matches the exact protected non-MCP route set registered by buildApplication", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "formaspec-route-contract-"));
    const dataDir = path.join(rootDir, "data");
    const application = await buildApplication(loadConfig({
      HOST: "127.0.0.1",
      PORT: "4310",
      DATA_DIR: dataDir,
      BACKUP_DIR: path.join(rootDir, "backups"),
      DESIGNER_DATABASE_PATH: ":memory:",
      PUBLIC_BASE_URL: "http://127.0.0.1:4310",
      AUTH_MODE: "none",
      FORMASPEC_ALLOW_SOFTWARE_RENDERER: "true",
      DESIGNER_LOG_LEVEL: "silent",
    }));

    try {
      await application.app.ready();
      const actual = [...application.registeredProtectedNonMcpRoutes].sort();
      const expected = [...PROTECTED_NON_MCP_ROUTE_CONTRACTS.keys()].sort();
      expect(actual).toEqual(expected);
      expect(actual).toHaveLength(108);
    } finally {
      await application.app.close();
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("retains the audited total, family counts, and explicit health/MCP exclusions", () => {
    const familyCounts = Object.fromEntries(PROTECTED_NON_MCP_ROUTE_FAMILIES.map((family) => [family, 0]));
    for (const contract of PROTECTED_NON_MCP_ROUTE_CONTRACTS.values()) {
      familyCounts[contract.family] = (familyCounts[contract.family] ?? 0) + 1;
    }

    expect(PROTECTED_NON_MCP_ROUTE_CONTRACTS.size).toBe(108);
    expect(familyCounts).toEqual({
      core_design: 22,
      product_spec_and_agents: 20,
      enterprise_domain: 45,
      portable_and_backup: 14,
      organization_policy: 6,
      maintenance: 1,
    });

    for (const routePath of PROTECTED_NON_MCP_ROUTE_EXCLUSIONS.health) {
      expect(isProtectedNonMcpRoute("GET", routePath)).toBe(false);
    }
    for (const method of ["GET", "POST", "DELETE"]) {
      expect(isProtectedNonMcpRoute(method, "/mcp")).toBe(false);
    }
    expect(isProtectedNonMcpRoute("HEAD", "/api/designs")).toBe(false);
    expect(isProtectedNonMcpRoute("OPTIONS", "/api/designs")).toBe(false);
  });

  it("classifies every intentional authorization exception explicitly", () => {
    const authorizationCounts = Object.fromEntries(
      PROTECTED_NON_MCP_AUTHORIZATION_CLASSES.map((authorization) => [authorization, 0]),
    );
    for (const contract of PROTECTED_NON_MCP_ROUTE_CONTRACTS.values()) {
      authorizationCounts[contract.authorization] = (authorizationCounts[contract.authorization] ?? 0) + 1;
    }
    expect(authorizationCounts).toEqual({
      authenticated_project: 54,
      authenticated_organization: 48,
      pairing_nonce: 1,
      self_authorization_context: 1,
      authenticated_static_capabilities: 1,
      maintenance_status: 1,
      sse: 2,
    });

    const exceptions = [...PROTECTED_NON_MCP_ROUTE_CONTRACTS.values()]
      .filter((contract) => ![
        "authenticated_project",
        "authenticated_organization",
      ].includes(contract.authorization))
      .map((contract) => [contract.key, contract.authorization])
      .sort(([left], [right]) => left.localeCompare(right));
    expect(Object.fromEntries(exceptions)).toEqual({
      "GET /api/agent-authorization-context": "self_authorization_context",
      "GET /api/enterprise-domain-capabilities": "authenticated_static_capabilities",
      "GET /api/events": "sse",
      "GET /api/maintenance/status": "maintenance_status",
      "GET /events": "sse",
      "POST /api/agent-connections/pair": "pairing_nonce",
    });
  });
});
